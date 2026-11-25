// What Money in names on each line (26 Nov 2026): a Yes Bank line has a date only, a settlement tells the desk bills
// waiting before it, a MakeMyTrip payout suggests Room income, and a transfer whose other side was booked under a head
// is found by its bank reference. Invented figures only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const T = (cells: (string | number)[]) => cells.join('\t');

describe('Money in, named', () => {
  it('date only, desk bills waiting, MakeMyTrip, and a transfer booked on one side', async () => {
    const h = await businessWithAllRoles('Hotel');
    const o = h.clients.owner;
    const icici = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'Icici A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    const yes = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'Yes A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    const room = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Room income', type: 'income' })).json.id;
    const gen = (await o.post(`/businesses/${h.bid}/heads`, { name: 'General exp', type: 'expense' })).json.id;
    await sql`INSERT INTO bill_type_heads (business_id, bill_type, head_id, created_at) VALUES (${h.bid}, 'room', ${room}, 0)`;
    await o.post(`/businesses/${h.bid}/bank/${icici}/paste`, { text: [
      T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
      T([1, 'S90000001', '30/10/2026', '30/10/2026 6:13:00 PM', '-', 'MMT/IMPS/600000000123/a/somehotelye/YESB0000001', 'DR', 101, '1']),
      T([2, 'S90000002', '30/10/2026', '30/10/2026 6:20:00 PM', '-', 'NEFT-HDFCH0000001-MAKEMYTRIP INDIA LIMITED-0001NEFT', 'CR', '8,000.00', '1']),
    ].join('\n') });
    await o.post(`/businesses/${h.bid}/bank/${yes}/paste`, { text: [
      T(['Transaction Date', 'Value Date', 'Description', 'Reference Number', 'Withdrawals', 'Deposits', 'Running Balance']),
      T(['30/10/2026', '30/10/2026', 'IMPS/SOME HOTEL PRI/XXX0001/RRN:600000000123/ICICI BANK LIMITED', 'YBP600000000999', '', '101.00', 'INR 101.00']),
      T(['30/10/2026', '30/10/2026', '115000000001/700000001 UPI Collection Settlement/SOME HOTEL/CBS PAYABLE ACC', 'YESF26303000000001', '', '16,000.00', 'INR 16,101.00']),
    ].join('\n') });
    const id = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${id}, ${h.bid}, '2026-10-29', 280000, 'income', ${room}, 'software_report', 'approved', 'upi', '2610299', '2026-10-29', 'awaiting_bank_match', 0)`;
    const rows = async () => (await o.get(`/businesses/${h.bid}/bank-rows?from=2026-10-29&to=2026-10-31`)).json.rows as Record<string, any>[];
    let r = await rows();
    const by = (tran: string) => r.find((x) => x.tranId === tran)!;

    // The ICICI ₹101 out was booked as an expense: the Yes Bank ₹101 in names it.
    const out = by('S90000001');
    expect((await o.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: out.id, headId: gen }] })).json.booked).toBe(1);
    r = await rows();
    expect(by('YBP600000000999')).toMatchObject({ dateOnly: true, bookedLeg: { rowId: out.id, accountName: 'Icici A', headName: 'General exp', ref: '600000000123' } });
    expect(by('S90000002')).toMatchObject({ dateOnly: false, known: 'mmt', suggest: { headId: room, party: 'MakeMyTrip', item: 'MakeMyTrip payout' } });
    expect(by('YESF26303000000001')).toMatchObject({ known: 'settlement', desk: { from: '2026-10-27', to: '2026-10-29', waiting: 1 }, suggest: { headId: room } });
  });
});
