import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { all, isUniqueViolation, now, one, stmt } from '../db';
import { DUMMY_HASH, verifyPassword } from '../crypto';
import { endSession, requireUser, startSession } from '../auth';
import { body, fail, normalizePhone, text } from '../http';
import { actionsFor, isRole, type Role } from '../permissions';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/login', async (c) => {
  const data = await body(c);
  // Email, or a mobile number for people who joined by phone (21 Nov 2026).
  const login = text(data, 'email', 'Email or mobile number', { max: 254 })!;
  const password = typeof data.password === 'string' ? data.password : '';
  const phone = login.includes('@') ? null : normalizePhone(login);
  const user = await one<{ id: string; password_hash: string }>(c.env.DB,
    phone ? 'SELECT id, password_hash FROM users WHERE phone = ?' : 'SELECT id, password_hash FROM users WHERE lower(email) = lower(?)', phone ?? login);
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) fail(401, phone ? 'Mobile number or password is incorrect.' : 'Email or password is incorrect.');
  await startSession(c, c.env.DB, user.id);
  return c.json({ ok: true });
});

authRoutes.post('/auth/logout', async (c) => {
  await endSession(c, c.env.DB);
  return c.json({ ok: true });
});

// Also sign in with a mobile number (approved 23 Nov 2026): someone who signs in by email adds (or removes) a mobile
// number on their own login, confirming with their password. Then either signs in, with the same password, and a phone
// invite to that number joins this same login. A number belongs to one login only.
authRoutes.put('/me/phone', requireUser, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const data = await body(c);
  const row = await one<{ password_hash: string; phone: string | null; email: string }>(db, 'SELECT password_hash, phone, email FROM users WHERE id = ?', user.id);
  if (row!.email.endsWith('@phone.bookr.invalid')) fail(400, 'You sign in with your mobile number. Ask the owner to change it.');
  if (!(await verifyPassword(typeof data.password === 'string' ? data.password : '', row!.password_hash))) fail(401, 'Password is incorrect.');
  const clear = data.phone === null || data.phone === '';
  const phone = clear ? null : normalizePhone(data.phone);
  if (!clear && !phone) fail(400, 'Enter a 10-digit mobile number.');
  if (phone && await one(db, 'SELECT 1 AS ok FROM users WHERE phone = ? AND id <> ?', phone, user.id)) fail(409, 'Another login already uses this number.');
  const t = now();
  const businesses = await all<{ id: string }>(db, 'SELECT business_id AS id FROM memberships WHERE user_id = ?', user.id);
  try {
    await db.batch([
      stmt(db, 'UPDATE users SET phone = ? WHERE id = ?', phone, user.id),
      ...businesses.map((b) => stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'me.phone', 'users', ?, ?, ?, ?)`, b.id, user.id, user.id, JSON.stringify({ phone: row!.phone }), JSON.stringify({ phone }), t)),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'Another login already uses this number.');
    throw e;
  }
  return c.json({ ok: true, phone });
});

authRoutes.get('/me', requireUser, async (c) => {
  const user = c.get('user');
  // cash_books (20 Nov 2026): the business keeps cashier cash books (a school), so it opens on them.
  const rows = await all<{ id: string; name: string; is_demo: number; role: string; cash_books: number }>(c.env.DB, `
    SELECT b.id, b.name, b.is_demo, m.role, EXISTS (SELECT 1 FROM branches x WHERE x.business_id = b.id) AS cash_books
    FROM memberships m JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = ?
    ORDER BY b.name`, user.id);
  const businesses = rows
    .filter((r) => isRole(r.role))
    .map((r) => ({ id: r.id, name: r.name, isDemo: r.is_demo === 1, role: r.role, cashBooks: r.cash_books === 1, actions: actionsFor(r.role as Role) }));
  const p = await one<{ phone: string | null; email: string }>(c.env.DB, 'SELECT phone, email FROM users WHERE id = ?', user.id);
  return c.json({
    user: { ...user, phone: p?.phone ?? null, phoneLogin: !!p?.email.endsWith('@phone.bookr.invalid') },
    businesses,
    canCreateBusiness: businesses.some((b) => b.role === 'owner'),
  });
});
