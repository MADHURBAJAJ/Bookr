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
  openingBalancePaise: number; openingDate: string;
}
const BOOK_SQL = `SELECT a.id, a.name, a.branch_id AS branchId, b.name AS branchName, a.cashier_user_id AS cashierUserId, u.name AS cashierName,
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
export async function inHandThrough(db: DB, book: { id: string; openingBalancePaise: number; openingDate: string }, through: string) {
  const r = await one<{ s: number | null }>(db, `SELECT sum(${SIGNED}) AS s FROM cash_entries e WHERE e.account_id = ? AND e.day >= ? AND e.day <= ?`,
    book.id, book.openingDate, through);
  return book.openingBalancePaise + (r?.s ?? 0);
}

export interface EntryRow {
  id: string; day: string; kind: EntryKind; amountPaise: number; narration: string | null; headId: string | null; headName: string | null;
  partyName: string | null; enteredBy: string | null; enteredByName: string | null; enteredAt: number;
  /** Filled from the day's fee report (soft fill): its amount comes from the report. */
  feeReportId: string | null;
  handover: HandoverRow | null;
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
  const [opening, lines, count, sent, incoming] = await Promise.all([
    day <= book.openingDate ? Promise.resolve(book.openingBalancePaise) : inHandThrough(db, book, prev),
    all<Omit<EntryRow, 'handover'>>(db, `SELECT e.id, e.day, e.kind, e.amount_paise AS amountPaise, e.narration, e.head_id AS headId, h.name AS headName,
        p.name AS partyName, e.entered_by AS enteredBy, u.name AS enteredByName, e.entered_at AS enteredAt, e.fee_report_id AS feeReportId
      FROM cash_entries e LEFT JOIN heads h ON h.id = e.head_id LEFT JOIN parties p ON p.id = e.party_id LEFT JOIN users u ON u.id = e.entered_by
      WHERE e.account_id = ? AND e.day = ? ORDER BY e.entered_at`, book.id, day),
    one<{ countedPaise: number; countedAt: number; countedByName: string | null }>(db, `SELECT c.counted_paise AS countedPaise, c.counted_at AS countedAt,
        u.name AS countedByName FROM cash_counts c LEFT JOIN users u ON u.id = c.counted_by WHERE c.account_id = ? AND c.day = ?`, book.id, day),
    handovers(db, businessId, 'AND o.account_id = ? AND o.day = ?', book.id, day),
    handovers(db, businessId, `AND h.to_kind = 'book' AND h.to_account_id = ? AND (h.status = 'sent' OR (h.to_entry_id IN (SELECT id FROM cash_entries WHERE account_id = ? AND day = ?)))`,
      book.id, book.id, day),
  ]);
  const byFrom = new Map(sent.map((h) => [h.fromEntryId, h]));
  const byTo = new Map(incoming.filter((h) => h.toEntryId).map((h) => [h.toEntryId!, h]));
  const entries: EntryRow[] = lines.map((e) => ({ ...e, handover: byFrom.get(e.id) ?? byTo.get(e.id) ?? null }));
  const total = (kinds: readonly string[]) => entries.filter((e) => kinds.includes(e.kind)).reduce((t, e) => t + e.amountPaise, 0);
  const inPaise = total(IN_KINDS);
  const outPaise = total(OUT_KINDS);
  const shouldPaise = opening + inPaise - outPaise;
  return {
    book, day, before: day < book.openingDate, openingPaise: opening, entries, inPaise, outPaise, shouldPaise,
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
