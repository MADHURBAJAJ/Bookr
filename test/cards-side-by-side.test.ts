// The suggestion cards side by side (approved 21 Nov 2026): a UPI bill with no credit says where money of its amount
// went, the UPI part of a bill paid in cash and UPI can take a credit booked as a sale (Same money), the bank-settles card
// warns about a bill written twice, and a bill-number slip needs the amounts to agree. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { statusOf } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Suggestion cards side by side', () => {
  it('a UPI bill with no credit says which bill took money of its amount, and offers the software side', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 11:04', 'UPI', '550'], ['2610312', '31 23:35', 'CASH', '544']]);
    await h.register([{ no: '2610311', amount: '550', pays: [['upi', '550']] }, { no: '2610312', amount: '550', pays: [['upi', '550']] }]);
    const [credit] = await h.credits([['31 10:58', 550], ['1 07:55', 1]]);
    const r = await h.reconcile();
    const card = r.noCredit.find((c: any) => c.kind === 'no_upi_credit' && c.billNos.includes('2610312'));
    expect(card.look.credits).toEqual([expect.objectContaining({ id: credit, use: 'pick', bills: '2610311' })]);
    expect(card.look.bill).toMatchObject({ software: { mode: 'cash', amountPaise: 54400 }, register: { mode: 'upi', amountPaise: 55000 } });
    const sw = card.actions.find((a: any) => a.body?.decision === 'use_software');
    expect(sw).toMatchObject({ label: 'It was cash ₹544 (software)', primary: true });
    expect((await h.clients.accountant.put(sw.path, sw.body)).status).toBe(200);
  });

  it('the UPI part of a bill paid in cash and UPI takes a credit booked as a sale', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    const [paid] = await h.credits([['31 19:04', 5], ['1 07:55', 1]]);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: paid, billType: 'fnb', item: 'Unbilled sale' }] })).json).toMatchObject({ booked: 1 });
    await h.software([['2610311', '31 19:12', 'UPI', '345']]);
    await h.register([{ no: '2610311', amount: '345', pays: [['cash', '340'], ['upi', '5']] }]);
    await h.decideRest();
    const r = await h.reconcile();
    const card = r.noCredit.find((c: any) => c.kind === 'no_upi_credit' && c.billNos.includes('2610311'));
    expect(card.look).toMatchObject({ mixed: true, credits: [expect.objectContaining({ id: paid, use: 'booked', sale: true })] });
    const same = card.actions.find((a: any) => a.method === 'POST');
    expect(same).toMatchObject({ primary: true, body: { rowId: paid } });
    expect((await h.clients.accountant.post(same.path, same.body)).status).toBe(200);
    await h.confirm();
    expect(await statusOf(paid)).toBe('matched');
    const sales = await sql`SELECT payment_mode, amount_paise, matched_bank_row FROM transactions WHERE business_id = ${h.bid} AND bill_no = '2610311' ORDER BY payment_mode`;
    expect(sales.map((x: any) => [x.payment_mode, x.amount_paise, x.matched_bank_row])).toEqual([['cash', 34000, null], ['upi', 500, paid]]);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE business_id = ${h.bid} AND source = 'bank_sheet'`)[0].n).toBe(0);
  });

  it('the bank-settles card shows both sides and warns about a big gap', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 11:45', 'UPI', '9000']]);
    await h.register([{ no: '2610311', amount: '6000', pays: [['upi', '6000']] }]);
    await h.credits([['31 11:43', 6000]]);
    const r = await h.reconcile();
    const card = r.fixes.find((c: any) => c.kind === 'bank_backs');
    expect(card.look).toMatchObject({ backs: 'register', software: { amountPaise: 900000 }, register: { amountPaise: 600000 } });
    expect(card.look.warn).toEqual(['₹3,000 less than the software: a discount, or a second payment still to come?']);
    expect(card.actions.map((a: any) => a.body?.decision)).toEqual(['use_register', 'use_software']);
  });

  it('no bill-number slip when the amounts differ and the software bill has its own credit', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610369', '31 23:01', 'UPI', '104']]);
    await h.register([{ no: '2610325', amount: '30', pays: [['upi', '30']] }]);
    await h.credits([['31 23:00', 104], ['31 23:37', 30]]);
    const r = await h.reconcile();
    expect(r.fixes.filter((c: any) => c.kind === 'number_typo')).toEqual([]);
  });
});
