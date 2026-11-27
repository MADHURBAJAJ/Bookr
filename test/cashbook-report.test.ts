// Cash book report (approved 28 Nov 2026): one cashier or all, day by day with totals. Invented books and amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

describe('cash book report', () => {
  it('shows each day, the totals and the summary; a cashier gets only their own book', async () => {
    const h = await businessWithAllRoles('Test School Group');
    const o = h.clients.owner;
    const north = (await o.post(`/businesses/${h.bid}/branches`, { name: 'North Campus' })).json.id;
    const south = (await o.post(`/businesses/${h.bid}/branches`, { name: 'South Campus' })).json.id;
    const a = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Cashier North', branchId: north, cashierUserId: h.users.entry_staff.id, openingBalance: '10,000', openingDate: '2026-11-10' })).json.id as string;
    const b = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Cashier South', branchId: south, openingBalance: '2,000', openingDate: '2026-11-12' })).json.id as string;
    const c = h.clients.entry_staff;
    const add = (day: string, x: Record<string, unknown>) => c.post(`/businesses/${h.bid}/cashbooks/${a}/entries`, { day, ...x });
    expect((await c.put(`/businesses/${h.bid}/cashbooks/${a}/fee/2026-11-11`, { amount: '5,000', receipts: 4 })).status).toBe(200);
    const e1 = (await add('2026-11-11', { kind: 'expense', amount: '300', narration: 'Chalk' })).json.id;
    await add('2026-11-11', { kind: 'other_in', amount: '700', narration: 'Admission form' });
    await add('2026-11-12', { kind: 'handover_out', amount: '4,000', to: { kind: 'book', accountId: b } });
    expect((await c.put(`/businesses/${h.bid}/cashbooks/${a}/count/2026-11-12`, { counted: '11,300', note: 'Coins' })).status).toBe(200);
    const heads = (await o.get(`/businesses/${h.bid}/heads`)).json.heads as { id: string; type: string }[];
    await o.put(`/businesses/${h.bid}/cashbook-lines/${e1}/head`, { headId: heads.find((x) => x.type === 'expense')!.id });
    expect((await o.post(`/businesses/${h.bid}/cashbook-lines/${e1}/review`, { status: 'approved' })).status).toBe(200);

    const q = (who: typeof o, x: string) => who.get(`/businesses/${h.bid}/cashbook-report?${x}`);
    const one = (await q(o, `book=${a}&from=2026-11-11&to=2026-11-13`)).json;
    expect(one.all).toBe(false);
    const r = one.reports[0];
    expect(r.openingPaise).toBe(1000000);
    expect(r.days.map((d: { day: string }) => d.day)).toEqual(['2026-11-11', '2026-11-12', '2026-11-13']);
    expect(r.days[0]).toMatchObject({ openingPaise: 1000000, shouldPaise: 1000000 + 500000 - 30000 + 70000 });
    expect(r.days[0].lines.find((l: { kind: string }) => l.kind === 'expense')).toMatchObject({ reviewStatus: 'approved', narration: 'Chalk' });
    expect(r.days[0].lines.find((l: { kind: string }) => l.kind === 'fee')).toMatchObject({ amountPaise: 500000, feeReceipts: 4 });
    expect(r.days[1].lines[0]).toMatchObject({ kind: 'handover_out', other: 'Cashier South' });
    expect(r.days[1].count).toMatchObject({ countedPaise: 1130000, gapPaise: -10000, note: 'Coins' });
    expect(r.totals).toEqual({ feePaise: 500000, receiptsPaise: 70000, expensesPaise: 30000, handedPaise: 400000, inHandPaise: 1140000 });
    expect(r.expenses.approved).toEqual({ n: 1, paise: 30000 });
    expect(r.daysCounted).toBe(1);

    // All cashiers: South starts on 12 Nov, so its opening is its start; a range before a book starts gives no days.
    const all = (await q(h.clients.accountant, 'book=all&from=2026-11-11&to=2026-11-13')).json;
    expect(all.all).toBe(true);
    expect(all.reports.map((x: { book: { name: string } }) => x.book.name)).toEqual(['Cashier North', 'Cashier South']);
    expect(all.reports[1]).toMatchObject({ from: '2026-11-12', openingPaise: 200000 });
    expect((await q(o, `book=${b}&from=2026-11-10&to=2026-11-11`)).json.reports[0]).toMatchObject({ totals: null, days: [] });

    // A cashier asking for all gets only their own book, and another book is not found.
    const mine = (await q(c, 'book=all&from=2026-11-11&to=2026-11-11')).json;
    expect(mine.reports.map((x: { book: { id: string } }) => x.book.id)).toEqual([a]);
    expect((await q(c, `book=${b}&from=2026-11-11&to=2026-11-11`)).status).toBe(404);
    // Bad ranges.
    expect((await q(o, 'from=2026-11-13&to=2026-11-11')).status).toBe(400);
    expect((await q(o, 'from=2026-01-01&to=2026-11-11')).json.error).toMatch(/at most 92 days/);
    expect((await q(o, 'from=2030-01-01&to=2030-01-02')).status).toBe(400);
  });
});
