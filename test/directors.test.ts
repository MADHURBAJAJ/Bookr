// Directors' accounts (approved 23 Nov 2026): families with a person on every line, WITHDRAWL lines moved in, stock
// taken, NC at 50% with its income, names sorted once, and approved cash lines edited or removed with Undo.
// Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, bill } from './auditKit';
import { guessDirector, nameKey } from '../src/directors';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

async function setUp() {
  const h = await hotel();
  const o = h.clients.owner;
  const head = async (name: string) => (await o.post(`/businesses/${h.bid}/heads`, { name, type: 'expense' })).json.id as string;
  const heads = { bajaj: await head('BAJAJ WITHDRAWL'), veg: await head('Vegetables') };
  const cash = (await sql`SELECT id FROM accounts WHERE business_id = ${h.bid} AND kind = 'cash'`)[0]?.id ?? null;
  const tx = async (day: string, rupees: number, narration: string, headId: string, status = 'approved') => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, created_at)
      VALUES (${id}, ${h.bid}, ${cash}, ${day}, ${rupees * 100}, 'expense', ${headId}, ${narration}, 'cash_photo', ${status}, 'cash', ${Date.now()})`;
    return id;
  };
  const acc = h.clients.accountant;
  const r = await acc.post(`/businesses/${h.bid}/directors`, { from: '2026-10-30', family: 'Bajaj', names: 'Mohak, Deepansh' });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((await acc.post(`/businesses/${h.bid}/directors`, { family: 'Kharbanda', names: 'Vikas' })).status).toBe(200);
  const d = (await acc.get(`/businesses/${h.bid}/directors`)).json;
  const id = (n: string) => d.families.flatMap((f: any) => f.people).find((p: any) => p.name === n).id as string;
  return { h, acc, heads, tx, mohak: id('Mohak'), deepansh: id('Deepansh'), vikas: id('Vikas') };
}

describe('names', () => {
  it('reads DEEPANSH SIR, deepansh and a misspelling as one person', () => {
    expect(nameKey('DEEPANSH SIR')).toBe('deepansh');
    const ppl = [{ id: 'a', name: 'Mohak' }, { id: 'b', name: 'Deepansh' }];
    expect(guessDirector('Deepansh Sir', ppl)?.id).toBe('b');
    expect(guessDirector('Dipansh', ppl)?.id).toBe('b');
    expect(guessDirector('Mr Mehta', ppl)).toBeNull();
  });
});

describe('the ledger', () => {
  it('opening, moved WITHDRAWL lines, stock taken with Undo, and the balance', async () => {
    const { h, acc, heads, tx, mohak, vikas } = await setUp();
    expect((await acc.put(`/businesses/${h.bid}/directors/${mohak}/opening`, { amount: '1000', side: 'owes' })).status).toBe(200);
    const cashOut = await tx('2026-10-31', 500, 'Mohak sir cash', heads.bajaj);
    const back = await tx('2026-11-01', 300, '11th Sep bar stock', heads.bajaj);
    const gas = await tx('2026-11-01', 1200, 'Gas cylinder', heads.veg);
    await tx('2026-10-29', 900, 'Before the start', heads.bajaj);

    let d = (await acc.get(`/businesses/${h.bid}/directors`)).json;
    expect(d.toMove.map((m: any) => [m.transactionId, m.kind])).toEqual([[cashOut, 'taken'], [back, 'repaid']]);
    expect(d.toMove[0].directorId).toBe(mohak);
    // A viewer reads, but cannot move.
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/director-entries/move`, { items: [] })).status).toBe(403);
    expect((await h.clients.viewer.get(`/businesses/${h.bid}/directors`)).json.toMove).toEqual([]);
    const mv = await acc.post(`/businesses/${h.bid}/director-entries/move`, { items: d.toMove.map((m: any) => ({ transactionId: m.transactionId, directorId: mohak, kind: m.kind })) });
    expect(mv.status, JSON.stringify(mv.json)).toBe(200);
    // The cash lines stay.
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE id IN (${cashOut}, ${back})`)[0].n).toBe(2);

    // Stock taken: the gas cylinder's cash line goes (no cash left the drawer); Remove brings it back.
    const st = await acc.post(`/businesses/${h.bid}/director-entries`, { transactionId: gas, directorId: vikas, kind: 'stock_taken' });
    expect(st.status, JSON.stringify(st.json)).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE id = ${gas}`)[0].n).toBe(0);
    d = (await acc.get(`/businesses/${h.bid}/directors`)).json;
    const bajaj = d.families.find((f: any) => f.family === 'Bajaj');
    expect(bajaj.people.find((p: any) => p.id === mohak)).toMatchObject({ opening: 100000, takenPaise: 50000, givenPaise: 30000, balancePaise: 120000 });
    expect(d.families.find((f: any) => f.family === 'Kharbanda').balancePaise).toBe(120000);
    expect((await acc.call('DELETE', `/businesses/${h.bid}/director-entries/${st.json.id}`, {})).status).toBe(200);
    expect((await sql`SELECT amount_paise FROM transactions WHERE id = ${gas}`)[0].amount_paise).toBe(120000);

    // A typed line, and the hotel owing someone.
    expect((await acc.post(`/businesses/${h.bid}/director-entries`, { directorId: vikas, kind: 'given', day: '2026-11-02', amount: '200', note: 'Cash to Vikas sir' })).status).toBe(200);
    d = (await acc.get(`/businesses/${h.bid}/directors`)).json;
    expect(d.families.find((f: any) => f.family === 'Kharbanda').people[0].balancePaise).toBe(-20000);
    // Entry staff cannot read the ledger.
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/directors`)).status).toBe(403);
  });

  it('NC at 50% with its income, names asked once, and follows the bill', async () => {
    const { h, acc, deepansh } = await setUp();
    await h.software([['2610501', '31 13:00', 'CASH', '800']]);
    const cmp = bill(await h.view(), '2610501').id;
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${cmp}/complimentary`, { guestName: 'DEEPANSH SIR' })).status).toBe(200);

    let tab = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/complimentary`)).json;
    expect(tab.ncAsk).toEqual([expect.objectContaining({ key: 'deepansh', bills: ['2610501'], valuePaise: 80000, guess: expect.objectContaining({ id: deepansh }) })]);
    // Entry staff are not asked.
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/complimentary`)).json.ncAsk).toEqual([]);
    const s = await acc.post(`/businesses/${h.bid}/nc-names`, { name: 'DEEPANSH SIR', kind: 'director', directorId: deepansh });
    expect(s.json).toMatchObject({ ok: true, added: 1 });
    tab = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/complimentary`)).json;
    expect(tab.ncAsk).toEqual([]);

    const nc = await sql`SELECT e.amount_paise, t.amount_paise AS income, t.type, h.name AS head FROM director_entries e JOIN transactions t ON t.id = e.income_id JOIN heads h ON h.id = t.head_id WHERE e.kind = 'nc'`;
    expect(nc).toEqual([{ amount_paise: 40000, income: 40000, type: 'income', head: 'Director NC' }]);
    const rep = (await h.clients.viewer.get(`/businesses/${h.bid}/reports/complimentary?from=2026-10-31&to=2026-10-31`)).json;
    expect(rep.byName).toEqual([expect.objectContaining({ kind: 'director', person: 'Bajaj · Deepansh', bills: 1, valuePaise: 80000, chargedPaise: 40000 })]);
    // An NC line cannot be removed by hand.
    const id = (await sql`SELECT id FROM director_entries WHERE kind = 'nc'`)[0].id;
    expect((await acc.call('DELETE', `/businesses/${h.bid}/director-entries/${id}`, {})).status).toBe(400);

    // No longer complimentary: the NC line and its income go.
    expect((await acc.call('DELETE', `/businesses/${h.bid}/comparisons/${cmp}/complimentary`, {})).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM director_entries WHERE kind = 'nc'`)[0].n).toBe(0);
    expect((await sql`SELECT count(*) AS n FROM transactions t JOIN heads h ON h.id = t.head_id WHERE h.name = 'Director NC'`)[0].n).toBe(0);
    // Staff: listed, never charged.
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${cmp}/complimentary`, { guestName: 'Ramesh' })).status).toBe(200);
    await acc.post(`/businesses/${h.bid}/nc-names`, { name: 'Ramesh', kind: 'staff' });
    expect((await sql`SELECT count(*) AS n FROM director_entries WHERE kind = 'nc'`)[0].n).toBe(0);
  });
});

describe('approved cash lines', () => {
  it('Owner or Accountant edit or remove one, with Undo; entry staff cannot', async () => {
    const { h, acc, heads, tx, mohak } = await setUp();
    const id = await tx('2026-10-31', 500, 'Tomatoes', heads.veg);
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/expense-rows/${id}`, { narration: 'Tomatoes', amount: '50', headId: heads.veg })).status).toBe(404);
    const e = await acc.put(`/businesses/${h.bid}/expense-rows/${id}`, { narration: 'Tomatoes', amount: '50', headId: heads.veg });
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    expect((await sql`SELECT amount_paise, status FROM transactions WHERE id = ${id}`)[0]).toEqual({ amount_paise: 5000, status: 'approved' });
    expect((await acc.post(`/businesses/${h.bid}/expense-rows/undo/${e.json.auditId}`, {})).status).toBe(200);
    expect((await sql`SELECT amount_paise FROM transactions WHERE id = ${id}`)[0].amount_paise).toBe(50000);

    expect((await h.clients.entry_staff.call('DELETE', `/businesses/${h.bid}/expense-rows/${id}/approved`, {})).status).toBe(403);
    const rm = await acc.call('DELETE', `/businesses/${h.bid}/expense-rows/${id}/approved`, {});
    expect(rm.status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE id = ${id}`)[0].n).toBe(0);
    expect((await acc.post(`/businesses/${h.bid}/expense-rows/undo/${rm.json.auditId}`, {})).status).toBe(200);
    expect((await sql`SELECT amount_paise, narration FROM transactions WHERE id = ${id}`)[0]).toEqual({ amount_paise: 50000, narration: 'Tomatoes' });

    // In a director's account: edits follow it there; it cannot be removed until taken out.
    expect((await acc.post(`/businesses/${h.bid}/director-entries`, { transactionId: id, directorId: mohak, kind: 'taken' })).status).toBe(200);
    expect((await acc.put(`/businesses/${h.bid}/expense-rows/${id}`, { narration: 'Tomatoes', amount: '450', headId: heads.veg })).status).toBe(200);
    expect((await sql`SELECT amount_paise FROM director_entries WHERE transaction_id = ${id}`)[0].amount_paise).toBe(45000);
    expect((await acc.call('DELETE', `/businesses/${h.bid}/expense-rows/${id}/approved`, {})).status).toBe(409);
  });
});
