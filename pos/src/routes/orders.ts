// Orders, KOTs, tabs and bills. A bill is printed once from an order whose lines have all gone to the kitchen; its number
// comes from its billing name's series in the same batch, so numbers have no gaps. A printed bill never changes: a mistake
// is voided with a reason (the order opens again) and billed again, perhaps under another billing name.
import { optionAdd, readPrices } from '../addons';
import { CATEGORY_JOIN, isOnline, ITEM_ROUTE } from '../stations';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { phoneKey } from './settings';
import { all, newId, now, one, stmt } from '../../../src/db';
import { body, fail, isUuid, paise, text } from '../../../src/http';
import { approval, approverOf, isManager, requireAction, requireStaff } from '../auth';
import { billTaxRows, billTotals, limitState, rs, type Discount, type LineTax, type TaxRow } from '../billing';
import { clock, dormWhole, event, isNcPlace, isTrigger, bizOf, loadBusiness, placeOf, reasonLabel, sectionTables, tableLayout, tableList } from '../util';
import { dishMoves, cancelMoves, stockAtKot } from '../stock';
import { sendSoon } from '../sync';
import { istDay } from '../../../src/time';
import type { AppEnv } from '../types';

export const orderRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
orderRoutes.use(`${B}/*`, requireStaff);

interface OrderRow { id: string; kind: string; place: string; stay_id: string | null; guest_name: string | null; guest_phone: string | null; guest_id: string | null; covers: number | null; status: string; opened_at: number; opened_shift_day: string;
  handed_at: number | null; handed_from_name: string | null; held_by_name: string | null }
const ORDER_COLS = `id, kind, place, stay_id, guest_name, guest_phone, guest_id, covers, status, opened_at, opened_shift_day, handed_at,
  (SELECT name FROM staff WHERE id = orders.handed_from) AS handed_from_name, (SELECT name FROM staff WHERE id = orders.held_by) AS held_by_name`;
interface LineRow { id: string; item_id: string; name: string; price_paise: number; sac: string; station: string; qty: number; sent_qty: number; variant: string; options: string | null; price_by: string | null; station_id: string | null; kot: number }
/** What was chosen on a line: [{group, name, addPaise}], in the dish's order of groups. */
type Chosen = { group: string; name: string; addPaise: number }[];
const chosenOf = (l: { options: string | null }): Chosen => (l.options ? JSON.parse(l.options) : []);
const LINE_COLS = 'id, item_id, name, price_paise, sac, station, qty, sent_qty, variant, options, price_by, station_id, kot';

async function order(c: { env: { DB: D1Database } }, bid: string, id: string, editable = false): Promise<OrderRow> {
  if (!isUuid(id)) fail(404, 'Order not found.');
  const o = await one<OrderRow>(c.env.DB, `SELECT ${ORDER_COLS} FROM orders WHERE id = ? AND business_id = ?`, id, bid);
  if (!o) fail(404, 'Order not found.');
  if (editable && o.status !== 'open' && o.status !== 'tab') fail(409, 'This order is already billed. Void the bill first to change it.');
  return o;
}

/** A phone as shown on screens: only its last 4 digits (••••6789). The full number is never sent to the counter. */
const maskPhone = (p: string | null) => (p ? `••••${p.slice(-4)}` : null);

/**
 * The guest typed on an order (22 Nov 2026): a name, a phone, or both, all optional unless `required`. A phone already in
 * the guest list under another name is asked about (guestChoice 'saved' keeps the saved name, 'update' renames the guest).
 * A new name with a phone joins the guest list; a phone alone does not.
 */
async function readGuest(c: Context<AppEnv>, data: Record<string, unknown>, required = false) {
  const bid = c.get('businessId');
  const name = text(data, 'guestName', 'Guest name', { optional: !required, max: 80 });
  const phone = phoneKey(data.guestPhone);
  if (required && !phone) fail(400, "Add the guest's phone number.");
  const t = now();
  if (!phone) return { name, phone: null, guestId: null, stmts: [] as D1PreparedStatement[] };
  const g = await one<{ id: string; name: string }>(c.env.DB, 'SELECT id, name FROM guests WHERE business_id = ? AND phone = ?', bid, phone);
  if (g) {
    if (name && name.trim().toLowerCase() !== g.name.trim().toLowerCase()) {
      if (data.guestChoice === 'saved') return { name: g.name, phone, guestId: g.id, stmts: [] };
      if (data.guestChoice === 'update') return { name, phone, guestId: g.id, stmts: [stmt(c.env.DB, 'UPDATE guests SET name = ?, updated_at = ? WHERE id = ?', name, t, g.id)] };
      throw new HTTPException(409, { message: `This phone is saved for ${g.name}. Same guest?`, cause: { code: 'guest_differs', savedName: g.name } });
    }
    return { name: name ?? g.name, phone, guestId: g.id, stmts: [] };
  }
  if (!name) return { name: null, phone, guestId: null, stmts: [] };
  const id = newId();
  return { name, phone, guestId: id, stmts: [stmt(c.env.DB, 'INSERT INTO guests (id, business_id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, bid, name, phone, t, t)] };
}

const lines = (db: D1Database, orderId: string) =>
  all<LineRow>(db, `SELECT ${LINE_COLS} FROM order_lines WHERE order_id = ? ORDER BY created_at, rowid`, orderId);

function orderOut(o: OrderRow, ls: LineRow[], bill: unknown = null) {
  return {
    id: o.id, kind: o.kind, place: o.place, stayId: o.stay_id, guestName: o.guest_name, guestPhone: maskPhone(o.guest_phone), covers: o.covers, status: o.status,
    openedAt: o.opened_at, openedShiftDay: o.opened_shift_day,
    // Handed over between cashiers (24 Nov 2026): from whom, to whom, when.
    handedFrom: o.handed_from_name, heldBy: o.held_by_name, handedAt: o.handed_at,
    lines: ls.filter((l) => l.qty > 0).map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, pricePaise: l.price_paise, qty: l.qty, sentQty: l.sent_qty,
      options: chosenOf(l), typedPrice: !!l.price_by, noKot: l.kot === 0 })),
    itemsPaise: ls.reduce((s, l) => s + l.qty * l.price_paise, 0), bill,
  };
}

// Open orders and tabs (with their lines), and bills printed but not yet paid: the counter's main screen.
orderRoutes.get(`${B}/orders`, requireAction('pos.view'), async (c) => {
  const bid = c.get('businessId');
  const fixed = tableList(bizOf(c));
  const [os, ls, bills, used] = await Promise.all([
    all<OrderRow>(c.env.DB, `SELECT ${ORDER_COLS} FROM orders WHERE business_id = ? AND status IN ('open', 'tab', 'billed') ORDER BY opened_at`, bid),
    all<LineRow & { order_id: string }>(c.env.DB, "SELECT l.order_id, l.id, l.item_id, l.name, l.price_paise, l.sac, l.station, l.qty, l.sent_qty, l.variant, l.options, l.price_by, l.station_id, l.kot FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.business_id = ? AND o.status IN ('open', 'tab', 'billed') ORDER BY l.created_at, l.rowid", bid),
    all<{ id: string; order_id: string; bill_no: string; total_paise: number; entity_id: string }>(c.env.DB,
      "SELECT id, order_id, bill_no, total_paise, entity_id FROM bills WHERE business_id = ? AND status = 'printed'", bid),
    // The counter's table grid: the restaurant's own list from Settings, or else the tables used in the last 60 days.
    fixed ? Promise.resolve(fixed.map((place) => ({ place })))
      : all<{ place: string }>(c.env.DB, "SELECT min(place) AS place FROM orders WHERE business_id = ? AND kind = 'table' AND opened_at > ? GROUP BY lower(place) LIMIT 80",
        bid, Date.now() - 60 * 86_400_000),
  ]);
  return c.json({ orders: os.map((o) => {
    const b = bills.find((x) => x.order_id === o.id);
    return orderOut(o, ls.filter((l) => l.order_id === o.id), b ? { id: b.id, billNo: b.bill_no, totalPaise: b.total_paise, entityId: b.entity_id } : null);
  }), tables: fixed ?? used.map((u) => u.place).sort((x, y) => x.localeCompare(y, 'en', { numeric: true })), tablesFixed: !!fixed,
    sections: tableLayout(bizOf(c)) ?? [] });
});

// Who can approve, with their PIN, cancelling an item already sent to the kitchen: managers and owners with a PIN.
/** A room or bed name compared loosely: "Room 101", "room-101" and "101" are the same room. */
export const roomKey = (s: string) => s.toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '');

orderRoutes.get(`${B}/approvers`, requireAction('pos.view'), async (c) => {
  return c.json({ approvers: await all(c.env.DB, "SELECT id, name, role FROM staff WHERE business_id = ? AND active = 1 AND support = 0 AND role IN ('owner', 'manager') AND pin_hash IS NOT NULL ORDER BY role DESC, name", c.get('businessId')) });
});

orderRoutes.post(`${B}/orders`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const b = bizOf(c);
  const data = await body(c);
  const kind = data.kind;
  if (kind !== 'table' && kind !== 'room' && kind !== 'takeaway') fail(400, 'Order kind must be table, room or takeaway.');
  let place = kind === 'takeaway' ? 'Takeaway' : text(data, 'place', kind === 'room' ? 'Room' : 'Table', { max: 40 })!;
  let stayId: string | null = null;
  const typed = await readGuest(c, data);
  let guest = typed.name;
  let guestPhone = typed.phone;
  let guestId = typed.guestId;
  // A guest staying: their name and phone come from the check-in, unless others were typed.
  const fromStay = (s: { guest_name: string; phone: string | null; guest_id: string | null }) => {
    guest ??= s.guest_name;
    if (!guestPhone) { guestPhone = s.phone; guestId = s.guest_id; }
  };
  if (kind === 'room') {
    stayId = text(data, 'stayId', 'Stay')!;
    const s = await one<{ room: string; guest_name: string; phone: string | null; guest_id: string | null }>(c.env.DB,
      'SELECT room, guest_name, phone, guest_id FROM stays WHERE id = ? AND business_id = ? AND checked_out_at IS NULL', stayId, bid);
    if (!s) fail(400, 'That room has no open stay.');
    place = `Room ${s.room}`;
    fromStay(s);
  }
  if (kind === 'table' && (await one(c.env.DB, "SELECT 1 FROM orders WHERE business_id = ? AND kind = 'table' AND lower(place) = lower(?) AND status = 'open'", bid, place))) {
    fail(409, `${place} already has an open order.`);
  }
  if (kind === 'table') {
    const layout = tableLayout(b);
    const at = placeOf(layout, place);
    if (at?.section.kind === 'nc' && !isManager(c)) fail(403, 'NC tables are for managers and owners.');
    // A private room, a dorm bed, or a whole dorm (a group) with a guest staying: the order is theirs, so its bill goes to their folio (21 Nov 2026).
    if (at && (at.section.kind === 'rooms' || at.section.kind === 'dorms')) {
      const key = roomKey(place);
      const st = (await all<{ id: string; room: string; guest_name: string; phone: string | null; guest_id: string | null }>(c.env.DB,
        'SELECT id, room, guest_name, phone, guest_id FROM stays WHERE business_id = ? AND checked_out_at IS NULL', bid)).find((x) => roomKey(x.room) === key);
      if (st) { stayId = st.id; fromStay(st); }
    }
    // A dorm is sold bed by bed, or whole to one group: not both at once.
    if (at?.dorm) {
      const others = at.whole ? sectionTables({ kind: 'dorms', dorms: at.section.dorms!.filter((d) => d.name === at.dorm) }).filter((x) => x !== dormWhole(at.dorm!)) : [dormWhole(at.dorm)];
      const busy = await all<{ place: string }>(c.env.DB, `SELECT place FROM orders WHERE business_id = ? AND kind = 'table' AND status IN ('open', 'tab', 'billed')
        AND lower(place) IN (SELECT lower(value) FROM json_each(?))`, bid, JSON.stringify(others));
      if (busy.length) fail(409, at.whole ? `${busy.map((x) => x.place).join(', ')} already ${busy.length === 1 ? 'has an order' : 'have orders'}: finish ${busy.length === 1 ? 'it' : 'them'} before booking ${at.dorm} whole.`
        : `${at.dorm} is booked whole: add to the ${dormWhole(at.dorm)} order.`);
    }
  }
  const covers = typeof data.covers === 'number' && Number.isInteger(data.covers) && data.covers > 0 && data.covers < 100 ? data.covers : null;
  const id = newId();
  const { t, shiftDay } = clock(b);
  await c.env.DB.batch([...typed.stmts,
    stmt(c.env.DB, 'INSERT INTO orders (id, business_id, kind, place, stay_id, guest_name, guest_phone, guest_id, covers, opened_by, opened_at, opened_shift_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, bid, kind, place, stayId, guest, guestPhone, guestId, covers, c.get('staff').id, t, shiftDay)]);
  return c.json({ id }, 201);
});

orderRoutes.get(`${B}/orders/:id`, requireAction('pos.view'), async (c) => {
  const o = await order(c, c.get('businessId'), c.req.param('id'));
  return c.json({ order: { ...orderOut(o, await lines(c.env.DB, o.id)), guest: await guestOut(c.env.DB, c.get('businessId'), o.id, o.guest_name, o.guest_phone, o.guest_id) } });
});

// Adds a dish, with its choices and add-ons and, for a price-at-billing dish, the typed price; or changes a line on the order
// by its id (+1, -1). The same dish with other choices or another price is a line of its own. Taking away a line already
// sent to the kitchen needs a reason and goes on the exceptions report.
orderRoutes.post(`${B}/orders/:id/items`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const delta = data.delta;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 50) fail(400, 'Change must be a whole number of items.');
  const [o, item, groups] = await Promise.all([
    order(c, bid, c.req.param('id'), true),
    data.lineId === undefined && delta > 0
      ? one<{ id: string; name: string; price_paise: number; open_price: number; min_price_paise: number | null }>(db,
        'SELECT id, name, price_paise, open_price, min_price_paise FROM menu_items WHERE id = ? AND business_id = ? AND active = 1', data.itemId, bid)
      : Promise.resolve(null),
    data.lineId === undefined && delta > 0
      ? all<{ group_id: string; group_name: string; kind: string; option_id: string; option_name: string; add_paise: number; prices: string | null }>(db, `SELECT g.id AS group_id, g.name AS group_name, g.kind,
          o.id AS option_id, o.name AS option_name, o.add_paise, a.prices FROM menu_item_addons a JOIN addon_groups g ON g.id = a.group_id
          JOIN addon_options o ON o.group_id = g.id AND o.active = 1 WHERE a.item_id = ? AND a.business_id = ? ORDER BY a.sort, g.name, o.sort, o.name`, data.itemId, bid)
      : Promise.resolve([]),
  ]);
  const t = now();
  if (o.kind === 'table' && !isManager(c) && isNcPlace(tableLayout(bizOf(c)), o.place)) fail(403, 'NC tables are for managers and owners.');
  if (data.lineId === undefined && delta > 0) {
    if (!item) fail(400, 'Item not on the menu.');
    // Choices: one from each "choose one" group, any from an "add any" group, nothing from elsewhere.
    const picked = Array.isArray(data.options) ? data.options : [];
    if (picked.some((x) => typeof x !== 'string') || new Set(picked).size !== picked.length) fail(400, 'Choose each add-on once.');
    for (const id of picked) if (!groups.some((g) => g.option_id === id)) fail(400, 'That add-on is not offered with this dish.');
    for (const g of new Set(groups.filter((x) => x.kind === 'one').map((x) => x.group_id))) {
      const n = groups.filter((x) => x.group_id === g && picked.includes(x.option_id)).length;
      if (n !== 1) fail(400, `Choose one ${groups.find((x) => x.group_id === g)!.group_name} for ${item.name}.`);
    }
    // Each choice costs what this dish says (its own Half / Full prices, its own price for an extra), else the add-on's own.
    const chosen: Chosen = groups.filter((g) => picked.includes(g.option_id)).map((g) => {
      const opts = groups.filter((x) => x.group_id === g.group_id).map((x) => ({ name: x.option_name, addPaise: x.add_paise }));
      return { group: g.group_name, name: g.option_name, addPaise: optionAdd(g.kind, opts, { name: g.option_name, addPaise: g.add_paise }, readPrices(g.prices)) };
    });
    // Price at billing: typed now, never below the lowest price; who typed it is kept.
    let base = item.price_paise;
    let priceBy: string | null = null;
    if (item.open_price) {
      base = paise(data, 'price', `Price of ${item.name}`);
      if (base <= 0) fail(400, `Type the price of ${item.name}.`);
      if (item.min_price_paise !== null && base < item.min_price_paise) fail(400, `${item.name} cannot be less than ${rs(item.min_price_paise)}.`);
      priceBy = c.get('staff').id;
    }
    const unit = Math.max(0, base + chosen.reduce((s, x) => s + x.addPaise, 0));
    const variant = [...picked].sort().join(',') + (item.open_price ? `|${base}` : '');
    // Its station and whether it makes a KOT come from the dish, else its category. A no-KOT line counts as sent at once.
    await stmt(db, `INSERT INTO order_lines (id, business_id, order_id, item_id, name, price_paise, sac, station, qty, sent_qty, created_at, variant, options, price_by, kot, station_id)
        SELECT ?, ?, ?, m.id, m.name, ?, m.sac, m.station, ?, CASE coalesce(m.kot, c.kot, 1) WHEN 0 THEN ? ELSE 0 END, ?, ?, ?, ?, r.kot, r.station_id
        FROM menu_items m ${CATEGORY_JOIN} JOIN (SELECT ${ITEM_ROUTE} FROM menu_items m ${CATEGORY_JOIN} WHERE m.id = ?) r WHERE m.id = ?
        ON CONFLICT (order_id, item_id, variant) DO UPDATE SET qty = order_lines.qty + excluded.qty,
          sent_qty = CASE order_lines.kot WHEN 0 THEN order_lines.qty + excluded.qty ELSE order_lines.sent_qty END`,
      newId(), bid, o.id, unit, delta, delta, t, variant, chosen.length ? JSON.stringify(chosen) : null, priceBy, item.id, item.id).run();
    // A no-KOT item (a bottle at the counter) is handed over at once: its stock goes now (24 Nov 2026).
    if (stockAtKot(o.opened_at)) {
      const nl = await one<{ kot: number; station: string }>(db, 'SELECT kot, station FROM order_lines WHERE order_id = ? AND item_id = ? AND variant = ?', o.id, item.id, variant);
      if (nl?.kot === 0) {
        const moves = await dishMoves(db, bid, [{ itemId: item.id, station: nl.station, qty: delta }], 'sale', `${o.place} · no KOT`, null, c.get('staff').id, clock(bizOf(c)).shiftDay, t);
        if (moves.length) await db.batch(moves);
      }
    }
    return c.json({ order: orderOut(o, await lines(db, o.id)) });
  }
  // A line by its id, or (older screens) the dish's plain line.
  const line = data.lineId !== undefined
    ? await one<LineRow>(db, `SELECT ${LINE_COLS} FROM order_lines WHERE id = ? AND order_id = ?`, data.lineId, o.id)
    : await one<LineRow>(db, `SELECT ${LINE_COLS} FROM order_lines WHERE order_id = ? AND item_id = ? ORDER BY variant = '' DESC, created_at LIMIT 1`, o.id, data.itemId);
  if (!line) fail(400, 'That line is not on the order.');
  if (line.qty + delta < 0) fail(400, 'There are not that many on the order.');
  const newQty = line.qty + delta;
  // A no-KOT line was never with a station: it follows its quantity and needs no reason to come off.
  if (line.kot === 0) {
    await db.batch([stmt(db, 'UPDATE order_lines SET qty = ?, sent_qty = ? WHERE id = ?', newQty, newQty, line.id),
      ...(stockAtKot(o.opened_at) ? await dishMoves(db, bid, [{ itemId: line.item_id, station: line.station, qty: delta }], 'sale', `${o.place} · no KOT`, null, c.get('staff').id, clock(bizOf(c)).shiftDay, t) : [])]);
    return c.json({ order: orderOut(o, await lines(db, o.id)), cancelledSent: 0, kots: [] });
  }
  const cancelSent = Math.max(0, line.sent_qty - newQty);
  const statements = [stmt(db, 'UPDATE order_lines SET qty = ?, sent_qty = ? WHERE id = ?', newQty, Math.min(line.sent_qty, newQty), line.id)];
  let kotIds: string[] = [];
  if (cancelSent > 0) {
    const reason = await reasonLabel(db, bid, 'kot_cancel', data.reasonId, 'A reason for cancelling an item already sent to the kitchen');
    // Cancelling what the kitchen already has needs a manager or owner (21 Nov 2026): their own sign-in, or their PIN here.
    const approver = isManager(c) ? { name: c.get('staff').name } : await approverOf(c, data.approverId, data.approverPin);
    const what = [line.name, ...chosenOf(line).map((x) => x.name)].join(' + ');
    statements.push(event(db, bid, 'kot_cancel', `${o.place} · ${cancelSent} × ${what}`, cancelSent * line.price_paise, reason, `Approved by ${approver.name}`,
      c.get('staff').id, clock(bizOf(c)).shiftDay));
    // The station is told: a cancel KOT, printed or shown like any other.
    const k = await kotStatements(db, bid, o.id, [{ ...line, qty: -cancelSent, sent_qty: 0 }], c.get('staff').id, now(), true, clock(bizOf(c)).shiftDay);
    statements.push(...k.statements);
    kotIds = k.ids;
    // Its stock goes back to the store (25 Nov 2026).
    if (stockAtKot(o.opened_at)) statements.push(...await cancelMoves(db, bid, [{ itemId: line.item_id, station: line.station, qty: cancelSent }],
      `${o.place} · cancelled`, c.get('staff').id, clock(bizOf(c)).shiftDay, t));
  }
  await db.batch(statements);
  return c.json({ order: orderOut(o, await lines(db, o.id)), cancelledSent: cancelSent, kots: await kotsOut(db, kotIds, o.place) });
});

// Sends what is new to the kitchen and bar: one KOT per station, numbered for the business.
orderRoutes.post(`${B}/orders/:id/kot`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const o = await order(c, bid, c.req.param('id'), true);
  const ls = (await lines(c.env.DB, o.id)).filter((l) => l.qty > l.sent_qty);
  if (!ls.length) fail(409, 'Nothing new to send.');
  const t = now();
  const { shiftDay } = clock(bizOf(c));
  const k = await kotStatements(c.env.DB, bid, o.id, ls, c.get('staff').id, t, false, shiftDay);
  // What goes to the kitchen and bar takes its stock now (24 Nov 2026), not at payment.
  const moves = stockAtKot(o.opened_at) ? await dishMoves(c.env.DB, bid, ls.filter((l) => l.kot !== 0).map((l) => ({ itemId: l.item_id, station: l.station, qty: l.qty - l.sent_qty })),
    'sale', `${o.place} · KOT`, null, c.get('staff').id, shiftDay, t) : [];
  await c.env.DB.batch([...k.statements, ...moves, ...ls.map((l) => stmt(c.env.DB, 'UPDATE order_lines SET sent_qty = qty WHERE id = ?', l.id))]);
  return c.json({ kots: await kotsOut(c.env.DB, k.ids, o.place), order: orderOut(o, await lines(c.env.DB, o.id)) }, 201);
});

/**
 * KOTs for lines going to stations (one per station, numbered for the business), and how each is delivered: printed at the
 * station's device when it is online and prints, shown on its screen, or, when its device is offline, printed at the
 * counter so nothing is missed. A cancel KOT (negative quantities) goes the same way.
 */
async function kotStatements(db: D1Database, bid: string, orderId: string, ls: LineRow[], staffId: string, t: number, cancel: boolean, shiftDay: string) {
  const send = ls.filter((l) => l.kot !== 0 && l.qty !== l.sent_qty);
  const stations = await all<{ id: string; name: string; how: string; seen: number | null }>(db,
    `SELECT s.id, s.name, s.how, (SELECT max(d.last_seen_at) FROM devices d WHERE d.station_id = s.id AND d.revoked_at IS NULL) AS seen
     FROM stations s WHERE s.business_id = ? ORDER BY s.is_bar, s.sort`, bid);
  const fallback = stations[0];
  const stationOf = (l: LineRow) => stations.find((s) => s.id === l.station_id) ?? stations.find((s) => (l.station === 'bar') === /bar/i.test(s.name)) ?? fallback;
  const groups = new Map<string, LineRow[]>();
  for (const l of send) { const s = stationOf(l); if (s) groups.set(s.id, [...(groups.get(s.id) ?? []), l]); }
  const ids: string[] = [];
  const statements = [...groups].map(([sid, gl]) => {
    const s = stations.find((x) => x.id === sid)!;
    const online = isOnline(s.seen, t);
    const printAt = !online ? 'counter' : s.how === 'screen' ? 'none' : 'station';
    const id = newId();
    ids.push(id);
    // The printed number starts at 101 each shift day (21 Nov 2026); kot_no keeps running underneath.
    return stmt(db, `INSERT INTO kots (id, business_id, order_id, kot_no, station, lines, by_staff, printed_at, station_id, print_at, status, shift_day, day_no)
      SELECT ?, ?, ?, coalesce(max(kot_no), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?,
        coalesce((SELECT max(day_no) FROM kots WHERE business_id = ? AND shift_day = ?), 100) + 1 FROM kots WHERE business_id = ?`,
      id, bid, orderId, s.name, JSON.stringify(gl.map((l) => ({ name: l.name, qty: l.qty - l.sent_qty, options: chosenOf(l).map((x) => x.name), pricePaise: l.price_paise,
        ...(cancel ? { cancelled: true } : {}) }))), staffId, t, s.id, printAt, s.how === 'paper' ? 'ready' : 'new', shiftDay, bid, shiftDay, bid);
  });
  return { ids, statements };
}
/** KOTs as the counter gets them: those it must print itself have printAt 'counter'. */
async function kotsOut(db: D1Database, ids: string[], place: string) {
  if (!ids.length) return [];
  const ks = await all<{ kot_no: number; station: string; lines: string; print_at: string; copies: number | null }>(db,
    `SELECT coalesce(k.day_no, k.kot_no) AS kot_no, k.station, k.lines, k.print_at, s.copies FROM kots k LEFT JOIN stations s ON s.id = k.station_id WHERE k.id IN (SELECT value FROM json_each(?)) ORDER BY k.kot_no`, JSON.stringify(ids));
  return ks.map((k) => ({ kotNo: k.kot_no, station: k.station, place, lines: JSON.parse(k.lines), printAt: k.print_at, copies: k.copies ?? 1 }));
}

// Split by item: chosen quantities move to a new order at the same place ("T4 · 2"), billed on its own with its own number
// and GST. What was already sent to the kitchen stays sent, so no new KOT prints for it.
orderRoutes.post(`${B}/orders/:id/split`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const o = await order(c, bid, c.req.param('id'), true);
  const data = await body(c);
  if (!Array.isArray(data.lines) || !data.lines.length) fail(400, 'Choose what moves to the new bill.');
  const ls = await lines(c.env.DB, o.id);
  const moves: { line: LineRow; qty: number }[] = [];
  for (const raw of data.lines) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const line = r.lineId !== undefined ? ls.find((l) => l.id === r.lineId) : ls.find((l) => l.item_id === r.itemId);
    const qty = r.qty;
    if (!line || typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0 || qty > line.qty) fail(400, 'A quantity to move is not on the order.');
    if (qty > 0 && !moves.some((m) => m.line.id === line.id)) moves.push({ line, qty });
  }
  if (!moves.length) fail(400, 'Choose what moves to the new bill.');
  const leftAfter = ls.reduce((n, l) => n + l.qty, 0) - moves.reduce((n, m) => n + m.qty, 0);
  if (leftAfter <= 0) fail(400, 'Leave something on this bill; nothing would be split.');
  const b = bizOf(c);
  const { t, shiftDay } = clock(b);
  const base = o.place.replace(/ · \d+$/, '');
  const siblings = await one<{ n: number }>(c.env.DB, "SELECT count(*) AS n FROM orders WHERE business_id = ? AND (place = ? OR place LIKE ?) AND status IN ('open', 'tab', 'billed')",
    bid, base, `${base} · %`);
  const id = newId();
  await c.env.DB.batch([
    // The new bill keeps the same guest (22 Nov 2026).
    stmt(c.env.DB, 'INSERT INTO orders (id, business_id, kind, place, stay_id, guest_name, guest_phone, guest_id, covers, opened_by, opened_at, opened_shift_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
      id, bid, o.kind, `${base} · ${(siblings?.n ?? 1) + 1}`, o.stay_id, o.guest_name, o.guest_phone, o.guest_id, c.get('staff').id, t, shiftDay),
    ...moves.flatMap(({ line, qty }) => {
      const sentMoved = Math.max(0, qty - (line.qty - line.sent_qty)); // not-yet-sent move first
      return [
        stmt(c.env.DB, 'UPDATE order_lines SET qty = qty - ?, sent_qty = sent_qty - ? WHERE id = ?', qty, sentMoved, line.id),
        stmt(c.env.DB, `INSERT INTO order_lines (id, business_id, order_id, item_id, name, price_paise, sac, station, qty, sent_qty, created_at, variant, options, price_by, station_id, kot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(), bid, id, line.item_id, line.name, line.price_paise, line.sac, line.station, qty, sentMoved, t, line.variant, line.options, line.price_by, line.station_id, line.kot),
      ];
    }),
  ]);
  return c.json({ id }, 201);
});

// Keeps the order open as a tab across shifts (for guests not in a room). It is billed when the guest settles.
orderRoutes.post(`${B}/orders/:id/tab`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const o = await order(c, bid, c.req.param('id'), true);
  const data = await body(c);
  // A tab carries the guest's name and phone, both required (22 Nov 2026); those on the order already count.
  const typed = await readGuest(c, { ...data, guestName: data.guestName || o.guest_name || undefined, guestPhone: data.guestPhone || o.guest_phone || undefined }, true);
  const ls = await lines(c.env.DB, o.id);
  if (ls.some((l) => l.qty > l.sent_qty)) fail(409, 'Send the new items to the kitchen first.');
  await c.env.DB.batch([...typed.stmts,
    stmt(c.env.DB, "UPDATE orders SET status = 'tab', guest_name = ?, guest_phone = ?, guest_id = ? WHERE id = ?", typed.name, typed.phone, typed.guestId, o.id)]);
  return c.json({ ok: true });
});

// The guest on an order (22 Nov 2026): name and phone, either or both, set or changed while the order is open or a tab.
// The answer gives the name, the phone's last 4 digits, and how many times the guest came before (by phone).
orderRoutes.post(`${B}/orders/:id/guest`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const o = await order(c, bid, c.req.param('id'), true);
  const data = await body(c);
  // No phone sent keeps the one on file; an empty one clears it (not on a tab).
  const g = await readGuest(c, { ...data, guestPhone: data.guestPhone === undefined ? o.guest_phone ?? undefined : data.guestPhone }, o.status === 'tab');
  if (o.status === 'tab' && !g.name) fail(400, 'A tab needs the guest name.');
  await c.env.DB.batch([...g.stmts, stmt(c.env.DB, 'UPDATE orders SET guest_name = ?, guest_phone = ?, guest_id = ? WHERE id = ?', g.name, g.phone, g.guestId, o.id)]);
  return c.json({ guest: await guestOut(c.env.DB, bid, o.id, g.name, g.phone, g.guestId) });
});
async function guestOut(db: D1Database, bid: string, orderId: string, name: string | null, phone: string | null, guestId: string | null) {
  const v = guestId ? await one<{ n: number; last: string | null; avg: number | null }>(db, `SELECT count(*) AS n, max(opened_shift_day) AS last,
      (SELECT round(avg(b.total_paise)) FROM bills b JOIN orders x ON x.id = b.order_id WHERE x.business_id = ?1 AND x.guest_id = ?2 AND x.id <> ?3 AND b.status = 'settled') AS avg
    FROM orders WHERE business_id = ?1 AND guest_id = ?2 AND id <> ?3 AND status <> 'cancelled'`, bid, guestId, orderId) : null;
  return { name, phone: maskPhone(phone), visits: v?.n ?? 0, lastVisit: v?.last ?? null, usualPaise: v?.avg ?? null };
}

// An order with nothing sent to the kitchen can be dropped (a table that left before ordering). One with items already
// sent is cancelled whole (21 Nov 2026): one reason, approved by a manager or owner (their sign-in, or their PIN), a cancel
// KOT to each station for everything it was sent, and each line on the Daily check.
orderRoutes.post(`${B}/orders/:id/cancel`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const o = await order(c, bid, c.req.param('id'), true);
  const ls = await lines(db, o.id);
  const sent = ls.filter((l) => l.sent_qty > 0 && l.kot !== 0);
  if (!sent.length) {
    await stmt(db, "UPDATE orders SET status = 'cancelled' WHERE id = ?", o.id).run();
    return c.json({ ok: true, kots: [] });
  }
  if (o.kind === 'table' && !isManager(c) && isNcPlace(tableLayout(bizOf(c)), o.place)) fail(403, 'NC tables are for managers and owners.');
  const data = await body(c);
  const reason = await reasonLabel(db, bid, 'kot_cancel', data.reasonId, 'A reason for cancelling an order already sent to the kitchen');
  const approver = isManager(c) ? { name: c.get('staff').name } : await approverOf(c, data.approverId, data.approverPin);
  const { shiftDay } = clock(bizOf(c));
  const staffId = c.get('staff').id;
  const k = await kotStatements(db, bid, o.id, sent.map((l) => ({ ...l, qty: -l.sent_qty, sent_qty: 0 })), staffId, now(), true, shiftDay);
  await db.batch([
    ...k.statements,
    ...sent.map((l) => event(db, bid, 'kot_cancel', `${o.place} · ${l.sent_qty} × ${[l.name, ...chosenOf(l).map((x) => x.name)].join(' + ')} (whole order)`,
      l.sent_qty * l.price_paise, reason, `Approved by ${approver.name}`, staffId, shiftDay)),
    stmt(db, "UPDATE orders SET status = 'cancelled' WHERE id = ?", o.id),
    // Its stock goes back to the store (25 Nov 2026). No-KOT items were handed over: they stay used.
    ...(stockAtKot(o.opened_at) ? await cancelMoves(db, bid, sent.map((l) => ({ itemId: l.item_id, station: l.station, qty: l.sent_qty })),
      `${o.place} · cancelled`, staffId, shiftDay, now()) : []),
  ]);
  return c.json({ ok: true, kots: await kotsOut(db, k.ids, o.place) });
});

interface Entity { id: string; name: string; gst_rate_bp: number; gst_registered: number; series_prefix: string; offered: number; active: number; warn1_paise: number | null; warn2_paise: number | null; stop_paise: number | null }

// Prints the bill: the cashier chooses the billing name (the default is preselected on screen) and any discount, with its reason.
orderRoutes.post(`${B}/orders/:id/bill`, requireAction('bills.print'), async (c) => {
  const bid = c.get('businessId');
  const b = bizOf(c);
  const data = await body(c);
  const entityId = text(data, 'entityId', 'Billing name')!;
  const { t, shiftDay, fy } = clock(b);
  // Everything the bill needs, read in one go: the order, its lines, the billing name and its year so far.
  const [o, allLines, e, yearRow, taxRows] = await Promise.all([
    order(c, bid, c.req.param('id'), true),
    lines(c.env.DB, c.req.param('id')),
    one<Entity>(c.env.DB, 'SELECT id, name, gst_rate_bp, gst_registered, series_prefix, offered, active, warn1_paise, warn2_paise, stop_paise FROM billing_entities WHERE id = ? AND business_id = ?', entityId, bid),
    one<{ s: number }>(c.env.DB, "SELECT coalesce(sum(total_paise), 0) AS s FROM bills WHERE entity_id = ? AND fy = ? AND status <> 'void'", entityId, fy),
    // Each line's tax, from the menu as it is now: the item's own, else its category's, else the billing name's.
    all<{ id: string; mode: string | null; bp: number | null; cmode: string | null; cbp: number | null }>(c.env.DB, `SELECT l.id, m.tax_mode AS mode, m.gst_bp AS bp,
        k.tax_mode AS cmode, k.gst_bp AS cbp FROM order_lines l JOIN menu_items m ON m.id = l.item_id
        LEFT JOIN menu_categories k ON k.business_id = m.business_id AND lower(k.name) = lower(m.category) WHERE l.order_id = ?`, c.req.param('id')),
  ]);
  // A billing name not registered for GST charges no GST: its GST lines go at 0%; liquor and exempt stay as they are.
  const lineTax = (lineId: string): LineTax => {
    const r = taxRows.find((x) => x.id === lineId);
    const mode = r?.mode ?? r?.cmode ?? 'billing';
    if (mode === 'liquor') return { kind: 'liquor' };
    if (mode === 'none') return { kind: 'exempt' };
    const bp = mode === 'rate' ? (r!.mode === 'rate' ? r!.bp! : r!.cbp!) : e!.gst_rate_bp;
    return { kind: 'gst', bp: e!.gst_registered ? bp : 0 };
  };
  const ls = allLines.filter((l) => l.qty > 0);
  if (!ls.length) fail(409, 'The order has no items.');
  if (ls.some((l) => l.qty > l.sent_qty)) fail(409, 'Send the new items to the kitchen first.');
  if (!e || !e.active || !e.offered) fail(400, 'That billing name is not offered at the counter.');

  const d = (data.discount ?? { kind: 'none' }) as Record<string, unknown>;
  let discount: Discount = { kind: 'none' };
  if (d.kind === 'pct') {
    if (typeof d.bp !== 'number' || !Number.isInteger(d.bp) || d.bp <= 0 || d.bp > 10000) fail(400, 'Discount must be above 0% and at most 100%.');
    discount = { kind: 'pct', bp: d.bp };
  } else if (d.kind === 'amount') {
    if (typeof d.paise !== 'number' || !Number.isInteger(d.paise) || d.paise <= 0) fail(400, 'Discount amount must be above zero.');
    discount = { kind: 'amount', paise: d.paise };
  } else if (d.kind !== 'none') fail(400, 'Discount must be none, a percentage or an amount.');
  // Items made free or given a share off (21 Nov 2026): [{ lineId, bp }], 10000 = free.
  const lineDisc = new Map<string, number>();
  if (data.lineDiscounts !== undefined) {
    if (!Array.isArray(data.lineDiscounts) || data.lineDiscounts.length > 100) fail(400, 'Item discounts are not valid.');
    for (const raw of data.lineDiscounts) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const l = ls.find((x) => x.id === r.lineId);
      if (!l || typeof r.bp !== 'number' || !Number.isInteger(r.bp) || r.bp <= 0 || r.bp > 10000) fail(400, 'An item discount is not valid: above 0% and at most 100%.');
      lineDisc.set(l.id, Math.floor((l.qty * l.price_paise * r.bp + 5000) / 10000));
    }
  }
  let totals;
  try { totals = billTotals(ls.map((l) => ({ qty: l.qty, pricePaise: l.price_paise, tax: lineTax(l.id), discPaise: lineDisc.get(l.id) ?? 0 })), discount, e.gst_rate_bp); } catch { fail(400, 'The discount is more than the bill.'); }
  if (totals.totalPaise <= 0) fail(400, 'Everything on this bill is free: close it as complimentary instead (no discount, then Complimentary at payment).');
  const discountReason = totals.discountPaise > 0 ? await reasonLabel(c.env.DB, bid, 'discount', d.reasonId ?? data.discountReasonId, 'A reason for the discount') : null;
  // A cashier gives up to the business's limit alone; above it, or any item made free, a manager approves.
  const freeItems = ls.filter((l) => (lineDisc.get(l.id) ?? 0) >= l.qty * l.price_paise);
  const overLimit = totals.discountPaise * 10000 > totals.grossPaise * b.disc_limit_bp;
  const approver = overLimit || freeItems.length
    ? await approval(c, data, freeItems.length ? 'Making an item free' : `A discount above ${b.disc_limit_bp / 100}%`) : null;

  const year = yearRow!.s;
  const was = limitState(e, year);
  const will = limitState(e, year, totals.totalPaise);
  if (will === 'stop') fail(409, `${e.name} would pass its stop point for ${fy} (${rs(year)} billed so far). Choose another billing name.`);

  const id = newId();
  const printDay = istDay(t);
  const yymmdd = printDay.slice(2).replace(/-/g, '');
  const guest = text(data, 'guestName', 'Guest name', { optional: true, max: 80 }) ?? o.guest_name;
  const staffId = c.get('staff').id;
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT OR IGNORE INTO bill_series (entity_id, fy, next_no) VALUES (?, ?, 1)', e.id, fy),
      // Its number: the billing name's letter, the date printed (YYMMDD, India time) and the next number of that day
      // (C261119001); the yearly running number (seq) is taken too. All in this one batch, so no number is skipped.
      stmt(c.env.DB, `INSERT INTO bills (id, business_id, order_id, entity_id, fy, seq, bill_no, shift_day, printed_at, printed_by, gross_paise, discount_paise,
          discount_reason, taxable_paise, nongst_paise, gst_rate_bp, cgst_paise, sgst_paise, round_off_paise, total_paise, guest_name, print_day, day_seq, guest_phone)
        SELECT ?, ?, ?, ?, ?, s.next_no, ? || ? || printf('%03d', d.n), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, d.n, ?
        FROM bill_series s, (SELECT coalesce(max(day_seq), 0) + 1 AS n FROM bills WHERE entity_id = ? AND print_day = ?) d WHERE s.entity_id = ? AND s.fy = ?`,
        id, bid, o.id, e.id, fy, e.series_prefix, yymmdd, shiftDay, t, staffId, totals.grossPaise, totals.discountPaise, discountReason,
        totals.taxablePaise, totals.nonGstPaise, e.gst_rate_bp, totals.cgstPaise, totals.sgstPaise, totals.roundOffPaise, totals.totalPaise, guest, printDay, o.guest_phone,
        e.id, printDay, e.id, fy),
      stmt(c.env.DB, 'UPDATE bill_series SET next_no = next_no + 1 WHERE entity_id = ? AND fy = ?', e.id, fy),
      ...ls.map((l) => {
        const tx = lineTax(l.id);
        return stmt(c.env.DB, `INSERT INTO bill_lines (id, business_id, bill_id, item_id, name, sac, qty, rate_paise, amount_paise, taxed, options, tax_kind, gst_bp, price_by, discount_paise)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(), bid, id, l.item_id, l.name, l.sac, l.qty, l.price_paise, l.qty * l.price_paise, tx.kind === 'gst' ? 1 : 0, l.options,
          tx.kind, tx.kind === 'gst' ? tx.bp : null, l.price_by, lineDisc.get(l.id) ?? 0);
      }),
      ...totals.taxes.map((x) => stmt(c.env.DB, 'INSERT INTO bill_taxes (bill_id, business_id, kind, gst_bp, value_paise, cgst_paise, sgst_paise) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, bid, x.kind, x.bp, x.valuePaise, x.cgstPaise, x.sgstPaise)),
      stmt(c.env.DB, "UPDATE orders SET status = 'billed' WHERE id = ?", o.id),
      // The exceptions report, in the same batch: the discount takes its bill number from the row just written.
      ...(totals.discountPaise > 0 ? [stmt(c.env.DB, `INSERT INTO pos_events (business_id, kind, ref, amount_paise, reason, detail, by_staff, shift_day, at)
        SELECT ?, 'discount', bill_no, ?, ?, ?, ?, ?, ? FROM bills WHERE id = ?`, bid, totals.discountPaise, discountReason,
        [lineDisc.size ? `Items: ${ls.filter((l) => lineDisc.has(l.id)).map((l) => `${l.name} ${freeItems.includes(l) ? 'free' : rs(lineDisc.get(l.id)!) + ' off'}`).join(', ')}` : '',
          approver ? `Approved by ${approver.name}` : ''].filter(Boolean).join(' · ') || null, staffId, shiftDay, t, id)] : []),
      ...(will !== was ? [event(c.env.DB, bid, 'limit_warning', e.name, year + totals.totalPaise, null, `${e.name} reached ${rs(year + totals.totalPaise)} billed in ${fy}`, staffId, shiftDay)] : []),
    ]);
  } catch (err) {
    if (isTrigger(err, 'UNIQUE constraint failed')) fail(409, 'Another bill was printed at the same moment. Try again.');
    throw err;
  }
  const warning = will === 'warn1' || will === 'warn2' ? `${e.name} has ${rs(year + totals.totalPaise)} billed in ${fy}${e.stop_paise ? `; it stops at ${rs(e.stop_paise)}` : ''}.` : null;
  return c.json({ bill: await billOut(c.env.DB, bid, id), warning }, 201);
});

export async function billOut(db: D1Database, bid: string, id: string) {
  const b = await one<Record<string, unknown> & { entity_id: string }>(db, `SELECT b.id, b.bill_no AS billNo, b.order_id AS orderId, b.shift_day AS shiftDay, b.printed_at AS printedAt,
      b.gross_paise AS grossPaise, b.discount_paise AS discountPaise, b.discount_reason AS discountReason, b.taxable_paise AS taxablePaise,
      b.nongst_paise AS nonGstPaise, b.gst_rate_bp AS gstRateBp, b.cgst_paise AS cgstPaise, b.sgst_paise AS sgstPaise, b.round_off_paise AS roundOffPaise, b.total_paise AS totalPaise,
      b.guest_name AS guestName, b.status, b.print_count AS printCount, b.void_reason AS voidReason, b.entity_id,
      e.name AS entityName, e.gst_registered AS gstRegistered, e.gstin, o.place, st.name AS printedBy
    FROM bills b JOIN billing_entities e ON e.id = b.entity_id JOIN orders o ON o.id = b.order_id LEFT JOIN staff st ON st.id = b.printed_by
    WHERE b.id = ? AND b.business_id = ?`, id, bid);
  if (!b) fail(404, 'Bill not found.');
  const [items, creditNotes, pays, differences, taxRows] = await Promise.all([
    all<Record<string, unknown> & { options: string | null }>(db, `SELECT id, name, sac, qty, rate_paise AS ratePaise, amount_paise AS amountPaise, discount_paise AS discountPaise, taxed, options,
      coalesce(tax_kind, CASE WHEN taxed = 1 THEN 'gst' ELSE 'liquor' END) AS taxKind, gst_bp AS gstBp, price_by IS NOT NULL AS typedPrice FROM bill_lines WHERE bill_id = ? ORDER BY rowid`, id),
    all(db, `SELECT id, cn_no AS cnNo, reason, lines, total_paise AS totalPaise, refund_mode AS refundMode, at FROM credit_notes WHERE bill_id = ? ORDER BY seq`, id),
    all(db, `SELECT p.id, p.mode, p.shift_day AS shiftDay, a.amount_paise AS amountPaise, p.card_last4 AS cardLast4, p.card_approval AS cardApproval, pa.name AS payAccount,
      d.name AS debtorAccount, p.comp_guest AS compGuest, p.comp_reason AS compReason, p.tendered_paise AS tenderedPaise
    FROM allocations a JOIN payments p ON p.id = a.payment_id LEFT JOIN pay_accounts pa ON pa.id = p.pay_account_id LEFT JOIN debtor_accounts d ON d.id = p.debtor_account_id
    WHERE a.bill_id = ? ORDER BY p.at, p.rowid`, id),
    all(db, `SELECT d.kind, d.amount_paise AS amountPaise, d.reason, p.mode FROM settle_differences d LEFT JOIN payments p ON p.id = d.payment_id
    WHERE d.bill_id = ? OR (d.kind = 'tip' AND d.settlement_id = (SELECT settlement_id FROM bills WHERE id = ?)) ORDER BY d.rowid`, id, id),
    all<{ kind: TaxRow['kind']; bp: number; valuePaise: number; cgstPaise: number; sgstPaise: number }>(db,
      `SELECT kind, gst_bp AS bp, value_paise AS valuePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise FROM bill_taxes WHERE bill_id = ? ORDER BY CASE kind WHEN 'gst' THEN 0 WHEN 'liquor' THEN 1 ELSE 2 END, gst_bp`, id),
  ]);
  const { entity_id, ...rest } = b;
  const taxes = billTaxRows(b as unknown as { gstRateBp: number; taxablePaise: number; nonGstPaise: number; cgstPaise: number; sgstPaise: number }, taxRows);
  return { ...rest, entityId: entity_id, items: items.map((i) => ({ ...i, gstBp: i.gstBp ?? (i.taxKind === 'gst' ? b.gstRateBp : null), options: i.options ? JSON.parse(i.options) : [] })),
    taxes, payments: pays, differences, creditNotes: creditNotes.map((n) => ({ ...n, lines: JSON.parse(String(n.lines)) })) };
}

// One search for the counter (22 Nov 2026): a bill number (or its end), a guest name, 4 or more digits of a phone, or a
// table or room. Open orders, tabs and unpaid bills first; then bills, newest first: the last 90 days for cashiers, all
// for managers and owners. Phones come back as their last 4 digits only.
orderRoutes.get(`${B}/search`, requireAction('bills.print'), async (c) => {
  const bid = c.get('businessId');
  const raw = (c.req.query('q') ?? '').trim();
  if (raw.length < 2 || raw.length > 40) fail(400, 'Type at least 2 letters or digits.');
  const like = `%${raw.toLowerCase().replace(/[%_]/g, '')}%`;
  const digits = raw.replace(/\D/g, '');
  const phone = digits.length >= 4 ? `%${digits}%` : null;
  const since = isManager(c) ? 0 : Date.now() - 90 * 86_400_000;
  const [open, bills] = await Promise.all([
    all<{ id: string; place: string; status: string; guest_name: string | null; guest_phone: string | null; opened_at: number; bill_id: string | null; bill_no: string | null; total: number | null; items: number }>(c.env.DB, `
      SELECT o.id, o.place, o.status, o.guest_name, o.guest_phone, o.opened_at, b.id AS bill_id, b.bill_no, b.total_paise AS total,
        (SELECT coalesce(sum(l.qty * l.price_paise), 0) FROM order_lines l WHERE l.order_id = o.id) AS items
      FROM orders o LEFT JOIN bills b ON b.order_id = o.id AND b.status = 'printed'
      WHERE o.business_id = ? AND o.status IN ('open', 'tab', 'billed')
        AND (lower(o.place) LIKE ? OR lower(coalesce(o.guest_name, '')) LIKE ? OR lower(coalesce(b.bill_no, '')) LIKE ? OR (? IS NOT NULL AND o.guest_phone LIKE ?))
      ORDER BY o.opened_at DESC LIMIT 20`, bid, like, like, like, phone, phone),
    all<{ id: string; bill_no: string; status: string; total: number; printed_at: number; place: string; guest_name: string | null; guest_phone: string | null; modes: string | null }>(c.env.DB, `
      SELECT b.id, b.bill_no, b.status, b.total_paise AS total, b.printed_at, o.place, coalesce(b.guest_name, o.guest_name) AS guest_name,
        coalesce(b.guest_phone, o.guest_phone) AS guest_phone,
        (SELECT group_concat(DISTINCT p.mode) FROM allocations a JOIN payments p ON p.id = a.payment_id WHERE a.bill_id = b.id) AS modes
      FROM bills b JOIN orders o ON o.id = b.order_id
      WHERE b.business_id = ? AND b.printed_at >= ? AND b.status <> 'printed'
        AND (lower(b.bill_no) LIKE ? OR lower(o.place) LIKE ? OR lower(coalesce(b.guest_name, o.guest_name, '')) LIKE ?
          OR (? IS NOT NULL AND coalesce(b.guest_phone, o.guest_phone) LIKE ?))
      ORDER BY b.printed_at DESC LIMIT 30`, bid, since, like, like, like, phone, phone),
  ]);
  return c.json({ days: isManager(c) ? null : 90,
    open: open.map((o) => ({ id: o.id, place: o.place, status: o.status, guestName: o.guest_name, phone: maskPhone(o.guest_phone), openedAt: o.opened_at,
      billId: o.bill_id, billNo: o.bill_no, amountPaise: o.total ?? o.items })),
    bills: bills.map((b) => ({ id: b.id, billNo: b.bill_no, status: b.status, totalPaise: b.total, printedAt: b.printed_at, place: b.place, guestName: b.guest_name,
      phone: maskPhone(b.guest_phone), modes: b.modes ? b.modes.split(',') : [] })) });
});

// Finds a bill by its number (the end of it is enough, e.g. "418"): the most recent first.
orderRoutes.get(`${B}/bills`, requireAction('bills.print'), async (c) => {
  const no = (c.req.query('no') ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9/-]{1,16}$/.test(no)) fail(400, 'Type a bill number.');
  return c.json({ bills: await all(c.env.DB, `SELECT b.id, b.bill_no AS billNo, b.status, b.total_paise AS totalPaise, b.printed_at AS printedAt, o.place
    FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.business_id = ? AND (b.bill_no = ? OR b.bill_no LIKE ?) ORDER BY b.printed_at DESC LIMIT 10`,
    c.get('businessId'), no, `%${no}`) });
});

orderRoutes.get(`${B}/bills/:id`, requireAction('pos.view'), async (c) => {
  if (!isUuid(c.req.param('id'))) fail(404, 'Bill not found.');
  return c.json({ bill: await billOut(c.env.DB, c.get('businessId'), c.req.param('id')) });
});

// Void: only a printed bill not yet paid. Its number stays used (shown as void); the order opens again to be billed afresh.
orderRoutes.post(`${B}/bills/:id/void`, requireAction('bills.void'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Bill not found.');
  const bill = await one<{ bill_no: string; order_id: string; total_paise: number; status: string; shift_day: string }>(c.env.DB,
    'SELECT bill_no, order_id, total_paise, status, shift_day FROM bills WHERE id = ? AND business_id = ?', id, bid);
  if (!bill) fail(404, 'Bill not found.');
  if (bill.status !== 'printed') fail(409, bill.status === 'void' ? 'This bill is already void.' : 'This bill is paid. A paid bill is corrected with a credit note, not voided.');
  const reason = await reasonLabel(c.env.DB, bid, 'void', (await body(c)).reasonId, 'A reason for the void');
  const staffId = c.get('staff').id;
  const t = now();
  const { shiftDay } = clock(bizOf(c), t);
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE bills SET status = 'void', void_reason = ?, void_by = ?, void_at = ? WHERE id = ? AND status = 'printed'", reason, staffId, t, id),
    stmt(c.env.DB, "UPDATE orders SET status = 'open' WHERE id = ?", bill.order_id),
    event(c.env.DB, bid, 'void', bill.bill_no, bill.total_paise, reason, null, staffId, shiftDay),
    stmt(c.env.DB, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'bill_void', ?, ?)", newId(), bid,
      JSON.stringify({ billId: id, billNo: bill.bill_no, shiftDay: bill.shift_day, totalPaise: bill.total_paise, reason, voidedAt: t }), t),
  ]);
  sendSoon(c, bid);
  return c.json({ ok: true });
});

orderRoutes.post(`${B}/bills/:id/reprint`, requireAction('bills.print'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Bill not found.');
  const bill = await one<{ bill_no: string; total_paise: number; status: string }>(c.env.DB, 'SELECT bill_no, total_paise, status FROM bills WHERE id = ? AND business_id = ?', id, bid);
  if (!bill) fail(404, 'Bill not found.');
  if (bill.status === 'void') fail(409, 'A void bill is not reprinted.');
  const reason = text(await body(c), 'reason', 'Reason for the reprint', { optional: true, max: 80 }) ?? 'Copy';
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE bills SET print_count = print_count + 1 WHERE id = ?', id),
    event(c.env.DB, bid, 'reprint', bill.bill_no, bill.total_paise, reason, null, c.get('staff').id, clock(bizOf(c)).shiftDay),
  ]);
  return c.json({ bill: await billOut(c.env.DB, bid, id) });
});
