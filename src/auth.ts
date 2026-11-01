import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from './types';
import { now, one, run, stmt, type DB } from './db';
import { randomToken, sha256 } from './crypto';
import { can, isRole, type Action } from './permissions';
import { fail, isUuid } from './http';

export const SESSION_COOKIE = 'bookr_session';
const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_MS = 5 * 60 * 1000;

export async function startSession(c: Context<AppEnv>, db: DB, userId: string): Promise<void> {
  const token = randomToken();
  const id = await sha256(token);
  const t = now();
  await db.batch([
    stmt(db, 'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      id, userId, t, t + SESSION_DAYS * DAY_MS, t),
    stmt(db, 'UPDATE users SET last_active_at = ? WHERE id = ?', t, userId),
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function endSession(c: Context<AppEnv>, db: DB): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await run(db, 'DELETE FROM sessions WHERE id = ?', await sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

// Loads the signed-in user from the session cookie, or answers 401.
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) fail(401, 'Please sign in.');
  const db = c.env.DB;
  const id = await sha256(token);
  const t = now();
  const row = await one<{ id: string; name: string; email: string; last_seen_at: number }>(db, `
    SELECT u.id, u.name, u.email, s.last_seen_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?`, id, t);
  if (!row) {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    fail(401, 'Please sign in.');
  }
  if (row.last_seen_at < t - TOUCH_MS) {
    await db.batch([
      stmt(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', t, id),
      stmt(db, 'UPDATE users SET last_active_at = ? WHERE id = ?', t, row.id),
    ]);
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
    const m = await one<{ role: string }>(c.env.DB,
      'SELECT role FROM memberships WHERE business_id = ? AND user_id = ?', businessId, c.get('user').id);
    if (!m || !isRole(m.role)) fail(404, 'Business not found.');
    if (!can(m.role, action)) fail(403, 'Your role in this business does not allow this.');
    c.set('businessId', businessId);
    c.set('role', m.role);
    await next();
  };
}
