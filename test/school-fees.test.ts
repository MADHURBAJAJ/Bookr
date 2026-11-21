// Fee check (approved 20 Nov 2026): the FeeDaySheet report (a web page table) brought into a school business.
// Invented students, cashiers and amounts, in the layout of the real report.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, businessWithAllRoles, makeUser, resetDb, sql } from './helpers';
import { parseFeeReport, receiptCode } from '../src/feereport';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const HEAD = ['S.No', 'Enrollment Code', 'Admission No', 'Student Name', 'ReceiptNo', 'Receipt Date', 'Class/Section', 'Remarks',
  'System Generated Receipt No(Online)', 'Academic Year', 'FeeType', 'PaymentMode', 'Cashier', 'Amount'];
type L = [string, string, string, string, string, number];   // receipt, student, fee type, mode, cashier, rupees
function sheet(day: string, lines: L[]) {
  const td = (cells: (string | number)[], tag = 'td') => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  const rows = lines.map(([rc, st, fee, mode, cashier, amt], i) => td([i + 1, 'E1', 'A1', st, rc, day, 'Grade 1 &gt;&gt; A', '', rc, '2026-2027', fee, mode, cashier, amt.toFixed(2)]));
  const total = lines.reduce((t, l) => t + l[5], 0);
  return `<html><body><table>${td(HEAD, 'th')}<tr><td colspan="14">Receipt Date : ${day}</td></tr>${rows.join('')}
    <tr><td colspan="13">${day} : Total Amount</td><td>${total.toFixed(2)}</td></tr>
    <tr><td colspan="13">Google Pay : 100.00,  Paytm : 50.00           UPI</td><td>150.00</td></tr>
    <tr><td colspan="13">Net Payment</td><td>${total.toFixed(2)}</td></tr></table></body></html>`;
}
const DAY = '20 Nov 2026';
const LINES: L[] = [
  ['26SMSSMS0001', 'Asha', 'Tuition Fee(Quarter 2)', 'Cash', 'ANUP  MAHESHWARI', 5000],
  ['26SMSSMS0001', 'Asha', 'ID Card Fee(Installment 1)', 'Cash', 'ANUP  MAHESHWARI', 130],
  ['26SMSSMS0002', 'Bilal', 'Tuition Fee(Quarter 2)', 'UPI', 'ANUP  MAHESHWARI', 100],
  ['26SMSSMS0003', 'Chetan', 'Tuition Fee(Quarter 2)', 'Cash', "ST.MARY'S SCHOOL", 300],
  ['26BISBIS0004', 'Diya', 'Tuition Fee(Installment 3)', 'Cash', 'RAVI KUMAR', 2000],
  ['26BISBIS0005', 'Esha', 'Tuition Fee(Installment 3)', 'Bank Transfers', 'RAVI KUMAR', 12750],
  ['26BISPBIST0006', 'Farhan', 'Tuition Fee(Installment 1)', 'Credit / debit card swipe', 'OTHER CASHIER', 9000],
];

describe('fee report', () => {
  it('reads the lines, the day, the school code and the report\'s own totals', () => {
    const r = parseFeeReport(sheet(DAY, LINES));
    expect(r.day).toBe('2026-11-20');
    expect(r.lines).toHaveLength(7);
    expect(r.lines[0]).toMatchObject({ receiptNo: '26SMSSMS0001', code: 'SMSSMS', mode: 'cash', cashier: 'ANUP MAHESHWARI', amountPaise: 500000, classSection: 'Grade 1 >> A' });
    expect(r.lines.map((l) => l.mode)).toEqual(['cash', 'cash', 'upi', 'cash', 'cash', 'bank', 'card']);
    expect(r.footer.find((f) => f.label === 'UPI')).toMatchObject({ amountPaise: 15000, detail: 'Google Pay : 100.00, Paytm : 50.00' });
    expect(receiptCode('26BISPBIST4352')).toBe('BISPBIST');
    expect(() => parseFeeReport('<table><tr><td>hello</td></tr></table>')).toThrow(/not a fee day sheet/);
  });

  it('fills each cashier\'s book with their cash fees, leaves other codes out, and refills when a code or name is linked', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    const anup = await makeUser('Anup Maheshwari');
    await addMember(h.bid, anup.id, 'entry_staff');
    const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'SMS' })).json.id;
    const bis = (await o.post(`/businesses/${h.bid}/branches`, { name: 'BIS' })).json.id;
    // The book's cashier is named like the report (spaces and case aside), so it is found on its own.
    await sql`UPDATE users SET name = 'Anup Maheshwari' WHERE id = ${anup.id}`;
    const anupBook = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'SMS cash', branchId: sms, cashierUserId: anup.id, openingBalance: '0', openingDate: '2026-11-01' })).json.id;
    const raviBook = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'BIS cash', branchId: bis, cashierUserId: h.users.entry_staff.id, openingBalance: '0', openingDate: '2026-11-01' })).json.id;
    const imp = await h.clients.entry_staff.post(`/businesses/${h.bid}/fees/import`, { fileName: 'FeeDaySheet.xls', text: sheet(DAY, LINES) });
    expect(imp.status).toBe(201);
    let d = (await o.get(`/businesses/${h.bid}/fees/2026-11-20`)).json;
    expect(d.codes.map((c: { code: string; state: string }) => `${c.code}:${c.state}`).sort()).toEqual(['BISBIS:unknown', 'BISPBIST:unknown', 'SMSSMS:unknown']);
    expect(d.totalPaise).toBe(0);
    await o.put(`/businesses/${h.bid}/fees/codes/SMSSMS`, { branchId: sms });
    await o.put(`/businesses/${h.bid}/fees/codes/BISBIS`, { branchId: bis });
    await o.put(`/businesses/${h.bid}/fees/codes/BISPBIST`, { branchId: null });
    d = (await o.get(`/businesses/${h.bid}/fees/2026-11-20`)).json;
    expect(d.totals).toMatchObject({ cash: 743000, upi: 10000, bank: 1275000, card: 0 });
    const anupRow = d.cashiers.find((x: { name: string }) => x.name === 'ANUP MAHESHWARI');
    expect(anupRow).toMatchObject({ cashPaise: 513000, book: { id: anupBook, how: 'same name' }, filledPaise: 543000 });
    // ST.MARY'S SCHOOL is not a person: its branch has one book, so its cash goes there by default (21 Nov 2026).
    expect(d.cashiers.find((x: { name: string }) => x.name === "ST.MARY'S SCHOOL")).toMatchObject({ cashPaise: 30000, book: { id: anupBook, how: 'branch' }, filledPaise: 543000 });
    // A name can be given a separate book: here BIS cash, then back to Anup's.
    await o.put(`/businesses/${h.bid}/fees/cashiers`, { name: "ST.MARY'S SCHOOL", accountId: raviBook });
    expect((await o.get(`/businesses/${h.bid}/cashbooks/${raviBook}/day/2026-11-20`)).json.entries.map((e: { amountPaise: number }) => e.amountPaise)).toEqual([230000]);
    await o.put(`/businesses/${h.bid}/fees/cashiers`, { name: "ST.MARY'S SCHOOL", accountId: anupBook });
    await o.put(`/businesses/${h.bid}/fees/cashiers`, { name: 'RAVI KUMAR', accountId: raviBook });
    const book = (await h.clients.owner.get(`/businesses/${h.bid}/cashbooks/${anupBook}/day/2026-11-20`)).json;
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0]).toMatchObject({ kind: 'fee', amountPaise: 543000, narration: 'Cash fees from fee report (2 receipts)' });
    expect(book.entries[0].feeReportId).toBeTruthy();
    // A filled line cannot be removed by hand; bringing the day in again replaces it, not adds to it.
    expect((await o.del(`/businesses/${h.bid}/cashbooks/${anupBook}/entries/${book.entries[0].id}`)).status).toBe(409);
    expect((await o.post(`/businesses/${h.bid}/fees/import`, { text: sheet(DAY, LINES.slice(0, 2)) })).status).toBe(201);
    const again = (await h.clients.owner.get(`/businesses/${h.bid}/cashbooks/${anupBook}/day/2026-11-20`)).json;
    expect(again.entries.map((e: { amountPaise: number }) => e.amountPaise)).toEqual([513000]);
    // That file covered only SMS (21 Nov 2026): BIS keeps the lines of the earlier file, so Ravi's cash stays.
    expect((await h.clients.owner.get(`/businesses/${h.bid}/cashbooks/${raviBook}/day/2026-11-20`)).json.entries.map((e: { amountPaise: number }) => e.amountPaise)).toEqual([200000]);
    expect((await o.get(`/businesses/${h.bid}/fees/2026-11-20`)).json.totals).toMatchObject({ cash: 713000, bank: 1275000 });
    // Only Owner/Accountant link codes and names.
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/fees/codes/SMSSMS`, { branchId: sms })).status).toBe(403);
  });

  it('a bank transfer receipt is matched to its credit', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    const bis = (await o.post(`/businesses/${h.bid}/branches`, { name: 'BIS' })).json.id;
    await o.put(`/businesses/${h.bid}/fees/codes/BISBIS`, { branchId: bis });
    const bank = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'ICICI', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    const T = (cells: (string | number)[]) => cells.join('\t');
    const lines = [T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
      T([1, 'S81000001', '21/11/2026', '21/11/2026 10:00:00 AM', '-', 'IMPS/P2A/123/ESHA PARENT', 'CR', 12750, '12750'])].join('\n');
    expect((await o.post(`/businesses/${h.bid}/bank/${bank}/paste`, { text: lines })).json).toMatchObject({ added: 1 });
    await o.post(`/businesses/${h.bid}/fees/import`, { text: sheet(DAY, LINES) });
    let d = (await o.get(`/businesses/${h.bid}/fees/2026-11-20`)).json;
    expect(d.bank).toHaveLength(1);
    expect(d.bank[0]).toMatchObject({ receiptNo: '26BISBIS0005', amountPaise: 1275000, match: null });
    expect(d.bank[0].candidates).toHaveLength(1);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/fees/receipts/26BISBIS0005/match`, { bankRowId: d.bank[0].candidates[0].id })).status).toBe(403);
    expect((await o.post(`/businesses/${h.bid}/fees/receipts/26BISBIS0005/match`, { bankRowId: d.bank[0].candidates[0].id })).status).toBe(200);
    d = (await o.get(`/businesses/${h.bid}/fees/2026-11-20`)).json;
    expect(d.bank[0].match).toMatchObject({ accountName: 'ICICI', day: '2026-11-21' });
    expect((await o.del(`/businesses/${h.bid}/fees/receipts/26BISBIS0005/match`)).status).toBe(200);
    expect((await o.get(`/businesses/${h.bid}/fees/2026-11-20`)).json.bank[0].match).toBeNull();
  });

  it('one file brought into one business is also brought into the other school business it covers', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
    await o.put(`/businesses/${h.bid}/fees/codes/SMSSMS`, { branchId: sms });
    const mumbai = (await o.post('/businesses', { name: 'Bis Mumbai', fyStart: '2026-04-01' })).json.id;
    const taloja = (await o.post(`/businesses/${mumbai}/branches`, { name: 'Taloja' })).json.id;
    await o.put(`/businesses/${mumbai}/fees/codes/BISPBIST`, { branchId: taloja });
    await o.post(`/businesses/${mumbai}/cashbooks`, { name: 'OTHER CASHIER', branchId: taloja, openingBalance: '0', openingDate: '2026-11-01' });
    const res = await o.post(`/businesses/${h.bid}/fees/import`, { fileName: 'FeeDaySheet.xls', text: sheet(DAY, LINES) });
    expect(res.status).toBe(201);
    expect(res.json.also).toEqual([{ businessId: mumbai, name: 'Bis Mumbai', receipts: 1, paise: 900000 }]);
    expect((await o.get(`/businesses/${mumbai}/fees/2026-11-20`)).json).toMatchObject({ totalPaise: 900000, totals: { card: 900000 } });
    // A cashier who is only in Bgi Saharanpur fills only Bgi Saharanpur.
    const only = await h.clients.entry_staff.post(`/businesses/${h.bid}/fees/import`, { text: sheet(DAY, LINES) });
    expect(only.json.also).toEqual([]);
  });
});
