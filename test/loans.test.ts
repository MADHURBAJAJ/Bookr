// Loans (approved 24 Nov 2026): money in and out of loans and deposits from Bank lines, not income or expenses; an
// EMI's interest under a head; a remembered UPI ID suggests the loan on its next line, never booked by itself; opening
// the line again takes it all back. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('loans', () => {
  it('books bank lines to loans taken and given, splits interest, remembers, and undoes', async () => {
    const h = await hotel();
    const base = `/businesses/${h.bid}`;
    const acc = h.clients.accountant;
    await h.account('HUF A', 'UPI XOXO');
    const { ids: [lent, emi, again, advance] } = await h.lines([
      ['31 10:00', 50000, 'CR', 'UPI/700000000001/loan/lender77@okaxis/SAMPLE BANK/ICIa'],
      ['31 11:00', 6000, 'DR', 'NACH/EMI/SAMPLE FINANCE LTD/LN00123'],
      ['31 12:00', 10000, 'CR', 'UPI/700000000002/more/lender77@okaxis/SAMPLE BANK/ICIa'],
      ['31 13:00', 3000, 'DR', 'UPI/700000000003/advance/staffone@okaxis/SAMPLE BANK/ICIa'],
    ]);
    const [exp] = await sql`INSERT INTO heads (id, business_id, name, type, created_at) VALUES (${crypto.randomUUID()}, ${h.bid}, 'Interest paid', 'expense', ${Date.now()}) RETURNING id`;

    // Only an Owner or Accountant books to a loan.
    expect((await h.clients.entry_staff.post(`${base}/bank-rows/${lent}/loan`, { newLoan: { name: 'Asha (lender)', kind: 'taken' } })).status).toBe(403);
    const r1 = await acc.post(`${base}/bank-rows/${lent}/loan`, { newLoan: { name: 'Asha (lender)', kind: 'taken' }, remember: 'lender77@okaxis' });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const asha = r1.json.loanId;
    // An EMI: principal lowers the loan, interest goes under the head.
    const car = (await acc.post(`${base}/loans`, { name: 'Sample car loan', kind: 'taken', opening: '100000', openingDay: '2026-10-30' })).json.id;
    expect((await acc.post(`${base}/bank-rows/${emi}/loan`, { loanId: car, interest: '1000' })).status, 'interest needs its head').toBe(400);
    expect((await acc.post(`${base}/bank-rows/${emi}/loan`, { loanId: car, interest: '1000', interestHeadId: exp.id })).status).toBe(200);
    // A loan given: a staff advance.
    expect((await acc.post(`${base}/bank-rows/${advance}/loan`, { newLoan: { name: 'Staff One', kind: 'given' } })).status).toBe(200);

    // The remembered UPI ID suggests the loan on its next line, unbooked.
    const rows = (await acc.get(`${base}/bank-rows?from=2026-10-30&to=2026-11-02`)).json.rows;
    expect(rows.find((r: any) => r.id === again)).toMatchObject({ status: 'unmatched', loan: { id: asha, name: 'Asha (lender)', kind: 'taken' } });
    expect(rows.find((r: any) => r.id === lent)).toMatchObject({ status: 'booked', note: 'Loan · Asha (lender) · received' });
    expect((await acc.post(`${base}/bank-rows/${again}/loan`, { loanId: asha })).status).toBe(200);

    let l = (await acc.get(`${base}/loans`)).json.loans;
    const by = (n: string) => l.find((x: any) => x.name === n);
    expect(by('Asha (lender)')).toMatchObject({ kind: 'taken', companyOwes: true, balancePaise: 6000000, keys: ['lender77@okaxis'] });
    expect(by('Sample car loan')).toMatchObject({ balancePaise: 10000000 - 500000, interestPaise: 100000 });
    expect(by('Staff One')).toMatchObject({ kind: 'given', companyOwes: false, balancePaise: 300000 });
    // Not income; the interest is an expense under its head; the loan rows are transfers.
    const tx = await sql`SELECT type, amount_paise, head_id FROM transactions WHERE business_id = ${h.bid} AND source = 'bank_sheet' ORDER BY amount_paise`;
    expect(tx).toEqual([{ type: 'expense', amount_paise: 100000, head_id: exp.id }, { type: 'transfer', amount_paise: 300000, head_id: null },
      { type: 'transfer', amount_paise: 500000, head_id: null }, { type: 'transfer', amount_paise: 1000000, head_id: null }, { type: 'transfer', amount_paise: 5000000, head_id: null }]);

    // A typed line (cash repaid by the staff member), and its removal.
    const typed = (await acc.post(`${base}/loans/${by('Staff One').id}/entries`, { direction: 'in', day: '2026-11-01', amount: '1000', note: 'cash' })).json.id;
    l = (await acc.get(`${base}/loans`)).json.loans;
    expect(by('Staff One').balancePaise).toBe(200000);
    expect((await acc.del(`${base}/loan-entries/${typed}`)).status).toBe(200);
    // A bank line is undone on Bank, not here.
    const fromBank = by('Sample car loan').lines[0].id;
    expect((await acc.del(`${base}/loan-entries/${fromBank}`)).status).toBe(409);
    expect((await acc.post(`${base}/bank-rows/${emi}/reopen`, {})).status).toBe(200);
    l = (await acc.get(`${base}/loans`)).json.loans;
    expect(by('Sample car loan')).toMatchObject({ balancePaise: 10000000, lines: [] });
    expect(await sql`SELECT 1 FROM transactions WHERE head_id = ${exp.id}`).toHaveLength(0);
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${emi}`)[0].status).toBe('unmatched');
    // A loan with lines cannot be removed; one without can.
    expect((await acc.del(`${base}/loans/${asha}`)).status).toBe(409);
    expect((await acc.del(`${base}/loans/${car}`)).status).toBe(200);
  });
});
