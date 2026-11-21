// School cash book screens' API (approved 20 Nov 2026). Amounts from the Khatabook example: SMS CR EXP on 15 Sep 2026,
// and Anoop handing ₹4,50,000 to haji ji. Invented people and accounts otherwise.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, businessWithAllRoles, makeUser, resetDb, signIn, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const DAY = '2026-09-15';

async function setup() {
  const h = await businessWithAllRoles('School');
  const o = h.clients.owner;
  const second = await makeUser('cashier2');
  await addMember(h.bid, second.id, 'entry_staff');
  const cashier2 = await signIn(second.email);
  const branch = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
  const book = async (name: string, cashierUserId: string, openingBalance = '0') =>
    (await o.post(`/businesses/${h.bid}/cashbooks`, { name, branchId: branch, cashierUserId, openingBalance, openingDate: DAY })).json.id as string;
  const sms = await book('SMS CR EXP', h.users.entry_staff.id, '84628');
  const haji = await book('Haji ji', second.id);
  const bank = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'ICICI', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id as string;
  const heads = (await o.get(`/businesses/${h.bid}/heads`)).json.heads as { id: string; type: string }[];
  const expenseHead = heads.find((x) => x.type === 'expense')!.id;
  const cashier = h.clients.entry_staff;
  const add = (c: typeof cashier, accountId: string, b: Record<string, unknown>) => c.post(`/businesses/${h.bid}/cashbooks/${accountId}/entries`, { day: DAY, ...b });
  const dayOf = (c: typeof cashier, accountId: string, day = DAY) => c.get(`/businesses/${h.bid}/cashbooks/${accountId}/day/${day}`);
  return { ...h, o, cashier, cashier2, branch, sms, haji, bank, expenseHead, add, dayOf };
}

describe('school cash book', () => {
  it('the cashier writes the day and the book says what should be in hand; the count shows the gap', async () => {
    const s = await setup();
    expect((await s.add(s.cashier, s.sms, { kind: 'fee', amount: '1,14,180', narration: 'chilkana road fee received' })).status).toBe(201);
    for (const [amount, narration] of [['5500', 'stationery exam'], ['2000', 'rk tact'], ['1000', 'hardware']]) {
      expect((await s.add(s.cashier, s.sms, { kind: 'expense', amount, narration, headId: s.expenseHead })).status).toBe(201);
    }
    // An expense needs what it was for, or a head (the accountant sets the head later, 21 Nov 2026).
    expect((await s.add(s.cashier, s.sms, { kind: 'expense', amount: '10' })).json.error).toMatch(/what this was for/);
    let d = (await s.dayOf(s.cashier, s.sms)).json;
    expect(d).toMatchObject({ openingPaise: 8462800, inPaise: 11418000, outPaise: 850000, shouldPaise: 19030800, count: null });
    // A short count needs a note.
    expect((await s.cashier.put(`/businesses/${s.bid}/cashbooks/${s.sms}/count/${DAY}`, { counted: '1,90,000' })).json.error).toMatch(/short ₹ 308\. Write why/);
    expect((await s.cashier.put(`/businesses/${s.bid}/cashbooks/${s.sms}/count/${DAY}`, { counted: '1,90,000', note: 'peon took 308 for gas' })).status).toBe(200);
    d = (await s.dayOf(s.cashier, s.sms)).json;
    expect(d.count).toMatchObject({ gapPaise: -30800, note: 'peon took 308 for gas' });
    // The next day opens with what should have been in hand.
    expect((await s.dayOf(s.cashier, s.sms, '2026-09-16')).json.openingPaise).toBe(19030800);
    const list = (await s.o.get(`/businesses/${s.bid}/cashbooks`)).json;
    expect(list.books.find((b: { id: string }) => b.id === s.sms)).toMatchObject({ inHandPaise: 19030800, lastCount: { day: DAY, gapPaise: -30800 } });
  });

  it('a cashier sees and writes only their own book; the viewer sees all and writes none', async () => {
    const s = await setup();
    expect((await s.dayOf(s.cashier, s.haji)).status).toBe(404);
    expect((await s.add(s.cashier, s.haji, { kind: 'fee', amount: '100' })).status).toBe(404);
    expect((await s.cashier.get(`/businesses/${s.bid}/cashbooks`)).json.books.map((b: { name: string }) => b.name)).toEqual(['SMS CR EXP']);
    expect((await s.dayOf(s.clients.viewer, s.haji)).status).toBe(200);
    expect((await s.add(s.clients.viewer, s.sms, { kind: 'fee', amount: '100' })).status).toBe(403);
    expect((await s.cashier.post(`/businesses/${s.bid}/branches`, { name: 'Other' })).status).toBe(403);
    expect((await s.add(s.clients.accountant, s.haji, { kind: 'fee', amount: '100' })).status).toBe(201);
    const biz = (await s.cashier.get(`/businesses/${s.bid}`)).json;
    expect(biz).toMatchObject({ cashBooks: true, myBooks: 1 });
  });

  it('cash handed to another cashier waits until that cashier accepts it, and can be undone', async () => {
    const s = await setup();
    await s.add(s.cashier, s.sms, { kind: 'fee', amount: '450000' });
    expect((await s.add(s.cashier, s.sms, { kind: 'handover_out', amount: '4,50,000', narration: 'Transfer entry haji ji', to: { kind: 'book', accountId: s.haji } })).status).toBe(201);
    let all = (await s.o.get(`/businesses/${s.bid}/cashbooks`)).json;
    expect(all.handovers).toHaveLength(1);
    expect(all.handovers[0]).toMatchObject({ fromBookName: 'SMS CR EXP', toName: 'Haji ji', status: 'sent', amountPaise: 45000000 });
    const hd = (await s.dayOf(s.cashier2, s.haji)).json;
    expect(hd.waiting).toHaveLength(1);
    // The sender cannot accept for the receiver.
    expect((await s.cashier.post(`/businesses/${s.bid}/handovers/${hd.waiting[0].id}/receive`, {})).status).toBe(404);
    expect((await s.cashier2.post(`/businesses/${s.bid}/handovers/${hd.waiting[0].id}/receive`, { day: DAY })).status).toBe(200);
    expect((await s.dayOf(s.cashier2, s.haji)).json).toMatchObject({ waiting: [], inPaise: 45000000, shouldPaise: 45000000 });
    all = (await s.o.get(`/businesses/${s.bid}/cashbooks`)).json;
    expect(all.handovers).toHaveLength(0);
    expect(all.done[0]).toMatchObject({ status: 'received', settledByName: 'cashier2' });
    // The sender can no longer remove it; the receiver's undo puts it back to waiting.
    const out = (await s.dayOf(s.cashier, s.sms)).json.entries.find((e: { kind: string }) => e.kind === 'handover_out');
    expect((await s.cashier.del(`/businesses/${s.bid}/cashbooks/${s.sms}/entries/${out.id}`)).status).toBe(409);
    expect((await s.cashier2.post(`/businesses/${s.bid}/handovers/${hd.waiting[0].id}/undo`, {})).status).toBe(200);
    expect((await s.dayOf(s.cashier2, s.haji)).json).toMatchObject({ inPaise: 0 });
    expect((await s.cashier.del(`/businesses/${s.bid}/cashbooks/${s.sms}/entries/${out.id}`)).status).toBe(200);
    expect((await s.o.get(`/businesses/${s.bid}/cashbooks`)).json.handovers).toHaveLength(0);
  });

  it('cash given to a person is ticked by the owner; cash taken to the bank is matched to the deposit', async () => {
    const s = await setup();
    await s.add(s.cashier, s.sms, { kind: 'handover_out', amount: '100000', to: { kind: 'person', name: 'Anoop' } });
    await s.add(s.cashier, s.sms, { kind: 'handover_out', amount: '50000', to: { kind: 'bank', accountId: s.bank } });
    const H = (cells: (string | number)[]) => cells.join('\t');
    const lines = [H(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
      H([1, 'S70000001', '16/09/2026', '16/09/2026 11:00:00 AM', '-', 'BY CASH DEPOSIT CHILKANA', 'CR', 50000, '50000'])].join('\n');
    const pasted = await s.o.post(`/businesses/${s.bid}/bank/${s.bank}/paste`, { text: lines }); expect(pasted.json).toMatchObject({ added: 1 });
    const all = (await s.o.get(`/businesses/${s.bid}/cashbooks`)).json;
    const person = all.handovers.find((x: { toKind: string }) => x.toKind === 'person');
    const bank = all.handovers.find((x: { toKind: string }) => x.toKind === 'bank');
    expect(person.toName).toBe('Anoop');
    expect(bank.deposits).toHaveLength(1);
    expect((await s.cashier.post(`/businesses/${s.bid}/handovers/${person.id}/receive`, {})).status).toBe(403);
    expect((await s.o.post(`/businesses/${s.bid}/handovers/${person.id}/receive`, {})).status).toBe(200);
    expect((await s.o.post(`/businesses/${s.bid}/handovers/${bank.id}/deposit`, { bankRowId: bank.deposits[0].id })).status).toBe(200);
    expect((await s.o.get(`/businesses/${s.bid}/cashbooks`)).json.handovers).toHaveLength(0);
    // The same deposit is not offered twice.
    await s.add(s.cashier, s.sms, { kind: 'handover_out', amount: '50000', to: { kind: 'bank', accountId: s.bank } });
    expect((await s.o.get(`/businesses/${s.bid}/cashbooks`)).json.handovers[0].deposits).toHaveLength(0);
  });

  it('a hotel without branches shows no cash books', async () => {
    const h = await businessWithAllRoles('Hotel');
    expect((await h.clients.owner.get(`/businesses/${h.bid}`)).json).toMatchObject({ cashBooks: false, myBooks: 0 });
  });
});
