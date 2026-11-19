// KOT stations (approved 19 Nov 2026): where a dish's KOT goes and whether it makes one. The rules in one place.
//
// An item makes a KOT if it says so, else if its category says so (categories default to yes). It goes to its own station,
// else its category's. menu_items.station ('kitchen' or 'bar') follows the station's bar flag: it picks the stock store and
// the bar reports, which work as before.
import { newId, stmt } from '../../src/db';

type DB = D1Database;
export const ONLINE_MS = 45_000; // a station device asks every few seconds; quiet for longer than this, it is offline
export const isOnline = (lastSeen: number | null | undefined, now: number) => !!lastSeen && now - lastSeen < ONLINE_MS;

/** A new business starts with a Kitchen and a Bar. */
export const defaultStations = (db: DB, bid: string, t: number) => [
  stmt(db, "INSERT INTO stations (id, business_id, name, is_bar, sort, created_at) VALUES (?, ?, 'Kitchen', 0, 0, ?)", newId(), bid, t),
  stmt(db, "INSERT INTO stations (id, business_id, name, is_bar, sort, created_at) VALUES (?, ?, 'Bar', 1, 1, ?)", newId(), bid, t),
];

/** SQL for an item's category row (alias c), given the item as alias m. */
export const CATEGORY_JOIN = 'LEFT JOIN menu_categories c ON c.business_id = m.business_id AND lower(c.name) = lower(m.category)';
/** SQL: the item's KOT flag and station, as columns kot and station_id (alias m, with CATEGORY_JOIN). */
export const ITEM_ROUTE = `coalesce(m.kot, c.kot, 1) AS kot,
  coalesce(m.station_id, c.station_id, (SELECT s.id FROM stations s WHERE s.business_id = m.business_id AND s.active = 1 ORDER BY s.is_bar, s.sort LIMIT 1)) AS station_id`;

/** Keeps menu_items.station ('kitchen' / 'bar') in step with each item's station, for stock and the bar reports. */
export const syncItemStations = (db: DB, bid: string) => stmt(db, `UPDATE menu_items SET station = coalesce((
    SELECT CASE s.is_bar WHEN 1 THEN 'bar' ELSE 'kitchen' END FROM stations s WHERE s.id = coalesce(menu_items.station_id,
      (SELECT c.station_id FROM menu_categories c WHERE c.business_id = menu_items.business_id AND lower(c.name) = lower(menu_items.category)))), station)
  WHERE business_id = ?`, bid);
