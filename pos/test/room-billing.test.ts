// Room billing (24 Nov 2026): the room's bill follows its booking (rent and what was paid before arrival), money taken
// at the hotel gets a numbered receipt, a deposit is kept apart and refunded, and check-out makes one tax invoice for the
// room rent. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { readDjubo, setReader, stampOf } from '../src/booking-readers';
import { roomTax } from '../src/rooms';

afterAll(dispose);

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ djubo: 'reports@djubo.example.test' }) });
const raw = (subject: string, id: string, bodyText: string) =>
  `From: reports@djubo.example.test\r\nTo: bookings@mail.example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: Mon, 23 Nov 2026 10:00:00 +0530\r\nContent-Type: text/plain\r\n\r\n${bodyText}\r\n`;
const send = (businessId: string, id: string, line: string) => receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw('Booking', id, line)).body!,
  setReject: () => undefined } as unknown as ForwardableEmailMessage, mailEnv(businessId) as never);
// An invented layout: "Booking REF | Name | phone | type | in | out | total ₹ | advance ₹ | channel".
const fake = (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, phone, roomType, checkIn, checkOut, total, paid, channel] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, phone, roomType, checkIn, checkOut, amountPaise: Math.round(Number(total) * 100), paidPaise: Math.round(Number(paid) * 100), channel };
});

describe('room billing', () => {
  it('reads when a Djubo booking was made and changed, its meal plan and requests', () => {
    const text = [
      'Reservation ID ## XOX0000001 Reference ID 0100000001 | Check in 23 Nov, 2026 13:00 Check out 24 Nov, 2026 11:00',
      'Guest Name | : Sample Guest',
      'S.No. | Rooms | Nights | Adults | Children | Infants | Meal Plan | Rooms No. | Currency | Total Net Price',
      '1 | DELUXE | 1 | 2 | 0 | 0 | Breakfast | XII | INR | 1,000.00',
      'Sub Total | INR | 1,000.00', 'Total Taxes | INR | 50.00', 'Advance Amount | INR | 500.00',
      'SPECIAL REQUESTS Late arrival, quiet room Booking Reference No.: 0100000001 Vendor Booking Id: NH12345678901',
      'Modified By: Sample Staff Modified On: 23 Nov, 2026 20:15',
      'Created By: System Created On: 23 Nov, 2026 15:51',
    ].join('\n');
    expect(readDjubo({ subject: 'Reservation Confirmation - SAMPLE - XOX0000001', text } as never)[0]).toMatchObject({
      bookedAt: '2026-11-23 15:51', changedAt: '2026-11-23 20:15', mealPlan: 'Breakfast', requests: 'Late arrival, quiet room', roomLabels: ['XII'] });
    expect(stampOf('23 Nov, 2026')).toBe('2026-11-23');
  });

  it('GST on room rent stated with GST in: 5% up to ₹7,500 a night, else 18%; none when not registered', () => {
    expect(roomTax(105_000, 105_000, true)).toEqual({ bp: 500, taxablePaise: 100_000, cgstPaise: 2_500, sgstPaise: 2_500 });
    expect(roomTax(1_180_000, 1_180_000, true)).toMatchObject({ bp: 1800, taxablePaise: 1_000_000 });
    expect(roomTax(100_000, 100_000, false)).toEqual({ bp: 0, taxablePaise: 100_000, cgstPaise: 0, sgstPaise: 0 });
  });

  it('phone booking: rent and advance from Djubo, balance taken with a receipt, deposit refunded, invoice at check-out', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok, mgr } = s;
    setReader('djubo', fake);
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['XII'] }] }));
    await ok(owner.call('PUT', `${B}/bookings/auto`, { from: '2026-01-01' }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
    await send(s.businessId, 'r1', `Booking DJ-1 | Sample Guest | 9800012345 | Deluxe | ${day} | ${plus(1)} | 2100 | 1000 | Direct`);
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XII', guestName: 'Sample Guest', phone: '9800012345', bookingId: arr[0].id }))).id;
    let bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill).toMatchObject({ rentPaise: 210_000, prepaidPaise: 100_000, balancePaise: 110_000, booking: { extRef: 'DJ-1' } });
    expect(bill.lines.map((l: any) => [l.kind, l.amountPaise, l.note])).toEqual([['room_rent', 210_000, null], ['prepaid', -100_000, 'Advance paid before arrival (booking team)']]);
    // An extra night in Djubo: the revised mail adds rent; read again, nothing doubles.
    await send(s.businessId, 'r2', `Booking DJ-1 | Sample Guest | 9800012345 | Deluxe | ${day} | ${plus(2)} | 4200 | 1000 | Direct`);
    await send(s.businessId, 'r2b', `Booking DJ-1 | Sample Guest | 9800012345 | Deluxe | ${day} | ${plus(2)} | 4200 | 1000 | Direct`);
    bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect([bill.rentPaise, bill.balancePaise]).toEqual([420_000, 320_000]);
    // An extra bed by hand; taking rent off needs a manager.
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '500', note: 'Extra bed' }));
    expect((await counter.post(`${B}/stays/${stay}/charges`, { amount: '200', note: 'Goodwill', lower: true })).status).toBe(403);
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '200', note: 'Goodwill', lower: true, ...mgr }));
    // The balance taken at the desk: a numbered receipt. A deposit on top, kept apart.
    const r1 = await ok(counter.post(`${B}/debtors/${bill.stay.accountId}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '3500' }] }));
    expect(r1.receipt).toMatchObject({ receiptNo: expect.stringMatching(/^RCPT\/\d\d-\d\d\/0001$/), kind: 'receipt', room: 'XII', name: 'Sample Guest', totalPaise: 350_000, balancePaise: 0 });
    const r2 = await ok(counter.post(`${B}/debtors/${bill.stay.accountId}/receipts`, { kind: 'deposit', payments: [{ mode: 'cash', amount: '1000' }] }));
    expect(r2.receipt.receiptNo).toMatch(/\/0002$/);
    // Check-out waits for the deposit to go back; then one invoice for the room rent.
    expect((await counter.post(`${B}/stays/${stay}/check-out`)).status).toBe(409);
    await ok(counter.post(`${B}/debtors/${bill.stay.accountId}/refund`, { mode: 'cash', amount: '1000', ...mgr }));
    const out = await ok(counter.post(`${B}/stays/${stay}/check-out`));
    expect(out.bill.invoice).toMatchObject({ invoiceNo: expect.stringMatching(/^CR\d{4}-0001$/), room: 'XII', nights: 2, gstRateBp: 500, totalPaise: 450_000,
      lines: [{ name: 'Room XII · 2 nights', amountPaise: 420_000 }, { name: 'Extra bed', amountPaise: 50_000 }, { name: expect.stringMatching(/^Goodwill/), amountPaise: -20_000 }] });
    expect(out.bill.invoice.taxablePaise + out.bill.invoice.cgstPaise + out.bill.invoice.sgstPaise).toBe(450_000);
    // A mail after check-out does not change an invoiced stay.
    await send(s.businessId, 'r3', `Booking DJ-1 | Sample Guest | 9800012345 | Deluxe | ${day} | ${plus(3)} | 6300 | 1000 | Direct`);
    expect((await ok(counter.get(`${B}/stays/${stay}/bill`))).rentPaise).toBe(450_000);
    expect(await q('SELECT count(*) AS n FROM room_invoices WHERE business_id = ?', s.businessId)).toEqual([{ n: 1 }]);
  });

  it('OTA prepaid: nothing to collect for the room, the invoice still made; a walk-in with no rent has none', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    setReader('djubo', fake);
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['XI', 'X'] }] }));
    await ok(owner.call('PUT', `${B}/bookings/auto`, { from: '2026-01-01' }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const next = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    await send(s.businessId, 'o1', `Booking DJ-2 | Ota Guest | 9800054321 | Deluxe | ${day} | ${next} | 1600 | 1600 | MAKE MY TRIP`);
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Ota Guest', bookingId: arr[0].id }))).id;
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.lines.map((l: any) => l.note)).toEqual([null, 'Paid to MAKE MY TRIP']);
    expect(bill.balancePaise).toBe(0);
    expect((await ok(counter.post(`${B}/stays/${stay}/check-out`))).bill.invoice).toMatchObject({ totalPaise: 160_000 });
    // A walk-in with no booking and no rent added: checks out with no invoice, as before.
    const walk = (await ok(counter.post(`${B}/stays`, { room: 'X', guestName: 'Walk Guest' }))).id;
    expect((await ok(counter.post(`${B}/stays/${walk}/check-out`))).bill.invoice).toBeNull();
  });
});
