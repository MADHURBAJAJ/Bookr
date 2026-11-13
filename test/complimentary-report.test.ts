// Complimentary report (approved 13 Nov 2026). Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { REGISTER_31_OCT } from '../demo/sample-data';
import { fullShift, hotel, view } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('complimentary bills report', () => {
  it('lists ₹0 bills with no money paid, with the software name and register remarks; a ₹0 row with money on it and a group-discount row are not listed', async () => {
    const h = await hotel();
    // 2610311 pays for 2610314 too, and the group's discount brings its own row to ₹0: paid with its group, not complimentary.
    // 2610399 is a ₹0 row with money written on it: a row to correct, not complimentary.
    const reg = [
      ...REGISTER_31_OCT.filter((r) => !['2610311', '2610314'].includes(r.billNo)),
      { billNo: '2610399', billType: 'fnb' as const, amount: '0', payments: [{ mode: 'cash' as const, columnLabel: 'Cash', amount: '200' }] },
    ];
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    const head = (await add('2610311', '420', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '1180' }], { discount: '420' })).json.id;
    expect((await add('2610314', '1180', [], { paidWithRowId: head })).status).toBe(201);
    await sql`UPDATE software_bills SET customer_name = 'Mr Mehta (owner''s guest)' WHERE bill_no = '2610316'`;
    expect((await view(h)).status).toBe(200);
    const r = await h.clients.viewer.get(`/businesses/${h.bid}/reports/complimentary?from=2026-10-31&to=2026-10-31`);
    expect(r.status).toBe(200);
    expect(r.json.lines).toEqual([expect.objectContaining({ day: '2026-10-31', billNo: '2610316', name: "Mr Mehta (owner's guest)", remarks: 'Complimentary', in: 'both', billType: 'fnb' })]);
    expect(r.json.count).toBe(1);
  });

  it('only those who can see reports get it', async () => {
    const h = await hotel();
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/reports/complimentary`)).status).toBe(403);
    expect((await h.clients.accountant.get(`/businesses/${h.bid}/reports/complimentary`)).status).toBe(200);
  });
});
