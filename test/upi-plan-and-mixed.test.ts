// The UPI tab before saving (21 Nov 2026): a same sale chosen counts as paid at once, and the UPI part of a bill paid in
// two modes is a UPI bill of its own, so its credit is not money with no bill. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('UPI tab before saving', () => {
  it('a same sale chosen on this shift is not counted twice', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    const [paid] = await h.credits([['31 15:01', 650]]);
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: paid, billType: 'fnb', item: 'lunch' }] });
    expect(res.json).toMatchObject({ booked: 1 });
    await h.software([['2610311', '31 15:00', 'UPI', '650']]);
    await h.register([{ no: '2610311', amount: '650', pays: [['upi', '650']] }]);
    await h.decideRest();
    let r = await h.reconcile();
    const card = r.fixes.find((c: any) => c.kind === 'same_sale');
    expect(card.same.bill.billNo).toBe('2610311');
    expect(r.upiBook).toMatchObject({ bookedPaise: 65000, forBillsPaise: 0 });
    const act = card.actions[0];
    expect((await h.clients.owner.post(act.path, act.body)).status).toBe(200);
    r = await h.reconcile();
    expect(r.upiBook).toMatchObject({ totalPaise: 65000, bookedPaise: 0, booked: 0, forBillsPaise: 65000, elsewhere: [] });
    expect(r.strip).toMatchObject({ upiSalesPaise: 65000, billsLeftPaise: 0 });
  });

  it('the UPI part of a bill paid in cash and UPI pairs with its credit', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 20:56', 'UPI', '966']]);
    await h.register([{ no: '2610311', amount: '966', pays: [['cash', '500'], ['upi', '466']] }]);
    const [credit] = await h.credits([['31 20:49', 466]]);
    await h.decideRest();
    const r = await h.reconcile();
    expect(r.strip.upiSalesPaise).toBe(46600);
    expect(r.noBill.map((x: any) => x.creditId)).not.toContain(credit);
    expect(r.upiBook).toMatchObject({ totalPaise: 46600, forBillsPaise: 46600, leftPaise: 0 });
  });
});
