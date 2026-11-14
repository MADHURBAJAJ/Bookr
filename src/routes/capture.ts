import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, isShiftConfirmed, isUniqueViolation, newId, now, one, stmt, type DB } from '../db';
import { body, date, fail, isUuid, optionalPaise, paise, text } from '../http';
import { MAX_UPLOAD_BYTES, serveStored, sniffImage, storageKey } from '../files';
import { cashSummaryChecks, LARGE_DISCOUNT_PCT, numberContext, numberFlags, refreshComparisons, suggestBills, type SummaryValues } from '../sales';
import { headFromItem, headFromWords, loadHistory, loadItemHistory, loadParties, markLearned, resolveVendor } from '../parties';
import { addDays, istDay, shiftDayOf } from '../time';
import { onPayingRow, spreadDifference } from '../discounts';
import { findSlip, TOTAL_KEYS, type ColumnTotals, type Slip } from '../ocr';
import { can, type Role } from '../permissions';
import { columnHints } from '../columnHints';

export const captureRoutes = new Hono<AppEnv>();

/** A field the app worked out that nobody has changed since. */
function stillInferred(ocrOriginal: string | null, field: string): boolean {
  if (!ocrOriginal) return false;
  const o = JSON.parse(ocrOriginal) as { inferred?: string[]; resolved?: string[] };
  return (o.inferred ?? []).includes(field) && !(o.resolved ?? []).includes(field);
}

const PHOTO_KINDS = ['bill_register', 'expense_list', 'cash_summary', 'single_bill'] as const;
type PhotoKind = (typeof PHOTO_KINDS)[number];
const CONFIRMED = 'This shift is confirmed. An Owner must reopen it first.';

interface Upload { id: string; kind: string; business_day: string; storage_key: string; status: string; page_written_total_paise: number | null; page_column_totals: string | null; ocr_engine: string | null; uploaded_by: string | null; created_at: number }

async function getUpload(db: DB, businessId: string, id: string | undefined): Promise<Upload> {
  if (!isUuid(id)) fail(404, 'Upload not found.');
  const u = await one<Upload>(db, `SELECT id, kind, business_day, storage_key, status, page_written_total_paise, page_column_totals, ocr_engine, uploaded_by, created_at
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
    SELECT u.id, u.kind, u.business_day AS day, u.status, u.uploaded_by AS uploadedBy, u.created_at AS createdAt, u.storage_key LIKE 'software-added/%' AS fromSoftware,
      CASE u.kind
        WHEN 'bill_register' THEN (SELECT count(*) FROM register_rows r WHERE r.upload_id = u.id)
        WHEN 'expense_list' THEN (SELECT count(*) FROM transactions t WHERE t.upload_id = u.id)
        WHEN 'software_sales_csv' THEN (SELECT bill_count FROM sales_reports s WHERE s.upload_id = u.id)
        ELSE NULL END AS rows,
      CASE u.kind
        WHEN 'bill_register' THEN (SELECT count(*) FROM register_rows r WHERE r.upload_id = u.id AND r.status <> 'checked')
        WHEN 'expense_list' THEN (SELECT count(*) FROM transactions t WHERE t.upload_id = u.id AND t.status <> 'approved')
        ELSE NULL END AS open,
      CASE WHEN u.page_written_total_paise IS NULL THEN NULL
        WHEN u.kind = 'bill_register' THEN u.page_written_total_paise NOT IN (
          (SELECT coalesce(sum(amount_paise), 0) FROM register_rows r WHERE r.upload_id = u.id),
          (SELECT coalesce(sum(amount_paise - discount_paise + tip_paise), 0) FROM register_rows r WHERE r.upload_id = u.id),
          (SELECT coalesce(sum(p.amount_paise), 0) FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.upload_id = u.id))
        WHEN u.kind = 'expense_list' THEN (SELECT coalesce(sum(amount_paise), 0) FROM transactions t WHERE t.upload_id = u.id) <> u.page_written_total_paise
        ELSE NULL END AS totalDiffers,
      u.ocr_engine AS ocrEngine
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

// Deletes an upload and everything read from it. Owner and Accountant can delete any upload;
// Entry staff only their own. Refused when it would change a confirmed shift or approved rows.
captureRoutes.delete('/businesses/:businessId/uploads/:uploadId', requireRole('rows.upload'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user').id;
  const u = await getUpload(db, bid, c.req.param('uploadId'));
  if (!['owner', 'accountant'].includes(c.get('role')) && u.uploaded_by !== user) fail(403, 'Entry staff can delete only their own uploads.');

  const report = await one<{ id: string; bill_count: number }>(db, 'SELECT id, bill_count FROM sales_reports WHERE upload_id = ?', u.id);
  if (report && (await one(db, 'SELECT 1 AS ok FROM sales_reports WHERE replaced_by = ?', report.id))) {
    fail(409, 'This file replaced an earlier report, so it cannot be deleted. Upload a corrected file instead.');
  }
  const days = new Set<string>();
  if (report) for (const r of await all<{ shift_day: string }>(db, 'SELECT DISTINCT shift_day FROM software_bills WHERE report_id = ?', report.id)) days.add(r.shift_day);
  if (u.kind === 'bill_register') for (const r of await all<{ shift_day: string }>(db, 'SELECT DISTINCT shift_day FROM register_rows WHERE upload_id = ?', u.id)) days.add(r.shift_day);
  if (days.size) {
    const confirmed = await one<{ shift_day: string }>(db, `SELECT shift_day FROM shifts WHERE business_id = ? AND status = 'confirmed'
      AND shift_day IN (SELECT value FROM json_each(?)) LIMIT 1`, bid, JSON.stringify([...days]));
    if (confirmed) fail(409, `Shift ${confirmed.shift_day} is confirmed. An Owner must reopen it before this upload can be deleted.`);
  }
  if (u.kind === 'expense_list' && (await one(db, "SELECT 1 AS ok FROM transactions WHERE upload_id = ? AND status = 'approved'", u.id))) {
    fail(409, 'Some lines on this page are approved, so it cannot be deleted.');
  }
  if (u.kind === 'cash_summary' && (await one(db, "SELECT 1 AS ok FROM cash_summaries WHERE upload_id = ? AND status = 'approved'", u.id))) {
    fail(409, 'This cash summary is approved, so it cannot be deleted.');
  }

  const counts = await one<{ bills: number; register: number; expenses: number }>(db, `SELECT
    (SELECT count(*) FROM software_bills WHERE report_id = ?) AS bills,
    (SELECT count(*) FROM register_rows WHERE upload_id = ?) AS register,
    (SELECT count(*) FROM transactions WHERE upload_id = ?) AS expenses`, report?.id ?? '', u.id, u.id);
  try {
    await db.batch([
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'upload.delete', 'uploads', ?, ?, NULL, ?)`, bid, user, u.id,
        JSON.stringify({ kind: u.kind, day: u.business_day, uploadedBy: u.uploaded_by, reportId: report?.id ?? null, ...counts }), now()),
      stmt(db, "DELETE FROM transactions WHERE upload_id = ? AND status <> 'approved'", u.id),
      stmt(db, 'DELETE FROM uploads WHERE id = ? AND business_id = ?', u.id, bid),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await c.env.UPLOADS.delete(u.storage_key);
  for (const d of days) await refreshComparisons(db, bid, d, user);
  return c.json({ ok: true, ...counts });
});

// Finds register rows by bill number (any part of it, e.g. the last digits) across every page.
captureRoutes.get('/businesses/:businessId/register-rows', requireRole('rows.edit'), async (c) => {
  const q = (c.req.query('bill') ?? '').replace(/\s/g, '');
  if (q.length < 2) return c.json({ rows: [] });
  const rows = await all(c.env.DB, `
    SELECT r.id, r.upload_id AS uploadId, r.line_no AS lineNo, r.bill_no AS billNo, r.amount_paise AS amountPaise,
           r.shift_day AS day, r.status
    FROM register_rows r
    WHERE r.business_id = ? AND instr(r.bill_no, ?) > 0
    ORDER BY r.shift_day DESC, r.upload_id, r.line_no LIMIT 30`, c.get('businessId'), q);
  return c.json({ rows });
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
  const base = { id: u.id, kind: u.kind, day: u.business_day, status: u.status, pageWrittenTotalPaise: u.page_written_total_paise, columnTotals: u.page_column_totals ? JSON.parse(u.page_column_totals) : null, ocrEngine: u.ocr_engine, uploadedBy: u.uploaded_by, createdAt: u.created_at,
    fromSoftware: u.storage_key.startsWith('software-added/') };
  if (u.kind === 'bill_register') {
    const rows = await all<{ id: string }>(db, `SELECT id, line_no AS lineNo, bill_no AS billNo, bill_type AS billType, amount_paise AS amountPaise,
      discount_paise - tip_paise AS discountPaise, paid_with_row_id AS paidWithRowId, remarks, status, ocr_original AS ocrOriginal, edited_at AS editedAt,
      (SELECT count(*) FROM register_bank_adjustments a WHERE a.target_id = register_rows.id AND a.reverses_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM register_bank_adjustments x WHERE x.reverses_id = a.id)) > 0 AS bankAdjusted,
      (SELECT CASE WHEN c.decision = 'leave_out' THEN 'Left out' ELSE c.close_note END FROM bill_comparisons c
         WHERE c.register_row_id = register_rows.id AND (c.closed_at IS NOT NULL OR c.decision = 'leave_out') LIMIT 1) AS numberSettled,
      (SELECT 1 FROM bill_comparisons c WHERE c.register_row_id = register_rows.id AND c.decided_by IS NOT NULL LIMIT 1) AS numberDecided
      FROM register_rows WHERE upload_id = ? ORDER BY line_no`, u.id);
    const pays = await all<{ registerRowId: string }>(db, `SELECT p.id, p.register_row_id AS registerRowId, p.mode, p.column_label AS columnLabel,
      p.amount_paise AS amountPaise FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.upload_id = ? ORDER BY p.created_at, p.id`, u.id);
    const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, u.business_day);
    // Bill number check against the software report of the same shift: exact, or suggestions for typos and short numbers.
    const [swBills, shiftRows] = await Promise.all([
      all<{ bill_no: string; pos_no: string; amount_paise: number; mode: string; paid_at: number }>(db,
        'SELECT bill_no, pos_no, amount_paise, mode, paid_at FROM software_bills WHERE business_id = ? AND shift_day = ?', bid, u.business_day),
      all<{ id: string; bill_no: string; amount_paise: number; gross_paise: number }>(db,
        'SELECT id, bill_no, amount_paise - discount_paise + tip_paise AS amount_paise, amount_paise AS gross_paise FROM register_rows WHERE business_id = ? AND shift_day = ?', bid, u.business_day),
    ]);
    const matches = swBills.length ? suggestBills(shiftRows, swBills) : null;
    // Bill 26110158 written for ₹283 when the software's 26110158 is ₹145 (11 Nov 2026): the number may be a slip for a
    // bill of this amount that is not in the register, so it is checked like a number the software does not have.
    const amountOff = (id: string) => {
      const x = shiftRows.find((y) => y.id === id);
      const sw = x && swBills.find((b) => b.bill_no === x.bill_no);
      return !!x && !!sw && sw.amount_paise !== x.amount_paise && sw.amount_paise !== x.gross_paise;
    };
    // Typos: a number that fits another bill or its date's running numbers. Until a person has decided the bill.
    const toCheck = shift?.status === 'confirmed' ? [] : (rows as unknown as { id: string; numberSettled: string | null; numberDecided: number | null }[])
      .filter((r) => !r.numberSettled && !r.numberDecided && (!matches?.get(r.id)?.exact || amountOff(r.id)));
    const numbers = toCheck.length ? await numberContext(db, bid, u.business_day) : null;
    const flagsOf = new Map(numbers ? toCheck.map((r) => {
      const x = shiftRows.find((y) => y.id === r.id);
      const f = x ? numberFlags(x, numbers) : [];
      // A number the software has, for another amount: only a bill of this row's amount, a digit away, is worth saying.
      return [r.id, matches?.get(r.id)?.exact ? f.filter((y) => y.kind === 'pending' || y.kind === 'pending_typo') : f] as const;
    }) : []);
    // A cell Claude could not read (amount or payment): the software's amount for this bill, and a bank credit of that
    // amount near the bill's time, offered as a hint. Never applied by itself; clearly read cells get no hint.
    // The bank is shown only to people who can match it (Owner, Accountant); entry staff get the software's figure only.
    const bankOk = can(c.get('role') as Role, 'bank.link');
    const [credits, colHints] = bankOk ? await Promise.all([
      all<{ amount_paise: number; posted_at: number }>(db, `SELECT amount_paise, posted_at FROM bank_rows
        WHERE business_id = ? AND kind = 'upi_in' AND day BETWEEN ? AND ?`, bid, u.business_day, addDays(u.business_day, 1)),
      // A confirmed shift's column is changed on Reconcile, together with the match.
      shift?.status === 'confirmed' ? [] : columnHints(db, bid, u.business_day),
    ]) : [[], []];
    const hintFor = (r: { billNo: string; ocrOriginal: string | null }) => {
      if (!r.ocrOriginal) return null;
      let o: { unclear?: string[]; resolved?: string[] };
      try { o = JSON.parse(r.ocrOriginal); } catch { return null; }
      const open = (o.unclear ?? []).filter((f) => !(o.resolved ?? []).includes(f));
      if (!open.includes('amount') && !open.includes('payments')) return null;
      const sw = swBills.find((b) => b.bill_no === r.billNo);
      if (!sw) return null;
      const bankAt = credits.filter((x) => x.amount_paise === sw.amount_paise && Math.abs(x.posted_at - sw.paid_at) <= 30 * 60000)
        .sort((a, b) => Math.abs(a.posted_at - sw.paid_at) - Math.abs(b.posted_at - sw.paid_at))[0]?.posted_at ?? null;
      return { amountPaise: sw.amount_paise, mode: sw.mode, bankAt, fields: open.filter((f) => f === 'amount' || f === 'payments') };
    };
    // The bank credit that backs a number slip: what the row says was paid, near the bill it probably is (11 Nov 2026).
    const slipBank = (id: string) => {
      const f = flagsOf.get(id)?.filter((y) => y.kind === 'pending' || y.kind === 'pending_typo') ?? [];
      const sw = f.length === 1 ? swBills.find((b) => b.bill_no === f[0].billNo) : undefined;
      const paid = pays.filter((p) => p.registerRowId === id).reduce((t, p) => t + (p as unknown as { amountPaise: number }).amountPaise, 0);
      if (!sw || !paid) return null;
      const x = credits.filter((y) => y.amount_paise === paid && Math.abs(y.posted_at - sw.paid_at) <= 30 * 60000)
        .sort((a, b) => Math.abs(a.posted_at - sw.paid_at) - Math.abs(b.posted_at - sw.paid_at))[0];
      return x ? { amountPaise: x.amount_paise, at: x.posted_at } : null;
    };
    // A line whose bill is in an earlier or later shift's software report (a bill settled the next day, 11 Nov 2026):
    // said as such, not as a number the software does not have.
    const elsewhereBill = new Map((await all<{ rowId: string; day: string; mode: string | null; amount: number | null; decision: string | null }>(db, `
      SELECT here.register_row_id AS rowId, e.shift_day AS day, e.sw_mode AS mode, e.sw_amount_paise AS amount, e.decision
      FROM bill_comparisons here JOIN bill_comparisons e ON e.id = here.linked_to_id
      WHERE here.business_id = ? AND here.shift_day = ? AND here.register_row_id IS NOT NULL AND e.shift_day <> here.shift_day`, bid, u.business_day))
      .map((x) => [x.rowId, x]));
    // Rows of the same shift on its other register pages: bills paid together can run across sheets.
    const pages = await all<{ id: string }>(db, `SELECT DISTINCT u.id, u.created_at FROM uploads u JOIN register_rows r ON r.upload_id = u.id
      WHERE u.business_id = ? AND u.kind = 'bill_register' AND (r.shift_day = ? OR u.id = ?) ORDER BY u.created_at, u.id`, bid, u.business_day, u.id);
    const pageNo = new Map(pages.map((p, i) => [p.id, i + 1]));
    const [others, otherPays] = await Promise.all([
      all<{ id: string; uploadId: string }>(db, `SELECT id, upload_id AS uploadId, line_no AS lineNo, bill_no AS billNo, bill_type AS billType, amount_paise AS amountPaise,
        discount_paise - tip_paise AS discountPaise, paid_with_row_id AS paidWithRowId, remarks, status FROM register_rows
        WHERE business_id = ? AND shift_day = ? AND upload_id <> ? ORDER BY line_no`, bid, u.business_day, u.id),
      all<{ registerRowId: string }>(db, `SELECT p.register_row_id AS registerRowId, p.mode, p.column_label AS columnLabel, p.amount_paise AS amountPaise
        FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ? AND r.upload_id <> ?`, bid, u.business_day, u.id),
    ]);
    const slip = pageSlip(rows as unknown as SlipRow[], pays as unknown as { registerRowId: string; amountPaise: number }[]);
    const deleted = await all<{ before: string; after: string; at: number; by: string | null }>(db, `SELECT a.before, a.after, a.created_at AS at, us.name AS by
      FROM audit_log a LEFT JOIN users us ON us.id = a.user_id
      WHERE a.business_id = ? AND a.action = 'register.delete' AND json_extract(a.before, '$.uploadId') = ? ORDER BY a.id`, bid, u.id);
    return c.json({
      deletedRows: deleted.map((d) => ({ ...JSON.parse(d.before), ...JSON.parse(d.after), at: d.at, by: d.by })),
      ...base, shiftStatus: shift?.status ?? 'open', softwareBills: swBills.length, pageNo: pageNo.get(u.id) ?? 1, shiftPages: pages.length,
      slip: slip && { direction: slip.direction, lines: slip.lineNos, receiver: slip.receiverLineNo },
      // The shift's software bills, for the bill box's suggestions as you type.
      softwareList: swBills.map((b) => ({ billNo: b.bill_no, amountPaise: b.amount_paise, mode: b.mode, paidAt: b.paid_at, used: shiftRows.some((r) => r.bill_no === b.bill_no) })),
      rows: rows.map((r) => ({ ...r, payments: pays.filter((p) => p.registerRowId === r.id), billMatch: matches?.get(r.id) ?? null, numberFlags: flagsOf.get(r.id) ?? [],
        // "Use ₹145?" is not offered for a row whose own amount fits another bill a digit away.
        slipBank: slipBank(r.id),
        otherDayBill: elsewhereBill.get(r.id) ?? null,
        hint: flagsOf.get(r.id)?.some((f) => f.kind === 'pending_typo') ? null : hintFor(r as unknown as { billNo: string; ocrOriginal: string | null }), columnHint: colHints.find((h) => h.rowId === r.id) ?? null })),
      otherPageRows: others.map((r) => ({ ...r, pageNo: pageNo.get(r.uploadId) ?? null, payments: otherPays.filter((p) => p.registerRowId === r.id) })),
    });
  }
  if (u.kind === 'expense_list') {
    const rows = await all(db, `SELECT t.id, t.line_no AS lineNo, t.narration, t.amount_paise AS amountPaise, t.head_id AS headId, t.status,
      t.ocr_original AS ocrOriginal, t.party_id AS partyId, p.name AS vendor,
      (SELECT json_group_array(DISTINCT h) FROM (SELECT p.default_head_id AS h WHERE p.default_head_id IS NOT NULL
         UNION SELECT x.head_id FROM transactions x WHERE x.party_id = t.party_id AND x.head_id IS NOT NULL AND x.type = 'expense')) AS vendorHeads
      FROM transactions t LEFT JOIN parties p ON p.id = t.party_id WHERE t.upload_id = ? ORDER BY t.line_no`, u.id) as { id: string; narration: string | null; headId: string | null; status: string }[];
    // A draft line with no head: a one-click suggestion, from an earlier line with the same item, else from common words
    // (petrol → Transport). Never filled in by itself (approved 14 Nov 2026).
    const open = rows.filter((r) => r.status === 'draft' && !r.headId && r.narration);
    const [items, heads] = open.length ? await Promise.all([loadItemHistory(db, bid),
      all<{ id: string; name: string }>(db, "SELECT id, name FROM heads WHERE business_id = ? AND type = 'expense' ORDER BY created_at", bid)]) : [[], []];
    const suggest = (r: (typeof rows)[number]) => {
      if (r.status !== 'draft' || r.headId || !r.narration) return null;
      const fromItem = headFromItem(items.filter((h) => heads.some((x) => x.id === h.head_id)), r.narration);
      if (fromItem) return { headId: fromItem, from: 'item', word: null };
      const w = headFromWords(heads, r.narration);
      return w ? { headId: w.headId, from: 'words', word: w.word } : null;
    };
    return c.json({ ...base, rows: rows.map((r) => ({ ...r, suggestHead: suggest(r) })) });
  }
  if (u.kind === 'cash_summary') {
    const s = await one<SummaryValues & { id: string; shift_day: string; status: string; mismatch_note: string | null; mismatch_accepted_at: number | null }>(db,
      'SELECT * FROM cash_summaries WHERE upload_id = ?', u.id);
    const checks = await cashSummaryChecks(db, bid, s!.shift_day, s!);
    return c.json({ ...base, summary: {
      id: s!.id, status: s!.status, openingPaise: s!.opening_paise, receivedPaise: s!.received_paise, balancePaise: s!.balance_paise,
      expensesPaise: s!.expenses_paise, cashInHandPaise: s!.cash_in_hand_paise, mismatchNote: s!.mismatch_note, mismatchAcceptedAt: s!.mismatch_accepted_at,
      ocrOriginal: (s as unknown as { ocr_original: string | null }).ocr_original,
    }, checks });
  }
  return c.json(base);
});

// The total written at the bottom of a register or expense page, checked against its rows.
captureRoutes.patch('/businesses/:businessId/uploads/:uploadId', requireRole('rows.edit'), async (c) => {
  const u = await getUpload(c.env.DB, c.get('businessId'), c.req.param('uploadId'));
  const data = await body(c);
  if ('day' in data) {
    await changeDay(c.env.DB, c.get('businessId'), u, date(data, 'day', 'Day'), c.get('role'), c.get('user').id);
    return c.json({ ok: true });
  }
  if ('columnTotals' in data) {
    // The totals on the bottom line of a register page, by column; a blank one is left out.
    const raw = data.columnTotals;
    if (u.kind !== 'bill_register' || !raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Column totals are for a register page.');
    const out: ColumnTotals = {};
    for (const k of TOTAL_KEYS) {
      const v = optionalPaise(raw as Record<string, unknown>, k, `Total of ${k}`);
      if (v !== null) out[k] = v;
    }
    await stmt(c.env.DB, 'UPDATE uploads SET page_column_totals = ? WHERE id = ?', JSON.stringify(out), u.id).run();
    return c.json({ ok: true, columnTotals: out });
  }
  const total = optionalPaise(data, 'pageWrittenTotal', 'Page total');
  await stmt(c.env.DB, 'UPDATE uploads SET page_written_total_paise = ? WHERE id = ?', total, u.id).run();
  return c.json({ ok: true });
});

/**
 * Moves an expense list or cash summary page to another day, e.g. a page uploaded under today that
 * belongs to an earlier shift. Its lines move with it. Once anything on it is approved, only an
 * Owner or Accountant can move it. Audited.
 */
async function changeDay(db: DB, bid: string, u: Upload, day: string, role: Role, user: string) {
  if (u.kind !== 'expense_list' && u.kind !== 'cash_summary') fail(400, 'Only an expense list or cash summary page can change its day.');
  if (day > istDay(Date.now())) fail(400, 'The day cannot be in the future.');
  if (day === u.business_day) return;
  const approved = u.kind === 'expense_list'
    ? await one(db, "SELECT 1 AS ok FROM transactions WHERE upload_id = ? AND status = 'approved' LIMIT 1", u.id)
    : await one(db, "SELECT 1 AS ok FROM cash_summaries WHERE upload_id = ? AND status = 'approved'", u.id);
  if (approved && !can(role, 'rows.approve')) fail(403, 'Lines on this page are approved. Only an Owner or Accountant can change its day.');
  await db.batch([
    stmt(db, 'UPDATE uploads SET business_day = ? WHERE id = ?', day, u.id),
    u.kind === 'expense_list'
      ? stmt(db, 'UPDATE transactions SET day = ? WHERE upload_id = ? AND business_id = ?', day, u.id, bid)
      : stmt(db, 'UPDATE cash_summaries SET shift_day = ? WHERE upload_id = ? AND business_id = ?', day, u.id, bid),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'upload.day_changed', 'uploads', ?, ?, ?, ?)`, bid, user, u.id, JSON.stringify({ day: u.business_day }), JSON.stringify({ day }), now()),
  ]);
}

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
  const amountPaise = paise(data, 'amount', 'Bill amount');
  // One signed figure from the screen: positive = discount, negative = tip. Stored apart.
  const signed = optionalPaise(data, 'discount', 'Discount') ?? 0;
  const discountPaise = signed > 0 ? signed : 0;
  const tipPaise = signed < 0 ? -signed : 0;
  const paidWith = typeof data.paidWithRowId === 'string' && data.paidWithRowId ? data.paidWithRowId : null;
  if (paidWith && !isUuid(paidWith)) fail(400, 'Unknown row to be paid with.');
  if (paidWith && payments.length) fail(400, 'A bill paid together with another row has no payment of its own. Remove its payment first.');
  // A ticked bill says how it was paid (approved 7 Nov 2026): a bill with no payment, if its credit never came, would
  // be missed. Bills paid together with another row are paid there; a bill discounted to nothing needs no payment.
  if (status === 'checked' && !paidWith && amountPaise - discountPaise > 0 && !payments.some((p) => p.amountPaise > 0)) {
    fail(400, 'Write how this bill was paid (cash, UPI or card) before ticking it. If it was paid together with another bill, link it to that row.');
  }
  return {
    paidWithRowId: paidWith,
    // Bill numbers have no spaces. A draft line may have none yet (a line just added below); a ticked one must.
    billNo: (text(data, 'billNo', 'Bill number', { optional: status !== 'checked', max: 30 }) ?? '').replace(/\s+/g, ''),
    billType,
    amountPaise,
    discountPaise,
    tipPaise,
    remarks: text(data, 'remarks', 'Remarks', { optional: true, max: 300 }),
    payments,
    status,
  };
}

/**
 * A row that becomes the head of a group for the first time loses the Disc worked out for it alone (amount minus its
 * own payment): its payment now pays the whole group, so that figure would count the other bills twice. A Disc that
 * is anything else was typed and stays. "Fill discounts and tips" writes the group's real discount on this row afterwards.
 */
const newHeadStatement = (db: D1Database, headId: string, memberId: string) => stmt(db, `UPDATE register_rows SET discount_paise = 0, tip_paise = 0
  WHERE id = ? AND discount_paise - tip_paise <> 0
    AND discount_paise - tip_paise = amount_paise - (SELECT coalesce(sum(amount_paise), 0) FROM register_payments WHERE register_row_id = ?)
    AND NOT EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = ? AND m.id <> ?)`, headId, headId, headId, memberId);

/**
 * A discount can be no more than the bills it covers: its own row, or for the row with the payment, the whole group.
 * rowId is null for a new line. Also checks the group a changed or removed bill leaves or stays in, which may now be too small.
 */
async function checkDiscount(db: DB, businessId: string, rowId: string | null, r: { amountPaise: number; discountPaise: number; paidWithRowId: string | null }, oldHead: string | null) {
  const others = rowId ? (await one<{ n: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS n FROM register_rows WHERE paid_with_row_id = ?', rowId))!.n : 0;
  if (r.discountPaise > r.amountPaise + (r.paidWithRowId ? 0 : others)) fail(400, others ? 'Discount cannot be more than the bills paid with this row.' : 'Discount cannot be more than the bill amount.');
  if (rowId && oldHead) await checkHeadDiscount(db, businessId, oldHead, rowId, oldHead === r.paidWithRowId ? r.amountPaise : 0);
  if (r.paidWithRowId && r.paidWithRowId !== oldHead) await checkHeadDiscount(db, businessId, r.paidWithRowId, rowId, r.amountPaise);
}

/** The paying row's discount against its group, with one member counted at a new amount (0 when it is leaving). */
async function checkHeadDiscount(db: DB, businessId: string, headId: string, memberId: string | null, memberPaise: number) {
  const g = await one<{ discount: number; bills: number }>(db, `SELECT h.discount_paise AS discount, h.amount_paise + coalesce((SELECT sum(m.amount_paise) FROM register_rows m
    WHERE m.paid_with_row_id = h.id AND m.id <> coalesce(?, '')), 0) AS bills FROM register_rows h WHERE h.id = ? AND h.business_id = ?`, memberId, headId, businessId);
  if (g && g.discount > g.bills + memberPaise) fail(400, 'The discount on the row with the payment would be more than its bills. Change that discount first.');
}

/** Checks a "paid with" link: same business and shift, not itself, no chains. */
async function checkPaidWith(db: DB, businessId: string, rowId: string | null, shiftDay: string, headId: string | null) {
  if (!headId) return;
  if (headId === rowId) fail(400, 'A bill cannot be paid with itself.');
  const head = await one<{ shift_day: string; paid_with_row_id: string | null }>(db,
    'SELECT shift_day, paid_with_row_id FROM register_rows WHERE id = ? AND business_id = ?', headId, businessId);
  if (!head) fail(400, 'The row it was paid with was not found.');
  if (head.shift_day !== shiftDay) fail(400, 'Bills paid together must be in the same shift.');
  if (head.paid_with_row_id) fail(400, 'That row is itself paid with another row. Choose the row where the payment is written.');
  if (rowId && (await one(db, 'SELECT 1 AS ok FROM register_rows WHERE paid_with_row_id = ? LIMIT 1', rowId))) {
    fail(400, 'Other bills are paid with this row, so it must keep the payment.');
  }
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
  await checkPaidWith(db, bid, null, u.business_day, r.paidWithRowId);
  await checkDiscount(db, bid, null, r, null);
  const last = await one<{ n: number }>(db, 'SELECT coalesce(max(line_no), 0) AS n FROM register_rows WHERE upload_id = ?', u.id);
  const id = newId();
  const t = now();
  try {
    await db.batch([
      stmt(db, `INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, discount_paise, tip_paise, paid_with_row_id, remarks, status, edited_by, edited_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, u.id, last!.n + 1, u.business_day, r.billNo, r.billType, r.amountPaise, r.discountPaise, r.tipPaise, r.paidWithRowId, r.remarks, r.status,
        c.get('user').id, t, t),
      ...paymentStatements(db, bid, id, r.payments, t),
      ...(r.paidWithRowId ? [newHeadStatement(db, r.paidWithRowId, id)] : []),
      stmt(db, "UPDATE uploads SET ocr_engine = coalesce(ocr_engine, 'manual') WHERE id = ?", u.id),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await autoGroupDiscount(db, bid, [r.paidWithRowId], c.get('user').id);
  await refreshComparisons(db, bid, u.business_day, c.get('user').id);
  return c.json({ id }, 201);
});

// A blank line just below another, for two bills written on one line of the page. Later lines move down one.
// The new line is placed on the same line of the photo as the one above it.
captureRoutes.post('/businesses/:businessId/register-rows/:rowId/insert-below', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const above = await one<{ upload_id: string; line_no: number; shift_day: string; bill_type: string | null; ocr_original: string | null }>(db,
    'SELECT upload_id, line_no, shift_day, bill_type, ocr_original FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!above) fail(404, 'Row not found.');
  let place: { line?: number; y?: number } = {};
  try { const o = above.ocr_original ? JSON.parse(above.ocr_original) : {}; place = { line: o.line, y: o.y }; } catch { /* not JSON */ }
  const id = newId();
  const t = now();
  const user = c.get('user').id;
  try {
    await db.batch([
      stmt(db, 'UPDATE register_rows SET line_no = line_no + 1 WHERE upload_id = ? AND line_no > ?', above.upload_id, above.line_no),
      stmt(db, `INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, discount_paise, tip_paise, remarks, status, ocr_original, edited_by, edited_at, created_at)
        VALUES (?, ?, ?, ?, ?, '', ?, 0, 0, 0, NULL, 'draft', ?, ?, ?, ?)`, id, bid, above.upload_id, above.line_no + 1, above.shift_day, above.bill_type,
        JSON.stringify({ engine: 'manual', addedBelow: rowId, ...place }), user, t, t),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'register.insert_below', 'register_rows', ?, NULL, ?, ?)`, bid, user, id, JSON.stringify({ below: rowId, lineNo: above.line_no + 1 }), t),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  return c.json({ id }, 201);
});

/**
 * Two bills the reader found on one line ("145232 145192", amount "188+351"), as they read: two numbers and two amounts.
 * Null when the line does not read that way, or it was split already (a line added or split below it).
 */
export function splitOfReading(ocr: string | null) {
  if (!ocr) return null;
  let o: { read?: { bill_no?: string | null; amount?: string | null }; splitInto?: string };
  try { o = JSON.parse(ocr); } catch { return null; }
  if (o.splitInto) return null;
  const bills = (o.read?.bill_no ?? '').trim().split(/[\s,/&+]+/).filter(Boolean);
  const amounts = (o.read?.amount ?? '').trim().split(/[\s,/&+]+/).filter(Boolean).map((a) => parsePaiseText(a));
  if (bills.length !== 2 || amounts.length !== 2 || amounts.some((a) => a === null || a <= 0)) return null;
  return { bills: bills as [string, string], amounts: amounts as [number, number] };
}
const parsePaiseText = (v: string) => {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.replace(/,/g, ''));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};

// Split a line the reader found two bills on (approved 13 Nov 2026): this row keeps the first bill and its payments,
// a new line below takes the second, paid with the same row as the first (or with this row when it holds the payment).
// Both go back to draft for a person to check against the photo.
captureRoutes.post('/businesses/:businessId/register-rows/:rowId/split', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const row = await one<{ upload_id: string; line_no: number; shift_day: string; bill_no: string; bill_type: string | null; amount_paise: number; paid_with_row_id: string | null; ocr_original: string | null }>(db,
    'SELECT upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, paid_with_row_id, ocr_original FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!row) fail(404, 'Row not found.');
  const sp = splitOfReading(row.ocr_original);
  if (!sp) fail(400, 'This line was not read as two bills with two amounts. Use Add a line below instead.');
  if (await one(db, "SELECT 1 AS ok FROM register_rows WHERE business_id = ? AND json_extract(ocr_original, '$.addedBelow') = ? LIMIT 1", bid, rowId)) {
    fail(400, 'A line was already added below this one for its second bill. Correct the two lines instead.');
  }
  const paysHere = await one(db, 'SELECT 1 AS ok FROM register_payments WHERE register_row_id = ? LIMIT 1', rowId);
  const paidWith = row.paid_with_row_id ?? (paysHere ? rowId : null);
  const o = JSON.parse(row.ocr_original!) as Record<string, unknown> & { resolved?: string[]; line?: number; y?: number };
  const id = newId();
  const t = now();
  const user = c.get('user').id;
  try {
    await db.batch([
      stmt(db, 'UPDATE register_rows SET line_no = line_no + 1 WHERE upload_id = ? AND line_no > ?', row.upload_id, row.line_no),
      stmt(db, "UPDATE register_rows SET bill_no = ?, amount_paise = ?, status = 'draft', ocr_original = ?, edited_by = ?, edited_at = ? WHERE id = ?",
        sp.bills[0], sp.amounts[0], JSON.stringify({ ...o, splitInto: id, resolved: [...new Set([...(o.resolved ?? []), 'bill_no', 'amount'])] }), user, t, rowId),
      stmt(db, `INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, discount_paise, tip_paise, paid_with_row_id, remarks, status, ocr_original, edited_by, edited_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, 'draft', ?, ?, ?, ?)`, id, bid, row.upload_id, row.line_no + 1, row.shift_day, sp.bills[1], row.bill_type, sp.amounts[1], paidWith,
        JSON.stringify({ engine: 'split', splitFrom: rowId, line: o.line, y: o.y, resolved: ['bill_no', 'amount'] }), user, t, t),
      ...(paidWith === rowId ? [newHeadStatement(db, rowId, id)] : []),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'register.split', 'register_rows', ?, ?, ?, ?)`,
        bid, user, rowId, JSON.stringify({ billNo: row.bill_no, amountPaise: row.amount_paise }),
        JSON.stringify({ newRowId: id, changes: `Split into ${sp.bills[0]} ${rupees(sp.amounts[0])} and ${sp.bills[1]} ${rupees(sp.amounts[1])}` }), t),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'register.split', 'register_rows', ?, NULL, ?, ?)`,
        bid, user, id, JSON.stringify({ splitFrom: rowId, changes: `Split from the line read as ${sp.bills.join(' ')}` }), t),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await autoGroupDiscount(db, bid, [paidWith], user);
  await refreshComparisons(db, bid, row.shift_day, user);
  return c.json({ id, bills: sp.bills, amounts: sp.amounts }, 201);
});


/**
 * A group's discount filled by itself after a line changes (approved 13 Nov 2026), when the group looks complete: less
 * was paid than billed, by no more than the large-discount limit, and no row is at ₹0 or has an amount not read. It
 * goes on the row with the payment, marked so the screen says it was filled. A discount a person typed or took off
 * is never touched. A filled one that no longer fits (the bills or payment changed) is worked out again, or taken off
 * when the group no longer qualifies: more paid than billed, a row at ₹0, or too large a gap stay with a person.
 */
async function autoGroupDiscount(db: DB, businessId: string, heads: (string | null | undefined)[], user: string) {
  for (const headId of [...new Set(heads.filter((x): x is string => !!x))]) {
    const rows = await all<{ id: string; amount_paise: number; discount_paise: number; tip_paise: number; paid_with_row_id: string | null; status: string; ocr_original: string | null }>(db,
      'SELECT id, amount_paise, discount_paise, tip_paise, paid_with_row_id, status, ocr_original FROM register_rows WHERE business_id = ? AND (id = ? OR paid_with_row_id = ?)', businessId, headId, headId);
    const head = rows.find((r) => r.id === headId);
    if (!head || head.paid_with_row_id || rows.length < 2) continue;
    const ocrOf = (r: { ocr_original: string | null }) => { try { return (r.ocr_original ? JSON.parse(r.ocr_original) : {}) as Record<string, unknown> & { inferred?: string[]; resolved?: string[]; unclear?: string[]; autoGroupDiscount?: boolean }; } catch { return {}; } };
    const o = ocrOf(head);
    const typed = (r: (typeof rows)[number]) => { const x = ocrOf(r); return (x.resolved ?? []).includes('discount') || ((r.discount_paise || r.tip_paise) > 0 && !stillInferred(r.ocr_original, 'discount')); };
    if (rows.some(typed)) continue;
    if (rows.some((r) => r.id !== headId && (r.discount_paise || r.tip_paise))) continue;
    const paid = (await one<{ n: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS n FROM register_payments WHERE register_row_id = ?', headId))!.n;
    const gross = rows.reduce((t, r) => t + r.amount_paise, 0);
    const unread = (r: (typeof rows)[number]) => { const x = ocrOf(r); return (x.unclear ?? []).includes('amount') && !(x.resolved ?? []).includes('amount'); };
    const gap = gross - paid;
    const fits = paid > 0 && gap > 0 && gap * 100 <= LARGE_DISCOUNT_PCT * gross && rows.every((r) => r.amount_paise > 0 && !unread(r));
    const want = fits ? gap : 0;
    if (!fits && !o.autoGroupDiscount) continue;           // nothing filled here before: a person decides
    if (head.discount_paise === want && head.tip_paise === 0 && !!o.autoGroupDiscount === fits) continue;
    const inferred = new Set((o.inferred ?? []).filter((f) => f !== 'discount'));
    if (fits) inferred.add('discount');
    const next = { ...o, inferred: [...inferred], autoGroupDiscount: fits || undefined };
    const pct = gross ? (gap * 1000 / gross) : 0;
    const words = fits ? `Discount filled: ${rupees(gap)} (${(Math.round(pct) / 10).toString()}% of ${rupees(gross)} of bills, ${rupees(paid)} paid)`
      : `Filled discount ${rupees(head.discount_paise)} taken off: the group now needs a person (${gap < 0 ? `${rupees(-gap)} more paid than billed` : rows.some((r) => !r.amount_paise || unread(r)) ? 'a row at ₹0 or not read' : gap > 0 ? 'the gap is over the large-discount limit' : 'it balances'})`;
    const t = now();
    await db.batch([
      stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = 0, ocr_original = ?, edited_by = ?, edited_at = ? WHERE id = ?', want, JSON.stringify(next), user, t, headId),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'register.auto_discount', 'register_rows', ?, ?, ?, ?)`,
        businessId, user, headId, JSON.stringify({ discountPaise: head.discount_paise, tipPaise: head.tip_paise }), JSON.stringify({ discountPaise: want, grossPaise: gross, paidPaise: paid, changes: words }), t),
    ]).catch((e) => { if (!isShiftConfirmed(e)) throw e; });
  }
}

captureRoutes.put('/businesses/:businessId/register-rows/:rowId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const old = await one<{ shift_day: string; bill_no: string; bill_type: string | null; amount_paise: number; discount_paise: number; tip_paise: number; paid_with_row_id: string | null; remarks: string | null; status: string; ocr_original: string | null }>(db,
    'SELECT shift_day, bill_no, bill_type, amount_paise, discount_paise, tip_paise, paid_with_row_id, remarks, status, ocr_original FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!old) fail(404, 'Row not found.');
  const data = await body(c);
  const r = registerInput(data);
  // Fields a person confirmed as they are (e.g. the bill number picked from the software list, the same as read).
  const confirmed = (Array.isArray(data.confirm) ? data.confirm : []).filter((f): f is string => typeof f === 'string' && ['bill_no', 'amount'].includes(f));
  await checkPaidWith(db, bid, rowId, old.shift_day, r.paidWithRowId);
  await checkDiscount(db, bid, rowId, r, old.paid_with_row_id);
  const t = now();
  // A field a person changes counts as resolved: its "Needs input" mark goes, the others stay until the row is checked.
  // The original reading and its "unclear" list are kept as they were.
  let ocr = old.ocr_original;
  const oldPays = await all<{ mode: string; amount_paise: number; column_label: string | null }>(db,
    'SELECT mode, amount_paise, column_label FROM register_payments WHERE register_row_id = ? ORDER BY created_at, id', rowId);
  const key = (ps: { mode: string; amount: number; label: string | null }[]) => JSON.stringify(ps.map((p) => [p.mode, p.amount, p.label ?? '']).sort());
  // An amount the reader could not read was drafted as ₹0 (13 Nov 2026): the row cannot be ticked at ₹0 until a person
  // types the amount, or says the bill really is ₹0.
  if (ocr && r.status === 'checked' && r.amountPaise === 0 && old.amount_paise === 0 && !confirmed.includes('amount')) {
    const o = JSON.parse(ocr) as { unclear?: string[]; resolved?: string[] };
    if ((o.unclear ?? []).includes('amount') && !(o.resolved ?? []).includes('amount')) {
      throw new HTTPException(400, { message: `The amount of bill ${r.billNo || 'on this line'} could not be read, so it is ₹0 for now. Type the amount from the photo, or confirm the bill really is ₹0.`, cause: { code: 'amount_unread' } });
    }
  }
  const editAudit = rowEditAudit(old, oldPays, r);
  if (ocr) {
    const changed = [
      old.bill_no !== r.billNo && 'bill_no',
      old.bill_type !== r.billType && 'bill_type',
      old.amount_paise !== r.amountPaise && 'amount',
      (old.discount_paise !== r.discountPaise || old.tip_paise !== r.tipPaise) && 'discount',
      (old.remarks ?? null) !== r.remarks && 'remarks',
      (old.paid_with_row_id !== r.paidWithRowId || key(oldPays.map((p) => ({ mode: p.mode, amount: p.amount_paise, label: p.column_label }))) !== key(r.payments.map((p) => ({ mode: p.mode, amount: p.amountPaise, label: p.columnLabel })))) && 'payments',
      ...confirmed,
    ].filter(Boolean) as string[];
    if (changed.length) {
      const o = JSON.parse(ocr) as { resolved?: string[] };
      o.resolved = [...new Set([...(o.resolved ?? []), ...changed])];
      ocr = JSON.stringify(o);
    }
  }
  try {
    await db.batch([
      stmt(db, `UPDATE register_rows SET bill_no = ?, bill_type = ?, amount_paise = ?, discount_paise = ?, tip_paise = ?, paid_with_row_id = ?, remarks = ?, status = ?, edited_by = ?, edited_at = ?, ocr_original = ?
        WHERE id = ? AND business_id = ?`, r.billNo, r.billType, r.amountPaise, r.discountPaise, r.tipPaise, r.paidWithRowId, r.remarks, r.status, c.get('user').id, t, ocr, rowId, bid),
      stmt(db, 'DELETE FROM register_payments WHERE register_row_id = ?', rowId),
      ...paymentStatements(db, bid, rowId, r.payments, t),
      ...(r.paidWithRowId && r.paidWithRowId !== old.paid_with_row_id ? [newHeadStatement(db, r.paidWithRowId, rowId)] : []),
      ...(editAudit ? [stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'register.edit', 'register_rows', ?, ?, ?, ?)`, bid, c.get('user').id, rowId, JSON.stringify(editAudit.before), JSON.stringify(editAudit.after), t)] : []),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await autoGroupDiscount(db, bid, [r.paidWithRowId ?? rowId, old.paid_with_row_id], c.get('user').id);
  await refreshComparisons(db, bid, old.shift_day, c.get('user').id);
  return c.json({ ok: true });
});

const rupees = (p: number) => `₹${p < 0 ? '-' : ''}${Math.trunc(Math.abs(p) / 100).toLocaleString('en-IN')}${Math.abs(p) % 100 ? `.${String(Math.abs(p) % 100).padStart(2, '0')}` : ''}`;
const MODE_WORD: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card' };
const paysText = (ps: { mode: string; amount: number; label: string | null }[]) =>
  ps.length ? ps.map((p) => `${p.label || MODE_WORD[p.mode] || p.mode} ${rupees(p.amount)}`).join(' + ') : 'none';

/**
 * Each change to a register row, kept in the audit log with the old and new values and a line in words for the bill's
 * History (approved 13 Nov 2026). Null when nothing changed.
 */
function rowEditAudit(old: { bill_no: string; bill_type: string | null; amount_paise: number; discount_paise: number; tip_paise: number; paid_with_row_id: string | null; remarks: string | null; status?: string },
  oldPays: { mode: string; amount_paise: number; column_label: string | null }[], r: ReturnType<typeof registerInput>) {
  const before = { billNo: old.bill_no, billType: old.bill_type, amountPaise: old.amount_paise, discountPaise: old.discount_paise, tipPaise: old.tip_paise,
    paidWithRowId: old.paid_with_row_id, remarks: old.remarks ?? null, status: old.status ?? null,
    payments: oldPays.map((p) => ({ mode: p.mode, amount: p.amount_paise, label: p.column_label })) };
  const after = { billNo: r.billNo, billType: r.billType, amountPaise: r.amountPaise, discountPaise: r.discountPaise, tipPaise: r.tipPaise,
    paidWithRowId: r.paidWithRowId, remarks: r.remarks, status: r.status, payments: r.payments.map((p) => ({ mode: p.mode, amount: p.amountPaise, label: p.columnLabel })) };
  const TYPE: Record<string, string> = { fnb: 'F&B', room: 'Room' };
  const disc = (d: number, tip: number) => (d - tip < 0 ? `tip ${rupees(tip - d)}` : rupees(d - tip));
  const words: string[] = [];
  if (before.billNo !== after.billNo) words.push(`Bill no. ${before.billNo || '(blank)'} → ${after.billNo || '(blank)'}`);
  if (before.billType !== after.billType) words.push(`Type ${TYPE[before.billType ?? ''] ?? '–'} → ${TYPE[after.billType ?? ''] ?? '–'}`);
  if (before.amountPaise !== after.amountPaise) words.push(`Amount ${rupees(before.amountPaise)} → ${rupees(after.amountPaise)}`);
  if (before.discountPaise - before.tipPaise !== after.discountPaise - after.tipPaise) words.push(`Discount ${disc(before.discountPaise, before.tipPaise)} → ${disc(after.discountPaise, after.tipPaise)}`);
  const pk = (ps: { mode: string; amount: number; label: string | null }[]) => JSON.stringify(ps.map((p) => [p.mode, p.amount, p.label ?? '']).sort());
  if (pk(before.payments) !== pk(after.payments)) words.push(`Payments ${paysText(before.payments)} → ${paysText(after.payments)}`);
  if (before.paidWithRowId !== after.paidWithRowId) words.push(after.paidWithRowId ? 'Linked to be paid with another row' : 'Unlinked: pays on its own');
  if (before.remarks !== after.remarks) words.push(`Remarks "${before.remarks ?? ''}" → "${after.remarks ?? ''}"`);
  if (before.status && before.status !== after.status) words.push(after.status === 'checked' ? 'Ticked as checked' : 'Tick removed');
  return words.length ? { before, after: { ...after, changes: words.join('; ') } } : null;
}

interface SlipRow { id: string; lineNo: number; amountPaise: number; paidWithRowId: string | null; status: string }

/**
 * Payments read a line off on this page (see findSlip), as the rows involved: "slice" is every row whose payments
 * change, "moves" says which row's payments each takes. The one row left with the odd payment out ("receiver")
 * gets it and stays marked for a person. Null when there is nothing to move or a row involved is already checked.
 */
function pageSlip<R extends SlipRow>(rows: R[], pays: { registerRowId: string; amountPaise: number }[]) {
  const sorted = [...rows].sort((a, b) => a.lineNo - b.lineNo);
  const paid = (id: string) => { const p = pays.filter((x) => x.registerRowId === id); return p.length ? p.reduce((t, x) => t + x.amountPaise, 0) : null; };
  const heads = new Set(sorted.map((r) => r.paidWithRowId).filter(Boolean));
  const slip: Slip | null = findSlip(sorted.map((r, i) => ({ line: i, amt: r.amountPaise, paid: paid(r.id), grouped: !!r.paidWithRowId || heads.has(r.id) })));
  if (!slip) return null;
  const lo = Math.min(...slip.lines), hi = Math.max(...slip.lines);
  // "up": rows lo..hi hold the payments of the row below each. "down": rows lo..hi hold the payments of the row above.
  const [first, last] = slip.direction === 'up' ? [lo, hi + 1] : [lo - 1, hi];
  const slice = sorted.slice(first, last + 1);
  if (slice.some((r) => r.status === 'checked')) return null;
  const moves = new Map<string, string>(); // row id → id of the row whose payments it takes
  if (slip.direction === 'up') {
    for (let k = first; k < last; k++) moves.set(sorted[k + 1].id, sorted[k].id);
    moves.set(sorted[first].id, sorted[last].id);
  } else {
    for (let k = first + 1; k <= last; k++) moves.set(sorted[k - 1].id, sorted[k].id);
    moves.set(sorted[last].id, sorted[first].id);
  }
  const receiver = slip.direction === 'up' ? sorted[first] : sorted[last];
  return { direction: slip.direction, slice, moves, receiver, lineNos: slice.map((r) => r.lineNo), receiverLineNo: receiver.lineNo };
}

// Moves the payments of the rows read a line off back to their own bills, in one step. Unchecked rows only.
// Worked-out discounts on those rows are worked out again; the row left with the odd payment stays marked. Logged.
captureRoutes.post('/businesses/:businessId/uploads/:uploadId/shift-payments', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const u = await getUpload(db, bid, c.req.param('uploadId'));
  if (u.kind !== 'bill_register') fail(400, 'This page is not a bill register.');
  const b = await body(c);
  const rows = await all<SlipRow & { discountPaise: number; tipPaise: number; ocrOriginal: string | null }>(db, `SELECT id, line_no AS lineNo, amount_paise AS amountPaise,
    paid_with_row_id AS paidWithRowId, status, discount_paise AS discountPaise, tip_paise AS tipPaise, ocr_original AS ocrOriginal FROM register_rows WHERE upload_id = ?`, u.id);
  const pays = await all<{ id: string; registerRowId: string; amountPaise: number }>(db, `SELECT p.id, p.register_row_id AS registerRowId, p.amount_paise AS amountPaise
    FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.upload_id = ?`, u.id);
  const slip = pageSlip(rows, pays);
  if (!slip || slip.direction !== b.direction) fail(409, 'The payments on this page no longer look shifted. Reload the page.');
  const t = now();
  const user = c.get('user').id;
  const statements: D1PreparedStatement[] = [];
  const done: { rowId: string; lineNo: number; fromRowId: string; paidPaise: number }[] = [];
  for (const r of slip!.slice) {
    const from = slip!.moves.get(r.id)!;
    const moved = pays.filter((p) => p.registerRowId === from);
    for (const p of moved) statements.push(stmt(db, 'UPDATE register_payments SET register_row_id = ? WHERE id = ?', r.id, p.id));
    const paid = moved.reduce((t2, p) => t2 + p.amountPaise, 0);
    const o = r.ocrOriginal ? JSON.parse(r.ocrOriginal) : {};
    const inferred = new Set<string>(o.inferred ?? []);
    const resolved = new Set<string>(o.resolved ?? []);
    const unclear = new Set<string>(o.unclear ?? []);
    let disc = r.discountPaise, tip = r.tipPaise;
    // A discount or tip worked out from the wrong payment is worked out again from the right one.
    if ((!disc && !tip) || stillInferred(r.ocrOriginal, 'discount')) {
      const v = paid > 0 ? spreadDifference({ id: r.id, amountPaise: r.amountPaise }, [], paid)?.get(r.id) : undefined;
      disc = v?.discountPaise ?? 0; tip = v?.tipPaise ?? 0;
      inferred.delete('discount');
      if (disc || tip) inferred.add('discount');
    }
    if (r.id === slip!.receiver.id && paid !== r.amountPaise - disc + tip) { unclear.add('payments'); resolved.delete('payments'); }
    else { inferred.add('payments'); resolved.add('payments'); }
    Object.assign(o, { inferred: [...inferred], resolved: [...resolved], unclear: [...unclear], movedFromRow: from });
    statements.push(stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ?, ocr_original = ?, edited_by = ?, edited_at = ? WHERE id = ?',
      disc, tip, JSON.stringify(o), user, t, r.id));
    done.push({ rowId: r.id, lineNo: r.lineNo, fromRowId: from, paidPaise: paid });
  }
  try {
    await db.batch([...statements, stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'register.shift_payments', 'uploads', ?, NULL, ?, ?)`, bid, user, u.id, JSON.stringify({ direction: slip!.direction, moves: done }), t)]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await refreshComparisons(db, bid, u.business_day, user);
  return c.json({ moved: done.length, checkLine: slip!.receiverLineNo });
});

// Fills discount = bill amount - payments on this page's rows with no discount or tip yet: a discount
// when less was paid than billed, a tip when more was. Rows with no payment or paid exactly are left alone. Logged.
captureRoutes.post('/businesses/:businessId/uploads/:uploadId/fill-discounts', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const u = await getUpload(db, bid, c.req.param('uploadId'));
  if (u.kind !== 'bill_register') fail(400, 'This page is not a bill register.');
  // For bills paid together, the bills of the whole group are compared with the one payment, and a discount
  // or tip goes on the row with the payment. A group is filled only
  // when none of its discounts or tips were typed by a person (amounts filled in earlier are worked out again).
  const rows = await all<{ id: string; amount_paise: number; discount_paise: number; tip_paise: number; paid_with_row_id: string | null; ocr_original: string | null; paid: number; n: number }>(db, `
    SELECT r.id, r.amount_paise, r.discount_paise, r.tip_paise, r.paid_with_row_id, r.ocr_original,
      coalesce(sum(p.amount_paise), 0) AS paid, count(p.id) AS n
    FROM register_rows r LEFT JOIN register_payments p ON p.register_row_id = r.id
    WHERE r.business_id = ? AND r.shift_day = ? GROUP BY r.id`, bid, u.business_day);
  // Groups with a bill on this page; their other bills may be on other pages of the same shift.
  const onPage = new Set((await all<{ id: string; head: string }>(db,
    'SELECT id, coalesce(paid_with_row_id, id) AS head FROM register_rows WHERE upload_id = ?', u.id)).map((r) => r.head));
  const autoOrNone = (r: (typeof rows)[number]) => (!r.discount_paise && !r.tip_paise) || stillInferred(r.ocr_original, 'discount');
  const fill: { id: string; discountPaise: number; tipPaise: number; ocr: string | null }[] = [];
  for (const head of rows.filter((r) => !r.paid_with_row_id && r.n > 0 && r.paid > 0 && onPage.has(r.id))) {
    const group = [head, ...rows.filter((m) => m.paid_with_row_id === head.id)];
    if (!group.every(autoOrNone)) continue;
    const spread = onPayingRow({ id: head.id, amountPaise: head.amount_paise }, group.slice(1).map((m) => ({ id: m.id, amountPaise: m.amount_paise })), head.paid);
    if (!spread) continue;
    for (const r of group) {
      const v = spread.get(r.id)!;
      if (v.discountPaise === r.discount_paise && v.tipPaise === r.tip_paise) continue;
      let ocr = r.ocr_original;
      const o = ocr ? JSON.parse(ocr) : {};
      const inferred = new Set<string>((o.inferred ?? []).filter((f: string) => f !== 'discount'));
      if (v.discountPaise || v.tipPaise) inferred.add('discount');
      o.inferred = [...inferred];
      o.resolved = (o.resolved ?? []).filter((f: string) => f !== 'discount');
      ocr = JSON.stringify(o);
      fill.push({ id: r.id, ...v, ocr });
    }
  }
  if (!fill.length) return c.json({ filled: 0 });
  const t = now();
  const user = c.get('user').id;
  try {
    await db.batch([
      ...fill.map((r) => stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ?, ocr_original = ?, edited_by = ?, edited_at = ? WHERE id = ?',
        r.discountPaise, r.tipPaise, r.ocr, user, t, r.id)),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'register.fill_discounts', 'uploads', ?, NULL, ?, ?)`, bid, user, u.id,
        JSON.stringify(fill.map((r) => ({ rowId: r.id, discountPaise: r.discountPaise, tipPaise: r.tipPaise }))), t),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await refreshComparisons(db, bid, u.business_day, user);
  return c.json({ filled: fill.length });
});

const DELETE_REASONS = ['written_twice', 'not_a_bill', 'cancelled', 'misread', 'other'];

captureRoutes.delete('/businesses/:businessId/register-rows/:rowId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const old = await one<{ shift_day: string; upload_id: string; line_no: number; bill_no: string; amount_paise: number; discount_paise: number; paid_with_row_id: string | null }>(db,
    'SELECT shift_day, upload_id, line_no, bill_no, amount_paise, discount_paise, paid_with_row_id FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!old) fail(404, 'Row not found.');
  if (old.paid_with_row_id) await checkHeadDiscount(db, bid, old.paid_with_row_id, rowId, 0);
  // Why the line went: the page's totals still include it, so Review explains the difference with it.
  const data = await body(c).catch(() => ({} as Record<string, unknown>));
  const reason = typeof data.reason === 'string' && DELETE_REASONS.includes(data.reason) ? data.reason : 'other';
  const note = typeof data.note === 'string' ? data.note.trim().slice(0, 200) || null : null;
  const pays = await all<{ mode: string; columnLabel: string | null; amountPaise: number }>(db,
    'SELECT mode, column_label AS columnLabel, amount_paise AS amountPaise FROM register_payments WHERE register_row_id = ?', rowId);
  try {
    await db.batch([
      stmt(db, 'DELETE FROM register_rows WHERE id = ? AND business_id = ?', rowId, bid),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'register.delete', 'register_rows', ?, ?, ?, ?)`, bid, c.get('user').id, rowId,
        JSON.stringify({ uploadId: old.upload_id, lineNo: old.line_no, billNo: old.bill_no, amountPaise: old.amount_paise, discountPaise: old.discount_paise, payments: pays }),
        JSON.stringify({ reason, note }), now()),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  await autoGroupDiscount(db, bid, [old.paid_with_row_id], c.get('user').id);
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

/** No head chosen and none from the party: the head of an earlier line with the same item (approved 14 Nov 2026). */
async function withItemHead<T extends { headId: string | null; learned: boolean }>(db: DB, bid: string, narration: string, v: T): Promise<T & { from: 'party' | 'item' }> {
  if (v.headId) return { ...v, from: 'party' };
  const headId = headFromItem(await loadItemHistory(db, bid), narration);
  return headId ? { ...v, headId, learned: true, from: 'item' } : { ...v, from: 'party' };
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
  const chosenHead = await expenseHead(db, bid, data);
  const vendor = text(data, 'vendor', 'Party', { optional: true, max: 120 });
  const v = await withItemHead(db, bid, narration, resolveVendor(db, bid, await loadParties(db, bid), { vendor, narration, headId: chosenHead }, await loadHistory(db, bid)));
  const account = await cashAccount(db, bid);
  const last = await one<{ n: number }>(db, 'SELECT coalesce(max(line_no), 0) AS n FROM transactions WHERE upload_id = ?', u.id);
  const id = newId();
  await db.batch([
    ...v.statements,
    stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode,
      upload_id, line_no, party_id, ocr_original, created_at) VALUES (?, ?, ?, ?, ?, 'expense', ?, ?, 'cash_photo', 'draft', 'cash', ?, ?, ?, ?, ?)`,
      id, bid, account, u.business_day, amount, v.headId, narration, u.id, last!.n + 1, v.partyId, markLearned(null, v.learned, v.from), now()),
    stmt(db, "UPDATE uploads SET ocr_engine = coalesce(ocr_engine, 'manual') WHERE id = ?", u.id),
  ]);
  return c.json({ id }, 201);
});

captureRoutes.put('/businesses/:businessId/expense-rows/:rowId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = c.req.param('rowId');
  if (!isUuid(rowId)) fail(404, 'Row not found.');
  const old = await one<{ ocr_original: string | null }>(db,
    "SELECT ocr_original FROM transactions WHERE id = ? AND business_id = ? AND source = 'cash_photo' AND status = 'draft'", rowId, bid);
  if (!old) fail(404, 'Draft row not found. Approved rows cannot be edited.');
  const data = await body(c);
  const narration = text(data, 'narration', 'Item', { max: 200 })!;
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than zero.');
  const chosenHead = await expenseHead(db, bid, data);
  const vendor = text(data, 'vendor', 'Party', { optional: true, max: 120 });
  const v = await withItemHead(db, bid, narration, resolveVendor(db, bid, await loadParties(db, bid), { vendor, narration, headId: chosenHead }, await loadHistory(db, bid)));
  await db.batch([
    ...v.statements,
    stmt(db, `UPDATE transactions SET narration = ?, amount_paise = ?, head_id = ?, party_id = ?, ocr_original = ?
      WHERE id = ? AND business_id = ? AND source = 'cash_photo' AND status = 'draft'`,
      narration, amount, v.headId, v.partyId, markLearned(old.ocr_original, v.learned, v.from), rowId, bid),
  ]);
  return c.json({ ok: true, headId: v.headId, learned: v.learned, from: v.from });
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
  if (s.status === 'draft') fail(409, 'Check the five figures against the page and press Save figures first.');
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

// ---- Vendors (parties) and the head each is remembered under

captureRoutes.get('/businesses/:businessId/parties', requireRole('heads.view'), async (c) => {
  const parties = await all(c.env.DB, `
    SELECT p.id, p.name, p.aliases, p.default_head_id AS defaultHeadId,
      (SELECT count(*) FROM transactions t WHERE t.party_id = p.id) AS lines,
      (SELECT json_group_array(json_object('headId', head_id, 'lines', n)) FROM (SELECT head_id, count(*) AS n FROM transactions t
         WHERE t.party_id = p.id AND t.head_id IS NOT NULL AND t.type = 'expense' GROUP BY head_id ORDER BY n DESC)) AS heads
    FROM parties p WHERE p.business_id = ? ORDER BY lower(p.name)`, c.get('businessId'));
  return c.json({ parties: parties.map((p) => ({ ...p, aliases: JSON.parse(p.aliases as string), heads: JSON.parse(p.heads as string) })) });
});

// Rename a vendor, move it under another head, or set its other spellings. Owner or Accountant.
captureRoutes.patch('/businesses/:businessId/parties/:partyId', requireRole('heads.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('partyId');
  if (!isUuid(id)) fail(404, 'Vendor not found.');
  const data = await body(c);
  const before = await one<Record<string, unknown>>(db, 'SELECT name, aliases, default_head_id FROM parties WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Vendor not found.');
  const name = text(data, 'name', 'Vendor name', { max: 120 })!;
  const headId = await expenseHead(db, bid, { headId: data.defaultHeadId });
  const aliases = Array.isArray(data.aliases) ? data.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim().slice(0, 120)).slice(0, 20) : JSON.parse(before.aliases as string);
  try {
    await db.batch([
      stmt(db, 'UPDATE parties SET name = ?, default_head_id = ?, aliases = ? WHERE id = ? AND business_id = ?', name, headId, JSON.stringify(aliases), id, bid),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'party.update', 'parties', ?, ?, ?, ?)`, bid, c.get('user').id, id, JSON.stringify(before),
        JSON.stringify({ name, default_head_id: headId, aliases }), now()),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'Another party already has this name.');
    throw e;
  }
  return c.json({ ok: true });
});
