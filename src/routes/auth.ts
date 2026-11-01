import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { all, one } from '../db';
import { DUMMY_HASH, verifyPassword } from '../crypto';
import { endSession, requireUser, startSession } from '../auth';
import { body, fail, text } from '../http';
import { actionsFor, isRole, type Role } from '../permissions';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/login', async (c) => {
  const data = await body(c);
  const email = text(data, 'email', 'Email', { max: 254 })!;
  const password = typeof data.password === 'string' ? data.password : '';
  const user = await one<{ id: string; password_hash: string }>(c.env.DB,
    'SELECT id, password_hash FROM users WHERE lower(email) = lower(?)', email);
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) fail(401, 'Email or password is incorrect.');
  await startSession(c, c.env.DB, user.id);
  return c.json({ ok: true });
});

authRoutes.post('/auth/logout', async (c) => {
  await endSession(c, c.env.DB);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireUser, async (c) => {
  const user = c.get('user');
  const rows = await all<{ id: string; name: string; is_demo: number; role: string }>(c.env.DB, `
    SELECT b.id, b.name, b.is_demo, m.role
    FROM memberships m JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = ?
    ORDER BY b.name`, user.id);
  const businesses = rows
    .filter((r) => isRole(r.role))
    .map((r) => ({ id: r.id, name: r.name, isDemo: r.is_demo === 1, role: r.role, actions: actionsFor(r.role as Role) }));
  return c.json({
    user,
    businesses,
    canCreateBusiness: businesses.some((b) => b.role === 'owner'),
  });
});
