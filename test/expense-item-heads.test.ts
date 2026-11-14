// Expense heads with no party (approved 14 Nov 2026): an item booked before fills its head ("Learned from item"); common
// words only suggest a head, which a person accepts. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, png } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('expense heads from the item', () => {
  it('suggests from words, learns from an earlier item, and never fills a word suggestion by itself', async () => {
    const h = await hotel();
    const staff = h.clients.entry_staff;
    const head = async (name: string) => (await sql`SELECT id FROM heads WHERE business_id = ${h.bid} AND type = 'expense' AND name = ${name}`)[0]?.id
      ?? (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name, type: 'expense' })).json.id;
    const transport = await head('Transport');
    const misc = await head('Misc. Expenses');
    const pg = (await staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(71), 'image/png')).json.id;
    await staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Petrol', amount: '100' });
    await staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Scissors', amount: '210' });
    await staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Something odd', amount: '5' });
    let rows = (await staff.get(`/businesses/${h.bid}/uploads/${pg}`)).json.rows;
    expect(rows.map((r: any) => [r.narration, r.headId, r.suggestHead])).toEqual([
      ['Petrol', null, { headId: transport, from: 'words', word: 'petrol' }],
      ['Scissors', null, { headId: misc, from: 'words', word: 'scissors' }],
      ['Something odd', null, null]]);

    // Accepted with one click: the head is the person's choice.
    const petrol = rows[0];
    await staff.put(`/businesses/${h.bid}/expense-rows/${petrol.id}`, { narration: 'Petrol', amount: '100', headId: transport });
    // Next page: Petrol fills by itself from the earlier line; "Petrol bike" too, by its first word.
    const pg2 = (await staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(72), 'image/png')).json.id;
    await staff.post(`/businesses/${h.bid}/uploads/${pg2}/expense-rows`, { narration: 'petrol', amount: '200' });
    await staff.post(`/businesses/${h.bid}/uploads/${pg2}/expense-rows`, { narration: 'Petrol bike', amount: '150' });
    rows = (await staff.get(`/businesses/${h.bid}/uploads/${pg2}`)).json.rows;
    expect(rows.map((r: any) => [r.narration, r.headId, JSON.parse(r.ocrOriginal).headFrom])).toEqual([['petrol', transport, 'item'], ['Petrol bike', transport, 'item']]);
    // A head chosen by a person stays; the item mark goes.
    await staff.put(`/businesses/${h.bid}/expense-rows/${rows[1].id}`, { narration: 'Petrol bike', amount: '150', headId: misc });
    const [r] = await sql`SELECT head_id, ocr_original FROM transactions WHERE id = ${rows[1].id}`;
    expect(r.head_id).toBe(misc);
    expect(JSON.parse(r.ocr_original).headFrom).toBeUndefined();
  });
});
