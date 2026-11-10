// The Card tab before saving (approved 10 Nov 2026): what Save would match, a match chosen now and made on Save, and
// what is left. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('card machine payments before saving a shift', () => {
  it('shows the safe match, takes a chosen one, and makes both on Save', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 12:00', 'CARD', '500'], ['2610312', '31 14:00', 'CARD', '700'], ['2610313', '31 14:10', 'CARD', '700'],
      ['2610314', '31 16:00', 'CASH', '900'], ['2610315', '1 07:59', 'CASH', '1']]);
    await h.register([
      { no: '2610311', amount: '500', pays: [['card', '500']] },
      { no: '2610312', amount: '700', pays: [['card', '700']] },
      { no: '2610313', amount: '700', pays: [['card', '700']] },
      { no: '2610314', amount: '900', pays: [['cash', '900']] },
      { no: '2610315', amount: '1', pays: [['cash', '1']] },
    ]);
    // Before the card report is in, the card bills wait for it and count as left (approved 10 Nov 2026).
    const early = (await h.reconcile()).cards;
    expect(early).toMatchObject({ covered: false, waitingReport: 3, left: 3 });
    const safe = await h.swipe('31 12:05', 500);
    const two = await h.swipe('31 14:30', 700);
    const cashOnMachine = await h.swipe('31 16:10', 900);
    await h.swipe('1 09:00', 1); // the report runs past the shift

    const k = (await h.reconcile()).cards;
    expect(k.trial).toBe(true);
    expect(k).toMatchObject({ covered: true, waitingReport: 0 });
    const v = await h.view();
    const cmp = (no: string) => v.json.comparisons.find((c: any) => c.billNo === no).id;
    expect(k.matches[cmp('2610311')]).toMatchObject({ paymentId: safe, how: 'auto' });
    const need = (id: string) => k.needs.find((n: any) => n.payment.id === id);
    expect(need(two).why).toBe('several');
    expect(need(two).candidates.map((x: any) => x.billNos[0]).sort()).toEqual(['2610312', '2610313']);
    expect(need(cashOnMachine)).toMatchObject({ why: 'written', written: { billNo: '2610314', mode: 'cash', minutes: 10 } });
    expect(k.strip).toMatchObject({ bills: 3, billsPaise: 190000, would: 1, wouldPaise: 50000 });
    // The Card table's Money received shows the payment before saving.
    const ent = await h.entries();
    expect(ent.card.entries.find((e: any) => e.billNo === '2610311').evidence).toMatch(/Bookr matches on save/);

    const B = `/businesses/${h.bid}/shifts/2026-10-31/card-choices`;
    // Entry staff cannot choose; the amount must be what the bills take by card.
    expect((await h.clients.entry_staff.post(B, { paymentId: two, comparisonIds: [cmp('2610313')] })).status).toBe(403);
    expect((await h.clients.accountant.post(B, { paymentId: two, comparisonIds: [cmp('2610311')] })).status).toBe(409);
    const ok = await h.clients.accountant.post(B, { paymentId: two, comparisonIds: [cmp('2610313')] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await h.clients.accountant.post(B, { paymentId: two, comparisonIds: [cmp('2610312')] })).status).toBe(409);

    const k2 = (await h.reconcile()).cards;
    expect(k2.matches[cmp('2610313')]).toMatchObject({ paymentId: two, how: 'chosen' });
    expect(k2.choices).toHaveLength(1);
    expect(k2.noSwipe.map((x: any) => x.billNo)).toEqual(['2610312']);
    expect((await h.entries()).card.entries.find((e: any) => e.billNo === '2610313').evidence).toMatch(/chosen, matched on save/);

    // Undo, then choose again: Undo removes the choice.
    expect((await h.clients.accountant.del(`/businesses/${h.bid}/shifts/2026-10-31/choices/${ok.json.id}`)).status).toBe(200);
    expect((await h.reconcile()).cards.choices).toHaveLength(0);
    expect((await h.clients.accountant.post(B, { paymentId: two, comparisonIds: [cmp('2610313')] })).status).toBe(200);

    await h.confirm();
    const matchOf = async (pid: string) => (await sql`SELECT t.bill_no FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.settlement_id = ${pid}`).map((r: any) => r.bill_no);
    expect(await matchOf(safe)).toEqual(['2610311']);
    expect(await matchOf(two)).toEqual(['2610313']);
    expect((await sql`SELECT count(*) AS n FROM shift_choices WHERE business_id = ${h.bid}`)[0].n).toBe(0);
    const after = (await h.reconcile()).cards;
    expect(after.trial).toBeUndefined();
    expect(after.noSwipe.map((x: any) => x.billNo)).toEqual(['2610312']);
  });
});
