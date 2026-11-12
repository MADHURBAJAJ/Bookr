// An advance paid on the card machine (approved 12 Nov 2026): booked as an advance when paid, then used by its room bill
// on a later shift. Chosen before saving, joined on save (counted once, on the day the money came), and undone by Undo.
// Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('a card advance', () => {
  it('is booked, used by its room bill on save, and undone', async () => {
    const h = await hotel();
    const base = `/businesses/${h.bid}`;
    const acc = h.clients.accountant;
    const adv = await h.swipe('30 13:00', 5000);
    expect((await acc.post(`${base}/cards/${adv}/book`, { billType: 'room', item: 'Advance: Mr Sharma, room 12' })).status).toBe(200);

    // Check-out on 31 Oct: ₹12,000, ₹5,000 of it the card advance, the rest cash. No swipe at check-out.
    await h.software([['2610341', '31 11:00', 'CASH', '12000']], istToMs(2026, 11, 1, 7, 59, 59));
    await h.register([{ no: '2610341', amount: '12000', pays: [['card', '5000'], ['cash', '7000']] }]);
    await h.swipe('1 09:00', 1);   // the card report covers the shift
    await h.decideRest('2026-10-31', () => 'use_register');
    let k = (await h.reconcile()).cards;
    const ns = k.noSwipe.find((x: any) => x.billNo === '2610341');
    expect(ns?.advances).toEqual([expect.objectContaining({ paymentId: adv, amountPaise: 500000, txDay: '2026-10-30', what: 'Advance: Mr Sharma, room 12' })]);

    const path = `${base}/shifts/2026-10-31/card-advance`;
    expect((await h.clients.entry_staff.post(path, { paymentId: adv, comparisonId: ns.comparisonId })).status).toBe(403);
    expect((await acc.post(path, { paymentId: adv, comparisonId: ns.comparisonId })).status).toBe(200);
    expect((await acc.post(path, { paymentId: adv, comparisonId: ns.comparisonId })).status).toBe(409);
    k = (await h.reconcile()).cards;
    expect(k.noSwipe.map((x: any) => x.billNo)).not.toContain('2610341');
    expect(k.advancePlans).toEqual([expect.objectContaining({ paymentId: adv, billNo: '2610341' })]);
    // Undo before saving, then choose it again.
    expect((await acc.del(path, { paymentId: adv })).status).toBe(200);
    expect((await h.reconcile()).cards.advancePlans).toEqual([]);
    expect((await acc.post(path, { paymentId: adv, comparisonId: ns.comparisonId })).status).toBe(200);

    await h.confirm();
    const sale = async () => (await sql`SELECT t.id, t.day, t.match_status, (SELECT m.settlement_id FROM card_matches m WHERE m.transaction_id = t.id) AS pay
      FROM transactions t WHERE t.bill_no = '2610341' AND t.payment_mode = 'card'`)[0];
    expect(await sale()).toMatchObject({ day: '2026-10-30', match_status: null, pay: adv });
    expect(await sql`SELECT 1 FROM transactions WHERE source = 'bank_sheet' AND business_id = ${h.bid}`, 'counted once: the advance booking is gone').toHaveLength(0);

    // Undo after saving: the booking comes back, the bill waits for its card payment on its own day.
    const un = await acc.post(`${base}/cards/${adv}/unmatch`, {});
    expect(un.json).toMatchObject({ ok: true, advanceBack: true });
    expect(await sale()).toMatchObject({ day: '2026-10-31', match_status: 'awaiting_card_settlement', pay: null });
    expect((await sql`SELECT t.narration FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.settlement_id = ${adv}`).map((r: any) => r.narration))
      .toEqual(['Sale not billed (Room): Advance: Mr Sharma, room 12 — card payment']);
  });
});
