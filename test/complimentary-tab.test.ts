// Payments › Complimentary (approved 14 Nov 2026): PREPAID bills, a bill made complimentary with the guest's name, and a
// complimentary bill turned into a Cash, UPI or Card sale; each undoable. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('complimentary bills', () => {
  it('PREPAID with no money is complimentary; PREPAID with money needs a look; a bill made complimentary takes the guest name; Paid by turns one into a sale; all undo', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'PREPAID' as never, '500'], ['2610312', '31 20:00', 'PREPAID' as never, '300'], ['2610313', '31 21:00', 'CASH', '200']]);
    await h.register([{ no: '2610312', amount: '300', pays: [['cash', '300']] }, { no: '2610313', amount: '200', pays: [['cash', '200']] }]);
    const acc = h.clients.accountant;
    const tab = async () => (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/complimentary`)).json;
    const cmp = async (bill: string) => (await sql`SELECT id, difference, decision FROM bill_comparisons WHERE bill_no = ${bill}`)[0];
    expect((await sql`SELECT mode, mode_text FROM software_bills WHERE bill_no = '2610311'`)[0]).toEqual({ mode: 'unknown', mode_text: 'PREPAID' });

    let t = await tab();
    // Not in the register: confirmed by a person with the guest's name.
    expect(t.lines.map((l: any) => [l.billNo, l.status, l.why, l.valuePaise])).toEqual([['2610311', 'look', 'prepaid', 50000], ['2610312', 'look', 'prepaid', 30000]]);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${t.lines[0].comparisonId}/complimentary`, { guestName: 'Room 4 guest' })).status).toBe(200);
    t = await tab();
    expect(t.lines[0]).toMatchObject({ billNo: '2610311', status: 'ok', why: 'marked', guestName: 'Room 4 guest' });
    expect(t.lines[1].look).toMatch(/PREPAID in the software, but the register shows Cash ₹300 paid/);
    expect((await cmp('2610311')).difference).toBe('complimentary');

    // Made complimentary with the guest's name: a matched cash bill stops being a sale.
    const c13 = (await cmp('2610313')).id;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/comparisons/${c13}/complimentary`, { guestName: 'Mr Shah' })).status).toBe(403);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c13}/complimentary`, {})).status).toBe(400);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c13}/complimentary`, { guestName: 'Mr Shah' })).status).toBe(200);
    expect((await cmp('2610313')).difference).toBe('complimentary');
    t = await tab();
    expect(t.lines.find((l: any) => l.billNo === '2610313')).toMatchObject({ why: 'marked', guestName: 'Mr Shah', status: 'look' }); // cash is written on its row
    const rep = (await acc.get(`/businesses/${h.bid}/reports/complimentary?from=2026-10-31&to=2026-10-31`)).json;
    expect(rep.lines.map((l: any) => [l.billNo, l.name, l.why])).toEqual([['2610311', 'Room 4 guest', 'marked'], ['2610313', 'Mr Shah', 'marked']]);
    expect((await acc.del(`/businesses/${h.bid}/comparisons/${c13}/complimentary`, {})).status).toBe(200);
    expect((await cmp('2610313')).difference).toBe('match');

    // PREPAID with cash in the register: Paid by Cash counts it from the register.
    const c12 = (await cmp('2610312')).id;
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c12}/paid-by`, { mode: 'cash' })).status).toBe(200);
    expect(await cmp('2610312')).toMatchObject({ difference: 'mode', decision: 'use_register' });

    // PREPAID, not in the register, paid by UPI after all: a line is added, counted, and undone.
    const c11 = (await cmp('2610311')).id;
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c11}/paid-by`, { mode: 'upi' })).status).toBe(200);
    expect(await cmp('2610311')).toMatchObject({ difference: 'mode', decision: 'use_register' });
    const added = await sql`SELECT r.amount_paise, p.mode, p.amount_paise AS paid FROM register_rows r JOIN register_payments p ON p.register_row_id = r.id WHERE r.bill_no = '2610311'`;
    expect(added).toEqual([{ amount_paise: 50000, mode: 'upi', paid: 50000 }]);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c11}/paid-by/undo`, {})).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM register_rows WHERE bill_no = '2610311'`)[0].n).toBe(0);
    expect((await cmp('2610311')).difference).toBe('complimentary');

    // History shows each step in words.
    const hist = (await h.clients.owner.get(`/businesses/${h.bid}/bills/2610313`)).json.history.map((x: any) => x.action);
    expect(hist).toEqual(expect.arrayContaining(['bill.complimentary', 'bill.complimentary_undone']));

    // Saved: no changes.
    await h.decideRest();
    await h.confirm();
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c13}/complimentary`, { guestName: 'X' })).status).toBe(409);
    const sales = await sql`SELECT bill_no FROM transactions WHERE type = 'income' ORDER BY bill_no`;
    expect(sales.map((x: any) => x.bill_no)).toEqual(['2610312', '2610313']);
  });

  it('Paid by: refused on a line that pays for other bills or comes to ₹0 or less; a second press changes nothing; each Undo goes one step back', async () => {
    const h = await hotel();
    await h.software([['2610320', '31 19:00', 'PREPAID' as never, '400']]);
    // Old POS 144898 pays for 144743; the group's discount brings its own line below ₹0 (as on 30 Oct live).
    await h.register([
      { no: '144898', amount: '385', discount: '385', pays: [['upi', '3481', 'UPI Bank 2']] },
      { no: '144743', amount: '3481', pays: [], paidWith: '144898' },
      { no: '2610320', amount: '400', pays: [['upi', '400']] },
    ]);
    const acc = h.clients.accountant;
    const cmp = async (bill: string) => (await sql`SELECT id, difference, decision FROM bill_comparisons WHERE bill_no = ${bill}`)[0];
    const tab = async () => (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/complimentary`)).json;
    // Not listed as complimentary: it is paid with its group.
    expect((await tab()).lines.map((l: any) => l.billNo)).not.toContain('144898');
    const head = await acc.post(`/businesses/${h.bid}/comparisons/${(await cmp('144898')).id}/paid-by`, { mode: 'cash' });
    expect(head.status).toBe(400);
    expect(head.json.error).toMatch(/pays for other bills/);
    expect((await sql`SELECT p.mode, p.amount_paise FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.bill_no = '144898'`)).toEqual([{ mode: 'upi', amount_paise: 348100 }]);

    // PREPAID with UPI written: Cash, Cash again (no change), then UPI; Undo twice is back to the UPI written on the page.
    const c20 = (await cmp('2610320')).id;
    const pay = async () => (await sql`SELECT p.mode, p.amount_paise FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.bill_no = '2610320'`);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c20}/paid-by`, { mode: 'cash' })).status).toBe(200);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c20}/paid-by`, { mode: 'cash' })).json).toMatchObject({ unchanged: true });
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c20}/paid-by`, { mode: 'card' })).status).toBe(200);
    expect(await pay()).toEqual([{ mode: 'card', amount_paise: 40000 }]);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c20}/paid-by/undo`, {})).status).toBe(200);
    expect(await pay()).toEqual([{ mode: 'cash', amount_paise: 40000 }]);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c20}/paid-by/undo`, {})).status).toBe(200);
    expect(await pay()).toEqual([{ mode: 'upi', amount_paise: 40000 }]);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c20}/paid-by/undo`, {})).status).toBe(400);
  });
});
