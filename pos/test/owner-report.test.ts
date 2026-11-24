// The Daily check sent to the owner each morning (25 Nov 2026): the listener asks for a one-time link with its key; the
// link shows that one shift, read-only, and stops working when it expires or is changed. Key and data are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { billed, dispose, env, setupBusiness } from './helpers';

afterAll(dispose);
const KEY = 'test-report-key-not-a-secret-0123456789';
const call = (method: string, path: string, body?: unknown) => app.request(`/api${path}`, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }, env);

describe('owner report link', () => {
  it('gives a signed link for the last closed shift with the right key only, and the link shows that shift', async () => {
    const s = await setupBusiness();
    (env as Record<string, unknown>).REPORT_KEYS = JSON.stringify({ [s.businessId]: KEY });
    await billed(s, [['Masala Chai', 2]]);
    expect((await call('POST', '/report/link', { businessId: s.businessId, key: 'wrong-key-wrong-key-wrong-key' })).status).toBe(403);
    expect((await call('POST', '/report/link', { businessId: crypto.randomUUID(), key: KEY })).status).toBe(403);

    const today = (await s.ok(s.owner.get('/me'))).business.shiftDay;
    const r = await call('POST', '/report/link', { businessId: s.businessId, key: KEY, day: today });
    expect(r.status).toBe(200);
    const link = await r.json() as { url: string; day: string; caption: string };
    // Today's shift is not closed: asking for it gives the last closed one, yesterday.
    expect(link.day < today).toBe(true);
    expect(link.caption).toMatch(/^Sample Hotel · Daily check .*\nNet sales ₹/);
    const [bid, day, exp, sig] = decodeURIComponent(link.url.split('#')[1]).split('.');
    expect([bid, day]).toEqual([s.businessId, link.day]);
    const q = (x: Record<string, string>) => `/report/data?${new URLSearchParams(x)}`;
    const data = await call('GET', q({ b: bid, d: day, e: exp, s: sig }));
    expect(data.status).toBe(200);
    expect(await data.json()).toMatchObject({ business: 'Sample Hotel', d: { day: link.day }, events: [] });

    // Changed in any part, or expired: refused.
    expect((await call('GET', q({ b: bid, d: today, e: exp, s: sig }))).status).toBe(403);
    expect((await call('GET', q({ b: bid, d: day, e: String(Number(exp) + 1), s: sig }))).status).toBe(403);
    expect((await call('GET', q({ b: bid, d: day, e: exp, s: sig.slice(0, -2) + 'AA' }))).status).toBe(403);
    expect((await call('GET', q({ b: bid, d: day, e: '1000', s: sig }))).status).toBe(403);
  });
});
