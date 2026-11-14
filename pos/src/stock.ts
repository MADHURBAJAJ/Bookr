// Stock taken out by sales: each settled bill's lines use their menu item's recipe, from the store that matches the
// item's station (bar or kitchen). Returned as statements for the settle batch, so a bill and its stock move together.
import { all, newId, stmt, type DB } from '../../src/db';

export async function saleMoves(db: DB, bid: string, billIds: string[], staffId: string, shiftDay: string, t: number): Promise<D1PreparedStatement[]> {
  if (!billIds.length) return [];
  const rows = await all<{ bill_no: string; stock_item_id: string; use_qty: number; station: string }>(db, `
    SELECT b.bill_no, r.stock_item_id, sum(l.qty * r.qty) AS use_qty, m.station
    FROM bill_lines l JOIN bills b ON b.id = l.bill_id JOIN menu_items m ON m.id = l.item_id JOIN recipes r ON r.menu_item_id = l.item_id
    WHERE l.bill_id IN (${billIds.map(() => '?').join(',')}) GROUP BY b.id, r.stock_item_id, m.station`, ...billIds);
  if (!rows.length) return [];
  const stores = await all<{ id: string; kind: string }>(db, 'SELECT id, kind FROM stock_stores WHERE business_id = ? ORDER BY created_at', bid);
  const out: D1PreparedStatement[] = [];
  for (const r of rows) {
    const store = stores.find((s) => s.kind === r.station) ?? stores.find((s) => s.kind === 'main');
    if (!store || r.use_qty <= 0) continue;
    out.push(stmt(db, "INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, ref, by_staff, shift_day, at) VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?)",
      newId(), bid, r.stock_item_id, store.id, -r.use_qty, r.bill_no, staffId, shiftDay, t));
  }
  return out;
}
