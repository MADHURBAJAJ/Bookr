// Cash for a shift: what should be in hand against what was counted.
// Opening (previous day's cash in hand) + confirmed cash sales - approved cash expenses (and any
// booked shortage) = should be in hand; counted = cash in hand on the day's cash summary page.

import { all, one, type DB, SUMMARY_IN_USE } from './db';
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
    WHERE business_id = ? AND shift_day = ? AND ${SUMMARY_IN_USE} ORDER BY status = 'approved' DESC, created_at DESC LIMIT 1`, businessId, day);
}

export async function cashCheck(db: DB, businessId: string, day: string) {
  const [shift, today, yesterday, sales, notInRegister, expenses, shortages, accepted, moved] = await Promise.all([
    one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day),
    summaryFor(db, businessId, day),
    summaryFor(db, businessId, addDays(day, -1)),
    one<{ total: number }>(db, `SELECT coalesce(sum(amount_paise), 0) AS total FROM transactions
      WHERE business_id = ? AND shift_day = ? AND source = 'software_report' AND type = 'income' AND payment_mode = 'cash'`, businessId, day),
    all<{ id: string; bill_no: string; sw_amount_paise: number; decision: string | null; bill_type: string | null; note: string | null; paid_at: number | null; typed: number; close_note: string | null; late: string | null }>(db, `
      SELECT c.id, c.bill_no, c.sw_amount_paise, c.decision, c.bill_type, c.note, sb.paid_at, 0 AS typed, c.close_note,
        -- Written late: the same bill on a later day's register, linked to this one (its day and written amount).
        (SELECT x.shift_day || '|' || coalesce(x.rg_amount_paise, '') FROM bill_comparisons x WHERE x.business_id = c.business_id AND x.linked_to_id = c.id
          ORDER BY x.shift_day LIMIT 1) AS late FROM bill_comparisons c
      LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.difference = 'missing_in_register' AND c.sw_mode = 'cash'
      UNION ALL
      SELECT c.id, c.bill_no, c.sw_amount_paise, 'use_software', r.bill_type, 'Added to the register from the software report', NULL, 1, NULL, NULL
      FROM bill_comparisons c JOIN register_rows r ON r.id = c.register_row_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.sw_mode = 'cash' AND json_extract(r.ocr_original, '$.source') = 'software_report'
      ORDER BY 2`, businessId, day, businessId, day),
    one<{ approved: number; waiting: number; waitingPaise: number }>(db, `SELECT
        coalesce(sum(CASE WHEN status = 'approved' THEN amount_paise END), 0) AS approved,
        count(CASE WHEN status <> 'approved' THEN 1 END) AS waiting,
        coalesce(sum(CASE WHEN status <> 'approved' THEN amount_paise END), 0) AS waitingPaise
      FROM transactions WHERE business_id = ? AND day = ? AND source = 'cash_photo' AND type = 'expense'`, businessId, day),
    all<{ id: string; amount_paise: number; narration: string | null; ocr_original: string | null }>(db, `SELECT id, amount_paise, narration, ocr_original FROM transactions
      WHERE business_id = ? AND shift_day = ? AND source = 'cash_shortage' ORDER BY created_at`, businessId, day),
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
  const shortageTotal = shortages.reduce((t, x) => t + x.amount_paise, 0);
  const shouldBe = confirmed && opening !== null ? opening + sales!.total - expenses!.approved - shortageTotal - moved!.deposited + moved!.drawn : null;
  const difference = shouldBe !== null && counted !== null ? counted - shouldBe : null;
  const acc = accepted ? (JSON.parse(accepted.after) as { differencePaise: number; note: string }) : null;
  const notInRegisterRows = notInRegister.map((c) => ({ id: c.id, billNo: c.bill_no, amountPaise: c.sw_amount_paise, decision: c.decision, billType: c.bill_type, note: c.note,
    paidAt: c.paid_at, closeNote: c.close_note,
    late: c.late ? { day: c.late.split('|')[0], amountPaise: c.late.split('|')[1] ? Number(c.late.split('|')[1]) : null } : null }));

  // A short count is first explained by the cash bills the register does not have (Stage 3, approved 10 Nov 2026):
  // counted from the software, so they raise "should be in hand", but the cash may never have reached the drawer.
  // Taken in time order; the last one may explain only part of the shortage.
  const settled = difference === 0 || (acc !== null && difference !== null && acc.differencePaise === difference);
  let explained: { bills: { id: string; billNo: string; amountPaise: number; partPaise: number }[]; explainedPaise: number; unexplainedPaise: number } | null = null;
  if (difference !== null && difference < 0 && !settled) {
    let left = -difference;
    const bills = [];
    for (const c of notInRegister.filter((x) => !x.typed && x.decision === 'use_software' && !x.close_note).sort((a, b) => (a.paid_at ?? 0) - (b.paid_at ?? 0))) {
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
    expensesWaitingPaise: expenses!.waitingPaise,
    shortagePaise: shortageTotal,
    // Each shortage booked on this shift, and the bill it was booked for (18 Nov 2026).
    shortages: shortages.map((x) => { let o: { comparisonId?: string; billNo?: string } = {}; try { o = JSON.parse(x.ocr_original ?? '{}') ?? {}; } catch { /* none */ }
      return { id: x.id, amountPaise: x.amount_paise, note: x.narration, comparisonId: o.comparisonId ?? null, billNo: o.billNo ?? null }; }),
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
 * late. Offered on both days; settling it accepts both differences with one note. Also (18 Nov 2026) the day a cash
 * bill of this day was written late in the register, or the day this day's late line belongs to, and up to
 * PAIR_SLACK_PAISE apart (a bill of ₹385 written as ₹380): the gap is shown and goes into the note.
 */
export const PAIR_SLACK_PAISE = 1000;
export async function cashPairOf(db: DB, businessId: string, day: string, k?: Awaited<ReturnType<typeof cashCheck>>) {
  const me = k ?? await cashCheck(db, businessId, day);
  if (me.differencePaise === null || me.differencePaise === 0 || me.settled) return null;
  const linked = await all<{ d: string }>(db, `SELECT DISTINCT x.shift_day AS d FROM bill_comparisons x JOIN bill_comparisons c ON c.id = x.linked_to_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.sw_mode = 'cash'
    UNION SELECT DISTINCT c.shift_day AS d FROM bill_comparisons x JOIN bill_comparisons c ON c.id = x.linked_to_id
      WHERE x.business_id = ? AND x.shift_day = ? AND c.sw_mode = 'cash'`, businessId, day, businessId, day);
  const days = [...new Set([addDays(day, 1), addDays(day, -1), ...linked.map((x) => x.d)])].filter((d) => d !== day);
  let best: { day: string; differencePaise: number; shortDay: string; overDay: string; amountPaise: number; gapPaise: number } | null = null;
  for (const other of days) {
    const o = await cashCheck(db, businessId, other);
    if (o.differencePaise === null || o.settled || Math.sign(o.differencePaise) === Math.sign(me.differencePaise)) continue;
    const gap = Math.abs(o.differencePaise + me.differencePaise);
    if (gap > PAIR_SLACK_PAISE || (gap && !linked.some((x) => x.d === other))) continue; // a gap only with a late line between them
    if (best && best.gapPaise <= gap) continue;
    const [shortDay, overDay] = me.differencePaise < 0 ? [day, other] : [other, day];
    best = { day: other, differencePaise: o.differencePaise, shortDay, overDay, amountPaise: Math.abs(me.differencePaise), gapPaise: gap };
  }
  return best;
}

/**
 * A cash count over by exactly a shortage booked on one of the 7 shifts before (18 Nov 2026): the cash came late, so the
 * shortage can be reversed and the two days settled as paid late. Offered, never done by itself.
 */
export async function shortageToReverse(db: DB, businessId: string, day: string, k: Awaited<ReturnType<typeof cashCheck>>) {
  const over = k.confirmed ? k.differencePaise : null;
  if (over == null || over <= 0 || k.settled) return null;
  const x = await one<{ id: string; shift_day: string; amount_paise: number; ocr_original: string | null }>(db, `SELECT id, shift_day, amount_paise, ocr_original FROM transactions
    WHERE business_id = ? AND source = 'cash_shortage' AND amount_paise = ? AND shift_day < ? AND shift_day >= ? ORDER BY shift_day DESC LIMIT 1`,
    businessId, over, day, addDays(day, -7));
  if (!x) return null;
  let o: { billNo?: string } = {}; try { o = JSON.parse(x.ocr_original ?? '{}') ?? {}; } catch { /* none */ }
  return { id: x.id, day: x.shift_day, amountPaise: x.amount_paise, billNo: o.billNo ?? null };
}
