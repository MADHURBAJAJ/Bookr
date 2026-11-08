import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, one } from '../db';
import { fail } from '../http';
import { can } from '../permissions';
import { coverage } from '../sales';
import { shiftWindow } from '../time';

export const dayRoutes = new Hono<AppEnv>();

const dayParam = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fail(400, 'Unknown shift.'));

/** "Bring in": what has arrived for a shift — software report, pages (and how far they are read), bank statements. */
dayRoutes.get('/businesses/:businessId/shifts/:day/inputs', requireRole('rows.upload'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const day = dayParam(c.req.param('day'));
  const w = shiftWindow(day);
  const [cov, bills, pages, shift] = await Promise.all([
    coverage(db, bid, day),
    one<{ n: number }>(db, 'SELECT count(*) AS n FROM software_bills WHERE business_id = ? AND shift_day = ?', bid, day),
    all<{ id: string; kind: string; status: string; createdAt: number; uploadedBy: string; fromSoftware: number; rows: number; unclear: number; reviewed: number }>(db, `
      SELECT u.id, u.kind, u.status, u.created_at AS createdAt, u.uploaded_by AS uploadedBy, u.storage_key LIKE 'software-added/%' AS fromSoftware,
        CASE u.kind WHEN 'bill_register' THEN (SELECT count(*) FROM register_rows r WHERE r.upload_id = u.id)
          WHEN 'expense_list' THEN (SELECT count(*) FROM transactions t WHERE t.upload_id = u.id) ELSE NULL END AS rows,
        -- Still to review: register rows not ticked, expense lines not approved, a cash summary not approved.
        CASE u.kind WHEN 'bill_register' THEN (SELECT count(*) FROM register_rows r WHERE r.upload_id = u.id AND r.status <> 'checked')
          WHEN 'expense_list' THEN (SELECT count(*) FROM transactions t WHERE t.upload_id = u.id AND t.status <> 'approved')
          ELSE (SELECT count(*) FROM cash_summaries s WHERE s.upload_id = u.id AND s.status <> 'approved') END AS unclear,
        CASE u.kind WHEN 'bill_register' THEN (SELECT count(*) FROM register_rows r WHERE r.upload_id = u.id AND r.status = 'checked')
          WHEN 'expense_list' THEN (SELECT count(*) FROM transactions t WHERE t.upload_id = u.id AND t.status = 'approved')
          ELSE (SELECT count(*) FROM cash_summaries s WHERE s.upload_id = u.id AND s.status = 'approved') END AS reviewed
      FROM uploads u WHERE u.business_id = ? AND u.business_day = ? AND u.kind IN ('bill_register', 'expense_list', 'cash_summary') ORDER BY u.created_at`, bid, day),
    one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day),
  ]);
  // The report files covering this shift, each with the shifts its bills are in (deleting one removes them all).
  const files = cov.reports.length ? await all<{ uploadId: string; uploadedBy: string; createdAt: number; coversFrom: number; coversTo: number; billCount: number; days: string; replaces: number }>(db, `
    SELECT r.upload_id AS uploadId, u.uploaded_by AS uploadedBy, u.created_at AS createdAt, r.covers_from AS coversFrom, r.covers_to AS coversTo, r.bill_count AS billCount,
      (SELECT group_concat(DISTINCT b.shift_day) FROM software_bills b WHERE b.report_id = r.id) AS days,
      EXISTS (SELECT 1 FROM sales_reports o WHERE o.replaced_by = r.id) AS replaces
    FROM sales_reports r JOIN uploads u ON u.id = r.upload_id
    WHERE r.business_id = ? AND r.id IN (SELECT value FROM json_each(?)) ORDER BY r.covers_from`, bid, JSON.stringify(cov.reports.map((r) => r.id))) : [];
  const summary = await one<{ cash: number | null }>(db, `SELECT cash_in_hand_paise AS cash FROM cash_summaries WHERE business_id = ? AND shift_day = ?
    ORDER BY status = 'approved' DESC, created_at DESC LIMIT 1`, bid, day);
  let bank = null;
  if (can(c.get('role'), 'bank.link')) {
    const accounts = await all<{ id: string; name: string; sheet: number; label: string | null; lastAt: number | null }>(db, `
      SELECT a.id, a.name, s.sheet_id IS NOT NULL AS sheet, s.receives_upi_label AS label, (SELECT max(r.posted_at) FROM bank_rows r WHERE r.account_id = a.id) AS lastAt
      FROM accounts a LEFT JOIN bank_sources s ON s.account_id = a.id WHERE a.business_id = ? AND a.kind = 'bank' ORDER BY a.name`, bid);
    // Accounts take turns, so the shift is covered when the latest line of any UPI account reaches its end (about 8 am).
    const latest = Math.max(0, ...accounts.filter((a) => a.label).map((a) => a.lastAt ?? 0));
    bank = { accounts, covered: latest >= w.to - 30 * 60000, shiftEnd: w.to };
  }
  return c.json({
    day, shiftStatus: shift?.status ?? null,
    software: { reports: cov.reports.length, bills: bills?.n ?? 0, gaps: cov.gaps, window: cov.window,
      files: files.map((f) => ({ ...f, days: (f.days ?? '').split(',').filter(Boolean).sort(), replaces: !!f.replaces })) },
    pages: pages.filter((p) => !p.fromSoftware),
    cashInHandPaise: summary?.cash ?? null,
    bank,
  });
});

/** Everything about one bill number: software, register, comparison, sale lines, money, history. */
dayRoutes.get('/businesses/:businessId/bills/:billNo', requireRole('sales.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const billNo = decodeURIComponent(c.req.param('billNo')).trim();
  if (!billNo || billNo.length > 40) fail(400, 'Unknown bill.');
  const day = c.req.query('day');
  const dayOk = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  const comparisons = await all<Record<string, unknown> & { id: string; register_row_id: string | null; shift_day: string }>(db, `
    SELECT c.id, c.shift_day, c.pos_no, c.bill_no, c.difference, c.decision, c.note, c.bill_type, c.sw_amount_paise, c.sw_mode, c.rg_amount_paise, c.rg_mode,
      c.register_row_id, c.linked_to_id, c.closed_at, b.paid_at, s.status AS shift_status
    FROM bill_comparisons c LEFT JOIN software_bills b ON b.id = c.software_bill_id LEFT JOIN shifts s ON s.business_id = c.business_id AND s.shift_day = c.shift_day
    WHERE c.business_id = ? AND c.bill_no = ? AND (? IS NULL OR c.shift_day = ?) ORDER BY c.shift_day DESC`, bid, billNo, dayOk, dayOk);
  const regIds = comparisons.map((x) => x.register_row_id).filter(Boolean) as string[];
  const register = await all<Record<string, unknown> & { id: string }>(db, `
    SELECT r.id, r.upload_id, r.line_no, r.shift_day, r.bill_no, r.bill_type, r.amount_paise, r.discount_paise, r.tip_paise, r.remarks, r.status, r.paid_with_row_id,
      (SELECT json_group_array(json_object('mode', p.mode, 'label', p.column_label, 'amountPaise', p.amount_paise)) FROM register_payments p WHERE p.register_row_id = coalesce(r.paid_with_row_id, r.id)) AS payments,
      EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target_id = r.id AND a.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM register_bank_adjustments x WHERE x.reverses_id = a.id)) AS adjusted
    FROM register_rows r WHERE r.business_id = ? AND (r.bill_no = ? ${regIds.length ? `OR r.id IN (${regIds.map(() => '?').join(',')})` : ''})
      AND (? IS NULL OR r.shift_day = ?)`, bid, billNo, ...regIds, dayOk, dayOk);
  const cmpIds = comparisons.map((x) => x.id);
  const sales = await all<Record<string, unknown> & { id: string; matched_bank_row: string | null }>(db, `
    SELECT t.id, t.shift_day, t.amount_paise, t.payment_mode, t.match_status, t.matched_bank_row, t.confirmed_source, h.name AS head
    FROM transactions t LEFT JOIN heads h ON h.id = t.head_id
    WHERE t.business_id = ? AND t.type = 'income' AND t.source = 'software_report' AND (t.bill_no = ? ${cmpIds.length ? `OR t.comparison_id IN (${cmpIds.map(() => '?').join(',')})` : ''})
      AND (? IS NULL OR t.shift_day = ?)`, bid, billNo, ...cmpIds, dayOk, dayOk);
  let money: Record<string, unknown>[] = [];
  if (can(c.get('role'), 'bank.link') && sales.length) {
    money = await all(db, `SELECT r.id, r.tran_id AS tranId, r.posted_at AS postedAt, r.amount_paise AS amountPaise, r.vpa, a.name AS accountName, m.amount_paise AS appliedPaise, m.transaction_id AS saleId
      FROM bank_matches m JOIN bank_rows r ON r.id = m.bank_row_id JOIN accounts a ON a.id = r.account_id
      WHERE m.transaction_id IN (${sales.map(() => '?').join(',')}) ORDER BY r.posted_at`, ...sales.map((x) => x.id));
  }
  const ids = [...cmpIds, ...register.map((r) => r.id), ...sales.map((x) => x.id), ...money.map((m) => m.id as string)];
  const history = ids.length ? await all(db, `SELECT a.action, a.created_at AS at, u.name AS user, a.after FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.business_id = ? AND a.row_id IN (${ids.map(() => '?').join(',')}) AND a.action NOT IN ('ocr.read') ORDER BY a.id DESC LIMIT 40`, bid, ...ids) : [];
  return c.json({ billNo, comparisons, register: register.map((r) => ({ ...r, payments: JSON.parse(r.payments as string) })), sales, money, history });
});
