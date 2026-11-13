// Register line edits kept in History, an unread amount not ticked at ₹0, a line of two bills split, and the
// paid-together blocker in figures (approved 13 Nov 2026). Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { REGISTER_31_OCT } from '../demo/sample-data';
import { fullShift, hotel, view } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

const READ = (bill: string, amount: string, unclear: string[] = ['amount']) =>
  JSON.stringify({ engine: 'claude_vision', line: 9, y: 50, read: { bill_no: bill, amount }, unclear, inferred: [] });

async function setup() {
  const h = await hotel();
  const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122'].includes(r.billNo));
  const pageId = await fullShift(h, reg);
  const add = async (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) => {
    const r = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'draft', ...extra });
    expect(r.status).toBe(201);
    return r.json.id as string;
  };
  const put = (id: string, b: Record<string, unknown>) => h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${id}`, { billType: 'fnb', payments: [], ...b });
  return { h, pageId, add, put };
}

describe('register lines', () => {
  it('an unread amount cannot be ticked at ₹0 without saying so; typing it works; each change is in the bill\'s History', async () => {
    const { h, add, put } = await setup();
    const id = await add('2610311', '0', []);
    await sql`UPDATE register_rows SET ocr_original = ${READ('2610311', '42O')} WHERE id = ${id}`;
    const refused = await put(id, { billNo: '2610311', amount: '0', status: 'checked' });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('amount_unread');
    expect(refused.json.error).toMatch(/could not be read/);
    // Saved as a draft, it is fine: only ticking it at ₹0 asks.
    expect((await put(id, { billNo: '2610311', amount: '0', remarks: 'see photo', status: 'draft' })).status).toBe(200);
    expect((await put(id, { billNo: '2610311', amount: '0', status: 'checked', confirm: ['amount'] })).status).toBe(200);
    expect((await put(id, { billNo: '2610311', amount: '420', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '420' }] })).status).toBe(200);
    const log = await sql`SELECT after FROM audit_log WHERE action = 'register.edit' AND row_id = ${id} ORDER BY id`;
    const changes = log.map((l: any) => JSON.parse(l.after).changes);
    expect(changes).toEqual([
      'Remarks "" → "see photo"',
      'Remarks "see photo" → ""; Ticked as checked',
      'Amount ₹0 → ₹420; Payments none → UPI Bank 2 ₹420',
    ]);
    const bill = await h.clients.owner.get(`/businesses/${h.bid}/bills/2610311`);
    expect(bill.json.history.map((x: any) => x.action)).toContain('register.edit');
    // Nothing changed: nothing written.
    expect((await put(id, { billNo: '2610311', amount: '420', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '420' }] })).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'register.edit' AND row_id = ${id}`)[0].n).toBe(3);
  });

  it('a line read as two bills splits in two, paid together with the row holding the payment; a second split is refused', async () => {
    const { h, add } = await setup();
    const head = await add('2610311', '0', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '1600' }]);
    await sql`UPDATE register_rows SET ocr_original = ${READ('2610311 2610314', '420+1180')} WHERE id = ${head}`;
    const member = await add('26103122', '0', [], { paidWithRowId: head });
    await sql`UPDATE register_rows SET ocr_original = ${READ('26103122 2610399', '780 50')} WHERE id = ${member}`;
    const s1 = await h.clients.entry_staff.post(`/businesses/${h.bid}/register-rows/${head}/split`, {});
    expect(s1.status).toBe(201);
    const s2 = await h.clients.entry_staff.post(`/businesses/${h.bid}/register-rows/${member}/split`, {});
    expect(s2.status).toBe(201);
    const rows = await sql`SELECT id, bill_no, amount_paise, paid_with_row_id, status FROM register_rows WHERE id IN (${head}, ${member}, ${s1.json.id}, ${s2.json.id}) ORDER BY line_no`;
    expect(rows.map((r: any) => [r.bill_no, r.amount_paise, r.paid_with_row_id, r.status])).toEqual([
      ['2610311', 42000, null, 'draft'], ['2610314', 118000, head, 'draft'], ['26103122', 78000, head, 'draft'], ['2610399', 5000, head, 'draft'],
    ]);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/register-rows/${head}/split`, {})).status).toBe(400);
    // The group is now ₹2,430 of bills against ₹1,600 paid: told in figures.
    const v = await view(h);
    expect(v.json.blockers.join(' ')).toMatch(/2610311, 2610314, 26103122, 2610399 are paid together: bills ₹2,430 after discounts and tips, paid ₹1,600, ₹830 less paid than billed/);
    const hist = await sql`SELECT after FROM audit_log WHERE action = 'register.split' AND row_id = ${head}`;
    expect(JSON.parse(hist[0].after).changes).toBe('Split into 2610311 ₹420 and 2610314 ₹1,180');
  });

  it('a line with a line added below already is not split; a group with a row at ₹0 names it', async () => {
    const { h, add, put } = await setup();
    const head = await add('2610311', '0', [{ mode: 'cash', columnLabel: 'Cash', amount: '1600' }]);
    await sql`UPDATE register_rows SET ocr_original = ${READ('2610311 2610314', '420+1180')} WHERE id = ${head}`;
    const below = (await h.clients.entry_staff.post(`/businesses/${h.bid}/register-rows/${head}/insert-below`, {})).json.id;
    expect((await put(below, { billNo: '2610314', amount: '1180', paidWithRowId: head, status: 'draft' })).status).toBe(200);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/register-rows/${head}/split`, {})).status).toBe(400);
    const v = await view(h);
    expect(v.json.blockers.join(' ')).toMatch(/bills ₹1,180 after discounts and tips, paid ₹1,600, ₹420 more paid than billed\. Rows at ₹0: 2610311\./);
  });

  it('a group short by a small gap gets its discount filled by itself once no row is at ₹0; a typed discount or Undo stays', async () => {
    const { h, add, put } = await setup();
    // 420 + 1180 = 1,600 of bills, 1,550 paid. While 2610314 is at ₹0, nothing is filled (₹1,130 paid over).
    const head = await add('2610311', '420', [{ mode: 'cash', columnLabel: 'Cash', amount: '1550' }]);
    const m = await add('2610314', '0', [], { paidWithRowId: head });
    const disc = async () => (await sql`SELECT discount_paise FROM register_rows WHERE id = ${head}`)[0].discount_paise;
    expect(await disc()).toBe(0);
    expect((await put(m, { billNo: '2610314', amount: '1180', paidWithRowId: head, status: 'draft' })).status).toBe(200);
    expect(await disc()).toBe(5000);
    const log = await sql`SELECT after FROM audit_log WHERE action = 'register.auto_discount' AND row_id = ${head}`;
    expect(JSON.parse(log[0].after).changes).toBe('Discount filled: ₹50 (3.1% of ₹1,600 of bills, ₹1,550 paid)');
    expect((await view(h)).json.blockers.join(' ')).not.toMatch(/2610311, 2610314 are paid together/);
    // The member back to ₹0: the filled discount comes off, and the blocker names the row.
    expect((await put(m, { billNo: '2610314', amount: '0', paidWithRowId: head, status: 'draft' })).status).toBe(200);
    expect(await disc()).toBe(0);
    expect((await view(h)).json.blockers.join(' ')).toMatch(/Rows at ₹0: 2610314/);
    // A gap over 20% is left to a person.
    expect((await put(m, { billNo: '2610314', amount: '5000', paidWithRowId: head, status: 'draft' })).status).toBe(200);
    expect(await disc()).toBe(0);
    // Back to 1,180: filled again; a person taking it off (Undo) keeps it off.
    expect((await put(m, { billNo: '2610314', amount: '1180', paidWithRowId: head, status: 'draft' })).status).toBe(200);
    expect(await disc()).toBe(5000);
    expect((await put(head, { billNo: '2610311', amount: '420', discount: '0', payments: [{ mode: 'cash', columnLabel: 'Cash', amount: '1550' }], status: 'draft' })).status).toBe(200);
    expect(await disc()).toBe(0);
    expect((await put(m, { billNo: '2610314', amount: '1180', remarks: 'x', paidWithRowId: head, status: 'draft' })).status).toBe(200);
    expect(await disc()).toBe(0);
  });
});
