// The booking gate (E1, approved 25 Nov 2026): money received is checked before it is booked under a head, by every
// way of booking. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, matchedTo, statusOf } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('the booking gate', () => {
  it('stops a credit while a bill of its amount waits (under ₹100 too), and books it anyway only with a reason', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610501', '31 14:00', 'UPI', '80']]);
    await h.register([{ no: '2610501', amount: '80', pays: [['upi', '80']] }]);
    await h.decideRest('2026-10-31', () => 'use_register');
    await h.confirm();
    // The ₹80 credit came five days later (2 Nov is the latest the kit writes: still within the 7 days).
    const [late] = await h.credits([['2 11:00', 80]]);
    const o = h.clients.owner;
    const book = (more = {}) => o.post(`/businesses/${h.bid}/bank-rows/${late}/book`, { headId: h.fnb, ...more });

    const asked = (await book()).json;
    expect(asked.ok).toBe(false);
    expect(asked.gate.canOverride).toBe(true);
    expect(asked.gate.checks[0]).toMatchObject({ check: 'waiting' });
    expect(asked.gate.checks[0].bills[0]).toMatchObject({ billNo: '2610501', upiPaise: 8000 });
    expect(await statusOf(late)).toBe('unmatched');

    // A list books nothing stopped; asking first says which.
    const check = (await o.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: late, headId: h.fnb }], check: true })).json;
    expect(check).toMatchObject({ clear: [], look: [{ rowId: late, amountPaise: 8000 }] });
    const many = (await o.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: late, headId: h.fnb }] })).json;
    expect(many.booked).toBe(0);
    expect(many.look).toHaveLength(1);

    // No reason, no booking; with one, the reason stays on the line and in the audit log.
    expect((await book({ override: { reason: ' ' } })).json.ok).toBe(false);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${late}/book`, { headId: h.fnb, override: { reason: 'Tip for the band' } })).json.ok).toBe(true);
    const [row] = await sql`SELECT status, note FROM bank_rows WHERE id = ${late}`;
    expect(row.status).toBe('booked');
    expect(row.note).toContain('Tip for the band');
    const [a] = await sql`SELECT after FROM audit_log WHERE action = 'bank.book' AND row_id = ${late}`;
    expect(JSON.parse(a.after).gate).toEqual({ checks: ['waiting'], reason: 'Tip for the band' });
  });

  it('never books card machine money or a credit chosen on Reconcile, even with a reason', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610502', '31 14:00', 'UPI', '450']]);
    await h.register([{ no: '2610502', amount: '450', pays: [['upi', '450']] }]);
    const [held, card] = await h.credits([['31 14:05', 450], ['31 18:00', 1444.82]]);
    await sql`UPDATE bank_rows SET kind = 'card_settlement' WHERE id = ${card}`;
    const o = h.clients.owner;
    const cmp = (await o.get(`/businesses/${h.bid}/shifts/2026-10-31`)).json.comparisons.find((c: { billNo: string }) => c.billNo === '2610502');
    expect((await o.post(`/businesses/${h.bid}/shifts/2026-10-31/choices`, { bankRowId: held, comparisonIds: [cmp.id] })).status).toBe(200);

    for (const [id, check] of [[held, 'held'], [card, 'card']] as const) {
      const r = (await o.post(`/businesses/${h.bid}/bank-rows/${id}/book`, { headId: h.fnb, override: { reason: 'Owner says so' } })).json;
      expect(r.ok).toBe(false);
      expect(r.gate.canOverride).toBe(false);
      expect(r.gate.checks[0].check).toBe(check);
    }
    await h.confirm();
    expect(await matchedTo(held)).toEqual(['2610502']);
    expect(await statusOf(card)).toBe('unmatched');
  });

  it('names the other half of a transfer, cash deposited and desk bills in a settlement; a rule books none of them', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.account('Yes B', 'UPI YES');
    const o = h.clients.owner;
    const out = (await h.lines([['31 10:00', 101, 'DR', 'NEFT/630318481786/To own Yes account']], 'HUF A')).ids[0];
    const [inn, dep] = (await h.lines([['31 10:05', 101, 'CR', 'NEFT/630318481786/From own account'], ['31 12:00', 20000, 'CR', 'BY CASH DEPOSIT']], 'Yes B')).ids;
    const gate = async (id: string) => (await o.post(`/businesses/${h.bid}/bank-rows/${id}/book`, { headId: h.fnb })).json.gate;
    expect((await gate(inn)).checks[0]).toMatchObject({ check: 'transfer', pairRowId: out });
    expect((await gate(dep)).checks.map((k: { check: string }) => k.check)).toContain('cash');

    // A Yes Bank UPI collection settlement on 2 Nov while a desk UPI bill of 31 Oct waits.
    await h.software([['2610503', '31 15:00', 'UPI', '2800']]);
    await h.register([{ no: '2610503', amount: '2800', pays: [['upi', '2800']] }]);
    await h.decideRest('2026-10-31', () => 'use_register');
    await h.confirm();
    const settle = (await h.lines([['2 09:00', 4100, 'CR', 'UPI Collection Settlement 01-11-2026']], 'Yes B')).ids[0];
    await sql`UPDATE bank_rows SET remark = 'UPI collection settlement', kind = 'other' WHERE id = ${settle}`;
    const g = await gate(settle);
    expect(g.checks[0]).toMatchObject({ check: 'settlement', from: '2026-10-30', to: '2026-11-01' });
    expect(g.checks[0].bills.map((b: { billNo: string }) => b.billNo)).toEqual(['2610503']);
    // None of these (26 Nov 2026): the Accountant says no desk bill is in it; the whole settlement is booked, the check written on it.
    const none = await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${settle}/book`, { headId: h.fnb, item: 'UPI collection settlement',
      override: { reason: 'Checked: no desk bill in this settlement (2610503 not in it)' } });
    expect(none.status, JSON.stringify(none.json)).toBe(200);
    expect(none.json.gate).toBeUndefined();
    expect(await statusOf(settle)).toBe('booked');
    expect((await sql`SELECT t.narration, t.amount_paise FROM bank_rows r JOIN transactions t ON t.id = r.transaction_id WHERE r.id = ${settle}`)[0]).toMatchObject({ amount_paise: 410000 });

    // A rule for "BY CASH" books nothing the gate stops.
    expect((await o.post(`/businesses/${h.bid}/rules`, { name: 'Cash', direction: 'CR', contains: 'BY CASH', headId: h.fnb })).status).toBe(201);
    const byRules = (await o.post(`/businesses/${h.bid}/bank-rows/book-by-rules`, { ids: [dep] })).json;
    expect(byRules.booked).toBe(0);
    expect(await statusOf(dep)).toBe('unmatched');
  });
});
