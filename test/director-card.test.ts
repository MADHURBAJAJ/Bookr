// A director's money paid to the company on the card machine (approved 24 Nov 2026): booked from the Card tab as a
// "Paid to the company" line in their account, not income; the card can be remembered so its next payment with no bill is
// suggested for them, never booked by itself. Undo on the payment takes the line away. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('a director pays the company on the card machine', () => {
  it('books to their account, not income; remembers the card; Undo takes it back', async () => {
    const h = await hotel();
    const base = `/businesses/${h.bid}`;
    const acc = h.clients.accountant;
    await h.software([['2610311', '31 11:00', 'CARD', '500']], istToMs(2026, 11, 1, 7, 59, 59));
    await h.register([{ no: '2610311', amount: '500', pays: [['card', '500']] }]);
    await h.swipe('31 11:01', 500);
    const big = await h.swipe('31 18:00', 10000, 'MASTER');
    const again = await h.swipe('31 21:00', 2500, 'MASTER');
    const guest = await h.swipe('31 21:30', 700, 'VISA');
    await h.swipe('1 09:00', 1);
    expect((await acc.post(`${base}/directors`, { from: '2026-10-30', family: 'Bajaj', names: 'Asha, Ravi' })).status).toBe(200);
    const asha = (await acc.get(`${base}/directors`)).json.families[0].people.find((p: any) => p.name === 'Asha');

    let k = (await h.reconcile()).cards;
    expect(k.needs.find((n: any) => n.payment.id === big).director).toBeNull();
    expect((await h.clients.entry_staff.post(`${base}/cards/${big}/director`, { directorId: asha.id })).status).toBe(403);
    expect((await acc.post(`${base}/cards/${big}/director`, { directorId: asha.id, note: 'money in', remember: true })).status).toBe(200);
    expect((await acc.post(`${base}/cards/${big}/director`, { directorId: asha.id })).status, 'booked once').toBe(409);

    k = (await h.reconcile()).cards;
    expect(k.booked.map((x: any) => [x.paymentId, x.what])).toEqual([[big, 'Paid to the company by Asha, card MASTER ··4242: money in']]);
    expect(k.strip.machine).toMatchObject({ bookedPaise: 1000000 });
    // The same card's next payment with no bill is suggested for Asha; a guest's card is not.
    expect(k.needs.find((n: any) => n.payment.id === again).director).toEqual({ directorId: asha.id, name: 'Asha' });
    expect(k.needs.find((n: any) => n.payment.id === guest).director).toBeNull();

    // Forgotten, the card is no longer suggested; remembered again for the rest.
    expect((await acc.post(`${base}/director-cards/forget`, { key: 'MASTER|4242' })).status).toBe(200);
    expect((await h.reconcile()).cards.needs.find((n: any) => n.payment.id === again).director).toBeNull();

    let d = (await acc.get(`${base}/directors`)).json.families[0];
    expect(d.people.find((p: any) => p.name === 'Asha')).toMatchObject({ givenPaise: 1000000, balancePaise: -1000000 });
    expect(d.lines.find((l: any) => l.kind === 'given')).toMatchObject({ amountPaise: 1000000, day: '2026-10-31' });
    // Not income, and kept by the save.
    await h.decideRest();
    await h.confirm();
    expect(await sql`SELECT type, head_id FROM transactions t JOIN card_matches m ON m.transaction_id = t.id WHERE m.settlement_id = ${big}`).toEqual([{ type: 'transfer', head_id: null }]);
    expect((await sql`SELECT coalesce(sum(amount_paise), 0) AS s FROM transactions WHERE business_id = ${h.bid} AND type = 'income' AND amount_paise = 1000000`)[0].s).toBe(0);

    // Its ledger line is undone on the payment, not on the Directors page.
    const line = d.lines.find((l: any) => l.kind === 'given');
    expect((await acc.del(`${base}/director-entries/${line.id}`)).status).toBe(409);
    expect((await acc.post(`${base}/cards/${big}/unmatch`, {})).status).toBe(200);
    d = (await acc.get(`${base}/directors`)).json.families[0];
    expect(d.lines.filter((l: any) => l.kind === 'given')).toEqual([]);
    expect(await sql`SELECT 1 FROM card_matches WHERE settlement_id = ${big}`).toHaveLength(0);

  });
});
