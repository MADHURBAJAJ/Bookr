// A register number the software has for another amount (11 Nov 2026): page 7 row 3 reads 26103158 ₹283 (tip ₹13),
// the software's 26103158 is ₹145 and its 26103157 ₹283 is not in the register. Bookr suggests 26103157 and does not
// offer the software's ₹145. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('a number one digit off a bill of the same amount', () => {
  it('is suggested on register review and on Reconcile', async () => {
    const h = await hotel();
    await h.software([['26103158', '31 13:00', 'UPI', '145'], ['26103157', '31 14:59', 'UPI', '283']]);
    await h.account('HUF A', 'UPI XOXO');
    await h.credits([['31 14:54', 296]]);
    await h.register([{ no: '26103158', amount: '145', pays: [['upi', '145']] }, { no: '26103158', amount: '283', discount: '-13', pays: [['upi', '296']] }]);
    const [{ upload_id: page }] = await sql`SELECT upload_id FROM register_rows WHERE business_id = ${h.bid} LIMIT 1`;
    const u = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    const [right, slip] = [...u.rows].sort((a: any, b: any) => a.lineNo - b.lineNo);
    expect(right.numberFlags).toEqual([]);
    expect(slip.numberFlags).toEqual([expect.objectContaining({ kind: 'pending_typo', billNo: '26103157', amountPaise: 28300 })]);
    expect(slip.hint).toBeNull();
    expect(slip.slipBank).toMatchObject({ amountPaise: 29600 });

    // Reconcile keeps one line of a repeated number; the blocker names the slip.
    const v = (await h.view()).json;
    expect(v.blockers.join(' ')).toContain('The ₹ 283 line of 26103158 is probably bill 26103157');
    expect(v.numberSlips).toEqual([expect.objectContaining({ writtenAs: '26103158', billNo: '26103157', amountPaise: 28300, paidPaise: 29600 })]);
    // The UPI tab tells it under the bill and the credit.
    expect((await h.reconcile()).numberSlips).toEqual([expect.objectContaining({ billNo: '26103157', paidPaise: 29600 })]);
  });

  it('says nothing when no bill of the amount is waiting', async () => {
    const h = await hotel();
    await h.software([['26103158', '31 13:00', 'UPI', '145'], ['26103157', '31 14:59', 'UPI', '300']]);
    await h.register([{ no: '26103158', amount: '283', pays: [['upi', '283']] }]);
    const [{ upload_id: page }] = await sql`SELECT upload_id FROM register_rows WHERE business_id = ${h.bid} LIMIT 1`;
    const u = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    expect(u.rows[0].numberFlags).toEqual([]);
  });
});
