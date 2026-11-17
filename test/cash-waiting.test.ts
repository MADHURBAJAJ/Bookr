// A cash bill not in the register (18 Nov 2026): it waits 2 days for its late register line, then counts as payment not
// received; an Accountant may book just that bill as a cash shortage, which closes it; if its cash comes in later, the
// over day offers to reverse the shortage. Today counts it in the same groups as To do. Invented data only.
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

describe('a cash bill not in the register', () => {
  it('is not received after 2 days, is booked as a shortage by an Accountant, and the shortage is reversed when the cash comes', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'CASH', '50'], ['2610313', '31 21:00', 'CASH', '100'], ['2611011', '1 10:00', 'CASH', '200']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610313', amount: '100', pays: [['cash', '100']] }, { no: '2611011', amount: '200', pays: [['cash', '200']], day: '2026-11-01' }]);
    await h.decideRest();
    await h.confirm();
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1100); // should be 1,150: ₹50 short, the bill not in the register
    const acc = h.clients.accountant;
    const look = async () => (await acc.get(`/businesses/${h.bid}/waiting`)).json.look.find((x: any) => x.billNo === '2610311');

    // Weeks old with no late line: not received, on Waiting and in Today's groups.
    expect(await look()).toMatchObject({ kind: 'not_received', unresolved: true });
    const home = (await h.clients.owner.get(`/businesses/${h.bid}/home`)).json;
    expect(home.waitingBills.kinds.not_received).toEqual({ n: 1, paise: 5000, days: ['2026-10-31'] });
    // Kept waiting by a person: back inside its watch.
    const cmp = (await look()).comparisonId;
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${cmp}/keep-waiting`, { note: 'cashier says tomorrow' })).status).toBe(200);
    expect(await look()).toMatchObject({ kind: 'cash_wait' });

    // Booked as a shortage for that bill only: Entry staff may not; the Accountant may.
    const short = (b: Record<string, unknown>, c = acc) => c.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/shortage`, b);
    expect((await short({ note: 'x', comparisonId: cmp }, h.clients.entry_staff)).status).toBe(403);
    const res = await short({ note: 'Cashier to repay', comparisonId: cmp });
    expect(res.json).toEqual({ ok: true, amountPaise: 5000 });
    const [t] = await sql`SELECT id, narration, ocr_original FROM transactions WHERE source = 'cash_shortage'`;
    expect(t.narration).toBe('Cash shortage, 2026-10-31 shift: bill 2610311 not received · Cashier to repay');
    expect(JSON.parse(t.ocr_original)).toEqual({ comparisonId: cmp, billNo: '2610311' });
    expect((await sql`SELECT close_note FROM bill_comparisons WHERE id = ${cmp}`)[0].close_note).toBe('Cash shortage booked: Cashier to repay');
    expect(await look()).toBeUndefined();
    expect((await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json).toMatchObject({ differencePaise: 0, settled: true,
      shortages: [{ id: t.id, amountPaise: 5000, comparisonId: cmp, billNo: '2610311', note: expect.any(String) }] });
    const m = (await h.clients.owner.get(`/businesses/${h.bid}/reports/missed?from=2026-10-31&to=2026-10-31`)).json;
    expect(m.shortages).toEqual([{ day: '2026-10-31', amountPaise: 5000, billNo: '2610311', note: 'Cashier to repay' }]);

    // The cash comes in on 1 Nov: that day is over by ₹50, and offers to reverse the shortage.
    await h.view('2026-11-01');
    await h.decideRest('2026-11-01');
    await h.confirm('2026-11-01');
    await count(h.bid, '2026-11-01', 1350); // should be 1,300
    const k1 = (await acc.get(`/businesses/${h.bid}/shifts/2026-11-01/cash`)).json;
    expect(k1.differencePaise).toBe(5000);
    expect(k1.reverse).toEqual({ id: t.id, day: '2026-10-31', amountPaise: 5000, billNo: '2610311' });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/cash-shortages/${t.id}/reverse`, {})).status).toBe(403);
    expect((await acc.post(`/businesses/${h.bid}/cash-shortages/${t.id}/reverse`, { note: 'came on 1 Nov' })).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE source = 'cash_shortage'`)[0].n).toBe(0);
    expect((await sql`SELECT close_note FROM bill_comparisons WHERE id = ${cmp}`)[0].close_note).toBeNull();
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'cash.shortage_reversed'`)[0].n).toBe(1);
    // Now the two days pair up as paid late.
    expect((await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json.pair).toMatchObject({ day: '2026-11-01', amountPaise: 5000 });
  });
});
