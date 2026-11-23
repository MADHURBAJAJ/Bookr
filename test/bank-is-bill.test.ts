// Bank = the bill, not the register (approved 24 Nov 2026). A bill whose register says a ₹4 tip was received (bill ₹104,
// received ₹108), paid ₹104 by UPI, among other ₹104 bills. Before saving it showed as matched and saving then dropped
// the match quietly. Now: it is open before saving with a card that sets the register to the bank, and after saving the
// same card matches and corrects the register. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

async function setUp() {
  const h = await hotel();
  await h.account('HUF A', 'UPI XOXO');
  await h.software([['2610311', '31 12:56', 'UPI', '104'], ['2610312', '31 15:29', 'UPI', '104'], ['2610313', '31 21:36', 'UPI', '104'], ['2610314', '31 21:37', 'UPI', '104']]);
  await h.register([{ no: '2610312', amount: '104', pays: [['upi', '104']] }, { no: '2610313', amount: '104', pays: [['upi', '104']] }, { no: '2610314', amount: '104', pays: [['upi', '104']] }]);
  const [tipCredit] = await h.credits([['31 12:52', 104], ['31 15:29', 104], ['31 21:36', 104], ['31 21:37', 104], ['1 07:55', 1]]);
  await h.register([{ no: '2610311', amount: '104', discount: '-4', pays: [['upi', '108']] }]);
  return { h, tipCredit };
}
const upiSales = (bid: string) => sql`SELECT bill_no, amount_paise, matched_bank_row FROM transactions WHERE business_id = ${bid} AND payment_mode = 'upi' ORDER BY bill_no`;

describe('Bank = the bill, not the register', () => {
  it('before saving: open with a card, not shown as matched; Match sets the register and saving matches all four', async () => {
    const { h, tipCredit } = await setUp();
    const r = await h.reconcile();
    expect(r.clear.map((x: any) => x.billNos[0]).sort()).toEqual(['2610312', '2610313', '2610314']);
    expect(r.strip).toMatchObject({ billsLeft: 1, billsLeftPaise: 10800 });
    const card = r.noCredit.find((c: any) => c.kind === 'bank_is_bill');
    expect(card).toMatchObject({ billNos: ['2610311'], look: { billPaise: 10400, receivedPaise: 10800, creditPaise: 10400, minutes: 4, tipPaise: 400 } });
    expect(card.uses).toContain(`cr:${tipCredit}`);
    expect(r.noCredit.some((c: any) => c.kind === 'no_upi_credit' && c.billNos.includes('2610311'))).toBe(false);
    const act = card.actions[0];
    expect(act).toMatchObject({ op: 'noDiscount', label: 'Match · register → ₹104', rowId: h.rows['2610311'] });
    // What the button does on the page: the discount goes and the one payment is the bill's amount.
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/register-rows/${act.rowId}`, { billNo: '2610311', billType: 'fnb', amount: '104', discount: '0', status: 'checked',
      payments: [{ mode: 'upi', amount: '104', columnLabel: 'UPI XOXO' }] })).status).toBe(200);
    expect((await h.reconcile()).clear.length).toBe(4);
    await h.confirm();
    expect((await upiSales(h.bid)).map((x: any) => [x.bill_no, x.amount_paise, !!x.matched_bank_row])).toEqual([
      ['2610311', 10400, true], ['2610312', 10400, true], ['2610313', 10400, true], ['2610314', 10400, true]]);
  });

  it('after saving as written: a card matches the credit and corrects the register', async () => {
    const { h, tipCredit } = await setUp();
    await h.confirm();
    expect((await upiSales(h.bid)).find((x: any) => x.bill_no === '2610311')).toMatchObject({ amount_paise: 10800, matched_bank_row: null });
    const r = await h.reconcile();
    // The explainer's "payment written as ₹108 instead of ₹104" card already covers a saved shift.
    const card = r.fixes.find((c: any) => c.billNos.includes('2610311') && c.uses.includes(`cr:${tipCredit}`));
    expect(card.actions[0]).toMatchObject({ method: 'POST', body: { pairs: [{ rowId: tipCredit, adjust: true }] } });
    expect(r.noCredit.some((c: any) => c.billNos.includes('2610311'))).toBe(false);
    const act = card.actions[0];
    expect((await h.clients.accountant.post(act.path, act.body)).json).toMatchObject({ matched: 1 });
    expect((await upiSales(h.bid)).find((x: any) => x.bill_no === '2610311')).toMatchObject({ amount_paise: 10400, matched_bank_row: tipCredit });
  });
});
