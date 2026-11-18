// A UPI payment under one account's column, the money in another (18 Nov 2026): offered only once the written
// account's statement runs past the bill, so a credit still to come there is not passed over. Invented data.
import { describe, expect, it } from 'vitest';
import { wrongColumn } from '../src/columnHints';

const T = Date.UTC(2026, 10, 3, 8, 0);
const w = { from: T - 3 * 3600e3, to: T + 21 * 3600e3 };
const pay = { paymentId: 'p1', rowId: 'r1', uploadId: 'u1', billNo: '26110342', amount: 125000, label: 'UPI Bank 2', paidAt: T };
const credit = { id: 'c1', amount: 125000, postedAt: T + 4 * 60000, label: 'UPI Bank 1', accountName: 'Bank 1' };
const labels = ['UPI Bank 1', 'UPI Bank 2'];

describe('wrong UPI column', () => {
  it('waits for the written account\'s statement', () => {
    expect(wrongColumn([pay], [credit], w, labels, new Map([['upibank1', T + 86400e3], ['upibank2', null]]))).toEqual([]);
    expect(wrongColumn([pay], [credit], w, labels, new Map([['upibank1', T + 86400e3], ['upibank2', T + 30 * 60000]]))).toEqual([]);
    const h = wrongColumn([pay], [credit], w, labels, new Map([['upibank1', T + 86400e3], ['upibank2', T + 2 * 3600e3]]));
    expect(h).toEqual([expect.objectContaining({ billNo: '26110342', fromLabel: 'UPI Bank 2', toLabel: 'UPI Bank 1', creditId: 'c1', minutes: 4 })]);
  });

  it('the other way round: the credit in Bank 2 and the bill under Bank 1', () => {
    const h = wrongColumn([{ ...pay, label: 'UPI Bank 1' }], [{ ...credit, label: 'UPI Bank 2', accountName: 'Bank 2' }], w, labels,
      new Map([['upibank1', T + 86400e3], ['upibank2', T + 86400e3]]));
    expect(h).toEqual([expect.objectContaining({ fromLabel: 'UPI Bank 1', toLabel: 'UPI Bank 2' })]);
  });
});
