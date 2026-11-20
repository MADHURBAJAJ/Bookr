// Counted twice (20 Nov 2026): one payment written as Card and UPI on one register line. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('counted twice', () => {
  it('removes the half that never comes, puts the line right, and Undo puts it all back', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610553', '31 19:32', 'CARD', '188']], istToMs(2026, 11, 1, 23, 59, 59));
    // ₹ 179 written in both the Card and the UPI column: the line says ₹ 358 for a ₹ 188 bill.
    await h.register([{ no: '2610553', amount: '188', discount: '-170', pays: [['card', '179'], ['upi', '179']] }]);
    await h.credits([['31 21:00', 5], ['1 09:30', 6]]);
    await h.swipe('31 19:32', 179);
    await h.decideRest('2026-10-31', () => 'use_register');
    await h.confirm();
    const acc = h.clients.accountant;
    const income = async () => (await sql`SELECT payment_mode, amount_paise FROM transactions WHERE business_id = ${h.bid} AND type = 'income' ORDER BY payment_mode`);
    expect((await income()).map((x: any) => [x.payment_mode, x.amount_paise])).toEqual([['card', 17900], ['upi', 17900]]);
    const carded = await sql`SELECT count(*) AS n FROM card_matches`;
    expect(Number(carded[0].n)).toBe(1);

    const wait = async () => (await acc.get(`/businesses/${h.bid}/waiting`)).json.look.filter((x: any) => x.billNo === '2610553');
    const [item] = await wait();
    expect(item).toMatchObject({ mode: 'upi', amountPaise: 17900, twice: { otherMode: 'card', newDiscountPaise: 900, newTipPaise: 0 } });
    const txId = item.key.slice(2);

    // Entry staff may not; a sale that is not counted twice is refused.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/sales/${txId}/counted-twice`, { note: 'x' })).status).toBe(403);
    const card = (await sql`SELECT id FROM transactions WHERE business_id = ${h.bid} AND payment_mode = 'card'`)[0].id;
    expect((await acc.post(`/businesses/${h.bid}/sales/${card}/counted-twice`, { note: 'x' })).status).toBe(409);

    const res = await acc.post(`/businesses/${h.bid}/sales/${txId}/counted-twice`, { note: 'paid once by card' });
    expect(res.status).toBe(200);
    expect((await income()).map((x: any) => [x.payment_mode, x.amount_paise])).toEqual([['card', 17900]]);
    const row = (await sql`SELECT id, discount_paise, tip_paise FROM register_rows WHERE business_id = ${h.bid} AND bill_no = '2610553'`)[0];
    expect([row.discount_paise, row.tip_paise]).toEqual([900, 0]);
    expect((await sql`SELECT mode, amount_paise FROM register_payments WHERE register_row_id = ${row.id}`).map((x: any) => x.mode)).toEqual(['card']);
    expect((await sql`SELECT rg_amount_paise, rg_mode FROM bill_comparisons WHERE business_id = ${h.bid} AND bill_no = '2610553'`)[0]).toMatchObject({ rg_amount_paise: 17900, rg_mode: 'card' });
    expect(await wait()).toEqual([]);
    // The shift stays saved; the line stays locked to anything else.
    expect((await sql`SELECT status FROM shifts WHERE business_id = ${h.bid} AND shift_day = '2026-10-31'`)[0].status).toBe('confirmed');
    await expect(sql`UPDATE register_rows SET discount_paise = 0 WHERE id = ${row.id}`).rejects.toThrow(/shift_confirmed/);

    // Undo: everything as it was.
    expect((await acc.post(`/businesses/${h.bid}/counted-twice/${res.json.auditId}/undo`, {})).status).toBe(200);
    expect((await income()).map((x: any) => [x.payment_mode, x.amount_paise])).toEqual([['card', 17900], ['upi', 17900]]);
    const back = (await sql`SELECT discount_paise, tip_paise FROM register_rows WHERE id = ${row.id}`)[0];
    expect([back.discount_paise, back.tip_paise]).toEqual([item.twice.discountPaise, item.twice.tipPaise]);
    expect((await sql`SELECT mode FROM register_payments WHERE register_row_id = ${row.id} ORDER BY mode`).map((x: any) => x.mode)).toEqual(['card', 'upi']);
    expect((await wait())[0]).toMatchObject({ twice: { otherMode: 'card' } });
    expect((await acc.post(`/businesses/${h.bid}/counted-twice/${res.json.auditId}/undo`, {})).status).toBe(404);
  });
});
