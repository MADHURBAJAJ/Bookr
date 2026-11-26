// UPI shortage (approved 26 Nov 2026): a saved UPI bill whose money never came is booked by an Owner or Accountant as an
// expense under "UPI shortage"; the bill stops waiting; Undo puts it back. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('UPI shortage', () => {
  it('books a UPI bill whose money never came as an expense, stops it waiting, leaves the cash alone, and Undo puts it back', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610801', '31 14:00', 'UPI', '450'], ['2610802', '31 15:00', 'UPI', '313']]);
    await h.register([{ no: '2610801', amount: '450', pays: [['upi', '450']] }, { no: '2610802', amount: '313', pays: [['upi', '313']] }]);
    await h.decideRest('2026-10-31', () => 'use_register');
    await h.credits([['31 14:05', 450]]);
    await h.confirm();
    await h.credits([['2 11:00', 99]]); // the bank is in past the bill: it waits for a person, not a file
    const sale = (await sql`SELECT id, comparison_id FROM transactions WHERE bill_no = '2610802' AND type = 'income'`)[0];
    const waiting = async () => (await h.clients.owner.get(`/businesses/${h.bid}/days`)).json.days.find((d: { day: string }) => d.day === '2026-10-31').billsWaiting;
    expect(await waiting()).toBe(1);

    // Entry staff and viewers cannot; the accountant can, by the bill's comparison too.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/upi-shortage`, { txId: sale.id, note: 'never came' })).status).toBe(403);
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/upi-shortage`, { txId: sale.id, note: 'never came' })).status).toBe(403);
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/upi-shortage`, { comparisonId: sale.comparison_id, note: 'Guest showed a paid screen' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ amountPaise: 31300, billNo: '2610802' });
    const [x] = await sql`SELECT t.account_id, t.amount_paise, t.type, t.payment_mode, t.shift_day, h.name FROM transactions t JOIN heads h ON h.id = t.head_id WHERE t.id = ${res.json.id}`;
    expect(x).toMatchObject({ account_id: null, amount_paise: 31300, type: 'expense', payment_mode: 'upi', shift_day: '2026-10-31', name: 'UPI shortage' });
    expect(await waiting()).toBe(0);
    // Not a cash shortage: the cash check of the day does not count it.
    const cash = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    expect(JSON.stringify(cash)).not.toContain('2610802');
    // Twice is refused.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/upi-shortage`, { txId: sale.id, note: 'again' })).status).toBe(409);

    // Undo: the expense goes, the bill waits again; booked again by its sale, the head is not made twice.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/upi-shortage/${res.json.id}/undo`, {})).status).toBe(200);
    expect(await sql`SELECT id FROM transactions WHERE id = ${res.json.id}`).toEqual([]);
    expect(await waiting()).toBe(1);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/upi-shortage`, { txId: sale.id, note: 'never came' })).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM heads WHERE business_id = ${h.bid} AND name = 'UPI shortage'`)[0].n).toBe(1);
  });
});
