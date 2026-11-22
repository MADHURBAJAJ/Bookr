// Payments that failed and came back, and ₹1 UPI ID tests (approved 23 Nov 2026): left out by Bookr, both lines of a
// pair together; a line a person reopens stays theirs. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Failed payments and ₹1 tests', () => {
  it('leaves out the failed payment with its return and the ₹1 test, not the payment that went through', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    const { ids } = await h.lines([
      ['31 15:34', 1, 'DR', 'UPI/810000000001/UPI Pay/vendor1@icici//ICIa'],
      ['31 15:35', 2800, 'DR', 'UPI/810000000002/UPI Pay/vendor1@icici//ICIb'],
      ['31 15:35', 2800, 'CR', 'UPI/RVSL810000000002/UPI Pay/vendor1@icici//ICIb'],
      ['31 15:40', 2800, 'DR', 'UPI/810000000003/vendorpay/vendor2@okaxis//ICIc'],
    ]);
    const st = async () => (await sql`SELECT id, status, note FROM bank_rows WHERE business_id = ${h.bid}`).reduce((o: any, r: any) => ({ ...o, [r.id]: r }), {});
    let s = await st();
    expect(ids.map((id) => s[id].status)).toEqual(['ignored', 'ignored', 'ignored', 'unmatched']);
    expect(s[ids[0]].note).toMatch(/UPI ID test of ₹1/);
    expect(s[ids[1]].note).toBe('Payment reversed');

    // A person reopens the test line: Bookr leaves it to them, also when the Funds flow runs the rules again.
    const re = await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${ids[0]}/reopen`, {});
    expect(re.status, JSON.stringify(re.json)).toBe(200);
    // Lines from before the rule: open again with no person's reopen, the Funds flow leaves them out.
    await sql`UPDATE bank_rows SET status = 'unmatched', note = NULL WHERE id = ${ids[1]} OR id = ${ids[2]}`;
    const f = await h.clients.owner.get(`/businesses/${h.bid}/reports/funds-flow?from=2026-10-31&to=2026-10-31`);
    expect(f.status).toBe(200);
    s = await st();
    expect(ids.map((id) => s[id].status)).toEqual(['unmatched', 'ignored', 'ignored', 'unmatched']);
  });
});
