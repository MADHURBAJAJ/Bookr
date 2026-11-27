// Bar stock: stores, items, recipes, receiving, transfers, breakage, counts and the stock report (Owner and manager).
// Every movement is a row that is never changed. A count records the difference from the book as a variance, which also
// goes on the exceptions report; so does breakage.
import { Hono } from 'hono';
import { all, isUniqueViolation, newId, one, stmt, type DB } from '../../../src/db';
import { body, date, fail, optionalPaise, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { audit, clock, event, bizOf, loadBusiness } from '../util';
import type { AppEnv } from '../types';
import { z } from 'zod';
import { askClaude, OcrError, readWithClaude } from '../../../src/claude';
import { cocktailInstructions, kitchenInstructions, propose, type NewStock, type Pours, type Proposal, type StockLite } from '../bar-recipes';

export const stockRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
stockRoutes.use(`${B}/*`, requireStaff);

const whole = (v: unknown, label: string, min = 1, max = 10_000_000): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(400, `${label} must be a whole number${min > 0 ? ' above zero' : ''}.`);
  return v;
};

async function store(db: DB, bid: string, id: unknown, label = 'Store') {
  const s = await one<{ id: string; name: string; kind: string }>(db, 'SELECT id, name, kind FROM stock_stores WHERE id = ? AND business_id = ?', id, bid);
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
  const items = await all<{ id: string; name: string; unit: string; pack_name: string; pack_size: number; cost_per_pack_paise: number; reorder_level: number; active: number; category: string | null }>(db,
    'SELECT id, name, unit, pack_name, pack_size, cost_per_pack_paise, reorder_level, active, category FROM stock_items WHERE business_id = ? ORDER BY name', bid);
  const sums = await all<{ item_id: string; store_id: string; q: number }>(db, 'SELECT item_id, store_id, sum(qty) AS q FROM stock_moves WHERE business_id = ? GROUP BY item_id, store_id', bid);
  const recipes = await all(db, `SELECT r.menu_item_id AS menuItemId, m.name AS menuItem, r.stock_item_id AS stockItemId, r.qty FROM recipes r JOIN menu_items m ON m.id = r.menu_item_id
    WHERE r.business_id = ? ORDER BY m.name`, bid);
  return c.json({ stores, recipes, items: items.map((i) => {
    const byStore = Object.fromEntries(stores.map((s) => [s.id, sums.find((x) => x.item_id === i.id && x.store_id === s.id)?.q ?? 0]));
    const total = Object.values(byStore).reduce((a, b) => a + b, 0);
    return { id: i.id, name: i.name, unit: i.unit, category: i.category, packName: i.pack_name, packSize: i.pack_size, costPerPackPaise: i.cost_per_pack_paise, reorderLevel: i.reorder_level,
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
    // Its category for count sheets (27 Nov 2026), e.g. Whisky, Beer, Cigarettes.
    category: text(data, 'category', 'Category', { optional: true, max: 40 }) ?? null,
  };
}

stockRoutes.post(`${B}/stock/items`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const f = itemFields(await body(c));
  const id = newId();
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT INTO stock_items (id, business_id, name, unit, pack_name, pack_size, cost_per_pack_paise, reorder_level, active, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, bid, f.name, f.unit, f.pack_name, f.pack_size, f.cost_per_pack_paise, f.reorder_level, f.active, Date.now(), f.category),
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
  const before = await one(c.env.DB, 'SELECT name, unit, pack_name, pack_size, cost_per_pack_paise, reorder_level, active, category FROM stock_items WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Stock item not found.');
  const f = itemFields(await body(c));
  if (f.unit !== before.unit && (await one(c.env.DB, 'SELECT 1 FROM stock_moves WHERE item_id = ? LIMIT 1', id))) fail(409, 'This item has stock movements; its unit cannot change.');
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE stock_items SET name = ?, unit = ?, pack_name = ?, pack_size = ?, cost_per_pack_paise = ?, reorder_level = ?, active = ?, category = ? WHERE id = ?',
      f.name, f.unit, f.pack_name, f.pack_size, f.cost_per_pack_paise, f.reorder_level, f.active, f.category, id),
    audit(c.env.DB, bid, c.get('staff').id, 'stock_item.update', 'stock_items', id, before, f),
  ]);
  return c.json({ ok: true });
});

// A stock item removed: refused while a recipe uses it; one with stock history is hidden (kept for its reports), else deleted.
stockRoutes.delete(`${B}/stock/items/:id`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const id = c.req.param('id');
  const it = await one<{ name: string }>(db, 'SELECT name FROM stock_items WHERE id = ? AND business_id = ?', id, bid);
  if (!it) fail(404, 'Stock item not found.');
  const used = await one<{ n: number }>(db, 'SELECT count(*) AS n FROM recipes WHERE stock_item_id = ?', id);
  if (used!.n) fail(409, `${it.name} is in ${used!.n === 1 ? 'a recipe' : `${used!.n} recipes`}. Take it out of ${used!.n === 1 ? 'that recipe' : 'them'} first.`);
  const moved = await one(db, 'SELECT 1 FROM stock_moves WHERE item_id = ? LIMIT 1', id);
  await db.batch([
    moved ? stmt(db, 'UPDATE stock_items SET active = 0 WHERE id = ?', id) : stmt(db, 'DELETE FROM stock_items WHERE id = ?', id),
    audit(db, bid, c.get('staff').id, moved ? 'stock_item.hide' : 'stock_item.delete', 'stock_items', id, { name: it.name }, null),
  ]);
  return c.json({ ok: true, hidden: !!moved });
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

// ---------- Make recipes: proposals for bar drinks without one, from their names (and Claude for cocktails). Saves nothing.
const CocktailReading = z.object({
  drinks: z.array(z.object({
    n: z.number().int(),
    menuItem: z.string(),
    note: z.string(),
    lines: z.array(z.object({ stock: z.string(), qty: z.number().int(), unit: z.enum(['ml', 'pcs', 'g']), isNew: z.boolean(), packName: z.string(), packSize: z.number().int() })),
  })),
});
const MAX_COCKTAILS = 60;
const pourSizes = (data: Record<string, unknown>): Pours => ({ peg: whole(data.peg ?? 30, 'Peg size', 5, 200), large: whole(data.large ?? 60, 'Large peg size', 5, 400), glass: whole(data.glass ?? 150, 'Glass of wine', 50, 500) });
const loadStock = async (db: DB, bid: string): Promise<StockLite[]> =>
  (await all<{ id: string; name: string; unit: string; pack_size: number }>(db, 'SELECT id, name, unit, pack_size FROM stock_items WHERE business_id = ? AND active = 1 ORDER BY name', bid))
    .map((x) => ({ id: x.id, name: x.name, unit: x.unit, packSize: x.pack_size }));
const drinkKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type Detail = 'major' | 'all';
const detailOf = (v: unknown): Detail => (v === 'all' ? 'all' : 'major');
/** The question for Claude: cocktails in the bar's pours, or kitchen dishes at the chosen detail. */
const promptFor = (kind: 'bar' | 'kitchen', ask: Proposal[], stock: StockLite[], pours: Pours, detail: Detail, planned: Map<string, NewStock>) => {
  const list = ask.map((p) => ({ name: p.menuItem, category: p.category }));
  const plan = [...planned.values()];
  return kind === 'kitchen' ? kitchenInstructions(list, stock, detail, plan) : cocktailInstructions(list, stock, pours, plan);
};

/** Claude's recipes for these items, into their proposals (matched by number, else by name). Throws OcrError. */
async function fillWithClaude(env: AppEnv['Bindings'], ask: Proposal[], stock: StockLite[], prompt: string, newItems: Map<string, NewStock>) {
  const r = await askClaude(env, prompt, CocktailReading);
  ask.forEach((p, i) => {
    const d = r.data.drinks.find((x) => x.n === i + 1 && drinkKey(x.menuItem) === drinkKey(p.menuItem))
      ?? r.data.drinks.find((x) => drinkKey(x.menuItem) === drinkKey(p.menuItem)) ?? r.data.drinks.find((x) => x.n === i + 1);
    p.source = 'claude';
    p.check = true;
    p.lines = [];
    if (!d) { p.note = 'The AI gave no recipe for this one.'; return; }
    p.note = d.note;
    for (const l of d.lines) {
      if (l.qty <= 0 || l.qty > 5000) continue;
      const name = l.stock.trim().slice(0, 80);
      if (!name) continue;
      const have = stock.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (have) {
        if (have.unit !== l.unit) continue;
        if (!p.lines.some((x) => x.stockItemId === have.id)) p.lines.push({ stockItemId: have.id, qty: l.qty, label: `${l.qty} ${l.unit}` });
        continue;
      }
      // A new ingredient, or one the name rules already proposed (same name and unit): one stock item either way.
      const key = [...newItems.values()].find((x) => x.unit === l.unit && x.name.toLowerCase() === name.toLowerCase())?.key ?? `new:${l.unit}:${name.toLowerCase()}`;
      if (!newItems.has(key)) newItems.set(key, { key, name, unit: l.unit, packName: (l.packName || 'pack').slice(0, 20), packSize: Math.min(Math.max(1, l.packSize || 1), 100_000) });
      if (!p.lines.some((x) => x.newKey === key)) p.lines.push({ newKey: key, qty: l.qty, label: `${l.qty} ${l.unit}` });
    }
    p.lines = p.lines.slice(0, 20);
    if (!p.lines.length && !p.note) p.note = 'The AI gave no ingredients for this one.';
  });
}

// The menu sections with items still without a recipe, for the Make recipes screen: bar or kitchen by most of their items.
stockRoutes.get(`${B}/stock/recipes/sections`, requireAction('stock.edit'), async (c) => {
  const rows = await all<{ category: string; n: number; bar: number }>(c.env.DB, `SELECT category, count(*) AS n, sum(station = 'bar') AS bar FROM menu_items m
    WHERE business_id = ? AND active = 1 AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = m.id) GROUP BY category ORDER BY category`, c.get('businessId'));
  return c.json({ sections: rows.map((r) => ({ category: r.category, n: r.n, bar: r.bar * 2 >= r.n })) });
});

stockRoutes.post(`${B}/stock/recipes/suggest`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const pours = pourSizes(data);
  const detail = detailOf(data.detail);
  // The menu sections chosen on the screen (all bar items when none are given, as before).
  const cats = Array.isArray(data.categories) ? (data.categories as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200) : null;
  const [menu, stock] = await Promise.all([
    all<{ id: string; name: string; category: string; open_price: number; station: string }>(db, `SELECT id, name, category, open_price, station FROM menu_items m
      WHERE business_id = ? AND active = 1 AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = m.id)
        AND ${cats ? 'category IN (SELECT value FROM json_each(?))' : "station = 'bar' AND ? IS NULL"} ORDER BY category, name`, bid, cats ? JSON.stringify(cats) : null),
    loadStock(db, bid),
  ]);
  const bar = menu.filter((m) => m.station === 'bar');
  const { proposals, newItems } = propose(bar.map((m) => ({ id: m.id, name: m.name, category: m.category, openPrice: !!m.open_price })), stock, pours);
  // Kitchen dishes: no name rules; Claude estimates them (or they wait for a person).
  const dishes: Proposal[] = menu.filter((m) => m.station !== 'bar').map((m) => ({ menuItemId: m.id, menuItem: m.name, category: m.category, kind: 'kitchen', source: 'none', lines: [], note: '', check: true }));
  proposals.push(...dishes);
  proposals.sort((a, b) => (a.category === b.category ? (a.menuItem < b.menuItem ? -1 : 1) : a.category < b.category ? -1 : 1));

  const cocktails = proposals.filter((p) => p.kind === 'cocktail');
  const notes: string[] = [];
  const left: string[] = [];        // what Claude did not do, said once at the end
  let failed: string | null = null;
  const run = async (kind: 'bar' | 'kitchen', group: Proposal[], what: string) => {
    if (!group.length) return;
    if (data.claude !== true || failed) { left.push(what); return; }
    const ask = group.slice(0, MAX_COCKTAILS);
    if (group.length > MAX_COCKTAILS) notes.push(`AI suggestions were made for the first ${MAX_COCKTAILS} ${what}; save those, then press Make recipes again for the rest.`);
    try {
      await fillWithClaude(c.env, ask, stock, promptFor(kind, ask, stock, pours, detail, newItems), newItems);
    } catch (e) {
      if (!(e instanceof OcrError)) throw e;
      failed = e.message;
      left.push(what);
    }
  };
  await run('bar', cocktails, 'cocktails');
  await run('kitchen', dishes, 'kitchen dishes');
  if (left.length) {
    const which = left.join(' and ');
    notes.unshift(failed ? `${failed} The ${which} are left for you: add them by hand, or try AI suggestion on one later.`
      : `The ${which} were not sent for AI suggestions: add them by hand, use AI suggestion on one, or tick “Use AI suggestions”.`);
  }
  const claudeNote = notes.join(' ') || null;
  for (const p of cocktails) if (!p.lines.length && !p.note) p.note = 'A cocktail: add its recipe by hand.';
  for (const p of dishes) if (!p.lines.length && !p.note) p.note = 'A kitchen dish: add its recipe by hand, or use AI suggestion.';
  // Only the new stock items some proposal still uses.
  const used = new Set(proposals.flatMap((p) => p.lines.map((l) => l.newKey)).filter(Boolean));
  return c.json({ pours, proposals, newItems: [...newItems.values()].filter((n) => used.has(n.key)), claudeNote });
});

// One drink to Claude, from the Make recipes screen ("Ask Claude" on a drink the name did not explain). Saves nothing.
stockRoutes.post(`${B}/stock/recipes/ask`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const pours = pourSizes(data);
  const m = await one<{ id: string; name: string; category: string; open_price: number; station: string }>(db,
    "SELECT id, name, category, open_price, station FROM menu_items WHERE id = ? AND business_id = ? AND active = 1", data.menuItemId, bid);
  if (!m) fail(404, 'Drink not found.');
  const stock = await loadStock(db, bid);
  const kitchen = m.station !== 'bar';
  const p: Proposal = { menuItemId: m.id, menuItem: m.name, category: m.category, kind: kitchen ? 'kitchen' : 'cocktail', source: 'claude', lines: [], note: '', check: true };
  const newItems = new Map<string, NewStock>();
  // The screen's own new items, so an ingredient it already proposes is reused rather than proposed twice.
  if (Array.isArray(data.newItems)) for (const n of (data.newItems as Record<string, unknown>[]).slice(0, 500)) {
    if (typeof n.key === 'string' && typeof n.name === 'string' && ['ml', 'pcs', 'g'].includes(n.unit as string)) newItems.set(n.key, { key: n.key, name: n.name, unit: n.unit as NewStock['unit'], packName: String(n.packName ?? 'pack'), packSize: Number(n.packSize) || 1 });
  }
  const before = new Set(newItems.keys());
  try {
    await fillWithClaude(c.env, [p], stock, promptFor(kitchen ? 'kitchen' : 'bar', [p], stock, pours, detailOf(data.detail), newItems), newItems);
  } catch (e) {
    if (!(e instanceof OcrError)) throw e;
    fail(e.status, e.message);
  }
  return c.json({ proposal: p, newItems: [...newItems.values()].filter((n) => !before.has(n.key) && p.lines.some((l) => l.newKey === n.key)) });
});

// The approved proposals: new stock items made first, then each drink's recipe set whole. All or nothing, one audit entry.
stockRoutes.post(`${B}/stock/recipes/apply`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  if (!Array.isArray(data.recipes) || !data.recipes.length || data.recipes.length > 500) fail(400, 'Approve at least one recipe.');
  const rawNew = Array.isArray(data.newItems) ? (data.newItems as Record<string, unknown>[]) : [];
  if (rawNew.length > 500) fail(400, 'Too many new stock items at once.');
  const existing = await all<{ id: string; name: string; unit: string }>(db, 'SELECT id, name, unit FROM stock_items WHERE business_id = ?', bid);
  const t = Date.now();
  const made = new Map<string, string>();      // new key → stock item id
  const creates: ReturnType<typeof stmt>[] = [];
  const createdList: unknown[] = [];
  for (const n of rawNew) {
    if (typeof n.key !== 'string' || !n.key.startsWith('new:')) fail(400, 'A new stock item has no key.');
    const f = itemFields({ name: n.name, unit: n.unit, packName: n.packName, packSize: n.packSize });
    // A stock item with that name already (made since the suggestion): used if it is counted the same way.
    const same = existing.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    if (same) {
      if (same.unit !== f.unit) fail(409, `${same.name} is already a stock item counted in ${same.unit}. Rename the new one.`);
      made.set(n.key, same.id); continue;
    }
    const id = newId();
    made.set(n.key, id);
    existing.push({ id, name: f.name, unit: f.unit });
    creates.push(stmt(db, 'INSERT INTO stock_items (id, business_id, name, unit, pack_name, pack_size, cost_per_pack_paise, reorder_level, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?)',
      id, bid, f.name, f.unit, f.pack_name, f.pack_size, t));
    createdList.push({ id, ...f });
  }
  const menuIds = (data.recipes as Record<string, unknown>[]).map((r) => r?.menuItemId);
  if (new Set(menuIds).size !== menuIds.length) fail(400, 'A drink is in the list twice.');
  const menu = await all<{ id: string; name: string }>(db, 'SELECT id, name FROM menu_items WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))', bid, JSON.stringify(menuIds));
  if (menu.length !== menuIds.length) fail(404, 'A drink was not found. Make the recipes again.');
  const sets: { menuItemId: string; lines: { stockItemId: string; qty: number }[] }[] = [];
  for (const r of data.recipes as Record<string, unknown>[]) {
    const name = menu.find((m) => m.id === r.menuItemId)!.name;
    if (!Array.isArray(r.lines) || !r.lines.length || r.lines.length > 20) fail(400, `${name}: a recipe is 1 to 20 stock items.`);
    const lines: { stockItemId: string; qty: number }[] = [];
    for (const raw of r.lines as Record<string, unknown>[]) {
      const sid = typeof raw.newKey === 'string' ? made.get(raw.newKey) : existing.find((x) => x.id === raw.stockItemId)?.id;
      if (!sid) fail(400, `${name}: a stock item was not found.`);
      if (lines.some((l) => l.stockItemId === sid)) fail(400, `${name}: the same stock item twice.`);
      lines.push({ stockItemId: sid, qty: whole(raw.qty, `${name}: quantity`) });
    }
    sets.push({ menuItemId: r.menuItemId as string, lines });
  }
  await db.batch([
    ...creates,
    ...sets.flatMap((s) => [
      stmt(db, 'DELETE FROM recipes WHERE menu_item_id = ?', s.menuItemId),
      ...s.lines.map((l) => stmt(db, 'INSERT INTO recipes (menu_item_id, stock_item_id, business_id, qty) VALUES (?, ?, ?, ?)', s.menuItemId, l.stockItemId, bid, l.qty)),
    ]),
    audit(db, bid, c.get('staff').id, 'recipe.auto', 'recipes', `${sets.length} drinks`, null, { stockItemsCreated: createdList, recipes: sets }),
  ]);
  // made: each new item's key → the stock item it became, so the screen points other drinks at it.
  return c.json({ ok: true, recipes: sets.length, stockItemsCreated: createdList.length, made: Object.fromEntries(made) });
});

// Goods received into a store, with the vendor's invoice: quantities in packs, price per pack (it becomes the item's last price).
stockRoutes.post(`${B}/stock/purchases`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const s = await store(db, bid, data.storeId);
  // Opening stock (22 Nov 2026): what is on the shelf when stock-keeping starts, at its price; not a purchase, so it is
  // left out of spend and of count variances.
  const opening = data.opening === true;
  if (opening && data.billId) fail(400, 'Opening stock is not received against a supplier bill.');
  const vendor = opening ? 'Opening stock' : text(data, 'vendor', 'Vendor', { max: 80 })!;
  if (!opening && vendor.toLowerCase() === 'opening stock') fail(400, 'Use the Opening stock tick for opening stock.');
  const invoice = opening ? null : text(data, 'invoiceNo', 'Invoice number', { optional: true, max: 40 });
  if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 50) fail(400, 'Add what was received.');
  const { t, shiftDay } = clock(bizOf(c));
  const statements = [];
  // A bill photo read earlier: the goods are received against it, once.
  let billId: string | null = null;
  if (data.billId !== undefined && data.billId !== null) {
    const pb = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM purchase_bills WHERE id = ? AND business_id = ?', data.billId, bid);
    if (!pb) fail(400, 'That bill photo was not found.');
    if (pb.status === 'received') fail(409, 'The goods on this bill were already received.');
    billId = pb.id;
    statements.push(stmt(db, "UPDATE purchase_bills SET status = 'received', vendor = ?, invoice_no = ?, received_at = ? WHERE id = ? AND status = 'draft'", vendor, invoice, t, billId));
  }
  for (const raw of data.lines) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const i = await item(db, bid, r.itemId);
    const packs = whole(r.packs, `Packs of ${i.name}`, 1, 100000);
    const cost = optionalPaise(r, 'costPerPack', `Price per pack of ${i.name}`);
    statements.push(stmt(db, `INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, cost_per_pack_paise, ref, vendor, by_staff, shift_day, at, bill_id)
      VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), bid, i.id, s.id, packs * i.pack_size, cost, invoice, vendor, c.get('staff').id, shiftDay, t, billId));
    if (cost !== null) statements.push(stmt(db, 'UPDATE stock_items SET cost_per_pack_paise = ? WHERE id = ?', cost, i.id));
  }
  await db.batch(statements);
  return c.json({ ok: true }, 201);
});

// ---------- supplier bill photos, read by Claude

const BillReading = z.object({
  vendor: z.string().nullable(),
  invoiceNo: z.string().nullable(),
  billDate: z.string().nullable(),
  totalRupees: z.number().nullable(),
  lines: z.array(z.object({
    description: z.string(),
    stockItemId: z.string().nullable(),
    packs: z.number().nullable(),
    pricePerPackRupees: z.number().nullable(),
    lineTotalRupees: z.number().nullable(),
  })),
});
const MAX_PHOTO = 5 * 1024 * 1024;

function billInstructions(items: { id: string; name: string; unit: string; pack_name: string; pack_size: number }[]) {
  return `This is a photo of a supplier's bill (tax invoice or delivery bill) for a restaurant and bar in India.
Read it and return:
- vendor: the supplier's name as printed; invoiceNo: the bill or invoice number; billDate: the bill date as YYYY-MM-DD.
- totalRupees: the bill's grand total in rupees.
- lines: one entry per item row on the bill, in order. description = the item as printed (name, size, brand).
  packs = how many packs were bought, counted in the pack of the matched stock item below (for example bottles or cases).
  If the bill counts in a different unit (cases against bottles), convert to the stock item's pack; if unsure, use null.
  pricePerPackRupees = what was paid for one such pack including the tax shown on the bill, so packs x price is the real cost.
  lineTotalRupees = the row's amount as printed.
  stockItemId = the id of the matching stock item below, only when you are confident it is the same product and size; otherwise null.
Use null for anything you cannot read clearly. Never guess a number.

The restaurant's stock items (id | name | counted in | pack):
${items.map((i) => `${i.id} | ${i.name} | ${i.unit} | ${i.pack_name} of ${i.pack_size} ${i.unit}`).join('\n') || '(none yet)'}`;
}

// A photo of a supplier's bill (JPEG or PNG, sent as the request body): kept, then read by Claude into a draft to check.
// When Claude is not set up or cannot read it, the photo is still kept and the person types the lines in.
stockRoutes.post(`${B}/stock/bills`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  if (!c.env.BILLS) fail(503, 'Bill photos are not set up on the server yet (no BILLS storage). Type the bill in below.');
  const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim();
  if (type !== 'image/jpeg' && type !== 'image/png') fail(400, 'Send the bill as a JPEG or PNG photo.');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) fail(400, 'The photo is empty.');
  if (bytes.length > MAX_PHOTO) fail(400, 'The photo is larger than 5 MB. Take it again at a lower resolution.');
  const id = newId();
  const t = Date.now();
  const key = `pos/${bid}/bills/${id}.${type === 'image/png' ? 'png' : 'jpg'}`;
  await c.env.BILLS.put(key, bytes, { httpMetadata: { contentType: type } });

  // Cost guard: at most N readings per business per day (default 30).
  const limit = Number(c.env.BILL_READS_PER_DAY) || 30;
  const today = await one<{ n: number }>(db, 'SELECT count(*) AS n FROM purchase_bills WHERE business_id = ? AND read_model IS NOT NULL AND created_at > ?', bid, t - 86_400_000);
  let read: z.infer<typeof BillReading> | null = null;
  let model: string | null = null;
  let error: string | null = null;
  if (today!.n >= limit) error = `Today's limit of ${limit} bill readings is used up. Type this bill in; the photo is kept.`;
  else {
    const items = await all<{ id: string; name: string; unit: string; pack_name: string; pack_size: number }>(db,
      'SELECT id, name, unit, pack_name, pack_size FROM stock_items WHERE business_id = ? AND active = 1 ORDER BY name', bid);
    try {
      const r = await readWithClaude(c.env, { bytes, mediaType: type }, billInstructions(items), BillReading);
      read = r.data;
      model = r.model;
      // Keep only matches to this business's own items.
      const ids = new Set(items.map((i) => i.id));
      for (const l of read.lines) if (l.stockItemId && !ids.has(l.stockItemId)) l.stockItemId = null;
    } catch (e) {
      if (!(e instanceof OcrError)) throw e;
      error = e.message;
    }
  }
  await stmt(db, `INSERT INTO purchase_bills (id, business_id, photo_key, read_json, read_model, read_error, vendor, invoice_no, by_staff, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, key, read ? JSON.stringify(read) : null, model, error, read?.vendor ?? null, read?.invoiceNo ?? null, c.get('staff').id, t).run();
  return c.json({ billId: id, read, error }, 201);
});

// The photo itself, for checking against what was read (only to people who handle stock).
stockRoutes.get(`${B}/stock/bills/:id/photo`, requireAction('stock.edit'), async (c) => {
  const pb = await one<{ photo_key: string | null }>(c.env.DB, 'SELECT photo_key FROM purchase_bills WHERE id = ? AND business_id = ?', c.req.param('id'), c.get('businessId'));
  if (!pb?.photo_key || !c.env.BILLS) fail(404, 'Photo not found.');
  const obj = await c.env.BILLS.get(pb.photo_key);
  if (!obj) fail(404, 'Photo not found.');
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
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

/**
 * The first stock of an item in a store (27 Nov 2026): a count of an item that never had stock in there before (no purchase,
 * opening stock, transfer in or count) puts what is on the shelf in as its opening stock, not as stock found extra.
 */
export async function firstStockIn(db: DB, bid: string, itemId: string, storeId: string, before: number) {
  return !(await one(db, `SELECT 1 AS x FROM stock_moves WHERE business_id = ? AND item_id = ? AND store_id = ? AND kind IN ('purchase', 'transfer_in', 'count') AND at < ? LIMIT 1`,
    bid, itemId, storeId, before));
}
/** The stock move for one counted item: opening stock on its first count, else the difference from the book. */
export function countMove(db: DB, x: { bid: string; itemId: string; storeId: string; diff: number; counted: number; ref: string | null; by: string; shiftDay: string; at: number; opening: boolean }) {
  return x.opening
    ? stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, counted_qty, ref, vendor, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, 'Opening stock', ?, ?, ?)",
      newId(), x.bid, x.itemId, x.storeId, x.diff, x.counted, x.ref ?? 'First count', x.by, x.shiftDay, x.at)
    : stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, counted_qty, ref, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'count', ?, ?, ?, ?, ?, ?)",
      newId(), x.bid, x.itemId, x.storeId, x.diff, x.counted, x.ref, x.by, x.shiftDay, x.at);
}

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
    const opening = diff > 0 && await firstStockIn(db, bid, i.id, s.id, t);
    result.push({ name: i.name, unit: i.unit, book, counted, variance: opening ? 0 : diff, opening, valuePaise: opening ? 0 : Math.round((diff * i.cost_per_pack_paise) / i.pack_size) });
    if (diff === 0) continue;
    statements.push(countMove(db, { bid, itemId: i.id, storeId: s.id, diff, counted, ref: null, by: c.get('staff').id, shiftDay, at: t, opening }));
    if (!opening) statements.push(event(db, bid, 'stock_count', `${i.name} · ${s.name}`, Math.round((diff * i.cost_per_pack_paise) / i.pack_size), null,
      `Book ${book} ${i.unit}, counted ${counted} ${i.unit} (${diff > 0 ? '+' : ''}${diff})`, c.get('staff').id, shiftDay));
  }
  // One summary line per count, even when everything agrees: it marks the handover time (Stock, Bar handover).
  const differ = result.filter((l) => l.variance !== 0);
  statements.push(event(db, bid, 'stock_count', `Count · ${s.name}`, differ.reduce((t, l) => t + l.valuePaise, 0), 'Count',
    `${result.length} item${result.length === 1 ? '' : 's'} counted, ${differ.length ? `${differ.length} differ` : 'all agree'}`, c.get('staff').id, shiftDay));
  await db.batch(statements);
  return c.json({ lines: result }, 201);
});

// Each count of a store, as a handover: what was missing (or extra) at that count, the breakage since the count before,
// and who billed that store's station items in between, so missing stock can be put to the shift it went missing in.
stockRoutes.get(`${B}/stock/handovers`, requireAction('stock.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const from = date({ d: c.req.query('from') ?? '' }, 'd', 'From');
  const to = date({ d: c.req.query('to') ?? '' }, 'd', 'To');
  if (from > to) fail(400, 'From must be on or before To.');
  const s = await store(db, bid, c.req.query('storeId'));
  const counts = await all<{ at: number; by_name: string | null; detail: string; shift_day: string }>(db, `SELECT e.at, st.name AS by_name, e.detail, e.shift_day FROM pos_events e
    LEFT JOIN staff st ON st.id = e.by_staff WHERE e.business_id = ? AND e.kind = 'stock_count' AND e.reason = 'Count' AND e.ref = ? AND e.shift_day <= ? ORDER BY e.at`,
    bid, `Count · ${s.name}`, to);
  const out = [];
  for (let n = 0; n < counts.length; n++) {
    const k = counts[n];
    if (k.shift_day < from) continue;
    const since = n > 0 ? counts[n - 1].at : 0;
    const [diff, waste, sales] = await Promise.all([
      one<{ missing: number; extra: number }>(db, `SELECT
          coalesce(sum(CASE WHEN m.qty < 0 THEN -m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS missing,
          coalesce(sum(CASE WHEN m.qty > 0 THEN m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size END), 0) AS extra
        FROM stock_moves m JOIN stock_items i ON i.id = m.item_id WHERE m.business_id = ? AND m.store_id = ? AND m.kind = 'count' AND m.at > ? AND m.at <= ?`, bid, s.id, since, k.at),
      one<{ v: number }>(db, `SELECT coalesce(sum(-m.qty * i.cost_per_pack_paise * 1.0 / i.pack_size), 0) AS v FROM stock_moves m JOIN stock_items i ON i.id = m.item_id
        WHERE m.business_id = ? AND m.store_id = ? AND m.kind = 'waste' AND m.at > ? AND m.at <= ?`, bid, s.id, since, k.at),
      s.kind === 'bar' || s.kind === 'kitchen' ? all<{ name: string | null; paise: number }>(db, `SELECT st.name, sum(l.amount_paise) AS paise FROM bill_lines l
          JOIN bills b ON b.id = l.bill_id JOIN menu_items mi ON mi.id = l.item_id LEFT JOIN staff st ON st.id = b.printed_by
          WHERE b.business_id = ? AND b.status <> 'void' AND b.printed_at > ? AND b.printed_at <= ? AND mi.station = ? GROUP BY b.printed_by ORDER BY paise DESC`,
        bid, since, k.at, s.kind) : Promise.resolve([]),
    ]);
    out.push({ at: k.at, shiftDay: k.shift_day, byName: k.by_name, detail: k.detail, sinceAt: since || null,
      missingPaise: Math.round(diff!.missing), extraPaise: Math.round(diff!.extra), wastePaise: Math.round(waste!.v),
      billedBy: sales.map((x) => ({ name: x.name ?? 'Unknown', paise: x.paise })) });
  }
  return c.json({ store: s, from, to, counts: out.reverse() });
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
  const items = rows.map((r) => {
    const closing = r.opening + r.purchase + r.transfer_in + r.transfer_out + r.sale + r.waste + r.count;
    const v = (q: number) => Math.round((q * r.cost_per_pack_paise) / r.pack_size);
    return { id: r.id, name: r.name, unit: r.unit, opening: r.opening, received: r.purchase, transferIn: r.transfer_in, transferOut: -r.transfer_out, sold: -r.sale,
      waste: -r.waste, variance: r.count, closing, closingValuePaise: v(Math.max(0, closing)), varianceValuePaise: v(r.count), wasteValuePaise: v(-r.waste),
      soldValuePaise: v(-r.sale) };
  }).filter((x) => x.opening || x.received || x.transferIn || x.transferOut || x.sold || x.waste || x.variance || x.closing);
  // Cost against sales, for a bar or kitchen store: what its station's dishes sold for (before bill discounts and GST, void bills
  // left out), against the cost of what the recipes used (expected) and of what actually went (recipes + breakage + count shortfall).
  // Costs are at the last price paid.
  let cost = null;
  if (s.kind === 'bar' || s.kind === 'kitchen') {
    const sales = await one<{ p: number }>(db, `SELECT coalesce(sum(l.amount_paise), 0) AS p FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      JOIN menu_items m ON m.id = l.item_id WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ? AND b.status <> 'void' AND m.station = ?`, bid, from, to, s.kind);
    const sum = (k: 'soldValuePaise' | 'wasteValuePaise' | 'varianceValuePaise') => items.reduce((t, i) => t + i[k], 0);
    const expected = sum('soldValuePaise');
    const actual = expected + sum('wasteValuePaise') - sum('varianceValuePaise');
    cost = { salesPaise: sales!.p, expectedCostPaise: expected, wastePaise: sum('wasteValuePaise'), missingPaise: -sum('varianceValuePaise'), actualCostPaise: actual };
  }
  return c.json({ from, to, store: s, items, cost });
});
