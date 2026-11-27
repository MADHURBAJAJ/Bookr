// Bar and kitchen counts with a manager's approval (27 Nov 2026). A count list (Settings) picks the items, by category; the
// sheet prints them with what is in hand; the count is typed from the paper after the shift (compared with the stock at the
// time it was counted) or live (each row compared with the stock when it is typed). Each item can be found in two places
// (the bar counter and the store). Stock changes only when a manager approves; then each difference is a count move at
// the counted time, and shows on the Bar handover report.
import { Hono, type Context } from 'hono';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../../../src/db';
import { body, fail, isUuid, text } from '../../../src/http';
import { isManager, requireAction, requireStaff } from '../auth';
import { audit, bizOf, clock, event } from '../util';
import type { AppEnv } from '../types';

export const stockCountRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
stockCountRoutes.use(`${B}/*`, requireStaff);

type Item = { id: string; name: string; unit: string; packName: string; packSize: number; category: string | null; costPerPackPaise: number };
type List = { id: string; store_id: string; name: string; categories: string; off_items: string; on_items: string };
const NONE = 'No category';

const ids = (v: unknown, label: string) => {
  if (!Array.isArray(v) || v.length > 500 || v.some((x) => typeof x !== 'string' || x.length > 40)) fail(400, `${label}: a list, please.`);
  return [...new Set(v as string[])];
};
async function storeOf(db: DB, bid: string, id: unknown) {
  const s = await one<{ id: string; name: string; kind: string }>(db, 'SELECT id, name, kind FROM stock_stores WHERE id = ? AND business_id = ?', typeof id === 'string' ? id : '', bid);
  if (!s) fail(400, 'Choose a store.');
  return s;
}
async function listOf(db: DB, bid: string, id: unknown) {
  if (typeof id !== 'string' || !isUuid(id)) fail(404, 'Count list not found.');
  const l = await one<List>(db, 'SELECT id, store_id, name, categories, off_items, on_items FROM count_lists WHERE id = ? AND business_id = ?', id, bid);
  if (!l) fail(404, 'Count list not found.');
  return l;
}
async function itemsAll(db: DB, bid: string) {
  return all<Item>(db, `SELECT id, name, unit, pack_name AS packName, pack_size AS packSize, category, cost_per_pack_paise AS costPerPackPaise
    FROM stock_items WHERE business_id = ? AND active = 1 ORDER BY lower(name)`, bid);
}
/** The items on a list, grouped by category in the list's order (A to Z inside), single items under their own category. */
function groupsOf(list: List, items: Item[]) {
  const cats = JSON.parse(list.categories) as string[];
  const off = new Set(JSON.parse(list.off_items) as string[]);
  const on = new Set(JSON.parse(list.on_items) as string[]);
  const mine = items.filter((i) => (cats.includes(i.category ?? NONE) && !off.has(i.id)) || on.has(i.id));
  const order = [...cats, ...[...new Set(mine.map((i) => i.category ?? NONE))].filter((c) => !cats.includes(c)).sort()];
  return order.map((c) => ({ category: c, items: mine.filter((i) => (i.category ?? NONE) === c) })).filter((g) => g.items.length);
}
/** What a store held of each item at a moment (every move up to then). */
async function inHandAt(db: DB, bid: string, storeId: string, t: number) {
  const rows = await all<{ item_id: string; q: number }>(db, 'SELECT item_id, sum(qty) AS q FROM stock_moves WHERE business_id = ? AND store_id = ? AND at <= ? GROUP BY item_id', bid, storeId, t);
  return new Map(rows.map((r) => [r.item_id, r.q]));
}

// ---------- count lists (Settings): managers and owners

stockCountRoutes.get(`${B}/stock/count-lists`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  const lists = await all<List>(c.env.DB, 'SELECT id, store_id, name, categories, off_items, on_items FROM count_lists WHERE business_id = ? ORDER BY created_at', bid);
  const items = await itemsAll(c.env.DB, bid);
  return c.json({
    lists: lists.map((l) => ({ id: l.id, storeId: l.store_id, name: l.name, categories: JSON.parse(l.categories), offItems: JSON.parse(l.off_items), onItems: JSON.parse(l.on_items),
      count: groupsOf(l, items).reduce((n, g) => n + g.items.length, 0) })),
    categories: [...new Set(items.map((i) => i.category ?? NONE))].sort((a, b) => (a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b))),
    items: items.map((i) => ({ id: i.id, name: i.name, category: i.category ?? NONE, unit: i.unit, packName: i.packName, packSize: i.packSize })),
  });
});

async function saveList(c: Context<AppEnv>, id: string | null) {
  if (!isManager(c)) fail(403, 'Count lists are set by a manager or owner.');
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const s = await storeOf(db, bid, data.storeId);
  const f = { name: text(data, 'name', 'List name', { max: 40 })!, categories: ids(data.categories ?? [], 'Categories'), offItems: ids(data.offItems ?? [], 'Items taken off'),
    onItems: ids(data.onItems ?? [], 'Items added') };
  const lid = id ?? newId();
  try {
    await db.batch([
      id ? stmt(db, 'UPDATE count_lists SET store_id = ?, name = ?, categories = ?, off_items = ?, on_items = ? WHERE id = ? AND business_id = ?',
          s.id, f.name, JSON.stringify(f.categories), JSON.stringify(f.offItems), JSON.stringify(f.onItems), id, bid)
        : stmt(db, 'INSERT INTO count_lists (id, business_id, store_id, name, categories, off_items, on_items, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          lid, bid, s.id, f.name, JSON.stringify(f.categories), JSON.stringify(f.offItems), JSON.stringify(f.onItems), now()),
      audit(db, bid, c.get('staff').id, id ? 'count_list.update' : 'count_list.create', 'count_lists', lid, null, { storeId: s.id, ...f }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'There is already a count list with that name.');
    throw e;
  }
  return c.json({ id: lid }, id ? 200 : 201);
}
stockCountRoutes.post(`${B}/stock/count-lists`, requireAction('stock.count'), (c) => saveList(c, null));
stockCountRoutes.put(`${B}/stock/count-lists/:id`, requireAction('stock.count'), async (c) => { await listOf(c.env.DB, c.get('businessId'), c.req.param('id')); return saveList(c, c.req.param('id')); });

// ---------- the sheet to print: the list's items by category, with what is in hand now

stockCountRoutes.get(`${B}/stock/count-lists/:id/sheet`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const l = await listOf(db, bid, c.req.param('id'));
  const s = await storeOf(db, bid, l.store_id);
  const t = now();
  const hand = await inHandAt(db, bid, s.id, t);
  return c.json({ list: { id: l.id, name: l.name }, store: s, at: t,
    groups: groupsOf(l, await itemsAll(db, bid)).map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, inHand: hand.get(i.id) ?? 0 })) })) });
});

// ---------- counts

type CountRow = { id: string; store_id: string; list_id: string | null; mode: string; counted_at: number | null; status: string; by_staff: string | null; sent_at: number | null;
  decided_by: string | null; decided_at: number | null; note: string | null; created_at: number };
async function countOf(db: DB, bid: string, id: string) {
  if (!isUuid(id)) fail(404, 'Count not found.');
  const k = await one<CountRow>(db, 'SELECT * FROM stock_counts WHERE id = ? AND business_id = ?', id, bid);
  if (!k) fail(404, 'Count not found.');
  return k;
}

/** A count with its rows: each item's count at both places, and what was in hand at its time (the counted time, or when typed live). */
async function countOut(db: DB, bid: string, k: CountRow) {
  const s = await storeOf(db, bid, k.store_id);
  const items = await itemsAll(db, bid);
  const lines = await all<{ item_id: string; place1: number; place2: number; at: number; recount: number }>(db,
    'SELECT item_id, place1, place2, at, recount FROM stock_count_lines WHERE count_id = ?', k.id);
  const l = k.list_id ? await one<List>(db, 'SELECT id, store_id, name, categories, off_items, on_items FROM count_lists WHERE id = ?', k.list_id) : null;
  // The list's items, and any item counted that has since left the list.
  const listed = l ? groupsOf(l, items) : [];
  const extra = items.filter((i) => lines.some((x) => x.item_id === i.id) && !listed.some((g) => g.items.some((y) => y.id === i.id)));
  const groups = extra.length ? [...listed, ...groupsOf({ id: '', store_id: k.store_id, name: '', categories: '[]', off_items: '[]', on_items: JSON.stringify(extra.map((i) => i.id)) }, items)] : listed;
  const t = now();
  const at = new Map<number, Map<string, number>>();
  const handAt = async (ts: number) => { if (!at.has(ts)) at.set(ts, await inHandAt(db, bid, s.id, ts)); return at.get(ts)!; };
  const names = await all<{ id: string; name: string }>(db, 'SELECT id, name FROM staff WHERE id IN (?, ?)', k.by_staff, k.decided_by);
  const out = [];
  for (const g of groups) {
    const rows = [];
    for (const i of g.items) {
      const x = lines.find((y) => y.item_id === i.id);
      const when = k.mode === 'after_shift' ? (k.counted_at ?? t) : x ? x.at : t;
      const inHand = (await handAt(when)).get(i.id) ?? 0;
      const counted = x ? x.place1 + x.place2 : null;
      rows.push({ ...i, inHand, place1: x?.place1 ?? null, place2: x?.place2 ?? null, counted, diff: counted === null ? null : counted - inHand,
        valuePaise: counted === null ? 0 : Math.round(((counted - inHand) * i.costPerPackPaise) / i.packSize), at: x?.at ?? null, recount: !!x?.recount });
    }
    out.push({ category: g.category, items: rows });
  }
  const who = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
  return { count: { id: k.id, storeId: s.id, store: s.name, listId: k.list_id, list: l?.name ?? null, mode: k.mode, countedAt: k.counted_at, status: k.status,
      by: who(k.by_staff), sentAt: k.sent_at, decidedBy: who(k.decided_by), decidedAt: k.decided_at, note: k.note, createdAt: k.created_at }, groups: out };
}

stockCountRoutes.get(`${B}/stock/count-sessions`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  const rows = await all(c.env.DB, `SELECT k.id, k.mode, k.status, k.counted_at AS countedAt, k.sent_at AS sentAt, k.decided_at AS decidedAt, k.created_at AS createdAt,
      s.name AS store, l.name AS list, st.name AS byName, (SELECT count(*) FROM stock_count_lines x WHERE x.count_id = k.id) AS rows
    FROM stock_counts k JOIN stock_stores s ON s.id = k.store_id LEFT JOIN count_lists l ON l.id = k.list_id LEFT JOIN staff st ON st.id = k.by_staff
    WHERE k.business_id = ? AND (k.status IN ('draft', 'waiting', 'sent_back') OR k.created_at > ?) AND k.status <> 'dropped' ORDER BY k.created_at DESC LIMIT 50`, bid, now() - 14 * 86_400_000);
  return c.json({ counts: rows });
});

stockCountRoutes.post(`${B}/stock/count-sessions`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const l = await listOf(db, bid, data.listId);
  const mode = data.mode === 'live' ? 'live' : data.mode === 'after_shift' ? 'after_shift' : fail(400, 'Choose after shift or live.');
  const id = newId();
  const t = now();
  await db.batch([
    stmt(db, 'INSERT INTO stock_counts (id, business_id, store_id, list_id, mode, counted_at, by_staff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, bid, l.store_id, l.id, mode, null, c.get('staff').id, t),
  ]);
  return c.json({ id }, 201);
});

stockCountRoutes.get(`${B}/stock/count-sessions/:id`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  return c.json(await countOut(c.env.DB, bid, await countOf(c.env.DB, bid, c.req.param('id'))));
});

const units = (v: unknown, label: string) => {
  const n = v === null || v === undefined || v === '' ? 0 : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) fail(400, `${label}: a whole number, 0 or more.`);
  return n;
};

// Saving what was typed (any time before it is sent, or after it is sent back). Rows left blank are not counted.
stockCountRoutes.put(`${B}/stock/count-sessions/:id`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const k = await countOf(db, bid, c.req.param('id'));
  if (k.status !== 'draft' && k.status !== 'sent_back') fail(409, k.status === 'waiting' ? 'This count is with the manager.' : 'This count is closed.');
  const data = await body(c);
  const t = now();
  let countedAt = k.counted_at;
  if (k.mode === 'after_shift' && data.countedAt !== undefined) {
    const v = Number(data.countedAt);
    if (!Number.isFinite(v) || v > t + 60_000 || v < t - 3 * 86_400_000) fail(400, 'The counted time must be in the last 3 days, not later than now.');
    countedAt = Math.round(v);
  }
  const lines = Array.isArray(data.lines) ? (data.lines as Record<string, unknown>[]).slice(0, 500) : [];
  const items = await itemsAll(db, bid);
  const have = await all<{ item_id: string; place1: number; place2: number }>(db, 'SELECT item_id, place1, place2 FROM stock_count_lines WHERE count_id = ?', k.id);
  const st = [stmt(db, 'UPDATE stock_counts SET counted_at = ? WHERE id = ?', countedAt, k.id)];
  for (const raw of lines) {
    const i = items.find((x) => x.id === raw.itemId);
    if (!i) fail(400, 'A counted item is not a stock item.');
    if (raw.clear === true) { st.push(stmt(db, 'DELETE FROM stock_count_lines WHERE count_id = ? AND item_id = ?', k.id, i.id)); continue; }
    const p1 = units(raw.place1, `${i.name}, bar counter`);
    const p2 = units(raw.place2, `${i.name}, other place`);
    const old = have.find((x) => x.item_id === i.id);
    if (old && old.place1 === p1 && old.place2 === p2) continue;
    // Live: the row is compared with the stock at the moment it was typed (or typed again).
    st.push(stmt(db, `INSERT INTO stock_count_lines (count_id, item_id, business_id, place1, place2, at, recount) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT (count_id, item_id) DO UPDATE SET place1 = excluded.place1, place2 = excluded.place2, at = excluded.at, recount = 0`, k.id, i.id, bid, p1, p2, t));
  }
  await db.batch(st);
  return c.json(await countOut(db, bid, await countOf(db, bid, k.id)));
});

stockCountRoutes.post(`${B}/stock/count-sessions/:id/send`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const k = await countOf(db, bid, c.req.param('id'));
  if (k.status !== 'draft' && k.status !== 'sent_back') fail(409, 'This count is already with the manager or closed.');
  if (k.mode === 'after_shift' && !k.counted_at) fail(400, 'Type the time it was counted.');
  const n = (await one<{ n: number }>(db, 'SELECT count(*) AS n FROM stock_count_lines WHERE count_id = ?', k.id))!.n;
  if (!n) fail(400, 'Nothing is counted yet.');
  await db.batch([stmt(db, "UPDATE stock_counts SET status = 'waiting', sent_at = ? WHERE id = ?", now(), k.id),
    audit(db, bid, c.get('staff').id, 'stock_count.send', 'stock_counts', k.id, null, { rows: n })]);
  return c.json({ ok: true });
});

stockCountRoutes.post(`${B}/stock/count-sessions/:id/drop`, requireAction('stock.count'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const k = await countOf(db, bid, c.req.param('id'));
  if (k.status === 'approved' || k.status === 'dropped') fail(409, 'This count is closed.');
  if (k.status === 'waiting' && !isManager(c)) fail(403, 'This count is with the manager.');
  await db.batch([stmt(db, "UPDATE stock_counts SET status = 'dropped', decided_by = ?, decided_at = ? WHERE id = ?", c.get('staff').id, now(), k.id),
    audit(db, bid, c.get('staff').id, 'stock_count.drop', 'stock_counts', k.id, null, null)]);
  return c.json({ ok: true });
});

// The manager sends rows back to be counted again.
stockCountRoutes.post(`${B}/stock/count-sessions/:id/back`, requireAction('stock.count'), async (c) => {
  if (!isManager(c)) fail(403, 'A manager or owner checks counts.');
  const bid = c.get('businessId');
  const db = c.env.DB;
  const k = await countOf(db, bid, c.req.param('id'));
  if (k.status !== 'waiting') fail(409, 'Only a count waiting for you can be sent back.');
  const data = await body(c);
  const items = ids(data.itemIds ?? [], 'Rows to count again');
  const note = text(data, 'note', 'Note', { optional: true, max: 200 }) ?? null;
  await db.batch([
    stmt(db, "UPDATE stock_counts SET status = 'sent_back', note = ? WHERE id = ?", note, k.id),
    ...items.map((i) => stmt(db, 'UPDATE stock_count_lines SET recount = 1 WHERE count_id = ? AND item_id = ?', k.id, i)),
    audit(db, bid, c.get('staff').id, 'stock_count.back', 'stock_counts', k.id, null, { itemIds: items, note }),
  ]);
  return c.json({ ok: true });
});

// The manager approves: each counted item's stock becomes the count, at the time it was counted.
stockCountRoutes.post(`${B}/stock/count-sessions/:id/approve`, requireAction('stock.count'), async (c) => {
  if (!isManager(c)) fail(403, 'A manager or owner approves counts.');
  const bid = c.get('businessId');
  const db = c.env.DB;
  const k = await countOf(db, bid, c.req.param('id'));
  if (k.status !== 'waiting') fail(409, 'Only a count waiting for you can be approved.');
  const { groups, count } = await countOut(db, bid, k);
  const b = bizOf(c);
  const staff = c.get('staff').id;
  const st = [];
  const rows = groups.flatMap((g) => g.items).filter((r) => r.counted !== null);
  for (const r of rows) {
    if (!r.diff) continue;
    const when = k.mode === 'after_shift' ? k.counted_at! : r.at!;
    st.push(stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, counted_qty, ref, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'count', ?, ?, ?, ?, ?, ?)",
      newId(), bid, r.id, k.store_id, r.diff, r.counted, `count ${k.id}`, k.by_staff ?? staff, clock(b, when).shiftDay, when));
  }
  const differ = rows.filter((r) => r.diff);
  const { shiftDay } = clock(b);
  st.push(
    stmt(db, "UPDATE stock_counts SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", staff, now(), k.id),
    // One summary line per count (Stock › Bar handover), as for a count saved straight away.
    event(db, bid, 'stock_count', `Count · ${count.store}`, differ.reduce((t, r) => t + r.valuePaise, 0), 'Count',
      `${rows.length} item${rows.length === 1 ? '' : 's'} counted, ${differ.length ? `${differ.length} differ` : 'all agree'} · approved`, k.by_staff ?? staff, shiftDay),
    audit(db, bid, staff, 'stock_count.approve', 'stock_counts', k.id, null, { rows: rows.length, differ: differ.length }),
  );
  await db.batch(st);
  return c.json({ ok: true, rows: rows.length, differ: differ.length });
});
