// One list of choices made before saving (approved 25 Nov 2026): a credit is held by one plan only, whatever its kind,
// and saving the shift removes all its plans. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, matchedTo } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('one list of plans', () => {
  it('a credit ticked for a bill paid in parts cannot also pay another bill, and the reverse; saving clears the list', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610453', '31 23:04', 'UPI', '2380'], ['2610454', '31 12:40', 'UPI', '580']]);
    await h.register([{ no: '2610453', amount: '2380', pays: [['upi', '1800'], ['upi', '580']] }, { no: '2610454', amount: '580', pays: [['upi', '580']] }]);
    const [big, small] = await h.credits([['31 12:24', 1800], ['31 12:32', 580]]);
    const day = '2026-10-31';
    const comps = (await o.get(`/businesses/${h.bid}/shifts/${day}`)).json.comparisons as { id: string; billNo: string }[];
    const parts = comps.find((c) => c.billNo === '2610453')!;
    const single = comps.find((c) => c.billNo === '2610454')!;
    const plans = async () => Number((await sql`SELECT count(*) AS n FROM shift_plans WHERE business_id = ${h.bid}`)[0].n);

    const ticked = await o.post(`/businesses/${h.bid}/shifts/${day}/bill-parts`, { comparisonId: parts.id, creditIds: [big, small] });
    expect(ticked.status).toBe(200);
    // The ₹580 credit is held: it cannot be matched on save to the other ₹580 bill.
    const clash = await o.post(`/businesses/${h.bid}/shifts/${day}/choices`, { bankRowId: small, comparisonIds: [single.id] });
    expect(clash.status).toBe(409);
    expect(clash.json.error).toMatch(/ticked for a bill paid in parts/);

    // The other way round: undo the parts, match the ₹580 to the single bill, then ticking it for the parts is refused.
    expect((await o.post(`/businesses/${h.bid}/bill-parts/${ticked.json.planId}/undo`, {})).status).toBe(200);
    expect(await plans()).toBe(0);
    expect((await o.post(`/businesses/${h.bid}/shifts/${day}/choices`, { bankRowId: small, comparisonIds: [single.id] })).status).toBe(200);
    const again = await o.post(`/businesses/${h.bid}/shifts/${day}/bill-parts`, { comparisonId: parts.id, creditIds: [big, small] });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/matched on save/);
    expect(await plans()).toBe(1);

    await h.confirm();
    expect(await matchedTo(small)).toEqual(['2610454']);
    expect(await plans()).toBe(0);
  });
});
