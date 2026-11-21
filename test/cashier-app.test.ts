// Cashier phone app (approved 21 Nov 2026, migration 0033): the day's fee cash as one total against the fee day sheet,
// extra receipts, expenses reviewed by the accountant and the owner, a note on a short count, and a sheet per school.
// Invented students, receipts and amounts in the layout of the real FeeDaySheet.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const HEAD = ['S.No', 'Enrollment Code', 'Admission No', 'Student Name', 'ReceiptNo', 'Receipt Date', 'Class/Section', 'Remarks',
  'System Generated Receipt No(Online)', 'Academic Year', 'FeeType', 'PaymentMode', 'Cashier', 'Amount'];
type L = [string, string, number, string?];   // receipt, mode, rupees, cashier
function sheet(day: string, lines: L[]) {
  const td = (cells: (string | number)[], tag = 'td') => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  const rows = lines.map(([rc, mode, amt, who], i) => td([i + 1, 'E1', 'A1', 'Student', rc, day, 'Grade 1 &gt;&gt; A', '', rc, '2026-2027', 'Tuition Fee', mode, who ?? 'ANUP MAHESHWARI', amt.toFixed(2)]));
  const total = lines.reduce((t, l) => t + l[2], 0);
  return `<html><body><table>${td(HEAD, 'th')}<tr><td colspan="14">Receipt Date : ${day}</td></tr>${rows.join('')}
    <tr><td colspan="13">${day} : Total Amount</td><td>${total.toFixed(2)}</td></tr></table></body></html>`;
}
const D20 = '2026-11-20';
// 0401–0407 in cash on 20 Nov: ₹ 23,500. 0408 (₹ 1,500) is made after the sheet was taken out.
const SMS20: L[] = [['26SMSSMS0401', 'Cash', 3000], ['26SMSSMS0402', 'Cash', 4000], ['26SMSSMS0403', 'Cash', 2000], ['26SMSSMS0404', 'Cash', 5000],
  ['26SMSSMS0405', 'Cash', 4000], ['26SMSSMS0406', 'Cash', 3500], ['26SMSSMS0407', 'Cash', 2000]];

async function setup() {
  const h = await businessWithAllRoles('Bgi Saharanpur');
  const o = h.clients.owner;
  const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
  const bis = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Bajaj International' })).json.id;
  await o.put(`/businesses/${h.bid}/fees/codes/SMSSMS`, { branchId: sms });
  await o.put(`/businesses/${h.bid}/fees/codes/BISBIS`, { branchId: bis });
  const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Anup Maheshwari', branchId: sms, cashierUserId: h.users.entry_staff.id, openingBalance: '20,450', openingDate: '2026-11-19' })).json.id as string;
  const bisBook = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Rajesh Kumar', branchId: bis, openingBalance: '0', openingDate: '2026-11-19' })).json.id as string;
  const cashier = h.clients.entry_staff;
  const base = `/businesses/${h.bid}/cashbooks/${book}`;
  const day = async (d = D20) => (await cashier.get(`${base}/day/${d}`)).json;
  return { ...h, o, cashier, sms, bis, book, bisBook, base, day };
}

describe('cashier app', () => {
  it('the day\'s fee total counts until the sheet is in; a sheet with less is kept, then clears when a later sheet has the receipt', async () => {
    const s = await setup();
    expect((await s.cashier.put(`${s.base}/fee/${D20}`, { amount: '25,000', receipts: 8, first: '0401', last: '0399' })).json.error).toMatch(/must come after the first/);
    expect((await s.cashier.put(`${s.base}/fee/${D20}`, { amount: '25,000', receipts: 8, first: '0401' })).json.error).toMatch(/both the first and the last/);
    expect((await s.cashier.put(`${s.base}/fee/${D20}`, { amount: '24,000', receipts: 7 })).status).toBe(200);
    // Entered again: replaces, not adds.
    expect((await s.cashier.put(`${s.base}/fee/${D20}`, { amount: '25,000', receipts: 8, first: '0401', last: '0408' })).status).toBe(200);
    let d = await s.day();
    expect(d.fee).toMatchObject({ state: 'waiting', typedPaise: 2500000, receipts: 8, first: '0401', last: '0408', sheetIn: false });
    expect(d.shouldPaise).toBe(2045000 + 2500000);

    expect((await s.cashier.post(`/businesses/${s.bid}/fees/import`, { text: sheet('20 Nov 2026', SMS20) })).status).toBe(201);
    d = await s.day();
    expect(d.fee).toMatchObject({ state: 'less', sheetIn: true, sheetPaise: 2350000, sheetReceipts: 7, diffPaise: 150000, missing: ['0408'], countsPaise: 0 });
    expect(d.shouldPaise).toBe(2045000 + 2350000);
    // Once the sheet is in the total cannot change; the difference is sorted out instead.
    expect((await s.cashier.put(`${s.base}/fee/${D20}`, { amount: '23,500' })).status).toBe(409);
    expect((await s.cashier.put(`${s.base}/fee/${D20}/settle`, { how: 'kept' })).status).toBe(200);
    d = await s.day();
    expect(d.fee).toMatchObject({ state: 'kept', countsPaise: 150000 });
    expect(d.shouldPaise).toBe(2045000 + 2500000);
    expect((await s.cashier.get(`/businesses/${s.bid}/cashbooks`)).json.books[0].inHandPaise).toBe(2045000 + 2500000);

    // 21 Nov's sheet has 0408: the 20 Nov difference clears and 21 Nov counts it, once.
    expect((await s.cashier.post(`/businesses/${s.bid}/fees/import`, { text: sheet('21 Nov 2026', [['26SMSSMS0408', 'Cash', 1500]]) })).status).toBe(201);
    d = await s.day();
    expect(d.fee).toMatchObject({ state: 'cleared', countsPaise: 0 });
    expect((await s.day('2026-11-21')).shouldPaise).toBe(2045000 + 2350000 + 150000);
    const days = (await s.cashier.get(`${s.base}/days`)).json.days;
    expect(days.find((x: { day: string }) => x.day === D20)).toMatchObject({ shouldPaise: 2045000 + 2350000, fee: { state: 'cleared' } });
    expect(days.find((x: { day: string }) => x.day === '2026-11-21')).toMatchObject({ shouldPaise: 2045000 + 2350000 + 150000, fee: { state: 'sheet only' } });
  });

  it('a sheet with more than the cashier entered: the book uses the sheet, and the cashier says it is right', async () => {
    const s = await setup();
    await s.cashier.put(`${s.base}/fee/${D20}`, { amount: '23,000' });
    await s.cashier.post(`/businesses/${s.bid}/fees/import`, { text: sheet('20 Nov 2026', SMS20) });
    let d = await s.day();
    expect(d.fee).toMatchObject({ state: 'more', diffPaise: -50000, missing: [] });
    expect(d.shouldPaise).toBe(2045000 + 2350000);
    expect((await s.cashier.put(`${s.base}/fee/${D20}/settle`, { how: 'kept' })).status).toBe(400);
    expect((await s.cashier.put(`${s.base}/fee/${D20}/settle`, { how: 'sheet' })).status).toBe(200);
    d = await s.day();
    expect(d.fee.state).toBe('sheet');
    // The count against the sheet: short needs a note.
    expect((await s.cashier.put(`${s.base}/count/${D20}`, { counted: '43,450' })).json.error).toMatch(/short ₹ 500\. Write why/);
    expect((await s.cashier.put(`${s.base}/count/${D20}`, { counted: '43,950' })).status).toBe(200);
  });

  it('a school\'s own sheet and the all-schools sheet next day never wipe out or count a school twice', async () => {
    const s = await setup();
    const bisLine: L = ['26BISBIS0900', 'Cash', 7000, 'RAJESH KUMAR'];
    // The BIS cashier's own sheet first, then Anup's for Chilkana Road only.
    await s.o.post(`/businesses/${s.bid}/fees/import`, { text: sheet('20 Nov 2026', [bisLine]) });
    await s.cashier.post(`/businesses/${s.bid}/fees/import`, { text: sheet('20 Nov 2026', SMS20) });
    const cashOf = async (b: string) => (await s.o.get(`/businesses/${s.bid}/cashbooks/${b}/day/${D20}`)).json.entries
      .filter((e: { feeReportId: string | null }) => e.feeReportId).map((e: { amountPaise: number }) => e.amountPaise);
    expect(await cashOf(s.book)).toEqual([2350000]);
    expect(await cashOf(s.bisBook)).toEqual([700000]);
    // The accountant brings in the all-schools sheet: the same figures, not doubled.
    await s.clients.accountant.post(`/businesses/${s.bid}/fees/import`, { text: sheet('20 Nov 2026', [...SMS20, bisLine]) });
    expect(await cashOf(s.book)).toEqual([2350000]);
    expect(await cashOf(s.bisBook)).toEqual([700000]);
    expect((await s.o.get(`/businesses/${s.bid}/fees/${D20}`)).json.totals.cash).toBe(3050000);
  });

  it('an expense: the cashier writes what for, the accountant sets the head, the owner approves or rejects with a note', async () => {
    const s = await setup();
    const heads = (await s.o.get(`/businesses/${s.bid}/heads`)).json.heads as { id: string; type: string; name: string }[];
    const exp = heads.find((x) => x.type === 'expense')!.id;
    const inc = heads.find((x) => x.type === 'income')!.id;
    const add = (b: Record<string, unknown>) => s.cashier.post(`${s.base}/entries`, { day: D20, ...b });
    const e1 = (await add({ kind: 'expense', amount: '450', narration: 'Registers and chalk' })).json.id;
    const e2 = (await add({ kind: 'expense', amount: '300', narration: 'Tea for staff' })).json.id;
    const x1 = (await add({ kind: 'other_in', amount: '600', narration: 'Admission form · slip M-118' })).json.id;
    expect((await add({ kind: 'other_in', amount: '200' })).status).toBe(400);
    const d = await s.day();
    expect(d.shouldPaise).toBe(2045000 - 45000 - 30000 + 60000);

    let r = (await s.clients.accountant.get(`/businesses/${s.bid}/cashbook-reviews`)).json;
    expect(r.lines.map((l: { id: string }) => l.id).sort()).toEqual([e1, e2, x1].sort());
    expect(r.can.approve).toBe(false);
    expect((await s.cashier.get(`/businesses/${s.bid}/cashbook-reviews`)).status).toBe(403);
    // The head must be of the right kind.
    expect((await s.clients.accountant.put(`/businesses/${s.bid}/cashbook-lines/${x1}/head`, { headId: exp })).status).toBe(400);
    expect((await s.clients.accountant.put(`/businesses/${s.bid}/cashbook-lines/${x1}/head`, { headId: inc })).status).toBe(200);
    expect((await s.o.post(`/businesses/${s.bid}/cashbook-lines/${e1}/review`, { status: 'approved' })).json.error).toMatch(/sets the head first/);
    await s.clients.accountant.put(`/businesses/${s.bid}/cashbook-lines/${e1}/head`, { headId: exp });
    await s.clients.accountant.put(`/businesses/${s.bid}/cashbook-lines/${e2}/head`, { headId: exp });
    expect((await s.clients.accountant.post(`/businesses/${s.bid}/cashbook-lines/${e1}/review`, { status: 'approved' })).status).toBe(403);
    expect((await s.o.post(`/businesses/${s.bid}/cashbook-lines/${e1}/review`, { status: 'approved' })).status).toBe(200);
    expect((await s.o.post(`/businesses/${s.bid}/cashbook-lines/${e2}/review`, { status: 'rejected' })).json.error).toMatch(/why it is rejected/);
    expect((await s.o.post(`/businesses/${s.bid}/cashbook-lines/${e2}/review`, { status: 'rejected', note: 'Staff tea is not a school expense' })).status).toBe(200);
    r = (await s.o.get(`/businesses/${s.bid}/cashbook-reviews`)).json;
    expect(r.lines).toHaveLength(0);
    // The cashier sees the outcome; the cash still left the book; a reviewed line cannot be removed.
    const lines = (await s.cashier.get(`${s.base}/lines`)).json.lines as { id: string; reviewStatus: string | null; reviewNote: string | null; headName: string | null }[];
    expect(lines.find((l) => l.id === e2)).toMatchObject({ reviewStatus: 'rejected', reviewNote: 'Staff tea is not a school expense' });
    expect(lines.find((l) => l.id === e1)?.reviewStatus).toBe('approved');
    expect((await s.day()).shouldPaise).toBe(2045000 - 45000 - 30000 + 60000);
    expect((await s.cashier.del(`${s.base}/entries/${e1}`)).status).toBe(409);
    expect((await s.clients.accountant.put(`/businesses/${s.bid}/cashbook-lines/${e1}/head`, { headId: exp })).status).toBe(409);
  });
});
