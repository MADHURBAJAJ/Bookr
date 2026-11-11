// Every machine payment can be found on the Card tab (11 Nov 2026): one a Check line names is in the tray to tick, and
// UPI on the machine left for a UPI bill is said on the Card tab with the bill. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('card tab lists every machine payment', () => {
  it('puts a checked payment in the tray and names UPI-tab payments', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 21:52', 'CARD', '95'], ['2610312', '31 22:15', 'CASH', '100'], ['2610313', '31 21:31', 'UPI', '104']]);
    await h.register([{ no: '2610311', amount: '95', pays: [['card', '95']] }, { no: '2610312', amount: '100', pays: [['cash', '100']] },
      { no: '2610313', amount: '104', pays: [['upi', '104']] }]);
    const p100 = await h.swipe('31 21:50', 100, 'UPI');
    const p104 = await h.swipe('31 21:31', 104, 'UPI');
    await h.swipe('31 23:30', 999); // the card report covers the shift
    const k = (await h.reconcile()).cards;
    // ₹100: a check on the ₹95 card bill and on the cash bill; it can be ticked in the tray.
    expect(k.noSwipe.find((x: any) => x.billNo === '2610311').near).toMatchObject({ paymentId: p100 });
    expect(k.open.payments.map((x: any) => x.id)).toContain(p100);
    // ₹104: for the UPI bill, on the UPI tab; the Card tab says so.
    expect(k.open.payments.map((x: any) => x.id)).not.toContain(p104);
    expect(k.onUpiTab).toEqual([expect.objectContaining({ id: p104, billNo: '2610313', offered: true })]);
    // What the machine got adds up: card bills, UPI bills, not matched yet (₹100 and the ₹999 with no bill).
    expect(k.strip.machine).toEqual({ cardPaise: 0, upiPaise: 10400, leftPaise: 109900 });
    expect(k.strip).toMatchObject({ noBillPaise: 109900, noBill: 2 });
    // Chosen for the UPI bill: tagged as a UPI bill, still counted under UPI bills.
    const upiBill = (await h.view()).json.comparisons.find((x: any) => x.billNo === '2610313');
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/card-choices`, { paymentId: p104, comparisonIds: [upiBill.id] })).status).toBe(200);
    const k2 = (await h.reconcile()).cards;
    expect(k2.choices).toEqual([expect.objectContaining({ paymentId: p104, upiBill: true })]);
    expect(k2.strip.machine).toEqual({ cardPaise: 0, upiPaise: 10400, leftPaise: 109900 });
  });
});
