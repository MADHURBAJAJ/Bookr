// A bill paid in several goes whose credits a person ticks (25 Nov 2026, from bill 26112453: a room bill closed at
// 11:04 pm, paid ₹1,800 + ₹580 by UPI about ten hours earlier, too far for Bookr to pair by time). Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, matchedTo, statusOf } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('a bill paid in parts, its credits ticked', () => {
  it('is matched on save whatever the time gap, told under On save, and can be undone', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610453', '31 23:04', 'UPI', '2380']]);
    await h.register([{ no: '2610453', amount: '2380', pays: [['upi', '1800'], ['upi', '580']] }]);
    const [big, small, stray] = await h.credits([['31 12:24', 1800], ['31 12:32', 580], ['31 13:00', 500]]);
    const day = '2026-10-31';
    const cmp = (await o.get(`/businesses/${h.bid}/shifts/${day}`)).json.comparisons.find((c: { billNo: string }) => c.billNo === '2610453');
    const rec = async () => (await o.get(`/businesses/${h.bid}/shifts/${day}/reconcile`)).json;

    // Ten hours before the bill: Bookr does not pair them by itself.
    expect((await rec()).open.credits.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([big, small]));

    // A credit that is not one of the row's UPI payments is refused.
    const bad = await o.post(`/businesses/${h.bid}/shifts/${day}/bill-parts`, { comparisonId: cmp.id, creditIds: [big, stray] });
    expect(bad.status).toBe(409);

    const chose = await o.post(`/businesses/${h.bid}/shifts/${day}/bill-parts`, { comparisonId: cmp.id, creditIds: [big, small] });
    expect(chose.status).toBe(200);
    let r = await rec();
    expect(r.open.credits.map((c: { id: string }) => c.id)).not.toContain(big);
    const plan = r.fixes.find((k: { key: string }) => k.key === `bill-parts-plan:${cmp.id}`);
    expect(plan.title).toBe('Bill 2610453 will join the credits ₹1,800.00 + ₹580.00');

    // Undo puts them back; choosing again is the same choice.
    expect((await o.post(`/businesses/${h.bid}/bill-parts/${chose.json.auditId}/undo`, {})).status).toBe(200);
    r = await rec();
    expect(r.fixes.some((k: { key: string }) => k.key.startsWith('bill-parts-plan:'))).toBe(false);
    expect(r.open.credits.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([big, small]));
    expect((await o.post(`/businesses/${h.bid}/shifts/${day}/bill-parts`, { comparisonId: cmp.id, creditIds: [small, big] })).status).toBe(200);

    await h.confirm();
    expect(await matchedTo(big)).toEqual(['2610453']);
    expect(await matchedTo(small)).toEqual(['2610453']);
    expect(await statusOf(stray)).toBe('unmatched');
  });
});
