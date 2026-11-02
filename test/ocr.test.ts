// "Read page" with Claude vision. The Claude call is replaced by a mock: no test calls the API.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { readWithClaude, OcrError } from '../src/claude';
import { businessWithAllRoles, env, sql, resetDb } from './helpers';
import { CASH_SUMMARY_31_OCT, EXPENSES_31_OCT, REGISTER_31_OCT } from '../demo/sample-data';

const mocked = vi.mocked(readWithClaude);
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 7]);
let seq = 0;

afterAll(() => sql.end());
beforeEach(async () => {
  await resetDb();
  mocked.mockReset();
  Object.assign(env, { ANTHROPIC_API_KEY: 'test-key', CLAUDE_OCR_MODEL: 'claude-opus-5-5', OCR_DAILY_PAGE_LIMIT: '40', OCR_MAX_PARALLEL: '3' });
});
vi.setConfig({ testTimeout: 120_000 });

/** What Claude would return for the invented register page, with two cells it was unsure of. */
const registerReading = () => ({
  data: {
    orientation: 'rotated_90_clockwise', legible: true, page_total: '16215.50',
    rows: REGISTER_31_OCT.map((r, i) => ({
      line: i + 1, bill_no: i === 2 ? null : r.billNo, bill_type: i === 3 ? 'unclear' : r.billType, amount: r.amount, discount: i === 7 ? '20' : null,
      payments: r.payments.map((p) => ({ column: p.columnLabel, mode: p.mode, amount: p.amount })),
      remarks: r.remarks ?? null, unclear: i === 5 ? ['amount'] : [],
    })),
  },
  model: 'claude-opus-5-5',
});

async function page(kind: string, day = '2026-10-31') {
  const h = await businessWithAllRoles('Hotel');
  const id = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=${kind}&day=${day}`, PNG(++seq), 'image/png')).json.id as string;
  return { ...h, id, read: (c = h.clients.entry_staff) => c.post(`/businesses/${h.bid}/uploads/${id}/read`) };
}

describe('Read page: register', () => {
  it('fills draft rows, keeps the original reading, marks unsure cells, and checks the written total', async () => {
    const p = await page('bill_register');
    mocked.mockResolvedValueOnce(registerReading() as never);
    const res = await p.read();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ rows: 16, totalMatches: true, writtenTotalPaise: 1621550, orientation: 'rotated_90_clockwise' });
    expect(res.json.unclearCells).toBe(3); // missing bill number, unclear type, unsure amount
    const rows = await sql`SELECT bill_no, bill_type, amount_paise, status, ocr_original FROM register_rows ORDER BY line_no`;
    expect(rows).toHaveLength(16);
    expect(rows.every((r) => r.status === 'draft')).toBe(true); // never confirmed automatically
    expect(rows[2]).toMatchObject({ bill_no: '' });
    expect(rows[3].bill_type).toBeNull();
    expect(JSON.parse(rows[5].ocr_original)).toMatchObject({ engine: 'claude_vision', model: 'claude-opus-5-5', unclear: ['amount'] });
    expect(rows[10].amount_paise).toBe(124050);
    const [disc] = await sql`SELECT discount_paise FROM register_rows WHERE line_no = 8`;
    expect(disc.discount_paise).toBe(2000);
    const [u] = await sql`SELECT status, ocr_engine, page_written_total_paise FROM uploads WHERE id = ${p.id}`;
    expect(u).toEqual({ status: 'ready', ocr_engine: 'claude_vision', page_written_total_paise: 1621550 });
    const pays = await sql`SELECT count(*) AS n FROM register_payments`;
    expect(pays[0].n).toBe(16); // 15 bills with one payment + one with two, the complimentary bill has none
    // The call got the right instructions and the page itself.
    const [env0, img, instructions] = mocked.mock.calls[0];
    expect(env0.ANTHROPIC_API_KEY).toBe('test-key');
    expect(img.mediaType).toBe('image/png');
    expect(instructions).toMatch(/bill register/);
  });

  it('flags the page when the rows do not add up to the written total', async () => {
    const p = await page('bill_register');
    const r = registerReading();
    r.data.page_total = '16000';
    mocked.mockResolvedValueOnce(r as never);
    expect((await p.read()).json.totalMatches).toBe(false);
    const list = await p.clients.entry_staff.get(`/businesses/${p.bid}/uploads`);
    expect(list.json.uploads.find((u: any) => u.id === p.id).totalDiffers).toBe(1);
  });

  it('a person checking a row is still required before the shift can be confirmed', async () => {
    const p = await page('bill_register');
    mocked.mockResolvedValueOnce(registerReading() as never);
    await p.read();
    const v = await p.clients.owner.get(`/businesses/${p.bid}/shifts/2026-10-31`);
    expect(v.json.blockers.join(' ')).toMatch(/16 register rows are not checked/);
  });

  it('reading again replaces unchecked rows, but not once a row is checked', async () => {
    const p = await page('bill_register');
    mocked.mockResolvedValue(registerReading() as never);
    await p.read();
    expect((await p.read()).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM register_rows`)[0].n).toBe(16);
    const [row] = await sql`SELECT id FROM register_rows WHERE line_no = 1`;
    await p.clients.entry_staff.put(`/businesses/${p.bid}/register-rows/${row.id}`, { billNo: '26103010', billType: 'room', amount: '1250', status: 'checked', payments: [{ mode: 'upi', amount: '1250' }] });
    expect((await p.read()).status).toBe(409);
  });

  it('fixing a cell clears only that cell\'s "Needs input"; the original reading is kept', async () => {
    const p = await page('bill_register');
    mocked.mockResolvedValueOnce(registerReading() as never);
    await p.read();
    const [row] = await sql`SELECT id, ocr_original FROM register_rows WHERE line_no = 4`; // type was unclear
    expect(JSON.parse(row.ocr_original).unclear).toEqual(['bill_type']);
    await p.clients.entry_staff.put(`/businesses/${p.bid}/register-rows/${row.id}`, {
      billNo: '2610313', billType: 'room', amount: '942', status: 'draft', payments: [{ mode: 'card', columnLabel: 'Card', amount: '942' }],
    });
    const [after] = await sql`SELECT ocr_original FROM register_rows WHERE id = ${row.id}`;
    const o = JSON.parse(after.ocr_original);
    expect(o.unclear).toEqual(['bill_type']);
    expect(o.resolved).toEqual(['bill_type']);
    expect(o.read.bill_type).toBe('unclear');
  });

  it('fills in a discount when less was paid, a tip when more was, marked as worked out', async () => {
    const p = await page('bill_register');
    const r = registerReading();
    r.data.rows[1] = { ...r.data.rows[1], amount: '440', discount: null, payments: [{ column: 'UPI XOXO', mode: 'upi', amount: '420' }] } as never; // paid 20 less
    r.data.rows[2] = { ...r.data.rows[2], amount: '380', discount: null, payments: [{ column: 'Cash', mode: 'cash', amount: '400' }] } as never;  // paid more: tip
    mocked.mockResolvedValueOnce(r as never);
    await p.read();
    const rows = await sql`SELECT line_no, amount_paise, discount_paise, tip_paise, ocr_original FROM register_rows WHERE line_no IN (2, 3) ORDER BY line_no`;
    expect(rows[0]).toMatchObject({ amount_paise: 44000, discount_paise: 2000 });
    expect(JSON.parse(rows[0].ocr_original).inferred).toEqual(['discount']);
    expect(rows[1]).toMatchObject({ amount_paise: 38000, discount_paise: 0, tip_paise: 2000 }); // paid more: a tip
    expect(JSON.parse(rows[1].ocr_original).inferred).toEqual(['discount']);
  });

  it('reads one payment shared by several bills as bills paid together', async () => {
    const p = await page('bill_register');
    const r = registerReading();
    r.data.rows[7] = { ...r.data.rows[7], amount: '1890', discount: null, payments: [{ column: 'UPI Bank 2', mode: 'upi', amount: '3400' }], paid_with_line: null } as never;
    r.data.rows[8] = { ...r.data.rows[8], amount: '836', discount: null, payments: [], paid_with_line: 8 } as never;
    r.data.rows[9] = { ...r.data.rows[9], amount: '676', discount: null, payments: [], paid_with_line: 8 } as never;
    mocked.mockResolvedValueOnce(r as never);
    expect((await p.read()).status).toBe(200);
    const rows = await sql`SELECT r.line_no, r.id, r.paid_with_row_id, r.discount_paise, r.tip_paise, r.ocr_original,
      (SELECT count(*) FROM register_payments p WHERE p.register_row_id = r.id) AS pays FROM register_rows r WHERE line_no IN (8, 9, 10) ORDER BY line_no`;
    expect(rows[1].paid_with_row_id).toBe(rows[0].id);
    expect(rows[2].paid_with_row_id).toBe(rows[0].id);
    expect(rows.map((x) => x.pays)).toEqual([1, 0, 0]);
    // 1,890 + 836 + 676 = 3,402 against 3,400 paid: a discount of 2 on the row holding the payment.
    expect(rows[0]).toMatchObject({ discount_paise: 200, tip_paise: 0 });
    expect(JSON.parse(rows[0].ocr_original).inferred).toEqual(['discount']);
    expect(JSON.parse(rows[1].ocr_original).inferred).toEqual(['payments']);
  });

  it('refuses a confirmed shift', async () => {
    const p = await page('bill_register');
    await sql`INSERT INTO shifts (id, business_id, shift_day, status, created_at) VALUES ('s1', ${p.bid}, '2026-10-31', 'confirmed', 0)`;
    expect((await p.read()).status).toBe(409);
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe('Read page: expense list and cash summary', () => {
  it('expense lines become draft expense rows without a head', async () => {
    const p = await page('expense_list');
    mocked.mockResolvedValueOnce({ data: {
      orientation: 'upright', legible: true, page_total: '2910',
      rows: EXPENSES_31_OCT.map((e, i) => ({ line: i + 1, item: e.narration, amount: i === 3 ? 'l20' : e.amount, unclear: [] })),
    }, model: 'claude-opus-5-5' } as never);
    const res = await p.read();
    expect(res.json).toMatchObject({ rows: 4, totalMatches: false, unclearCells: 1 }); // "l20" is not an amount
    const rows = await sql`SELECT narration, amount_paise, head_id, status, type, source FROM transactions ORDER BY line_no`;
    expect(rows.map((r) => r.status)).toEqual(['draft', 'draft', 'draft', 'draft']);
    expect(rows.every((r) => r.head_id === null && r.type === 'expense' && r.source === 'cash_photo')).toBe(true);
    expect(rows[3].amount_paise).toBe(0);
    // Nothing gets approved without a head chosen by a person.
    expect((await p.clients.owner.post(`/businesses/${p.bid}/uploads/${p.id}/expense-rows/approve`)).status).toBe(400);
  });

  it('a known vendor on an expense line gives it the remembered head; an unknown one is kept as read', async () => {
    const p = await page('expense_list');
    const kitchen = (await p.clients.owner.post(`/businesses/${p.bid}/heads`, { name: 'Kitchen purchases', type: 'expense' })).json.id;
    await sql`INSERT INTO parties (id, business_id, name, aliases, default_head_id, created_at) VALUES ('v1', ${p.bid}, 'Blinkit', '[]', ${kitchen}, 0)`;
    mocked.mockResolvedValueOnce({ data: { orientation: 'upright', legible: true, page_total: null, rows: [
      { line: 1, item: 'Vegetables', vendor: 'BLINKIT', amount: '420', unclear: [] },
      { line: 2, item: 'Gas refill', vendor: 'Indane', amount: '900', unclear: [] },
    ] }, model: 'm' } as never);
    await p.read();
    const rows = await sql`SELECT head_id, party_id, ocr_original FROM transactions ORDER BY line_no`;
    expect(rows[0]).toMatchObject({ head_id: kitchen, party_id: 'v1' });
    expect(JSON.parse(rows[0].ocr_original).inferred).toEqual(['head']);
    expect(rows[1]).toMatchObject({ head_id: null, party_id: null });
    expect(JSON.parse(rows[1].ocr_original).read.vendor).toBe('Indane');
  });

  it('cash summary figures are filled as a draft that a person must save before approval', async () => {
    const p = await page('cash_summary');
    const c = CASH_SUMMARY_31_OCT;
    mocked.mockResolvedValueOnce({ data: { orientation: 'upright', legible: true, opening: c.opening, received: c.received, balance: c.balance, expenses: c.expenses, cash_in_hand: null, unclear: ['received'] }, model: 'claude-opus-5-5' } as never);
    expect((await p.read()).json.unclearCells).toBe(2);
    const [s] = await sql`SELECT opening_paise, received_paise, cash_in_hand_paise, status FROM cash_summaries`;
    expect(s).toEqual({ opening_paise: 840000, received_paise: 240050, cash_in_hand_paise: null, status: 'draft' });
    const sid = (await p.clients.owner.get(`/businesses/${p.bid}/uploads/${p.id}`)).json.summary.id;
    expect((await p.clients.owner.post(`/businesses/${p.bid}/cash-summaries/${sid}/approve`, { note: 'x' })).json.error).toMatch(/Save figures/);
  });

  it('an unreadable page asks for a retake and writes no rows', async () => {
    const p = await page('expense_list');
    mocked.mockResolvedValueOnce({ data: { orientation: 'upright', legible: false, page_total: null, rows: [] }, model: 'claude-opus-5-5' } as never);
    const res = await p.read();
    expect(res.status).toBe(422);
    const [u] = await sql`SELECT status FROM uploads WHERE id = ${p.id}`;
    expect(u.status).toBe('retake');
  });
});

describe('Read page: who, how many, and failures', () => {
  it('Owner, Accountant and Entry staff can read; Viewer cannot', async () => {
    const p = await page('expense_list');
    mocked.mockResolvedValue({ data: { orientation: 'upright', legible: true, page_total: null, rows: [] }, model: 'm' } as never);
    expect((await p.read(p.clients.viewer)).status).toBe(403);
    for (const role of ['entry_staff', 'accountant', 'owner'] as const) expect((await p.read(p.clients[role])).status).toBe(200);
  });

  it('stops at the daily cap per business, failures included', async () => {
    env.OCR_DAILY_PAGE_LIMIT = '2';
    const p = await page('expense_list');
    mocked.mockRejectedValueOnce(new OcrError(502, 'Reading the page failed.'));
    mocked.mockResolvedValue({ data: { orientation: 'upright', legible: true, page_total: null, rows: [] }, model: 'm' } as never);
    expect((await p.read()).status).toBe(502);
    expect((await p.read()).status).toBe(200);
    const third = await p.read();
    expect(third.status).toBe(429);
    expect(third.json.error).toMatch(/limit of 2 page reads/);
    expect(mocked).toHaveBeenCalledTimes(2);
    const status = await p.clients.entry_staff.get(`/businesses/${p.bid}/ocr`);
    expect(status.json).toMatchObject({ configured: true, usedToday: 2, dailyLimit: 2 });
  });

  it('allows only a few pages at a time', async () => {
    env.OCR_MAX_PARALLEL = '1';
    const p = await page('expense_list');
    let release!: () => void;
    mocked.mockImplementationOnce(() => new Promise((r) => { release = () => r({ data: { orientation: 'upright', legible: true, page_total: null, rows: [] }, model: 'm' } as never); }));
    const second = (await p.clients.owner.upload(`/businesses/${p.bid}/uploads?kind=expense_list&day=2026-10-31`, PNG(++seq), 'image/png')).json.id;
    const first = p.read();
    await vi.waitFor(() => expect(mocked).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    const blocked = await p.clients.owner.post(`/businesses/${p.bid}/uploads/${second}/read`);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatch(/being read already/);
    release();
    expect((await first).status).toBe(200);
  });

  it('a failed call leaves the rows as they were and says what to do', async () => {
    const p = await page('bill_register');
    await p.clients.entry_staff.post(`/businesses/${p.bid}/uploads/${p.id}/register-rows`, { billNo: '1', billType: 'fnb', amount: '10', payments: [{ mode: 'cash', amount: '10' }] });
    mocked.mockRejectedValueOnce(new OcrError(502, 'Reading the page failed on Claude’s side. Try again shortly, or type the rows in.'));
    const res = await p.read();
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/type the rows in/);
    expect((await sql`SELECT count(*) AS n FROM register_rows`)[0].n).toBe(1);
    const [u] = await sql`SELECT status FROM uploads WHERE id = ${p.id}`;
    expect(u.status).toBe('failed');
  });

  it('with no key it says so clearly, and typing rows in still works', async () => {
    env.ANTHROPIC_API_KEY = undefined as unknown as string;
    const p = await page('bill_register');
    const res = await p.read();
    expect(res.status).toBe(503);
    expect(res.json.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(mocked).not.toHaveBeenCalled();
    expect((await p.clients.entry_staff.get(`/businesses/${p.bid}/ocr`)).json.configured).toBe(false);
    expect((await p.clients.entry_staff.post(`/businesses/${p.bid}/uploads/${p.id}/register-rows`, { billNo: '1', billType: 'fnb', amount: '10', payments: [] })).status).toBe(201);
  });

  it('the key never reaches the browser', async () => {
    const p = await page('bill_register');
    const responses = [
      await p.clients.owner.get(`/businesses/${p.bid}/ocr`),
      await p.clients.owner.get(`/businesses/${p.bid}/uploads/${p.id}`),
      await p.clients.owner.get('/me'),
    ];
    for (const r of responses) expect(JSON.stringify(r.json)).not.toContain('test-key');
  });
});
