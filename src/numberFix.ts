import { all, newId, now, stmt, type DB } from './db';
import { addDays } from './time';
import { parsePaise } from './money';
import { completeBillNo, dateFormNumber, IMPOSSIBLE_TIMES, splitPaymentCell } from './ocr';

/**
 * What a bill number read off a page is checked against: the shift's software bills (one amount per number), the
 * numbers already on register lines of the shift (other pages, or all of them), and the previous shift's software bills
 * still missing on the register anywhere (a room bill paid on the next shift's page).
 */
export async function numberContext(db: DB, businessId: string, day: string, exceptUpload?: string) {
  const [sw, taken, prev] = await Promise.all([
    all<{ bill_no: string; amount_paise: number }>(db,
      'SELECT bill_no, max(amount_paise) AS amount_paise FROM software_bills WHERE business_id = ? AND shift_day = ? GROUP BY bill_no', businessId, day),
    all<{ bill_no: string }>(db, `SELECT DISTINCT bill_no FROM register_rows WHERE business_id = ? AND shift_day = ?${exceptUpload ? ' AND upload_id <> ?' : ''}`,
      ...[businessId, day, ...(exceptUpload ? [exceptUpload] : [])]),
    all<{ bill_no: string; amount_paise: number }>(db, `SELECT s.bill_no, max(s.amount_paise) AS amount_paise FROM software_bills s
      WHERE s.business_id = ? AND s.shift_day = ? AND NOT EXISTS (SELECT 1 FROM register_rows r WHERE r.business_id = s.business_id AND r.bill_no = s.bill_no)
      GROUP BY s.bill_no`, businessId, addDays(day, -1)),
  ]);
  return {
    softwareBills: sw.map((b) => b.bill_no),
    softwareAmounts: Object.fromEntries(sw.map((b) => [b.bill_no, b.amount_paise])) as Record<string, number>,
    takenBills: taken.map((b) => b.bill_no),
    previousBills: Object.fromEntries(prev.map((b) => [b.bill_no, b.amount_paise])) as Record<string, number>,
    day,
  };
}

type Row = { id: string; bill_no: string; amount_paise: number; discount_paise: number; tip_paise: number; status: string; ocr_original: string | null; upload_id: string };
type Pay = { id: string; register_row_id: string; mode: string; column_label: string | null; amount_paise: number };

/**
 * The page re-check (approved 22 and 23 Nov 2026), run when a page is opened and when a software report comes in, on
 * draft lines Claude read that no person has edited:
 * - bill numbers not in the software report are completed to the one bill they stand for (completeBillNo), and a number
 *   Bookr completed earlier under the old, looser rule is redone (back to the number as read when nothing fits now);
 * - payment cells read before notes were split ("2900 paid", "4ok") get their payment;
 * - a payment far larger than the bill ("100815" on ₹2,700) is taken off, with any discount or tip worked out from it.
 * Everything changed is amber and stays unticked; each change is in the Changes tab as Bookr's.
 */
export async function recheckDay(db: DB, businessId: string, day: string): Promise<number> {
  if ((await all(db, "SELECT 1 FROM shifts WHERE business_id = ? AND shift_day = ? AND status = 'confirmed'", businessId, day)).length) return 0;
  const ctx = await numberContext(db, businessId, day);
  const [rows, pays, edited] = await Promise.all([
    all<Row>(db, `SELECT id, bill_no, amount_paise, discount_paise, tip_paise, status, ocr_original, upload_id FROM register_rows
      WHERE business_id = ? AND shift_day = ? AND status = 'draft' AND ocr_original IS NOT NULL`, businessId, day),
    all<Pay>(db, `SELECT p.id, p.register_row_id, p.mode, p.column_label, p.amount_paise FROM register_payments p
      JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
    all<{ row_id: string }>(db, `SELECT DISTINCT a.row_id FROM audit_log a JOIN register_rows r ON r.id = a.row_id
      WHERE a.business_id = ? AND a.row_table = 'register_rows' AND r.shift_day = ? AND a.action IN ('register.edit', 'register.move_column', 'register.shift_payments', 'register.fill_discounts', 'register.split', 'register.column_changed', 'register.insert_below', 'register.paid_later')`, businessId, day),
  ]);
  if (!rows.length) return 0;
  const personal = new Set(edited.map((e) => e.row_id));
  const software = new Map(ctx.softwareBills.map((b) => [b, ctx.softwareAmounts[b]]));
  const previous = new Map(Object.entries(ctx.previousBills));
  const allBills = await all<{ bill_no: string }>(db, 'SELECT bill_no FROM register_rows WHERE business_id = ? AND shift_day = ?', businessId, day);
  const used = new Set(allBills.map((b) => b.bill_no));
  const t = now();
  const statements: D1PreparedStatement[] = [];
  let changed = 0;

  for (const r of rows) {
    if (personal.has(r.id)) continue;
    let o: Record<string, any>;
    try { o = JSON.parse(r.ocr_original!); } catch { continue; }
    if (o.engine !== 'claude_vision' || !o.read) continue;
    const mine = pays.filter((p) => p.register_row_id === r.id);
    const paid = mine.reduce((s, p) => s + p.amount_paise, 0);
    const before = { billNo: r.bill_no, payments: mine.map((p) => ({ column: p.column_label, amountPaise: p.amount_paise })), discountPaise: r.discount_paise, tipPaise: r.tip_paise };
    let billNo = r.bill_no;
    const inferred = new Set<string>(o.inferred ?? []);
    const unclear = new Set<string>(o.unclear ?? []);
    let touched = false;

    // Bill number: only the number as Claude read it, or as Bookr completed it.
    const read = typeof o.read.bill_no === 'string' ? o.read.bill_no.replace(/\s+/g, '') : '';
    const asRead = read && r.bill_no === read && !o.completedFrom;
    const asCompleted = o.completedFrom && r.bill_no !== o.completedFrom;
    if (read && (asRead || asCompleted) && !(asRead && software.has(r.bill_no))) {
      const from = o.completedFrom ?? read;
      if (asCompleted) used.delete(r.bill_no);
      const hit = completeBillNo(from, [r.amount_paise, paid], software, used, previous);
      let to: string | null = hit && hit !== 'several' ? hit.billNo : null;
      if (!to) to = dateFormNumber(from, day);
      if (!to && asCompleted) to = from; // the old completion no longer fits: back to the number as read
      if (to && to !== r.bill_no) {
        billNo = to;
        touched = true;
        if (to === from) { delete o.completedFrom; inferred.delete('bill_no'); unclear.add('bill_no'); }
        else {
          o.completedFrom = from; inferred.add('bill_no');
          if (hit && hit !== 'several' && hit.billNo === to) unclear.delete('bill_no'); else unclear.add('bill_no');
        }
      }
      used.add(billNo);
    }

    // Payments: cells with words read before 22 Nov, and payments far larger than the bill.
    const newPays: { mode: string; column: string; paise: number }[] = [];
    const dropIds: string[] = [];
    if (!o.repaid) {
      const notes: string[] = [...(o.read.payment_notes ?? [])];
      for (const p of (o.read.payments ?? []) as { column: string; mode: string; amount: string | null }[]) {
        if (!p.amount || parsePaise(p.amount) !== null) continue;
        if (mine.some((m) => (m.column_label ?? '').toLowerCase() === p.column.toLowerCase())) continue;
        const cut = splitPaymentCell(p.amount, o.read.amount ?? null);
        const paise = cut.amount ? parsePaise(cut.amount) : null;
        if (paise) { newPays.push({ mode: p.mode, column: p.column, paise }); notes.push(cut.note ?? p.amount); }
      }
      if (newPays.length) { o.repaid = true; o.read = { ...o.read, payment_notes: notes }; inferred.add('payments'); touched = true; }
    }
    if (r.amount_paise > 0) {
      const big = mine.filter((p) => p.amount_paise > IMPOSSIBLE_TIMES * r.amount_paise);
      if (big.length) {
        dropIds.push(...big.map((p) => p.id));
        o.dropped = [...(o.dropped ?? []), ...big.map((p) => ({ column: p.column_label ?? p.mode, paise: p.amount_paise }))];
        unclear.add('payments');
        touched = true;
      }
    }
    if (!touched) continue;
    // A discount or tip Bookr worked out from a payment that is now gone is cleared.
    const clearSpread = dropIds.length && (o.inferred ?? []).includes('discount');
    o.inferred = [...inferred];
    o.unclear = [...unclear];
    if (clearSpread) o.inferred = o.inferred.filter((f: string) => f !== 'discount');
    const disc = clearSpread ? 0 : r.discount_paise;
    const tip = clearSpread ? 0 : r.tip_paise;
    statements.push(stmt(db, `UPDATE register_rows SET bill_no = ?, discount_paise = ?, tip_paise = ?, ocr_original = ?
      WHERE id = ? AND business_id = ? AND status = 'draft' AND bill_no = ?`, billNo, disc, tip, JSON.stringify(o), r.id, businessId, r.bill_no));
    for (const id of dropIds) statements.push(stmt(db, 'DELETE FROM register_payments WHERE id = ? AND business_id = ?', id, businessId));
    for (const p of newPays) {
      statements.push(stmt(db, `INSERT INTO register_payments (id, business_id, register_row_id, mode, column_label, amount_paise, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, newId(), businessId, r.id, p.mode, p.column, p.paise, t));
    }
    const kept = mine.filter((p) => !dropIds.includes(p.id)).map((p) => ({ column: p.column_label, amountPaise: p.amount_paise }));
    const action = billNo !== r.bill_no && !newPays.length && !dropIds.length ? 'register.number_completed' : 'register.recheck';
    statements.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, NULL, ?, 'register_rows', ?, ?, ?, ?)`, businessId, action, r.id, JSON.stringify(before),
      JSON.stringify({ billNo, payments: [...kept, ...newPays.map((p) => ({ column: p.column, amountPaise: p.paise }))], discountPaise: disc, tipPaise: tip,
        ...(dropIds.length ? { dropped: o.dropped } : {}) }), t));
    changed++;
  }
  if (statements.length) await db.batch(statements);
  return changed;
}

/** Kept for the software report upload (22 Nov 2026): the same re-check. */
export const completeLateNumbers = recheckDay;
