// Cash for a shift: what should be in hand against what was counted.
// Opening (previous day's cash in hand) + confirmed cash sales - approved cash expenses (and any
// booked shortage) = should be in hand; counted = cash in hand on the day's cash summary page.

import { all, one, type DB } from './db';
import { addDays } from './time';

export const SHORTAGE_HEAD = { name: 'Cash shortage', tally: 'Cash Shortage' };

/** A bank line that reads as cash moved between the drawer and the bank (Stage 6): a deposit, or cash taken out. */
export function cashMoveOf(r: { direction: string; kind: string; description: string }): 'deposit' | 'withdrawal' | null {
  if (r.kind === 'upi_in' || r.kind === 'upi_out' || r.kind === 'card_settlement') return null;
  if (r.direction === 'CR' && /\b(CASH\s*DEP(OSIT)?|BY\s+CASH|CDM|CASH\s+CR)\b/i.test(r.description)) return 'deposit';
  if (r.direction === 'DR' && /\b(CASH\s*(WDL|WITHDRAWAL)|ATM\s*(WDL|CASH)|ATW|NWD|SELF)\b/i.test(r.description)) return 'withdrawal';
  return null;
}

/** Reasons accepted for leaving out a cash bill the register does not have. */
export const LEAVE_OUT_REASONS = ['Cancelled in POS', 'Paid another way', "In another shift's register", 'Test bill'] as const;

async function summaryFor(db: DB, businessId: string, day: string) {
  return one<{ upload_id: string; opening_paise: number | null; cash_in_hand_paise: number | null; status: string }>(db, `
    SELECT upload_id, opening_paise, cash_in_hand_paise, status FROM cash_summaries
    WHERE business_id = ? AND shift_day = ? ORDER BY status = 'approved' DESC, created_at DESC LIMIT 1`, businessId, day);
}

export async function cashCheck(db: DB, businessId: string, day: string) {
  const [shift, today, yesterday, sales, notInRegister, expenses, shortages, accepted, moved] = await Promise.all([
    one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day),
    summaryFor(db, businessId, day),
    summaryFor(db, businessId, addDays(day, -1)),
    one<{ total: number }>(db, `SELECT coalesce(sum(amount_paise), 0) AS total FROM transactions
      WHERE business_id = ? AND shift_day = ? AND source = 'software_report' AND type = 'income' AND payment_mode = 'cash'`, businessId, day),
    all<{ id: string; bill_no: string; sw_amount_paise: number; decision: string | null; bill_type: string | null; note: string | null; paid_at: number | null; typed: number }>(db, `
      SELECT c.id, c.bill_no, c.sw_amount_paise, c.decision, c.bill_type, c.note, sb.paid_at, 0 AS typed FROM bill_comparisons c
      LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.difference = 'missing_in_register' AND c.sw_mode = 'cash'
      UNION ALL
      SELECT c.id, c.bill_no, c.sw_amount_paise, 'use_software', r.bill_type, 'Added to the register from the software report', NULL, 1
      FROM bill_comparisons c JOIN register_rows r ON r.id = c.register_row_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.sw_mode = 'cash' AND json_extract(r.ocr_original, '$.source') = 'software_report'
      ORDER BY 2`, businessId, day, businessId, day),
    one<{ approved: number; waiting: number }>(db, `SELECT
        coalesce(sum(CASE WHEN status = 'approved' THEN amount_paise END), 0) AS approved,
        count(CASE WHEN status <> 'approved' THEN 1 END) AS waiting
      FROM transactions WHERE business_id = ? AND day = ? AND source = 'cash_photo' AND type = 'expense'`, businessId, day),
    one<{ total: number }>(db, `SELECT coalesce(sum(amount_paise), 0) AS total FROM transactions
      WHERE business_id = ? AND shift_day = ? AND source = 'cash_shortage'`, businessId, day),
    one<{ after: string }>(db, `SELECT after FROM audit_log WHERE business_id = ? AND action = 'cash.difference_accepted'
      AND row_table = 'shifts' AND json_extract(after, '$.day') = ? ORDER BY id DESC LIMIT 1`, businessId, day),
    // Cash moved to or from the bank on this shift (Stage 6).
    one<{ deposited: number; drawn: number }>(db, `SELECT
        coalesce(sum(CASE WHEN json_extract(t.ocr_original, '$.leg') = 'out' THEN t.amount_paise END), 0) AS deposited,
        coalesce(sum(CASE WHEN json_extract(t.ocr_original, '$.leg') = 'in' THEN t.amount_paise END), 0) AS drawn
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'transfer' AND a.kind = 'cash'`, businessId, day),
  ]);

  const confirmed = shift?.status === 'confirmed';
  const opening = yesterday?.cash_in_hand_paise ?? today?.opening_paise ?? null;
  const openingFrom = yesterday?.cash_in_hand_paise != null ? 'previous' : today?.opening_paise != null ? 'page' : null;
  const counted = today?.cash_in_hand_paise ?? null;
  const shouldBe = confirmed && opening !== null ? opening + sales!.total - expenses!.approved - shortages!.total - moved!.deposited + moved!.drawn : null;
  const difference = shouldBe !== null && counted !== null ? counted - shouldBe : null;
  const acc = accepted ? (JSON.parse(accepted.after) as { differencePaise: number; note: string }) : null;
  const notInRegisterRows = notInRegister.map((c) => ({ id: c.id, billNo: c.bill_no, amountPaise: c.sw_amount_paise, decision: c.decision, billType: c.bill_type, note: c.note }));

  // A short count is first explained by the cash bills the register does not have (Stage 3, approved 10 Nov 2026):
  // counted from the software, so they raise "should be in hand", but the cash may never have reached the drawer.
  // Taken in time order; the last one may explain only part of the shortage.
  const settled = difference === 0 || (acc !== null && difference !== null && acc.differencePaise === difference);
  let explained: { bills: { id: string; billNo: string; amountPaise: number; partPaise: number }[]; explainedPaise: number; unexplainedPaise: number } | null = null;
  if (difference !== null && difference < 0 && !settled) {
    let left = -difference;
    const bills = [];
    for (const c of notInRegister.filter((x) => !x.typed && x.decision === 'use_software').sort((a, b) => (a.paid_at ?? 0) - (b.paid_at ?? 0))) {
      if (left <= 0) break;
      const part = Math.min(left, c.sw_amount_paise);
      bills.push({ id: c.id, billNo: c.bill_no, amountPaise: c.sw_amount_paise, partPaise: part });
      left -= part;
    }
    explained = { bills, explainedPaise: -difference - left, unexplainedPaise: left };
  }

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
    depositedPaise: moved!.deposited,
    drawnPaise: moved!.drawn,
    shouldBePaise: shouldBe,
    countedPaise: counted,
    summaryUploadId: today?.upload_id ?? null,
    differencePaise: difference,
    // Settled when the difference is zero, or when this exact difference was accepted with a note.
    accepted: acc && difference !== null && acc.differencePaise === difference ? acc.note : null,
    settled,
    explained,
  };
}

/**
 * A short day next to an over day by the same amount (Stage 3, approved 10 Nov 2026): most likely cash counted a day
 * late. Offered on both days; settling it accepts both differences with one note.
 */
export async function cashPairOf(db: DB, businessId: string, day: string, k?: Awaited<ReturnType<typeof cashCheck>>) {
  const me = k ?? await cashCheck(db, businessId, day);
  if (me.differencePaise === null || me.differencePaise === 0 || me.settled) return null;
  for (const other of [addDays(day, 1), addDays(day, -1)]) {
    const o = await cashCheck(db, businessId, other);
    if (o.differencePaise === -me.differencePaise && !o.settled) {
      const [shortDay, overDay] = me.differencePaise < 0 ? [day, other] : [other, day];
      return { day: other, differencePaise: o.differencePaise, shortDay, overDay, amountPaise: Math.abs(me.differencePaise) };
    }
  }
  return null;
}
