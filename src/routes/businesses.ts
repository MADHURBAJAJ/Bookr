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

// Dashboard figures. Uses reports.view, so Entry staff are refused here even though they can
// read the account and head lists they need for tagging.
businessRoutes.get('/businesses/:businessId/dashboard', requireRole('reports.view'), async (c) => {
  const sql = c.get('sql');
  const bid = c.get('businessId');
  const accounts = await sql`
    SELECT id, name, kind, opening_balance::text AS "openingBalance"
    FROM accounts WHERE business_id = ${bid} ORDER BY kind = 'bank', name`;
  const [heads] = await sql<{ income: number; expense: number }[]>`
    SELECT count(*) FILTER (WHERE type = 'income')::int AS income,
           count(*) FILTER (WHERE type = 'expense')::int AS expense
    FROM heads WHERE business_id = ${bid}`;
  return c.json({ accounts, heads });
});
