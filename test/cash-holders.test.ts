// Cash holders (approved 21 Nov 2026): people not at a school who keep a cash book, e.g. a director (an Owner who keeps
// his own book) or a trustee who joins by phone. Cashiers hand cash to them; they take it in, spend, hand on and count,
// without fees. Invented people, numbers and amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const D = '2026-11-20';
const tokenOf = (link: string) => link.split('#/invite/')[1];
const HEAD = ['S.No', 'Enrollment Code', 'Admission No', 'Student Name', 'ReceiptNo', 'Receipt Date', 'Class/Section', 'Remarks',
  'System Generated Receipt No(Online)', 'Academic Year', 'FeeType', 'PaymentMode', 'Cashier', 'Amount'];
const sheet = (cashier: string) => {
  const td = (cells: (string | number)[], tag = 'td') => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  return `<html><body><table>${td(HEAD, 'th')}<tr><td colspan="14">Receipt Date : 20 Nov 2026</td></tr>
    ${td([1, 'E1', 'A1', 'Asha', '26SMSSMS0401', '20 Nov 2026', 'Grade 1', '', '', '2026-2027', 'Tuition Fee', 'Cash', cashier, '3000.00'])}</table></body></html>`;
};

describe('cash holders', () => {
  it('a director who is an Owner keeps his own book: cashiers hand cash to him, he takes it in, spends, hands on and counts, without fees', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    await sql`UPDATE users SET name = 'Anoop Bajaj' WHERE id = ${h.users.owner.id}`;
    const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
    await o.put(`/businesses/${h.bid}/fees/codes/SMSSMS`, { branchId: sms });
    const anup = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Anup Maheshwari', branchId: sms, cashierUserId: h.users.entry_staff.id, openingBalance: '30,000', openingDate: '2026-11-19' })).json.id;
    // A holder is not at a school; the Owner keeps it himself.
    expect((await o.post(`/businesses/${h.bid}/cashbooks`, { holder: true, name: 'Anoop Bajaj (Director)', branchId: sms, openingBalance: '0', openingDate: '2026-11-19' })).status).toBe(400);
    const dir = (await o.post(`/businesses/${h.bid}/cashbooks`, { holder: true, name: 'Anoop Bajaj (Director)', cashierUserId: h.users.owner.id, openingBalance: '40,000', openingDate: '2026-11-19' })).json.id;
    expect((await o.get(`/businesses/${h.bid}`)).json.myBooks).toBe(1);
    let list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.books.find((b: { id: string }) => b.id === dir)).toMatchObject({ branchId: null, cashierName: 'Anoop Bajaj', inHandPaise: 4000000 });

    // The cashier sees the director among where cash can go, and hands ₹ 15,000 over.
    const day = (await h.clients.entry_staff.get(`/businesses/${h.bid}/cashbooks/${anup}/day/${D}`)).json;
    expect(day.targets.find((t: { id: string }) => t.id === dir)).toMatchObject({ branchName: null });
    await h.clients.entry_staff.post(`/businesses/${h.bid}/cashbooks/${anup}/entries`, { day: D, kind: 'handover_out', amount: '15,000', to: { kind: 'book', accountId: dir } });
    const waiting = (await o.get(`/businesses/${h.bid}/cashbooks/${dir}/day/${D}`)).json.waiting;
    expect(waiting).toHaveLength(1);
    expect((await o.post(`/businesses/${h.bid}/handovers/${waiting[0].id}/receive`, { day: D })).status).toBe(200);

    // No fees in a holder's book, and the fee report never fills it, even under the same name.
    expect((await o.post(`/businesses/${h.bid}/cashbooks/${dir}/entries`, { day: D, kind: 'fee', amount: '100' })).status).toBe(400);
    expect((await o.put(`/businesses/${h.bid}/cashbooks/${dir}/fee/${D}`, { amount: '100' })).status).toBe(400);
    await o.post(`/businesses/${h.bid}/fees/import`, { text: sheet('Anoop Bajaj (Director)') });
    expect((await o.get(`/businesses/${h.bid}/cashbooks/${dir}/day/${D}`)).json.entries.filter((e: { feeReportId: string | null }) => e.feeReportId)).toHaveLength(0);
    expect((await o.get(`/businesses/${h.bid}/cashbooks/${anup}/day/${D}`)).json.entries.filter((e: { feeReportId: string | null }) => e.feeReportId)).toHaveLength(1);

    // Money in from outside, an expense, and on to the bank.
    const bank = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'ICICI 7465', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await o.post(`/businesses/${h.bid}/cashbooks/${dir}/entries`, { day: D, kind: 'other_in', amount: '2,000', narration: 'Gift from parents\' committee' });
    await o.post(`/businesses/${h.bid}/cashbooks/${dir}/entries`, { day: D, kind: 'expense', amount: '2,000', narration: 'Diesel for bus' });
    await o.post(`/businesses/${h.bid}/cashbooks/${dir}/entries`, { day: D, kind: 'handover_out', amount: '50,000', to: { kind: 'bank', accountId: bank } });
    const d = (await o.get(`/businesses/${h.bid}/cashbooks/${dir}/day/${D}`)).json;
    expect(d.shouldPaise).toBe(4000000 + 1500000 + 200000 - 200000 - 5000000);
    expect((await o.put(`/businesses/${h.bid}/cashbooks/${dir}/count/${D}`, { counted: '5,000' })).status).toBe(200);
    // A holder's book always has someone who keeps it.
    expect((await o.patch(`/businesses/${h.bid}/cashbooks/${dir}`, { name: 'Anoop Bajaj (Director)' })).json.error).toMatch(/who keeps/);
    expect((await o.patch(`/businesses/${h.bid}/cashbooks/${dir}`, { name: 'Anoop Bajaj (MD)', cashierUserId: h.users.owner.id })).status).toBe(200);
    list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.books.find((b: { id: string }) => b.id === dir)).toMatchObject({ name: 'Anoop Bajaj (MD)', branchId: null, inHandPaise: 500000 });
  });

  it('a trustee added as a cash holder shows until he joins by phone, then keeps the book as Entry staff', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' });
    const tr = (await o.post(`/businesses/${h.bid}/cashbooks`, { holder: true, name: 'Rakesh Gupta (Trustee)', openingBalance: '0', openingDate: '2026-11-19' })).json.id;
    let list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.books.map((b: { id: string }) => b.id)).not.toContain(tr);
    expect(list.pendingHolders).toMatchObject([{ id: tr, name: 'Rakesh Gupta (Trustee)', invite: null }]);
    const inv = await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 77777', role: 'entry_staff', accountId: tr });
    expect(inv.status).toBe(201);
    list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.pendingHolders[0].invite).toMatchObject({ phone: '+919412077777' });
    const guest = new Client();
    expect((await guest.post(`/invites/${tokenOf(inv.json.link)}/accept`, { name: 'Rakesh Gupta', password: 'long-enough-pw' })).status).toBe(200);
    list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.pendingHolders).toHaveLength(0);
    expect(list.books.find((b: { id: string }) => b.id === tr)).toMatchObject({ branchId: null, cashierName: 'Rakesh Gupta' });
    expect((await guest.get(`/businesses/${h.bid}/cashbooks`)).json.books.map((b: { id: string }) => b.id)).toEqual([tr]);
    expect((await guest.post(`/businesses/${h.bid}/cashbooks/${tr}/entries`, { day: D, kind: 'other_in', amount: '500', narration: 'Refund from vendor' })).status).toBe(201);
  });
});
