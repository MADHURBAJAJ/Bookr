// A credit booked as an unbilled sale on a saved shift, whose bill is made in the next shift (an advance at check-in,
// billed at check-out): offered as one sale on the next shift before it is saved (11 Nov 2026). Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, log } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('an advance booked the day before its bill', () => {
  it('is offered as the same sale on the next shift', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    const base = `/businesses/${h.bid}`;
    await h.software([['2610311', '31 11:00', 'CASH', '500'], ['26110129', '1 08:54', 'UPI', '1950']], istToMs(2026, 11, 2, 7, 59, 59));
    await h.register([{ no: '2610311', amount: '500', pays: [['cash', '500']] }]);
    await h.decideRest();
    await h.confirm();
    const [cr] = await h.credits([['31 12:03', 1950]]);
    const acc = h.clients.accountant;
    expect((await acc.post(`${base}/bank-rows/book-many`, { items: [{ rowId: cr, billType: 'fnb' }] })).json.booked).toBe(1);

    await h.register([{ no: '26110129', amount: '1950', pays: [['upi', '1950']], day: '2026-11-01' }]);
    const r = await h.reconcile('2026-11-01');
    log('fixes', r.fixes?.map((c: any) => c.title));
    const card = r.fixes.find((c: any) => c.kind === 'same_sale');
    expect(card?.title).toMatch(/26110129/);
    // Before: the next shift is not saved, so booking on 31 Oct warns about it.
    expect((await h.reconcile()).nextShift).toEqual({ day: '2026-11-01', saved: false });

    // Same sale: chosen before saving, done on save. The sale is counted once, on the credit's day, matched to it.
    const a = card.actions[0];
    expect((await acc.post(a.path, a.body)).status).toBe(200);
    await h.decideRest('2026-11-01');
    await h.confirm('2026-11-01');
    const sales = await sql`SELECT bill_no, source, day, matched_bank_row FROM transactions WHERE business_id = ${h.bid} AND type = 'income' AND amount_paise = 195000`;
    expect(sales).toEqual([{ bill_no: '26110129', source: 'software_report', day: '2026-10-31', matched_bank_row: cr }]);
    expect((await h.reconcile()).nextShift).toEqual({ day: '2026-11-01', saved: true });
  });
});
