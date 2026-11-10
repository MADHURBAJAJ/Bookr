// Stage 6 (approved 10 Nov 2026): cash moved between the drawer and the bank, a payment reversed after it was matched,
// a credit in the other account matched as written, a credit within ₹10 of one side (tip or discount), and the card
// machine backing an amount difference or the card part of a split payment. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { bill, hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('stage 6', () => {
  it('books cash deposited and cash drawn as moves, changing the cash check, and undoes them', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 12:00', 'CASH', '1000']]);
    await h.register([{ no: '2610311', amount: '1000', pays: [['cash', '1000']] }]);
    await h.decideRest();
    await h.confirm();
    const { ids: [dep, wdl] } = await h.lines([['31 15:00', 800, 'CR', 'BY CASH DEPOSIT-MAIN BRANCH'], ['31 16:00', 200, 'DR', 'CASH WDL SELF']]);
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}`;
    const rows = (await acc.get(`${base}/bank-rows?from=2026-10-31&to=2026-10-31`)).json.rows;
    expect(rows.find((r: any) => r.id === dep).cashMove).toBe('deposit');
    expect(rows.find((r: any) => r.id === wdl).cashMove).toBe('withdrawal');
    const before = (await acc.get(`${base}/shifts/2026-10-31/cash`)).json;
    expect((await h.clients.entry_staff.post(`${base}/bank-rows/${dep}/cash-move`, { shiftDay: '2026-10-31' })).status).toBe(403);
    expect((await acc.post(`${base}/bank-rows/${dep}/cash-move`, { shiftDay: '2026-10-31' })).status).toBe(200);
    expect((await acc.post(`${base}/bank-rows/${wdl}/cash-move`, { shiftDay: '2026-10-31' })).status).toBe(200);
    const after = (await acc.get(`${base}/shifts/2026-10-31/cash`)).json;
    expect([after.depositedPaise, after.drawnPaise]).toEqual([80000, 20000]);
    if (before.shouldBePaise != null) expect(after.shouldBePaise).toBe(before.shouldBePaise - 60000);
    expect(await sql`SELECT 1 FROM transactions WHERE business_id = ${h.bid} AND type = 'transfer'`).toHaveLength(4);
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${dep}`)[0].status).toBe('booked');
    // Not a sale: no income from either line.
    expect(await sql`SELECT 1 FROM transactions WHERE business_id = ${h.bid} AND type = 'income' AND source = 'bank_sheet'`).toHaveLength(0);
    expect((await acc.post(`${base}/bank-rows/${dep}/reopen`, {})).status).toBe(200);
    expect(await sql`SELECT 1 FROM transactions WHERE business_id = ${h.bid} AND type = 'transfer'`).toHaveLength(2);
    expect((await acc.get(`${base}/shifts/2026-10-31/cash`)).json.depositedPaise).toBe(0);
  });

  it('makes a bill unpaid again when its matched payment is reversed', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:00', 'UPI', '500']]);
    await h.register([{ no: '2610311', amount: '500', pays: [['upi', '500']] }]);
    const { ids: [cr] } = await h.lines([['31 19:02', 500, 'CR', 'UPI/800000001/Paid/guest1@okaxis/SAMPLE BANK/ICIa']]);
    await h.decideRest();
    await h.confirm();
    const tx = async () => (await sql`SELECT matched_bank_row, match_status FROM transactions WHERE bill_no = '2610311' AND type = 'income'`)[0];
    expect((await tx()).matched_bank_row).toBe(cr);
    const { ids: [rev] } = await h.lines([['31 19:30', 500, 'DR', 'UPI/RVSL800000001/Rev/guest1@okaxis/SAMPLE BANK/ICIa']]);
    const base = `/businesses/${h.bid}`;
    const acc = h.clients.accountant;
    // Waiting shows it as needing a look until it is dealt with.
    const w = (await acc.get(`${base}/waiting`)).json;
    const look = (w.look ?? w.items ?? []).find((x: any) => x.reversalId === rev);
    expect(look, JSON.stringify(w).slice(0, 400)).toBeTruthy();
    expect((await h.clients.entry_staff.post(`${base}/bank-rows/${rev}/reversed-unpaid`, {})).status).toBe(403);
    expect((await acc.post(`${base}/bank-rows/${rev}/reversed-unpaid`, {})).status).toBe(200);
    expect(await tx()).toEqual({ matched_bank_row: null, match_status: 'awaiting_bank_match' });
    expect((await sql`SELECT status FROM bank_rows WHERE id IN (${cr}, ${rev})`).map((r: any) => r.status)).toEqual(['ignored', 'ignored']);
  });

  it('matches a credit in the other account as written, keeping the register column', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.account('HUF B', 'UPI BANK 2');
    await h.software([['2610311', '31 19:00', 'UPI', '640']]);
    await h.register([{ no: '2610311', amount: '640', pays: [['upi', '640']] }]);
    const [cr] = await h.credits([['31 19:03', 640]], 'HUF B');
    const v = await h.view();
    const hint = (v.json.columnHints ?? []).find((x: any) => x.billNo === '2610311');
    expect(hint, JSON.stringify(v.json.columnHints)).toBeTruthy();
    const base = `/businesses/${h.bid}`;
    // Before saving: chosen on the tray's endpoint, matched on save; the column stays.
    expect((await h.clients.accountant.post(`${base}/shifts/2026-10-31/choices`, { bankRowId: cr, comparisonIds: [bill(v, '2610311').id] })).status).toBe(200);
    await h.confirm();
    expect((await sql`SELECT matched_bank_row FROM transactions WHERE bill_no = '2610311' AND type = 'income'`)[0].matched_bank_row).toBe(cr);
    expect((await sql`SELECT column_label FROM register_payments WHERE register_row_id = ${h.rows['2610311']}`)[0].column_label).toBe('UPI XOXO');
  });

  it('offers a credit within ₹10 of one side as a tip or a discount', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:00', 'UPI', '1200'], ['2610312', '31 20:00', 'UPI', '1200']]);
    await h.register([{ no: '2610311', amount: '1150', pays: [['upi', '1150']] }, { no: '2610312', amount: '1150', pays: [['upi', '1150']] }]);
    const [a, b] = await h.credits([['31 19:04', 1156], ['31 20:03', 1195]]);
    const v = await h.view();
    expect(bill(v, '2610311').bankNear).toMatchObject({ creditId: a, amountPaise: 115600 });
    expect(bill(v, '2610312').bankNear).toMatchObject({ creditId: b, amountPaise: 119500 });
    // Not counted as a credit with no bill.
    expect(v.json.bank.noBill.map((x: any) => x.id)).not.toContain(a);
    const base = `/businesses/${h.bid}`;
    const acc = h.clients.accountant;
    // What the buttons do: the register's payment becomes the credit (a ₹6 tip on the register's bill) …
    const reg = async (no: string) => (await acc.get(`${base}/uploads/${(await sql`SELECT upload_id FROM register_rows WHERE id = ${h.rows[no]}`)[0].upload_id}`)).json.rows.find((r: any) => r.id === h.rows[no]);
    const put = async (no: string, amount: string, discount: string, pay: string) => {
      const r = await reg(no);
      const res = await h.clients.entry_staff.put(`${base}/register-rows/${r.id}`, { billNo: r.billNo, billType: r.billType, amount, discount, status: r.status, remarks: r.remarks,
        paidWithRowId: null, payments: [{ mode: 'upi', columnLabel: 'UPI XOXO', amount: pay }] });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    };
    await put('2610311', '1150', '-6', '1156');
    // … or the software's bill with a ₹5 discount.
    await put('2610312', '1200', '5', '1195');
    const v2 = await h.view();
    expect(bill(v2, '2610311').bank).toMatchObject({ creditId: a, suggest: 'use_register' });
    if (bill(v2, '2610311').difference !== 'match') expect((await acc.put(`${base}/comparisons/${bill(v2, '2610311').id}`, { decision: 'use_register', note: 'tip' })).status).toBe(200);
    if (bill(v2, '2610312').difference !== 'match') expect((await acc.put(`${base}/comparisons/${bill(v2, '2610312').id}`, { decision: 'use_software', note: 'discount' })).status).toBe(200);
    await h.decideRest();
    await h.confirm();
    const m = await sql`SELECT bill_no, matched_bank_row, amount_paise FROM transactions WHERE bill_no IN ('2610311', '2610312') AND type = 'income' ORDER BY bill_no`;
    expect(m.map((x: any) => [x.bill_no, x.matched_bank_row])).toEqual([['2610311', a], ['2610312', b]]);
  });

  it('lets the card machine back an amount difference and the card part of a split payment', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'CARD', '900'], ['2610312', '31 20:00', 'CASH', '1000']]);
    await h.register([{ no: '2610311', amount: '950', pays: [['card', '950']] }, { no: '2610312', amount: '1000', pays: [['cash', '400'], ['card', '600']] }]);
    await h.swipe('31 19:02', 900);
    await h.swipe('31 20:01', 600);
    const v = await h.view();
    expect(bill(v, '2610311').machine).toMatchObject({ suggest: 'use_software', amountPaise: 90000 });
    expect(bill(v, '2610312').machine).toMatchObject({ suggest: 'use_register', amountPaise: 60000 });
  });
});
