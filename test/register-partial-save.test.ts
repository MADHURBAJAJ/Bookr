// Saving a register row (17 Nov 2026): a screen sends only what it changed and what it was, so an older screen does
// not undo a save made elsewhere; a group discount that was exactly the gap moves with the gap; the answer carries the
// rows of the group so the screen updates at once. Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { REGISTER_31_OCT } from '../demo/sample-data';
import { fullShift, hotel } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

async function setup() {
  const h = await hotel();
  const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122'].includes(r.billNo));
  const pageId = await fullShift(h, reg);
  const add = async (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) => {
    const r = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'draft', ...extra });
    expect(r.status).toBe(201);
    return r.json.id as string;
  };
  const put = (id: string, b: Record<string, unknown>) => h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${id}`, b);
  const row = async (id: string) => (await sql`SELECT amount_paise, discount_paise, tip_paise, status, remarks FROM register_rows WHERE id = ${id}`)[0];
  return { h, add, put, row };
}

const CASH = (a: string) => [{ mode: 'cash', columnLabel: 'Cash', amount: a }];

describe('saving a register row', () => {
  it('an older screen sending only its change keeps a save made elsewhere; a field changed elsewhere is refused', async () => {
    const { add, put, row } = await setup();
    const id = await add('2610311', '3676', CASH('676'), { discount: '3000' });
    // Another screen corrects the amount to 676 (and the discount to 0).
    expect((await put(id, { billNo: '2610311', billType: 'fnb', amount: '676', discount: '0', payments: CASH('676'), status: 'draft', only: ['amount', 'discount'],
      was: { amount: '3676.00', discount: '3000.00' } })).status).toBe(200);
    // The first screen, still showing 3676, ticks the row: only the tick is sent, the amount stays 676.
    const tick = await put(id, { billNo: '2610311', billType: 'fnb', amount: '3676', discount: '3000', payments: CASH('676'), status: 'checked', only: ['status'], was: { status: 'draft' } });
    expect(tick.status).toBe(200);
    expect(await row(id)).toMatchObject({ amount_paise: 67600, discount_paise: 0, status: 'checked' });
    // The same screen now changes the amount it saw as 3676: refused, the row is not touched.
    const stale = await put(id, { amount: '3600', only: ['amount'], was: { amount: '3676' } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('stale_row');
    expect(stale.json.error).toMatch(/amount changed on another screen/);
    expect((await row(id)).amount_paise).toBe(67600);
    // A change to the value already saved is fine (two screens making the same fix).
    expect((await put(id, { amount: '676', only: ['amount'], was: { amount: '3676' } })).status).toBe(200);
    // A remark alone: the rest of the row comes from what is saved.
    expect((await put(id, { remarks: 'guest paid less', only: ['remarks'], was: { remarks: null } })).status).toBe(200);
    expect(await row(id)).toMatchObject({ amount_paise: 67600, status: 'checked', remarks: 'guest paid less' });
  });

  it('a group discount that was exactly the gap moves with it; the answer carries the group rows and says what changed', async () => {
    const { add, put, row } = await setup();
    // 420 + 1180 = 1,600 of bills, 1,550 paid; the discount of 50 was typed on the paying row.
    const head = await add('2610311', '420', CASH('1550'), { discount: '50' });
    const m = await add('2610314', '1180', [], { paidWithRowId: head });
    expect((await row(head)).discount_paise).toBe(5000);
    // The member's amount was misread: 1,200. The gap is now 70 and the discount follows.
    const res = await put(m, { amount: '1200', only: ['amount'], was: { amount: '1180' } });
    expect(res.status).toBe(200);
    expect((await row(head)).discount_paise).toBe(7000);
    expect(res.json.rows.find((r: any) => r.id === head)).toMatchObject({ discountPaise: 7000 });
    expect(res.json.rows.find((r: any) => r.id === m)).toMatchObject({ amountPaise: 120000, paidWithRowId: head });
    expect(res.json.notes).toEqual([expect.objectContaining({ rowId: head, fromPaise: 5000, toPaise: 7000 })]);
    expect(res.json.notes[0].words).toMatch(/^Discount ₹50 → ₹70/);
    // A gap over the limit: the discount stays as typed.
    expect((await put(m, { amount: '5000', only: ['amount'], was: { amount: '1200' } })).status).toBe(200);
    expect((await row(head)).discount_paise).toBe(7000);
    // A typed discount that is not the gap does not move.
    expect((await put(m, { amount: '1180', only: ['amount'], was: { amount: '5000' } })).status).toBe(200);
    expect((await row(head)).discount_paise).toBe(7000);
  });

  it('a filled group discount comes back with the save that changed it', async () => {
    const { add, put } = await setup();
    const head = await add('2610311', '420', CASH('1550'));
    const m = await add('2610314', '0', [], { paidWithRowId: head });
    const res = await put(m, { amount: '1180', only: ['amount'], was: { amount: '0' } });
    expect(res.status).toBe(200);
    expect(res.json.rows.find((r: any) => r.id === head)).toMatchObject({ discountPaise: 5000 });
    expect(res.json.notes[0].words).toMatch(/^Discount filled: ₹50/);
  });
});
