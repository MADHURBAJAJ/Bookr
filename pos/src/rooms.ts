// Room billing (24 Nov 2026). Djubo keeps rooms, dates, rates and any advance taken before arrival; the room's folio
// here follows the booking: its room rent (GST included, as Djubo states it) and what was paid before arrival (to the OTA
// or the booking team). Money taken at the hotel is a receipt on the folio; at check-out one tax invoice is made for the
// stay's room rent. Food has its own bills already, so it is never on the room invoice.
import { all, newId, now, one, stmt, type DB } from '../../src/db';

const OTA = /make\s*my\s*trip|\bmmt\b|goibibo|booking\.com|agoda|expedia|airbnb|hostelworld|cleartrip|easemytrip|yatra|\bota\b/i;

/** Who was paid before arrival, as the folio shows it. */
export function prepaidNote(channel: string | null, source: string): string {
  if (source === 'mmt') return `Paid to ${channel && OTA.test(channel) ? channel : 'MakeMyTrip'}`;
  return channel && OTA.test(channel) ? `Paid to ${channel}` : 'Advance paid before arrival';
}

/** The booking a stay's rent follows: of a Djubo and MakeMyTrip pair, Djubo's (it has the advance and the GST). */
async function bookingOfStay(db: DB, stayId: string) {
  return one<{ id: string; source: string; amount_paise: number | null; paid_paise: number | null; channel: string | null; status: string }>(db,
    `SELECT id, source, amount_paise, paid_paise, channel, status FROM bookings WHERE stay_id = ? ORDER BY source = 'djubo' DESC, updated_at DESC LIMIT 1`, stayId);
}

/**
 * Brings a stay's room rent and prepaid amount in step with its booking: the difference from what is on the folio is
 * added (an extra night adds rent, a cancellation takes it all back). Nothing changes once the stay is invoiced.
 * Each is one statement, so the difference is worked out and written together.
 */
export async function syncStay(db: DB, bid: string, stayId: string) {
  if (await one(db, 'SELECT 1 FROM room_invoices WHERE stay_id = ?', stayId)) return;
  const acc = await one<{ id: string }>(db, "SELECT id FROM debtor_accounts WHERE stay_id = ? AND business_id = ? AND kind = 'room'", stayId, bid);
  const bk = await bookingOfStay(db, stayId);
  if (!acc || !bk) return;
  const live = bk.status !== 'cancelled';
  const rent = live ? Math.max(0, bk.amount_paise ?? 0) : 0;
  const paid = live ? Math.min(Math.max(0, bk.paid_paise ?? 0), rent) : 0;
  const t = now();
  const put = (kind: 'room_rent' | 'prepaid', target: number, note: string | null) => stmt(db, `INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, booking_id, note, at)
    SELECT ?, ?, ?, ?, x.d, ?, ?, ? FROM (SELECT ? - coalesce((SELECT sum(amount_paise) FROM debtor_entries WHERE account_id = ? AND kind = ? AND booking_id IS NOT NULL), 0) AS d) x
    WHERE x.d <> 0`, newId(), bid, acc.id, kind, bk.id, note, t, target, acc.id, kind);
  await db.batch([put('room_rent', rent, null), put('prepaid', -paid, prepaidNote(bk.channel, bk.source))]);
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
