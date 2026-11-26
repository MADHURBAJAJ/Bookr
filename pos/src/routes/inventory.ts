// What an inventory manager needs beyond moving stock (22 Nov 2026): what to buy (shortages, from how fast things are
// used), what was used (consumption, by item and by the dishes that used it), what was bought (purchases, by vendor,
// with price rises), and supplier bills photographed but not yet received. Reads only; no new tables.
import { Hono } from 'hono';
import { all, one, stmt } from '../../../src/db';
import { date, fail } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { stockRule } from '../stock';
import { audit } from '../util';
import type { AppEnv } from '../types';

export const inventoryRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
inventoryRoutes.use(`${B}/*`, requireStaff);

const DAY = 86_400_000;
const OPENING = 'Opening stock';
const valueOf = (qty: number, i: { cost_per_pack_paise: number; pack_size: number }) => Math.round((qty * i.cost_per_pack_paise) / i.pack_size);
const num = (v: string | undefined, d: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : d; };

// What to buy: each item's stock, how fast it went over the last `days` days (sales by recipe, breakage, count shortfall),
// how many days that lasts, and how much to order to last `cover` days and stay above the reorder level.
// Needs ordering: at or below the reorder level, under `lead` days left, or below zero (the book is wrong: count it).
inventoryRoutes.get(`${B}/stock/shortages`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const days = num(c.req.query('days'), 14, 1, 90);
  const cover = num(c.req.query('cover'), 7, 1, 60);
  const lead = num(c.req.query('lead'), 3, 0, 30);
  const since = Date.now() - days * DAY;
  const rows = await all<{ id: string; name: string; unit: string; pack_name: string; pack_size: number; cost_per_pack_paise: number; reorder_level: number;
    on_hand: number; used: number; first_at: number | null }>(db, `
    SELECT i.id, i.name, i.unit, i.pack_name, i.pack_size, i.cost_per_pack_paise, i.reorder_level,
      coalesce((SELECT sum(m.qty) FROM stock_moves m WHERE m.item_id = i.id), 0) AS on_hand,
      coalesce((SELECT -sum(m.qty) FROM stock_moves m WHERE m.item_id = i.id AND m.at >= ? AND (m.kind IN ('sale', 'waste') OR (m.kind = 'count' AND m.qty < 0))), 0) AS used,
      (SELECT min(m.at) FROM stock_moves m WHERE m.item_id = i.id) AS first_at
    FROM stock_items i WHERE i.business_id = ? AND i.active = 1 ORDER BY i.name`, since, bid);
  const vendors = await all<{ item_id: string; vendor: string; cost: number | null }>(db, `SELECT m.item_id, m.vendor, m.cost_per_pack_paise AS cost FROM stock_moves m
    WHERE m.business_id = ? AND m.kind = 'purchase' AND m.vendor IS NOT NULL AND m.vendor <> ? AND m.at = (SELECT max(x.at) FROM stock_moves x
      WHERE x.item_id = m.item_id AND x.kind = 'purchase' AND x.vendor IS NOT NULL AND x.vendor <> ?)`, bid, OPENING, OPENING);
  const items = rows.map((r) => {
    // Usage per day over the days this item has been in stock (a new item is not averaged over days it did not exist).
    const span = r.first_at ? Math.max(1, Math.min(days, Math.ceil((Date.now() - r.first_at) / DAY))) : days;
    const perDay = r.used > 0 ? r.used / span : 0;
    const daysLeft = perDay > 0 ? Math.max(0, r.on_hand) / perDay : null;
    const target = Math.ceil(perDay * cover) + r.reorder_level;
    const units = Math.max(0, target - r.on_hand);
    const packs = Math.ceil(units / r.pack_size);
    const why = r.on_hand < 0 ? 'below zero' : r.reorder_level > 0 && r.on_hand <= r.reorder_level ? 'at or below reorder level'
      : daysLeft !== null && daysLeft < lead ? `under ${lead} days left` : null;
    const v = vendors.find((x) => x.item_id === r.id);
    return { id: r.id, name: r.name, unit: r.unit, packName: r.pack_name, packSize: r.pack_size, onHand: r.on_hand, reorderLevel: r.reorder_level,
      usedPerDay: Math.round(perDay * 10) / 10, daysLeft: daysLeft === null ? null : Math.round(daysLeft * 10) / 10, why,
      orderPacks: why ? Math.max(packs, r.on_hand < 0 || r.on_hand <= r.reorder_level ? 1 : 0) : packs, costPerPackPaise: v?.cost ?? r.cost_per_pack_paise, lastVendor: v?.vendor ?? null };
  });
  return c.json({ days, cover, lead, items });
});

// What was used, item by item, for shifts from..to (one store, or all): by sales (through recipes), breakage, and
// count shortfall; extra found at counts shown apart. With the dishes that used each item most.
inventoryRoutes.get(`${B}/stock/consumption`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const storeId = c.req.query('storeId') || null;
  if (storeId && !(await one(db, 'SELECT 1 FROM stock_stores WHERE id = ? AND business_id = ?', storeId, bid))) fail(400, 'Store not found.');
  const rows = await all<{ id: string; name: string; unit: string; pack_size: number; cost_per_pack_paise: number; sold: number; waste: number; missing: number; extra: number }>(db, `
    SELECT i.id, i.name, i.unit, i.pack_size, i.cost_per_pack_paise,
      coalesce(-sum(CASE WHEN m.kind = 'sale' THEN m.qty END), 0) AS sold,
      coalesce(-sum(CASE WHEN m.kind = 'waste' THEN m.qty END), 0) AS waste,
      coalesce(-sum(CASE WHEN m.kind = 'count' AND m.qty < 0 THEN m.qty END), 0) AS missing,
      coalesce(sum(CASE WHEN m.kind = 'count' AND m.qty > 0 THEN m.qty END), 0) AS extra
    FROM stock_items i JOIN stock_moves m ON m.item_id = i.id AND m.shift_day BETWEEN ? AND ? ${storeId ? 'AND m.store_id = ?' : ''}
    WHERE i.business_id = ? GROUP BY i.id ORDER BY i.name`, ...(storeId ? [from, to, storeId, bid] : [from, to, bid]));
  // The dishes behind each item's sales (today's recipes applied to the dishes billed, void bills left out).
  const dishes = await all<{ stock_item_id: string; dish: string; qty: number; units: number }>(db, `
    SELECT r.stock_item_id, l.name AS dish, sum(l.qty) AS qty, sum(l.qty * r.qty) AS units FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      JOIN recipes r ON r.menu_item_id = l.item_id WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void'
      GROUP BY r.stock_item_id, l.name ORDER BY units DESC`, bid, from, to);
  const nDays = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  // Sent to the kitchen or bar but not on a bill (24 Nov 2026): what the KOTs took less what bills (not void) account for —
  // tables still open, walkouts, or anything else that left without a bill. Only for all stores, as bills are not by store.
  const billed = new Map<string, number>();
  for (const d of dishes) billed.set(d.stock_item_id, (billed.get(d.stock_item_id) ?? 0) + d.units);
  const items = rows.map((r) => {
    const used = r.sold + r.waste + r.missing;
    const notBilled = storeId ? 0 : Math.max(0, r.sold - (billed.get(r.id) ?? 0));
    return { id: r.id, name: r.name, unit: r.unit, packSize: r.pack_size, sold: r.sold, waste: r.waste, missing: r.missing, extra: r.extra, used,
      notBilled, notBilledValuePaise: valueOf(notBilled, r),
      perDay: Math.round((used / nDays) * 10) / 10, usedValuePaise: valueOf(used, r), wasteValuePaise: valueOf(r.waste, r), missingValuePaise: valueOf(r.missing, r),
      topDishes: dishes.filter((d) => d.stock_item_id === r.id).slice(0, 3).map((d) => ({ dish: d.dish, qty: d.qty, units: d.units })) };
  }).filter((x) => x.used || x.extra);
  return c.json({ from, to, days: nDays, storeId, items, totals: {
    usedValuePaise: items.reduce((t, x) => t + x.usedValuePaise, 0), wasteValuePaise: items.reduce((t, x) => t + x.wasteValuePaise, 0),
    missingValuePaise: items.reduce((t, x) => t + x.missingValuePaise, 0), notBilledValuePaise: items.reduce((t, x) => t + x.notBilledValuePaise, 0) } });
});

// One item's consumption, behind its row (26 Nov 2026): the bills it was sold on, the orders that took it at the KOT
// and are on no bill yet, and the breakage and count shortfalls, with who and when. Loaded only when the row is tapped.
inventoryRoutes.get(`${B}/stock/consumption/item`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const storeId = c.req.query('storeId') || null;
  const item = await one<{ id: string; name: string; unit: string }>(db, 'SELECT id, name, unit FROM stock_items WHERE id = ? AND business_id = ?', c.req.query('itemId') ?? '', bid);
  if (!item) fail(404, 'Stock item not found.');
  const bills = await all<{ id: string; bill_no: string; place: string; printed_at: number; units: number; dishes: string }>(db, `
    SELECT b.id, b.bill_no, o.place, b.printed_at, sum(l.qty * r.qty) AS units, group_concat(l.qty || ' × ' || l.name, ', ') AS dishes
      FROM bill_lines l JOIN bills b ON b.id = l.bill_id JOIN orders o ON o.id = b.order_id JOIN recipes r ON r.menu_item_id = l.item_id AND r.stock_item_id = ?
      WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' GROUP BY b.id ORDER BY b.printed_at DESC LIMIT 300`, item.id, bid, from, to);
  // Sent (or handed over, for no-KOT items) on orders with no bill standing: still open, on a tab, or their bill voided.
  const unbilled = storeId ? [] : await all<{ id: string; place: string; status: string; opened_at: number; units: number; dishes: string; kots: string | null; by_name: string | null }>(db, `
    SELECT o.id, o.place, o.status, o.opened_at, sum(CASE WHEN l.kot = 0 THEN l.qty ELSE l.sent_qty END * r.qty) AS units,
      group_concat(CASE WHEN l.kot = 0 THEN l.qty ELSE l.sent_qty END || ' × ' || l.name, ', ') AS dishes,
      (SELECT group_concat(k.kot_no, ', ') FROM kots k WHERE k.order_id = o.id) AS kots,
      (SELECT st.name FROM kots k JOIN staff st ON st.id = k.by_staff WHERE k.order_id = o.id ORDER BY k.printed_at LIMIT 1) AS by_name
      FROM orders o JOIN order_lines l ON l.order_id = o.id JOIN recipes r ON r.menu_item_id = l.item_id AND r.stock_item_id = ?
      WHERE o.business_id = ? AND o.opened_shift_day BETWEEN ? AND ? AND o.status <> 'cancelled' AND o.opened_at >= ?
        AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.order_id = o.id AND b.status <> 'void')
      GROUP BY o.id HAVING units > 0 ORDER BY o.opened_at DESC LIMIT 300`, item.id, bid, from, to, stockRule.kotFrom);
  const losses = await all<{ kind: string; qty: number; reason: string | null; ref: string | null; at: number; shift_day: string; store: string; by_name: string | null }>(db, `
    SELECT m.kind, m.qty, m.reason, m.ref, m.at, m.shift_day, s.name AS store, st.name AS by_name FROM stock_moves m JOIN stock_stores s ON s.id = m.store_id
      LEFT JOIN staff st ON st.id = m.by_staff WHERE m.business_id = ? AND m.item_id = ? AND m.shift_day BETWEEN ? AND ? ${storeId ? 'AND m.store_id = ?' : ''}
      AND (m.kind = 'waste' OR (m.kind = 'count' AND m.qty < 0)) ORDER BY m.at DESC LIMIT 300`, ...(storeId ? [bid, item.id, from, to, storeId] : [bid, item.id, from, to]));
  return c.json({ item: { id: item.id, name: item.name, unit: item.unit }, from, to,
    bills: bills.map((b) => ({ id: b.id, billNo: b.bill_no, place: b.place, at: b.printed_at, units: b.units, dishes: b.dishes })),
    unbilled: unbilled.map((o) => ({ orderId: o.id, place: o.place, status: o.status, at: o.opened_at, units: o.units, dishes: o.dishes, kots: o.kots, by: o.by_name })),
    losses: losses.map((m) => ({ kind: m.kind === 'waste' ? 'breakage' : 'missing', qty: -m.qty, reason: m.reason ?? m.ref ?? '', at: m.at, store: m.store, by: m.by_name })) });
});

// What was bought for shifts from..to: each receipt (a bill, or one receiving), its lines and amount, the price paid
// against the time before (a rise of 5% or more is flagged), and the total per vendor. Opening stock is listed apart.
inventoryRoutes.get(`${B}/stock/purchases`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const rows = await all<{ id: string; at: number; shift_day: string; vendor: string | null; ref: string | null; bill_id: string | null; store: string; item: string; unit: string;
    pack_name: string; pack_size: number; qty: number; cost: number | null; prev: number | null; by_name: string | null; photo: number }>(db, `
    SELECT m.id, m.at, m.shift_day, m.vendor, m.ref, m.bill_id, s.name AS store, i.name AS item, i.unit, i.pack_name, i.pack_size, m.qty, m.cost_per_pack_paise AS cost,
      (SELECT p.cost_per_pack_paise FROM stock_moves p WHERE p.item_id = m.item_id AND p.kind = 'purchase' AND p.cost_per_pack_paise IS NOT NULL
         AND (p.at < m.at OR (p.at = m.at AND p.rowid < m.rowid)) ORDER BY p.at DESC, p.rowid DESC LIMIT 1) AS prev,
      st.name AS by_name, (SELECT pb.photo_key IS NOT NULL FROM purchase_bills pb WHERE pb.id = m.bill_id) AS photo
    FROM stock_moves m JOIN stock_items i ON i.id = m.item_id JOIN stock_stores s ON s.id = m.store_id LEFT JOIN staff st ON st.id = m.by_staff
    WHERE m.business_id = ? AND m.kind = 'purchase' AND m.shift_day BETWEEN ? AND ? ORDER BY m.at DESC, i.name`, bid, from, to);
  const receipts = new Map<string, { key: string; at: number; day: string; vendor: string; invoice: string | null; billId: string | null; photo: boolean; store: string; by: string | null;
    opening: boolean; lines: unknown[]; amountPaise: number; priceRises: number }>();
  for (const r of rows) {
    const key = r.bill_id ?? `${r.vendor}|${r.ref}|${r.at}`;
    const opening = r.vendor === OPENING;
    const rc = receipts.get(key) ?? { key, at: r.at, day: r.shift_day, vendor: r.vendor ?? '—', invoice: opening ? null : r.ref, billId: r.bill_id, photo: !!r.photo, store: r.store,
      by: r.by_name, opening, lines: [], amountPaise: 0, priceRises: 0 };
    const packs = r.qty / r.pack_size;
    const amount = r.cost === null ? 0 : Math.round(packs * r.cost);
    const risePct = r.cost !== null && r.prev ? Math.round(((r.cost - r.prev) * 1000) / r.prev) / 10 : null;
    rc.lines.push({ item: r.item, packs: Math.round(packs * 100) / 100, packName: r.pack_name, costPerPackPaise: r.cost, amountPaise: amount, prevCostPerPackPaise: r.prev, risePct });
    rc.amountPaise += amount;
    if (risePct !== null && risePct >= 5) rc.priceRises += 1;
    receipts.set(key, rc);
  }
  const list = [...receipts.values()];
  const bought = list.filter((x) => !x.opening);
  const byVendor = [...bought.reduce((m, x) => m.set(x.vendor, { vendor: x.vendor, receipts: (m.get(x.vendor)?.receipts ?? 0) + 1, amountPaise: (m.get(x.vendor)?.amountPaise ?? 0) + x.amountPaise }),
    new Map<string, { vendor: string; receipts: number; amountPaise: number }>()).values()].sort((a, b) => b.amountPaise - a.amountPaise);
  return c.json({ from, to, receipts: list, byVendor, totalPaise: bought.reduce((t, x) => t + x.amountPaise, 0) });
});

// Supplier bills photographed (and read) but not received yet: to finish later, or discard.
inventoryRoutes.get(`${B}/stock/bills`, requireAction('stock.edit'), async (c) => {
  const rows = await all<{ id: string; created_at: number; vendor: string | null; invoice_no: string | null; read_json: string | null; read_error: string | null; by_name: string | null; photo: number }>(c.env.DB,
    `SELECT pb.id, pb.created_at, pb.vendor, pb.invoice_no, pb.read_json, pb.read_error, st.name AS by_name, pb.photo_key IS NOT NULL AS photo FROM purchase_bills pb
     LEFT JOIN staff st ON st.id = pb.by_staff WHERE pb.business_id = ? AND pb.status = 'draft' ORDER BY pb.created_at DESC LIMIT 50`, c.get('businessId'));
  return c.json({ bills: rows.map((r) => ({ id: r.id, createdAt: r.created_at, vendor: r.vendor, invoiceNo: r.invoice_no, read: r.read_json ? JSON.parse(r.read_json) : null,
    error: r.read_error, by: r.by_name, photo: !!r.photo })) });
});

inventoryRoutes.delete(`${B}/stock/bills/:id`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const pb = await one<{ id: string; status: string; photo_key: string | null; vendor: string | null }>(c.env.DB, 'SELECT id, status, photo_key, vendor FROM purchase_bills WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!pb) fail(404, 'Bill not found.');
  if (pb.status !== 'draft') fail(409, 'This bill was received; it stays with its stock.');
  await c.env.DB.batch([
    stmt(c.env.DB, "DELETE FROM purchase_bills WHERE id = ? AND status = 'draft'", pb.id),
    audit(c.env.DB, bid, c.get('staff').id, 'purchase_bill.discard', 'purchase_bills', pb.id, { vendor: pb.vendor }, null),
  ]);
  if (pb.photo_key && c.env.BILLS) await c.env.BILLS.delete(pb.photo_key).catch(() => {});
  return c.json({ ok: true });
});
