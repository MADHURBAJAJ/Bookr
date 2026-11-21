// Extra cash booked as income (approved 21 Nov 2026): an Owner or Accountant books extra cash with no reason found under
// "Cash excess", as a shortage is booked as an expense; the cash then agrees, and Undo takes it out. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const count = async (bid: string, day: string, rupees: number) => {
  const [u] = await sql`SELECT id FROM uploads WHERE business_id = ${bid} AND id NOT IN (SELECT upload_id FROM cash_summaries) LIMIT 1`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${u.id}, ${day}, ${rupees * 100}, 'approved', ${Date.now()})`;
};

describe('extra cash booked as Cash excess', () => {
  it('books the extra as income, agrees, and undoes', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610501', '31 12:00', 'CASH', '500']]);
    await h.register([{ no: '2610501', amount: '500', pays: [['cash', '500']] }]);
    await h.decideRest();
    await h.confirm();
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1600); // should be 1,500: ₹100 extra
    const acc = h.clients.accountant;
    const cash = async () => (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    expect((await cash()).differencePaise).toBe(10000);

    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/excess`, { note: 'x' })).status).toBe(403);
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/shortage`, { note: 'x' })).status).toBe(409);
    const res = await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/excess`, { note: 'guest left change' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const k = await cash();
    expect(k).toMatchObject({ differencePaise: 0, excessPaise: 10000, shortagePaise: 0, shortages: [] });
    expect(k.excesses).toEqual([expect.objectContaining({ id: res.json.id, amountPaise: 10000, note: 'guest left change' })]);
    const [tx] = await sql`SELECT t.type, t.status, t.payment_mode, h.name FROM transactions t JOIN heads h ON h.id = t.head_id WHERE t.id = ${res.json.id}`;
    expect(tx).toMatchObject({ type: 'income', status: 'approved', payment_mode: 'cash', name: 'Cash excess' });
    // Nothing more to book; a shortage is not offered against it.
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/excess`, { note: 'again' })).status).toBe(409);
    expect((await acc.post(`/businesses/${h.bid}/cash-shortages/${res.json.id}/reverse`, {})).status).toBe(404);

    expect((await acc.post(`/businesses/${h.bid}/cash-excess/${res.json.id}/undo`, {})).status).toBe(200);
    expect(await cash()).toMatchObject({ differencePaise: 10000, excessPaise: 0 });
    expect((await acc.post(`/businesses/${h.bid}/cash-excess/${res.json.id}/undo`, {})).status).toBe(404);
  });
});
