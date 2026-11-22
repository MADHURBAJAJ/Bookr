// Page reading, second round (approved 23 Nov 2026): bill numbers with digits missing, written as dates or one digit
// wrong; the end of a number only at a near amount; the shift's dates told to Claude; crossed-out lines; payments far
// larger than the bill; "4ok"; and the re-check when a page is opened. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { completeBillNo, dateFormNumber, draftRegisterRows, gridToReading, registerInstructions, splitPaymentCell } from '../src/ocr';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Which software bill a number stands for', () => {
  const sw = new Map([['26111115', 400000], ['26111180', 21900], ['26111130', 143400], ['26111139', 900000], ['26111151', 255000], ['2611112', 23000], ['26111112', 23000]]);
  it('fills missing digits, a date form and one wrong digit, only at the same amount', () => {
    expect(completeBillNo('26/11/15', [400000], sw, new Set())).toEqual({ billNo: '26111115', how: 'missing' });
    expect(completeBillNo('2611115', [400000], sw, new Set())).toEqual({ billNo: '26111115', how: 'missing' });
    expect(completeBillNo('1158', [255000], sw, new Set())).toEqual({ billNo: '26111151', how: 'digit' });
    // "1180" ends 26111180, but that is ₹219: the ₹1,434 bill one digit away is the one.
    expect(completeBillNo('1180', [143400, 443400], sw, new Set())).toEqual({ billNo: '26111130', how: 'digit' });
    // The end of a number at a far amount, and the bill already on another line: left for a person.
    expect(completeBillNo('1139', [400000, 600000], sw, new Set())).toBeNull();
    expect(completeBillNo('1158', [255000], sw, new Set(['26111151']))).toBeNull();
    // Two real bills at ₹230 with the digits: not chosen.
    expect(completeBillNo('261112', [23000], sw, new Set())).toBe('several');
  });
  it('looks at the previous shift\'s bills still missing on the register', () => {
    expect(completeBillNo('2611107', [120000], sw, new Set(), new Map([['26111071', 120000]]))).toEqual({ billNo: '26111071', how: 'missing' });
  });
  it('turns a date form that fits nothing into the shift date and running number', () => {
    expect(dateFormNumber('26/11/36', '2026-11-11')).toBe('26111136');
    expect(dateFormNumber('26/10/36', '2026-11-11')).toBeNull();
  });
  it('tells Claude the shift dates', () => {
    const t = registerInstructions('2026-11-30');
    expect(t).toContain('261130');
    expect(t).toContain('261201');
    expect(t).toContain('never as a date');
  });
});

describe('What a page line says', () => {
  const grid = (cells: (string | null)[], struck = false) => gridToReading({ orientation: 'upright', legible: true, page_total: null, total_cells: null,
    headings: ['S.No', 'Bill No', 'Bill Amt', 'Type', 'Cash', 'UPI Bank 2', 'Remarks'], lines: [{ line: 1, y: 10, cells, paid_with_line: null, unclear_columns: [], struck }] });
  it('reads "4ok" as ₹4,000 only when that is the bill', () => {
    expect(splitPaymentCell('4ok', '4000')).toEqual({ amount: '4000', discount: null, note: null });
    expect(splitPaymentCell('4ok', '3500')).toEqual({ amount: null, discount: null, note: '4ok' });
    expect(splitPaymentCell('4k')).toMatchObject({ amount: null });
  });
  it('does not take a payment far larger than the bill, nor fill a tip over ₹50', () => {
    const r = draftRegisterRows(grid(['1', '26103131', '2700', 'Room', '100815', '2600', null]));
    expect(r[0].pays.map((p) => p.paise)).toEqual([260000]);
    expect(r[0].dropped).toEqual([{ column: 'Cash', paise: 10081500 }]);
    expect(r[0].unclear.has('payments')).toBe(true);
    const tip = draftRegisterRows(grid(['1', '26103132', '900', 'Room', null, '1000', null]));
    expect(tip[0]).toMatchObject({ disc: null, tip: 0 });
    expect(tip[0].unclear.has('payments')).toBe(true);
  });
  it('keeps a crossed-out line, marked', () => {
    expect(grid(['1', '26103133', '1960', 'F&B', null, '1960', null], true).rows[0].struck).toBe(true);
  });
});

describe('The page re-check', () => {
  it('completes numbers, re-reads payment cells and takes off impossible payments, then leaves them unticked', async () => {
    const h = await hotel();
    await h.software([
      ['26103115', '31 12:00', 'CASH', '400'],
      ['26103130', '31 12:10', 'UPI', '1434'],
      ['26103180', '31 12:20', 'UPI', '219'],
      ['26103140', '31 12:30', 'UPI', '2900'],
      ['26103145', '31 12:40', 'UPI', '2700'],
      ['26103150', '31 12:50', 'CASH', '500'],
    ]);
    await h.register([
      { no: '26/10/15', amount: '400', pays: [['cash', '400']] },
      { no: '26103180', amount: '1434', pays: [['upi', '1434']] },
      { no: '26103140', amount: '2900', pays: [['upi', '2900']] },
      { no: '26103145', amount: '2700', discount: '-100715', pays: [['cash', '100815'], ['upi', '2600']] },
      { no: '26/10/50', amount: '500', pays: [['cash', '500']] },
    ]);
    await sql`UPDATE register_rows SET status = 'draft' WHERE business_id = ${h.bid}`;
    await sql`DELETE FROM register_payments WHERE register_row_id = ${h.rows['26103140']}`; // the cell said "2900 paid"
    const ocr = (o: object) => JSON.stringify({ engine: 'claude_vision', model: 'm', ...o });
    await sql`UPDATE register_rows SET ocr_original = ${ocr({ read: { bill_no: '26/10/15', amount: '400', payments: [] }, inferred: [], unclear: [] })} WHERE id = ${h.rows['26/10/15']}`;
    await sql`UPDATE register_rows SET ocr_original = ${ocr({ read: { bill_no: '3180', amount: '1434', payments: [] }, inferred: ['bill_no'], unclear: [], completedFrom: '3180' })} WHERE id = ${h.rows['26103180']}`;
    await sql`UPDATE register_rows SET ocr_original = ${ocr({ read: { bill_no: '26103140', amount: '2900', payments: [{ column: 'UPI Bank 2', mode: 'upi', amount: '2900 paid' }] }, inferred: [], unclear: ['payments'] })} WHERE id = ${h.rows['26103140']}`;
    await sql`UPDATE register_rows SET ocr_original = ${ocr({ read: { bill_no: '26103145', amount: '2700', payments: [] }, inferred: ['discount'], unclear: [] })} WHERE id = ${h.rows['26103145']}`;
    // A person typed this one: it stays theirs.
    await sql`UPDATE register_rows SET ocr_original = ${ocr({ read: { bill_no: '26/10/50', amount: '500', payments: [] }, inferred: [], unclear: [] })} WHERE id = ${h.rows['26/10/50']}`;
    await sql`INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (${h.bid}, NULL, 'register.edit', 'register_rows', ${h.rows['26/10/50']}, '{}', '{}', 1)`;

    const r = await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/auto-tick`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.fixed).toBe(4);
    const rows = await sql`SELECT id, bill_no, discount_paise, tip_paise, status, ocr_original,
      (SELECT json_group_array(amount_paise) FROM register_payments p WHERE p.register_row_id = r.id) AS pays
      FROM register_rows r WHERE business_id = ${h.bid} ORDER BY line_no`;
    const by = (id: string) => rows.find((x: any) => x.id === id) as any;
    expect(by(h.rows['26/10/15']).bill_no).toBe('26103115');
    expect(by(h.rows['26103180']).bill_no).toBe('26103130');
    expect(JSON.parse(by(h.rows['26103140']).pays)).toEqual([290000]);
    const six = by(h.rows['26103145']);
    expect(JSON.parse(six.pays)).toEqual([260000]);
    expect([six.discount_paise, six.tip_paise].map(Number)).toEqual([0, 0]);
    expect(JSON.parse(six.ocr_original).dropped).toEqual([{ column: 'Cash', paise: 10081500 }]);
    expect(by(h.rows['26/10/50']).bill_no).toBe('26/10/50');
    // Bookr's changes are not ticked by Bookr: completed lines wait for a person.
    expect(rows.filter((x: any) => x.status === 'checked').map((x: any) => x.bill_no)).not.toContain('26103115');
    // Again: nothing more to do.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/auto-tick`, {})).json.fixed).toBe(0);
    const items = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/changes`)).json.items as any[];
    expect(items.filter((x) => x.action === 'register.recheck' || x.action === 'register.number_completed').length).toBe(4);
  });
});
