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
    // While the guest is in house, the bill sits on the room bill (26 Nov 2026).
    expect(by(room.bill.id)).toMatchObject({ roomPlace: '101', roomOut: false, roomInvoiceNo: null });
    expect(by(unpaid.bill.id)).toMatchObject({ status: 'printed', modes: [] });
    expect(by(voided.bill.id)).toMatchObject({ status: 'void' });
    // A room invoice made at check-out is listed too, with its stay to open the room bill.
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '1050', note: 'Room rent' }));
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    await ok(counter.post(`${B}/debtors/${acc}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: String(bill.balancePaise / 100) }] }));
    await ok(counter.post(`${B}/stays/${stay}/check-out`, {}));
    const r2 = await ok(counter.get(`${B}/bill-list`));
    expect(r2.roomInvoices).toEqual([expect.objectContaining({ room: '101', guestName: 'Sample Room Guest', totalPaise: 105_000, stayId: stay })]);
    // How the room was paid: the cash taken on the room bill, the food bill on it; the food bill now paid with the room.
    expect(r2.roomInvoices[0]).toMatchObject({ paid: [{ mode: 'cash', amountPaise: bill.balancePaise }], prepaidPaise: 0, movedPaise: 0, foodBills: 1 });
    expect(r2.bills.find((b: any) => b.id === room.bill.id)).toMatchObject({ roomOut: true, roomInvoiceNo: r2.roomInvoices[0].invoiceNo });
  });
});

describe('bills on credit in the list', () => {
  it('shows the account and what it still owes (26 Nov 2026)', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    const b = await billed(s, [['Masala Dosa', 1]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [b.bill.id], payments: [{ mode: 'credit', amount: String(b.bill.totalPaise / 100), newCredit: { name: 'Sample Travels', phone: '9800033333' } }], ...s.mgr }));
    const r = await ok(counter.get(`${B}/bill-list`));
    expect(r.bills.find((x: any) => x.id === b.bill.id)).toMatchObject({ modes: ['credit'], credit: 'Sample Travels', creditOwesPaise: b.bill.totalPaise });
  });
});
