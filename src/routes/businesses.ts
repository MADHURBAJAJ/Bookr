import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { body, date, fail, text } from '../http';
import { createBusiness } from '../defaults';

export const businessRoutes = new Hono<AppEnv>();

// Only someone who is already an Owner somewhere can start a new business; they become its Owner.
businessRoutes.post('/businesses', async (c) => {
  const user = c.get('user');
  const sql = c.get('sql');
  const [owner] = await sql`SELECT 1 FROM memberships WHERE user_id = ${user.id} AND role = 'owner' LIMIT 1`;
  if (!owner) fail(403, 'Only an Owner can create a business.');
  const data = await body(c);
  const name = text(data, 'name', 'Business name', { max: 120 })!;
  const fyStart = date(data, 'fyStart', 'Financial year start');
  const id = await createBusiness(sql, { name, fyStart, ownerId: user.id });
  return c.json({ id }, 201);
});

businessRoutes.get('/businesses/:businessId', requireRole('business.view'), async (c) => {
  const [b] = await c.get('sql')`
    SELECT id, name, to_char(fy_start, 'YYYY-MM-DD') AS "fyStart", is_demo AS "isDemo"
    FROM businesses WHERE id = ${c.get('businessId')}`;
  return c.json({ ...b, role: c.get('role') });
});

businessRoutes.patch('/businesses/:businessId', requireRole('business.edit'), async (c) => {
  const data = await body(c);
  const name = text(data, 'name', 'Business name', { max: 120 })!;
  const fyStart = date(data, 'fyStart', 'Financial year start');
  await c.get('sql')`UPDATE businesses SET name = ${name}, fy_start = ${fyStart} WHERE id = ${c.get('businessId')}`;
  return c.json({ ok: true });
});
