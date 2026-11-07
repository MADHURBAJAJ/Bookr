// "Make the bill add up" (approved 7 Nov 2026). A credit with no bill is often a register slip on a bill near it:
// a payment written as a discount (₹8 received, written as ₹8 off), or one payment's amount written wrong (282
// written as 218). For each such credit, Bookr tries the small corrections a person would try on bills paid within an
// hour, and offers one only when the bill then equals the software and the credit pays the changed payment. A person
// presses the button; before confirming it edits the register row, after confirming it is a recorded correction
// (register_bank_adjustments) that Unmatch puts back. Bills paid together are left to the person.

import { all, newId, one, stmt, type DB } from './db';
import { fail } from './http';
import { matchStatements, type BankRow } from './bank';

const NEAR_MIN = 60;

export interface SlipPay { id: string; mode: string; label: string | null; amountPaise: number }
export interface SlipBill {
  rowId: string; uploadId: string; billNo: string; grossPaise: number; discountPaise: number; tipPaise: number; pays: SlipPay[];
  swPaise: number; paidAt: number;
  /** UPI payments a credit already backs (by id): not the one written wrong. */
  backed: Set<string>;
}
export interface SlipCredit { id: string; amountPaise: number; postedAt: number; accountName: string | null; label: string | null }
export interface Slip {
  key: string; kind: 'add_payment' | 'change_payment';
  rowId: string; uploadId: string; billNo: string; softwarePaise: number;
  creditId: string; creditPaise: number; postedAt: number; accountName: string | null; minutes: number;
  /** The payment written wrong (change_payment). */
  paymentId: string | null; fromPaise: number | null;
  before: { discountPaise: number; tipPaise: number; pays: SlipPay[] };
  after: { discountPaise: number; tipPaise: number; pays: (Omit<SlipPay, 'id'> & { id: string | null })[] };
  /** The bill's other UPI payments and the credits that pay them (e.g. the ₹210 of 210 + 282): matched with it. */
  others: { paymentId: string; creditId: string; amountPaise: number; postedAt: number }[];
}

const digits = (n: number) => String(Math.round(n / 100)).split('').sort().join('');

/** The corrections, closest in time first, each credit and each bill once. */
export function findSlips(bills: SlipBill[], credits: SlipCredit[], unmatched: { id: string; amountPaise: number; postedAt: number }[]): Slip[] {
  const options: { s: Slip; rank: number }[] = [];
  for (const c of credits) {
    for (const b of bills) {
      const minutes = Math.round(Math.abs(c.postedAt - b.paidAt) / 60000);
      if (minutes > NEAR_MIN) continue;
      const sum = b.pays.reduce((t, p) => t + p.amountPaise, 0);
      const base = { rowId: b.rowId, uploadId: b.uploadId, billNo: b.billNo, softwarePaise: b.swPaise, creditId: c.id, creditPaise: c.amountPaise, postedAt: c.postedAt,
        accountName: c.accountName, minutes, before: { discountPaise: b.discountPaise, tipPaise: b.tipPaise, pays: b.pays }, others: [] };
      const ends = (paid: number) => ({ discountPaise: Math.max(b.grossPaise - paid, 0), tipPaise: Math.max(paid - b.grossPaise, 0) });
      // A payment left out (often written as a discount): the bill is the software's, and this credit is what is missing.
      if (b.grossPaise === b.swPaise && sum + c.amountPaise === b.swPaise && (b.discountPaise || b.tipPaise || sum < b.grossPaise)) {
        options.push({ rank: minutes, s: { ...base, key: `slip:add:${b.rowId}:${c.id}`, kind: 'add_payment', paymentId: null, fromPaise: null,
          after: { ...ends(b.swPaise), pays: [...b.pays, { id: null, mode: 'upi', label: c.label ?? 'UPI', amountPaise: c.amountPaise }] } } });
      }
      // One UPI payment written wrong: no credit of its amount came near the bill, and this credit makes the bill add up.
      for (const p of b.pays) {
        if (p.mode !== 'upi' || p.amountPaise === c.amountPaise || b.backed.has(p.id)) continue;
        if (sum - p.amountPaise + c.amountPaise !== b.swPaise) continue;
        if (unmatched.some((u) => u.amountPaise === p.amountPaise && Math.abs(u.postedAt - b.paidAt) <= NEAR_MIN * 60000)) continue;
        // Digits swapped (218 for 282) or one digit wrong rank first.
        const swap = digits(p.amountPaise) === digits(c.amountPaise);
        options.push({ rank: minutes - (swap ? 30 : 0), s: { ...base, key: `slip:chg:${p.id}:${c.id}`, kind: 'change_payment', paymentId: p.id, fromPaise: p.amountPaise,
          after: { ...ends(b.swPaise), pays: b.pays.map((x) => (x.id === p.id ? { ...x, amountPaise: c.amountPaise } : x)) } } });
      }
    }
  }
  options.sort((a, b) => a.rank - b.rank);
  const usedCredit = new Set<string>();
  const usedBill = new Set<string>();
  const out: Slip[] = [];
  for (const { s } of options) {
    if (usedCredit.has(s.creditId) || usedBill.has(s.rowId)) continue;
    usedCredit.add(s.creditId); usedBill.add(s.rowId);
    out.push(s);
  }
  // The bill's other UPI payments: the closest unmatched credit of each amount near the bill, each credit once.
  for (const s of out) {
    const b = bills.find((x) => x.rowId === s.rowId)!;
    for (const p of b.pays) {
      if (p.mode !== 'upi' || p.id === s.paymentId || b.backed.has(p.id)) continue;
      const u = unmatched.filter((x) => x.amountPaise === p.amountPaise && !usedCredit.has(x.id) && Math.abs(x.postedAt - b.paidAt) <= NEAR_MIN * 60000)
        .sort((x, y) => Math.abs(x.postedAt - b.paidAt) - Math.abs(y.postedAt - b.paidAt))[0];
      if (u) { usedCredit.add(u.id); s.others.push({ paymentId: p.id, creditId: u.id, amountPaise: u.amountPaise, postedAt: u.postedAt }); }
    }
  }
  return out;
}

/**
 * Corrections for one shift, for the credits given (those with no bill). On a confirmed shift a changed payment's
 * sale must still wait for the bank; a payment left out becomes a new sale, so the bill's others may be matched.
 */
export async function shiftSlips(db: DB, businessId: string, day: string, creditIds: string[]): Promise<Slip[]> {
  if (!creditIds.length) return [];
  const credits = await all<SlipCredit>(db, `SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt, a.name AS accountName, s.receives_upi_label AS label
    FROM bank_rows r JOIN accounts a ON a.id = r.account_id LEFT JOIN bank_sources s ON s.account_id = r.account_id
    WHERE r.business_id = ? AND r.status = 'unmatched' AND r.id IN (${creditIds.map(() => '?').join(',')})`, businessId, ...creditIds.slice(0, 90));
  const [rows, pays, unmatched, sales] = await Promise.all([
    all<{ rowId: string; uploadId: string; billNo: string; grossPaise: number; discountPaise: number; tipPaise: number; swPaise: number; paidAt: number }>(db, `
      SELECT r.id AS rowId, r.upload_id AS uploadId, r.bill_no AS billNo, r.amount_paise AS grossPaise, r.discount_paise AS discountPaise, r.tip_paise AS tipPaise,
        sb.amount_paise AS swPaise, sb.paid_at AS paidAt
      FROM register_rows r JOIN software_bills sb ON sb.business_id = r.business_id AND sb.shift_day = r.shift_day AND sb.bill_no = r.bill_no
      WHERE r.business_id = ? AND r.shift_day = ? AND r.paid_with_row_id IS NULL AND sb.paid_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = r.id)`, businessId, day),
    all<SlipPay & { rowId: string }>(db, `SELECT p.id, p.register_row_id AS rowId, p.mode, p.column_label AS label, p.amount_paise AS amountPaise
      FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ? ORDER BY p.created_at, p.id`, businessId, day),
    all<{ id: string; amountPaise: number; postedAt: number }>(db, `SELECT id, amount_paise AS amountPaise, posted_at AS postedAt FROM bank_rows
      WHERE business_id = ? AND kind = 'upi_in' AND status = 'unmatched' AND day BETWEEN date(?, '-1 day') AND date(?, '+1 day')`, businessId, day, day),
    all<{ rowId: string; amountPaise: number; matched: number }>(db, `SELECT c.register_row_id AS rowId, t.amount_paise AS amountPaise, t.matched_bank_row IS NOT NULL AS matched
      FROM transactions t JOIN bill_comparisons c ON c.id = t.comparison_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'upi'`, businessId, day),
  ]);
  const confirmed = (await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day))?.status === 'confirmed';
  const bills: SlipBill[] = rows.map((r) => {
    const mine = pays.filter((p) => p.rowId === r.rowId);
    // A payment is backed when its sale is matched (confirmed shift), or a credit of its amount came near the bill.
    const sold = sales.filter((s) => s.rowId === r.rowId);
    const backed = new Set(mine.filter((p) => p.mode === 'upi' && sold.some((s) => s.matched && s.amountPaise === p.amountPaise)).map((p) => p.id));
    return { ...r, pays: mine.map(({ rowId: _r, ...p }) => p), backed };
  });
  return findSlips(bills, credits, unmatched).filter((s) => !confirmed || s.kind === 'add_payment' || sales.some((x) => x.rowId === s.rowId && !x.matched && x.amountPaise === s.fromPaise));
}

/**
 * On a confirmed shift: the correction as recorded changes, and the credit matched to the changed (or added) sale.
 * Every change is recorded under the credit, so Unmatch puts it all back (see undoAll: rows marked 'added' go).
 */
export async function slipFixStatements(db: DB, businessId: string, credit: BankRow, s: Slip, userId: string, t: number) {
  const note = `Register corrected from bank: bill ${s.billNo}`;
  const statements: D1PreparedStatement[] = [];
  const record = (target: string, id: string, field: string, v: { bp?: number | null; ap?: number | null; at?: string | null }) =>
    statements.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, after_text, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), businessId, credit.id, target, id, field, v.bp ?? null, v.ap ?? null, v.at ?? null, note, userId, t));
  const cmp = await one<{ id: string }>(db, 'SELECT id FROM bill_comparisons WHERE business_id = ? AND register_row_id = ?', businessId, s.rowId);
  if (!cmp) fail(400, 'This bill has no comparison. Correct it on its register page.');
  const sales = await all<Record<string, unknown> & { id: string; amount_paise: number; payment_mode: string; matched_bank_row: string | null; match_status: string | null }>(db,
    "SELECT * FROM transactions WHERE comparison_id = ? AND type = 'income' ORDER BY amount_paise", cmp.id);
  if (s.after.discountPaise !== s.before.discountPaise) record('register_row', s.rowId, 'discount_paise', { bp: s.before.discountPaise, ap: s.after.discountPaise });
  if (s.after.tipPaise !== s.before.tipPaise) record('register_row', s.rowId, 'tip_paise', { bp: s.before.tipPaise, ap: s.after.tipPaise });
  statements.push(stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ? WHERE id = ?', s.after.discountPaise, s.after.tipPaise, s.rowId));
  let txId: string;
  if (s.kind === 'change_payment') {
    const tx = sales.find((x) => x.payment_mode === 'upi' && !x.matched_bank_row && x.match_status === 'awaiting_bank_match' && x.amount_paise === s.fromPaise);
    if (!tx) fail(409, `Bill ${s.billNo}'s ₹${(s.fromPaise! / 100).toFixed(2)} sale is not waiting for the bank.`);
    record('register_payment', s.paymentId!, 'amount_paise', { bp: s.fromPaise, ap: s.creditPaise });
    statements.push(stmt(db, 'UPDATE register_payments SET amount_paise = ? WHERE id = ?', s.creditPaise, s.paymentId));
    record('transaction', tx.id, 'amount_paise', { bp: tx.amount_paise, ap: s.creditPaise });
    statements.push(stmt(db, 'UPDATE transactions SET amount_paise = ? WHERE id = ?', s.creditPaise, tx.id));
    txId = tx.id;
  } else {
    const like = sales.find((x) => x.payment_mode === 'upi') ?? sales[0];
    if (!like) fail(400, `Bill ${s.billNo} has no sale to add the payment to.`);
    const payId = newId();
    txId = newId();
    const label = s.after.pays.find((p) => p.id === null)!.label;
    record('register_payment', payId, 'row', { ap: s.creditPaise, at: 'added' });
    statements.push(stmt(db, "INSERT INTO register_payments (id, business_id, register_row_id, mode, column_label, amount_paise, created_at) VALUES (?, ?, ?, 'upi', ?, ?, ?)",
      payId, businessId, s.rowId, label, s.creditPaise, t));
    record('transaction', txId, 'row', { ap: s.creditPaise, at: 'added' });
    const row: Record<string, unknown> = { ...like, id: txId, amount_paise: s.creditPaise, payment_mode: 'upi', matched_bank_row: null, match_status: 'awaiting_bank_match', account_id: null }; // UPI sales sit on no account until matched
    if ('created_at' in row) row.created_at = t;
    const cols = Object.keys(row);
    statements.push(stmt(db, `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((k) => row[k] as never)));
  }
  statements.push(...matchStatements(db, businessId, credit.id, [txId], userId, t));
  // The bill's other UPI payments with their credits, when their sales still wait.
  const free = sales.filter((x) => x.payment_mode === 'upi' && !x.matched_bank_row && x.match_status === 'awaiting_bank_match' && x.id !== txId);
  for (const o of s.others) {
    const i = free.findIndex((x) => x.amount_paise === o.amountPaise);
    if (i < 0) continue;
    statements.push(...matchStatements(db, businessId, o.creditId, [free.splice(i, 1)[0].id], userId, t));
  }
  return statements;
}
