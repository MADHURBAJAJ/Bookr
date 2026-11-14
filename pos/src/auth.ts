// Sign-in for the POS. Two cookies, both HttpOnly and holding only random tokens (their SHA-256 is stored):
// - pos_device: marks a counter device an Owner set up. PIN sign-in works only on such a device.
// - pos_session: the person signed in. Owners and managers sign in with email and password; counter staff with a PIN.
// Every business route then checks the person's role in that business (requireAction), on every request.
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { now, one, run, stmt, type DB } from '../../src/db';
import { randomToken, sha256 } from '../../src/crypto';
import { fail, isUuid } from '../../src/http';
import { can, isRole, type Action } from './permissions';
import type { AppEnv } from './types';

export const SESSION_COOKIE = 'pos_session';
export const DEVICE_COOKIE = 'pos_device';
const HOUR = 60 * 60 * 1000;
export const PASSWORD_SESSION_MS = 7 * 24 * HOUR;
export const PIN_SESSION_MS = 12 * HOUR;
export const PIN_TRIES = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;

const cookieOpts = (maxAgeMs: number) => ({ httpOnly: true, secure: true, sameSite: 'Strict' as const, path: '/', maxAge: Math.floor(maxAgeMs / 1000) });

export async function startSession(c: Context<AppEnv>, db: DB, staffId: string, kind: 'password' | 'pin', deviceId: string | null): Promise<void> {
  const token = randomToken();
  const ms = kind === 'pin' ? PIN_SESSION_MS : PASSWORD_SESSION_MS;
  const t = now();
  await stmt(db, 'INSERT INTO sessions (id, staff_id, device_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    await sha256(token), staffId, deviceId, kind, t, t + ms).run();
  setCookie(c, SESSION_COOKIE, token, cookieOpts(ms));
}

export async function endSession(c: Context<AppEnv>, db: DB): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await run(db, 'DELETE FROM sessions WHERE id = ?', await sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

export async function setDeviceCookie(c: Context<AppEnv>, token: string): Promise<void> {
  setCookie(c, DEVICE_COOKIE, token, cookieOpts(400 * 24 * HOUR));
}

/** The counter device this browser is, if any (and not revoked). */
export async function currentDevice(c: Context<AppEnv>): Promise<{ id: string; business_id: string; name: string; pin_failures: number; locked_until: number | null } | null> {
  const token = getCookie(c, DEVICE_COOKIE);
  if (!token) return null;
  return one(c.env.DB, 'SELECT id, business_id, name, pin_failures, locked_until FROM devices WHERE token_hash = ? AND revoked_at IS NULL', await sha256(token));
}

export const requireStaff: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) fail(401, 'Please sign in.');
  const row = await one<{ id: string; name: string; role: string; business_id: string; kind: string; device_id: string | null; sid: string }>(c.env.DB, `
    SELECT st.id, st.name, st.role, st.business_id, s.kind, s.device_id, s.id AS sid
    FROM sessions s JOIN staff st ON st.id = s.staff_id
    WHERE s.id = ? AND s.expires_at > ? AND st.active = 1`, await sha256(token), now());
  if (!row || !isRole(row.role)) {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    fail(401, 'Please sign in.');
  }
  if (row.kind === 'pin') {
    // A PIN session lives only on the device it was made on, and ends when that device is revoked.
    const device = await currentDevice(c);
    if (!device || device.id !== row.device_id) fail(401, 'Please sign in.');
  }
  c.set('staff', { id: row.id, name: row.name, role: row.role, businessId: row.business_id });
  c.set('sessionId', row.sid);
  c.set('deviceId', row.device_id);
  await next();
};

// The business named by :businessId must be the signed-in person's own, and their role must allow the action.
// Another business → 404, so ids cannot be probed. Role without the right → 403.
export function requireAction(action: Action): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const businessId = c.req.param('businessId');
    const staff = c.get('staff');
    if (!isUuid(businessId) || businessId !== staff.businessId) fail(404, 'Business not found.');
    if (!can(staff.role, action)) fail(403, 'Your role does not allow this.');
    c.set('businessId', businessId);
    await next();
  };
}
