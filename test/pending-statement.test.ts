// Reports → Pending bills and Bank statement (19 Nov 2026). Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const count = async (bid: string, day: string, rupees: number) => {
  const [u] = await sql`SELECT id FROM uploads WHERE business_id = ${bid} AND id NOT IN (SELECT upload_id FROM cash_summaries) LIMIT 1`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${u.id}, ${day}, ${rupees * 100}, 'approved', ${Date.now()})`;
};

describe('pending bills', () => {
  it('lists the bills a short count waits on, and a bill paid on a later day as received', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610501', '31 12:00', 'CASH', '1634'], ['2610504', '31 14:00', 'CASH', '83'], ['2610505', '31 13:00', 'CASH', '100'],
      ['2611503', '1 14:50', 'CARD', '501'], ['2611504', '2 07:59', 'CASH', '1']], istToMs(2026, 11, 2, 23, 59, 59));
    await h.register([
      { no: '2610504', amount: '83', pays: [['upi', '83']] }, { no: '2610505', amount: '100', pays: [['cash', '100']] },
      { no: '2610501', amount: '1634', pays: [['card', '1634']], day: '2026-11-01' }, { no: '2611503', amount: '501', pays: [['card', '501']], day: '2026-11-01' },
      { no: '2611504', amount: '1', pays: [['cash', '1']], day: '2026-11-01' },
    ]);
    await h.credits([['2 09:00', 1]]);
    await h.swipe('1 15:02', 2135, 'MASTER');
    await h.swipe('2 09:00', 1);
    await h.decideRest('2026-10-31', (c) => (['2610504', '2610501'].includes(c.billNo) ? 'use_software' : undefined));
    await h.confirm();
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1100); // 1,634 + 83 never reached the drawer
    const acc = h.clients.accountant;
    const pending = async () => (await acc.get(`/businesses/${h.bid}/reports/pending?from=2026-10-25&to=2026-11-05`)).json;

    const p = await pending();
    const short = p.toReceive.filter((x: any) => x.group === 'cash_short');
    expect(short.map((x: any) => [x.billNo, x.amountPaise]).sort()).toEqual([['2610501', 163400], ['2610504', 8300]]);
    expect(short.find((x: any) => x.billNo === '2610504').reason).toMatch(/register wrote UPI/);
    expect(short.find((x: any) => x.billNo === '2610501').reason).toMatch(/1 Nov register as card/);
    expect(p.toReceive.some((x: any) => x.billNo === '2610505')).toBe(false);
    expect(p.received).toEqual([]);

    // All bills: every bill with its tag and how its payment came.
    const all = (await acc.get(`/businesses/${h.bid}/reports/bills?day=2026-10-31`)).json;
    const bill = (no: string) => all.lines.find((l: any) => l.billNo === no);
    expect(bill('2610505')).toMatchObject({ tag: 'both', counted: { amountPaise: 10000, mode: 'cash' }, payment: [{ kind: 'cash', text: 'Cash · in the drawer' }], notCome: false });
    expect(bill('2610504')).toMatchObject({ tag: 'differ', software: { mode: 'cash' }, register: { mode: 'upi' }, notCome: true });
    expect(bill('2610504').payment[0]).toMatchObject({ kind: 'short', bad: true });
    expect(bill('2610501')).toMatchObject({ tag: 'software', notCome: true });
    expect(all.lines.every((l: any) => l.day === '2026-10-31')).toBe(true);
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/reports/bills`)).status).toBeLessThan(500);

    // Changed on 1 Nov's Card tab: received, and no longer to be received.
    const pl = (await h.reconcile('2026-11-01')).paidLater.find((x: any) => x.billNo === '2610501');
    expect((await acc.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [pl.txId], mode: 'card', note: 'Settled the next day' })).status).toBe(200);
    const p2 = await pending();
    expect(p2.received).toMatchObject([{ day: '2026-10-31', billNo: '2610501', amountPaise: 163400, from: 'cash', mode: 'card', paidOn: '2026-11-01', how: 'changed', lateDays: 1 }]);
    // Now a card sale: it waits for its machine payment to be matched, no longer for cash.
    expect(p2.toReceive.filter((x: any) => x.billNo === '2610501').map((x: any) => [x.group, x.mode])).toEqual([['not_received', 'card']]);
    expect(p2.toReceive.find((x: any) => x.billNo === '2610504')).toMatchObject({ group: 'cash_short' });
    // Bank people only for the statement; sales people for pending.
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/reports/bank-statement`)).status).toBe(403);
  });
});

describe('bank statement', () => {
  it('tags each line with how it was booked and checks the balance line by line', async () => {
    const h = await hotel();
    const accId = await h.account('HUF A', 'UPI XOXO');
    const { ids } = await h.lines([
      ['1 00:04', 41, 'CR', 'UPI/667023127194/Scan and Pay/XX3401@goaxb/SAMPLE BANK/ICIa'],
      ['1 00:05', '0.44', 'DR', 'EZY/UPICCMDR_~667023127194~011126'],
      ['1 08:21', 8100, 'DR', 'UPI/111045097844/salarypankaj/XX7457@ibl//ICIb'],
      ['1 15:35', 2800, 'DR', 'UPI/111048061210/UPI Pay/XX6978@icici//ICIc'],
      ['1 15:35', 2800, 'CR', 'UPI/RVSL111048061210/UPI Pay/XX6978@icici//ICId'],
    ]);
    // Balances that follow from ₹ 10,000.
    let bal = 1000000;
    for (const [id, d] of [[ids[0], 4100], [ids[1], -44], [ids[2], -810000], [ids[3], -280000], [ids[4], 280000]] as const) {
      bal += d;
      await sql`UPDATE bank_rows SET balance_paise = ${bal} WHERE id = ${id}`;
    }
    const o = h.clients.owner;
    const get = async () => (await o.get(`/businesses/${h.bid}/reports/bank-statement?account=${accId}&from=2026-11-01&to=2026-11-01`)).json.statement;
    let s = await get();
    expect(s).toMatchObject({ openingPaise: 1000000, inPaise: 284100, outPaise: 1090044, closingPaise: bal, breaks: 0 });
    const tag = (i: number) => s.lines.find((l: any) => l.id === ids[i]).tag;
    expect(tag(0)).toMatchObject({ kind: 'open', label: 'Not booked', hint: 'no bill yet' });
    expect(tag(1)).toMatchObject({ kind: 'open', label: 'UPI card fee · not booked' });
    expect(tag(1).hint).toMatch(/^credit S/);
    expect(tag(2)).toMatchObject({ kind: 'open', hint: 'note: salarypankaj' });
    expect(tag(4)).toMatchObject({ kind: 'open' });
    expect(tag(4).hint).toMatch(/^reversal of S/);

    // The fee booked to Bank charges; the failed payment and its reversal skipped.
    const head = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Bank charges', type: 'expense' })).json.id;
    const booked = await o.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: ids[1], headId: head, item: 'UPI card fee' }] });
    expect(booked.json.booked).toBe(1);
    expect((await o.post(`/businesses/${h.bid}/bank-rows/ignore-reversals`, {})).json.pairs).toBe(1);
    s = await get();
    expect(tag(1)).toMatchObject({ kind: 'fee', label: 'Bank charges · UPI card fee' });
    expect(tag(3)).toMatchObject({ kind: 'reversed', label: 'Reversed' });
    expect(tag(4)).toMatchObject({ kind: 'reversed', label: 'Reversal' });

    // A missing line shows as a break in the balance.
    await sql`UPDATE bank_rows SET balance_paise = balance_paise + 100 WHERE id = ${ids[2]}`;
    s = await get();
    expect(s.breaks).toBe(2);
    expect(s.lines.find((l: any) => l.id === ids[2]).balanceOk).toBe(false);
  });
});
