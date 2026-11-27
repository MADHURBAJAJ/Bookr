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
    // What the OTA says was paid online counts when Djubo shows less (26 Nov 2026), never above the rent. A booking from
    // Djubo's daily report with no total keeps no rent here (owner's choice): its invoice is not the POS's.
    const ota = bk.source === 'djubo' && bk.amount_paise !== null ? (await one<{ p: number | null }>(db, `SELECT max(paid_paise) AS p FROM bookings
      WHERE id IN (SELECT value FROM json_each(?)) AND source = 'mmt' AND status <> 'cancelled'`, JSON.stringify(ids)))?.p ?? 0 : 0;
    const paid = live ? Math.min(Math.max(0, Math.max(bk.paid_paise ?? 0, ota) - bk.desk_paid_paise), rent) : 0;
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
/** The first shift day money marked in Djubo is counted in the POS on the day marked (26 Nov 2026). Tests set it. */
export const djuboDeskRule = { from: '2026-11-26' };

export async function recomputeDesk(db: DB, bid: string, bookingId: string, team?: string[], dry = false): Promise<number> {
  const noReceipt = team ?? await bookingTeam(db, bid);
  // Before the POS (26 Nov 2026, owner's choice): what reception marked in Djubo before djuboDeskRule.from was received then
  // (the paper register or the bank): it counts as paid before arrival, except what the POS itself took for the booking then
  // (a 25 Nov advance), which stays desk money so it is not counted twice. A guest who came before the POS and whose first
  // Djubo mail the POS sees only now: what that mail says was paid is the starting point, not desk money.
  const k = await one<{ check_in: string | null; h: number; stay_id: string | null; match_id: string | null }>(db,
    'SELECT k.check_in, b.shift_start_hour AS h, k.stay_id, k.match_id FROM bookings k JOIN businesses b ON b.id = k.business_id WHERE k.id = ?', bookingId);
  const cut = Date.parse(`${djuboDeskRule.from}T00:00:00Z`) + (k?.h ?? 8) * 3_600_000 - 19_800_000;
  const atDesk = (name: string | null) => { const n = (name ?? '').trim().toLowerCase(); return !!n && n !== 'system' && !noReceipt.includes(n); };
  // In the order Djubo made the changes (the booking's mail history), else as the mails came.
  const log = await all<{ paid_paise: number; entered_by: string | null; received_at: number }>(db, `SELECT l.paid_paise, l.entered_by, l.received_at FROM booking_paid_log l
    LEFT JOIN booking_versions v ON v.booking_id = l.booking_id AND v.mail_id = l.mail_id WHERE l.booking_id = ?
    ORDER BY coalesce(v.order_at, l.received_at), l.received_at, l.mail_id`, bookingId);
  let prev = 0;
  let desk = 0;
  let pre = 0;
  let at: number | null = null;
  const cameBefore = k?.check_in != null && k.check_in < djuboDeskRule.from;
  log.forEach((r, i) => {
    if (i === 0 && cameBefore && r.received_at >= cut) { prev = r.paid_paise; return; }   // first seen after go-live
    const d = r.paid_paise - prev;
    const early = r.received_at < cut;
    if (atDesk(r.entered_by)) {
      if (early) pre = d > 0 ? pre + d : Math.max(0, pre + d);
      else if (d > 0) { desk += d; at = r.received_at; } else if (d < 0) desk = Math.max(0, desk + d);
    } else if (d < 0) { desk = Math.min(desk, r.paid_paise); pre = Math.min(pre, r.paid_paise); }
    prev = r.paid_paise;
  });
  if (pre > 0) {
    // What the POS took for this booking before go-live (an advance, or a receipt on its room bill on the trial day).
    const posBefore = (await one<{ p: number }>(db, `SELECT coalesce((SELECT sum(p.amount_paise) FROM desk_advances d JOIN payments p ON p.settlement_id = d.settlement_id
        WHERE d.booking_id IN (?1, ?2) AND p.shift_day < ?4), 0)
      + coalesce((SELECT -sum(e.amount_paise) FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id JOIN payments p ON p.id = e.payment_id
        WHERE a.stay_id = ?3 AND e.kind IN ('receipt', 'advance') AND p.shift_day < ?4
          AND NOT EXISTS (SELECT 1 FROM desk_advances d WHERE d.settlement_id = p.settlement_id AND d.booking_id IN (?1, ?2))), 0) AS p`,
      bookingId, k?.match_id ?? '', k?.stay_id ?? '', djuboDeskRule.from))!.p;
    desk += Math.min(pre, posBefore);
  }
  // What its MakeMyTrip twin says was paid online is never desk money (26 Nov 2026): reception may enter an OTA booking in
  // Djubo by hand and mark it paid, which is the OTA's payment, not cash at the desk.
  const twin = await one<{ p: number | null }>(db, `SELECT max(paid_paise) AS p FROM bookings WHERE source = 'mmt' AND status <> 'cancelled'
    AND (id = (SELECT match_id FROM bookings WHERE id = ?1) OR match_id = ?1)`, bookingId);
  desk = Math.max(0, Math.min(desk, prev - (twin?.p ?? 0)));
  if (!dry) await stmt(db, 'UPDATE bookings SET desk_paid_paise = ?, desk_paid_at = ? WHERE id = ?', desk, desk ? at : null, bookingId).run();
  return desk;
}

/**
 * Money reception entered in Djubo that has no POS receipt yet: the desk's part of each booking less the advances taken
 * here for it and, once checked in, the payments taken on its room bill. A room bill's receipts cover its bookings once
 * between them, oldest night first (27 Nov 2026): with a booking per night, one receipt must not cover every night, or
 * money reception marked in Djubo without a POS receipt is never asked for.
 */
export async function deskPending(db: DB, bid: string) {
  const rows = await all<{ id: string; extRef: string; guestName: string | null; checkIn: string | null; checkOut: string | null; status: string; stayId: string | null;
    deskPaidPaise: number; deskPaidAt: number | null; enteredBy: string | null; heldPaise: number; linkedOnPaise: number; linkedOffPaise: number; poolPaise: number }>(db, `
    SELECT k.id, k.ext_ref AS extRef, k.guest_name AS guestName,
      k.check_in AS checkIn, k.check_out AS checkOut, k.status, k.stay_id AS stayId, k.desk_paid_paise AS deskPaidPaise, k.desk_paid_at AS deskPaidAt, k.entered_by AS enteredBy,
      coalesce((SELECT sum(d.amount_paise) FROM desk_advances d WHERE d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id)), 0) AS heldPaise,
      -- A POS receipt someone linked to this booking's Djubo payment ("already taken in the POS") always counts in full:
      -- on its room bill (or the group's first room's, 26 Nov 2026) ...
      coalesce((SELECT sum(p.amount_paise) FROM booking_paid_log l JOIN payments p ON p.settlement_id = l.settlement_id WHERE l.booking_id = k.id
        AND EXISTS (SELECT 1 FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id WHERE e.payment_id = p.id
          AND a.stay_id IN (k.stay_id, (SELECT g.group_stay_id FROM stays g WHERE g.id = k.stay_id)))
        AND NOT EXISTS (SELECT 1 FROM desk_advances d WHERE d.settlement_id = p.settlement_id AND d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id))), 0) AS linkedOnPaise,
      -- ... or not on it.
      coalesce((SELECT sum(p.amount_paise) FROM booking_paid_log l JOIN payments p ON p.settlement_id = l.settlement_id WHERE l.booking_id = k.id
        AND NOT EXISTS (SELECT 1 FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id WHERE e.payment_id = p.id
          AND a.stay_id IN (k.stay_id, (SELECT g.group_stay_id FROM stays g WHERE g.id = k.stay_id)))
        AND NOT EXISTS (SELECT 1 FROM desk_advances d WHERE d.settlement_id = p.settlement_id AND d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id))), 0) AS linkedOffPaise,
      -- Receipts on the room bill, past what they paid of food and other charges (26 Nov 2026): a food payment must not
      -- hide rent reception took in Djubo.
      max(0, coalesce((SELECT -sum(e.amount_paise) FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id
          WHERE a.stay_id IN (k.stay_id, (SELECT g.group_stay_id FROM stays g WHERE g.id = k.stay_id)) AND e.kind IN ('receipt', 'advance') AND e.payment_id IS NOT NULL), 0)
        - max(0, coalesce((SELECT sum(e.amount_paise) FROM debtor_entries e JOIN debtor_accounts a ON a.id = e.account_id
          WHERE a.stay_id IN (k.stay_id, (SELECT g.group_stay_id FROM stays g WHERE g.id = k.stay_id)) AND e.kind IN ('charge', 'credit_note', 'transfer')), 0))) AS poolPaise
    FROM bookings k WHERE k.business_id = ? AND k.desk_paid_paise > 0 AND k.status IN ('new', 'approved', 'checked_in')
    ORDER BY k.check_in, k.desk_paid_at, k.id`, bid);
  // Per room bill: what its receipts have left once the linked ones are taken out, shared oldest night first.
  const left = new Map<string, number>();
  for (const r of rows) if (r.stayId && !left.has(r.stayId)) left.set(r.stayId, r.poolPaise);
  for (const r of rows) if (r.stayId) left.set(r.stayId, Math.max(0, left.get(r.stayId)! - r.linkedOnPaise));
  const out = rows.map((r) => {
    let covered = r.heldPaise + r.linkedOnPaise + r.linkedOffPaise;
    if (r.stayId) {
      const take = Math.min(left.get(r.stayId)!, Math.max(0, r.deskPaidPaise - covered));
      left.set(r.stayId, left.get(r.stayId)! - take);
      covered += take;
    }
    const { heldPaise: _h, linkedOnPaise: _on, linkedOffPaise: _off, poolPaise: _p, ...rest } = r;
    return { ...rest, coveredPaise: covered, pendingPaise: r.deskPaidPaise - covered };
  });
  return out.filter((r) => r.pendingPaise > 0).sort((a, b) => (a.deskPaidAt ?? 0) - (b.deskPaidAt ?? 0));
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

// ---------- extensions are made in Djubo (26 Nov 2026)

/** When Djubo changes a checked-in booking's dates, the stay and its group's beds leave when the bookings end. A date a
 *  manager extended by hand past the bookings stays. */
export async function followBookingDates(db: DB, bid: string, bookingId: string, oldCheckOut: string | null) {
  const k = await one<{ stay_id: string | null }>(db, 'SELECT stay_id FROM bookings WHERE id = ? AND business_id = ?', bookingId, bid);
  if (!k?.stay_id) return;
  const head = (await one<{ h: string }>(db, 'SELECT coalesce(group_stay_id, id) AS h FROM stays WHERE id = ?', k.stay_id))!.h;
  const end = (await one<{ e: string | null }>(db, `SELECT max(b.check_out) AS e FROM bookings b JOIN stays s ON s.id = b.stay_id
    WHERE (s.id = ?1 OR s.group_stay_id = ?1) AND b.status = 'checked_in'`, head))?.e;
  if (!end) return;
  await stmt(db, `UPDATE stays SET check_out_plan = ?1 WHERE (id = ?2 OR group_stay_id = ?2) AND checked_out_at IS NULL
    AND (check_out_plan IS NULL OR check_out_plan = ?3 OR check_out_plan < ?1)`, end, head, oldCheckOut ?? end).run();
}

/** Nights the guest stays that no rent covers: their bookings' last day plus nights a manager added by hand ("N extra
 *  night(s)", less any taken off), against the day they leave. Only for stays from bookings. */
export async function nightsNotCharged(db: DB, bid: string) {
  const rows = await all<{ id: string; room: string; guest_name: string; plan: string | null; booked_to: string | null; hand: string | null }>(db, `
    SELECT s.id, s.room, s.guest_name, s.check_out_plan AS plan,
      (SELECT max(b.check_out) FROM bookings b JOIN stays m ON m.id = b.stay_id WHERE (m.id = s.id OR m.group_stay_id = s.id) AND b.status = 'checked_in') AS booked_to,
      (SELECT json_group_array(json_object('a', e.amount_paise, 'n', e.note)) FROM debtor_entries e JOIN debtor_accounts d ON d.id = e.account_id JOIN stays m ON m.id = d.stay_id
        WHERE (m.id = s.id OR m.group_stay_id = s.id) AND e.kind = 'room_rent' AND e.booking_id IS NULL AND lower(e.note) LIKE '%extra night%') AS hand
    FROM stays s WHERE s.business_id = ? AND s.checked_out_at IS NULL AND s.group_stay_id IS NULL AND s.room NOT LIKE '%(past stay)'`, bid);
  const out: { stayId: string; room: string; guestName: string; plan: string; coveredTo: string; nights: number }[] = [];
  for (const r of rows) {
    if (!r.booked_to) continue;
    let hand = 0;
    for (const e of JSON.parse(r.hand ?? '[]') as { a: number; n: string }[]) {
      const n = Number(/(\d+)\s+extra night/i.exec(e.n ?? '')?.[1] ?? 1);
      hand += e.a > 0 ? n : e.a < 0 ? -n : 0;
    }
    const covered = new Date(Date.parse(r.booked_to) + Math.max(0, hand) * 86_400_000).toISOString().slice(0, 10);
    const plan = r.plan ?? r.booked_to;
    if (plan > covered) out.push({ stayId: r.id, room: r.room, guestName: r.guest_name, plan, coveredTo: covered, nights: Math.round((Date.parse(plan) - Date.parse(covered)) / 86_400_000) });
  }
  return out;
}

/** Guests in house tonight whose night has no rent (an overstay, or an extension not in Djubo): blocks the day's close. */
export async function tonightNotCharged(db: DB, bid: string, day: string) {
  const rows = await all<{ id: string; room: string; guest_name: string; booked_to: string | null; hand: string | null }>(db, `
    SELECT s.id, s.room, s.guest_name,
      (SELECT max(b.check_out) FROM bookings b JOIN stays m ON m.id = b.stay_id WHERE (m.id = s.id OR m.group_stay_id = s.id) AND b.status = 'checked_in') AS booked_to,
      (SELECT json_group_array(json_object('a', e.amount_paise, 'n', e.note)) FROM debtor_entries e JOIN debtor_accounts d ON d.id = e.account_id JOIN stays m ON m.id = d.stay_id
        WHERE (m.id = s.id OR m.group_stay_id = s.id) AND e.kind = 'room_rent' AND e.booking_id IS NULL AND lower(e.note) LIKE '%extra night%') AS hand
    FROM stays s WHERE s.business_id = ? AND s.checked_out_at IS NULL AND s.group_stay_id IS NULL AND s.room NOT LIKE '%(past stay)'`, bid);
  const out: { stayId: string; room: string; guestName: string; coveredTo: string }[] = [];
  for (const r of rows) {
    if (!r.booked_to) continue;
    let hand = 0;
    for (const e of JSON.parse(r.hand ?? '[]') as { a: number; n: string }[]) {
      const n = Number(/(\d+)\s+extra night/i.exec(e.n ?? '')?.[1] ?? 1);
      hand += e.a > 0 ? n : e.a < 0 ? -n : 0;
    }
    const covered = new Date(Date.parse(r.booked_to) + Math.max(0, hand) * 86_400_000).toISOString().slice(0, 10);
    if (covered <= day) out.push({ stayId: r.id, room: r.room, guestName: r.guest_name, coveredTo: covered });
  }
  return out;
}
