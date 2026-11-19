// Several reads in one request (19 Nov 2026). Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb, Client } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('combined reads', () => {
  it('answers each part as its own request, with its own role check', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610501', '31 12:00', 'UPI', '450']], istToMs(2026, 11, 1, 23, 59, 59));
    await h.register([{ no: '2610501', amount: '450', pays: [['upi', '450']] }]);
    await h.credits([['31 12:01', 450]]);
    const parts = [`/businesses/${h.bid}/shifts/2026-10-31/reconcile`, `/businesses/${h.bid}/shifts/2026-10-31/cash`, `/businesses/${h.bid}/shifts/2026-10-31`];
    const q = parts.map((p) => `p=${encodeURIComponent(p)}`).join('&');
    const o = h.clients.owner;
    const many = await o.get(`/many?${q}`);
    expect(many.status).toBe(200);
    // The same answers as asking one by one.
    for (const [i, p] of parts.entries()) {
      const one = await o.get(p);
      expect(many.json.results[i]).toEqual({ status: one.status, body: one.json });
    }
    // Entry staff: the bank part is refused, the parts they may read are answered.
    const es = (await h.clients.entry_staff.get(`/many?${q}`)).json.results.map((x: any) => x.status);
    expect(es[0]).toBe(403);
    // Not signed in, another place, or too many: refused.
    expect((await new Client().get(`/many?${q}`)).status).toBe(401);
    expect((await o.get(`/many?p=${encodeURIComponent('/me')}`)).status).toBe(400);
    expect((await o.get(`/many?p=${encodeURIComponent(`/businesses/${h.bid}/../me`)}`)).status).toBe(400);
    expect((await o.get(`/many?${Array(13).fill(`p=${encodeURIComponent(parts[2])}`).join('&')}`)).status).toBe(400);
    // Another business's part: refused by that part's own check.
    const other = crypto.randomUUID();
    expect((await o.get(`/many?p=${encodeURIComponent(`/businesses/${other}/shifts/2026-10-31`)}`)).json.results[0].status).toBeGreaterThanOrEqual(403);
  });
});
