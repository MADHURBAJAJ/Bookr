// Common expenses (approved 28 Nov 2026, migration 0047): an entry such as "Bajaj Group" marked as the group's common
// spending, not a school. Expenses can be for it; fee codes and cashier books cannot. Invented schools and amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

describe('common expenses', () => {
  it('marks an entry as common, keeps it out of fees and books, and the report shows it apart', async () => {
    const h = await businessWithAllRoles('Test School Group');
    const o = h.clients.owner;
    const north = (await o.post(`/businesses/${h.bid}/branches`, { name: 'North Campus' })).json.id as string;
    const group = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Alpha Group' })).json.id as string;
    const common = (on: boolean, who = o, id = group) => who.put(`/businesses/${h.bid}/branches/${id}/common`, { common: on });
    expect((await common(true, h.clients.entry_staff)).status).toBe(403);
    expect((await common(true)).status).toBe(200);

    // A school with a cashier's book can't become common; nor can a book be made for the common entry.
    const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Cashier North', branchId: north, cashierUserId: h.users.entry_staff.id, openingBalance: '10,000', openingDate: '2026-11-01' })).json.id as string;
    expect((await common(true, o, north)).status).toBe(409);
    expect((await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Group cash', branchId: group, openingBalance: '0', openingDate: '2026-11-01' })).status).toBe(400);

    // Fees: the common entry is not offered and can't be given a fee code.
    const fees = (await o.get(`/businesses/${h.bid}/fees/${today()}`)).json;
    expect(fees.branches.map((b: { name: string }) => b.name)).toEqual(['North Campus']);
    expect((await o.put(`/businesses/${h.bid}/fees/codes/ALP`, { branchId: group })).status).toBe(400);

    // Expenses: schools first, the common entry last and marked; the report keeps it apart.
    const c = h.clients.entry_staff;
    const t = today();
    const add = (x: Record<string, unknown>) => c.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: t, kind: 'expense', ...x });
    const shared = (await add({ amount: '700', narration: 'Group audit fee', forBranchId: group })).json.id;
    await add({ amount: '300', narration: 'Chalk' });
    const day = (await c.get(`/businesses/${h.bid}/cashbooks/${book}/day/${t}`)).json;
    expect(day.branches.map((b: { name: string; common: number }) => [b.name, !!b.common])).toEqual([['North Campus', false], ['Alpha Group', true]]);
    expect(day.entries.find((e: { id: string }) => e.id === shared)).toMatchObject({ forBranchName: 'Alpha Group', forCommon: 1 });
    const rep = (await o.get(`/businesses/${h.bid}/cashbook-report?book=all&from=${t}&to=${t}`)).json.reports[0];
    expect(rep.expensesByBranch).toEqual(expect.arrayContaining([{ branch: 'Alpha Group', paise: 70000, common: true }, { branch: 'North Campus', paise: 30000, common: false }]));

    // Back to a school: allowed while it has no book or fee code.
    expect((await common(false)).status).toBe(200);
    expect((await sql`SELECT is_common FROM branches WHERE id = ${group}`)[0].is_common).toBe(0);
  });
});
