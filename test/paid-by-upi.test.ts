// "Paid by UPI" before saving (approved 11 Nov 2026): a card (or cash) bill that one UPI credit of its exact amount
// paid instead is offered on Reconcile; one button changes the register's payment to UPI, decides the bill Use register
// when the software says otherwise, and matches the credit on save. Not offered when the card machine has a payment of
// that amount near the bill. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('paid by UPI, before saving', () => {
  it('offers the credit for a card bill with no machine payment, and the button steps make it a UPI sale on save', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:30', 'CARD', '450'], ['2610312', '31 21:00', 'CARD', '620']]);
    await h.register([{ no: '2610311', amount: '450', pays: [['card', '450']] }, { no: '2610312', amount: '620', pays: [['card', '620']] }]);
    await h.swipe('31 23:10', 999); // the card report covers the shift
    await h.swipe('31 21:00', 620); // 620 was paid on the machine
    const [credit] = await h.credits([['31 19:32', 450], ['31 21:02', 620]]);

    const r = await h.reconcile();
    expect(r.byUpi).toHaveLength(1);
    const o = r.byUpi[0];
    expect(o).toMatchObject({ billNo: '2610311', mode: 'card', amountPaise: 45000, creditId: credit, rowId: h.rows['2610311'], minutes: 2, accountName: 'HUF A' });

    // What the button does.
    const base = `/businesses/${h.bid}`;
    const acc = h.clients.accountant;
    const u = (await acc.get(`${base}/uploads/${o.uploadId}`)).json;
    const row = u.rows.find((x: any) => x.id === o.rowId);
    const put = await acc.put(`${base}/register-rows/${row.id}`, { paidWithRowId: null, billNo: row.billNo, billType: row.billType, amount: '450', discount: '0',
      remarks: row.remarks, status: row.status, payments: [{ mode: 'upi', columnLabel: o.label ?? 'UPI', amount: '450' }] });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const c = (await h.view()).json.comparisons.find((x: any) => x.billNo === '2610311');
    expect(c.difference).not.toBe('match');
    expect((await acc.put(`${base}/comparisons/${c.id}`, { decision: 'use_register', note: 'UPI credit ₹450 at 7:32 pm' })).status).toBe(200);
    const ch = await acc.post(`${base}/shifts/2026-10-31/choices`, { bankRowId: credit, comparisonIds: [c.id] });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    expect((await h.reconcile()).byUpi).toEqual([]);

    await h.decideRest();
    await h.confirm();
    const [tx] = await sql`SELECT payment_mode, matched_bank_row FROM transactions WHERE bill_no = '2610311' AND type = 'income'`;
    expect(tx).toEqual({ payment_mode: 'upi', matched_bank_row: credit });
    // Saved: nothing offered.
    expect((await h.reconcile()).byUpi).toEqual([]);
  });

  it('offers nothing when the card report does not cover the shift, or two bills could take the credit', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:30', 'CARD', '450']]);
    await h.register([{ no: '2610311', amount: '450', pays: [['card', '450']] }]);
    await h.credits([['31 19:32', 450]]);
    expect((await h.reconcile()).byUpi).toEqual([]); // no card report yet

    const g = await hotel();
    await g.account('HUF A', 'UPI XOXO');
    await g.software([['2610311', '31 19:30', 'CASH', '450'], ['2610312', '31 19:40', 'CASH', '450']]);
    await g.register([{ no: '2610311', amount: '450', pays: [['cash', '450']] }, { no: '2610312', amount: '450', pays: [['cash', '450']] }]);
    await g.credits([['31 19:35', 450]]);
    expect((await g.reconcile()).byUpi).toEqual([]);
    // One cash bill and one credit: offered.
    const k = await hotel();
    await k.account('HUF A', 'UPI XOXO');
    await k.software([['2610311', '31 19:30', 'CASH', '450']]);
    await k.register([{ no: '2610311', amount: '450', pays: [['cash', '450']] }]);
    await k.credits([['31 19:35', 450]]);
    expect((await k.reconcile()).byUpi).toMatchObject([{ billNo: '2610311', mode: 'cash', minutes: 5 }]);
  });
});
