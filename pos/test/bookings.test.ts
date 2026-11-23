// Booking mails (23 Nov 2026): kept once, read by the reader for their sender, approved by a person (or by themselves
// once automatic is on), linked across Djubo and MakeMyTrip, and offered at check-in. All mails, names and numbers are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { setReader } from '../src/booking-readers';

afterAll(dispose);

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ mmt: '@mmt.example.test', djubo: 'reports@djubo.example.test' }) });
const raw = (from: string, subject: string, id: string, bodyText: string) =>
  `From: ${from}\r\nTo: bookings@mail.example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: Mon, 23 Nov 2026 10:00:00 +0530\r\nContent-Type: text/plain\r\n\r\n${bodyText}\r\n`;
function message(to: string, text: string) {
  const out = { rejected: null as string | null };
  return { out, msg: { to, raw: new Response(text).body!, setReject: (r: string) => { out.rejected = r; } } as unknown as ForwardableEmailMessage };
}
// An invented layout, standing in for the real reader: "Booking ABC | Name | phone | Room type | 2026-12-01 | 2026-12-03".
const fake = (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [ref, guestName, phone, roomType, checkIn, checkOut, cancel] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef: ref, guestName, phone, roomType, checkIn, checkOut, cancelled: cancel === 'cancelled' };
});

describe('booking mails', () => {
  it('keeps each mail once, turns away other senders, and waits for a reader', async () => {
    const s = await setupBusiness();
    const e = mailEnv(s.businessId);
    let m = message('nobody@mail.example.test', raw('a@mmt.example.test', 'x', 'r0', 'x'));
    await receiveMail(m.msg, e as never);
    expect(m.out.rejected).toMatch(/not set up/);
    m = message('bookings@mail.example.test', raw('spam@other.example.test', 'Offer', 'r1', 'Buy now'));
    await receiveMail(m.msg, e as never);
    expect(m.out.rejected).toMatch(/only reads booking mails/);
    // Gmail's forwarding confirmation is kept with its link.
    m = message('bookings@mail.example.test', raw('forwarding-noreply@google.com', 'Gmail Forwarding Confirmation', 'g1', 'Open https://mail-settings.google.com/mail/vf-abc123 to confirm'));
    await receiveMail(m.msg, e as never);
    // A MakeMyTrip mail its reader cannot read: kept, with why it was not read; the same mail again is not kept twice.
    for (let i = 0; i < 2; i++) await receiveMail(message('bookings@mail.example.test', raw('new@mmt.example.test', 'New Booking Received', 'm1', 'Booking X1 | A | 9800011111 | Deluxe | 2026-12-01 | 2026-12-02')).msg, e as never);
    const mails = await q('SELECT source, status, note FROM inbound_mails WHERE business_id = ? ORDER BY created_at', s.businessId);
    expect(mails).toEqual([
      { source: 'gmail', status: 'ignored', note: 'Gmail asks to confirm forwarding to Bookr POS. Open https://mail-settings.google.com/mail/vf-abc123' },
      { source: 'mmt', status: 'failed', note: expect.stringMatching(/did not have a Booking ID/) },
    ]);
    // Once the reader is improved, "Read again" reads the kept mail.
    setReader('mmt', fake);
    const id = (await q("SELECT id FROM inbound_mails WHERE source = 'mmt' AND business_id = ?", s.businessId))[0].id;
    await s.ok(s.counter.post(`${s.B}/mails/${id}/read-again`));
    expect((await s.ok(s.counter.get(`${s.B}/bookings`))).waiting).toMatchObject([{ extRef: 'X1', guestName: 'A', phone: '••••1111', status: 'new' }]);
  });

  it('a person approves or fixes; automatic later; linked across the two sources; offered at check-in', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const e = mailEnv(s.businessId);
    setReader('mmt', fake); setReader('djubo', fake);
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['Deluxe 1', 'Deluxe 2'] }] }));
    const send = (from: string, id: string, line: string) => receiveMail(message('bookings@mail.example.test', raw(from, 'Booking', id, line)).msg, e as never);
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
    await send('new@mmt.example.test', 'a1', `Booking MMT-1 | Sample Guest | +91 98000 22222 | Deluxe | ${day} | ${plus(2)}`);
    await send('new@mmt.example.test', 'a2', `Booking MMT-2 | Other Guest | 9800033333 | Penthouse | ${plus(1)} | ${plus(2)}`);
    await send('reports@djubo.example.test', 'a3', `Booking DJ-7 | sample guest | 9800022222 | Deluxe | ${day} | ${plus(2)}`);
    let r = await ok(counter.get(`${B}/bookings`));
    expect(r.waiting.map((x: any) => [x.extRef, x.problem])).toEqual([['MMT-1', null], ['DJ-7', null], ['MMT-2', 'room type "Penthouse" is not in Settings']]);
    // The MakeMyTrip and Djubo copies of one stay are linked (same check-in, same phone).
    const mmt1 = r.waiting.find((x: any) => x.extRef === 'MMT-1'); const dj7 = r.waiting.find((x: any) => x.extRef === 'DJ-7');
    expect([mmt1.matchId, dj7.matchId]).toEqual([dj7.id, mmt1.id]);
    // Approve one as read; fix the other's room type; cancel the Djubo copy.
    await ok(counter.post(`${B}/bookings/${mmt1.id}/approve`));
    const mmt2 = r.waiting.find((x: any) => x.extRef === 'MMT-2');
    expect((await counter.post(`${B}/bookings/${mmt2.id}/approve`, { checkOut: plus(1) })).status).toBe(400);
    await ok(counter.post(`${B}/bookings/${mmt2.id}/approve`, { roomType: 'Deluxe' }));
    await ok(counter.post(`${B}/bookings/${dj7.id}/cancel`));
    r = await ok(counter.get(`${B}/bookings`));
    expect(r.waiting).toEqual([]);
    expect(r.arriving.map((x: any) => [x.extRef, x.status, x.how])).toEqual([['MMT-1', 'approved', 'person'], ['MMT-2', 'approved', 'person']]);
    // Automatic: only a manager switches it; from then on a clean booking goes in by itself, an odd one still waits.
    expect((await counter.call('PUT', `${B}/bookings/auto`, { from: day })).status).toBe(403);
    await ok(owner.call('PUT', `${B}/bookings/auto`, { from: plus(-1) }));
    await send('new@mmt.example.test', 'a4', `Booking MMT-3 | Third Guest | 9800044444 | Deluxe | ${plus(3)} | ${plus(4)}`);
    await send('new@mmt.example.test', 'a5', `Booking MMT-4 | | 9800055555 | Deluxe | ${plus(3)} | ${plus(4)}`);
    r = await ok(counter.get(`${B}/bookings`));
    expect(r.arriving.find((x: any) => x.extRef === 'MMT-3')).toMatchObject({ status: 'approved', how: 'auto' });
    expect(r.waiting).toMatchObject([{ extRef: 'MMT-4', problem: 'no guest name' }]);
    // A later mail cancels a booking.
    await send('new@mmt.example.test', 'a6', `Booking MMT-3 | Third Guest | 9800044444 | Deluxe | ${plus(3)} | ${plus(4)} | cancelled`);
    expect((await q("SELECT status FROM bookings WHERE ext_ref = 'MMT-3' AND business_id = ?", s.businessId))[0].status).toBe('cancelled');
    // At check-in: today's arrivals, with the full phone to fill the form; checking in marks the booking.
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    expect(arr).toMatchObject([{ extRef: 'MMT-1', guestName: 'Sample Guest', phone: '9800022222' }]);
    await ok(counter.post(`${B}/stays`, { room: 'Deluxe 1', guestName: 'Sample Guest', phone: '9800022222', bookingId: arr[0].id }));
    expect((await q('SELECT status, stay_id FROM bookings WHERE id = ?', arr[0].id))[0]).toMatchObject({ status: 'checked_in', stay_id: expect.any(String) });
    // The cancelled Djubo copy stays cancelled; a matched pair checks in together (below, a fresh pair).
    expect((await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals).toEqual([]);
  });

  it('offers a MakeMyTrip and Djubo pair as one arrival and checks both in', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    setReader('mmt', fake); setReader('djubo', fake);
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['Deluxe 1'] }] }));
    await ok(owner.call('PUT', `${B}/bookings/auto`, { from: '2026-01-01' }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const out = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const e = mailEnv(s.businessId);
    await receiveMail(message('bookings@mail.example.test', raw('new@mmt.example.test', 'B', 'p1', `Booking MMT-9 | Pair Guest | 9800066666 | Deluxe | ${day} | ${out}`)).msg, e as never);
    await receiveMail(message('bookings@mail.example.test', raw('reports@djubo.example.test', 'B', 'p2', `Booking DJ-9 | Pair Guest | 9800066666 | Deluxe | ${day} | ${out}`)).msg, e as never);
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    expect(arr.map((x: any) => x.extRef)).toEqual(['MMT-9']);
    await ok(counter.post(`${B}/stays`, { room: 'Deluxe 1', guestName: 'Pair Guest', bookingId: arr[0].id }));
    expect((await q("SELECT ext_ref, status FROM bookings WHERE business_id = ? ORDER BY ext_ref", s.businessId))).toEqual([
      { ext_ref: 'DJ-9', status: 'checked_in' }, { ext_ref: 'MMT-9', status: 'checked_in' }]);
  });
});
