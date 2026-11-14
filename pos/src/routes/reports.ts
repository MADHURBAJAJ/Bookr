// Reports the POS gives on its own, before it is connected to Bookr: sales by billing name with GST, by payment mode and by
// item; discounts and complimentary bills; and who owes what, aged, with each account's statement (GET /debtors/:id).
import { Hono } from 'hono';
import { all } from '../../../src/db';
import { date, fail } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { clock, loadBusiness } from '../util';
import type { AppEnv } from '../types';

export const reportRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
reportRoutes.use(`${B}/*`, requireStaff);

// Sales of shifts from..to (bills by the shift they were printed in; payments by the shift they were taken in).
reportRoutes.get(`${B}/reports/sales`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const days = await all(db, `SELECT shift_day AS day, count(*) AS bills, sum(total_paise) AS totalPaise FROM bills
    WHERE business_id = ? AND shift_day BETWEEN ? AND ? AND status <> 'void' GROUP BY shift_day ORDER BY shift_day`, bid, from, to);
  const byEntity = await all(db, `SELECT e.name, e.gst_registered AS gstRegistered, e.gstin, count(*) AS bills, sum(b.gross_paise) AS grossPaise,
      sum(b.discount_paise) AS discountPaise, sum(b.taxable_paise) AS taxablePaise, sum(b.cgst_paise) AS cgstPaise, sum(b.sgst_paise) AS sgstPaise,
      sum(b.round_off_paise) AS roundOffPaise, sum(b.total_paise) AS totalPaise, min(b.bill_no) AS firstBill, max(b.bill_no) AS lastBill
    FROM bills b JOIN billing_entities e ON e.id = b.entity_id
    WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' GROUP BY e.id ORDER BY e.is_default DESC, e.name`, bid, from, to);
  const byMode = await all(db, `SELECT p.mode, count(*) AS n, sum(p.amount_paise) AS paise FROM payments p JOIN settlements s ON s.id = p.settlement_id
    WHERE p.business_id = ? AND p.shift_day BETWEEN ? AND ? AND s.kind = 'bills' GROUP BY p.mode ORDER BY paise DESC`, bid, from, to);
  const items = await all(db, `SELECT l.name, sum(l.qty) AS qty, sum(l.amount_paise) AS amountPaise FROM bill_lines l JOIN bills b ON b.id = l.bill_id
    WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' GROUP BY l.name ORDER BY amountPaise DESC`, bid, from, to);
  const discounts = await all(db, `SELECT discount_reason AS reason, count(*) AS n, sum(discount_paise) AS paise FROM bills
    WHERE business_id = ? AND shift_day BETWEEN ? AND ? AND status <> 'void' AND discount_paise > 0 GROUP BY discount_reason ORDER BY paise DESC`, bid, from, to);
  const comps = await all(db, `SELECT p.comp_guest AS guest, p.comp_reason AS reason, p.amount_paise AS paise, p.shift_day AS day, s.name AS byName
    FROM payments p LEFT JOIN staff s ON s.id = p.by_staff WHERE p.business_id = ? AND p.shift_day BETWEEN ? AND ? AND p.mode = 'comp' ORDER BY p.at`, bid, from, to);
  const voids = await all(db, `SELECT bill_no AS billNo, total_paise AS totalPaise, void_reason AS reason FROM bills
    WHERE business_id = ? AND shift_day BETWEEN ? AND ? AND status = 'void' ORDER BY bill_no`, bid, from, to);
  const creditNotes = await all(db, `SELECT e.name, count(*) AS n, sum(n.taxable_paise) AS taxablePaise, sum(n.cgst_paise) AS cgstPaise, sum(n.sgst_paise) AS sgstPaise,
      sum(n.total_paise) AS totalPaise, min(n.cn_no) AS first, max(n.cn_no) AS last
    FROM credit_notes n JOIN billing_entities e ON e.id = n.entity_id WHERE n.business_id = ? AND n.shift_day BETWEEN ? AND ? GROUP BY e.id ORDER BY e.is_default DESC, e.name`, bid, from, to);
  const creditNoteList = await all(db, `SELECT n.cn_no AS cnNo, b.bill_no AS billNo, n.total_paise AS totalPaise, n.reason, n.refund_mode AS refundMode, n.shift_day AS day
    FROM credit_notes n JOIN bills b ON b.id = n.bill_id WHERE n.business_id = ? AND n.shift_day BETWEEN ? AND ? ORDER BY n.at`, bid, from, to);
  return c.json({ from, to, days, byEntity, byMode, items, discounts, comps, voids, creditNotes, creditNoteList });
});

// Who owes what, aged: what is owed is taken to be the newest charges (older ones were paid first).
reportRoutes.get(`${B}/reports/debtors`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const { t } = clock(await loadBusiness(db, bid));
  const accounts = await all<{ id: string; kind: string; name: string; phone: string | null; limit: number | null; balance: number; open: number }>(db, `
    SELECT d.id, d.kind, d.name, d.phone, d.credit_limit_paise AS "limit", coalesce(sum(e.amount_paise), 0) AS balance,
      (d.kind = 'credit' OR EXISTS (SELECT 1 FROM stays s WHERE s.id = d.stay_id AND s.checked_out_at IS NULL)) AS open
    FROM debtor_accounts d LEFT JOIN debtor_entries e ON e.account_id = d.id WHERE d.business_id = ? GROUP BY d.id ORDER BY balance DESC, d.name`, bid);
  const charges = await all<{ account_id: string; amount_paise: number; at: number }>(db,
    "SELECT account_id, amount_paise, at FROM debtor_entries WHERE business_id = ? AND amount_paise > 0 AND kind IN ('charge', 'advance_used') ORDER BY at DESC", bid);
  const DAY = 86400000;
  return c.json({ accounts: accounts.filter((a) => a.balance !== 0 || a.open).map((a) => {
    const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    let left = a.balance;
    for (const ch of charges.filter((x) => x.account_id === a.id)) {
      if (left <= 0) break;
      const take = Math.min(left, ch.amount_paise);
      const age = Math.floor((t - ch.at) / DAY);
      if (age <= 30) buckets.d0_30 += take; else if (age <= 60) buckets.d31_60 += take; else if (age <= 90) buckets.d61_90 += take; else buckets.d90 += take;
      left -= take;
    }
    return { id: a.id, kind: a.kind, name: a.name, phone: a.phone, creditLimitPaise: a.limit, balancePaise: a.balance, ...buckets };
  }) });
});
