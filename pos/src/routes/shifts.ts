// Shift close: the drawer count against the cash taken, totals by payment mode and by UPI account, the bill number range
// of each billing name, and what to look at (voids, reprints, discounts). Open orders must be billed or kept as a tab, and
// printed bills paid or voided, before the shift closes; tabs carry on and are listed apart. The close goes to Bookr.
import { Hono } from 'hono';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../../../src/db';
import { parsePaise } from '../../../src/money';
import { body, date, fail, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { rs, shiftDayAt } from '../billing';
import { deskPending } from '../rooms';
import { notInDjubo } from './frontdesk';
import { audit, clock, isTrigger, bizOf, loadBusiness } from '../util';
import { sendOutbox, sendSoon } from '../sync';
import type { AppEnv } from '../types';

export const shiftRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
shiftRoutes.use(`${B}/*`, requireStaff);

const NOTES = ['2000', '500', '200', '100', '50', '20', '10'];

export async function shiftSummary(db: DB, bid: string, day: string, tabAgeDays: number, startHour = 8) {
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
  const outs = await all<{ kind: string; mode: string; amount_paise: number; note: string; at: number; by_name: string | null }>(db, `SELECT o.kind, o.mode, o.amount_paise, o.note, o.at, s.name AS by_name
    FROM drawer_outs o LEFT JOIN staff s ON s.id = o.by_staff WHERE o.business_id = ? AND o.shift_day = ? ORDER BY o.at`, bid, day);
  const differences = await all<{ kind: string; mode: string | null; n: number; paise: number }>(db, `SELECT d.kind, p.mode, count(*) AS n, sum(d.amount_paise) AS paise
    FROM settle_differences d LEFT JOIN payments p ON p.id = d.payment_id WHERE d.business_id = ? AND d.shift_day = ? GROUP BY d.kind, p.mode`, bid, day);
  const creditNotes = await all<{ cn_no: string; bill_no: string; total_paise: number; refund_mode: string; reason: string }>(db, `SELECT n.cn_no, b.bill_no, n.total_paise, n.refund_mode, n.reason
    FROM credit_notes n JOIN bills b ON b.id = n.bill_id WHERE n.business_id = ? AND n.shift_day = ? ORDER BY n.seq`, bid, day);
  const cashIn = [...byMode, ...receipts].filter((r) => r.mode === 'cash').reduce((s, r) => s + r.paise, 0);
  const cashOut = outs.filter((o) => o.mode === 'cash').reduce((s, o) => s + o.amount_paise, 0)
    + creditNotes.filter((n) => n.refund_mode === 'cash').reduce((s, n) => s + n.total_paise, 0);
  // Money reception entered in Djubo during this shift with no POS receipt (24 Nov 2026).
  const deskMissing = (await deskPending(db, bid)).filter((r) => r.deskPaidAt !== null && shiftDayAt(r.deskPaidAt, startHour) === day)
    .map((r) => ({ bookingId: r.id, extRef: r.extRef, guestName: r.guestName, enteredBy: r.enteredBy, at: r.deskPaidAt, pendingPaise: r.pendingPaise }));
  const oldTabDay = new Date(Date.parse(day + 'T00:00:00Z') - tabAgeDays * 86400000).toISOString().slice(0, 10);
  return { shiftDay: day, byMode, receipts, byAccount, billed, events, openOrders, unpaidBills: unpaid, tabs: tabs.map((x) => ({ ...x, old: x.since <= oldTabDay })),
    cashInPaise: cashIn, cashOutPaise: cashOut, deskMissing,
    // Reservations made at the desk that Djubo has not confirmed (25 Nov 2026).
    notInDjubo: await notInDjubo(db, bid, day),
    drawerOuts: outs.map((o) => ({ kind: o.kind, mode: o.mode, amountPaise: o.amount_paise, note: o.note, at: o.at, byName: o.by_name })),
    tips: differences.filter((d) => d.kind === 'tip').map((d) => ({ mode: d.mode, n: d.n, paise: d.paise })),
    discountsAtPayment: differences.filter((d) => d.kind === 'discount').reduce((t, d) => ({ n: t.n + d.n, paise: t.paise + d.paise }), { n: 0, paise: 0 }),
    creditNotes: creditNotes.map((n) => ({ cnNo: n.cn_no, billNo: n.bill_no, totalPaise: n.total_paise, refundMode: n.refund_mode, reason: n.reason })) };
}

shiftRoutes.get(`${B}/shifts/:day`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const b = bizOf(c);
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const closed = await one(c.env.DB, `SELECT opening_float_paise AS openingFloatPaise, counted, counted_paise AS countedPaise, expected_paise AS expectedPaise,
    difference_paise AS differencePaise, difference_reason AS differenceReason, closed_at AS closedAt, counted_at AS countedAt, auto FROM shift_closes WHERE business_id = ? AND shift_day = ?`, bid, day);
  // The last shift closed (24 Nov 2026): to count its drawer if it was closed automatically, or for an owner to reopen it.
  const last = await one<{ shift_day: string; counted_at: number | null; auto: number; closed_at: number; by: string | null; later: number }>(c.env.DB,
    `SELECT x.shift_day, x.counted_at, x.auto, x.closed_at, s.name AS "by" FROM shift_closes x LEFT JOIN staff s ON s.id = x.closed_by
     WHERE x.business_id = ? ORDER BY x.shift_day DESC LIMIT 1`, bid);
  return c.json({ summary: await shiftSummary(c.env.DB, bid, day, b.tab_age_days, b.shift_start_hour), closed, current: clock(b).shiftDay,
    lastClosed: last ? { shiftDay: last.shift_day, countedAt: last.counted_at, auto: !!last.auto, closedAt: last.closed_at, by: last.by } : null,
    endsAt: shiftEnd(clock(b).shiftDay, b.shift_start_hour) });
});

shiftRoutes.post(`${B}/shifts/:day/close`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const b = bizOf(c);
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const { t } = clock(b);
  // Only a shift that has started by the clock can be closed: closing the 23rd early moves work to the 24th, which
  // cannot itself be closed before its own start (24 Nov 2026).
  if (day > shiftDayAt(t, b.shift_start_hour)) fail(400, `The ${day} shift has only just started. Close it at its end.`);
  const s = await shiftSummary(db, bid, day, b.tab_age_days, b.shift_start_hour);
  if (s.openOrders.length) fail(409, `Bill these orders or keep them as a tab first: ${s.openOrders.map((o) => o.place).join(', ')}.`);
  if (s.unpaidBills.length) fail(409, `These bills are printed but not paid: ${s.unpaidBills.map((x) => x.bill_no).join(', ')}. Settle or void them first.`);

  const data = await body(c);
  const { float, counted, countedPaise } = readCount(data);
  const expected = float + s.cashInPaise - s.cashOutPaise;
  const diff = countedPaise - expected;
  const reason = text(data, 'reason', 'A reason for the difference', { optional: diff === 0, max: 200 });
  // Money reception entered in Djubo with no POS receipt: take it in Rooms first, or say why (24 Nov 2026).
  const deskReason = s.deskMissing.length ? text(data, 'deskReason', `Reception entered ${rs(s.deskMissing.reduce((t, x) => t + x.pendingPaise, 0))} in Djubo with no POS receipt (${s.deskMissing.map((x) => x.extRef).join(', ')}). Take it in Rooms, or a reason`, { max: 200 })! : null;
  const djuboReason = s.notInDjubo.length ? text(data, 'djuboReason', `${s.notInDjubo.length} reservation${s.notInDjubo.length === 1 ? '' : 's'} made here ${s.notInDjubo.length === 1 ? 'is' : 'are'} not in Djubo yet (${s.notInDjubo.map((x) => x.guestName).join(', ')}). Enter ${s.notInDjubo.length === 1 ? 'it' : 'them'} in Djubo, or a reason`, { max: 200 })! : null;
  const totals = { deskMissing: s.deskMissing, deskReason, notInDjubo: s.notInDjubo, djuboReason, byMode: s.byMode, receipts: s.receipts, byAccount: s.byAccount, billed: s.billed, events: s.events, tabs: s.tabs, drawerOuts: s.drawerOuts, creditNotes: s.creditNotes, tips: s.tips, discountsAtPayment: s.discountsAtPayment };
  const id = newId();
  try {
    await db.batch([
      stmt(db, `INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise,
        difference_reason, totals, closed_by, closed_at, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, bid, day, float, JSON.stringify(counted), countedPaise, expected, diff, diff === 0 ? null : reason, JSON.stringify(totals), c.get('staff').id, t, t),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'shift_closed', ?, ?)", newId(), bid, JSON.stringify({
        shiftDay: day, closedAt: t, closedBy: c.get('staff').name, openingFloatPaise: float, countedPaise, expectedPaise: expected, differencePaise: diff,
        differenceReason: diff === 0 ? null : reason, counted, ...totals,
      }), t),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'This shift is already closed.');
    throw e;
  }
  sendSoon(c, bid);
  return c.json({ ok: true, countedPaise, expectedPaise: expected, differencePaise: diff, message: diff === 0 ? 'Drawer agrees.' : `Drawer is ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}.` }, 201);
});

/** When a shift day ends: the shift's hour on the next day, India time. */
const shiftEnd = (day: string, hour: number) => Date.parse(day + 'T00:00:00Z') + 86_400_000 + hour * 3_600_000 - 19_800_000;
const nextDay = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);

/** Reads the drawer count from a request: notes by value and the loose amount. */
function readCount(data: Record<string, unknown>) {
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
  return { float, counted, countedPaise: countedPaise + loose };
}

// Counting the drawer of a shift that was closed automatically (24 Nov 2026). The drawer now also holds what the next
// shift has taken since, so that is taken off: the difference belongs to the shift being counted. A shift can be counted
// only until a later shift is closed.
shiftRoutes.post(`${B}/shifts/:day/count`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const b = bizOf(c);
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const row = await one<{ id: string; counted_at: number | null; totals: string }>(db, 'SELECT id, counted_at, totals FROM shift_closes WHERE business_id = ? AND shift_day = ?', bid, day);
  if (!row) fail(404, 'That shift is not closed.');
  if (row.counted_at !== null) fail(409, 'That shift\'s drawer is already counted.');
  if (await one(db, 'SELECT 1 FROM shift_closes WHERE business_id = ? AND shift_day > ?', bid, day)) fail(409, 'A later shift is closed, so this drawer can no longer be counted.');
  const data = await body(c);
  const { float, counted, countedPaise } = readCount(data);
  const { t, shiftDay: current } = clock(b);
  const s = await shiftSummary(db, bid, day, b.tab_age_days, b.shift_start_hour);
  let sincePaise = 0;
  for (let d = nextDay(day); d <= current; d = nextDay(d)) {
    const x = await shiftSummary(db, bid, d, b.tab_age_days, b.shift_start_hour);
    sincePaise += x.cashInPaise - x.cashOutPaise;
  }
  const expected = float + s.cashInPaise - s.cashOutPaise + sincePaise;
  const diff = countedPaise - expected;
  const reason = text(data, 'reason', 'A reason for the difference', { optional: diff === 0, max: 200 });
  const totals = { ...JSON.parse(row.totals), countedLater: { sincePaise, at: t } };
  const res = await db.batch([
    stmt(db, `UPDATE shift_closes SET opening_float_paise = ?, counted = ?, counted_paise = ?, expected_paise = ?, difference_paise = ?, difference_reason = ?,
      totals = ?, closed_by = ?, counted_at = ? WHERE id = ? AND counted_at IS NULL`,
      float, JSON.stringify(counted), countedPaise, expected, diff, diff === 0 ? null : reason, JSON.stringify(totals), c.get('staff').id, t, row.id),
    stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) SELECT ?, ?, 'shift_closed', ?, ? WHERE changes() = 1", newId(), bid, JSON.stringify({
      shiftDay: day, closedAt: t, closedBy: c.get('staff').name, openingFloatPaise: float, countedPaise, expectedPaise: expected, differencePaise: diff,
      differenceReason: diff === 0 ? null : reason, counted, ...totals }), t),
    audit(db, bid, c.get('staff').id, 'shift.count', 'shift_closes', row.id, null, { float, countedPaise, expected, diff, sincePaise }),
  ]);
  if (!res[0].meta.changes) fail(409, 'That shift\'s drawer is already counted.');
  sendSoon(c, bid);
  return c.json({ ok: true, countedPaise, expectedPaise: expected, differencePaise: diff, sincePaise,
    message: diff === 0 ? 'Drawer agrees.' : `Drawer is ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}.` });
});

// An owner reopens the last closed shift, with a reason (24 Nov 2026): its close is removed (kept in the audit log), and
// money taken now goes to that shift again if its time has not ended. Bookr keeps the first close it was sent.
shiftRoutes.post(`${B}/shifts/:day/reopen`, requireAction('staff.manage'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const data = await body(c);
  const reason = text(data, 'reason', 'A reason for reopening', { max: 200 })!;
  const row = await one<Record<string, unknown> & { id: string }>(db, 'SELECT * FROM shift_closes WHERE business_id = ? AND shift_day = ?', bid, day);
  if (!row) fail(404, 'That shift is not closed.');
  if (await one(db, 'SELECT 1 FROM shift_closes WHERE business_id = ? AND shift_day > ?', bid, day)) fail(409, 'Only the last closed shift can be reopened.');
  await db.batch([
    stmt(db, 'DELETE FROM shift_closes WHERE id = ?', row.id),
    audit(db, bid, c.get('staff').id, 'shift.reopen', 'shift_closes', row.id, row, { reason }),
  ]);
  return c.json({ ok: true });
});

/** The automatic close (24 Nov 2026), run by the 5-minute timer: once a shift's hour has passed, the shift before it is
 *  closed if nobody closed it by hand and anything happened in it. Its drawer is "not counted yet"; open orders, printed
 *  bills and tabs carry on into the next shift and are listed in the close. Only the shift just ended is closed. */
export async function autoCloseAll(db: DB, t = now()) {
  const bs = await all<{ id: string; shift_start_hour: number; tab_age_days: number }>(db, "SELECT id, shift_start_hour, tab_age_days FROM businesses WHERE status = 'active'");
  let closed = 0;
  for (const b of bs) {
    const prev = new Date(Date.parse(shiftDayAt(t, b.shift_start_hour)) - 86_400_000).toISOString().slice(0, 10);
    if (await one(db, 'SELECT 1 FROM shift_closes WHERE business_id = ? AND shift_day >= ?', b.id, prev)) continue;
    const busy = await one(db, `SELECT 1 FROM payments WHERE business_id = ? AND shift_day = ? UNION ALL SELECT 1 FROM bills WHERE business_id = ? AND shift_day = ?
      UNION ALL SELECT 1 FROM drawer_outs WHERE business_id = ? AND shift_day = ? UNION ALL SELECT 1 FROM orders WHERE business_id = ? AND opened_shift_day = ? LIMIT 1`,
      b.id, prev, b.id, prev, b.id, prev, b.id, prev);
    if (!busy) continue;
    const s = await shiftSummary(db, b.id, prev, b.tab_age_days, b.shift_start_hour);
    const totals = { deskMissing: s.deskMissing, notInDjubo: s.notInDjubo, byMode: s.byMode, receipts: s.receipts, byAccount: s.byAccount, billed: s.billed, events: s.events,
      tabs: s.tabs, drawerOuts: s.drawerOuts, creditNotes: s.creditNotes, tips: s.tips, discountsAtPayment: s.discountsAtPayment,
      carried: { openOrders: s.openOrders, unpaidBills: s.unpaidBills } };
    try {
      await db.batch([stmt(db, `INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise,
        difference_reason, totals, closed_by, closed_at, counted_at, auto) VALUES (?, ?, ?, 0, '{}', 0, ?, 0, NULL, ?, NULL, ?, NULL, 1)`,
        newId(), b.id, prev, s.cashInPaise - s.cashOutPaise, JSON.stringify(totals), t)]);
      closed++;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;   // closed by hand meanwhile
    }
  }
  return closed;
}

// Cash paid out of the drawer (vegetables, a delivery): a note is required; it reduces the cash expected at shift close.
shiftRoutes.post(`${B}/drawer-outs`, requireAction('bills.settle'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const amount = parsePaise(typeof data.amount === 'string' ? data.amount : '');
  if (amount === null || amount <= 0) fail(400, 'Amount must be above zero, in rupees.');
  const note = text(data, 'note', 'What it was for', { max: 120 })!;
  const { t, shiftDay } = clock(bizOf(c));
  const id = newId();
  try {
    await db.batch([
      stmt(db, "INSERT INTO drawer_outs (id, business_id, kind, mode, amount_paise, note, shift_day, by_staff, at) VALUES (?, ?, 'paid_out', 'cash', ?, ?, ?, ?, ?)",
        id, bid, amount, note, shiftDay, c.get('staff').id, t),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'drawer_out', ?, ?)", newId(), bid,
        JSON.stringify({ drawerOutId: id, kind: 'paid_out', mode: 'cash', amountPaise: amount, note, shiftDay, at: t, by: c.get('staff').name }), t),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed.');
    throw e;
  }
  sendSoon(c, bid);
  return c.json({ id }, 201);
});

// The exceptions report: every void, reprint, cancelled KOT line, discount, complimentary bill and limit warning of a shift.
shiftRoutes.get(`${B}/events`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const day = date({ day: c.req.query('day') ?? '' }, 'day', 'Shift day');
  return c.json({ events: await all(c.env.DB, `SELECT e.kind, e.ref, e.amount_paise AS amountPaise, e.reason, e.detail, s.name AS byName, e.at
    FROM pos_events e LEFT JOIN staff s ON s.id = e.by_staff WHERE e.business_id = ? AND e.shift_day = ? ORDER BY e.at DESC, e.id DESC`, bid, day) });
});

shiftRoutes.get(`${B}/outbox`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const pending = await one<{ n: number; oldest: number | null }>(c.env.DB, 'SELECT count(*) AS n, min(created_at) AS oldest FROM outbox WHERE business_id = ? AND sent_at IS NULL', bid);
  const failing = await all(c.env.DB, 'SELECT id, kind, attempts, last_error AS lastError, created_at AS createdAt FROM outbox WHERE business_id = ? AND sent_at IS NULL AND attempts > 0 ORDER BY created_at LIMIT 20', bid);
  const rejected = await all(c.env.DB, "SELECT id, kind, last_error AS lastError, sent_at AS sentAt FROM outbox WHERE business_id = ? AND sent_at IS NOT NULL AND last_error LIKE 'Rejected%' ORDER BY sent_at DESC LIMIT 20", bid);
  return c.json({ pending: pending?.n ?? 0, oldestAt: pending?.oldest ?? null, failing, rejected });
});

// "Send now": tries the outbox at once (also tried after each sale and every 5 minutes).
shiftRoutes.post(`${B}/outbox/send`, requireAction('shift.close'), async (c) => {
  return c.json(await sendOutbox(c.env, c.get('businessId')));
});
