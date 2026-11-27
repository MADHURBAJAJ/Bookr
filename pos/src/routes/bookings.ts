// Bookings read from Djubo and MakeMyTrip mails (23 Nov 2026). A person approves each one (or fixes what was read)
// until automatic is switched on; then clean ones go in by themselves and only the odd ones wait. Approved bookings
// are offered at check-in for that day. Front desk (stays.edit) works the list; a manager or owner switches automatic.
import { Hono, type Context } from 'hono';
import { all, now, one, stmt } from '../../../src/db';
import { body, date, fail, isUuid, text } from '../../../src/http';
import { isManager, requireAction, requireStaff } from '../auth';
import { audit, bizOf, clock } from '../util';
import { bookingsInMail, orderOf, readAgain, saveBooking } from '../mail';
import type { ReadBooking } from '../booking-readers';
import { CLOSED_TO, type Business } from '../util';
import { continuesOf, linkStay, nameKey, recomputeDesk } from '../rooms';
import { oldDeskPending } from '../djubo-desk';
import { phoneKey } from './settings';
import type { AppEnv } from '../types';

export const bookingRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
bookingRoutes.use(`${B}/*`, requireStaff);

const COLS = `id, source, ext_ref AS extRef, guest_name AS guestName, phone, room_type AS roomType, rooms, guests, check_in AS checkIn, check_out AS checkOut,
  amount_paise AS amountPaise, paid_paise AS paidPaise, status, how, problem, match_id AS matchId, mail_id AS mailId, stay_id AS stayId, created_at AS createdAt,
  ota_ref AS otaRef, pnr, room_labels AS roomLabels, channel, unplaced, booked_at AS bookedAt, changed_at AS changedAt, meal_plan AS mealPlan, requests,
  desk_paid_paise AS deskPaidPaise, entered_by AS enteredBy, from_report AS fromReport, report_due_paise AS reportDuePaise,
  (SELECT coalesce(sum(d.amount_paise), 0) FROM desk_advances d WHERE d.status = 'held' AND (d.booking_id = bk.id OR d.booking_id = bk.match_id)) AS heldPaise`;
const masked = <T extends { phone: string | null }>(x: T) => ({ ...x, phone: x.phone ? `••••${x.phone.slice(-4)}` : null });

// The Bookings screen: waiting for a person, arriving soon, and the mails received lately (with any problem).
bookingRoutes.get(`${B}/bookings`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const today = clock(bizOf(c)).shiftDay;
  const [alerts, waiting, arriving, mails, autoRow] = await Promise.all([
    // Djubo could not place these OTA bookings: overbooking risk until someone creates them in Djubo by hand.
    all<{ phone: string | null }>(c.env.DB, `SELECT ${COLS} FROM bookings bk WHERE business_id = ? AND status = 'new' AND unplaced = 1 ORDER BY check_in, created_at`, bid),
    all<{ phone: string | null }>(c.env.DB, `SELECT ${COLS} FROM bookings bk WHERE business_id = ? AND status = 'new' AND unplaced = 0 ORDER BY check_in, created_at`, bid),
    all<{ phone: string | null }>(c.env.DB, `SELECT ${COLS} FROM bookings bk WHERE business_id = ? AND status IN ('approved', 'checked_in') AND check_in >= ? ORDER BY check_in, guest_name LIMIT 200`,
      bid, new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10)),
    all(c.env.DB, `SELECT id, from_addr AS fromAddr, subject, source, received_at AS receivedAt, status, note FROM inbound_mails WHERE business_id = ?
      ORDER BY received_at DESC LIMIT 30`, bid),
    one<{ a: number | null; u: string }>(c.env.DB, 'SELECT bookings_auto_from AS a, no_receipt_users AS u FROM businesses WHERE id = ?', bid),
  ]);
  // Money taken at reception (24 Nov 2026): what reception entered in Djubo with no POS receipt yet (before check-in; once
  // checked in, the room bill shows it as to collect), advances taken here waiting for their Djubo booking, and the rooms
  // checked in by hand with no booking (to link a booking to); a group's other beds have theirs on its first room.
  const [pending, advancesWaiting, unbooked] = await Promise.all([
    oldDeskPending(c.env.DB, bid, bizOf(c).shift_start_hour),
    all(c.env.DB, `SELECT d.id, d.guest_name AS guestName, d.phone, d.check_in AS checkIn, d.amount_paise AS amountPaise, d.at, s.receipt_no AS receiptNo,
        CASE WHEN r.status = 'cancelled' THEN 'cancelled' ELSE k.status END AS bookingStatus, coalesce(k.ext_ref, CASE WHEN r.id IS NOT NULL THEN 'made here' END) AS bookingRef
      FROM desk_advances d JOIN settlements s ON s.id = d.settlement_id LEFT JOIN bookings k ON k.id = d.booking_id LEFT JOIN reservations r ON r.id = d.reservation_id
      WHERE d.business_id = ? AND d.status = 'held' AND ((d.booking_id IS NULL AND (d.reservation_id IS NULL OR r.status = 'cancelled')) OR k.status = 'cancelled') ORDER BY d.at`, bid),
    all(c.env.DB, `SELECT s.id, s.room, s.guest_name AS guestName FROM stays s WHERE s.business_id = ? AND s.checked_out_at IS NULL
      AND s.group_stay_id IS NULL AND NOT EXISTS (SELECT 1 FROM bookings x WHERE x.stay_id = s.id) ORDER BY s.room`, bid),
  ]);
  let users: string[] = [];
  try { users = JSON.parse(autoRow?.u ?? '[]'); } catch { /* none */ }
  return c.json({ today, alerts: alerts.map(masked), waiting: waiting.map(masked), arriving: arriving.map(masked), mails, autoFrom: autoRow?.a ?? null,
    bookingTeam: users, deskToTake: pending.filter((p) => p.status !== 'checked_in'), advancesWaiting: advancesWaiting.map((a) => masked(a as { phone: string | null })), unbooked });
});

// Arrivals for check-in on a day: approved bookings not yet checked in (the full phone, to fill the check-in form).
bookingRoutes.get(`${B}/bookings/arrivals`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const day = date({ d: c.req.query('day') ?? clock(bizOf(c)).shiftDay }, 'd', 'Day');
  // One guest once: of a Djubo and MakeMyTrip pair of the same stay, the Djubo one is offered (it has the phone, Djubo's room
  // numbers and what is still to pay).
  const pairOk = `NOT (bk.source = 'mmt' AND EXISTS (SELECT 1 FROM bookings m WHERE m.id = bk.match_id AND m.status = 'approved' AND m.stay_id IS NULL))`;
  const [arrivals, late] = await Promise.all([
    all(c.env.DB, `SELECT ${COLS} FROM bookings bk WHERE business_id = ? AND status = 'approved' AND check_in <= ? AND check_out > ? AND stay_id IS NULL
      AND ${pairOk} ORDER BY guest_name`, bid, day, day),
    // Not checked in from earlier days (25 Nov 2026): bookings of the last 7 days whose stay has ended or ends today, never
    // checked in here. Checked in late (with the booking's own dates), or in and out together when the guest has left.
    all(c.env.DB, `SELECT ${COLS} FROM bookings bk WHERE business_id = ? AND status = 'approved' AND stay_id IS NULL AND check_in < ? AND check_in >= ?
      AND check_out <= ? AND ${pairOk} ORDER BY check_in, guest_name`, bid, day, new Date(Date.parse(day) - 7 * 86_400_000).toISOString().slice(0, 10), day),
  ]);
  // A booking that continues a guest already in house (an extension made in Djubo as a new booking): their rooms.
  const cont = await continuesOf(c.env.DB, bid, (arrivals as { id: string; phone: string | null; guestName: string | null; checkIn: string | null }[]));
  return c.json({ arrivals: (arrivals as { id: string }[]).map((a) => ({ ...a, continues: cont.get(a.id) ?? null })), late });
});

async function booking(c: Context<AppEnv>, id: string) {
  if (!isUuid(id)) fail(404, 'Booking not found.');
  const b = await one<{ id: string; status: string; guest_name: string | null; check_in: string | null; check_out: string | null; room_type: string | null }>(c.env.DB,
    'SELECT id, status, guest_name, check_in, check_out, room_type FROM bookings WHERE id = ? AND business_id = ?', id, c.get('businessId'));
  if (!b) fail(404, 'Booking not found.');
  return b;
}

// Approve, with any fixes to what was read (name, phone, room type, dates).
bookingRoutes.post(`${B}/bookings/:id/approve`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const b = await booking(c, c.req.param('id'));
  if (b.status !== 'new' && b.status !== 'approved') fail(409, b.status === 'cancelled' ? 'This booking was cancelled.' : 'This guest is already checked in.');
  const data = await body(c);
  const name = text(data, 'guestName', 'Guest name', { optional: true, max: 80 }) ?? b.guest_name;
  const checkIn = data.checkIn ? date(data, 'checkIn', 'Check-in') : b.check_in;
  const checkOut = data.checkOut ? date(data, 'checkOut', 'Check-out') : b.check_out;
  const roomType = text(data, 'roomType', 'Room type', { optional: true, max: 40 }) ?? b.room_type;
  const phone = data.phone === undefined ? undefined : phoneKey(data.phone);
  if (!name) fail(400, 'Add the guest name.');
  if (!checkIn || !checkOut) fail(400, 'Add the check-in and check-out dates.');
  if (checkOut <= checkIn) fail(400, 'Check-out must be after check-in.');
  const t = now();
  await c.env.DB.batch([
    stmt(c.env.DB, `UPDATE bookings SET guest_name = ?, check_in = ?, check_out = ?, room_type = ?, phone = coalesce(?, phone), status = 'approved', how = 'person', problem = NULL,
      decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`, name, checkIn, checkOut, roomType, phone ?? null, c.get('staff').id, t, t, b.id),
    audit(c.env.DB, bid, c.get('staff').id, 'booking.approve', 'bookings', b.id, { guest: b.guest_name, checkIn: b.check_in, checkOut: b.check_out, roomType: b.room_type },
      { guest: name, checkIn, checkOut, roomType }),
  ]);
  return c.json({ ok: true });
});

bookingRoutes.post(`${B}/bookings/:id/cancel`, requireAction('stays.edit'), async (c) => {
  const b = await booking(c, c.req.param('id'));
  if (b.status === 'checked_in') fail(409, 'This guest is already checked in.');
  const t = now();
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE bookings SET status = 'cancelled', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?", c.get('staff').id, t, t, b.id),
    audit(c.env.DB, c.get('businessId'), c.get('staff').id, 'booking.cancel', 'bookings', b.id, null, null),
  ]);
  return c.json({ ok: true });
});

// Reads a kept mail again (after a reader is improved).
bookingRoutes.post(`${B}/mails/:id/read-again`, requireAction('stays.edit'), async (c) => {
  if (!isUuid(c.req.param('id'))) fail(404, 'Mail not found.');
  if (!(await readAgain(c.env, c.get('businessId'), c.req.param('id')))) fail(404, 'Mail not found.');
  return c.json({ ok: true });
});

// Reads every kept Djubo and MakeMyTrip mail again, oldest first (so a later, revised mail has the last word), a few per
// call to stay within the Worker's limits: `from` is how many are done; `next` is null when all are.
const PER_CALL = 8;
bookingRoutes.post(`${B}/mails/read-all-again`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  const from = Number.isInteger(data.from) && (data.from as number) >= 0 ? (data.from as number) : 0;
  const total = (await one<{ n: number }>(c.env.DB, "SELECT count(*) AS n FROM inbound_mails WHERE business_id = ? AND source IN ('mmt', 'djubo')", bid))!.n;
  const ids = await all<{ id: string }>(c.env.DB, `SELECT id FROM inbound_mails WHERE business_id = ? AND source IN ('mmt', 'djubo')
    ORDER BY received_at, created_at, id LIMIT ? OFFSET ?`, bid, PER_CALL, from);
  for (const m of ids) await readAgain(c.env, bid, m.id);
  const done = from + ids.length;
  return c.json({ done, total, next: ids.length === PER_CALL && done < total ? done : null });
});

// The Djubo users of the booking team (a manager sets them, 24 Nov 2026): money they enter in Djubo needs no POS receipt.
// Anyone else's (reception, someone new) does; OTA bookings ("System") never do.
bookingRoutes.put(`${B}/bookings/booking-team`, requireAction('stays.edit'), async (c) => {
  if (!isManager(c)) fail(403, 'A manager or owner sets the booking team.');
  const bid = c.get('businessId');
  const data = await body(c);
  if (!Array.isArray(data.users) || data.users.length > 10) fail(400, 'List up to 10 names, as Djubo shows them.');
  const users = [...new Set(data.users.map((u) => String(u).trim()).filter(Boolean).map((u) => u.slice(0, 60)))];
  const before = await one<{ u: string }>(c.env.DB, 'SELECT no_receipt_users AS u FROM businesses WHERE id = ?', bid);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET no_receipt_users = ? WHERE id = ?', JSON.stringify(users), bid),
    audit(c.env.DB, bid, c.get('staff').id, 'bookings.booking_team', 'businesses', bid, before?.u ?? null, users),
  ]);
  // Worked out again for every booking with Djubo mails, with the new names.
  const lower = users.map((u) => u.toLowerCase());
  for (const k of await all<{ booking_id: string }>(c.env.DB, 'SELECT DISTINCT booking_id FROM booking_paid_log WHERE business_id = ?', bid)) await recomputeDesk(c.env.DB, bid, k.booking_id, lower);
  return c.json({ ok: true, users });
});

// A person links a booking to the guest already in a room (checked in by hand before Djubo had the booking).
bookingRoutes.post(`${B}/bookings/:id/link-stay`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const b = await booking(c, c.req.param('id'));
  if (b.status === 'cancelled' || b.status === 'checked_in') fail(409, b.status === 'cancelled' ? 'This booking was cancelled.' : 'This booking is already checked in.');
  const data = await body(c);
  // A group's other rooms and beds (24 Nov 2026) have their booking on the group's first room: never linked on their own.
  const s = await one<{ id: string }>(c.env.DB, `SELECT s.id FROM stays s WHERE s.id = ? AND s.business_id = ? AND s.checked_out_at IS NULL
    AND s.group_stay_id IS NULL AND NOT EXISTS (SELECT 1 FROM bookings x WHERE x.stay_id = s.id)`, typeof data.stayId === 'string' && isUuid(data.stayId) ? data.stayId : null, bid);
  if (!s) fail(404, 'Choose an in-house room that has no booking.');
  await linkStay(c.env.DB, bid, b.id, s.id);
  await audit(c.env.DB, bid, c.get('staff').id, 'booking.link_stay', 'bookings', b.id, null, { stayId: s.id }).run();
  return c.json({ ok: true });
});

// Automatic: from a date (e.g. 10 days on), clean bookings go in by themselves. Off: a person approves every one.
bookingRoutes.put(`${B}/bookings/auto`, requireAction('stays.edit'), async (c) => {
  if (!isManager(c)) fail(403, 'A manager or owner switches automatic on or off.');
  const data = await body(c);
  const from = data.from === null || data.from === '' || data.from === undefined ? null : Date.parse(`${date(data, 'from', 'Automatic from')}T00:00:00+05:30`);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET bookings_auto_from = ? WHERE id = ?', from, c.get('businessId')),
    audit(c.env.DB, c.get('businessId'), c.get('staff').id, 'bookings.auto', 'businesses', c.get('businessId'), null, { from }),
  ]);
  return c.json({ autoFrom: from });
});

// ---------- each booking's mail history (26 Nov 2026)

/** What every mail said about a booking (and its MakeMyTrip copy), newest first, and which one the booking follows. */
bookingRoutes.get(`${B}/bookings/:id/history`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const k = await booking(c, c.req.param('id'));
  const rows = await all<{ booking_id: string; mail_id: string; order_at: number; received_at: number; data: string; status: string; held_reason: string | null;
    decided_by: string | null; decided_at: number | null; source: string; ext_ref: string; subject: string | null }>(c.env.DB, `
    SELECT v.booking_id, v.mail_id, v.order_at, v.received_at, v.data, v.status, v.held_reason, (SELECT name FROM staff WHERE id = v.decided_by) AS decided_by, v.decided_at,
      b.source, b.ext_ref, m.subject
    FROM booking_versions v JOIN bookings b ON b.id = v.booking_id JOIN inbound_mails m ON m.id = v.mail_id
    WHERE v.business_id = ?1 AND v.booking_id IN (?2, (SELECT match_id FROM bookings WHERE id = ?2), (SELECT id FROM bookings WHERE match_id = ?2))
    ORDER BY v.order_at DESC, v.received_at DESC`, bid, k.id);
  return c.json({ history: rows.map((r) => {
    const x = JSON.parse(r.data) as ReadBooking;
    return { bookingId: r.booking_id, mailId: r.mail_id, source: r.source, extRef: r.ext_ref, subject: r.subject, orderAt: r.order_at, receivedAt: r.received_at,
      status: r.status, heldReason: r.held_reason, decidedBy: r.decided_by, decidedAt: r.decided_at, enteredBy: x.enteredBy ?? null, cancelled: !!x.cancelled,
      amountPaise: x.amountPaise ?? null, paidPaise: x.paidPaise ?? null, checkIn: x.checkIn ?? null, checkOut: x.checkOut ?? null, rooms: x.rooms ?? null,
      roomType: x.roomType ?? null, roomLabels: x.roomLabels ?? null };
  }) });
});

/**
 * A stay's email history (27 Nov 2026): every booking on its bill (Djubo makes one per night or extension, and their
 * MakeMyTrip twins), and the same guest's bookings just before it that never came onto a bill (Djubo sent them late), each
 * email marked with its booking, night, and whether it is on this bill.
 */
bookingRoutes.get(`${B}/stays/:id/history`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const st = await one<{ id: string; guest_name: string; phone: string | null; check_in: string; group_stay_id: string | null }>(db,
    'SELECT id, guest_name, phone, check_in, group_stay_id FROM stays WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!st) fail(404, 'Stay not found.');
  const head = st.group_stay_id ?? st.id;
  const onBill = await all<{ id: string; match_id: string | null; check_in: string | null }>(db,
    'SELECT id, match_id, check_in FROM bookings WHERE business_id = ? AND stay_id IN (SELECT id FROM stays WHERE id = ? OR group_stay_id = ?)', bid, head, head);
  const ids = new Set<string>();
  for (const k of onBill) { ids.add(k.id); if (k.match_id) ids.add(k.match_id); }
  // The same guest's bookings that end where this stay began (and so on back), with no stay of their own.
  const digits = (p: string | null) => { const d = (p ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
  const same = (k: { guest_name: string | null; phone: string | null }) =>
    (digits(st.phone) !== '' && digits(st.phone) === digits(k.phone)) || (nameKey(st.guest_name).length >= 4 && nameKey(st.guest_name) === nameKey(k.guest_name));
  const loose = (await all<{ id: string; guest_name: string | null; phone: string | null; check_in: string | null; check_out: string | null }>(db,
    "SELECT id, guest_name, phone, check_in, check_out FROM bookings WHERE business_id = ? AND stay_id IS NULL AND status <> 'cancelled' AND check_out <= ? AND check_out >= ?",
    bid, st.check_in, new Date(Date.parse(st.check_in) - 30 * 86_400_000).toISOString().slice(0, 10))).filter(same);
  const firstIn = [st.check_in, ...onBill.map((k) => k.check_in).filter((x): x is string => !!x)].sort()[0];
  const before = new Set<string>();
  for (let day = firstIn, guard = 0; guard < 30; guard++) {
    const prev = loose.filter((k) => k.check_out === day && !before.has(k.id));
    if (!prev.length) break;
    for (const k of prev) before.add(k.id);
    day = prev.map((k) => k.check_in ?? day).sort()[0];
  }
  const all_ = [...ids, ...before];
  const rows = all_.length ? await all<{ booking_id: string; mail_id: string; order_at: number; received_at: number; data: string; status: string; held_reason: string | null;
    decided_by: string | null; decided_at: number | null; source: string; ext_ref: string; subject: string | null; check_in: string | null; check_out: string | null }>(db, `
    SELECT v.booking_id, v.mail_id, v.order_at, v.received_at, v.data, v.status, v.held_reason, (SELECT name FROM staff WHERE id = v.decided_by) AS decided_by, v.decided_at,
      b.source, b.ext_ref, m.subject, b.check_in, b.check_out
    FROM booking_versions v JOIN bookings b ON b.id = v.booking_id JOIN inbound_mails m ON m.id = v.mail_id
    WHERE v.business_id = ? AND v.booking_id IN (SELECT value FROM json_each(?)) ORDER BY v.order_at DESC, v.received_at DESC`, bid, JSON.stringify(all_)) : [];
  return c.json({ history: rows.map((r) => {
    const x = JSON.parse(r.data) as ReadBooking;
    return { bookingId: r.booking_id, mailId: r.mail_id, source: r.source, extRef: r.ext_ref, subject: r.subject, orderAt: r.order_at, receivedAt: r.received_at,
      status: r.status, heldReason: r.held_reason, decidedBy: r.decided_by, decidedAt: r.decided_at, enteredBy: x.enteredBy ?? null, cancelled: !!x.cancelled,
      amountPaise: x.amountPaise ?? null, paidPaise: x.paidPaise ?? null, checkIn: x.checkIn ?? r.check_in, checkOut: x.checkOut ?? r.check_out, rooms: x.rooms ?? null,
      roomType: x.roomType ?? null, roomLabels: x.roomLabels ?? null, onBill: !before.has(r.booking_id), night: r.check_in ? `${r.check_in}|${r.check_out ?? ''}` : null };
  }), bookings: ids.size + before.size, offBill: before.size });
});

/** Changes held for a person: what the booking has now beside what the mail says. */
bookingRoutes.get(`${B}/bookings/held`, requireAction('stays.edit'), async (c) => c.json({ held: await heldChanges(c.env.DB, c.get('businessId')) }));
export async function heldChanges(db: Context<AppEnv>['env']['DB'], bid: string) {
  const rows = await all<{ booking_id: string; mail_id: string; data: string; held_reason: string | null; order_at: number; ext_ref: string; source: string; guest_name: string | null;
    status: string; amount_paise: number | null; paid_paise: number | null; check_in: string | null; check_out: string | null; room: string | null; stay_id: string | null }>(db, `
    SELECT v.booking_id, v.mail_id, v.data, v.held_reason, v.order_at, b.ext_ref, b.source, b.guest_name, b.status, b.amount_paise, b.paid_paise, b.check_in, b.check_out,
      (SELECT s.room FROM stays s WHERE s.id = b.stay_id) AS room, b.stay_id
    FROM booking_versions v JOIN bookings b ON b.id = v.booking_id WHERE v.business_id = ? AND v.status = 'held' ORDER BY v.order_at`, bid);
  return rows.map((r) => {
    const x = JSON.parse(r.data) as ReadBooking;
    return { bookingId: r.booking_id, mailId: r.mail_id, reason: r.held_reason, at: r.order_at, extRef: r.ext_ref, source: r.source, guestName: r.guest_name, room: r.room, stayId: r.stay_id,
      now: { status: r.status, amountPaise: r.amount_paise, paidPaise: r.paid_paise, checkIn: r.check_in, checkOut: r.check_out },
      mail: { cancelled: !!x.cancelled, amountPaise: x.amountPaise ?? null, paidPaise: x.paidPaise ?? null, checkIn: x.checkIn ?? null, checkOut: x.checkOut ?? null, enteredBy: x.enteredBy ?? null } };
  });
}

async function heldOne(c: Context<AppEnv>) {
  const bid = c.get('businessId');
  const id = c.req.param('id') ?? '';
  const v = await one<{ data: string; source: 'mmt' | 'djubo' }>(c.env.DB, `SELECT v.data, b.source FROM booking_versions v JOIN bookings b ON b.id = v.booking_id
    WHERE v.booking_id = ? AND v.mail_id = ? AND v.business_id = ? AND v.status = 'held'`, isUuid(id) ? id : null, c.req.param('mailId') ?? '', bid);
  if (!v) fail(404, 'This change is no longer waiting.');
  return v;
}
// Apply: the booking takes what the mail says, as if it had come in normally.
bookingRoutes.post(`${B}/bookings/:id/versions/:mailId/apply`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const v = await heldOne(c);
  const b = (await one<Business>(c.env.DB, `SELECT id, name, fy_start_month, shift_start_hour, tab_age_days, tables, disc_limit_bp, ${CLOSED_TO} FROM businesses WHERE id = ?`, bid))!;
  const auto = (await one<{ a: number | null }>(c.env.DB, 'SELECT bookings_auto_from AS a FROM businesses WHERE id = ?', bid))!.a;
  await saveBooking(c.env.DB, b, auto, v.source, c.req.param('mailId'), JSON.parse(v.data) as ReadBooking, undefined, true);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE booking_versions SET decided_by = ?, decided_at = ? WHERE booking_id = ? AND mail_id = ?', c.get('staff').id, now(), c.req.param('id'), c.req.param('mailId')),
    audit(c.env.DB, bid, c.get('staff').id, 'booking.change_applied', 'bookings', c.req.param('id'), null, { mailId: c.req.param('mailId') }),
  ]);
  return c.json({ ok: true });
});
// Keep: the booking stays as it is; the mail stays in its history, marked kept.
bookingRoutes.post(`${B}/bookings/:id/versions/:mailId/keep`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  await heldOne(c);
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE booking_versions SET status = 'kept', decided_by = ?, decided_at = ? WHERE booking_id = ? AND mail_id = ?", c.get('staff').id, now(), c.req.param('id'), c.req.param('mailId')),
    audit(c.env.DB, bid, c.get('staff').id, 'booking.change_kept', 'bookings', c.req.param('id'), null, { mailId: c.req.param('mailId') }),
  ]);
  return c.json({ ok: true });
});

// Builds each booking's history from the mails already kept (once, when the history began; 26 Nov 2026). Changes no booking.
bookingRoutes.post(`${B}/mails/build-history`, requireAction('stays.edit'), async (c) => {
  if (!isManager(c)) fail(403, 'A manager or owner builds the history.');
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const from = Number.isInteger(data.from) && (data.from as number) >= 0 ? (data.from as number) : 0;
  const ids = await all<{ id: string }>(db, `SELECT id FROM inbound_mails WHERE business_id = ? AND source IN ('mmt', 'djubo') AND status = 'read'
    ORDER BY received_at, created_at, id LIMIT 25 OFFSET ?`, bid, from);
  let added = 0;
  for (const m of ids) {
    const r = await bookingsInMail(c.env, bid, m.id);
    for (const x of r?.found ?? []) {
      const k = await one<{ id: string }>(db, 'SELECT id FROM bookings WHERE business_id = ? AND source = ? AND ext_ref = ?', bid, r!.source, x.extRef);
      if (!k) continue;
      const res = await stmt(db, `INSERT INTO booking_versions (booking_id, mail_id, business_id, order_at, received_at, data, status) VALUES (?, ?, ?, ?, ?, ?, 'applied')
        ON CONFLICT (booking_id, mail_id) DO NOTHING`, k.id, m.id, bid, orderOf(r!.source, x, r!.came), r!.came, JSON.stringify(x)).run();
      added += res.meta.changes ?? 0;
    }
  }
  return c.json({ done: from + ids.length, added, next: ids.length === 25 ? from + 25 : null });
});

// Dry run (26 Nov 2026): for bookings not over, where the newest mail by Djubo's time, or the desk money worked out again,
// differs from what the booking has now. Changes nothing.
bookingRoutes.get(`${B}/mails/history-check`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const today = clock(bizOf(c)).shiftDay;
  const ks = await all<{ id: string; ext_ref: string; guest_name: string | null; status: string; amount_paise: number | null; paid_paise: number | null; check_in: string | null;
    check_out: string | null; desk_paid_paise: number }>(db, `SELECT id, ext_ref, guest_name, status, amount_paise, paid_paise, check_in, check_out, desk_paid_paise FROM bookings
    WHERE business_id = ? AND status IN ('new', 'approved', 'checked_in') AND (check_out IS NULL OR check_out >= ?)`, bid, today);
  const out: unknown[] = [];
  for (const k of ks) {
    const v = await one<{ data: string; mail_id: string }>(db, `SELECT data, mail_id FROM booking_versions WHERE booking_id = ? AND status IN ('applied', 'held')
      ORDER BY order_at DESC, received_at DESC LIMIT 1`, k.id);
    const diffs: string[] = [];
    if (v) {
      const x = JSON.parse(v.data) as ReadBooking;
      if (x.cancelled) diffs.push('newest mail says cancelled');
      if (x.amountPaise !== undefined && x.amountPaise !== k.amount_paise) diffs.push(`total ${k.amount_paise} → ${x.amountPaise}`);
      if (x.paidPaise !== undefined && x.paidPaise !== k.paid_paise) diffs.push(`paid ${k.paid_paise} → ${x.paidPaise}`);
      if (x.checkIn && x.checkIn !== k.check_in) diffs.push(`check-in ${k.check_in} → ${x.checkIn}`);
      if (x.checkOut && x.checkOut !== k.check_out) diffs.push(`check-out ${k.check_out} → ${x.checkOut}`);
    }
    const desk = await recomputeDesk(db, bid, k.id, undefined, true);
    if (desk !== k.desk_paid_paise) diffs.push(`desk money ${k.desk_paid_paise} → ${desk}`);
    if (diffs.length) out.push({ extRef: k.ext_ref, guestName: k.guest_name, status: k.status, diffs });
  }
  return c.json({ checked: ks.length, differ: out });
});
