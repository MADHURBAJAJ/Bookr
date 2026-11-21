// Owner phone app and settling a count short or extra (approved 21 Nov 2026, migration 0035). Invented amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const D19 = '2026-11-19';
const D20 = '2026-11-20';

async function setup() {
  const h = await businessWithAllRoles('Bgi Saharanpur');
  const o = h.clients.owner;
  const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
  const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Anup Maheshwari', branchId: sms, cashierUserId: h.users.entry_staff.id, openingBalance: '10,000', openingDate: D19 })).json.id as string;
  const cashier = h.clients.entry_staff;
  const base = `/businesses/${h.bid}/cashbooks/${book}`;
  const look = async () => (await o.get(`/businesses/${h.bid}/owner-look`)).json;
  return { ...h, o, cashier, book, base, look };
}

describe('settling a count', () => {
  it('short: only the Owner settles; booked as shortage the book agrees; the cashier cannot count again until it is undone', async () => {
    const { o, cashier, base, look, clients } = await setup();
    expect((await cashier.put(`${base}/count/${D19}`, { counted: '9,800', note: 'gave ₹ 200 extra change' })).status).toBe(200);
    expect((await look()).counts).toMatchObject([{ bookName: 'Anup Maheshwari', day: D19, gapPaise: -20000, note: 'gave ₹ 200 extra change' }]);
    expect((await cashier.post(`${base}/count/${D19}/settle`, { how: 'shortage' })).status).toBe(403);
    expect((await clients.accountant.post(`${base}/count/${D19}/settle`, { how: 'shortage' })).status).toBe(403);
    expect((await o.post(`${base}/count/${D19}/settle`, { how: 'extra' })).status).toBe(400);
    const res = await o.post(`${base}/count/${D19}/settle`, { how: 'shortage', note: 'Told him to check change' });
    expect(res.json).toMatchObject({ ok: true, gapPaise: -20000 });
    const d = (await o.get(`${base}/day/${D19}`)).json;
    expect(d.count).toMatchObject({ gapPaise: 0, settle: 'shortage', settleGapPaise: -20000, settleNote: 'Told him to check change' });
    expect(d.entries.find((e: { kind: string }) => e.kind === 'expense')).toMatchObject({ amountPaise: 20000, headName: 'Cash shortage', reviewStatus: 'approved' });
    expect((await look()).counts).toHaveLength(0);
    // The next day starts from what was counted.
    expect((await o.get(`${base}/day/${D20}`)).json.openingPaise).toBe(980000);
    expect((await o.post(`${base}/count/${D19}/settle`, { how: 'shortage' })).status).toBe(409);
    expect((await cashier.put(`${base}/count/${D19}`, { counted: '9,900', note: 'found ₹ 100' })).status).toBe(409);
    // Undo: the shortage line goes and the count is open again.
    expect((await o.del(`${base}/count/${D19}/settle`)).status).toBe(200);
    const u = (await o.get(`${base}/day/${D19}`)).json;
    expect(u.count).toMatchObject({ gapPaise: -20000, settle: null });
    expect(u.entries.filter((e: { kind: string }) => e.kind === 'expense')).toHaveLength(0);
    expect((await look()).counts).toHaveLength(1);
  });

  it('extra given back writes nothing; a short that turns up the next day needs nothing (same money); found it comes back if not added', async () => {
    const { o, cashier, base, look } = await setup();
    // Extra ₹ 300, given back: settled, nothing written; the next day's count agrees.
    await cashier.put(`${base}/count/${D19}`, { counted: '10,300', note: 'parent paid twice' });
    expect((await o.post(`${base}/count/${D19}/settle`, { how: 'shortage' })).status).toBe(400);
    expect((await o.post(`${base}/count/${D19}/settle`, { how: 'given_back' })).status).toBe(200);
    expect((await o.get(`${base}/day/${D19}`)).json.count).toMatchObject({ gapPaise: 30000, settle: 'given_back' });
    expect((await look()).counts).toHaveLength(0);
    await cashier.put(`${base}/count/${D20}`, { counted: '10,000' });
    expect((await look()).counts).toHaveLength(0);
  });

  it('a short not settled clears itself when a later count agrees; found it: the cashier adds the missed line and the day agrees', async () => {
    const { o, cashier, base, look } = await setup();
    await cashier.put(`${base}/count/${D19}`, { counted: '9,500', note: 'not sure' });
    expect((await look()).counts).toHaveLength(1);
    await cashier.put(`${base}/count/${D20}`, { counted: '10,000' });
    expect((await look()).counts).toHaveLength(0);

    await cashier.put(`${base}/count/${D20}`, { counted: '9,500', note: 'bus fare not written' });
    expect((await o.post(`${base}/count/${D20}/settle`, { how: 'found' })).status).toBe(200);
    expect((await look()).counts).toHaveLength(0);
    // The cashier writes the missed line: the day agrees.
    await cashier.post(`${base}/entries`, { day: D20, kind: 'expense', amount: '500', narration: 'Bus fare' });
    expect((await o.get(`${base}/day/${D20}`)).json.count.gapPaise).toBe(0);
  });
});

describe('owner look', () => {
  it('lists cash given to a person, expenses to approve with or without a head, and nothing for the accountant', async () => {
    const { o, cashier, base, look, clients, bid } = await setup();
    await cashier.post(`${base}/entries`, { day: D20, kind: 'handover_out', amount: '5,000', to: { kind: 'person', name: 'Anoop' } });
    await cashier.post(`${base}/entries`, { day: D20, kind: 'expense', amount: '650', narration: 'Plumber' });
    const l = await look();
    expect(l.handovers).toMatchObject([{ toKind: 'person', toName: 'Anoop', amountPaise: 500000 }]);
    expect(l.expenses).toMatchObject([{ narration: 'Plumber', headId: null, bookName: 'Anup Maheshwari' }]);
    expect(l.heads.some((x: { type: string }) => x.type === 'expense')).toBe(true);
    expect((await clients.accountant.get(`/businesses/${bid}/owner-look`)).status).toBe(403);
    // Ticked and approved: the list empties.
    await o.post(`/businesses/${bid}/handovers/${l.handovers[0].id}/receive`, {});
    const head = l.heads.find((x: { type: string }) => x.type === 'expense').id;
    await o.put(`/businesses/${bid}/cashbook-lines/${l.expenses[0].id}/head`, { headId: head });
    await o.post(`/businesses/${bid}/cashbook-lines/${l.expenses[0].id}/review`, { status: 'approved' });
    const after = await look();
    expect(after.handovers).toHaveLength(0);
    expect(after.expenses).toHaveLength(0);
  });
});
