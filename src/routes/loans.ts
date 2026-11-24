// Loans (approved 24 Nov 2026): see src/loans.ts. Read by Owner, Accountant and Viewer; changed by Owner and Accountant
// (a bank line also needs the bank role). Every change is audited; a line from the bank is undone by opening that line
// again on Bank (Done), which takes its rows away.
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { newId, now, one, stmt } from '../db';
import { body, date, fail, isUuid, optionalPaise, paise, text } from '../http';
import { can } from '../permissions';
import { getRow } from '../bank';
import { LOAN_KINDS, LOAN_WORD, loansFor, signOf, type LoanKind } from '../loans';

export const loanRoutes = new Hono<AppEnv>();
const AUDIT = `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const kindOf = (v: unknown): LoanKind => ((LOAN_KINDS as readonly string[]).includes(v as string) ? v as LoanKind : fail(400, 'Choose the type: loan taken, loan given, deposit paid or deposit received.'));
const loanName = (data: Record<string, unknown>) => text(data, 'name', 'Name', { max: 80 })!;

loanRoutes.get('/businesses/:businessId/loans', requireRole('reports.view'), async (c) => c.json({ loans: await loansFor(c.env.DB, c.get('businessId')), kinds: LOAN_WORD }));

/** A new loan or deposit account, with its opening balance (what is owed on the day it starts). */
loanRoutes.post('/businesses/:businessId/loans', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const name = loanName(data);
  const kind = kindOf(data.kind);
  const opening = optionalPaise(data, 'opening', 'Opening balance') ?? 0;
  const openingDay = opening ? date(data, 'openingDay', 'Opening day') : null;
  if (await one(db, 'SELECT 1 AS x FROM loans WHERE business_id = ? AND lower(name) = lower(?)', bid, name)) fail(409, 'A loan with this name is already there.');
  const id = newId();
  const t = now();
  await db.batch([
    stmt(db, 'INSERT INTO loans (id, business_id, name, kind, opening_paise, opening_day, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, bid, name, kind, opening, openingDay, text(data, 'note', 'Note', { optional: true, max: 200 }), c.get('user').id, t),
    stmt(db, AUDIT, bid, c.get('user').id, 'loans.add', 'loans', id, null, JSON.stringify({ name, kind, openingPaise: opening, changes: `${LOAN_WORD[kind]}: ${name}${opening ? `, opening ${rs(opening)}` : ''}` }), t),
  ]);
  return c.json({ ok: true, id });
});

/** Rename, or change the opening balance. */
loanRoutes.put('/businesses/:businessId/loans/:id', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const old = isUuid(id) ? await one<Record<string, unknown> & { name: string; opening_paise: number; opening_day: string | null }>(db, 'SELECT * FROM loans WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!old) fail(404, 'Not found.');
  const data = await body(c);
  const name = data.name === undefined ? old.name : loanName(data);
  const opening = data.opening === undefined ? old.opening_paise : optionalPaise(data, 'opening', 'Opening balance') ?? 0;
  const openingDay = data.openingDay === undefined ? old.opening_day : opening ? date(data, 'openingDay', 'Opening day') : null;
  if (name.toLowerCase() !== old.name.toLowerCase() && await one(db, 'SELECT 1 AS x FROM loans WHERE business_id = ? AND lower(name) = lower(?)', bid, name)) fail(409, 'A loan with this name is already there.');
  await db.batch([
    stmt(db, 'UPDATE loans SET name = ?, opening_paise = ?, opening_day = ? WHERE id = ?', name, opening, openingDay, id),
    stmt(db, AUDIT, bid, c.get('user').id, 'loans.edit', 'loans', id, JSON.stringify(old), JSON.stringify({ name, openingPaise: opening, openingDay }), now()),
  ]);
  return c.json({ ok: true });
});

/** Removed only while it has no lines. */
loanRoutes.delete('/businesses/:businessId/loans/:id', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const old = isUuid(id) ? await one<Record<string, unknown>>(db, 'SELECT * FROM loans WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!old) fail(404, 'Not found.');
  if (await one(db, 'SELECT 1 AS x FROM loan_entries WHERE loan_id = ?', id)) fail(409, 'This loan has lines: take them out first.');
  await db.batch([stmt(db, 'DELETE FROM loans WHERE id = ?', id), stmt(db, AUDIT, bid, c.get('user').id, 'loans.remove', 'loans', id, JSON.stringify(old), null, now())]);
  return c.json({ ok: true });
});

/** A line typed in (cash, or money that did not pass through a bank account here): only the loan's balance changes. */
loanRoutes.post('/businesses/:businessId/loans/:id/entries', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const loan = isUuid(id) ? await one<{ name: string; kind: LoanKind }>(db, 'SELECT name, kind FROM loans WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!loan) fail(404, 'Not found.');
  const data = await body(c);
  const direction = data.direction === 'in' || data.direction === 'out' ? data.direction : fail(400, 'Choose money in or money out.');
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than zero.');
  const day = date(data, 'day', 'Day');
  const note = text(data, 'note', 'Note', { optional: true, max: 200 });
  const e = newId();
  const t = now();
  await db.batch([
    stmt(db, `INSERT INTO loan_entries (id, business_id, loan_id, day, direction, amount_paise, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e, bid, id, day, direction, amount, note, c.get('user').id, t),
    stmt(db, AUDIT, bid, c.get('user').id, 'loans.entry', 'loan_entries', e, null, JSON.stringify({ loan: loan!.name, direction, amountPaise: amount, day,
      changes: `${loan!.name}: ${direction === 'in' ? 'money in' : 'money out'} ${rs(amount)} (${signOf(loan!.kind, direction) > 0 ? 'balance up' : 'balance down'})` }), t),
  ]);
  return c.json({ ok: true, id: e });
});

loanRoutes.delete('/businesses/:businessId/loan-entries/:id', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const e = isUuid(id) ? await one<Record<string, unknown> & { bank_row_id: string | null }>(db, 'SELECT * FROM loan_entries WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!e) fail(404, 'Not found.');
  if (e.bank_row_id) fail(409, 'This line came from the bank: open that line again on Bank → Done.');
  await db.batch([stmt(db, 'DELETE FROM loan_entries WHERE id = ?', id), stmt(db, AUDIT, bid, c.get('user').id, 'loans.entry_removed', 'loan_entries', id, JSON.stringify(e), null, now())]);
  return c.json({ ok: true });
});

/** Forget a remembered UPI ID or word. */
loanRoutes.post('/businesses/:businessId/loans/:id/forget', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const key = text(await body(c), 'key', 'Word', { max: 80 })!.toLowerCase();
  await db.batch([stmt(db, 'DELETE FROM loan_keys WHERE business_id = ? AND key = ? AND loan_id = ?', bid, key, c.req.param('id')),
    stmt(db, AUDIT, bid, c.get('user').id, 'loans.forget', 'loans', c.req.param('id'), JSON.stringify({ key }), null, now())]);
  return c.json({ ok: true });
});

/**
 * A bank line booked to a loan: money in or out of a loan or deposit, not income or an expense. The line is booked to a
 * transfer row with no other account; an EMI's interest (or interest received on a loan given) is a second row under a
 * head. Opening the line again on Bank takes both rows and the loan's line away.
 */
loanRoutes.post('/businesses/:businessId/bank-rows/:rowId/loan', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  if (!can(c.get('role'), 'rows.approve')) fail(403, 'Only an Owner or Accountant books to a loan.');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'unmatched' || row.kind === 'card_settlement') fail(409, 'This line is already matched, booked or ignored.');
  const data = await body(c);
  const t = now();
  const user = c.get('user').id;
  const s: D1PreparedStatement[] = [];
  let loan: { id: string; name: string; kind: LoanKind } | null = null;
  if (typeof data.loanId === 'string') loan = isUuid(data.loanId) ? await one(db, 'SELECT id, name, kind FROM loans WHERE id = ? AND business_id = ?', data.loanId, bid) : null;
  else if (data.newLoan && typeof data.newLoan === 'object') {
    const n = data.newLoan as Record<string, unknown>;
    const name = loanName(n);
    if (await one(db, 'SELECT 1 AS x FROM loans WHERE business_id = ? AND lower(name) = lower(?)', bid, name)) fail(409, 'A loan with this name is already there: choose it.');
    loan = { id: newId(), name, kind: kindOf(n.kind) };
    s.push(stmt(db, 'INSERT INTO loans (id, business_id, name, kind, opening_paise, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)', loan.id, bid, name, loan.kind, user, t),
      stmt(db, AUDIT, bid, user, 'loans.add', 'loans', loan.id, null, JSON.stringify({ name, kind: loan.kind, changes: `${LOAN_WORD[loan.kind]}: ${name}` }), t));
  }
  if (!loan) fail(400, 'Choose the loan.');
  const direction = row.direction === 'CR' ? 'in' : 'out';
  const interest = optionalPaise(data, 'interest', 'Interest') ?? 0;
  if (interest < 0 || interest >= row.amount_paise) fail(400, 'Interest must be less than the line.');
  let interestHead: string | null = null;
  if (interest) {
    const want = direction === 'out' ? 'expense' : 'income';
    interestHead = typeof data.interestHeadId === 'string' && isUuid(data.interestHeadId) ? data.interestHeadId : fail(400, 'Choose the head for the interest.');
    if (!await one(db, 'SELECT 1 AS x FROM heads WHERE id = ? AND business_id = ? AND type = ?', interestHead, bid, want)) fail(400, `Interest ${direction === 'out' ? 'paid goes under an expense' : 'received goes under an income'} head.`);
  }
  const principal = row.amount_paise - interest;
  const note = text(data, 'note', 'Note', { optional: true, max: 200 });
  const word = direction === 'in' ? (signOf(loan.kind, 'in') > 0 ? 'received' : 'paid back to the company') : (signOf(loan.kind, 'out') > 0 ? 'given' : 'repaid');
  const label = `Loan · ${loan.name} · ${word}${interest ? ` ${rs(principal)} + interest ${rs(interest)}` : ''}`;
  const tx = newId();
  const itx = interest ? newId() : null;
  const entry = newId();
  const key = typeof data.remember === 'string' && data.remember.trim().length >= 3 ? data.remember.trim().toLowerCase().slice(0, 80) : null;
  s.push(
    stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, narration, source, status, ocr_original, created_at)
      VALUES (?, ?, ?, ?, ?, 'transfer', ?, 'bank_sheet', 'approved', ?, ?)`, tx, bid, row.account_id, row.day, principal, `${label}${note ? `: ${note}` : ''} (${row.description})`,
      JSON.stringify({ loan: loan.id, leg: direction, bankRowId: row.id }), t),
    ...(itx ? [stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, ocr_original, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bank_sheet', 'approved', ?, ?)`, itx, bid, row.account_id, row.day, interest, direction === 'out' ? 'expense' : 'income', interestHead,
      `Interest · ${loan.name} (${row.description})`, JSON.stringify({ loanBankRowId: row.id, loan: loan.id }), t)] : []),
    stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", tx, label, user, t, row.id),
    stmt(db, `INSERT INTO loan_entries (id, business_id, loan_id, day, direction, amount_paise, interest_paise, note, bank_row_id, transaction_id, interest_tx_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entry, bid, loan.id, row.day, direction, principal, interest, note, row.id, tx, itx, user, t),
    ...(key ? [stmt(db, 'INSERT INTO loan_keys (business_id, key, loan_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (business_id, key) DO UPDATE SET loan_id = excluded.loan_id', bid, key, loan.id, t)] : []),
    stmt(db, AUDIT, bid, user, 'loans.bank', 'bank_rows', row.id, JSON.stringify({ status: 'unmatched' }), JSON.stringify({ loanId: loan.id, entry, transactions: [tx, itx].filter(Boolean),
      remembered: key, changes: `${label}${key ? ` · "${key}" remembered` : ''}` }), t),
  );
  await db.batch(s);
  return c.json({ ok: true, loanId: loan.id, remembered: key });
});
