// Missed entries report (approved 7 Nov 2026): for a range of shifts, what one record left out. A bill in the software
// report that nobody wrote in the register; a bill in the register that the software does not have; and money in the
// bank with no bill in either (booked under a head, or still unmatched after its shift was confirmed). Read-only.

import { all, type DB } from './db';
import { shiftDayOf, shiftWindow } from './time';

export interface MissedBill {
  comparisonId: string; day: string; billNo: string; amountPaise: number | null; mode: string | null; paidAt: number | null;
  /** open, added (written in from the software report), counted, left_out, other_day, carried */
  status: string; otherDay: string | null; note: string | null;
}
export interface MissedCredit {
  id: string; day: string; postedAt: number; amountPaise: number; accountName: string | null; remark: string | null; vpa: string | null;
  status: 'booked' | 'unmatched'; headName: string | null; note: string | null;
}

const statusOf = (decision: string | null, added: boolean, otherDay: string | null) =>
  added ? 'added' : otherDay ? 'other_day' : decision === 'use_software' || decision === 'use_register' ? 'counted'
    : decision === 'leave_out' ? 'left_out' : decision === 'carry_forward' ? 'carried' : 'open';

export async function missedEntries(db: DB, businessId: string, from: string, to: string) {
  const [bills, credits, confirmed] = await Promise.all([
    all<{ id: string; day: string; billNo: string; difference: string; swPaise: number | null; swMode: string | null; rgPaise: number | null; rgMode: string | null;
      paidAt: number | null; decision: string | null; note: string | null; added: number; otherDay: string | null }>(db, `
      SELECT c.id, c.shift_day AS day, c.bill_no AS billNo, c.difference, c.sw_amount_paise AS swPaise, c.sw_mode AS swMode, c.rg_amount_paise AS rgPaise, c.rg_mode AS rgMode,
        sb.paid_at AS paidAt, c.decision, c.note, coalesce(r.ocr_original LIKE '%"source":"software_report"%', 0) AS added, l.shift_day AS otherDay
      FROM bill_comparisons c LEFT JOIN register_rows r ON r.id = c.register_row_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
        LEFT JOIN bill_comparisons l ON l.id = c.linked_to_id
      WHERE c.business_id = ? AND c.shift_day BETWEEN ? AND ?
        AND (c.difference IN ('missing_in_register', 'missing_in_software') OR r.ocr_original LIKE '%"source":"software_report"%')
      ORDER BY c.shift_day, coalesce(sb.paid_at, 0), c.bill_no`, businessId, from, to),
    all<Omit<MissedCredit, 'day'>>(db, `
      SELECT r.id, r.posted_at AS postedAt, r.amount_paise AS amountPaise, a.name AS accountName, r.remark, r.vpa, r.status, h.name AS headName, r.note
      FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status IN ('booked', 'unmatched') AND r.posted_at >= ? AND r.posted_at < ?
      ORDER BY r.posted_at`, businessId, shiftWindow(from).from, shiftWindow(to).to),
    all<{ day: string }>(db, "SELECT shift_day AS day FROM shifts WHERE business_id = ? AND status = 'confirmed' AND shift_day BETWEEN ? AND ?", businessId, from, to),
  ]);
  const done = new Set(confirmed.map((x) => x.day));
  const bill = (b: (typeof bills)[number], side: 'sw' | 'rg'): MissedBill => ({
    comparisonId: b.id, day: b.day, billNo: b.billNo, amountPaise: side === 'sw' ? b.swPaise : b.rgPaise, mode: side === 'sw' ? b.swMode : b.rgMode,
    paidAt: b.paidAt, status: statusOf(b.decision, !!b.added, b.otherDay), otherDay: b.otherDay, note: b.note,
  });
  return {
    notInRegister: bills.filter((b) => b.difference === 'missing_in_register' || b.added).map((b) => bill(b, 'sw')),
    notInSoftware: bills.filter((b) => b.difference === 'missing_in_software').map((b) => bill(b, 'rg')),
    // Booked credits always count; an unmatched one only once its shift is confirmed (before, it may still be paired).
    inNeither: credits.map((c) => ({ ...c, day: shiftDayOf(c.postedAt) }))
      .filter((c) => c.day >= from && c.day <= to && (c.status === 'booked' || done.has(c.day))),
  };
}
