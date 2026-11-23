import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole, startSession } from '../auth';
import { all, isInviteUnusable, isLastOwner, isUniqueViolation, newId, now, one, stmt, type DB } from '../db';
import { body, fail, isEmail, isUuid, normalizePhone, phoneEmail, signInSql, text } from '../http';
import { hashPassword, randomToken, sha256, verifyPassword } from '../crypto';
import { isRole } from '../permissions';
import { booksOf, handovers, inHandThrough } from '../cashbook';

const INVITE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;
const RESET_HOURS = 24;
const LAST_OWNER = 'A business needs at least one Owner.';

export const memberRoutes = new Hono<AppEnv>();

// People in a business plus pending invites, for the Users and roles screen. Owner only.
memberRoutes.get('/businesses/:businessId/members', requireRole('members.manage'), async (c) => {
  const bid = c.get('businessId');
  const members = await all(c.env.DB, `
    SELECT u.id, u.name, ${signInSql('u')} AS email, u.phone, m.role, u.last_active_at AS lastActiveAt,
      EXISTS (SELECT 1 FROM memberships x WHERE x.user_id = u.id AND x.role = 'owner') AS ownerAnywhere
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.business_id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'accountant' THEN 1 WHEN 'entry_staff' THEN 2 ELSE 3 END, u.name`, bid);
  const invites = await all(c.env.DB, `
    SELECT id, ${signInSql('invites')} AS email, role, account_id AS accountId, created_at AS createdAt, expires_at AS expiresAt
    FROM invites
    WHERE business_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC`, bid, now());
  return c.json({ members, invites });
});

// One person's roles across businesses — limited to businesses where the caller is also Owner,
// so an Owner never learns about businesses they have no say in.
memberRoutes.get('/businesses/:businessId/members/:userId/memberships', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const rows = await all(c.env.DB, `
    SELECT b.id, b.name, m.role
    FROM memberships m
    JOIN businesses b ON b.id = m.business_id
    JOIN memberships mine ON mine.business_id = m.business_id AND mine.user_id = ? AND mine.role = 'owner'
    WHERE m.user_id = ?
    ORDER BY b.name`, c.get('user').id, userId);
  return c.json({ memberships: rows });
});

// One statement each. The last-Owner rule is a database trigger, so it holds even when two
// Owners change roles at the same moment.
memberRoutes.patch('/businesses/:businessId/members/:userId', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const data = await body(c);
  if (!isRole(data.role)) fail(400, 'Role must be one of Owner, Accountant, Entry staff or Viewer.');
  try {
    const res = await stmt(c.env.DB, 'UPDATE memberships SET role = ? WHERE business_id = ? AND user_id = ?',
      data.role, c.get('businessId'), userId).run();
    if (!res.meta.changes) fail(404, 'Person not found.');
  } catch (e) {
    if (isLastOwner(e)) fail(409, LAST_OWNER);
    throw e;
  }
  return c.json({ ok: true });
});

// What removing a person's login touches (21 Nov 2026): the cash books they keep here, with the cash each should hold
// today, and cash handed over still waiting to or from those books. Their lines stay; the books lose their keeper.
async function removeCheck(db: DB, bid: string, userId: string) {
  const books = (await booksOf(db, bid, userId, 'owner', 'also')).filter((b) => b.cashierUserId === userId);
  const t = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const withCash = await Promise.all(books.map(async (b) => ({ id: b.id, name: b.name, inHandPaise: await inHandThrough(db, b, t) })));
  const ids = books.map((b) => b.id);
  const marks = ids.map(() => '?').join(',');
  const waiting = ids.length ? (await handovers(db, bid, `AND h.status = 'sent' AND h.to_kind = 'book'
    AND (o.account_id IN (${marks}) OR h.to_account_id IN (${marks}))`, ...ids, ...ids))
    .map((h) => ({ id: h.id, day: h.day, amountPaise: h.amountPaise, fromBookName: h.fromBookName, toName: h.toName })) : [];
  return { books: withCash, waiting };
}

memberRoutes.get('/businesses/:businessId/members/:userId/remove-check', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  return c.json(await removeCheck(c.env.DB, c.get('businessId'), userId));
});

// Removing a person (also "Remove login" on a cash book's line, 21 Nov 2026): their books here lose their keeper (the
// lines stay), their reset links here stop working, and if they are left in no business they are signed out. Refused
// while cash handed over to or from their books is waiting, so it is never left with nobody to accept it.
memberRoutes.delete('/businesses/:businessId/members/:userId', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const check = await removeCheck(db, bid, userId);
  if (check.waiting.length) {
    const w = check.waiting[0];
    fail(409, `Cash handed over is waiting: ₹ ${(w.amountPaise / 100).toLocaleString('en-IN')} from ${w.fromBookName} to ${w.toName}. Accept it or undo it first.`);
  }
  const t = now();
  const me = c.get('user').id;
  try {
    const res = await db.batch([
      ...check.books.flatMap((b) => [
        stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'cashbook.cashier', 'accounts', ?, ?, ?, ?)`,
          bid, me, b.id, JSON.stringify({ cashierUserId: userId }), JSON.stringify({ cashierUserId: null, loginRemoved: true }), t),
        stmt(db, 'UPDATE accounts SET cashier_user_id = NULL WHERE id = ? AND business_id = ?', b.id, bid),
      ]),
      stmt(db, 'UPDATE password_resets SET revoked_at = ? WHERE user_id = ? AND business_id = ? AND used_at IS NULL AND revoked_at IS NULL', t, userId, bid),
      stmt(db, 'DELETE FROM memberships WHERE business_id = ? AND user_id = ?', bid, userId),
      stmt(db, 'DELETE FROM sessions WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?)', userId, userId),
    ]);
    if (!res[res.length - 2].meta.changes) fail(404, 'Person not found.');
  } catch (e) {
    if (isLastOwner(e)) fail(409, LAST_OWNER);
    throw e;
  }
  return c.json({ ok: true, books: check.books.length });
});

// Only someone who is an Owner nowhere may have their password reset or their number changed by an Owner:
// otherwise one Owner could take over another business's Owner.
async function notOwnerMember(db: DB, bid: string, userId: string) {
  const row = await one<{ role: string; ownerAnywhere: number }>(db, `SELECT m.role,
      EXISTS (SELECT 1 FROM memberships x WHERE x.user_id = m.user_id AND x.role = 'owner') AS ownerAnywhere
    FROM memberships m WHERE m.business_id = ? AND m.user_id = ?`, bid, userId);
  if (!row) fail(404, 'Person not found.');
  if (row.ownerAnywhere) fail(403, 'An Owner changes their own password and number.');
}

// Password reset (approved 21 Nov 2026): the Owner makes a link for the person, valid 24 hours, used once.
// A newer link replaces an older one. The old password works until the new one is set.
memberRoutes.post('/businesses/:businessId/members/:userId/reset', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  await notOwnerMember(db, bid, userId);
  const token = randomToken();
  const t = now();
  const expiresAt = t + RESET_HOURS * 3600000;
  await db.batch([
    stmt(db, 'UPDATE password_resets SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL', t, userId),
    stmt(db, `INSERT INTO password_resets (id, user_id, business_id, created_by, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId(), userId, bid, c.get('user').id, await sha256(token), t, expiresAt),
  ]);
  const who = await one<{ phone: string | null }>(db, 'SELECT phone FROM users WHERE id = ?', userId);
  return c.json({ expiresAt, phone: who?.phone ?? null, link: `${new URL(c.req.url).origin}/#/reset/${token}` }, 201);
});

// Fix a person's name or change their mobile number (21 Nov 2026). Someone who joined by phone signs in with the new
// number from then on; their hidden stand-in email follows the number.
memberRoutes.patch('/businesses/:businessId/members/:userId/profile', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const db = c.env.DB;
  const data = await body(c);
  await notOwnerMember(db, c.get('businessId'), userId);
  const user = await one<{ name: string; email: string; phone: string | null }>(db, 'SELECT name, email, phone FROM users WHERE id = ?', userId);
  if (!user) fail(404, 'Person not found.');
  const name = data.name === undefined ? user.name : text(data, 'name', 'Name', { max: 120 })!;
  let phone = user.phone;
  let email = user.email;
  const emailLogin = !user.email.endsWith('@phone.bookr.invalid');
  // An email login's extra mobile number can be taken off again (23 Nov 2026); a phone login always keeps one.
  if (emailLogin && (data.phone === null || data.phone === '')) {
    phone = null;
  } else if (data.phone !== undefined) {
    phone = normalizePhone(data.phone);
    if (!phone) fail(400, 'Enter a 10-digit mobile number.');
    if (user.email.endsWith('@phone.bookr.invalid')) email = phoneEmail(phone);
  }
  if (phone && phone !== user.phone && await one(db, 'SELECT 1 AS ok FROM users WHERE phone = ? AND id <> ?', phone, userId)) {
    fail(409, 'Another person signs in with this number.');
  }
  try {
    await db.batch([
      stmt(db, 'UPDATE users SET name = ?, phone = ?, email = ? WHERE id = ?', name, phone, email, userId),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'member.profile', 'users', ?, ?, ?, ?)`,
        c.get('businessId'), c.get('user').id, userId, JSON.stringify({ name: user.name, phone: user.phone }), JSON.stringify({ name, phone }), now()),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'Another person signs in with this number.');
    throw e;
  }
  return c.json({ ok: true, name, phone });
});

// Creates an invite and returns a link for the Owner to share. No email is sent in Phase 1.
memberRoutes.post('/businesses/:businessId/invites', requireRole('members.manage'), async (c) => {
  const data = await body(c);
  // By email, or (21 Nov 2026) by mobile number, optionally for a cash book: joining makes them its cashier.
  const byPhone = data.phone !== undefined && data.phone !== null && data.phone !== '';
  const phone = byPhone ? normalizePhone(data.phone) : null;
  if (byPhone && !phone) fail(400, 'Enter a 10-digit mobile number.');
  const email = phone ? phoneEmail(phone) : text(data, 'email', 'Email', { max: 254 })!.toLowerCase();
  if (!phone && !isEmail(email)) fail(400, 'Enter a valid email address.');
  if (!isRole(data.role)) fail(400, 'Role must be one of Owner, Accountant, Entry staff or Viewer.');
  const accountId = typeof data.accountId === 'string' && data.accountId ? data.accountId : null;
  if (accountId && !isUuid(accountId)) fail(400, 'Choose the cash book.');
  const bid = c.get('businessId');
  const db = c.env.DB;
  const already = await one(db, phone
    ? 'SELECT 1 AS ok FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = ? AND u.phone = ?'
    : 'SELECT 1 AS ok FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = ? AND lower(u.email) = ?', bid, phone ?? email);
  if (already) fail(409, 'This person is already in this business.');
  const token = randomToken();
  const id = newId();
  const t = now();
  const expiresAt = t + INVITE_DAYS * DAY_MS;
  // One batch: a new invite replaces any pending one for the same email or number, and for the same cash book.
  try {
    await db.batch([
      stmt(db, `UPDATE invites SET revoked_at = ?
        WHERE business_id = ? AND (lower(email) = ? OR (? IS NOT NULL AND account_id = ?)) AND accepted_at IS NULL AND revoked_at IS NULL`, t, bid, email, accountId, accountId),
      stmt(db, `INSERT INTO invites (id, business_id, email, phone, account_id, role, invited_by, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, email, phone, accountId, data.role, c.get('user').id, await sha256(token), t, expiresAt),
    ]);
  } catch (e) {
    if (String((e as Error).message).includes('invite_phone_or_book')) fail(400, 'Choose a cash book of this business.');
    throw e;
  }
  const origin = new URL(c.req.url).origin;
  return c.json({ id, expiresAt, phone, link: `${origin}/#/invite/${token}` }, 201);
});

memberRoutes.delete('/businesses/:businessId/invites/:inviteId', requireRole('members.manage'), async (c) => {
  const inviteId = c.req.param('inviteId');
  if (!isUuid(inviteId)) fail(404, 'Invite not found.');
  const res = await stmt(c.env.DB, `
    UPDATE invites SET revoked_at = ?
    WHERE id = ? AND business_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    now(), inviteId, c.get('businessId')).run();
  if (!res.meta.changes) fail(404, 'Invite not found.');
  return c.json({ ok: true });
});

// Public: anyone holding the link can see what it is for. Nothing else about the business is shown.
export const inviteRoutes = new Hono<AppEnv>();

const INVALID_INVITE = 'This invite link is not valid. Ask the Owner for a new one.';

async function findInvite(db: DB, token: string) {
  const inv = await one<{ id: string; business_id: string; business_name: string; email: string; phone: string | null; account_id: string | null; role: string }>(db, `
    SELECT i.id, i.business_id, b.name AS business_name, i.email, i.phone, i.account_id, i.role
    FROM invites i JOIN businesses b ON b.id = i.business_id
    WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
    await sha256(token), now());
  if (!inv) fail(404, INVALID_INVITE);
  return inv;
}

inviteRoutes.get('/invites/:token', async (c) => {
  const inv = await findInvite(c.env.DB, c.req.param('token'));
  // A phone login (only ever made by a cashier invite) that is in no business any more (removed, 23 Nov 2026) joins like
  // a new person: name and a new password.
  const user = await one(c.env.DB, `SELECT 1 AS ok FROM users u WHERE ${inv.phone ? 'u.phone = ?' : 'lower(u.email) = lower(?)'}
    ${inv.phone ? "AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)" : ""}`, inv.phone ?? inv.email);
  return c.json({ businessName: inv.business_name, email: inv.phone ? null : inv.email, phone: inv.phone, role: inv.role, hasAccount: !!user });
});

// New person: sets a name and password. Existing person: confirms with their current password.
// The claim, the new user and the membership go in one batch; the invites_accept_once trigger
// rolls the whole batch back if the link was used, revoked or expired in the meantime.
inviteRoutes.post('/invites/:token/accept', async (c) => {
  const db = c.env.DB;
  const data = await body(c);
  const password = typeof data.password === 'string' ? data.password : '';
  const inv = await findInvite(db, c.req.param('token'));
  const existing = await one<{ id: string; password_hash: string; member: number }>(db, `SELECT u.id, u.password_hash,
      (? IS NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)) AS member FROM users u WHERE ${inv.phone ? 'u.phone = ?' : 'lower(u.email) = lower(?)'}`, inv.phone, inv.phone ?? inv.email);
  const t = now();
  const statements = [stmt(db, 'UPDATE invites SET accepted_at = ? WHERE id = ?', t, inv.id)];
  let userId: string;
  if (existing?.member) {
    if (!(await verifyPassword(password, existing.password_hash))) fail(401, 'Password is incorrect.');
    userId = existing.id;
  } else if (existing) {
    // In no business any more (its login was removed): the invited person sets their own name and password; the old
    // password stops working and any old sign-in ends.
    const name = text(data, 'name', 'Your name', { max: 120 })!;
    if (password.length < MIN_PASSWORD) fail(400, `Password must be at least ${MIN_PASSWORD} characters.`);
    userId = existing.id;
    statements.push(
      stmt(db, 'UPDATE users SET name = ?, password_hash = ? WHERE id = ?', name, await hashPassword(password), userId),
      stmt(db, 'DELETE FROM sessions WHERE user_id = ?', userId));
  } else {
    const name = text(data, 'name', 'Your name', { max: 120 })!;
    if (password.length < MIN_PASSWORD) fail(400, `Password must be at least ${MIN_PASSWORD} characters.`);
    userId = newId();
    statements.push(stmt(db, 'INSERT INTO users (id, name, email, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      userId, name, inv.email, inv.phone, await hashPassword(password), t));
  }
  statements.push(stmt(db, `INSERT INTO memberships (business_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (business_id, user_id) DO NOTHING`, inv.business_id, userId, inv.role, t));
  // An invite for a cash book makes the person its cashier (after the membership, which the book's trigger asks for).
  if (inv.account_id) statements.push(
    stmt(db, 'UPDATE accounts SET cashier_user_id = ? WHERE id = ? AND business_id = ?', userId, inv.account_id, inv.business_id),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'cashbook.cashier', 'accounts', ?, NULL, ?, ?)`,
      inv.business_id, userId, inv.account_id, JSON.stringify({ cashierUserId: userId, byInvite: inv.id }), t));
  try {
    await db.batch(statements);
  } catch (e) {
    if (isInviteUnusable(e)) fail(404, INVALID_INVITE);
    if (isUniqueViolation(e)) fail(409, 'An account with this email or number was just created. Open the link again to continue.');
    throw e;
  }
  await startSession(c, db, userId);
  return c.json({ ok: true });
});

// Public: a password reset link (approved 21 Nov 2026). Shows whose it is; setting a new password uses it up and signs
// the person out everywhere, then signs them in here.
const INVALID_RESET = 'This reset link is not valid. Ask the Owner for a new one.';

async function findReset(db: DB, token: string) {
  // A link made from the server for an Owner who is locked out (scripts/owner-reset.ts, 23 Nov 2026) is marked as made
  // by the person themselves (no one can do that in the app) and works for an Owner too.
  const r = await one<{ id: string; user_id: string; name: string; signIn: string; ownerAnywhere: number }>(db, `
    SELECT r.id, r.user_id, u.name, ${signInSql('u')} AS signIn,
      (r.created_by IS NOT r.user_id AND EXISTS (SELECT 1 FROM memberships x WHERE x.user_id = u.id AND x.role = 'owner')) AS ownerAnywhere
    FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > ?
      AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = r.user_id AND m.business_id = r.business_id)`, await sha256(token), now());
  if (!r || r.ownerAnywhere) fail(404, INVALID_RESET);
  return r;
}

inviteRoutes.get('/resets/:token', async (c) => {
  const r = await findReset(c.env.DB, c.req.param('token'));
  return c.json({ name: r.name, signIn: r.signIn });
});

inviteRoutes.post('/resets/:token', async (c) => {
  const db = c.env.DB;
  const data = await body(c);
  const password = typeof data.password === 'string' ? data.password : '';
  const r = await findReset(db, c.req.param('token'));
  if (password.length < MIN_PASSWORD) fail(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  const t = now();
  try {
    await db.batch([
      stmt(db, 'UPDATE password_resets SET used_at = ? WHERE id = ?', t, r.id),
      stmt(db, 'UPDATE password_resets SET revoked_at = ? WHERE user_id = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL', t, r.user_id, r.id),
      stmt(db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), r.user_id),
      stmt(db, 'DELETE FROM sessions WHERE user_id = ?', r.user_id),
    ]);
  } catch (e) {
    if (String((e as Error).message).includes('reset_unusable')) fail(404, INVALID_RESET);
    throw e;
  }
  await startSession(c, db, r.user_id);
  return c.json({ ok: true });
});
