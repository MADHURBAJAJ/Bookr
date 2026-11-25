// Old booking mails brought in once (25 Nov 2026): forwarded from the hotel's own mailbox with the import key; read as if
// they came when the original did, so they never override a newer mail; only stays not over yet; Djubo's daily report
// keeps the last word on what is still to collect; old advances never ask for a POS receipt. All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';
import { clock12, setReader } from '../src/booking-readers';

afterAll(dispose);

const KEY = 'test-import-key-not-a-secret-0123';
const BOX = 'hotel@mail.example.test';
const mailEnv = (businessId: string, key: string | undefined = KEY) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ mmt: '@mmt.example.test', djubo: 'reports@djubo.example.test' }), MAIL_IMPORT_FROM: BOX, MAIL_IMPORT_KEY: key });
const raw = (from: string, subject: string, id: string, body: string, date = 'Mon, 23 Nov 2026 10:00:00 +0530') =>
  `From: ${from}\r\nTo: bookings@mail.example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: ${date}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
function send(e: unknown, text: string) {
  const out = { rejected: null as string | null };
  return receiveMail({ to: 'bookings@mail.example.test', raw: new Response(text).body!, setReject: (r: string) => { out.rejected = r; } } as unknown as ForwardableEmailMessage, e as never)
    .then(() => out);
}
/** A forward from the hotel's mailbox of a mail that came at `at`, with the import line on top. */
const forward = (gmailId: string, at: string, line: string, key = KEY) => raw(BOX, 'Fwd: Reservation Confirmation', `fwd-${gmailId}`,
  `Bookr import ${key} ${gmailId} ${at} reports@djubo.example.test\n\n---------- Forwarded message ---------\n${line}`);
// An invented layout standing in for Djubo's reader: "Booking REF | name | phone | type | in | out | total | paid | booked".
const fake = (m: { text?: string }) => (m.text ?? '').split('\n').filter((l) => l.startsWith('Booking ')).map((l) => {
  const [extRef, guestName, phone, roomType, checkIn, checkOut, total, paid, bookedAt] = l.slice(8).split('|').map((x) => x.trim());
  return { extRef, guestName, phone, roomType, checkIn, checkOut, amountPaise: total ? Number(total) * 100 : undefined, paidPaise: paid ? Number(paid) * 100 : undefined,
    bookedAt: bookedAt || undefined, enteredBy: 'Desk Person' };
});
const plus = (day: string, n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

describe('old booking mails brought in', () => {
  it('needs the hotel mailbox and the key; reads the forward as the original; keeps it once', async () => {
    const s = await setupBusiness();
    setReader('djubo', fake);
    const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
    const line = `Booking DJ-1 | Asha Rao | 9800010001 | Deluxe | ${plus(day, 3)} | ${plus(day, 5)} | 5000 | 1000 | 2026-10-04 11:24`;
    // No key, a wrong key, or imports closed: turned away.
    expect((await send(mailEnv(s.businessId), raw(BOX, 'Fwd: x', 'n1', line))).rejected).toMatch(/only reads booking mails/);
    expect((await send(mailEnv(s.businessId), forward('a1b2c3d4e5', '2026-10-04T05:54:51Z', line, 'wrong-key-wrong-key-wrong-key-00'))).rejected).toMatch(/only reads/);
    expect((await send(mailEnv(s.businessId, ''), forward('a1b2c3d4e5', '2026-10-04T05:54:51Z', line))).rejected).toMatch(/only reads/);
    expect(await q('SELECT 1 FROM bookings WHERE business_id = ?', s.businessId)).toEqual([]);

    const e = mailEnv(s.businessId);
    for (let i = 0; i < 2; i++) expect((await send(e, forward('a1b2c3d4e5', '2026-10-04T05:54:51Z', line))).rejected).toBeNull();
    expect(await q('SELECT message_id, source, received_at, subject, note FROM inbound_mails WHERE business_id = ?', s.businessId)).toEqual([
      { message_id: 'import:a1b2c3d4e5', source: 'djubo', received_at: Date.parse('2026-10-04T05:54:51Z'), subject: 'Reservation Confirmation', note: 'Old mail brought in: DJ-1 added.' }]);
    expect(await q('SELECT ext_ref, guest_name, amount_paise, paid_paise, booked_at, desk_paid_paise FROM bookings WHERE business_id = ?', s.businessId)).toEqual([
      { ext_ref: 'DJ-1', guest_name: 'Asha Rao', amount_paise: 500000, paid_paise: 100000, booked_at: '2026-10-04 11:24', desk_paid_paise: 0 }]);
  });

  it('leaves out stays already over, and never overrides a newer mail (only fills its blanks)', async () => {
    const s = await setupBusiness();
    setReader('djubo', fake);
    const e = mailEnv(s.businessId);
    const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
    await send(e, forward('0000000001', '2026-10-01T05:00:00Z', `Booking DJ-2 | Old Stay | 9800010002 | Deluxe | ${plus(day, -4)} | ${plus(day, -1)} | 3000 | 0 |`));
    expect(await q('SELECT 1 FROM bookings WHERE business_id = ?', s.businessId)).toEqual([]);
    expect((await q('SELECT note FROM inbound_mails WHERE business_id = ?', s.businessId))[0].note).toBe('Old mail brought in: DJ-2 stay over, left out.');

    // The POS read a revised mail on 23 Nov (no booked date in it); the October original comes in after it.
    await send(e, raw('reports@djubo.example.test', 'Reservation Confirmation [Revised]', 'rev3', `Booking DJ-3 | New Name | 9800010003 | Deluxe | ${plus(day, 2)} | ${plus(day, 6)} | 8000 | 2000 |`));
    await send(e, forward('0000000003', '2026-10-10T05:00:00Z', `Booking DJ-3 | Old Name | 9800010003 | Deluxe | ${plus(day, 2)} | ${plus(day, 4)} | 4000 | 0 | 2026-10-10 10:30`));
    expect(await q('SELECT guest_name, check_out, amount_paise, booked_at FROM bookings WHERE business_id = ?', s.businessId)).toEqual([
      { guest_name: 'New Name', check_out: plus(day, 6), amount_paise: 800000, booked_at: '2026-10-10 10:30' }]);
  });

  it('a booking from Djubo\'s daily report gets its details; the report keeps the last word on what is left to collect', async () => {
    const s = await setupBusiness();
    setReader('djubo', fake);
    const e = mailEnv(s.businessId);
    const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
    const t = Date.now();
    for (const [id, ref, typed] of [['r1', 'DJ-4', null], ['r2', 'DJ-5', 900000]] as const) {
      await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, check_in, check_out, status, created_at, updated_at, from_report, report_due_paise, amount_paise, paid_paise)
        VALUES (?, ?, 'djubo', ?, 'Report Guest', 'Deluxe', ?, ?, 'approved', ?, ?, 1, 200000, ?, ?)`, `${id}-${s.businessId}`, s.businessId, ref, day, plus(day, 2), t, t, typed, typed ? typed - 200000 : null);
    }
    await send(e, forward('0000000004', '2026-11-04T05:54:51Z', `Booking DJ-4 | Report Guest | 9800010004 | Deluxe | ${day} | ${plus(day, 2)} | 5000 | 1000 | 2026-11-04 11:24`));
    await send(e, forward('0000000005', '2026-11-05T05:54:51Z', `Booking DJ-5 | Report Guest | 9800010005 | Deluxe | ${day} | ${plus(day, 2)} | 6000 | 1000 | 2026-11-05 09:00`));
    expect(await q('SELECT ext_ref, phone, amount_paise, paid_paise, booked_at, desk_paid_paise FROM bookings WHERE business_id = ? ORDER BY ext_ref', s.businessId)).toEqual([
      // Djubo's mail says ₹1,000 was paid; the report, newer, says ₹2,000 is still to collect: ₹3,000 counts as paid.
      { ext_ref: 'DJ-4', phone: '9800010004', amount_paise: 500000, paid_paise: 300000, booked_at: '2026-11-04 11:24', desk_paid_paise: 0 },
      // A total typed at the desk stays.
      { ext_ref: 'DJ-5', phone: '9800010005', amount_paise: 900000, paid_paise: 700000, booked_at: '2026-11-05 09:00', desk_paid_paise: 0 },
    ]);
    expect((await q("SELECT note FROM inbound_mails WHERE business_id = ? AND message_id = 'import:0000000005'", s.businessId))[0].note)
      .toBe('Old mail brought in: DJ-5 total typed at the desk kept (mail says 6000.00); DJ-5 brought up to date.');
  });

  it('reads MakeMyTrip\'s "Booked on" time', () => {
    expect(clock12("25 Nov '26 03:01 PM")).toBe('2026-11-25 15:01');
    expect(clock12("01 Dec '26 12:05 AM")).toBe('2026-12-01 00:05');
    expect(clock12("01 Dec '26 12:40 PM")).toBe('2026-12-01 12:40');
  });
});
