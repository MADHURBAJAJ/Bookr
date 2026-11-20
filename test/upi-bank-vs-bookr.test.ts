// UPI: the bank against Bookr (approved 20 Nov 2026). Every UPI credit of the 8 am to 8 am window is split into this
// shift's bills, sales booked with no bill and what is not booked yet, before and after saving. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('UPI bank against Bookr', () => {
  it('splits the window: bills, booked with no bill, not booked yet', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 15:00', 'UPI', '30'], ['2610312', '31 18:00', 'UPI', '500']]);
    await h.register([{ no: '2610311', amount: '30', pays: [['upi', '30']] }, { no: '2610312', amount: '500', pays: [['upi', '500']] }]);
    const [, , extra, noBill] = await h.credits([['31 15:01', 30], ['31 18:01', 500], ['31 20:00', 30], ['31 21:00', 120]]);
    const before = (await h.reconcile()).upiBook;
    expect(before).toMatchObject({ totalPaise: 68000, payments: 4, forBillsPaise: 53000, bookedPaise: 0, leftPaise: 15000, left: 2, other: [], elsewhere: [] });

    await h.decideRest();
    await h.confirm();
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: noBill, billType: 'fnb', item: 'tea' }] });
    expect(res.json).toMatchObject({ booked: 1 });
    const saved = await h.reconcile();
    expect(saved.upiBook).toMatchObject({ totalPaise: 68000, payments: 4, forBillsPaise: 53000, bookedPaise: 12000, booked: 1, leftPaise: 3000, left: 1 });
    expect(saved.noBill.map((x: any) => x.creditId)).toEqual([extra]);
  });
});
