// Money reception marks in Djubo, counted in the POS on the day it was marked (26 Nov 2026, owner's choice). From that day,
// each increase in a Djubo booking's paid amount made by anyone but the booking team and the OTAs ("System") is listed
// on the day its mail came: in Day close, on Rooms › Today and on the guest's room bill. Someone picks how it was paid
// (cash, UPI or card); that makes a numbered POS receipt dated that day, on the room bill (or held as an advance until
// check-in). The day cannot close until each has a mode. What the POS already took for the booking (a receipt or an advance
// taken here first) covers it, so nothing is counted twice. Earlier money keeps the old "take it here" list.
import { all, type DB } from '../../src/db';
import { shiftDayAt } from './billing';
import { bookingTeam, deskPending, djuboDeskRule } from './rooms';

export { djuboDeskRule };

export interface DjuboPay {
  bookingId: string; mailId: string; extRef: string; guestName: string | null; checkIn: string | null; checkOut: string | null; roomLabels: string | null;
  stayId: string | null; by: string | null; at: number; day: string; amountPaise: number;
  /** Set once its mode is picked: the POS receipt. */
  settlementId: string | null; receiptNo: string | null; mode: string | null;
}

const IST = 19_800_000;
const dayStart = (day: string, startHour: number) => Date.parse(`${day}T00:00:00Z`) + startHour * 3_600_000 - IST;

/**
 * Reception's Djubo payments from djuboDeskRule.from on (all, or one booking's), and per booking what is left of the old
 * pending money (marked before then). Unconfirmed ones are trimmed to what the POS has not already taken for the booking.
 */
export async function djuboPays(db: DB, bid: string, startHour: number, bookingId?: string) {
  const team = await bookingTeam(db, bid);
  const atDesk = (name: string | null) => { const n = (name ?? '').trim().toLowerCase(); return !!n && n !== 'system' && !team.includes(n); };
  const cut = dayStart(djuboDeskRule.from, startHour);
  const rows = await all<{ booking_id: string; mail_id: string; paid_paise: number; entered_by: string | null; received_at: number; settlement_id: string | null;
    ext_ref: string; guest_name: string | null; check_in: string | null; check_out: string | null; room_labels: string | null; stay_id: string | null; status: string;
    receipt_no: string | null; mode: string | null; receipt_paise: number | null }>(db, `
    SELECT l.booking_id, l.mail_id, l.paid_paise, l.entered_by, l.received_at, l.settlement_id, k.ext_ref, k.guest_name, k.check_in, k.check_out, k.room_labels,
      -- The room bill it belongs on: a bed in a group has its payments on the group's first room (26 Nov 2026).
      (SELECT coalesce(g.group_stay_id, g.id) FROM stays g WHERE g.id = coalesce(k.stay_id, (SELECT m.stay_id FROM bookings m WHERE m.id = k.match_id))) AS stay_id, k.status,
      s.receipt_no, (SELECT min(p.mode) FROM payments p WHERE p.settlement_id = s.id) AS mode, (SELECT sum(p.amount_paise) FROM payments p WHERE p.settlement_id = s.id) AS receipt_paise
    FROM booking_paid_log l JOIN bookings k ON k.id = l.booking_id LEFT JOIN settlements s ON s.id = l.settlement_id
    WHERE l.business_id = ? AND k.source = 'djubo' ${bookingId ? 'AND l.booking_id = ?' : ''}
      AND l.booking_id IN (SELECT booking_id FROM booking_paid_log WHERE business_id = ? AND received_at >= ?)
    ORDER BY l.booking_id, l.received_at, l.mail_id`, ...(bookingId ? [bid, bookingId, bid, cut] : [bid, bid, cut]));
  const pending = new Map((await deskPending(db, bid)).map((p) => [p.id, p.pendingPaise]));
  const byBooking = new Map<string, typeof rows>();
  for (const r of rows) byBooking.set(r.booking_id, [...(byBooking.get(r.booking_id) ?? []), r]);
  const pays: DjuboPay[] = [];
  const lowered: { bookingId: string; extRef: string; guestName: string | null; paise: number }[] = [];
  const oldLeft = new Map<string, number>();
  for (const [id, log] of byBooking) {
    if (['cancelled'].includes(log[0].status)) continue;
    let prev = 0;
    let low = 0;
    const evs: (DjuboPay & { counted: boolean })[] = [];
    const unconfirmed = () => evs.filter((e) => !e.settlementId && e.amountPaise > 0);
    const cutBack = (by: number) => {   // takes money off the latest unconfirmed first; returns what it could not
      for (const e of unconfirmed().reverse()) { const x = Math.min(e.amountPaise, by); e.amountPaise -= x; by -= x; if (!by) break; }
      return by;
    };
    for (const r of log) {
      const d = r.paid_paise - prev;
      if (r.settlement_id || (d > 0 && atDesk(r.entered_by))) {
        evs.push({ bookingId: id, mailId: r.mail_id, extRef: r.ext_ref, guestName: r.guest_name, checkIn: r.check_in, checkOut: r.check_out, roomLabels: r.room_labels,
          stayId: r.stay_id, by: r.entered_by, at: r.received_at, day: shiftDayAt(r.received_at, startHour), amountPaise: r.settlement_id ? r.receipt_paise ?? d : d,
          settlementId: r.settlement_id, receiptNo: r.receipt_no, mode: r.mode, counted: r.received_at >= cut });
      } else if (d < 0) {
        const left = cutBack(-d);
        if (atDesk(r.entered_by) && evs.some((e) => e.settlementId)) low += left;
      }
      prev = r.paid_paise;
    }
    // What the POS already took for this booking covers unconfirmed money first (oldest first), so nothing is counted twice.
    const open = pending.get(id) ?? 0;
    const newOpen = unconfirmed().filter((e) => e.counted);
    let room = open;
    for (const e of newOpen.reverse()) { const keep = Math.min(e.amountPaise, room); room -= keep; e.amountPaise = keep; }
    if (room > 0) oldLeft.set(id, room);
    for (const e of evs) if (e.counted && e.amountPaise > 0) { const { counted: _c, ...p } = e; pays.push(p); }
    if (low > 0) lowered.push({ bookingId: id, extRef: log[0].ext_ref, guestName: log[0].guest_name, paise: low });
  }
  pays.sort((a, b) => a.at - b.at);
  return { pays, lowered, oldLeft, touched: new Set(byBooking.keys()) };
}

/** The old "take it here" list (money marked before djuboDeskRule.from), less what the new way lists. */
export async function oldDeskPending(db: DB, bid: string, startHour: number) {
  const [rows, d] = await Promise.all([deskPending(db, bid), djuboPays(db, bid, startHour)]);
  return rows.map((r) => (d.touched.has(r.id) ? { ...r, pendingPaise: d.oldLeft.get(r.id) ?? 0 } : r)).filter((r) => r.pendingPaise > 0);
}
