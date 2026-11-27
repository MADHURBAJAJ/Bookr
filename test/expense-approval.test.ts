// Approving expenses at once, learnt heads, notices and removed lines (approved 28 Nov 2026, migration 0047).
// Invented schools, people and amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, businessWithAllRoles, makeUser, resetDb, signIn, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

async function setup() {
  const h = await businessWithAllRoles('Test School Group');
  const o = h.clients.owner;
  const second = await makeUser('owner2');
  await addMember(h.bid, second.id, 'owner');
  const o2 = await signIn(second.email);
  const br = (await o.post(`/businesses/${h.bid}/branches`, { name: 'North Campus' })).json.id;
  const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Cashier North', branchId: br, cashierUserId: h.users.entry_staff.id, openingBalance: '10,000', openingDate: '2026-11-01' })).json.id as string;
  const heads = (await o.get(`/businesses/${h.bid}/heads`)).json.heads as { id: string; type: string; name: string }[];
  const exp = heads.filter((x) => x.type === 'expense');
  const c = h.clients.entry_staff;
  const t = today();
  const add = async (narration: string, amount: string) => (await c.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: t, kind: 'expense', amount, narration })).json.id as string;
  const line = async (id: string) => (await o.get(`/businesses/${h.bid}/cashbooks/${book}/day/${t}`)).json.entries.find((e: { id: string }) => e.id === id);
  return { ...h, o, o2, second, book, exp, c, t, add, line, acc: h.clients.accountant };
}

describe('approving expenses', () => {
  it('learns heads from the words, sets one head for many, and the owner approves many at once', async () => {
    const s = await setup();
    const [h1, h2] = s.exp;
    const paper = await s.add('Newspaper bill', '475');
    const paper2 = await s.add('newspaper bill Nov', '480');
    const bands = await s.add('Rubber bands · paid to Gupta Stores', '220');
    const tape = await s.add('Tape', '60');
    // Setting one head teaches it: the waiting line with the same words gets it now, marked learnt.
    expect((await s.acc.put(`/businesses/${s.bid}/cashbook-lines/${paper}/head`, { headId: h1.id })).status).toBe(200);
    expect(await s.line(paper2)).toMatchObject({ headId: h1.id });
    const rv = (await s.acc.get(`/businesses/${s.bid}/cashbook-reviews`)).json.lines;
    expect(rv.find((l: { id: string }) => l.id === paper2).headLearnt).toBe(1);
    expect(rv.find((l: { id: string }) => l.id === paper).headLearnt).toBe(0);
    // One head for several ticked lines; the next expense with those words comes with it.
    expect((await s.acc.put(`/businesses/${s.bid}/cashbook-lines/heads`, { ids: [bands, tape], headId: h2.id })).json.lines).toBe(2);
    const bands2 = await s.add('Rubber Bands', '100');
    expect(await s.line(bands2)).toMatchObject({ headId: h2.id });
    expect(await s.line(await s.add('Something new', '10'))).toMatchObject({ headId: null });

    // Approving many: Owner only, every line needs a head; Undo puts them back.
    const many = (who: typeof s.o, ids: string[], status: string | null = 'approved') => who.post(`/businesses/${s.bid}/cashbook-lines/review-many`, { ids, status });
    expect((await many(s.acc, [paper])).status).toBe(403);
    const fresh = await s.add('Chalk', '30');
    expect((await many(s.o, [paper, fresh])).json.error).toMatch(/"Chalk" has no head/);
    expect((await many(s.o, [paper, paper2, bands, tape, bands2])).json.lines).toBe(5);
    expect(await s.line(paper)).toMatchObject({ reviewStatus: 'approved' });
    expect((await many(s.o, [paper])).status).toBe(409);
    expect((await many(s.o, [tape], null)).status).toBe(200);
    expect(await s.line(tape)).toMatchObject({ reviewStatus: null });
  });

  it('a head changed after approval: the Accountant\'s change goes to both owners, an Owner\'s to the other; Approve clears it', async () => {
    const s = await setup();
    const [h1, h2] = s.exp;
    const a4 = await s.add('A4 paper', '2,800');
    await s.acc.put(`/businesses/${s.bid}/cashbook-lines/${a4}/head`, { headId: h1.id });
    await s.o.post(`/businesses/${s.bid}/cashbook-lines/review-many`, { ids: [a4], status: 'approved' });
    expect((await s.acc.put(`/businesses/${s.bid}/cashbook-lines/${a4}/head`, { headId: h2.id })).status).toBe(200);
    expect(await s.line(a4)).toMatchObject({ headId: h2.id, reviewStatus: 'approved' });
    const mine = (await s.o.get(`/businesses/${s.bid}/owner-look`)).json.notices;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'head_after_approval', detail: { narration: 'A4 paper', beforeHead: h1.name, afterHead: h2.name } });
    expect((await s.o2.get(`/businesses/${s.bid}/notices`)).json.notices).toHaveLength(1);
    expect((await s.acc.get(`/businesses/${s.bid}/notices`)).json.notices).toHaveLength(0);
    // Change back: the head returns, and the other owner is told of this owner's change.
    expect((await s.o.post(`/businesses/${s.bid}/notices/${mine[0].id}/change-back`, {})).status).toBe(200);
    expect(await s.line(a4)).toMatchObject({ headId: h1.id });
    expect((await s.o.get(`/businesses/${s.bid}/notices`)).json.notices).toHaveLength(0);
    const theirs = (await s.o2.get(`/businesses/${s.bid}/notices`)).json.notices;
    expect(theirs.map((n: { kind: string }) => n.kind).sort()).toEqual(['head_after_approval', 'owner_change']);
    // Approve (done) clears only their own.
    for (const n of theirs) expect((await s.o2.post(`/businesses/${s.bid}/notices/${n.id}/done`, {})).status).toBe(200);
    expect((await s.o2.get(`/businesses/${s.bid}/notices`)).json.notices).toHaveLength(0);
    expect((await s.o.post(`/businesses/${s.bid}/notices/${theirs[0].id}/done`, {})).status).toBe(404);
    // Reopening an approved expense tells the other owner too.
    await s.o.post(`/businesses/${s.bid}/cashbook-lines/${a4}/review`, { status: null });
    expect((await s.o2.get(`/businesses/${s.bid}/notices`)).json.notices[0]).toMatchObject({ kind: 'owner_change', detail: { reopened: true } });
  });

  it('an expense the owner removes stays struck off for the cashier, out of the total, with a notice', async () => {
    const s = await setup();
    const bands = await s.add('Rubber bands', '220');
    await s.add('Polythene', '240');
    const base = `/businesses/${s.bid}/cashbooks/${s.book}`;
    expect((await s.o.del(`${base}/entries/${bands}`, { note: 'typed twice' })).status).toBe(200);
    const d = (await s.c.get(`${base}/day/${s.t}`)).json;
    expect(d.shouldPaise).toBe(1000000 - 24000);
    expect(d.removed).toEqual([expect.objectContaining({ narration: 'Rubber bands', amountPaise: 22000, note: 'typed twice' })]);
    expect(d.notices).toEqual([expect.objectContaining({ kind: 'line_removed', detail: expect.objectContaining({ amountPaise: 22000, note: 'typed twice' }) })]);
    expect((await s.c.post(`/businesses/${s.bid}/notices/${d.notices[0].id}/done`, {})).status).toBe(200);
    // The cashier removing their own line: no struck-off line, no notice.
    const own = await s.add('Tea', '20');
    await s.c.del(`${base}/entries/${own}`);
    const d2 = (await s.c.get(`${base}/day/${s.t}`)).json;
    expect(d2.removed).toHaveLength(1);
    expect(d2.notices).toHaveLength(0);
  });
});
