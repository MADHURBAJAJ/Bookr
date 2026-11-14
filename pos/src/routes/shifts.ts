// Shift close: the drawer count against the cash taken, totals by payment mode and by UPI account, the bill number range
// of each billing name, and what to look at (voids, reprints, discounts). Open orders must be billed or kept as a tab, and
// printed bills paid or voided, before the shift closes; tabs carry on and are listed apart. The close goes to Bookr.
import { Hono } from 'hono';
import { all, isUniqueViolation, newId, one, stmt, type DB } from '../../../src/db';
import { parsePaise } from '../../../src/money';
import { body, date, fail, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { rs } from '../billing';
import { clock, loadBusiness } from '../util';
import type { AppEnv } from '../types';

export const shiftRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
shiftRoutes.use(`${B}/*`, requireStaff);

const NOTES = ['2000', '500', '200', '100', '50', '20', '10'];

export async function shiftSummary(db: DB, bid: string, day: string, tabAgeDays: number) {
  const byMode = await all<{ mode: string; n: number; paise: number }>(db, `SELECT p.mode, count(*) AS n, sum(p.amount_paise) AS paise
    FROM payments p JOIN settlements s ON s.id = p.settlement_id WHERE p.business_id = ? AND p.shift_day = ? AND s.kind = 'bills' GROUP BY p.mode ORDER BY p.mode`, bid, day);
  const receipts = await all<{ mode: string; n: number; paise: number }>(db, `SELECT p.mode, count(*) AS n, sum(p.amount_paise) AS paise
    FROM payments p JOIN settlements s ON s.id = p.settlement_id WHERE p.business_id = ? AND p.shift_day = ? AND s.kind = 'receipt' GROUP BY p.mode ORDER BY p.mode`, bid, day);
  const byAccount = await all<{ name: string; entity: string; paise: number }>(db, `SELECT a.name, e.name AS entity, sum(p.amount_paise) AS paise
    FROM payments p JOIN pay_accounts a ON a.id = p.pay_account_id JOIN billing_entities e ON e.id = a.entity_id
    WHERE p.business_id = ? AND p.shift_day = ? AND p.mode = 'upi' GROUP BY a.id ORDER BY a.name`, bid, day);
  const billed = await all<{ entity: string; first: string; last: string; n: number; voids: number; paise: number }>(db, `SELECT e.name AS entity,
      min(b.bill_no) AS first, max(b.bill_no) AS last, count(*) AS n, sum(b.status = 'void') AS voids, sum(CASE WHEN b.status <> 'void' THEN b.total_paise ELSE 0 END) AS paise
    FROM bills b JOIN billing_entities e ON e.id = b.entity_id WHERE b.business_id = ? AND b.shift_day = ? GROUP BY e.id ORDER BY e.is_default DESC, e.name`, bid, day);
  const events = await all<{ kind: string; n: number; paise: number }>(db,
    'SELECT kind, count(*) AS n, coalesce(sum(amount_paise), 0) AS paise FROM pos_events WHERE business_id = ? AND shift_day = ? GROUP BY kind', bid, day);
  const openOrders = await all<{ place: string; paise: number }>(db, `SELECT o.place, coalesce(sum(l.qty * l.price_paise), 0) AS paise
    FROM orders o LEFT JOIN order_lines l ON l.order_id = o.id WHERE o.business_id = ? AND o.status = 'open' GROUP BY o.id HAVING paise > 0`, bid);
  const unpaid = await all<{ bill_no: string; place: string; paise: number }>(db, `SELECT b.bill_no, o.place, b.total_paise AS paise
    FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.business_id = ? AND b.status = 'printed'`, bid);
  const tabs = await all<{ place: string; guest: string; since: string; paise: number }>(db, `SELECT o.place, o.guest_name AS guest, o.opened_shift_day AS since,
      coalesce(sum(l.qty * l.price_paise), 0) AS paise
    FROM orders o LEFT JOIN order_lines l ON l.order_id = o.id WHERE o.business_id = ? AND o.status = 'tab' GROUP BY o.id ORDER BY o.opened_at`, bid);
  const cashIn = [...byMode, ...receipts].filter((r) => r.mode === 'cash').reduce((s, r) => s + r.paise, 0);
  const oldTabDay = new Date(Date.parse(day + 'T00:00:00Z') - tabAgeDays * 86400000).toISOString().slice(0, 10);
  return { shiftDay: day, byMode, receipts, byAccount, billed, events, openOrders, unpaidBills: unpaid, tabs: tabs.map((x) => ({ ...x, old: x.since <= oldTabDay })), cashInPaise: cashIn };
}

shiftRoutes.get(`${B}/shifts/:day`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const b = await loadBusiness(c.env.DB, bid);
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const closed = await one(c.env.DB, `SELECT opening_float_paise AS openingFloatPaise, counted, counted_paise AS countedPaise, expected_paise AS expectedPaise,
    difference_paise AS differencePaise, difference_reason AS differenceReason, closed_at AS closedAt FROM shift_closes WHERE business_id = ? AND shift_day = ?`, bid, day);
  return c.json({ summary: await shiftSummary(c.env.DB, bid, day, b.tab_age_days), closed, current: clock(b).shiftDay });
});

shiftRoutes.post(`${B}/shifts/:day/close`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const b = await loadBusiness(db, bid);
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const { t, shiftDay: current } = clock(b);
  if (day > current) fail(400, 'That shift has not started.');
  const s = await shiftSummary(db, bid, day, b.tab_age_days);
  if (s.openOrders.length) fail(409, `Bill these orders or keep them as a tab first: ${s.openOrders.map((o) => o.place).join(', ')}.`);
  if (s.unpaidBills.length) fail(409, `These bills are printed but not paid: ${s.unpaidBills.map((x) => x.bill_no).join(', ')}. Settle or void them first.`);

  const data = await body(c);
  const float = parsePaise(typeof data.openingFloat === 'string' ? data.openingFloat : '');
  if (float === null || float < 0) fail(400, 'Opening float must be an amount in rupees.');
  const raw = (data.counted ?? {}) as Record<string, unknown>;
  const counted: Record<string, number> = {};
  let countedPaise = 0;
  for (const note of NOTES) {
    const n = raw[note] ?? 0;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100000) fail(400, `Count of ₹${note} notes must be a whole number.`);
    counted[note] = n;
    countedPaise += n * Number(note) * 100;
  }
  const loose = parsePaise(typeof raw.loose === 'string' && raw.loose ? raw.loose : '0');
  if (loose === null || loose < 0) fail(400, 'Coins and small notes must be an amount in rupees.');
  counted.loose_paise = loose;
  countedPaise += loose;
  const expected = float + s.cashInPaise;
  const diff = countedPaise - expected;
  const reason = text(data, 'reason', 'A reason for the difference', { optional: diff === 0, max: 200 });
  const totals = { byMode: s.byMode, receipts: s.receipts, byAccount: s.byAccount, billed: s.billed, events: s.events, tabs: s.tabs };
  const id = newId();
  try {
    await db.batch([
      stmt(db, `INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise,
        difference_reason, totals, closed_by, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, bid, day, float, JSON.stringify(counted), countedPaise, expected, diff, diff === 0 ? null : reason, JSON.stringify(totals), c.get('staff').id, t),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'shift_closed', ?, ?)", newId(), bid, JSON.stringify({
        shiftDay: day, closedAt: t, closedBy: c.get('staff').name, openingFloatPaise: float, countedPaise, expectedPaise: expected, differencePaise: diff,
        differenceReason: diff === 0 ? null : reason, counted, ...totals,
      }), t),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'This shift is already closed.');
    throw e;
  }
  return c.json({ ok: true, countedPaise, expectedPaise: expected, differencePaise: diff, message: diff === 0 ? 'Drawer agrees.' : `Drawer is ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}.` }, 201);
});

// The exceptions report: every void, reprint, cancelled KOT line, discount, complimentary bill and limit warning of a shift.
shiftRoutes.get(`${B}/events`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const day = date({ day: c.req.query('day') ?? '' }, 'day', 'Shift day');
  return c.json({ events: await all(c.env.DB, `SELECT e.kind, e.ref, e.amount_paise AS amountPaise, e.reason, e.detail, s.name AS byName, e.at
    FROM pos_events e LEFT JOIN staff s ON s.id = e.by_staff WHERE e.business_id = ? AND e.shift_day = ? ORDER BY e.at DESC, e.id DESC`, bid, day) });
});

shiftRoutes.get(`${B}/outbox`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const pending = await one<{ n: number; oldest: number | null }>(c.env.DB, 'SELECT count(*) AS n, min(created_at) AS oldest FROM outbox WHERE business_id = ? AND sent_at IS NULL', bid);
  const failing = await all(c.env.DB, 'SELECT id, kind, attempts, last_error AS lastError, created_at AS createdAt FROM outbox WHERE business_id = ? AND sent_at IS NULL AND attempts > 0 ORDER BY created_at LIMIT 20', bid);
  return c.json({ pending: pending?.n ?? 0, oldestAt: pending?.oldest ?? null, failing });
});
