// A guest who left the room with the bill still open (27 Nov 2026): the room is freed for the next guest, their open food
// moves to the restaurant table they sit at (or waits), and check-out waits for it. A restaurant table can be opened for a
// guest in house. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('left room, bill open', () => {
  it('frees the room, moves the food to a table, and check-out still waits for it', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Main', kind: 'other', tables: ['T1', 'T2'] }, { name: 'Deluxe', kind: 'rooms', tables: ['R1', 'R2'] }] }));
    const old = (await ok(counter.post(`${B}/stays`, { room: 'R1', guestName: 'Leaving Guest' }))).id;
    const food = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'R1' }))).id;
    expect((await q('SELECT stay_id FROM orders WHERE id = ?', food))[0].stay_id).toBe(old);

    const ck = await ok(counter.get(`${B}/stays/${old}/left-room`));
    expect(ck.orders.map((o: { id: string }) => o.id)).toEqual([food]);
    expect(ck.freeTables).toEqual(['T1', 'T2']);
    expect((await counter.post(`${B}/stays/${old}/left-room`, {})).status).toBe(409);   // food open: choose what to do
    const r = await ok(counter.post(`${B}/stays/${old}/left-room`, { move: 'table', table: 'T2' }));
    expect(r).toMatchObject({ table: 'T2', rooms: ['R1'] });
    expect((await q('SELECT room, checked_out_at FROM stays WHERE id = ?', old))[0]).toEqual({ room: 'R1 (left room)', checked_out_at: null });
    expect((await q('SELECT place, stay_id FROM orders WHERE id = ?', food))[0]).toEqual({ place: 'T2', stay_id: old });
    expect((await q("SELECT status FROM room_status WHERE room = 'R1'"))[0].status).toBe('dirty');

    // The next guest moves in to R1; food on the R1 tile is theirs.
    const next = (await ok(counter.post(`${B}/stays`, { room: 'R1', guestName: 'Next Guest', dirtyOk: true }))).id;
    const theirs = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'R1' }))).id;
    expect((await q('SELECT stay_id FROM orders WHERE id = ?', theirs))[0].stay_id).toBe(next);

    // The guest who left can't check out while T2 is open; once it's closed, check-out works and R1 is not marked dirty again.
    expect((await owner.post(`${B}/stays/${old}/check-out`, {})).json.code).toBe('open_food');
    await q("UPDATE orders SET status = 'cancelled' WHERE id = ?", food);
    await q("UPDATE room_status SET status = 'clean' WHERE room = 'R1'");
    await ok(owner.post(`${B}/stays/${old}/check-out`, {}));
    expect((await q('SELECT room FROM stays WHERE id = ?', old))[0].room).toBe('R1');
    expect((await q("SELECT status FROM room_status WHERE room = 'R1'"))[0].status).toBe('clean');
    expect((await q('SELECT checked_out_at FROM stays WHERE id = ?', next))[0].checked_out_at).toBeNull();
  });

  it('keeps the food waiting under the guest\'s name when they are not at a table yet', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Main', kind: 'other', tables: ['T1'] }, { name: 'Deluxe', kind: 'rooms', tables: ['W1'] }] }));
    const old = (await ok(counter.post(`${B}/stays`, { room: 'W1', guestName: 'Waiting Guest' }))).id;
    const food = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'W1' }))).id;
    await ok(counter.post(`${B}/stays/${old}/left-room`, { move: 'wait' }));
    expect((await q('SELECT place FROM orders WHERE id = ?', food))[0].place).toBe('Waiting Guest · left W1');
    expect((await counter.post(`${B}/stays/${old}/left-room`, { move: 'wait' })).status).toBe(409);   // already left
  });

  it('a restaurant table can be opened for, linked to and unlinked from a guest in house', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Main', kind: 'other', tables: ['T1', 'T2'] }, { name: 'Deluxe', kind: 'rooms', tables: ['G1'] }] }));
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'G1', guestName: 'Diner Guest' }))).id;
    const a = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T1', guestStayId: stay }))).id;
    expect((await q('SELECT stay_id, guest_name FROM orders WHERE id = ?', a))[0]).toEqual({ stay_id: stay, guest_name: 'Diner Guest' });
    const b = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T2' }))).id;
    await ok(counter.post(`${B}/orders/${b}/stay`, { stayId: stay }));
    expect((await q('SELECT stay_id FROM orders WHERE id = ?', b))[0].stay_id).toBe(stay);
    expect((await owner.post(`${B}/stays/${stay}/check-out`, {})).json.code).toBe('open_food');
    await ok(counter.post(`${B}/orders/${b}/stay`, { stayId: null }));
    expect((await q('SELECT stay_id FROM orders WHERE id = ?', b))[0].stay_id).toBeNull();
    // A room tile belongs to the guest in it.
    const room = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'G1' }))).id;
    expect((await counter.post(`${B}/orders/${room}/stay`, { stayId: null })).status).toBe(409);
  });
});
