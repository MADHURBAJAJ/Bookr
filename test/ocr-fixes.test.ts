// Page reading fixes (approved 22 Nov 2026): notes in payment columns, bill numbers missing a doubled digit, and one
// payment column read a line off. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { columnSlipMoves, completeBillNo, droppedRepeat, findColumnSlip, gridToReading, splitPaymentCell } from '../src/ocr';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Notes in a payment column', () => {
  it('takes only the number as the payment', () => {
    expect(splitPaymentCell('(Disc 45)')).toEqual({ amount: null, discount: '45', note: null });
    expect(splitPaymentCell('1500 Discont')).toEqual({ amount: '1500', discount: null, note: null });
    expect(splitPaymentCell('800 Ravi')).toEqual({ amount: '800', discount: null, note: 'Ravi' });
    expect(splitPaymentCell('Dis 40')).toEqual({ amount: null, discount: '40', note: null });
    expect(splitPaymentCell('120 Discount 6')).toEqual({ amount: '120', discount: '6', note: null });
    expect(splitPaymentCell('Paid')).toMatchObject({ amount: null, note: 'Paid' });
    expect(splitPaymentCell('(64)')).toMatchObject({ amount: null, discount: null, note: '(64)' });
    expect(splitPaymentCell('1000+500')).toEqual({ amount: '1000+500', discount: null, note: null });
    expect(splitPaymentCell('2,400')).toEqual({ amount: '2,400', discount: null, note: null });
  });

  it('moves the discount and words out of the grid line', () => {
    const r = gridToReading({ orientation: 'upright', legible: true, page_total: null, headings: ['S.No', 'Bill No', 'Bill Amt', 'Type', 'Cash', 'UPI XOXO', 'UPI Bank 2', 'Card', 'Remarks'],
      lines: [{ line: 1, cells: ['1', '2610311', '845', 'F&B', '(Disc 45)', null, '800', null, 'Table 4'], unclear_columns: [], paid_with_line: null, y: 10 }] } as never);
    expect(r.rows[0]).toMatchObject({ discount: '45', payments: [{ column: 'UPI Bank 2', amount: '800' }], remarks: 'Table 4', payment_notes: ['Disc 45'] });
  });
});

describe('Bill numbers missing a doubled digit', () => {
  it('completes only to a free software bill of the same amount', () => {
    expect(droppedRepeat('2611115', '261115')).toBe(true);
    expect(droppedRepeat('26111110', '2611110')).toBe(true);
    expect(droppedRepeat('2612345', '261345')).toBe(false);
    const sw = new Map([['2611115', 47000], ['26111114', 55600], ['26111112', 23000]]);
    expect(completeBillNo('261115', [47000], sw, new Set())).toEqual({ billNo: '2611115' });
    expect(completeBillNo('2611114', [23000], sw, new Set())).toBeNull(); // 26111114 is ₹556
    expect(completeBillNo('2611114', [55600], sw, new Set(['26111114']))).toBeNull(); // already on the register
    expect(completeBillNo('1115', [1], sw, new Set())).toEqual({ billNo: '2611115' }); // the end of a number
  });
});

describe('A payment column read a line off', () => {
  const page = [[18500, 18500], [26200, 18500], [94000, 26200], [27100, 94000, 30000], [12500, 27100], [6200, 12500], [95520, 6200], [25200, 90000], [3200, 25200], [3200, 3200]];
  const rows = page.map(([amt, upi, cash]) => ({ amt, cols: { 'UPI Bank 2': upi, ...(cash ? { Cash: cash } : {}) } as Record<string, number>, grouped: false }));
  it('finds it and moves only that column, past a line paid in cash', () => {
    const slip = findColumnSlip(rows)!;
    expect(slip).toMatchObject({ column: 'UPI Bank 2', direction: 'down' });
    const moves = columnSlipMoves(rows, slip);
    expect([...moves.values()]).toEqual([18500, 26200, 94000, undefined, 12500, 6200, 90000, 25200, 3200, undefined]);
  });
  it('does not see one on a page where equal bills follow each other', () => {
    expect(findColumnSlip([23000, 23000, 23000, 23000].map((a) => ({ amt: a, cols: { UPI: a }, grouped: false })))).toBeNull();
  });

  it('moves it on a page and puts it back with Undo', async () => {
    const h = await hotel();
    // Line 4 was paid in cash; the UPI column was read a line low from line 2 on.
    const amts = [185, 262, 940, 271, 125, 62];
    const read = [185, 185, 262, 940, 271, 125];
    await h.register(amts.map((a, i) => ({ no: `26103${11 + i}`, amount: String(a),
      pays: [...(i === 3 ? [['cash', '300'] as ['cash', string]] : []), ['upi', String(read[i]), 'UPI Bank 2'] as ['upi', string, string]] })));
    await sql`UPDATE register_rows SET status = 'draft' WHERE business_id = ${h.bid}`;
    const pageId = (await sql`SELECT upload_id FROM register_rows WHERE id = ${h.rows['2610311']}`)[0].upload_id;
    const u = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${pageId}`)).json;
    expect(u.columnSlip).toMatchObject({ column: 'UPI Bank 2', direction: 'down' });
    const paid = async () => (await sql`SELECT r.bill_no, coalesce(sum(p.amount_paise), 0) AS paid FROM register_rows r LEFT JOIN register_payments p ON p.register_row_id = r.id
      WHERE r.business_id = ${h.bid} GROUP BY r.id ORDER BY r.line_no`).map((x: any) => Number(x.paid) / 100);
    const m = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/move-column`, { column: 'UPI Bank 2', direction: 'down' });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    expect(await paid()).toEqual([185, 262, 940, 300, 125, 0]);
    const back = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/move-column/undo`, { key: m.json.key });
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect(await paid()).toEqual([185, 185, 262, 1240, 271, 125]);
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/uploads/${pageId}/move-column`, { column: 'UPI Bank 2', direction: 'down' })).status).toBe(403);
  });
});

describe('Numbers completed when the software report comes later', () => {
  it('fixes a number Claude read, not one a person typed', async () => {
    const h = await hotel();
    await h.register([{ no: '261031', amount: '470', pays: [['cash', '470']] }, { no: '261032', amount: '230', pays: [['upi', '230']] }]);
    await sql`UPDATE register_rows SET status = 'draft', ocr_original = ${JSON.stringify({ engine: 'claude_vision', read: { bill_no: '261031' } })} WHERE id = ${h.rows['261031']}`;
    await sql`UPDATE register_rows SET status = 'draft' WHERE id = ${h.rows['261032']}`;
    await h.software([['2610311', '31 12:00', 'CASH', '470'], ['2610322', '31 12:10', 'UPI', '230']]);
    const nos = (await sql`SELECT bill_no FROM register_rows WHERE business_id = ${h.bid} ORDER BY line_no`).map((x: any) => x.bill_no);
    expect(nos).toEqual(['2610311', '261032']);
  });
});
