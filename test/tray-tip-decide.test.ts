// The tray's tip or discount on a bill the software has at what was paid (18 Nov 2026): the register then differs
// from the software, so the bill takes the credit only once decided Use register, which the tray now does. Invented data.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('tray tip on a bill the software has at the amount paid', () => {
  it('matches on save after Use register', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610411', '31 13:00', 'UPI', '208']]);
    await h.register([{ no: '2610411', amount: '198', discount: '-10', pays: [['upi', '208']] }]);
    const [cr] = await h.credits([['31 20:00', 220]]);
    const r = await h.reconcile();
    const bill = r.open.bills.find((x: any) => x.billNo === '2610411');
    const acc = h.clients.accountant;
    // What the tray writes: ₹ 22 tip, UPI ₹ 220.
    const put = await acc.put(`/businesses/${h.bid}/register-rows/${bill.rowId}`, { billNo: '2610411', billType: 'fnb', amount: '198', discount: '-22', status: 'checked',
      payments: [{ mode: 'upi', columnLabel: 'UPI XOXO', amount: '220' }] });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const url = `/businesses/${h.bid}/shifts/2026-10-31/choices`;
    const pair = { pairs: [{ bankRowId: cr, comparisonIds: [bill.id] }] };
    const refused = await acc.post(url, pair);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/decide/);
    expect((await acc.put(`/businesses/${h.bid}/comparisons/${bill.id}`, { decision: 'use_register', note: 'Bank ₹ 220 at 20:00: ₹ 12 tip' })).status).toBe(200);
    const ok = await acc.post(url, pair);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await h.confirm();
    const tx = await sql`SELECT amount_paise, matched_bank_row FROM transactions WHERE business_id = ${h.bid} AND bill_no = '2610411' AND type = 'income'`;
    expect(tx.map((x: any) => [Number(x.amount_paise), x.matched_bank_row])).toEqual([[22000, cr]]);
  });
});

describe('card tray tip on a bill the software has at the amount paid', () => {
  it('matches the machine payment on save after Use register', async () => {
    const h = await hotel();
    await h.software([['2610421', '31 13:00', 'CARD', '510'], ['2610422', '1 07:59', 'CASH', '1']]);
    await h.register([{ no: '2610421', amount: '500', discount: '-10', pays: [['card', '510']] }, { no: '2610422', amount: '1', pays: [['cash', '1']] }]);
    const pay = await h.swipe('31 13:05', 520);
    await h.swipe('1 09:00', 1);
    const v = await h.view();
    const c = v.json.comparisons.find((x: any) => x.billNo === '2610421');
    const acc = h.clients.accountant;
    expect((await acc.put(`/businesses/${h.bid}/register-rows/${c.register.rowId}`, { billNo: '2610421', billType: 'fnb', amount: '500', discount: '-20', status: 'checked',
      payments: [{ mode: 'card', columnLabel: 'Card', amount: '520' }] })).status).toBe(200);
    const url = `/businesses/${h.bid}/shifts/2026-10-31/card-choices`;
    const pair = { pairs: [{ paymentId: pay, comparisonIds: [c.id] }] };
    expect((await acc.post(url, pair)).status).toBe(409);
    expect((await acc.put(`/businesses/${h.bid}/comparisons/${c.id}`, { decision: 'use_register', note: 'Card machine ₹ 520: ₹ 20 tip' })).status).toBe(200);
    const ok = await acc.post(url, pair);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });
});
