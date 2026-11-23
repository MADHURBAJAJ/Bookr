// The MakeMyTrip and Djubo readers (23 Nov 2026), on INVENTED mails built in the same HTML layout as the real ones.
// Every name, phone, booking number and amount here is made up.
import { afterAll, describe, expect, it } from 'vitest';
import type { Email } from 'postal-mime';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { dateOf, mailRows, paiseOf, readDjubo, readMmt, roomTypeOf, setReader } from '../src/booking-readers';

afterAll(dispose);

const tr = (...cells: string[]) => `<tr>${cells.map((c) => `<td style="padding:4px">${c}</td>`).join('')}</tr>`;
// Rows sit in nested tables, as in the real mails.
const page = (rows: string[]) => `<html><head><style>td{font:12px}</style></head><body><table><tr><td>${rows.map((r) => `<table>${r}</table>`).join('')}</td></tr></table></body></html>`;
const asMail = (subject: string, html: string) => ({ subject, html }) as unknown as Email;

/** A Go-MMT "Host Voucher": one "1 x ROOM" block per room. */
function mmtMail(o: { kind?: 'new' | 'cancel'; ref: string; guest: string; checkIn: string; checkOut: string; rooms: { name: string; people: string }[]; gross?: string; pay?: string; via?: string }) {
  const kind = o.kind ?? 'new';
  const rows = [
    tr('Host Voucher'), tr('Sample Stay Hostel <br>, Goa'), tr('PRIMARY GUEST DETAILS'), tr(`<span>${o.guest}</span>`),
    tr('CHECK-IN', 'CHECK-OUT'), tr(`${o.checkIn}<br>1:00 PM`, `${o.checkOut}<br>(1 Night)<br>11:00 AM`),
    tr('TOTAL NO. OF GUEST(S)'), ...(o.rooms.length === 1 ? [tr(o.rooms[0].people)] : []),
    tr('Booking ID'), tr(o.ref), tr(kind === 'new' ? 'Booked on' : 'Cancelled on'), tr("20 Nov &#39;26 03:49 PM"),
    tr('Booking Status'), tr(kind === 'new' ? 'Confirmed' : 'CANCELLED'),
    tr('Payment Status'), tr(o.pay ?? 'Paid Online'), tr('Booked Via'), tr(o.via ?? 'MakeMyTrip'), tr('PNR'), tr('0000000001'),
    tr(`${o.rooms.length} Room(s)`),
    ...o.rooms.flatMap((r) => [tr(`1 x ${r.name}`), tr(r.people, '&#8226;', 'Room Only'), tr('Cancellation Policy'), tr('&#8226;', 'Non-refundable.')]),
    tr('Payment'),
    ...(kind === 'new'
      ? [tr('Property Gross Charges'), tr(`&#8377; ${o.gross}`), tr('Payable to Property'), tr('&#8377; 1.00'),
         tr('Date', 'Room Charges (R)', 'Gross Charges (G=R+E+F+T)'), tr('Grand Total', '1.00', '1.00')]
      : [tr('Cancellation Charges (Payable to Property)'), tr('&#8377; 0.0')]),
  ];
  const subject = kind === 'new' ? `New Booking Received for Sample Stay Hostel on ${o.via ?? 'MakeMyTrip'} - ${o.ref}` : `Cancellation received for Booking ID : ${o.ref}`;
  return { subject, html: page(rows) };
}

/** A Djubo reservation mail: one table row per room. */
function djuboMail(o: { kind?: 'Confirmation' | 'Cancellation'; ref: string; guest: string; phone: string; checkIn: string; checkOut: string; rooms: [string, number, number][]; sub: string; taxes: string; advance?: string }) {
  const kind = o.kind ?? 'Confirmation';
  const rows = [
    tr(`Reservation ID <h2>${o.ref}</h2> Reference ID 0000000002`, `Check in <b>${o.checkIn}</b> 13:00 Check out <b>${o.checkOut}</b> 11:00`),
    tr('Guest Name', `: ${o.guest}`), tr('Guest<br>Email', ': guest@example.test'), tr('Guest<br>Contact No.', `:<br>91-<br>${o.phone}`),
    tr('Company Name', 'SAMPLE OTA'),
    tr('S.No.', 'Rooms', 'Nights', 'Adults', 'Children', 'Infants', 'Meal Plan', 'Rooms<br>No.', 'Currency', 'Total Net Price'),
    ...o.rooms.map(([name, adults, children], i) => tr(String(i + 1), name, '1', String(adults), String(children), '0', 'Room Only', `R ${i + 1}`, 'INR', '100.00')),
    tr('Rooms Rent', 'INR', o.sub), tr('Total', 'INR', o.sub), tr('Sub Total', 'INR', o.sub), tr('Total Taxes', 'INR', o.taxes),
    ...(o.advance ? [tr('Advance Amount', 'INR', o.advance)] : []), tr('Total outstanding amount', 'INR', '0.00'),
    ...(kind === 'Cancellation' ? [tr('<h4>CANCELLATION REMARK</h4> Booking has been cancelled through OTA')] : []),
    tr('Created By: Sample Person Created On: 20 Nov, 2026 16:40'), tr('Type of Reservation: OTA'),
  ];
  return { subject: `Reservation ${kind} - SAMPLE STAY HOSTEL - ${o.ref}`, html: page(rows) };
}

describe('reading helpers', () => {
  it('reads dates, amounts, room names and table rows', () => {
    expect(dateOf("05 Dec '26 1:00 PM")).toBe('2026-12-05');
    expect(dateOf('4 Jan, 2027 13:00:00')).toBe('2027-01-04');
    expect(dateOf('December 31, 2026')).toBe('2026-12-31');
    expect(dateOf('soon')).toBeUndefined();
    expect(paiseOf('₹ 1,234.50')).toBe(123450);
    expect(paiseOf('—')).toBeUndefined();
    expect(['PREMIUM ROOM FOR TWO (AC)', 'HEXA NEO', 'HEXA', 'Bed in Quad Sharing Dorm', 'BASIC PREMIUM', 'Luxury Room', 'SUITE ROOM', 'BOUTIQUE ROOMS', 'DELUXE', 'Treehouse'].map(roomTypeOf))
      .toEqual(['Premium Rooms', 'Hexa Neo', 'Hexa', 'Quad Sharing', 'Basic Premium', 'Luxury', 'Suite Room', 'Boutique Rooms', 'Deluxe', 'Treehouse']);
    expect(mailRows({ html: page([tr('A &amp; B', '', '<b>c</b>')]) })).toEqual([['A & B', 'c']]);
    expect(mailRows({ text: '| Guest Name | : Sample |\n\n' })).toEqual([['Guest Name', ': Sample']]);
  });
});

describe('MakeMyTrip reader', () => {
  it('reads a new booking', () => {
    const m = mmtMail({ ref: 'NH10000000000001', guest: 'Riya Sample', checkIn: "05 Dec &#39;26", checkOut: "07 Dec &#39;26", rooms: [{ name: 'PREMIUM ROOM FOR TWO (AC)', people: '2 Adults' }], gross: '2,345.60' });
    expect(readMmt(asMail(m.subject, m.html))).toEqual([{ extRef: 'NH10000000000001', guestName: 'Riya Sample', roomType: 'Premium Rooms', rooms: 1, guests: 2,
      checkIn: '2026-12-05', checkOut: '2026-12-07', amountPaise: 234560, paidPaise: 234560, cancelled: false }]);
  });

  it('adds up rooms and guests; pay at hotel is not paid; Goibibo has the same layout', () => {
    const m = mmtMail({ ref: 'GH10000000000002', guest: 'Kabir Example', checkIn: "30 Dec &#39;26", checkOut: "02 Jan &#39;27", via: 'GoIbibo', pay: 'Pay at Hotel',
      rooms: [{ name: 'HEXA NEO', people: '1 Adult' }, { name: 'HEXA NEO', people: '2 Adults, 1 Child' }], gross: '5,000.00' });
    expect(readMmt(asMail(m.subject, m.html))[0]).toMatchObject({ extRef: 'GH10000000000002', roomType: 'Hexa Neo', rooms: 2, guests: 4,
      checkIn: '2026-12-30', checkOut: '2027-01-02', amountPaise: 500000, paidPaise: undefined });
  });

  it('reads a cancellation, and mixed room types are kept for a person', () => {
    const m = mmtMail({ kind: 'cancel', ref: 'NH10000000000003', guest: 'Dev Placeholder', checkIn: "10 Dec &#39;26", checkOut: "11 Dec &#39;26",
      rooms: [{ name: 'LUXURY ROOM', people: '2 Adults' }, { name: 'DELUXE ROOM', people: '2 Adults' }] });
    expect(readMmt(asMail(m.subject, m.html))).toEqual([{ extRef: 'NH10000000000003', guestName: 'Dev Placeholder', roomType: 'Luxury, Deluxe', rooms: 2, guests: 4,
      checkIn: '2026-12-10', checkOut: '2026-12-11', amountPaise: undefined, paidPaise: undefined, cancelled: true }]);
  });

  it('leaves other MakeMyTrip mails alone, and says so when a booking mail cannot be read', () => {
    expect(readMmt(asMail('Your weekly performance report', page([tr('Hello partner')])))).toEqual([]);
    expect(() => readMmt(asMail('New Booking Received for Sample Stay Hostel on MakeMyTrip', page([tr('Something new')])))).toThrow(/Booking ID/);
  });
});

describe('Djubo reader', () => {
  it('reads a reservation with its phone, rooms, guests, amount and advance', () => {
    const m = djuboMail({ ref: 'XOX0000101', guest: 'Asha Testcase', phone: '9000000101', checkIn: '05 Dec, 2026', checkOut: '07 Dec, 2026',
      rooms: [['PREMIUM ROOMS', 2, 0]], sub: '2,000.00', taxes: '100.00', advance: '500.00' });
    expect(readDjubo(asMail(m.subject, m.html))).toEqual([{ extRef: 'XOX0000101', guestName: 'Asha Testcase', phone: '91- 9000000101', roomType: 'Premium Rooms',
      rooms: 1, guests: 2, checkIn: '2026-12-05', checkOut: '2026-12-07', amountPaise: 210000, paidPaise: 50000, cancelled: false }]);
  });

  it('counts each room row, and reads a cancellation', () => {
    const m = djuboMail({ kind: 'Cancellation', ref: 'XOX0000102', guest: 'Group Sample', phone: '9000000102', checkIn: '12 Dec, 2026', checkOut: '14 Dec, 2026',
      rooms: [['HEXA', 1, 0], ['HEXA', 1, 0], ['HEXA', 1, 1]], sub: '3,000.00', taxes: '150.00' });
    expect(readDjubo(asMail(m.subject, m.html))[0]).toMatchObject({ extRef: 'XOX0000102', roomType: 'Hexa', rooms: 3, guests: 4, amountPaise: 315000, paidPaise: undefined, cancelled: true });
  });

  it('leaves reports and no-show mails alone, and says so when a reservation mail cannot be read', () => {
    expect(readDjubo(asMail('SAMPLE STAY HOSTEL: Daily Property Inventory Report - 23 Nov, 2026', page([tr('Room Type', 'Available'), tr('DELUXE', '3')])))).toEqual([]);
    const ns = djuboMail({ ref: 'XOX0000103', guest: 'No Show', phone: '9000000103', checkIn: '01 Dec, 2026', checkOut: '02 Dec, 2026', rooms: [['DELUXE', 2, 0]], sub: '1.00', taxes: '0.00' });
    expect(readDjubo(asMail('No Show - SAMPLE STAY HOSTEL - XOX0000103', ns.html))).toEqual([]);
    expect(() => readDjubo(asMail('Reservation Confirmation - SAMPLE STAY HOSTEL - XOX0000104', page([tr('New layout')])))).toThrow(/Reservation ID/);
  });
});

describe('booking mails through the receiver', () => {
  it('a MakeMyTrip mail and its Djubo copy are read, saved and linked; a cancellation keeps the amount', async () => {
    setReader('mmt', readMmt); setReader('djubo', readDjubo);
    const s = await setupBusiness();
    await s.ok(s.owner.call('PUT', `${s.B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['Deluxe 1'] }] }));
    const e = { ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': s.businessId }),
      BOOKING_MAIL_FROM: JSON.stringify({ mmt: 'no-reply@mmt.example.test', djubo: 'notifications@djubo.example.test' }) };
    const send = async (from: string, id: string, m: { subject: string; html: string }) => {
      const raw = `From: ${from}\r\nTo: bookings@mail.example.test\r\nSubject: ${m.subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: Mon, 23 Nov 2026 10:00:00 +0530\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${m.html}\r\n`;
      await receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw).body!, setReject: (r: string) => { throw new Error(r); } } as unknown as ForwardableEmailMessage, e as never);
    };
    await send('no-reply@mmt.example.test', 'm1', mmtMail({ ref: 'NH10000000000009', guest: 'Pair Sample', checkIn: "05 Dec &#39;26", checkOut: "06 Dec &#39;26",
      rooms: [{ name: 'DELUXE ROOM', people: '2 Adults' }], gross: '1,500.00' }));
    await send('notifications@djubo.example.test', 'd1', djuboMail({ ref: 'XOX0000109', guest: 'Pair Sample', phone: '9000000109', checkIn: '05 Dec, 2026', checkOut: '06 Dec, 2026',
      rooms: [['DELUXE', 2, 0]], sub: '1,428.57', taxes: '71.43', advance: '1,500.00' }));
    // A Djubo report is kept but has no booking.
    await send('notifications@djubo.example.test', 'd2', { subject: 'SAMPLE STAY HOSTEL: Daily Sales Report', html: page([tr('Total', '0')]) });
    expect(await q('SELECT source, status, note FROM inbound_mails WHERE business_id = ? ORDER BY created_at', s.businessId)).toEqual([
      { source: 'mmt', status: 'read', note: '1 booking read.' }, { source: 'djubo', status: 'read', note: '1 booking read.' },
      { source: 'djubo', status: 'ignored', note: 'No booking in this mail.' }]);
    const rows = await q('SELECT source, ext_ref, guest_name, room_type, rooms, guests, check_in, check_out, amount_paise, problem, match_id IS NOT NULL AS linked FROM bookings WHERE business_id = ? ORDER BY source', s.businessId);
    expect(rows).toEqual([
      { source: 'djubo', ext_ref: 'XOX0000109', guest_name: 'Pair Sample', room_type: 'Deluxe', rooms: 1, guests: 2, check_in: '2026-12-05', check_out: '2026-12-06', amount_paise: 150000, problem: null, linked: 1 },
      { source: 'mmt', ext_ref: 'NH10000000000009', guest_name: 'Pair Sample', room_type: 'Deluxe', rooms: 1, guests: 2, check_in: '2026-12-05', check_out: '2026-12-06', amount_paise: 150000, problem: null, linked: 1 },
    ]);
    await send('no-reply@mmt.example.test', 'm2', mmtMail({ kind: 'cancel', ref: 'NH10000000000009', guest: 'Pair Sample', checkIn: "05 Dec &#39;26", checkOut: "06 Dec &#39;26",
      rooms: [{ name: 'DELUXE ROOM', people: '2 Adults' }] }));
    expect((await q("SELECT status, amount_paise FROM bookings WHERE business_id = ? AND source = 'mmt'", s.businessId))[0]).toEqual({ status: 'cancelled', amount_paise: 150000 });
  });
});
