// Paid later by card (approved 18 Nov 2026): a cash bill of 31 Oct written in the 1 Nov register as card, paid on the
// card machine on 1 Nov together with a 1 Nov card bill on the next line. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('a bill paid later by card', () => {
  it('is told on its day with the payment, counted as card there, undone, and paid on the later day', async () => {
    const h = await hotel();
    await h.software([['2610501', '31 12:00', 'CASH', '1634'], ['2610502', '31 13:00', 'CASH', '100'],
      ['2611503', '1 14:50', 'CARD', '501'], ['2611504', '2 07:59', 'CASH', '1']], (await import('../src/time')).istToMs(2026, 11, 2, 23, 59, 59));
    await h.register([
      { no: '2610502', amount: '100', pays: [['cash', '100']] },
      { no: '2610501', amount: '1634', pays: [['card', '1634']], day: '2026-11-01' },
      { no: '2611503', amount: '501', pays: [['card', '501']], day: '2026-11-01' },
    ]);
    const pay = await h.swipe('1 15:02', 2135, 'MASTER');
    await h.swipe('2 09:00', 1);
    const acc = h.clients.accountant;
    const cash = async () => (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    const k = await cash();
    const nir = k.notInRegister.find((x: any) => x.billNo === '2610501');
    expect(nir.late).toMatchObject({ day: '2026-11-01', amountPaise: 163400, mode: 'card' });
    expect(nir.paidLater).toMatchObject({ mode: 'card', done: false, evidence: { kind: 'card', id: pay, amountPaise: 213500, with: [{ billNo: '2611503', amountPaise: 50100 }] } });
    const before = k.draft.cashSalesPaise;
    const lineDecision = async () => (await sql`SELECT decision, note FROM bill_comparisons WHERE business_id = ${h.bid} AND shift_day = '2026-11-01' AND bill_no = '2610501'`)[0];
    expect((await lineDecision()).decision).toBe('leave_out');

    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/comparisons/${nir.id}/paid-later`, {})).status).toBe(403);
    const res = await acc.post(`/businesses/${h.bid}/comparisons/${nir.id}/paid-later`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const k2 = await cash();
    expect(k2.draft.cashSalesPaise).toBe(before - 163400);
    expect(await lineDecision()).toMatchObject({ decision: 'leave_out', note: 'Already counted on 2026-10-31' });
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${nir.id}/paid-later`, {})).status).toBe(400);

    // Undo puts it back as cash, still left out on 1 Nov.
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${nir.id}/paid-later/undo`, {})).status).toBe(200);
    expect((await cash()).draft.cashSalesPaise).toBe(before);
    expect((await lineDecision()).decision).toBe('leave_out');

    // Again, then save 31 Oct: a card sale waiting; 1 Nov's payment pays it with the 1 Nov bill.
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${nir.id}/paid-later`, {})).status).toBe(200);
    await h.decideRest();
    await h.confirm();
    const sale = (await sql`SELECT id, payment_mode, match_status FROM transactions WHERE business_id = ${h.bid} AND bill_no = '2610501' AND type = 'income'`);
    expect(sale.map((x: any) => [x.payment_mode, x.match_status])).toEqual([['card', 'awaiting_card_settlement']]);
    const cards = (await h.reconcile('2026-11-01')).cards;
    const need = cards.needs.find((n: any) => n.payment.id === pay);
    expect(need.candidates.map((x: any) => [...x.billNos].sort())).toEqual([['2610501', '2611503']]);
    const ok = await acc.post(`/businesses/${h.bid}/shifts/2026-11-01/card-choices`, { pairs: [{ paymentId: pay, comparisonIds: need.candidates[0].comparisonIds }] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });
});

describe('a bill paid later by UPI', () => {
  it('is paired with the later day\'s credit on its UPI tab and matched when that day is saved', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610601', '31 12:00', 'CASH', '750'], ['2610602', '31 13:00', 'CASH', '100'], ['2611603', '2 07:59', 'CASH', '1']],
      (await import('../src/time')).istToMs(2026, 11, 2, 23, 59, 59));
    await h.register([
      { no: '2610602', amount: '100', pays: [['cash', '100']] },
      { no: '2610601', amount: '750', pays: [['upi', '750']], day: '2026-11-01' },
    ]);
    const [cr] = await h.credits([['1 16:00', 750], ['2 09:00', 1]]);
    const acc = h.clients.accountant;
    const nir = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json.notInRegister.find((x: any) => x.billNo === '2610601');
    expect(nir.paidLater).toMatchObject({ mode: 'upi', evidence: { kind: 'upi', id: cr, amountPaise: 75000, with: [] } });
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${nir.id}/paid-later`, {})).status).toBe(200);
    await h.decideRest();
    await h.confirm();
    const r = await h.reconcile('2026-11-01');
    const bill = r.open.bills.find((b: any) => b.billNo === '2610601');
    expect(bill).toMatchObject({ fromDay: '2026-10-31', amountPaise: 75000 });
    const ok = await acc.post(`/businesses/${h.bid}/shifts/2026-11-01/choices`, { pairs: [{ bankRowId: cr, comparisonIds: [bill.id] }] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    await h.decideRest('2026-11-01');
    await h.confirm('2026-11-01');
    const tx = await sql`SELECT matched_bank_row, match_status FROM transactions WHERE business_id = ${h.bid} AND bill_no = '2610601' AND type = 'income'`;
    expect(tx).toEqual([{ matched_bank_row: cr, match_status: null }]);
  });
});
