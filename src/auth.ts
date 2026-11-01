import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './types';
import type { Sql } from './db';
import { randomToken, sha256 } from './crypto';
import { can, isRole, type Action } from './permissions';
import { fail, isUuid } from './http';

export const SESSION_COOKIE = 'bookr_session';
const SESSION_DAYS = 30;

export async function startSession(c: Context<AppEnv>, sql: Sql, userId: string): Promise<void> {
  const token = randomToken();
  const id = await sha256(token);
  await sql`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${id}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  await sql`UPDATE users SET last_active_at = now() WHERE id = ${userId}`;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function endSession(c: Context<AppEnv>, sql: Sql): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await sql`DELETE FROM sessions WHERE id = ${await sha256(token)}`;
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

// Loads the signed-in user from the session cookie, or answers 401.
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) fail(401, 'Please sign in.');
  const sql = c.get('sql');
  const id = await sha256(token);
  const [row] = await sql<{ id: string; name: string; email: string; stale: boolean }[]>`
    SELECT u.id, u.name, u.email, s.last_seen_at < now() - interval '5 minutes' AS stale
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id} AND s.expires_at > now()`;
  if (!row) {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    fail(401, 'Please sign in.');
  }
  if (row.stale) {
    await sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${id}`;
    await sql`UPDATE users SET last_active_at = now() WHERE id = ${row.id}`;
  }
  c.set('user', { id: row.id, name: row.name, email: row.email });
  c.set('sessionId', id);
  await next();
};

// Checks the caller's role in the business named by :businessId against one action.
// Not a member → 404, so business ids cannot be probed. Member without the right → 403.
export function requireRole(action: Action): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const businessId = c.req.param('businessId');
    if (!isUuid(businessId)) fail(404, 'Business not found.');
    const [m] = await c.get('sql')<{ role: string }[]>`
      SELECT role FROM memberships WHERE business_id = ${businessId} AND user_id = ${c.get('user').id}`;
    if (!m || !isRole(m.role)) fail(404, 'Business not found.');
    if (!can(m.role, action)) fail(403, 'Your role in this business does not allow this.');
    c.set('businessId', businessId);
    c.set('role', m.role);
    await next();
  };
}
