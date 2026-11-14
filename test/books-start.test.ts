// Books start (approved 14 Nov 2026): an account's opening date is the day its books start. Its bank lines of earlier
// shifts are left out ("Before books start"), not waiting; moving the date earlier opens them again. Invented lines.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const T = (cells: (string | number)[]) => cells.join('\t');
const LINES = [
  T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
  T([1, 'S60000001', '29/10/2026', '29/10/2026 10:00:00 AM', '-', 'UPI/330000000001/Milk/xxmilk@ybl//ICIaaaa', 'DR', 100, '900']),
  // 7:30 am on 30 Oct is still the 29 Oct shift: before the books start.
  T([2, 'S60000002', '30/10/2026', '30/10/2026 7:30:00 AM', '-', 'UPI/330000000002/Ice/xxice@ybl//ICIbbbb', 'DR', 50, '850']),
  T([3, 'S60000003', '30/10/2026', '30/10/2026 9:00:00 AM', '-', 'UPI/330000000003/Veg/xxveg@ybl//ICIcccc', 'DR', 70, '780']),
].join('\n');

describe('books start', () => {
  it('leaves out open lines of shifts before the opening date, and opens them again when the date moves earlier', async () => {
    const h = await businessWithAllRoles('Hotel');
    const o = h.clients.owner;
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '1000', openingDate: '2026-10-30' })).json.id;
    expect((await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: LINES })).json).toMatchObject({ added: 3 });
    const st = async () => Object.fromEntries((await sql`SELECT tran_id, status, note FROM bank_rows ORDER BY tran_id`).map((r: any) => [r.tran_id, [r.status, r.note]]));
    expect(await st()).toEqual({ S60000001: ['ignored', 'Before books start'], S60000002: ['ignored', 'Before books start'], S60000003: ['unmatched', null] });
    expect((await o.get(`/businesses/${h.bid}/home`)).json.bookExpenses).toMatchObject({ count: 1, paise: 7000 });
    // The opening date moved earlier: those lines wait again.
    expect((await o.patch(`/businesses/${h.bid}/accounts/${acc}`, { name: 'HUF', kind: 'bank', openingBalance: '1000', openingDate: '2026-10-29' })).status).toBe(200);
    expect(await st()).toEqual({ S60000001: ['unmatched', null], S60000002: ['unmatched', null], S60000003: ['unmatched', null] });
    expect((await o.get(`/businesses/${h.bid}/home`)).json.bookExpenses).toMatchObject({ count: 3 });
  });
});
