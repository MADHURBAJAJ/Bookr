// The tray by tick order (Stage 1, approved 10 Nov 2026): a bill only in the software report that a credit or a card
// payment paid is added to the register (with the tip or discount) and matched; the shifts either side list their open
// credits and payments. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('tray: a bill not in the register, paid by the bank or the card machine', () => {
  it('adds the register row with the tip, matches it on save, undoes, and lists the shifts either side', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:18', 'UPI', '104'], ['2610312', '31 20:00', 'CARD', '455'], ['2610313', '31 21:00', 'UPI', '300'], ['2610315', '1 07:59', 'CASH', '1']]);
    await h.register([{ no: '2610315', amount: '1', pays: [['cash', '1']] }]);
    const [c110, cFar, cNext] = await h.credits([['31 19:16', 110], ['31 19:30', 150], ['1 09:30', 300]]);
    const swipe = await h.swipe('31 20:02', 460);
    await h.swipe('1 09:00', 1);
    const r = await h.reconcile();
    const bill = (no: string) => r.open.bills.find((x: any) => x.billNo === no) ?? r.cards.open.bills.find((x: any) => x.billNo === no);
    expect(bill('2610311')).toMatchObject({ amountPaise: 10400, rowId: null });
    const acc = h.clients.accountant;
    const add = (id: string, x: object) => acc.post(`/businesses/${h.bid}/comparisons/${id}/add-paid`, x);

    // Entry staff cannot; more than ₹10 apart is refused.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/comparisons/${bill('2610311').id}/add-paid`, { mode: 'upi', sourceId: c110 })).status).toBe(403);
    expect((await add(bill('2610311').id, { mode: 'upi', sourceId: cFar })).status).toBe(400);

    const ok = await add(bill('2610311').id, { mode: 'upi', sourceId: c110 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const [row] = await sql`SELECT amount_paise, tip_paise, discount_paise, status, remarks FROM register_rows WHERE id = ${ok.json.rowId}`;
    expect(row).toMatchObject({ amount_paise: 10400, tip_paise: 600, discount_paise: 0, status: 'checked' });
    expect(row.remarks).toMatch(/Added from software report: Paid by UPI.*₹ 6 tip/);
    const [pay] = await sql`SELECT mode, amount_paise FROM register_payments WHERE register_row_id = ${ok.json.rowId}`;
    expect(pay).toMatchObject({ mode: 'upi', amount_paise: 11000 });
    const [cmp] = await sql`SELECT difference, register_row_id FROM bill_comparisons WHERE bill_no = '2610311'`;
    expect(cmp).toMatchObject({ difference: 'match', register_row_id: ok.json.rowId });
    // It now has a register row: not again.
    expect((await add(bill('2610311').id, { mode: 'upi', sourceId: c110 })).status).toBe(400);

    // Undo (delete the line), then add again.
    expect((await acc.del(`/businesses/${h.bid}/register-rows/${ok.json.rowId}`)).status).toBe(200);
    expect((await sql`SELECT difference FROM bill_comparisons WHERE bill_no = '2610311'`)[0].difference).toBe('missing_in_register');
    const again = await add(bill('2610311').id, { mode: 'upi', sourceId: c110 });
    expect(again.status).toBe(200);

    // A card bill not in the register, swiped ₹5 more.
    const card = await add(bill('2610312').id, { mode: 'card', sourceId: swipe });
    expect(card.status, JSON.stringify(card.json)).toBe(200);
    expect((await sql`SELECT tip_paise FROM register_rows WHERE id = ${card.json.rowId}`)[0].tip_paise).toBe(500);
    const cardCmp = (await sql`SELECT id FROM bill_comparisons WHERE bill_no = '2610312'`)[0].id;
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/card-choices`, { paymentId: swipe, comparisonIds: [cardCmp] })).status).toBe(200);

    // The shifts either side: the ₹300 credit at 9:30 am is the next shift's, open there.
    const near = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/nearby`)).json;
    expect(near.credits.map((x: any) => [x.id, x.shiftDay])).toContainEqual([cNext, '2026-11-01']);
    expect(near.credits.map((x: any) => x.id)).not.toContain(c110);
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/nearby`)).status).toBe(403);
    // A bill here may take it: chosen on this shift, matched on save.
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/choices`, { bankRowId: cNext, comparisonIds: [bill('2610313').id] })).status).toBe(200);
    expect((await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/nearby`)).json.credits.map((x: any) => x.id)).not.toContain(cNext);

    await h.confirm();
    const matched = await sql`SELECT bill_no, matched_bank_row FROM transactions WHERE business_id = ${h.bid} AND bill_no IN ('2610311', '2610313') AND type = 'income' ORDER BY bill_no`;
    expect(matched.map((m: any) => m.matched_bank_row)).toEqual([c110, cNext]);
    const cm = await sql`SELECT t.bill_no FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.settlement_id = ${swipe}`;
    expect(cm.map((x: any) => x.bill_no)).toEqual(['2610312']);
  });
});
