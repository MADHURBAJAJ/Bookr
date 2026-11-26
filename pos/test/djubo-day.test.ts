// Money reception marks in Djubo (26 Nov 2026): counted in the POS on the day it was marked; someone picks cash, UPI or
// card, which makes a POS receipt dated that day, and the day cannot close until each has one. All names, numbers and
// amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { readDjubo, setReader } from '../src/booking-readers';
import { shiftDayAt } from '../src/billing';
import { djuboDeskRule } from '../src/djubo-desk';

// The rule counts from today in these tests.
djuboDeskRule.from = '2000-01-01';

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
  // Money anyone but the booking team enters in Djubo needs a POS receipt (24 Nov 2026).
  await s.ok(s.owner.call('PUT', `${s.B}/bookings/booking-team`, { users: ['Sample Team'] }));
  const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
  const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
  return { ...s, day, plus };
}

describe('money marked in Djubo by reception', () => {
  it('is listed on its day, blocks the close until its mode is picked, and becomes a receipt dated that day', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus } = s;
    // A guest in house; reception marks ₹3,000 in Djubo. The booking team's ₹1,000 advance is not listed.
    await send(s.businessId, 'h1', `Booking DJ-H1 | House Guest | 9800044441 | Deluxe | ${day} | ${plus(1)} | 4000 | 1000 | Sample Team | XI`);
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'House Guest', bookingId: arr[0].id }))).id;
    await send(s.businessId, 'h2', `Booking DJ-H1 | House Guest | 9800044441 | Deluxe | ${day} | ${plus(1)} | 4000 | 4000 | Sample Desk | XI`);
    // A later stay: reception marks ₹1,500, then ₹500 more, and once marks and removes ₹700 (a slip): only ₹2,000 is listed.
    await send(s.businessId, 'f1', `Booking DJ-F1 | Future Guest | 9800044442 | Deluxe | ${plus(5)} | ${plus(6)} | 5000 | 1500 | Sample Desk | X`);
    await send(s.businessId, 'f2', `Booking DJ-F1 | Future Guest | 9800044442 | Deluxe | ${plus(5)} | ${plus(6)} | 5000 | 2700 | Sample Desk | X`);
    await send(s.businessId, 'f3', `Booking DJ-F1 | Future Guest | 9800044442 | Deluxe | ${plus(5)} | ${plus(6)} | 5000 | 2000 | Sample Desk | X`);

    let sh = await ok(s.owner.get(`${B}/shifts/${day}`));
    expect(sh.summary.djubo.map((x: any) => [x.extRef, x.amountPaise, x.by, x.settlementId])).toEqual([['DJ-H1', 300_000, 'Sample Desk', null], ['DJ-F1', 150_000, 'Sample Desk', null], ['DJ-F1', 50_000, 'Sample Desk', null]]);
    expect(sh.summary.deskMissing).toEqual([]);
    const fd = await ok(counter.get(`${B}/frontdesk/today`));
    expect([fd.alerts.djuboToMode, fd.alerts.deskToTake]).toEqual([3, 0]);
    expect(fd.inHouse.find((x: any) => x.id === stay)).toMatchObject({ balancePaise: 300_000, djuboPaise: 300_000 });
    let bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.djubo.map((x: any) => x.amountPaise)).toEqual([300_000]);

    // The day cannot close yet.
    const close = await s.owner.post(`${B}/shifts/${day}/close`, { counted: '0' });
    expect(close.status).toBe(409);
    expect(close.json.error).toMatch(/Pick Cash, UPI or Card .*House Guest ₹3,000/);

    // Picked: a numbered receipt on the room bill, dated the day it was marked; the bill is settled.
    const h = sh.summary.djubo[0];
    const r = await ok(counter.post(`${B}/bookings/${h.bookingId}/djubo-paid`, { mailId: h.mailId, mode: 'cash' }));
    expect(r).toMatchObject({ shiftDay: day, receipt: { kind: 'receipt', totalPaise: 300_000, room: 'XI', receiptNo: expect.stringMatching(/^RCPT\//) } });
    bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect([bill.balancePaise, bill.djubo]).toEqual([0, []]);
    // Twice is refused.
    expect((await counter.post(`${B}/bookings/${h.bookingId}/djubo-paid`, { mailId: h.mailId, mode: 'cash' })).status).toBe(404);
    // The later stay's: held as advances, which move onto its room bill at check-in.
    for (const x of sh.summary.djubo.slice(1)) await ok(counter.post(`${B}/bookings/${x.bookingId}/djubo-paid`, { mailId: x.mailId, mode: 'card' }));
    sh = await ok(s.owner.get(`${B}/shifts/${day}`));
    expect(sh.summary.djubo.map((x: any) => [x.mode, !!x.receiptNo])).toEqual([['cash', true], ['card', true], ['card', true]]);
    expect(sh.summary.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'cash', paise: 300_000 }), expect.objectContaining({ mode: 'card', paise: 200_000 })]));
    const fu = await q("SELECT sum(amount_paise) AS p FROM desk_advances WHERE status = 'held' AND business_id = ?", s.businessId);
    expect(fu[0].p).toBe(200_000);
    expect((await ok(counter.get(`${B}/frontdesk/today`))).alerts.djuboToMode).toBe(0);
    // Reading the mails again changes nothing.
    await ok(counter.post(`${B}/mails/read-all-again`, {}));
    expect((await ok(counter.get(`${B}/frontdesk/today`))).alerts.djuboToMode).toBe(0);
  });

  it('is not listed when the POS took it first, and a food payment does not hide it', async () => {
    const s = await hostel();
    const { B, counter, ok, day, plus } = s;
    // The POS took a ₹2,000 advance for the booking before reception marked it in Djubo.
    await send(s.businessId, 'p1', `Booking DJ-P1 | First Guest | 9800055551 | Deluxe | ${plus(3)} | ${plus(4)} | 4000 | 0 | Sample Team | X`);
    const p1 = (await q("SELECT id FROM bookings WHERE ext_ref = 'DJ-P1' AND business_id = ?", s.businessId))[0].id;
    await ok(counter.post(`${B}/desk-advances`, { bookingId: p1, payments: [{ mode: 'cash', amount: '2000' }] }));
    await send(s.businessId, 'p2', `Booking DJ-P1 | First Guest | 9800055551 | Deluxe | ${plus(3)} | ${plus(4)} | 4000 | 2000 | Sample Desk | X`);
    // In house with ₹1,000 of food on the room, paid at the desk; then reception marks ₹2,500 of rent in Djubo.
    await send(s.businessId, 'g1', `Booking DJ-G1 | Food Guest | 9800055552 | Deluxe | ${day} | ${plus(1)} | 2500 | 0 | Sample Team | XII`);
    const arr = (await ok(counter.get(`${B}/bookings/arrivals?day=${day}`))).arrivals;
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XII', guestName: 'Food Guest', bookingId: arr.find((a: any) => a.extRef === 'DJ-G1').id }))).id;
    const acc = (await ok(counter.get(`${B}/stays/${stay}/bill`))).stay.accountId;
    await q("INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, at) VALUES ('fd-1', ?, ?, 'charge', 100000, ?)", s.businessId, acc, Date.now());
    await ok(counter.post(`${B}/debtors/${acc}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '1000' }] }));
    await send(s.businessId, 'g2', `Booking DJ-G1 | Food Guest | 9800055552 | Deluxe | ${day} | ${plus(1)} | 2500 | 2500 | Sample Desk | XII`);
    const sh = await ok(s.owner.get(`${B}/shifts/${day}`));
    expect(sh.summary.djubo.map((x: any) => [x.extRef, x.amountPaise])).toEqual([['DJ-G1', 250_000]]);
  });
});
