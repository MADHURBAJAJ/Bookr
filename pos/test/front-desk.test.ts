// The front desk (25 Nov 2026): room rates, the chart and what is free, reservations made at the desk with an advance,
// the reminder until Djubo has them, linking when Djubo's mail arrives, check-in with ID details and a registration card,
// holds, rooms out of order, and the shift close check. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { setReader } from '../src/booking-readers';

afterAll(dispose);

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ djubo: 'reports@djubo.example.test' }) });
const send = (businessId: string, id: string, line: string) => receiveMail({ to: 'bookings@mail.example.test', setReject: () => undefined,
  raw: new Response(`From: reports@djubo.example.test\r\nTo: bookings@mail.example.test\r\nSubject: Booking\r\nMessage-ID: <${id}@example.test>\r\nDate: Mon, 23 Nov 2026 10:00:00 +0530\r\nContent-Type: text/plain\r\n\r\n${line}\r\n`).body! } as unknown as ForwardableEmailMessage,
  mailEnv(businessId) as never);
const fake = (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, phone, roomType, checkIn, checkOut, total, paid, room] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, phone, roomType, checkIn, checkOut, amountPaise: Math.round(Number(total) * 100), paidPaise: Math.round(Number(paid) * 100), channel: 'Direct',
    enteredBy: 'Sample Team', roomLabels: room ? [room] : undefined };
});

async function desk() {
  const s = await setupBusiness();
  setReader('djubo', fake);
  await s.ok(s.owner.call('PUT', `${s.B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }, { name: 'Suite', kind: 'rooms', tables: ['XIX'] }] }));
  await s.ok(s.owner.call('PUT', `${s.B}/bookings/auto`, { from: '2026-01-01' }));
  const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
  const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
  return { ...s, day, plus };
}

describe('front desk', () => {
  it('rates, what is free, a reservation with an advance, the Djubo reminder and the link when its mail arrives', async () => {
    const s = await desk();
    const { B, owner, counter, ok, mgr, day, plus } = s;
    expect((await counter.call('PUT', `${B}/frontdesk/rates`, { rates: { Deluxe: '1600' } })).status).toBe(403);
    await ok(owner.call('PUT', `${B}/frontdesk/rates`, { rates: { Deluxe: '1600', Suite: '14850' } }));
    // A Djubo booking takes XII on the first two nights; XI is out of order on the third.
    await send(s.businessId, 'd1', `Booking DJ-1 | Booked Guest | 9800011111 | Deluxe | ${plus(1)} | ${plus(3)} | 3200 | 3200 | XII`);
    await ok(counter.post(`${B}/frontdesk/blocks`, { room: 'XI', from: plus(3), to: plus(3), note: 'AC repair' }));
    let free = await ok(counter.get(`${B}/frontdesk/free?from=${plus(1)}&to=${plus(4)}`));
    expect(free.types.find((x: any) => x.type === 'Deluxe')).toMatchObject({ freeRooms: ['X'], freeCount: 1 });
    expect(free.rates).toEqual({ Deluxe: 160_000, Suite: 1_485_000 });
    // Taken: refused. A rate well under the room rate needs a manager.
    const base = { checkIn: plus(1), checkOut: plus(4), guestName: 'Desk Guest', phone: '9800022222', source: 'WhatsApp' };
    expect((await counter.post(`${B}/reservations`, { ...base, lines: [{ type: 'Deluxe', roomNames: ['XII'], adults: 2, rate: '1600' }] })).status).toBe(409);
    expect((await counter.post(`${B}/reservations`, { ...base, lines: [{ type: 'Deluxe', roomNames: ['X'], adults: 2, rate: '1000' }] })).status).toBe(403);
    const r = await ok(counter.post(`${B}/reservations`, { ...base, lines: [{ type: 'Deluxe', roomNames: ['X'], adults: 2, rate: '1600' }],
      payments: [{ mode: 'cash', amount: '1500' }] }));
    expect(r).toMatchObject({ totalPaise: 480_000, receipt: { kind: 'advance', totalPaise: 150_000, receiptNo: expect.stringMatching(/^RCPT\//) } });
    free = await ok(counter.get(`${B}/frontdesk/free?from=${plus(1)}&to=${plus(4)}`));
    expect(free.types.find((x: any) => x.type === 'Deluxe').freeCount).toBe(0);
    // Not in Djubo yet: nothing for 15 minutes, amber after, red after an hour; "remind me later" starts again.
    expect((await ok(counter.get(`${B}/frontdesk/alerts`))).notInDjubo).toEqual([]);
    await q('UPDATE reservations SET remind_from = remind_from - 20 * 60000 WHERE id = ?', r.id);
    expect((await ok(counter.get(`${B}/frontdesk/alerts`))).notInDjubo).toMatchObject([{ guestName: 'Desk Guest', level: 'amber', rooms: 'Deluxe X' }]);
    await q('UPDATE reservations SET remind_from = remind_from - 60 * 60000 WHERE id = ?', r.id);
    expect((await ok(counter.get(`${B}/frontdesk/alerts`))).notInDjubo[0].level).toBe('red');
    // Shift close asks why.
    expect((await ok(owner.get(`${B}/shifts/${day}`))).summary.notInDjubo).toHaveLength(1);
    await ok(counter.post(`${B}/reservations/${r.id}/remind-later`));
    expect((await ok(counter.get(`${B}/frontdesk/alerts`))).notInDjubo).toEqual([]);
    // Djubo's mail with the same phone and check-in links it; the advance follows the booking.
    await send(s.businessId, 'd2', `Booking DJ-2 | Desk Guest | 9800022222 | Deluxe | ${plus(1)} | ${plus(4)} | 4800 | 0 | X`);
    expect((await q('SELECT status, booking_id IS NOT NULL AS linked FROM reservations WHERE id = ?', r.id))[0]).toEqual({ status: 'linked', linked: 1 });
    const bk = await ok(counter.get(`${B}/bookings`));
    expect(bk.arriving.find((x: any) => x.extRef === 'DJ-2').heldPaise).toBe(150_000);
    void mgr;
  });

  it('check-in from a desk reservation: rent and advance on the bill, ID kept as last 4, a registration card', async () => {
    const s = await desk();
    const { B, owner, counter, ok, day, plus } = s;
    await ok(owner.call('PUT', `${B}/frontdesk/rates`, { rates: { Deluxe: '1600' } }));
    const r = await ok(counter.post(`${B}/reservations`, { checkIn: day, checkOut: plus(2), guestName: 'Walk Guest', phone: '9800033333', source: 'Phone',
      lines: [{ type: 'Deluxe', roomNames: ['XI'], adults: 2, rate: '1600' }], payments: [{ mode: 'cash', amount: '1000' }] }));
    const today = await ok(counter.get(`${B}/frontdesk/today`));
    expect(today.arrivals).toMatchObject([{ kind: 'reservation', guestName: 'Walk Guest', duePaise: 220_000 }]);
    expect(today.alerts.notInDjubo).toMatchObject([{ level: 'red' }]);   // arriving today and not in Djubo
    expect((await counter.post(`${B}/stays`, { room: 'XI', guestName: 'Walk Guest', reservationId: r.id, idDocs: [{ type: 'Aadhaar', number: '12' }] })).status).toBe(400);
    const stay = await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Walk Guest', phone: '9800033333', reservationId: r.id, adults: 2, address: 'Sample Road, Pune',
      comingFrom: 'Pune', idDocs: [{ type: 'Aadhaar', number: '1234 5678 4821', name: 'Walk Guest' }, { type: 'Driving licence', number: 'MH12 2019 0000917', name: 'Second Guest' }] }));
    expect(stay.grcNo).toMatch(/^GRC-\d{4}-0001$/);
    const bill = await ok(counter.get(`${B}/stays/${stay.id}/bill`));
    expect([bill.rentPaise, bill.balancePaise]).toEqual([320_000, 220_000]);
    const grc = (await ok(counter.get(`${B}/stays/${stay.id}/grc`))).grc;
    expect(grc).toMatchObject({ grcNo: stay.grcNo, room: 'XI', adults: 2, idDocs: [{ type: 'Aadhaar', last4: '4821' }, { type: 'Driving licence', last4: '0917' }], checkOut: plus(2) });
    expect(JSON.stringify(await q('SELECT id_docs FROM stays WHERE id = ?', stay.id))).not.toContain('5678');
    // Djubo's mail later: the reservation's rent gives way to Djubo's.
    await send(s.businessId, 'w1', `Booking DJ-W | Walk Guest | 9800033333 | Deluxe | ${day} | ${plus(2)} | 3000 | 0 | XI`);
    const after = await ok(counter.get(`${B}/stays/${stay.id}/bill`));
    expect([after.rentPaise, after.balancePaise]).toEqual([300_000, 200_000]);
    expect((await ok(counter.get(`${B}/frontdesk/today`))).alerts.notInDjubo).toEqual([]);
  });

  it('a hold lapses and frees its room; a cancelled reservation leaves the chart; credit shows how old the debt is', async () => {
    const s = await desk();
    const { B, counter, ok, plus } = s;
    const h = await ok(counter.post(`${B}/reservations`, { checkIn: plus(2), checkOut: plus(3), guestName: 'Hold Guest', phone: '9800044444', source: 'Instagram', status: 'hold',
      lines: [{ type: 'Suite', rooms: 1, adults: 1, rate: '14850' }] }));
    let free = await ok(counter.get(`${B}/frontdesk/free?from=${plus(2)}&to=${plus(3)}`));
    expect(free.types.find((x: any) => x.type === 'Suite').freeCount).toBe(0);
    await q('UPDATE reservations SET hold_until = 1 WHERE id = ?', h.id);
    free = await ok(counter.get(`${B}/frontdesk/free?from=${plus(2)}&to=${plus(3)}`));
    expect(free.types.find((x: any) => x.type === 'Suite').freeCount).toBe(1);
    const c1 = await ok(counter.post(`${B}/reservations`, { checkIn: plus(2), checkOut: plus(3), guestName: 'Gone Guest', phone: '9800055555', source: 'Phone',
      lines: [{ type: 'Deluxe', roomNames: ['X'], adults: 1, rate: '1600' }] }));
    expect((await ok(counter.get(`${B}/frontdesk/chart?from=${plus(2)}&days=1`))).bars.map((b: any) => b.room)).toEqual(['X']);
    await ok(counter.post(`${B}/reservations/${c1.id}/cancel`, { reason: 'Plans changed' }));
    expect((await ok(counter.get(`${B}/frontdesk/chart?from=${plus(2)}&days=1`))).bars).toEqual([]);
    expect((await ok(counter.get(`${B}/reservations`))).reservations.map((x: any) => [x.guestName, x.status])).toEqual([['Gone Guest', 'cancelled'], ['Hold Guest', 'hold']]);
    expect((await ok(counter.get(`${B}/credit-accounts`))).accounts).toEqual([]);
  });
});
