// One check-in for a booking of several rooms or beds (24 Nov 2026): each room or bed shows taken, while the rent, the
// food and the payments go on the first room's one bill; checking out the first room checks out the group, and one bed
// may leave early. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('group check-in', () => {
  it('checks a guest in to several beds with one bill, food from any bed on it, and checks the group out together', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Main', kind: 'other', tables: ['T1', 'T2'] },
      { name: 'Quad', kind: 'dorms', dorms: [{ name: 'II', beds: 4 }, { name: 'IV', beds: 4 }] }] }));
    const beds = (await ok(owner.get(`${B}/tables`))).sections.find((x: any) => x.name === 'Quad').tables.filter((t: string) => !/whole$/.test(t));
    const [b1, b2, b3, b4] = [beds[0], beds[1], beds[4], beds[5]];

    // Three beds for one guest; a bed already taken is refused with its name, and nothing is checked in.
    const other = (await ok(counter.post(`${B}/stays`, { room: b4, guestName: 'Other Guest' }))).id;
    const bad = await counter.post(`${B}/stays`, { room: b1, rooms: [b3, b4], guestName: 'Sample Group' });
    expect(bad.status).toBe(409);
    expect(bad.json.error).toContain(b4);
    expect((await q("SELECT count(*) AS n FROM stays WHERE guest_name = 'Sample Group'"))[0].n).toBe(0);

    const r = await ok(counter.post(`${B}/stays`, { room: b1, rooms: [b2, b3, b1], guestName: 'Sample Group', phone: '9800011111', adults: 3 }));
    expect(r.rooms).toEqual([b1, b2, b3]);
    const open = (await ok(counter.get(`${B}/stays`))).stays.filter((x: any) => x.guestName === 'Sample Group');
    expect(open.map((x: any) => [x.room, x.groupRoom])).toEqual([[b1, null], [b2, b1], [b3, b1]].sort());
    const member = open.find((x: any) => x.room === b2);
    // The group's other beds have their booking on the first bed: they are not "a guest with no booking" to link to.
    const inbox = await ok(counter.get(`${B}/bookings`));
    expect(inbox.unbooked.map((x: any) => x.room)).toEqual([b1, b4].sort());
    expect((await counter.post(`${B}/bookings/${crypto.randomUUID()}/link-stay`, { stayId: member.id })).status).toBe(404);

    // The room bill of any bed is the group's one bill, on the first bed.
    await ok(counter.post(`${B}/stays/${r.id}/charges`, { amount: '1500', note: 'Room rent' }));
    const viaMember = await ok(counter.get(`${B}/stays/${member.id}/bill`));
    expect(viaMember.stay).toMatchObject({ id: r.id, room: b1, group: [{ room: b2 }, { room: b3 }].sort((x, y) => x.room.localeCompare(y.room)) });
    expect(viaMember.balancePaise).toBe(150_000);

    // Food put on the second bed goes on the first bed's bill.
    const food = await billed(s, [['Masala Chai', 2]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [food.bill.id], payments: [{ mode: 'room', amount: String(food.bill.totalPaise / 100), debtorAccountId: member.accountId }] }));
    const bill = await ok(counter.get(`${B}/stays/${r.id}/bill`));
    expect(bill.balancePaise).toBe(150_000 + food.bill.totalPaise);
    expect((await ok(counter.get(`${B}/stays`))).stays.find((x: any) => x.id === member.id).balancePaise).toBe(0);

    // One bed leaves early: it is free and dirty, the bill stays.
    await ok(counter.post(`${B}/stays/${member.id}/check-out`, {}));
    expect((await q('SELECT status FROM room_status WHERE room = ?', b2))[0].status).toBe('dirty');

    // The first bed checks out the rest, after the bill is paid; one invoice names all its beds.
    expect((await counter.post(`${B}/stays/${r.id}/check-out`, {})).status).toBe(409);
    await ok(counter.post(`${B}/debtors/${bill.stay.accountId}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: String(bill.balancePaise / 100) }] }));
    const out = await ok(counter.post(`${B}/stays/${r.id}/check-out`, {}));
    expect(out.bill.invoice.room).toBe(`${b1}, ${b2}, ${b3}`);
    expect((await q("SELECT count(*) AS n FROM stays WHERE guest_name = 'Sample Group' AND checked_out_at IS NULL"))[0].n).toBe(0);
    expect((await q('SELECT room FROM room_status WHERE status = ? AND room IN (?, ?) ORDER BY room', 'dirty', b1, b3)).length).toBe(2);
    // The other guest is untouched.
    expect((await q('SELECT checked_out_at AS t FROM stays WHERE id = ?', other))[0].t).toBeNull();
  });
});
