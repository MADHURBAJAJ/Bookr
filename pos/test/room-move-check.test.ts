// Moving or swapping rooms (27 Nov 2026): the move check lists what goes with the guest, printed-but-unpaid orders move
// too, and an order on nobody's bill moves only when asked. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('room move check', () => {
  it('shows what moves, moves printed orders, and links loose orders only when asked', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['R1', 'R2', 'R3'] }] }));
    const a = (await ok(counter.post(`${B}/stays`, { room: 'R1', guestName: 'Mover Guest' }))).id;
    const mine = (await ok(counter.post(`${B}/orders`, { kind: 'room', place: 'Room R1', stayId: a }))).id;
    await q("UPDATE orders SET status = 'billed' WHERE id = ?", mine);   // printed, not paid
    const looseOld = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'R1' }))).id;
    await q('UPDATE orders SET stay_id = NULL WHERE id = ?', looseOld);   // someone ordered on the tile without the bill
    const looseNew = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'R2' }))).id;

    const ck = await ok(counter.get(`${B}/stays/${a}/move-check?room=R2`));
    expect(ck.guests).toHaveLength(1);
    expect(ck.guests[0]).toMatchObject({ stayId: a, from: 'R1', to: 'R2' });
    expect(ck.guests[0].orders.map((o: { id: string }) => o.id)).toEqual([mine]);
    expect(ck.loose).toEqual([{ room: 'R1', orders: [expect.objectContaining({ id: looseOld })] }, { room: 'R2', orders: [expect.objectContaining({ id: looseNew })] }]);

    // An order from another room can't be put on the bill.
    const other = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'R3' }))).id;
    expect((await counter.post(`${B}/stays/${a}/move`, { room: 'R2', attach: [{ orderId: other, stayId: a }] })).status).toBe(409);

    await ok(counter.post(`${B}/stays/${a}/move`, { room: 'R2', attach: [{ orderId: looseOld, stayId: a }] }));
    const rows = await q('SELECT id, place, stay_id FROM orders WHERE id IN (?, ?, ?)', mine, looseOld, looseNew);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[mine]).toMatchObject({ place: 'R2', stay_id: a });        // printed order went with the guest
    expect(by[looseOld]).toMatchObject({ place: 'R2', stay_id: a });    // asked: now on the guest's bill
    expect(by[looseNew]).toMatchObject({ place: 'R2', stay_id: null }); // not asked: left on the table
  });

  it('a swap checks both guests and puts a loose order on the chosen bill', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['S1', 'S2'] }] }));
    const a = (await ok(counter.post(`${B}/stays`, { room: 'S1', guestName: 'Swap One' }))).id;
    const b = (await ok(counter.post(`${B}/stays`, { room: 'S2', guestName: 'Swap Two' }))).id;
    const loose = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'S2' }))).id;
    await q('UPDATE orders SET stay_id = NULL WHERE id = ?', loose);
    const ck = await ok(counter.get(`${B}/stays/${a}/move-check?with=${b}`));
    expect(ck.guests.map((g: { from: string; to: string }) => `${g.from}>${g.to}`)).toEqual(['S1>S2', 'S2>S1']);
    expect(ck.loose[1].orders[0].id).toBe(loose);
    await ok(counter.post(`${B}/stays/${a}/swap`, { withStayId: b, attach: [{ orderId: loose, stayId: b }] }));
    expect((await q('SELECT place, stay_id FROM orders WHERE id = ?', loose))[0]).toEqual({ place: 'S1', stay_id: b });
  });
});
