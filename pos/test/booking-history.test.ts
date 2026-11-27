// Each booking's mail history (26 Nov 2026): the booking follows the newest mail by Djubo's own time, an older mail read
// late or read again never brings back old amounts, changes that need a person are held, money marked in Djubo before
// the POS is paid before arrival, and what the OTA says was paid online counts. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { buildHistory, receiveMail } from '../src/mail';
import { setReader } from '../src/booking-readers';
import { shiftDayAt } from '../src/billing';
import { djuboDeskRule } from '../src/djubo-desk';

afterAll(dispose);
djuboDeskRule.from = '2000-01-01';

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
// "Booking REF | Name | phone | in | out | total ₹ | paid ₹ | entered by | room | Djubo changed (YYYY-MM-DD HH:MM) | C (cancelled) | OTA no."
const fake = (channel: string) => (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, phone, checkIn, checkOut, total, paid, enteredBy, room, changed, c, ota] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, phone, roomType: 'Deluxe', checkIn, checkOut, amountPaise: Math.round(Number(total) * 100), paidPaise: Math.round(Number(paid) * 100), channel,
    enteredBy: enteredBy || undefined, roomLabels: room ? [room] : undefined, changedAt: changed || undefined, cancelled: c === 'C' || undefined, otaRef: ota || undefined };
});
const DJ = 'reports@djubo.example.test';

async function hostel() {
  const s = await setupBusiness();
  setReader('djubo', fake('Direct'));
  setReader('mmt', fake('MyBiz'));
  await s.ok(s.owner.call('PUT', `${s.B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] }));
  await s.ok(s.owner.call('PUT', `${s.B}/bookings/auto`, { from: '2026-01-01' }));
  await s.ok(s.owner.call('PUT', `${s.B}/bookings/booking-team`, { users: ['Sample Team'] }));
  const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
  const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
  const bk = async (ref: string) => (await q('SELECT * FROM bookings WHERE ext_ref = ? AND business_id = ?', ref, s.businessId))[0];
  return { ...s, day, plus, bk };
}

describe('booking mail history', () => {
  it('follows the newest mail by Djubo time; an older mail, late or read again, never brings back old amounts', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus, bk } = s;
    // The newer change (10:00) arrives first; the older one (09:00) arrives after it.
    await send(s.businessId, DJ, 'n2', `Booking DJ-H1 | Order Guest | 9800077771 | ${plus(2)} | ${plus(3)} | 6000 | 5000 | Sample Team | X | ${day} 10:00`);
    await send(s.businessId, DJ, 'n1', `Booking DJ-H1 | Order Guest | 9800077771 | ${plus(2)} | ${plus(3)} | 6000 | 2000 | Sample Team | X | ${day} 09:00`);
    expect((await bk('DJ-H1')).paid_paise).toBe(500_000);
    const h = (await ok(counter.get(`${B}/bookings/${(await bk('DJ-H1')).id}/history`))).history;
    expect(h.map((x: any) => [x.paidPaise, x.status])).toEqual([[500_000, 'applied'], [200_000, 'older']]);
    // Reading the old mail again changes nothing.
    const old = (await q("SELECT mail_id FROM booking_versions WHERE status = 'older' AND business_id = ?", s.businessId))[0].mail_id;
    await ok(counter.post(`${B}/mails/${old}/read-again`, {}));
    expect((await bk('DJ-H1')).paid_paise).toBe(500_000);
    expect((await ok(counter.get(`${B}/bookings/held`))).held).toEqual([]);
    // Built again from the kept mails (as for mails read before the history began): the same lines, nothing else changes.
    await q('DELETE FROM booking_versions WHERE business_id = ?', s.businessId);
    await q('UPDATE inbound_mails SET history_at = NULL WHERE business_id = ?', s.businessId);
    while (await buildHistory(mailEnv(s.businessId) as never, 10)) { /* a batch at a time */ }
    const again = (await ok(counter.get(`${B}/bookings/${(await bk('DJ-H1')).id}/history`))).history;
    expect(again.map((x: any) => x.paidPaise)).toEqual([500_000, 200_000]);
    expect((await bk('DJ-H1')).paid_paise).toBe(500_000);
  });

  it('holds a cancellation of a guest in house: the rent stays until someone applies it', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus, bk } = s;
    await send(s.businessId, DJ, 'c1', `Booking DJ-C1 | House Guest | 9800077772 | ${day} | ${plus(2)} | 4000 | 4000 | Sample Team | XI | ${day} 08:30`);
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'House Guest', bookingId: (await bk('DJ-C1')).id }))).id;
    await send(s.businessId, DJ, 'c2', `Booking DJ-C1 | House Guest | 9800077772 | ${day} | ${plus(2)} | 4000 | 4000 | Sample Desk | XI | ${day} 11:00 | C`);
    expect((await bk('DJ-C1')).status).toBe('checked_in');
    let bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.rentPaise).toBe(400_000);
    const held = (await ok(counter.get(`${B}/frontdesk/today`))).held;
    expect(held.map((x: any) => [x.extRef, x.reason, x.room, x.mail.cancelled])).toEqual([['DJ-C1', 'Cancelled while the guest is in house', 'XI', true]]);
    // Kept: nothing changes, and it leaves the list.
    await ok(counter.post(`${B}/bookings/${held[0].bookingId}/versions/${held[0].mailId}/keep`, {}));
    expect((await ok(counter.get(`${B}/frontdesk/today`))).held).toEqual([]);
    bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.rentPaise).toBe(400_000);
    // A paid amount above the total is held too; differences under ₹1 are rounding and go in.
    await send(s.businessId, DJ, 'c3', `Booking DJ-C1 | House Guest | 9800077772 | ${day} | ${plus(2)} | 4000 | 4000.02 | Sample Team | XI | ${day} 12:00`);
    await send(s.businessId, DJ, 'c4', `Booking DJ-C1 | House Guest | 9800077772 | ${day} | ${plus(2)} | 4000 | 4500 | Sample Team | XI | ${day} 13:00`);
    expect((await ok(counter.get(`${B}/bookings/held`))).held.map((x: any) => x.reason)).toEqual(['Paid is more than the total']);
  });

  it('money marked before the POS is paid before arrival; the first mail seen after go-live is the starting point', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus, bk } = s;
    djuboDeskRule.from = day;   // go-live today: the guests below came yesterday
    try {
      // Came before go-live; Djubo's first mail the POS sees is today's, already paid in full by reception (before the POS).
      await send(s.businessId, DJ, 'p1', `Booking DJ-P1 | Early Guest | 9800077773 | ${plus(-1)} | ${plus(1)} | 3000 | 3000 | Sample Desk | X | ${day} 09:10`);
      expect((await bk('DJ-P1')).desk_paid_paise).toBe(0);
      // Then reception takes ₹500 more today and marks it: that is desk money.
      await send(s.businessId, DJ, 'p2', `Booking DJ-P1 | Early Guest | 9800077773 | ${plus(-1)} | ${plus(1)} | 3500 | 3500 | Sample Desk | X | ${day} 09:40`);
      expect((await bk('DJ-P1')).desk_paid_paise).toBe(50_000);
      expect((await ok(counter.get(`${B}/frontdesk/today`))).djubo.open.map((x: any) => [x.extRef, x.amountPaise])).toEqual([['DJ-P1', 50_000]]);
    } finally {
      djuboDeskRule.from = '2000-01-01';
    }
  });

  it('what the OTA says was paid counts when Djubo shows less, never above the rent', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus, bk } = s;
    await send(s.businessId, 'alerts@mmt.example.test', 'o1', `Booking NH800001 | Ota Paid | 9800077774 | ${day} | ${plus(1)} | 3000 | 3000 | | | | | NH800001`);
    await send(s.businessId, DJ, 'o2', `Booking DJ-O1 | Ota Paid | 9800077774 | ${day} | ${plus(1)} | 2999.99 | 0 | System | XII | ${day} 08:40 | | NH800001`);
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XII', guestName: 'Ota Paid', bookingId: (await bk('DJ-O1')).id }))).id;
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect([bill.rentPaise, bill.prepaidPaise, bill.balancePaise]).toEqual([299_999, 299_999, 0]);
  });
});
