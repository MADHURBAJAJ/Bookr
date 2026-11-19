// Cash for a shift: what should be in hand against what was counted.
// Opening (previous day's cash in hand) + confirmed cash sales - approved cash expenses (and any
// booked shortage) = should be in hand; counted = cash in hand on the day's cash summary page.

import { all, one, type DB, SUMMARY_IN_USE } from './db';
import { addDays } from './time';
import { paidLaterLines } from './paidLater';

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
        (SELECT x.shift_day || '|' || coalesce(x.rg_amount_paise, '') || '|' || coalesce(x.rg_mode, '') FROM bill_comparisons x WHERE x.business_id = c.business_id AND x.linked_to_id = c.id
          ORDER BY x.shift_day LIMIT 1) AS late FROM bill_comparisons c
      LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.difference = 'missing_in_register' AND c.sw_mode = 'cash'
      UNION ALL
      SELECT c.id, c.bill_no, c.sw_amount_paise, 'use_software', r.bill_type, 'Added to the register from the software report', NULL, 1, NULL, NULL
      FROM bill_comparisons c JOIN register_rows r ON r.id = c.register_row_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.sw_mode = 'cash' AND json_extract(r.ocr_original, '$.source') = 'software_report'
        -- Only those written in as cash (18 Nov 2026): one added as UPI or card is not a cash sale of this drawer.
        AND EXISTS (SELECT 1 FROM register_payments p WHERE p.register_row_id = r.id AND p.mode = 'cash')
      ORDER BY 2`, businessId, day, businessId, day),
    one<{ approved: number; waiting: number; waitingPaise: number; waitingUpload: string | null }>(db, `SELECT
        coalesce(sum(CASE WHEN status = 'approved' THEN amount_paise END), 0) AS approved,
        count(CASE WHEN status <> 'approved' THEN 1 END) AS waiting,
        coalesce(sum(CASE WHEN status <> 'approved' THEN amount_paise END), 0) AS waitingPaise,
        min(CASE WHEN status <> 'approved' THEN upload_id END) AS waitingUpload
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

  // Cash in the software, counted as cash (Use software), but the register wrote it another way and has no cash on it
  // (18 Nov 2026): to the drawer the same as a bill not in the register, so it explains a short count too.
  const notCash = await all<{ id: string; bill_no: string; sw_amount_paise: number; paid_at: number | null; close_note: string | null; rg_mode: string | null; rg_paise: number | null }>(db, `
    SELECT c.id, c.bill_no, c.sw_amount_paise, sb.paid_at, c.close_note, c.rg_mode, c.rg_amount_paise AS rg_paise FROM bill_comparisons c
    LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
    WHERE c.business_id = ? AND c.shift_day = ? AND c.sw_mode = 'cash' AND c.decision = 'use_software' AND c.register_row_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM register_payments p WHERE p.register_row_id = c.register_row_id AND p.mode = 'cash')
      AND coalesce(json_extract((SELECT ocr_original FROM register_rows r WHERE r.id = c.register_row_id), '$.source'), '') <> 'software_report'
    ORDER BY c.bill_no`, businessId, day);
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
    late: c.late ? { day: c.late.split('|')[0], amountPaise: c.late.split('|')[1] ? Number(c.late.split('|')[1]) : null, mode: c.late.split('|')[2] || null } : null,
    // Written late as card or UPI (18 Nov 2026): the money came on that day, not into this drawer.
    paidLater: null as Awaited<ReturnType<typeof paidLaterLines>>[number] | null }));
  if (!confirmed && notInRegisterRows.some((c) => c.late?.mode === 'card' || c.late?.mode === 'upi')) {
    const lines = await paidLaterLines(db, businessId, day);
    for (const r of notInRegisterRows) r.paidLater = lines.find((l) => l.comparisonId === r.id) ?? null;
  }

  // A short count is first explained by the cash bills the register does not have (Stage 3, approved 10 Nov 2026):
  // counted from the software, so they raise "should be in hand", but the cash may never have reached the drawer.
  // Taken in time order; the last one may explain only part of the shortage.
  // Changed after saving (18 Nov 2026): a cash bill of this saved shift found paid by card or UPI on a later day. The
  // day's cash sales drop by it, so the difference moves; told with who, when and what it was when saved.
  const changedLater = confirmed ? (await all<{ after: string; created_at: number; who: string | null }>(db, `SELECT a.after, a.created_at, u.name AS who FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.business_id = ? AND a.action = 'sale.repaid' AND json_extract(a.after, '$.shiftDay') = ? AND json_extract(a.after, '$.settledLater') = 1
        AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.business_id = a.business_id AND x.action = 'sale.repay_undone' AND x.row_id = CAST(a.id AS TEXT))
      ORDER BY a.id`, businessId, day)).map((a) => {
      const o = JSON.parse(a.after) as { from: string; mode: string; bills: string[]; amountPaise: number; paidOn?: string | null; shortage?: { fromPaise: number; toPaise: number } | null };
      return { bills: o.bills, amountPaise: o.amountPaise, from: o.from, mode: o.mode, paidOn: o.paidOn ?? null, by: a.who, at: a.created_at,
        shortage: o.shortage ? { fromPaise: o.shortage.fromPaise, toPaise: o.shortage.toPaise } : null };
    }) : [];
  const settled = difference === 0 || (acc !== null && difference !== null && acc.differencePaise === difference);
  let explained: { bills: { id: string; billNo: string; amountPaise: number; partPaise: number }[]; explainedPaise: number; unexplainedPaise: number } | null = null;
  if (difference !== null && difference < 0 && !settled) {
    let left = -difference;
    const bills = [];
    const waiting = [...notInRegister.filter((x) => !x.typed && x.decision === 'use_software' && !x.close_note), ...notCash.filter((x) => !x.close_note)];
    for (const c of waiting.sort((a, b) => (a.paid_at ?? 0) - (b.paid_at ?? 0))) {
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
    registerNotCash: notCash.map((c) => ({ id: c.id, billNo: c.bill_no, amountPaise: c.sw_amount_paise, rgMode: c.rg_mode, rgPaise: c.rg_paise, closeNote: c.close_note })),
    changedLater,
    expensesPaise: expenses!.approved,
    expensesWaiting: expenses!.waiting,
    expensesWaitingPaise: expenses!.waitingPaise,
    // The day's own expense page, so its Review link opens it (18 Nov 2026), not the list of every day.
    expensesWaitingUploadId: expenses!.waitingUpload,
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
      WHERE c.business_id = ? AND c.shift_day = ? AND c.sw_mode = 'cash' AND coalesce(x.rg_mode, 'cash') = 'cash'
    UNION SELECT DISTINCT c.shift_day AS d FROM bill_comparisons x JOIN bill_comparisons c ON c.id = x.linked_to_id
      WHERE x.business_id = ? AND x.shift_day = ? AND c.sw_mode = 'cash' AND coalesce(x.rg_mode, 'cash') = 'cash'`, businessId, day, businessId, day);
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
