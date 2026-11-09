// "Paid another way" (approved 3 Nov 2026): a confirmed UPI sale the bank never received, which was in fact paid
// by cash or card (the register's mode was a slip). The register payment's mode and the sale move to cash or card;
// a cash sale then counts in the shift's cash check. Recorded in the audit log with whole before rows, so it can be
// put back. Bills paid together change together (one payment).
// Also (approved 8 Nov 2026) a confirmed card sale no card payment was found for once the card report is in ("Was
// cash?"): it moves to cash or UPI the same way. And (approved 9 Nov 2026) a confirmed cash sale that was paid on the
// card machine moves to card, matched to that machine payment in the same step (see routes/cards.ts).

import { all, one, stmt, type DB } from './db';
import { fail } from './http';
import { cashAccountId } from './sales';

export async function repayStatements(db: DB, businessId: string, txIds: string[], mode: 'cash' | 'card' | 'upi', note: string, userId: string, t: number) {
  const tx = await all<Record<string, unknown> & { id: string; amount_paise: number; payment_mode: string; match_status: string | null; matched_bank_row: string | null;
    comparison_id: string | null; shift_day: string; bill_no: string | null }>(db,
    `SELECT * FROM transactions WHERE business_id = ? AND type = 'income' AND source = 'software_report' AND id IN (${txIds.map(() => '?').join(',')})`, businessId, ...txIds);
  if (tx.length !== txIds.length) fail(404, 'A sale was not found.');
  const from = tx[0].payment_mode;
  const open = (x: (typeof tx)[number]) => (x.payment_mode === 'upi' && !x.matched_bank_row && x.match_status === 'awaiting_bank_match')
    || (x.payment_mode === 'card' && x.match_status === 'awaiting_card_settlement')
    || (x.payment_mode === 'cash' && x.match_status == null);
  if (tx.some((x) => x.payment_mode !== from || !open(x))) fail(409, 'Only a UPI sale not yet found in the bank, a card sale with no card payment, or a cash sale can be changed here.');
  if (from === mode) fail(400, `This sale is already ${mode === 'upi' ? 'UPI' : mode}.`);
  if (from === 'card' && await one(db, `SELECT 1 AS x FROM card_matches WHERE transaction_id IN (${txIds.map(() => '?').join(',')})`, ...txIds)) fail(409, 'This card sale is matched to a card payment.');
  // The register line(s) and the one payment they were paid with.
  const regs = await all<{ txId: string; regId: string; head: string; cmpId: string; rgMode: string | null }>(db, `
    SELECT t.id AS txId, r.id AS regId, coalesce(r.paid_with_row_id, r.id) AS head, c.id AS cmpId, c.rg_mode AS rgMode
    FROM transactions t JOIN bill_comparisons c ON c.id = t.comparison_id JOIN register_rows r ON r.id = c.register_row_id
    WHERE t.id IN (${txIds.map(() => '?').join(',')})`, ...txIds);
  if (regs.length !== tx.length) fail(400, 'A bill chosen is not in the register. Correct it on Compare sales.');
  const heads = [...new Set(regs.map((r) => r.head))];
  if (heads.length !== 1) fail(400, 'Choose one bill (or one group of bills paid together) at a time.');
  const members = await all<{ id: string }>(db, 'SELECT id FROM register_rows WHERE id = ? OR paid_with_row_id = ?', heads[0], heads[0]);
  if (members.length !== regs.length) fail(400, 'Choose every bill paid together with this one.');
  const pays = await all<Record<string, unknown> & { id: string; mode: string; amount_paise: number }>(db, 'SELECT * FROM register_payments WHERE register_row_id = ?', heads[0]);
  const total = tx.reduce((s, x) => s + x.amount_paise, 0);
  const pay = pays.length === 1 ? pays[0] : pays.find((p) => p.mode === from && p.amount_paise === total);
  if (!pay || pay.mode !== from) fail(400, 'The register shows more than one payment for this bill. Change it on its register page.');
  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, tx[0].shift_day);
  if (shift?.status !== 'confirmed') fail(400, 'This shift is not confirmed yet: change the payment on its register page.');
  const cash = mode === 'cash' ? await cashAccountId(db, businessId) : null;
  if (mode === 'cash' && !cash) fail(400, 'This business has no cash account.');
  const cmps = await all<Record<string, unknown> & { id: string }>(db, `SELECT * FROM bill_comparisons WHERE id IN (${regs.map(() => '?').join(',')})`, ...regs.map((r) => r.cmpId));

  const statements: D1PreparedStatement[] = [
    stmt(db, 'UPDATE register_payments SET mode = ?, column_label = NULL WHERE id = ?', mode, pay.id),
    ...tx.map((x) => stmt(db, 'UPDATE transactions SET payment_mode = ?, account_id = ?, match_status = ? WHERE id = ? AND match_status IS ?',
      mode, cash, mode === 'card' ? 'awaiting_card_settlement' : mode === 'upi' ? 'awaiting_bank_match' : null, x.id, x.match_status)),
    ...cmps.map((c) => stmt(db, 'UPDATE bill_comparisons SET rg_mode = ? WHERE id = ?', mode, c.id)),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'sale.repaid', 'register_payments', ?, ?, ?, ?)`, businessId, userId, pay.id,
      JSON.stringify({ payment: pay, sales: tx, comparisons: cmps }),
      JSON.stringify({ from, mode, note, shiftDay: tx[0].shift_day, bills: tx.map((x) => x.bill_no), amountPaise: total, transactionIds: txIds }), t),
  ];
  return { statements, bills: tx.map((x) => x.bill_no), amountPaise: total };
}

/** Changes of this kind for a shift that are still in force (not put back). */
export async function repaidFor(db: DB, businessId: string, day: string) {
  return all<{ id: number; after: string; created_at: number }>(db, `SELECT a.id, a.after, a.created_at FROM audit_log a
    WHERE a.business_id = ? AND a.action = 'sale.repaid' AND json_extract(a.after, '$.shiftDay') = ?
      AND NOT EXISTS (SELECT 1 FROM audit_log u WHERE u.business_id = a.business_id AND u.action = 'sale.repay_undone' AND u.row_id = CAST(a.id AS TEXT))
    ORDER BY a.id DESC`, businessId, day);
}

/** Puts a change back from its audit entry, if nothing has moved since (the sales still as it left them). */
export async function undoRepayStatements(db: DB, businessId: string, auditId: number, userId: string, t: number) {
  const a = await one<{ id: number; before: string; after: string }>(db, "SELECT id, before, after FROM audit_log WHERE id = ? AND business_id = ? AND action = 'sale.repaid'", auditId, businessId);
  if (!a) fail(404, 'Not found.');
  if (await one(db, "SELECT 1 AS ok FROM audit_log WHERE business_id = ? AND action = 'sale.repay_undone' AND row_id = ?", businessId, String(auditId))) fail(409, 'This was already put back.');
  const b = JSON.parse(a.before) as { payment: Record<string, unknown>; sales: Record<string, unknown>[]; comparisons: Record<string, unknown>[] };
  const now = await all<{ id: string; matched_bank_row: string | null }>(db, `SELECT id, matched_bank_row FROM transactions WHERE id IN (${b.sales.map(() => '?').join(',')})`, ...b.sales.map((x) => x.id as string));
  if (now.length !== b.sales.length || now.some((x) => x.matched_bank_row)) fail(409, 'These sales have changed since (e.g. matched). Put them back by hand on the register page.');
  return [
    stmt(db, 'UPDATE register_payments SET mode = ?, column_label = ? WHERE id = ?', b.payment.mode as string, (b.payment.column_label as string) ?? null, b.payment.id as string),
    ...b.sales.map((x) => stmt(db, 'UPDATE transactions SET payment_mode = ?, account_id = ?, match_status = ? WHERE id = ?',
      x.payment_mode as string, (x.account_id as string) ?? null, (x.match_status as string) ?? null, x.id as string)),
    ...b.comparisons.map((c) => stmt(db, 'UPDATE bill_comparisons SET rg_mode = ? WHERE id = ?', (c.rg_mode as string) ?? null, c.id as string)),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'sale.repay_undone', 'audit_log', ?, ?, NULL, ?)`, businessId, userId, String(auditId), a.after, t),
  ];
}
