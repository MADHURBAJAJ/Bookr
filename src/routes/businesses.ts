import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, one, run } from '../db';
import { body, date, fail, text } from '../http';
import { createBusiness } from '../defaults';

export const businessRoutes = new Hono<AppEnv>();

// Only someone who is already an Owner somewhere can start a new business; they become its Owner.
businessRoutes.post('/businesses', async (c) => {
  const user = c.get('user');
  const owner = await one(c.env.DB, "SELECT 1 AS ok FROM memberships WHERE user_id = ? AND role = 'owner' LIMIT 1", user.id);
  if (!owner) fail(403, 'Only an Owner can create a business.');
  const data = await body(c);
  const name = text(data, 'name', 'Business name', { max: 120 })!;
  const fyStart = date(data, 'fyStart', 'Financial year start');
  const id = await createBusiness(c.env.DB, { name, fyStart, ownerId: user.id });
  return c.json({ id }, 201);
});

businessRoutes.get('/businesses/:businessId', requireRole('business.view'), async (c) => {
  const b = await one<{ id: string; name: string; fyStart: string; isDemo: number }>(c.env.DB,
    'SELECT id, name, fy_start AS fyStart, is_demo AS isDemo FROM businesses WHERE id = ?', c.get('businessId'));
  return c.json({ ...b, isDemo: b?.isDemo === 1, role: c.get('role') });
});

businessRoutes.patch('/businesses/:businessId', requireRole('business.edit'), async (c) => {
  const data = await body(c);
  const name = text(data, 'name', 'Business name', { max: 120 })!;
  const fyStart = date(data, 'fyStart', 'Financial year start');
  await run(c.env.DB, 'UPDATE businesses SET name = ?, fy_start = ? WHERE id = ?', name, fyStart, c.get('businessId'));
  return c.json({ ok: true });
});

// Dashboard figures. Uses reports.view, so Entry staff are refused here even though they can
// read the account and head lists they need for tagging.
businessRoutes.get('/businesses/:businessId/dashboard', requireRole('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const accounts = await all(c.env.DB, `
    SELECT id, name, kind, opening_balance_paise AS openingBalancePaise
    FROM accounts WHERE business_id = ? ORDER BY kind = 'bank', name`, bid);
  const heads = await one<{ income: number; expense: number }>(c.env.DB, `
    SELECT count(*) FILTER (WHERE type = 'income') AS income,
           count(*) FILTER (WHERE type = 'expense') AS expense
    FROM heads WHERE business_id = ?`, bid);
  return c.json({ accounts, heads });
});
