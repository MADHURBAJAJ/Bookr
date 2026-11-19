// Cash short explained by bills the register doesn't show as cash, left short on its day and changed on the day its
// payment came (18 Nov 2026): a ₹1,634 cash bill written next day as card and paid with a next-day bill on the card
// machine; ₹209 and ₹83 cash bills the register wrote as UPI, the ₹210 credit being another bill's. Invented data only.
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

describe('a short count the register does not show as cash', () => {
  it('names every bill, leaves the credit to its own bill, and is changed on the later day with the booked shortage', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610501', '31 12:00', 'CASH', '1634'], ['2610502', '31 23:30', 'CASH', '209'], ['2610503', '1 01:18', 'UPI', '210'],
      ['2610504', '31 14:00', 'CASH', '83'], ['2610505', '31 13:00', 'CASH', '100'], ['2611503', '1 14:50', 'CARD', '501'], ['2611504', '2 07:59', 'CASH', '1']],
      istToMs(2026, 11, 2, 23, 59, 59));
    await h.register([
      { no: '2610502', amount: '210', pays: [['upi', '210']] }, { no: '2610503', amount: '210', pays: [['upi', '210']] },
      { no: '2610504', amount: '83', pays: [['upi', '83']] }, { no: '2610505', amount: '100', pays: [['cash', '100']] },
      { no: '2610501', amount: '1634', pays: [['card', '1634']], day: '2026-11-01' }, { no: '2611503', amount: '501', pays: [['card', '501']], day: '2026-11-01' },
      { no: '2611504', amount: '1', pays: [['cash', '1']], day: '2026-11-01' },
    ]);
    await h.credits([['1 01:19', 210], ['2 09:00', 1]]);
    const pay = await h.swipe('1 15:02', 2135, 'MASTER');
    await h.swipe('2 09:00', 1);
    const acc = h.clients.accountant;
    const cash = async (d = '2026-10-31') => (await acc.get(`/businesses/${h.bid}/shifts/${d}/cash`)).json;

    // The ₹210 credit is 2610503's (billed a minute before it), not 2610502's; 2610504 has none.
    const k0 = await cash();
    const w = (no: string) => k0.bills.find((b: any) => b.billNo === no).witness;
    expect(w('2610502')).toMatchObject({ mode: 'upi', amountPaise: 21000, found: null, takenBy: { billNo: '2610503' } });
    expect(w('2610504')).toMatchObject({ mode: 'upi', amountPaise: 8300, found: null });
    expect(w('2610504').takenBy).toBeUndefined();
    // Left short on its day: no paid-later evidence needed to wait.
    await h.decideRest('2026-10-31', (c) => (['2610502', '2610504', '2610501'].includes(c.billNo) ? 'use_software' : undefined));
    await h.confirm();
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1100); // should be 3,026: 1,634 + 209 + 83 never reached the drawer
    const k = await cash();
    expect(k.differencePaise).toBe(-192600);
    expect(k.registerNotCash.map((x: any) => [x.billNo, x.rgMode, x.amountPaise]).sort()).toEqual([['2610502', 'upi', 20900], ['2610504', 'upi', 8300]]);
    expect(k.explained).toMatchObject({ explainedPaise: 192600, unexplainedPaise: 0 });
    expect(k.explained.bills.map((b: any) => b.billNo).sort()).toEqual(['2610501', '2610502', '2610504']);

    // The next day: told on its Cash tab, the earlier short named, never carried in.
    const n = await cash('2026-11-01');
    expect(n.previous).toMatchObject({ day: '2026-10-31', differencePaise: -192600 });
    expect(n.paidHere).toEqual([{ billNo: '2610501', amountPaise: 163400, fromDay: '2026-10-31', mode: 'card' }]);

    // A shortage booked in full on 31 Oct; then 1 Nov's Card tab offers the change with the payment and the shortage.
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/shortage`, { note: 'counted short' })).status).toBe(200);
    const pl = (await h.reconcile('2026-11-01')).paidLater.find((x: any) => x.billNo === '2610501');
    expect(pl).toMatchObject({ fromDay: '2026-10-31', rowMode: 'card', evidence: { id: pay, amountPaise: 213500, with: [{ billNo: '2611503', amountPaise: 50100 }] },
      fromCash: { differencePaise: 0, shortagePaise: 192600 } });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [pl.txId], mode: 'card', note: 'x', reduceShortage: true })).status).toBe(403);
    const res = await acc.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [pl.txId], mode: 'card', note: 'Settled the next day', reduceShortage: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const shortage = async () => (await sql`SELECT amount_paise FROM transactions WHERE business_id = ${h.bid} AND source = 'cash_shortage'`).map((x: any) => x.amount_paise);
    expect(await shortage()).toEqual([29200]);
    const k2 = await cash();
    expect(k2.differencePaise).toBe(0);
    expect(k2.changedLater).toMatchObject([{ bills: ['2610501'], amountPaise: 163400, from: 'cash', mode: 'card', paidOn: '2026-11-01', shortage: { fromPaise: 192600, toPaise: 29200 } }]);
    // Undo puts the sale and the shortage back.
    expect((await acc.post(`/businesses/${h.bid}/sales/repay/${res.json.auditId}/undo`, {})).status).toBe(200);
    expect(await shortage()).toEqual([192600]);
    expect((await cash()).changedLater).toEqual([]);
  });

});
