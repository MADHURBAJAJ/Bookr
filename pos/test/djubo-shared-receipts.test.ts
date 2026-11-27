// A stay of several Djubo bookings (one per night, extensions as new bookings), paid at the POS on the room bill, all
// marked paid in Djubo by reception at the end (27 Nov 2026). The bill's receipts cover the bookings once between them,
// oldest night first: a receipt must not cover every booking at once, or money reception took without a POS receipt is
// never asked for. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { setReader } from '../src/booking-readers';
import { shiftDayAt } from '../src/billing';
import { djuboDeskRule } from '../src/djubo-desk';

// The rule counts from today in these tests.
djuboDeskRule.from = '2000-01-01';
afterAll(dispose);

const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ djubo: 'reports@djubo.example.test' }) });
let minute = 0;
const send = (businessId: string, id: string, line: string) => {
  minute += 1;
  // In today's shift (9 am India time plus a minute each), so the test does not depend on the day it runs.
  const today = shiftDayAt(Date.now(), 8);
  const date = new Date(Date.parse(today + 'T00:00:00Z') + 9 * 3_600_000 - 19_800_000 + minute * 60_000).toUTCString();
  const raw = `From: reports@djubo.example.test\r\nTo: bookings@mail.example.test\r\nSubject: Booking\r\nMessage-ID: <${id}@example.test>\r\nDate: ${date}\r\nContent-Type: text/plain\r\n\r\n${line}\r\n`;
  return receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw).body!, setReject: () => undefined } as unknown as ForwardableEmailMessage, mailEnv(businessId) as never);
};
// "Booking REF | Name | phone | type | in | out | total ₹ | advance ₹ | entered by | room no".
const fake = (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, phone, roomType, checkIn, checkOut, total, paid, enteredBy, room] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, phone, roomType, checkIn, checkOut, amountPaise: Math.round(Number(total) * 100), paidPaise: Math.round(Number(paid) * 100), channel: 'Direct',
    enteredBy, roomLabels: room ? [room] : undefined };
});

/** Five nights at ₹2,000 ending tonight, one Djubo booking each, joined to one stay; ₹2,000 cash taken at the POS on the
 *  nights given; then reception marks all five paid in Djubo. Returns what the POS shows. */
async function fiveNights(paidAtPos: number[]) {
  const s = await setupBusiness();
  setReader('djubo', fake);
  const { B, counter, owner, ok } = s;
  await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] }));
  await ok(owner.call('PUT', `${B}/bookings/auto`, { from: '2026-01-01' }));
  await ok(owner.call('PUT', `${B}/bookings/booking-team`, { users: ['Sample Team'] }));
  const day = (await ok(owner.get('/me'))).business.shiftDay;
  const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
  const line = (n: number, paid: number) => `Booking DJ-S${n} | Sample Stayer | 9800077777 | Deluxe | ${plus(n - 5)} | ${plus(n - 4)} | 2000 | ${paid} | Sample Desk | XI`;
  let stay = '';
  let acc = '';
  for (let n = 1; n <= 5; n++) {
    await send(s.businessId, `s${n}`, line(n, 0));
    const bk = (await ok(counter.get(`${B}/bookings/arrivals?day=${plus(n - 5)}`))).arrivals.find((a: any) => a.extRef === `DJ-S${n}`);
    if (n === 1) {
      stay = (await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Sample Stayer', phone: '9800077777', bookingId: bk.id, ...s.mgr }))).id;
      acc = (await ok(counter.get(`${B}/stays/${stay}/bill`))).stay.accountId;
    } else await ok(counter.post(`${B}/bookings/${bk.id}/continue`, { stays: [{ id: stay }] }));
    if (paidAtPos.includes(n)) await ok(counter.post(`${B}/debtors/${acc}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '2000' }] }));
  }
  for (let n = 1; n <= 5; n++) await send(s.businessId, `s${n}-paid`, line(n, 2000));
  const sh = await ok(owner.get(`${B}/shifts/${day}`));
  const fd = await ok(counter.get(`${B}/frontdesk/today`));
  const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
  const listed = sh.summary.djubo.reduce((t: number, x: any) => t + x.amountPaise, 0);
  const close = await owner.post(`${B}/shifts/${day}/close`, { counted: '0' });
  return { s, day, sh, fd, bill, listed, close };
}

describe('receipts on a room bill with several Djubo bookings', () => {
  it('all nights paid at the POS: nothing more to take', async () => {
    const r = await fiveNights([1, 2, 3, 4, 5]);
    expect([r.bill.balancePaise, r.listed, r.fd.alerts.djuboToMode]).toEqual([0, 0, 0]);
  });

  it('nothing paid at the POS: all five are asked for and block the close', async () => {
    const r = await fiveNights([]);
    expect([r.bill.balancePaise, r.listed, r.fd.alerts.djuboToMode]).toEqual([1_000_000, 1_000_000, 5]);
    expect(r.close.status).toBe(409);
    expect(r.close.json.error).toMatch(/Pick Cash, UPI or Card/);
  });

  it('one night not paid at the POS (night 3): its ₹2,000 is still asked for and blocks the close', async () => {
    const r = await fiveNights([1, 2, 4, 5]);
    expect(r.bill.balancePaise).toBe(200_000);
    // ₹8,000 of receipts covers four nights once between them, oldest first; the last night's ₹2,000 is left to take.
    expect(r.listed).toBe(200_000);
    expect(r.sh.summary.djubo.map((x: any) => [x.extRef, x.amountPaise])).toEqual([['DJ-S5', 200_000]]);
    expect(r.fd.alerts.djuboToMode).toBe(1);
    expect(r.close.status).toBe(409);
    expect(r.close.json.error).toMatch(/Pick Cash, UPI or Card .*Sample Stayer ₹2,000/);
  });

  it('only night 1 paid at the POS: the other four nights\' ₹8,000 is asked for', async () => {
    const r = await fiveNights([1]);
    expect(r.bill.balancePaise).toBe(800_000);
    expect(r.listed).toBe(800_000);
    expect(r.sh.summary.djubo.map((x: any) => [x.extRef, x.amountPaise])).toEqual([['DJ-S2', 200_000], ['DJ-S3', 200_000], ['DJ-S4', 200_000], ['DJ-S5', 200_000]]);
    expect(r.fd.alerts.djuboToMode).toBe(4);
    expect(r.close.status).toBe(409);
  });
});
