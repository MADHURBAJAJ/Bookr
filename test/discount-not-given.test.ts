// The bank got the bill before its discount (14 Nov 2026): told before saving, with "Paid in full" removing the
// discount so the credit is matched on save. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('discount not given', () => {
  it('a credit equal to the bill before its discount is a card; Paid in full makes it match on save', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610321', '31 22:03', 'UPI', '32']]);
    await h.register([{ no: '2610321', amount: '32', discount: '2', pays: [['upi', '30']] }]);
    const [credit] = await h.credits([['31 22:00', 32]]);
    await h.credits([['1 07:59', 1]]); // the bank covers the shift
    const r = await h.reconcile();
    const card = r.fixes.find((c: any) => c.kind === 'discount_not_given');
    expect(card.title).toMatch(/Bill 2610321: the bank got ₹32.00, the register says ₹30.00 after a ₹2.00 discount/);
    expect(card.actions[0]).toMatchObject({ label: 'Paid in full ₹32.00', op: 'noDiscount' });

    // Paid in full, as the screen does it: the discount goes and the payment is the whole bill.
    const row = (await sql`SELECT id, upload_id FROM register_rows WHERE bill_no = '2610321'`)[0];
    const res = await h.clients.accountant.put(`/businesses/${h.bid}/register-rows/${row.id}`, { billNo: '2610321', billType: 'fnb', amount: '32', discount: '0', status: 'checked',
      payments: [{ mode: 'upi', columnLabel: 'UPI XOXO', amount: '32' }] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await h.reconcile()).fixes.find((c: any) => c.kind === 'discount_not_given')).toBeUndefined();
    await h.decideRest();
    await h.confirm();
    expect((await sql`SELECT amount_paise, matched_bank_row FROM transactions WHERE bill_no = '2610321' AND type = 'income'`)[0]).toEqual({ amount_paise: 3200, matched_bank_row: credit });
  });
});
