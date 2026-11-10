// "Paid on the card machine" before saving (approved 11 Nov 2026): a bill written as UPI that the card machine got is
// corrected on Reconcile in one step: the register's payment becomes Card, the bill is decided Use register (card)
// when the software says UPI, and the machine payment is matched on save. Not offered when a UPI credit of the same
// amount is near too (paid twice?). Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('paid on the card machine, before saving', () => {
  it('changes the register to card, decides the bill and matches the machine payment on save', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:32', 'UPI', '179'], ['2610312', '31 21:00', 'UPI', '260']]);
    await h.register([{ no: '2610311', amount: '179', pays: [['upi', '179']] }, { no: '2610312', amount: '260', pays: [['upi', '260']] }]);
    const pay = await h.swipe('31 19:32', 179);
    await h.swipe('31 21:01', 260);
    await h.credits([['31 21:03', 260]]); // the 260 bill also has a UPI credit near it

    const r = await h.reconcile();
    const needs = r.cards.needs;
    const n = needs.find((x: any) => x.payment.id === pay);
    expect(n).toMatchObject({ why: 'written', written: { billNo: '2610311', mode: 'upi', swMode: 'upi', upiNear: false, rowId: h.rows['2610311'] } });
    expect(n.written.uploadId).toBeTruthy();
    expect(needs.find((x: any) => x.written?.billNo === '2610312')?.written.upiNear).toBe(true);

    // What the button does.
    const base = `/businesses/${h.bid}`;
    const u = (await h.clients.accountant.get(`${base}/uploads/${n.written.uploadId}`)).json;
    const row = u.rows.find((x: any) => x.id === n.written.rowId);
    const put = await h.clients.accountant.put(`${base}/register-rows/${row.id}`, { paidWithRowId: null, billNo: row.billNo, billType: row.billType, amount: '179', discount: '0',
      remarks: row.remarks, status: row.status, payments: [{ mode: 'card', columnLabel: 'Card', amount: '179' }] });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const c = (await h.view()).json.comparisons.find((x: any) => x.billNo === '2610311');
    expect(c.difference).not.toBe('match');
    expect((await h.clients.accountant.put(`${base}/comparisons/${c.id}`, { decision: 'use_register', note: 'Card machine ₹179 at 7:32 pm' })).status).toBe(200);
    const ch = await h.clients.accountant.post(`${base}/shifts/2026-10-31/card-choices`, { paymentId: pay, comparisonIds: [c.id] });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    expect((await h.reconcile()).cards.needs.find((x: any) => x.payment.id === pay)).toBeUndefined();

    await h.decideRest();
    await h.confirm();
    const [tx] = await sql`SELECT t.payment_mode, (SELECT count(*) FROM card_matches m WHERE m.transaction_id = t.id AND m.settlement_id = ${pay}) AS matched
      FROM transactions t WHERE t.bill_no = '2610311' AND t.type = 'income'`;
    expect(tx).toEqual({ payment_mode: 'card', matched: 1 });
  });
});
