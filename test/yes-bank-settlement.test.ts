// Desk bills in a Yes Bank settlement (approved 25 Nov 2026): a desk UPI bill rarely paid into the direct-booking
// account comes inside one day's settlement. Invented figures only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const T = (...rows: string[][]) => rows.map((r) => r.join('\t')).join('\n');
const STATEMENT = T(
  ['999900001111', 'SOME HOTEL PRIVATE LIMITED'],
  ['Transaction Date', 'Value Date', 'Description', 'Reference Number', 'Withdrawals', 'Deposits', 'Running Balance'],
  ['01/11/2026', '01/11/2026', '115000000001/800000001 UPI Collection Settlement/SOME HOTEL/CBS PAYABLE ACC', 'YESF26305000000001', '', '20,000.00', 'INR 20,000.00'],
  ['20/10/2026', '20/10/2026', '115000000001/800000002 UPI Collection Settlement/SOME HOTEL/CBS PAYABLE ACC', 'YESF26293000000002', '', '5,000.00', 'INR 0.00'],
);

describe('a Yes Bank settlement with a desk bill in it', () => {
  it('suggests Room income; matches the desk bill and books only the rest; Unmatch undoes both', async () => {
    const h = await businessWithAllRoles('Hotel');
    const o = h.clients.owner;
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'Yes Bank', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    const room = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Room income', type: 'income' })).json.id;
    const fnb = (await o.post(`/businesses/${h.bid}/heads`, { name: 'F&B', type: 'income' })).json.id;
    const veg = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Vegetables', type: 'expense' })).json.id;
    await sql`INSERT INTO bill_type_heads (business_id, bill_type, head_id, created_at) VALUES (${h.bid}, 'room', ${room}, 0)`;
    expect((await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: STATEMENT })).json).toMatchObject({ added: 2 });
    const sale = (bill: string, paise: number, day: string) => { const id = crypto.randomUUID(); return sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${id}, ${h.bid}, ${day}, ${paise}, 'income', ${fnb}, 'software_report', 'approved', 'upi', ${bill}, ${day}, 'awaiting_bank_match', 0)`.then(() => id); };
    const desk = await sale('2610310', 200000, '2026-10-31');
    await sale('2610210', 50000, '2026-10-21'); // too early for the 1 Nov settlement

    const rows = (await o.get(`/businesses/${h.bid}/bank-rows?from=2026-10-01&to=2026-11-30`)).json.rows;
    const line = rows.find((r: { tranId: string }) => r.tranId === 'YESF26305000000001');
    expect(line).toMatchObject({ kind: 'other', remark: 'UPI collection settlement', amountPaise: 2000000 });
    expect(line.suggest.headId).toBe(room);

    const found = (await o.get(`/businesses/${h.bid}/bank-rows/${line.id}/desk-bills`)).json;
    expect(found.bills.map((b: { billNo: string }) => b.billNo)).toEqual(['2610310']);
    expect(found.headId).toBe(room);

    const split = (x: Record<string, unknown>) => o.post(`/businesses/${h.bid}/bank-rows/${line.id}/settlement-split`, x);
    expect((await split({ transactionIds: [desk], headId: veg })).status).toBe(400);
    const ok = await split({ transactionIds: [desk], headId: room });
    expect(ok.json).toMatchObject({ deskPaise: 200000, restPaise: 1800000 });
    expect((await sql`SELECT match_status, matched_bank_row FROM transactions WHERE id = ${desk}`)[0]).toEqual({ match_status: null, matched_bank_row: line.id });
    const [rest] = await sql`SELECT type, amount_paise, head_id FROM transactions WHERE matched_bank_row = ${line.id} AND source = 'bank_sheet'`;
    expect(rest).toEqual({ type: 'income', amount_paise: 1800000, head_id: room });

    // Not on an ordinary line, and not twice.
    expect((await split({ transactionIds: [desk], headId: room })).status).toBe(409);

    expect((await o.del(`/businesses/${h.bid}/bank-rows/${line.id}/match`)).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE matched_bank_row = ${line.id}`)[0].n).toBe(0);
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${desk}`)[0].match_status).toBe('awaiting_bank_match');
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${line.id}`)[0].status).toBe('unmatched');
  });
});
