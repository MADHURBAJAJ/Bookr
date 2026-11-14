// Bar stock: stores, items, recipes, receiving, transfers, breakage, counts and the stock report (Owner and manager).
// Every movement is a row that is never changed. A count records the difference from the book as a variance, which also
// goes on the exceptions report; so does breakage.
import { Hono } from 'hono';
import { all, isUniqueViolation, newId, one, stmt, type DB } from '../../../src/db';
import { body, date, fail, optionalPaise, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { audit, clock, event, bizOf, loadBusiness } from '../util';
import type { AppEnv } from '../types';

export const stockRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
stockRoutes.use(`${B}/*`, requireStaff);

const whole = (v: unknown, label: string, min = 1, max = 10_000_000): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(400, `${label} must be a whole number${min > 0 ? ' above zero' : ''}.`);
  return v;
};

async function store(db: DB, bid: string, id: unknown, label = 'Store') {
  const s = await one<{ id: string; name: string }>(db, 'SELECT id, name FROM stock_stores WHERE id = ? AND business_id = ?', id, bid);
  if (!s) fail(400, `${label} not found.`);
  return s;
}
async function item(db: DB, bid: string, id: unknown) {
  const i = await one<{ id: string; name: string; unit: string; pack_size: number; cost_per_pack_paise: number }>(db,
    'SELECT id, name, unit, pack_size, cost_per_pack_paise FROM stock_items WHERE id = ? AND business_id = ?', id, bid);
  if (!i) fail(400, 'Stock item not found.');
  return i;
}
const onHand = async (db: DB, bid: string, itemId: string, storeId: string) =>
  (await one<{ q: number }>(db, 'SELECT coalesce(sum(qty), 0) AS q FROM stock_moves WHERE business_id = ? AND item_id = ? AND store_id = ?', bid, itemId, storeId))!.q;

// On hand: every item in every store, its value at the last price, and whether it is below its reorder level.
stockRoutes.get(`${B}/stock`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const stores = await all<{ id: string; name: string; kind: string }>(db, 'SELECT id, name, kind FROM stock_stores WHERE business_id = ? ORDER BY created_at', bid);
  const items = await all<{ id: string; name: string; unit: string; pack_name: string; pack_size: number; cost_per_pack_paise: number; reorder_level: number; active: number }>(db,
    'SELECT id, name, unit, pack_name, pack_size, cost_per_pack_paise, reorder_level, active FROM stock_items WHERE business_id = ? ORDER BY name', bid);
  const sums = await all<{ item_id: string; store_id: string; q: number }>(db, 'SELECT item_id, store_id, sum(qty) AS q FROM stock_moves WHERE business_id = ? GROUP BY item_id, store_id', bid);
  const recipes = await all(db, `SELECT r.menu_item_id AS menuItemId, m.name AS menuItem, r.stock_item_id AS stockItemId, r.qty FROM recipes r JOIN menu_items m ON m.id = r.menu_item_id
    WHERE r.business_id = ? ORDER BY m.name`, bid);
  return c.json({ stores, recipes, items: items.map((i) => {
    const byStore = Object.fromEntries(stores.map((s) => [s.id, sums.find((x) => x.item_id === i.id && x.store_id === s.id)?.q ?? 0]));
    const total = Object.values(byStore).reduce((a, b) => a + b, 0);
    return { id: i.id, name: i.name, unit: i.unit, packName: i.pack_name, packSize: i.pack_size, costPerPackPaise: i.cost_per_pack_paise, reorderLevel: i.reorder_level,
      active: i.active, byStore, total, valuePaise: Math.round((Math.max(0, total) * i.cost_per_pack_paise) / i.pack_size), low: total <= i.reorder_level };
  }) });
});

stockRoutes.post(`${B}/stock/stores`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  if (!['main', 'bar', 'kitchen'].includes(data.kind as string)) fail(400, 'Kind must be main, bar or kitchen.');
  const name = text(data, 'name', 'Store name', { max: 40 })!;
  const id = newId();
  try {
    await stmt(c.env.DB, 'INSERT INTO stock_stores (id, business_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)', id, bid, name, data.kind, Date.now()).run();
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'There is already a store with that name.');
    throw e;
  }
  return c.json({ id }, 201);
});

function itemFields(data: Record<string, unknown>) {
  if (!['ml', 'pcs', 'g'].includes(data.unit as string)) fail(400, 'Unit must be ml, pcs or g.');
  return {
    name: text(data, 'name', 'Item name', { max: 80 })!, unit: data.unit as string, pack_name: text(data, 'packName', 'Pack name', { optional: true, max: 20 }) ?? 'pack',
    pack_size: whole(data.packSize, 'Units in a pack'), cost_per_pack_paise: optionalPaise(data, 'costPerPack', 'Cost per pack') ?? 0,
    reorder_level: whole(data.reorderLevel ?? 0, 'Reorder level', 0), active: data.active === false ? 0 : 1,
  };
}

stockRoutes.post(`${B}/stock/items`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const f = itemFields(await body(c));
  const id = newId();
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT INTO stock_items (id, business_id, name, unit, pack_name, pack_size, cost_per_pack_paise, reorder_level, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, bid, f.name, f.unit, f.pack_name, f.pack_size, f.cost_per_pack_paise, f.reorder_level, f.active, Date.now()),
      audit(c.env.DB, bid, c.get('staff').id, 'stock_item.create', 'stock_items', id, null, f),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'There is already a stock item with that name.');
    throw e;
  }
  return c.json({ id }, 201);
});

stockRoutes.put(`${B}/stock/items/:id`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one(c.env.DB, 'SELECT name, unit, pack_name, pack_size, cost_per_pack_paise, reorder_level, active FROM stock_items WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Stock item not found.');
  const f = itemFields(await body(c));
  if (f.unit !== before.unit && (await one(c.env.DB, 'SELECT 1 FROM stock_moves WHERE item_id = ? LIMIT 1', id))) fail(409, 'This item has stock movements; its unit cannot change.');
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE stock_items SET name = ?, unit = ?, pack_name = ?, pack_size = ?, cost_per_pack_paise = ?, reorder_level = ?, active = ? WHERE id = ?',
      f.name, f.unit, f.pack_name, f.pack_size, f.cost_per_pack_paise, f.reorder_level, f.active, id),
    audit(c.env.DB, bid, c.get('staff').id, 'stock_item.update', 'stock_items', id, before, f),
  ]);
  return c.json({ ok: true });
});

// A menu item's recipe, replaced whole: [{stockItemId, qty}] (an empty list takes the recipe away).
stockRoutes.put(`${B}/stock/recipes/:menuItemId`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const menuItemId = c.req.param('menuItemId');
  if (!(await one(db, 'SELECT 1 FROM menu_items WHERE id = ? AND business_id = ?', menuItemId, bid))) fail(404, 'Menu item not found.');
  const data = await body(c);
  if (!Array.isArray(data.lines) || data.lines.length > 20) fail(400, 'A recipe is a list of up to 20 stock items.');
  const lines: { stockItemId: string; qty: number }[] = [];
  for (const raw of data.lines) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const i = await item(db, bid, r.stockItemId);
    if (lines.some((l) => l.stockItemId === i.id)) fail(400, `${i.name} is in the recipe twice.`);
    lines.push({ stockItemId: i.id, qty: whole(r.qty, `Quantity of ${i.name}`) });
  }
  const before = await all(db, 'SELECT stock_item_id, qty FROM recipes WHERE menu_item_id = ?', menuItemId);
  await db.batch([
    stmt(db, 'DELETE FROM recipes WHERE menu_item_id = ?', menuItemId),
    ...lines.map((l) => stmt(db, 'INSERT INTO recipes (menu_item_id, stock_item_id, business_id, qty) VALUES (?, ?, ?, ?)', menuItemId, l.stockItemId, bid, l.qty)),
    audit(db, bid, c.get('staff').id, 'recipe.set', 'recipes', menuItemId, before, lines),
  ]);
  return c.json({ ok: true });
});

// Goods received into a store, with the vendor's invoice: quantities in packs, price per pack (it becomes the item's last price).
stockRoutes.post(`${B}/stock/purchases`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const s = await store(db, bid, data.storeId);
  const vendor = text(data, 'vendor', 'Vendor', { max: 80 })!;
  const invoice = text(data, 'invoiceNo', 'Invoice number', { optional: true, max: 40 });
  if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 50) fail(400, 'Add what was received.');
  const { t, shiftDay } = clock(bizOf(c));
  const statements = [];
  for (const raw of data.lines) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const i = await item(db, bid, r.itemId);
    const packs = whole(r.packs, `Packs of ${i.name}`, 1, 100000);
    const cost = optionalPaise(r, 'costPerPack', `Price per pack of ${i.name}`);
    statements.push(stmt(db, `INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, cost_per_pack_paise, ref, vendor, by_staff, shift_day, at)
      VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, ?, ?, ?, ?)`, newId(), bid, i.id, s.id, packs * i.pack_size, cost, invoice, vendor, c.get('staff').id, shiftDay, t));
    if (cost !== null) statements.push(stmt(db, 'UPDATE stock_items SET cost_per_pack_paise = ? WHERE id = ?', cost, i.id));
  }
  await db.batch(statements);
  return c.json({ ok: true }, 201);
});

// Moves stock between stores (e.g. main store to bar), in units of the item (ml, pcs).
stockRoutes.post(`${B}/stock/transfers`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const from = await store(db, bid, data.fromStoreId, 'From store');
  const to = await store(db, bid, data.toStoreId, 'To store');
  if (from.id === to.id) fail(400, 'Choose two different stores.');
  if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 50) fail(400, 'Add what moves.');
  const { t, shiftDay } = clock(bizOf(c));
  const ref = newId();
  const statements = [];
  for (const raw of data.lines) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const i = await item(db, bid, r.itemId);
    const qty = whole(r.qty, `Quantity of ${i.name}`);
    const have = await onHand(db, bid, i.id, from.id);
    if (qty > have) fail(409, `${from.name} has only ${have} ${i.unit} of ${i.name}.`);
    statements.push(
      stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, ref, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'transfer_out', ?, ?, ?, ?, ?)",
        newId(), bid, i.id, from.id, -qty, `To ${to.name} · ${ref.slice(0, 8)}`, c.get('staff').id, shiftDay, t),
      stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, ref, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'transfer_in', ?, ?, ?, ?, ?)",
        newId(), bid, i.id, to.id, qty, `From ${from.name} · ${ref.slice(0, 8)}`, c.get('staff').id, shiftDay, t));
  }
  await db.batch(statements);
  return c.json({ ok: true }, 201);
});

// Breakage, spillage or anything else lost, with a reason (also on the exceptions report).
stockRoutes.post(`${B}/stock/waste`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const s = await store(db, bid, data.storeId);
  const i = await item(db, bid, data.itemId);
  const qty = whole(data.qty, 'Quantity');
  const reason = text(data, 'reason', 'Reason', { max: 120 })!;
  const { t, shiftDay } = clock(bizOf(c));
  const value = Math.round((qty * i.cost_per_pack_paise) / i.pack_size);
  await db.batch([
    stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, reason, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'waste', ?, ?, ?, ?, ?)",
      newId(), bid, i.id, s.id, -qty, reason, c.get('staff').id, shiftDay, t),
    event(db, bid, 'stock_waste', `${i.name} · ${s.name}`, value, reason, `${qty} ${i.unit}`, c.get('staff').id, shiftDay),
  ]);
  return c.json({ ok: true }, 201);
});

// A physical count: for each item counted, the difference from the book is recorded as a variance.
stockRoutes.post(`${B}/stock/counts`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const s = await store(db, bid, data.storeId);
  if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 200) fail(400, 'Add what was counted.');
  const { t, shiftDay } = clock(bizOf(c));
  const statements = [];
  const result = [];
  for (const raw of data.lines) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const i = await item(db, bid, r.itemId);
    const counted = whole(r.counted, `Count of ${i.name}`, 0);
    const book = await onHand(db, bid, i.id, s.id);
    const diff = counted - book;
    result.push({ name: i.name, unit: i.unit, book, counted, variance: diff, valuePaise: Math.round((diff * i.cost_per_pack_paise) / i.pack_size) });
    if (diff === 0) continue;
    statements.push(
      stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, counted_qty, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'count', ?, ?, ?, ?, ?)",
        newId(), bid, i.id, s.id, diff, counted, c.get('staff').id, shiftDay, t),
      event(db, bid, 'stock_count', `${i.name} · ${s.name}`, Math.round((diff * i.cost_per_pack_paise) / i.pack_size), null,
        `Book ${book} ${i.unit}, counted ${counted} ${i.unit} (${diff > 0 ? '+' : ''}${diff})`, c.get('staff').id, shiftDay));
  }
  if (statements.length) await db.batch(statements);
  return c.json({ lines: result }, 201);
});

// For shifts from..to and one store: per item, opening, received, transfers, sold, breakage, count variance and closing.
stockRoutes.get(`${B}/stock/report`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  const s = await store(db, bid, c.req.query('storeId'));
  const rows = await all<{ id: string; name: string; unit: string; pack_size: number; cost_per_pack_paise: number; opening: number; purchase: number; transfer_in: number;
    transfer_out: number; sale: number; waste: number; count: number }>(db, `
    SELECT i.id, i.name, i.unit, i.pack_size, i.cost_per_pack_paise,
      coalesce(sum(CASE WHEN m.shift_day < ? THEN m.qty END), 0) AS opening,
      coalesce(sum(CASE WHEN m.shift_day BETWEEN ? AND ? AND m.kind = 'purchase' THEN m.qty END), 0) AS purchase,
      coalesce(sum(CASE WHEN m.shift_day BETWEEN ? AND ? AND m.kind = 'transfer_in' THEN m.qty END), 0) AS transfer_in,
      coalesce(sum(CASE WHEN m.shift_day BETWEEN ? AND ? AND m.kind = 'transfer_out' THEN m.qty END), 0) AS transfer_out,
      coalesce(sum(CASE WHEN m.shift_day BETWEEN ? AND ? AND m.kind = 'sale' THEN m.qty END), 0) AS sale,
      coalesce(sum(CASE WHEN m.shift_day BETWEEN ? AND ? AND m.kind = 'waste' THEN m.qty END), 0) AS waste,
      coalesce(sum(CASE WHEN m.shift_day BETWEEN ? AND ? AND m.kind = 'count' THEN m.qty END), 0) AS count
    FROM stock_items i LEFT JOIN stock_moves m ON m.item_id = i.id AND m.store_id = ? AND m.shift_day <= ?
    WHERE i.business_id = ? GROUP BY i.id ORDER BY i.name`, from, from, to, from, to, from, to, from, to, from, to, from, to, s.id, to, bid);
  return c.json({ from, to, store: s, items: rows.map((r) => {
    const closing = r.opening + r.purchase + r.transfer_in + r.transfer_out + r.sale + r.waste + r.count;
    const v = (q: number) => Math.round((q * r.cost_per_pack_paise) / r.pack_size);
    return { id: r.id, name: r.name, unit: r.unit, opening: r.opening, received: r.purchase, transferIn: r.transfer_in, transferOut: -r.transfer_out, sold: -r.sale,
      waste: -r.waste, variance: r.count, closing, closingValuePaise: v(Math.max(0, closing)), varianceValuePaise: v(r.count), wasteValuePaise: v(-r.waste) };
  }).filter((x) => x.opening || x.received || x.transferIn || x.transferOut || x.sold || x.waste || x.variance || x.closing) });
});
