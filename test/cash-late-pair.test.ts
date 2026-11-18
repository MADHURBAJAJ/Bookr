// A cash bill written late in a later day's register (18 Nov 2026): it is paid, so the Cash tab and To do tell it as
// written late, not as payment not received; the short day and the day the cash went into are settled together, even
// two days apart and ₹5 apart (a ₹50 bill written as ₹45). Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const count = async (bid: string, day: string, rupees: number) => {
  const [u] = await sql`SELECT id FROM uploads WHERE business_id = ${bid} AND id NOT IN (SELECT upload_id FROM cash_summaries) LIMIT 1`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${u.id}, ${day}, ${rupees * 100}, 'approved', ${Date.now()})`;
};

describe('a cash bill written late', () => {
  it('is told as written late, and the two days settle together with the ₹5 gap in the note', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'CASH', '50'], ['2610313', '31 21:00', 'CASH', '100'], ['2611011', '1 10:00', 'CASH', '200'], ['2611021', '2 10:00', 'CASH', '200']],
      istToMs(2026, 11, 3, 8, 0, 0));
    await h.register([{ no: '2610313', amount: '100', pays: [['cash', '100']] }, { no: '2611011', amount: '200', pays: [['cash', '200']], day: '2026-11-01' },
      { no: '2611021', amount: '200', pays: [['cash', '200']], day: '2026-11-02' }, { no: '2610311', amount: '45', pays: [['cash', '45']], day: '2026-11-02' }]);
    for (const d of ['2026-10-31', '2026-11-01', '2026-11-02']) { await h.view(d); await h.decideRest(d); await h.confirm(d); }
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1100); // should be 1,150: the ₹50 bill's cash did not reach this count
    await count(h.bid, '2026-11-01', 1300);
    await count(h.bid, '2026-11-02', 1545); // should be 1,500: the ₹45 written late came in here
    const acc = h.clients.accountant;
    const k = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    expect(k.differencePaise).toBe(-5000);
    expect(k.notInRegister.find((x: any) => x.billNo === '2610311').late).toEqual({ day: '2026-11-02', amountPaise: 4500, mode: 'cash' });
    expect(k.pair).toMatchObject({ day: '2026-11-02', shortDay: '2026-10-31', overDay: '2026-11-02', amountPaise: 5000, gapPaise: 500 });
    expect((await acc.get(`/businesses/${h.bid}/shifts/2026-11-02/cash`)).json.pair).toMatchObject({ day: '2026-10-31', gapPaise: 500 });
    const res = await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/pair`, { otherDay: '2026-11-02' });
    expect(res.json.note).toBe('Paid late: ₹ 50 short on 2026-10-31, ₹ 45 over on 2026-11-02 (₹ 5 differs)');
    for (const d of ['2026-10-31', '2026-11-02']) expect((await acc.get(`/businesses/${h.bid}/shifts/${d}/cash`)).json).toMatchObject({ settled: true, pair: null });
  });
});
