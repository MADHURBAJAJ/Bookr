import { all, now, stmt, type DB } from './db';
import { shiftView } from './sales';

/**
 * Ticked by Bookr (approved 22 Nov 2026). A register line is ticked as checked when three things agree, so a person
 * looks only at the rest:
 * - the register and the software have the bill in the same mode (cash, UPI or card), on this shift, not paid together
 *   with another line, and its number raises nothing;
 * - the line pays exactly what it says;
 * - for UPI or card, a bank credit or card machine payment equals the register's amount, and the software is at most
 *   ₹50 away (more than that is a discount someone has to explain); for cash, the software is at most ₹5 away (rounding).
 * A line a person has unticked is never ticked again by Bookr, nor one whose number Bookr completed (23 Nov 2026). Nothing on a saved shift changes.
 */
export const UPI_GAP_PAISE = 5000;
export const CASH_GAP_PAISE = 500;

export type TickReason = { rowId: string; billNo: string; mode: string; amountPaise: number; softwarePaise: number; creditAt: number | null };

export async function linesToTick(db: DB, businessId: string, day: string): Promise<TickReason[]> {
  const v = await shiftView(db, businessId, day);
  if (v.status === 'confirmed') return [];
  const repeated = new Set(v.repeatedLines.flatMap((g) => g.lines.map((l) => l.rowId)));
  const unbalanced = new Set(v.unbalancedRows.map((r) => r.rowId));
  const out: TickReason[] = [];
  for (const c of v.comparisons) {
    const rg = c.register;
    const sw = c.software;
    if (!rg || !sw || rg.reviewed || !rg.rowId || c.difference !== 'match') continue;
    if (c.otherDay || c.linkedToId || c.groupId || c.numberFlags.length || c.oldPos || !rg.billType) continue;
    if (repeated.has(rg.rowId) || unbalanced.has(rg.rowId)) continue;
    const mode = rg.mode;
    if (!mode || mode !== sw.mode || !['cash', 'upi', 'card'].includes(mode)) continue;
    const amount = rg.amountPaise ?? 0;
    if (amount <= 0 || rg.paidPaise !== amount || sw.amountPaise == null) continue;
    const gap = Math.abs(sw.amountPaise - amount);
    let creditAt: number | null = null;
    if (mode === 'cash') {
      if (gap > CASH_GAP_PAISE) continue;
    } else {
      if (gap > UPI_GAP_PAISE) continue;
      const b = c.bank;
      const m = c.machine;
      if (b && !b.bothSides && !b.parts && b.amountPaise === amount && (b.fits === 'register' || b.fits === 'both')) creditAt = b.postedAt;
      else if (m && m.amountPaise === amount) creditAt = m.paidAt;
      else continue;
    }
    out.push({ rowId: rg.rowId, billNo: c.billNo, mode, amountPaise: amount, softwarePaise: sw.amountPaise, creditAt });
  }
  if (!out.length) return out;
  // A person unticked it: theirs from then on.
  const ids = out.map((x) => x.rowId);
  const untouchable = new Set<string>();
  // A number Bookr completed, a payment it took off, or a line crossed out on the page: a person checks it first.
  (await all<{ id: string }>(db, `SELECT id FROM register_rows WHERE business_id = ? AND shift_day = ? AND status = 'draft'
    AND (json_extract(ocr_original, '$.completedFrom') IS NOT NULL OR json_extract(ocr_original, '$.struck') = 1 OR json_extract(ocr_original, '$.dropped') IS NOT NULL)`,
    businessId, day)).forEach((r) => untouchable.add(r.id));
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const rows = await all<{ rowId: string }>(db, `SELECT DISTINCT row_id AS rowId FROM audit_log
      WHERE business_id = ? AND row_table = 'register_rows' AND action = 'register.edit'
        AND json_extract(before, '$.status') = 'checked' AND json_extract(after, '$.status') <> 'checked'
        AND row_id IN (${part.map(() => '?').join(',')})`, businessId, ...part);
    rows.forEach((r) => untouchable.add(r.rowId));
  }
  return out.filter((x) => !untouchable.has(x.rowId));
}

export async function autoTick(db: DB, businessId: string, day: string): Promise<number> {
  const lines = await linesToTick(db, businessId, day);
  if (!lines.length) return 0;
  const at = now();
  const res = await db.batch(lines.flatMap((x) => [
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      SELECT ?, NULL, 'register.auto_check', 'register_rows', id, ?, ?, ? FROM register_rows
      WHERE id = ? AND business_id = ? AND status = 'draft'`, businessId, JSON.stringify({ status: 'draft', billNo: x.billNo }),
      JSON.stringify({ status: 'checked', billNo: x.billNo, mode: x.mode, amountPaise: x.amountPaise, softwarePaise: x.softwarePaise, creditAt: x.creditAt }), at, x.rowId, businessId),
    stmt(db, "UPDATE register_rows SET status = 'checked' WHERE id = ? AND business_id = ? AND status = 'draft'", x.rowId, businessId),
  ]));
  return res.filter((_, i) => i % 2 === 1).reduce((t, r) => t + (r.meta?.changes ?? 0), 0);
}
