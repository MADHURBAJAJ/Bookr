/**
 * Paid by UPI, before saving (approved 11 Nov 2026): a bill written as card (or cash) that one UPI credit of its exact
 * amount paid instead. Offered on Reconcile with one button: the register's payment becomes UPI in the column of the
 * account the money came into, the bill is decided Use register when the software says otherwise, and the credit is
 * matched on save. Offered only when it is clear:
 * - card: the card report covers the shift and has no payment of that amount near the bill;
 * - exactly one free UPI credit of that amount is near the bill, and no UPI bill of the shift has that amount;
 * - the bill is on its own register row with one payment (not paid together with other bills).
 * Cash bills are offered too; the person is asked first, as the cash count is then that much short of what was written.
 */
import { all, one, type DB } from './db';
import { addDays, shiftWindow } from './time';
import { plannedRows } from './sales';

const NEAR_MIN = 60;

export interface ByUpi {
  comparisonId: string; billNo: string | null; mode: 'card' | 'cash'; amountPaise: number; paidAt: number | null; swMode: string | null;
  rowId: string; uploadId: string; creditId: string; creditAt: number; accountName: string | null; label: string | null; minutes: number | null;
}

export async function paidByUpi(db: DB, businessId: string, day: string): Promise<ByUpi[]> {
  const w = shiftWindow(day);
  const rows = await plannedRows(db, businessId, day);
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.c.id, (count.get(r.c.id) ?? 0) + 1);
  const upiAmounts = new Set(rows.filter((r) => r.mode === 'upi').map((r) => r.amount));
  const bills = rows.filter((r) => (r.mode === 'card' || r.mode === 'cash') && count.get(r.c.id) === 1 && r.c.register_row_id && !upiAmounts.has(r.amount));
  if (!bills.length) return [];
  const [regs, times, credits, cardLast, cardPays, chosen] = await Promise.all([
    all<{ id: string; upload_id: string; grouped: number }>(db, `SELECT r.id, r.upload_id, (r.paid_with_row_id IS NOT NULL OR EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = r.id)) AS grouped
      FROM register_rows r WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
    all<{ id: string; paid_at: number | null }>(db, `SELECT c.id, sb.paid_at FROM bill_comparisons c LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day = ?`, businessId, day),
    all<{ id: string; amount_paise: number; posted_at: number; account_name: string | null; label: string | null }>(db, `
      SELECT r.id, r.amount_paise, r.posted_at, a.name AS account_name, s.receives_upi_label AS label FROM bank_rows r
      JOIN accounts a ON a.id = r.account_id LEFT JOIN bank_sources s ON s.account_id = r.account_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ?
        AND NOT EXISTS (SELECT 1 FROM shift_choices k WHERE k.bank_row_id = r.id)`, businessId, w.from - 3600e3, w.to + 3 * 3600e3),
    one<{ paid: number | null; settled: string | null }>(db, 'SELECT max(paid_at) AS paid, max(settled_on) AS settled FROM card_settlements WHERE business_id = ?', businessId),
    all<{ amount_paise: number; paid_at: number }>(db, `SELECT amount_paise, paid_at FROM card_settlements WHERE business_id = ? AND txn_type = 'PURCHASE'
      AND paid_at >= ? AND paid_at < ?`, businessId, w.from - 3600e3, w.to + 3600e3),
    all<{ comparison_ids: string }>(db, 'SELECT comparison_ids FROM shift_choices WHERE business_id = ? AND shift_day = ?', businessId, day),
  ]);
  const regOf = new Map(regs.map((r) => [r.id, r]));
  const timeOf = new Map(times.map((t) => [t.id, t.paid_at]));
  const chosenBills = new Set(chosen.flatMap((k) => JSON.parse(k.comparison_ids) as string[]));
  const cardCovered = (cardLast?.paid ?? 0) >= w.to || (cardLast?.settled ?? '') >= addDays(day, 2);
  const near = (at: number | null, t: number) => (at != null ? Math.abs(t - at) <= NEAR_MIN * 60000 : t >= w.from && t < w.to);
  const options: ByUpi[] = [];
  for (const b of bills) {
    const reg = regOf.get(b.c.register_row_id!);
    if (!reg || reg.grouped || chosenBills.has(b.c.id)) continue;
    const at = timeOf.get(b.c.id) ?? null;
    if (b.mode === 'card' && (!cardCovered || cardPays.some((p) => p.amount_paise === b.amount && near(at, p.paid_at)))) continue;
    const fits = credits.filter((c) => c.amount_paise === b.amount && near(at, c.posted_at));
    if (fits.length !== 1) continue;
    const c = fits[0];
    options.push({ comparisonId: b.c.id, billNo: b.c.bill_no, mode: b.mode as 'card' | 'cash', amountPaise: b.amount, paidAt: at, swMode: b.c.sw_mode ?? null,
      rowId: reg.id, uploadId: reg.upload_id, creditId: c.id, creditAt: c.posted_at, accountName: c.account_name, label: c.label,
      minutes: at != null ? Math.round(Math.abs(c.posted_at - at) / 60000) : null });
  }
  // A credit two bills could take is left to the person.
  return options.filter((o) => options.filter((x) => x.creditId === o.creditId).length === 1);
}
