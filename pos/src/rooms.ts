// Room billing (24 Nov 2026). Djubo keeps rooms, dates, rates and any advance taken before arrival; the room's folio
// here follows the booking: its room rent (GST included, as Djubo states it) and what was paid before arrival (to the OTA
// or the booking team). Money taken at the hotel is a receipt on the folio; at check-out one tax invoice is made for the
// stay's room rent. Food has its own bills already, so it is never on the room invoice.
import { all, newId, now, one, stmt, type DB } from '../../src/db';

const OTA = /make\s*my\s*trip|\bmmt\b|goibibo|booking\.com|agoda|expedia|airbnb|hostelworld|cleartrip|easemytrip|yatra|\bota\b/i;

/** Who was paid before arrival, as the folio shows it. */
export function prepaidNote(channel: string | null, source: string): string {
  if (source === 'mmt') return `Paid to ${channel && OTA.test(channel) ? channel : 'MakeMyTrip'}`;
  return channel && OTA.test(channel) ? `Paid to ${channel}` : 'Advance paid before arrival (booking team)';
}

/** The booking a stay's rent follows: of a Djubo and MakeMyTrip pair, Djubo's (it has the advance and the GST). */

/**
 * Brings a stay's room rent and prepaid amount in step with its booking: the difference from what is on the folio is
 * added (an extra night adds rent, a cancellation takes it all back). Nothing changes once the stay is invoiced.
 * Each is one statement, so the difference is worked out and written together.
 */
export async function syncStay(db: DB, bid: string, stayId: string) {
  if (await one(db, 'SELECT 1 FROM room_invoices WHERE stay_id = ?', stayId)) return;
  const acc = await one<{ id: string }>(db, "SELECT id FROM debtor_accounts WHERE stay_id = ? AND business_id = ? AND kind = 'room'", stayId, bid);
  if (!acc) return;
  const t0 = now();
  // Advances taken with a reservation made here (25 Nov 2026) move onto the room's bill, booking or not.
  const fromRes = await all<{ id: string; payment_id: string; amount_paise: number }>(db, `SELECT d.id, p.id AS payment_id, p.amount_paise FROM desk_advances d
    JOIN payments p ON p.settlement_id = d.settlement_id JOIN stays s ON s.reservation_id = d.reservation_id WHERE s.id = ? AND d.business_id = ? AND d.status = 'held'`, stayId, bid);
  if (fromRes.length) await db.batch([
    ...fromRes.map((h) => stmt(db, `INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, payment_id, note, at)
      SELECT ?, ?, ?, 'advance', ?, ?, 'Advance taken at hotel', ? WHERE NOT EXISTS (SELECT 1 FROM debtor_entries WHERE payment_id = ? AND account_id = ?)`,
      newId(), bid, acc.id, -h.amount_paise, h.payment_id, t0, h.payment_id, acc.id)),
    ...[...new Set(fromRes.map((h) => h.id))].map((id) => stmt(db, "UPDATE desk_advances SET status = 'applied', stay_id = ? WHERE id = ? AND status = 'held'", stayId, id))]);
  const units = await bookingUnits(db, stayId);
  if (!units.length) return;
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const { bk, ids } of units) {
    const live = bk.status !== 'cancelled';
    const rent = live ? Math.max(0, bk.amount_paise ?? 0) : 0;
    // Of Djubo's advance, the part reception entered was taken at the desk: it is collected here with a receipt (24 Nov 2026),
    // so only the rest counts as paid before arrival.
    const paid = live ? Math.min(Math.max(0, (bk.paid_paise ?? 0) - bk.desk_paid_paise), rent) : 0;
    const put = (kind: 'room_rent' | 'prepaid', target: number, note: string | null) => stmt(db, `INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, booking_id, note, at)
      SELECT ?, ?, ?, ?, x.d, ?, ?, ? FROM (SELECT ? - coalesce((SELECT sum(amount_paise) FROM debtor_entries WHERE account_id = ? AND kind = ?
        AND booking_id IN (SELECT value FROM json_each(?))), 0) AS d) x WHERE x.d <> 0`, newId(), bid, acc.id, kind, bk.id, note, t, target, acc.id, kind, JSON.stringify(ids));
    stmts.push(put('room_rent', rent, null), put('prepaid', -paid, prepaidNote(bk.channel, bk.source)));
  }
  // Advances taken at the desk before check-in, for its bookings (or their MakeMyTrip twins), move onto the room's bill.
  const held = await all<{ id: string; payment_id: string; amount_paise: number }>(db, `SELECT d.id, p.id AS payment_id, p.amount_paise FROM desk_advances d
    JOIN payments p ON p.settlement_id = d.settlement_id WHERE d.business_id = ? AND d.status = 'held' AND d.booking_id IN (SELECT id FROM bookings WHERE stay_id = ?)`, bid, stayId);
  await db.batch([...stmts,
    ...held.map((h) => stmt(db, `INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, payment_id, note, at)
      SELECT ?, ?, ?, 'advance', ?, ?, 'Advance taken at hotel', ? WHERE NOT EXISTS (SELECT 1 FROM debtor_entries WHERE payment_id = ? AND account_id = ?)`,
      newId(), bid, acc.id, -h.amount_paise, h.payment_id, t, h.payment_id, acc.id)),
    ...[...new Set(held.map((h) => h.id))].map((id) => stmt(db, "UPDATE desk_advances SET status = 'applied', stay_id = ? WHERE id = ? AND status = 'held'", stayId, id))]);
}

type UnitBooking = { id: string; source: string; amount_paise: number | null; paid_paise: number | null; desk_paid_paise: number; channel: string | null; status: string;
  match_id: string | null; check_in: string | null; check_out: string | null; rooms: number | null; ext_ref: string; room_labels: string | null };
/**
 * A stay's bookings as stays of their own (25 Nov 2026): usually one (Djubo's, with MakeMyTrip's copy of the same stay); an
 * extension made in Djubo as a new booking is a second. Each has the booking whose amounts count (Djubo's first) and the ids
 * of all its copies, so rent already on the bill under any copy is not added twice. With one, every booking of the stay is
 * its copy, as before.
 */
export async function bookingUnits(db: DB, stayId: string): Promise<{ bk: UnitBooking; ids: string[] }[]> {
  const all_ = await all<UnitBooking>(db, `SELECT id, source, amount_paise, paid_paise, desk_paid_paise, channel, status, match_id, check_in, check_out, rooms, ext_ref, room_labels
    FROM bookings WHERE stay_id = ? ORDER BY source = 'djubo' DESC, updated_at DESC`, stayId);
  const units: { bk: UnitBooking; ids: string[] }[] = [];
  for (const b of all_) {
    const twin = units.find((u) => u.ids.includes(b.match_id ?? '') || (b.id && all_.some((x) => u.ids.includes(x.id) && x.match_id === b.id)));
    if (twin) twin.ids.push(b.id); else units.push({ bk: b, ids: [b.id] });
  }
  if (units.length === 1) units[0].ids = all_.map((b) => b.id);
  return units;
}

// ---------- money taken at reception (24 Nov 2026)

/** The Djubo users of the booking team, whose money needs no POS receipt, as set in Settings (lower case). */
export async function bookingTeam(db: DB, bid: string): Promise<string[]> {
  const r = await one<{ u: string }>(db, 'SELECT no_receipt_users AS u FROM businesses WHERE id = ?', bid);
  try { return (JSON.parse(r?.u ?? '[]') as unknown[]).map((x) => String(x).trim().toLowerCase()).filter(Boolean); } catch { return []; }
}

/**
 * The part of a Djubo booking's advance taken at the desk, worked out from its mails in order: each increase in a mail made
 * or changed by anyone but the booking team and the OTAs ("System") is money taken at the desk; a decrease takes it back.
 * The same however often mails are read. (24 Nov 2026: by who needs no receipt, so a new or unlisted person needs one.)
 */
export async function recomputeDesk(db: DB, bid: string, bookingId: string, team?: string[]) {
  const noReceipt = team ?? await bookingTeam(db, bid);
  const atDesk = (name: string | null) => { const n = (name ?? '').trim().toLowerCase(); return !!n && n !== 'system' && !noReceipt.includes(n); };
  const log = await all<{ paid_paise: number; entered_by: string | null; received_at: number }>(db,
    'SELECT paid_paise, entered_by, received_at FROM booking_paid_log WHERE booking_id = ? ORDER BY received_at, mail_id', bookingId);
  let prev = 0;
  let desk = 0;
  let at: number | null = null;
  for (const r of log) {
    const d = r.paid_paise - prev;
    if (atDesk(r.entered_by)) {
      if (d > 0) { desk += d; at = r.received_at; } else if (d < 0) desk = Math.max(0, desk + d);
    } else if (d < 0) desk = Math.min(desk, r.paid_paise);
    prev = r.paid_paise;
  }
  // What its MakeMyTrip twin says was paid online is never desk money (26 Nov 2026): reception may enter an OTA booking in
  // Djubo by hand and mark it paid, which is the OTA's payment, not cash at the desk.
  const twin = await one<{ p: number | null }>(db, `SELECT max(paid_paise) AS p FROM bookings WHERE source = 'mmt' AND status <> 'cancelled'
    AND (id = (SELECT match_id FROM bookings WHERE id = ?1) OR match_id = ?1)`, bookingId);
  desk = Math.max(0, Math.min(desk, prev - (twin?.p ?? 0)));
  await stmt(db, 'UPDATE bookings SET desk_paid_paise = ?, desk_paid_at = ? WHERE id = ?', desk, desk ? at : null, bookingId).run();
}

/**
 * Money reception entered in Djubo that has no POS receipt yet: the desk's part of each booking less the advances taken
 * here for it and, once checked in, the payments taken on its room bill.
 */
export async function deskPending(db: DB, bid: string) {
  const rows = await all<{ id: string; extRef: string; guestName: string | null; checkIn: string | null; checkOut: string | null; status: string; stayId: string | null;
    deskPaidPaise: number; deskPaidAt: number | null; enteredBy: string | null; coveredPaise: number }>(db, `SELECT k.id, k.ext_ref AS extRef, k.guest_name AS guestName,
      k.check_in AS checkIn, k.check_out AS checkOut, k.status, k.stay_id AS stayId, k.desk_paid_paise AS deskPaidPaise, k.desk_paid_at AS deskPaidAt, k.entered_by AS enteredBy,
      coalesce((SELECT sum(d.amount_paise) FROM desk_advances d WHERE d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id)), 0)
      -- Receipts on the room bill cover it only past what they paid of food and other charges (26 Nov 2026): a food payment
      -- must not hide rent reception took in Djubo.
      -- A bed in a group has its payments on the group's first room (26 Nov 2026), so that bill counts too. A POS receipt
      -- someone linked to this booking's Djubo payment ("already taken in the POS") always counts in full.
      + max(coalesce((SELECT sum(p.amount_paise) FROM booking_paid_log l JOIN payments p ON p.settlement_id = l.settlement_id WHERE l.booking_id = k.id
          AND NOT EXISTS (SELECT 1 FROM desk_advances d WHERE d.settlement_id = p.settlement_id AND d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id))), 0),
        max(0, coalesce((SELECT -sum(e.amount_paise) FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id
          WHERE a.stay_id IN (k.stay_id, (SELECT g.group_stay_id FROM stays g WHERE g.id = k.stay_id)) AND e.kind IN ('receipt', 'advance') AND e.payment_id IS NOT NULL), 0)
        - max(0, coalesce((SELECT sum(e.amount_paise) FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id
          WHERE a.stay_id IN (k.stay_id, (SELECT g.group_stay_id FROM stays g WHERE g.id = k.stay_id)) AND e.kind IN ('charge', 'credit_note', 'transfer')), 0)))
        + coalesce((SELECT sum(p.amount_paise) FROM booking_paid_log l JOIN payments p ON p.settlement_id = l.settlement_id WHERE l.booking_id = k.id
          AND NOT EXISTS (SELECT 1 FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id WHERE e.payment_id = p.id
            AND a.stay_id IN (k.stay_id, (SELECT g.group_stay_id FROM stays g WHERE g.id = k.stay_id)))
          AND NOT EXISTS (SELECT 1 FROM desk_advances d WHERE d.settlement_id = p.settlement_id AND d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id))), 0)) AS coveredPaise
    FROM bookings k WHERE k.business_id = ? AND k.desk_paid_paise > 0 AND k.status IN ('new', 'approved', 'checked_in') ORDER BY k.desk_paid_at`, bid);
  return rows.map((r) => ({ ...r, pendingPaise: r.deskPaidPaise - r.coveredPaise })).filter((r) => r.pendingPaise > 0);
}

/**
 * A guest checked in by hand before Djubo had the booking (a walk-in in a rush): when the booking's mail arrives, it is
 * linked to the in-house room with no booking that has the same check-in day and the same phone, or the same Djubo room
 * number and first name. Only one clear match is linked; otherwise a person links it.
 */
export async function linkWalkIn(db: DB, bid: string, bookingId: string) {
  const k = await one<{ id: string; phone: string | null; guest_name: string | null; check_in: string | null; room_labels: string | null; status: string; problem: string | null;
    stay_id: string | null; unplaced: number }>(db, 'SELECT id, phone, guest_name, check_in, room_labels, status, problem, stay_id, unplaced FROM bookings WHERE id = ? AND business_id = ?', bookingId, bid);
  if (!k || k.stay_id || !['new', 'approved'].includes(k.status) || k.problem || k.unplaced || !k.check_in) return null;
  const stays = await all<{ id: string; room: string; guest_name: string; phone: string | null }>(db, `SELECT s.id, s.room, s.guest_name, s.phone FROM stays s
    WHERE s.business_id = ? AND s.checked_out_at IS NULL AND s.check_in = ? AND s.group_stay_id IS NULL AND NOT EXISTS (SELECT 1 FROM bookings x WHERE x.stay_id = s.id)`, bid, k.check_in);
  const flat = (t: string) => t.toLowerCase().replace(/\s+/g, '');
  const first = (t: string | null) => (t ?? '').trim().toLowerCase().replace(/^(mr|mrs|ms|dr)\.?\s*/, '').split(/\s+/)[0] ?? '';
  const labels = (k.room_labels ?? '').split(',').map(flat).filter(Boolean);
  const hits = stays.filter((s) => (k.phone && s.phone === k.phone) || (labels.includes(flat(s.room)) && first(s.guest_name) && first(s.guest_name) === first(k.guest_name)));
  if (hits.length !== 1) return null;
  await linkStay(db, bid, k.id, hits[0].id);
  return hits[0].id;
}

/** Links a booking (and its MakeMyTrip twin) to an in-house room: rent typed by hand as "Room rent…" gives way to the booking's. */
export async function linkStay(db: DB, bid: string, bookingId: string, stayId: string, replaceHand = true) {
  const acc = await one<{ id: string }>(db, "SELECT id FROM debtor_accounts WHERE stay_id = ? AND business_id = ? AND kind = 'room'", stayId, bid);
  const ref = (await one<{ ext_ref: string }>(db, 'SELECT ext_ref FROM bookings WHERE id = ?', bookingId))!.ext_ref;
  const byHand = acc && replaceHand ? (await one<{ s: number }>(db, `SELECT coalesce(sum(amount_paise), 0) AS s FROM debtor_entries
    WHERE account_id = ? AND kind = 'room_rent' AND booking_id IS NULL AND lower(note) LIKE 'room rent%'`, acc.id))!.s : 0;
  const t = now();
  await db.batch([
    stmt(db, `UPDATE bookings SET status = 'checked_in', stay_id = ?, updated_at = ? WHERE business_id = ? AND stay_id IS NULL
      AND (id = ?4 OR id = (SELECT match_id FROM bookings WHERE id = ?4))`, stayId, t, bid, bookingId),
    ...(acc && byHand > 0 ? [stmt(db, "INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, note, at) VALUES (?, ?, ?, 'room_rent', ?, ?, ?)",
      newId(), bid, acc.id, -byHand, `Room rent by hand, replaced by Djubo ${ref}`, t)] : []),
  ]);
  await syncStay(db, bid, stayId);
}

/** After a booking changes: its stay (if checked in) follows. */
export async function syncStayRent(db: DB, bid: string, bookingId: string) {
  const b = await one<{ stay_id: string | null }>(db, 'SELECT stay_id FROM bookings WHERE id = ? AND business_id = ?', bookingId, bid);
  if (b?.stay_id) await syncStay(db, bid, b.stay_id);
}

/** Days from one 'YYYY-MM-DD' to another, at least 1. */
export const nightsBetween = (from: string, to: string) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

/**
 * GST on room rent stated with GST included: 5% when the rent per room per night is up to ₹7,500, else 18%
 * (SAC 996311); none when the billing name is not registered for GST.
 */
export function roomTax(totalPaise: number, perNightPaise: number, gstRegistered: boolean) {
  const bp = !gstRegistered ? 0 : perNightPaise <= 750_000 ? 500 : 1800;
  const taxable = Math.round((totalPaise * 10_000) / (10_000 + bp));
  const tax = totalPaise - taxable;
  const cgst = Math.floor(tax / 2);
  return { bp, taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst };
}

/** What the room bill shows: every entry on the folio in plain words, with its bill or receipt number. */
export async function folioLines(db: DB, accountId: string) {
  return all<{ kind: string; amountPaise: number; at: number; note: string | null; billNo: string | null; mode: string | null; receiptNo: string | null; bookingRef: string | null }>(db,
    `SELECT e.kind, e.amount_paise AS amountPaise, e.at, e.note, b.bill_no AS billNo, p.mode, s.receipt_no AS receiptNo, k.ext_ref AS bookingRef
     FROM debtor_entries e LEFT JOIN bills b ON b.id = e.bill_id LEFT JOIN payments p ON p.id = e.payment_id LEFT JOIN settlements s ON s.id = p.settlement_id
     LEFT JOIN bookings k ON k.id = e.booking_id WHERE e.account_id = ? ORDER BY e.at, e.kind <> 'room_rent', e.id`, accountId);
}

/** A guest's name compared loosely: no Mr / Mrs / Ms / Dr, no spaces or dots, lower case. */
export const nameKey = (n: string | null | undefined) => String(n ?? '').toLowerCase().replace(/\b(mr|mrs|ms|miss|dr)\b\.?/g, ' ').replace(/[^a-z]/g, '');

/**
 * Who a new booking continues (25 Nov 2026): Djubo makes an extension as a new booking from the day the stay ends. The
 * guest's in-house rooms whose stay ends on the booking's first day, with the same phone or the same name.
 */
export async function continuesOf(db: DB, bid: string, bookings: { id: string; phone: string | null; guestName: string | null; checkIn: string | null }[]) {
  if (!bookings.length) return new Map<string, { id: string; room: string; guestName: string }[]>();
  const stays = await all<{ id: string; room: string; guest_name: string; phone: string | null; plan: string | null; check_in: string }>(db, `SELECT s.id, s.room, s.guest_name, s.phone, s.check_in,
      coalesce(s.check_out_plan, (SELECT max(k.check_out) FROM bookings k WHERE k.stay_id = s.id)) AS plan
    FROM stays s WHERE s.business_id = ? AND s.checked_out_at IS NULL AND s.room NOT LIKE '%(past stay)' ORDER BY s.room`, bid);
  const out = new Map<string, { id: string; room: string; guestName: string }[]>();
  for (const b of bookings) {
    // Ends on the booking's first day, or was already extended past it by hand (25 Nov 2026), having begun before it.
    const hits = stays.filter((s) => s.plan && b.checkIn && s.plan >= b.checkIn && s.check_in < b.checkIn
      && ((b.phone && s.phone === b.phone) || (nameKey(b.guestName).length >= 4 && nameKey(s.guest_name) === nameKey(b.guestName))));
    if (hits.length) out.set(b.id, hits.map((s) => ({ id: s.id, room: s.room, guestName: s.guest_name })));
  }
  return out;
}
