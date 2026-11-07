// "Fix the bill" from a bank credit (approved 2 Nov 2026). On a confirmed shift, the register line a credit pays can
// be corrected: bill number, bill amount, discount/tip and its UPI payment. When the corrected number is a bill that
// is only in the software report, the two halves become one bill: the register's sale stays (re-pointed to the
// software bill), the software-only duplicate sale is removed. Every change is recorded in register_bank_adjustments
// (with whole rows where something is removed), so Unmatch can put everything back.

import { all, newId, one, stmt, type DB } from './db';
import { fail } from './http';
import type { BankRow } from './bank';

export interface FixInput { registerRowId: string; billNo: string; amountPaise: number; discountPaise: number; note: string }

export async function fixBillStatements(db: DB, businessId: string, credit: BankRow, input: FixInput, userId: string, t: number) {
  const r = await one<{ id: string; bill_no: string; amount_paise: number; discount_paise: number; tip_paise: number; shift_day: string; paid_with_row_id: string | null }>(db,
    'SELECT id, bill_no, amount_paise, discount_paise, tip_paise, shift_day, paid_with_row_id FROM register_rows WHERE id = ? AND business_id = ?', input.registerRowId, businessId);
  if (!r) fail(404, 'That register line was not found.');
  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, r.shift_day);
  if (shift?.status !== 'confirmed') fail(400, 'This shift is not confirmed yet: correct the bill on its register page.');
  if (r.paid_with_row_id || (await one(db, 'SELECT 1 AS ok FROM register_rows WHERE paid_with_row_id = ?', r.id))) {
    fail(400, 'This bill is paid together with other bills. Use Match by hand for the group.');
  }
  const pays = await all<{ id: string; mode: string; amount_paise: number }>(db, 'SELECT id, mode, amount_paise FROM register_payments WHERE register_row_id = ?', r.id);
  if (pays.length !== 1 || pays[0].mode !== 'upi') fail(400, 'Fix the bill works for a bill paid by one UPI payment. Use Match by hand for this one.');
  const cr = await one<Record<string, unknown> & { id: string; pos_no: string; bill_no: string }>(db,
    'SELECT * FROM bill_comparisons WHERE business_id = ? AND register_row_id = ?', businessId, r.id);
  if (!cr) fail(400, 'This register line has no comparison. Correct it on its register page.');
  const tr = await all<Record<string, unknown> & { id: string; amount_paise: number; match_status: string | null; matched_bank_row: string | null; payment_mode: string }>(db,
    "SELECT * FROM transactions WHERE comparison_id = ? AND type = 'income'", cr.id);
  if (tr.length !== 1 || tr[0].payment_mode !== 'upi') fail(400, 'This bill was counted in more than one part. Use Match by hand.');
  if (tr[0].matched_bank_row || tr[0].match_status !== 'awaiting_bank_match') fail(409, 'This bill is already matched to a bank credit.');

  const billNo = input.billNo.trim();
  if (!billNo) fail(400, 'Give the bill number.');
  const pay = credit.amount_paise;
  const signed = input.discountPaise; // positive: discount, negative: tip
  if (input.amountPaise <= 0) fail(400, 'Give the bill amount.');
  if (input.amountPaise - signed !== pay) {
    fail(400, `Bill amount less discount (or plus tip) must equal the ₹${(pay / 100).toFixed(2)} received. It comes to ₹${((input.amountPaise - signed) / 100).toFixed(2)}.`);
  }
  if (signed > input.amountPaise) fail(400, 'The discount is more than the bill.');

  const statements: D1PreparedStatement[] = [];
  const changed: string[] = [];
  const record = (target: string, id: string, field: string, v: { bp?: number | null; ap?: number | null; bt?: string | null; at?: string | null; json?: unknown }) =>
    statements.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, before_text, after_text, before_json, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), businessId, credit.id, target, id, field, v.bp ?? null, v.ap ?? null, v.bt ?? null, v.at ?? null,
      v.json === undefined ? null : JSON.stringify(v.json), input.note, userId, t));

  // The software-only half with the corrected number, if there is one: the two halves are joined.
  let cs: (Record<string, unknown> & { id: string; sw_amount_paise: number; sw_mode: string; decision: string | null; difference: string; register_row_id: string | null }) | null = null;
  let ts: (Record<string, unknown> & { id: string; matched_bank_row: string | null })[] = [];
  if (billNo !== r.bill_no) {
    cs = await one(db, 'SELECT * FROM bill_comparisons WHERE business_id = ? AND shift_day = ? AND bill_no = ? AND id <> ?', businessId, r.shift_day, billNo, cr.id);
    if (cs && (cs.register_row_id || cs.difference !== 'missing_in_register')) fail(400, `Bill ${billNo} is already in the register for this shift.`);
    if (cs) {
      ts = await all(db, "SELECT * FROM transactions WHERE comparison_id = ? AND type = 'income'", cs.id);
      if (ts.some((x) => x.matched_bank_row)) fail(409, `Bill ${billNo}'s software sale is already matched to a bank credit. Unmatch it first.`);
    }
  }

  // Register line: bill number, amount, discount/tip, payment.
  const disc = Math.max(signed, 0);
  const tip = Math.max(-signed, 0);
  if (billNo !== r.bill_no) { record('register_row', r.id, 'bill_no', { bt: r.bill_no, at: billNo }); changed.push(`bill ${r.bill_no} → ${billNo}`); }
  if (input.amountPaise !== r.amount_paise) { record('register_row', r.id, 'amount_paise', { bp: r.amount_paise, ap: input.amountPaise }); changed.push('bill amount'); }
  if (disc !== r.discount_paise) record('register_row', r.id, 'discount_paise', { bp: r.discount_paise, ap: disc });
  if (tip !== r.tip_paise) record('register_row', r.id, 'tip_paise', { bp: r.tip_paise, ap: tip });
  if (disc !== r.discount_paise || tip !== r.tip_paise) changed.push(signed >= 0 ? `discount ₹${(disc / 100).toFixed(2)}` : `tip ₹${(tip / 100).toFixed(2)}`);
  statements.push(stmt(db, 'UPDATE register_rows SET bill_no = ?, amount_paise = ?, discount_paise = ?, tip_paise = ? WHERE id = ?', billNo, input.amountPaise, disc, tip, r.id));
  if (pays[0].amount_paise !== pay) {
    record('register_payment', pays[0].id, 'amount_paise', { bp: pays[0].amount_paise, ap: pay });
    statements.push(stmt(db, 'UPDATE register_payments SET amount_paise = ? WHERE id = ?', pay, pays[0].id));
    changed.push('payment');
  }

  if (cs) {
    // Join: the register's sale moves to the software bill; the software-only sale and the register-only comparison go.
    record('transaction', tr[0].id, 'row', { json: tr[0] });
    statements.push(stmt(db, 'UPDATE transactions SET comparison_id = ?, bill_no = ?, pos_no = ?, amount_paise = ? WHERE id = ?', cs.id, billNo, cs.pos_no ?? null, pay, tr[0].id));
    for (const x of ts) { record('sale_removed', x.id, 'row', { json: x }); statements.push(stmt(db, 'DELETE FROM transactions WHERE id = ?', x.id)); }
    const amountDiffers = cs.sw_amount_paise !== pay;
    const modeDiffers = cs.sw_mode !== 'upi';
    const difference = amountDiffers && modeDiffers ? 'amount_and_mode' : amountDiffers ? 'amount' : modeDiffers ? 'mode' : 'match';
    const decision = difference === 'match' ? null : 'use_register';
    record('comparison', cs.id, 'row', { json: cs });
    record('comparison', cs.id, 'decision', { bt: cs.decision, at: decision }); // always: the lock checks it
    statements.push(stmt(db, `UPDATE bill_comparisons SET register_row_id = ?, rg_amount_paise = ?, rg_mode = 'upi', difference = ?, decision = ?, decided_by = ?, decided_at = ?,
      note = ? WHERE id = ?`, r.id, pay, difference, decision, userId, t, `Joined from bank: ${input.note}`, cs.id));
    record('comparison_removed', cr.id, 'row', { json: cr });
    statements.push(stmt(db, 'DELETE FROM bill_comparisons WHERE id = ?', cr.id));
    changed.push(`joined with the software bill${ts.length ? ` (its duplicate sale of ₹${(ts.reduce((s, x) => s + (x.amount_paise as number), 0) / 100).toFixed(2)} removed)` : ''}`);
  } else {
    record('transaction', tr[0].id, 'row', { json: tr[0] });
    statements.push(stmt(db, 'UPDATE transactions SET bill_no = ?, amount_paise = ? WHERE id = ?', billNo, pay, tr[0].id));
    if (billNo !== r.bill_no) {
      record('comparison', cr.id, 'bill_no', { bt: cr.bill_no, at: billNo });
      statements.push(stmt(db, 'UPDATE bill_comparisons SET bill_no = ?, rg_amount_paise = ? WHERE id = ?', billNo, pay, cr.id));
    }
  }
  return { statements, transactionId: tr[0].id, changed };
}

const insertRow = (db: DB, table: 'transactions' | 'bill_comparisons', row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return stmt(db, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c] as never));
};

interface Adj { id: string; target: string; target_id: string; field: string; before_paise: number | null; after_paise: number | null; before_text: string | null; after_text: string | null; before_json: string | null; bank_row_id: string }

/** Puts back every change made for these credits (bank adjustments and bill fixes), recording the reverse of each. */
export async function undoAll(db: DB, businessId: string, bankRowIds: string[], userId: string, t: number) {
  if (!bankRowIds.length) return [];
  const open = await all<Adj>(db, `SELECT a.* FROM register_bank_adjustments a WHERE a.business_id = ? AND a.bank_row_id IN (${bankRowIds.map(() => '?').join(',')})
      AND a.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM register_bank_adjustments r WHERE r.reverses_id = a.id) ORDER BY a.created_at DESC`, businessId, ...bankRowIds);
  if (!open.length) return [];
  const s: D1PreparedStatement[] = [];
  // 1. The reverse of each change, recorded first (the locks check these).
  for (const a of open) {
    s.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, before_text, after_text, note, reverses_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Unmatched', ?, ?, ?)`, newId(), businessId, a.bank_row_id, a.target, a.target_id, a.field, a.after_paise, a.before_paise, a.after_text, a.before_text, a.id, userId, t));
  }
  const of = (target: string, field?: string) => open.filter((a) => a.target === target && (!field || a.field === field));
  // 2. Removed comparisons and sales come back; moved sales go back.
  for (const a of of('comparison_removed')) s.push(insertRow(db, 'bill_comparisons', JSON.parse(a.before_json!)));
  // A sale or register payment added by a correction (see slips.ts) goes; its bank match goes with it.
  for (const a of open.filter((x) => x.after_text === 'added')) {
    s.push(stmt(db, a.target === 'transaction' ? 'DELETE FROM transactions WHERE id = ?' : 'DELETE FROM register_payments WHERE id = ?', a.target_id));
  }
  for (const a of of('transaction', 'row').filter((x) => x.after_text !== 'added')) {
    const x = JSON.parse(a.before_json!);
    s.push(stmt(db, 'UPDATE transactions SET comparison_id = ?, bill_no = ?, pos_no = ?, amount_paise = ? WHERE id = ?', x.comparison_id, x.bill_no, x.pos_no, x.amount_paise, a.target_id));
  }
  for (const a of of('transaction', 'amount_paise')) s.push(stmt(db, 'UPDATE transactions SET amount_paise = ? WHERE id = ?', a.before_paise, a.target_id));
  for (const a of of('sale_removed')) s.push(insertRow(db, 'transactions', JSON.parse(a.before_json!)));
  // 3. Comparisons: the joined one goes back to software-only (row and decision in one step); a renamed one gets its number back.
  for (const a of of('comparison', 'row')) {
    const x = JSON.parse(a.before_json!);
    s.push(stmt(db, `UPDATE bill_comparisons SET register_row_id = ?, rg_amount_paise = ?, rg_mode = ?, difference = ?, decision = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?`,
      x.register_row_id, x.rg_amount_paise, x.rg_mode, x.difference, x.decision, x.decided_by, x.decided_at, x.note, a.target_id));
  }
  for (const a of of('comparison', 'bill_no')) s.push(stmt(db, 'UPDATE bill_comparisons SET bill_no = ? WHERE id = ?', a.before_text, a.target_id));
  // 4. Register lines: all their fields back in one step; then payments.
  const rows = new Map<string, Record<string, unknown>>();
  for (const a of of('register_row')) {
    const r = rows.get(a.target_id) ?? {};
    r[a.field] = a.field === 'bill_no' ? a.before_text : a.before_paise;
    rows.set(a.target_id, r);
  }
  for (const [id, r] of rows) {
    const cols = Object.keys(r);
    s.push(stmt(db, `UPDATE register_rows SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => r[c] as never), id));
  }
  for (const a of of('register_payment', 'amount_paise')) s.push(stmt(db, 'UPDATE register_payments SET amount_paise = ? WHERE id = ?', a.before_paise, a.target_id));
  return s;
}
