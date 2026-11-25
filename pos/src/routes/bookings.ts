// Bookings read from Djubo and MakeMyTrip mails (23 Nov 2026). A person approves each one (or fixes what was read)
// until automatic is switched on; then clean ones go in by themselves and only the odd ones wait. Approved bookings
// are offered at check-in for that day. Front desk (stays.edit) works the list; a manager or owner switches automatic.
import { Hono, type Context } from 'hono';
import { all, now, one, stmt } from '../../../src/db';
import { body, date, fail, isUuid, text } from '../../../src/http';
import { isManager, requireAction, requireStaff } from '../auth';
import { audit, bizOf, clock } from '../util';
import { readAgain } from '../mail';
import { deskPending, linkStay, recomputeDesk } from '../rooms';
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
    deskPending(c.env.DB, bid),
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
  return c.json({ arrivals: await all(c.env.DB, `SELECT ${COLS} FROM bookings bk WHERE business_id = ? AND status = 'approved' AND check_in <= ? AND check_out > ? AND stay_id IS NULL
    AND NOT (bk.source = 'mmt' AND EXISTS (SELECT 1 FROM bookings m WHERE m.id = bk.match_id AND m.status = 'approved' AND m.stay_id IS NULL))
    ORDER BY guest_name`, bid, day, day) });
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
