// Stage 3 (not written in the register) and Stage 4 (missing in the software), approved 10 Nov 2026: a short cash count is
// explained by the cash bills the register does not have; a short day next to an over day by the same amount is settled
// as paid late; a late register line is linked to its sale day and counted once; a misread number is suggested; a bill
// never billed in the software is closed as such and counted on the dashboard. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const count = async (bid: string, day: string, rupees: number) => {
  // Each summary needs its own upload: borrow one not used yet (invented data, the photo does not matter here).
  const [u] = await sql`SELECT id FROM uploads WHERE business_id = ${bid} AND id NOT IN (SELECT upload_id FROM cash_summaries) LIMIT 1`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${u.id}, ${day}, ${rupees * 100}, 'approved', ${Date.now()})`;
};

describe('cash: shortage explained, and paid late', () => {
  it('explains a short count by the bills not in the register, then settles the short and over days together', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'CASH', '50'], ['2610312', '31 20:00', 'CASH', '30'], ['2610313', '31 21:00', 'CASH', '100'],
      ['2611011', '1 10:00', 'CASH', '200']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610313', amount: '100', pays: [['cash', '100']] }, { no: '2611011', amount: '200', pays: [['cash', '200']], day: '2026-11-01' }]);
    await h.decideRest();
    await h.confirm();
    await h.view('2026-11-01');
    await h.decideRest('2026-11-01');
    await h.confirm('2026-11-01');
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1120); // should be 1,180: ₹60 short
    await count(h.bid, '2026-11-01', 1380); // should be 1,320: ₹60 over

    const acc = h.clients.accountant;
    const k = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    expect(k.differencePaise).toBe(-6000);
    expect(k.explained).toEqual({ explainedPaise: 6000, unexplainedPaise: 0, bills: [
      expect.objectContaining({ billNo: '2610311', partPaise: 5000 }), expect.objectContaining({ billNo: '2610312', amountPaise: 3000, partPaise: 1000 })] });
    expect(k.pair).toMatchObject({ day: '2026-11-01', shortDay: '2026-10-31', overDay: '2026-11-01', amountPaise: 6000 });
    expect((await acc.get(`/businesses/${h.bid}/shifts/2026-11-01/cash`)).json.pair).toMatchObject({ day: '2026-10-31' });

    // The same bills on Waiting, one entry each, telling their part of the shortage.
    const look = (await acc.get(`/businesses/${h.bid}/waiting`)).json.look;
    expect(look.find((x: any) => x.billNo === '2610311').reason).toMatch(/explains ₹ 50\.00 of the ₹ 60\.00 short/);

    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/pair`, { otherDay: '2026-11-01' })).status).toBe(403);
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/pair`, { otherDay: '2026-10-30' })).status).toBe(409);
    const ok = await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/pair`, { otherDay: '2026-11-01' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    for (const d of ['2026-10-31', '2026-11-01']) {
      const x = (await acc.get(`/businesses/${h.bid}/shifts/${d}/cash`)).json;
      expect(x).toMatchObject({ settled: true, pair: null });
      expect(x.accepted).toMatch(/^Paid late/);
    }
    // Settled: the cash bills stop waiting.
    expect((await acc.get(`/businesses/${h.bid}/waiting`)).json.look.map((x: any) => x.billNo)).not.toContain('2610311');
  });
});

describe('late lines, misreads, and bills not billed in the software', () => {
  it('links a late register line, suggests a misread, and counts bills closed as not billed', async () => {
    const h = await hotel();
    await h.software([['2610321', '31 19:00', 'UPI', '104'], ['2610331', '31 20:00', 'CASH', '75'], ['2610313', '31 21:00', 'CASH', '30'],
      ['2611042', '1 10:00', 'CASH', '60']]);
    await h.register([{ no: '2610313', amount: '30', pays: [['cash', '30']] }, { no: '2610353', amount: '75', pays: [['cash', '75']] },
      { no: '2611041', amount: '60', pays: [['cash', '60']] }, { no: '2610319', amount: '45', pays: [['cash', '45']] },
      { no: '2610321', amount: '110', pays: [['upi', '110']], day: '2026-11-01' }]);
    const v31 = (await h.view()).json;
    const late = (await h.view('2026-11-01')).json.comparisons.find((c: any) => c.billNo === '2610321');
    // Counted on the sale day; the late line is linked to it and not counted again.
    expect(late).toMatchObject({ difference: 'missing_in_software', decision: 'leave_out', note: 'Already counted on 2026-10-31' });
    const sale = (await h.view()).json.comparisons.find((c: any) => c.billNo === '2610321');
    expect(sale.confirmedBy).toEqual({ day: '2026-11-01', amountPaise: 11000, mode: 'upi' });

    // Misread: two digits off on the same shift, one digit off on the next shift's report; same amount.
    const flags = (no: string) => v31.comparisons.find((c: any) => c.billNo === no).numberFlags;
    expect(flags('2610353')).toContainEqual(expect.objectContaining({ kind: 'pending_typo', billNo: '2610331', sameShift: true }));
    expect(flags('2611041')).toContainEqual(expect.objectContaining({ kind: 'pending_typo', billNo: '2611042', day: '2026-11-01' }));

    // A register-only bill, past its watch: closed as not billed in the software, counted on the dashboard.
    await h.decideRest();
    await h.confirm();
    const acc = h.clients.accountant;
    const reg = (await acc.get(`/businesses/${h.bid}/waiting`)).json.look.find((x: any) => x.billNo === '2610319');
    expect(reg).toMatchObject({ side: 'register', unresolved: true });
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${reg.comparisonId}/close`, { note: 'Not billed in software' })).status).toBe(200);
    expect((await acc.get(`/businesses/${h.bid}/home`)).json.waitingBills.notBilled).toBe(1);
  });
});
