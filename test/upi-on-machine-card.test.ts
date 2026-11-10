// UPI on the card machine for card bills (approved 11 Nov 2026): the money comes in the card settlement like a swipe, so
// it pays a card bill (matched on save like a swipe) when no UPI bill of its amount is waiting near it; a card bill is
// tried before a cash bill; a near amount is a check, never a match; a UPI bill paid on the machine can be matched to it
// before saving. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('UPI on the card machine', () => {
  it('pays a card bill like a swipe, before a cash bill, and not when a UPI bill of its amount waits near it', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 16:56', 'CARD', '200'], ['2610312', '31 16:13', 'CASH', '200'], ['2610313', '31 18:44', 'CARD', '368'],
      ['2610314', '31 16:40', 'CARD', '32'], ['2610315', '31 16:42', 'UPI', '32']]);
    await h.register([{ no: '2610311', amount: '200', pays: [['card', '200']] }, { no: '2610312', amount: '200', pays: [['cash', '200']] },
      { no: '2610313', amount: '368', pays: [['card', '368']] }, { no: '2610314', amount: '32', pays: [['card', '32']] }, { no: '2610315', amount: '32', pays: [['upi', '32']] }]);
    const p200 = await h.swipe('31 16:54', 200, 'UPI');
    const p385 = await h.swipe('31 18:41', 385, 'UPI');
    const p32 = await h.swipe('31 16:44', 32, 'UPI');
    await h.swipe('31 23:30', 999); // the card report covers the shift
    const k = (await h.reconcile()).cards;
    // ₹200: matched to the card bill on save, not offered to the cash bill 41 min away.
    expect(k.matches[(await h.view()).json.comparisons.find((x: any) => x.billNo === '2610311').id]).toMatchObject({ paymentId: p200, how: 'auto' });
    expect(k.needs.find((n: any) => n.payment.id === p200)).toBeUndefined();
    // ₹32: a UPI bill of ₹32 waits near it, so the card bill does not take it.
    expect(Object.values(k.matches).some((m: any) => m.paymentId === p32)).toBe(false);
    // ₹368 card bill: the ₹385 at 6:41 pm is told as a check, not matched; it can be ticked in the tray.
    const ns = k.noSwipe.find((x: any) => x.billNo === '2610313');
    expect(ns.near).toMatchObject({ paymentId: p385, amountPaise: 38500, minutes: 3 });
    expect(k.open.payments.map((x: any) => x.id)).toContain(p385);
    expect(Object.values(k.matches).some((m: any) => m.paymentId === p385)).toBe(false);

    await h.decideRest();
    await h.confirm();
    const [m] = await sql`SELECT t.bill_no FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.settlement_id = ${p200}`;
    expect(m).toEqual({ bill_no: '2610311' });
    expect((await sql`SELECT payment_mode FROM transactions WHERE bill_no = '2610311' AND type = 'income'`)[0].payment_mode).toBe('card');
  });

  it('matches a UPI bill to UPI on the machine when chosen before saving, once', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 16:50', 'UPI', '210'], ['2610312', '31 16:52', 'CARD', '210']]);
    await h.register([{ no: '2610311', amount: '210', pays: [['upi', '210']] }, { no: '2610312', amount: '210', pays: [['card', '210']] }]);
    const pay = await h.swipe('31 16:48', 210, 'UPI');
    await h.swipe('31 23:30', 999);
    const r = await h.reconcile();
    const c = (await h.view()).json.comparisons;
    const upiBill = c.find((x: any) => x.billNo === '2610311');
    // The UPI bill waits near it: not given to the card bill.
    expect(Object.values(r.cards.matches).some((m: any) => m.paymentId === pay)).toBe(false);
    // Offered on the UPI tab: paid by UPI on the machine.
    expect(r.cards.upiOnMachine).toMatchObject([{ comparisonId: upiBill.id, paymentId: pay, minutes: 2 }]);
    const acc = h.clients.accountant;
    const ch = await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/card-choices`, { paymentId: pay, comparisonIds: [upiBill.id] });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    // Not to a bank credit as well.
    const [credit] = await h.credits([['31 16:51', 210]]);
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/choices`, { bankRowId: credit, comparisonIds: [upiBill.id] })).status).toBe(409);
    expect((await h.reconcile()).open.bills.map((x: any) => x.billNo)).not.toContain('2610311');
    await h.decideRest();
    await h.confirm();
    const rows = await sql`SELECT t.bill_no, t.payment_mode FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.settlement_id = ${pay}`;
    expect(rows).toEqual([{ bill_no: '2610311', payment_mode: 'upi' }]);
  });
});
