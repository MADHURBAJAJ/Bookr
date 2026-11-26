// A MakeMyTrip booking paid online, that reception then enters in Djubo by hand and marks paid (26 Nov 2026): that is
// MakeMyTrip's payment, not cash at the desk, so no receipt is asked for and the room bill shows it paid before arrival.
// All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { setReader } from '../src/booking-readers';
import { shiftDayAt } from '../src/billing';

afterAll(dispose);

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ djubo: 'reports@djubo.example.test', mmt: 'alerts@mmt.example.test' }) });
let minute = 0;
const send = (businessId: string, from: string, id: string, line: string) => {
  minute += 1;
  const today = shiftDayAt(Date.now(), 8);
  const date = new Date(Date.parse(today + 'T00:00:00Z') + 9 * 3_600_000 - 19_800_000 + minute * 60_000).toUTCString();
  const raw = `From: ${from}\r\nTo: bookings@mail.example.test\r\nSubject: Booking\r\nMessage-ID: <${id}@example.test>\r\nDate: ${date}\r\nContent-Type: text/plain\r\n\r\n${line}\r\n`;
  return receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw).body!, setReject: () => undefined } as unknown as ForwardableEmailMessage, mailEnv(businessId) as never);
};
// "Booking REF | Name | phone | in | out | total ₹ | paid ₹ | entered by | MakeMyTrip no."
const fake = (channel: string) => (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, phone, checkIn, checkOut, total, paid, enteredBy, ota] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, phone, roomType: 'Deluxe', checkIn, checkOut, amountPaise: Math.round(Number(total) * 100), paidPaise: Math.round(Number(paid) * 100),
    channel, enteredBy: enteredBy || undefined, otaRef: ota || undefined, roomLabels: channel === 'MAKE MY TRIP' ? ['XI'] : undefined };
});

describe('an OTA booking entered in Djubo by hand', () => {
  it('is not desk money, whichever mail comes first', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    setReader('djubo', fake('MAKE MY TRIP'));
    setReader('mmt', fake('MyBiz'));
    await ok(s.owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] }));
    await ok(s.owner.call('PUT', `${B}/bookings/auto`, { from: '2026-01-01' }));
    await ok(s.owner.call('PUT', `${B}/bookings/booking-team`, { users: ['Sample Team'] }));
    const day = (await ok(s.owner.get('/me'))).business.shiftDay;
    const out = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);

    // MakeMyTrip first, then reception enters it in Djubo, first unpaid, then marked paid.
    await send(s.businessId, 'alerts@mmt.example.test', 'm1', `Booking NH900001 | Ota Guest | 9800030001 | ${day} | ${out} | 5000 | 5000 | | NH900001`);
    await send(s.businessId, 'reports@djubo.example.test', 'd1', `Booking DJ-OTA1 | Ota Guest | 9800030001 | ${day} | ${out} | 5000 | 0 | Sample Desk | NH900001`);
    await send(s.businessId, 'reports@djubo.example.test', 'd2', `Booking DJ-OTA1 | Ota Guest | 9800030001 | ${day} | ${out} | 5000 | 5000 | Sample Desk | NH900001`);
    // Djubo first this time, MakeMyTrip's mail after it.
    await send(s.businessId, 'reports@djubo.example.test', 'd3', `Booking DJ-OTA2 | Second Guest | 9800030002 | ${day} | ${out} | 4000 | 4000 | Sample Desk | NH900002`);
    expect((await ok(counter.get(`${B}/bookings`))).deskToTake.map((x: any) => x.extRef)).toEqual(['DJ-OTA2']);   // not yet known as MakeMyTrip's
    await send(s.businessId, 'alerts@mmt.example.test', 'm2', `Booking NH900002 | Second Guest | 9800030002 | ${day} | ${out} | 4000 | 4000 | | NH900002`);
    expect((await ok(counter.get(`${B}/bookings`))).deskToTake).toEqual([]);

    // Checked in: the room bill shows it paid before arrival, nothing to collect.
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    const bk = arr.find((a: any) => a.extRef === 'DJ-OTA1');
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Ota Guest', bookingId: bk.id }))).id;
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect([bill.prepaidPaise, bill.balancePaise]).toEqual([500_000, 0]);
  });
});
