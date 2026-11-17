// Reports the POS gives on its own, before it is connected to Bookr: sales by billing name with GST, by payment mode and by
// item; discounts and complimentary bills; and who owes what, aged, with each account's statement (GET /debtors/:id).
import { Hono } from 'hono';
import { all, one } from '../../../src/db';
import { date, fail } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { clock, bizOf, loadBusiness } from '../util';
import { fyOf } from '../billing';
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
  const tips = await all(db, `SELECT p.mode, count(*) AS n, sum(d.amount_paise) AS paise FROM settle_differences d JOIN payments p ON p.id = d.payment_id
    WHERE d.business_id = ? AND d.shift_day BETWEEN ? AND ? AND d.kind = 'tip' GROUP BY p.mode`, bid, from, to);
  const paymentDiscounts = await all(db, `SELECT d.reason, count(*) AS n, sum(d.amount_paise) AS paise FROM settle_differences d
    WHERE d.business_id = ? AND d.shift_day BETWEEN ? AND ? AND d.kind = 'discount' GROUP BY d.reason`, bid, from, to);
  const creditNotes = await all(db, `SELECT e.name, count(*) AS n, sum(n.taxable_paise) AS taxablePaise, sum(n.cgst_paise) AS cgstPaise, sum(n.sgst_paise) AS sgstPaise,
      sum(n.total_paise) AS totalPaise, min(n.cn_no) AS first, max(n.cn_no) AS last
    FROM credit_notes n JOIN billing_entities e ON e.id = n.entity_id WHERE n.business_id = ? AND n.shift_day BETWEEN ? AND ? GROUP BY e.id ORDER BY e.is_default DESC, e.name`, bid, from, to);
  const creditNoteList = await all(db, `SELECT n.cn_no AS cnNo, b.bill_no AS billNo, n.total_paise AS totalPaise, n.reason, n.refund_mode AS refundMode, n.shift_day AS day
    FROM credit_notes n JOIN bills b ON b.id = n.bill_id WHERE n.business_id = ? AND n.shift_day BETWEEN ? AND ? ORDER BY n.at`, bid, from, to);
  return c.json({ from, to, days, byEntity, byMode, items, discounts, comps, voids, creditNotes, creditNoteList, tips, paymentDiscounts });
});

// When, where and by whom the money came in, and what sold: for shifts from..to, void bills left out.
// Money is net sales (after bill discounts, before GST); item and category values are before bill discounts.
// Hours are India time, from when each KOT was printed: what the kitchen and bar were sent, and when.
reportRoutes.get(`${B}/reports/insights`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const live = "b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void'";
  // The shifts from..to as times: from the shift start hour (India time) on From, to the same hour the day after To.
  const startOf = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), bizOf(c).shift_start_hour) - 19_800_000;
  const fromMs = startOf(from);
  const toMs = startOf(to) + 86_400_000;
  const [byHour, coversByHour, byService, byStaff, mix, items, notSold] = await Promise.all([
    // Each KOT line: its quantity, valued at the order's price for that dish (menu price, before discounts and GST).
    all(db, `SELECT ((k.printed_at + 19800000) / 3600000) % 24 AS hour, k.station, count(DISTINCT k.id) AS kots,
        sum(json_extract(j.value, '$.qty')) AS items, sum(json_extract(j.value, '$.qty') * coalesce(ol.price_paise, 0)) AS valuePaise
      FROM kots k, json_each(k.lines) j
      LEFT JOIN order_lines ol ON ol.order_id = k.order_id AND ol.name = json_extract(j.value, '$.name')
      WHERE k.business_id = ? AND k.printed_at >= ? AND k.printed_at < ? GROUP BY hour, k.station ORDER BY hour`, bid, fromMs, toMs),
    // Guests, counted at the hour of their order's first KOT.
    all(db, `SELECT ((first + 19800000) / 3600000) % 24 AS hour, sum(covers) AS covers FROM (
        SELECT min(k.printed_at) AS first, max(coalesce(o.covers, 0)) AS covers FROM kots k JOIN orders o ON o.id = k.order_id
        WHERE k.business_id = ? AND k.printed_at >= ? AND k.printed_at < ? GROUP BY k.order_id) GROUP BY hour`, bid, fromMs, toMs),
    all(db, `SELECT o.kind, count(*) AS bills, sum(b.taxable_paise) AS netPaise, sum(coalesce(o.covers, 0)) AS covers,
        sum(CASE WHEN o.covers > 0 THEN b.taxable_paise ELSE 0 END) AS coveredNetPaise, count(DISTINCT lower(o.place) || b.shift_day) AS placeDays
      FROM bills b JOIN orders o ON o.id = b.order_id WHERE ${live} GROUP BY o.kind ORDER BY netPaise DESC`, bid, from, to),
    all(db, `SELECT coalesce(st.name, 'Unknown') AS name, st.role,
        sum(b.status <> 'void') AS bills, sum(CASE WHEN b.status <> 'void' THEN b.taxable_paise ELSE 0 END) AS netPaise,
        sum(b.status <> 'void' AND b.discount_paise > 0) AS discountBills, sum(CASE WHEN b.status <> 'void' THEN b.discount_paise ELSE 0 END) AS discountPaise,
        sum(b.status = 'void') AS voids
      FROM bills b JOIN orders o ON o.id = b.order_id LEFT JOIN staff st ON st.id = o.opened_by
      WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? GROUP BY o.opened_by ORDER BY netPaise DESC`, bid, from, to),
    all(db, `SELECT coalesce(m.category, 'Not on the menu now') AS category, coalesce(m.station, 'kitchen') AS station, sum(l.qty) AS qty, sum(l.amount_paise) AS amountPaise
      FROM bill_lines l JOIN bills b ON b.id = l.bill_id LEFT JOIN menu_items m ON m.id = l.item_id WHERE ${live} GROUP BY 1, 2 ORDER BY amountPaise DESC`, bid, from, to),
    all(db, `SELECT l.name, coalesce(m.category, '') AS category, coalesce(m.station, 'kitchen') AS station, sum(l.qty) AS qty, sum(l.amount_paise) AS amountPaise
      FROM bill_lines l JOIN bills b ON b.id = l.bill_id LEFT JOIN menu_items m ON m.id = l.item_id WHERE ${live}
      GROUP BY coalesce(l.item_id, l.name) ORDER BY amountPaise DESC`, bid, from, to),
    all(db, `SELECT name, category, station FROM menu_items m WHERE m.business_id = ? AND m.active = 1 AND m.id NOT IN (
        SELECT l.item_id FROM bill_lines l JOIN bills b ON b.id = l.bill_id WHERE ${live} AND l.item_id IS NOT NULL) ORDER BY category, name`, bid, bid, from, to),
  ]);
  return c.json({ from, to, byHour, coversByHour, byService, byStaff, mix, items, notSold });
});

// The owner's morning check for one shift: the day's money, every exception, food sent to the kitchen that is not paid for,
// orders left open, whether every bill-number series is unbroken, and whether the shift was closed.
reportRoutes.get(`${B}/reports/daily-check`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const b = bizOf(c);
  const day = date({ d: c.req.query('day') ?? '' }, 'd', 'Shift');
  const { t } = clock(b);
  const fy = fyOf(day, b.fy_start_month);
  const [sales, byMode, events, diffs, unpaid, series, cnSeries, close, bar] = await Promise.all([
    one<{ bills: number; net: number; total: number; voids: number }>(db, `SELECT sum(status <> 'void') AS bills,
        coalesce(sum(CASE WHEN status <> 'void' THEN taxable_paise END), 0) AS net, coalesce(sum(CASE WHEN status <> 'void' THEN total_paise END), 0) AS total,
        sum(status = 'void') AS voids FROM bills WHERE business_id = ? AND shift_day = ?`, bid, day),
    all(db, `SELECT p.mode, count(*) AS n, sum(p.amount_paise) AS paise FROM payments p JOIN settlements s ON s.id = p.settlement_id
      WHERE p.business_id = ? AND p.shift_day = ? AND s.kind = 'bills' GROUP BY p.mode ORDER BY paise DESC`, bid, day),
    // Count summaries (reason 'Count') mark handovers; they are not exceptions themselves.
    all<{ kind: string; n: number; paise: number }>(db, `SELECT kind, count(*) AS n, coalesce(sum(amount_paise), 0) AS paise FROM pos_events
      WHERE business_id = ? AND shift_day = ? AND NOT (kind = 'stock_count' AND coalesce(reason, '') = 'Count') GROUP BY kind`, bid, day),
    all<{ kind: string; n: number; paise: number }>(db, `SELECT kind, count(*) AS n, sum(amount_paise) AS paise FROM settle_differences
      WHERE business_id = ? AND shift_day = ? GROUP BY kind`, bid, day),
    // Every order still holding food or drink the kitchen or bar was sent, with no paid bill: open, kept as a tab, or billed and unpaid.
    all<{ id: string; place: string; status: string; guest_name: string | null; opened_at: number; opened_shift_day: string; sent_paise: number; bill_no: string | null; voids: number }>(db, `
      SELECT o.id, o.place, o.status, o.guest_name, o.opened_at, o.opened_shift_day,
        (SELECT coalesce(sum(l.sent_qty * l.price_paise), 0) FROM order_lines l WHERE l.order_id = o.id) AS sent_paise,
        (SELECT bill_no FROM bills x WHERE x.order_id = o.id AND x.status = 'printed') AS bill_no,
        (SELECT count(*) FROM bills x WHERE x.order_id = o.id AND x.status = 'void') AS voids
      FROM orders o WHERE o.business_id = ? AND o.status IN ('open', 'tab', 'billed') ORDER BY o.opened_at`, bid),
    all<{ entity_id: string; name: string; prefix: string; seqs: string }>(db, `SELECT e.id AS entity_id, e.name, e.series_prefix AS prefix, group_concat(b.seq) AS seqs
      FROM bills b JOIN billing_entities e ON e.id = b.entity_id WHERE b.business_id = ? AND b.fy = ? GROUP BY e.id ORDER BY e.is_default DESC, e.name`, bid, fy),
    all<{ entity_id: string; name: string; seqs: string }>(db, `SELECT e.id AS entity_id, e.name, group_concat(n.seq) AS seqs
      FROM credit_notes n JOIN billing_entities e ON e.id = n.entity_id WHERE n.business_id = ? AND n.fy = ? GROUP BY e.id`, bid, fy),
    one<{ difference_paise: number; difference_reason: string | null; closed_at: number }>(db,
      'SELECT difference_paise, difference_reason, closed_at FROM shift_closes WHERE business_id = ? AND shift_day = ?', bid, day),
    // The bar: how many counts were taken this shift, and what they found missing or extra, at cost.
    one<{ counts: number; missing: number; extra: number; waste: number }>(db, `SELECT
        (SELECT count(*) FROM pos_events e WHERE e.business_id = ?1 AND e.shift_day = ?2 AND e.kind = 'stock_count' AND e.reason = 'Count'
          AND e.ref IN (SELECT 'Count · ' || name FROM stock_stores WHERE business_id = ?1 AND kind = 'bar')) AS counts,
        coalesce(sum(CASE WHEN m.kind = 'count' AND m.qty < 0 THEN -m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS missing,
        coalesce(sum(CASE WHEN m.kind = 'count' AND m.qty > 0 THEN m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS extra,
        coalesce(sum(CASE WHEN m.kind = 'waste' THEN -m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS waste
      FROM stock_moves m JOIN stock_items i ON i.id = m.item_id JOIN stock_stores ss ON ss.id = m.store_id
      WHERE m.business_id = ?1 AND m.shift_day = ?2 AND ss.kind = 'bar' AND m.kind IN ('count', 'waste')`, bid, day),
  ]);
  // A series is unbroken when its numbers run 1, 2, 3 … with none missing (void bills keep their number, so they count).
  const gaps = (seqs: string) => {
    const nums = seqs.split(',').map(Number).sort((x, y) => x - y);
    const have = new Set(nums);
    const missing: number[] = [];
    for (let i = 1; i <= nums[nums.length - 1] && missing.length < 20; i++) if (!have.has(i)) missing.push(i);
    return { count: nums.length, last: nums[nums.length - 1], missing };
  };
  const HOUR = 3_600_000;
  return c.json({
    day, fy,
    sales: { bills: sales!.bills ?? 0, netPaise: sales!.net, totalPaise: sales!.total, voids: sales!.voids ?? 0 }, byMode,
    events: Object.fromEntries(events.map((e) => [e.kind, { n: e.n, paise: e.paise }])),
    differences: Object.fromEntries(diffs.map((d) => [d.kind, { n: d.n, paise: d.paise }])),
    unpaid: unpaid.filter((o) => o.sent_paise > 0).map((o) => ({
      id: o.id, place: o.place, status: o.status, guestName: o.guest_name, billNo: o.bill_no, voided: o.voids > 0,
      sentPaise: o.sent_paise, openedAt: o.opened_at, openedShiftDay: o.opened_shift_day, hours: Math.floor((t - o.opened_at) / HOUR),
      // Old: a tab past the business's limit, or anything else open for more than 6 hours.
      old: o.status === 'tab' ? (t - o.opened_at) / 86_400_000 > b.tab_age_days : t - o.opened_at > 6 * HOUR,
    })),
    series: series.map((x) => ({ name: x.name, prefix: x.prefix, ...gaps(x.seqs) })),
    creditNoteSeries: cnSeries.map((x) => ({ name: x.name, ...gaps(x.seqs) })),
    bar: { counts: bar!.counts, missingPaise: Math.round(bar!.missing), extraPaise: Math.round(bar!.extra), breakagePaise: Math.round(bar!.waste) },
    shiftClose: close ? { differencePaise: close.difference_paise, reason: close.difference_reason, closedAt: close.closed_at } : null,
  });
});

// GSTR-1 working for one calendar month, per GST-registered billing name: sales to unregistered buyers (B2C small) by rate,
// net of credit notes; the SAC summary; and the document summary (bill and credit-note series, with void bills as cancelled).
// The date is the bill's date (India time, when printed), not the shift. Bills to registered businesses are not recorded
// separately yet: the POS does not take a guest's GSTIN.
reportRoutes.get(`${B}/reports/gstr1`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const month = c.req.query('month') ?? '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(400, 'Month must look like 2026-11.');
  const IST = 19_800_000;
  const start = Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 1) - IST;
  const end = Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1) - IST;
  const [entities, bills, lines, notes] = await Promise.all([
    all<{ id: string; name: string; gstin: string | null; gst_registered: number }>(db,
      'SELECT id, name, gstin, gst_registered FROM billing_entities WHERE business_id = ? ORDER BY is_default DESC, name', bid),
    all<{ id: string; entity_id: string; bill_no: string; seq: number; status: string; gst_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; total_paise: number }>(db,
      `SELECT id, entity_id, bill_no, seq, status, gst_rate_bp, taxable_paise, cgst_paise, sgst_paise, total_paise FROM bills
       WHERE business_id = ? AND printed_at >= ? AND printed_at < ? ORDER BY entity_id, seq`, bid, start, end),
    all<{ bill_id: string; sac: string; qty: number; amount_paise: number }>(db,
      `SELECT l.bill_id, l.sac, l.qty, l.amount_paise FROM bill_lines l JOIN bills b ON b.id = l.bill_id
       WHERE b.business_id = ? AND b.printed_at >= ? AND b.printed_at < ? AND b.status <> 'void'`, bid, start, end),
    all<{ entity_id: string; cn_no: string; seq: number; gst_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; total_paise: number; lines: string }>(db,
      `SELECT n.entity_id, n.cn_no, n.seq, b.gst_rate_bp, n.taxable_paise, n.cgst_paise, n.sgst_paise, n.total_paise, n.lines FROM credit_notes n JOIN bills b ON b.id = n.bill_id
       WHERE n.business_id = ? AND n.at >= ? AND n.at < ? ORDER BY n.entity_id, n.seq`, bid, start, end),
  ]);
  const out = entities.map((e) => {
    const eb = bills.filter((x) => x.entity_id === e.id);
    const live = eb.filter((x) => x.status !== 'void');
    const en = notes.filter((n) => n.entity_id === e.id);
    // B2C small: by rate, bills less credit notes.
    const rates = new Map<number, { taxable: number; cgst: number; sgst: number }>();
    const add = (rate: number, k: 1 | -1, x: { taxable_paise: number; cgst_paise: number; sgst_paise: number }) => {
      const r = rates.get(rate) ?? { taxable: 0, cgst: 0, sgst: 0 };
      r.taxable += k * x.taxable_paise; r.cgst += k * x.cgst_paise; r.sgst += k * x.sgst_paise;
      rates.set(rate, r);
    };
    for (const x of live) add(x.gst_rate_bp, 1, x);
    for (const n of en) add(n.gst_rate_bp, -1, n);
    // SAC summary: each bill's taxable value and tax shared over its SACs by line value (one SAC per bill in practice).
    const sac = new Map<string, { qty: number; taxable: number; cgst: number; sgst: number }>();
    for (const x of live) {
      const ls = lines.filter((l) => l.bill_id === x.id);
      const gross = ls.reduce((t, l) => t + l.amount_paise, 0) || 1;
      for (const l of ls) {
        const r = sac.get(l.sac) ?? { qty: 0, taxable: 0, cgst: 0, sgst: 0 };
        const share = l.amount_paise / gross;
        r.qty += l.qty; r.taxable += x.taxable_paise * share; r.cgst += x.cgst_paise * share; r.sgst += x.sgst_paise * share;
        sac.set(l.sac, r);
      }
    }
    const doc = (nos: { no: string; seq: number; cancelled: boolean }[]) => nos.length
      ? { from: nos[0].no, to: nos[nos.length - 1].no, total: nos.length, cancelled: nos.filter((d) => d.cancelled).length } : null;
    return {
      name: e.name, gstin: e.gstin, registered: !!e.gst_registered,
      b2cs: [...rates].sort((x, y) => x[0] - y[0]).map(([rate, r]) => ({ ratePct: rate / 100, taxablePaise: r.taxable, cgstPaise: r.cgst, sgstPaise: r.sgst })),
      sac: [...sac].map(([code, r]) => ({ sac: code, qty: r.qty, taxablePaise: Math.round(r.taxable), cgstPaise: Math.round(r.cgst), sgstPaise: Math.round(r.sgst) })),
      invoices: doc(eb.map((x) => ({ no: x.bill_no, seq: x.seq, cancelled: x.status === 'void' }))),
      creditNotes: doc(en.map((n) => ({ no: n.cn_no, seq: n.seq, cancelled: false }))),
      totalPaise: live.reduce((t, x) => t + x.total_paise, 0) - en.reduce((t, n) => t + n.total_paise, 0),
    };
  }).filter((e) => e.invoices || e.creditNotes);
  return c.json({ month, entities: out });
});

// Who owes what, aged: what is owed is taken to be the newest charges (older ones were paid first).
reportRoutes.get(`${B}/reports/debtors`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const { t } = clock(bizOf(c));
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
