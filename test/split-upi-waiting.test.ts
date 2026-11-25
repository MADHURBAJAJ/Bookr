// Booking a credit with no bill while the UPI part of a split cash + UPI bill of that amount waits (approved 24 Nov 2026,
// from bill 26110648: ₹966 = ₹500 cash + ₹466 UPI, its ₹466 credit booked as an unbilled sale). Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, matchedTo, statusOf } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('a split bill waiting for its UPI part', () => {
  it('is named before an unsaved shift\'s credit is booked; once saved it can be matched from the same check', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610391', '31 20:52', 'UPI', '966']]);
    await h.register([{ no: '2610391', amount: '966', pays: [['cash', '500'], ['upi', '466']] }]);
    const [early] = await h.credits([['31 20:49', 466]]);
    const book = (id: string, more = {}) => h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${id}/book`, { headId: h.fnb, note: 'Unbilled sale', ...more });

    // Not saved: the bill is named, with no sale to match yet; nothing is booked.
    const asked = (await book(early)).json;
    expect(asked.ok).toBe(false);
    expect(asked.gate.checks[0].bills).toEqual([{ billNo: '2610391', day: '2026-10-31', txId: null, billPaise: 96600, upiPaise: 46600 }]);
    expect(await statusOf(early)).toBe('unmatched');

    // A credit of another amount is not held up.
    const [other] = await h.credits([['31 21:30', 470]]);
    expect((await book(other)).json.ok).toBe(true);

    // Saved with the ₹466 credit away (it came in later): the UPI part waits as a sale, and the check offers it to match.
    await sql`DELETE FROM bank_rows WHERE id = ${early}`;
    await h.decideRest('2026-10-31', () => 'use_register');
    await h.confirm();
    const [late] = await h.credits([['31 20:50', 466]]);
    const again = (await book(late)).json;
    const bills = again.gate.checks[0].bills;
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({ billNo: '2610391', billPaise: 96600, upiPaise: 46600 });
    expect(bills[0].txId).toBeTruthy();
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${late}/match`, { transactionIds: [bills[0].txId] })).status).toBe(200);
    expect(await matchedTo(late)).toEqual(['2610391']);
  });
});
