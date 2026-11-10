// The multi-pair tray (approved 10 Nov 2026): several credit ↔ bill pairs matched on save in one go, each its own
// choice so Undo works one pair at a time; one bad pair stops them all. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('several pairs matched on save at once', () => {
  it('checks every pair first, saves them together, and undoes them one by one', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 09:00', 'UPI', '510'], ['2610312', '31 09:30', 'UPI', '520'], ['2610313', '1 07:59', 'CASH', '1']]);
    await h.register([
      { no: '2610311', amount: '510', pays: [['upi', '510']] },
      { no: '2610312', amount: '520', pays: [['upi', '520']] },
      { no: '2610313', amount: '1', pays: [['cash', '1']] },
    ]);
    // Credits 11 hours after their bills: too far to pair on their own.
    const [a, b, odd] = await h.credits([['31 20:00', 510], ['31 20:30', 520], ['31 21:00', 999]]);
    const r = await h.reconcile();
    const bill = (no: string) => r.open.bills.find((x: any) => x.billNo === no).id;
    expect(r.open.credits.map((c: any) => c.id)).toEqual(expect.arrayContaining([a, b, odd]));
    const url = `/businesses/${h.bid}/shifts/2026-10-31/choices`;
    const acc = h.clients.accountant;
    const count = async () => (await sql`SELECT count(*) AS n FROM shift_choices WHERE business_id = ${h.bid}`)[0].n;

    expect((await h.clients.entry_staff.post(url, { pairs: [{ bankRowId: a, comparisonIds: [bill('2610311')] }] })).status).toBe(403);
    // The same credit or bill twice, or one pair that does not add up: nothing is saved.
    expect((await acc.post(url, { pairs: [{ bankRowId: a, comparisonIds: [bill('2610311')] }, { bankRowId: a, comparisonIds: [bill('2610312')] }] })).status).toBe(409);
    expect((await acc.post(url, { pairs: [{ bankRowId: a, comparisonIds: [bill('2610311')] }, { bankRowId: b, comparisonIds: [bill('2610311')] }] })).status).toBe(409);
    const bad = await acc.post(url, { pairs: [{ bankRowId: a, comparisonIds: [bill('2610311')] }, { bankRowId: odd, comparisonIds: [bill('2610312')] }] });
    expect(bad.status).toBe(409);
    expect(bad.json.error).toMatch(/2610312/);
    expect(await count()).toBe(0);

    const ok = await acc.post(url, { pairs: [{ bankRowId: a, comparisonIds: [bill('2610311')] }, { bankRowId: b, comparisonIds: [bill('2610312')] }] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.ids).toHaveLength(2);
    expect((await h.reconcile()).choices.map((k: any) => k.billNos[0]).sort()).toEqual(['2610311', '2610312']);
    // A pair already held cannot be chosen again.
    expect((await acc.post(url, { pairs: [{ bankRowId: a, comparisonIds: [bill('2610311')] }] })).status).toBe(409);

    // Undo one pair; the other stays.
    expect((await acc.del(`${url}/${ok.json.ids[1]}`)).status).toBe(200);
    expect(await count()).toBe(1);
    // The single form still works.
    expect((await acc.post(url, { bankRowId: b, comparisonIds: [bill('2610312')] })).status).toBe(200);

    await h.confirm();
    const matched = await sql`SELECT bill_no, matched_bank_row FROM transactions WHERE business_id = ${h.bid} AND bill_no IN ('2610311', '2610312') AND type = 'income' ORDER BY bill_no`;
    expect(matched.map((m: any) => m.matched_bank_row)).toEqual([a, b]);
    expect(await count()).toBe(0);
  });
});
