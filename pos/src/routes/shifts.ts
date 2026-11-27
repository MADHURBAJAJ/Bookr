// Shift close: the drawer count against the cash taken, totals by payment mode and by UPI account, the bill number range
// of each billing name, and what to look at (voids, reprints, discounts). Open orders must be billed or kept as a tab, and
// printed bills paid or voided, before the shift closes; tabs carry on and are listed apart. The close goes to Bookr.
import { Hono } from 'hono';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../../../src/db';
import { parsePaise } from '../../../src/money';
import { body, date, fail, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { rs, shiftDayAt } from '../billing';
import { djuboPays, oldDeskPending } from '../djubo-desk';
import { restaurantAdvances } from '../restaurant-advances';
import { tonightNotCharged } from '../rooms';
import { notInDjubo } from './frontdesk';
import { audit, clock, isTrigger, bizOf, loadBusiness } from '../util';
import { sendOutbox, sendSoon } from '../sync';
import type { AppEnv } from '../types';
import { cashBetween, cashGuard, closeDrawerStmts, countResult, drawersOfDay, openDrawer, readCounted, startDrawer } from './drawers';
import { isManager } from '../auth';

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
  // Each money payment of the day (26 Nov 2026), for Day close's Breakdown: what it paid (bill numbers, or the receipt and
  // the room or account it went on, or a desk advance's guest) so a tap on a total lists them.
  const payments = await all<{ id: string; mode: string; amountPaise: number; kind: string; at: number; receiptNo: string | null; bills: string | null; billId: string | null;
    place: string | null; account: string | null; stayId: string | null; advGuest: string | null }>(db, `SELECT p.id, p.mode, p.amount_paise AS amountPaise, s.kind, s.at, s.receipt_no AS receiptNo,
      (SELECT group_concat(b.bill_no, ', ') FROM allocations a JOIN bills b ON b.id = a.bill_id WHERE a.payment_id = p.id) AS bills,
      (SELECT a.bill_id FROM allocations a WHERE a.payment_id = p.id LIMIT 1) AS billId,
      (SELECT o.place FROM allocations a JOIN bills b ON b.id = a.bill_id JOIN orders o ON o.id = b.order_id WHERE a.payment_id = p.id LIMIT 1) AS place,
      (SELECT d.name FROM debtor_entries e JOIN debtor_accounts d ON d.id = e.account_id WHERE e.payment_id = p.id LIMIT 1) AS account,
      (SELECT d.stay_id FROM debtor_entries e JOIN debtor_accounts d ON d.id = e.account_id WHERE e.payment_id = p.id LIMIT 1) AS stayId,
      (SELECT g.guest_name FROM desk_advances g WHERE g.settlement_id = s.id LIMIT 1) AS advGuest
    FROM payments p JOIN settlements s ON s.id = p.settlement_id
    WHERE p.business_id = ? AND p.shift_day = ? AND p.mode IN ('cash', 'upi', 'card') ORDER BY s.at DESC, p.rowid DESC LIMIT 1000`, bid, day);
  const cashIn = [...byMode, ...receipts].filter((r) => r.mode === 'cash').reduce((s, r) => s + r.paise, 0);
  const cashOut = outs.filter((o) => o.mode === 'cash').reduce((s, o) => s + o.amount_paise, 0)
    + creditNotes.filter((n) => n.refund_mode === 'cash').reduce((s, n) => s + n.total_paise, 0);
  // Money reception entered in Djubo during this shift with no POS receipt (24 Nov 2026).
  const deskMissing = (await oldDeskPending(db, bid, startHour)).filter((r) => r.deskPaidAt !== null && shiftDayAt(r.deskPaidAt, startHour) === day)
    .map((r) => ({ bookingId: r.id, extRef: r.extRef, guestName: r.guestName, enteredBy: r.enteredBy, at: r.deskPaidAt, pendingPaise: r.pendingPaise }));
  const oldTabDay = new Date(Date.parse(day + 'T00:00:00Z') - tabAgeDays * 86400000).toISOString().slice(0, 10);
  return { shiftDay: day, byMode, receipts, byAccount, billed, events, payments, openOrders, unpaidBills: unpaid, tabs: tabs.map((x) => ({ ...x, old: x.since <= oldTabDay })),
    cashInPaise: cashIn, cashOutPaise: cashOut, deskMissing,
    // Money reception marked in Djubo on this day (26 Nov 2026): counted here; each needs a mode before the day closes.
    // Restaurant advances not used on a bill yet (26 Nov 2026).
    advancesHeld: await restaurantAdvances(db, bid),
    // Guests in house tonight with no rent for the night (26 Nov 2026): the day cannot close until Djubo has it.
    notCharged: await tonightNotCharged(db, bid, day),
    djubo: (await djuboPays(db, bid, startHour)).pays.filter((x) => x.day === day || (x.settlementId && payments.some((p) => p.receiptNo === x.receiptNo))),
    // Reservations made at the desk that Djubo has not confirmed (25 Nov 2026).
    notInDjubo: await notInDjubo(db, bid, day),
    drawerOuts: outs.map((o) => ({ kind: o.kind, mode: o.mode, amountPaise: o.amount_paise, note: o.note, at: o.at, byName: o.by_name })),
    tips: differences.filter((d) => d.kind === 'tip').map((d) => ({ mode: d.mode, n: d.n, paise: d.paise })),
    discountsAtPayment: differences.filter((d) => d.kind === 'discount').reduce((t, d) => ({ n: t.n + d.n, paise: t.paise + d.paise }), { n: 0, paise: 0 }),
    creditNotes: creditNotes.map((n) => ({ cnNo: n.cn_no, billNo: n.bill_no, totalPaise: n.total_paise, refundMode: n.refund_mode, reason: n.reason })) };
}

shiftRoutes.get(`${B}/shifts/:day`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const b = bizOf(c);
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const closed = await one(db, `SELECT opening_float_paise AS openingFloatPaise, counted, counted_paise AS countedPaise, expected_paise AS expectedPaise,
    difference_paise AS differencePaise, difference_reason AS differenceReason, closed_at AS closedAt, counted_at AS countedAt, auto FROM shift_closes WHERE business_id = ? AND shift_day = ?`, bid, day);
  // The last day closed (24 Nov 2026): whether it closed by itself and is waiting for its drawer count, and for an owner to reopen it.
  const last = await one<{ shift_day: string; counted_at: number | null; auto: number; closed_at: number; by: string | null }>(db,
    `SELECT x.shift_day, x.counted_at, x.auto, x.closed_at, s.name AS "by" FROM shift_closes x LEFT JOIN staff s ON s.id = x.closed_by
     WHERE x.business_id = ? ORDER BY x.shift_day DESC LIMIT 1`, bid);
  const dr = await openDrawer(db, bid);
  const float = (await one<{ f: number }>(db, 'SELECT float_paise AS f FROM businesses WHERE id = ?', bid))!.f;
  return c.json({ summary: await shiftSummary(db, bid, day, b.tab_age_days, b.shift_start_hour), closed, current: clock(b).shiftDay,
    lastClosed: last ? { shiftDay: last.shift_day, countedAt: last.counted_at, auto: !!last.auto, closedAt: last.closed_at, by: last.by } : null,
    endsAt: shiftEnd(clock(b).shiftDay, b.shift_start_hour), overdue: await overdueOrders(db, bid, day), floatPaise: float,
    drawerCount: (await one<{ n: number }>(db, 'SELECT drawer_count AS n FROM businesses WHERE id = ?', bid))!.n === 1,
    // Arrivals of this shift and the 7 days before that were never checked in here (25 Nov 2026): a reminder, not a block.
    notCheckedIn: await all(db, `SELECT guest_name AS guestName, check_in AS checkIn, room_labels AS roomLabels FROM bookings bk
      WHERE business_id = ? AND status = 'approved' AND stay_id IS NULL AND check_in <= ? AND check_in >= ?
        AND NOT (bk.source = 'mmt' AND EXISTS (SELECT 1 FROM bookings m WHERE m.id = bk.match_id AND m.status = 'approved' AND m.stay_id IS NULL))
      ORDER BY check_in, guest_name LIMIT 50`, bid, day, new Date(Date.parse(day) - 7 * 86_400_000).toISOString().slice(0, 10)),
    drawer: dr ? { holder: dr.holder, heldBy: dr.held_by, since: dr.opened_at, openingPaise: dr.opening_paise, openingFrom: dr.opening_from } : null });
});

/** Tables already carried over an earlier day close (24 Nov 2026): they must be cleared before this day closes. Tabs have
 *  their own age limit and are not counted here. */
async function overdueOrders(db: DB, bid: string, day: string) {
  return all<{ place: string; bill_no: string | null; since: string }>(db, `SELECT o.place, b.bill_no, o.opened_shift_day AS since FROM orders o
    LEFT JOIN bills b ON b.order_id = o.id AND b.status = 'printed' WHERE o.business_id = ? AND o.status IN ('open', 'billed') AND o.opened_shift_day < ? ORDER BY o.opened_at`, bid, day);
}

// The day close (24 Nov 2026): counts the cash drawer (blind), sends cash above the float to the safe, locks the day and
// sends it to Bookr. It does not change who holds the drawer; open tables carry into the next day with their holder,
// except those already carried over an earlier day close, which must be cleared first.
shiftRoutes.post(`${B}/shifts/:day/close`, requireAction('shift.close'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const b = bizOf(c);
  const me = c.get('staff');
  const day = date({ day: c.req.param('day') }, 'day', 'Shift day');
  const { t } = clock(b);
  // Only a shift that has started by the clock can be closed: closing the 23rd early moves work to the 24th, which
  // cannot itself be closed before its own start (24 Nov 2026).
  if (day > shiftDayAt(t, b.shift_start_hour)) fail(400, `The ${day} shift has only just started. Close it at its end.`);
  if (await one(db, 'SELECT 1 FROM shift_closes WHERE business_id = ? AND shift_day = ?', bid, day)) fail(409, 'This shift is already closed.');
  const overdue = await overdueOrders(db, bid, day);
  if (overdue.length) fail(409, `Open since an earlier day: ${overdue.map((o) => `${o.place}${o.bill_no ? ` (${o.bill_no})` : ''}`).join(', ')}. Take payment, post to a room, put on credit, or void (manager) first.`);
  const s = await shiftSummary(db, bid, day, b.tab_age_days, b.shift_start_hour);
  // Money reception marked in Djubo today needs how it was paid, so cash, UPI and card add up (26 Nov 2026, required).
  const noMode = s.djubo.filter((x) => !x.settlementId);
  if (noMode.length) fail(409, `Pick Cash, UPI or Card for the money marked in Djubo today: ${noMode.map((x) => `${x.guestName ?? x.extRef} ${rs(x.amountPaise)}`).join(', ')}.`);
  if (s.notCharged.length) fail(409, `No rent for tonight: ${s.notCharged.map((x) => `${x.room} · ${x.guestName}`).join(', ')}. Extend in Djubo (the rent comes with its mail), or a manager extends without Djubo.`);

  const data = await body(c);
  // Money reception entered in Djubo with no POS receipt: take it in Rooms first, or say why (24 Nov 2026).
  const deskReason = s.deskMissing.length ? text(data, 'deskReason', `Reception entered ${rs(s.deskMissing.reduce((t, x) => t + x.pendingPaise, 0))} in Djubo with no POS receipt (${s.deskMissing.map((x) => x.extRef).join(', ')}). Take it in Rooms, or a reason`, { max: 200 })! : null;
  const djuboReason = s.notInDjubo.length ? text(data, 'djuboReason', `${s.notInDjubo.length} reservation${s.notInDjubo.length === 1 ? '' : 's'} made here ${s.notInDjubo.length === 1 ? 'is' : 'are'} not in Djubo yet (${s.notInDjubo.map((x) => x.guestName).join(', ')}). Enter ${s.notInDjubo.length === 1 ? 'it' : 'them'} in Djubo, or a reason`, { max: 200 })! : null;
  // No drawer count (26 Nov 2026, a setting): the day closes as the automatic close does, the drawer "not counted" and
  // left as it is; nothing goes to Bookr for it (the bills and payments already did).
  if ((await one<{ n: number }>(db, 'SELECT drawer_count AS n FROM businesses WHERE id = ?', bid))!.n === 0) {
    const totals = { deskMissing: s.deskMissing, deskReason, notInDjubo: s.notInDjubo, djuboReason, byMode: s.byMode, receipts: s.receipts, byAccount: s.byAccount, billed: s.billed,
      events: s.events, tabs: s.tabs, drawerOuts: s.drawerOuts, creditNotes: s.creditNotes, tips: s.tips, discountsAtPayment: s.discountsAtPayment,
      carried: { openOrders: s.openOrders, unpaidBills: s.unpaidBills }, noCount: true };
    try {
      await db.batch([stmt(db, `INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise,
        difference_reason, totals, closed_by, closed_at, counted_at, auto) VALUES (?, ?, ?, 0, '{}', 0, ?, 0, NULL, ?, ?, ?, NULL, 0)`,
        newId(), bid, day, s.cashInPaise - s.cashOutPaise, JSON.stringify(totals), me.id, t)]);
    } catch (e) {
      if (isUniqueViolation(e)) fail(409, 'This shift is already closed.');
      throw e;
    }
    return c.json({ ok: true, noCount: true, message: `${day} closed. Cash taken today ${rs(s.cashInPaise)}.` }, 201);
  }
  const floatPaise = (await one<{ f: number }>(db, 'SELECT float_paise AS f FROM businesses WHERE id = ?', bid))!.f;
  const typed = typeof data.openingFloat === 'string' && data.openingFloat ? parsePaise(data.openingFloat) : null;
  if (typed !== null && typed < 0) fail(400, 'Opening float must be an amount in rupees.');
  let dr = await openDrawer(db, bid);
  if (dr && dr.held_by !== me.id && !isManager(c)) fail(403, `${dr.holder} holds the cash drawer: ${dr.holder} closes the day, or hands the drawer over first, or a manager closes it.`);
  // Nobody took cash into a drawer (or only managers did): the count starts a drawer from the last close.
  if (!dr) dr = await startDrawer(db, bid, me.id, typed ?? floatPaise, 'float');
  // With no float set in Settings, the float typed at the close is used, as before.
  const opening = dr.opening_from === 'float' && floatPaise === 0 && typed !== null ? typed : dr.opening_paise;
  const { counted, countedPaise } = readCounted(data);
  const cash = await cashBetween(db, bid, dr.opened_at, t);
  const expected = opening + cash.inPaise - cash.outPaise;
  const { diff, reason } = countResult(data, countedPaise, expected);
  const start = shiftEnd(day, b.shift_start_hour) - 86_400_000;
  const drawers = (await drawersOfDay(db, bid, start, t)).map((x) => (x.id === dr!.id ? { ...x, to: t, closeKind: 'day_close', countedPaise, expectedPaise: expected, differencePaise: diff, reason } : x));
  const safePaise = Math.max(0, countedPaise - (floatPaise || opening));
  const totals = { deskMissing: s.deskMissing, deskReason, notInDjubo: s.notInDjubo, djuboReason, byMode: s.byMode, receipts: s.receipts, byAccount: s.byAccount, billed: s.billed,
    events: s.events, tabs: s.tabs, drawerOuts: s.drawerOuts, creditNotes: s.creditNotes, tips: s.tips, discountsAtPayment: s.discountsAtPayment,
    carried: { openOrders: s.openOrders, unpaidBills: s.unpaidBills }, drawers, safePaise, floatKeptPaise: countedPaise - safePaise };
  try {
    await db.batch([
      ...closeDrawerStmts(db, bid, dr, { kind: 'day_close', t, counted, countedPaise, expected, diff, reason, by: me.id, byName: me.name, shiftDay: day }),
      stmt(db, `INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise,
        difference_reason, totals, closed_by, closed_at, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), bid, day, opening, JSON.stringify(counted), countedPaise, expected, diff, reason, JSON.stringify(totals), me.id, t, t),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'shift_closed', ?, ?)", newId(), bid, JSON.stringify({
        shiftDay: day, closedAt: t, closedBy: me.name, openingFloatPaise: opening, countedPaise, expectedPaise: expected, differencePaise: diff,
        differenceReason: reason, counted, ...totals,
      }), t),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'This shift is already closed.');
    throw e;
  }
  sendSoon(c, bid);
  return c.json({ ok: true, countedPaise, expectedPaise: expected, differencePaise: diff, safePaise,
    message: `${diff === 0 ? 'Drawer agrees.' : `Drawer is ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}.`}${safePaise ? ` ${rs(safePaise)} to the safe, ${rs(countedPaise - safePaise)} stays in the drawer.` : ''}` }, 201);
});

/** When a shift day ends: the shift's hour on the next day, India time. */
const shiftEnd = (day: string, hour: number) => Date.parse(day + 'T00:00:00Z') + 86_400_000 + hour * 3_600_000 - 19_800_000;

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
  const bs = await all<{ id: string; shift_start_hour: number; tab_age_days: number; drawer_count: number }>(db, "SELECT id, shift_start_hour, tab_age_days, drawer_count FROM businesses WHERE status = 'active'");
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
      carried: { openOrders: s.openOrders, unpaidBills: s.unpaidBills }, ...(b.drawer_count === 0 ? { noCount: true } : {}) };
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
  await cashGuard(c, true);
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
