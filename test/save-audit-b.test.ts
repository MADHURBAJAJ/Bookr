// Save audit B (14 Nov 2026): bills paid together, saved. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { brief, cmp, saveChecked } from './saveKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const byBill = (rows: any[]) => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.bill_no] = (out[r.bill_no] ?? 0) + r.amount_paise;
  return out;
};
const byMode = (rows: any[]) => {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.payment_mode] = (out[r.payment_mode] ?? 0) + r.amount_paise;
  return out;
};

describe('B8 one payment for several bills', () => {
  it('one mode, split modes, a discount filled by itself, and a bill the software does not have', async () => {
    const h = await hotel();
    await h.software([
      ['2610381', '31 10:00', 'CASH', '300'], ['2610382', '31 10:05', 'CASH', '500'],       // G1 one mode
      ['2610383', '31 11:00', 'UPI', '600'], ['2610384', '31 11:05', 'CASH', '400'],        // G2 cash + UPI
      ['2610385', '31 12:00', 'CASH', '500'], ['2610386', '31 12:05', 'CASH', '500'],       // G3 ₹50 less paid
      ['2610387', '31 13:00', 'CASH', '300'],                                               // G4 2610388 not in the software
    ]);
    await h.register([
      { no: '2610381', amount: '300', pays: [['cash', '800']] }, { no: '2610382', amount: '500', pays: [], paidWith: '2610381' },
      { no: '2610383', amount: '600', pays: [['cash', '400'], ['upi', '600']] }, { no: '2610384', amount: '400', pays: [], paidWith: '2610383' },
      { no: '2610385', amount: '500', pays: [['cash', '950']] }, { no: '2610386', amount: '500', pays: [], paidWith: '2610385' },
      { no: '2610387', amount: '300', pays: [['cash', '700']] }, { no: '26103198', amount: '400', pays: [], paidWith: '2610387' },
    ]);
    // G3: the ₹50 gap (5%) is filled as the group's discount on the row with the payment.
    expect((await sql`SELECT discount_paise FROM register_rows WHERE id = ${h.rows['2610385']}`)[0].discount_paise).toBe(5000);
    const v = await h.view();
    expect(v.json.blockers).toEqual([]);
    expect(v.json.paidGroups.map((g: any) => [g.billNos.join('+'), g.matched])).toEqual([
      ['2610381+2610382', true], ['2610383+2610384', true], ['2610385+2610386', true], ['2610387+26103198', false]]);
    expect(await cmp(h, '2610387')).toMatchObject({ difference: 'match' });
    expect(await cmp(h, '26103198')).toMatchObject({ difference: 'missing_in_software', decision: 'use_register' });
    const s = await saveChecked(h);
    expect(byBill(s.rows)).toEqual({ 2610381: 30000, 2610382: 50000, 2610383: 60000, 2610384: 40000, 2610385: 45000, 2610386: 50000, 2610387: 30000, 26103198: 40000 });
    const g2 = s.rows.filter((r: any) => ['2610383', '2610384'].includes(r.bill_no));
    expect(byMode(g2), 'G2 books the cash and the UPI paid').toEqual({ cash: 40000, upi: 60000 });
    expect(s.after.cashSalesPaise).toBe(285000);
    expect(new Set(s.rows.map((r: any) => r.head))).toEqual(new Set(['F&B']));
  });
});

describe('B9 a group across two register pages, and a line split in two', () => {
  it('both save as their own bills', async () => {
    const h = await hotel();
    await h.software([['2610391', '31 10:00', 'UPI', '400'], ['2610392', '31 10:05', 'UPI', '600'], ['2610393', '31 11:00', 'CASH', '500'], ['2610394', '31 11:05', 'CASH', '300']]);
    await h.register([{ no: '2610391', amount: '400', pays: [['upi', '1000']] }, { no: '2610393', amount: '500', pays: [['cash', '800']] }]);
    // Page 2 of the same shift: 2610392, paid with 2610391 on page 1.
    const staff = h.clients.entry_staff;
    const p2 = await staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, PNG, 'image/png');
    expect(p2.status).toBe(201);
    const m = await staff.post(`/businesses/${h.bid}/uploads/${p2.json.id}/register-rows`, { billNo: '2610392', billType: 'fnb', amount: '600', discount: '0', status: 'checked', payments: [], paidWithRowId: h.rows['2610391'] });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    // A line read as two bills: split, then both ticked.
    const row = h.rows['2610393'];
    await sql`UPDATE register_rows SET ocr_original = ${JSON.stringify({ engine: 'claude_vision', line: 3, y: 30, read: { bill_no: '2610393 2610394', amount: '500+300' }, unclear: [], inferred: [] })} WHERE id = ${row}`;
    const sp = await staff.post(`/businesses/${h.bid}/register-rows/${row}/split`, {});
    expect(sp.status, JSON.stringify(sp.json)).toBe(201);
    let v = await h.view();
    expect(v.json.blockers.join(' ')).toMatch(/not checked/);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(409);
    const put = (id: string, b: Record<string, unknown>) => staff.put(`/businesses/${h.bid}/register-rows/${id}`, { billType: 'fnb', discount: '0', status: 'checked', ...b });
    expect((await put(row, { billNo: '2610393', amount: '500', payments: [{ mode: 'cash', amount: '800', columnLabel: 'Cash' }] })).status).toBe(200);
    expect((await put(sp.json.id, { billNo: '2610394', amount: '300', payments: [], paidWithRowId: row })).status).toBe(200);
    v = await h.view();
    expect(v.json.blockers).toEqual([]);
    const s = await saveChecked(h);
    expect(brief(s.rows)).toEqual([
      ['2610391', 400, 'upi', 'F&B', 'both_matched'],
      ['2610392', 600, 'upi', 'F&B', 'both_matched'],
      ['2610393', 500, 'cash', 'F&B', 'both_matched'],
      ['2610394', 300, 'cash', 'F&B', 'both_matched'],
    ]);
  });
});
