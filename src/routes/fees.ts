// Fee check (approved 20 Nov 2026). See src/fees.ts, src/feereport.ts and migration 0031.
// Bring in a day's report: Owner, Accountant or Entry staff (sales.import). See it: everyone (sales.view).
// Link a receipt code to a school, or a report cashier to a book: Owner or Accountant (accounts.edit).
// Match a bank transfer or cheque receipt to its credit: Owner or Accountant (rows.approve).
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, newId, now, one, stmt, type DB } from '../db';
import { body, fail, isUuid } from '../http';
import { nameKey, parseFeeReport } from '../feereport';
import { cashierBooks, codeMap, receiptCandidates, refillAll, refillCash } from '../fees';
import { can } from '../permissions';

export const feeRoutes = new Hono<AppEnv>();

const audit = (db: DB, e: { businessId: string; userId: string; action: string; table: string; rowId: string; after?: unknown; before?: unknown; at: number }) =>
  stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    e.businessId, e.userId, e.action, e.table, e.rowId, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.at);
const isDay = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

feeRoutes.post('/businesses/:businessId/fees/import', requireRole('sales.import'), async (c) => {
  const data = await body(c);
  if (typeof data.text !== 'string' || !data.text.trim()) fail(400, 'Choose the FeeDaySheet file.');
  if (data.text.length > 5_000_000) fail(400, 'This file is too large for one day\'s report.');
  let rep;
  try { rep = parseFeeReport(data.text); } catch (e) { fail(400, (e as Error).message); }
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const fileName = typeof data.fileName === 'string' ? data.fileName.slice(0, 120) : null;
  const id = newId();
  const t = now();
  const lines = rep.lines.map((l) => stmt(db, `INSERT INTO fee_lines (id, business_id, report_id, line_no, day, receipt_no, code, enrollment_code, admission_no,
      student, class_section, fee_type, mode, mode_text, cashier, amount_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), bid, id, l.lineNo, l.day, l.receiptNo, l.code, l.enrollmentCode, l.admissionNo, l.student, l.classSection, l.feeType, l.mode, l.modeText, l.cashier, l.amountPaise));
  // The same day brought in again replaces the earlier copy (its lines and the cash it filled go with it).
  await db.batch([
    stmt(db, 'DELETE FROM fee_reports WHERE business_id = ? AND day = ?', bid, rep.day),
    stmt(db, 'INSERT INTO fee_reports (id, business_id, day, file_name, footer, imported_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, bid, rep.day, fileName, JSON.stringify(rep.footer), user.id, t),
    ...lines,
    audit(db, { businessId: bid, userId: user.id, action: 'fees.import', table: 'fee_reports', rowId: id, after: { day: rep.day, fileName, lines: rep.lines.length }, at: t }),
  ]);
  await refillCash(db, bid, id, user.id);
  return c.json({ id, day: rep.day, lines: rep.lines.length }, 201);
});

feeRoutes.get('/businesses/:businessId/fees/:day', requireRole('sales.view'), async (c) => {
  const day = c.req.param('day');
  if (!isDay(day)) fail(400, 'Day must be a date (YYYY-MM-DD).');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const role = c.get('role');
  const [report, days, branches] = await Promise.all([
    one<{ id: string; fileName: string | null; footer: string; createdAt: number; importedByName: string | null }>(db, `SELECT r.id, r.file_name AS fileName, r.footer,
      r.created_at AS createdAt, u.name AS importedByName FROM fee_reports r LEFT JOIN users u ON u.id = r.imported_by WHERE r.business_id = ? AND r.day = ?`, bid, day),
    all<{ day: string }>(db, 'SELECT day FROM fee_reports WHERE business_id = ? ORDER BY day DESC LIMIT 60', bid),
    all<{ id: string; name: string }>(db, 'SELECT id, name FROM branches WHERE business_id = ? ORDER BY name', bid),
  ]);
  const base = { day, days: days.map((d) => d.day), branches, can: { import: can(role, 'sales.import'), setup: can(role, 'accounts.edit'), approve: can(role, 'rows.approve') } };
  if (!report) return c.json({ ...base, report: null });
  const [lines, codes, cb, matches, filled] = await Promise.all([
    all<{ receiptNo: string; code: string; student: string | null; classSection: string | null; feeType: string | null; mode: string; modeText: string;
      cashier: string | null; amountPaise: number }>(db, `SELECT receipt_no AS receiptNo, code, student, class_section AS classSection, fee_type AS feeType, mode,
      mode_text AS modeText, cashier, amount_paise AS amountPaise FROM fee_lines WHERE report_id = ? ORDER BY line_no`, report.id),
    codeMap(db, bid),
    cashierBooks(db, bid),
    all<{ receiptNo: string; bankRowId: string; day: string; description: string; accountName: string; matchedByName: string | null }>(db, `SELECT m.receipt_no AS receiptNo,
      m.bank_row_id AS bankRowId, r.day, r.description, a.name AS accountName, u.name AS matchedByName FROM fee_receipt_matches m JOIN bank_rows r ON r.id = m.bank_row_id
      JOIN accounts a ON a.id = r.account_id LEFT JOIN users u ON u.id = m.matched_by WHERE m.business_id = ?`, bid),
    all<{ accountId: string; amountPaise: number }>(db, 'SELECT account_id AS accountId, amount_paise AS amountPaise FROM cash_entries WHERE fee_report_id = ?', report.id),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  // Codes in the file: ours (a school), not ours, or not known yet.
  const codeTotals = new Map<string, number>();
  for (const l of lines) codeTotals.set(l.code, (codeTotals.get(l.code) ?? 0) + l.amountPaise);
  const codeList = [...codeTotals].map(([code, paise]) => ({ code, paise, state: !codes.has(code) ? 'unknown' : codes.get(code) ? 'ours' : 'other',
    branchId: codes.get(code) ?? null, branchName: codes.get(code) ? branchName.get(codes.get(code)!) ?? null : null }));
  const ours = lines.filter((l) => codes.get(l.code));
  const sum = (list: { amountPaise: number }[]) => list.reduce((t, l) => t + l.amountPaise, 0);
  const modes = ['cash', 'upi', 'card', 'bank', 'cheque', 'other'] as const;
  const totals = Object.fromEntries(modes.map((m) => [m, sum(ours.filter((l) => l.mode === m))]));
  const schools = branches.map((b) => {
    const of = ours.filter((l) => codes.get(l.code) === b.id);
    return { branchId: b.id, name: b.name, totalPaise: sum(of), byMode: Object.fromEntries(modes.map((m) => [m, sum(of.filter((l) => l.mode === m))])) };
  }).filter((s) => s.totalPaise);
  // Cashiers: cash and other modes, and the book their cash fills.
  const filledBy = new Map(filled.map((f) => [f.accountId, f.amountPaise]));
  const names = [...new Set(ours.map((l) => l.cashier ?? ''))];
  const cashiers = names.map((name) => {
    const of = ours.filter((l) => (l.cashier ?? '') === name);
    const m = cb.of(name || null);
    const cash = sum(of.filter((l) => l.mode === 'cash'));
    const book = m && m !== 'none' ? m.book : null;
    return { name: name || '(no cashier)', nameKey: name ? nameKey(name) : '', cashPaise: cash, otherPaise: sum(of) - cash,
      schools: [...new Set(of.map((l) => branchName.get(codes.get(l.code)!) ?? l.code))],
      book: book ? { id: book.id, name: book.name, how: (m as { how: string }).how } : null, noBook: m === 'none',
      filledPaise: book ? filledBy.get(book.id) ?? 0 : 0, beforeBook: !!book && day < book.openingDate };
  }).sort((a, b) => b.cashPaise - a.cashPaise);
  // Receipts paid by bank transfer or cheque: each to its bank credit.
  const matchOf = new Map(matches.map((m) => [m.receiptNo, m]));
  const receipts = new Map<string, { receiptNo: string; student: string | null; mode: string; modeText: string; cashier: string | null; school: string | null; amountPaise: number }>();
  for (const l of ours.filter((x) => x.mode === 'bank' || x.mode === 'cheque')) {
    const r = receipts.get(l.receiptNo) ?? { receiptNo: l.receiptNo, student: l.student, mode: l.mode, modeText: l.modeText, cashier: l.cashier,
      school: branchName.get(codes.get(l.code)!) ?? null, amountPaise: 0 };
    r.amountPaise += l.amountPaise;
    receipts.set(l.receiptNo, r);
  }
  const bank = await Promise.all([...receipts.values()].map(async (r) => ({ ...r, match: matchOf.get(r.receiptNo) ?? null,
    candidates: matchOf.has(r.receiptNo) ? [] : await receiptCandidates(db, bid, day, r.amountPaise) })));
  return c.json({
    ...base,
    report: { id: report.id, fileName: report.fileName, createdAt: report.createdAt, importedByName: report.importedByName, footer: JSON.parse(report.footer),
      lines: lines.length, oursLines: ours.length, receipts: new Set(ours.map((l) => l.receiptNo)).size },
    codes: codeList, totals, totalPaise: sum(ours), schools, cashiers, bank,
    books: cb.books.map((b) => ({ id: b.id, name: b.name, cashierName: b.cashierName })),
  });
});

feeRoutes.put('/businesses/:businessId/fees/codes/:code', requireRole('accounts.edit'), async (c) => {
  const code = (c.req.param('code') ?? '').toUpperCase();
  if (!/^[A-Z]{1,30}$/.test(code)) fail(400, 'Unknown receipt code.');
  const data = await body(c);
  const branchId = typeof data.branchId === 'string' && data.branchId ? data.branchId : null;
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  if (branchId && (!isUuid(branchId) || !(await one(db, 'SELECT 1 AS ok FROM branches WHERE id = ? AND business_id = ?', branchId, bid)))) fail(400, 'Choose the school.');
  const t = now();
  await db.batch([
    stmt(db, `INSERT INTO fee_codes (business_id, code, branch_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (business_id, code) DO UPDATE SET branch_id = excluded.branch_id`, bid, code, branchId, t),
    audit(db, { businessId: bid, userId: user.id, action: 'fees.code', table: 'fee_codes', rowId: code, after: { branchId }, at: t }),
  ]);
  await refillAll(db, bid, user.id);
  return c.json({ ok: true });
});

feeRoutes.put('/businesses/:businessId/fees/cashiers', requireRole('accounts.edit'), async (c) => {
  const data = await body(c);
  const key = typeof data.name === 'string' ? nameKey(data.name) : '';
  if (!key) fail(400, 'Which cashier name?');
  const accountId = typeof data.accountId === 'string' && data.accountId ? data.accountId : null;
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  if (accountId && (!isUuid(accountId) || !(await one(db, "SELECT 1 AS ok FROM accounts WHERE id = ? AND business_id = ? AND kind = 'cash'", accountId, bid)))) fail(400, 'Choose the cash book.');
  const t = now();
  await db.batch([
    stmt(db, `INSERT INTO fee_cashiers (business_id, name_key, account_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (business_id, name_key) DO UPDATE SET account_id = excluded.account_id`, bid, key, accountId, t),
    audit(db, { businessId: bid, userId: user.id, action: 'fees.cashier', table: 'fee_cashiers', rowId: key, after: { accountId }, at: t }),
  ]);
  await refillAll(db, bid, user.id);
  return c.json({ ok: true });
});

feeRoutes.post('/businesses/:businessId/fees/receipts/:receiptNo/match', requireRole('rows.approve'), async (c) => {
  const receiptNo = c.req.param('receiptNo') ?? '';
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const r = await one<{ day: string; amountPaise: number }>(db, `SELECT min(day) AS day, sum(amount_paise) AS amountPaise FROM fee_lines
    WHERE business_id = ? AND receipt_no = ? AND mode IN ('bank', 'cheque') AND report_id IN (SELECT id FROM fee_reports WHERE business_id = ?)`, bid, receiptNo, bid);
  if (!r?.day) fail(404, 'Receipt not found.');
  const rowId = (await body(c)).bankRowId;
  const ok = (await receiptCandidates(db, bid, r.day, r.amountPaise)).find((x) => x.id === rowId);
  if (!ok) fail(400, 'Choose a credit of this amount near the receipt\'s day.');
  const t = now();
  try {
    await db.batch([
      stmt(db, 'INSERT INTO fee_receipt_matches (id, business_id, receipt_no, bank_row_id, matched_by, matched_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), bid, receiptNo, ok.id, user.id, t),
      audit(db, { businessId: bid, userId: user.id, action: 'fees.match', table: 'fee_receipt_matches', rowId: receiptNo, after: { bankRowId: ok.id }, at: t }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) fail(409, 'This receipt is already matched.');
    throw e;
  }
  return c.json({ ok: true });
});

feeRoutes.delete('/businesses/:businessId/fees/receipts/:receiptNo/match', requireRole('rows.approve'), async (c) => {
  const receiptNo = c.req.param('receiptNo') ?? '';
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const t = now();
  await db.batch([
    audit(db, { businessId: bid, userId: user.id, action: 'fees.unmatch', table: 'fee_receipt_matches', rowId: receiptNo, before: { receiptNo }, at: t }),
    stmt(db, 'DELETE FROM fee_receipt_matches WHERE business_id = ? AND receipt_no = ?', bid, receiptNo),
  ]);
  return c.json({ ok: true });
});
