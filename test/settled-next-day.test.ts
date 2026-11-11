// A bill settled the next day (approved 11 Nov 2026): 2610317 was counted from the software as cash on 31 Oct (its
// register line was not written yet); on 1 Nov the register writes it as card, with 2611012, and one card payment of
// ₹2,135 pays both. A person changes 31 Oct's sale to card (31 Oct's cash then drops), Bookr offers the pair, and Save
// matches the payment to both bills. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('a bill settled the next day', () => {
  it('is changed to card on its own day and paid by the next shift\'s card payment', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    const base = `/businesses/${h.bid}`;
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610317', '31 17:18', 'CASH', '1634'], ['2610318', '31 12:00', 'CASH', '100'], ['2611012', '1 15:05', 'CARD', '501']],
      istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610318', amount: '100', pays: [['cash', '100']] }]);
    await h.view();
    await h.decideRest();
    await h.confirm();
    const cashBefore = (await sql`SELECT coalesce(sum(amount_paise), 0) AS s FROM transactions WHERE business_id = ${h.bid} AND shift_day = '2026-10-31' AND payment_mode = 'cash' AND type = 'income'`)[0].s;
    expect(Number(cashBefore)).toBe(173400);

    await h.register([{ no: '2610317', amount: '1634', pays: [['card', '1634']], day: '2026-11-01' }, { no: '2611012', amount: '501', pays: [['card', '501']], day: '2026-11-01' }]);
    const pay = await h.swipe('1 15:02', 2135, 'MASTER');
    await h.swipe('1 23:30', 999); // the card report covers the shift
    await h.view('2026-11-01');
    let r = await h.reconcile('2026-11-01');
    expect(r.paidLater).toEqual([expect.objectContaining({ billNo: '2610317', fromDay: '2026-10-31', txMode: 'cash', rowMode: 'card', amountPaise: 163400 })]);

    // Paid by card on 1 Nov: 31 Oct's sale becomes card, its cash drops by ₹1,634.
    const rp = await o.post(`${base}/sales/repay`, { transactionIds: [r.paidLater[0].txId], mode: 'card', note: 'Settled on 1 Nov by card' });
    expect(rp.status, JSON.stringify(rp.json)).toBe(200);
    const cashAfter = (await sql`SELECT coalesce(sum(amount_paise), 0) AS s FROM transactions WHERE business_id = ${h.bid} AND shift_day = '2026-10-31' AND payment_mode = 'cash' AND type = 'income'`)[0].s;
    expect(Number(cashAfter)).toBe(10000);
    r = await h.reconcile('2026-11-01');
    expect(r.paidLater).toEqual([]);
    expect(r.paidLaterDone).toEqual([expect.objectContaining({ billNo: '2610317', from: 'cash', auditId: rp.json.auditId })]);
    // The card payment is offered for both bills, and the earlier bill is in the tray.
    const need = r.cards.needs.find((n: any) => n.payment.id === pay);
    expect(need.candidates).toEqual([expect.objectContaining({ billNos: ['2611012', '2610317'], earlier: [expect.objectContaining({ billNo: '2610317', fromDay: '2026-10-31' })] })]);
    expect(r.cards.open.bills.find((b: any) => b.billNo === '2610317')).toMatchObject({ fromDay: '2026-10-31' });
    const ch = await h.clients.accountant.post(`${base}/shifts/2026-11-01/card-choices`, { paymentId: pay, comparisonIds: need.candidates[0].comparisonIds });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);

    await h.decideRest('2026-11-01');
    await h.confirm('2026-11-01');
    const m = await sql`SELECT t.bill_no FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.settlement_id = ${pay} ORDER BY t.bill_no`;
    expect(m.map((x: any) => x.bill_no)).toEqual(['2610317', '2611012']);
    // Counted once: 2610317 is a sale of 31 Oct only.
    expect((await sql`SELECT shift_day FROM transactions WHERE bill_no = '2610317' AND type = 'income'`).map((x: any) => x.shift_day)).toEqual(['2026-10-31']);
  });

  it('can be put back before its money is matched', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    const base = `/businesses/${h.bid}`;
    await h.software([['2610317', '31 17:18', 'CASH', '1634'], ['2610318', '31 12:00', 'CASH', '100']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610318', amount: '100', pays: [['cash', '100']] }]);
    await h.view();
    await h.decideRest();
    await h.confirm();
    await h.register([{ no: '2610317', amount: '1634', pays: [['card', '1634']], day: '2026-11-01' }]);
    await h.view('2026-11-01');
    const r = await h.reconcile('2026-11-01');
    const rp = await o.post(`${base}/sales/repay`, { transactionIds: [r.paidLater[0].txId], mode: 'card', note: 'x' });
    expect(rp.status).toBe(200);
    expect((await o.post(`${base}/sales/repay/${rp.json.auditId}/undo`)).status).toBe(200);
    expect((await sql`SELECT payment_mode FROM transactions WHERE bill_no = '2610317' AND type = 'income'`)[0].payment_mode).toBe('cash');
    expect((await h.reconcile('2026-11-01')).paidLater).toHaveLength(1);
  });
});
