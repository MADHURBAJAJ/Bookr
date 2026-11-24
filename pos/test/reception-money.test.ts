// Money taken at reception (24 Nov 2026): what reception enters in Djubo is asked for here so a POS receipt prints;
// the booking team's advance stays "paid before arrival". All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { readDjubo, setReader } from '../src/booking-readers';
import { shiftDayAt } from '../src/billing';

afterAll(dispose);

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ djubo: 'reports@djubo.example.test' }) });
let minute = 0;
const send = (businessId: string, id: string, line: string, subject = 'Booking') => {
  minute += 1;
  // In today's shift (9 am India time plus a minute each), so the test does not depend on the day it runs.
  const today = shiftDayAt(Date.now(), 8);
  const date = new Date(Date.parse(today + 'T00:00:00Z') + 9 * 3_600_000 - 19_800_000 + minute * 60_000).toUTCString();
  const raw = `From: reports@djubo.example.test\r\nTo: bookings@mail.example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: ${date}\r\nContent-Type: text/plain\r\n\r\n${line}\r\n`;
  return receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw).body!, setReject: () => undefined } as unknown as ForwardableEmailMessage, mailEnv(businessId) as never);
};
// "Booking REF | Name | phone | type | in | out | total ₹ | advance ₹ | entered by | room no".
const fake = (m: { text?: string; subject?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, phone, roomType, checkIn, checkOut, total, paid, enteredBy, room] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, phone, roomType, checkIn, checkOut, amountPaise: Math.round(Number(total) * 100), paidPaise: Math.round(Number(paid) * 100), channel: 'Direct',
    enteredBy, roomLabels: room ? [room] : undefined, hold: /hold/i.test(m.subject ?? '') || undefined };
});

async function hostel() {
  const s = await setupBusiness();
  setReader('djubo', fake);
  await s.ok(s.owner.call('PUT', `${s.B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] }));
  await s.ok(s.owner.call('PUT', `${s.B}/bookings/auto`, { from: '2026-01-01' }));
  await s.ok(s.owner.call('PUT', `${s.B}/bookings/reception`, { users: ['Sample Desk'] }));
  const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
  const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
  return { ...s, day, plus };
}

describe('money taken at reception', () => {
  it('reads who entered a Djubo booking, and a website hold', () => {
    const text = ['Reservation ID ## XOX0000201 | Check in 23 Nov, 2026 13:00 Check out 24 Nov, 2026 11:00', 'Guest Name | : Sample Guest',
      'Modified By: Sample Desk Modified On: 23 Nov, 2026 16:07', 'Created By: Sample Team Created On: 23 Nov, 2026 16:06'].join('\n');
    expect(readDjubo({ subject: 'Reservation Hold - SAMPLE - XOX0000201', text } as never)[0]).toMatchObject({ enteredBy: 'Sample Desk', hold: true });
  });

  it('walk-in, Djubo first: reception\'s payment is collected here; the booking team\'s is paid before arrival', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus } = s;
    await send(s.businessId, 'w1', `Booking DJ-W1 | Walk Guest | 9800011111 | Deluxe | ${day} | ${plus(1)} | 3000 | 3000 | Sample Desk | XI`);
    await send(s.businessId, 'p1', `Booking DJ-P1 | Phone Guest | 9800022222 | Deluxe | ${day} | ${plus(1)} | 4000 | 2000 | Sample Team | XII`);
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    expect(arr.map((a: any) => [a.extRef, a.deskPaidPaise])).toEqual([['DJ-P1', 0], ['DJ-W1', 300_000]]);
    const walk = (await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Walk Guest', bookingId: arr[1].id }))).id;
    const phone = (await ok(counter.post(`${B}/stays`, { room: 'XII', guestName: 'Phone Guest', bookingId: arr[0].id }))).id;
    let wb = await ok(counter.get(`${B}/stays/${walk}/bill`));
    expect([wb.prepaidPaise, wb.balancePaise]).toEqual([0, 300_000]);
    const pb = await ok(counter.get(`${B}/stays/${phone}/bill`));
    expect([pb.prepaidPaise, pb.balancePaise]).toEqual([200_000, 200_000]);
    expect(pb.lines.find((l: any) => l.kind === 'prepaid').note).toBe('Advance paid before arrival (booking team)');
    // Not taken yet: shift close needs it taken, or a reason.
    let sh = await ok(s.owner.get(`${B}/shifts/${day}`));
    expect(sh.summary.deskMissing).toMatchObject([{ extRef: 'DJ-W1', pendingPaise: 300_000 }]);
    await ok(counter.post(`${B}/debtors/${wb.stay.accountId}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '3000' }] }));
    sh = await ok(s.owner.get(`${B}/shifts/${day}`));
    expect(sh.summary.deskMissing).toEqual([]);
    // Read again: nothing changes.
    await ok(counter.post(`${B}/mails/read-all-again`, {}));
    wb = await ok(counter.get(`${B}/stays/${walk}/bill`));
    expect([wb.prepaidPaise, wb.balancePaise]).toEqual([0, 0]);
  });

  it('advance for a later date, Djubo first: listed to take; the receipt moves onto the room bill at check-in', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus } = s;
    await send(s.businessId, 'a1', `Booking DJ-A1 | Later Guest | 9800033333 | Deluxe | ${plus(5)} | ${plus(7)} | 6000 | 0 | Sample Team | X`);
    await send(s.businessId, 'a2', `Booking DJ-A1 | Later Guest | 9800033333 | Deluxe | ${plus(5)} | ${plus(7)} | 6000 | 2000 | Sample Desk | X`);
    let bk = await ok(counter.get(`${B}/bookings`));
    expect(bk.deskToTake).toMatchObject([{ extRef: 'DJ-A1', pendingPaise: 200_000, enteredBy: 'Sample Desk' }]);
    const r = await ok(counter.post(`${B}/desk-advances`, { bookingId: bk.deskToTake[0].id, payments: [{ mode: 'cash', amount: '2000' }] }));
    expect(r.receipt).toMatchObject({ kind: 'advance', booking: 'DJ-A1', totalPaise: 200_000, receiptNo: expect.stringMatching(/^RCPT\//) });
    bk = await ok(counter.get(`${B}/bookings`));
    expect(bk.deskToTake).toEqual([]);
    // Check-in on the day (moved to today for the test): the advance is on the room bill with its receipt.
    await q("UPDATE bookings SET check_in = ?, check_out = ? WHERE ext_ref = 'DJ-A1' AND business_id = ?", day, plus(2), s.businessId);
    const id = (await q("SELECT id FROM bookings WHERE ext_ref = 'DJ-A1' AND business_id = ?", s.businessId))[0].id;
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'X', guestName: 'Later Guest', bookingId: id }))).id;
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.lines.map((l: any) => [l.kind, l.amountPaise, l.receiptNo ?? l.note])).toEqual([['room_rent', 600_000, null], ['advance', -200_000, r.receipt.receiptNo]]);
    expect(bill.balancePaise).toBe(400_000);
  });

  it('walk-in, POS first: checked in by hand, then linked when Djubo\'s mail arrives; nothing asked twice', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus } = s;
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XII', guestName: 'Rush Guest', phone: '9800044444' }))).id;
    let bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '3000', note: 'Room rent' }));
    await ok(counter.post(`${B}/debtors/${bill.stay.accountId}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '3000' }] }));
    await send(s.businessId, 'r1', `Booking DJ-R1 | Rush Guest | 9800044444 | Deluxe | ${day} | ${plus(1)} | 3000 | 3000 | Sample Desk | XII`);
    bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.booking).toMatchObject({ extRef: 'DJ-R1' });
    expect([bill.rentPaise, bill.balancePaise]).toEqual([300_000, 0]);
    expect((await ok(s.owner.get(`${B}/shifts/${day}`))).summary.deskMissing).toEqual([]);
    // Not sure (different phone, no room number): a person links it.
    const other = (await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Second Guest', phone: '9800055555' }))).id;
    await send(s.businessId, 'r2', `Booking DJ-R2 | Another Name | 9800066666 | Deluxe | ${day} | ${plus(1)} | 2500 | 0 | Sample Desk |`);
    const bk = await ok(counter.get(`${B}/bookings`));
    expect(bk.unbooked.map((x: any) => x.room)).toEqual(['XI']);
    const r2 = bk.arriving.find((x: any) => x.extRef === 'DJ-R2');
    await ok(counter.post(`${B}/bookings/${r2.id}/link-stay`, { stayId: other }));
    expect((await ok(counter.get(`${B}/stays/${other}/bill`))).rentPaise).toBe(250_000);
  });

  it('advance before Djubo has the booking: attached by phone and date when the mail arrives; refunded if cancelled', async () => {
    const s = await hostel();
    const { B, counter, ok, plus, mgr } = s;
    const r = await ok(counter.post(`${B}/desk-advances`, { guestName: 'Early Guest', phone: '9800077777', checkIn: plus(4), payments: [{ mode: 'upi', amount: '1500', payAccountId: s.upiCompany }] }));
    expect(r.receipt).toMatchObject({ kind: 'advance', booking: null, totalPaise: 150_000 });
    let bk = await ok(counter.get(`${B}/bookings`));
    expect(bk.advancesWaiting).toMatchObject([{ guestName: 'Early Guest', amountPaise: 150_000, phone: '••••7777' }]);
    await send(s.businessId, 'e1', `Booking DJ-E1 | Early Guest | 9800077777 | Deluxe | ${plus(4)} | ${plus(5)} | 3000 | 1500 | Sample Desk | X`);
    bk = await ok(counter.get(`${B}/bookings`));
    expect([bk.advancesWaiting, bk.deskToTake]).toEqual([[], []]);
    expect(bk.arriving.find((x: any) => x.extRef === 'DJ-E1').heldPaise).toBe(150_000);
    // Cancelled in Djubo: the advance waits to be given back; a manager approves the refund.
    const r2 = await ok(counter.post(`${B}/desk-advances`, { guestName: 'Gone Guest', phone: '9800088888', checkIn: plus(6), payments: [{ mode: 'cash', amount: '500' }] }));
    await send(s.businessId, 'g1', `Booking DJ-G1 | Gone Guest | 9800088888 | Deluxe | ${plus(6)} | ${plus(7)} | 2000 | 500 | Sample Desk | XI`);
    await q("UPDATE bookings SET status = 'cancelled' WHERE ext_ref = 'DJ-G1' AND business_id = ?", s.businessId);
    bk = await ok(counter.get(`${B}/bookings`));
    expect(bk.advancesWaiting).toMatchObject([{ guestName: 'Gone Guest', bookingStatus: 'cancelled' }]);
    expect((await counter.post(`${B}/desk-advances/${r2.id}/refund`, { mode: 'cash' })).status).toBe(403);
    await ok(counter.post(`${B}/desk-advances/${r2.id}/refund`, { mode: 'cash', ...mgr }));
    expect((await ok(counter.get(`${B}/bookings`))).advancesWaiting).toEqual([]);
  });

  it('a website hold waits as not confirmed and is not offered at check-in', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus } = s;
    await send(s.businessId, 'h1', `Booking DJ-H1 | Web Guest | 9800099999 | Deluxe | ${day} | ${plus(1)} | 5000 | 0 | System | X`, 'Reservation Hold');
    expect((await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals).toEqual([]);
    expect((await ok(counter.get(`${B}/bookings`))).waiting).toMatchObject([{ extRef: 'DJ-H1', problem: expect.stringMatching(/website hold/) }]);
    await send(s.businessId, 'h2', `Booking DJ-H1 | Web Guest | 9800099999 | Deluxe | ${day} | ${plus(1)} | 5000 | 5000 | System | X`, 'Reservation Confirmation');
    expect((await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals.map((a: any) => a.extRef)).toEqual(['DJ-H1']);
  });
});
