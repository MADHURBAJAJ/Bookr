// Bookings from mail, items 1–4 (23 Nov 2026): Djubo and MakeMyTrip matched exactly by number, Djubo's room numbers and
// the balance still to pay offered at check-in, and Djubo's "could not place" alerts. All mails, names, numbers invented.
import { afterAll, describe, expect, it } from 'vitest';
import type { Email } from 'postal-mime';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { readDjubo, readMmt } from '../src/booking-readers';

afterAll(dispose);

const tr = (...cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const page = (rows: string[]) => `<html><body><table><tr><td>${rows.map((r) => `<table>${r}</table>`).join('')}</td></tr></table></body></html>`;
const asMail = (subject: string, html: string) => ({ subject, html }) as unknown as Email;

function djubo(o: { ref: string; pnr?: string; vendor?: string; guest: string; phone: string; ci: string; co: string; rooms: [string, string][]; sub: string; tax: string; adv: string; type?: string; company?: string }) {
  const rows = [
    tr(`Reservation ID <h2>${o.ref}</h2>${o.pnr ? ` Reference ID ${o.pnr}` : ''}`, `Check in <b>${o.ci}</b> 13:00 Check out <b>${o.co}</b> 11:00`),
    tr('Guest Name', `: ${o.guest}`), tr('Guest Email', ': guest@example.test'), tr('Guest Contact No.', `: 91- ${o.phone}`),
    ...(o.company ? [tr('Company Name', o.company)] : []),
    tr('S.No.', 'Rooms', 'Nights', 'Adults', 'Children', 'Infants', 'Meal Plan', 'Rooms<br>No.', 'Currency', 'Total Net Price'),
    ...o.rooms.map(([name, label], i) => tr(String(i + 1), name, '2', '1', '0', '0', 'Room Only', label, 'INR', '100.00')),
    tr('Sub Total', 'INR', o.sub), tr('Total Taxes', 'INR', o.tax), tr('Advance Amount', 'INR', o.adv), tr('Total outstanding amount', 'INR', '0.00'),
    tr(`<h4>SPECIAL REQUESTS</h4>${o.pnr ? ` Booking Reference No.: ${o.pnr}` : ''}${o.vendor ? ` Vendor Booking Id: ${o.vendor}` : ''}`),
    tr('Created By: System Created On: 23 Nov, 2026 00:39'), tr(`Type of Reservation: ${o.type ?? 'OTA'}`),
  ];
  return { subject: `Reservation Confirmation - SAMPLE STAY HOSTEL - ${o.ref}`, html: page(rows) };
}
function mmt(o: { ref: string; pnr: string; guest: string; ci: string; co: string }) {
  const rows = [tr('Host Voucher'), tr('PRIMARY GUEST DETAILS'), tr(o.guest), tr('CHECK-IN', 'CHECK-OUT'), tr(`${o.ci} 1:00 PM`, `${o.co} 11:00 AM`),
    tr('TOTAL NO. OF GUEST(S)'), tr('2 Adults'), tr('Booking ID'), tr(o.ref), tr('Booking Status'), tr('Confirmed'), tr('Payment Status'), tr('Paid Online'),
    tr('Booked Via'), tr('MakeMyTrip'), tr('PNR'), tr(o.pnr), tr('1 Room(s)'), tr('1 x DELUXE DOUBLE ROOM'), tr('2 Adults', '•', 'Room Only'),
    tr('Property Gross Charges'), tr('₹ 5,000.00')];
  return { subject: `New Booking Received for Sample Stay Hostel on MakeMyTrip - ${o.ref}`, html: page(rows) };
}
function unplaced(o: { pnr: string; guest: string; phone: string; ci: string; co: string; type: string }) {
  const rows = [tr(`Hi, Our system has detected an OTA booking for your property, which failed to get auto created in Djubo.`),
    tr('Booking Reference Number:', o.pnr), tr('Guest Name', o.guest), tr('Guest Email', 'guest@example.test'), tr('Guest Mobile No', o.phone),
    tr('Arrival Date:', o.ci), tr('Departure Date:', o.co), tr('Creation Date:', '23 Nov, 2026'), tr('Operation Type:', 'Confirm'),
    tr('Agency Name:', 'MAKE MY TRIP'), tr('Total Amount:', '4500.50'), tr('Number of Pax:', '1'), tr('Meal Plan:', 'EP'),
    tr('S.No.', 'Room category', 'No. of Rooms'), tr('1', o.type, '1')];
  return { subject: `ATTENTION - Continuous Room(s) unavailable - System Unable to generate/modify Automated Reservation for MAKE MY TRIP Booking Ref No ${o.pnr} - SAMPLE STAY HOSTEL`, html: page(rows) };
}

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ mmt: 'no-reply@mmt.example.test', djubo: 'notifications@djubo.example.test' }) });
const send = async (e: object, from: string, m: { subject: string; html: string }, id: string) => {
  const raw = `From: ${from}\r\nTo: bookings@mail.example.test\r\nSubject: ${m.subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: Mon, 23 Nov 2026 10:00:00 +0530\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${m.html}\r\n`;
  await receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw).body!, setReject: (r: string) => { throw new Error(r); } } as unknown as ForwardableEmailMessage, e as never);
};

describe('reading the extra details', () => {
  it('reads Djubo numbers, room numbers and channel; MakeMyTrip PNR; and a could-not-place alert', () => {
    const d = readDjubo(asMail(...Object.values(djubo({ ref: 'XOX0099001', pnr: '0100000001', vendor: 'NH10000000000001', guest: 'Asha Sample', phone: '9800012345',
      ci: '29 Nov, 2026', co: '01 Dec, 2026', rooms: [['QUAD SHARING', 'II B'], ['QUAD SHARING', 'II C']], sub: '2,000.00', tax: '100.00', adv: '1,000.00', company: 'MAKE MY TRIP' })) as [string, string]))[0];
    expect(d).toMatchObject({ extRef: 'XOX0099001', pnr: '0100000001', otaRef: 'NH10000000000001', roomLabels: ['II B', 'II C'], channel: 'MAKE MY TRIP',
      roomType: 'Quad Sharing', rooms: 2, amountPaise: 210000, paidPaise: 100000, checkIn: '2026-11-29', checkOut: '2026-12-01' });
    const direct = readDjubo(asMail(...Object.values(djubo({ ref: 'XOX0099002', guest: 'Ravi Sample', phone: '9800012346', ci: '27 Dec, 2026', co: '01 Jan, 2027',
      rooms: [['DELUXE', 'X']], sub: '1,000.00', tax: '50.00', adv: '0.00', type: 'Direct' })) as [string, string]))[0];
    expect(direct).toMatchObject({ channel: 'Direct', roomLabels: undefined, pnr: undefined });
    expect(readMmt(asMail(...Object.values(mmt({ ref: 'NH10000000000001', pnr: '0100000001', guest: 'Asha Sample', ci: "29 Nov '26", co: "01 Dec '26" })) as [string, string]))[0])
      .toMatchObject({ extRef: 'NH10000000000001', otaRef: 'NH10000000000001', pnr: '0100000001', channel: 'MakeMyTrip' });
    expect(readDjubo(asMail(...Object.values(unplaced({ pnr: '0100000009', guest: 'Neel Sample', phone: '9800012399', ci: '22 Nov, 2026', co: '27 Nov, 2026', type: 'QUAD SHARING' })) as [string, string]))[0])
      .toMatchObject({ extRef: 'ALERT-0100000009', pnr: '0100000009', unplaced: true, guestName: 'Neel Sample', phone: '9800012399', roomType: 'Quad Sharing',
        checkIn: '2026-11-22', checkOut: '2026-11-27', amountPaise: 450050, channel: 'MAKE MY TRIP' });
  });
});

describe('matching, check-in and alerts', () => {
  it('matches by number, offers Djubo at check-in with what is still to pay, and clears an alert once Djubo has the booking', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const e = mailEnv(s.businessId);
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Quad Sharing', kind: 'rooms', tables: ['II B', 'II C'] }, { name: 'Deluxe', kind: 'rooms', tables: ['D1'] }] }));
    await ok(owner.call('PUT', `${B}/bookings/auto`, { from: '2026-01-01' }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const fmtD = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}, ${y}`; };
    const out = new Date(Date.parse(day) + 2 * 86_400_000).toISOString().slice(0, 10);
    // The MakeMyTrip mail names a different guest spelling: the number decides.
    await send(e, 'no-reply@mmt.example.test', mmt({ ref: 'NH10000000000002', pnr: '0100000002', guest: 'A. Sample', ci: fmtD(day), co: fmtD(out) }), 'm1');
    await send(e, 'notifications@djubo.example.test', djubo({ ref: 'XOX0099003', pnr: '0100000002', vendor: 'NH10000000000002', guest: 'Asha Sample', phone: '9800012345',
      ci: fmtD(day), co: fmtD(out), rooms: [['QUAD SHARING', 'II B']], sub: '2,000.00', tax: '100.00', adv: '600.00', company: 'MAKE MY TRIP' }), 'd1');
    const rows = await q('SELECT ext_ref, match_id IS NOT NULL AS linked FROM bookings WHERE business_id = ? ORDER BY ext_ref', s.businessId);
    expect(rows).toEqual([{ ext_ref: 'NH10000000000002', linked: 1 }, { ext_ref: 'XOX0099003', linked: 1 }]);
    // At check-in: one guest, the Djubo copy, with its room number and ₹1,500 still to pay.
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    expect(arr).toMatchObject([{ extRef: 'XOX0099003', roomLabels: 'II B', phone: '9800012345', amountPaise: 210000, paidPaise: 60000 }]);

    // Djubo could not place an OTA booking: an alert, never approved by itself; cleared when Djubo's own confirmation for that PNR arrives.
    await send(e, 'notifications@djubo.example.test', unplaced({ pnr: '0100000009', guest: 'Neel Sample', phone: '9800012399', ci: fmtD(day), co: fmtD(out), type: 'QUAD SHARING' }), 'a1');
    let r = await ok(counter.get(`${B}/bookings`));
    expect(r.alerts).toMatchObject([{ extRef: 'ALERT-0100000009', guestName: 'Neel Sample', status: 'new', unplaced: 1 }]);
    expect(r.waiting.map((x: any) => x.extRef)).not.toContain('ALERT-0100000009');
    await send(e, 'notifications@djubo.example.test', djubo({ ref: 'XOX0099004', pnr: '0100000009', guest: 'Neel Sample', phone: '9800012399',
      ci: fmtD(day), co: fmtD(out), rooms: [['QUAD SHARING', 'II C']], sub: '4,000.00', tax: '200.00', adv: '4,200.00' }), 'd2');
    r = await ok(counter.get(`${B}/bookings`));
    expect(r.alerts).toEqual([]);
    expect((await q("SELECT status, problem FROM bookings WHERE ext_ref = 'ALERT-0100000009'"))[0]).toEqual({ status: 'cancelled', problem: 'Settled: Djubo now has it as XOX0099004.' });
    // A person can also mark an alert as done in Djubo.
    await send(e, 'notifications@djubo.example.test', unplaced({ pnr: '0100000010', guest: 'Ola Sample', phone: '9800012400', ci: fmtD(day), co: fmtD(out), type: 'HEXA' }), 'a2');
    const alert = (await ok(counter.get(`${B}/bookings`))).alerts[0];
    await ok(counter.post(`${B}/bookings/${alert.id}/cancel`));
    expect((await ok(counter.get(`${B}/bookings`))).alerts).toEqual([]);
  });
});
