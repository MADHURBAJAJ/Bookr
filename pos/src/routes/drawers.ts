// Cash drawers (24 Nov 2026): who answers for the cash, from when to when. The drawer is handed from one cashier to the
// next at any time: the person leaving counts it blind, open tables pass to the next person by name, and the next person
// accepts with their PIN. If the holder has left, the next person counts it and a manager confirms ("not present"). The
// day close counts the drawer too (see shifts.ts) and does not change who holds it. Only one drawer is open at a time;
// it covers the cash taken from the close of the drawer before it to its own close, so no cash falls between two.
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../../../src/db';
import { parsePaise } from '../../../src/money';
import { body, fail, isUuid, text } from '../../../src/http';
import { approval, approverOf, isManager, requireAction, requireStaff } from '../auth';
import { rs } from '../billing';
import { audit, bizOf } from '../util';
import { sendSoon } from '../sync';
import type { AppEnv } from '../types';
import { notCancelled } from './receipt-cancels';

export const drawerRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
drawerRoutes.use(`${B}/*`, requireStaff);

const NOTES = ['2000', '500', '200', '100', '50', '20', '10'];
const TILL = ['owner', 'manager', 'cashier'] as const;

export interface DrawerRow { id: string; held_by: string; holder: string; opened_at: number; opening_paise: number; opening_from: 'float' | 'handover' }

export async function openDrawer(db: DB, bid: string): Promise<DrawerRow | null> {
  return one<DrawerRow>(db, `SELECT d.id, d.held_by, s.name AS holder, d.opened_at, d.opening_paise, d.opening_from
    FROM drawers d JOIN staff s ON s.id = d.held_by WHERE d.business_id = ? AND d.closed_at IS NULL`, bid);
}

/** Cash into and out of the drawer between `from` (after) and `to` (up to): cash payments, cash paid out and refunded. */
export async function cashBetween(db: DB, bid: string, from: number, to: number) {
  const r = await one<{ inP: number; outP: number; cnP: number }>(db, `SELECT
      (SELECT coalesce(sum(amount_paise), 0) FROM payments WHERE business_id = ? AND mode = 'cash' AND at > ? AND at <= ? AND ${notCancelled('payments.settlement_id')}) AS inP,
      (SELECT coalesce(sum(amount_paise), 0) FROM drawer_outs WHERE business_id = ? AND mode = 'cash' AND at > ? AND at <= ?) AS outP,
      (SELECT coalesce(sum(total_paise), 0) FROM credit_notes WHERE business_id = ? AND refund_mode = 'cash' AND at > ? AND at <= ?) AS cnP`,
    bid, from, to, bid, from, to, bid, from, to);
  return { inPaise: r!.inP, outPaise: r!.outP + r!.cnP };
}

/** When the next drawer starts counting cash: the close of the last one. */
async function lastClose(db: DB, bid: string) {
  return (await one<{ t: number | null }>(db, 'SELECT max(closed_at) AS t FROM drawers WHERE business_id = ?', bid))!.t ?? 0;
}

/** Opens a drawer for this person, from the last close, starting with the float. Used when the first cash comes in. */
export async function startDrawer(db: DB, bid: string, staffId: string, opening: number, from: 'float' | 'handover', at?: number) {
  const id = newId();
  await stmt(db, 'INSERT INTO drawers (id, business_id, held_by, opened_at, opening_paise, opening_from) VALUES (?, ?, ?, ?, ?, ?)',
    id, bid, staffId, at ?? (await lastClose(db, bid)), opening, from).run();
  return (await openDrawer(db, bid))!;
}

/** Before cash is taken (24 Nov 2026): only the person holding the drawer takes cash. A manager or owner may take cash
 *  into whoever's drawer is open. A cashier with nobody holding it starts a drawer with the float. */
export async function cashGuard(c: Context<AppEnv>, cash: boolean) {
  if (!cash) return;
  const db = c.env.DB;
  const bid = c.get('businessId');
  const staff = c.get('staff');
  const open = await openDrawer(db, bid);
  if (open) {
    if (open.held_by === staff.id || isManager(c)) return;
    throw new HTTPException(409, { message: `The cash drawer is with ${open.holder}. ${open.holder} hands it over first, or you take it over.`,
      cause: { code: 'drawer_held', holder: open.holder, holderId: open.held_by } });
  }
  if (isManager(c)) return;   // counted in the next drawer
  const float = (await one<{ f: number }>(db, 'SELECT float_paise AS f FROM businesses WHERE id = ?', bid))!.f;
  try { await startDrawer(db, bid, staff.id, float, 'float'); } catch (e) { if (!isUniqueViolation(e)) throw e; return cashGuard(c, cash); }
}

/** Reads a blind count: notes by value and the loose amount. */
export function readCounted(data: Record<string, unknown>) {
  const raw = (data.counted ?? {}) as Record<string, unknown>;
  const counted: Record<string, number> = {};
  let paise = 0;
  for (const note of NOTES) {
    const n = raw[note] ?? 0;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100000) fail(400, `Count of ₹${note} notes must be a whole number.`);
    counted[note] = n;
    paise += n * Number(note) * 100;
  }
  const loose = parsePaise(typeof raw.loose === 'string' && raw.loose ? raw.loose : '0');
  if (loose === null || loose < 0) fail(400, 'Coins and small notes must be an amount in rupees.');
  counted.loose_paise = loose;
  return { counted, countedPaise: paise + loose };
}

/** The result of a count, and the reason when it does not agree. Blind: the expected amount is only told after a count,
 *  in the refusal that asks for the reason. */
export function countResult(data: Record<string, unknown>, countedPaise: number, expected: number) {
  const diff = countedPaise - expected;
  const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 200) : '';
  if (diff !== 0 && !reason) throw new HTTPException(400, { message: `The drawer should hold ${rs(expected)}; counted ${rs(countedPaise)}: ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}. Give a reason.`,
    cause: { code: 'count_differs', expectedPaise: String(expected), differencePaise: String(diff) } });
  return { diff, reason: diff === 0 ? null : reason };
}

/** Statements that close a drawer with its count, and mark days closed by themselves meanwhile as counted with it. */
export function closeDrawerStmts(db: DB, bid: string, dr: DrawerRow, close: { kind: 'handover' | 'takeover' | 'count' | 'day_close'; t: number; counted: Record<string, number>;
  countedPaise: number; expected: number; diff: number; reason: string | null; by: string; byName: string; acceptedBy?: string | null; approvedBy?: string | null; shiftDay?: string | null }) {
  return [
    stmt(db, `UPDATE drawers SET closed_at = ?, close_kind = ?, counted = ?, counted_paise = ?, expected_paise = ?, difference_paise = ?, difference_reason = ?,
      closed_by = ?, accepted_by = ?, approved_by = ?, shift_day = ? WHERE id = ? AND closed_at IS NULL`,
      close.t, close.kind, JSON.stringify(close.counted), close.countedPaise, close.expected, close.diff, close.reason, close.by, close.acceptedBy ?? null,
      close.approvedBy ?? null, close.shiftDay ?? null, dr.id),
    // A day that closed by itself while this drawer was open is counted now, with this drawer (24 Nov 2026).
    stmt(db, `INSERT INTO outbox (id, business_id, kind, body, created_at)
      SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
        ?, 'shift_closed', json_object('shiftDay', shift_day, 'closedAt', closed_at, 'closedBy', ?, 'countedPaise', ?, 'expectedPaise', ?, 'differencePaise', ?,
        'differenceReason', ?, 'countedWithDrawer', ?), ?
      FROM shift_closes WHERE business_id = ? AND auto = 1 AND counted_at IS NULL AND closed_at > ?`,
      bid, close.byName, close.countedPaise, close.expected, close.diff, close.reason, dr.id, close.t, bid, dr.opened_at),
    stmt(db, `UPDATE shift_closes SET counted_at = ?, counted = ?, counted_paise = ?, expected_paise = ?, difference_paise = ?, difference_reason = ?, closed_by = ?,
      opening_float_paise = ? WHERE business_id = ? AND auto = 1 AND counted_at IS NULL AND closed_at > ?`,
      close.t, JSON.stringify(close.counted), close.countedPaise, close.expected, close.diff, close.reason, close.by, dr.opening_paise, bid, dr.opened_at),
  ];
}

/** Open orders pass to the next holder by name. */
const handOrders = (db: DB, bid: string, from: string, to: string, t: number) =>
  stmt(db, "UPDATE orders SET handed_from = ?, held_by = ?, handed_at = ? WHERE business_id = ? AND status IN ('open', 'tab', 'billed')", from, to, t, bid);

// The drawer now: who holds it, since when, what it started with; the cashiers it can go to; open tables to hand over.
drawerRoutes.get(`${B}/drawer`, requireAction('pos.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const dr = await openDrawer(db, bid);
  const staff = await all<{ id: string; name: string; role: string }>(db,
    "SELECT id, name, role FROM staff WHERE business_id = ? AND active = 1 AND support = 0 AND role IN ('owner', 'manager', 'cashier') ORDER BY role = 'cashier' DESC, name", bid);
  const tables = await all<{ id: string; place: string; status: string; bill_no: string | null; bill_id: string | null; paise: number; opened_shift_day: string }>(db, `
    SELECT o.id, o.place, o.status, b.bill_no, b.id AS bill_id, o.opened_shift_day,
      coalesce(b.total_paise, (SELECT coalesce(sum(l.qty * l.price_paise), 0) FROM order_lines l WHERE l.order_id = o.id)) AS paise
    FROM orders o LEFT JOIN bills b ON b.order_id = o.id AND b.status = 'printed'
    WHERE o.business_id = ? AND o.status IN ('open', 'tab', 'billed') ORDER BY o.opened_at`, bid);
  const float = (await one<{ f: number }>(db, 'SELECT float_paise AS f FROM businesses WHERE id = ?', bid))!.f;
  return c.json({ drawer: dr ? { id: dr.id, heldBy: dr.held_by, holder: dr.holder, since: dr.opened_at, openingPaise: dr.opening_paise, openingFrom: dr.opening_from } : null,
    staff, floatPaise: float, tables: tables.map((x) => ({ orderId: x.id, place: x.place, status: x.status, billNo: x.bill_no, billId: x.bill_id, paise: x.paise, openedShiftDay: x.opened_shift_day })) });
});

// Hand the drawer over (any time): the holder counts it (their PIN if someone else is signed in), the next cashier
// accepts with their PIN (unless they are the one signed in). Open tables pass to them by name.
drawerRoutes.post(`${B}/drawer/handover`, requireAction('shift.close'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const me = c.get('staff');
  const data = await body(c);
  const dr = await openDrawer(db, bid);
  if (!dr) fail(409, 'Nobody holds the cash drawer now: the next person to take cash starts it.');
  const toId = typeof data.toId === 'string' && isUuid(data.toId) ? data.toId : fail(400, 'Choose who takes the drawer.');
  if (toId === dr.held_by) fail(400, `${dr.holder} already holds the drawer.`);
  if (me.id !== dr.held_by) await approverOf(c, dr.held_by, data.fromPin, TILL);
  const to = me.id === toId ? { id: me.id, name: me.name } : await approverOf(c, toId, data.toPin, TILL);
  const { counted, countedPaise } = readCounted(data);
  const t = now();
  const cash = await cashBetween(db, bid, dr.opened_at, t);
  const expected = dr.opening_paise + cash.inPaise - cash.outPaise;
  const { diff, reason } = countResult(data, countedPaise, expected);
  const nextId = newId();
  await db.batch([
    ...closeDrawerStmts(db, bid, dr, { kind: 'handover', t, counted, countedPaise, expected, diff, reason, by: dr.held_by, byName: dr.holder, acceptedBy: to.id }),
    stmt(db, "INSERT INTO drawers (id, business_id, held_by, opened_at, opening_paise, opening_from) VALUES (?, ?, ?, ?, ?, 'handover')", nextId, bid, to.id, t, countedPaise),
    handOrders(db, bid, dr.held_by, to.id, t),
    audit(db, bid, me.id, 'drawer.handover', 'drawers', dr.id, null, { from: dr.holder, to: to.name, countedPaise, expected, diff }),
  ]);
  sendSoon(c, bid);
  return c.json({ ok: true, from: dr.holder, to: to.name, countedPaise, expectedPaise: expected, differencePaise: diff,
    message: `Drawer handed from ${dr.holder} to ${to.name}. ${diff === 0 ? 'It agrees.' : `It was ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}.`}` });
});

// Take the drawer over when its holder has left: the signed-in cashier counts it and a manager confirms.
drawerRoutes.post(`${B}/drawer/takeover`, requireAction('shift.close'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const me = c.get('staff');
  const data = await body(c);
  const dr = await openDrawer(db, bid);
  if (!dr) fail(409, 'Nobody holds the cash drawer now: the next person to take cash starts it.');
  if (dr.held_by === me.id) fail(400, 'You already hold the drawer.');
  const { counted, countedPaise } = readCounted(data);
  const t = now();
  const cash = await cashBetween(db, bid, dr.opened_at, t);
  const expected = dr.opening_paise + cash.inPaise - cash.outPaise;
  const { diff, reason } = countResult(data, countedPaise, expected);
  const approver = await approval(c, data, `Taking the drawer over from ${dr.holder}`);
  await db.batch([
    ...closeDrawerStmts(db, bid, dr, { kind: 'takeover', t, counted, countedPaise, expected, diff, reason: reason ? `${reason} (${dr.holder} not present)` : null,
      by: me.id, byName: me.name, acceptedBy: me.id, approvedBy: approver.id }),
    stmt(db, "INSERT INTO drawers (id, business_id, held_by, opened_at, opening_paise, opening_from) VALUES (?, ?, ?, ?, ?, 'handover')", newId(), bid, me.id, t, countedPaise),
    handOrders(db, bid, dr.held_by, me.id, t),
    audit(db, bid, me.id, 'drawer.takeover', 'drawers', dr.id, null, { from: dr.holder, countedPaise, expected, diff, approvedBy: approver.name }),
  ]);
  sendSoon(c, bid);
  return c.json({ ok: true, countedPaise, expectedPaise: expected, differencePaise: diff,
    message: `You hold the drawer now (${dr.holder} not present, confirmed by ${approver.name}). ${diff === 0 ? 'It agrees.' : `It was ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}.`}` });
});

// Count the drawer without handing it over: after a day closed by itself at 8 am, or any time. The holder keeps it.
drawerRoutes.post(`${B}/drawer/count`, requireAction('shift.close'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const me = c.get('staff');
  const data = await body(c);
  let dr = await openDrawer(db, bid);
  if (dr && dr.held_by !== me.id && !isManager(c)) fail(403, `Only ${dr.holder}, or a manager, counts this drawer.`);
  // Nobody held it (only managers took cash): the count starts a drawer from the last close, with the float.
  if (!dr) dr = await startDrawer(db, bid, me.id, (await one<{ f: number }>(db, 'SELECT float_paise AS f FROM businesses WHERE id = ?', bid))!.f, 'float');
  const { counted, countedPaise } = readCounted(data);
  const t = now();
  const cash = await cashBetween(db, bid, dr.opened_at, t);
  const expected = dr.opening_paise + cash.inPaise - cash.outPaise;
  const { diff, reason } = countResult(data, countedPaise, expected);
  await db.batch([
    ...closeDrawerStmts(db, bid, dr, { kind: 'count', t, counted, countedPaise, expected, diff, reason, by: me.id, byName: me.name }),
    stmt(db, "INSERT INTO drawers (id, business_id, held_by, opened_at, opening_paise, opening_from) VALUES (?, ?, ?, ?, ?, 'handover')", newId(), bid, dr.held_by, t, countedPaise),
    audit(db, bid, me.id, 'drawer.count', 'drawers', dr.id, null, { countedPaise, expected, diff }),
  ]);
  sendSoon(c, bid);
  return c.json({ ok: true, countedPaise, expectedPaise: expected, differencePaise: diff,
    message: `Drawer counted. ${diff === 0 ? 'It agrees.' : `It is ${diff < 0 ? 'short' : 'over'} by ${rs(Math.abs(diff))}.`}` });
});

// Whether Day close counts the drawer (26 Nov 2026; owners and managers): off closes the day without a count.
drawerRoutes.put(`${B}/drawer/count-setting`, requireAction('drawer.float'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  if (typeof data.on !== 'boolean') fail(400, 'Say whether the drawer is counted at day close: on or off.');
  const before = await one<{ drawer_count: number }>(db, 'SELECT drawer_count FROM businesses WHERE id = ?', bid);
  await db.batch([stmt(db, 'UPDATE businesses SET drawer_count = ? WHERE id = ?', data.on ? 1 : 0, bid),
    audit(db, bid, c.get('staff').id, 'business.drawer_count', 'businesses', bid, before, { drawer_count: data.on ? 1 : 0 })]);
  return c.json({ ok: true, on: data.on });
});

// The float left in the drawer at each day close (managers and owners).
drawerRoutes.put(`${B}/drawer/float`, requireAction('drawer.float'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const f = parsePaise(typeof data.amount === 'string' ? data.amount : '');
  if (f === null || f < 0) fail(400, 'Float must be an amount in rupees.');
  const before = bizOf(c);
  await db.batch([stmt(db, 'UPDATE businesses SET float_paise = ? WHERE id = ?', f, bid),
    audit(db, bid, c.get('staff').id, 'business.float', 'businesses', bid, { float: (before as unknown as { float_paise?: number }).float_paise ?? null }, { floatPaise: f })]);
  return c.json({ ok: true, floatPaise: f });
});

/** The drawers that held cash during a shift day: for the day close record and the Daily check. */
export async function drawersOfDay(db: DB, bid: string, start: number, end: number) {
  const rows = await all<{ id: string; holder: string; opened_at: number; closed_at: number | null; close_kind: string | null; opening_paise: number; counted_paise: number | null;
    expected_paise: number | null; difference_paise: number | null; difference_reason: string | null; accepted: string | null; approver: string | null }>(db, `
    SELECT d.id, s.name AS holder, d.opened_at, d.closed_at, d.close_kind, d.opening_paise, d.counted_paise, d.expected_paise, d.difference_paise, d.difference_reason,
      a.name AS accepted, p.name AS approver
    FROM drawers d JOIN staff s ON s.id = d.held_by LEFT JOIN staff a ON a.id = d.accepted_by LEFT JOIN staff p ON p.id = d.approved_by
    WHERE d.business_id = ? AND d.opened_at < ? AND (d.closed_at IS NULL OR d.closed_at > ?) ORDER BY d.opened_at`, bid, end, start);
  const out = [];
  for (const r of rows) {
    const cash = await cashBetween(db, bid, r.opened_at, r.closed_at ?? now());
    out.push({ id: r.id, holder: r.holder, from: r.opened_at, to: r.closed_at, closeKind: r.close_kind, openingPaise: r.opening_paise, cashInPaise: cash.inPaise,
      cashOutPaise: cash.outPaise, countedPaise: r.counted_paise, expectedPaise: r.expected_paise, differencePaise: r.difference_paise, reason: r.difference_reason,
      acceptedBy: r.accepted, approvedBy: r.approver });
  }
  return out;
}
