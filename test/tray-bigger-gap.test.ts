// The tray, more than ₹10 apart (11 Nov 2026): never matched on its own; a person chooses a tip (or discount), or
// "Bill was ₹ X". For a bill not in the register the row is added that way and matched on save. A credit Reconcile
// said "could be" a bill that a person matched to another credit is told as extra. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('tray: more than ₹10 apart', () => {
  it('adds a bill not in the register with a ₹13 tip, or at the payment amount, and matches it on save', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 14:59', 'UPI', '283'], ['2610312', '31 16:00', 'UPI', '283']]);
    await h.register([]);
    const [tip, was] = await h.credits([['31 14:54', 296], ['31 16:05', 296]]);
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}`;
    const bill = async (no: string) => (await h.reconcile()).open.bills.find((x: any) => x.billNo === no);
    const b1 = await bill('2610311');
    // Without a person's choice: refused, as before.
    expect((await acc.post(`${base}/comparisons/${b1.id}/add-paid`, { mode: 'upi', sourceId: tip })).status).toBe(400);
    // ₹13 tip.
    const r1 = await acc.post(`${base}/comparisons/${b1.id}/add-paid`, { mode: 'upi', sourceId: tip, allowGap: true });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect((await sql`SELECT amount_paise, tip_paise FROM register_rows WHERE id = ${r1.json.rowId}`)[0]).toEqual({ amount_paise: 28300, tip_paise: 1300 });
    // Bill was ₹296: the row takes it and the bill is decided Use register.
    const b2 = await bill('2610312');
    const r2 = await acc.post(`${base}/comparisons/${b2.id}/add-paid`, { mode: 'upi', sourceId: was, allowGap: true, fix: true });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect((await sql`SELECT amount_paise, tip_paise, discount_paise FROM register_rows WHERE id = ${r2.json.rowId}`)[0]).toEqual({ amount_paise: 29600, tip_paise: 0, discount_paise: 0 });
    expect((await sql`SELECT difference, decision FROM bill_comparisons WHERE bill_no = '2610312'`)[0]).toEqual({ difference: 'amount', decision: 'use_register' });

    const cmps = (await h.view()).json.comparisons;
    for (const [credit, no] of [[tip, '2610311'], [was, '2610312']] as const) {
      const c = cmps.find((x: any) => x.billNo === no);
      const ch = await acc.post(`${base}/shifts/2026-10-31/choices`, { bankRowId: credit, comparisonIds: [c.id] });
      expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    }
    await h.decideRest();
    await h.confirm();
    const tx = await sql`SELECT bill_no, amount_paise, matched_bank_row FROM transactions WHERE type = 'income' AND bill_no IN ('2610311', '2610312') ORDER BY bill_no`;
    expect(tx.map((x: any) => x.matched_bank_row)).toEqual([tip, was]);
  });

  it('tells a credit as extra when the bill it "could be" was matched to another credit by a person', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 13:13', 'UPI', '30']]);
    await h.register([{ no: '2610311', amount: '30', pays: [['upi', '30']] }]);
    const [chosen, later] = await h.credits([['31 12:55', 30], ['31 21:12', 30]]);
    const c = (await h.view()).json.comparisons.find((x: any) => x.billNo === '2610311');
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/choices`, { bankRowId: chosen, comparisonIds: [c.id] })).status).toBe(200);
    const r = await h.reconcile();
    expect(r.open.credits.find((x: any) => x.id === later)).toMatchObject({ why: 'extra', bills: [] });
    expect(r.noBill.map((x: any) => x.creditId)).toContain(later);
  });
});
