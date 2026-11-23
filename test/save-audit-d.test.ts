// Save audit D (14 Nov 2026): the cash of a shift before and after saving. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { cashOf, count, DAY, decide, saveChecked, type H } from './saveKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

async function expense(h: H, rupees: number, status: 'draft' | 'approved') {
  const cash = (await sql`SELECT id FROM accounts WHERE business_id = ${h.bid} AND kind = 'cash'`)[0].id;
  await sql`INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, narration, source, status, payment_mode, created_at)
    VALUES (${crypto.randomUUID()}, ${h.bid}, ${cash}, ${DAY}, ${rupees * 100}, 'expense', 'Vegetables', 'cash_photo', ${status}, 'cash', ${Date.now()})`;
}

describe('D14 the draft cash is the final cash', () => {
  it('across matched, decided, one-sided, grouped, complimentary and left-out bills, with opening and count', async () => {
    const h = await hotel();
    await h.software([
      ['2610441', '31 10:00', 'CASH', '1000'],                                    // match
      ['2610442', '31 10:10', 'CASH', '800'],                                     // amount: use software
      ['2610443', '31 10:20', 'UPI', '400'],                                      // mode: register says cash
      ['2610444', '31 10:30', 'CASH', '300'],                                     // software only, auto
      ['2610445', '31 10:40', 'CASH', '200'],                                     // software only, left out
      ['2610446', '31 10:50', 'CASH', '500'], ['2610447', '31 10:55', 'CASH', '250'], // group, cash + UPI
      ['2610448', '31 11:00', 'CASH', '0'],                                       // ₹0
      ['2610449', '31 11:10', 'U/N', '350'],                                      // U/N, cash in the register
    ]);
    await h.register([
      { no: '2610441', amount: '1000', pays: [['cash', '1000']] },
      { no: '2610442', amount: '750', pays: [['cash', '750']] },
      { no: '2610443', amount: '400', pays: [['cash', '400']] },
      { no: '2610446', amount: '500', pays: [['cash', '600'], ['upi', '150']] }, { no: '2610447', amount: '250', pays: [], paidWith: '2610446' },
      { no: '2610448', amount: '0', pays: [] },
      { no: '2610449', amount: '350', pays: [['cash', '350']] },
      { no: '26103150', amount: '120', pays: [['cash', '120']] },                 // register only, new POS number
    ]);
    await count(h, '2026-10-30', 2000);
    await count(h, DAY, 5000);
    await decide(h, '2610442', 'use_software');
    await decide(h, '2610443', 'use_register');
    await decide(h, '2610445', 'leave_out', { note: 'Cancelled in POS' });
    const before = await cashOf(h);
    // 1000 + 800 + 400 + 300 + 600 (group's cash) + 350 + 120 = 3,570
    expect(before.draft).toMatchObject({ cashSalesPaise: 357000, shouldBePaise: 557000, differencePaise: -57000 });
    const s = await saveChecked(h);
    expect(s.after).toMatchObject({ cashSalesPaise: 357000, shouldBePaise: 557000, differencePaise: -57000 });
  });
});

describe('D15 cash after the sales', () => {
  it('expenses waiting approval, cash deposited to the bank, a difference accepted and a shortage booked', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610451', '31 10:00', 'CASH', '1000'], ['2610452', '31 11:00', 'CASH', '500']]);
    await h.register([{ no: '2610451', amount: '1000', pays: [['cash', '1000']] }, { no: '2610452', amount: '500', pays: [['cash', '500']] }]);
    await count(h, '2026-10-30', 2000);
    await count(h, DAY, 2600);
    await expense(h, 300, 'approved');
    await expense(h, 200, 'draft');
    const { ids: [dep] } = await h.lines([['31 18:00', 400, 'CR', 'BY CASH DEPOSIT CDM 1234']]);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${dep}/cash-move`, { shiftDay: DAY })).status).toBe(200);
    const base = `/businesses/${h.bid}/shifts/${DAY}/cash`;
    // Nothing to accept or book before saving.
    expect((await h.clients.accountant.post(`${base}/accept`, { note: 'x' })).status).toBe(409);
    expect((await h.clients.owner.post(`${base}/shortage`, { note: 'x' })).status).toBe(409);
    const before = await cashOf(h);
    // 2000 + 1500 − 300 (approved; ₹200 waits) − 400 deposited = 2,800; counted 2,600.
    expect(before).toMatchObject({ expensesPaise: 30000, expensesWaiting: 1, depositedPaise: 40000 });
    // The day's expense lines, for the Expenses row of Cash page vs Bookr (24 Nov 2026).
    expect(before.expenseLines.map((x: { amountPaise: number; status: string }) => [x.amountPaise, x.status]).sort()).toEqual([[20000, 'draft'], [30000, 'approved']]);
    expect(before.draft).toEqual({ cashSalesPaise: 150000, shouldBePaise: 280000, differencePaise: -20000 });
    await saveChecked(h);
    expect(await cashOf(h)).toMatchObject({ shouldBePaise: 280000, differencePaise: -20000, settled: false });
    expect((await h.clients.accountant.post(`${base}/accept`, { note: 'Counted again tomorrow' })).status).toBe(200);
    expect(await cashOf(h)).toMatchObject({ differencePaise: -20000, settled: true, accepted: 'Counted again tomorrow' });
    // Owner or Accountant books a shortage (18 Nov 2026); once booked the cash agrees and it cannot be booked again.
    expect((await h.clients.entry_staff.post(`${base}/shortage`, { note: 'Short' })).status).toBe(403);
    expect((await h.clients.owner.post(`${base}/shortage`, { note: 'Short' })).json).toMatchObject({ ok: true, amountPaise: 20000 });
    expect(await cashOf(h)).toMatchObject({ shortagePaise: 20000, shouldBePaise: 260000, differencePaise: 0, settled: true });
    expect((await h.clients.owner.post(`${base}/shortage`, { note: 'Again' })).status).toBe(409);
  });
});

describe('D14 a complimentary bill with cash written in the register', () => {
  // BUG (minor, save audit 14 Nov 2026): the Cash tab says it agrees. Bill 2610453 is ₹500 cash on both sides and was
  // made complimentary, so nothing is counted, but the register says ₹500 reached the drawer. cashBills
  // (src/sales.ts, `differs`) compares only the software's cash with the register's cash, not with what is counted.
  it('is shown as differing on the Cash tab (₹500 in the register, nothing counted)', async () => {
    const h = await hotel();
    await h.software([['2610453', '31 10:00', 'CASH', '500']]);
    await h.register([{ no: '2610453', amount: '500', pays: [['cash', '500']] }]);
    const c = (await sql`SELECT id FROM bill_comparisons WHERE bill_no = '2610453'`)[0].id;
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/comparisons/${c}/complimentary`, { guestName: 'Mr Rao' })).status).toBe(200);
    const k = await cashOf(h);
    expect(k.bills.find((b: any) => b.billNo === '2610453')).toMatchObject({ state: 'complimentary', rgCashPaise: 50000, countedPaise: 0, differs: true });
  });
});
