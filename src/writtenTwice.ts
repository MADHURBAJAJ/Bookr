import { all, now, one, stmt, type DB } from './db';

/**
 * Bills written twice on a shift's register pages (approved 23 Nov 2026, from the choices made 30 Oct to 10 Nov).
 * For each bill number on two or more lines of the same shift, one copy is kept: the one paid together with other
 * bills, else a ticked paid one, else the first paid one (earlier page, then earlier line). Another copy is removed by
 * Bookr when:
 * - A: it has no payment and the kept copy is paid, amounts within ₹10 (14 of 14);
 * - B: it pays the same (same modes and rupees) as the kept copy, amounts within ₹10, neither in a group (5 of 5);
 * - B1: it has no payment and the kept copy is in a group, amounts within ₹10 (2 of 2);
 * - C: it is an empty line, ₹0 and no payment, with the bill on another line, no number at all, or a number that is the
 *   end of the bill on the line just above (8 of 8).
 * B2, a copy with its own payment beside a copy in a group, is only offered to a person: the group's payment decides
 * which copy is the duplicate. Ticked lines and lines in a group are never removed; a line a person put back is left.
 */
export type TwinRow = {
  id: string; page: number; lineNo: number; billNo: string; amountPaise: number; discountPaise: number; status: string;
  paidWithRowId: string | null; payments: { mode: string; amountPaise: number }[]; uploadId?: string;
};
export type Rule = 'A' | 'B' | 'B1' | 'C';
export type Removal = { id: string; keepId: string | null; rule: Rule };
export type Offer = { id: string; keepId: string; why: 'covered' | 'not_in_group' };

const NEAR = 1000; // ₹10

export function writtenTwice(rows: TwinRow[], restored: Set<string> = new Set()): { remove: Removal[]; offers: Offer[] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const heads = new Set(rows.map((r) => r.paidWithRowId).filter(Boolean) as string[]);
  const grouped = (r: TwinRow) => !!r.paidWithRowId || heads.has(r.id);
  const paid = (r: TwinRow) => r.payments.reduce((t, p) => t + p.amountPaise, 0);
  const order = (a: TwinRow, b: TwinRow) => a.page - b.page || a.lineNo - b.lineNo;
  const samePays = (a: TwinRow, b: TwinRow) => {
    const k = (r: TwinRow) => r.payments.map((p) => `${p.mode}:${p.amountPaise}`).sort().join(',');
    return k(a) === k(b);
  };
  const removable = (r: TwinRow) => r.status !== 'checked' && !grouped(r) && !restored.has(r.id);
  const remove: Removal[] = [];
  const offers: Offer[] = [];
  const gone = new Set<string>();

  const byBill = new Map<string, TwinRow[]>();
  for (const r of rows) if (r.billNo) byBill.set(r.billNo, [...(byBill.get(r.billNo) ?? []), r]);
  for (const list of byBill.values()) {
    if (list.length < 2 || list.some((r) => restored.has(r.id))) continue;
    const g = list.filter(grouped);
    if (g.length > 1) continue;
    const paidOnes = list.filter((r) => paid(r) > 0).sort((a, b) => Number(b.status === 'checked') - Number(a.status === 'checked') || order(a, b));
    const keep = g[0] ?? paidOnes[0] ?? [...list].sort((a, b) => b.amountPaise - a.amountPaise || order(a, b))[0];
    for (const o of list) {
      if (o === keep) continue;
      const near = Math.abs(o.amountPaise - keep.amountPaise) <= NEAR;
      if (removable(o)) {
        let rule: Rule | null = null;
        if (paid(o) === 0 && o.amountPaise === 0) rule = 'C';
        else if (paid(o) === 0 && grouped(keep) && near) rule = 'B1';
        else if (paid(o) === 0 && paid(keep) > 0 && near) rule = 'A';
        else if (paid(o) > 0 && !grouped(keep) && paid(keep) > 0 && near && samePays(o, keep)) rule = 'B';
        if (rule) { remove.push({ id: o.id, keepId: keep.id, rule }); gone.add(o.id); continue; }
      }
      // B2: the group's payment says which copy is the duplicate. Offered, never done by Bookr.
      if (paid(o) > 0 && grouped(keep) && !grouped(o) && o.status !== 'checked') {
        const head = keep.paidWithRowId ? byId.get(keep.paidWithRowId) : keep;
        if (!head) continue;
        const group = [head, ...rows.filter((m) => m.paidWithRowId === head.id)];
        const billed = group.reduce((t, m) => t + m.amountPaise - m.discountPaise, 0);
        const groupPaid = paid(head);
        const covered = Math.abs(billed - groupPaid) <= NEAR;
        const without = Math.abs(billed - (keep.amountPaise - keep.discountPaise) - groupPaid) <= NEAR;
        if (covered && !without) offers.push({ id: o.id, keepId: keep.id, why: 'covered' });
        else if (without && !covered && keep !== head && keep.status !== 'checked') offers.push({ id: keep.id, keepId: o.id, why: 'not_in_group' });
      }
    }
  }

  // C without a twin: no number at all, or the end of the bill on the line just above ("1310" under 26111310).
  for (const r of rows) {
    if (gone.has(r.id) || !removable(r) || r.amountPaise !== 0 || paid(r) > 0) continue;
    if (r.billNo && (byBill.get(r.billNo)?.length ?? 0) > 1) continue;
    if (!r.billNo.trim()) { remove.push({ id: r.id, keepId: null, rule: 'C' }); continue; }
    const above = rows.find((x) => x.uploadId === r.uploadId && x.page === r.page && x.lineNo === r.lineNo - 1);
    if (above && r.billNo.length >= 3 && above.billNo.length > r.billNo.length && above.billNo.endsWith(r.billNo)) remove.push({ id: r.id, keepId: above.id, rule: 'C' });
  }
  return { remove, offers };
}

/** The shift's register lines as writtenTwice needs them, pages numbered in upload order. */
export async function shiftTwinRows(db: DB, businessId: string, day: string): Promise<{ rows: TwinRow[]; restored: Set<string> }> {
  const [rows, pays, restored, banked] = await Promise.all([
    all<{ id: string; upload_id: string; line_no: number; bill_no: string; amount_paise: number; discount_paise: number; tip_paise: number; status: string; paid_with_row_id: string | null; page: number }>(db, `
      SELECT r.id, r.upload_id, r.line_no, r.bill_no, r.amount_paise, r.discount_paise, r.tip_paise, r.status, r.paid_with_row_id,
        (SELECT count(*) FROM uploads u2 WHERE u2.business_id = u.business_id AND u2.kind = 'bill_register' AND u2.business_day = u.business_day
          AND (u2.created_at < u.created_at OR (u2.created_at = u.created_at AND u2.id <= u.id))) AS page
      FROM register_rows r JOIN uploads u ON u.id = r.upload_id WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
    all<{ register_row_id: string; mode: string; amount_paise: number }>(db, `SELECT p.register_row_id, p.mode, p.amount_paise FROM register_payments p
      JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
    all<{ row_id: string }>(db, `SELECT DISTINCT a.row_id FROM audit_log a JOIN register_rows r ON r.id = a.row_id
      WHERE a.business_id = ? AND a.action = 'register.restore' AND r.shift_day = ?`, businessId, day),
    all<{ target_id: string }>(db, `SELECT DISTINCT a.target_id FROM register_bank_adjustments a JOIN register_rows r ON r.id = a.target_id
      WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
  ]);
  const keep = new Set([...restored.map((x) => x.row_id), ...banked.map((x) => x.target_id)]);
  return {
    rows: rows.map((r) => ({ id: r.id, uploadId: r.upload_id, page: r.page, lineNo: r.line_no, billNo: (r.bill_no ?? '').trim(), amountPaise: r.amount_paise,
      discountPaise: r.discount_paise - r.tip_paise, status: r.status, paidWithRowId: r.paid_with_row_id,
      payments: pays.filter((p) => p.register_row_id === r.id).map((p) => ({ mode: p.mode, amountPaise: p.amount_paise })) })),
    restored: keep,
  };
}

const WHY: Record<Rule, string> = {
  A: 'paid on the other copy; this one had no payment',
  B: 'same payment as the other copy',
  B1: 'paid together with other bills on the other copy',
  C: 'empty line',
};

/** Removes the copies writtenTwice finds, as Bookr, each with everything needed to put it back. Returns how many. */
export async function removeWrittenTwice(db: DB, businessId: string, day: string): Promise<number> {
  if (await one(db, "SELECT 1 AS ok FROM shifts WHERE business_id = ? AND shift_day = ? AND status = 'confirmed'", businessId, day)) return 0;
  const { rows, restored } = await shiftTwinRows(db, businessId, day);
  const { remove } = writtenTwice(rows, restored);
  if (!remove.length) return 0;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const t = now();
  const statements: D1PreparedStatement[] = [];
  for (const x of remove) {
    const full = await one<Record<string, unknown>>(db, "SELECT * FROM register_rows WHERE id = ? AND business_id = ? AND status = 'draft'", x.id, businessId);
    if (!full) continue;
    const pays = await all<Record<string, unknown>>(db, 'SELECT * FROM register_payments WHERE register_row_id = ?', x.id);
    const k = x.keepId ? byId.get(x.keepId) : null;
    const where = k ? `page ${k.page} line ${k.lineNo}` : null;
    statements.push(
      stmt(db, "DELETE FROM register_rows WHERE id = ? AND business_id = ? AND status = 'draft'", x.id, businessId),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, NULL, 'register.delete', 'register_rows', ?, ?, ?, ?)`, businessId, x.id,
        JSON.stringify({ uploadId: full.upload_id, lineNo: full.line_no, billNo: full.bill_no, amountPaise: full.amount_paise, discountPaise: full.discount_paise,
          payments: pays.map((p) => ({ mode: p.mode, columnLabel: p.column_label, amountPaise: p.amount_paise })) }),
        JSON.stringify({ reason: 'written_twice', note: `Bookr: ${WHY[x.rule]}${where ? `, kept on ${where}` : ''}`, auto: true, rule: x.rule, keptRowId: x.keepId, row: full, pays }), t),
    );
  }
  if (!statements.length) return 0;
  const res = await db.batch(statements);
  return res.filter((_, i) => i % 2 === 0).filter((r) => (r.meta?.changes ?? 0) > 0).length;
}

const COLUMN = /^[a-z_]+$/;

/** Puts back a line Bookr removed as written twice. Returns the shift day, or null when there is nothing to put back. */
export async function restoreRemoved(db: DB, businessId: string, rowId: string, userId: string): Promise<string | null> {
  if (await one(db, 'SELECT 1 AS ok FROM register_rows WHERE id = ?', rowId)) return null;
  const a = await one<{ after: string }>(db, `SELECT after FROM audit_log WHERE business_id = ? AND action = 'register.delete' AND row_id = ?
    AND json_extract(after, '$.auto') = 1 ORDER BY id DESC LIMIT 1`, businessId, rowId);
  if (!a) return null;
  const after = JSON.parse(a.after) as { row: Record<string, unknown>; pays: Record<string, unknown>[] };
  const row = after.row;
  if (!row || row.business_id !== businessId) return null;
  const insert = (table: string, o: Record<string, unknown>) => {
    const cols = Object.keys(o).filter((c) => COLUMN.test(c));
    return stmt(db, `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => o[c] as never));
  };
  await db.batch([
    insert('register_rows', row),
    ...(after.pays ?? []).map((p) => insert('register_payments', p)),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'register.restore', 'register_rows', ?, NULL, ?, ?)`, businessId, userId, rowId, JSON.stringify({ billNo: row.bill_no, why: 'Put back: not written twice' }), now()),
  ]);
  return String(row.shift_day);
}
