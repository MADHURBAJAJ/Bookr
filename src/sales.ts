// Daily sales: per-bill comparison, confirming and reopening a shift, and cash summary checks.
// See docs/phase2-context.md, "Phase 2 design". The app never picks a side: every difference
// waits for a person's decision.

import { all, newId, now, one, stmt, type DB } from './db';
import { addDays, missingInWindow, shiftWindow, type Gap } from './time';

export type Difference = 'match' | 'amount' | 'mode' | 'amount_and_mode' | 'missing_in_register' | 'missing_in_software' | 'complimentary';
export type Decision = 'use_software' | 'use_register' | 'leave_out';

export const NEEDS_DECISION: Difference[] = ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'];

interface SwBill { id: string; pos_no: string; bill_no: string; paid_at: number; mode: string; amount_paise: number; is_complimentary: number }
/** amount_paise here is the register amount after discount and tip (what should have been paid); discount_paise is signed (negative = tip). */
interface RgRow { id: string; bill_no: string; bill_type: string | null; amount_paise: number; discount_paise: number; status: string; line_no: number; upload_id: string; paid_with_row_id: string | null }
interface RgPay { register_row_id: string; mode: string; amount_paise: number; column_label: string | null }
interface Comparison {
  id: string; pos_no: string; bill_no: string; software_bill_id: string | null; register_row_id: string | null;
  sw_amount_paise: number | null; sw_mode: string | null; rg_amount_paise: number | null; rg_mode: string | null;
  difference: Difference; decision: Decision | null; decided_by: string | null; decided_at: number | null; note: string | null;
}

export function shiftStatement(db: DB, businessId: string, day: string) {
  return stmt(db, `INSERT INTO shifts (id, business_id, shift_day, status, created_at) VALUES (?, ?, ?, 'open', ?)
    ON CONFLICT (business_id, shift_day) DO NOTHING`, newId(), businessId, day, now());
}

/** The register's payment mode for a bill: one mode, 'mixed' for several, null for none written. */
export function registerMode(pays: RgPay[]): string | null {
  const modes = [...new Set(pays.map((p) => p.mode))];
  return modes.length === 0 ? null : modes.length === 1 ? modes[0] : 'mixed';
}

/**
 * rg.amount is the register amount after discount and tip (what was received); rg.gross is the bill
 * amount before them. A bill with a discount or tip matches when the software shows either figure:
 * the register's received amount is then used (approved rule, 2 Nov 2026).
 */
export function classify(sw: { amount: number; mode: string } | null, rg: { amount: number; mode: string | null; gross?: number } | null): Difference {
  if (sw && sw.amount === 0) return 'complimentary';
  if (!sw && rg && rg.amount === 0) return 'complimentary';
  if (sw && !rg) return 'missing_in_register';
  if (!sw && rg) return 'missing_in_software';
  const amountDiffers = sw!.amount !== rg!.amount && !(rg!.gross !== undefined && rg!.gross !== rg!.amount && sw!.amount === rg!.gross);
  const modeDiffers = sw!.mode === 'unknown' || sw!.mode !== rg!.mode;
  if (amountDiffers && modeDiffers) return 'amount_and_mode';
  if (amountDiffers) return 'amount';
  if (modeDiffers) return 'mode';
  return 'match';
}

export interface PaidGroup { headId: string; billNos: string[]; billsPaise: number; paidPaise: number; modes: string[] }

/**
 * Bills paid together: one payment written on the head row covers the head and every row that points
 * to it. When the group was paid one way, each bill is treated as paid that way for its own amount
 * after discount and tip, so each bill can match its own software bill and becomes its own income row.
 * The group as a whole must balance (see shiftView); a group paid more than one way is a blocker.
 */
export function applyPaidTogether(rows: RgRow[], written: Map<string, RgPay[]>) {
  const paysByRow = new Map(written);
  const members = new Map<string, RgRow[]>();
  for (const r of rows) if (r.paid_with_row_id) members.set(r.paid_with_row_id, [...(members.get(r.paid_with_row_id) ?? []), r]);
  const groups: PaidGroup[] = [];
  for (const head of rows) {
    const ms = members.get(head.id);
    if (!ms || head.paid_with_row_id) continue;
    const pays = written.get(head.id) ?? [];
    const modes = [...new Set(pays.map((p) => p.mode))];
    const all = [head, ...ms];
    groups.push({ headId: head.id, billNos: all.map((r) => r.bill_no), billsPaise: all.reduce((t, r) => t + r.amount_paise, 0), paidPaise: pays.reduce((t, p) => t + p.amount_paise, 0), modes });
    if (modes.length === 1) {
      for (const r of all) paysByRow.set(r.id, [{ register_row_id: r.id, mode: modes[0], amount_paise: r.amount_paise, column_label: pays[0].column_label }]);
    } else {
      for (const m of ms) paysByRow.set(m.id, []);
    }
  }
  return { paysByRow, groups };
}

// One round trip: D1 runs a batch of reads together.
async function loadShiftData(db: DB, businessId: string, day: string) {
  const [status, sw, rg, pays, existing] = await db.batch([
    stmt(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day),
    stmt(db, `SELECT id, pos_no, bill_no, paid_at, mode, amount_paise, is_complimentary FROM software_bills
      WHERE business_id = ? AND shift_day = ? ORDER BY paid_at`, businessId, day),
    stmt(db, `SELECT id, bill_no, bill_type, amount_paise - discount_paise + tip_paise AS amount_paise, discount_paise - tip_paise AS discount_paise, status, line_no, upload_id, paid_with_row_id FROM register_rows
      WHERE business_id = ? AND shift_day = ? ORDER BY upload_id, line_no`, businessId, day),
    stmt(db, `SELECT p.register_row_id, p.mode, p.amount_paise, p.column_label FROM register_payments p
      JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
    stmt(db, 'SELECT * FROM bill_comparisons WHERE business_id = ? AND shift_day = ?', businessId, day),
  ]);
  const written = new Map<string, RgPay[]>();
  for (const p of pays.results as RgPay[]) written.set(p.register_row_id, [...(written.get(p.register_row_id) ?? []), p]);
  const rows = rg.results as RgRow[];
  const { paysByRow, groups } = applyPaidTogether(rows, written);
  return {
    status: (status.results[0] as { status: string } | undefined)?.status ?? null,
    sw: sw.results as SwBill[],
    rg: rows,
    paysByRow,
    groups,
    existing: existing.results as Comparison[],
  };
}

/**
 * Rebuilds the comparison rows of one shift from the software bills and the register.
 * A row whose two sides are unchanged keeps its decision. If new data changes a decided bill,
 * its decision is cleared and the clearing is audit-logged. Nothing happens on a confirmed shift.
 */
export async function refreshComparisons(db: DB, businessId: string, day: string, userId: string | null): Promise<void> {
  const { status, sw, rg, paysByRow, existing } = await loadShiftData(db, businessId, day);
  if (status === 'confirmed') return;

  // Register bills match a software bill by bill number. Only the first register row per number takes part;
  // a repeat is reported by shiftView and blocks confirmation.
  const rgByBill = new Map<string, RgRow>();
  for (const r of rg) if (!rgByBill.has(r.bill_no)) rgByBill.set(r.bill_no, r);
  const wanted = new Map<string, Omit<Comparison, 'id' | 'decision' | 'decided_by' | 'decided_at' | 'note'>>();
  const usedRg = new Set<string>();
  for (const b of sw) {
    const r = rgByBill.get(b.bill_no) ?? null;
    if (r) usedRg.add(r.bill_no);
    const rgMode = r ? registerMode(paysByRow.get(r.id) ?? []) : null;
    wanted.set(`${b.pos_no}\u0000${b.bill_no}`, {
      pos_no: b.pos_no, bill_no: b.bill_no, software_bill_id: b.id, register_row_id: r?.id ?? null,
      sw_amount_paise: b.amount_paise, sw_mode: b.mode, rg_amount_paise: r?.amount_paise ?? null, rg_mode: rgMode,
      difference: classify({ amount: b.amount_paise, mode: b.mode }, r ? { amount: r.amount_paise, mode: rgMode, gross: r.amount_paise + r.discount_paise } : null),
    });
  }
  for (const r of rgByBill.values()) {
    if (usedRg.has(r.bill_no)) continue;
    const rgMode = registerMode(paysByRow.get(r.id) ?? []);
    wanted.set(`\u0000${r.bill_no}`, {
      pos_no: '', bill_no: r.bill_no, software_bill_id: null, register_row_id: r.id,
      sw_amount_paise: null, sw_mode: null, rg_amount_paise: r.amount_paise, rg_mode: rgMode,
      difference: classify(null, { amount: r.amount_paise, mode: rgMode }),
    });
  }

  const t = now();
  const statements: D1PreparedStatement[] = [];
  const same = (a: Comparison, b: (typeof wanted extends Map<string, infer V> ? V : never)) =>
    a.software_bill_id === b.software_bill_id && a.register_row_id === b.register_row_id &&
    a.sw_amount_paise === b.sw_amount_paise && a.sw_mode === b.sw_mode &&
    a.rg_amount_paise === b.rg_amount_paise && a.rg_mode === b.rg_mode && a.difference === b.difference;
  const clearedAudit = (c: Comparison, after: unknown) => stmt(db, `
    INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, ?, 'comparison.decision_cleared', 'bill_comparisons', ?, ?, ?, ?)`,
    businessId, userId, c.id, JSON.stringify(c), after === null ? null : JSON.stringify(after), t);

  const seen = new Set<string>();
  for (const c of existing) {
    const key = `${c.pos_no}\u0000${c.bill_no}`;
    const w = wanted.get(key);
    seen.add(key);
    if (!w) {
      if (c.decision) statements.push(clearedAudit(c, null));
      statements.push(stmt(db, 'DELETE FROM bill_comparisons WHERE id = ?', c.id));
      continue;
    }
    if (same(c, w)) continue;
    // Any change to a bill clears its decision, so it is decided again on the new values.
    if (c.decision) statements.push(clearedAudit(c, w));
    statements.push(stmt(db, `UPDATE bill_comparisons SET software_bill_id = ?, register_row_id = ?, sw_amount_paise = ?, sw_mode = ?,
      rg_amount_paise = ?, rg_mode = ?, difference = ?, decision = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?`,
      w.software_bill_id, w.register_row_id, w.sw_amount_paise, w.sw_mode, w.rg_amount_paise, w.rg_mode, w.difference,
      null, null, null, null, c.id));
  }
  for (const [key, w] of wanted) {
    if (seen.has(key)) continue;
    statements.push(stmt(db, `INSERT INTO bill_comparisons (id, business_id, shift_day, pos_no, bill_no, software_bill_id, register_row_id,
      sw_amount_paise, sw_mode, rg_amount_paise, rg_mode, difference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), businessId, day, w.pos_no, w.bill_no, w.software_bill_id, w.register_row_id,
      w.sw_amount_paise, w.sw_mode, w.rg_amount_paise, w.rg_mode, w.difference, t));
  }
  if (wanted.size) statements.push(stmt(db, "UPDATE shifts SET status = 'comparing' WHERE business_id = ? AND shift_day = ? AND status = 'open'", businessId, day));
  if (statements.length) await db.batch([shiftStatement(db, businessId, day), ...statements]);
}

export async function coverage(db: DB, businessId: string, day: string) {
  const window = shiftWindow(day);
  const reports = await all<{ id: string; covers_from: number; covers_to: number; first_paid_at: number; last_paid_at: number; bill_count: number; created_at: number }>(db, `
    SELECT id, covers_from, covers_to, first_paid_at, last_paid_at, bill_count, created_at FROM sales_reports
    WHERE business_id = ? AND replaced_by IS NULL AND covers_to >= ? AND covers_from < ?
    ORDER BY covers_from`, businessId, window.from - 1000, window.to);
  const gaps: Gap[] = missingInWindow(window, reports.map((r) => ({ from: r.covers_from, to: r.covers_to })));
  return { window, reports, gaps };
}

async function cashAccountId(db: DB, businessId: string): Promise<string | null> {
  const a = await one<{ id: string }>(db, `SELECT id FROM accounts WHERE business_id = ? AND kind = 'cash'
    ORDER BY lower(name) = 'cash' DESC, created_at LIMIT 1`, businessId);
  return a?.id ?? null;
}

/** Everything the Compare sales screen shows for one shift, plus what still blocks confirming it. */
export async function shiftView(db: DB, businessId: string, day: string) {
  const [{ sw, rg, paysByRow, groups }, cov, comparisons, shift, conflicts, typeHeads] = await Promise.all([
    loadShiftData(db, businessId, day),
    coverage(db, businessId, day),
    all<Comparison & { paid_at: number | null }>(db, `
      SELECT c.*, b.paid_at FROM bill_comparisons c LEFT JOIN software_bills b ON b.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day = ? ORDER BY c.bill_no`, businessId, day),
    one<{ id: string; status: string; confirmed_at: number | null; reopened_at: number | null; reopen_reason: string | null }>(db,
      'SELECT id, status, confirmed_at, reopened_at, reopen_reason FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day),
    all<{ id: string; bill_no: string; pos_no: string; existing_paid_at: number; existing_mode: string; existing_amount_paise: number;
      incoming_paid_at: number; incoming_mode: string; incoming_amount_paise: number; decision: string | null }>(db, `
      SELECT k.id, b.bill_no, b.pos_no, b.paid_at AS existing_paid_at, b.mode AS existing_mode, b.amount_paise AS existing_amount_paise,
             k.incoming_paid_at, k.incoming_mode, k.incoming_amount_paise, k.decision
      FROM software_bill_conflicts k JOIN software_bills b ON b.id = k.existing_bill_id
      WHERE k.business_id = ? AND k.decision IS NULL AND b.shift_day = ?`, businessId, day),
    all<{ bill_type: string }>(db, 'SELECT bill_type FROM bill_type_heads WHERE business_id = ?', businessId),
  ]);

  const blockers: string[] = [];
  if (!sw.length) blockers.push('No software report has bills in this shift yet.');
  if (cov.gaps.length) blockers.push('Some hours of this shift are not covered by a software report.');
  if (conflicts.length) blockers.push(`${conflicts.length} overlapping bill${conflicts.length > 1 ? 's differ' : ' differs'} between two software reports. Decide which values to keep.`);
  const undecided = comparisons.filter((c) => NEEDS_DECISION.includes(c.difference) && !c.decision);
  if (undecided.length) blockers.push(`${undecided.length} difference${undecided.length > 1 ? 's are' : ' is'} not decided yet.`);
  const drafts = rg.filter((r) => r.status !== 'checked');
  if (drafts.length) blockers.push(`${drafts.length} register row${drafts.length > 1 ? 's are' : ' is'} not checked yet.`);
  const counts = new Map<string, number>();
  for (const r of rg) counts.set(r.bill_no, (counts.get(r.bill_no) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 1).map(([b]) => b);
  if (repeated.length) blockers.push(`Bill ${repeated.join(', ')} appears more than once in the register.`);
  const grouped = new Set(groups.flatMap((g) => [g.headId, ...rg.filter((r) => r.paid_with_row_id === g.headId).map((r) => r.id)]));
  const unbalanced = rg.filter((r) => !grouped.has(r.id) && (paysByRow.get(r.id) ?? []).reduce((s, p) => s + p.amount_paise, 0) !== r.amount_paise && r.amount_paise !== 0);
  for (const g of groups) {
    if (g.modes.length !== 1) blockers.push(`Bills ${g.billNos.join(', ')} are paid together, so their one payment must be a single mode (cash, UPI or card).`);
    else if (g.paidPaise !== g.billsPaise) blockers.push(`Bills ${g.billNos.join(', ')} are paid together: the payment does not equal the bills after discounts and tips.`);
  }
  if (unbalanced.length) blockers.push(`The payments written for bill ${unbalanced.map((r) => r.bill_no).join(', ')} do not add up to the bill amount.`);
  const typed = new Set(typeHeads.map((t) => t.bill_type));
  const counted = comparisons.filter((c) => c.difference === 'match' || (c.decision && c.decision !== 'leave_out'));
  const rgById = new Map(rg.map((r) => [r.id, r]));
  const missingType = counted.filter((c) => !c.register_row_id || !rgById.get(c.register_row_id)?.bill_type);
  if (missingType.length) blockers.push(`Bill ${missingType.map((c) => c.bill_no).join(', ')} has no type (F&B or Room) in the register.`);
  const neededTypes = new Set(counted.map((c) => (c.register_row_id ? rgById.get(c.register_row_id)?.bill_type : null)).filter(Boolean) as string[]);
  const unmapped = [...neededTypes].filter((t) => !typed.has(t));
  if (unmapped.length) blockers.push(`Choose the income head for ${unmapped.map((t) => (t === 'fnb' ? 'F&B' : 'Room')).join(' and ')} bills on Heads and rules.`);
  if (!(await cashAccountId(db, businessId))) blockers.push('This business has no cash account.');

  const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);
  const swByMode = (m: string) => sum(sw.filter((b) => b.mode === m).map((b) => ({ amount: b.amount_paise })));
  const rgByMode = (m: string) => sum(rg.flatMap((r) => (paysByRow.get(r.id) ?? []).filter((p) => p.mode === m).map((p) => ({ amount: p.amount_paise }))));
  const totals = (['cash', 'upi', 'card'] as const).map((m) => ({ mode: m, softwarePaise: swByMode(m), registerPaise: rgByMode(m) }));
  const unknownPaise = swByMode('unknown');

  return {
    day,
    status: shift?.status ?? 'open',
    confirmedAt: shift?.confirmed_at ?? null,
    reopenedAt: shift?.reopened_at ?? null,
    reopenReason: shift?.reopen_reason ?? null,
    window: cov.window,
    gaps: cov.gaps,
    reports: cov.reports.map((r) => ({ id: r.id, coversFrom: r.covers_from, coversTo: r.covers_to, firstPaidAt: r.first_paid_at, lastPaidAt: r.last_paid_at, billCount: r.bill_count })),
    softwareBills: sw.length,
    registerRows: rg.length,
    registerPages: new Set(rg.map((r) => r.upload_id)).size,
    comparisons: comparisons.map((c) => ({
      id: c.id, posNo: c.pos_no, billNo: c.bill_no, paidAt: c.paid_at, difference: c.difference, decision: c.decision, note: c.note,
      software: c.software_bill_id ? { amountPaise: c.sw_amount_paise, mode: c.sw_mode } : null,
      register: c.register_row_id ? { amountPaise: c.rg_amount_paise, mode: c.rg_mode, billType: rgById.get(c.register_row_id)?.bill_type ?? null, discountPaise: rgById.get(c.register_row_id)?.discount_paise ?? 0,
        rowId: c.register_row_id, uploadId: rgById.get(c.register_row_id)?.upload_id ?? null } : null,
    })),
    conflicts: conflicts.map((k) => ({
      id: k.id, billNo: k.bill_no, posNo: k.pos_no,
      existing: { paidAt: k.existing_paid_at, mode: k.existing_mode, amountPaise: k.existing_amount_paise },
      incoming: { paidAt: k.incoming_paid_at, mode: k.incoming_mode, amountPaise: k.incoming_amount_paise },
    })),
    totals,
    unknownModePaise: unknownPaise,
    matchedAfterAdjustment: comparisons
      .filter((c) => c.difference === 'match' && c.sw_amount_paise !== c.rg_amount_paise)
      .map((c) => ({ billNo: c.bill_no, softwarePaise: c.sw_amount_paise, registerPaise: c.rg_amount_paise })),
    blockers: shift?.status === 'confirmed' ? [] : blockers,
    canConfirm: shift?.status !== 'confirmed' && blockers.length === 0,
  };
}

interface NewRow { amount: number; mode: 'cash' | 'upi' | 'card'; billType: string; source: 'software' | 'register' | 'both_matched'; c: Comparison }

/** The income rows confirmation would create. The app follows each decision; it never picks a side. */
async function plannedRows(db: DB, businessId: string, day: string): Promise<NewRow[]> {
  const { rg, paysByRow } = await loadShiftData(db, businessId, day);
  const rgById = new Map(rg.map((r) => [r.id, r]));
  const comps = await all<Comparison>(db, 'SELECT * FROM bill_comparisons WHERE business_id = ? AND shift_day = ?', businessId, day);
  const rows: NewRow[] = [];
  for (const c of comps) {
    const r = c.register_row_id ? rgById.get(c.register_row_id) : undefined;
    const billType = r?.bill_type ?? '';
    const fromRegister = (source: NewRow['source']) => {
      for (const p of paysByRow.get(r!.id) ?? []) rows.push({ amount: p.amount_paise, mode: p.mode as NewRow['mode'], billType, source, c });
    };
    // Matched after a discount or tip: the software shows the bill amount, the register what was received.
    // The register's figure is booked, so it is what bank matching will look for.
    if (c.difference === 'match') fromRegister(c.sw_amount_paise === c.rg_amount_paise ? 'both_matched' : 'register');
    else if (c.decision === 'use_register') fromRegister('register');
    else if (c.decision === 'use_software') rows.push({ amount: c.sw_amount_paise!, mode: c.sw_mode as NewRow['mode'], billType, source: 'software', c });
  }
  return rows;
}

/** Confirms a shift in one batch: approved income rows, the shift marked confirmed, audit rows. */
export async function confirmShift(db: DB, businessId: string, day: string, userId: string): Promise<{ rows: number; totalPaise: number } | { blockers: string[] }> {
  await refreshComparisons(db, businessId, day, userId);
  const view = await shiftView(db, businessId, day);
  if (view.status === 'confirmed') return { blockers: ['This shift is already confirmed.'] };
  if (!view.canConfirm) return { blockers: view.blockers };
  const [rows, cashAccount, heads] = await Promise.all([
    plannedRows(db, businessId, day),
    cashAccountId(db, businessId),
    all<{ bill_type: string; head_id: string }>(db, 'SELECT bill_type, head_id FROM bill_type_heads WHERE business_id = ?', businessId),
  ]);
  const headFor = new Map(heads.map((h) => [h.bill_type, h.head_id]));
  const t = now();
  const shift = await one<{ id: string }>(db, 'SELECT id FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day);
  const statements = [
    // First, so a second confirm running at the same moment fails here and rolls back whole.
    stmt(db, "UPDATE shifts SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE id = ?", userId, t, shift!.id),
    ...rows.map((r) => stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status,
      payment_mode, bill_no, pos_no, confirmed_source, comparison_id, shift_day, match_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'income', ?, ?, 'software_report', 'approved', ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), businessId, r.mode === 'cash' ? cashAccount : null, day, r.amount, headFor.get(r.billType) ?? null,
      `Bill ${r.c.bill_no}`, r.mode, r.c.bill_no, r.c.pos_no || null, r.source, r.c.id, day,
      r.mode === 'upi' ? 'awaiting_bank_match' : r.mode === 'card' ? 'awaiting_card_settlement' : null, t)),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'shift.confirm', 'shifts', ?, NULL, ?, ?)`, businessId, userId, shift!.id,
      JSON.stringify({ shiftDay: day, incomeRows: rows.length, totalPaise: rows.reduce((s, r) => s + r.amount, 0) }), t),
  ];
  await db.batch(statements);
  return { rows: rows.length, totalPaise: rows.reduce((s, r) => s + r.amount, 0) };
}

/** Owner only (checked by the route). Removes the rows confirmation made, keeping them in the audit log. */
export async function reopenShift(db: DB, businessId: string, day: string, userId: string, reason: string): Promise<{ error: string } | { removed: number }> {
  const shift = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day);
  if (!shift || shift.status !== 'confirmed') return { error: 'This shift is not confirmed.' };
  const rows = await all<Record<string, unknown>>(db, `SELECT * FROM transactions WHERE business_id = ? AND shift_day = ? AND source = 'software_report'`, businessId, day);
  if (rows.some((r) => r.matched_bank_row)) return { error: 'Some sales of this shift are already matched to the bank or card settlement, so it cannot be reopened.' };
  const t = now();
  await db.batch([
    ...rows.map((r) => stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'transaction.remove_on_reopen', 'transactions', ?, ?, NULL, ?)`, businessId, userId, r.id, JSON.stringify(r), t)),
    stmt(db, `DELETE FROM transactions WHERE business_id = ? AND shift_day = ? AND source = 'software_report' AND matched_bank_row IS NULL`, businessId, day),
    stmt(db, `UPDATE shifts SET status = 'comparing', reopened_by = ?, reopened_at = ?, reopen_reason = ? WHERE id = ? AND status = 'confirmed'`, userId, t, reason, shift.id),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'shift.reopen', 'shifts', ?, ?, ?, ?)`, businessId, userId, shift.id,
      JSON.stringify({ status: 'confirmed' }), JSON.stringify({ status: 'comparing', reason, removedRows: rows.length }), t),
  ]);
  return { removed: rows.length };
}

// ---- Cash account summary checks (design: "Checks shown on the summary")

export type CheckState = 'pass' | 'fail' | 'waiting' | 'unavailable';
export interface Check { key: string; label: string; state: CheckState; detail: string }

export interface SummaryValues {
  opening_paise: number | null; received_paise: number | null; balance_paise: number | null;
  expenses_paise: number | null; cash_in_hand_paise: number | null;
}

const rs = (p: number) => {
  const neg = p < 0; const a = Math.abs(p);
  return `₹${neg ? '−' : ''}${Math.trunc(a / 100).toLocaleString('en-IN')}.${String(a % 100).padStart(2, '0')}`;
};

export async function cashSummaryChecks(db: DB, businessId: string, day: string, v: SummaryValues): Promise<Check[]> {
  const checks: Check[] = [];
  const filled = [v.opening_paise, v.received_paise, v.balance_paise, v.expenses_paise, v.cash_in_hand_paise].every((x) => x !== null);
  if (!filled) {
    return [{ key: 'filled', label: 'All five figures entered', state: 'waiting', detail: 'Enter opening, received, balance, expenses and cash in hand from the page.' }];
  }
  const o = v.opening_paise!, r = v.received_paise!, b = v.balance_paise!, e = v.expenses_paise!, h = v.cash_in_hand_paise!;
  const arith = o + r === b && b - e === h;
  checks.push({ key: 'arithmetic', label: 'Opening + received − expenses = cash in hand', state: arith ? 'pass' : 'fail',
    detail: arith ? 'The page adds up.' : `Opening + received = ${rs(o + r)} (page says balance ${rs(b)}); balance − expenses = ${rs(b - e)} (page says cash in hand ${rs(h)}).` });

  const prev = await one<{ cash_in_hand_paise: number | null }>(db, `SELECT cash_in_hand_paise FROM cash_summaries
    WHERE business_id = ? AND shift_day = ? ORDER BY status = 'approved' DESC, created_at DESC LIMIT 1`, businessId, addDays(day, -1));
  if (!prev || prev.cash_in_hand_paise === null) {
    checks.push({ key: 'opening', label: "Opening equals the previous day's cash in hand", state: 'unavailable', detail: 'There is no cash summary for the previous day.' });
  } else {
    const ok = prev.cash_in_hand_paise === o;
    checks.push({ key: 'opening', label: "Opening equals the previous day's cash in hand", state: ok ? 'pass' : 'fail',
      detail: ok ? `Both are ${rs(o)}.` : `Previous day's cash in hand is ${rs(prev.cash_in_hand_paise)}; this page's opening is ${rs(o)}.` });
  }

  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day);
  if (shift?.status !== 'confirmed') {
    checks.push({ key: 'received', label: "Received equals the shift's confirmed cash sales", state: 'waiting', detail: 'Waiting for this shift to be confirmed on Compare sales.' });
  } else {
    const cash = await one<{ total: number }>(db, `SELECT coalesce(sum(amount_paise), 0) AS total FROM transactions
      WHERE business_id = ? AND shift_day = ? AND source = 'software_report' AND type = 'income' AND payment_mode = 'cash'`, businessId, day);
    const ok = cash!.total === r;
    checks.push({ key: 'received', label: "Received equals the shift's confirmed cash sales", state: ok ? 'pass' : 'fail',
      detail: ok ? `Both are ${rs(r)}.` : `Confirmed cash sales are ${rs(cash!.total)}; the page says received ${rs(r)}.` });
  }

  const exp = await one<{ approved: number; drafts: number }>(db, `SELECT
      coalesce(sum(CASE WHEN status = 'approved' THEN amount_paise END), 0) AS approved,
      count(CASE WHEN status <> 'approved' THEN 1 END) AS drafts
    FROM transactions WHERE business_id = ? AND day = ? AND source = 'cash_photo' AND type = 'expense'`, businessId, day);
  if (exp!.drafts > 0) {
    checks.push({ key: 'expenses', label: "Expenses equal the day's approved expense rows", state: 'waiting',
      detail: `Waiting for ${exp!.drafts} expense row${exp!.drafts > 1 ? 's' : ''} on this day to be approved.` });
  } else {
    const ok = exp!.approved === e;
    checks.push({ key: 'expenses', label: "Expenses equal the day's approved expense rows", state: ok ? 'pass' : 'fail',
      detail: ok ? `Both are ${rs(e)}.` : `Approved expense rows add up to ${rs(exp!.approved)}; the page says expenses ${rs(e)}.` });
  }
  return checks;
}

// ---- Bill number suggestions for the register (typos and short numbers)

export interface BillOption { billNo: string; posNo: string; amountPaise: number; mode: string; paidAt: number; amountMatches: boolean; why: 'short' | 'typo' | 'short_typo' | 'amount' }
export interface BillMatch { exact: boolean; options: BillOption[] }

const digits = (v: string) => v.replace(/\D/g, '');

/** Optimal string alignment distance: edits, inserts, deletes and swaps of neighbouring digits. */
export function billDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const WHY_ORDER = { short: 0, typo: 1, short_typo: 2, amount: 3 } as const;

/**
 * For each register row whose bill number is not exactly a software bill of the same shift, the
 * software bills it probably means. A suggestion is never applied by itself; a person picks it.
 */
export function suggestBills(
  rows: { id: string; bill_no: string; amount_paise: number }[],
  bills: { bill_no: string; pos_no: string; amount_paise: number; mode: string; paid_at: number }[],
): Map<string, BillMatch> {
  const exact = new Set(bills.map((b) => b.bill_no));
  const claimed = new Set(rows.filter((r) => exact.has(r.bill_no)).map((r) => r.bill_no));
  const free = bills.filter((b) => !claimed.has(b.bill_no) && b.amount_paise !== 0);
  const out = new Map<string, BillMatch>();
  for (const r of rows) {
    if (exact.has(r.bill_no)) { out.set(r.id, { exact: true, options: [] }); continue; }
    const w = digits(r.bill_no);
    const options: BillOption[] = [];
    for (const b of free) {
      const s = digits(b.bill_no);
      const amountMatches = b.amount_paise === r.amount_paise;
      let why: BillOption['why'] | null = null;
      if (w.length >= 3 && w.length < s.length && s.endsWith(w)) why = 'short';
      else if (w.length >= 5 && Math.abs(w.length - s.length) <= 1 && billDistance(w, s) === 1) why = 'typo';
      else if (w.length >= 3 && w.length < s.length && billDistance(w, s.slice(-w.length)) === 1 && amountMatches) why = 'short_typo';
      if (why) options.push({ billNo: b.bill_no, posNo: b.pos_no, amountPaise: b.amount_paise, mode: b.mode, paidAt: b.paid_at, amountMatches, why });
    }
    // With no close number (or none written), offer bills with the same amount.
    if (!options.length) {
      for (const b of free) {
        if (b.amount_paise === r.amount_paise) options.push({ billNo: b.bill_no, posNo: b.pos_no, amountPaise: b.amount_paise, mode: b.mode, paidAt: b.paid_at, amountMatches: true, why: 'amount' });
      }
    }
    options.sort((a, b) => Number(b.amountMatches) - Number(a.amountMatches) || WHY_ORDER[a.why] - WHY_ORDER[b.why] || a.paidAt - b.paidAt);
    out.set(r.id, { exact: false, options: options.slice(0, 6) });
  }
  return out;
}
