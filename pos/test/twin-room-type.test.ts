// A MakeMyTrip booking whose mail has no room name takes the room type from its Djubo twin and goes in (24 Nov 2026).
// Invented mails and names only.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { setReader } from '../src/booking-readers';

afterAll(dispose);

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ djubo: 'reports@djubo.example.test', mmt: 'noreply@mmt.example.test' }) });
let n = 0;
const send = (businessId: string, from: string, line: string) => {
  const raw = `From: ${from}\r\nTo: bookings@mail.example.test\r\nSubject: Booking\r\nMessage-ID: <tw${++n}@example.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${line}\r\n`;
  return receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw).body!, setReject: () => undefined } as unknown as ForwardableEmailMessage, mailEnv(businessId) as never);
};
// "Booking REF | Name | type (may be empty) | in | out | total | PNR"
const fake = (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, roomType, checkIn, checkOut, total, pnr] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, roomType: roomType || undefined, checkIn, checkOut, amountPaise: Number(total) * 100, paidPaise: Number(total) * 100, pnr, channel: 'MakeMyTrip' };
});

describe('MakeMyTrip booking with no room name', () => {
  it('takes the room type from its Djubo twin, whichever mail comes first; alone it waits', async () => {
    const s = await setupBusiness();
    setReader('djubo', fake); setReader('mmt', fake);
    await s.ok(s.owner.call('PUT', `${s.B}/tables`, { sections: [{ name: 'Hexa', kind: 'rooms', tables: ['VIII'] }] }));
    await s.ok(s.owner.call('PUT', `${s.B}/bookings/auto`, { from: '2026-01-01' }));
    const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
    const out = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const status = async (ref: string) => (await q('SELECT status, room_type, problem FROM bookings WHERE business_id = ? AND ext_ref = ?', s.businessId, ref))[0];
    // MakeMyTrip first, then Djubo.
    await send(s.businessId, 'noreply@mmt.example.test', `Booking NH0001 | Twin One | | ${day} | ${out} | 2000 | 0100000001`);
    expect(await status('NH0001')).toMatchObject({ status: 'new', problem: 'no room type' });
    await send(s.businessId, 'reports@djubo.example.test', `Booking XOX0001 | Twin One | Hexa | ${day} | ${out} | 2000 | 0100000001`);
    expect(await status('NH0001')).toMatchObject({ status: 'approved', room_type: 'Hexa', problem: null });
    // Djubo first, then MakeMyTrip.
    await send(s.businessId, 'reports@djubo.example.test', `Booking XOX0002 | Twin Two | Hexa | ${day} | ${out} | 1500 | 0100000002`);
    await send(s.businessId, 'noreply@mmt.example.test', `Booking NH0002 | Twin Two | | ${day} | ${out} | 1500 | 0100000002`);
    expect(await status('NH0002')).toMatchObject({ status: 'approved', room_type: 'Hexa' });
    // No Djubo twin: it still waits for a person.
    await send(s.businessId, 'noreply@mmt.example.test', `Booking NH0003 | Alone | | ${day} | ${out} | 1000 | 0100000003`);
    expect(await status('NH0003')).toMatchObject({ status: 'new', problem: 'no room type' });
  });
});
