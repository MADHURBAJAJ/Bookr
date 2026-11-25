// Payments › Bills (25 Nov 2026): every bill of a shift with how it was paid, the room it went to, and void ones.
// All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('bills of a shift', () => {
  it('lists each bill with its status and how it was paid, the room for a room post', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['101'] }] }));
    const stay = (await ok(counter.post(`${B}/stays`, { room: '101', guestName: 'Sample Room Guest' }))).id;
    const acc = (await ok(counter.get(`${B}/stays/${stay}/bill`))).stay.accountId;
    const cash = await billed(s, [['Masala Chai', 2]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [cash.bill.id], payments: [{ mode: 'cash', amount: String(cash.bill.totalPaise / 100) }] }));
    const room = await billed(s, [['Masala Dosa', 1]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [room.bill.id], payments: [{ mode: 'room', amount: String(room.bill.totalPaise / 100), debtorAccountId: acc }] }));
    const unpaid = await billed(s, [['Butter Naan', 1]]);
    const voided = await billed(s, [['Beer 650 ml', 1]]);
    await ok(owner.post(`${B}/bills/${voided.bill.id}/void`, { reasonId: s.reasons.void }));

    const r = await ok(counter.get(`${B}/bill-list`));
    const by = (id: string) => r.bills.find((b: any) => b.id === id);
    expect(r.bills).toHaveLength(4);
    expect(by(cash.bill.id)).toMatchObject({ status: 'settled', modes: ['cash'] });
    expect(by(room.bill.id)).toMatchObject({ status: 'settled', modes: ['room'], room: 'Room 101 · Sample Room Guest' });
    expect(by(unpaid.bill.id)).toMatchObject({ status: 'printed', modes: [] });
    expect(by(voided.bill.id)).toMatchObject({ status: 'void' });
  });
});
