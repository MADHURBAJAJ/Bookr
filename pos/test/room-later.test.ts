// Check in now, room later (28 Nov 2026): a guest checked in before a room is free has a bill (food and payments go on it),
// waits under "Waiting for a room", blocks the day's close until given a room, and Give room (Move room) moves them in
// without marking a placeholder dirty or moving a restaurant table linked to them. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('check in now, room later', () => {
  it('checks in with no room, keeps food on the bill, blocks the close, and Give room moves them in', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Main', kind: 'other', tables: ['T1'] }, { name: 'Deluxe', kind: 'rooms', tables: ['R1', 'R2'] }] }));
    const r = await ok(counter.post(`${B}/stays`, { roomLater: true, guestName: 'Early Guest' }));
    const stay = (await q('SELECT room FROM stays WHERE id = ?', r.id))[0].room as string;
    expect(stay.startsWith('Waiting for room · Early Guest #')).toBe(true);
    // R1 and R2 are still free for others.
    const other = (await ok(counter.post(`${B}/stays`, { room: 'R2', guestName: 'Other Guest' }))).id;
    // A second guest waiting at the same time gets their own placeholder.
    const r2 = await ok(counter.post(`${B}/stays`, { roomLater: true, guestName: 'Early Guest' }));
    expect(r2.id).not.toBe(r.id);
    // They eat at T1 while waiting: the table is linked to them, and the bill goes on their room bill.
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T1', guestStayId: r.id }))).id;
    const bill = await ok(counter.get(`${B}/stays/${r.id}/bill`));
    await q("INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, at) VALUES ('rl-1', ?, ?, 'charge', 50000, ?)", s.businessId, bill.stay.accountId, Date.now());
    expect((await ok(counter.get(`${B}/stays/${r.id}/bill`))).balancePaise).toBe(50_000);

    // The day can't close while a guest waits for a room.
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const sh = await ok(owner.get(`${B}/shifts/${day}`));
    expect(sh.summary.waitingRoom.map((x: any) => x.guestName)).toEqual(['Early Guest', 'Early Guest']);
    const close = await owner.post(`${B}/shifts/${day}/close`, { counted: '0' });
    expect(close.status).toBe(409);
    expect(close.json.error).toMatch(/Waiting for a room: Early Guest/);

    // Give room: R1. The placeholder is not marked dirty; the T1 order stays at T1, still theirs.
    await ok(counter.post(`${B}/stays/${r.id}/move`, { room: 'R1' }));
    expect((await q('SELECT room FROM stays WHERE id = ?', r.id))[0].room).toBe('R1');
    expect(await q("SELECT room FROM room_status WHERE room LIKE 'Waiting for room%'")).toEqual([]);
    expect((await q('SELECT place, stay_id FROM orders WHERE id = ?', order))[0]).toEqual({ place: 'T1', stay_id: r.id });
    expect((await ok(counter.get(`${B}/stays/${r.id}/bill`))).balancePaise).toBe(50_000);
    expect((await q("SELECT count(*) AS n FROM audit_log WHERE action = 'stay.give_room'"))[0].n).toBe(1);
    // R2's guest is untouched.
    expect((await q('SELECT room FROM stays WHERE id = ?', other))[0].room).toBe('R2');
    // A waiting guest who leaves without a room checks out without marking anything dirty.
    const out = await owner.post(`${B}/stays/${r2.id}/check-out`, {});
    expect(out.status).toBe(200);
    expect((await q('SELECT checked_out_at IS NOT NULL AS out FROM stays WHERE id = ?', r2.id))[0].out).toBe(1);
    expect(await q("SELECT room FROM room_status WHERE room LIKE 'Waiting for room%'")).toEqual([]);
  });
});
