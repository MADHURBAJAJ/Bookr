// Rooms, after the hotel manager's audit (25 Nov 2026): moving a room's balance to a company or another room, room credit
// notes, no-shows, the night audit, extending a stay, Form C, the guest register and past stays, housekeeping, and room
// moves. All check the role per business on the server; ID numbers are only ever kept as their last 4 characters.
import { Hono } from 'hono';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../../../src/db';
import { body, fail, isUuid, paise, text } from '../../../src/http';
import { approval, isManager, requireAction, requireStaff } from '../auth';
import { audit, bizOf, clock, isTrigger, tableLayout } from '../util';
import { phoneKey, openStay, stayBill } from './settings';
import { notInDjubo, addDays } from './frontdesk';
import { sendSoon } from '../sync';
import type { AppEnv } from '../types';

export const roomDeskRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
roomDeskRoutes.use(`${B}/*`, requireStaff);

const rupeesText = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const balanceOf = async (db: DB, accountId: string) => (await one<{ s: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS s FROM debtor_entries WHERE account_id = ?', accountId))!.s;
const dirtyUpsert = (db: DB, bid: string, room: string, status: string, staffId: string, t: number, note: string | null = null) => stmt(db,
  `INSERT INTO room_status (business_id, room, status, note, by_staff, at) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT (business_id, room) DO UPDATE SET status = excluded.status, note = excluded.note, by_staff = excluded.by_staff, at = excluded.at`, bid, room, status, note, staffId, t);

// ---------- 2, 14: a room's balance moved to a company's credit account, or to another room (a group paying together)

roomDeskRoutes.post(`${B}/stays/:id/transfer`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const s = await openStay(c, c.req.param('id'));
  if (s.checked_out_at) fail(409, 'This guest has checked out.');
  const data = await body(c);
  const bal = await balanceOf(db, s.account_id);
  if (bal <= 0) fail(409, 'Nothing is owed on this room.');
  const amount = data.amount === undefined || data.amount === '' ? bal : paise(data, 'amount', 'Amount');
  if (amount <= 0 || amount > bal) fail(400, `Move up to ${rupeesText(bal)}.`);
  const staff = c.get('staff');
  const t = now();
  const from = `Room ${s.room} · ${s.guest_name}`;
  let target: { id: string; name: string } | null = null;
  const pre = [];
  let approvedBy = '';
  if (data.to === 'room') {
    const other = await one<{ account_id: string; room: string; guest_name: string }>(db, `SELECT d.id AS account_id, s.room, s.guest_name FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id
      WHERE s.id = ? AND s.business_id = ? AND s.checked_out_at IS NULL`, typeof data.stayId === 'string' && isUuid(data.stayId) ? data.stayId : null, bid);
    if (!other || other.account_id === s.account_id) fail(400, 'Choose another room that is checked in.');
    target = { id: other.account_id, name: `Room ${other.room} · ${other.guest_name}` };
  } else if (data.to === 'credit') {
    if (data.newCredit && typeof data.newCredit === 'object') {
      const nc = data.newCredit as Record<string, unknown>;
      const phone = phoneKey(nc.phone);
      if (!phone) fail(400, 'Add the phone number for the new credit account.');
      const name = text(nc, 'name', 'Company or person', { max: 80 })!;
      const same = await one<{ id: string; name: string }>(db, "SELECT id, name FROM debtor_accounts WHERE business_id = ? AND kind = 'credit' AND phone = ?", bid, phone);
      if (same) target = same;
      else {
        const ap = await approval(c, data, 'A new credit account');
        if (!isManager(c)) approvedBy = ` · Approved by ${ap.name}`;
        const id = newId();
        pre.push(stmt(db, "INSERT INTO debtor_accounts (id, business_id, kind, name, phone, created_by, created_at) VALUES (?, ?, 'credit', ?, ?, ?, ?)", id, bid, name, phone, staff.id, t));
        target = { id, name };
      }
    } else {
      const a = await one<{ id: string; name: string; credit_limit_paise: number | null }>(db, "SELECT id, name, credit_limit_paise FROM debtor_accounts WHERE id = ? AND business_id = ? AND kind = 'credit'",
        typeof data.debtorAccountId === 'string' && isUuid(data.debtorAccountId) ? data.debtorAccountId : null, bid);
      if (!a) fail(400, 'Choose a credit account, or add a new one.');
      if (a.credit_limit_paise !== null && (await balanceOf(db, a.id)) + amount > a.credit_limit_paise) fail(409, `${a.name} would go over its credit limit of ${rupeesText(a.credit_limit_paise)}.`);
      target = a;
    }
  } else fail(400, 'Move it to a credit account or another room.');
  await db.batch([
    ...pre,
    stmt(db, "INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, note, by_staff, at) VALUES (?, ?, ?, 'transfer', ?, ?, ?, ?)",
      newId(), bid, s.account_id, -amount, `Moved to ${target!.name}${approvedBy}`.slice(0, 160), staff.id, t),
    stmt(db, "INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, note, by_staff, at) VALUES (?, ?, ?, 'transfer', ?, ?, ?, ?)",
      newId(), bid, target!.id, amount, `From ${from}`.slice(0, 160), staff.id, t),
    audit(db, bid, staff.id, 'stay.transfer', 'stays', s.id, null, { to: target!.name, amountPaise: amount }),
  ]);
  return c.json(await stayBill(c, s.id), 201);
});

// ---------- 4: a room credit note (rent given back on a room invoice), GST taken back at the invoice's rate

roomDeskRoutes.post(`${B}/room-invoices/:id/credit-note`, requireAction('bills.refund'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const id = c.req.param('id');
  const inv = await one<{ id: string; invoice_no: string; total_paise: number; gst_rate_bp: number; stay_id: string }>(db,
    'SELECT id, invoice_no, total_paise, gst_rate_bp, stay_id FROM room_invoices WHERE id = ? AND business_id = ?', isUuid(id) ? id : null, bid);
  if (!inv) fail(404, 'Room invoice not found.');
  const data = await body(c);
  const amount = paise(data, 'amount', 'Amount');
  const prior = (await one<{ s: number }>(db, 'SELECT coalesce(sum(total_paise), 0) AS s FROM room_credit_notes WHERE invoice_id = ?', inv.id))!.s;
  if (amount <= 0 || amount > inv.total_paise - prior) fail(400, `Up to ${rupeesText(inv.total_paise - prior)} can be given back on ${inv.invoice_no}.`);
  const reason = text(data, 'reason', 'A reason', { max: 120 })!;
  const mode = data.refundMode;
  if (mode !== 'cash' && mode !== 'upi' && mode !== 'none') fail(400, 'Say how it goes back: cash, UPI, or none (no money back).');
  const ap = await approval(c, data, 'A room credit note');
  const taxable = Math.round((amount * 10000) / (10000 + inv.gst_rate_bp));
  const cgst = Math.floor((amount - taxable) / 2);
  const sgst = amount - taxable - cgst;
  const { t, shiftDay, fy } = clock(bizOf(c));
  const staff = c.get('staff');
  const cnId = newId();
  const note = `Room credit note on ${inv.invoice_no} · ${reason}${isManager(c) ? '' : ` · Approved by ${ap.name}`}`.slice(0, 160);
  try {
    await db.batch([
      stmt(db, 'INSERT OR IGNORE INTO room_cn_series (business_id, fy, next_no) VALUES (?, ?, 1)', bid, fy),
      stmt(db, `INSERT INTO room_credit_notes (id, business_id, invoice_id, fy, seq, cn_no, shift_day, reason, taxable_paise, cgst_paise, sgst_paise, total_paise, refund_mode, by_staff, at)
        SELECT ?, ?, ?, ?, next_no, 'RCN/' || substr(?, 3) || '/' || printf('%04d', next_no), ?, ?, ?, ?, ?, ?, ?, ?, ? FROM room_cn_series WHERE business_id = ? AND fy = ?`,
        cnId, bid, inv.id, fy, fy, shiftDay, reason, taxable, cgst, sgst, amount, mode, staff.id, t, bid, fy),
      stmt(db, 'UPDATE room_cn_series SET next_no = next_no + 1 WHERE business_id = ? AND fy = ?', bid, fy),
      ...(mode === 'none' ? [] : [stmt(db, "INSERT INTO drawer_outs (id, business_id, kind, mode, amount_paise, note, shift_day, by_staff, at) VALUES (?, ?, 'paid_out', ?, ?, ?, ?, ?, ?)",
        newId(), bid, mode, amount, note, shiftDay, staff.id, t)]),
      audit(db, bid, staff.id, 'room_invoice.credit_note', 'room_invoices', inv.id, null, { amountPaise: amount, reason, mode }),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed.');
    throw e;
  }
  if (mode !== 'none') sendSoon(c, bid);
  const cn = (await one<{ cn_no: string }>(db, 'SELECT cn_no FROM room_credit_notes WHERE id = ?', cnId))!.cn_no;
  return c.json({ cnNo: cn, bill: await stayBill(c, inv.stay_id) }, 201);
});

// ---------- 5: no-shows (the guest never came): the booking or reservation leaves the board; an advance taken here is kept
// as the no-show charge, or waits to be given back.

async function noShowAdvances(db: DB, bid: string, where: string, ...args: unknown[]) {
  return all<{ id: string }>(db, `SELECT id FROM desk_advances WHERE business_id = ? AND status = 'held' AND ${where}`, bid, ...args);
}

roomDeskRoutes.post(`${B}/bookings/:id/no-show`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const k = await one<{ id: string; status: string; match_id: string | null; ext_ref: string }>(c.env.DB, 'SELECT id, status, match_id, ext_ref FROM bookings WHERE id = ? AND business_id = ?', isUuid(id) ? id : null, bid);
  if (!k) fail(404, 'Booking not found.');
  if (k.status === 'checked_in' || k.status === 'cancelled') fail(409, k.status === 'checked_in' ? 'This guest is checked in.' : 'This booking was cancelled.');
  const data = await body(c);
  const keep = data.advance === 'keep';
  const t = now();
  const adv = await noShowAdvances(c.env.DB, bid, '(booking_id = ? OR booking_id = ?)', k.id, k.match_id);
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE bookings SET status = 'cancelled', no_show_at = ?, problem = 'No-show', updated_at = ? WHERE business_id = ? AND (id = ?4 OR id = ?5) AND status <> 'checked_in'", t, t, bid, k.id, k.match_id),
    ...(keep ? adv.map((a) => stmt(c.env.DB, "UPDATE desk_advances SET status = 'kept', kept_at = ? WHERE id = ?", t, a.id)) : []),
    audit(c.env.DB, bid, c.get('staff').id, 'booking.no_show', 'bookings', k.id, null, { advance: keep ? 'kept' : 'to refund' }),
  ]);
  return c.json({ ok: true, advances: adv.length, kept: keep });
});

roomDeskRoutes.post(`${B}/reservations/:id/no-show`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const r = await one<{ id: string; status: string; stay_id: string | null }>(c.env.DB, 'SELECT id, status, stay_id FROM reservations WHERE id = ? AND business_id = ?', isUuid(id) ? id : null, bid);
  if (!r) fail(404, 'Reservation not found.');
  if (r.stay_id || r.status === 'cancelled') fail(409, r.stay_id ? 'This guest is checked in.' : 'This reservation was cancelled.');
  const data = await body(c);
  const keep = data.advance === 'keep';
  const t = now();
  const adv = await noShowAdvances(c.env.DB, bid, 'reservation_id = ?', r.id);
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE reservations SET status = 'cancelled', no_show_at = ?, cancel_reason = 'No-show' WHERE id = ?", t, r.id),
    ...(keep ? adv.map((a) => stmt(c.env.DB, "UPDATE desk_advances SET status = 'kept', kept_at = ? WHERE id = ?", t, a.id)) : []),
    audit(c.env.DB, bid, c.get('staff').id, 'reservation.no_show', 'reservations', r.id, null, { advance: keep ? 'kept' : 'to refund' }),
  ]);
  return c.json({ ok: true, advances: adv.length, kept: keep });
});

// ---------- 6: extending a stay (an overstay or an extra night), with rent for the extra nights

roomDeskRoutes.post(`${B}/stays/:id/extend`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const s = await openStay(c, c.req.param('id'));
  if (s.checked_out_at) fail(409, 'This guest has checked out.');
  const data = await body(c);
  const to = typeof data.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.to) ? data.to : fail(400, 'The new check-out must be a date.');
  const cur = await one<{ plan: string | null }>(c.env.DB, `SELECT coalesce(s.check_out_plan, (SELECT max(k.check_out) FROM bookings k WHERE k.stay_id = s.id)) AS plan FROM stays s WHERE s.id = ?`, s.id);
  const from = cur?.plan ?? clock(bizOf(c)).shiftDay;
  if (to <= from) fail(400, `The new check-out must be after ${from}.`);
  const nights = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const rate = data.rate === undefined || data.rate === '' ? null : paise(data, 'rate', 'Rate per night');
  const t = now();
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE stays SET check_out_plan = ? WHERE id = ?', to, s.id),
    ...(rate ? [stmt(c.env.DB, "INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, note, by_staff, at) VALUES (?, ?, ?, 'room_rent', ?, ?, ?, ?)",
      newId(), bid, s.account_id, rate * nights, `Room rent · ${nights} extra night${nights === 1 ? '' : 's'} × ${rupeesText(rate)}`, c.get('staff').id, t)] : []),
    audit(c.env.DB, bid, c.get('staff').id, 'stay.extend', 'stays', s.id, { checkOut: from }, { checkOut: to, ratePaise: rate }),
  ]);
  return c.json(await stayBill(c, s.id), 201);
});

// ---------- 8: Form C filed for a foreign guest

roomDeskRoutes.post(`${B}/stays/:id/form-c`, requireAction('stays.edit'), async (c) => {
  const s = await openStay(c, c.req.param('id'));
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE stays SET form_c_at = ?, foreign_info = json_set(coalesce(foreign_info, '{}'), '$.formC', json('true')) WHERE id = ?", now(), s.id),
    audit(c.env.DB, c.get('businessId'), c.get('staff').id, 'stay.form_c', 'stays', s.id, null, { filed: true }),
  ]);
  return c.json({ ok: true });
});

/** Foreign guests whose Form C is not filed: amber from check-in, red after 18 hours (it is due within 24). */
export async function formCPending(db: DB, bid: string, t = now()) {
  const rows = await all<{ id: string; room: string; guest_name: string; created_at: number }>(db, `SELECT id, room, guest_name, created_at FROM stays
    WHERE business_id = ? AND checked_out_at IS NULL AND foreign_info IS NOT NULL AND form_c_at IS NULL AND coalesce(json_extract(foreign_info, '$.formC'), 0) = 0`, bid);
  return rows.map((r) => { const hours = Math.floor((t - r.created_at) / 3_600_000); return { stayId: r.id, room: r.room, guestName: r.guest_name, hours, level: hours >= 18 ? 'red' : 'amber' }; });
}

// ---------- 7: the night audit: what is left before the day is closed

roomDeskRoutes.get(`${B}/frontdesk/audit`, requireAction('stays.edit'), async (c) => {
  const b = bizOf(c);
  const db = c.env.DB;
  const { t, shiftDay: today } = clock(b);
  const tomorrow = addDays(today, 1);
  const [bookings, reservations, stays, formC, djubo, dirty, tomorrowB, tomorrowR] = await Promise.all([
    all(db, `SELECT k.id, k.guest_name AS guestName, k.check_in AS checkIn, k.check_out AS checkOut, k.room_type AS roomType, k.room_labels AS roomLabels, k.channel, k.source,
        (SELECT coalesce(sum(d.amount_paise), 0) FROM desk_advances d WHERE d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id)) AS heldPaise
      FROM bookings k WHERE k.business_id = ? AND k.status IN ('new', 'approved') AND k.unplaced = 0 AND k.stay_id IS NULL AND k.check_in <= ?
      AND NOT (k.source = 'mmt' AND EXISTS (SELECT 1 FROM bookings m WHERE m.id = k.match_id AND m.status <> 'cancelled')) ORDER BY k.check_in, k.guest_name`, b.id, today),
    all(db, `SELECT r.id, r.guest_name AS guestName, r.check_in AS checkIn, r.check_out AS checkOut, r.status,
        (SELECT coalesce(sum(d.amount_paise), 0) FROM desk_advances d WHERE d.reservation_id = r.id AND d.status = 'held') AS heldPaise
      FROM reservations r WHERE r.business_id = ? AND r.status IN ('confirmed', 'hold') AND r.booking_id IS NULL AND r.stay_id IS NULL AND r.check_in <= ? ORDER BY r.check_in`, b.id, today),
    all<{ id: string; room: string; guestName: string; plan: string | null; balancePaise: number }>(db, `SELECT s.id, s.room, s.guest_name AS guestName,
        coalesce(s.check_out_plan, (SELECT max(k.check_out) FROM bookings k WHERE k.stay_id = s.id)) AS plan,
        coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balancePaise
      FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id WHERE s.business_id = ? AND s.checked_out_at IS NULL ORDER BY s.room`, b.id),
    formCPending(db, b.id, t),
    notInDjubo(db, b.id, today, t),
    all(db, "SELECT room, status, at FROM room_status WHERE business_id = ? AND status <> 'inspected' ORDER BY room", b.id),
    all(db, `SELECT guest_name AS guestName, room_type AS roomType, room_labels AS roomLabels FROM bookings k WHERE business_id = ? AND status IN ('new', 'approved') AND check_in = ?
      AND NOT (k.source = 'mmt' AND match_id IS NOT NULL)`, b.id, tomorrow),
    all(db, "SELECT guest_name AS guestName, lines FROM reservations WHERE business_id = ? AND status IN ('confirmed', 'hold') AND booking_id IS NULL AND check_in = ?", b.id, tomorrow),
  ]);
  return c.json({
    today, tomorrow,
    notArrived: [...bookings.map((x) => ({ ...x, kind: 'booking' })), ...reservations.map((x) => ({ ...x, kind: 'reservation' }))],
    overstays: stays.filter((s) => s.plan && s.plan < today),
    dueOut: stays.filter((s) => s.plan === today),
    noDate: stays.filter((s) => !s.plan),
    balances: stays.filter((s) => s.balancePaise !== 0),
    formC, notInDjubo: djubo, dirty,
    tomorrow_: [...tomorrowB, ...tomorrowR.map((r) => ({ guestName: (r as { guestName: string }).guestName, roomType: 'made here' }))],
  });
});

// ---------- 9, 10: the guest register and past stays

roomDeskRoutes.get(`${B}/frontdesk/register`, requireAction('stays.edit'), async (c) => {
  const b = bizOf(c);
  const today = clock(b).shiftDay;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('from') ?? '') ? c.req.query('from')! : addDays(today, -6);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('to') ?? '') ? c.req.query('to')! : today;
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const rows = await all<Record<string, unknown> & { id_docs: string | null; foreign_info: string | null }>(c.env.DB, `SELECT s.id, s.grc_no AS grcNo, s.room, s.guest_name AS guestName,
      s.phone, s.check_in AS checkIn, s.created_at AS arrivedAt, s.checked_out_at AS leftAt, s.adults, s.children, s.nationality, s.address, s.coming_from AS comingFrom,
      s.going_to AS goingTo, s.id_docs, s.foreign_info, s.form_c_at AS formCAt, i.invoice_no AS invoiceNo, i.total_paise AS invoicePaise
    FROM stays s LEFT JOIN room_invoices i ON i.stay_id = s.id WHERE s.business_id = ?
      AND (? <> '' AND (lower(s.guest_name) LIKE ? OR lower(s.room) = ? OR lower(coalesce(s.grc_no, '')) LIKE ? OR (? <> '' AND s.phone LIKE ?))
        OR ? = '' AND s.check_in <= ? AND (s.checked_out_at IS NULL OR s.check_in >= ? OR s.checked_out_at >= ?))
    ORDER BY s.created_at DESC LIMIT 500`, b.id, q, `%${q}%`, q, `%${q}%`, digits, `%${digits}%`, q, to, from, Date.parse(from) - 19_800_000);
  return c.json({ from, to, stays: rows.map(({ id_docs, foreign_info, ...r }) => ({ ...r, idDocs: id_docs ? JSON.parse(id_docs) : [], foreign: foreign_info ? JSON.parse(foreign_info) : null })) });
});

// ---------- 11: housekeeping

roomDeskRoutes.get(`${B}/frontdesk/housekeeping`, requireAction('pos.view'), async (c) => {
  const b = bizOf(c);
  const secs = (tableLayout(b) ?? []).filter((s) => s.kind === 'rooms' || s.kind === 'dorms');
  const [status, occupied] = await Promise.all([
    all<{ room: string; status: string; note: string | null; at: number; by_name: string | null }>(c.env.DB,
      'SELECT r.room, r.status, r.note, r.at, s.name AS by_name FROM room_status r LEFT JOIN staff s ON s.id = r.by_staff WHERE r.business_id = ?', b.id),
    all<{ room: string; guest_name: string }>(c.env.DB, 'SELECT room, guest_name FROM stays WHERE business_id = ? AND checked_out_at IS NULL', b.id),
  ]);
  return c.json({ sections: secs.map((s) => ({ name: s.name, rooms: s.tables.filter((t) => !/· whole$/.test(t)).map((room) => {
    const st = status.find((x) => x.room === room);
    return { room, status: st?.status ?? 'inspected', note: st?.note ?? null, at: st?.at ?? null, by: st?.by_name ?? null, guest: occupied.find((o) => o.room === room)?.guest_name ?? null };
  }) })) });
});

roomDeskRoutes.post(`${B}/frontdesk/housekeeping`, requireAction('pos.view'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  const status = data.status;
  if (status !== 'dirty' && status !== 'clean' && status !== 'inspected') fail(400, 'Status is dirty, clean or inspected.');
  if (status === 'inspected' && !isManager(c) && c.get('staff').role === 'captain') fail(403, 'A cashier, manager or owner marks a room inspected.');
  const rooms = Array.isArray(data.rooms) ? data.rooms.map(String).slice(0, 100) : [];
  const all_ = (tableLayout(bizOf(c)) ?? []).flatMap((s) => s.tables);
  if (!rooms.length || rooms.some((r) => !all_.includes(r))) fail(400, 'Choose rooms from the list.');
  const note = text(data, 'note', 'Note', { optional: true, max: 80 });
  const t = now();
  await c.env.DB.batch(rooms.map((r) => dirtyUpsert(c.env.DB, bid, r, status, c.get('staff').id, t, note)));
  return c.json({ ok: true });
});

/** A room still dirty, for the check-in warning. */
export async function roomIsDirty(db: DB, bid: string, room: string) {
  return !!(await one(db, "SELECT 1 FROM room_status WHERE business_id = ? AND room = ? AND status = 'dirty'", bid, room));
}

// ---------- 12: moving a guest to another room (the bill, open orders and history go with them)

roomDeskRoutes.post(`${B}/stays/:id/move`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const s = await openStay(c, c.req.param('id'));
  if (s.checked_out_at) fail(409, 'This guest has checked out.');
  const data = await body(c);
  const all_ = (tableLayout(bizOf(c)) ?? []).filter((x) => x.kind === 'rooms' || x.kind === 'dorms').flatMap((x) => x.tables);
  const to = all_.find((r) => r === data.room);
  if (!to) fail(400, 'Choose a room or bed from the list.');
  if (to === s.room) fail(400, 'That is the same room.');
  const reason = text(data, 'reason', 'Why the guest moves', { max: 80 })!;
  if (data.dirtyOk !== true && await roomIsDirty(db, bid, to)) return c.json({ error: `${to} is marked dirty. Move anyway?`, code: 'room_dirty' }, 409);
  const t = now();
  try {
    await db.batch([
      stmt(db, 'UPDATE stays SET room = ? WHERE id = ?', to, s.id),
      stmt(db, 'UPDATE debtor_accounts SET name = ? WHERE id = ?', `${/^\d/.test(to) ? 'Room ' : ''}${to} · ${s.guest_name}`, s.account_id),
      stmt(db, "UPDATE orders SET place = ? WHERE stay_id = ? AND status IN ('open', 'tab')", to, s.id),
      dirtyUpsert(db, bid, s.room, 'dirty', c.get('staff').id, t, `Guest moved to ${to}`),
      audit(db, bid, c.get('staff').id, 'stay.move', 'stays', s.id, { room: s.room }, { room: to, reason }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, `${to} already has a guest.`);
    throw e;
  }
  return c.json(await stayBill(c, s.id));
});

