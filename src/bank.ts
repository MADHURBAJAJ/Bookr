// Bank statements: import (no line twice), pairing (UPI card fees, reversals), rules, and UPI match suggestions.
// Nothing here confirms or books by itself: suggestions are shown, and a person confirms each one (or a set of
// clear ones they chose).

import { all, newId, now, one, stmt, type DB } from './db';
import type { BankLine } from './bankstatement';
import { addDays, shiftWindow } from './time';

export interface BankRow {
  id: string; account_id: string; tran_id: string; value_date: string; posted_at: number; day: string; description: string;
  direction: 'CR' | 'DR'; amount_paise: number; balance_paise: number | null; kind: string; upi_ref: string | null; vpa: string | null;
  remark: string | null; pair_row_id: string | null; status: string; transaction_id: string | null; note: string | null;
}

/** Adds the lines not already stored for this account, then pairs UPI card fees and reversals. */
export async function importLines(db: DB, businessId: string, accountId: string, lines: BankLine[]) {
  const have = new Set((await all<{ tran_id: string }>(db, 'SELECT tran_id FROM bank_rows WHERE account_id = ?', accountId)).map((r) => r.tran_id));
  const fresh = lines.filter((l) => !have.has(l.tranId));
  const t = now();
  const statements = fresh.map((l) => stmt(db, `INSERT INTO bank_rows (id, business_id, account_id, tran_id, value_date, posted_at, day, description, direction,
    amount_paise, balance_paise, kind, upi_ref, vpa, remark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, tran_id) DO NOTHING`,
    newId(), businessId, accountId, l.tranId, l.valueDate, l.postedAt, l.day, l.description, l.direction, l.amountPaise, l.balancePaise,
    l.kind, l.upiRef, l.vpa, l.remark, t));
  for (let i = 0; i < statements.length; i += 80) await db.batch(statements.slice(i, i + 80));
  await pairRows(db, accountId);
  return { added: fresh.length, skipped: lines.length - fresh.length };
}

/** A UPI card fee belongs to the credit with its ref; a reversal to the debit with its ref. */
export async function pairRows(db: DB, accountId: string) {
  await db.batch([
    stmt(db, `UPDATE bank_rows SET pair_row_id = (SELECT c.id FROM bank_rows c WHERE c.account_id = bank_rows.account_id
        AND c.upi_ref = bank_rows.upi_ref AND c.kind = 'upi_in' LIMIT 1)
      WHERE account_id = ? AND kind = 'upi_fee' AND pair_row_id IS NULL`, accountId),
    stmt(db, `UPDATE bank_rows SET pair_row_id = (SELECT d.id FROM bank_rows d WHERE d.account_id = bank_rows.account_id
        AND d.upi_ref = bank_rows.upi_ref AND d.kind = 'upi_out' AND d.amount_paise = bank_rows.amount_paise LIMIT 1)
      WHERE account_id = ? AND kind = 'reversal' AND pair_row_id IS NULL`, accountId),
  ]);
}

// ---- Rules

export interface Rule {
  id: string; position: number; name: string; direction: string | null; account_id: string | null; contains: string | null;
  vpa: string | null; min_paise: number | null; max_paise: number | null; head_id: string; party_id: string | null;
}

export const loadRules = (db: DB, businessId: string) =>
  all<Rule>(db, 'SELECT * FROM rules WHERE business_id = ? ORDER BY position, created_at', businessId);

/** The first rule that fits a line, checked top to bottom. */
export function ruleFor(rules: Rule[], r: Pick<BankRow, 'direction' | 'account_id' | 'description' | 'vpa' | 'amount_paise'>): Rule | null {
  const d = r.description.toLowerCase();
  return rules.find((x) => (!x.direction || x.direction === r.direction) && (!x.account_id || x.account_id === r.account_id)
    && (!x.contains || d.includes(x.contains.toLowerCase())) && (!x.vpa || (r.vpa ?? '') === x.vpa.toLowerCase())
    && (x.min_paise == null || r.amount_paise >= x.min_paise) && (x.max_paise == null || r.amount_paise <= x.max_paise)) ?? null;
}

// ---- UPI matching

export interface UpiIncome {
  id: string; amount_paise: number; bill_no: string | null; shift_day: string; paid_at: number | null; group_head: string | null; labels: string | null;
  /** How many UPI payments the register shows for this bill (a bill paid in two goes has two sale lines). */
  parts?: number;
}

/** Confirmed UPI sales still waiting for their bank credit, in shifts from..to. */
export const waitingUpi = (db: DB, businessId: string, from: string, to: string) => all<UpiIncome>(db, `
  SELECT t.id, t.amount_paise, t.bill_no, t.shift_day, sb.paid_at, coalesce(rr.paid_with_row_id, rr.id) AS group_head,
    (SELECT group_concat(DISTINCT p.column_label) FROM register_payments p WHERE p.register_row_id = coalesce(rr.paid_with_row_id, rr.id) AND p.mode = 'upi') AS labels,
    (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income' AND o.payment_mode = 'upi') AS parts
  FROM transactions t
  LEFT JOIN bill_comparisons c ON c.id = t.comparison_id
  LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
  LEFT JOIN register_rows rr ON rr.id = c.register_row_id
  WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match'
    AND t.matched_bank_row IS NULL AND t.shift_day BETWEEN ? AND ?`, businessId, from, to);

const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** A sale whose register column names an account label can only be paid into an account with that label. */
const labelFits = (labels: string | null, accountLabel: string | null) =>
  !labels || !accountLabel || labels.split(',').some((l) => !norm(l) || norm(l) === norm(accountLabel) || !/upi/.test(norm(l)) || norm(l) === 'upi');

const STRONG_MIN = 20;
/** Pre-ticked when paired within this many minutes. */
const TICK_MIN = 60;
const WIDE_MIN = 180;

export interface Candidate { transactionIds: string[]; billNos: string[]; amountPaise: number; minutes: number | null; strong: boolean; shiftDay: string; part: string | null }

/**
 * For each unmatched UPI credit, sales of the same amount paid near that time (a bill paid together counts as one).
 * Strong: paid within 20 minutes by the software's time. Clear: one strong sale for the credit, and that sale has no
 * other strong credit.
 */
export function upiCandidates(credits: (BankRow & { label: string | null })[], sales: UpiIncome[]) {
  const units: { ids: string[]; bills: string[]; amount: number; paidAt: number | null; shiftDay: string; labels: string | null; part: string | null }[] = [];
  const byGroup = new Map<string, UpiIncome[]>();
  for (const s of sales) {
    units.push({ ids: [s.id], bills: [s.bill_no ?? ''], amount: s.amount_paise, paidAt: s.paid_at, shiftDay: s.shift_day, labels: s.labels,
      part: (s.parts ?? 1) > 1 ? `part: 1 of ${s.parts} UPI payments` : null });
    if (s.group_head) byGroup.set(s.group_head, [...(byGroup.get(s.group_head) ?? []), s]);
  }
  for (const g of byGroup.values()) {
    if (g.length < 2) continue;
    const times = g.map((s) => s.paid_at).filter((x): x is number => x != null);
    const oneBill = new Set(g.map((s) => s.bill_no)).size === 1;
    units.push({ ids: g.map((s) => s.id), bills: [...new Set(g.map((s) => s.bill_no ?? ''))], amount: g.reduce((t, s) => t + s.amount_paise, 0),
      paidAt: times.length ? Math.max(...times) : null, shiftDay: g[0].shift_day, labels: g[0].labels, part: oneBill ? `all ${g.length} UPI payments` : null });
  }
  const out = new Map<string, Candidate[]>();
  for (const c of credits) {
    const list: Candidate[] = [];
    for (const u of units) {
      if (u.amount !== c.amount_paise || !labelFits(u.labels, c.label)) continue;
      let minutes: number | null = null;
      if (u.paidAt != null) {
        minutes = Math.round(Math.abs(c.posted_at - u.paidAt) / 60000);
        if (minutes > WIDE_MIN) continue;
      } else {
        const w = shiftWindow(u.shiftDay);
        if (c.posted_at < w.from - 3600e3 || c.posted_at > w.to + 3600e3) continue;
      }
      list.push({ transactionIds: u.ids, billNos: u.bills, amountPaise: u.amount, minutes, strong: minutes != null && minutes <= STRONG_MIN, shiftDay: u.shiftDay, part: u.part });
    }
    list.sort((a, b) => (a.minutes ?? 9999) - (b.minutes ?? 9999));
    out.set(c.id, list);
  }
  // Clear (ticked for the person): credits and sales paired by closest time first, each used once, up to an hour
  // apart. Two credits of the same amount near two bills of that amount pair up by time instead of blocking each other.
  const pairs: { creditId: string; k: Candidate }[] = [];
  for (const [id, list] of out) for (const k of list) if (k.minutes != null && k.minutes <= TICK_MIN) pairs.push({ creditId: id, k });
  pairs.sort((a, b) => a.k.minutes! - b.k.minutes!);
  const usedSale = new Set<string>();
  const clear = new Map<string, Candidate>();
  for (const p of pairs) {
    if (clear.has(p.creditId) || p.k.transactionIds.some((x) => usedSale.has(x))) continue;
    clear.set(p.creditId, p.k);
    p.k.transactionIds.forEach((x) => usedSale.add(x));
  }
  // The paired sale comes first in each credit's list, so it is the one chosen by default.
  for (const [id, k] of clear) out.set(id, [k, ...out.get(id)!.filter((x) => x !== k)]);
  return { candidates: out, clear };
}

/** Unmatched UPI credits on days from..to, with the label of the account they came into. */
export const unmatchedCredits = (db: DB, businessId: string, from: string, to: string) => all<BankRow & { label: string | null; account_name: string }>(db, `
  SELECT r.*, s.receives_upi_label AS label, a.name AS account_name FROM bank_rows r
  JOIN accounts a ON a.id = r.account_id LEFT JOIN bank_sources s ON s.account_id = r.account_id
  WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.day BETWEEN ? AND ?
  ORDER BY r.posted_at`, businessId, from, to);

/** Credits and sales around a set of days: sales of the day before and after can be paid across midnight or 8 am. */
export async function suggestionsFor(db: DB, businessId: string, from: string, to: string) {
  const [credits, sales] = await Promise.all([unmatchedCredits(db, businessId, from, to), waitingUpi(db, businessId, addDays(from, -1), addDays(to, 1))]);
  return { credits, sales, ...upiCandidates(credits, sales) };
}

/** Statements that match a credit to sales: checked by the caller. */
export function matchStatements(db: DB, businessId: string, rowId: string, transactionIds: string[], userId: string, t: number) {
  return [
    ...transactionIds.flatMap((tid) => [
      stmt(db, `INSERT INTO bank_matches (id, business_id, bank_row_id, transaction_id, amount_paise, matched_by, matched_at)
        SELECT ?, ?, ?, id, amount_paise, ?, ? FROM transactions WHERE id = ?`, newId(), businessId, rowId, userId, t, tid),
      stmt(db, "UPDATE transactions SET matched_bank_row = ?, match_status = NULL WHERE id = ? AND matched_bank_row IS NULL AND match_status = 'awaiting_bank_match'", rowId, tid),
    ]),
    stmt(db, "UPDATE bank_rows SET status = 'matched', done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", userId, t, rowId),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'bank.match', 'bank_rows', ?, NULL, ?, ?)`, businessId, userId, rowId, JSON.stringify({ transactionIds }), t),
  ];
}

export const getRow = (db: DB, businessId: string, id: string) =>
  one<BankRow>(db, 'SELECT * FROM bank_rows WHERE id = ? AND business_id = ?', id, businessId);

/**
 * Splits credits over bills, in order: each bill takes from the credits until it is paid. Used when several credits
 * pay one or more bills (e.g. a guest paying in two goes). Totals must already agree (any difference is booked apart).
 */
export function allocate(credits: { id: string; amount: number }[], bills: { id: string; amount: number }[]) {
  const links: { rowId: string; transactionId: string; amount: number }[] = [];
  const left = credits.map((c) => ({ ...c }));
  let i = 0;
  for (const b of bills) {
    let need = b.amount;
    while (need > 0 && i < left.length) {
      const take = Math.min(need, left[i].amount);
      if (take > 0) links.push({ rowId: left[i].id, transactionId: b.id, amount: take });
      need -= take;
      left[i].amount -= take;
      if (left[i].amount === 0) i += 1;
    }
  }
  return links;
}

/** Every credit tied to this one through shared bills: they are matched, and unmatched, together. */
export async function matchedSet(db: DB, rowId: string) {
  let rows = new Set([rowId]);
  for (let round = 0; round < 10; round += 1) {
    const list = [...rows];
    // Tied by a shared bill, or matched in the same action (same time and person): undone together.
    const q = list.map(() => '?').join(',');
    const found = await all<{ bank_row_id: string; transaction_id: string }>(db, `SELECT bank_row_id, transaction_id FROM bank_matches
      WHERE transaction_id IN (SELECT transaction_id FROM bank_matches WHERE bank_row_id IN (${q}))
         OR EXISTS (SELECT 1 FROM bank_matches x WHERE x.bank_row_id IN (${q}) AND x.matched_at = bank_matches.matched_at AND x.matched_by IS bank_matches.matched_by)`, ...list, ...list);
    const next = new Set([...rows, ...found.map((f) => f.bank_row_id)]);
    if (next.size === rows.size) return { rows: [...rows], transactions: [...new Set(found.map((f) => f.transaction_id))] };
    rows = next;
  }
  return { rows: [...rows], transactions: [] as string[] };
}
