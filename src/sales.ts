// Daily sales: per-bill comparison, confirming and reopening a shift, and cash summary checks.
// See docs/phase2-context.md, "Phase 2 design". The app never picks a side: every difference
// waits for a person's decision.

import { all, newId, now, one, stmt, type DB } from './db';
import { addDays, missingInWindow, shiftWindow, type Gap } from './time';

export type Difference = 'match' | 'amount' | 'mode' | 'amount_and_mode' | 'missing_in_register' | 'missing_in_software' | 'complimentary';
export type Decision = 'use_software' | 'use_register' | 'leave_out' | 'carry_forward';
export const ONE_SIDED: Difference[] = ['missing_in_register', 'missing_in_software'];
/** How long a bill found on one side only is watched for in other days' data. */
export const WATCH_DAYS = 7;

export const NEEDS_DECISION: Difference[] = ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'];

interface SwBill { id: string; pos_no: string; bill_no: string; paid_at: number; mode: string; amount_paise: number; is_complimentary: number }
/** amount_paise here is the register amount after discount and tip (what should have been paid); discount_paise is signed (negative = tip). */
interface RgRow { id: string; bill_no: string; bill_type: string | null; amount_paise: number; discount_paise: number; status: string; line_no: number; upload_id: string; paid_with_row_id: string | null }
interface RgPay { register_row_id: string; mode: string; amount_paise: number; column_label: string | null }
interface Comparison {
  id: string; pos_no: string; bill_no: string; software_bill_id: string | null; register_row_id: string | null;
  sw_amount_paise: number | null; sw_mode: string | null; rg_amount_paise: number | null; rg_mode: string | null;
  difference: Difference; decision: Decision | null; decided_by: string | null; decided_at: number | null; note: string | null;
  bill_type: string | null; shift_day?: string; linked_to_id?: string | null; closed_at?: number | null; close_note?: string | null;
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
/** A discount above this share of the bill(s) is never matched by itself: a person checks for a missing payment. */
export const LARGE_DISCOUNT_PCT = 20;

/**
 * Discount per register row as a share of its bills. Bills paid together are judged as one: the group's
 * discounts against the group's bills. discount_paise is signed here (negative = tip); amount_paise is net.
 */
export function discountShares(rows: { id: string; amount_paise: number; discount_paise: number; paid_with_row_id: string | null }[]) {
  const groups = new Map<string, { discount: number; gross: number }>();
  for (const r of rows) {
    const g = groups.get(r.paid_with_row_id ?? r.id) ?? { discount: 0, gross: 0 };
    g.discount += Math.max(r.discount_paise, 0);
    g.gross += r.amount_paise + r.discount_paise;
    groups.set(r.paid_with_row_id ?? r.id, g);
  }
  const out = new Map<string, { discountPaise: number; grossPaise: number; pct: number; large: boolean }>();
  for (const r of rows) {
    const g = groups.get(r.paid_with_row_id ?? r.id)!;
    const large = g.discount > 0 && g.discount * 100 > LARGE_DISCOUNT_PCT * g.gross;
    out.set(r.id, { discountPaise: g.discount, grossPaise: g.gross, pct: g.gross ? Math.round((g.discount * 100) / g.gross) : 0, large });
  }
  return out;
}

export function classify(sw: { amount: number; mode: string } | null, rg: { amount: number; mode: string | null; gross?: number; largeDiscount?: boolean } | null): Difference {
  if (sw && sw.amount === 0) return 'complimentary';
  if (!sw && rg && rg.amount === 0) return 'complimentary';
  if (sw && !rg) return 'missing_in_register';
  if (!sw && rg) return 'missing_in_software';
  // Matched after a discount or tip, unless the discount is large (more than LARGE_DISCOUNT_PCT of the bills).
  const amountDiffers = sw!.amount !== rg!.amount && !(rg!.gross !== undefined && rg!.gross !== rg!.amount && sw!.amount === rg!.gross && !rg!.largeDiscount);
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
    stmt(db, `SELECT id, bill_no, bill_type, amount_paise - discount_paise + tip_paise AS amount_paise, discount_paise - tip_paise AS discount_paise, status, line_no, upload_id, paid_with_row_id, ocr_original FROM register_rows
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
  const shares = discountShares(rg);
  const wanted = new Map<string, Omit<Comparison, 'id' | 'decision' | 'decided_by' | 'decided_at' | 'note' | 'bill_type'>>();
  const usedRg = new Set<string>();
  for (const b of sw) {
    const r = rgByBill.get(b.bill_no) ?? null;
    if (r) usedRg.add(r.bill_no);
    const rgMode = r ? registerMode(paysByRow.get(r.id) ?? []) : null;
    wanted.set(`${b.pos_no}\u0000${b.bill_no}`, {
      pos_no: b.pos_no, bill_no: b.bill_no, software_bill_id: b.id, register_row_id: r?.id ?? null,
      sw_amount_paise: b.amount_paise, sw_mode: b.mode, rg_amount_paise: r?.amount_paise ?? null, rg_mode: rgMode,
      difference: classify({ amount: b.amount_paise, mode: b.mode }, r ? { amount: r.amount_paise, mode: rgMode, gross: r.amount_paise + r.discount_paise, largeDiscount: shares.get(r.id)?.large } : null),
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
      statements.push(...unlinkStatements(db, c.id, t));
      statements.push(stmt(db, 'DELETE FROM bill_comparisons WHERE id = ?', c.id));
      continue;
    }
    if (same(c, w)) continue;
    // Any change to a bill clears its decision, so it is decided again on the new values.
    if (c.decision) statements.push(clearedAudit(c, w));
    statements.push(...unlinkStatements(db, c.id, t));
    statements.push(stmt(db, `UPDATE bill_comparisons SET software_bill_id = ?, register_row_id = ?, sw_amount_paise = ?, sw_mode = ?,
      rg_amount_paise = ?, rg_mode = ?, difference = ?, decision = ?, decided_by = ?, decided_at = ?, note = ?, bill_type = NULL, linked_to_id = NULL,
      closed_at = NULL, closed_by = NULL, close_note = NULL WHERE id = ?`,
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

/**
 * A bill on another day that was decided by linking to this comparison (e.g. "already counted on 31 Oct")
 * no longer holds when this one changes: its decision is cleared, unless its shift is confirmed.
 */
function unlinkStatements(db: DB, comparisonId: string, t: number): D1PreparedStatement[] {
  const open = `linked_to_id = ? AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.business_id = bill_comparisons.business_id
    AND s.shift_day = bill_comparisons.shift_day AND s.status = 'confirmed')`;
  return [
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      SELECT business_id, NULL, 'comparison.decision_cleared', 'bill_comparisons', id,
        json_object('decision', decision, 'linkedToId', linked_to_id, 'note', note), json_object('reason', 'linked bill changed'), ?
      FROM bill_comparisons WHERE ${open}`, t, comparisonId),
    stmt(db, `UPDATE bill_comparisons SET decision = NULL, decided_by = NULL, decided_at = NULL, note = NULL, bill_type = NULL, linked_to_id = NULL
      WHERE ${open}`, comparisonId),
  ];
}

// ---- Bills found on one side only, followed across shifts

export interface OtherDay {
  id: string; day: string; billNo: string; side: 'software' | 'register'; amountPaise: number | null; mode: string | null;
  decision: Decision | null; note: string | null; billType: string | null; confirmed: boolean; closed: boolean;
  /** This other entry was itself decided by linking to the comparison being looked at. */
  linksHere: boolean;
}

export const isCounted = (d: Decision | null | undefined) => d === 'use_software' || d === 'use_register';
/** Bill numbers that may be the same bill: equal, or one is the last 4+ digits of the other (as the register often writes). */
export const sameBillNo = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.endsWith(b) || b.endsWith(a)));

/**
 * For each one-sided comparison of a shift, the same bill on the other side in another shift within the
 * watch (or one already linked either way). A comparison in a confirmed shift is shown but cannot change.
 */
export async function otherDays(db: DB, businessId: string, day: string, comps: Comparison[]): Promise<Map<string, OtherDay>> {
  const out = new Map<string, OtherDay>();
  const mine = comps.filter((c) => ONE_SIDED.includes(c.difference));
  if (!mine.length) return out;
  // A bill added to the register from the software report is, for other days, a software-only bill that was counted.
  const cands = await all<Comparison & { shift_day: string; shift_status: string | null; rg_type: string | null }>(db, `
    SELECT * FROM (SELECT c.id, c.business_id, c.shift_day, c.pos_no, c.bill_no, c.software_bill_id, c.register_row_id, c.sw_amount_paise, c.sw_mode,
      c.rg_amount_paise, c.rg_mode, c.note, c.bill_type, c.linked_to_id, c.closed_at, c.close_note, c.decided_by, c.decided_at, c.created_at,
      CASE WHEN json_extract(r.ocr_original, '$.source') = 'software_report' THEN 'missing_in_register' ELSE c.difference END AS difference,
      CASE WHEN json_extract(r.ocr_original, '$.source') = 'software_report' THEN 'use_software' ELSE c.decision END AS decision,
      s.status AS shift_status, r.bill_type AS rg_type
    FROM bill_comparisons c
    LEFT JOIN shifts s ON s.business_id = c.business_id AND s.shift_day = c.shift_day
    LEFT JOIN register_rows r ON r.id = c.register_row_id) c
    WHERE c.business_id = ? AND c.shift_day <> ? AND c.difference IN ('missing_in_register', 'missing_in_software')
      AND ((c.shift_day BETWEEN ? AND ? AND c.closed_at IS NULL)
        OR c.linked_to_id IN (SELECT x.id FROM bill_comparisons x WHERE x.business_id = ? AND x.shift_day = ?)
        OR c.id IN (SELECT x.linked_to_id FROM bill_comparisons x WHERE x.business_id = ? AND x.shift_day = ? AND x.linked_to_id IS NOT NULL))`,
    businessId, day, addDays(day, -WATCH_DAYS), addDays(day, WATCH_DAYS), businessId, day, businessId, day);
  for (const c of mine) {
    const opposite = c.difference === 'missing_in_register' ? 'missing_in_software' : 'missing_in_register';
    const pick = cands.find((o) => o.id === c.linked_to_id) ?? cands.find((o) => o.linked_to_id === c.id)
      ?? cands.find((o) => o.difference === opposite && o.bill_no === c.bill_no && !o.linked_to_id)
      ?? cands.find((o) => o.difference === opposite && sameBillNo(o.bill_no, c.bill_no) && !o.linked_to_id);
    if (!pick || pick.difference !== opposite) continue;
    const sw = pick.difference === 'missing_in_register';
    out.set(c.id, {
      id: pick.id, day: pick.shift_day, billNo: pick.bill_no, side: sw ? 'software' : 'register',
      amountPaise: sw ? pick.sw_amount_paise : pick.rg_amount_paise, mode: sw ? pick.sw_mode : pick.rg_mode,
      decision: pick.decision, note: pick.note, billType: pick.rg_type ?? pick.bill_type, confirmed: pick.shift_status === 'confirmed',
      closed: pick.closed_at != null, linksHere: pick.linked_to_id === c.id,
    });
  }
  return out;
}

/**
 * The watch list: bills found on one side only, decided, not closed, and not yet paired with the other
 * side on another day. After WATCH_DAYS they are unresolved and an Owner or Accountant closes them.
 */
/** Bills of the old POS: 6-digit numbers, never in the software report, so never matched. */
export const isOldPosBill = (billNo: string | null | undefined) => /^\d{6}$/.test(billNo ?? '');

export async function waitingBills(db: DB, businessId: string, today: string) {
  const rows = await all<Comparison & { shift_day: string; shift_status: string | null }>(db, `
    SELECT c.*, s.status AS shift_status FROM bill_comparisons c
    LEFT JOIN shifts s ON s.business_id = c.business_id AND s.shift_day = c.shift_day
    WHERE c.business_id = ? AND c.difference IN ('missing_in_register', 'missing_in_software') AND c.decision IS NOT NULL
      AND c.closed_at IS NULL AND c.linked_to_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM bill_comparisons x WHERE x.linked_to_id = c.id)
    ORDER BY c.shift_day, c.bill_no`, businessId);
  // An old POS bill on the register will never meet a software bill: it does not wait.
  return rows.filter((c) => !(c.difference === 'missing_in_software' && isOldPosBill(c.bill_no))).map((c) => {
    const days = Math.round((Date.parse(today) - Date.parse(c.shift_day)) / 86400000);
    return {
      id: c.id, day: c.shift_day, billNo: c.bill_no, side: c.difference === 'missing_in_register' ? 'software' : 'register',
      amountPaise: c.difference === 'missing_in_register' ? c.sw_amount_paise : c.rg_amount_paise,
      mode: c.difference === 'missing_in_register' ? c.sw_mode : c.rg_mode,
      decision: c.decision, note: c.note, confirmed: c.shift_status === 'confirmed', daysWaiting: days, unresolved: days > WATCH_DAYS,
    };
  });
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

export async function cashAccountId(db: DB, businessId: string): Promise<string | null> {
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
  const others = await otherDays(db, businessId, day, comparisons);
  const twice = comparisons.filter((c) => isCounted(c.decision) && others.has(c.id) && isCounted(others.get(c.id)!.decision)
    && (c.linked_to_id === others.get(c.id)!.id || others.get(c.id)!.linksHere || others.get(c.id)!.billNo === c.bill_no));
  if (twice.length) blockers.push(`Bill ${twice.map((c) => `${c.bill_no} (also counted on ${others.get(c.id)!.day})`).join(', ')} would be counted twice. Choose "Already counted" for it here.`);
  const undecided = comparisons.filter((c) => NEEDS_DECISION.includes(c.difference) && !c.decision);
  if (undecided.length) blockers.push(`${undecided.length} difference${undecided.length > 1 ? 's are' : ' is'} not decided yet: bill ${undecided.slice(0, 20).map((c) => c.bill_no).join(', ')}${undecided.length > 20 ? ' …' : ''}.`);
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
  const counted = comparisons.filter((c) => c.difference === 'match' || isCounted(c.decision));
  const rgById = new Map(rg.map((r) => [r.id, r]));
  const shares = discountShares(rg);
  const typeOf = (c: Comparison) => (c.register_row_id ? rgById.get(c.register_row_id)?.bill_type : c.bill_type) ?? null;
  const missingType = counted.filter((c) => !typeOf(c));
  if (missingType.length) blockers.push(`Bill ${missingType.map((c) => c.bill_no).join(', ')} has no type (F&B or Room) in the register.`);
  const neededTypes = new Set(counted.map(typeOf).filter(Boolean) as string[]);
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
      id: c.id, posNo: c.pos_no, billNo: c.bill_no, paidAt: c.paid_at, difference: c.difference, decision: c.decision, note: c.note, billType: c.bill_type,
      software: c.software_bill_id ? { amountPaise: c.sw_amount_paise, mode: c.sw_mode } : null,
      register: c.register_row_id ? { amountPaise: c.rg_amount_paise, mode: c.rg_mode, billType: rgById.get(c.register_row_id)?.bill_type ?? null, discountPaise: rgById.get(c.register_row_id)?.discount_paise ?? 0,
        rowId: c.register_row_id, uploadId: rgById.get(c.register_row_id)?.upload_id ?? null } : null,
      largeDiscount: c.register_row_id && shares.get(c.register_row_id)?.large ? shares.get(c.register_row_id) : null,
      linkedToId: c.linked_to_id ?? null,
      otherDay: others.get(c.id) ?? null,
    })),
    conflicts: conflicts.map((k) => ({
      id: k.id, billNo: k.bill_no, posNo: k.pos_no,
      existing: { paidAt: k.existing_paid_at, mode: k.existing_mode, amountPaise: k.existing_amount_paise },
      incoming: { paidAt: k.incoming_paid_at, mode: k.incoming_mode, amountPaise: k.incoming_amount_paise },
    })),
    totals,
    unknownModePaise: unknownPaise,
    // Types taken as F&B because the register's type could not be read, and not changed since.
    assumedTypes: rg.filter((r) => { try { const o = JSON.parse((r as unknown as { ocr_original?: string }).ocr_original ?? 'null'); return o && (o.inferred ?? []).includes('bill_type') && !(o.resolved ?? []).includes('bill_type'); } catch { return false; } }).map((r) => r.bill_no),
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
    const billType = r?.bill_type ?? c.bill_type ?? '';
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

export interface BillOption { billNo: string; posNo: string; amountPaise: number; mode: string; paidAt: number; amountMatches: boolean; why: 'short' | 'typo' | 'short_typo' | 'amount'; taken?: boolean }
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
    // Bills already on another register line are offered too, marked taken and listed last: the other line may be
    // the wrong one, or the bill written twice.
    for (const b of bills) {
      if (b.amount_paise === 0) continue;
      const s = digits(b.bill_no);
      const amountMatches = b.amount_paise === r.amount_paise;
      let why: BillOption['why'] | null = null;
      if (w.length >= 3 && w === s) why = 'typo'; // the same digits written with a space or a stray mark
      else if (w.length >= 3 && w.length < s.length && s.endsWith(w)) why = 'short';
      else if (w.length >= 5 && Math.abs(w.length - s.length) <= 1 && billDistance(w, s) === 1) why = 'typo';
      else if (w.length >= 3 && w.length < s.length && billDistance(w, s.slice(-w.length)) === 1 && amountMatches) why = 'short_typo';
      const taken = claimed.has(b.bill_no);
      if (why && (!taken || amountMatches || why !== 'short')) options.push({ billNo: b.bill_no, posNo: b.pos_no, amountPaise: b.amount_paise, mode: b.mode, paidAt: b.paid_at, amountMatches, why, ...(taken ? { taken } : {}) });
    }
    // With no close number (or none written), offer bills with the same amount.
    if (!options.length) {
      for (const b of free) {
        if (b.amount_paise === r.amount_paise) options.push({ billNo: b.bill_no, posNo: b.pos_no, amountPaise: b.amount_paise, mode: b.mode, paidAt: b.paid_at, amountMatches: true, why: 'amount' });
      }
    }
    options.sort((a, b) => Number(b.amountMatches) - Number(a.amountMatches) || Number(!!a.taken) - Number(!!b.taken) || WHY_ORDER[a.why] - WHY_ORDER[b.why] || a.paidAt - b.paidAt);
    out.set(r.id, { exact: false, options: options.slice(0, 6) });
  }
  return out;
}

/** The discount share of a register row's bills (its group's, when paid together), straight from the table. */
export async function largeDiscountOf(db: DB, rowId: string) {
  const rows = await all<{ id: string; amount_paise: number; discount_paise: number; tip_paise: number; paid_with_row_id: string | null }>(db, `
    SELECT id, amount_paise, discount_paise, tip_paise, paid_with_row_id FROM register_rows
    WHERE coalesce(paid_with_row_id, id) = (SELECT coalesce(paid_with_row_id, id) FROM register_rows WHERE id = ?)`, rowId);
  const net = rows.map((r) => ({ ...r, amount_paise: r.amount_paise - r.discount_paise + r.tip_paise, discount_paise: r.discount_paise - r.tip_paise }));
  return discountShares(net).get(rowId) ?? null;
}
