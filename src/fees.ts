// Fee check (approved 20 Nov 2026): a day's fee report against where its money should be. See migration 0031.
// - Cash: filled into each cashier's book ("soft fill", one line per book per day); the cashier's count checks it.
// - Bank transfer and cheque: each receipt matched by a person to its bank credit (same amount, a few days around).
// - UPI and card: shown by school and cashier; matched to the apps' and machines' payouts once those accounts are added.

import { all, newId, now, stmt, type DB } from './db';
import { nameKey } from './feereport';

/** Days before and after the receipt that its bank credit is looked for. */
export const BANK_BEFORE = 3;
export const BANK_AFTER = 7;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export interface CodeMap { code: string; branchId: string | null }
export async function codeMap(db: DB, businessId: string) {
  const rows = await all<CodeMap>(db, 'SELECT code, branch_id AS branchId FROM fee_codes WHERE business_id = ?', businessId);
  return new Map(rows.map((r) => [r.code, r.branchId]));
}

interface BookRef { id: string; name: string; cashierName: string | null; openingDate: string }
/** Which book each report cashier name fills: a person's choice first, else a book whose cashier or name is that name. */
export async function cashierBooks(db: DB, businessId: string) {
  const [chosen, books] = await Promise.all([
    all<{ nameKey: string; accountId: string | null }>(db, 'SELECT name_key AS nameKey, account_id AS accountId FROM fee_cashiers WHERE business_id = ?', businessId),
    all<BookRef>(db, `SELECT a.id, a.name, u.name AS cashierName, a.opening_date AS openingDate FROM accounts a LEFT JOIN users u ON u.id = a.cashier_user_id
      WHERE a.business_id = ? AND a.kind = 'cash' AND (a.branch_id IS NOT NULL OR a.cashier_user_id IS NOT NULL) ORDER BY a.name`, businessId),
  ]);
  const picked = new Map(chosen.map((c) => [c.nameKey, c.accountId]));
  const byId = new Map(books.map((b) => [b.id, b]));
  return {
    books,
    /** The book for a report cashier name: { book, how } or null (no book yet), or 'none' (a person said: no book). */
    of(name: string | null): { book: BookRef; how: 'chosen' | 'same name' } | 'none' | null {
      if (!name) return null;
      const k = nameKey(name);
      if (picked.has(k)) { const id = picked.get(k); return id && byId.has(id) ? { book: byId.get(id)!, how: 'chosen' } : 'none'; }
      const same = books.filter((b) => (b.cashierName && nameKey(b.cashierName) === k) || nameKey(b.name) === k);
      return same.length === 1 ? { book: same[0], how: 'same name' } : null;
    },
  };
}

/** Fills the cash fees of a report into the cashier books again (one line per book), from the codes and names known now. */
export async function refillCash(db: DB, businessId: string, reportId: string, userId: string | null) {
  const [lines, codes, cb, rep] = await Promise.all([
    all<{ code: string; cashier: string | null; receiptNo: string; amountPaise: number }>(db,
      "SELECT code, cashier, receipt_no AS receiptNo, amount_paise AS amountPaise FROM fee_lines WHERE report_id = ? AND mode = 'cash'", reportId),
    codeMap(db, businessId),
    cashierBooks(db, businessId),
    all<{ day: string }>(db, 'SELECT day FROM fee_reports WHERE id = ?', reportId),
  ]);
  const day = rep[0]?.day;
  if (!day) return;
  const sums = new Map<string, { paise: number; receipts: Set<string> }>();
  for (const l of lines) {
    if (!codes.get(l.code)) continue;
    const m = cb.of(l.cashier);
    if (!m || m === 'none' || day < m.book.openingDate) continue;
    const s = sums.get(m.book.id) ?? { paise: 0, receipts: new Set<string>() };
    s.paise += l.amountPaise;
    s.receipts.add(l.receiptNo);
    sums.set(m.book.id, s);
  }
  const t = now();
  await db.batch([
    stmt(db, 'DELETE FROM cash_entries WHERE fee_report_id = ?', reportId),
    ...[...sums].filter(([, s]) => s.paise > 0).map(([bookId, s]) => stmt(db, `INSERT INTO cash_entries
      (id, business_id, account_id, day, kind, amount_paise, narration, entered_by, entered_at, created_at, fee_report_id)
      VALUES (?, ?, ?, ?, 'fee', ?, ?, ?, ?, ?, ?)`, newId(), businessId, bookId, day, s.paise,
      `Cash fees from fee report (${s.receipts.size} receipt${s.receipts.size === 1 ? '' : 's'})`, userId, t, t, reportId)),
  ]);
}

export async function refillAll(db: DB, businessId: string, userId: string | null) {
  for (const r of await all<{ id: string }>(db, 'SELECT id FROM fee_reports WHERE business_id = ?', businessId)) await refillCash(db, businessId, r.id, userId);
}

/** Bank credits that could pay a bank transfer or cheque receipt: same amount, a few days around, not used elsewhere. */
export async function receiptCandidates(db: DB, businessId: string, day: string, amountPaise: number) {
  return all<{ id: string; day: string; description: string; accountName: string }>(db, `SELECT r.id, r.day, r.description, a.name AS accountName
    FROM bank_rows r JOIN accounts a ON a.id = r.account_id
    WHERE r.business_id = ? AND r.direction = 'CR' AND r.amount_paise = ? AND r.day >= ? AND r.day <= ?
      AND NOT EXISTS (SELECT 1 FROM fee_receipt_matches m WHERE m.bank_row_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM cash_handovers h WHERE h.bank_row_id = r.id)
    ORDER BY abs(julianday(r.day) - julianday(?)), r.posted_at LIMIT 5`, businessId, amountPaise, addDays(day, -BANK_BEFORE), addDays(day, BANK_AFTER), day);
}
