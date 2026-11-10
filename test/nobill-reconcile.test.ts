// Money with no bill booked from Reconcile → Payments (approved 11 Nov 2026): listed before saving too, and booked
// before saving (one, or several ticked), without stopping the shift from being saved. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('money with no bill on Reconcile', () => {
  it('lists credits with no bill before saving and books them then', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:00', 'UPI', '500']]);
    await h.register([{ no: '2610311', amount: '500', pays: [['upi', '500']] }]);
    const [paid, a, b, c] = await h.credits([['31 19:02', 500], ['31 20:10', 333], ['31 21:15', 147], ['31 22:40', 1290]]);
    const r = await h.reconcile();
    expect(r.trial).toBe(true);
    expect(r.noBill.map((x: any) => x.creditId).sort()).toEqual([a, b, c].sort());
    expect(r.noBill.map((x: any) => x.creditId)).not.toContain(paid);

    const base = `/businesses/${h.bid}/bank-rows`;
    const acc = h.clients.accountant;
    // One row, with what it was.
    expect((await acc.post(`${base}/book-many`, { items: [{ rowId: a, billType: 'fnb', item: 'dinner, table 4' }] })).json).toMatchObject({ booked: 1 });
    // Two ticked together.
    expect((await acc.post(`${base}/book-many`, { items: [{ rowId: b, billType: 'fnb', item: null }, { rowId: c, billType: 'room', item: null }] })).json).toMatchObject({ booked: 2 });
    expect(await sql`SELECT narration FROM transactions WHERE business_id = ${h.bid} AND source = 'bank_sheet' ORDER BY amount_paise`).toEqual([
      { narration: expect.stringMatching(/F&B/) }, { narration: expect.stringMatching(/dinner, table 4/) }, { narration: expect.stringMatching(/Room/) }]);
    expect((await h.reconcile()).noBill).toEqual([]);

    // The shift still saves, and the bill matches its own credit.
    await h.decideRest();
    await h.confirm();
    expect((await sql`SELECT matched_bank_row FROM transactions WHERE bill_no = '2610311' AND type = 'income'`)[0].matched_bank_row).toBe(paid);
    expect((await sql`SELECT status FROM bank_rows WHERE id IN (${a}, ${b}, ${c})`).map((x: any) => x.status)).toEqual(['booked', 'booked', 'booked']);
    // Open again puts one back on the list (a saved shift lists it too).
    expect((await acc.post(`${base}/${a}/reopen`, {})).status).toBe(200);
    expect((await h.reconcile()).noBill.map((x: any) => x.creditId)).toEqual([a]);
  });
});
