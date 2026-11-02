import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, isShiftConfirmed, isUniqueViolation, newId, now, one, stmt } from '../db';
import { body, fail, isUuid, text } from '../http';
import { sha256 } from '../crypto';
import { parseSalesCsv } from '../salescsv';
import { shiftDayOf } from '../time';
import { storageKey } from '../files';
import { confirmShift, NEEDS_DECISION, refreshComparisons, reopenShift, shiftStatement, shiftView, type Decision } from '../sales';

export const salesRoutes = new Hono<AppEnv>();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIRMED = 'This shift is confirmed. An Owner must reopen it first.';
const MAX_CSV_CHARS = 2_000_000;

function dayParam(v: string | undefined): string {
  if (!v || !DAY_RE.test(v)) fail(400, 'Day must be YYYY-MM-DD.');
  return v;
}

function msField(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(400, `${key} must be a time in milliseconds.`);
  return v;
}

interface Existing { id: string; pos_no: string; bill_no: string; paid_at: number; mode: string; amount_paise: number; discount_paise: number; report_id: string; shift_day: string }

// ---- Software sales report import. One call previews (dryRun) and the same call imports.
// The file must pass its own footer check, or nothing is imported. Overlapping bills: identical
// ones are skipped, different ones are flagged for a person. Nothing is ever overwritten silently.
salesRoutes.post('/businesses/:businessId/sales-reports', requireRole('sales.import'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const csv = typeof data.csv === 'string' ? data.csv : '';
  if (!csv.trim()) fail(400, 'Choose a CSV file.');
  if (csv.length > MAX_CSV_CHARS) fail(400, 'The file is too large.');
  const day = dayParam(text(data, 'day', 'Day')!);
  const dryRun = data.dryRun === true;
  const replaces = typeof data.replaces === 'string' && data.replaces ? data.replaces : null;
  if (replaces && !isUuid(replaces)) fail(400, 'Unknown report to replace.');

  const parsed = parseSalesCsv(csv);
  if (parsed.problems.length) return c.json({ error: 'This file cannot be imported.', problems: parsed.problems }, 400);
  const coversFrom = msField(data, 'coversFrom') ?? parsed.firstPaidAt!;
  const coversTo = msField(data, 'coversTo') ?? parsed.lastPaidAt!;
  if (coversFrom > parsed.firstPaidAt! || coversTo < parsed.lastPaidAt!) {
    fail(400, 'The covered period must include every bill in the file.');
  }

  const contentSha = await sha256(csv);
  if (await one(db, 'SELECT 1 AS ok FROM uploads WHERE business_id = ? AND content_sha256 = ?', bid, contentSha)) {
    fail(409, 'This exact file was already uploaded.');
  }

  let replaced: { id: string; days: string[] } | null = null;
  if (replaces) {
    const old = await one<{ id: string; replaced_by: string | null }>(db, 'SELECT id, replaced_by FROM sales_reports WHERE id = ? AND business_id = ?', replaces, bid);
    if (!old || old.replaced_by) fail(404, 'Report to replace not found.');
    const days = (await all<{ shift_day: string }>(db, 'SELECT DISTINCT shift_day FROM software_bills WHERE report_id = ?', replaces)).map((r) => r.shift_day);
    replaced = { id: replaces, days };
  }

  // Compare with bills already stored (other than those of the report being replaced).
  const keys = parsed.bills.map((b) => `${b.posNo}\u0000${b.billNo}`);
  const existing = await all<Existing>(db, `
    SELECT id, pos_no, bill_no, paid_at, mode, amount_paise, discount_paise, report_id, shift_day FROM software_bills
    WHERE business_id = ? AND (pos_no || char(0) || bill_no) IN (SELECT value FROM json_each(?))`, bid, JSON.stringify(keys));
  const byKey = new Map(existing.filter((e) => e.report_id !== replaced?.id).map((e) => [`${e.pos_no}\u0000${e.bill_no}`, e]));

  const toAdd: typeof parsed.bills = [];
  const toFlag: { bill: (typeof parsed.bills)[number]; existing: Existing }[] = [];
  let skipped = 0;
  for (const b of parsed.bills) {
    const e = byKey.get(`${b.posNo}\u0000${b.billNo}`);
    if (!e) toAdd.push(b);
    else if (e.paid_at === b.paidAt && e.mode === b.mode && e.amount_paise === b.amountPaise && e.discount_paise === b.discountPaise) skipped++;
    else toFlag.push({ bill: b, existing: e });
  }

  const addDays = [...new Set(toAdd.map((b) => shiftDayOf(b.paidAt)))].sort();
  const touched = [...new Set([...addDays, ...(replaced?.days ?? [])])].sort();
  const confirmed = touched.length
    ? (await all<{ shift_day: string }>(db, `SELECT shift_day FROM shifts WHERE business_id = ? AND status = 'confirmed'
        AND shift_day IN (SELECT value FROM json_each(?))`, bid, JSON.stringify(touched))).map((s) => s.shift_day)
    : [];

  const summary = {
    bills: parsed.bills.length,
    complimentary: parsed.bills.filter((b) => b.amountPaise === 0).length,
    footer: parsed.footer,
    firstPaidAt: parsed.firstPaidAt,
    lastPaidAt: parsed.lastPaidAt,
    coversFrom,
    coversTo,
    add: toAdd.length,
    skip: skipped,
    flag: toFlag.length,
    shifts: [...new Set(parsed.bills.map((b) => shiftDayOf(b.paidAt)))].sort(),
    confirmedShifts: confirmed,
  };
  if (dryRun) return c.json(summary);
  if (confirmed.length) fail(409, `This file would change shift ${confirmed.join(', ')}, which is confirmed. An Owner must reopen it first.`);

  const uploadId = newId();
  const reportId = newId();
  const key = storageKey(bid, uploadId);
  const t = now();
  await c.env.UPLOADS.put(key, parsed.redacted, { httpMetadata: { contentType: 'text/csv' } });
  try {
    await db.batch([
      stmt(db, `INSERT INTO uploads (id, business_id, kind, business_day, storage_key, content_sha256, status, uploaded_by, created_at)
        VALUES (?, ?, 'software_sales_csv', ?, ?, ?, 'approved', ?, ?)`, uploadId, bid, day, key, contentSha, c.get('user').id, t),
      stmt(db, `INSERT INTO sales_reports (id, business_id, upload_id, covers_from, covers_to, first_paid_at, last_paid_at, bill_count,
        footer_bills, footer_upi_paise, footer_card_paise, footer_cash_paise, footer_total_paise, bills_added, bills_skipped, bills_flagged, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        reportId, bid, uploadId, coversFrom, coversTo, parsed.firstPaidAt, parsed.lastPaidAt, parsed.bills.length,
        parsed.footer!.bills, parsed.footer!.upiPaise, parsed.footer!.cardPaise, parsed.footer!.cashPaise, parsed.footer!.totalPaise,
        toAdd.length, skipped, toFlag.length, t),
      ...(replaced ? [
        stmt(db, 'UPDATE sales_reports SET replaced_by = ? WHERE id = ?', reportId, replaced.id),
        stmt(db, 'DELETE FROM software_bill_conflicts WHERE report_id = ? AND decision IS NULL', replaced.id),
        stmt(db, 'DELETE FROM software_bills WHERE report_id = ?', replaced.id),
      ] : []),
      ...touched.map((d) => shiftStatement(db, bid, d)),
      ...toAdd.map((b) => stmt(db, `INSERT INTO software_bills (id, business_id, report_id, pos_no, bill_no, si_no, paid_at, shift_day, mode,
        amount_paise, discount_paise, is_complimentary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), bid, reportId, b.posNo, b.billNo, b.siNo, b.paidAt, shiftDayOf(b.paidAt), b.mode, b.amountPaise, b.discountPaise,
        b.amountPaise === 0 ? 1 : 0, t)),
      ...toFlag.map((f) => stmt(db, `INSERT INTO software_bill_conflicts (id, business_id, report_id, existing_bill_id, incoming_paid_at,
        incoming_mode, incoming_amount_paise, incoming_discount_paise, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), bid, reportId, f.existing.id, f.bill.paidAt, f.bill.mode, f.bill.amountPaise, f.bill.discountPaise, t)),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'sales_report.import', 'sales_reports', ?, ?, ?, ?)`, bid, c.get('user').id, reportId,
        replaced ? JSON.stringify({ replaces: replaced.id }) : null,
        JSON.stringify({ bills: parsed.bills.length, added: toAdd.length, skipped, flagged: toFlag.length, coversFrom, coversTo }), t),
    ]);
  } catch (e) {
    await c.env.UPLOADS.delete(key);
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    if (isUniqueViolation(e)) fail(409, 'Another import changed these bills at the same moment. Try again.');
    throw e;
  }
  for (const d of touched) await refreshComparisons(db, bid, d, c.get('user').id);
  return c.json({ id: reportId, ...summary }, 201);
});

salesRoutes.get('/businesses/:businessId/sales-reports', requireRole('sales.view'), async (c) => {
  const reports = await all(c.env.DB, `
    SELECT r.id, r.covers_from AS coversFrom, r.covers_to AS coversTo, r.first_paid_at AS firstPaidAt, r.last_paid_at AS lastPaidAt,
           r.bill_count AS billCount, r.bills_added AS added, r.bills_skipped AS skipped, r.bills_flagged AS flagged,
           r.footer_total_paise AS footerTotalPaise, r.replaced_by AS replacedBy, r.created_at AS createdAt, u.business_day AS day
    FROM sales_reports r JOIN uploads u ON u.id = r.upload_id
    WHERE r.business_id = ? ORDER BY r.covers_from DESC LIMIT 100`, c.get('businessId'));
  return c.json({ reports });
});

// The covered period can be corrected while no shift it touches is confirmed.
salesRoutes.patch('/businesses/:businessId/sales-reports/:reportId', requireRole('sales.import'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const reportId = c.req.param('reportId');
  if (!isUuid(reportId)) fail(404, 'Report not found.');
  const r = await one<{ covers_from: number; covers_to: number; first_paid_at: number; last_paid_at: number }>(db,
    'SELECT covers_from, covers_to, first_paid_at, last_paid_at FROM sales_reports WHERE id = ? AND business_id = ? AND replaced_by IS NULL', reportId, bid);
  if (!r) fail(404, 'Report not found.');
  const data = await body(c);
  const from = msField(data, 'coversFrom');
  const to = msField(data, 'coversTo');
  if (from === null || to === null) fail(400, 'Give both coversFrom and coversTo.');
  if (from > r.first_paid_at || to < r.last_paid_at) fail(400, 'The covered period must include every bill in the file.');
  const days = new Set<string>();
  for (let t = Math.min(from, r.covers_from); t <= Math.max(to, r.covers_to) + 86_400_000; t += 3_600_000) days.add(shiftDayOf(t));
  const confirmed = await one<{ shift_day: string }>(db, `SELECT shift_day FROM shifts WHERE business_id = ? AND status = 'confirmed'
    AND shift_day IN (SELECT value FROM json_each(?)) LIMIT 1`, bid, JSON.stringify([...days]));
  if (confirmed) fail(409, `Shift ${confirmed.shift_day} is confirmed. An Owner must reopen it first.`);
  await db.batch([
    stmt(db, 'UPDATE sales_reports SET covers_from = ?, covers_to = ? WHERE id = ?', from, to, reportId),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'sales_report.coverage', 'sales_reports', ?, ?, ?, ?)`, bid, c.get('user').id, reportId,
      JSON.stringify({ coversFrom: r.covers_from, coversTo: r.covers_to }), JSON.stringify({ coversFrom: from, coversTo: to }), now()),
  ]);
  return c.json({ ok: true });
});

// ---- Overlapping bills whose values differ

salesRoutes.put('/businesses/:businessId/conflicts/:conflictId', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('conflictId');
  if (!isUuid(id)) fail(404, 'Not found.');
  const data = await body(c);
  if (data.decision !== 'keep_existing' && data.decision !== 'use_incoming') fail(400, 'Decision must be keep_existing or use_incoming.');
  const k = await one<{ existing_bill_id: string; decision: string | null; incoming_paid_at: number; incoming_mode: string; incoming_amount_paise: number;
    incoming_discount_paise: number; shift_day: string; paid_at: number; mode: string; amount_paise: number; discount_paise: number }>(db, `
    SELECT k.existing_bill_id, k.decision, k.incoming_paid_at, k.incoming_mode, k.incoming_amount_paise, k.incoming_discount_paise,
           b.shift_day, b.paid_at, b.mode, b.amount_paise, b.discount_paise
    FROM software_bill_conflicts k JOIN software_bills b ON b.id = k.existing_bill_id
    WHERE k.id = ? AND k.business_id = ?`, id, bid);
  if (!k) fail(404, 'Not found.');
  if (k.decision) fail(409, 'This overlap is already decided.');
  const t = now();
  const user = c.get('user').id;
  const newDay = shiftDayOf(k.incoming_paid_at);
  try {
    await db.batch([
      ...(data.decision === 'use_incoming' ? [
        shiftStatement(db, bid, newDay),
        stmt(db, `UPDATE software_bills SET paid_at = ?, shift_day = ?, mode = ?, amount_paise = ?, discount_paise = ?, is_complimentary = ?
          WHERE id = ?`, k.incoming_paid_at, newDay, k.incoming_mode, k.incoming_amount_paise, k.incoming_discount_paise,
          k.incoming_amount_paise === 0 ? 1 : 0, k.existing_bill_id),
      ] : []),
      stmt(db, 'UPDATE software_bill_conflicts SET decision = ?, decided_by = ?, decided_at = ? WHERE id = ? AND decision IS NULL', data.decision, user, t, id),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'conflict.decide', 'software_bill_conflicts', ?, ?, ?, ?)`, bid, user, id,
        JSON.stringify({ paidAt: k.paid_at, mode: k.mode, amountPaise: k.amount_paise, discountPaise: k.discount_paise }),
        JSON.stringify({ decision: data.decision, incoming: { paidAt: k.incoming_paid_at, mode: k.incoming_mode, amountPaise: k.incoming_amount_paise } }), t),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  for (const d of new Set([k.shift_day, newDay])) await refreshComparisons(db, bid, d, user);
  return c.json({ ok: true });
});

// ---- Shifts and the per-bill comparison

salesRoutes.get('/businesses/:businessId/shifts', requireRole('sales.view'), async (c) => {
  const shifts = await all(c.env.DB, `
    SELECT s.shift_day AS day, s.status,
      (SELECT count(*) FROM bill_comparisons b WHERE b.business_id = s.business_id AND b.shift_day = s.shift_day
         AND b.difference IN ('amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software') AND b.decision IS NULL) AS undecided
    FROM shifts s WHERE s.business_id = ? ORDER BY s.shift_day DESC LIMIT 60`, c.get('businessId'));
  return c.json({ shifts });
});

salesRoutes.get('/businesses/:businessId/shifts/:day', requireRole('sales.view'), async (c) => {
  const day = dayParam(c.req.param('day'));
  const bid = c.get('businessId');
  await refreshComparisons(c.env.DB, bid, day, c.get('user').id);
  return c.json(await shiftView(c.env.DB, bid, day));
});

salesRoutes.put('/businesses/:businessId/comparisons/:comparisonId', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('comparisonId');
  if (!isUuid(id)) fail(404, 'Not found.');
  const data = await body(c);
  const decision = data.decision === null ? null : (data.decision as Decision);
  if (decision !== null && !['use_software', 'use_register', 'leave_out'].includes(decision)) fail(400, 'Decision must be use_software, use_register or leave_out.');
  const note = text(data, 'note', 'Note', { optional: true, max: 500 });
  const cmp = await one<{ difference: string; software_bill_id: string | null; register_row_id: string | null; sw_mode: string | null;
    decision: string | null; shift_day: string }>(db,
    'SELECT difference, software_bill_id, register_row_id, sw_mode, decision, shift_day FROM bill_comparisons WHERE id = ? AND business_id = ?', id, bid);
  if (!cmp) fail(404, 'Not found.');
  if (!NEEDS_DECISION.includes(cmp.difference as never)) fail(400, 'This bill has no difference to decide.');
  // A bill the register does not have gets its type (F&B or Room) with the decision; otherwise the register's type is used.
  let billType: string | null = null;
  if (decision === 'use_software') {
    if (!cmp.software_bill_id) fail(400, 'This bill is not in the software report.');
    if (cmp.sw_mode === 'unknown') fail(400, 'The software report does not say how this bill was paid. Use the register, or leave it out.');
    if (!cmp.register_row_id) {
      if (data.billType !== 'fnb' && data.billType !== 'room') fail(400, 'This bill is not in the register, so choose its type: Use software · F&B, or Use software · Room.');
      billType = data.billType;
    }
  }
  if (decision === 'use_register') {
    if (!cmp.register_row_id) fail(400, 'This bill is not in the register.');
    // A bill paid together with another row is paid through that row's payment.
    const pays = await one<{ n: number }>(db, `SELECT count(*) AS n FROM register_payments
      WHERE register_row_id = coalesce((SELECT paid_with_row_id FROM register_rows WHERE id = ?), ?)`, cmp.register_row_id, cmp.register_row_id);
    if (!pays!.n) fail(400, 'The register row has no payment written, and is not paid together with another row. Add its payment in Review first.');
  }
  const t = now();
  const user = c.get('user').id;
  try {
    await db.batch([
      stmt(db, 'UPDATE bill_comparisons SET decision = ?, decided_by = ?, decided_at = ?, note = ?, bill_type = ? WHERE id = ?',
        decision, decision ? user : null, decision ? t : null, note, billType, id),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
        VALUES (?, ?, 'comparison.decide', 'bill_comparisons', ?, ?, ?, ?)`, bid, user, id,
        JSON.stringify({ decision: cmp.decision }), JSON.stringify({ decision, note, billType }), t),
    ]);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, CONFIRMED);
    throw e;
  }
  return c.json({ ok: true });
});

salesRoutes.post('/businesses/:businessId/shifts/:day/confirm', requireRole('sales.decide'), async (c) => {
  const day = dayParam(c.req.param('day'));
  try {
    const result = await confirmShift(c.env.DB, c.get('businessId'), day, c.get('user').id);
    if ('blockers' in result) return c.json({ error: 'This shift cannot be confirmed yet.', problems: result.blockers }, 409);
    return c.json(result);
  } catch (e) {
    if (isShiftConfirmed(e)) fail(409, 'This shift is already confirmed.');
    throw e;
  }
});

salesRoutes.post('/businesses/:businessId/shifts/:day/reopen', requireRole('shift.reopen'), async (c) => {
  const day = dayParam(c.req.param('day'));
  const data = await body(c);
  const reason = text(data, 'reason', 'Reason', { max: 500 })!;
  const result = await reopenShift(c.env.DB, c.get('businessId'), day, c.get('user').id, reason);
  if ('error' in result) fail(409, result.error);
  await refreshComparisons(c.env.DB, c.get('businessId'), day, c.get('user').id);
  return c.json(result);
});

// ---- Which income head each register bill type uses. Owner and Accountant, like heads.

salesRoutes.get('/businesses/:businessId/bill-type-heads', requireRole('heads.view'), async (c) => {
  const rows = await all(c.env.DB, 'SELECT bill_type AS billType, head_id AS headId FROM bill_type_heads WHERE business_id = ?', c.get('businessId'));
  return c.json({ billTypeHeads: rows });
});

salesRoutes.put('/businesses/:businessId/bill-type-heads/:billType', requireRole('heads.edit'), async (c) => {
  const billType = c.req.param('billType');
  if (billType !== 'fnb' && billType !== 'room') fail(404, 'Bill type must be fnb or room.');
  const data = await body(c);
  const headId = typeof data.headId === 'string' ? data.headId : '';
  const bid = c.get('businessId');
  const head = isUuid(headId) ? await one(c.env.DB, "SELECT 1 AS ok FROM heads WHERE id = ? AND business_id = ? AND type = 'income'", headId, bid) : null;
  if (!head) fail(400, 'Choose an income head of this business.');
  const before = await one(c.env.DB, 'SELECT head_id FROM bill_type_heads WHERE business_id = ? AND bill_type = ?', bid, billType);
  await c.env.DB.batch([
    stmt(c.env.DB, `INSERT INTO bill_type_heads (business_id, bill_type, head_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (business_id, bill_type) DO UPDATE SET head_id = excluded.head_id`, bid, billType, headId, now()),
    stmt(c.env.DB, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'bill_type_head.set', 'heads', ?, ?, ?, ?)`, bid, c.get('user').id, headId,
      before ? JSON.stringify({ billType, headId: before.head_id }) : null, JSON.stringify({ billType, headId }), now()),
  ]);
  return c.json({ ok: true });
});
