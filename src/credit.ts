/**
 * Credit bills (approved 23 Nov 2026). A bill the software calls U/N that the register does not have, which a guest
 * (PARI, DK) will pay later: a person makes it credit with the guest's name on the Complimentary tab. On saving the
 * shift it is a sale with no payment mode. The Credit list shows who owes what and for how long; a free UPI credit of
 * the bill's amount after it is offered (never matched by itself), and Match makes that credit pay the bill.
 */
import type { DB } from './db';
import { all, one, stmt } from './db';
import { istDay } from './time';
import { heldCredit } from './plans';

/** A credit still owed this many days after its bill is shown in red on Home. */
export const CREDIT_RED_DAYS = 30;

interface CreditRow { id: string; shift_day: string; bill_no: string; guest_name: string; amount_paise: number; made_at: number; by: string | null;
  tx_id: string | null; paid_row: string | null; paid_at: number | null; paid_amount: number | null; account: string | null }

/** The credit sale of a credit bill (made when its shift was saved), and the credit that paid it, if any. */
const LIST_SQL = `
  SELECT k.id, k.shift_day, k.bill_no, k.guest_name, k.amount_paise, k.made_at, u.name AS by,
    t.id AS tx_id, m.bank_row_id AS paid_row, r.posted_at AS paid_at, m.amount_paise AS paid_amount, a.name AS account
  FROM credit_bills k LEFT JOIN users u ON u.id = k.made_by
    LEFT JOIN transactions t ON t.business_id = k.business_id AND t.shift_day = k.shift_day AND t.bill_no = k.bill_no AND t.type = 'income'
      AND t.source = 'software_report' AND t.payment_mode IS NULL
    LEFT JOIN bank_matches m ON m.transaction_id = t.id
    LEFT JOIN bank_rows r ON r.id = m.bank_row_id LEFT JOIN accounts a ON a.id = r.account_id
  WHERE k.business_id = ?`;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** Every credit bill: owed (with free credits of its amount since its day) and paid. */
export async function creditList(db: DB, businessId: string) {
  const today = istDay(Date.now());
  const rows = await all<CreditRow>(db, `${LIST_SQL} ORDER BY k.shift_day, k.bill_no`, businessId);
  const owed = rows.filter((r) => !r.paid_row);
  const free = owed.length ? await all<{ id: string; amount: number; postedAt: number; account: string | null; vpa: string | null }>(db, `
    SELECT r.id, r.amount_paise AS amount, r.posted_at AS postedAt, a.name AS account, r.vpa FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id
    WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.direction = 'CR' AND r.status = 'unmatched'
      AND r.amount_paise IN (${[...new Set(owed.map((r) => r.amount_paise))].map(() => '?').join(',')})
      AND NOT ${heldCredit('r.id')} ORDER BY r.posted_at`,
    businessId, ...new Set(owed.map((r) => r.amount_paise))) : [];
  const right = await creditRight(db, businessId);
  const lines = rows.map((r) => {
    const days = daysBetween(r.shift_day, today);
    const from = Date.parse(`${r.shift_day}T02:30:00Z`) - 3600e3; // the shift's 8 am IST, less an hour
    return {
      id: r.id, day: r.shift_day, billNo: r.bill_no, guestName: r.guest_name, amountPaise: r.amount_paise, madeBy: r.by, madeAt: r.made_at,
      saved: !!r.tx_id, days, red: !r.paid_row && days >= CREDIT_RED_DAYS,
      paid: r.paid_row ? { bankRowId: r.paid_row, postedAt: r.paid_at, account: r.account } : null,
      offers: r.paid_row || !r.tx_id ? [] : free.filter((c) => c.amount === r.amount_paise && c.postedAt >= from).slice(0, 3)
        .map((c) => ({ bankRowId: c.id, postedAt: c.postedAt, account: c.account, vpa: c.vpa })),
    };
  });
  const open = lines.filter((l) => !l.paid);
  return { lines, right, owedPaise: open.reduce((t, l) => t + l.amountPaise, 0), owed: open.length,
    red: open.filter((l) => l.red).map((l) => ({ guestName: l.guestName, amountPaise: l.amountPaise, days: l.days, billNo: l.billNo })) };
}

/** Matches in a row since the last Undo, up to 10 ("auto after 10 right · n/10"). */
export async function creditRight(db: DB, businessId: string) {
  const r = await one<{ n: number }>(db, `SELECT count(*) AS n FROM audit_log WHERE business_id = ? AND action = 'credit.paid'
    AND id > coalesce((SELECT max(id) FROM audit_log WHERE business_id = ? AND action = 'credit.paid_undone'), 0)`, businessId, businessId);
  return Math.min(10, r?.n ?? 0);
}

export async function creditOf(db: DB, businessId: string, id: string) {
  return one<CreditRow>(db, `${LIST_SQL} AND k.id = ?`, businessId, id);
}

/** The guest's money came: the credit pays the credit sale, in one batch, only while the credit is still open. */
export function payStatements(db: DB, businessId: string, k: CreditRow, bankRowId: string, matchId: string, userId: string, t: number) {
  const free = "EXISTS (SELECT 1 FROM bank_rows WHERE id = ? AND status = 'unmatched' AND business_id = ?)";
  return [
    stmt(db, `INSERT INTO bank_matches (id, business_id, bank_row_id, transaction_id, amount_paise, matched_by, matched_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${free}`, matchId, businessId, bankRowId, k.tx_id, k.amount_paise, userId, t, bankRowId, businessId),
    stmt(db, 'UPDATE transactions SET matched_bank_row = ? WHERE id = ? AND EXISTS (SELECT 1 FROM bank_matches m WHERE m.id = ?)', bankRowId, k.tx_id, matchId),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      SELECT ?, ?, 'credit.paid', 'credit_bills', ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM bank_matches m WHERE m.id = ?)`, businessId, userId, k.id,
      JSON.stringify({ bankRowId, transactionId: k.tx_id, billNo: k.bill_no, day: k.shift_day, guestName: k.guest_name, amountPaise: k.amount_paise }), t, matchId),
    stmt(db, "UPDATE bank_rows SET status = 'matched', done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched' AND business_id = ?", userId, t, bankRowId, businessId),
  ];
}

export function unpayStatements(db: DB, businessId: string, k: CreditRow, userId: string, t: number) {
  return [
    stmt(db, 'DELETE FROM bank_matches WHERE transaction_id = ? AND bank_row_id = ?', k.tx_id, k.paid_row),
    stmt(db, 'UPDATE transactions SET matched_bank_row = NULL WHERE id = ?', k.tx_id),
    stmt(db, "UPDATE bank_rows SET status = 'unmatched', done_by = NULL, done_at = NULL WHERE id = ? AND business_id = ? AND status = 'matched'", k.paid_row, businessId),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'credit.paid_undone', 'credit_bills', ?, ?, NULL, ?)`, businessId, userId, k.id, JSON.stringify({ bankRowId: k.paid_row, transactionId: k.tx_id }), t),
  ];
}
