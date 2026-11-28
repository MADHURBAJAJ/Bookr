// "Did not arrive" in the night audit (27 Nov 2026): nights a guest stayed before the desk checked them in here, which
// Djubo sent only later (one booking per night, leading into their stay), are not asked about; a booking the POS knew of
// in time and nobody checked in still is. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);
const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

describe('did not arrive', () => {
  it('leaves out earlier nights that lead into the guest\'s stay and came late; keeps real no-shows', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] }));
    const today = (await ok(owner.get('/me'))).business.shiftDay;
    const long = Date.now() - 10 * 86_400_000;   // known in good time
    const bk = async (ref: string, guest: string, phone: string, inDay: string, outDay: string, createdAt: number) => {
      const id = crypto.randomUUID();
      await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, phone, room_type, room_labels, rooms, check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at)
        VALUES (?, ?, 'djubo', ?, ?, ?, 'Deluxe', 'XI', 1, ?, ?, 'approved', 200000, 200000, ?, ?)`, id, s.businessId, ref, guest, phone, inDay, outDay, createdAt, createdAt);
      return id;
    };
    // In house from yesterday, checked in here with their booking.
    const now = await bk('DJ-NOW', 'Sample Stayer', '9800066666', add(today, -1), add(today, 1), long);
    await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Sample Stayer', phone: '9800066666', bookingId: now, ...s.mgr }));
    // The three nights before it, in Djubo since, sent only today (reception marked them paid): stayed, not missed.
    await bk('DJ-E1', 'Sample Stayer', '91- 9800066666', add(today, -4), add(today, -3), Date.now());
    await bk('DJ-E2', 'Mr. Sample Stayer', '9800066666', add(today, -3), add(today, -2), Date.now());
    await bk('DJ-E3', 'Sample Stayer', '9800066666', add(today, -2), add(today, -1), Date.now());
    // A night with a gap before the stay: not leading into it.
    await bk('DJ-GAP', 'Sample Stayer', '9800066666', add(today, -7), add(today, -6), Date.now());
    // Another guest who never came, known in time.
    await bk('DJ-MISS', 'Other Guest', '9800011111', add(today, -2), add(today, -1), long);
    // The same guest's night before the stay, known in time and not checked in: still asked about.
    const s2 = await setupBusiness();
    await s2.ok(s2.owner.call('PUT', `${s2.B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI'] }] }));
    const id2 = crypto.randomUUID();
    await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, phone, room_type, room_labels, rooms, check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at)
      VALUES (?, ?, 'djubo', 'DJ-LATE', 'Late Guest', '9800022222', 'Deluxe', 'XI', 1, ?, ?, 'approved', 200000, 0, ?, ?)`, id2, s2.businessId, add(today, -2), add(today, -1), long, long);
    const id3 = crypto.randomUUID();
    await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, phone, room_type, room_labels, rooms, check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at)
      VALUES (?, ?, 'djubo', 'DJ-LATE2', 'Late Guest', '9800022222', 'Deluxe', 'XI', 1, ?, ?, 'approved', 200000, 0, ?, ?)`, id3, s2.businessId, add(today, -1), add(today, 1), long, long);
    await s2.ok(s2.counter.post(`${s2.B}/stays`, { room: 'XI', guestName: 'Late Guest', phone: '9800022222', bookingId: id3, ...s2.mgr }));

    const a = await ok(counter.get(`${B}/frontdesk/audit`));
    expect(a.notArrived.map((x: any) => x.extRef ?? x.guestName).sort()).toEqual(['Other Guest', 'Sample Stayer']);
    expect(a.notArrived.find((x: any) => x.guestName === 'Sample Stayer').checkIn).toBe(add(today, -7));   // the gap night only
    expect(a.notArrived[0]).not.toHaveProperty('phone');
    // Day close's "Arrivals not checked in" follows the same rule (28 Nov 2026).
    const dc = await ok(owner.get(`${B}/shifts/${today}`));
    expect(dc.notCheckedIn.map((x: any) => [x.guestName, x.checkIn])).toEqual([['Sample Stayer', add(today, -7)], ['Other Guest', add(today, -2)]]);
    expect(dc.notCheckedIn[0]).not.toHaveProperty('phone');
    // And the Check-in page's "earlier days" (28 Nov 2026).
    const ar = await ok(counter.get(`${B}/bookings/arrivals?day=${today}`));
    expect(ar.late.map((x: any) => [x.guestName, x.checkIn])).toEqual([['Sample Stayer', add(today, -7)], ['Other Guest', add(today, -2)]]);
    const a2 = await s2.ok(s2.counter.get(`${s2.B}/frontdesk/audit`));
    expect(a2.notArrived.map((x: any) => [x.guestName, x.checkIn])).toEqual([['Late Guest', add(today, -2)]]);
  });
});
