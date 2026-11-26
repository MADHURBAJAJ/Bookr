// Day close without a drawer count (26 Nov 2026, a setting): the day closes with no count, as the automatic close does;
// the Daily check does not flag it as a missed count. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('day close with counting turned off', () => {
  it('closes without a count, needs no float or notes, and is not flagged as not counted', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    // Only a manager or owner changes it; a wrong value is refused.
    expect((await counter.call('PUT', `${B}/drawer/count-setting`, { on: false })).status).toBe(403);
    expect((await owner.call('PUT', `${B}/drawer/count-setting`, { on: 'no' })).status).toBe(400);
    await ok(owner.call('PUT', `${B}/drawer/count-setting`, { on: false }));
    expect((await ok(owner.get('/me'))).business.drawer_count).toBe(0);

    const b = await billed(s, [['Masala Chai', 2]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [b.bill.id], payments: [{ mode: 'cash', amount: String(b.bill.totalPaise / 100) }] }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    expect((await ok(owner.get(`${B}/shifts/${day}`))).drawerCount).toBe(false);
    const r = await ok(owner.post(`${B}/shifts/${day}/close`, {}));
    expect(r).toMatchObject({ ok: true, noCount: true });
    const dc = await ok(owner.get(`${B}/reports/daily-check?day=${day}`));
    expect(dc.shiftClose).toMatchObject({ countedAt: null, noCount: true });
    // Turned on again: the count is asked for, as before.
    await ok(owner.call('PUT', `${B}/drawer/count-setting`, { on: true }));
    expect((await ok(owner.get(`${B}/shifts/${day}`))).drawerCount).toBe(true);
  });
});
