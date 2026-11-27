// A booking's beds missing in the POS (26 Nov 2026): reception places guests where beds are free, so a group with fewer beds
// than its booking is flagged; beds are added where the guests are, or marked as sharing. All names invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('beds missing', () => {
  it('flags a group with fewer beds than booked; add beds or mark sharing clears it', async () => {
    const s = await setupBusiness();
    const { B, counter, ok, owner } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Dorm', kind: 'rooms', tables: ['D1', 'D2', 'D3', 'D4', 'D5'] }] }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const out = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const t = Date.now();
    await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, rooms, check_in, check_out, amount_paise, paid_paise, status, created_at, updated_at, room_labels)
      VALUES ('00000000-0000-4000-8000-00000000b001', ?, 'djubo', 'DJ-G3', 'Group Guest', 'Dorm', 3, ?, ?, 300000, 300000, 'approved', ?, ?, 'D1, D2, D3')`, s.businessId, day, out, t, t);
    // Checked in to one bed only.
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'D1', guestName: 'Group Guest', bookingId: '00000000-0000-4000-8000-00000000b001' }))).id;
    let mb = (await ok(counter.get(`${B}/frontdesk/today`))).missingBeds;
    expect(mb.map((x: any) => [x.room, x.booked, x.have, x.missing])).toEqual([['D1', 3, 1, 2]]);
    // Another guest is in D2; the group's second guest is really in D4.
    await ok(counter.post(`${B}/stays`, { room: 'D2', guestName: 'Other Guest' }));
    expect((await counter.post(`${B}/stays/${stay}/add-beds`, { rooms: ['D2'] })).status).toBe(409);
    await ok(counter.post(`${B}/stays/${stay}/add-beds`, { rooms: ['D4'] }));
    mb = (await ok(counter.get(`${B}/frontdesk/today`))).missingBeds;
    expect(mb.map((x: any) => x.missing)).toEqual([1]);
    // The third shares: cleared. The bed shows as theirs, and the bill stays on D1.
    await ok(counter.post(`${B}/stays/${stay}/sharing`, { beds: 1 }));
    expect((await ok(counter.get(`${B}/frontdesk/today`))).missingBeds).toEqual([]);
    const d4 = (await q("SELECT group_stay_id FROM stays WHERE room = 'D4' AND business_id = ?", s.businessId))[0];
    expect(d4.group_stay_id).toBe(stay);
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.rentPaise).toBe(300_000);
  });

  it('a check-in with the others sharing is not flagged', async () => {
    const s = await setupBusiness();
    const { B, counter, ok, owner } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Dorm', kind: 'rooms', tables: ['E1', 'E2'] }] }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const out = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const t = Date.now();
    await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, rooms, check_in, check_out, amount_paise, paid_paise, status, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-00000000b002', ?, 'djubo', 'DJ-G2', 'Pair Guest', 'Dorm', 2, ?, ?, 200000, 200000, 'approved', ?, ?)`, s.businessId, day, out, t, t);
    await ok(counter.post(`${B}/stays`, { room: 'E1', guestName: 'Pair Guest', bookingId: '00000000-0000-4000-8000-00000000b002', sharingBeds: 1 }));
    expect((await ok(counter.get(`${B}/frontdesk/today`))).missingBeds).toEqual([]);
  });

  it('counts Djubo\'s rooms, not the OTA\'s, when Djubo split an OTA booking (27 Nov 2026)', async () => {
    const s = await setupBusiness();
    const { B, counter, ok, owner } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Mixed', kind: 'rooms', tables: ['M1', 'M2'] }] }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const out = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'M2', guestName: 'Split Guest' }))).id;
    const t = Date.now();
    await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, rooms, check_in, check_out, amount_paise, paid_paise, status, created_at, updated_at, stay_id)
      VALUES ('00000000-0000-4000-8000-00000000c001', ?1, 'mmt', 'OTA-2R', 'Split Guest', 'Deluxe', 2, ?2, ?3, 400000, 400000, 'checked_in', ?4, ?4, ?5),
             ('00000000-0000-4000-8000-00000000c002', ?1, 'djubo', 'DJ-1B', 'Split Guest', 'Quad Sharing', 1, ?2, ?3, 100000, 100000, 'checked_in', ?4, ?4, ?5)`, s.businessId, day, out, t, stay);
    expect((await ok(counter.get(`${B}/frontdesk/today`))).missingBeds).toEqual([]);
  });
});
