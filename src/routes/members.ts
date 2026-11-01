import { Hono } from 'hono';
import type { AppEnv } from '../types';
import type { Query as Sql } from '../db';
import { requireRole, startSession } from '../auth';
import { body, fail, isEmail, isUuid, text } from '../http';
import { hashPassword, randomToken, sha256, verifyPassword } from '../crypto';
import { isRole } from '../permissions';

const INVITE_DAYS = 7;
const MIN_PASSWORD = 10;

export const memberRoutes = new Hono<AppEnv>();

// People in a business plus pending invites, for the Users and roles screen. Owner only.
memberRoutes.get('/businesses/:businessId/members', requireRole('members.manage'), async (c) => {
  const sql = c.get('sql');
  const bid = c.get('businessId');
  const members = await sql`
    SELECT u.id, u.name, u.email, m.role, u.last_active_at AS "lastActiveAt"
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.business_id = ${bid}
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'accountant' THEN 1 WHEN 'entry_staff' THEN 2 ELSE 3 END, u.name`;
  const invites = await sql`
    SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"
    FROM invites
    WHERE business_id = ${bid} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    ORDER BY created_at DESC`;
  return c.json({ members, invites });
});

// One person's roles across businesses — limited to businesses where the caller is also Owner,
// so an Owner never learns about businesses they have no say in.
memberRoutes.get('/businesses/:businessId/members/:userId/memberships', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const rows = await c.get('sql')`
    SELECT b.id, b.name, m.role
    FROM memberships m
    JOIN businesses b ON b.id = m.business_id
    JOIN memberships mine ON mine.business_id = m.business_id AND mine.user_id = ${c.get('user').id} AND mine.role = 'owner'
    WHERE m.user_id = ${userId}
    ORDER BY b.name`;
  return c.json({ memberships: rows });
});

// A business must always keep at least one Owner. Locks the Owner rows so two changes cannot race.
async function assertNotLastOwner(tx: Sql, businessId: string, userId: string) {
  const owners = await tx<{ user_id: string }[]>`
    SELECT user_id FROM memberships WHERE business_id = ${businessId} AND role = 'owner' FOR UPDATE`;
  if (owners.length <= 1 && owners.some((o) => o.user_id === userId)) {
    fail(409, 'A business needs at least one Owner.');
  }
}

memberRoutes.patch('/businesses/:businessId/members/:userId', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const data = await body(c);
  if (!isRole(data.role)) fail(400, 'Role must be one of Owner, Accountant, Entry staff or Viewer.');
  const role = data.role;
  const bid = c.get('businessId');
  await c.get('sql').begin(async (tx) => {
    const [m] = await tx<{ role: string }[]>`
      SELECT role FROM memberships WHERE business_id = ${bid} AND user_id = ${userId} FOR UPDATE`;
    if (!m) fail(404, 'Person not found.');
    if (m.role === 'owner' && role !== 'owner') await assertNotLastOwner(tx, bid, userId);
    await tx`UPDATE memberships SET role = ${role} WHERE business_id = ${bid} AND user_id = ${userId}`;
  });
  return c.json({ ok: true });
});

memberRoutes.delete('/businesses/:businessId/members/:userId', requireRole('members.manage'), async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) fail(404, 'Person not found.');
  const bid = c.get('businessId');
  await c.get('sql').begin(async (tx) => {
    const [m] = await tx<{ role: string }[]>`
      SELECT role FROM memberships WHERE business_id = ${bid} AND user_id = ${userId} FOR UPDATE`;
    if (!m) fail(404, 'Person not found.');
    if (m.role === 'owner') await assertNotLastOwner(tx, bid, userId);
    await tx`DELETE FROM memberships WHERE business_id = ${bid} AND user_id = ${userId}`;
  });
  return c.json({ ok: true });
});

// Creates an invite and returns a link for the Owner to share. No email is sent in Phase 1.
memberRoutes.post('/businesses/:businessId/invites', requireRole('members.manage'), async (c) => {
  const data = await body(c);
  const email = text(data, 'email', 'Email', { max: 254 })!.toLowerCase();
  if (!isEmail(email)) fail(400, 'Enter a valid email address.');
  if (!isRole(data.role)) fail(400, 'Role must be one of Owner, Accountant, Entry staff or Viewer.');
  const role = data.role;
  const bid = c.get('businessId');
  const sql = c.get('sql');
  const [already] = await sql`
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.business_id = ${bid} AND lower(u.email) = ${email}`;
  if (already) fail(409, 'This person is already in this business.');
  const token = randomToken();
  const tokenHash = await sha256(token);
  const [invite] = await sql.begin(async (tx) => {
    // A new invite replaces any pending one for the same email.
    await tx`
      UPDATE invites SET revoked_at = now()
      WHERE business_id = ${bid} AND lower(email) = ${email} AND accepted_at IS NULL AND revoked_at IS NULL`;
    return tx`
      INSERT INTO invites (business_id, email, role, invited_by, token_hash, expires_at)
      VALUES (${bid}, ${email}, ${role}, ${c.get('user').id}, ${tokenHash}, now() + make_interval(days => ${INVITE_DAYS}))
      RETURNING id, expires_at AS "expiresAt"`;
  });
  const origin = new URL(c.req.url).origin;
  return c.json({ id: invite.id, expiresAt: invite.expiresAt, link: `${origin}/#/invite/${token}` }, 201);
});

memberRoutes.delete('/businesses/:businessId/invites/:inviteId', requireRole('members.manage'), async (c) => {
  const inviteId = c.req.param('inviteId');
  if (!isUuid(inviteId)) fail(404, 'Invite not found.');
  const rows = await c.get('sql')`
    UPDATE invites SET revoked_at = now()
    WHERE id = ${inviteId} AND business_id = ${c.get('businessId')} AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id`;
  if (!rows.length) fail(404, 'Invite not found.');
  return c.json({ ok: true });
});

// Public: anyone holding the link can see what it is for. Nothing else about the business is shown.
export const inviteRoutes = new Hono<AppEnv>();

async function findInvite(sql: Sql, token: string) {
  const [inv] = await sql<{ id: string; business_id: string; business_name: string; email: string; role: string; usable: boolean }[]>`
    SELECT i.id, i.business_id, b.name AS business_name, i.email, i.role,
           (i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS usable
    FROM invites i JOIN businesses b ON b.id = i.business_id
    WHERE i.token_hash = ${await sha256(token)}`;
  if (!inv || !inv.usable) fail(404, 'This invite link is not valid. Ask the Owner for a new one.');
  return inv;
}

inviteRoutes.get('/invites/:token', async (c) => {
  const sql = c.get('sql');
  const inv = await findInvite(sql, c.req.param('token'));
  const [user] = await sql`SELECT 1 FROM users WHERE lower(email) = lower(${inv.email})`;
  return c.json({ businessName: inv.business_name, email: inv.email, role: inv.role, hasAccount: !!user });
});

// New person: sets a name and password. Existing person: confirms with their current password.
inviteRoutes.post('/invites/:token/accept', async (c) => {
  const sql = c.get('sql');
  const data = await body(c);
  const password = typeof data.password === 'string' ? data.password : '';
  const userId = await sql.begin(async (tx) => {
    const inv = await findInvite(tx, c.req.param('token'));
    await tx`SELECT 1 FROM invites WHERE id = ${inv.id} FOR UPDATE`;
    const [existing] = await tx<{ id: string; password_hash: string }[]>`
      SELECT id, password_hash FROM users WHERE lower(email) = lower(${inv.email})`;
    let id: string;
    if (existing) {
      if (!(await verifyPassword(password, existing.password_hash))) fail(401, 'Password is incorrect.');
      id = existing.id;
    } else {
      const name = text(data, 'name', 'Your name', { max: 120 })!;
      if (password.length < MIN_PASSWORD) fail(400, `Password must be at least ${MIN_PASSWORD} characters.`);
      const [u] = await tx<{ id: string }[]>`
        INSERT INTO users (name, email, password_hash)
        VALUES (${name}, ${inv.email}, ${await hashPassword(password)}) RETURNING id`;
      id = u.id;
    }
    await tx`
      INSERT INTO memberships (business_id, user_id, role) VALUES (${inv.business_id}, ${id}, ${inv.role})
      ON CONFLICT (business_id, user_id) DO NOTHING`;
    await tx`UPDATE invites SET accepted_at = now() WHERE id = ${inv.id}`;
    return id;
  });
  await startSession(c, sql, userId);
  return c.json({ ok: true });
});
