// Loans (approved 24 Nov 2026): money the company borrowed (taken) or lent (given, e.g. a staff salary advance), and
// deposits paid or received. Each is an account with an opening balance and lines. Money in raises what the company owes
// on a loan taken (or lowers what is owed to it on a loan given); money out the other way. An EMI's interest is not part
// of the loan: it goes under a head. Directors keep their own ledger (src/directors.ts); the Loans page shows both.
import type { DB } from './db';
import { all } from './db';

export const LOAN_KINDS = ['taken', 'given', 'deposit_paid', 'deposit_received'] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];
export const LOAN_WORD: Record<LoanKind, string> = { taken: 'Loan taken', given: 'Loan given', deposit_paid: 'Deposit paid', deposit_received: 'Deposit received' };
/** The company owes these; the others owe the company. */
export const companyOwes = (k: LoanKind) => k === 'taken' || k === 'deposit_received';
/** Lowers or raises the balance: money in raises what the company owes, money out raises what is owed to it. */
export const signOf = (k: LoanKind, direction: 'in' | 'out') => (companyOwes(k) ? (direction === 'in' ? 1 : -1) : (direction === 'out' ? 1 : -1));

export interface LoanRow { id: string; name: string; kind: LoanKind; opening_paise: number; opening_day: string | null; note: string | null }
export interface LoanEntryRow { id: string; loan_id: string; day: string; direction: 'in' | 'out'; amount_paise: number; interest_paise: number; note: string | null;
  bank_row_id: string | null; by: string | null }

export async function loansFor(db: DB, bid: string) {
  const [loans, entries, keys] = await Promise.all([
    all<LoanRow>(db, 'SELECT id, name, kind, opening_paise, opening_day, note FROM loans WHERE business_id = ? ORDER BY kind, lower(name)', bid),
    all<LoanEntryRow>(db, `SELECT e.id, e.loan_id, e.day, e.direction, e.amount_paise, e.interest_paise, e.note, e.bank_row_id, u.name AS by
      FROM loan_entries e LEFT JOIN users u ON u.id = e.created_by WHERE e.business_id = ? ORDER BY e.day, e.created_at`, bid),
    all<{ key: string; loan_id: string }>(db, 'SELECT key, loan_id FROM loan_keys WHERE business_id = ? ORDER BY key', bid),
  ]);
  return loans.map((l) => {
    const lines = entries.filter((e) => e.loan_id === l.id);
    const balance = l.opening_paise + lines.reduce((t, e) => t + signOf(l.kind, e.direction) * e.amount_paise, 0);
    return { id: l.id, name: l.name, kind: l.kind, kindWord: LOAN_WORD[l.kind], companyOwes: companyOwes(l.kind), openingPaise: l.opening_paise, openingDay: l.opening_day,
      note: l.note, balancePaise: balance, interestPaise: lines.reduce((t, e) => t + e.interest_paise, 0), keys: keys.filter((k) => k.loan_id === l.id).map((k) => k.key),
      lines: lines.map((e) => ({ id: e.id, day: e.day, direction: e.direction, amountPaise: e.amount_paise, interestPaise: e.interest_paise, note: e.note,
        fromBank: !!e.bank_row_id, by: e.by })) };
  });
}

/** Remembered UPI IDs and words, longest first, for suggesting a loan on a bank line. */
export async function loanKeys(db: DB, bid: string) {
  return (await all<{ key: string; loan_id: string; name: string; kind: LoanKind }>(db, `SELECT k.key, k.loan_id, l.name, l.kind FROM loan_keys k JOIN loans l ON l.id = k.loan_id
    WHERE k.business_id = ?`, bid).catch(() => [])).sort((a, b) => b.key.length - a.key.length);
}

/** The loan a bank line names: its UPI ID, or a remembered word in its description. Only a suggestion. */
export function loanOf(keys: Awaited<ReturnType<typeof loanKeys>>, r: { vpa: string | null; description: string }) {
  const vpa = (r.vpa ?? '').toLowerCase();
  const d = r.description.toLowerCase();
  const k = keys.find((x) => (vpa && x.key === vpa) || (x.key.length >= 4 && d.includes(x.key)));
  return k ? { id: k.loan_id, name: k.name, kind: k.kind } : null;
}
