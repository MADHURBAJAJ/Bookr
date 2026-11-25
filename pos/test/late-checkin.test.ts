// Late check-in (25 Nov 2026): a booking missed at the desk is listed under "not checked in from earlier days" and checked
// in with its own date; more than 2 days late needs a manager, more than 7 is refused; the Day close reminds and the Daily
// check lists it. All names and numbers are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);
const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

describe('late check-in', () => {
  it('lists missed bookings, checks them in with their own date, asks a manager after 2 days, and reports them', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok, mgr } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['101', '102', '103', '104'] }] }));
    const today = (await ok(owner.get('/me'))).business.shiftDay;
    const t = Date.now();
    const bk = async (ref: string, name: string, inDay: string, outDay: string) => {
      const id = crypto.randomUUID();
      await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at)
        VALUES (?, ?, 'djubo', ?, ?, 'Deluxe', ?, ?, 'approved', 150000, 150000, ?, ?)`, id, s.businessId, ref, name, inDay, outDay, t, t);
      return id;
    };
    const one = await bk('DJ-L1', 'Sample Late One', add(today, -1), today);        // left today
    const three = await bk('DJ-L3', 'Sample Late Three', add(today, -3), add(today, -2));
    const old = await bk('DJ-L9', 'Sample Too Old', add(today, -9), add(today, -8));
    const now = await bk('DJ-N', 'Sample Arriving', today, add(today, 1));

    const r = await ok(counter.get(`${B}/bookings/arrivals`));
    expect(r.arrivals.map((x: any) => x.extRef)).toEqual(['DJ-N']);
    expect(r.late.map((x: any) => x.extRef)).toEqual(['DJ-L3', 'DJ-L1']);   // 7 days back at most, oldest first
    expect((await ok(owner.get(`/businesses/${s.businessId}/shifts/${today}`))).notCheckedIn.map((x: any) => x.guestName).sort())
      .toEqual(['Sample Arriving', 'Sample Late One', 'Sample Late Three']);

    // One day late: any counter staff; the stay starts on the booking's date.
    const st1 = (await ok(counter.post(`${B}/stays`, { room: '101', guestName: 'Sample Late One', bookingId: one }))).id;
    expect((await q('SELECT check_in FROM stays WHERE id = ?', st1))[0].check_in).toBe(add(today, -1));
    // Three days late: a manager approves.
    expect((await counter.post(`${B}/stays`, { room: '102', guestName: 'Sample Late Three', bookingId: three })).status).toBe(403);
    const st3 = (await ok(counter.post(`${B}/stays`, { room: '102', guestName: 'Sample Late Three', bookingId: three, ...mgr }))).id;
    expect((await q('SELECT check_in FROM stays WHERE id = ?', st3))[0].check_in).toBe(add(today, -3));
    // Nine days late: refused.
    expect((await owner.post(`${B}/stays`, { room: '103', guestName: 'Sample Too Old', bookingId: old })).status).toBe(409);
    // Today's arrival: today's date, as before.
    const stN = (await ok(counter.post(`${B}/stays`, { room: '104', guestName: 'Sample Arriving', bookingId: now }))).id;
    expect((await q('SELECT check_in FROM stays WHERE id = ?', stN))[0].check_in).toBe(today);

    // In and out together: the booking was prepaid, so it checks out at once with an invoice for its own dates.
    const out = await ok(counter.post(`${B}/stays/${st1}/check-out`, {}));
    expect(out.bill.invoice).toMatchObject({ checkIn: add(today, -1), checkOut: today, nights: 1 });

    const dc = await ok(owner.get(`${B}/reports/daily-check?day=${today}`));
    expect(dc.lateCheckIns.map((x: any) => [x.guestName, x.checkIn, !!x.checkedOutAt])).toEqual([
      ['Sample Late One', add(today, -1), true], ['Sample Late Three', add(today, -3), false]]);
    expect((await ok(counter.get(`${B}/bookings/arrivals`))).late).toEqual([]);
  });
});
