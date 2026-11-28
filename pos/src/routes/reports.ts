// Reports the POS gives on its own, before it is connected to Bookr: sales by billing name with GST, by payment mode and by
// item; discounts and complimentary bills; and who owes what, aged, with each account's statement (GET /debtors/:id).
import { noRentOf, waitingOf } from './shifts';
import { Hono } from 'hono';
import { all, one, type DB } from '../../../src/db';
import { date, fail } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { clock, bizOf, loadBusiness, type Business } from '../util';
import { billNo, billTaxRows, creditNoteNo, fyOf, type TaxRow } from '../billing';
import type { AppEnv } from '../types';
import { occupancy, roomRevenueByDay } from './frontdesk';
import { drawersOfDay } from './drawers';
import { cancelledReceipts } from './receipt-cancels';
import { deskAll } from '../rooms';
import { shiftDayAt } from '../billing';
import { servingSummary, timedLines } from '../serving';

export const reportRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
/** A bill settled as NC or complimentary (for a bill aliased b): not a sale. */
export const COMP = "EXISTS (SELECT 1 FROM payments p WHERE p.settlement_id = b.settlement_id AND p.mode = 'comp')";
const shiftAdd = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
reportRoutes.use(`${B}/*`, requireStaff);

// Sales of shifts from..to (bills by the shift they were printed in; payments by the shift they were taken in).
reportRoutes.get(`${B}/reports/sales`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  // Sales leave out NC and complimentary bills (the same rule as every other report); the table by name on the bill keeps
  // every bill, as GST records need.
  const days = await all(db, `SELECT b.shift_day AS day, count(*) AS bills, sum(b.taxable_paise + b.nongst_paise) AS netPaise, sum(b.total_paise) AS totalPaise FROM bills b
    WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND NOT ${COMP} GROUP BY b.shift_day ORDER BY b.shift_day`, bid, from, to);
  // Compared with: the same day last week for one shift, else the same number of shifts just before.
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const back = span === 1 ? 7 : span;
  const [pFrom, pTo] = [shiftAdd(from, -back), shiftAdd(to, -back)];
  const totals = (a: string, z: string) => one<{ bills: number; grossPaise: number; discountPaise: number; netPaise: number; totalPaise: number }>(db, `SELECT count(*) AS bills,
      coalesce(sum(b.gross_paise), 0) AS grossPaise, coalesce(sum(b.discount_paise), 0) AS discountPaise, coalesce(sum(b.taxable_paise + b.nongst_paise), 0) AS netPaise,
      coalesce(sum(b.total_paise), 0) AS totalPaise FROM bills b WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND NOT ${COMP}`, bid, a, z);
  const [paid, prev, nc] = await Promise.all([totals(from, to), totals(pFrom, pTo),
    one<{ bills: number; menuPaise: number }>(db, `SELECT count(*) AS bills, coalesce(sum(b.gross_paise), 0) AS menuPaise FROM bills b
      WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND ${COMP}`, bid, from, to)]);
  const byEntity = await all(db, `SELECT e.name, e.gst_registered AS gstRegistered, e.gstin, count(*) AS bills, sum(b.gross_paise) AS grossPaise,
      sum(b.discount_paise) AS discountPaise, sum(b.taxable_paise) AS taxablePaise, sum(b.nongst_paise) AS nonGstPaise, sum(b.cgst_paise) AS cgstPaise, sum(b.sgst_paise) AS sgstPaise,
      sum(b.round_off_paise) AS roundOffPaise, sum(b.total_paise) AS totalPaise, min(b.bill_no) AS firstBill, max(b.bill_no) AS lastBill
    FROM bills b JOIN billing_entities e ON e.id = b.entity_id
    WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' GROUP BY e.id ORDER BY e.is_default DESC, e.name`, bid, from, to);
  const byMode = await all(db, `SELECT p.mode, count(*) AS n, sum(p.amount_paise) AS paise FROM payments p JOIN settlements s ON s.id = p.settlement_id
    WHERE p.business_id = ? AND p.shift_day BETWEEN ? AND ? AND s.kind = 'bills' GROUP BY p.mode ORDER BY paise DESC`, bid, from, to);
  const items = await all(db, `SELECT l.name, sum(l.qty) AS qty, sum(l.amount_paise) AS amountPaise FROM bill_lines l JOIN bills b ON b.id = l.bill_id
    WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND NOT ${COMP} GROUP BY l.name ORDER BY amountPaise DESC`, bid, from, to);
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
  const creditNotes = await all(db, `SELECT e.name, count(*) AS n, sum(n.taxable_paise) AS taxablePaise, sum(n.nongst_paise) AS nonGstPaise, sum(n.cgst_paise) AS cgstPaise, sum(n.sgst_paise) AS sgstPaise,
      sum(n.total_paise) AS totalPaise, min(n.cn_no) AS first, max(n.cn_no) AS last
    FROM credit_notes n JOIN billing_entities e ON e.id = n.entity_id WHERE n.business_id = ? AND n.shift_day BETWEEN ? AND ? GROUP BY e.id ORDER BY e.is_default DESC, e.name`, bid, from, to);
  const creditNoteList = await all(db, `SELECT n.cn_no AS cnNo, b.bill_no AS billNo, n.total_paise AS totalPaise, n.reason, n.refund_mode AS refundMode, n.shift_day AS day
    FROM credit_notes n JOIN bills b ON b.id = n.bill_id WHERE n.business_id = ? AND n.shift_day BETWEEN ? AND ? ORDER BY n.at`, bid, from, to);
  return c.json({ from, to, days, paid, nc, prev: { from: pFrom, to: pTo, ...prev }, byEntity, byMode, items, discounts, comps, voids, creditNotes, creditNoteList, tips, paymentDiscounts });
});

// When, where and by whom the money came in, and what sold: for shifts from..to, void bills left out.
// Money is net sales (after bill discounts, before GST; liquor, which has no GST, included); item and category values are before bill discounts.
// Hours are India time, from when each KOT was printed: what the kitchen and bar were sent, and when.
reportRoutes.get(`${B}/reports/insights`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const live = `b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND NOT ${COMP}`;
  // The shifts from..to as times: from the shift start hour (India time) on From, to the same hour the day after To.
  const startOf = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), bizOf(c).shift_start_hour) - 19_800_000;
  const fromMs = startOf(from);
  const toMs = startOf(to) + 86_400_000;
  const [byHour, coversByHour, byService, byStaff, mix, items, notSold] = await Promise.all([
    // Each KOT line: its quantity, valued at the order's price for that dish (menu price, before discounts and GST).
    // Kitchen against bar: a KOT counts as bar when its station is a bar station (stations of their own since 19 Nov 2026).
    all(db, `SELECT ((k.printed_at + 19800000) / 3600000) % 24 AS hour,
        CASE WHEN coalesce(s.is_bar, lower(k.station) = 'bar') THEN 'bar' ELSE 'kitchen' END AS station, count(DISTINCT k.id) AS kots,
        sum(json_extract(j.value, '$.qty')) AS items, sum(json_extract(j.value, '$.qty') * coalesce(json_extract(j.value, '$.pricePaise'), ol.price_paise, 0)) AS valuePaise
      FROM kots k JOIN json_each(k.lines) j LEFT JOIN stations s ON s.id = k.station_id
      LEFT JOIN order_lines ol ON ol.order_id = k.order_id AND ol.name = json_extract(j.value, '$.name')
      WHERE k.business_id = ? AND k.printed_at >= ? AND k.printed_at < ? GROUP BY hour, 2 ORDER BY hour`, bid, fromMs, toMs),
    // Guests, counted at the hour of their order's first KOT.
    all(db, `SELECT ((first + 19800000) / 3600000) % 24 AS hour, sum(covers) AS covers FROM (
        SELECT min(k.printed_at) AS first, max(coalesce(o.covers, 0)) AS covers FROM kots k JOIN orders o ON o.id = k.order_id
        WHERE k.business_id = ? AND k.printed_at >= ? AND k.printed_at < ? GROUP BY k.order_id) GROUP BY hour`, bid, fromMs, toMs),
    all(db, `SELECT o.kind, count(*) AS bills, sum(b.taxable_paise + b.nongst_paise) AS netPaise, sum(coalesce(o.covers, 0)) AS covers,
        sum(CASE WHEN o.covers > 0 THEN b.taxable_paise + b.nongst_paise ELSE 0 END) AS coveredNetPaise, count(DISTINCT lower(o.place) || b.shift_day) AS placeDays
      FROM bills b JOIN orders o ON o.id = b.order_id WHERE ${live} GROUP BY o.kind ORDER BY netPaise DESC`, bid, from, to),
    all(db, `SELECT coalesce(st.name, 'Unknown') AS name, st.role,
        sum(b.status <> 'void' AND NOT ${COMP}) AS bills, sum(CASE WHEN b.status <> 'void' AND NOT ${COMP} THEN b.taxable_paise + b.nongst_paise ELSE 0 END) AS netPaise,
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
reportRoutes.get(`${B}/reports/daily-check`, requireAction('reports.view'), async (c) =>
  c.json(await dailyCheckData(c.env.DB, bizOf(c), c.get('businessId'), date({ d: c.req.query('day') ?? '' }, 'd', 'Shift'))));

/** The Daily check of one shift (also sent to the owner as a PDF each morning, through a one-time link). */
export async function dailyCheckData(db: DB, b: Business, bid: string, day: string) {
  const { t } = clock(b);
  const fy = fyOf(day, b.fy_start_month);
  const [sales, byMode, events, diffs, unpaid, series, cnSeries, close, bar, typed] = await Promise.all([
    one<{ bills: number; net: number; total: number; voids: number; nc: number; ncMenu: number }>(db, `SELECT sum(b.status <> 'void' AND NOT ${COMP}) AS bills,
        coalesce(sum(CASE WHEN b.status <> 'void' AND NOT ${COMP} THEN b.taxable_paise + b.nongst_paise END), 0) AS net,
        coalesce(sum(CASE WHEN b.status <> 'void' AND NOT ${COMP} THEN b.total_paise END), 0) AS total,
        sum(b.status <> 'void' AND ${COMP}) AS nc, coalesce(sum(CASE WHEN b.status <> 'void' AND ${COMP} THEN b.gross_paise END), 0) AS ncMenu,
        sum(b.status = 'void') AS voids FROM bills b WHERE b.business_id = ? AND b.shift_day = ?`, bid, day),
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
    all<{ entity_id: string; name: string; prefix: string; seqs: string; days: string | null; last_no: string }>(db, `SELECT e.id AS entity_id, e.name, e.series_prefix AS prefix,
        group_concat(b.seq) AS seqs, group_concat(b.print_day || ':' || b.day_seq) AS days,
        (SELECT x.bill_no FROM bills x WHERE x.entity_id = e.id AND x.fy = ? ORDER BY x.seq DESC LIMIT 1) AS last_no
      FROM bills b JOIN billing_entities e ON e.id = b.entity_id WHERE b.business_id = ? AND b.fy = ? GROUP BY e.id ORDER BY e.is_default DESC, e.name`, fy, bid, fy),
    all<{ entity_id: string; name: string; prefix: string; seqs: string; days: string | null }>(db, `SELECT e.id AS entity_id, e.name, e.series_prefix AS prefix,
        group_concat(n.seq) AS seqs, group_concat(n.print_day || ':' || n.day_seq) AS days
      FROM credit_notes n JOIN billing_entities e ON e.id = n.entity_id WHERE n.business_id = ? AND n.fy = ? GROUP BY e.id`, bid, fy),
    one<{ difference_paise: number; difference_reason: string | null; closed_at: number; counted_at: number | null; auto: number; totals: string | null }>(db,
      'SELECT difference_paise, difference_reason, closed_at, counted_at, auto, totals FROM shift_closes WHERE business_id = ? AND shift_day = ?', bid, day),
    // The bar: how many counts were taken this shift, and what they found missing or extra, at cost.
    one<{ counts: number; missing: number; extra: number; waste: number }>(db, `SELECT
        (SELECT count(*) FROM pos_events e WHERE e.business_id = ?1 AND e.shift_day = ?2 AND e.kind = 'stock_count' AND e.reason = 'Count'
          AND e.ref IN (SELECT 'Count · ' || name FROM stock_stores WHERE business_id = ?1 AND kind = 'bar')) AS counts,
        coalesce(sum(CASE WHEN m.kind = 'count' AND m.qty < 0 THEN -m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS missing,
        coalesce(sum(CASE WHEN m.kind = 'count' AND m.qty > 0 THEN m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS extra,
        coalesce(sum(CASE WHEN m.kind = 'waste' THEN -m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS waste
      FROM stock_moves m JOIN stock_items i ON i.id = m.item_id JOIN stock_stores ss ON ss.id = m.store_id
      WHERE m.business_id = ?1 AND m.shift_day = ?2 AND ss.kind = 'bar' AND m.kind IN ('count', 'waste')`, bid, day),
    // Prices typed at billing (bottles, seafood, catering): each with who typed it and the item's lowest price.
    all(db, `SELECT b.bill_no AS billNo, l.name, l.qty, l.rate_paise AS pricePaise, m.min_price_paise AS minPricePaise, st.name AS byName
      FROM bill_lines l JOIN bills b ON b.id = l.bill_id LEFT JOIN menu_items m ON m.id = l.item_id LEFT JOIN staff st ON st.id = l.price_by
      WHERE b.business_id = ? AND b.shift_day = ? AND b.status <> 'void' AND l.price_by IS NOT NULL ORDER BY b.printed_at`, bid, day),
  ]);
  // A series is unbroken when its numbers run 1, 2, 3 … with none missing (void bills keep their number, so they count).
  const gaps = (seqs: string) => {
    const nums = seqs.split(',').map(Number).sort((x, y) => x - y);
    const have = new Set(nums);
    const missing: number[] = [];
    for (let i = 1; i <= nums[nums.length - 1] && missing.length < 20; i++) if (!have.has(i)) missing.push(i);
    return { count: nums.length, last: nums[nums.length - 1], missing };
  };
  // Numbers by print date (from 19 Nov 2026): each day of each billing name runs 001, 002, 003 … with none missing.
  // A missing one is named as it would have been printed (C261119004).
  const dayGaps = (days: string | null, numberOf: (day: string, n: number) => string) => {
    const by = new Map<string, Set<number>>();
    for (const x of (days ?? '').split(',').filter(Boolean)) { const [d, n] = x.split(':'); by.set(d, (by.get(d) ?? new Set()).add(Number(n))); }
    const out: string[] = [];
    for (const [d, ns] of [...by].sort()) for (let i = 1; i <= Math.max(...ns) && out.length < 20; i++) if (!ns.has(i)) out.push(numberOf(d, i));
    return out;
  };
  const HOUR = 3_600_000;
  // Receipts cancelled this day (27 Nov 2026): who, why, how much.
  const cancelledReceiptsOfDay = await cancelledReceipts(db, bid, day);
  return {
    day, fy, cancelledReceipts: cancelledReceiptsOfDay,
    // Djubo money reception marked this day that POS receipts on the room bill cover (28 Nov 2026): not asked about, listed.
    djuboCovered: (await deskAll(db, bid)).filter((r) => r.coveredBy.length && r.deskPaidAt && shiftDayAt(r.deskPaidAt, b.shift_start_hour) === day)
      .map((r) => ({ extRef: r.extRef, guestName: r.guestName, enteredBy: r.enteredBy, deskPaidPaise: r.deskPaidPaise, coveredBy: r.coveredBy })),
    sales: { bills: sales!.bills ?? 0, netPaise: sales!.net, totalPaise: sales!.total, voids: sales!.voids ?? 0, ncBills: sales!.nc ?? 0, ncMenuPaise: sales!.ncMenu }, byMode,
    events: Object.fromEntries(events.map((e) => [e.kind, { n: e.n, paise: e.paise }])),
    differences: Object.fromEntries(diffs.map((d) => [d.kind, { n: d.n, paise: d.paise }])),
    unpaid: unpaid.filter((o) => o.sent_paise > 0).map((o) => ({
      id: o.id, place: o.place, status: o.status, guestName: o.guest_name, billNo: o.bill_no, voided: o.voids > 0,
      sentPaise: o.sent_paise, openedAt: o.opened_at, openedShiftDay: o.opened_shift_day, hours: Math.floor((t - o.opened_at) / HOUR),
      // Old: a tab past the business's limit, or anything else open for more than 6 hours.
      old: o.status === 'tab' ? (t - o.opened_at) / 86_400_000 > b.tab_age_days : t - o.opened_at > 6 * HOUR,
    })),
    // Missing: bill numbers missing within a day, then any gap in the year's running count (which no printed number shows).
    series: series.map((x) => { const g = gaps(x.seqs); return { name: x.name, prefix: x.prefix, count: g.count, last: g.last, lastNo: x.last_no,
      missing: [...dayGaps(x.days, (d, n) => billNo(x.prefix, d, n)), ...g.missing.map((n) => `bill ${n} of ${fy}`)] }; }),
    creditNoteSeries: cnSeries.map((x) => { const g = gaps(x.seqs); return { name: x.name, count: g.count, last: g.last,
      missing: [...dayGaps(x.days, (d, n) => creditNoteNo(x.prefix, d, n)), ...g.missing.map((n) => `credit note ${n} of ${fy}`)] }; }),
    typedPrices: typed,
    bar: { counts: bar!.counts, missingPaise: Math.round(bar!.missing), extraPaise: Math.round(bar!.extra), breakagePaise: Math.round(bar!.waste) },
    drawers: await drawersOfDay(db, bid, Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), b.shift_start_hour) - 19_800_000,
      Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), b.shift_start_hour) - 19_800_000 + 86_400_000),
    shiftClose: close ? { differencePaise: close.difference_paise, reason: close.difference_reason, closedAt: close.closed_at, countedAt: close.counted_at, auto: !!close.auto,
      // Closed with counting turned off (26 Nov 2026): not a missed count, so not flagged.
      noCount: (() => { try { return !!JSON.parse(String(close.totals ?? '{}')).noCount; } catch { return false; } })(),
      // Closed by itself with guests still in house and no rent for the night (28 Nov 2026).
      noRent: close.auto ? noRentOf(close.totals) : [], waitingRoom: close.auto ? waitingOf(close.totals) : [] } : null,
    // Sent to the kitchen or bar, not paid (25 Nov 2026): bills voided this shift whose order was not billed and paid
    // again, and the stock a cancelled KOT put back on the book, to check at the stock count.
    voidedNotRebilled: await all(db, `SELECT b.bill_no AS billNo, b.total_paise AS totalPaise, o.place
      FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.business_id = ? AND b.shift_day = ? AND b.status = 'void'
        AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.order_id = b.order_id AND x.status <> 'void') ORDER BY b.printed_at`, bid, day),
    // Checked in late this shift (25 Nov 2026): stays opened in this shift with an earlier check-in date (a booking missed at the desk).
    lateCheckIns: await all(db, `SELECT s.room, s.guest_name AS guestName, s.check_in AS checkIn, st.name AS byName, s.created_at AS at,
        s.checked_out_at AS checkedOutAt FROM stays s LEFT JOIN staff st ON st.id = s.opened_by
      WHERE s.business_id = ? AND s.group_stay_id IS NULL AND s.check_in < ? AND s.created_at >= ? AND s.created_at < ? ORDER BY s.created_at`, bid, day,
      Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), b.shift_start_hour) - 19_800_000,
      Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), b.shift_start_hour) - 19_800_000 + 86_400_000),
    // Checked out this shift without a POS room invoice (25 Nov 2026): a stay from before the POS whose total rent was not
    // known, or a stay with no room rent on its bill at all (a walk-in whose rent was never added: worth a look).
    noInvoice: await all(db, `SELECT s.room, s.guest_name AS guestName, s.check_in AS checkIn, s.checked_out_at AS at,
        EXISTS (SELECT 1 FROM bookings k WHERE k.stay_id = s.id AND k.from_report = 1 AND k.amount_paise IS NULL) AS rentUnknown,
        (SELECT st.name FROM audit_log a JOIN staff st ON st.id = a.staff_id WHERE a.row_table = 'stays' AND a.row_id = s.id AND a.action = 'stay.check_out' ORDER BY a.id DESC LIMIT 1) AS byName
      FROM stays s WHERE s.business_id = ? AND s.group_stay_id IS NULL AND s.checked_out_at >= ? AND s.checked_out_at < ?
        AND NOT EXISTS (SELECT 1 FROM room_invoices i WHERE i.stay_id = s.id) ORDER BY s.checked_out_at`, bid,
      Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), b.shift_start_hour) - 19_800_000,
      Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), b.shift_start_hour) - 19_800_000 + 86_400_000),
    cancelReturns: await all(db, `SELECT i.name, ss.name AS store, i.unit, sum(m.qty) AS qty FROM stock_moves m JOIN stock_items i ON i.id = m.item_id
      JOIN stock_stores ss ON ss.id = m.store_id WHERE m.business_id = ? AND m.shift_day = ? AND m.kind = 'sale' AND m.qty > 0 AND m.ref LIKE '% · cancelled'
      GROUP BY i.id, ss.id ORDER BY i.name`, bid, day),
    serving: await servingOfDay(db, bid, day),
  };
}

/**
 * Serving time on the Daily check (28 Nov 2026): items on time, late, not marked; the worst three; and everything done
 * after the fact (undos by a manager or by a server within 2 minutes, items undone and not served again, items marked
 * by a manager with no photo), plus wrong server PINs. Null when nothing was timed and nothing happened.
 */
export async function servingOfDay(db: DB, bid: string, day: string) {
  const [lines, log, pins] = await Promise.all([
    timedLines(db, bid, { from: day, to: day }),
    all<{ kind: string; ref: string; reason: string | null; detail: string | null; by: string | null; at: number }>(db,
      `SELECT e.kind, e.ref, e.reason, e.detail, st.name AS by, e.at FROM pos_events e LEFT JOIN staff st ON st.id = e.by_staff
       WHERE e.business_id = ? AND e.shift_day = ? AND e.kind IN ('serve_undo', 'serve_manager') ORDER BY e.at`, bid, day),
    one<{ n: number }>(db, 'SELECT count(*) AS n FROM serve_signins WHERE business_id = ? AND shift_day = ? AND ok = 0', bid, day),
  ]);
  if (!lines.length && !log.length && !pins?.n) return null;
  const sum = servingSummary(lines);
  const serverUndos = log.filter((e) => e.kind === 'serve_undo' && e.detail?.startsWith('server:'));
  const byName = new Map<string, number>();
  for (const e of serverUndos) byName.set(e.detail!.slice(7), (byName.get(e.detail!.slice(7)) ?? 0) + 1);
  return {
    timed: sum.timed, marked: sum.marked, onTime: sum.onTime, late: sum.late, notMarked: sum.notMarked, waiting: sum.waiting, avgLateMins: sum.avgLateMins, worst: sum.worst,
    wrongPins: pins?.n ?? 0,
    undoneByManager: log.filter((e) => e.kind === 'serve_undo' && !e.detail?.startsWith('server:')).length,
    undoneByServer: serverUndos.length, serverUndos: [...byName].map(([name, n]) => ({ name, n })),
    // Undone by a manager and still not served again.
    undoneNotServed: lines.filter((l) => l.undoneAt !== null && l.servedAt === null).map((l) => ({ place: l.place, name: l.name, qty: l.qty, by: l.undoneBy, reason: l.undoReason, at: l.undoneAt })),
    managerMarks: log.filter((e) => e.kind === 'serve_manager').length,
    log: log.map((e) => ({ kind: e.kind, ref: e.ref, reason: e.reason, at: e.at, by: e.detail?.startsWith('server:') ? e.detail.slice(7) : e.by, server: !!e.detail?.startsWith('server:') })),
  };
}

// Reports › Serving time (28 Nov 2026): items late out of those timed, by item, day, hour and server, for shifts from..to.
reportRoutes.get(`${B}/reports/serving`, requireAction('reports.view'), async (c) => {
  const from = date({ v: c.req.query('from') }, 'v', 'From');
  const to = date({ v: c.req.query('to') }, 'v', 'To');
  if (to < from) fail(400, 'The end date is before the start.');
  if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) fail(400, 'Choose at most 3 months.');
  const sum = servingSummary(await timedLines(c.env.DB, c.get('businessId'), { from, to }));
  return c.json({ from, to, ...sum });
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
  const [entities, bills, lines, notes, billRows, noteRows] = await Promise.all([
    all<{ id: string; name: string; gstin: string | null; gst_registered: number }>(db,
      'SELECT id, name, gstin, gst_registered FROM billing_entities WHERE business_id = ? ORDER BY is_default DESC, name', bid),
    all<{ id: string; entity_id: string; bill_no: string; seq: number; status: string; gst_rate_bp: number; taxable_paise: number; nongst_paise: number; cgst_paise: number; sgst_paise: number; total_paise: number }>(db,
      `SELECT id, entity_id, bill_no, seq, status, gst_rate_bp, taxable_paise, nongst_paise, cgst_paise, sgst_paise, total_paise FROM bills
       WHERE business_id = ? AND printed_at >= ? AND printed_at < ? ORDER BY entity_id, seq`, bid, start, end),
    all<{ bill_id: string; sac: string; qty: number; amount_paise: number; bp: number }>(db,
      `SELECT l.bill_id, l.sac, l.qty, l.amount_paise - l.discount_paise AS amount_paise, coalesce(l.gst_bp, b.gst_rate_bp) AS bp FROM bill_lines l JOIN bills b ON b.id = l.bill_id
       WHERE b.business_id = ? AND b.printed_at >= ? AND b.printed_at < ? AND b.status <> 'void'
         AND coalesce(l.tax_kind, CASE WHEN l.taxed = 1 THEN 'gst' ELSE 'liquor' END) = 'gst'`, bid, start, end),
    all<{ id: string; entity_id: string; cn_no: string; seq: number; gst_rate_bp: number; taxable_paise: number; nongst_paise: number; cgst_paise: number; sgst_paise: number; total_paise: number }>(db,
      `SELECT n.id, n.entity_id, n.cn_no, n.seq, b.gst_rate_bp, n.taxable_paise, n.nongst_paise, n.cgst_paise, n.sgst_paise, n.total_paise FROM credit_notes n JOIN bills b ON b.id = n.bill_id
       WHERE n.business_id = ? AND n.at >= ? AND n.at < ? ORDER BY n.entity_id, n.seq`, bid, start, end),
    all<TaxRow & { bill_id: string }>(db, `SELECT t.bill_id, t.kind, t.gst_bp AS bp, t.value_paise AS valuePaise, t.cgst_paise AS cgstPaise, t.sgst_paise AS sgstPaise
      FROM bill_taxes t JOIN bills b ON b.id = t.bill_id WHERE b.business_id = ? AND b.printed_at >= ? AND b.printed_at < ? AND b.status <> 'void'`, bid, start, end),
    all<TaxRow & { credit_note_id: string }>(db, `SELECT t.credit_note_id, t.kind, t.gst_bp AS bp, t.value_paise AS valuePaise, t.cgst_paise AS cgstPaise, t.sgst_paise AS sgstPaise
      FROM credit_note_taxes t JOIN credit_notes n ON n.id = t.credit_note_id WHERE n.business_id = ? AND n.at >= ? AND n.at < ?`, bid, start, end),
  ]);
  // Each bill's and note's tax rows (older ones: GST at the bill's rate, and liquor).
  const rowsOf = (x: { gst_rate_bp: number; taxable_paise: number; nongst_paise: number; cgst_paise: number; sgst_paise: number }, rows: TaxRow[]) =>
    billTaxRows({ gstRateBp: x.gst_rate_bp, taxablePaise: x.taxable_paise, nonGstPaise: x.nongst_paise, cgstPaise: x.cgst_paise, sgstPaise: x.sgst_paise }, rows);
  const out = entities.map((e) => {
    const eb = bills.filter((x) => x.entity_id === e.id);
    const live = eb.filter((x) => x.status !== 'void');
    const en = notes.filter((n) => n.entity_id === e.id);
    // B2C small by rate, and Table 8 (liquor: non-GST supply; exempt), bills less credit notes.
    const rates = new Map<number, { taxable: number; cgst: number; sgst: number }>();
    const table8 = { liquor: 0, exempt: 0 };
    const add = (k: 1 | -1, r: TaxRow) => {
      if (r.kind !== 'gst') { table8[r.kind] += k * r.valuePaise; return; }
      const x = rates.get(r.bp) ?? { taxable: 0, cgst: 0, sgst: 0 };
      x.taxable += k * r.valuePaise; x.cgst += k * r.cgstPaise; x.sgst += k * r.sgstPaise;
      rates.set(r.bp, x);
    };
    const gstRowsOf = new Map<string, TaxRow[]>();
    for (const x of live) {
      const rs = rowsOf(x, billRows.filter((r) => r.bill_id === x.id));
      gstRowsOf.set(x.id, rs.filter((r) => r.kind === 'gst'));
      for (const r of rs) add(1, r);
    }
    for (const n of en) for (const r of rowsOf(n, noteRows.filter((r) => r.credit_note_id === n.id))) add(-1, r);
    // SAC summary per SAC and rate: each GST row's value and tax shared over that rate's lines by line value.
    const sac = new Map<string, { sac: string; bp: number; qty: number; taxable: number; cgst: number; sgst: number }>();
    for (const x of live) {
      for (const r of gstRowsOf.get(x.id) ?? []) {
        const ls = lines.filter((l) => l.bill_id === x.id && l.bp === r.bp);
        const gross = ls.reduce((t, l) => t + l.amount_paise, 0) || 1;
        for (const l of ls) {
          const key = `${l.sac}:${r.bp}`;
          const v = sac.get(key) ?? { sac: l.sac, bp: r.bp, qty: 0, taxable: 0, cgst: 0, sgst: 0 };
          const share = l.amount_paise / gross;
          v.qty += l.qty; v.taxable += r.valuePaise * share; v.cgst += r.cgstPaise * share; v.sgst += r.sgstPaise * share;
          sac.set(key, v);
        }
      }
    }
    const doc = (nos: { no: string; seq: number; cancelled: boolean }[]) => nos.length
      ? { from: nos[0].no, to: nos[nos.length - 1].no, total: nos.length, cancelled: nos.filter((d) => d.cancelled).length } : null;
    return {
      name: e.name, gstin: e.gstin, registered: !!e.gst_registered,
      b2cs: [...rates].sort((x, y) => x[0] - y[0]).filter(([, r]) => r.taxable || r.cgst).map(([rate, r]) => ({ ratePct: rate / 100, taxablePaise: r.taxable, cgstPaise: r.cgst, sgstPaise: r.sgst })),
      sac: [...sac.values()].sort((a, b) => a.sac.localeCompare(b.sac) || a.bp - b.bp).filter((r) => r.taxable || r.qty)
        .map((r) => ({ sac: r.sac, ratePct: r.bp / 100, qty: r.qty, taxablePaise: Math.round(r.taxable), cgstPaise: Math.round(r.cgst), sgstPaise: Math.round(r.sgst) })),
      invoices: doc(eb.map((x) => ({ no: x.bill_no, seq: x.seq, cancelled: x.status === 'void' }))),
      creditNotes: doc(en.map((n) => ({ no: n.cn_no, seq: n.seq, cancelled: false }))),
      // Table 8, net of credit notes: liquor (non-GST supply) and items with no GST (exempt).
      nonGstPaise: table8.liquor,
      exemptPaise: table8.exempt,
      totalPaise: live.reduce((t, x) => t + x.total_paise, 0) - en.reduce((t, n) => t + n.total_paise, 0),
    };
  }).filter((e) => e.invoices || e.creditNotes);
  // Room invoices and room credit notes (25 Nov 2026): rent at 5% or 18%, SAC 996311, under each billing name; an invoice
  // made out to a company with a GSTIN is B2B.
  const [rooms, roomCns] = await Promise.all([
    all<{ entity_id: string; invoice_no: string; at: number; gst_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; total_paise: number; nights: number;
      bill_to_name: string | null; bill_to_gstin: string | null }>(db, `SELECT entity_id, invoice_no, at, gst_rate_bp, taxable_paise, cgst_paise, sgst_paise, total_paise, nights, bill_to_name, bill_to_gstin
      FROM room_invoices WHERE business_id = ? AND at >= ? AND at < ? ORDER BY seq`, bid, start, end),
    all<{ entity_id: string; cn_no: string; gst_rate_bp: number; taxable_paise: number; cgst_paise: number; sgst_paise: number; total_paise: number }>(db, `SELECT i.entity_id, n.cn_no,
      i.gst_rate_bp, n.taxable_paise, n.cgst_paise, n.sgst_paise, n.total_paise FROM room_credit_notes n JOIN room_invoices i ON i.id = n.invoice_id
      WHERE n.business_id = ? AND n.at >= ? AND n.at < ? ORDER BY n.seq`, bid, start, end),
  ]);
  const roomOut = entities.map((e) => {
    const inv = rooms.filter((r) => r.entity_id === e.id);
    const cns = roomCns.filter((r) => r.entity_id === e.id);
    if (!inv.length && !cns.length) return null;
    const rates = new Map<number, { taxable: number; cgst: number; sgst: number; nights: number }>();
    for (const r of inv.filter((x) => !x.bill_to_gstin)) { const x = rates.get(r.gst_rate_bp) ?? { taxable: 0, cgst: 0, sgst: 0, nights: 0 }; x.taxable += r.taxable_paise; x.cgst += r.cgst_paise; x.sgst += r.sgst_paise; x.nights += r.nights; rates.set(r.gst_rate_bp, x); }
    for (const r of cns) { const x = rates.get(r.gst_rate_bp) ?? { taxable: 0, cgst: 0, sgst: 0, nights: 0 }; x.taxable -= r.taxable_paise; x.cgst -= r.cgst_paise; x.sgst -= r.sgst_paise; rates.set(r.gst_rate_bp, x); }
    return { name: e.name, gstin: e.gstin,
      b2cs: [...rates].sort((a, b) => a[0] - b[0]).map(([bp, x]) => ({ ratePct: bp / 100, sac: '996311', nights: x.nights, taxablePaise: x.taxable, cgstPaise: x.cgst, sgstPaise: x.sgst })),
      b2b: inv.filter((x) => x.bill_to_gstin).map((x) => ({ gstin: x.bill_to_gstin, name: x.bill_to_name, invoiceNo: x.invoice_no, at: x.at, ratePct: x.gst_rate_bp / 100,
        taxablePaise: x.taxable_paise, cgstPaise: x.cgst_paise, sgstPaise: x.sgst_paise, totalPaise: x.total_paise })),
      invoices: inv.length ? { from: inv[0].invoice_no, to: inv[inv.length - 1].invoice_no, total: inv.length, cancelled: 0 } : null,
      creditNotes: cns.length ? { from: cns[0].cn_no, to: cns[cns.length - 1].cn_no, total: cns.length, cancelled: 0 } : null,
      totalPaise: inv.reduce((t, x) => t + x.total_paise, 0) - cns.reduce((t, x) => t + x.total_paise, 0) };
  }).filter(Boolean);
  return c.json({ month, entities: out, rooms: roomOut });
});

// Room sales for shifts from..to (25 Nov 2026): each room invoice (rent, GST), room credit notes, no-show charges kept,
// and totals by GST rate.
reportRoutes.get(`${B}/reports/rooms`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const today = clock(bizOf(c)).shiftDay;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('from') ?? '') ? c.req.query('from')! : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('to') ?? '') ? c.req.query('to')! : from;
  const hour = bizOf(c).shift_start_hour * 3_600_000;   // a shift day starts at the shift's hour, India time
  const [invoices, cns, kept, noRent] = await Promise.all([
    all(db, `SELECT invoice_no AS invoiceNo, shift_day AS day, guest_name AS guestName, room, check_in AS checkIn, check_out AS checkOut, nights, gst_rate_bp AS gstRateBp,
      taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise, total_paise AS totalPaise, bill_to_name AS billToName, bill_to_gstin AS billToGstin
      FROM room_invoices WHERE business_id = ? AND shift_day BETWEEN ? AND ? ORDER BY seq`, bid, from, to),
    all(db, `SELECT n.cn_no AS cnNo, n.shift_day AS day, i.invoice_no AS invoiceNo, n.reason, n.taxable_paise AS taxablePaise, n.cgst_paise AS cgstPaise, n.sgst_paise AS sgstPaise,
      n.total_paise AS totalPaise, n.refund_mode AS refundMode FROM room_credit_notes n JOIN room_invoices i ON i.id = n.invoice_id WHERE n.business_id = ? AND n.shift_day BETWEEN ? AND ? ORDER BY n.seq`, bid, from, to),
    all(db, `SELECT d.guest_name AS guestName, d.amount_paise AS amountPaise, d.kept_at AS at, s.receipt_no AS receiptNo FROM desk_advances d JOIN settlements s ON s.id = d.settlement_id
      WHERE d.business_id = ? AND d.status = 'kept' AND d.kept_at >= ? AND d.kept_at < ?`, bid, Date.parse(from) + hour - 19_800_000, Date.parse(to) + 86_400_000 + hour - 19_800_000),
    // Checked out with no room rent on the bill (25 Nov 2026): approved by a manager, listed here to be looked at.
    all(db, `SELECT s.room, s.guest_name AS guestName, s.check_in AS checkIn, s.checked_out_at AS at, st.name AS byName,
        json_extract(a.after, '$.approvedBy') AS approvedBy
      FROM stays s LEFT JOIN audit_log a ON a.row_table = 'stays' AND a.row_id = s.id AND a.action = 'stay.check_out' LEFT JOIN staff st ON st.id = a.staff_id
      WHERE s.business_id = ? AND s.group_stay_id IS NULL AND s.checked_out_at >= ? AND s.checked_out_at < ?
        AND NOT EXISTS (SELECT 1 FROM room_invoices i WHERE i.stay_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM bookings k WHERE k.stay_id = s.id AND k.from_report = 1 AND k.amount_paise IS NULL)
      ORDER BY s.checked_out_at`, bid, Date.parse(from) + hour - 19_800_000, Date.parse(to) + 86_400_000 + hour - 19_800_000),
  ]);
  const sum = (rows: Record<string, unknown>[], k: string) => rows.reduce((t, r) => t + Number(r[k] ?? 0), 0);
  // Occupancy, ADR and RevPAR (25 Nov 2026). ADR is room sales before GST per night invoiced (invoices are made at
  // check-out); RevPAR is ADR times occupancy, rooms and beds together.
  const occ = await occupancy(db, bizOf(c), from, to);
  const nightsInvoiced = sum(invoices, 'nights');
  const salesNet = sum(invoices, 'taxablePaise') - sum(cns, 'taxablePaise');
  const adrPaise = nightsInvoiced ? Math.round(salesNet / nightsInvoiced) : null;
  const avail = occ.rooms.available + occ.beds.available;
  const occAll = avail ? (occ.rooms.sold + occ.beds.sold) / avail : null;
  // Room revenue earned night by night (25 Nov 2026), not when invoiced or paid. ADR and RevPAR follow it: revenue before
  // GST per night sold, earned each night (not only once a guest has checked out).
  const byDay = await roomRevenueByDay(db, bizOf(c), from, to);
  const soldNights = byDay.totals.roomsSold + byDay.totals.bedsSold;
  const adrEarned = soldNights ? Math.round(byDay.totals.taxablePaise / soldNights) : adrPaise;
  const kpis = { ...occ, adrPaise: adrEarned, revparPaise: adrEarned != null && occAll != null ? Math.round(adrEarned * occAll) : null,
    pct: occAll == null ? null : Math.round(occAll * 1000) / 10 };
  return c.json({ from, to, invoices, creditNotes: cns, noShowsKept: kept, noRent, occupancy: kpis, byDay,
    totals: { invoices: invoices.length, nights: sum(invoices, 'nights'), taxablePaise: sum(invoices, 'taxablePaise') - sum(cns, 'taxablePaise'),
      gstPaise: sum(invoices, 'cgstPaise') + sum(invoices, 'sgstPaise') - sum(cns, 'cgstPaise') - sum(cns, 'sgstPaise'),
      totalPaise: sum(invoices, 'totalPaise') - sum(cns, 'totalPaise'), noShowPaise: sum(kept, 'amountPaise') } });
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
    "SELECT account_id, amount_paise, at FROM debtor_entries WHERE business_id = ? AND amount_paise > 0 AND kind IN ('charge', 'advance_used', 'room_rent', 'transfer') ORDER BY at DESC", bid);
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

// Profit per dish for shifts from..to: what each dish sold for (before bill discounts and GST) against what its recipe
// costs at the last price paid for each stock item. NC, complimentary and void bills left out (they are on Losses).
// Each dish with a recipe is placed by two questions, kitchen and bar apart: does it sell well (at least 70% of an even
// share of the dishes sold) and does it earn well (profit per plate at or above the average)?
reportRoutes.get(`${B}/reports/profit`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const rows = await all<{ id: string | null; name: string; category: string; station: string; qty: number; salesPaise: number; unitCost: number | null }>(db, `
    SELECT l.item_id AS id, max(l.name) AS name, coalesce(m.category, '') AS category, coalesce(m.station, 'kitchen') AS station,
      sum(l.qty) AS qty, sum(l.amount_paise - l.discount_paise) AS salesPaise,
      (SELECT sum(r.qty * i.cost_per_pack_paise * 1.0 / i.pack_size) FROM recipes r JOIN stock_items i ON i.id = r.stock_item_id WHERE r.menu_item_id = l.item_id) AS unitCost
    FROM bill_lines l JOIN bills b ON b.id = l.bill_id LEFT JOIN menu_items m ON m.id = l.item_id
    WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND NOT ${COMP}
    GROUP BY coalesce(l.item_id, l.name) ORDER BY salesPaise DESC`, bid, from, to);
  const discount = (await one<{ d: number }>(db, `SELECT coalesce(sum(b.discount_paise), 0) AS d FROM bills b
    WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND NOT ${COMP}`, bid, from, to))!.d;
  const dishes = rows.map((r) => {
    const costed = r.unitCost != null;
    const costPaise = costed ? Math.round(r.unitCost! * r.qty) : null;
    return { id: r.id, name: r.name, category: r.category, station: r.station === 'bar' ? 'bar' : 'kitchen', qty: r.qty, salesPaise: r.salesPaise,
      costPaise, profitPaise: costed ? r.salesPaise - costPaise! : null, costPct: costed && r.salesPaise ? Math.round((costPaise! * 1000) / r.salesPaise) / 10 : null,
      group: null as null | 'best' | 'popular' | 'profitable' | 'weak' };
  });
  const stations = (['kitchen', 'bar'] as const).map((st) => {
    const all_ = dishes.filter((d) => d.station === st);
    const costed = all_.filter((d) => d.costPaise != null && d.qty > 0);
    const qty = costed.reduce((t, d) => t + d.qty, 0);
    const profit = costed.reduce((t, d) => t + d.profitPaise!, 0);
    const sales = costed.reduce((t, d) => t + d.salesPaise, 0);
    const cost = costed.reduce((t, d) => t + d.costPaise!, 0);
    const popularAt = costed.length ? (0.7 * qty) / costed.length : 0;
    const avgProfit = qty ? profit / qty : 0;
    for (const d of costed) {
      const pop = d.qty >= popularAt;
      const earns = d.profitPaise! / d.qty >= avgProfit;
      d.group = pop && earns ? 'best' : pop ? 'popular' : earns ? 'profitable' : 'weak';
    }
    const allSales = all_.reduce((t, d) => t + d.salesPaise, 0);
    return { station: st, salesPaise: allSales, costedSalesPaise: sales, costPaise: cost, profitPaise: profit,
      costPct: sales ? Math.round((cost * 1000) / sales) / 10 : null, notCosted: all_.length - costed.length, avgProfitPaise: Math.round(avgProfit) };
  });
  return c.json({ from, to, discountPaise: discount, stations, dishes });
});

// What was lost or given away in shifts from..to, each with who and why: cancelled after KOT, voids, discounts, NC and
// complimentary, refunds; stock broken or found missing at a count (at cost); and cash short or over at shift close.
reportRoutes.get(`${B}/reports/losses`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const [events, stock, cash] = await Promise.all([
    all(db, `SELECT e.kind, e.ref, e.amount_paise AS amountPaise, e.reason, e.detail, coalesce(s.name, '') AS byName, e.shift_day AS day, e.at
      FROM pos_events e LEFT JOIN staff s ON s.id = e.by_staff
      WHERE e.business_id = ? AND e.shift_day BETWEEN ? AND ? AND e.kind IN ('kot_cancel', 'void', 'discount', 'comp', 'credit_note') ORDER BY e.at`, bid, from, to),
    all(db, `SELECT i.name, i.unit, m.kind, sum(-m.qty) AS qty, round(sum(-m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size)) AS valuePaise
      FROM stock_moves m JOIN stock_items i ON i.id = m.item_id
      WHERE m.business_id = ? AND m.shift_day BETWEEN ? AND ? AND (m.kind = 'waste' OR (m.kind = 'count' AND m.qty < 0))
      GROUP BY i.id, m.kind ORDER BY valuePaise DESC`, bid, from, to),
    all(db, `SELECT x.shift_day AS day, x.difference_paise AS differencePaise, CASE WHEN x.counted_at IS NULL THEN 'Not counted (closed automatically)' ELSE x.difference_reason END AS reason, coalesce(s.name, '') AS byName
      FROM shift_closes x LEFT JOIN staff s ON s.id = x.closed_by WHERE x.business_id = ? AND x.shift_day BETWEEN ? AND ? ORDER BY x.shift_day`, bid, from, to),
  ]);
  return c.json({ from, to, events, stock, cash });
});
