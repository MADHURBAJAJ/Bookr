// Cash for a shift: what should be in hand against what was counted.
// Opening (previous day's cash in hand) + confirmed cash sales - approved cash expenses (and any
// booked shortage) = should be in hand; counted = cash in hand on the day's cash summary page.

import { all, one, type DB } from './db';
import { addDays } from './time';

export const SHORTAGE_HEAD = { name: 'Cash shortage', tally: 'Cash Shortage' };

/** Reasons accepted for leaving out a cash bill the register does not have. */
export const LEAVE_OUT_REASONS = ['Cancelled in POS', 'Paid another way', "In another shift's register", 'Test bill'] as const;

async function summaryFor(db: DB, businessId: string, day: string) {
  return one<{ upload_id: string; opening_paise: number | null; cash_in_hand_paise: number | null; status: string }>(db, `
    SELECT upload_id, opening_paise, cash_in_hand_paise, status FROM cash_summaries
    WHERE business_id = ? AND shift_day = ? ORDER BY status = 'approved' DESC, created_at DESC LIMIT 1`, businessId, day);
}

export async function cashCheck(db: DB, businessId: string, day: string) {
  const [shift, today, yesterday, sales, notInRegister, expenses, shortages, accepted] = await Promise.all([
    one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day),
    summaryFor(db, businessId, day),
    summaryFor(db, businessId, addDays(day, -1)),
    one<{ total: number }>(db, `SELECT coalesce(sum(amount_paise), 0) AS total FROM transactions
      WHERE business_id = ? AND shift_day = ? AND source = 'software_report' AND type = 'income' AND payment_mode = 'cash'`, businessId, day),
    all<{ id: string; bill_no: string; sw_amount_paise: number; decision: string | null; bill_type: string | null; note: string | null }>(db, `
      SELECT id, bill_no, sw_amount_paise, decision, bill_type, note FROM bill_comparisons
      WHERE business_id = ? AND shift_day = ? AND difference = 'missing_in_register' AND sw_mode = 'cash' ORDER BY bill_no`, businessId, day),
    one<{ approved: number; waiting: number }>(db, `SELECT
        coalesce(sum(CASE WHEN status = 'approved' THEN amount_paise END), 0) AS approved,
        count(CASE WHEN status <> 'approved' THEN 1 END) AS waiting
      FROM transactions WHERE business_id = ? AND day = ? AND source = 'cash_photo' AND type = 'expense'`, businessId, day),
    one<{ total: number }>(db, `SELECT coalesce(sum(amount_paise), 0) AS total FROM transactions
      WHERE business_id = ? AND shift_day = ? AND source = 'cash_shortage'`, businessId, day),
    one<{ after: string }>(db, `SELECT after FROM audit_log WHERE business_id = ? AND action = 'cash.difference_accepted'
      AND row_table = 'shifts' AND json_extract(after, '$.day') = ? ORDER BY id DESC LIMIT 1`, businessId, day),
  ]);

  const confirmed = shift?.status === 'confirmed';
  const opening = yesterday?.cash_in_hand_paise ?? today?.opening_paise ?? null;
  const openingFrom = yesterday?.cash_in_hand_paise != null ? 'previous' : today?.opening_paise != null ? 'page' : null;
  const counted = today?.cash_in_hand_paise ?? null;
  const shouldBe = confirmed && opening !== null ? opening + sales!.total - expenses!.approved - shortages!.total : null;
  const difference = shouldBe !== null && counted !== null ? counted - shouldBe : null;
  const acc = accepted ? (JSON.parse(accepted.after) as { differencePaise: number; note: string }) : null;
  const notInRegisterRows = notInRegister.map((c) => ({ id: c.id, billNo: c.bill_no, amountPaise: c.sw_amount_paise, decision: c.decision, billType: c.bill_type, note: c.note }));

  return {
    day,
    confirmed,
    openingPaise: opening,
    openingFrom,
    cashSalesPaise: confirmed ? sales!.total : null,
    notInRegister: notInRegisterRows,
    notInRegisterBookedPaise: notInRegisterRows.filter((c) => c.decision === 'use_software').reduce((t, c) => t + c.amountPaise, 0),
    expensesPaise: expenses!.approved,
    expensesWaiting: expenses!.waiting,
    shortagePaise: shortages!.total,
    shouldBePaise: shouldBe,
    countedPaise: counted,
    summaryUploadId: today?.upload_id ?? null,
    differencePaise: difference,
    // Settled when the difference is zero, or when this exact difference was accepted with a note.
    accepted: acc && difference !== null && acc.differencePaise === difference ? acc.note : null,
    settled: difference === 0 || (acc !== null && difference !== null && acc.differencePaise === difference),
  };
}
