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

describe('cash on the way', () => {
  it('cash sent to another book or the bank needs the Owner after a day; sent to the Owner\'s own book at once; Got it for them goes in on the day sent', async () => {
    const { o, cashier, base, look, bid, users } = await setup();
    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const sms = (await o.get(`/businesses/${bid}/cashbooks`)).json.branches[0].id;
    const tt = (await o.post(`/businesses/${bid}/cashbooks`, { name: 'Tiny Tots Pilkhantala', branchId: sms, openingBalance: '0', openingDate: D19 })).json.id;
    const mine = (await o.post(`/businesses/${bid}/cashbooks`, { holder: true, name: 'Director', cashierUserId: users.owner.id, openingBalance: '0', openingDate: D19 })).json.id;
    const bank = (await o.post(`/businesses/${bid}/accounts`, { name: 'ICICI 7465', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await cashier.post(`${base}/entries`, { day: today, kind: 'handover_out', amount: '1,000', to: { kind: 'book', accountId: tt } });
    await cashier.post(`${base}/entries`, { day: today, kind: 'handover_out', amount: '2,000', to: { kind: 'book', accountId: mine } });
    await cashier.post(`${base}/entries`, { day: D19, kind: 'handover_out', amount: '3,000', to: { kind: 'book', accountId: tt } });
    await cashier.post(`${base}/entries`, { day: D19, kind: 'handover_out', amount: '4,000', to: { kind: 'bank', accountId: bank } });
    const l = await look();
    // Today's ₹ 1,000 to another book is only on the way; the rest need a look.
    expect(l.handovers.map((h: { amountPaise: number }) => h.amountPaise).sort()).toEqual([200000, 300000, 400000]);
    expect(l.handovers.find((h: { amountPaise: number }) => h.amountPaise === 200000)).toMatchObject({ mine: true });
    expect(l.handovers.find((h: { amountPaise: number }) => h.amountPaise === 400000)).toMatchObject({ toKind: 'bank', deposits: [] });
    // Got it for them: into Tiny Tots' book on 19 Nov, the day it was sent.
    const old = l.handovers.find((h: { amountPaise: number }) => h.amountPaise === 300000);
    expect((await o.post(`/businesses/${bid}/handovers/${old.id}/receive`, {})).status).toBe(200);
    const d19 = (await o.get(`/businesses/${bid}/cashbooks/${tt}/day/${D19}`)).json;
    expect(d19.entries.find((e: { kind: string }) => e.kind === 'handover_in')).toMatchObject({ amountPaise: 300000 });
    expect((await look()).handovers).toHaveLength(2);
    // Undo puts it back on the way.
    expect((await o.post(`/businesses/${bid}/handovers/${old.id}/undo`, {})).status).toBe(200);
    expect((await look()).handovers).toHaveLength(3);
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
