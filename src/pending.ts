/**
 * Reports → Pending bills (approved 19 Nov 2026): every bill whose money has not come, over a range of shifts, and the
 * bills whose money came on a later day. Read-only: each line is fixed on its own day's To do or Card/UPI tab.
 *
 * To be received:
 * - the Waiting "look" lines of saved shifts (payment not received, payment found to match, paperwork differs, cash
 *   bills not in the register inside their 2 days, other);
 * - the bills that explain a saved shift's short cash count (the same as its Cash panel), when not already listed.
 * Lines that only wait for a file or for their shift to be saved are counted, not listed.
 *
 * Already received:
 * - a bill changed after saving to the card or UPI payment that came on a later day (sale.repaid, settled later);
 * - a UPI bill matched to a credit that came after its shift ended;
 * - a cash bill not in its own register, written as cash in a later day's register.
 */
import type { DB } from './db';
import { all } from './db';
import { addDays, istDay, shiftDayOf, shiftWindow } from './time';
import { waitingPicture } from './waiting';
import { cashCheck } from './cash';

export type PendingGroup = 'not_received' | 'cash_short' | 'cash_wait' | 'found' | 'paperwork' | 'other';
export interface PendingLine { day: string; billNo: string; amountPaise: number; mode: string | null; group: PendingGroup; reason: string; daysWaiting: number; saved: boolean }
export interface ReceivedLine {
  day: string; billNo: string; amountPaise: number; from: string | null; mode: string; paidOn: string | null; how: 'changed' | 'late_credit' | 'late_register';
  detail: string; by: string | null; at: number | null; lateDays: number | null;
  shortage?: { fromPaise: number; toPaise: number } | null;
}

const rs = (p: number) => `₹ ${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export async function pendingBills(db: DB, businessId: string, from: string, to: string, today = istDay(Date.now())) {
  const [picture, countDays] = await Promise.all([
    waitingPicture(db, businessId, today),
    all<{ day: string }>(db, `SELECT DISTINCT s.shift_day AS day FROM cash_summaries s JOIN shifts h ON h.business_id = s.business_id AND h.shift_day = s.shift_day
      WHERE s.business_id = ? AND s.status = 'approved' AND h.status = 'confirmed' AND s.shift_day BETWEEN ? AND ? ORDER BY 1`, businessId, from, to),
  ]);
  const inRange = (d: string) => d >= from && d <= to;
  const toReceive: PendingLine[] = picture.look.filter((x) => inRange(x.day) && x.billNo).map((x) => ({
    day: x.day, billNo: x.billNo, amountPaise: x.amountPaise, mode: x.mode, group: (x.kind ?? 'other') as PendingGroup, reason: x.reason,
    daysWaiting: x.daysWaiting, saved: x.confirmed,
  }));
  const listed = new Set(toReceive.flatMap((x) => x.billNo.split(' + ').map((b) => `${x.day}|${b}`)));
  // A saved shift's short count, explained by its bills (as on its Cash panel).
  const checks = await Promise.all(countDays.map((d) => cashCheck(db, businessId, d.day)));
  for (const k of checks) {
    if (!k.explained || k.settled || k.differencePaise == null || k.differencePaise >= 0) continue;
    for (const b of k.explained.bills) {
      if (listed.has(`${k.day}|${b.billNo}`)) continue;
      const notCash = k.registerNotCash.find((x) => x.billNo === b.billNo);
      const nir = k.notInRegister.find((x) => x.billNo === b.billNo);
      const reason = notCash ? `Cash · the register wrote ${(notCash.rgMode ?? 'another mode').toUpperCase()}${notCash.rgPaise && notCash.rgPaise !== notCash.amountPaise ? ` ${rs(notCash.rgPaise)}` : ''}, short in the cash count`
        : nir?.late ? `Cash · written in the ${short(nir.late.day)} register${nir.late.mode ? ` as ${nir.late.mode}` : ''}, short in the cash count`
          : `Cash · not in any register, short in the cash count`;
      toReceive.push({ day: k.day, billNo: b.billNo, amountPaise: b.partPaise, mode: 'cash', group: 'cash_short', reason, daysWaiting: daysBetween(k.day, today), saved: true });
      listed.add(`${k.day}|${b.billNo}`);
    }
  }
  toReceive.sort((a, b) => a.day.localeCompare(b.day) || a.billNo.localeCompare(b.billNo));
  const waitingForFiles = picture.grey.filter((g) => inRange(g.day)).reduce((t, g) => t + (g.count ?? 1), 0);

  // Already received.
  const [changed, lateCredits, lateRegister] = await Promise.all([
    all<{ after: string; created_at: number; who: string | null }>(db, `SELECT a.after, a.created_at, u.name AS who FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.business_id = ? AND a.action = 'sale.repaid' AND json_extract(a.after, '$.settledLater') = 1 AND json_extract(a.after, '$.shiftDay') BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.business_id = a.business_id AND x.action = 'sale.repay_undone' AND x.row_id = CAST(a.id AS TEXT))
      ORDER BY a.id`, businessId, from, to),
    all<{ day: string; billNo: string; amountPaise: number; postedAt: number; tranId: string; account: string; matchedAt: number | null; who: string | null }>(db, `
      SELECT t.shift_day AS day, t.bill_no AS billNo, m.amount_paise AS amountPaise, r.posted_at AS postedAt, r.tran_id AS tranId, a.name AS account,
        m.matched_at AS matchedAt, u.name AS who
      FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id JOIN bank_rows r ON r.id = m.bank_row_id JOIN accounts a ON a.id = r.account_id
      LEFT JOIN users u ON u.id = m.matched_by
      WHERE m.business_id = ? AND t.payment_mode = 'upi' AND t.shift_day BETWEEN ? AND ? AND r.day > t.shift_day AND t.bill_no IS NOT NULL
      ORDER BY t.shift_day, t.bill_no`, businessId, from, to),
    all<{ day: string; billNo: string; amountPaise: number; lateDay: string; rgPaise: number | null }>(db, `
      SELECT c.shift_day AS day, c.bill_no AS billNo, c.sw_amount_paise AS amountPaise, x.shift_day AS lateDay, x.rg_amount_paise AS rgPaise
      FROM bill_comparisons c JOIN bill_comparisons x ON x.business_id = c.business_id AND x.linked_to_id = c.id
      WHERE c.business_id = ? AND c.shift_day BETWEEN ? AND ? AND c.sw_mode = 'cash' AND c.difference = 'missing_in_register' AND x.rg_mode = 'cash' AND x.shift_day > c.shift_day
      ORDER BY c.shift_day, c.bill_no`, businessId, from, to),
  ]);
  const received: ReceivedLine[] = [];
  const seen = new Set<string>();
  for (const a of changed) {
    const o = JSON.parse(a.after) as { shiftDay: string; from: string; mode: string; bills: string[]; amountPaise: number; paidOn?: string | null; shortage?: { fromPaise: number; toPaise: number } | null };
    const billNo = o.bills.join(' + ');
    received.push({ day: o.shiftDay, billNo, amountPaise: o.amountPaise, from: o.from, mode: o.mode, paidOn: o.paidOn ?? null, how: 'changed',
      detail: `${o.mode === 'upi' ? 'UPI' : o.mode === 'card' ? 'Card' : o.mode}${o.paidOn ? ` on ${short(o.paidOn)}` : ''} · was ${o.from}`,
      by: a.who, at: a.created_at, lateDays: o.paidOn ? daysBetween(o.shiftDay, o.paidOn) : null, shortage: o.shortage ?? null });
    for (const b of o.bills) seen.add(`${o.shiftDay}|${b}`);
  }
  for (const c of lateCredits) {
    if (c.postedAt < shiftWindow(c.day).to || seen.has(`${c.day}|${c.billNo}`)) continue;
    const paidOn = shiftDayOf(c.postedAt);
    received.push({ day: c.day, billNo: c.billNo, amountPaise: c.amountPaise, from: 'upi', mode: 'upi', paidOn, how: 'late_credit',
      detail: `UPI credit on ${short(istDay(c.postedAt))}, ${timeOf(c.postedAt)} · ${c.account} · ${c.tranId}`, by: c.who, at: c.matchedAt, lateDays: daysBetween(c.day, paidOn) });
    seen.add(`${c.day}|${c.billNo}`);
  }
  for (const c of lateRegister) {
    if (seen.has(`${c.day}|${c.billNo}`)) continue;
    received.push({ day: c.day, billNo: c.billNo, amountPaise: c.amountPaise, from: 'cash', mode: 'cash', paidOn: c.lateDay, how: 'late_register',
      detail: `Cash · written in the ${short(c.lateDay)} register${c.rgPaise != null && c.rgPaise !== c.amountPaise ? ` as ${rs(c.rgPaise)}` : ''}`, by: null, at: null, lateDays: daysBetween(c.day, c.lateDay) });
    seen.add(`${c.day}|${c.billNo}`);
  }
  received.sort((a, b) => a.day.localeCompare(b.day) || a.billNo.localeCompare(b.billNo));
  return { from, to, toReceive, received, waitingForFiles };
}

/** The default range: the last 30 shifts up to yesterday's. */
export function pendingRange(q: { from?: string; to?: string }, today = istDay(Date.now())) {
  const iso = (v?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? v! : null);
  const to = iso(q.to) ?? today;
  let from = iso(q.from) ?? addDays(to, -30);
  if (from > to) from = to;
  if (from < addDays(to, -366)) from = addDays(to, -366);
  return { from, to };
}
