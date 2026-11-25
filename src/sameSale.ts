// A credit booked directly as a sale, whose bill turns up later: one sale, not two (approved 7 Nov 2026).
// A person joins them. The booking goes, the credit is matched to the bill, and the sale stays on the booked day.
import { all, one, stmt, type DB } from './db';
import { matchStatements, settleOnCredit } from './bank';
import type { Card } from './explain';
import { addDays, shiftWindow } from './time';
import { ADVANCE_DAYS, ADVANCE_TAG } from './extra';
import { shiftPlans } from './plans';

const WATCH = 7;
/** Small amounts repeat all day: with more than one bill of the amount, they are not worth a card. */
const SMALL_PAISE = 10000;

export interface BookedSale { id: string; amountPaise: number; postedAt: number; txId: string; txDay: string; headId: string | null; headName: string | null; accountName: string | null; advance?: number }
export interface WaitingBill { billNo: string; amountPaise: number; day: string; txId?: string; comparisonId: string; swPaise: number | null; rgPaise: number | null; headName: string | null; txCount?: number; paidAt?: number | null }

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hm = (ms: number) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
export const dayName = (day: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${day}T00:00:00Z`));

/**
 * Credits booked under a head that a bill type uses (so as a sale, not as interest or rent), from the watch before this
 * shift to the day after. An advance (Stage 5, 10 Nov 2026) is looked for over ADVANCE_DAYS: a room is often paid ahead.
 */
export function bookedSalesAround(db: DB, businessId: string, day: string) {
  return all<BookedSale>(db, `
    SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt, t.id AS txId, t.day AS txDay, t.head_id AS headId, h.name AS headName, a.name AS accountName,
      (t.narration LIKE ?) AS advance
    FROM bank_rows r JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id LEFT JOIN accounts a ON a.id = r.account_id
    WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'booked' AND t.type = 'income' AND t.source = 'bank_sheet'
      AND t.head_id IN (SELECT head_id FROM bill_type_heads WHERE business_id = ?)
      AND (r.posted_at >= ? OR (t.narration LIKE ? AND r.posted_at >= ?)) AND r.posted_at < ? ORDER BY r.posted_at`,
    `%${ADVANCE_TAG}%`, businessId, businessId, shiftWindow(addDays(day, -WATCH)).from, `%${ADVANCE_TAG}%`, shiftWindow(addDays(day, -ADVANCE_DAYS)).from, shiftWindow(addDays(day, 1)).to);
}

/** Each credit with one bill of its amount, each used once, the credit nearest the shift first. */
export function pairBooked(bills: WaitingBill[], booked: BookedSale[], day: string) {
  const end = shiftWindow(day).to;
  const free = new Set(bills);
  const out: { bill: WaitingBill; credit: BookedSale; others: number }[] = [];
  for (const credit of [...booked].sort((a, b) => Math.abs(end - a.postedAt) - Math.abs(end - b.postedAt))) {
    // An advance may pay one payment line of a bill paid in parts; any other credit pays a bill paid in one go.
    const same = bills.filter((b) => b.amountPaise === credit.amountPaise && (credit.advance || (b.txCount ?? 1) === 1));
    const bill = same.find((b) => free.has(b));
    if (!bill || (credit.amountPaise < SMALL_PAISE && same.length > 1)) continue;
    free.delete(bill);
    out.push({ bill, credit, others: same.length - 1 });
  }
  return out;
}

export function sameSaleCard(base: string, p: { bill: WaitingBill; credit: BookedSale; others: number }, counted: boolean): Card {
  const { bill, credit, others } = p;
  const onBook = dayName(credit.txDay);
  const trial = !bill.txId;
  return {
    key: `same-sale:${credit.id}:${bill.comparisonId}`, kind: 'same_sale', billNos: [bill.billNo],
    title: credit.advance ? `Advance of ${rs(credit.amountPaise)} received on ${onBook}: does bill ${bill.billNo} use it?`
      : `${rs(credit.amountPaise)} booked as ${credit.headName ?? 'a sale'} on ${onBook}: is it bill ${bill.billNo}?`,
    evidence: [
      counted ? 'If this is the same sale, it is counted twice now: once from the bank, once from the bill.' : 'If this is the same sale, this bill can never find a credit, because its credit is already booked.',
      `Same sale keeps it on ${onBook}, matched to this credit.${trial ? ' It is done when you confirm the shift.' : ''} Undo puts the booking back.`,
      ...(bill.headName && credit.headName && bill.headName !== credit.headName ? [`It moves from ${credit.headName} to ${bill.headName}, as the bill says.`] : []),
      ...(others ? [`${others} other bill${others === 1 ? '' : 's'} of this amount on this shift: check the number first.`] : []),
    ],
    score: others ? 60 : 80,
    uses: [...(bill.txId ? [`tx:${bill.txId}`] : []), `cmp:${bill.comparisonId}`],
    witnesses: { software: bill.swPaise != null ? `Bill ${bill.billNo} · ${rs(bill.swPaise)}` : null, register: bill.rgPaise != null ? `Bill ${bill.billNo} · ${rs(bill.rgPaise)}` : null,
      bank: `${rs(credit.amountPaise)} at ${hm(credit.postedAt)}, ${onBook}${credit.accountName ? ` · ${credit.accountName}` : ''}`, odd: null },
    same: { credit: { amountPaise: credit.amountPaise, postedAt: credit.postedAt, day: credit.txDay, accountName: credit.accountName, headName: credit.headName, advance: !!credit.advance },
      bill: { billNo: bill.billNo, amountPaise: bill.amountPaise, day: bill.day, swPaise: bill.swPaise, rgPaise: bill.rgPaise, paidAt: bill.paidAt ?? null, headName: bill.headName }, counted, trial, others },
    actions: [{ label: 'Same sale', primary: true, method: 'POST',
      path: trial ? `${base}/comparisons/${bill.comparisonId}/same-sale` : `${base}/sales/${bill.txId}/same-sale`, body: { rowId: credit.id } }],
  };
}

/** Confirmed shift: bills waiting for a credit, paid in one UPI payment and not with other bills. */
export async function sameSaleCards(db: DB, businessId: string, day: string, skip: Set<string>): Promise<Card[]> {
  const booked = await bookedSalesAround(db, businessId, day);
  if (!booked.length) return [];
  const rows = await all<WaitingBill & { onCredit: number; txId: string }>(db, `
    SELECT t.id AS txId, t.bill_no AS billNo, t.amount_paise AS amountPaise, t.shift_day AS day, t.comparison_id AS comparisonId, c.sw_amount_paise AS swPaise, c.rg_amount_paise AS rgPaise,
      h.name AS headName, coalesce(json_extract(t.ocr_original, '$.countOnCredit'), 0) AS onCredit,
      (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income') AS txCount
    FROM transactions t JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN register_rows rr ON rr.id = c.register_row_id LEFT JOIN heads h ON h.id = t.head_id
    WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
      AND (rr.id IS NULL OR (rr.paid_with_row_id IS NULL AND NOT EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = rr.id)))`, businessId, day);
  const counted = new Map(rows.map((r) => [r.txId, !r.onCredit]));
  return pairBooked(rows.filter((r) => !skip.has(r.txId)), booked, day).map((p) => sameSaleCard(`/businesses/${businessId}`, p, counted.get(p.bill.txId!) ?? true));
}

// ---- Before confirming: the wish is a same_sale plan of the shift until the save makes the sale it applies to.

/** Same-sale plans of this shift whose credit is still booked: the credit and the bill. */
export async function plansFor(db: DB, businessId: string, day: string) {
  const plans = await shiftPlans(db, businessId, day, ['same_sale']);
  if (!plans.length) return [];
  const ids = plans.map((p) => p.bankRowIds[0]);
  const booked = new Set((await all<{ id: string }>(db, `SELECT id FROM bank_rows WHERE business_id = ? AND status = 'booked' AND id IN (${ids.map(() => '?').join(',')})`, businessId, ...ids)).map((r) => r.id));
  return plans.filter((p) => booked.has(p.bankRowIds[0])).map((p) => ({ planId: p.id, rowId: p.bankRowIds[0], comparisonId: p.comparisonIds[0] }));
}

// ---- Joining and taking it apart

export const bookedTx = (db: DB, businessId: string, rowId: string) => one<Record<string, unknown> & { id: string; day: string; head_id: string | null }>(db, `
  SELECT t.* FROM bank_rows r JOIN transactions t ON t.id = r.transaction_id
  WHERE r.id = ? AND r.business_id = ? AND r.status = 'booked' AND r.kind = 'upi_in' AND t.type = 'income' AND t.source = 'bank_sheet'`, rowId, businessId);

/** The booking goes, the bill takes its day, and the credit is matched to the bill. Works on a sale made earlier in the same batch. */
export function sameSaleStatements(db: DB, businessId: string, row: { id: string; note: string | null; done_by?: string | null; done_at?: number | null }, booked: { id: string; day: string; head_id: string | null },
  bill: { id: string; day: string; status: string; ocr_original: string | null; head_id: string | null }, userId: string, t: number) {
  return [
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'bank.same_sale', 'bank_rows', ?, ?, ?, ?)`, businessId, userId, row.id,
      JSON.stringify({ booked, note: row.note, doneBy: row.done_by ?? null, doneAt: row.done_at ?? null, bill }), JSON.stringify({ transactionId: bill.id, day: booked.day }), t),
    stmt(db, "UPDATE bank_rows SET status = 'unmatched', transaction_id = NULL, note = NULL WHERE id = ? AND status = 'booked'", row.id),
    stmt(db, "DELETE FROM transactions WHERE id = ? AND source = 'bank_sheet'", booked.id),
    stmt(db, `UPDATE transactions SET status = 'approved', day = ?, head_id = coalesce(head_id, ?), ocr_original = json_set(coalesce(ocr_original, '{}'), '$.sameSale', 1) WHERE id = ?`, booked.day, booked.head_id, bill.id),
    ...matchStatements(db, businessId, row.id, [bill.id], userId, t + 1),
  ];
}

/** Is this matched credit a joined one? Unmatch and Undo then put the booking back. */
export const joinedBill = (db: DB, rowId: string) => one<{ id: string }>(db, `SELECT t.id FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id
  WHERE m.bank_row_id = ? AND json_extract(t.ocr_original, '$.sameSale') = 1`, rowId);

export async function undoSameSaleStatements(db: DB, businessId: string, rowId: string, userId: string, t: number) {
  const a = await one<{ before: string }>(db, "SELECT before FROM audit_log WHERE business_id = ? AND action = 'bank.same_sale' AND row_id = ? ORDER BY id DESC LIMIT 1", businessId, rowId);
  if (!a) return null;
  const b = JSON.parse(a.before) as { booked: Record<string, unknown> & { id: string }; note: string | null; doneBy: string | null; doneAt: number | null;
    bill: { id: string; day: string; status: string; ocr_original: string | null; head_id: string | null } };
  const cols = Object.keys(b.booked);
  return [
    stmt(db, 'DELETE FROM bank_matches WHERE bank_row_id = ?', rowId),
    stmt(db, "UPDATE transactions SET matched_bank_row = NULL, match_status = 'awaiting_bank_match', day = ?, status = ?, ocr_original = ?, head_id = ? WHERE id = ?", b.bill.day, b.bill.status, b.bill.ocr_original, b.bill.head_id, b.bill.id),
    stmt(db, `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((k) => b.booked[k])),
    stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ?", b.booked.id, b.note, b.doneBy, b.doneAt, rowId),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'bank.same_sale_undone', 'bank_rows', ?, NULL, ?, ?)`, businessId, userId, rowId,
      JSON.stringify({ transactionId: b.bill.id, bookingRestored: b.booked.id }), t),
    // The undo stands: the plan that made the join is withdrawn, so Reopen and Save does not join them again (audit, 14 Nov 2026).
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      SELECT business_id, ?, 'bank.same_sale_unplanned', 'bank_rows', row_id, NULL, after, ? FROM audit_log
      WHERE business_id = ? AND action = 'bank.same_sale_planned' AND row_id = ? ORDER BY id DESC LIMIT 1`, userId, t, businessId, rowId),
    ...settleOnCredit(db, businessId),
  ];
}

/**
 * Bills of this amount waiting near a credit about to be booked: booking it too would count that sale twice. The UPI
 * part of a bill split between cash and UPI counts too (bill 26110648, 6 Nov: ₹966 = ₹500 cash + ₹466 UPI; approved
 * 24 Nov 2026). txId: a saved sale the credit can be matched to now; without it the shift is not saved yet and the
 * credit is matched when it is.
 */
export async function waitingBillsLike(db: DB, businessId: string, amountPaise: number, day: string, rowId: string | null = null) {
  // Any amount (the booking gate, 25 Nov 2026: small credits are checked too). Not a bill closed by a person, nor one
  // already chosen to be paid by another credit on Reconcile.
  const from = addDays(day, -WATCH);
  const to = addDays(day, WATCH);
  type Waiting = { billNo: string; day: string; txId: string | null; billPaise: number; upiPaise: number };
  const [saved, open] = await Promise.all([
    all<Waiting>(db, `
      SELECT t.bill_no AS billNo, t.shift_day AS day, t.id AS txId, t.amount_paise AS upiPaise,
        (SELECT sum(x.amount_paise) FROM transactions x WHERE x.business_id = t.business_id AND x.type = 'income' AND x.bill_no = t.bill_no AND x.shift_day = t.shift_day) AS billPaise
      FROM transactions t
      WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
        AND t.amount_paise = ? AND t.shift_day BETWEEN ? AND ? AND t.id NOT IN (SELECT transaction_id FROM closed_bills WHERE business_id = t.business_id)
        AND NOT EXISTS (SELECT 1 FROM shift_plans p, json_each(p.comparison_ids) j WHERE p.business_id = t.business_id AND j.value = t.id)
      ORDER BY t.shift_day, t.bill_no LIMIT 5`, businessId, amountPaise, from, to),
    all<Waiting>(db, `
      SELECT c.bill_no AS billNo, c.shift_day AS day, NULL AS txId, ? AS upiPaise, coalesce(c.rg_amount_paise, c.sw_amount_paise, ?) AS billPaise
      FROM bill_comparisons c LEFT JOIN shifts s ON s.business_id = c.business_id AND s.shift_day = c.shift_day
      WHERE c.business_id = ? AND coalesce(s.status, '') <> 'confirmed' AND c.closed_at IS NULL AND coalesce(c.decision, '') NOT IN ('leave_out', 'carry_forward')
        AND c.shift_day BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM shift_plans p, json_each(p.comparison_ids) j WHERE p.business_id = c.business_id AND j.value = c.id)
        AND ((c.rg_mode = 'upi' AND c.rg_amount_paise = ?) OR (c.sw_mode = 'upi' AND c.sw_amount_paise = ?)
          OR (c.register_row_id IS NOT NULL AND (SELECT sum(p.amount_paise) FROM register_payments p WHERE p.register_row_id = c.register_row_id AND p.mode = 'upi') = ?))
      ORDER BY c.shift_day, c.bill_no LIMIT 20`, amountPaise, amountPaise, businessId, from, to, amountPaise, amountPaise, amountPaise),
  ]);
  // A shift not saved yet pairs its bills with the credits in its hours when it is saved: a bill there needs this credit
  // only when the other free credits of this amount in those hours are fewer than its bills of this amount (20 Nov 2026,
  // more "could be" credits than bills: the rest are extra and bookable).
  const byDay = new Map<string, Waiting[]>();
  for (const b of open) byDay.set(b.day, [...(byDay.get(b.day) ?? []), b]);
  const need: Waiting[] = [];
  for (const [d, bills] of byDay) {
    const w = shiftWindow(d);
    const free = await one<{ n: number }>(db, `SELECT count(*) AS n FROM bank_rows r WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.direction = 'CR' AND r.status = 'unmatched'
      AND r.amount_paise = ? AND r.posted_at >= ? AND r.posted_at < ? AND r.id <> ? AND NOT EXISTS (SELECT 1 FROM shift_plan_items i WHERE i.bank_row_id = r.id)`,
      businessId, amountPaise, w.from - 3600e3, w.to + 3 * 3600e3, rowId ?? '');
    if ((free?.n ?? 0) < bills.length) need.push(...bills);
  }
  return [...saved, ...need].slice(0, 5);
}
