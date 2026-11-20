/**
 * Counted twice (approved 20 Nov 2026). One payment written in two columns of a register line (₹179 Card and ₹179 UPI
 * for a ₹188 bill paid once by card) becomes two sales when the shift is saved; the half that never comes waits for
 * ever. On a saved shift, without reopening it, a person removes that half: its register payment and its sale go, and
 * the line's discount or tip is put back to match the payment left. Every change is recorded in the change log (with
 * no bank credit) and in the audit log, so Undo puts back exactly what was there.
 *
 * Offered only when it is clear: the line has exactly two payments of the same amount in different modes, one of
 * them came (matched to a bank credit or a card machine payment), the other has none, and the software report has
 * the bill in the mode that came.
 */
import type { DB } from './db';
import { all, newId, one, stmt } from './db';
import { fail } from './http';

export interface Twice {
  txId: string; comparisonId: string; billNo: string; day: string; amountPaise: number; mode: string; otherMode: string;
  rowId: string; paymentId: string; billPaise: number; discountPaise: number; tipPaise: number; newDiscountPaise: number; newTipPaise: number;
}

interface TxRow { id: string; comparison_id: string; bill_no: string; shift_day: string; amount_paise: number; payment_mode: string; matched_bank_row: string | null; carded: number }

/** For each sale still waiting, the counted-twice picture when it is one; others are left out. */
export async function twiceFor(db: DB, businessId: string, txIds: string[]): Promise<Map<string, Twice>> {
  const out = new Map<string, Twice>();
  for (let i = 0; i < txIds.length; i += 90) {
    const ids = txIds.slice(i, i + 90);
    const rows = await all<TxRow & { sib_id: string | null; sib_mode: string | null; sib_got: number | null; sw_mode: string | null; row_id: string | null;
      r_amount: number | null; r_disc: number | null; r_tip: number | null; status: string | null }>(db, `
      SELECT t.id, t.comparison_id, t.bill_no, t.shift_day, t.amount_paise, t.payment_mode, t.matched_bank_row,
        EXISTS (SELECT 1 FROM card_matches m WHERE m.transaction_id = t.id) AS carded,
        s.id AS sib_id, s.payment_mode AS sib_mode,
        (s.matched_bank_row IS NOT NULL OR EXISTS (SELECT 1 FROM card_matches m WHERE m.transaction_id = s.id)) AS sib_got,
        c.sw_mode, c.register_row_id AS row_id, r.amount_paise AS r_amount, r.discount_paise AS r_disc, r.tip_paise AS r_tip, sh.status
      FROM transactions t
      JOIN bill_comparisons c ON c.id = t.comparison_id
      JOIN transactions s ON s.comparison_id = t.comparison_id AND s.id <> t.id AND s.type = 'income' AND s.amount_paise = t.amount_paise AND s.payment_mode <> t.payment_mode
      LEFT JOIN register_rows r ON r.id = c.register_row_id
      LEFT JOIN shifts sh ON sh.business_id = t.business_id AND sh.shift_day = t.shift_day
      WHERE t.business_id = ? AND t.type = 'income' AND t.id IN (${ids.map(() => '?').join(',')})`, businessId, ...ids);
    const rowIds = [...new Set(rows.flatMap((x) => (x.row_id ? [x.row_id] : [])))];
    const pays = rowIds.length ? await all<{ id: string; register_row_id: string; mode: string; amount_paise: number }>(db,
      `SELECT id, register_row_id, mode, amount_paise FROM register_payments WHERE register_row_id IN (${rowIds.map(() => '?').join(',')})`, ...rowIds) : [];
    // Two income sales of the comparison only (a third part means something else).
    const parts = await all<{ comparison_id: string; n: number }>(db, `SELECT comparison_id, count(*) AS n FROM transactions WHERE type = 'income'
      AND comparison_id IN (${[...new Set(rows.map((x) => x.comparison_id))].map(() => '?').join(',') || "''"}) GROUP BY comparison_id`, ...new Set(rows.map((x) => x.comparison_id)));
    const nOf = new Map(parts.map((p) => [p.comparison_id, p.n]));
    for (const x of rows) {
      if (x.status !== 'confirmed' || x.matched_bank_row || x.carded || !x.sib_got || !x.row_id || x.r_amount == null) continue;
      if (nOf.get(x.comparison_id) !== 2 || x.sw_mode !== x.sib_mode) continue;
      const ps = pays.filter((p) => p.register_row_id === x.row_id);
      if (ps.length !== 2) continue;
      const mine = ps.find((p) => p.mode === x.payment_mode && p.amount_paise === x.amount_paise);
      const other = ps.find((p) => p !== mine && p.mode === x.sib_mode && p.amount_paise === x.amount_paise);
      if (!mine || !other) continue;
      // The line's bill less discount plus tip was the two payments; after, it is the one left.
      const signed = x.r_amount - other.amount_paise; // positive: discount; negative: tip
      out.set(x.id, { txId: x.id, comparisonId: x.comparison_id, billNo: x.bill_no, day: x.shift_day, amountPaise: x.amount_paise, mode: x.payment_mode, otherMode: x.sib_mode!,
        rowId: x.row_id, paymentId: mine.id, billPaise: x.r_amount, discountPaise: x.r_disc ?? 0, tipPaise: x.r_tip ?? 0,
        newDiscountPaise: Math.max(signed, 0), newTipPaise: Math.max(-signed, 0) });
    }
  }
  return out;
}

const insertRow = (db: DB, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return stmt(db, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c] as never));
};

/** Removes the half counted twice. Returns the audit id (for Undo). */
export async function removeTwice(db: DB, businessId: string, txId: string, reason: string, userId: string) {
  const k = (await twiceFor(db, businessId, [txId])).get(txId);
  if (!k) fail(409, 'This sale is not a payment counted twice (or it has changed). Close it with a reason instead.');
  const [tx, pay, cmp] = await Promise.all([
    one<Record<string, unknown>>(db, 'SELECT * FROM transactions WHERE id = ?', k.txId),
    one<Record<string, unknown>>(db, 'SELECT * FROM register_payments WHERE id = ?', k.paymentId),
    one<Record<string, unknown> & { rg_amount_paise: number | null; rg_mode: string | null }>(db, 'SELECT * FROM bill_comparisons WHERE id = ?', k.comparisonId),
  ]);
  const t = Date.now();
  const note = `Counted twice: ${reason}`;
  const s: D1PreparedStatement[] = [];
  const adj: string[] = [];
  const record = (target: string, id: string, field: string, v: { bp?: number | null; ap?: number | null; json?: unknown }) => {
    const aid = newId();
    adj.push(aid);
    s.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, before_json, note, created_by, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, aid, businessId, target, id, field, v.bp ?? null, v.ap ?? null, v.json === undefined ? null : JSON.stringify(v.json), note, userId, t));
  };
  // The change log first: the register lock allows only recorded changes.
  if (k.newDiscountPaise !== k.discountPaise) record('register_row', k.rowId, 'discount_paise', { bp: k.discountPaise, ap: k.newDiscountPaise });
  if (k.newTipPaise !== k.tipPaise) record('register_row', k.rowId, 'tip_paise', { bp: k.tipPaise, ap: k.newTipPaise });
  record('register_payment', k.paymentId, 'row', { json: pay });
  record('sale_removed', k.txId, 'row', { json: tx });
  record('comparison', k.comparisonId, 'row', { json: cmp });
  s.push(stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ? WHERE id = ?', k.newDiscountPaise, k.newTipPaise, k.rowId));
  s.push(stmt(db, 'DELETE FROM register_payments WHERE id = ?', k.paymentId));
  s.push(stmt(db, 'DELETE FROM transactions WHERE id = ?', k.txId));
  s.push(stmt(db, 'UPDATE bill_comparisons SET rg_amount_paise = ?, rg_mode = ? WHERE id = ?', (cmp?.rg_amount_paise ?? k.amountPaise * 2) - k.amountPaise, k.otherMode, k.comparisonId));
  const after = { day: k.day, billNo: k.billNo, amountPaise: k.amountPaise, mode: k.mode, keptMode: k.otherMode, reason, adjustments: adj };
  s.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, ?, 'sale.counted_twice', 'transactions', ?, ?, ?, ?)`, businessId, userId, k.txId, JSON.stringify({ discountPaise: k.discountPaise, tipPaise: k.tipPaise }), JSON.stringify(after), t));
  await db.batch(s);
  const a = await one<{ id: number }>(db, `SELECT id FROM audit_log WHERE business_id = ? AND action = 'sale.counted_twice' AND row_id = ? ORDER BY id DESC LIMIT 1`, businessId, k.txId);
  return { auditId: a!.id, ...after };
}

/** Puts back a removal: the payment, the sale, the comparison's register figures and the line's discount or tip. */
export async function undoTwice(db: DB, businessId: string, auditId: number, userId: string) {
  const a = await one<{ id: number; row_id: string; after: string }>(db, `SELECT id, row_id, after FROM audit_log WHERE id = ? AND business_id = ? AND action = 'sale.counted_twice'
    AND NOT EXISTS (SELECT 1 FROM audit_log u WHERE u.business_id = audit_log.business_id AND u.action = 'sale.counted_twice_undone' AND u.row_id = CAST(audit_log.id AS TEXT))`, auditId, businessId);
  if (!a) fail(404, 'Nothing to undo.');
  const info = JSON.parse(a.after) as { adjustments: string[] };
  const adj = await all<{ id: string; target: string; target_id: string; field: string; before_paise: number | null; after_paise: number | null; before_json: string | null }>(db,
    `SELECT id, target, target_id, field, before_paise, after_paise, before_json FROM register_bank_adjustments WHERE business_id = ? AND id IN (${info.adjustments.map(() => '?').join(',')})`,
    businessId, ...info.adjustments);
  if (await one(db, 'SELECT 1 FROM transactions WHERE id = ?', a.row_id)) fail(409, 'This sale is back already.');
  const t = Date.now();
  const s: D1PreparedStatement[] = [];
  for (const x of adj) {
    s.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, note, reverses_id, created_by, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'Undo: counted twice', ?, ?, ?)`, newId(), businessId, x.target, x.target_id, x.field, x.after_paise, x.before_paise, x.id, userId, t));
  }
  const row: Record<string, unknown> = {};
  for (const x of adj.filter((y) => y.target === 'register_row')) row[x.field] = x.before_paise;
  if (Object.keys(row).length) {
    const rowId = adj.find((y) => y.target === 'register_row')!.target_id;
    s.push(stmt(db, `UPDATE register_rows SET ${Object.keys(row).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row) as never[], rowId));
  }
  for (const x of adj.filter((y) => y.target === 'register_payment')) s.push(insertRow(db, 'register_payments', JSON.parse(x.before_json!)));
  for (const x of adj.filter((y) => y.target === 'sale_removed')) s.push(insertRow(db, 'transactions', JSON.parse(x.before_json!)));
  for (const x of adj.filter((y) => y.target === 'comparison')) {
    const c = JSON.parse(x.before_json!);
    s.push(stmt(db, 'UPDATE bill_comparisons SET rg_amount_paise = ?, rg_mode = ? WHERE id = ?', c.rg_amount_paise, c.rg_mode, x.target_id));
  }
  s.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, ?, 'sale.counted_twice_undone', 'audit_log', ?, NULL, ?, ?)`, businessId, userId, String(a.id), a.after, t));
  await db.batch(s);
  return { ok: true };
}
