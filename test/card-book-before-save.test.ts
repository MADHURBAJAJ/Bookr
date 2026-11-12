// Card machine money with no bill, booked before saving (approved 11 Nov 2026): as an unbilled F&B or Room sale, or under
// a head. Matched to its payment at once, still part of what the machine got, kept by the save, and undone by Undo.
// Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('card machine money with no bill, before saving', () => {
  it('is booked as an unbilled sale, kept on save, and undone', async () => {
    const h = await hotel();
    const base = `/businesses/${h.bid}`;
    await h.software([['2610311', '31 11:00', 'CARD', '500']], istToMs(2026, 11, 1, 7, 59, 59));
    await h.register([{ no: '2610311', amount: '500', pays: [['card', '500']] }]);
    await h.swipe('31 11:01', 500);
    const p32 = await h.swipe('31 16:11', 32);
    const p210 = await h.swipe('31 16:48', 210, 'UPI', { payMode: 'UPI' });
    // The card report covers the shift.
    await h.swipe('1 09:00', 1);

    let k = (await h.reconcile()).cards;
    expect(k.strip.machine).toMatchObject({ leftPaise: 24200, bookedPaise: 0 });
    const got = k.strip.machineCardPaise + k.strip.machineUpiPaise;

    const acc = h.clients.accountant;
    expect((await h.clients.entry_staff.post(`${base}/cards/${p32}/book`, { billType: 'fnb' })).status).toBe(403);
    expect((await acc.post(`${base}/cards/${p32}/book`, { billType: 'fnb', item: 'Water bottle' })).status).toBe(200);
    const [inc] = await sql`SELECT id FROM heads WHERE business_id = ${h.bid} AND name = 'Sales'`;
    expect((await acc.post(`${base}/cards/${p210}/book`, { headId: inc.id })).status).toBe(200);

    k = (await h.reconcile()).cards;
    expect(k.booked.map((x: any) => [x.paymentId, x.amountPaise, x.what])).toEqual([[p32, 3200, 'Sale not billed (F&B): Water bottle'], [p210, 21000, expect.stringMatching(/no bill/)]]);
    expect(k.strip.machine).toMatchObject({ leftPaise: 0, bookedPaise: 24200 });
    expect(k.strip.machineCardPaise + k.strip.machineUpiPaise, 'still part of what the machine got').toBe(got);
    expect(k.needs.map((n: any) => n.payment.id)).not.toContain(p32);

    await h.decideRest();
    await h.confirm();
    const kept = await sql`SELECT t.amount_paise, t.narration, t.payment_mode, t.shift_day FROM transactions t JOIN card_matches m ON m.transaction_id = t.id WHERE m.settlement_id = ${p32}`;
    expect(kept).toEqual([{ amount_paise: 3200, narration: 'Sale not billed (F&B): Water bottle — card payment', payment_mode: 'card', shift_day: '2026-10-31' }]);

    // Undo: the booking goes, the payment is open again.
    expect((await acc.post(`${base}/cards/${p32}/unmatch`, {})).status).toBe(200);
    expect(await sql`SELECT 1 FROM transactions WHERE narration LIKE 'Sale not billed (F&B): Water bottle%'`).toHaveLength(0);
  });
});
