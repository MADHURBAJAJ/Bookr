// Stock used by what is sold (24 Nov 2026: at the KOT, not at payment). Each dish's recipe comes out of the store that
// matches its station (bar or kitchen) when it is sent to the kitchen or bar, or when a no-KOT item is added. Cancelled
// before it is made: it goes back. Cancelled after it is made: it is wastage, with the reason. Payment moves no stock.
// Orders opened before the change keep the old rule (stock at payment), so nothing is counted twice or missed.
import { all, newId, stmt, type DB } from '../../src/db';

/** Orders opened from this time take stock at the KOT; older ones at payment. Tests set it to 0. */
export const stockRule = { kotFrom: Date.parse('2026-11-25T02:30:00Z') };   // 25 Nov, 8 am India time: the shift start
export const stockAtKot = (openedAt: number) => openedAt >= stockRule.kotFrom;

const storesOf = (db: DB, bid: string) => all<{ id: string; kind: string }>(db, 'SELECT id, kind FROM stock_stores WHERE business_id = ? ORDER BY created_at', bid);
const storeFor = (stores: { id: string; kind: string }[], station: string) => stores.find((s) => s.kind === station) ?? stores.find((s) => s.kind === 'main');

/**
 * Stock moves for dishes: `qty` is how many of the dish, positive when used, negative when it goes back. kind 'waste'
 * (made, then cancelled) needs a reason. Returned as statements for the caller's batch.
 */
export async function dishMoves(db: DB, bid: string, uses: { itemId: string; station: string; qty: number }[], kind: 'sale' | 'waste', ref: string,
  reason: string | null, staffId: string, shiftDay: string, t: number): Promise<D1PreparedStatement[]> {
  const live = uses.filter((u) => u.qty !== 0);
  if (!live.length) return [];
  const recipes = await all<{ menu_item_id: string; stock_item_id: string; qty: number }>(db,
    `SELECT menu_item_id, stock_item_id, qty FROM recipes WHERE menu_item_id IN (SELECT value FROM json_each(?))`, JSON.stringify([...new Set(live.map((u) => u.itemId))]));
  if (!recipes.length) return [];
  const stores = await storesOf(db, bid);
  const sum = new Map<string, { item: string; store: string; qty: number }>();
  for (const u of live) {
    const store = storeFor(stores, u.station);
    if (!store) continue;
    for (const r of recipes.filter((x) => x.menu_item_id === u.itemId)) {
      const key = `${r.stock_item_id}|${store.id}`;
      const cur = sum.get(key) ?? { item: r.stock_item_id, store: store.id, qty: 0 };
      cur.qty -= u.qty * r.qty;
      sum.set(key, cur);
    }
  }
  return [...sum.values()].filter((m) => m.qty !== 0).map((m) => stmt(db,
    'INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, ref, reason, by_staff, shift_day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId(), bid, m.item, m.store, kind, m.qty, ref.slice(0, 80), reason, staffId, shiftDay, t));
}

/** A dish cancelled after it was sent: back to stock when not made; when made, its sale becomes wastage with the reason. */
export async function cancelMoves(db: DB, bid: string, uses: { itemId: string; station: string; qty: number }[], made: boolean, ref: string, reason: string,
  staffId: string, shiftDay: string, t: number) {
  const back = await dishMoves(db, bid, uses.map((u) => ({ ...u, qty: -u.qty })), 'sale', ref, null, staffId, shiftDay, t);
  return made ? [...back, ...(await dishMoves(db, bid, uses, 'waste', ref, `Made, then cancelled: ${reason}`.slice(0, 200), staffId, shiftDay, t))] : back;
}

/** The old rule, for orders opened before stock moved to the KOT: each settled bill's lines use their recipes at payment. */
export async function saleMoves(db: DB, bid: string, billIds: string[], staffId: string, shiftDay: string, t: number): Promise<D1PreparedStatement[]> {
  if (!billIds.length) return [];
  const rows = await all<{ bill_no: string; stock_item_id: string; use_qty: number; station: string }>(db, `
    SELECT b.bill_no, r.stock_item_id, sum(l.qty * r.qty) AS use_qty, m.station
    FROM bill_lines l JOIN bills b ON b.id = l.bill_id JOIN orders o ON o.id = b.order_id JOIN menu_items m ON m.id = l.item_id JOIN recipes r ON r.menu_item_id = l.item_id
    WHERE l.bill_id IN (${billIds.map(() => '?').join(',')}) AND o.opened_at < ? GROUP BY b.id, r.stock_item_id, m.station`, ...billIds, stockRule.kotFrom);
  if (!rows.length) return [];
  const stores = await storesOf(db, bid);
  const out: D1PreparedStatement[] = [];
  for (const r of rows) {
    const store = storeFor(stores, r.station);
    if (!store || r.use_qty <= 0) continue;
    out.push(stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, ref, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?)",
      newId(), bid, r.stock_item_id, store.id, -r.use_qty, r.bill_no, staffId, shiftDay, t));
  }
  return out;
}
