// Payment tables (10 Nov 2026): a ₹0 bill in a group is complimentary, not "to decide"; cash paid beside the UPI part of
// a group's payment is not a discount. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('bills paid together on the payment tabs', () => {
  it('a ₹0 bill is complimentary with nothing to decide, and the group counts every mode of its payment', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 12:00', 'CASH', '250'], ['2610312', '1 07:59', 'CASH', '1']]);
    await h.register([
      { no: '2610311', amount: '250', pays: [['cash', '250']] },
      { no: '145230', amount: '385', discount: '385', pays: [['cash', '2000'], ['upi', '8000']] },
      { no: '145231', amount: '4000', pays: [], paidWith: '145230' },
      { no: '145232', amount: '6000', pays: [], paidWith: '145230' },
      { no: '2610312', amount: '1', pays: [['cash', '1']] },
    ]);
    const v = await h.view();
    const zero = v.json.comparisons.find((c: any) => c.billNo === '145230');
    expect(zero.difference).toBe('complimentary');
    // Money is written on its row: To do shows it as a check (approved 10 Nov 2026).
    expect(zero.register.paidPaise).toBe(1000000);
    for (const no of ['145231', '145232']) {
      const c = v.json.comparisons.find((x: any) => x.billNo === no);
      expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids: [c.id], note: 'Old POS bill' })).json.decided).toBe(1);
    }
    const ent = await h.entries();
    const upi = ent.upi.entries.filter((e: any) => e.group);
    expect(upi.map((e: any) => e.billNo).sort()).toEqual(['145230', '145231', '145232']);
    expect(upi.every((e: any) => e.state !== 'decide')).toBe(true);
    expect(upi[0].group).toMatchObject({ paymentPaise: 800000, paidPaise: 1000000, billsPaise: 1000000, otherModes: [{ mode: 'cash', paise: 200000 }] });
    const z = upi.find((e: any) => e.billNo === '145230');
    // The paying row comes to ₹0 under the group's discount: told so, not as complimentary (10 Nov 2026).
    expect(z.edits.map((x: any) => x.text)).toEqual(["Amount ₹0 after the group's discount of ₹385: paid with bills 145231, 145232"]);
  });
});
