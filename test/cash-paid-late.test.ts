// An earlier day's cash bill paid in cash on a later day (approved 20 Nov 2026): the later day's register writes it, its
// cash is in that drawer. "Paid here in cash" counts it there and takes it off the earlier day's drawer; the sale stays on
// its own day, and Undo puts it back. The cash page is set beside Bookr. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const count = async (bid: string, day: string, rupees: number, page?: { received: number; expenses: number; opening: number }) => {
  const [u] = await sql`SELECT id FROM uploads WHERE business_id = ${bid} AND id NOT IN (SELECT upload_id FROM cash_summaries) LIMIT 1`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, opening_paise, received_paise, expenses_paise, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${u.id}, ${day}, ${page ? page.opening * 100 : null}, ${page ? page.received * 100 : null}, ${page ? page.expenses * 100 : null}, ${rupees * 100}, 'approved', ${Date.now()})`;
};

describe('an earlier bill paid here in cash', () => {
  it('is counted in the later drawer, explains the earlier one, and can be undone', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'CASH', '50'], ['2610313', '31 21:00', 'CASH', '100'], ['2611011', '1 10:00', 'CASH', '200']],
      istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610313', amount: '100', pays: [['cash', '100']] }, { no: '2611011', amount: '200', pays: [['cash', '200']], day: '2026-11-01' },
      { no: '2610311', amount: '45', pays: [['cash', '45']], day: '2026-11-01' }]);
    for (const d of ['2026-10-31', '2026-11-01']) { await h.view(d); await h.decideRest(d, (c: any) => (c.billNo === '2610311' && d === '2026-11-01' ? 'leave_out' : undefined)); }
    await h.confirm('2026-10-31');
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1100); // should be 1,150: the ₹50 bill's cash did not reach this drawer
    await count(h.bid, '2026-11-01', 1345, { opening: 1100, received: 245, expenses: 0 }); // the ₹45 came in here
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}`;
    let nov = (await acc.get(`${base}/shifts/2026-11-01/cash`)).json;
    expect(nov.draft.differencePaise).toBe(4500);
    expect(nov.page).toEqual({ openingPaise: 110000, receivedPaise: 24500, expensesPaise: 0, cashInHandPaise: 134500 });
    expect(nov.registerCashPaise).toBe(24500);
    expect(nov.lateOffers).toEqual([expect.objectContaining({ billNo: '2610311', fromDay: '2026-10-31', amountPaise: 4500, swAmountPaise: 5000 })]);

    const res = await acc.post(`${base}/shifts/2026-11-01/cash/paid-late`, { comparisonId: nov.lateOffers[0].comparisonId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    nov = (await acc.get(`${base}/shifts/2026-11-01/cash`)).json;
    expect(nov.draft.differencePaise).toBe(0);
    expect(nov.lateOffers).toEqual([]);
    expect(nov.lateIn).toEqual([expect.objectContaining({ billNo: '2610311', amountPaise: 4500 })]);
    const oct = (await acc.get(`${base}/shifts/2026-10-31/cash`)).json;
    expect(oct.differencePaise).toBe(-500); // ₹50 billed, ₹45 paid
    expect(oct.notInRegister.find((x: any) => x.billNo === '2610311').cashLate).toMatchObject({ day: '2026-11-01', amountPaise: 4500 });
    expect(oct.explained.bills.map((b: any) => b.billNo)).not.toContain('2610311');
    // The sale stays on 31 Oct, counted once.
    expect((await sql`SELECT shift_day FROM transactions WHERE bill_no = '2610311' AND type = 'income'`).map((x: any) => x.shift_day)).toEqual(['2026-10-31']);
    // A second press is refused; Undo puts both days back.
    expect((await acc.post(`${base}/shifts/2026-11-01/cash/paid-late`, { comparisonId: nov.lateIn[0].comparisonId })).status).toBe(409);
    expect((await acc.post(`${base}/cash/paid-late/${res.json.auditId}/undo`, {})).status).toBe(200);
    expect((await acc.get(`${base}/shifts/2026-11-01/cash`)).json.draft.differencePaise).toBe(4500);
    expect((await acc.get(`${base}/shifts/2026-10-31/cash`)).json.differencePaise).toBe(-5000);
    expect((await acc.post(`${base}/cash/paid-late/${res.json.auditId}/undo`, {})).status).toBe(404);
  });
});
