import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, isShiftConfirmed, isUniqueViolation, newId, now, one, stmt, type DB } from '../db';
import { body, fail, isUuid, optionalPaise, paise, text } from '../http';
import { MAX_UPLOAD_BYTES, serveStored, sniffImage, storageKey } from '../files';
import { cashSummaryChecks, refreshComparisons, type SummaryValues } from '../sales';
import { shiftDayOf } from '../time';

export const captureRoutes = new Hono<AppEnv>();

const PHOTO_KINDS = ['bill_register', 'expense_list', 'cash_summary', 'single_bill'] as const;
type PhotoKind = (typeof PHOTO_KINDS)[number];
const CONFIRMED = 'This shift is confirmed. An Owner must reopen it first.';

interface Upload { id: string; kind: string; business_day: string; storage_key: string; status: string; page_written_total_paise: number | null; ocr_engine: string | null; created_at: number }

async function getUpload(db: DB, businessId: string, id: string | undefined): Promise<Upload> {
  if (!isUuid(id)) fail(404, 'Upload not found.');
  const u = await one<Upload>(db, `SELECT id, kind, business_day, storage_key, status, page_written_total_paise, ocr_engine, created_at
    FROM uploads WHERE id = ? AND business_id = ?`, id, businessId);
  if (!u) fail(404, 'Upload not found.');
  return u;
}

// ---- Photo upload. The body is the file itself (JPG, PNG or PDF, checked from its first bytes).
// Reading the page (OCR) is not connected yet, so the rows are typed in on the Review screen.
captureRoutes.post('/businesses/:businessId/uploads', requireRole('rows.upload'), async (c) => {
  const kind = c.req.query('kind') as PhotoKind;
  const day = c.req.query('day') ?? '';
  if (!PHOTO_KINDS.includes(kind)) fail(400, 'Choose what is on the page.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Choose the day.');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) fail(400, 'Choose a file.');
  if (bytes.length > MAX_UPLOAD_BYTES) fail(400, 'The file is larger than 10 MB.');
  const type = sniffImage(bytes);
  if (!type) fail(400, 'Only JPG, PNG or PDF files can be uploaded.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = newId();
  const key = storageKey(bid, id);
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (await one(db, 'SELECT 1 AS ok FROM uploads WHERE business_id = ? AND content_sha256 = ?', bid, hex)) fail(409, 'This exact file was already uploaded.');
  await c.env.UPLOADS.put(key, bytes, { httpMetadata: { contentType: type } });
  const t = now();
  try {
    await db.batch([
      stmt(db, `INSERT INTO uploads (id, business_id, kind, business_day, storage_key, content_sha256, status, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`, id, bid, kind, day, key, hex, c.get('user').id, t),
      ...(kind === 'cash_summary' ? [stmt(db, `INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, status, created_at)
        VALUES (?, ?, ?, ?, 'draft', ?)`, newId(), bid, id, day, t)] : []),
    ]);
  } catch (e) {
    await c.env.UPLOADS.delete(key);
    if (isUniqueViolation(e)) fail(409, 'This exact file was already uploaded.');
    throw e;
  }
  return c.json({ id }, 201);
});

// Recent uploads plus plain notices for the Review screen.
captureRoutes.get('/businesses/:businessId/uploads', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const uploads = await all(db, `
    SELECT u.id, u.kind, u.business_day AS day, u.status, u.created_at AS createdAt,
      CASE u.kind
        WHEN 'bill_register' THEN (SELECT count(*) FROM register_rows r WHERE r.upload_id = u.id)
        WHEN 'expense_list' THEN (SELECT count(*) FROM transactions t WHERE t.upload_id = u.id)
        WHEN 'software_sales_csv' THEN (SELECT bill_count FROM sales_reports s WHERE s.upload_id = u.id)
        ELSE NULL END AS rows,
      CASE u.kind
        WHEN 'bill_register' THEN (SELECT count(*) FROM register_rows r WHERE r.upload_id = u.id AND r.status <> 'checked')
        WHEN 'expense_list' THEN (SELECT count(*) FROM transactions t WHERE t.upload_id = u.id AND t.status <> 'approved')
        ELSE NULL END AS open
    FROM uploads u WHERE u.business_id = ? ORDER BY u.created_at DESC LIMIT 100`, bid);
  // Software reports, with the shifts each one covers, for the Review list.
  const reportRows = await all<{ uploadId: string; id: string; coversFrom: number; coversTo: number; added: number; skipped: number;
    flagged: number; openConflicts: number; replacedBy: string | null }>(db, `
    SELECT r.upload_id AS uploadId, r.id, r.covers_from AS coversFrom, r.covers_to AS coversTo, r.bills_added AS added,
      r.bills_skipped AS skipped, r.bills_flagged AS flagged, r.replaced_by AS replacedBy,
      (SELECT count(*) FROM software_bill_conflicts k WHERE k.report_id = r.id AND k.decision IS NULL) AS openConflicts
    FROM sales_reports r WHERE r.business_id = ?`, bid);
  const reports = new Map(reportRows.map((r) => {
    const days = new Set<string>();
    for (let t = r.coversFrom; t < r.coversTo; t += 3_600_000) days.add(shiftDayOf(t));
    days.add(shiftDayOf(r.coversTo));
    return [r.uploadId, { ...r, shiftDays: [...days].sort() }];
  }));
  const withReports = uploads.map((u) => (u.kind === 'software_sales_csv' ? { ...u, report: reports.get(u.id as string) ?? null } : u));
  // The cash summary's expense check waits while that day's expense rows are not approved.
  const waiting = await all<{ day: string; drafts: number }>(db, `
    SELECT s.shift_day AS day, (SELECT count(*) FROM transactions t WHERE t.business_id = s.business_id AND t.day = s.shift_day
      AND t.source = 'cash_photo' AND t.type = 'expense' AND t.status <> 'approved') AS drafts
    FROM cash_summaries s WHERE s.business_id = ? AND s.status <> 'approved'`, bid);
  const notices = waiting.filter((w) => w.drafts > 0).map((w) => ({
    day: w.day,
    text: `The cash summary for ${w.day} cannot be checked yet: ${w.drafts} expense row${w.drafts > 1 ? 's' : ''} for that day ${w.drafts > 1 ? 'are' : 'is'} not approved.`,
  }));
  return c.json({ uploads: withReports, notices });
});

captureRoutes.get('/businesses/:businessId/uploads/:uploadId/file', requireRole('rows.edit'), async (c) => {
  const u = await getUpload(c.env.DB, c.get('businessId'), c.req.param('uploadId'));
  return serveStored(c, u.storage_key);
});

// One page with everything the Review screen needs for its kind.
captureRoutes.get('/businesses/:businessId/uploads/:uploadId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const u = await getUpload(db, bid, c.req.param('uploadId'));
  const base = { id: u.id, kind: u.kind, day: u.business_day, status: u.status, pageWrittenTotalPaise: u.page_written_total_paise, ocrEngine: u.ocr_engine, createdAt: u.created_at };
  if (u.kind === 'bill_register') {
    const rows = await all<{ id: string }>(db, `SELECT id, line_no AS lineNo, bill_no AS billNo, bill_type AS billType, amount_paise AS amountPaise,
      remarks, status, ocr_original AS ocrOriginal FROM register_rows WHERE upload_id = ? ORDER BY line_no`, u.id);
    const pays = await all<{ registerRowId: string }>(db, `SELECT p.id, p.register_row_id AS registerRowId, p.mode, p.column_label AS columnLabel,
      p.amount_paise AS amountPaise FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.upload_id = ? ORDER BY p.created_at, p.id`, u.id);
    const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, u.business_day);
    return c.json({ ...base, shiftStatus: shift?.status ?? 'open', rows: rows.map((r) => ({ ...r, payments: pays.filter((p) => p.registerRowId === r.id) })) });
  }
  if (u.kind === 'expense_list') {
    const rows = await all(db, `SELECT id, line_no AS lineNo, narration, amount_paise AS amountPaise, head_id AS headId, status
      FROM transactions WHERE upload_id = ? ORDER BY line_no`, u.id);
    return c.json({ ...base, rows });
  }
  if (u.kind === 'cash_summary') {
    const s = await one<SummaryValues & { id: string; shift_day: string; status: string; mismatch_note: string | null; mismatch_accepted_at: number | null }>(db,
      'SELECT * FROM cash_summaries WHERE upload_id = ?', u.id);
    const checks = await cashSummaryChecks(db, bid, s!.shift_day, s!);
    return c.json({ ...base, summary: {
      id: s!.id, status: s!.status, openingPaise: s!.opening_paise, receivedPaise: s!.received_paise, balancePaise: s!.balance_paise,
      expensesPaise: s!.expenses_paise, cashInHandPaise: s!.cash_in_hand_paise, mismatchNote: s!.mismatch_note, mismatchAcceptedAt: s!.mismatch_accepted_at,
    }, checks });
  }
  return c.json(base);
});

// The total written at the bottom of a register or expense page, checked against its rows.
captureRoutes.patch('/businesses/:businessId/uploads/:uploadId', requireRole('rows.edit'), async (c) => {
  const u = await getUpload(c.env.DB, c.get('businessId'), c.req.param('uploadId'));
  const data = await body(c);
  const total = optionalPaise(data, 'pageWrittenTotal', 'Page total');
  await stmt(c.env.DB, 'UPDATE uploads SET page_written_total_paise = ? WHERE id = ?', total, u.id).run();
  return c.json({ ok: true });
});

// ---- Register rows (bill register pages)

interface PaymentIn { mode: 'cash' | 'upi' | 'card'; columnLabel: string | null; amountPaise: number }

function registerInput(data: Record<string, unknown>) {
  const billType = data.billType === 'fnb' || data.billType === 'room' ? data.billType : data.billType === null || data.billType === '' || data.billType === undefined ? null : fail(400, 'Type must be F&B or Room.');
  const rawPays = Array.isArray(data.payments) ? data.payments : [];
  if (rawPays.length > 6) fail(400, 'At most 6 payments per bill.');
  const payments: PaymentIn[] = rawPays.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    if (o.mode !== 'cash' && o.mode !== 'upi' && o.mode !== 'card') fail(400, `Payment ${i + 1}: mode must be cash, upi or card.`);
    return { mode: o.mode, columnLabel: text(o, 'columnLabel', 'Column', { optional: true, max: 40 }), amountPaise: paise(o, 'amount', `Payment ${i + 1} amount`) };
  });
  const status = data.status === 'checked' ? 'checked' : 'draft';
  return {
    billNo: text(data, 'billNo', 'Bill number', { max: 30 })!,
    billType,
    amountPaise: paise(data, 'amount', 'Bill amount'),
    remarks: text(data, 'remarks', 'Remarks', { optional: true, max: 300 }),
    payments,
    status,
  };
}

const paymentStatements = (db: DB, businessId: string, rowId: string, pays: PaymentIn[], t: number) =>
  pays.map((p) => stmt(db, `INSERT INTO register_payments (id, business_id, register_row_id, mode, column_label, amount_paise, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, newId(), businessId, rowId, p.mode, p.columnLabel, p.amountPaise, t));

captureRoutes.post('/businesses/:businessId/uploads/:uploadId/register-rows', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const u = await getUpload(db, bid, c.req.param('uploadId'));
  if (u.kind !== 'bill_register') fail(400, 'This page is not a bill register.');
  const r = registerInput(await body(c));
  const last = await one<{ n: number }>(db, 'SELECT coalesce(max(line_no), 0) AS n FROM register_rows WHERE upload_id = ?', u.id);
  const id = newId();
  const t = now();
  try {
    await db.batch([
      stmt(db, `INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, remarks, status, edited_by, edited_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, u.id, last!.n + 1, u.business_day, r.billNo, r.billType, r.amountPaise, r.remarks, r.status,
        c.get('user').id, t, t),
      ...paymentStatements(db, bid, id, r.payments, t),
      stmt(db, "UPDATE uploads SET ocr_engine = coalesce(ocr_engine, 'manual') WHERE id = ?", u.id),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await refreshComparisons(db, bid, u.business_day, c.get('user').id);
  return c.json({ id }, 201);
});

captureRoutes.put('/businesses/:businessId/register-rows/:rowId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const old = await one<{ shift_day: string }>(db, 'SELECT shift_day FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!old) fail(404, 'Row not found.');
  const r = registerInput(await body(c));
  const t = now();
  try {
    await db.batch([
      stmt(db, `UPDATE register_rows SET bill_no = ?, bill_type = ?, amount_paise = ?, remarks = ?, status = ?, edited_by = ?, edited_at = ?
        WHERE id = ? AND business_id = ?`, r.billNo, r.billType, r.amountPaise, r.remarks, r.status, c.get('user').id, t, rowId, bid),
      stmt(db, 'DELETE FROM register_payments WHERE register_row_id = ?', rowId),
      ...paymentStatements(db, bid, rowId, r.payments, t),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await refreshComparisons(db, bid, old.shift_day, c.get('user').id);
  return c.json({ ok: true });
});

captureRoutes.delete('/businesses/:businessId/register-rows/:rowId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const old = await one<{ shift_day: string }>(db, 'SELECT shift_day FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!old) fail(404, 'Row not found.');
  try {
    await stmt(db, 'DELETE FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid).run();
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await refreshComparisons(db, bid, old.shift_day, c.get('user').id);
  return c.json({ ok: true });
});

// ---- Expense list rows: draft expense rows paid from Cash, approved by Owner or Accountant

async function cashAccount(db: DB, businessId: string): Promise<string> {
  const a = await one<{ id: string }>(db, `SELECT id FROM accounts WHERE business_id = ? AND kind = 'cash'
    ORDER BY lower(name) = 'cash' DESC, created_at LIMIT 1`, businessId);
  if (!a) fail(400, 'This business has no cash account. Add one on Accounts.');
  return a.id;
}

async function expenseHead(db: DB, businessId: string, data: Record<string, unknown>): Promise<string | null> {
  const headId = typeof data.headId === 'string' && data.headId ? data.headId : null;
  if (!headId) return null;
  if (!isUuid(headId) || !(await one(db, "SELECT 1 AS ok FROM heads WHERE id = ? AND business_id = ? AND type = 'expense'", headId, businessId))) {
    fail(400, 'Choose an expense head of this business.');
  }
  return headId;
}

captureRoutes.post('/businesses/:businessId/uploads/:uploadId/expense-rows', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const u = await getUpload(db, bid, c.req.param('uploadId'));
  if (u.kind !== 'expense_list') fail(400, 'This page is not an expense list.');
  const data = await body(c);
  const narration = text(data, 'narration', 'Item', { max: 200 })!;
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than zero.');
  const headId = await expenseHead(db, bid, data);
  const account = await cashAccount(db, bid);
  const last = await one<{ n: number }>(db, 'SELECT coalesce(max(line_no), 0) AS n FROM transactions WHERE upload_id = ?', u.id);
  const id = newId();
  await db.batch([
    stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode,
      upload_id, line_no, created_at) VALUES (?, ?, ?, ?, ?, 'expense', ?, ?, 'cash_photo', 'draft', 'cash', ?, ?, ?)`,
      id, bid, account, u.business_day, amount, headId, narration, u.id, last!.n + 1, now()),
    stmt(db, "UPDATE uploads SET ocr_engine = coalesce(ocr_engine, 'manual') WHERE id = ?", u.id),
  ]);
  return c.json({ id }, 201);
});

captureRoutes.put('/businesses/:businessId/expense-rows/:rowId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const data = await body(c);
  const narration = text(data, 'narration', 'Item', { max: 200 })!;
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than zero.');
  const headId = await expenseHead(db, bid, data);
  const res = await stmt(db, `UPDATE transactions SET narration = ?, amount_paise = ?, head_id = ?
    WHERE id = ? AND business_id = ? AND source = 'cash_photo' AND status = 'draft'`, narration, amount, headId, rowId, bid).run();
  if (!res.meta.changes) fail(404, 'Draft row not found. Approved rows cannot be edited.');
  return c.json({ ok: true });
});

captureRoutes.delete('/businesses/:businessId/expense-rows/:rowId', requireRole('rows.edit'), async (c) => {
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const res = await stmt(c.env.DB, `DELETE FROM transactions WHERE id = ? AND business_id = ? AND source = 'cash_photo' AND status = 'draft'`,
    rowId, c.get('businessId')).run();
  if (!res.meta.changes) fail(404, 'Draft row not found. Approved rows cannot be deleted.');
  return c.json({ ok: true });
});

// Approves every draft row on the page that has a head. Rows without a head stay as drafts.
captureRoutes.post('/businesses/:businessId/uploads/:uploadId/expense-rows/approve', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const u = await getUpload(db, bid, c.req.param('uploadId'));
  if (u.kind !== 'expense_list') fail(400, 'This page is not an expense list.');
  const ready = await all<Record<string, unknown> & { id: string }>(db, `SELECT * FROM transactions WHERE upload_id = ? AND business_id = ?
    AND status = 'draft' AND head_id IS NOT NULL`, u.id, bid);
  if (!ready.length) fail(400, 'No draft rows with a head to approve.');
  const t = now();
  const user = c.get('user').id;
  await db.batch(ready.flatMap((r) => [
    stmt(db, "UPDATE transactions SET status = 'approved' WHERE id = ? AND status = 'draft'", r.id),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'transaction.approve', 'transactions', ?, ?, ?, ?)`, bid, user, r.id, JSON.stringify(r), JSON.stringify({ ...r, status: 'approved' }), t),
  ]));
  const left = await one<{ n: number }>(db, "SELECT count(*) AS n FROM transactions WHERE upload_id = ? AND status <> 'approved'", u.id);
  if (!left!.n) await stmt(db, "UPDATE uploads SET status = 'approved' WHERE id = ?", u.id).run();
  return c.json({ approved: ready.length });
});

// ---- Cash account summary

captureRoutes.put('/businesses/:businessId/cash-summaries/:summaryId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const id = c.req.param('summaryId');
  if (!isUuid(id)) fail(404, 'Summary not found.');
  const data = await body(c);
  const v = {
    opening: optionalPaise(data, 'opening', 'Opening'),
    received: optionalPaise(data, 'received', 'Received'),
    balance: optionalPaise(data, 'balance', 'Balance'),
    expenses: optionalPaise(data, 'expenses', 'Expenses'),
    cashInHand: optionalPaise(data, 'cashInHand', 'Cash in hand'),
  };
  const filled = Object.values(v).every((x) => x !== null);
  const res = await stmt(db, `UPDATE cash_summaries SET opening_paise = ?, received_paise = ?, balance_paise = ?, expenses_paise = ?,
    cash_in_hand_paise = ?, status = ? WHERE id = ? AND business_id = ? AND status <> 'approved'`,
    v.opening, v.received, v.balance, v.expenses, v.cashInHand, filled ? 'checked' : 'draft', id, c.get('businessId')).run();
  if (!res.meta.changes) fail(404, 'Summary not found, or already approved.');
  return c.json({ ok: true });
});

// Approves when every check passes. A failed check needs a note from an Owner or Accountant.
// A check that is still waiting (shift not confirmed, expense rows not approved) blocks approval.
captureRoutes.post('/businesses/:businessId/cash-summaries/:summaryId/approve', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('summaryId');
  if (!isUuid(id)) fail(404, 'Summary not found.');
  const s = await one<SummaryValues & { shift_day: string; status: string; upload_id: string }>(db,
    'SELECT * FROM cash_summaries WHERE id = ? AND business_id = ?', id, bid);
  if (!s) fail(404, 'Summary not found.');
  if (s.status === 'approved') fail(409, 'Already approved.');
  const checks = await cashSummaryChecks(db, bid, s.shift_day, s);
  const waiting = checks.filter((k) => k.state === 'waiting');
  if (waiting.length) return c.json({ error: 'Some checks are still waiting.', problems: waiting.map((k) => k.detail) }, 409);
  const failed = checks.filter((k) => k.state === 'fail');
  const note = text(await body(c), 'note', 'Note', { optional: true, max: 500 });
  if (failed.length && !note) return c.json({ error: 'Some checks do not match. Add a note to approve anyway.', problems: failed.map((k) => k.detail) }, 409);
  const t = now();
  const user = c.get('user').id;
  await db.batch([
    stmt(db, `UPDATE cash_summaries SET status = 'approved', mismatch_note = ?, mismatch_accepted_by = ?, mismatch_accepted_at = ?
      WHERE id = ? AND status <> 'approved'`, failed.length ? note : null, failed.length ? user : null, failed.length ? t : null, id),
    stmt(db, "UPDATE uploads SET status = 'approved' WHERE id = ?", s.upload_id),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'cash_summary.approve', 'cash_summaries', ?, NULL, ?, ?)`, bid, user, id,
      JSON.stringify({ checks: checks.map((k) => ({ key: k.key, state: k.state })), note: failed.length ? note : null }), t),
  ]);
  return c.json({ ok: true, acceptedMismatches: failed.length });
});
