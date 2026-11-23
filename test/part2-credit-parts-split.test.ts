// Part 2 of the reconcile cases (approved 23 Nov 2026): credit bills, a group paid in parts, and a split cash + UPI
// bill against one software mode. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, at, bill, matchedTo, statusOf } from './auditKit';
import { pairGroupParts, pairEvidence } from '../src/bankEvidence';
import { allocateParts } from '../src/sales';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const W = { from: at('31 08:00').ms, to: at('1 08:00').ms };
const cr = (id: string, rupees: number, when: string) => ({ id, amount: rupees * 100, postedAt: at(when).ms, label: 'UPI XOXO' });

describe('the pieces', () => {
  it('a group paid in parts takes the one set of credits that adds up, and only one', () => {
    const g = [{ id: 'g', upiPaise: 1043400, labels: 'UPI XOXO' }];
    const two = pairGroupParts(g, [cr('a', 6000, '31 11:43'), cr('b', 4434, '31 12:15'), cr('c', 300, '31 12:00')], new Set(), W, new Set());
    expect(two.get('g')?.map((c) => c.id)).toEqual(['a', 'b']);
    // Two ways to make the total: nothing is offered.
    const amb = pairGroupParts(g, [cr('a', 6000, '31 11:43'), cr('b', 4434, '31 12:15'), cr('c', 4000, '31 12:00'), cr('d', 434, '31 12:05')], new Set(), W, new Set());
    expect(amb.has('g')).toBe(false);
    // A credit some bill still wants is left alone; too far apart is not one payment.
    expect(pairGroupParts(g, [cr('a', 6000, '31 11:43'), cr('b', 4434, '31 12:15')], new Set(), W, new Set([443400])).has('g')).toBe(false);
    expect(pairGroupParts(g, [cr('a', 6000, '31 09:00'), cr('b', 4434, '31 12:15')], new Set(), W, new Set()).has('g')).toBe(false);
  });

  it('shares the credits over the sales in turn', () => {
    expect(allocateParts([{ id: 'a', amount: 600000 }, { id: 'b', amount: 443400 }], [{ id: 'x', amount: 900000 }, { id: 'y', amount: 143400 }])).toEqual([
      { creditId: 'a', txs: [{ id: 'x', amount: 600000 }] },
      { creditId: 'b', txs: [{ id: 'x', amount: 300000 }, { id: 'y', amount: 143400 }] },
    ]);
  });

  it('the UPI part of a split cash + UPI bill looks back three hours', () => {
    const b = { id: 's', billNo: '2610313', paidAt: at('1 01:13').ms, difference: 'mode', decision: null, grouped: false,
      swAmount: 50400, swMode: 'upi', rgAmount: 49100, rgMode: 'mixed', parts: [24100] };
    const near = pairEvidence([b], [cr('k', 241, '31 23:10')], W).evidence.get('s');
    expect(near?.parts?.[0].creditId).toBe('k');
    expect(near?.suggest).toBe('use_register');
    // A plain UPI bill paid in two goes still looks only an hour each way.
    expect(pairEvidence([{ ...b, rgMode: 'upi', swMode: 'upi', difference: 'amount' }], [cr('k', 241, '31 23:10')], W).evidence.has('s')).toBe(false);
  });
});

describe('on a shift', () => {
  it('paid in parts and split cash + UPI: offered, a person presses, matched on save', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 12:15', 'UPI', '9000'], ['2610312', '31 12:17', 'UPI', '1434'], ['2610313', '1 01:13', 'UPI', '504']]);
    await h.register([{ no: '2610311', amount: '9000', pays: [['upi', '10434']] }, { no: '2610312', amount: '1434', pays: [], paidWith: '2610311' },
      { no: '2610313', amount: '504', discount: '13', pays: [['cash', '250'], ['upi', '241']] }]);
    const [six, four, split] = await h.credits([['31 11:43', 6000], ['31 12:15', 4434], ['31 23:10', 241]]);

    let v = await h.view();
    const g = v.json.paidGroups[0];
    expect(g.bank).toMatchObject({ amountPaise: 1043400, accepted: false, parts: [{ creditId: six, amountPaise: 600000 }, { creditId: four, amountPaise: 443400 }] });
    expect(v.json.bank.noBill.map((x: any) => x.id)).not.toContain(six);
    expect(bill(v, '2610313').bank).toMatchObject({ suggest: 'use_register', parts: [{ creditId: split }] });

    let r = await h.reconcile();
    const parts = r.fixes.find((c: any) => c.kind === 'group_parts');
    expect(parts).toMatchObject({ billNos: ['2610311', '2610312'], look: { accepted: false, right: 0, totalPaise: 1043400 } });
    const splitCard = r.fixes.find((c: any) => c.kind === 'split_cash_upi');
    expect(splitCard.look).toMatchObject({ software: { amountPaise: 50400, mode: 'upi' }, discountPaise: 1300 });
    expect(r.fixes.some((c: any) => c.kind === 'bank_backs' && c.billNos[0] === '2610313')).toBe(false);

    // Entry staff cannot press Match all.
    const a = parts.actions[0];
    expect((await h.clients.entry_staff.post(a.path, a.body)).status).toBe(403);
    let res = await h.clients.accountant.post(a.path, a.body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // Undo, then again: the second press counts.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/group-parts/${res.json.auditId}/undo`, {})).status).toBe(200);
    expect((await h.view()).json.paidGroups[0].bank.accepted).toBe(false);
    res = await h.clients.accountant.post(a.path, a.body);
    expect(res.status).toBe(200);
    r = await h.reconcile();
    expect(r.fixes.find((c: any) => c.kind === 'group_parts').look).toMatchObject({ accepted: true, right: 1 });

    const s = splitCard.actions[0];
    expect((await h.clients.accountant.put(s.path, s.body)).status).toBe(200);
    v = await h.view();
    expect(bill(v, '2610313').decision).toBe('use_register');

    await h.decideRest();
    await h.confirm();
    expect(await matchedTo(six)).toEqual(['2610311']);
    expect(await matchedTo(four)).toEqual(['2610311', '2610312']);
    expect(await matchedTo(split)).toEqual(['2610313']);
    expect(await statusOf(four)).toBe('matched');
    const amounts = await sql`SELECT bank_row_id, amount_paise FROM bank_matches WHERE bank_row_id = ${four} ORDER BY amount_paise`;
    expect(amounts.map((x: any) => x.amount_paise)).toEqual([143400, 300000]);
  });

  it('not pressed: a group paid in parts is not matched on save', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 12:15', 'UPI', '9000'], ['2610312', '31 12:17', 'UPI', '1434']]);
    await h.register([{ no: '2610311', amount: '9000', pays: [['upi', '10434']] }, { no: '2610312', amount: '1434', pays: [], paidWith: '2610311' }]);
    const [six] = await h.credits([['31 11:43', 6000], ['31 12:15', 4434]]);
    await h.confirm();
    expect(await statusOf(six)).toBe('unmatched');
  });

  it('credit bill: made on the Complimentary tab, a sale with no mode on saving, paid later by a matched credit', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610314', '31 14:00', 'U/N', '1697'], ['2610311', '31 12:15', 'CASH', '100']]);
    await h.register([{ no: '2610311', amount: '100', pays: [['cash', '100']] }]);
    const base = `/businesses/${h.bid}`;
    let tab = (await h.clients.accountant.get(`${base}/shifts/2026-10-31/complimentary`)).json;
    const line = tab.lines.find((l: any) => l.billNo === '2610314');
    expect(line).toMatchObject({ why: 'unknown' });

    expect((await h.clients.entry_staff.post(`${base}/comparisons/${line.comparisonId}/credit`, { guestName: 'PARI', billType: 'room' })).status).toBe(403);
    expect((await h.clients.accountant.post(`${base}/comparisons/${line.comparisonId}/credit`, { guestName: 'PARI' })).status).toBe(400);
    let res = await h.clients.accountant.post(`${base}/comparisons/${line.comparisonId}/credit`, { guestName: 'PARI', billType: 'room' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    tab = (await h.clients.accountant.get(`${base}/shifts/2026-10-31/complimentary`)).json;
    expect(tab.lines.some((l: any) => l.billNo === '2610314')).toBe(false);
    expect(tab.credit).toMatchObject([{ billNo: '2610314', guestName: 'PARI', amountPaise: 169700 }]);
    // Undo and make again.
    expect((await h.clients.accountant.call('DELETE', `${base}/comparisons/${line.comparisonId}/credit`, {})).status).toBe(200);
    expect((await sql`SELECT decision FROM bill_comparisons WHERE id = ${line.comparisonId}`)[0].decision).toBeNull();
    res = await h.clients.accountant.post(`${base}/comparisons/${line.comparisonId}/credit`, { guestName: 'PARI', billType: 'room' });
    expect(res.status).toBe(200);

    let list = (await h.clients.owner.get(`${base}/reports/credit`)).json;
    expect(list.lines[0]).toMatchObject({ billNo: '2610314', guestName: 'PARI', saved: false, paid: null, offers: [] });

    await h.confirm();
    const [tx] = await sql`SELECT payment_mode, amount_paise, account_id, match_status, head_id FROM transactions WHERE bill_no = '2610314'`;
    expect(tx).toMatchObject({ payment_mode: null, amount_paise: 169700, account_id: null, match_status: null });
    expect(tx.head_id).toBeTruthy();
    // Saved: no undo on that day.
    expect((await h.clients.accountant.call('DELETE', `${base}/comparisons/${line.comparisonId}/credit`, {})).status).toBe(409);

    const [paid] = await h.credits([['1 10:00', 1697]]);
    list = (await h.clients.owner.get(`${base}/reports/credit`)).json;
    expect(list).toMatchObject({ owed: 1, owedPaise: 169700, right: 0 });
    expect(list.lines[0].offers.map((o: any) => o.bankRowId)).toEqual([paid]);
    // Entry staff can read the report only if allowed, and never sees the bank.
    const staff = await h.clients.entry_staff.get(`${base}/reports/credit`);
    if (staff.status === 200) expect(staff.json.lines[0].offers).toEqual([]);

    expect((await h.clients.entry_staff.post(`${base}/credit-bills/${list.lines[0].id}/pay`, { bankRowId: paid })).status).toBe(403);
    res = await h.clients.owner.post(`${base}/credit-bills/${list.lines[0].id}/pay`, { bankRowId: paid });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await matchedTo(paid)).toEqual(['2610314']);
    list = (await h.clients.owner.get(`${base}/reports/credit`)).json;
    expect(list).toMatchObject({ owed: 0, right: 1 });
    expect(list.lines[0].paid.bankRowId).toBe(paid);

    expect((await h.clients.owner.post(`${base}/credit-bills/${list.lines[0].id}/unpay`, {})).status).toBe(200);
    expect(await statusOf(paid)).toBe('unmatched');
    list = (await h.clients.owner.get(`${base}/reports/credit`)).json;
    expect(list).toMatchObject({ owed: 1, right: 0 });
  });

  it('a credit 30 days old shows in red on Home', async () => {
    const h = await hotel();
    await sql`INSERT INTO credit_bills (id, business_id, shift_day, bill_no, guest_name, amount_paise, made_by, made_at)
      VALUES (${crypto.randomUUID()}, ${h.bid}, '2020-01-01', '2001011', 'DK', 197400, NULL, ${Date.now()})`;
    const home = (await h.clients.owner.get(`/businesses/${h.bid}/home`)).json;
    expect(home.creditRed).toMatchObject([{ guestName: 'DK', amountPaise: 197400, billNo: '2001011' }]);
  });
});
