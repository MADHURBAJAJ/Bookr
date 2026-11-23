/**
 * Paid now, on a saved day (approved 23 Nov 2026). A bill written as UPI on its own day, cash in the software, whose
 * cash came on a later day that was saved with that line counted as a new cash sale (26103168: ₹210 on 3 Nov). The
 * later day often cannot be reopened (its UPI sales are matched to the bank), so, as for "Counted twice", the later
 * day stays saved: its extra sale goes and the line is left out, both recorded in the change log; the cash is counted
 * in that day's drawer for the earlier bill (cash.paid_late). Undo puts back exactly what was there.
 */
import type { DB } from './db';
import { all, newId, one, stmt } from './db';
import { fail } from './http';

const insertRow = (db: DB, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return stmt(db, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c] as never));
};

export async function settleSaved(db: DB, businessId: string, x: { rowId: string; comparisonId: string; homeComparisonId: string; billNo: string; day: string;
  homeDay: string; homeRowId: string; cashPaise: number; swAmountPaise: number }, userId: string) {
  const cmp = await one<{ decision: string | null; note: string | null }>(db, 'SELECT decision, note FROM bill_comparisons WHERE id = ?', x.comparisonId);
  const sales = await all<Record<string, unknown> & { id: string; matched_bank_row: string | null; payment_mode: string }>(db,
    "SELECT * FROM transactions WHERE business_id = ? AND comparison_id = ? AND type = 'income'", businessId, x.comparisonId);
  if (sales.some((s) => s.matched_bank_row || s.payment_mode !== 'cash')) fail(409, `Bill ${x.billNo} on ${x.day} is matched to the bank or is not cash: change it on its Reconcile instead.`);
  const t = Date.now();
  const note = `Paid now: ${x.homeDay} bill ${x.billNo}`;
  const s: D1PreparedStatement[] = [];
  const adj: string[] = [];
  const record = (target: string, id: string, field: string, v: { bt?: string | null; at?: string | null; json?: unknown }) => {
    const aid = newId();
    adj.push(aid);
    s.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_text, after_text, before_json, note, created_by, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, aid, businessId, target, id, field, v.bt ?? null, v.at ?? null, v.json === undefined ? null : JSON.stringify(v.json), note, userId, t));
  };
  // The change log first: the saved-day locks allow only recorded changes.
  for (const sale of sales) record('sale_removed', sale.id, 'row', { json: sale });
  record('comparison', x.comparisonId, 'decision', { bt: cmp?.decision ?? null, at: 'leave_out', json: { note: cmp?.note ?? null } });
  for (const sale of sales) s.push(stmt(db, 'DELETE FROM transactions WHERE id = ?', sale.id));
  s.push(stmt(db, 'UPDATE bill_comparisons SET decision = ?, note = ? WHERE id = ?', 'leave_out', note, x.comparisonId));
  s.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, ?, 'cash.paid_late', 'bill_comparisons', ?, NULL, ?, ?)`, businessId, userId, x.comparisonId,
    JSON.stringify({ day: x.day, fromDay: x.homeDay, comparisonId: x.comparisonId, linkedId: x.homeComparisonId, billNo: x.billNo, amountPaise: x.cashPaise, swAmountPaise: x.swAmountPaise, twoDays: true }), t));
  s.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, ?, 'register.two_days', 'register_rows', ?, '{}', ?, ?)`, businessId, userId, x.rowId,
    JSON.stringify({ action: 'settle', savedDay: true, billNo: x.billNo, day: x.day, homeDay: x.homeDay, hereComparisonId: x.comparisonId, homeRowId: x.homeRowId,
      removedPaise: sales.reduce((n, y) => n + Number(y.amount_paise), 0), adjustments: adj }), t));
  await db.batch(s);
}

export async function undoSettleSaved(db: DB, businessId: string, rowId: string, auditAfter: string, userId: string) {
  const info = JSON.parse(auditAfter) as { hereComparisonId: string; adjustments: string[] };
  const adj = await all<{ id: string; target: string; target_id: string; field: string; before_text: string | null; after_text: string | null; before_json: string | null }>(db,
    `SELECT id, target, target_id, field, before_text, after_text, before_json FROM register_bank_adjustments WHERE business_id = ? AND id IN (${info.adjustments.map(() => '?').join(',')})`,
    businessId, ...info.adjustments);
  const t = Date.now();
  const s: D1PreparedStatement[] = [];
  for (const x of adj) {
    s.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_text, after_text, note, reverses_id, created_by, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'Undo: paid now', ?, ?, ?)`, newId(), businessId, x.target, x.target_id, x.field, x.after_text, x.before_text, x.id, userId, t));
  }
  for (const x of adj.filter((y) => y.target === 'sale_removed')) s.push(insertRow(db, 'transactions', JSON.parse(x.before_json!)));
  for (const x of adj.filter((y) => y.target === 'comparison')) {
    s.push(stmt(db, 'UPDATE bill_comparisons SET decision = ?, note = ? WHERE id = ?', x.before_text, (JSON.parse(x.before_json ?? '{}') as { note?: string | null }).note ?? null, x.target_id));
  }
  const cash = await one<{ id: number }>(db, `SELECT id FROM audit_log WHERE business_id = ? AND action = 'cash.paid_late' AND row_id = ? AND json_extract(after, '$.twoDays') = 1
    AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.business_id = audit_log.business_id AND x.action = 'cash.paid_late_undone' AND x.row_id = CAST(audit_log.id AS TEXT)) ORDER BY id DESC LIMIT 1`,
    businessId, info.hereComparisonId);
  if (cash) s.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, ?, 'cash.paid_late_undone', 'audit_log', ?, NULL, NULL, ?)`, businessId, userId, String(cash.id), t));
  s.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, ?, 'register.two_days_undone', 'register_rows', ?, NULL, ?, ?)`, businessId, userId, rowId, auditAfter, t));
  await db.batch(s);
}
