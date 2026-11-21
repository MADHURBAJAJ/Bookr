// UPI on the card machine near a UPI bill the bank already paid (21 Nov 2026): it is another sale, money with no bill,
// not the bill's payment and not "paid twice". Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('UPI on the machine near a UPI bill the bank paid', () => {
  it('is money with no bill', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 15:39', 'UPI', '32']]);
    await h.register([{ no: '2610311', amount: '32', pays: [['upi', '32']] }]);
    await h.credits([['31 15:37', 32]]);
    const machine = await h.swipe('31 16:02', 32, 'UPI', { payMode: 'UPI' });
    const r = await h.reconcile();
    const n = r.cards.needs.find((x: any) => x.payment.id === machine);
    expect(n).toMatchObject({ why: 'no_bill', written: null });
    expect(r.cards.onUpiTab.find((x: any) => x.id === machine)?.billNo ?? null).toBeNull();
  });
});
