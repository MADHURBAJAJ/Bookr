// Booking mails (23 Nov 2026): Gmail forwards the Djubo and MakeMyTrip mails to the POS's address; Cloudflare Email
// Routing hands them to this Worker. Each mail is kept as it came (R2, mail/<business>/<id>.eml) before anything is read,
// once per Message-ID; then its bookings are read into `bookings`. A mail that cannot be read stays kept and can be read
// again (after the reader is improved). Mail from anyone not listed in BOOKING_MAIL_FROM is turned away (it bounces back).
import PostalMime, { type Address, type Email } from 'postal-mime';
import { all, newId, now, one, stmt, type DB } from '../../src/db';
import type { Env } from './types';
import { readerFor, type ReadBooking } from './booking-readers';
import { phoneKeySoft } from './booking-readers';
import { linkWalkIn, recomputeDesk, syncStayRent } from './rooms';
import { linkReservation } from './routes/frontdesk';
import { tableLayout, type Business } from './util';

const GMAIL_CONFIRM = 'forwarding-noreply@google.com';
export type MailSource = 'mmt' | 'djubo' | 'gmail' | 'other';

export function businessFor(env: Env, to: string): string | null {
  try {
    const routes = JSON.parse(env.MAIL_ROUTES ?? '{}') as Record<string, string>;
    return Object.entries(routes).find(([a]) => a.trim().toLowerCase() === to.trim().toLowerCase())?.[1] ?? null;
  } catch { return null; }
}

/** Which kind of booking mail a sender sends (BOOKING_MAIL_FROM), Gmail's forwarding confirmation, or null (not wanted). */
export function sourceOf(env: Env, from: string): MailSource | null {
  const f = from.toLowerCase();
  if (f === GMAIL_CONFIRM) return 'gmail';
  let map: Record<string, string> = {};
  try { map = JSON.parse(env.BOOKING_MAIL_FROM ?? '{}'); } catch { /* not set */ }
  for (const [src, list] of Object.entries(map)) {
    if (src !== 'mmt' && src !== 'djubo') continue;
    if (list.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).some((x) => (x.startsWith('@') ? f.endsWith(x) : f === x))) return src;
  }
  return null;
}

const addressOf = (a: Address | undefined) => (a && 'address' in a && a.address ? a.address : a?.group?.[0]?.address ?? '').toLowerCase();

/** Cloudflare's email handler. */
export async function receiveMail(message: ForwardableEmailMessage, env: Env) {
  const businessId = businessFor(env, message.to);
  if (!businessId) { message.setReject('This address is not set up in Bookr POS.'); return; }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const mail = await PostalMime.parse(raw);
  const source = sourceOf(env, addressOf(mail.from));
  if (!source) { message.setReject('Bookr POS only reads booking mails from Djubo and MakeMyTrip.'); return; }
  await storeMail(env, businessId, raw, source, mail);
}

/** Keeps the mail (once per Message-ID) and reads it. Returns the stored mail's id, or null when it was already there. */
export async function storeMail(env: Env, businessId: string, raw: Uint8Array, source: MailSource, mail?: Email) {
  const db = env.DB;
  if (!env.BILLS) throw new Error('No mail store (R2) is set up.');
  mail ??= await PostalMime.parse(raw);
  const messageId = (mail.messageId ?? '').trim() || `sha256:${await sha256(raw)}`;
  if (await one(db, 'SELECT 1 FROM inbound_mails WHERE business_id = ? AND message_id = ?', businessId, messageId)) return null;
  const id = newId();
  const key = `mail/${businessId}/${id}.eml`;
  await env.BILLS.put(key, raw, { httpMetadata: { contentType: 'message/rfc822' } });
  const t = now();
  const receivedAt = mail.date && !Number.isNaN(Date.parse(mail.date)) ? Date.parse(mail.date) : t;
  await stmt(db, `INSERT INTO inbound_mails (id, business_id, message_id, from_addr, subject, source, received_at, r2_key, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', 'Not read yet.', ?) ON CONFLICT (business_id, message_id) DO NOTHING`,
    id, businessId, messageId, addressOf(mail.from), (mail.subject ?? '').slice(0, 300), source, receivedAt, key, t).run();
  await readMail(db, businessId, id, source, mail);
  return id;
}

/** Reads a kept mail again from R2 (after a reader is improved). */
export async function readAgain(env: Env, businessId: string, mailId: string) {
  const m = await one<{ r2_key: string; source: MailSource }>(env.DB, 'SELECT r2_key, source FROM inbound_mails WHERE id = ? AND business_id = ?', mailId, businessId);
  if (!m || !env.BILLS) return null;
  const obj = await env.BILLS.get(m.r2_key);
  if (!obj) return null;
  await readMail(env.DB, businessId, mailId, m.source, await PostalMime.parse(new Uint8Array(await obj.arrayBuffer())));
  return true;
}

async function readMail(db: DB, businessId: string, mailId: string, source: MailSource, mail: Email) {
  let status: 'read' | 'failed' | 'ignored';
  let note: string;
  if (source === 'gmail') {
    const link = /https:\/\/(?:mail-settings\.google\.com|mail\.google\.com)\/\S+/.exec(mail.text ?? mail.html ?? '')?.[0]?.replace(/[)>."']+$/, '');
    status = 'ignored';
    note = `Gmail asks to confirm forwarding to Bookr POS.${link ? ` Open ${link}` : ''}`;
  } else if (source === 'other') {
    status = 'ignored'; note = 'Not a booking mail.';
  } else {
    try {
      const found = readerFor(source)(mail);
      if (!found.length) { status = 'ignored'; note = 'No booking in this mail.'; } else {
        const b = (await one<Business>(db, 'SELECT id, name, fy_start_month, shift_start_hour, tab_age_days, tables, disc_limit_bp FROM businesses WHERE id = ?', businessId))!;
        const auto = (await one<{ a: number | null }>(db, 'SELECT bookings_auto_from AS a FROM businesses WHERE id = ?', businessId))!.a;
        for (const x of found) await saveBooking(db, b, auto, source, mailId, x);
        status = 'read'; note = `${found.length} booking${found.length === 1 ? '' : 's'} read.`;
      }
    } catch (e) {
      status = 'failed'; note = (e as Error).message.slice(0, 300);
    }
  }
  await stmt(db, 'UPDATE inbound_mails SET status = ?, note = ? WHERE id = ?', status, note, mailId).run();
}

/** Room type names the business knows (Settings, Rooms and tables), for checking what a mail says. */
const roomTypes = (b: Business) => (tableLayout(b) ?? []).filter((s) => s.kind === 'rooms' || s.kind === 'dorms').map((s) => s.name.toLowerCase());

/**
 * One booking as read: added, or brought up to date by its number. Why it needs a person is noted; a clean one goes in by
 * itself once automatic is on. The same stay from the other source (same phone or name, same check-in) is linked.
 */
export async function saveBooking(db: DB, b: Business, autoFrom: number | null, source: 'mmt' | 'djubo', mailId: string | null, x: ReadBooking) {
  const t = now();
  const phone = phoneKeySoft(x.phone);
  const known = roomTypes(b);
  const problem = [
    x.hold && 'website hold: not confirmed or paid yet',
    x.unplaced && 'Djubo could not place this booking on its room chart: create it in Djubo by hand',
    !x.guestName && 'no guest name',
    !x.checkIn && 'no check-in date',
    !x.checkOut && 'no check-out date',
    x.checkIn && x.checkOut && x.checkOut <= x.checkIn && 'check-out is not after check-in',
    x.roomType && known.length && !known.includes(x.roomType.toLowerCase()) && `room type "${x.roomType}" is not in Settings`,
    !x.roomType && 'no room type',
  ].filter(Boolean).join('; ') || null;
  const prev = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM bookings WHERE business_id = ? AND source = ? AND ext_ref = ?', b.id, source, x.extRef);
  const goesIn = !problem && !x.unplaced && autoFrom !== null && t >= autoFrom;
  const labels = x.roomLabels?.length ? x.roomLabels.join(', ').slice(0, 200) : null;
  const extra = [x.otaRef ?? null, x.pnr ?? null, labels, x.channel?.slice(0, 40) ?? null, x.unplaced ? 1 : 0,
    x.bookedAt ?? null, x.changedAt ?? null, x.mealPlan ?? null, x.requests ?? null, x.enteredBy ?? null] as const;
  if (prev) {
    // A later mail about the same booking (changed dates, cancelled): brought up to date; a checked-in one keeps its status.
    const status = x.cancelled ? 'cancelled' : prev.status === 'checked_in' ? 'checked_in' : prev.status === 'approved' && !problem ? 'approved' : goesIn ? 'approved' : 'new';
    await stmt(db, `UPDATE bookings SET guest_name = ?, phone = ?, room_type = ?, rooms = ?, guests = ?, check_in = ?, check_out = ?, amount_paise = coalesce(?, amount_paise), paid_paise = coalesce(?, paid_paise),
        status = ?, problem = ?, mail_id = coalesce(?, mail_id), how = CASE WHEN ? = 'approved' AND status <> 'approved' THEN 'auto' ELSE how END, updated_at = ?,
        ota_ref = coalesce(?, ota_ref), pnr = coalesce(?, pnr), room_labels = coalesce(?, room_labels), channel = coalesce(?, channel), unplaced = ?,
        booked_at = coalesce(?, booked_at), changed_at = coalesce(?, changed_at), meal_plan = coalesce(?, meal_plan), requests = ?, entered_by = coalesce(?, entered_by) WHERE id = ?`,
      x.guestName ?? null, phone, x.roomType ?? null, x.rooms ?? null, x.guests ?? null, x.checkIn ?? null, x.checkOut ?? null, x.amountPaise ?? null, x.paidPaise ?? null,
      status, problem, mailId, status, t, ...extra, prev.id).run();
    await afterSave(db, b.id, prev.id, x);
    await deskMoney(db, b.id, prev.id, source, mailId, x);
    // Already checked in (an extra night, a room change, a cancellation): the room's bill follows the booking.
    if (prev.status === 'checked_in') await syncStayRent(db, b.id, prev.id);
    else await linkWalkIn(db, b.id, prev.id);
    return prev.id;
  }
  const id = newId();
  await stmt(db, `INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, phone, room_type, rooms, guests, check_in, check_out, amount_paise, paid_paise,
      status, how, problem, mail_id, created_at, updated_at, ota_ref, pnr, room_labels, channel, unplaced, booked_at, changed_at, meal_plan, requests, entered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, b.id, source, x.extRef, x.guestName ?? null, phone, x.roomType ?? null, x.rooms ?? null, x.guests ?? null, x.checkIn ?? null, x.checkOut ?? null,
    x.amountPaise ?? null, x.paidPaise ?? null, x.cancelled ? 'cancelled' : goesIn ? 'approved' : 'new', goesIn && !x.cancelled ? 'auto' : null, problem, mailId, t, t, ...extra).run();
  await afterSave(db, b.id, id, x);
  await deskMoney(db, b.id, id, source, mailId, x);
  await linkWalkIn(db, b.id, id);
  return id;
}

/**
 * Money taken at reception (24 Nov 2026): each Djubo mail's advance is logged with who entered it, and the desk's part is
 * worked out again; an advance taken here before Djubo had the booking (same phone and check-in day) is attached to it.
 */
async function deskMoney(db: DB, bid: string, id: string, source: string, mailId: string | null, x: ReadBooking) {
  if (source === 'djubo' && mailId) {
    const m = await one<{ received_at: number }>(db, 'SELECT received_at FROM inbound_mails WHERE id = ?', mailId);
    await stmt(db, `INSERT INTO booking_paid_log (booking_id, mail_id, business_id, paid_paise, entered_by, received_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (booking_id, mail_id) DO UPDATE SET paid_paise = excluded.paid_paise, entered_by = excluded.entered_by`,
      id, mailId, bid, x.cancelled ? 0 : x.paidPaise ?? 0, x.enteredBy ?? null, m?.received_at ?? now()).run();
    await recomputeDesk(db, bid, id);
  }
  const phone = phoneKeySoft(x.phone);
  // A reservation made at the desk (25 Nov 2026) is linked when Djubo's mail for it arrives.
  if (!x.cancelled && !x.unplaced) await linkReservation(db, bid, id, phone, x.checkIn);
  if (phone && x.checkIn && !x.cancelled) {
    await stmt(db, `UPDATE desk_advances SET booking_id = ? WHERE business_id = ? AND booking_id IS NULL AND status = 'held' AND phone = ? AND check_in = ?`, id, bid, phone, x.checkIn).run();
  }
}

/** After a booking is saved: a Djubo alert for the same PNR is settled once Djubo has the booking; then the pair is linked. */
async function afterSave(db: DB, bid: string, id: string, x: ReadBooking) {
  if (!x.unplaced && x.pnr) {
    const ref = (await one<{ ext_ref: string }>(db, 'SELECT ext_ref FROM bookings WHERE id = ?', id))!.ext_ref;
    await stmt(db, `UPDATE bookings SET status = 'cancelled', problem = ?, updated_at = ? WHERE business_id = ? AND unplaced = 1 AND pnr = ? AND status = 'new'`,
      `Settled: Djubo now has it as ${ref}.`, now(), bid, x.pnr).run();
  }
  await linkMatch(db, bid, id);
}

/** Links a booking with the same stay read from the other source: same check-in, and the same phone or the same name. */
async function linkMatch(db: DB, bid: string, id: string) {
  const me = await one<{ source: string; ext_ref: string; phone: string | null; guest_name: string | null; check_in: string | null; match_id: string | null;
    ota_ref: string | null; pnr: string | null; unplaced: number }>(db,
    'SELECT source, ext_ref, phone, guest_name, check_in, match_id, ota_ref, pnr, unplaced FROM bookings WHERE id = ?', id);
  if (!me || me.match_id || me.unplaced) return;
  // Exactly by number: Djubo's Vendor Booking Id is the OTA's booking number; Djubo's Reference ID is the OTA's PNR.
  const byNo = await all<{ id: string }>(db, `SELECT id FROM bookings WHERE business_id = ? AND source <> ? AND unplaced = 0 AND match_id IS NULL
    AND ((? IS NOT NULL AND (ota_ref = ? OR ext_ref = ?)) OR (? IS NOT NULL AND pnr = ?))`, bid, me.source, me.ota_ref, me.ota_ref, me.ota_ref, me.pnr, me.pnr);
  if (byNo.length === 1) {
    await db.batch([stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', byNo[0].id, id), stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', id, byNo[0].id)]);
    return;
  }
  if (!me.check_in) return;
  const others = await all<{ id: string; phone: string | null; guest_name: string | null }>(db, `SELECT id, phone, guest_name FROM bookings
    WHERE business_id = ? AND source <> ? AND check_in = ? AND match_id IS NULL AND status <> 'cancelled' AND unplaced = 0`, bid, me.source, me.check_in);
  const same = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const hits = others.filter((o) => (me.phone && o.phone === me.phone) || same(o.guest_name, me.guest_name));
  if (hits.length !== 1) return;   // none, or not sure which: a person links it
  await db.batch([stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', hits[0].id, id), stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', id, hits[0].id)]);
}

async function sha256(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
