// Stage 7 (the plan's "Later" list, approved 10 Nov 2026): the same bill number twice in one software file is imported
// once and the repeat kept apart for a person to choose; a refund to the UPI ID that paid a bill is told as that bill
// cancelled; a bill split card + UPI is backed part by part. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { bill, hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('stage 7', () => {
  it('imports a bill number seen twice in one file once, and lets a person keep either line', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'CASH', '500'], ['2610311', '31 19:05', 'CASH', '550'], ['2610312', '31 20:00', 'CASH', '100'], ['2610312', '31 20:00', 'CASH', '100']]);
    expect(await sql`SELECT bill_no FROM software_bills WHERE business_id = ${h.bid} ORDER BY bill_no`).toHaveLength(2);
    const v = await h.view();
    // The exact repeat is skipped; the different one is flagged and stops saving until chosen.
    expect(v.json.conflicts).toHaveLength(1);
    expect(v.json.conflicts[0]).toMatchObject({ billNo: '2610311', sameFile: true, existing: { amountPaise: 50000 }, incoming: { amountPaise: 55000 } });
    const res = await h.clients.accountant.put(`/businesses/${h.bid}/conflicts/${v.json.conflicts[0].id}`, { decision: 'use_incoming' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await sql`SELECT amount_paise FROM software_bills WHERE bill_no = '2610311'`)[0].amount_paise).toBe(55000);
    expect((await h.view()).json.conflicts).toHaveLength(0);
  });

  it('tells a refund to the UPI ID that paid a bill as that bill cancelled, with a refund head', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    const refunds = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Refunds to guests', type: 'expense' })).json.id;
    await h.software([['2610311', '31 19:00', 'UPI', '750']]);
    await h.register([{ no: '2610311', amount: '750', pays: [['upi', '750']] }]);
    await h.lines([['31 19:02', 750, 'CR', 'UPI/800000011/Paid/guest7@okaxis/SAMPLE BANK/ICIa']]);
    await h.decideRest();
    await h.confirm();
    const { ids: [out, other] } = await h.lines([['2 11:00', 750, 'DR', 'UPI/800000012/Refund/guest7@okaxis/SAMPLE BANK/ICIa'],
      ['2 12:00', 750, 'DR', 'UPI/800000013/Paid/vendor@okaxis/SAMPLE BANK/ICIa']]);
    const rows = (await h.clients.accountant.get(`/businesses/${h.bid}/bank-rows?from=2026-11-02&to=2026-11-02`)).json.rows;
    const r = rows.find((x: any) => x.id === out);
    expect(r.refundOf).toMatchObject({ billNos: '2610311' });
    expect(r.suggest).toMatchObject({ item: 'Refund: bill 2610311 cancelled', headId: refunds });
    expect(rows.find((x: any) => x.id === other).refundOf).toBeNull();
  });

  it('backs a bill split card + UPI part by part against the software\'s one mode', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:00', 'CARD', '1000']]);
    await h.register([{ no: '2610311', amount: '1000', pays: [['card', '600'], ['upi', '400']] }]);
    await h.credits([['31 19:03', 400]]);
    await h.swipe('31 19:01', 600);
    const b = bill(await h.view(), '2610311');
    expect(b.bank).toMatchObject({ amountPaise: 40000, suggest: 'use_register' });
    expect(b.machine).toMatchObject({ amountPaise: 60000, suggest: 'use_register' });
  });
});
