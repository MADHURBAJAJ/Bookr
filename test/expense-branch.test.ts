// Which school an expense is for (approved 28 Nov 2026, migration 0046). Invented schools and amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

describe('expense for a school', () => {
  it('starts on the book\'s school, can be another school or the group, and the report adds them up by school', async () => {
    const h = await businessWithAllRoles('Test School Group');
    const o = h.clients.owner;
    const br = async (name: string) => (await o.post(`/businesses/${h.bid}/branches`, { name })).json.id as string;
    const north = await br('North Campus');
    const south = await br('South Campus');
    const group = await br('Test Group');
    const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Cashier North', branchId: north, cashierUserId: h.users.entry_staff.id, openingBalance: '10,000', openingDate: '2026-11-01' })).json.id as string;
    const c = h.clients.entry_staff;
    const t = today();
    const add = (x: Record<string, unknown>) => c.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: t, kind: 'expense', ...x });
    const own = (await add({ amount: '300', narration: 'Chalk' })).json.id;
    const forSouth = (await add({ amount: '500', narration: 'Plumber', forBranchId: south })).json.id;
    expect((await add({ amount: '50', narration: 'Tea', forBranchId: '00000000-0000-4000-8000-000000000001' })).json.error).toMatch(/which school/);
    // An older line from before (no school written) counts for the book's school.
    const old = (await add({ amount: '200', narration: 'Old line' })).json.id;
    await sql`UPDATE cash_entries SET for_branch_id = NULL WHERE id = ${old}`;

    const day = (await c.get(`/businesses/${h.bid}/cashbooks/${book}/day/${t}`)).json;
    expect(day.branches.map((b: { name: string }) => b.name)).toEqual(['North Campus', 'South Campus', 'Test Group']);
    const line = (id: string) => day.entries.find((e: { id: string }) => e.id === id);
    expect(line(own)).toMatchObject({ forBranchId: north, forBranchName: 'North Campus' });
    expect(line(forSouth)).toMatchObject({ forBranchId: south, forBranchName: 'South Campus' });
    expect(line(old)).toMatchObject({ forBranchId: north, forBranchName: 'North Campus' });
    // The cash leaves this book whichever school it is for.
    expect(day.shouldPaise).toBe(1000000 - 30000 - 50000 - 20000);

    // The cashier moves their own line to the group; once the owner approves, the school stays for everyone (reopen first).
    const put = (who: typeof o, id: string, branchId: string) => who.put(`/businesses/${h.bid}/cashbook-lines/${id}/branch`, { branchId });
    expect((await put(c, own, group)).status).toBe(200);
    const heads = (await o.get(`/businesses/${h.bid}/heads`)).json.heads as { id: string; type: string }[];
    await o.put(`/businesses/${h.bid}/cashbook-lines/${own}/head`, { headId: heads.find((x) => x.type === 'expense')!.id });
    await o.post(`/businesses/${h.bid}/cashbook-lines/${own}/review`, { status: 'approved' });
    expect((await put(c, own, north)).status).toBe(409);
    expect((await put(h.clients.accountant, own, north)).status).toBe(409);
    expect((await put(o, own, north)).status).toBe(409);
    expect((await put(h.clients.accountant, forSouth, north)).status).toBe(200);
    expect((await put(h.clients.accountant, forSouth, south)).status).toBe(200);
    expect((await put(h.clients.viewer, forSouth, north)).status).toBe(403);

    const rep = (await o.get(`/businesses/${h.bid}/cashbook-report?book=all&from=${t}&to=${t}`)).json.reports[0];
    expect(Object.fromEntries(rep.expensesByBranch.map((x: { branch: string; paise: number }) => [x.branch, x.paise])))
      .toEqual({ 'Test Group': 30000, 'South Campus': 50000, 'North Campus': 20000 });
    const reviews = (await o.get(`/businesses/${h.bid}/cashbook-reviews`)).json.lines;
    expect(reviews.find((l: { id: string }) => l.id === forSouth)).toMatchObject({ forBranchName: 'South Campus', branchName: 'North Campus' });
  });
});
