// Swapping two in-house guests' rooms (25 Nov 2026): each takes the other's room with their bill and open food orders,
// in one step, with a reason if one is given (optional since 26 Nov 2026); neither room is marked dirty. All names and numbers are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('room swap', () => {
  it('exchanges two guests\' rooms with their bills and open orders, without marking either dirty', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Boutique', kind: 'rooms', tables: ['XXI', 'XXII'] }] }));
    const a = (await ok(counter.post(`${B}/stays`, { room: 'XXI', guestName: 'Sample Guest A' }))).id;
    const b = (await ok(counter.post(`${B}/stays`, { room: 'XXII', guestName: 'Sample Guest B' }))).id;
    await ok(counter.post(`${B}/stays/${b}/charges`, { amount: '3000', note: 'Room rent' }));
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'room', place: 'Room XXI', stayId: a }))).id;

    expect((await counter.post(`${B}/stays/${a}/swap`, { withStayId: a, reason: 'Guests asked' })).status).toBe(400);
    const bill = await ok(counter.post(`${B}/stays/${a}/swap`, { withStayId: b }));   // no reason needed
    expect(bill.stay).toMatchObject({ id: a, room: 'XXII' });
    expect((await q('SELECT id, room FROM stays WHERE id IN (?, ?) ORDER BY room', a, b))).toEqual([{ id: b, room: 'XXI' }, { id: a, room: 'XXII' }]);
    expect((await ok(counter.get(`${B}/stays/${b}/bill`))).balancePaise).toBe(300_000);   // B's bill went with B
    expect((await q('SELECT place FROM orders WHERE id = ?', order))[0].place).toBe('XXII');
    expect(await q("SELECT room FROM room_status WHERE status = 'dirty' AND room IN ('XXI', 'XXII')")).toEqual([]);
    expect((await q("SELECT count(*) AS n FROM audit_log WHERE action = 'stay.swap'"))[0].n).toBe(2);
  });
});
