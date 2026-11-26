// Advances on restaurant orders (26 Nov 2026): taken on a running order or for a party booked ahead, with a numbered receipt
// counted in takings that day; used on the bill without being counted again; what is left given back or kept. Invented data.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('restaurant advances', () => {
  it('on a running order: receipt today, used on the bill, counted once', async () => {
    const s = await setupBusiness();
    const { B, counter, ok, owner } = s;
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T31' }))).id;
    await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: 4 }));
    const a = await ok(counter.post(`${B}/restaurant-advances`, { orderId: order, guestName: 'Sample Diner', payments: [{ mode: 'cash', amount: '500' }] }));
    expect(a.receipt).toMatchObject({ kind: 'advance', totalPaise: 50_000, place: 'T31', receiptNo: expect.stringMatching(/^RCPT\//) });
    const held = (await ok(counter.get(`${B}/restaurant-advances?orderId=${order}`))).advances;
    expect(held.map((x: any) => [x.guestName, x.leftPaise, x.place])).toEqual([['Sample Diner', 50_000, 'T31']]);
    await ok(counter.post(`${B}/orders/${order}/kot`));
    const bill = (await ok(counter.post(`${B}/orders/${order}/bill`, { entityId: s.company }))).bill;
    const rest = bill.totalPaise - 50_000;
    await ok(counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'advance', amount: '500', debtorAccountId: a.accountId }, { mode: 'cash', amount: (rest / 100).toFixed(2) }] }));
    expect((await ok(counter.get(`${B}/restaurant-advances`))).advances).toEqual([]);
    // Takings: the ₹500 advance (receipt) and the rest (bill), not the advance twice.
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const sum = (await ok(owner.get(`${B}/shifts/${day}`))).summary;
    const cash = [...sum.byMode, ...sum.receipts].filter((m: any) => m.mode === 'cash').reduce((t: number, m: any) => t + m.paise, 0);
    expect(cash).toBe(bill.totalPaise);
    expect(sum.advancesHeld).toEqual([]);
  });

  it('for a party booked ahead: held, linked on the day, what is left given back; a no-show kept by a manager', async () => {
    const s = await setupBusiness();
    const { B, counter, ok, owner, mgr } = s;
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    expect((await counter.post(`${B}/restaurant-advances`, { guestName: 'Sample Party', partyDay: day, payments: [{ mode: 'cash', amount: '2000' }] })).status).toBe(400);   // a phone is needed
    const a = await ok(counter.post(`${B}/restaurant-advances`, { guestName: 'Sample Party', phone: '9800088881', partyDay: day, partyTime: '20:30', people: 12, payments: [{ mode: 'cash', amount: '2000' }] }));
    let sum = (await ok(owner.get(`${B}/shifts/${day}`))).summary;
    expect(sum.advancesHeld.map((x: any) => [x.guestName, x.leftPaise, x.partyTime, x.people, x.phoneEnd])).toEqual([['Sample Party', 200_000, '20:30', 12, '8881']]);
    // On the day: their table, the advance put on it; the bill is less than the advance, ₹ left is given back.
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T32' }))).id;
    await ok(counter.post(`${B}/restaurant-advances/${a.id}/link`, { orderId: order }));
    await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items['Masala Chai'], delta: 5 }));
    await ok(counter.post(`${B}/orders/${order}/kot`));
    const bill = (await ok(counter.post(`${B}/orders/${order}/bill`, { entityId: s.company }))).bill;
    await ok(counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'advance', amount: (bill.totalPaise / 100).toFixed(2), debtorAccountId: a.accountId }] }));
    let left = (await ok(counter.get(`${B}/restaurant-advances`))).advances;
    expect(left.map((x: any) => [x.leftPaise, x.place])).toEqual([[200_000 - bill.totalPaise, 'T32']]);
    await ok(counter.post(`${B}/debtors/${a.accountId}/refund`, { mode: 'cash', amount: ((200_000 - bill.totalPaise) / 100).toFixed(2), note: 'Advance left over', ...mgr }));
    expect((await ok(counter.get(`${B}/restaurant-advances`))).advances).toEqual([]);
    // A no-show: kept by a manager, with a reason; it leaves the lists.
    const b = await ok(counter.post(`${B}/restaurant-advances`, { guestName: 'Sample No Show', phone: '9800088882', partyDay: day, payments: [{ mode: 'upi', amount: '1000', payAccountId: s.upiCompany }] }));
    expect((await counter.post(`${B}/restaurant-advances/${b.id}/keep`, { note: 'Did not come' })).status).toBe(403);
    await ok(counter.post(`${B}/restaurant-advances/${b.id}/keep`, { note: 'Did not come, non-refundable', ...mgr }));
    sum = (await ok(owner.get(`${B}/shifts/${day}`))).summary;
    expect(sum.advancesHeld).toEqual([]);
  });
});
