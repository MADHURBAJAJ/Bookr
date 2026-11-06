// A credit booked directly as a sale, whose bill turns up later: one sale, not two (approved 7 Nov 2026).
// A person joins them. The booking goes, the credit is matched to the bill, and the sale stays on the booked day.
import { all, one, stmt, type DB } from './db';
import { matchStatements, settleOnCredit } from './bank';
import type { Card } from './explain';
import { addDays, shiftWindow } from './time';

const WATCH = 7;
/** Small amounts repeat all day: with more than one bill of the amount, they are not worth a card. */
const SMALL_PAISE = 10000;

export interface BookedSale { id: string; amountPaise: number; postedAt: number; txId: string; txDay: string; headId: string | null; headName: string | null; accountName: string | null }
export interface WaitingBill { billNo: string; amountPaise: number; day: string; txId?: string; comparisonId: string; swPaise: number | null; rgPaise: number | null; headName: string | null }

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hm = (ms: number) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
export const dayName = (day: string) => new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${day}T00:00:00Z`));

/** Credits booked under a head that a bill type uses (so as a sale, not as interest or rent), from the watch before this shift to the day after. */
export function bookedSalesAround(db: DB, businessId: string, day: string) {
  return all<BookedSale>(db, `
    SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt, t.id AS txId, t.day AS txDay, t.head_id AS headId, h.name AS headName, a.name AS accountName
    FROM bank_rows r JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id LEFT JOIN accounts a ON a.id = r.account_id
    WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'booked' AND t.type = 'income' AND t.source = 'bank_sheet'
      AND t.head_id IN (SELECT head_id FROM bill_type_heads WHERE business_id = ?)
      AND r.posted_at >= ? AND r.posted_at < ? ORDER BY r.posted_at`,
    businessId, businessId, shiftWindow(addDays(day, -WATCH)).from, shiftWindow(addDays(day, 1)).to);
}

/** Each credit with one bill of its amount, each used once, the credit nearest the shift first. */
export function pairBooked(bills: WaitingBill[], booked: BookedSale[], day: string) {
  const end = shiftWindow(day).to;
  const free = new Set(bills);
  const out: { bill: WaitingBill; credit: BookedSale; others: number }[] = [];
  for (const credit of [...booked].sort((a, b) => Math.abs(end - a.postedAt) - Math.abs(end - b.postedAt))) {
    const same = bills.filter((b) => b.amountPaise === credit.amountPaise);
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
    title: `${rs(credit.amountPaise)} booked as ${credit.headName ?? 'a sale'} on ${onBook}: is it bill ${bill.billNo}?`,
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
      h.name AS headName, coalesce(json_extract(t.ocr_original, '$.countOnCredit'), 0) AS onCredit
    FROM transactions t JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN register_rows rr ON rr.id = c.register_row_id LEFT JOIN heads h ON h.id = t.head_id
    WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
      AND (rr.id IS NULL OR (rr.paid_with_row_id IS NULL AND NOT EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = rr.id)))
      AND (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income') = 1`, businessId, day);
  const counted = new Map(rows.map((r) => [r.txId, !r.onCredit]));
  return pairBooked(rows.filter((r) => !skip.has(r.txId)), booked, day).map((p) => sameSaleCard(`/businesses/${businessId}`, p, counted.get(p.bill.txId!) ?? true));
}

// ---- Before confirming: the wish is kept in the audit log until the confirm makes the sale it applies to.

export async function plansFor(db: DB, businessId: string, day: string) {
  const rows = await all<{ rowId: string; after: string }>(db, `SELECT a.row_id AS rowId, a.after FROM audit_log a
    WHERE a.business_id = ? AND a.action = 'bank.same_sale_planned' AND json_extract(a.after, '$.shiftDay') = ?
      AND NOT EXISTS (SELECT 1 FROM audit_log u WHERE u.business_id = a.business_id AND u.action = 'bank.same_sale_unplanned' AND u.row_id = a.row_id AND u.id > a.id)
      AND EXISTS (SELECT 1 FROM bank_rows r WHERE r.id = a.row_id AND r.status = 'booked') ORDER BY a.id`, businessId, day);
  return rows.map((r) => ({ rowId: r.rowId, comparisonId: (JSON.parse(r.after) as { comparisonId: string }).comparisonId }));
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
    ...settleOnCredit(db, businessId),
  ];
}

/** Bills of this amount waiting near a credit about to be booked: booking it too would count that sale twice. */
export async function waitingBillsLike(db: DB, businessId: string, amountPaise: number, day: string) {
  if (amountPaise < SMALL_PAISE) return [];
  const from = addDays(day, -WATCH);
  const to = addDays(day, WATCH);
  return all<{ billNo: string; day: string }>(db, `
    SELECT t.bill_no AS billNo, t.shift_day AS day FROM transactions t
    WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
      AND t.amount_paise = ? AND t.shift_day BETWEEN ? AND ?
    UNION
    SELECT c.bill_no, c.shift_day FROM bill_comparisons c LEFT JOIN shifts s ON s.business_id = c.business_id AND s.shift_day = c.shift_day
    WHERE c.business_id = ? AND coalesce(s.status, '') <> 'confirmed' AND c.closed_at IS NULL AND coalesce(c.decision, '') NOT IN ('leave_out', 'carry_forward')
      AND c.shift_day BETWEEN ? AND ? AND ((c.rg_mode = 'upi' AND c.rg_amount_paise = ?) OR (c.sw_mode = 'upi' AND c.sw_amount_paise = ?))
    LIMIT 5`, businessId, amountPaise, from, to, businessId, from, to, amountPaise, amountPaise);
}
