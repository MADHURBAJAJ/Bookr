// A group's check-out and payments (27 Nov 2026): food still open on any of its beds stops a check-out (bed or whole
// group), and money taken on a bed goes on the group's bill. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('group check-out and payments', () => {
  it('stops a check-out while food is open, and lets the next guest order on the bed', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Dorm', kind: 'rooms', tables: ['G1', 'G2', 'G3'] }] }));
    const head = (await ok(counter.post(`${B}/stays`, { room: 'G1', guestName: 'Group Guest' }))).id;
    await ok(counter.post(`${B}/stays/${head}/add-beds`, { rooms: ['G2', 'G3'] }));
    const bed = (await q("SELECT id FROM stays WHERE room = 'G2' AND business_id = ?", s.businessId))[0].id;
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'G2' }))).id;
    expect((await q('SELECT stay_id FROM orders WHERE id = ?', order))[0].stay_id).toBe(bed);

    const r = await counter.post(`${B}/stays/${bed}/check-out`, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('open_food');
    expect(r.json.orders.map((o: { id: string }) => o.id)).toEqual([order]);
    // The first room checks the whole group out: stopped too.
    const g = await owner.post(`${B}/stays/${head}/check-out`, {});
    expect(g.json.code).toBe('open_food');

    await q("UPDATE orders SET status = 'cancelled' WHERE id = ?", order);   // closed (paid or cancelled)
    await ok(counter.post(`${B}/stays/${bed}/check-out`, {}));
    await ok(counter.post(`${B}/stays`, { room: 'G2', guestName: 'Next Guest', dirtyOk: true }));
    await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'G2' }));   // not blocked by the old order
  });

  it('money taken on a bed goes on the group bill', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Dorm', kind: 'rooms', tables: ['P1', 'P2'] }] }));
    const head = (await ok(counter.post(`${B}/stays`, { room: 'P1', guestName: 'Pay Group' }))).id;
    await ok(counter.post(`${B}/stays/${head}/add-beds`, { rooms: ['P2'] }));
    const bedAcc = (await q("SELECT d.id FROM debtor_accounts d JOIN stays s ON s.id = d.stay_id WHERE s.room = 'P2' AND s.business_id = ?", s.businessId))[0].id;
    await ok(counter.post(`${B}/debtors/${bedAcc}/receipts`, { kind: 'advance', payments: [{ mode: 'upi', amount: '500', payAccountId: s.upiCompany }] }));
    expect((await ok(counter.get(`${B}/stays/${head}/bill`))).balancePaise).toBe(-50_000);
    expect((await q('SELECT coalesce(sum(amount_paise), 0) AS s FROM debtor_entries WHERE account_id = ?', bedAcc))[0].s).toBe(0);
  });
});
