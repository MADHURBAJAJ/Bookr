// Extra credits on Money with no bill (11 Nov 2026): a credit of an amount whose every bill already has its credit is
// money with no bill too, listed (marked extra) and bookable, before and after saving. A credit that a bill still
// without its credit could take is not listed. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('extra credits on Money with no bill', () => {
  it('lists an extra ₹30 credit, not one a waiting bill could take', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 15:00', 'UPI', '30'], ['2610312', '31 16:00', 'UPI', '30'], ['2610313', '31 22:00', 'UPI', '75']]);
    await h.register([{ no: '2610311', amount: '30', pays: [['upi', '30']] }, { no: '2610312', amount: '30', pays: [['upi', '30']] },
      { no: '2610313', amount: '75', pays: [['upi', '75']] }]);
    // Two ₹30 bills paid; a third ₹30 is extra. ₹75 at 10 pm is waiting for a credit; the ₹75 at 2 am could be it.
    const [, , extra, waitingFor] = await h.credits([['31 15:01', 30], ['31 16:01', 30], ['31 18:30', 30], ['1 02:00', 75]]);
    const r = await h.reconcile();
    expect(r.noBill).toMatchObject([{ creditId: extra, extra: 2 }]);
    expect(r.noBill.map((x: any) => x.creditId)).not.toContain(waitingFor);

    await h.decideRest();
    await h.confirm();
    const saved = await h.reconcile();
    expect(saved.noBill.map((x: any) => x.creditId)).toContain(extra);
    expect(saved.noBill.find((x: any) => x.creditId === extra).extra).toBe(2);
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: extra, billType: 'fnb', item: 'tea' }] });
    expect(res.json).toMatchObject({ booked: 1 });
  });

  it('does not list a credit equal to the other side of a bill whose software and register differ', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 13:30', 'UPI', '4410']]);
    await h.register([{ no: '2610311', amount: '4140', pays: [['upi', '4140']] }]);
    const [, other] = await h.credits([['31 13:31', 4140], ['31 13:40', 4410]]);
    expect((await h.reconcile()).noBill.map((x: any) => x.creditId)).not.toContain(other);
    await h.decideRest();
    await h.confirm();
    expect((await h.reconcile()).noBill.map((x: any) => x.creditId)).not.toContain(other);
  });
});
