// Booking mails (23 Nov 2026): Gmail forwards the Djubo and MakeMyTrip mails to the POS's address; Cloudflare Email
// Routing hands them to this Worker. Each mail is kept as it came (R2, mail/<business>/<id>.eml) before anything is read,
// once per Message-ID; then its bookings are read into `bookings`. A mail that cannot be read stays kept and can be read
// again (after the reader is improved). Mail from anyone not listed in BOOKING_MAIL_FROM is turned away (it bounces back).
import PostalMime, { type Address, type Email } from 'postal-mime';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../../src/db';
import type { Env } from './types';
import { readDjuboReport, readerFor, type DjuboReport, type ReadBooking, type ReportRoom } from './booking-readers';
import { phoneKeySoft } from './booking-readers';
import { followBookingDates, linkWalkIn, recomputeDesk, syncStay, syncStayRent } from './rooms';
import { linkReservation } from './routes/frontdesk';
import { CLOSED_TO, clock, tableLayout, type Business } from './util';

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
  const from = addressOf(mail.from);
  const imp = await importOf(env, from, mail);
  if (typeof imp === 'string') { message.setReject(`Bookr POS only reads booking mails from Djubo and MakeMyTrip: ${imp.slice(8).replace(/[()]/g, '').trim()}.`); return; }
  if (imp) { await storeMail(env, businessId, raw, imp.source, imp.mail, imp); return; }
  const source = sourceOf(env, from);
  if (!source) { message.setReject('Bookr POS only reads booking mails from Djubo and MakeMyTrip.'); return; }
  await storeMail(env, businessId, raw, source, mail);
}

// ---------- Old booking mails, brought in once (25 Nov 2026) ----------
// The mails from before the POS read booking mails are forwarded once from the hotel's own mailbox (MAIL_IMPORT_FROM).
// Each forward carries a line "Bookr import <key> <Gmail id> <when the mail came, ISO, or - to take it from the forward's
// own header> <its sender>" with the key in the
// MAIL_IMPORT_KEY secret, which is set only while this runs. The forwarded mail is read with its sender's reader and
// counts as having come when the original did, so it never overrides a newer mail the POS already has.

export interface Imported { source: 'mmt' | 'djubo'; mail: Email; messageId: string; receivedAt: number }
const IMPORT_LINE = /Bookr\s+import\s+([A-Za-z0-9_-]{20,})\s+([0-9a-f]{8,20})\s+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z|-)\s+([^\s<>"]+@[^\s<>"]+)/;
/** Gmail's forward header: "---------- Forwarded message ---------" then "Date: Wed, Nov 4, 2026 at 5:54 AM" (the
 *  mailbox's time zone, UTC for this one). */
const FWD_DATE = /Forwarded message[\s\S]{0,400}?Date:\s*(?:[A-Za-z]{3},\s*)?([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP])M/i;
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function forwardedAt(flat: string): number | null {
  const m = FWD_DATE.exec(flat);
  const mon = m ? MONTHS_EN.indexOf(m[1].toLowerCase()) : -1;
  if (!m || mon < 0) return null;
  const h = (Number(m[4]) % 12) + (/p/i.test(m[6]) ? 12 : 0);
  return Date.UTC(Number(m[3]), mon, Number(m[2]), h, Number(m[5]));
}
const FWD = /^\s*(?:(?:fwd?|fw)\s*:\s*)+/i;

/** A forwarded old booking mail: what it is and its inner mail; 'refused (why)' when it is from the hotel's mailbox but not
 *  a valid import (no key, a wrong one, imports not open); null when it is not from the hotel's mailbox at all. */
export async function importOf(env: Env, from: string, mail: Email): Promise<Imported | `refused${string}` | null> {
  const box = (env.MAIL_IMPORT_FROM ?? '').trim().toLowerCase();
  if (!box || from !== box) return null;
  const key = env.MAIL_IMPORT_KEY ?? '';
  if (key.length < 20) return 'refused (imports are closed)';
  const flat = `${mail.text ?? ''}\n${(mail.html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&#64;/g, '@')}`;
  const m = IMPORT_LINE.exec(flat);
  if (!m) return 'refused (no import line)';
  if (!same(m[1], key)) return 'refused (wrong key)';
  const src = sourceOf(env, m[4].toLowerCase());
  if (src !== 'mmt' && src !== 'djubo') return 'refused (not a booking sender)';
  const at = m[3] === '-' ? forwardedAt(flat) : Date.parse(m[3]);
  if (at === null || Number.isNaN(at)) return 'refused (no date for the original mail)';
  return { source: src, mail: await innerOf(mail), messageId: `import:${m[2]}`, receivedAt: at };
}

/** The original inside a forward: an attached mail when there is one, else the forward itself without its "Fwd:". */
async function innerOf(mail: Email): Promise<Email> {
  const att = mail.attachments?.find((a) => /message\/rfc822/i.test(a.mimeType));
  if (att) {
    const inner = await PostalMime.parse(typeof att.content === 'string' ? att.content : new Uint8Array(att.content as ArrayBuffer));
    if (inner.html || inner.text) return inner;
  }
  return { ...mail, subject: (mail.subject ?? '').replace(FWD, '') };
}

/** Same length and same characters, compared without stopping early. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Keeps the mail (once per Message-ID) and reads it. Returns the stored mail's id, or null when it was already there. */
export async function storeMail(env: Env, businessId: string, raw: Uint8Array, source: MailSource, mail?: Email, imp?: Pick<Imported, 'messageId' | 'receivedAt'>) {
  const db = env.DB;
  if (!env.BILLS) throw new Error('No mail store (R2) is set up.');
  mail ??= await PostalMime.parse(raw);
  const messageId = imp?.messageId ?? ((mail.messageId ?? '').trim() || `sha256:${await sha256(raw)}`);
  if (await one(db, 'SELECT 1 FROM inbound_mails WHERE business_id = ? AND message_id = ?', businessId, messageId)) return null;
  const id = newId();
  const key = `mail/${businessId}/${id}.eml`;
  await env.BILLS.put(key, raw, { httpMetadata: { contentType: 'message/rfc822' } });
  const t = now();
  const receivedAt = imp?.receivedAt ?? (mail.date && !Number.isNaN(Date.parse(mail.date)) ? Date.parse(mail.date) : t);
  await stmt(db, `INSERT INTO inbound_mails (id, business_id, message_id, from_addr, subject, source, received_at, r2_key, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', 'Not read yet.', ?) ON CONFLICT (business_id, message_id) DO NOTHING`,
    id, businessId, messageId, addressOf(mail.from), (mail.subject ?? '').slice(0, 300), source, receivedAt, key, t).run();
  await readMail(db, businessId, id, source, mail, imp ? receivedAt : null);
  return id;
}

/** The bookings a kept mail says (no change made), for building each booking's history (26 Nov 2026). */
export async function bookingsInMail(env: Env, businessId: string, mailId: string) {
  const m = await one<{ r2_key: string; source: MailSource; message_id: string; received_at: number }>(env.DB,
    'SELECT r2_key, source, message_id, received_at FROM inbound_mails WHERE id = ? AND business_id = ?', mailId, businessId);
  if (!m || !env.BILLS || (m.source !== 'djubo' && m.source !== 'mmt')) return null;
  const obj = await env.BILLS.get(m.r2_key);
  if (!obj) return null;
  let mail = await PostalMime.parse(new Uint8Array(await obj.arrayBuffer()));
  if (m.message_id.startsWith('import:')) mail = await innerOf(mail);
  if (m.source === 'djubo' && readDjuboReport(mail)) return null;
  try { return { source: m.source, came: m.received_at, found: readerFor(m.source)(mail) }; } catch { return null; }
}

/** Adds kept mails read before the history began to their bookings' history (26 Nov 2026), a batch at a time (the cron).
 *  Changes no booking: each mail's line is what it said, in Djubo's order. */
export async function buildHistory(env: Env, limit = 40) {
  const db = env.DB;
  const ms = await all<{ id: string; business_id: string }>(db, `SELECT id, business_id FROM inbound_mails WHERE history_at IS NULL AND status = 'read'
    AND source IN ('djubo', 'mmt') ORDER BY received_at LIMIT ?`, limit);
  for (const m of ms) {
    const r = await bookingsInMail(env, m.business_id, m.id).catch(() => null);
    for (const x of r?.found ?? []) {
      const k = await one<{ id: string }>(db, 'SELECT id FROM bookings WHERE business_id = ? AND source = ? AND ext_ref = ?', m.business_id, r!.source, x.extRef);
      if (k) await stmt(db, `INSERT INTO booking_versions (booking_id, mail_id, business_id, order_at, received_at, data, status) VALUES (?, ?, ?, ?, ?, ?, 'applied')
        ON CONFLICT (booking_id, mail_id) DO NOTHING`, k.id, m.id, m.business_id, orderOf(r!.source, x, r!.came), r!.came, JSON.stringify(x)).run();
    }
    await stmt(db, 'UPDATE inbound_mails SET history_at = ? WHERE id = ?', now(), m.id).run();
  }
  return ms.length;
}

/** Reads a kept mail again from R2 (after a reader is improved). */
export async function readAgain(env: Env, businessId: string, mailId: string) {
  const m = await one<{ r2_key: string; source: MailSource; message_id: string; received_at: number }>(env.DB,
    'SELECT r2_key, source, message_id, received_at FROM inbound_mails WHERE id = ? AND business_id = ?', mailId, businessId);
  if (!m || !env.BILLS) return null;
  const obj = await env.BILLS.get(m.r2_key);
  if (!obj) return null;
  const mail = await PostalMime.parse(new Uint8Array(await obj.arrayBuffer()));
  const imported = m.message_id.startsWith('import:');
  await readMail(env.DB, businessId, mailId, m.source, imported ? await innerOf(mail) : mail, imported ? m.received_at : null);
  return true;
}

async function readMail(db: DB, businessId: string, mailId: string, source: MailSource, mail: Email, importAt: number | null = null) {
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
      // Djubo's daily reports (24 Nov 2026): fill in bookings from before the POS read mails, and bring in guests staying.
      const report = source === 'djubo' ? readDjuboReport(mail) : null;
      if (report) {
        const b = (await one<Business>(db, `SELECT id, name, fy_start_month, shift_start_hour, tab_age_days, tables, disc_limit_bp, ${CLOSED_TO} FROM businesses WHERE id = ?`, businessId))!;
        note = await applyReport(db, b, mailId, report);
        status = 'read';
        await stmt(db, 'UPDATE inbound_mails SET status = ?, note = ? WHERE id = ?', status, note, mailId).run();
        return;
      }
      const found = readerFor(source)(mail);
      if (!found.length) { status = 'ignored'; note = 'No booking in this mail.'; } else {
        const b = (await one<Business>(db, `SELECT id, name, fy_start_month, shift_start_hour, tab_age_days, tables, disc_limit_bp, ${CLOSED_TO} FROM businesses WHERE id = ?`, businessId))!;
        const auto = (await one<{ a: number | null }>(db, 'SELECT bookings_auto_from AS a FROM businesses WHERE id = ?', businessId))!.a;
        const notes: string[] = [];
        for (const x of found) await saveBooking(db, b, auto, source, mailId, x, importAt === null ? undefined : { at: importAt, notes });
        status = 'read';
        note = importAt === null ? `${found.length} booking${found.length === 1 ? '' : 's'} read.` : `Old mail brought in: ${notes.join('; ')}.`.slice(0, 300);
      }
    } catch (e) {
      status = 'failed'; note = (e as Error).message.slice(0, 300);
    }
  }
  await stmt(db, 'UPDATE inbound_mails SET status = ?, note = ?, history_at = coalesce(history_at, ?) WHERE id = ?', status, note, now(), mailId).run();
}

/** A booking's room type checked against Settings (27 Nov 2026): a mixed one ("Quad Sharing, Hexa", a group) is checked
 *  part by part, and only the parts Settings does not have are named; null when every part is known. */
export function unknownTypes(type: string | undefined, known: string[]): string | null {
  if (!type || !known.length) return null;
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const k = known.map(norm);
  const missing = type.split(',').map((t) => t.trim()).filter(Boolean).filter((t) => !k.includes(norm(t)));
  return missing.length ? `room type "${missing.join(', ')}" is not in Settings` : null;
}

/** Room type names the business knows (Settings, Rooms and tables), for checking what a mail says. */
const roomTypes = (b: Business) => (tableLayout(b) ?? []).filter((s) => s.kind === 'rooms' || s.kind === 'dorms').map((s) => s.name.toLowerCase());

/**
 * One booking as read: added, or brought up to date by its number. Why it needs a person is noted; a clean one goes in by
 * itself once automatic is on. The same stay from the other source (same phone or name, same check-in) is linked.
 */
export async function saveBooking(db: DB, b: Business, autoFrom: number | null, source: 'mmt' | 'djubo', mailId: string | null, x: ReadBooking,
  imp?: { at: number; notes: string[] }, force = false) {
  const t = now();
  // The mail's place in the booking's history (26 Nov 2026): Djubo's own time of the change, else when the mail came.
  const came = mailId ? (await one<{ r: number }>(db, 'SELECT received_at AS r FROM inbound_mails WHERE id = ?', mailId))?.r ?? t : t;
  const orderAt = orderOf(source, x, imp?.at ?? came);
  const phone = phoneKeySoft(x.phone);
  if (imp) {
    // An old mail brought in (25 Nov 2026): only stays not over yet; never over a newer mail the POS already has (it only
    // fills what that booking lacks); a total typed at the desk stays, and Djubo's daily report has the last word on what
    // is still to collect.
    if (x.checkOut && x.checkOut < clock(b).shiftDay) { imp.notes.push(`${x.extRef} stay over, left out`); return null; }
    const old = await one<{ id: string; from_report: number; amount_paise: number | null; report_due_paise: number | null }>(db,
      'SELECT id, from_report, amount_paise, report_due_paise FROM bookings WHERE business_id = ? AND source = ? AND ext_ref = ?', b.id, source, x.extRef);
    if (old) {
      const last = await one<{ t: number | null }>(db, `SELECT max(t) AS t FROM (SELECT received_at AS t FROM booking_paid_log WHERE booking_id = ?1
        UNION ALL SELECT m.received_at FROM bookings k JOIN inbound_mails m ON m.id = k.mail_id WHERE k.id = ?1 AND k.from_report = 0)`, old.id);
      if (last?.t != null && last.t > imp.at) {
        await stmt(db, 'UPDATE bookings SET booked_at = coalesce(booked_at, ?), phone = coalesce(phone, ?) WHERE id = ?', x.bookedAt ?? null, phone, old.id).run();
        imp.notes.push(`${x.extRef} has a newer mail, only blanks filled`);
        return old.id;
      }
      if (old.from_report) {
        if (old.amount_paise !== null) {
          if (x.amountPaise !== undefined && x.amountPaise !== old.amount_paise) imp.notes.push(`${x.extRef} total typed at the desk kept (mail says ${(x.amountPaise / 100).toFixed(2)})`);
          x = { ...x, amountPaise: undefined, paidPaise: undefined };
        } else if (x.amountPaise !== undefined && old.report_due_paise !== null && old.report_due_paise <= x.amountPaise) {
          x = { ...x, paidPaise: x.amountPaise - old.report_due_paise };
        }
      }
      imp.notes.push(`${x.extRef} brought up to date`);
    } else imp.notes.push(`${x.extRef} added${x.cancelled ? ' (cancelled)' : ''}`);
  }
  const known = roomTypes(b);
  const problem = [
    x.hold && 'website hold: not confirmed or paid yet',
    x.unplaced && 'Djubo could not place this booking on its room chart: create it in Djubo by hand',
    !x.guestName && 'no guest name',
    !x.checkIn && 'no check-in date',
    !x.checkOut && 'no check-out date',
    x.checkIn && x.checkOut && x.checkOut <= x.checkIn && 'check-out is not after check-in',
    unknownTypes(x.roomType, known),
    !x.roomType && 'no room type',
  ].filter(Boolean).join('; ') || null;
  const prev = await one<{ id: string; status: string; amount_paise: number | null; paid_paise: number | null; check_in: string | null; check_out: string | null; rooms: number | null }>(db,
    'SELECT id, status, amount_paise, paid_paise, check_in, check_out, rooms FROM bookings WHERE business_id = ? AND source = ? AND ext_ref = ?', b.id, source, x.extRef);
  const goesIn = !problem && !x.unplaced && autoFrom !== null && t >= autoFrom;
  const labels = x.roomLabels?.length ? x.roomLabels.join(', ').slice(0, 200) : null;
  const extra = [x.otaRef ?? null, x.pnr ?? null, labels, x.channel?.slice(0, 40) ?? null, x.unplaced ? 1 : 0,
    x.bookedAt ?? null, x.changedAt ?? null, x.mealPlan ?? null, x.requests ?? null, x.enteredBy ?? null] as const;
  if (prev && mailId && !imp) {
    // History (26 Nov 2026): an older mail (read late, or read again) only fills what the booking lacks; a change that needs a
    // person is held; a mail someone already kept or that waits for a person stays as it is.
    const mine = await one<{ status: string }>(db, 'SELECT status FROM booking_versions WHERE booking_id = ? AND mail_id = ?', prev.id, mailId);
    const newer = await one(db, `SELECT 1 FROM booking_versions WHERE booking_id = ? AND mail_id <> ? AND status IN ('applied', 'held')
      AND (order_at > ? OR (order_at = ? AND received_at > ?))`, prev.id, mailId, orderAt, orderAt, came);
    const keep = async (status: string, reason: string | null = null) => stmt(db, `INSERT INTO booking_versions (booking_id, mail_id, business_id, order_at, received_at, data, status, held_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (booking_id, mail_id) DO UPDATE SET data = excluded.data, order_at = excluded.order_at,
        status = CASE WHEN booking_versions.status IN ('kept', 'held') AND excluded.status <> 'applied' THEN booking_versions.status ELSE excluded.status END,
        held_reason = coalesce(excluded.held_reason, booking_versions.held_reason)`, prev.id, mailId, b.id, orderAt, came, JSON.stringify(x), status, reason).run();
    if (!force && (mine?.status === 'kept' || mine?.status === 'held')) { await keep(mine.status); return prev.id; }
    if (newer) {
      await keep('older');
      await stmt(db, 'UPDATE bookings SET booked_at = coalesce(booked_at, ?), phone = coalesce(phone, ?), ota_ref = coalesce(ota_ref, ?), pnr = coalesce(pnr, ?) WHERE id = ?',
        x.bookedAt ?? null, phone, x.otaRef ?? null, x.pnr ?? null, prev.id).run();
      // Its paid amount still takes its place in the order of payments.
      await deskMoney(db, b.id, prev.id, source, mailId, x, false);
      return prev.id;
    }
    const reason = force ? null : holdReason(prev, x);
    if (reason) { await keep('held', reason); return prev.id; }
    await keep('applied');
    // A newer mail applied: older ones still waiting for a person are no longer the booking's latest.
    await stmt(db, `UPDATE booking_versions SET status = 'kept', held_reason = coalesce(held_reason, '') || ' (a newer mail came)'
      WHERE booking_id = ? AND mail_id <> ? AND status = 'held' AND order_at <= ?`, prev.id, mailId, orderAt).run();
  } else if (prev && mailId && imp) {
    await stmt(db, `INSERT INTO booking_versions (booking_id, mail_id, business_id, order_at, received_at, data, status) VALUES (?, ?, ?, ?, ?, ?, 'applied')
      ON CONFLICT (booking_id, mail_id) DO UPDATE SET data = excluded.data, order_at = excluded.order_at`, prev.id, mailId, b.id, orderAt, came, JSON.stringify(x)).run();
  }
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
    await deskMoney(db, b.id, prev.id, source, mailId, x, !!imp);
    // Already checked in (an extra night, a room change, a cancellation): the room's bill follows the booking, and the
    // stay (with its group's beds) leaves when the bookings end (26 Nov 2026: extensions are made in Djubo).
    if (prev.status === 'checked_in') { await followBookingDates(db, b.id, prev.id, prev.check_out); await syncStayRent(db, b.id, prev.id); }
    else await linkWalkIn(db, b.id, prev.id);
    return prev.id;
  }
  const id = newId();
  await stmt(db, `INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, phone, room_type, rooms, guests, check_in, check_out, amount_paise, paid_paise,
      status, how, problem, mail_id, created_at, updated_at, ota_ref, pnr, room_labels, channel, unplaced, booked_at, changed_at, meal_plan, requests, entered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, b.id, source, x.extRef, x.guestName ?? null, phone, x.roomType ?? null, x.rooms ?? null, x.guests ?? null, x.checkIn ?? null, x.checkOut ?? null,
    x.amountPaise ?? null, x.paidPaise ?? null, x.cancelled ? 'cancelled' : goesIn ? 'approved' : 'new', goesIn && !x.cancelled ? 'auto' : null, problem, mailId, t, t, ...extra).run();
  if (mailId) await stmt(db, `INSERT INTO booking_versions (booking_id, mail_id, business_id, order_at, received_at, data, status) VALUES (?, ?, ?, ?, ?, ?, 'applied')
    ON CONFLICT (booking_id, mail_id) DO NOTHING`, id, mailId, b.id, orderAt, came, JSON.stringify(x)).run();
  await afterSave(db, b.id, id, x);
  await deskMoney(db, b.id, id, source, mailId, x, !!imp);
  await linkWalkIn(db, b.id, id);
  return id;
}

/** A mail's place in its booking's history: Djubo prints when the booking was changed ("Modified On", else "Created On",
 *  India time); MakeMyTrip does not, so its mails go by when they came. */
export function orderOf(source: string, x: ReadBooking, came: number): number {
  const s = source === 'djubo' ? x.changedAt ?? x.bookedAt : undefined;
  const ms = s && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? Date.parse(`${s.replace(' ', 'T')}:00+05:30`) : NaN;
  return Number.isNaN(ms) ? came : ms;
}

/** Why a mail's change needs a person before it is applied (26 Nov 2026), or null. Differences under ₹1 are rounding. */
export function holdReason(prev: { status: string; amount_paise: number | null; paid_paise: number | null; check_in: string | null; check_out: string | null; rooms: number | null },
  x: ReadBooking): string | null {
  if (x.cancelled) return prev.status === 'checked_in' ? 'Cancelled while the guest is in house' : null;
  if (x.paidPaise !== undefined && x.amountPaise !== undefined && x.paidPaise > x.amountPaise + 100) return 'Paid is more than the total';
  if (x.paidPaise !== undefined && prev.paid_paise !== null && x.paidPaise < prev.paid_paise - 100) return 'What was paid went down';
  const same = (x.checkIn ?? prev.check_in) === prev.check_in && (x.checkOut ?? prev.check_out) === prev.check_out && (x.rooms ?? prev.rooms) === prev.rooms;
  if (same && x.amountPaise !== undefined && prev.amount_paise !== null && prev.amount_paise > 0
    && Math.abs(x.amountPaise - prev.amount_paise) > Math.max(50_000, prev.amount_paise / 5)) return 'The total changed a lot, with the same dates and rooms';
  return null;
}

/**
 * Money taken at reception (24 Nov 2026): each Djubo mail's advance is logged with who entered it, and the desk's part is
 * worked out again; an advance taken here before Djubo had the booking (same phone and check-in day) is attached to it.
 */
async function deskMoney(db: DB, bid: string, id: string, source: string, mailId: string | null, x: ReadBooking, before = false) {
  if (source === 'djubo' && mailId) {
    const m = await one<{ received_at: number }>(db, 'SELECT received_at FROM inbound_mails WHERE id = ?', mailId);
    await stmt(db, `INSERT INTO booking_paid_log (booking_id, mail_id, business_id, paid_paise, entered_by, received_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (booking_id, mail_id) DO UPDATE SET paid_paise = excluded.paid_paise, entered_by = excluded.entered_by`,
      // An old mail's advance was taken before the POS: it never asks for a POS receipt (no one at the desk entered it here).
      id, mailId, bid, x.cancelled ? 0 : before ? (await one<{ p: number | null }>(db, 'SELECT paid_paise AS p FROM bookings WHERE id = ?', id))?.p ?? 0 : x.paidPaise ?? 0,
      before ? null : x.enteredBy ?? null, m?.received_at ?? now()).run();
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
  await adoptTwin(db, bid, id);
  // Once paired, the Djubo side's desk money is checked against what MakeMyTrip says was paid online.
  const pair = await all<{ id: string }>(db, `SELECT id FROM bookings WHERE source = 'djubo' AND (id = ?1 OR match_id = ?1 OR id = (SELECT match_id FROM bookings WHERE id = ?1))`, id);
  for (const p of pair) await recomputeDesk(db, bid, p.id);
}

/** A MakeMyTrip booking whose mail has no room name (MakeMyTrip sometimes leaves it blank) takes the room type from its
 *  Djubo twin, and goes in with it, when that is the only thing it was waiting for (24 Nov 2026). */
async function adoptTwin(db: DB, bid: string, id: string) {
  const pair = await one<{ mmt: string; type: string }>(db, `SELECT m.id AS mmt, d.room_type AS type FROM bookings a JOIN bookings b ON b.id = a.match_id
    JOIN bookings m ON m.id IN (a.id, b.id) AND m.source = 'mmt' JOIN bookings d ON d.id IN (a.id, b.id) AND d.source = 'djubo'
    WHERE a.id = ? AND a.business_id = ? AND m.status = 'new' AND m.problem = 'no room type' AND d.status IN ('approved', 'checked_in') AND d.room_type IS NOT NULL`, id, bid);
  if (!pair) return;
  await stmt(db, "UPDATE bookings SET room_type = ?, problem = NULL, status = 'approved', how = 'auto', updated_at = ? WHERE id = ? AND status = 'new'", pair.type, now(), pair.mmt).run();
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
    await db.batch([stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', byNo[0].id, id), stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', id, byNo[0].id), ...followTwin(db, id, byNo[0].id)]);
    return;
  }
  if (!me.check_in) return;
  const others = await all<{ id: string; phone: string | null; guest_name: string | null }>(db, `SELECT id, phone, guest_name FROM bookings
    WHERE business_id = ? AND source <> ? AND check_in = ? AND match_id IS NULL AND status <> 'cancelled' AND unplaced = 0`, bid, me.source, me.check_in);
  const same = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const hits = others.filter((o) => (me.phone && o.phone === me.phone) || same(o.guest_name, me.guest_name));
  if (hits.length !== 1) return;   // none, or not sure which: a person links it
  await db.batch([stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', hits[0].id, id), stmt(db, 'UPDATE bookings SET match_id = ? WHERE id = ?', id, hits[0].id), ...followTwin(db, id, hits[0].id)]);
}

/** A twin that arrives after the stay began (26 Nov 2026: an old mail brought in, or a late OTA mail) is checked in with
 *  its pair, as a check-in does for both; the room bill counts a pair once. Either way round. */
function followTwin(db: DB, a: string, b: string) {
  const one_ = (x: string, y: string) => stmt(db, `UPDATE bookings SET status = 'checked_in', stay_id = (SELECT stay_id FROM bookings WHERE id = ?2), updated_at = ?3
    WHERE id = ?1 AND stay_id IS NULL AND status IN ('new', 'approved')
      AND EXISTS (SELECT 1 FROM bookings t WHERE t.id = ?2 AND t.status = 'checked_in' AND t.stay_id IS NOT NULL)`, x, y, now());
  return [one_(a, b), one_(b, a)];
}

/** Applies today's Djubo daily report (24 Nov 2026). An older report is kept but not applied, so reading mails again never
 *  brings back guests who have left. */
async function applyReport(db: DB, b: Business, mailId: string, rep: DjuboReport): Promise<string> {
  const today = clock(b).shiftDay;
  // Djubo sends them at about 7:30 am, before the 8 am day change: the report's date may be the day about to start.
  const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
  if (rep.day !== today && rep.day !== tomorrow) return `Djubo's daily report for ${rep.day}: only today's report is used.`;
  const t = now();
  if (rep.kind === 'front') {
    const known = roomTypes(b);
    let added = 0;
    for (const x of rep.bookings.filter((y) => y.section === 'arriving' || y.section === 'staying')) {
      if (await one(db, "SELECT 1 FROM bookings WHERE business_id = ? AND source = 'djubo' AND ext_ref = ?", b.id, x.extRef)) continue;
      const problem = [!x.guestName && 'no guest name', !x.checkIn && 'no check-in date', !x.checkOut && 'no check-out date',
        unknownTypes(x.roomType, known)].filter(Boolean).join('; ') || null;
      const id = newId();
      await stmt(db, `INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, rooms, guests, check_in, check_out, status, how, problem, mail_id,
          created_at, updated_at, pnr, channel, meal_plan, from_report, report_due_paise) VALUES (?, ?, 'djubo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        id, b.id, x.extRef, x.guestName ?? null, x.roomType ?? null, x.rooms ?? null, x.guests ?? null, x.checkIn ?? null, x.checkOut ?? null,
        problem ? 'new' : 'approved', problem ? null : 'auto', problem, mailId, t, t, x.pnr ?? null, x.channel?.slice(0, 40) ?? null, x.mealPlan?.slice(0, 60) ?? null,
        x.duePaise ?? null).run();
      await linkMatch(db, b.id, id);
      added++;
    }
    return added ? `Daily report: ${added} booking${added === 1 ? '' : 's'} from before the POS read Djubo's mails added.` : 'Daily report: every booking is already here.';
  }
  // Rooms: room numbers for bookings that have none, and guests already staying brought in as in house.
  const byRef = new Map<string, ReportRoom[]>();
  for (const r of rep.rooms) byRef.set(r.extRef, [...(byRef.get(r.extRef) ?? []), r]);
  const layout = (tableLayout(b) ?? []).filter((s) => s.kind === 'rooms' || s.kind === 'dorms');
  const tables = layout.flatMap((s) => s.tables);
  const key = (x: string) => x.toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '');
  const tableOf = (label: string) => tables.find((x) => key(x) === key(label)) ?? null;
  let labelled = 0;
  let broughtIn = 0;
  for (const [ref, rows] of byRef) {
    const bk = await one<{ id: string; status: string; stay_id: string | null; room_labels: string | null; guest_name: string | null; check_in: string | null; check_out: string | null; guests: number | null }>(db,
      "SELECT id, status, stay_id, room_labels, guest_name, check_in, check_out, guests FROM bookings WHERE business_id = ? AND source = 'djubo' AND ext_ref = ? AND status <> 'cancelled'", b.id, ref);
    if (!bk) continue;
    const labels = [...new Set(rows.map((r) => r.room))];
    if (!bk.room_labels) { await stmt(db, 'UPDATE bookings SET room_labels = ?, updated_at = ? WHERE id = ?', labels.join(', ').slice(0, 200), t, bk.id).run(); labelled++; }
    if (!rows.some((r) => r.status === 'staying') || bk.stay_id || bk.status === 'checked_in' || !bk.guest_name) continue;
    // Never a second stay (26 Nov 2026): not when its MakeMyTrip copy is checked in, nor when a guest of the same name who
    // came the same day is already in house (checked in under another booking).
    if (await one(db, `SELECT 1 FROM bookings m WHERE m.business_id = ?1 AND m.stay_id IS NOT NULL AND (m.id = (SELECT match_id FROM bookings WHERE id = ?2) OR m.match_id = ?2)
      UNION ALL SELECT 1 FROM stays s WHERE s.business_id = ?1 AND s.checked_out_at IS NULL AND lower(trim(s.guest_name)) = lower(trim(?3)) AND s.check_in = ?4`,
      b.id, bk.id, bk.guest_name, bk.check_in ?? today)) continue;
    const room = labels.map(tableOf).find((x): x is string => !!x);
    if (!room) continue;
    const stayId = newId();
    try {
      await db.batch([
        stmt(db, `INSERT INTO stays (id, business_id, room, guest_name, check_in, created_at, check_out_plan, adults, before_pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          stayId, b.id, room, bk.guest_name, bk.check_in ?? today, t, bk.check_out, rows.reduce((n, r) => n + (r.adults ?? 0), 0) || bk.guests || null),
        stmt(db, "INSERT INTO debtor_accounts (id, business_id, kind, name, stay_id, created_at) VALUES (?, ?, 'room', ?, ?, ?)", newId(), b.id, `${room} · ${bk.guest_name}`, stayId, t),
        stmt(db, `UPDATE bookings SET status = 'checked_in', stay_id = ?, updated_at = ? WHERE business_id = ? AND status IN ('approved', 'new')
          AND (id = ?4 OR id = (SELECT match_id FROM bookings WHERE id = ?4))`, stayId, t, b.id, bk.id),
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) continue;   // the room already has a guest here
      throw e;
    }
    await syncStay(db, b.id, stayId);
    broughtIn++;
  }
  return `Daily rooms report: ${broughtIn} guest${broughtIn === 1 ? '' : 's'} already staying brought in; room numbers set on ${labelled} booking${labelled === 1 ? '' : 's'}.`;
}

async function sha256(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
