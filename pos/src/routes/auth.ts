import { Hono } from 'hono';
import { all, newId, now, one, stmt } from '../../../src/db';
import { DUMMY_HASH, hashPassword, randomToken, sha256, verifyPassword } from '../../../src/crypto';
import { body, fail, isEmail, isUuid, text } from '../../../src/http';
import { currentDevice, endSession, PIN_LOCK_MS, PIN_TRIES, requireAction, requireStaff, setDeviceCookie, startSession } from '../auth';
import { PERMISSIONS, type Action } from '../permissions';
import type { AppEnv } from '../types';

export const authRoutes = new Hono<AppEnv>();

// Creates a business and its Owner, once, with the setup code (a Worker secret). The id is the business's id in Bookr.
authRoutes.post('/setup', async (c) => {
  const expected = c.env.POS_SETUP_TOKEN;
  const given = c.req.header('X-Setup-Token') ?? '';
  if (!expected || given.length !== expected.length || (await sha256(given)) !== (await sha256(expected))) fail(403, 'Setup is not allowed.');
  const data = await body(c);
  const id = text(data, 'businessId', 'Business id')!;
  if (!isUuid(id)) fail(400, 'Business id must be the business\'s id in Bookr.');
  const name = text(data, 'name', 'Business name')!;
  const ownerName = text(data, 'ownerName', 'Owner\'s name')!;
  const email = text(data, 'email', 'Email', { max: 254 })!;
  if (!isEmail(email)) fail(400, 'Email is not valid.');
  const password = typeof data.password === 'string' ? data.password : '';
  if (password.length < 12) fail(400, 'Password must be at least 12 characters.');
  if (await one(c.env.DB, 'SELECT 1 FROM businesses WHERE id = ?', id)) fail(409, 'This business is already set up.');
  const t = now();
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO businesses (id, name, created_at) VALUES (?, ?, ?)', id, name, t),
    stmt(c.env.DB, "INSERT INTO staff (id, business_id, name, role, email, password_hash, created_at) VALUES (?, ?, ?, 'owner', ?, ?, ?)",
      newId(), id, ownerName, email, await hashPassword(password), t),
  ]);
  return c.json({ ok: true });
});

authRoutes.post('/auth/login', async (c) => {
  const data = await body(c);
  const email = text(data, 'email', 'Email', { max: 254 })!;
  const password = typeof data.password === 'string' ? data.password : '';
  const st = await one<{ id: string; password_hash: string | null }>(c.env.DB,
    "SELECT id, password_hash FROM staff WHERE lower(email) = lower(?) AND active = 1 AND role IN ('owner', 'manager')", email);
  const ok = await verifyPassword(password, st?.password_hash ?? DUMMY_HASH);
  if (!st || !ok) fail(401, 'Email or password is incorrect.');
  await startSession(c, c.env.DB, st.id, 'password', null);
  return c.json({ ok: true });
});

// The counter's sign-in list: who can sign in with a PIN on this device. Only on a set-up device.
authRoutes.get('/device', async (c) => {
  const device = await currentDevice(c);
  if (!device) return c.json({ device: null });
  const people = await all<{ id: string; name: string; role: string }>(c.env.DB,
    'SELECT id, name, role FROM staff WHERE business_id = ? AND active = 1 AND pin_hash IS NOT NULL ORDER BY name', device.business_id);
  const b = await one<{ name: string }>(c.env.DB, 'SELECT name FROM businesses WHERE id = ?', device.business_id);
  return c.json({ device: { name: device.name, businessName: b?.name ?? '', locked: !!device.locked_until && device.locked_until > now() }, people });
});

authRoutes.post('/auth/pin', async (c) => {
  const device = await currentDevice(c);
  if (!device) fail(403, 'PIN sign-in works only on a counter device an Owner has set up.');
  const t = now();
  if (device.locked_until && device.locked_until > t) fail(429, 'Too many wrong PINs. Try again in a few minutes, or ask the Owner.');
  const data = await body(c);
  const staffId = text(data, 'staffId', 'Person')!;
  const pin = typeof data.pin === 'string' ? data.pin : '';
  const st = await one<{ id: string; pin_hash: string | null }>(c.env.DB,
    'SELECT id, pin_hash FROM staff WHERE id = ? AND business_id = ? AND active = 1', staffId, device.business_id);
  const ok = /^\d{4,6}$/.test(pin) && (await verifyPassword(pin, st?.pin_hash ?? DUMMY_HASH));
  if (!st || !st.pin_hash || !ok) {
    const failures = device.pin_failures + 1;
    const lock = failures >= PIN_TRIES ? t + PIN_LOCK_MS : null;
    await stmt(c.env.DB, 'UPDATE devices SET pin_failures = ?, locked_until = ? WHERE id = ?', lock ? 0 : failures, lock, device.id).run();
    fail(401, lock ? 'Too many wrong PINs. PIN sign-in is locked on this device for 15 minutes.' : 'Wrong PIN.');
  }
  await stmt(c.env.DB, 'UPDATE devices SET pin_failures = 0, locked_until = NULL WHERE id = ?', device.id).run();
  await startSession(c, c.env.DB, st.id, 'pin', device.id);
  return c.json({ ok: true });
});

authRoutes.post('/auth/logout', async (c) => {
  await endSession(c, c.env.DB);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireStaff, async (c) => {
  const s = c.get('staff');
  const b = await one<{ name: string; shift_start_hour: number; fy_start_month: number; tab_age_days: number }>(c.env.DB,
    'SELECT name, shift_start_hour, fy_start_month, tab_age_days FROM businesses WHERE id = ?', s.businessId);
  const actions = (Object.keys(PERMISSIONS) as Action[]).filter((a) => (PERMISSIONS[a] as readonly string[]).includes(s.role));
  return c.json({ staff: s, business: { id: s.businessId, ...b }, actions });
});

// Makes this browser a counter device of the business (Owner, signed in with a password on that device).
authRoutes.post('/businesses/:businessId/devices', requireStaff, requireAction('staff.manage'), async (c) => {
  const data = await body(c);
  const name = text(data, 'name', 'Device name', { max: 60 })!;
  const token = randomToken();
  const id = newId();
  await stmt(c.env.DB, 'INSERT INTO devices (id, business_id, name, token_hash, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, c.get('businessId'), name, await sha256(token), c.get('staff').id, now()).run();
  await setDeviceCookie(c, token);
  return c.json({ id }, 201);
});

authRoutes.get('/businesses/:businessId/devices', requireStaff, requireAction('staff.manage'), async (c) => {
  return c.json({ devices: await all(c.env.DB,
    'SELECT id, name, created_at AS createdAt, revoked_at AS revokedAt FROM devices WHERE business_id = ? ORDER BY created_at', c.get('businessId')) });
});

authRoutes.post('/businesses/:businessId/devices/:id/revoke', requireStaff, requireAction('staff.manage'), async (c) => {
  const r = await stmt(c.env.DB, 'UPDATE devices SET revoked_at = ? WHERE id = ? AND business_id = ? AND revoked_at IS NULL',
    now(), c.req.param('id'), c.get('businessId')).run();
  if (!r.meta.changes) fail(404, 'Device not found.');
  await stmt(c.env.DB, 'DELETE FROM sessions WHERE device_id = ?', c.req.param('id')).run();
  return c.json({ ok: true });
});
