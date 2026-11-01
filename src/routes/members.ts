import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole, startSession } from '../auth';
import { all, isInviteUnusable, isLastOwner, isUniqueViolation, newId, now, one, stmt, type DB } from '../db';
import { body, fail, isEmail, isUuid, text } from '../http';
import { hashPassword, randomToken, sha256, verifyPassword } from '../crypto';
import { isRole } from '../permissions';

const INVITE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;
const LAST_OWNER = 'A business needs at least one Owner.';

export const memberRoutes = new Hono<AppEnv>();

// People in a business plus pending invites, for the Users and roles screen. Owner only.
memberRoutes.get('/businesses/:businessId/members', requireRole('members.manage'), async (c) => {
  const bid = c.get('businessId');
  const members = await all(c.env.DB, `
    SELECT u.id, u.name, u.email, m.role, u.last_active_at AS lastActiveAt
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.business_id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'accountant' THEN 1 WHEN 'entry_staff' THEN 2 ELSE 3 END, u.name`, bid);
  const invites = await all(c.env.DB, `
    SELECT id, email, role, created_at AS createdAt, expires_at AS expiresAt
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

memberRoutes.delete('/businesses/:businessId/members/:userId', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  try {
    const res = await stmt(c.env.DB, 'DELETE FROM memberships WHERE business_id = ? AND user_id = ?',
      c.get('businessId'), userId).run();
    if (!res.meta.changes) fail(404, 'Person not found.');
  } catch (e) {
    if (isLastOwner(e)) fail(409, LAST_OWNER);
    throw e;
  }
  return c.json({ ok: true });
});

// Creates an invite and returns a link for the Owner to share. No email is sent in Phase 1.
memberRoutes.post('/businesses/:businessId/invites', requireRole('members.manage'), async (c) => {
  const data = await body(c);
  const email = text(data, 'email', 'Email', { max: 254 })!.toLowerCase();
  if (!isEmail(email)) fail(400, 'Enter a valid email address.');
  if (!isRole(data.role)) fail(400, 'Role must be one of Owner, Accountant, Entry staff or Viewer.');
  const bid = c.get('businessId');
  const db = c.env.DB;
  const already = await one(db, `
    SELECT 1 AS ok FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.business_id = ? AND lower(u.email) = ?`, bid, email);
  if (already) fail(409, 'This person is already in this business.');
  const token = randomToken();
  const id = newId();
  const t = now();
  const expiresAt = t + INVITE_DAYS * DAY_MS;
  // One batch: a new invite replaces any pending one for the same email.
  await db.batch([
    stmt(db, `UPDATE invites SET revoked_at = ?
      WHERE business_id = ? AND lower(email) = ? AND accepted_at IS NULL AND revoked_at IS NULL`, t, bid, email),
    stmt(db, `INSERT INTO invites (id, business_id, email, role, invited_by, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, email, data.role, c.get('user').id, await sha256(token), t, expiresAt),
  ]);
  const origin = new URL(c.req.url).origin;
  return c.json({ id, expiresAt, link: `${origin}/#/invite/${token}` }, 201);
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
  const inv = await one<{ id: string; business_id: string; business_name: string; email: string; role: string }>(db, `
    SELECT i.id, i.business_id, b.name AS business_name, i.email, i.role
    FROM invites i JOIN businesses b ON b.id = i.business_id
    WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
    await sha256(token), now());
  if (!inv) fail(404, INVALID_INVITE);
  return inv;
}

inviteRoutes.get('/invites/:token', async (c) => {
  const inv = await findInvite(c.env.DB, c.req.param('token'));
  const user = await one(c.env.DB, 'SELECT 1 AS ok FROM users WHERE lower(email) = lower(?)', inv.email);
  return c.json({ businessName: inv.business_name, email: inv.email, role: inv.role, hasAccount: !!user });
});

// New person: sets a name and password. Existing person: confirms with their current password.
// The claim, the new user and the membership go in one batch; the invites_accept_once trigger
// rolls the whole batch back if the link was used, revoked or expired in the meantime.
inviteRoutes.post('/invites/:token/accept', async (c) => {
  const db = c.env.DB;
  const data = await body(c);
  const password = typeof data.password === 'string' ? data.password : '';
  const inv = await findInvite(db, c.req.param('token'));
  const existing = await one<{ id: string; password_hash: string }>(db,
    'SELECT id, password_hash FROM users WHERE lower(email) = lower(?)', inv.email);
  const t = now();
  const statements = [stmt(db, 'UPDATE invites SET accepted_at = ? WHERE id = ?', t, inv.id)];
  let userId: string;
  if (existing) {
    if (!(await verifyPassword(password, existing.password_hash))) fail(401, 'Password is incorrect.');
    userId = existing.id;
  } else {
    const name = text(data, 'name', 'Your name', { max: 120 })!;
    if (password.length < MIN_PASSWORD) fail(400, `Password must be at least ${MIN_PASSWORD} characters.`);
    userId = newId();
    statements.push(stmt(db, 'INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      userId, name, inv.email, await hashPassword(password), t));
  }
  statements.push(stmt(db, `INSERT INTO memberships (business_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (business_id, user_id) DO NOTHING`, inv.business_id, userId, inv.role, t));
  try {
    await db.batch(statements);
  } catch (e) {
    if (isInviteUnusable(e)) fail(404, INVALID_INVITE);
    if (isUniqueViolation(e)) fail(409, 'An account with this email was just created. Open the link again to continue.');
    throw e;
  }
  await startSession(c, db, userId);
  return c.json({ ok: true });
});
