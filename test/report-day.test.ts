// Reports for one day (17 Nov 2026): a UPI bill with no credit is told with its amount and time, as on Reconcile, so the
// day view lists it as payment not received; the missed report says which day to open on. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Reports, one day', () => {
  it('tells a UPI bill with no credit with its amount and time, and the last day with bills', async () => {
    const h = await hotel();
    await h.software([['26103101', '31 13:01', 'UPI', '450'], ['26103102', '31 19:21', 'UPI', '2800']]);
    await h.register([
      { no: '26103101', amount: '450', pays: [['upi', '450']] },
      { no: '26103102', amount: '2800', pays: [['upi', '2800']] },
    ]);
    await h.account('HUF A', 'UPI XOXO');
    // A credit the next morning shows the bank covers the whole shift.
    await h.credits([['31 13:03', 450], ['01 09:30', 75]]);
    const rec = await h.reconcile();
    const none = rec.noCredit.filter((k: any) => k.kind === 'no_upi_credit');
    expect(none).toEqual([expect.objectContaining({ billNos: ['26103102'], amountPaise: 280000, paidAt: expect.any(Number) })]);
    const m = await h.clients.owner.get(`/businesses/${h.bid}/reports/missed?from=2026-10-31&to=2026-10-31`);
    expect(m.status).toBe(200);
    expect(m.json.lastDay).toBe('2026-10-31');
    // The page's first ask: only the day, nothing else worked out.
    expect((await h.clients.owner.get(`/businesses/${h.bid}/reports/missed?lastOnly=1`)).json).toEqual({ lastDay: '2026-10-31' });
  });
});
