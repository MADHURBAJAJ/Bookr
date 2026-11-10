// Extra credits on Money with no bill (11 Nov 2026): a credit of an amount whose every bill already has its credit is
// money with no bill too, listed (marked extra) and bookable, before and after saving. A credit that a bill still
// without its credit could take is not listed. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('extra credits on Money with no bill', () => {
  it('lists an extra ₹30 credit, not one a waiting bill could take', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 15:00', 'UPI', '30'], ['2610312', '31 16:00', 'UPI', '30'], ['2610313', '31 22:00', 'UPI', '75']]);
    await h.register([{ no: '2610311', amount: '30', pays: [['upi', '30']] }, { no: '2610312', amount: '30', pays: [['upi', '30']] },
      { no: '2610313', amount: '75', pays: [['upi', '75']] }]);
    // Two ₹30 bills paid; a third ₹30 is extra. ₹75 at 10 pm is waiting for a credit; the ₹75 at 2 am could be it.
    const [, , extra, waitingFor] = await h.credits([['31 15:01', 30], ['31 16:01', 30], ['31 18:30', 30], ['1 02:00', 75]]);
    const r = await h.reconcile();
    expect(r.noBill).toMatchObject([{ creditId: extra, extra: 2 }]);
    expect(r.noBill.map((x: any) => x.creditId)).not.toContain(waitingFor);

    await h.decideRest();
    await h.confirm();
    const saved = await h.reconcile();
    expect(saved.noBill.map((x: any) => x.creditId)).toContain(extra);
    expect(saved.noBill.find((x: any) => x.creditId === extra).extra).toBe(2);
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: extra, billType: 'fnb', item: 'tea' }] });
    expect(res.json).toMatchObject({ booked: 1 });
  });

  it('does not list a credit equal to the other side of an undecided bill whose software and register differ', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 13:30', 'UPI', '4410']]);
    await h.register([{ no: '2610311', amount: '4140', pays: [['upi', '4140']] }]);
    const [, other] = await h.credits([['31 13:31', 4140], ['31 13:40', 4410]]);
    expect((await h.reconcile()).noBill.map((x: any) => x.creditId)).not.toContain(other);
    await h.decideRest();
    await h.confirm();
    // Decided (Use register): listed, told it may be the bill's payment if the software was right.
    expect((await h.reconcile()).noBill.find((x: any) => x.creditId === other)?.otherSide).toEqual([{ billNo: '2610311', softwarePaise: 441000, registerPaise: 414000, chose: 'register' }]);
  });

  it('lists an extra credit when a bill of its amount only differs by a discount, and a credit freed by a person\'s choice', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    // 2610311: software ₹32, register ₹30 after a ₹2 discount (they agree). 2610312: ₹32, paid. 2610313: ₹30.
    await h.software([['2610311', '31 12:00', 'UPI', '32'], ['2610312', '31 13:00', 'UPI', '32'], ['2610313', '31 23:30', 'UPI', '30']]);
    await h.register([{ no: '2610311', amount: '32', discount: '2', pays: [['upi', '30']] } as any, { no: '2610312', amount: '32', pays: [['upi', '32']] },
      { no: '2610313', amount: '30', pays: [['upi', '30']] }]);
    const [, , extra32, chosen30, near30] = await h.credits([['31 12:01', 30], ['31 13:01', 32], ['31 14:05', 32], ['31 23:20', 30], ['31 23:31', 30]]);
    const before = await h.reconcile();
    expect(before.noBill.map((x: any) => x.creditId)).toContain(extra32);
    // The person matches bill 2610313 to the 11:20 pm credit: the 11:31 pm one is free again, and extra.
    const c = (await h.view()).json.comparisons.find((x: any) => x.billNo === '2610313');
    const ch = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/choices`, { bankRowId: chosen30, comparisonIds: [c.id] });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    const after = await h.reconcile();
    expect(after.noBill.map((x: any) => x.creditId).sort()).toEqual([extra32, near30].sort());
    expect(after.open.credits.find((x: any) => x.id === near30)?.why).toBe('extra');
  });

  it('lists a credit of the side a person chose against, with that bill named, before and after saving', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 13:30', 'UPI', '32'], ['2610312', '31 15:00', 'UPI', '32']]);
    await h.register([{ no: '2610311', amount: '30', pays: [['upi', '30']] }, { no: '2610312', amount: '32', pays: [['upi', '32']] }]);
    const [, , other] = await h.credits([['31 13:31', 30], ['31 15:01', 32], ['31 17:00', 32]]);
    // Undecided: the ₹32 could be bill 2610311's payment; not listed.
    expect((await h.reconcile()).noBill.map((x: any) => x.creditId)).not.toContain(other);
    await h.decideRest(); // Use register (₹30) for 2610311
    const before = (await h.reconcile()).noBill.find((x: any) => x.creditId === other);
    expect(before?.otherSide).toEqual([{ billNo: '2610311', softwarePaise: 3200, registerPaise: 3000, chose: 'register' }]);
    await h.confirm();
    const after = (await h.reconcile()).noBill.find((x: any) => x.creditId === other);
    expect(after?.otherSide).toEqual([{ billNo: '2610311', softwarePaise: 3200, registerPaise: 3000, chose: 'register' }]);
  });
});
