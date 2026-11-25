// Djubo's daily reports (24 Nov 2026): bookings made before the POS read Djubo's mails are filled in from the Daily Front
// Office Report; guests already staying are brought in from the Daily Occupied Rooms Report; reception types the total
// rent once. Invented mails in Djubo's layout; all names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, env, q, setupBusiness } from './helpers';
import { receiveMail } from '../src/mail';

afterAll(dispose);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (d: string) => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]}, ${d.slice(0, 4)}`;
const short = (d: string) => `${d.slice(8)}-${MON[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}`;
const mailEnv = (businessId: string) => ({ ...env, MAIL_ROUTES: JSON.stringify({ 'bookings@mail.example.test': businessId }),
  BOOKING_MAIL_FROM: JSON.stringify({ djubo: 'notifications@djubo.example.test' }) });
let n = 0;
const send = (businessId: string, subject: string, text: string) => {
  const raw = `From: notifications@djubo.example.test\r\nTo: bookings@mail.example.test\r\nSubject: ${subject}\r\nMessage-ID: <rep${++n}@example.test>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${text}\r\n`;
  return receiveMail({ to: 'bookings@mail.example.test', raw: new Response(raw).body!, setReject: () => undefined } as unknown as ForwardableEmailMessage, mailEnv(businessId) as never);
};

describe("Djubo's daily reports", () => {
  it('fills in missing bookings, brings in guests staying, and asks for the total rent once', async () => {
    const s = await setupBusiness();
    const { B, counter, owner, ok, businessId } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const plus = (k: number) => new Date(Date.parse(day) + k * 86_400_000).toISOString().slice(0, 10);
    const front = (d: string) => [`| | ## Daily Front Office Report ### ${long(d)} | SAMPLE HOSTEL |`,
      "| Today's Confirm Check-In : 1 Bookings | 1 Rooms |",
      '| Reservation | Guest Name | Rooms | Pax | Meal | Check in | Check out | Outstanding Amt. |', '| Direct |',
      `| XOX0000301 | Arrive Guest | DELUXE X 1 | 2 | EP X 1 | ${long(d)} | ${long(plus(2))} | 3,000.00 |`,
      '| Staying Over : 1 Bookings | 1 Rooms |', '| Reservation | Guest Name | Rooms | Pax | Meal | Check in | Check out | Outstanding Amt. |', '| MAKE MY TRIP |',
      `| XOX0000302 (0100000002) | Stay Guest MAKE MY TRIP | DELUXE X 1 | 2 | CP X 1 | ${short(plus(-1))} | ${short(plus(1))} | 0.00 |`,
      "| Today's Check-Out : 1 Bookings | 1 Rooms |", '| Direct |',
      `| XOX0000303 | Leave Guest | DELUXE X 1 | 1 | EP X 1 | ${long(plus(-2))} | ${long(d)} | 0.00 |`].join('\n');
    // An older report is kept but not applied.
    await send(businessId, `SAMPLE HOSTEL: Daily Front Office Report - ${long(plus(-1))}`, front(plus(-1)));
    expect(await q("SELECT 1 FROM bookings WHERE business_id = ?", businessId)).toHaveLength(0);
    await send(businessId, `SAMPLE HOSTEL: Daily Front Office Report - ${long(day)}`, front(day));
    const bks = await q('SELECT ext_ref, status, from_report, report_due_paise, pnr, channel, guest_name, meal_plan FROM bookings WHERE business_id = ? ORDER BY ext_ref', businessId);
    expect(bks).toMatchObject([
      { ext_ref: 'XOX0000301', status: 'approved', from_report: 1, report_due_paise: 300_000, channel: 'Direct', guest_name: 'Arrive Guest', meal_plan: 'EP' },
      { ext_ref: 'XOX0000302', status: 'approved', from_report: 1, report_due_paise: 0, pnr: '0100000002', guest_name: 'Stay Guest', meal_plan: 'CP' }]);
    const today = await ok(counter.get(`${B}/frontdesk/today`));
    expect(today.arrivals.find((a: any) => a.extRef === 'XOX0000301' || a.guestName === 'Arrive Guest')).toMatchObject({ duePaise: 300_000 });

    // The rooms report: room numbers set, the guest staying brought in as in house.
    await send(businessId, `SAMPLE HOSTEL: Daily Occupied Rooms Report - ${long(day)}`, [
      '| Rooms # | Guest Name Voucher No. | Status | Check-in | Check-out | Occupancy | Meal |',
      `| X | Arrive Guest XOX0000301 | Check-In Today | ${short(day)} | ${short(plus(2))} | 2 | 0 | 0 | EP |`,
      `| XI | Stay Guest XOX0000302 | Stay Over | ${short(plus(-1))} | ${short(plus(1))} | 2 | 0 | 0 | CP |`].join('\n'));
    const stay = (await q("SELECT id, room, before_pos, check_in FROM stays WHERE business_id = ?", businessId));
    expect(stay).toMatchObject([{ room: 'XI', before_pos: 1, check_in: plus(-1) }]);
    expect((await q("SELECT room_labels FROM bookings WHERE business_id = ? AND ext_ref = 'XOX0000301'", businessId))[0].room_labels).toBe('X');
    // Reading the same report again adds nothing.
    await send(businessId, `SAMPLE HOSTEL: Daily Front Office Report - ${long(day)}`, front(day));
    expect(await q('SELECT 1 FROM bookings WHERE business_id = ?', businessId)).toHaveLength(2);

    // The total rent typed from Djubo (optional): Djubo said nothing was left to collect, so all of it was paid before.
    const sid = stay[0].id;
    const bill = await ok(counter.post(`${B}/stays/${sid}/report-rent`, { total: '4000' }));
    expect(bill).toMatchObject({ rentPaise: 400_000, prepaidPaise: 400_000, balancePaise: 0 });
    expect((await counter.post(`${B}/stays/${sid}/report-rent`, { total: '4000' })).status).toBe(409);
    await ok(counter.post(`${B}/stays/${sid}/check-out`, {}));
  });
});
