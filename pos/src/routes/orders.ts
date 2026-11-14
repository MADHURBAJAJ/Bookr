// Orders, KOTs, tabs and bills. A bill is printed once from an order whose lines have all gone to the kitchen; its number
// comes from its billing name's series in the same batch, so numbers have no gaps. A printed bill never changes: a mistake
// is voided with a reason (the order opens again) and billed again, perhaps under another billing name.
import { Hono } from 'hono';
import { all, newId, now, one, stmt } from '../../../src/db';
import { body, fail, isUuid, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { billTotals, limitState, rs, type Discount } from '../billing';
import { clock, event, isTrigger, loadBusiness, reasonLabel } from '../util';
import type { AppEnv } from '../types';

export const orderRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
orderRoutes.use(`${B}/*`, requireStaff);

interface OrderRow { id: string; kind: string; place: string; stay_id: string | null; guest_name: string | null; covers: number | null; status: string; opened_at: number; opened_shift_day: string }
interface LineRow { id: string; item_id: string; name: string; price_paise: number; sac: string; station: string; qty: number; sent_qty: number }

async function order(c: { env: { DB: D1Database } }, bid: string, id: string, editable = false): Promise<OrderRow> {
  if (!isUuid(id)) fail(404, 'Order not found.');
  const o = await one<OrderRow>(c.env.DB, 'SELECT id, kind, place, stay_id, guest_name, covers, status, opened_at, opened_shift_day FROM orders WHERE id = ? AND business_id = ?', id, bid);
  if (!o) fail(404, 'Order not found.');
  if (editable && o.status !== 'open' && o.status !== 'tab') fail(409, 'This order is already billed. Void the bill first to change it.');
  return o;
}

const lines = (db: D1Database, orderId: string) =>
  all<LineRow>(db, 'SELECT id, item_id, name, price_paise, sac, station, qty, sent_qty FROM order_lines WHERE order_id = ? ORDER BY created_at', orderId);

function orderOut(o: OrderRow, ls: LineRow[], bill: unknown = null) {
  return {
    id: o.id, kind: o.kind, place: o.place, stayId: o.stay_id, guestName: o.guest_name, covers: o.covers, status: o.status,
    openedAt: o.opened_at, openedShiftDay: o.opened_shift_day,
    lines: ls.filter((l) => l.qty > 0).map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, pricePaise: l.price_paise, qty: l.qty, sentQty: l.sent_qty })),
    itemsPaise: ls.reduce((s, l) => s + l.qty * l.price_paise, 0), bill,
  };
}

// Open orders and tabs (with their lines), and bills printed but not yet paid: the counter's main screen.
orderRoutes.get(`${B}/orders`, requireAction('pos.view'), async (c) => {
  const bid = c.get('businessId');
  const os = await all<OrderRow>(c.env.DB, "SELECT id, kind, place, stay_id, guest_name, covers, status, opened_at, opened_shift_day FROM orders WHERE business_id = ? AND status IN ('open', 'tab', 'billed') ORDER BY opened_at", bid);
  const ls = await all<LineRow & { order_id: string }>(c.env.DB, "SELECT l.order_id, l.id, l.item_id, l.name, l.price_paise, l.sac, l.station, l.qty, l.sent_qty FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.business_id = ? AND o.status IN ('open', 'tab', 'billed')", bid);
  const bills = await all<{ id: string; order_id: string; bill_no: string; total_paise: number; entity_id: string }>(c.env.DB,
    "SELECT id, order_id, bill_no, total_paise, entity_id FROM bills WHERE business_id = ? AND status = 'printed'", bid);
  return c.json({ orders: os.map((o) => {
    const b = bills.find((x) => x.order_id === o.id);
    return orderOut(o, ls.filter((l) => l.order_id === o.id), b ? { id: b.id, billNo: b.bill_no, totalPaise: b.total_paise, entityId: b.entity_id } : null);
  }) });
});

orderRoutes.post(`${B}/orders`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const b = await loadBusiness(c.env.DB, bid);
  const data = await body(c);
  const kind = data.kind;
  if (kind !== 'table' && kind !== 'room' && kind !== 'takeaway') fail(400, 'Order kind must be table, room or takeaway.');
  let place = kind === 'takeaway' ? 'Takeaway' : text(data, 'place', kind === 'room' ? 'Room' : 'Table', { max: 40 })!;
  let stayId: string | null = null;
  let guest = text(data, 'guestName', 'Guest name', { optional: true, max: 80 });
  if (kind === 'room') {
    stayId = text(data, 'stayId', 'Stay')!;
    const s = await one<{ room: string; guest_name: string }>(c.env.DB, 'SELECT room, guest_name FROM stays WHERE id = ? AND business_id = ? AND checked_out_at IS NULL', stayId, bid);
    if (!s) fail(400, 'That room has no open stay.');
    place = `Room ${s.room}`;
    guest ??= s.guest_name;
  }
  if (kind === 'table' && (await one(c.env.DB, "SELECT 1 FROM orders WHERE business_id = ? AND kind = 'table' AND lower(place) = lower(?) AND status = 'open'", bid, place))) {
    fail(409, `${place} already has an open order.`);
  }
  const covers = typeof data.covers === 'number' && Number.isInteger(data.covers) && data.covers > 0 && data.covers < 100 ? data.covers : null;
  const id = newId();
  const { t, shiftDay } = clock(b);
  await stmt(c.env.DB, 'INSERT INTO orders (id, business_id, kind, place, stay_id, guest_name, covers, opened_by, opened_at, opened_shift_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, bid, kind, place, stayId, guest, covers, c.get('staff').id, t, shiftDay).run();
  return c.json({ id }, 201);
});

orderRoutes.get(`${B}/orders/:id`, requireAction('pos.view'), async (c) => {
  const o = await order(c, c.get('businessId'), c.req.param('id'));
  return c.json({ order: orderOut(o, await lines(c.env.DB, o.id)) });
});

// Adds or takes away items. Taking away an item already sent to the kitchen needs a reason and goes on the exceptions report.
orderRoutes.post(`${B}/orders/:id/items`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const o = await order(c, bid, c.req.param('id'), true);
  const data = await body(c);
  const itemId = text(data, 'itemId', 'Item')!;
  const delta = data.delta;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 50) fail(400, 'Change must be a whole number of items.');
  const line = await one<LineRow>(c.env.DB, 'SELECT id, item_id, name, price_paise, sac, station, qty, sent_qty FROM order_lines WHERE order_id = ? AND item_id = ?', o.id, itemId);
  const t = now();
  if (delta > 0) {
    if (line) {
      await stmt(c.env.DB, 'UPDATE order_lines SET qty = qty + ? WHERE id = ?', delta, line.id).run();
    } else {
      const item = await one<{ name: string; price_paise: number; sac: string; station: string }>(c.env.DB,
        'SELECT name, price_paise, sac, station FROM menu_items WHERE id = ? AND business_id = ? AND active = 1', itemId, bid);
      if (!item) fail(400, 'Item not on the menu.');
      await stmt(c.env.DB, 'INSERT INTO order_lines (id, business_id, order_id, item_id, name, price_paise, sac, station, qty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), bid, o.id, itemId, item.name, item.price_paise, item.sac, item.station, delta, t).run();
    }
  } else {
    if (!line || line.qty + delta < 0) fail(400, 'There are not that many on the order.');
    const newQty = line.qty + delta;
    const cancelSent = Math.max(0, line.sent_qty - newQty);
    const statements = [stmt(c.env.DB, 'UPDATE order_lines SET qty = ?, sent_qty = ? WHERE id = ?', newQty, Math.min(line.sent_qty, newQty), line.id)];
    if (cancelSent > 0) {
      const reason = await reasonLabel(c.env.DB, bid, 'kot_cancel', data.reasonId, 'A reason for cancelling an item already sent to the kitchen');
      statements.push(event(c.env.DB, bid, 'kot_cancel', `${o.place} · ${cancelSent} × ${line.name}`, cancelSent * line.price_paise, reason, null,
        c.get('staff').id, clock(await loadBusiness(c.env.DB, bid)).shiftDay));
    }
    await c.env.DB.batch(statements);
    return c.json({ order: orderOut(o, await lines(c.env.DB, o.id)), cancelledSent: cancelSent });
  }
  return c.json({ order: orderOut(o, await lines(c.env.DB, o.id)) });
});

// Sends what is new to the kitchen and bar: one KOT per station, numbered for the business.
orderRoutes.post(`${B}/orders/:id/kot`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const o = await order(c, bid, c.req.param('id'), true);
  const ls = (await lines(c.env.DB, o.id)).filter((l) => l.qty > l.sent_qty);
  if (!ls.length) fail(409, 'Nothing new to send.');
  const t = now();
  const stations = [...new Set(ls.map((l) => l.station))];
  const ids = stations.map(() => newId());
  await c.env.DB.batch([
    ...stations.map((st, i) => stmt(c.env.DB, `INSERT INTO kots (id, business_id, order_id, kot_no, station, lines, by_staff, printed_at)
      SELECT ?, ?, ?, coalesce(max(kot_no), 0) + 1, ?, ?, ?, ? FROM kots WHERE business_id = ?`,
      ids[i], bid, o.id, st, JSON.stringify(ls.filter((l) => l.station === st).map((l) => ({ name: l.name, qty: l.qty - l.sent_qty }))), c.get('staff').id, t, bid)),
    ...ls.map((l) => stmt(c.env.DB, 'UPDATE order_lines SET sent_qty = qty WHERE id = ?', l.id)),
  ]);
  const kots = await all<{ kot_no: number; station: string; lines: string }>(c.env.DB, `SELECT kot_no, station, lines FROM kots WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY kot_no`, ...ids);
  return c.json({ kots: kots.map((k) => ({ kotNo: k.kot_no, station: k.station, place: o.place, lines: JSON.parse(k.lines) })) }, 201);
});

// Keeps the order open as a tab across shifts (for guests not in a room). It is billed when the guest settles.
orderRoutes.post(`${B}/orders/:id/tab`, requireAction('orders.edit'), async (c) => {
  const bid = c.get('businessId');
  const o = await order(c, bid, c.req.param('id'), true);
  const data = await body(c);
  const guest = text(data, 'guestName', 'Guest name for the tab', { optional: !!o.guest_name, max: 80 }) ?? o.guest_name!;
  const ls = await lines(c.env.DB, o.id);
  if (ls.some((l) => l.qty > l.sent_qty)) fail(409, 'Send the new items to the kitchen first.');
  await stmt(c.env.DB, "UPDATE orders SET status = 'tab', guest_name = ? WHERE id = ?", guest, o.id).run();
  return c.json({ ok: true });
});

// An order with nothing sent to the kitchen can be dropped (a table that left before ordering).
orderRoutes.post(`${B}/orders/:id/cancel`, requireAction('orders.edit'), async (c) => {
  const o = await order(c, c.get('businessId'), c.req.param('id'), true);
  if ((await lines(c.env.DB, o.id)).some((l) => l.sent_qty > 0)) fail(409, 'Items have gone to the kitchen. Cancel them one by one with a reason, or bill the order.');
  await stmt(c.env.DB, "UPDATE orders SET status = 'cancelled' WHERE id = ?", o.id).run();
  return c.json({ ok: true });
});

interface Entity { id: string; name: string; gst_rate_bp: number; series_prefix: string; offered: number; active: number; warn1_paise: number | null; warn2_paise: number | null; stop_paise: number | null }

// Prints the bill: the cashier chooses the billing name (the default is preselected on screen) and any discount, with its reason.
orderRoutes.post(`${B}/orders/:id/bill`, requireAction('bills.print'), async (c) => {
  const bid = c.get('businessId');
  const b = await loadBusiness(c.env.DB, bid);
  const o = await order(c, bid, c.req.param('id'), true);
  const ls = (await lines(c.env.DB, o.id)).filter((l) => l.qty > 0);
  if (!ls.length) fail(409, 'The order has no items.');
  if (ls.some((l) => l.qty > l.sent_qty)) fail(409, 'Send the new items to the kitchen first.');
  const data = await body(c);
  const entityId = text(data, 'entityId', 'Billing name')!;
  const e = await one<Entity>(c.env.DB, 'SELECT id, name, gst_rate_bp, series_prefix, offered, active, warn1_paise, warn2_paise, stop_paise FROM billing_entities WHERE id = ? AND business_id = ?', entityId, bid);
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
  let totals;
  try { totals = billTotals(ls.map((l) => ({ qty: l.qty, pricePaise: l.price_paise })), discount, e.gst_rate_bp); } catch { fail(400, 'The discount is more than the bill.'); }
  const discountReason = totals.discountPaise > 0 ? await reasonLabel(c.env.DB, bid, 'discount', d.reasonId, 'A reason for the discount') : null;

  const { t, shiftDay, fy } = clock(b);
  const year = (await one<{ s: number }>(c.env.DB, "SELECT coalesce(sum(total_paise), 0) AS s FROM bills WHERE entity_id = ? AND fy = ? AND status <> 'void'", e.id, fy))!.s;
  const was = limitState(e, year);
  const will = limitState(e, year, totals.totalPaise);
  if (will === 'stop') fail(409, `${e.name} would pass its stop point for ${fy} (${rs(year)} billed so far). Choose another billing name.`);

  const id = newId();
  const short = fy.length === 7 ? fy.slice(2, 4) + fy.slice(5, 7) : fy.slice(2);
  const guest = text(data, 'guestName', 'Guest name', { optional: true, max: 80 }) ?? o.guest_name;
  const staffId = c.get('staff').id;
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT OR IGNORE INTO bill_series (entity_id, fy, next_no) VALUES (?, ?, 1)', e.id, fy),
      stmt(c.env.DB, `INSERT INTO bills (id, business_id, order_id, entity_id, fy, seq, bill_no, shift_day, printed_at, printed_by, gross_paise, discount_paise,
          discount_reason, taxable_paise, gst_rate_bp, cgst_paise, sgst_paise, round_off_paise, total_paise, guest_name)
        SELECT ?, ?, ?, ?, ?, next_no, ? || '-' || ? || '-' || printf('%05d', next_no), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM bill_series WHERE entity_id = ? AND fy = ?`,
        id, bid, o.id, e.id, fy, e.series_prefix, short, shiftDay, t, staffId, totals.grossPaise, totals.discountPaise, discountReason,
        totals.taxablePaise, e.gst_rate_bp, totals.cgstPaise, totals.sgstPaise, totals.roundOffPaise, totals.totalPaise, guest, e.id, fy),
      stmt(c.env.DB, 'UPDATE bill_series SET next_no = next_no + 1 WHERE entity_id = ? AND fy = ?', e.id, fy),
      ...ls.map((l) => stmt(c.env.DB, 'INSERT INTO bill_lines (id, business_id, bill_id, item_id, name, sac, qty, rate_paise, amount_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), bid, id, l.item_id, l.name, l.sac, l.qty, l.price_paise, l.qty * l.price_paise)),
      stmt(c.env.DB, "UPDATE orders SET status = 'billed' WHERE id = ?", o.id),
    ]);
  } catch (err) {
    if (isTrigger(err, 'UNIQUE constraint failed')) fail(409, 'Another bill was printed at the same moment. Try again.');
    throw err;
  }
  const billNo = (await one<{ bill_no: string }>(c.env.DB, 'SELECT bill_no FROM bills WHERE id = ?', id))!.bill_no;
  const later = [];
  if (totals.discountPaise > 0) later.push(event(c.env.DB, bid, 'discount', billNo, totals.discountPaise, discountReason, null, staffId, shiftDay));
  if (will !== was) later.push(event(c.env.DB, bid, 'limit_warning', e.name, year + totals.totalPaise, null, `${e.name} reached ${rs(year + totals.totalPaise)} billed in ${fy}`, staffId, shiftDay));
  if (later.length) await c.env.DB.batch(later);
  const warning = will === 'warn1' || will === 'warn2' ? `${e.name} has ${rs(year + totals.totalPaise)} billed in ${fy}${e.stop_paise ? `; it stops at ${rs(e.stop_paise)}` : ''}.` : null;
  return c.json({ bill: await billOut(c.env.DB, bid, id), warning }, 201);
});

export async function billOut(db: D1Database, bid: string, id: string) {
  const b = await one<Record<string, unknown> & { entity_id: string }>(db, `SELECT b.id, b.bill_no AS billNo, b.order_id AS orderId, b.shift_day AS shiftDay, b.printed_at AS printedAt,
      b.gross_paise AS grossPaise, b.discount_paise AS discountPaise, b.discount_reason AS discountReason, b.taxable_paise AS taxablePaise,
      b.gst_rate_bp AS gstRateBp, b.cgst_paise AS cgstPaise, b.sgst_paise AS sgstPaise, b.round_off_paise AS roundOffPaise, b.total_paise AS totalPaise,
      b.guest_name AS guestName, b.status, b.print_count AS printCount, b.void_reason AS voidReason, b.entity_id,
      e.name AS entityName, e.gst_registered AS gstRegistered, e.gstin, o.place, st.name AS printedBy
    FROM bills b JOIN billing_entities e ON e.id = b.entity_id JOIN orders o ON o.id = b.order_id LEFT JOIN staff st ON st.id = b.printed_by
    WHERE b.id = ? AND b.business_id = ?`, id, bid);
  if (!b) fail(404, 'Bill not found.');
  const items = await all(db, 'SELECT name, sac, qty, rate_paise AS ratePaise, amount_paise AS amountPaise FROM bill_lines WHERE bill_id = ?', id);
  const pays = await all(db, `SELECT p.mode, a.amount_paise AS amountPaise, p.card_last4 AS cardLast4, p.card_approval AS cardApproval, pa.name AS payAccount,
      d.name AS debtorAccount, p.comp_guest AS compGuest, p.comp_reason AS compReason, p.tendered_paise AS tenderedPaise
    FROM allocations a JOIN payments p ON p.id = a.payment_id LEFT JOIN pay_accounts pa ON pa.id = p.pay_account_id LEFT JOIN debtor_accounts d ON d.id = p.debtor_account_id
    WHERE a.bill_id = ? ORDER BY p.at, p.rowid`, id);
  const { entity_id, ...rest } = b;
  return { ...rest, entityId: entity_id, items, payments: pays };
}

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
  const { shiftDay } = clock(await loadBusiness(c.env.DB, bid), t);
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE bills SET status = 'void', void_reason = ?, void_by = ?, void_at = ? WHERE id = ? AND status = 'printed'", reason, staffId, t, id),
    stmt(c.env.DB, "UPDATE orders SET status = 'open' WHERE id = ?", bill.order_id),
    event(c.env.DB, bid, 'void', bill.bill_no, bill.total_paise, reason, null, staffId, shiftDay),
    stmt(c.env.DB, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'bill_void', ?, ?)", newId(), bid,
      JSON.stringify({ billId: id, billNo: bill.bill_no, shiftDay: bill.shift_day, totalPaise: bill.total_paise, reason, voidedAt: t }), t),
  ]);
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
    event(c.env.DB, bid, 'reprint', bill.bill_no, bill.total_paise, reason, null, c.get('staff').id, clock(await loadBusiness(c.env.DB, bid)).shiftDay),
  ]);
  return c.json({ bill: await billOut(c.env.DB, bid, id) });
});
