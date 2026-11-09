// Audit (9 Nov 2026): a UPI credit that came into another bank account than the register's column says. Invented data.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { at, bill, hotel, log, matchedTo, statusOf } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 600_000 });

describe('credits in another bank account', () => {
  it('same amount in both accounts; no account named; two goes, one in each; register-only bill; after saving', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.account('HUF B', 'UPI Bank 2');
    await h.software([
      ['2610311', '31 12:00', 'UPI', '515'],      // A1 a credit of its amount in each account
      ['2610312', '31 13:00', 'UPI', '525'],      // A2 written just "UPI": a credit in each account
      ['2610313', '31 14:00', 'UPI', '1000'],     // A3 two goes, one into each account
      ['2610315', '31 15:00', 'UPI', '545'],      // A5 its credit comes into the other account after saving
      ['2610316', '1 07:59', 'CASH', '1'],        // the report reaches the end of the shift
    ]);
    await h.register([
      { no: '2610311', amount: '515', pays: [['upi', '515', 'UPI XOXO']] },
      { no: '2610312', amount: '525', pays: [['upi', '525', 'UPI']] },
      { no: '2610313', amount: '1000', pays: [['upi', '600', 'UPI XOXO'], ['upi', '400', 'UPI Bank 2']] },
      { no: '2610314', amount: '535', pays: [['upi', '535', 'UPI XOXO']] },   // A4 register only; its only credit is in HUF B
      { no: '2610315', amount: '545', pays: [['upi', '545', 'UPI XOXO']] },
      { no: '2610316', amount: '1', pays: [['cash', '1']] },
    ]);
    const [a1a] = await h.credits([['31 12:10', 515], ['31 13:20', 525], ['31 14:05', 600]], 'HUF A');
    const [a2a] = [(await sql`SELECT id FROM bank_rows WHERE amount_paise = 52500`)[0].id];
    const [a1b, a2b, a3b, a4] = await h.credits([['31 12:05', 515], ['31 13:05', 525], ['31 14:08', 400], ['31 16:00', 535], ['1 09:00', 2]], 'HUF B');
    const a3a = (await sql`SELECT id FROM bank_rows WHERE amount_paise = 60000`)[0].id;

    let v = await h.view();
    // A1: the credit in the written account pays it, though the other account's is closer; no column change offered.
    expect.soft(bill(v, '2610311').bank?.creditId, 'A1: paired with the credit in its own account').toBe(a1a);
    expect.soft((v.json.columnHints ?? []).some((x: any) => x.billNo === '2610311'), 'A1: no column change offered').toBe(false);
    // A2: no account named: either account may pay it, the closer first.
    expect.soft(bill(v, '2610312').bank?.creditId, 'A2: "UPI" with no account: the closer credit (13:05, HUF B)').toBe(a2b);
    // A3: two goes, each into its own account: both paired.
    expect.soft((bill(v, '2610313').bank?.parts ?? []).map((p: any) => p.creditId).sort(), 'A3: one credit per go, each in its account').toEqual([a3a, a3b].sort());
    // A4: register-only bill, its only credit in the other account: told the column may be wrong.
    const h4 = (v.json.columnHints ?? []).find((x: any) => x.billNo === '2610314');
    log('A4 hint', h4 ?? null);
    expect.soft(h4?.creditId, 'A4: column change offered with the HUF B credit').toBe(a4);
    expect.soft(h4?.toLabel, 'A4: to the UPI Bank 2 column').toBe('UPI Bank 2');

    // Save, then the 545 comes into HUF B: Reconcile offers the column change and the match together.
    await h.decideRest();
    await h.confirm();
    expect.soft(await matchedTo(a1a), 'A1 saved: matched to 2610311').toEqual(['2610311']);
    expect.soft(await statusOf(a1b), 'A1 saved: the other account\'s 515 stays open').toBe('unmatched');
    expect.soft((await matchedTo(a3a)).concat(await matchedTo(a3b)), 'A3 saved: both goes matched').toEqual(['2610313', '2610313']);
    const [a5] = await h.credits([['31 15:40', 545]], 'HUF B');
    const rec = await h.reconcile();
    const h5 = (rec.columnHints ?? []).find((x: any) => x.billNo === '2610315');
    log('A5 hint', h5 ?? null);
    expect.soft(h5?.creditId, 'A5 after saving: column change offered').toBe(a5);
    if (h5) {
      const res = await h.clients.owner.post(`/businesses/${h.bid}/register-payments/${h5.paymentId}/column`, { columnLabel: h5.toLabel, creditId: h5.creditId, transactionIds: h5.transactionIds });
      expect.soft(res.json, 'A5: change and match in one step').toEqual({ ok: true, matched: true });
      expect.soft(await matchedTo(a5), 'A5: matched to 2610315').toEqual(['2610315']);
    }
    void a2a; void at;
  });

  it('a card settlement credit into another account than usual is still offered for that day', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.account('HUF B', 'UPI Bank 2');
    await h.swipe('31 12:00', 1000);
    await sql`UPDATE card_settlements SET fee_paise = 1800, net_paise = 98200, settled_on = '2026-11-02'`;
    const T = (c: (string | number)[]) => c.join('\t');
    const head = ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t');
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.accounts['HUF B']}/paste`, { text: [head, T([1, 'S77000001', '02/11/2026', '02/11/2026 7:47:41 AM', '-', 'EZY/ICICIPOS_SET_10XX000000_021126', 'CR', '982.00', '9000'])].join('\n') });
    const v = (await h.clients.owner.get(`/businesses/${h.bid}/cards?from=2026-10-30&to=2026-11-05`)).json;
    log('card settlement', v.settlements?.[0]?.credits ?? null);
    expect.soft(v.settlements?.[0]?.credits?.[0]?.accountName, 'the HUF B settlement credit is offered').toBe('HUF B');
  });
});
