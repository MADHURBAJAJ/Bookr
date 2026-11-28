// Extensions are made in Djubo (26 Nov 2026): the stay's leaving date and rent follow Djubo's mail; staff cannot extend or
// add rent by hand; a manager can, with a reason; nights no rent covers are flagged and block the day's close; a booking that
// continues a guest in house is never checked in again or marked a no-show. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, db, dispose, env, q, setupBusiness } from './helpers';
import { autoCloseAll } from '../src/routes/shifts';
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

describe('extending a stay through Djubo', () => {
  it('follows Djubo: the leaving date moves with the booking, for every bed; nights not charged are flagged and block the close', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus, bk, owner } = s;
    await send(s.businessId, DJ, 'e1', `Booking DJ-E1 | Stay Guest | 9800011221 | ${day} | ${plus(1)} | 2000 | 2000 | Sample Team | X | ${day} 08:10`);
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'X', rooms: ['XI'], guestName: 'Stay Guest', bookingId: (await bk('DJ-E1')).id }))).id;
    // Staff cannot extend by hand, nor add rent on a booked stay.
    expect((await counter.post(`${B}/stays/${stay}/extend`, { to: plus(2), rate: '2000', reason: 'Asked' })).status).toBe(403);
    expect((await counter.post(`${B}/stays/${stay}/charges`, { amount: '2000', note: 'Room rent extra night' })).status).toBe(403);
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '300', note: 'Extra bed' }));
    // Djubo extends the same booking by a night: the date moves for both beds, the rent comes with it.
    await send(s.businessId, DJ, 'e2', `Booking DJ-E1 | Stay Guest | 9800011221 | ${day} | ${plus(2)} | 4000 | 2000 | Sample Team | X | ${day} 10:00`);
    const plans = await q('SELECT room, check_out_plan AS p FROM stays WHERE business_id = ? ORDER BY room', s.businessId);
    expect(plans.map((x: any) => [x.room, x.p])).toEqual([['X', plus(2)], ['XI', plus(2)]]);
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.rentPaise).toBe(430_000);   // ₹4,000 from Djubo + the ₹300 extra bed
    expect((await ok(counter.get(`${B}/frontdesk/today`))).nightsNotCharged).toEqual([]);
    // A manager extends without Djubo (Djubo down): rent per night and a reason; flagged until it is charged.
    await ok(counter.post(`${B}/stays/${stay}/extend`, { to: plus(3), rate: '2000', reason: 'Djubo down', ...s.mgr }));
    expect((await ok(counter.get(`${B}/frontdesk/today`))).nightsNotCharged).toEqual([]);
    // The guest stays on with nobody telling Djubo (the date moved by hand with no rent, as before the rule): flagged.
    await q('UPDATE stays SET check_out_plan = ? WHERE id = ?', plus(5), stay);
    const nn = (await ok(counter.get(`${B}/frontdesk/today`))).nightsNotCharged;
    expect(nn.map((x: any) => [x.room, x.plan, x.coveredTo, x.nights])).toEqual([['X', plus(5), plus(3), 2]]);
    // Tonight is charged, so today can close; a guest whose tonight has no rent blocks it.
    await q("UPDATE bookings SET check_out = ? WHERE ext_ref = 'DJ-E1' AND business_id = ?", day, s.businessId);
    await q("DELETE FROM debtor_entries WHERE note LIKE '%extra night%' AND business_id = ?", s.businessId);
    const close = await owner.post(`${B}/shifts/${day}/close`, { counted: '0' });
    expect(close.status).toBe(409);
    // Rent till today: they leave today, so it says so (28 Nov 2026); still in house at the close, it still blocks.
    expect(close.json.error).toMatch(/Leaving today, not checked out yet: X · Stay Guest/);
    // Rent till yesterday: staying past the booking with no rent for tonight.
    await q("UPDATE bookings SET check_out = ? WHERE ext_ref = 'DJ-E1' AND business_id = ?", plus(-1), s.businessId);
    const late = await owner.post(`${B}/shifts/${day}/close`, { counted: '0' });
    expect(late.status).toBe(409);
    expect(late.json.error).toMatch(/No rent for tonight: X · Stay Guest/);

    // Nobody closes it: at 8 am it closes by itself, and its Daily check says in red who had no rent (28 Nov 2026).
    await billed(s, [['Masala Dosa', 1]]);
    const at8 = Date.parse(plus(1) + 'T00:00:00Z') + 8 * 3_600_000 + 5 * 60_000 - 19_800_000;
    expect(await autoCloseAll(db, at8)).toBe(1);
    const daily = await ok(owner.get(`${B}/reports/daily-check?day=${day}`));
    expect(daily.shiftClose.noRent).toEqual([{ room: 'X', guestName: 'Stay Guest', coveredTo: plus(-1) }]);
    expect((await ok(owner.get(`${B}/shifts/${plus(1)}`))).lastClosed.noRent).toEqual([{ room: 'X', guestName: 'Stay Guest', coveredTo: plus(-1) }]);
  });

  it('a booking continuing a guest in house is their extension: not checked in again, not a no-show', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus, bk } = s;
    await send(s.businessId, DJ, 'x1', `Booking DJ-X1 | Long Guest | 9800011331 | ${plus(-1)} | ${day} | 2000 | 2000 | Sample Team | XII | ${day} 07:00`);
    await q("UPDATE bookings SET status = 'approved' WHERE ext_ref = 'DJ-X1' AND business_id = ?", s.businessId);
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XII', guestName: 'Long Guest', bookingId: (await bk('DJ-X1')).id }))).id;
    await q('UPDATE stays SET check_out_plan = ? WHERE id = ?', day, stay);
    // Djubo makes the extension as a new booking from today.
    await send(s.businessId, DJ, 'x2', `Booking DJ-X2 | Long Guest | 9800011331 | ${day} | ${plus(1)} | 2000 | 2000 | Sample Team | XII | ${day} 09:00`);
    const x2 = (await bk('DJ-X2')).id;
    const r = await counter.post(`${B}/stays`, { room: 'X', guestName: 'Long Guest', bookingId: x2 });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/already in house: this booking is their extension/);
    expect((await counter.post(`${B}/bookings/${x2}/no-show`, {})).status).toBe(409);
    // Continue joins it: one bill, leaving tomorrow.
    const bill = await ok(counter.post(`${B}/bookings/${x2}/continue`, { stays: [{ id: stay }] }));
    expect([bill.rentPaise, bill.stay.checkOutPlan]).toEqual([400_000, plus(1)]);
  });
});
