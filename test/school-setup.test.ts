// Schools and cashiers (21 Nov 2026): a cashier's book changes its name, opening cash and start; the codes show.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

describe('schools and cashiers', () => {
  it('changes a cashier\'s name, opening cash and start, and lists the fee report codes', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
    const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Anup', branchId: sms, openingBalance: '0', openingDate: '2026-11-21' })).json.id;
    await o.put(`/businesses/${h.bid}/fees/codes/SMSSMS`, { branchId: sms });
    await o.put(`/businesses/${h.bid}/fees/codes/BISPBIST`, { branchId: null });
    expect((await o.patch(`/businesses/${h.bid}/cashbooks/${book}`, { name: 'Anup Maheshwari', branchId: sms, openingBalance: '12,500', openingDate: '2026-11-20' })).status).toBe(200);
    const d = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(d.books[0]).toMatchObject({ name: 'Anup Maheshwari', openingBalancePaise: 1250000, openingDate: '2026-11-20', inHandPaise: 1250000 });
    expect(d.codes).toEqual([{ code: 'BISPBIST', branchId: null }, { code: 'SMSSMS', branchId: sms }]);
    // Only branch and cashier sent: the rest stays.
    expect((await o.patch(`/businesses/${h.bid}/cashbooks/${book}`, { branchId: sms })).status).toBe(200);
    expect((await o.get(`/businesses/${h.bid}/cashbooks`)).json.books[0]).toMatchObject({ name: 'Anup Maheshwari', openingBalancePaise: 1250000 });
    // Cashiers do not change books.
    expect((await h.clients.entry_staff.patch(`/businesses/${h.bid}/cashbooks/${book}`, { branchId: sms, name: 'X' })).status).toBe(403);
  });
});
