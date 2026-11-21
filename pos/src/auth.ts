// Sign-in for the POS. Two cookies, both HttpOnly and holding only random tokens (their SHA-256 is stored):
// - pos_device: marks a counter device an Owner set up. PIN sign-in works only on such a device.
// - pos_session: the person signed in. Owners and managers sign in with email and password; counter staff with a PIN.
// Every business route then checks the person's role in that business (requireAction), on every request.
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { now, one, run, stmt, type DB } from '../../src/db';
import { DUMMY_HASH, randomToken, sha256, verifyPassword } from '../../src/crypto';
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
export async function currentDevice(c: Context<AppEnv>): Promise<{ id: string; business_id: string; name: string; pin_failures: number; locked_until: number | null; station_id: string | null } | null> {
  const token = getCookie(c, DEVICE_COOKIE);
  if (!token) return null;
  return one(c.env.DB, 'SELECT id, business_id, name, pin_failures, locked_until, station_id FROM devices WHERE token_hash = ? AND revoked_at IS NULL', await sha256(token));
}

export const requireStaff: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) fail(401, 'Please sign in.');
  const deviceToken = getCookie(c, DEVICE_COOKIE);
  // One trip: the session, the person, their business, and (for a PIN session) that it is on its own, unrevoked device.
  const row = await one<{ id: string; name: string; role: string; business_id: string; kind: string; device_id: string | null; sid: string; device_ok: number;
    b_name: string; fy_start_month: number; shift_start_hour: number; tab_age_days: number; tables: string | null; disc_limit_bp: number; b_status: string; support: number; login_id: string | null }>(c.env.DB, `
    SELECT st.id, st.name, st.role, st.business_id, s.kind, s.device_id, s.id AS sid,
      (s.kind <> 'pin' OR EXISTS (SELECT 1 FROM devices d WHERE d.id = s.device_id AND d.token_hash = ? AND d.revoked_at IS NULL)) AS device_ok,
      b.name AS b_name, b.fy_start_month, b.shift_start_hour, b.tab_age_days, b.tables, b.disc_limit_bp, b.status AS b_status, st.support, st.login_id
    FROM sessions s JOIN staff st ON st.id = s.staff_id JOIN businesses b ON b.id = st.business_id
    WHERE s.id = ? AND s.expires_at > ? AND st.active = 1`, deviceToken ? await sha256(deviceToken) : '', await sha256(token), now());
  if (!row || !isRole(row.role)) {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    fail(401, 'Please sign in.');
  }
  // A PIN session lives only on the device it was made on, and ends when that device is revoked.
  if (!row.device_ok) fail(401, 'Please sign in.');
  // A paused restaurant: nobody works in it until Bookr POS resumes it (its data is kept).
  if (row.b_status !== 'active') fail(403, 'This restaurant is paused. Please contact Bookr POS.');
  c.set('loginId', row.login_id);
  c.set('support', !!row.support);
  c.set('staff', { id: row.id, name: row.name, role: row.role, businessId: row.business_id });
  c.set('business', { id: row.business_id, name: row.b_name, fy_start_month: row.fy_start_month, shift_start_hour: row.shift_start_hour, tab_age_days: row.tab_age_days, tables: row.tables, disc_limit_bp: row.disc_limit_bp });
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

/**
 * A manager or owner approving something at the counter with their PIN (cancelling an item already sent to the kitchen,
 * 21 Nov 2026). Wrong PINs count towards this device's lock, the same as PIN sign-in, so a PIN cannot be guessed here.
 */
export async function approverOf(c: Context<AppEnv>, approverId: unknown, pin: unknown): Promise<{ id: string; name: string }> {
  const bid = c.get('businessId');
  const device = await currentDevice(c);
  const t = now();
  if (device?.locked_until && device.locked_until > t) fail(429, 'Too many wrong PINs. Try again in a few minutes.');
  const a = typeof approverId === 'string' && isUuid(approverId) ? await one<{ id: string; name: string; pin_hash: string | null }>(c.env.DB,
    "SELECT id, name, pin_hash FROM staff WHERE id = ? AND business_id = ? AND active = 1 AND support = 0 AND role IN ('owner', 'manager')", approverId, bid) : null;
  const ok = typeof pin === 'string' && /^\d{4,6}$/.test(pin) && (await verifyPassword(pin, a?.pin_hash ?? DUMMY_HASH));
  if (!a || !a.pin_hash || !ok) {
    if (device) {
      const failures = device.pin_failures + 1;
      const lock = failures >= PIN_TRIES ? t + PIN_LOCK_MS : null;
      await stmt(c.env.DB, 'UPDATE devices SET pin_failures = ?, locked_until = ? WHERE id = ?', lock ? 0 : failures, lock, device.id).run();
      if (lock) fail(429, 'Too many wrong PINs. PIN entry is locked on this device for 15 minutes.');
    }
    fail(403, a && !a.pin_hash ? `${a.name} has no PIN yet. The Owner sets one in Settings, Staff and PINs.` : 'Wrong PIN: a manager or owner must approve.');
  }
  if (device?.pin_failures) await stmt(c.env.DB, 'UPDATE devices SET pin_failures = 0 WHERE id = ?', device.id).run();
  return { id: a.id, name: a.name };
}
export const isManager = (c: Context<AppEnv>) => ['owner', 'manager'].includes(c.get('staff').role);
/**
 * A step a cashier may not take alone (21 Nov 2026): a manager or owner approves it themselves, or with their PIN on this
 * device. With no PIN sent, the answer is a 403 with code 'approval', and the screen asks for one and tries again.
 */
export async function approval(c: Context<AppEnv>, data: Record<string, unknown>, what: string): Promise<{ id: string; name: string }> {
  if (isManager(c)) return { id: c.get('staff').id, name: c.get('staff').name };
  if (data.approverId === undefined && data.approverPin === undefined) throw new HTTPException(403, { message: `${what} needs a manager's or owner's PIN.`, cause: { code: 'approval' } });
  return approverOf(c, data.approverId, data.approverPin);
}
