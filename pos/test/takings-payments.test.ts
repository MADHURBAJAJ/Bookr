// Day close › Takings › Breakdown (26 Nov 2026): each money payment of the day, with the bills it paid or the receipt and
// the room it went on, so a tap on a total lists them. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('payments behind the day close totals', () => {
  it('lists bill payments with their bill numbers and room receipts with their room', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['201'] }] }));
    const stay = (await ok(counter.post(`${B}/stays`, { room: '201', guestName: 'Sample Stay Guest' }))).id;
    const acc = (await ok(counter.get(`${B}/stays/${stay}/bill`))).stay.accountId;
    const b = await billed(s, [['Masala Chai', 2]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [b.bill.id], payments: [{ mode: 'cash', amount: String(b.bill.totalPaise / 100) }] }));
    await ok(counter.post(`${B}/debtors/${acc}/receipts`, { kind: 'advance', payments: [{ mode: 'card', amount: '1500' }] }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const sum = (await ok(owner.get(`${B}/shifts/${day}`))).summary;
    expect(sum.payments).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'cash', kind: 'bills', amountPaise: b.bill.totalPaise, bills: b.bill.billNo, billId: b.bill.id }),
      expect.objectContaining({ mode: 'card', kind: 'receipt', amountPaise: 150000, stayId: stay, account: expect.stringContaining('Sample Stay Guest'), receiptNo: expect.stringMatching(/^RCPT\//) }),
    ]));
    // Things that are not money (room posts, credit, complimentary) are not listed.
    expect(sum.payments.every((p: { mode: string }) => ['cash', 'upi', 'card'].includes(p.mode))).toBe(true);
  });
});
