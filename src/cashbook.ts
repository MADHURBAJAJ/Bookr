// School cash book (approved 20 Nov 2026): each cashier keeps their own book on the phone. A book is a cash account
// with a branch and a cashier (migration 0030). What should be in hand on a day = the book's opening balance + every
// line from its opening date to that day (money in adds, money out takes away). Cash handed over waits as "sent" until
// the other side shows it: the receiving book accepts it, the owner ticks a person's, or the deposit is matched in the
// bank statement.

import { all, one, type DB } from './db';
import { fail } from './http';
import type { Role } from './permissions';

export const IN_KINDS = ['fee', 'other_in', 'handover_in'] as const;
export const OUT_KINDS = ['expense', 'other_out', 'handover_out'] as const;
export type EntryKind = (typeof IN_KINDS)[number] | (typeof OUT_KINDS)[number];
/** Days after the handover that a bank deposit of its amount is looked for. */
export const DEPOSIT_DAYS = 7;

const SIGNED = `CASE WHEN e.kind IN ('fee', 'other_in', 'handover_in') THEN e.amount_paise ELSE -e.amount_paise END`;
/** Owner, Accountant and Viewer see every book; a cashier (Entry staff) only the books they keep. */
export const seesAllBooks = (role: Role) => role !== 'entry_staff';

export interface Book {
  id: string; name: string; branchId: string | null; branchName: string | null; cashierUserId: string | null; cashierName: string | null;
  openingBalancePaise: number; openingDate: string; cashierRole?: string | null;
}
const BOOK_SQL = `SELECT a.id, a.name, a.branch_id AS branchId, b.name AS branchName, a.cashier_user_id AS cashierUserId, u.name AS cashierName,
    (SELECT m.role FROM memberships m WHERE m.user_id = a.cashier_user_id AND m.business_id = a.business_id) AS cashierRole,
    a.opening_balance_paise AS openingBalancePaise, a.opening_date AS openingDate
  FROM accounts a LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN users u ON u.id = a.cashier_user_id
  WHERE a.business_id = ? AND a.kind = 'cash' AND (a.branch_id IS NOT NULL OR a.cashier_user_id IS NOT NULL)`;

export async function booksOf(db: DB, businessId: string, userId: string, role: Role): Promise<Book[]> {
  return seesAllBooks(role)
    ? all<Book>(db, `${BOOK_SQL} ORDER BY b.name, a.name`, businessId)
    : all<Book>(db, `${BOOK_SQL} AND a.cashier_user_id = ? ORDER BY b.name, a.name`, businessId, userId);
}

/** The book, if the caller may see it; 404 otherwise (a cashier cannot probe other books). */
export async function bookFor(db: DB, businessId: string, accountId: string, userId: string, role: Role): Promise<Book> {
  const b = await one<Book>(db, `${BOOK_SQL} AND a.id = ?`, businessId, accountId);
  if (!b || (!seesAllBooks(role) && b.cashierUserId !== userId)) fail(404, 'Cash book not found.');
  return b;
}

/** Cash the book should hold at the end of each day up to `through` (lines before its opening date are left out). */
export async function inHandThrough(db: DB, book: { id: string; branchId: string | null; openingBalancePaise: number; openingDate: string }, through: string) {
  const [r, adj] = await Promise.all([
    one<{ s: number | null }>(db, `SELECT sum(${SIGNED}) AS s FROM cash_entries e WHERE e.account_id = ? AND e.day >= ? AND e.day <= ?`,
      book.id, book.openingDate, through),
    // A fee total the cashier typed counts only until the day's fee sheet is in (then the sheet's cash counts).
    feeAdjust(db, book, book.openingDate, through),
  ]);
  return book.openingBalancePaise + (r?.s ?? 0) + adj;
}

export interface EntryRow {
  id: string; day: string; kind: EntryKind; amountPaise: number; narration: string | null; headId: string | null; headName: string | null;
  partyName: string | null; enteredBy: string | null; enteredByName: string | null; enteredAt: number;
  /** Filled from the day's fee report (soft fill): its amount comes from the report. */
  feeReportId: string | null;
  /** An expense or other money in: the owner's review (null = waiting), who and the note. */
  reviewStatus: 'approved' | 'rejected' | null; reviewNote: string | null; reviewedByName: string | null;
  /** Last change (audit log), if the line was edited. */
  editedAt: number | null; editedByName: string | null;
  /** Written by the Owner settling a count (changed only by undoing the settle). */
  fromSettle: number;
  handover: HandoverRow | null;
  changedAfterCount: boolean;
}
export interface HandoverRow {
  id: string; fromEntryId: string; fromAccountId: string; fromBookName: string; day: string; amountPaise: number; narration: string | null;
  toKind: 'book' | 'person' | 'bank'; toAccountId: string | null; toName: string; status: 'sent' | 'received' | 'deposited';
  toEntryId: string | null; bankRowId: string | null; settledAt: number | null; settledByName: string | null;
}
const HANDOVER_SQL = `SELECT h.id, h.from_entry_id AS fromEntryId, o.account_id AS fromAccountId, fa.name AS fromBookName, o.day, o.amount_paise AS amountPaise,
    o.narration, h.to_kind AS toKind, h.to_account_id AS toAccountId, coalesce(ta.name, p.name) AS toName, h.status,
    h.to_entry_id AS toEntryId, h.bank_row_id AS bankRowId, h.settled_at AS settledAt, su.name AS settledByName
  FROM cash_handovers h JOIN cash_entries o ON o.id = h.from_entry_id JOIN accounts fa ON fa.id = o.account_id
  LEFT JOIN accounts ta ON ta.id = h.to_account_id LEFT JOIN parties p ON p.id = h.to_party_id LEFT JOIN users su ON su.id = h.settled_by
  WHERE h.business_id = ?`;

export async function handovers(db: DB, businessId: string, where = '', ...params: unknown[]) {
  return all<HandoverRow>(db, `${HANDOVER_SQL} ${where} ORDER BY o.day DESC, o.entered_at DESC`, businessId, ...params);
}

/** One day of a book: opening, its lines (each handover with where it went), the count, and cash sent to it waiting. */
export async function bookDay(db: DB, businessId: string, book: Book, day: string) {
  const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const [opening, lines, count, sent, incoming, fee] = await Promise.all([
    day <= book.openingDate ? Promise.resolve(book.openingBalancePaise) : inHandThrough(db, book, prev),
    all<Omit<EntryRow, 'handover' | 'changedAfterCount'>>(db, `SELECT e.id, e.day, e.kind, e.amount_paise AS amountPaise, e.narration, e.head_id AS headId, h.name AS headName,
        p.name AS partyName, e.entered_by AS enteredBy, u.name AS enteredByName, e.entered_at AS enteredAt, e.fee_report_id AS feeReportId,
        e.review_status AS reviewStatus, e.review_note AS reviewNote, ru.name AS reviewedByName,
        EXISTS (SELECT 1 FROM cash_counts k WHERE k.settle_entry_id = e.id) AS fromSettle,
        (SELECT l.created_at FROM audit_log l WHERE l.row_table = 'cash_entries' AND l.row_id = e.id AND l.action = 'cashbook.entry.edit' ORDER BY l.id DESC LIMIT 1) AS editedAt,
        (SELECT lu.name FROM audit_log l LEFT JOIN users lu ON lu.id = l.user_id
          WHERE l.row_table = 'cash_entries' AND l.row_id = e.id AND l.action = 'cashbook.entry.edit' ORDER BY l.id DESC LIMIT 1) AS editedByName
      FROM cash_entries e LEFT JOIN heads h ON h.id = e.head_id LEFT JOIN parties p ON p.id = e.party_id LEFT JOIN users u ON u.id = e.entered_by
        LEFT JOIN users ru ON ru.id = e.reviewed_by
      WHERE e.account_id = ? AND e.day = ? ORDER BY e.entered_at`, book.id, day),
    one<{ countedPaise: number; countedAt: number; countedByName: string | null; note: string | null; settle: string | null; settleNote: string | null;
      settleGapPaise: number | null; settledByName: string | null; settledAt: number | null }>(db, `SELECT c.counted_paise AS countedPaise, c.counted_at AS countedAt,
        u.name AS countedByName, c.note, c.settle, c.settle_note AS settleNote, c.settle_gap_paise AS settleGapPaise, su.name AS settledByName, c.settled_at AS settledAt
      FROM cash_counts c LEFT JOIN users u ON u.id = c.counted_by LEFT JOIN users su ON su.id = c.settled_by WHERE c.account_id = ? AND c.day = ?`, book.id, day),
    handovers(db, businessId, 'AND o.account_id = ? AND o.day = ?', book.id, day),
    handovers(db, businessId, `AND h.to_kind = 'book' AND h.to_account_id = ? AND (h.status = 'sent' OR (h.to_entry_id IN (SELECT id FROM cash_entries WHERE account_id = ? AND day = ?)))`,
      book.id, book.id, day),
    feeChecks(db, book, day, day, true).then((f) => f[0] ?? null),
  ]);
  const byFrom = new Map(sent.map((h) => [h.fromEntryId, h]));
  const byTo = new Map(incoming.filter((h) => h.toEntryId).map((h) => [h.toEntryId!, h]));
  // Written or changed after the day was counted (22 Nov 2026): the count no longer matches what was checked.
  const entries: EntryRow[] = lines.map((e) => ({ ...e, handover: byFrom.get(e.id) ?? byTo.get(e.id) ?? null,
    changedAfterCount: !!count && !count.settle && Math.max(e.enteredAt, e.editedAt ?? 0) > count.countedAt }));
  const total = (kinds: readonly string[]) => entries.filter((e) => kinds.includes(e.kind)).reduce((t, e) => t + e.amountPaise, 0);
  const inPaise = total(IN_KINDS);
  const outPaise = total(OUT_KINDS);
  // The typed fee total counts only what fee.countsPaise says (all of it until the sheet is in).
  const feeAdj = fee && fee.typedPaise != null ? fee.countsPaise - fee.typedPaise : 0;
  const shouldPaise = opening + inPaise - outPaise + feeAdj;
  return {
    book, day, before: day < book.openingDate, openingPaise: opening, entries, inPaise, outPaise, shouldPaise, fee,
    count: count ? { ...count, gapPaise: count.countedPaise - shouldPaise } : null,
    waiting: incoming.filter((h) => h.status === 'sent'),
  };
}

/** Bank credits that could be a cash deposit: same amount, into that bank account, within DEPOSIT_DAYS of the handover, not used. */
export async function depositCandidates(db: DB, businessId: string, h: Pick<HandoverRow, 'id' | 'toAccountId' | 'amountPaise' | 'day'>) {
  const to = new Date(Date.parse(`${h.day}T00:00:00Z`) + DEPOSIT_DAYS * 86400000).toISOString().slice(0, 10);
  return all<{ id: string; day: string; description: string; amountPaise: number }>(db, `SELECT r.id, r.day, r.description, r.amount_paise AS amountPaise
    FROM bank_rows r WHERE r.business_id = ? AND r.account_id = ? AND r.direction = 'CR' AND r.amount_paise = ? AND r.day >= ? AND r.day <= ?
      AND NOT EXISTS (SELECT 1 FROM cash_handovers x WHERE x.bank_row_id = r.id) ORDER BY r.day, r.posted_at`,
    businessId, h.toAccountId, h.amountPaise, h.day, to);
}

// ---- The cashier's fee cash total against the fee day sheet (approved 21 Nov 2026, migration 0033).
// At the end of the day the cashier enters one total of the cash fees taken (a typed 'fee' line: no fee_report_id), with
// the number of receipts and the first and last receipt no. if they like. Until the sheet is in, the book counts that
// total. Once the sheet is in for the book's school that day, the book uses the sheet's cash (the soft-filled line) and the
// typed total only shows the difference:
//   agrees       same amount
//   less         the sheet has less than the cashier entered: bring the sheet in again, keep the amount ('kept': the
//                difference stays in the book as "fee not in sheet"), or say the sheet is right ('sheet')
//   more         the sheet has more: the book uses the sheet; the cashier says the sheet is right
// A kept difference clears itself when every receipt of the cashier's range that the sheet did not have turns up in a later
// day's sheet (that day's sheet then counts it, so it is never counted twice).

export type FeeState = 'waiting' | 'agrees' | 'less' | 'more' | 'kept' | 'sheet' | 'cleared' | 'sheet only';
export interface FeeCheck {
  day: string;
  entryId: string | null; typedPaise: number | null; receipts: number | null; first: string | null; last: string | null; settle: 'kept' | 'sheet' | null;
  sheetIn: boolean; sheetPaise: number; sheetReceipts: number;
  /** Typed total less the sheet's cash, once the sheet is in. */
  diffPaise: number;
  /** Receipt numbers in the cashier's first–last range that the day's sheet does not have. */
  missing: string[];
  /** What the typed total adds to the book that day (the sheet's own line is counted as it is). */
  countsPaise: number;
  state: FeeState | null;
}

const KEPT_LOOK_DAYS = 31;
const MAX_RANGE = 500;
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** A receipt number as prefix + running number ("26SMSSMS0408" → 26SMSSMS, 408; "0408" → '', 408). */
export function splitReceipt(s: string | null | undefined) {
  const m = /^(.*?)(\d+)$/.exec(String(s ?? '').replace(/\s+/g, '').toUpperCase());
  return m ? { prefix: m[1], n: Number(m[2]), width: m[2].length } : null;
}
/** The first–last range the cashier typed, if it can be read (same prefix, last not before first, at most MAX_RANGE). */
export function receiptRange(first: string | null, last: string | null) {
  const a = splitReceipt(first);
  const b = splitReceipt(last);
  if (!a || !b) return null;
  if (a.prefix && b.prefix && a.prefix !== b.prefix) return null;
  if (b.n < a.n || b.n - a.n >= MAX_RANGE) return null;
  return { prefix: a.prefix || b.prefix, from: a.n, to: b.n, width: a.width };
}

interface TypedRow { id: string; day: string; amountPaise: number; receipts: number | null; first: string | null; last: string | null; settle: 'kept' | 'sheet' | null }
type FeeBook = { id: string; branchId: string | null; openingDate: string };

/** Fee checks of a book's days from..through: every day with a typed total, and (withSheetOnly) every day with a sheet. */
export async function feeChecks(db: DB, book: FeeBook, from: string, through: string, withSheetOnly = false): Promise<FeeCheck[]> {
  if (through < from) return [];
  const typed = await all<TypedRow>(db, `SELECT id, day, amount_paise AS amountPaise, fee_receipts AS receipts,
      fee_first AS first, fee_last AS last, fee_settle AS settle
    FROM cash_entries WHERE account_id = ? AND kind = 'fee' AND fee_report_id IS NULL AND day >= ? AND day <= ? ORDER BY day, entered_at`, book.id, from, through);
  if (!typed.length && !withSheetOnly) return [];
  const acct = await one<{ businessId: string }>(db, 'SELECT business_id AS businessId FROM accounts WHERE id = ?', book.id);
  if (!acct) return [];
  const bid = acct.businessId;
  const [sheetRows, covered] = await Promise.all([
    all<{ day: string; paise: number; narration: string | null }>(db, `SELECT day, sum(amount_paise) AS paise, max(narration) AS narration FROM cash_entries
      WHERE account_id = ? AND fee_report_id IS NOT NULL AND day >= ? AND day <= ? GROUP BY day`, book.id, from, through),
    book.branchId ? all<{ day: string }>(db, `SELECT DISTINCT r.day FROM fee_reports r JOIN fee_lines l ON l.report_id = r.id
      JOIN fee_codes c ON c.business_id = r.business_id AND c.code = l.code
      WHERE r.business_id = ? AND c.branch_id = ? AND r.day >= ? AND r.day <= ?`, bid, book.branchId, from, through) : Promise.resolve([]),
  ]);
  const sheet = new Map(sheetRows.map((s) => [s.day, s]));
  const sheetDays = new Set([...sheetRows.map((s) => s.day), ...covered.map((c) => c.day)]);
  const byDay = new Map<string, TypedRow[]>();
  for (const t of typed) byDay.set(t.day, [...(byDay.get(t.day) ?? []), t]);
  const days = [...new Set([...byDay.keys(), ...(withSheetOnly ? sheetDays : [])])].filter((d) => d >= book.openingDate).sort();
  let codes: Map<string, string | null> | null = null;
  const out: FeeCheck[] = [];
  for (const day of days) {
    const rows = byDay.get(day) ?? [];
    const last = rows[rows.length - 1];
    const typedPaise = rows.length ? rows.reduce((t, r) => t + r.amountPaise, 0) : null;
    const s = sheet.get(day);
    const sheetIn = sheetDays.has(day);
    const c: FeeCheck = { day, entryId: last?.id ?? null, typedPaise, receipts: last?.receipts ?? null, first: last?.first ?? null, last: last?.last ?? null,
      settle: last?.settle ?? null, sheetIn, sheetPaise: s?.paise ?? 0, sheetReceipts: Number(/\((\d+) receipt/.exec(s?.narration ?? '')?.[1] ?? 0),
      diffPaise: 0, missing: [], countsPaise: typedPaise ?? 0, state: null };
    out.push(c);
    if (typedPaise == null) { c.state = sheetIn ? 'sheet only' : null; continue; }
    if (!sheetIn) { c.state = 'waiting'; continue; }
    c.diffPaise = typedPaise - c.sheetPaise;
    const range = receiptRange(c.first, c.last);
    if (c.diffPaise > 0 && range) {
      codes ??= new Map((await all<{ code: string; branchId: string | null }>(db, 'SELECT code, branch_id AS branchId FROM fee_codes WHERE business_id = ?', bid)).map((x) => [x.code, x.branchId]));
      const cm = codes;
      const isNo = (r: { receiptNo: string; code: string }, n: number) => {
        const sp = splitReceipt(r.receiptNo);
        return !!sp && sp.n === n && (range.prefix ? sp.prefix === range.prefix : cm.get(r.code) === book.branchId);
      };
      const lines = await all<{ receiptNo: string; code: string }>(db, `SELECT DISTINCT l.receipt_no AS receiptNo, l.code FROM fee_lines l
        JOIN fee_reports r ON r.id = l.report_id WHERE r.business_id = ? AND r.day = ?`, bid, day);
      for (let n = range.from; n <= range.to; n++) {
        if (!lines.some((l) => isNo(l, n))) c.missing.push(`${range.prefix}${String(n).padStart(range.width, '0')}`);
      }
      if (c.settle === 'kept' && c.missing.length) {
        const later = await all<{ receiptNo: string; code: string }>(db, `SELECT DISTINCT l.receipt_no AS receiptNo, l.code FROM fee_lines l
          JOIN fee_reports r ON r.id = l.report_id WHERE r.business_id = ? AND r.day > ? AND r.day <= ?`, bid, day, addDay(day, KEPT_LOOK_DAYS));
        if (c.missing.every((m) => { const n = splitReceipt(m)!.n; return later.some((l) => isNo(l, n)); })) c.state = 'cleared';
      }
    }
    if (c.state !== 'cleared') {
      c.state = c.diffPaise === 0 ? 'agrees' : c.settle === 'sheet' ? 'sheet' : c.settle === 'kept' && c.diffPaise > 0 ? 'kept' : c.diffPaise > 0 ? 'less' : 'more';
    }
    c.countsPaise = c.state === 'kept' ? c.diffPaise : 0;
  }
  return out;
}

/** What the typed fee totals change in the book from..through, against counting each of them in full. */
export async function feeAdjust(db: DB, book: FeeBook, from: string, through: string) {
  return (await feeChecks(db, book, from, through)).reduce((t, c) => t + c.countsPaise - (c.typedPaise ?? 0), 0);
}

/** Each day of a book from..through: what should be in hand at its end, the fee check and the count. */
export async function bookDays(db: DB, book: Book, from: string, through: string) {
  const start = from < book.openingDate ? book.openingDate : from;
  if (through < start) return [];
  const [opening, sums, fees, counts] = await Promise.all([
    start <= book.openingDate ? Promise.resolve(book.openingBalancePaise) : inHandThrough(db, book, addDay(start, -1)),
    all<{ day: string; s: number }>(db, `SELECT e.day, sum(${SIGNED}) AS s FROM cash_entries e WHERE e.account_id = ? AND e.day >= ? AND e.day <= ? GROUP BY e.day`, book.id, start, through),
    feeChecks(db, book, start, through, true),
    all<{ day: string; countedPaise: number; note: string | null }>(db, 'SELECT day, counted_paise AS countedPaise, note FROM cash_counts WHERE account_id = ? AND day >= ? AND day <= ?', book.id, start, through),
  ]);
  const sum = new Map(sums.map((x) => [x.day, x.s]));
  const fee = new Map(fees.map((f) => [f.day, f]));
  const count = new Map(counts.map((k) => [k.day, k]));
  const out: { day: string; shouldPaise: number; fee: FeeCheck | null; count: { countedPaise: number; gapPaise: number; note: string | null } | null }[] = [];
  let run = opening;
  for (let d = start; d <= through; d = addDay(d, 1)) {
    const f = fee.get(d) ?? null;
    run += (sum.get(d) ?? 0) + (f ? f.countsPaise - (f.typedPaise ?? 0) : 0);
    const k = count.get(d);
    out.push({ day: d, shouldPaise: run, fee: f, count: k ? { countedPaise: k.countedPaise, gapPaise: k.countedPaise - run, note: k.note } : null });
  }
  return out;
}
