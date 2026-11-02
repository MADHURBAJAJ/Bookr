// Register pages read as a grid; short bill numbers completed from the software report; payments read a line off;
// differences nothing explains marked unclear; the Owner's accuracy check. Claude is mocked; all data is invented.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { readWithClaude } from '../src/claude';
import { draftRegisterRows, findSlip, gridToReading, headingRole } from '../src/ocr';
import { businessWithAllRoles, env, sql, resetDb } from './helpers';

const mocked = vi.mocked(readWithClaude);
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 9]);
let seq = 0;

afterAll(() => sql.end());
beforeEach(async () => {
  await resetDb();
  mocked.mockReset();
  Object.assign(env, { ANTHROPIC_API_KEY: 'test-key', CLAUDE_OCR_MODEL: 'claude-opus-5-5', OCR_DAILY_PAGE_LIMIT: '40', OCR_MAX_PARALLEL: '3' });
});
vi.setConfig({ testTimeout: 120_000 });

const HEAD = ['S.No', 'Bill No', 'Closure time', 'Bill Amt', 'Type', 'Cash', 'UPI XOXO', 'UPI Bank 2', 'Card', 'Remarks'];
type Line = [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null];
const grid = (lines: Line[], extra: Partial<{ paid_with_line: number | null; unclear_columns: string[] }>[] = []) => ({
  orientation: 'upright' as const, legible: true, page_total: null, headings: HEAD,
  lines: lines.map((cells, i) => ({ line: i + 1, y: 20 + i * 3, cells, paid_with_line: null, unclear_columns: [], ...extra[i] })),
});

describe('Reading the register as a grid', () => {
  it('knows the columns from their printed headings', () => {
    expect(HEAD.map(headingRole)).toEqual(['line', 'bill_no', null, 'amount', 'type', 'cash', 'upi', 'upi', 'card', 'remarks']);
  });

  it('takes each cell from the column it sits under, dashes are blank, a discount in the remarks is used', () => {
    const r = gridToReading(grid([
      ['1', '26110101', '21:10', '450', 'F&B', '–', '450', '-', null, null],
      ['2', '26110102', '21:30', '1200', 'Room', '200', null, '1000', null, null],
      ['3', '26110103', '21:40', '500', 'f&b', '480', null, null, null, 'Disc 20'],
    ], [{}, {}, { unclear_columns: ['Cash'] }]));
    expect(r.rows[0]).toMatchObject({ bill_no: '26110101', amount: '450', bill_type: 'fnb', payments: [{ column: 'UPI XOXO', mode: 'upi', amount: '450' }] });
    expect(r.rows[1].payments).toEqual([{ column: 'Cash', mode: 'cash', amount: '200' }, { column: 'UPI Bank 2', mode: 'upi', amount: '1000' }]);
    expect(r.rows[1].bill_type).toBe('room');
    expect(r.rows[2]).toMatchObject({ discount: '20', unclear: ['payments'] });
  });

  it('falls back to the usual register columns when the headings cannot be told apart', () => {
    const r = gridToReading({ orientation: 'upright', legible: true, page_total: null, headings: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
      lines: [{ line: 1, y: 20, cells: ['1', '26110101', '300', 'F&B', '300', null, null, null, null], paid_with_line: null, unclear_columns: [] }] });
    expect(r.rows[0]).toMatchObject({ bill_no: '26110101', amount: '300', payments: [{ mode: 'cash', amount: '300' }] });
  });

  it('a line with the wrong number of cells is marked unclear', () => {
    const r = gridToReading({ ...grid([]), lines: [{ line: 1, y: 20, cells: ['1', '26110101', '300'], paid_with_line: null, unclear_columns: [] }] });
    expect(r.rows[0].unclear).toEqual(expect.arrayContaining(['amount', 'payments']));
  });
});

describe('Short bill numbers', () => {
  const read = (bills: string[]) => gridToReading(grid(bills.map((b, i) => [String(i + 1), b, null, '100', 'F&B', '100', null, null, null, null] as Line)));

  it('completes a number that only one software bill ends with, and marks it as worked out', () => {
    const rows = draftRegisterRows(read(['3114', '26103115']), { softwareBills: ['26103114', '26103115', '26103116'] });
    expect(rows[0]).toMatchObject({ billNo: '26103114', completedFrom: '3114' });
    expect(rows[0].inferred).toContain('bill_no');
    expect(rows[1].billNo).toBe('26103115');
  });

  it('leaves it as written and marks it unclear when several bills end with it', () => {
    const rows = draftRegisterRows(read(['14']), { softwareBills: ['26103114', '26103214'] });
    expect(rows[0].billNo).toBe('14');
    expect(rows[0].unclear.has('bill_no')).toBe(true);
  });

  it('does not use a bill already on this page or another page of the shift', () => {
    const rows = draftRegisterRows(read(['26103114', '114']), { softwareBills: ['26103114', '26103214'], takenBills: [] });
    expect(rows[1].billNo).toBe('114');
    const other = draftRegisterRows(read(['3114']), { softwareBills: ['26103114'], takenBills: ['26103114'] });
    expect(other[0].billNo).toBe('3114');
  });
});

describe('Differences nothing explains, and payments a line off', () => {
  const line = (n: number, amt: string, upi: string | null, remarks: string | null = null): Line => [String(n), `2611010${n}`, null, amt, 'F&B', null, upi, null, null, remarks];

  it('a small difference is filled as a discount (amber); a large one with no remark is red', () => {
    const rows = draftRegisterRows(gridToReading(grid([line(1, '500', '480'), line(2, '500', '300'), line(3, '500', '300', 'disc 200 owner')])));
    expect(rows[0]).toMatchObject({ disc: 2000 });
    expect(rows[0].unclear.has('payments')).toBe(false);
    expect(rows[1].unclear.has('payments')).toBe(true);
    expect(rows[2].unclear.has('payments')).toBe(false);
  });

  it('a bill with no payment and no remark is red; "complimentary" explains it', () => {
    const rows = draftRegisterRows(gridToReading(grid([line(1, '500', null), line(2, '0', null, 'Complimentary')])));
    expect(rows[0].unclear.has('payments')).toBe(true);
    expect(rows[1].unclear.has('payments')).toBe(false);
  });

  it('finds payments sitting one line above their bills, and marks those lines', () => {
    expect(findSlip([
      { line: 1, amt: 450, paid: 820, grouped: false }, { line: 2, amt: 820, paid: 300, grouped: false },
      { line: 3, amt: 300, paid: 610, grouped: false }, { line: 4, amt: 610, paid: null, grouped: false },
    ])).toEqual({ direction: 'up', lines: [1, 2, 3] });
    expect(findSlip([{ line: 1, amt: 450, paid: 450, grouped: false }, { line: 2, amt: 820, paid: 820, grouped: false }])).toBeNull();
    // Written a line lower, with the usual tips and discounts: 385 for a bill of 368, 418 for 398, 188 for 199.
    expect(findSlip([
      { line: 1, amt: 36800, paid: 23000, grouped: false }, { line: 2, amt: 39800, paid: 38500, grouped: false },
      { line: 3, amt: 19900, paid: 41800, grouped: false }, { line: 4, amt: 50400, paid: 18800, grouped: false },
    ])).toEqual({ direction: 'down', lines: [2, 3, 4] });
    const rows = draftRegisterRows(gridToReading(grid([line(1, '450', '820'), line(2, '820', '300'), line(3, '300', '610'), line(4, '610', null)])));
    expect(rows.slice(0, 3).every((x) => x.unclear.has('payments'))).toBe(true);
  });
});

async function page() {
  const h = await businessWithAllRoles('Hotel');
  const id = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-11-01`, PNG(++seq), 'image/png')).json.id as string;
  return { ...h, id };
}
const slipped = () => grid([
  ['1', '26110101', null, '450', 'F&B', null, '820', null, null, null],
  ['2', '26110102', null, '820', 'F&B', null, '300', null, null, null],
  ['3', '26110103', null, '300', 'F&B', null, '610', null, null, null],
  ['4', '26110104', null, '610', 'F&B', null, '450', null, null, null],
]);

describe('Shift them back', () => {
  it('the page offers to move the payments back; one step moves them and leaves the odd one marked', async () => {
    const p = await page();
    mocked.mockResolvedValueOnce({ data: slipped(), model: 'claude-opus-5-5' } as never);
    expect((await p.clients.entry_staff.post(`/businesses/${p.bid}/uploads/${p.id}/read`)).status).toBe(200);
    const detail = (await p.clients.entry_staff.get(`/businesses/${p.bid}/uploads/${p.id}`)).json;
    expect(detail.slip).toEqual({ direction: 'up', lines: [1, 2, 3, 4], receiver: 1 });
    expect((await p.clients.entry_staff.post(`/businesses/${p.bid}/uploads/${p.id}/shift-payments`, { direction: 'down' })).status).toBe(409);
    const res = await p.clients.entry_staff.post(`/businesses/${p.bid}/uploads/${p.id}/shift-payments`, { direction: 'up' });
    expect(res.json).toEqual({ moved: 4, checkLine: 1 });
    const rows = await sql`SELECT r.line_no, r.amount_paise, r.discount_paise, r.tip_paise, r.ocr_original, (SELECT sum(amount_paise) FROM register_payments p WHERE p.register_row_id = r.id) AS paid
      FROM register_rows r ORDER BY line_no`;
    expect(rows.map((r) => r.paid)).toEqual([45000, 82000, 30000, 61000]);
    expect(rows.every((r) => r.discount_paise === 0 && r.tip_paise === 0)).toBe(true); // the worked-out discounts went with the wrong payments
    expect(JSON.parse(rows[1].ocr_original).inferred).toContain('payments');
    expect(JSON.parse(rows[2].ocr_original).y).toBe(26); // where the line is on the photo, for the strip on Review
    const [log] = await sql`SELECT after FROM audit_log WHERE action = 'register.shift_payments'`;
    expect(JSON.parse(log.after).moves).toHaveLength(4);
    expect((await p.clients.entry_staff.get(`/businesses/${p.bid}/uploads/${p.id}`)).json.slip).toBeNull();
  });
});

describe('Check reading accuracy (Owner)', () => {
  it('re-reads a fully checked page and counts right and wrong fields, first reading against now; nothing changes', async () => {
    const p = await page();
    mocked.mockResolvedValueOnce({ data: slipped(), model: 'claude-opus-5-5' } as never);
    await p.clients.entry_staff.post(`/businesses/${p.bid}/uploads/${p.id}/read`);
    await p.clients.entry_staff.post(`/businesses/${p.bid}/uploads/${p.id}/shift-payments`, { direction: 'up' });
    for (const r of await sql`SELECT id, bill_no, amount_paise FROM register_rows ORDER BY line_no`) {
      const amt = String(r.amount_paise / 100);
      await p.clients.entry_staff.put(`/businesses/${p.bid}/register-rows/${r.id}`, { billNo: r.bill_no, billType: 'fnb', amount: amt, status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI XOXO', amount: amt }] });
    }
    expect((await p.clients.accountant.get(`/businesses/${p.bid}/ocr/accuracy-pages`)).status).toBe(403);
    const pages = (await p.clients.owner.get(`/businesses/${p.bid}/ocr/accuracy-pages`)).json.pages;
    expect(pages).toEqual([expect.objectContaining({ id: p.id, rows: 4 })]);
    // Now read right: every payment on its own line.
    mocked.mockResolvedValueOnce({ data: grid([
      ['1', '26110101', null, '450', 'F&B', null, '450', null, null, null], ['2', '26110102', null, '820', 'F&B', null, '820', null, null, null],
      ['3', '26110103', null, '300', 'F&B', null, '300', null, null, null], ['4', '26110104', null, '610', 'F&B', null, '610', null, null, null],
    ]), model: 'claude-opus-5-5' } as never);
    const before = await sql`SELECT id, ocr_original, status FROM register_rows ORDER BY line_no`;
    const res = await p.clients.owner.post(`/businesses/${p.bid}/ocr/accuracy/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.json.before.payments).toEqual({ right: 0, wrongRed: 4, wrongAmber: 0, wrongUnmarked: 0 }); // three a line off, and line 4 paid 450 on 610
    expect(res.json.after.payments).toEqual({ right: 4, wrongRed: 0, wrongAmber: 0, wrongUnmarked: 0 });
    expect(res.json.after.bill_no.right).toBe(4);
    expect(await sql`SELECT id, ocr_original, status FROM register_rows ORDER BY line_no`).toEqual(before);
    const [{ n }] = await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'ocr.read'`;
    expect(Number(n)).toBe(2); // counts toward today's limit
  });
});
