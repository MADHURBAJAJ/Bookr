// Phase 2 through the API: import, overlaps, coverage, comparison, decisions, confirm, reopen,
// uploads, expense rows and the cash summary checks. Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, Client, sql, resetDb, uploads } from './helpers';
import { buildSalesCsv, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
// A full shift is ~20 API calls with many queries each; the local D1 proxy is slow per query.
vi.setConfig({ testTimeout: 180_000 });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = (n: number) => { const b = new Uint8Array(PNG); b[10] = n; return b; };
const DAY_START = (y: number, m: number, d: number) => istToMs(y, m, d, 0, 0, 0);
const DAY_END = (y: number, m: number, d: number) => istToMs(y, m, d, 23, 59, 59);

/** A hotel with every role, F&B and Room income heads mapped to their bill types. */
async function hotel() {
  const h = await businessWithAllRoles('Hotel');
  const o = h.clients.owner;
  const fnb = (await o.post(`/businesses/${h.bid}/heads`, { name: 'F&B', type: 'income' })).json.id;
  const room = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Room', type: 'income' })).json.id;
  expect((await h.clients.accountant.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: fnb })).status).toBe(200);
  expect((await o.put(`/businesses/${h.bid}/bill-type-heads/room`, { headId: room })).status).toBe(200);
  const importCsv = (c: Client, bills: SampleBill[], extra: Record<string, unknown> = {}) =>
    c.post(`/businesses/${h.bid}/sales-reports`, { day: '2026-10-31', csv: buildSalesCsv(bills), ...extra });
  return { ...h, fnb, room, importCsv };
}

/** Imports both sample reports covering whole days, and types in the 31 Oct register. */
async function fullShift(h: Awaited<ReturnType<typeof hotel>>, register = REGISTER_31_OCT) {
  const o = h.clients.owner;
  expect((await h.importCsv(o, REPORT_31_OCT, { coversFrom: DAY_START(2026, 10, 31), coversTo: DAY_END(2026, 10, 31) })).status).toBe(201);
  expect((await h.importCsv(o, REPORT_1_NOV_EARLY, { coversFrom: DAY_START(2026, 11, 1), coversTo: istToMs(2026, 11, 1, 7, 59, 59) })).status).toBe(201);
  const page = await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(1), 'image/png');
  expect(page.status).toBe(201);
  for (const r of register) {
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page.json.id}/register-rows`, {
      billNo: r.billNo, billType: r.billType, amount: r.amount, discount: (r as { discount?: string }).discount ?? '0', remarks: r.remarks ?? null, status: 'checked',
      payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: p.amount })),
    });
    expect(res.status).toBe(201);
  }
  return page.json.id as string;
}

const view = (h: { bid: string; clients: Record<string, Client> }, day = '2026-10-31') => h.clients.owner.get(`/businesses/${h.bid}/shifts/${day}`);
const byBill = (v: { json: { comparisons: { billNo: string }[] } }, bill: string) => v.json.comparisons.find((c) => c.billNo === bill) as any;

describe('software report import', () => {
  it('previews without saving, then imports with each bill in its shift', async () => {
    const h = await hotel();
    const preview = await h.importCsv(h.clients.entry_staff, REPORT_31_OCT, { dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ bills: 16, add: 16, skip: 0, flag: 0, complimentary: 1, shifts: ['2026-10-30', '2026-10-31'] });
    expect(preview.json.coversFrom).toBe(istToMs(2026, 10, 31, 0, 20, 11)); // defaults to the first and last payment
    expect(preview.json.coversTo).toBe(istToMs(2026, 10, 31, 23, 40, 55));
    expect((await sql`SELECT count(*) AS n FROM software_bills`)[0].n).toBe(0);

    expect((await h.importCsv(h.clients.entry_staff, REPORT_31_OCT)).status).toBe(201);
    const listed = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads`)).json.uploads.find((u: any) => u.kind === 'software_sales_csv');
    expect(listed.report).toMatchObject({ added: 16, skipped: 0, flagged: 0, openConflicts: 0, shiftDays: ['2026-10-30', '2026-10-31'] });
    const days = await sql`SELECT shift_day, count(*) AS n FROM software_bills GROUP BY shift_day ORDER BY shift_day`;
    expect(days).toEqual([{ shift_day: '2026-10-30', n: 3 }, { shift_day: '2026-10-31', n: 13 }]);
    const [b] = await sql`SELECT amount_paise, mode, is_complimentary FROM software_bills WHERE bill_no = '26103121'`;
    expect(b).toEqual({ amount_paise: 124050, mode: 'cash', is_complimentary: 0 });
    const [comp] = await sql`SELECT is_complimentary FROM software_bills WHERE bill_no = '2610316'`;
    expect(comp.is_complimentary).toBe(1);
  });

  it('stores no guest name anywhere: not in D1, not in the stored copy', async () => {
    const h = await hotel();
    const res = await h.importCsv(h.clients.owner, REPORT_31_OCT);
    const [u] = await sql`SELECT storage_key FROM uploads WHERE kind = 'software_sales_csv'`;
    const stored = await (await uploads.get(u.storage_key))!.text();
    expect(stored).not.toMatch(/Asha|Vikram|Room 4/);
    expect(stored).toContain('26103120');
    for (const table of ['software_bills', 'sales_reports', 'uploads', 'audit_log', 'bill_comparisons']) {
      const rows = await sql([`SELECT * FROM ${table}`] as unknown as TemplateStringsArray);
      expect(JSON.stringify(rows)).not.toMatch(/Asha|Vikram/);
    }
    expect(res.status).toBe(201);
  });

  it('refuses a file whose footer does not add up, and saves nothing', async () => {
    const h = await hotel();
    const res = await h.clients.owner.post(`/businesses/${h.bid}/sales-reports`, { day: '2026-10-31', csv: buildSalesCsv(REPORT_31_OCT, { breakFooter: 'upi' }) });
    expect(res.status).toBe(400);
    expect(res.json.problems.join(' ')).toMatch(/UPI/);
    expect((await sql`SELECT count(*) AS n FROM uploads`)[0].n).toBe(0);
  });

  it('refuses the same file twice', async () => {
    const h = await hotel();
    expect((await h.importCsv(h.clients.owner, REPORT_31_OCT)).status).toBe(201);
    expect((await h.importCsv(h.clients.owner, REPORT_31_OCT)).status).toBe(409);
  });

  it('the covered period must include every bill', async () => {
    const h = await hotel();
    const res = await h.importCsv(h.clients.owner, REPORT_31_OCT, { coversFrom: DAY_START(2026, 10, 31), coversTo: istToMs(2026, 10, 31, 12, 0, 0) });
    expect(res.status).toBe(400);
  });

  it('Owner, Accountant and Entry staff can import; Viewer cannot', async () => {
    const h = await hotel();
    expect((await h.importCsv(h.clients.viewer, REPORT_31_OCT, { dryRun: true })).status).toBe(403);
    expect((await h.importCsv(h.clients.entry_staff, REPORT_31_OCT, { dryRun: true })).status).toBe(200);
    expect((await h.importCsv(h.clients.accountant, REPORT_31_OCT, { dryRun: true })).status).toBe(200);
  });
});

describe('overlapping files', () => {
  it('skips identical bills and flags different ones, never overwriting', async () => {
    const h = await hotel();
    await h.importCsv(h.clients.owner, REPORT_31_OCT);
    const overlap: SampleBill[] = [
      REPORT_31_OCT[14],                                  // identical
      { ...REPORT_31_OCT[15], amount: '870' },            // 26103122 differs
      ...REPORT_1_NOV_EARLY,                              // new
    ];
    const res = await h.importCsv(h.clients.owner, overlap);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ add: 3, skip: 1, flag: 1 });
    const [kept] = await sql`SELECT amount_paise FROM software_bills WHERE bill_no = '26103122'`;
    expect(kept.amount_paise).toBe(78000);
    const v = await view(h);
    expect(v.json.conflicts).toHaveLength(1);
    expect(v.json.conflicts[0]).toMatchObject({ billNo: '26103122', existing: { amountPaise: 78000 }, incoming: { amountPaise: 87000 } });
    expect(v.json.blockers.join(' ')).toMatch(/overlapping bill differs/);
  });

  it('a person decides the overlap: Entry staff cannot, Accountant can use the incoming values', async () => {
    const h = await hotel();
    await h.importCsv(h.clients.owner, REPORT_31_OCT);
    await h.importCsv(h.clients.owner, [{ ...REPORT_31_OCT[15], amount: '870' }]);
    const id = (await view(h)).json.conflicts[0].id;
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/conflicts/${id}`, { decision: 'use_incoming' })).status).toBe(403);
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/conflicts/${id}`, { decision: 'use_incoming' })).status).toBe(200);
    const [b] = await sql`SELECT amount_paise FROM software_bills WHERE bill_no = '26103122'`;
    expect(b.amount_paise).toBe(87000);
    expect((await view(h)).json.conflicts).toHaveLength(0);
    const [a] = await sql`SELECT action FROM audit_log WHERE action = 'conflict.decide'`;
    expect(a).toBeTruthy();
  });

  it('a corrected file can replace an earlier one before the shift is confirmed', async () => {
    const h = await hotel();
    const first = await h.importCsv(h.clients.owner, REPORT_31_OCT);
    const corrected = REPORT_31_OCT.map((b) => (b.bill === '2610317' ? { ...b, amount: '4140' } : b));
    const res = await h.importCsv(h.clients.owner, corrected, { replaces: first.json.id });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ add: 16, skip: 0, flag: 0 });
    const [b] = await sql`SELECT amount_paise FROM software_bills WHERE bill_no = '2610317'`;
    expect(b.amount_paise).toBe(414000);
    const [old] = await sql`SELECT replaced_by FROM sales_reports WHERE id = ${first.json.id}`;
    expect(old.replaced_by).toBe(res.json.id);
  });
});

describe('shift coverage', () => {
  it('a shift stays incomplete until imported coverage spans 8 am to 8 am', async () => {
    const h = await hotel();
    await h.importCsv(h.clients.owner, REPORT_31_OCT);
    let v = await view(h);
    expect(v.json.gaps.length).toBeGreaterThan(0);
    expect(v.json.blockers.join(' ')).toMatch(/not covered/);
    // Widen the first report to the whole day, then add the early hours of 1 Nov.
    const rid = v.json.reports[0].id;
    expect((await h.clients.owner.patch(`/businesses/${h.bid}/sales-reports/${rid}`, { coversFrom: DAY_START(2026, 10, 31), coversTo: DAY_END(2026, 10, 31) })).status).toBe(200);
    v = await view(h);
    expect(v.json.gaps).toEqual([{ from: istToMs(2026, 11, 1, 0, 0, 0), to: istToMs(2026, 11, 1, 8, 0, 0) }]);
    await h.importCsv(h.clients.owner, REPORT_1_NOV_EARLY, { coversFrom: DAY_START(2026, 11, 1), coversTo: istToMs(2026, 11, 1, 7, 59, 59) });
    v = await view(h);
    expect(v.json.gaps).toEqual([]);
  });

  it('one report spanning several days can cover a shift on its own', async () => {
    const h = await hotel();
    const res = await h.importCsv(h.clients.owner, [...REPORT_31_OCT, ...REPORT_1_NOV_EARLY], { coversFrom: DAY_START(2026, 10, 30), coversTo: DAY_END(2026, 11, 1) });
    expect(res.status).toBe(201);
    expect((await view(h)).json.gaps).toEqual([]);
    expect((await view(h, '2026-10-30')).json.gaps).toEqual([]);
  });
});

describe('comparison and decisions', () => {
  it('finds every kind of difference in the sample shift', async () => {
    const h = await hotel();
    await fullShift(h);
    const v = await view(h);
    expect(byBill(v, '2610311').difference).toBe('match');
    expect(byBill(v, '26103115').difference).toBe('mode');
    expect(byBill(v, '2610317').difference).toBe('amount');
    expect(byBill(v, '2610318').difference).toBe('mode');           // U/N in the software
    expect(byBill(v, '2610319').difference).toBe('missing_in_register');
    expect(byBill(v, '26103120').difference).toBe('mode');          // part cash, part UPI
    expect(byBill(v, '26103120').register.mode).toBe('mixed');
    expect(byBill(v, '26103125').difference).toBe('missing_in_software');
    expect(byBill(v, '2610316').difference).toBe('complimentary');
    expect(byBill(v, '26103010').difference).toBe('match');          // previous day's number, paid in this shift
    expect(byBill(v, '2611011').difference).toBe('match');           // next day's number, paid before 8 am
    expect(v.json.comparisons.filter((c: any) => ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'].includes(c.difference))).toHaveLength(6);
    expect(v.json.canConfirm).toBe(false);
  });

  it('an amount and mode difference is one combined type', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.map((r) => (r.billNo === '2610311' ? { ...r, amount: '400', payments: [{ mode: 'cash' as const, columnLabel: 'Cash', amount: '400' }] } : r));
    await fullShift(h, reg);
    expect(byBill(await view(h), '2610311').difference).toBe('amount_and_mode');
  });

  it('only Owner and Accountant decide; the app refuses sides that cannot work', async () => {
    const h = await hotel();
    await fullShift(h);
    const v = await view(h);
    const put = (c: Client, bill: string, decision: string) => c.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`, { decision });
    expect((await put(h.clients.entry_staff, '2610317', 'use_software')).status).toBe(403);
    expect((await put(h.clients.viewer, '2610317', 'use_software')).status).toBe(403);
    expect((await put(h.clients.accountant, '2610317', 'use_software')).status).toBe(200);
    // Missing in the register: "Use software" needs a type (F&B or Room) with it.
    expect((await put(h.clients.owner, '2610319', 'use_software')).json.error).toMatch(/choose its type/);
    // Unknown mode in the software: cannot be used.
    expect((await put(h.clients.owner, '2610318', 'use_software')).json.error).toMatch(/does not say how/);
    expect((await put(h.clients.owner, '2611011', 'use_register')).status).toBe(400); // a match needs no decision
    const [a] = await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.decide'`;
    expect(a.n).toBe(1);
  });

  it('editing a decided bill clears its decision and logs it', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    let v = await view(h);
    await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610317').id}`, { decision: 'use_register' });
    const [row] = await sql`SELECT id FROM register_rows WHERE bill_no = '2610317'`;
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${row.id}`, {
      billNo: '2610317', billType: 'fnb', amount: '4400', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI XOXO', amount: '4400' }],
    });
    v = await view(h);
    expect(byBill(v, '2610317').decision).toBeNull();
    const [a] = await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.decision_cleared'`;
    expect(a.n).toBe(1);
    expect(pageId).toBeTruthy();
  });
});

async function decideAll(h: Awaited<ReturnType<typeof hotel>>) {
  const v = await view(h);
  const decide = (bill: string, decision: string) => h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`,
    decision === 'leave_out' ? { decision, note: 'Cancelled in POS' } : { decision });
  expect((await decide('26103115', 'use_register')).status).toBe(200);   // cash 403
  expect((await decide('2610317', 'use_software')).status).toBe(200);    // UPI 4410
  expect((await decide('2610318', 'use_register')).status).toBe(200);    // UPI 650
  expect((await decide('2610319', 'leave_out')).status).toBe(200);
  expect((await decide('26103120', 'use_register')).status).toBe(200);   // cash 1000 + UPI 1560
  expect((await decide('26103125', 'use_register')).status).toBe(200);   // cash 500
}

describe('confirming a shift', () => {
  it('lists what blocks confirmation', async () => {
    const h = await hotel();
    await fullShift(h);
    const res = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(res.status).toBe(409);
    expect(res.json.problems.join(' ')).toMatch(/6 differences are not decided/);
  });

  it('creates approved income rows that follow each decision', async () => {
    const h = await hotel();
    await fullShift(h);
    await decideAll(h);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(403);
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(res.status).toBe(200);
    const rows = await sql`SELECT t.bill_no, t.amount_paise, t.payment_mode, t.status, t.account_id, t.match_status, t.confirmed_source, h.name AS head, a.kind
      FROM transactions t LEFT JOIN heads h ON h.id = t.head_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.shift_day = '2026-10-31' ORDER BY t.bill_no, t.payment_mode`;
    expect(rows.every((r) => r.status === 'approved')).toBe(true);
    expect(rows.find((r) => r.bill_no === '2610319')).toBeUndefined();     // left out
    expect(rows.find((r) => r.bill_no === '2610316')).toBeUndefined();     // complimentary
    expect(rows.filter((r) => r.bill_no === '26103120')).toHaveLength(2);  // part cash, part UPI
    const cash = rows.filter((r) => r.payment_mode === 'cash');
    expect(cash.every((r) => r.kind === 'cash' && r.match_status === null)).toBe(true);
    expect(rows.filter((r) => r.payment_mode === 'upi').every((r) => r.account_id === null && r.match_status === 'awaiting_bank_match')).toBe(true);
    expect(rows.find((r) => r.payment_mode === 'card')).toMatchObject({ account_id: null, match_status: 'awaiting_card_settlement', head: 'Room' });
    expect(rows.find((r) => r.bill_no === '2610317')).toMatchObject({ amount_paise: 441000, confirmed_source: 'software', head: 'F&B' });
    expect(rows.find((r) => r.bill_no === '2610311')).toMatchObject({ confirmed_source: 'both_matched' });
    // 380 + 403 + 1000 + 1240.50 + 560 + 220 + 500
    expect(cash.reduce((s, r) => s + r.amount_paise, 0)).toBe(430350);
    const [a] = await sql`SELECT after FROM audit_log WHERE action = 'shift.confirm'`;
    expect(JSON.parse(a.after)).toMatchObject({ incomeRows: rows.length });
  });

  it('confirming twice at the same moment creates the rows once', async () => {
    const h = await hotel();
    await fullShift(h);
    await decideAll(h);
    const results = await Promise.all([
      h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`),
      h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const [n] = await sql`SELECT count(*) AS n FROM transactions WHERE shift_day = '2026-10-31'`;
    expect(n.n).toBe(16);
  });

  it('a confirmed shift is locked: no register edits, decisions or imports into it', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    await decideAll(h);
    await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    const [row] = await sql`SELECT id FROM register_rows WHERE bill_no = '2610311'`;
    const edit = await h.clients.owner.put(`/businesses/${h.bid}/register-rows/${row.id}`, { billNo: '2610311', billType: 'fnb', amount: '1', status: 'checked', payments: [{ mode: 'cash', amount: '1' }] });
    expect(edit.status).toBe(409);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: '9', billType: 'fnb', amount: '1', payments: [] })).status).toBe(409);
    const v = await view(h);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610319').id}`, { decision: 'use_register' })).status).toBe(400);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610317').id}`, { decision: 'leave_out' })).status).toBe(409);
    const late: SampleBill = { pos: 'POS-1', bill: '26103199', when: '31-10-2026.18:00:00', name: 'U/N', mode: 'CASH', amount: '100' };
    expect((await h.importCsv(h.clients.owner, [late])).status).toBe(409);
    // The database refuses too, whatever the app does.
    await expect(sql`UPDATE register_rows SET amount_paise = 1 WHERE id = ${row.id}`).rejects.toThrow(/shift_confirmed/);
  });

  it('only an Owner can reopen; the rows go, and are kept in the audit log', async () => {
    const h = await hotel();
    await fullShift(h);
    await decideAll(h);
    await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/reopen`, { reason: 'Typo' })).status).toBe(403);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/reopen`, {})).status).toBe(400); // a reason is required
    const res = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/reopen`, { reason: 'Bill 2610317 was mistyped' });
    expect(res.status).toBe(200);
    expect(res.json.removed).toBe(16);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE shift_day = '2026-10-31'`)[0].n).toBe(0);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'transaction.remove_on_reopen'`)[0].n).toBe(16);
    const [s] = await sql`SELECT status, reopen_reason FROM shifts WHERE shift_day = '2026-10-31'`;
    expect(s).toEqual({ status: 'comparing', reopen_reason: 'Bill 2610317 was mistyped' });
    // Decisions survive the reopen, and the shift can be confirmed again.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
  });

  it('a shift with rows matched to the bank cannot be reopened', async () => {
    const h = await hotel();
    await fullShift(h);
    await decideAll(h);
    await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    await sql`UPDATE transactions SET matched_bank_row = 'bank-1' WHERE payment_mode = 'upi' AND bill_no = '2610311'`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/reopen`, { reason: 'x' })).status).toBe(409);
  });

  it('needs an income head for each bill type, set by Owner or Accountant only', async () => {
    const h = await businessWithAllRoles('Hotel');
    const exp = (await h.clients.owner.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.type === 'expense').id;
    const inc = (await h.clients.owner.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.type === 'income').id;
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: inc })).status).toBe(403);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: exp })).status).toBe(400);
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: inc })).status).toBe(200);
  });
});

describe('photo uploads', () => {
  it('accepts JPG, PNG or PDF by their contents, from Owner, Accountant and Entry staff', async () => {
    const h = await hotel();
    const up = (c: Client, bytes: Uint8Array<ArrayBuffer>, type: string) => c.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, bytes, type);
    expect((await up(h.clients.viewer, png(1), 'image/png')).status).toBe(403);
    expect((await up(h.clients.entry_staff, new TextEncoder().encode('<svg onload=alert(1)>'), 'image/png')).status).toBe(400);
    expect((await up(h.clients.entry_staff, png(2), 'image/png')).status).toBe(201);
    expect((await up(h.clients.entry_staff, png(2), 'image/png')).status).toBe(409);
    expect((await up(h.clients.entry_staff, png(3), 'text/plain')).status).toBe(415);
  });

  it('serves a photo only to the business, sandboxed and never cached', async () => {
    const h = await hotel();
    const id = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(4), 'image/png')).json.id;
    const ok = await h.clients.accountant.raw(`/businesses/${h.bid}/uploads/${id}/file`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/png');
    expect(ok.headers.get('Content-Security-Policy')).toMatch(/sandbox/);
    expect(ok.headers.get('Cache-Control')).toMatch(/no-store/);
    expect((await h.clients.viewer.raw(`/businesses/${h.bid}/uploads/${id}/file`)).status).toBe(403);
    const other = await hotel();
    expect((await other.clients.owner.raw(`/businesses/${other.bid}/uploads/${id}/file`)).status).toBe(404);
    expect((await new Client().raw(`/businesses/${h.bid}/uploads/${id}/file`)).status).toBe(401);
  });
});

describe('expense list and cash summary', () => {
  async function expensePage(h: Awaited<ReturnType<typeof hotel>>) {
    const id = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(7), 'image/png')).json.id;
    const heads = (await h.clients.owner.get(`/businesses/${h.bid}/heads`)).json.heads;
    const util = heads.find((x: any) => x.name === 'Utilities').id;
    const a = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${id}/expense-rows`, { narration: 'Gas cylinder', amount: '1100', headId: util });
    const b = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${id}/expense-rows`, { narration: 'Auto fare', amount: '150' });
    return { id, util, rowA: a.json.id, rowB: b.json.id };
  }

  it('expense rows are drafts from Cash until an Owner or Accountant approves rows with a head', async () => {
    const h = await hotel();
    const p = await expensePage(h);
    const [r] = await sql`SELECT t.type, t.status, t.source, a.kind FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ${p.rowA}`;
    expect(r).toEqual({ type: 'expense', status: 'draft', source: 'cash_photo', kind: 'cash' });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${p.id}/expense-rows/approve`)).status).toBe(403);
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/uploads/${p.id}/expense-rows/approve`);
    expect(res.json.approved).toBe(1); // the row without a head stays a draft
    expect((await h.clients.owner.put(`/businesses/${h.bid}/expense-rows/${p.rowA}`, { narration: 'x', amount: '1' })).status).toBe(404);
  });

  it('runs the four checks, waits on drafts and the shift, and needs a note to accept a mismatch', async () => {
    const h = await hotel();
    await fullShift(h);
    const p = await expensePage(h);
    const sumId = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=cash_summary&day=2026-10-31`, png(9), 'image/png')).json.id;
    let page = await h.clients.owner.get(`/businesses/${h.bid}/uploads/${sumId}`);
    const summaryId = page.json.summary.id;
    // opening 8,400 + received 4,303.50 = 12,703.50; − expenses 1,250 = 11,453.50
    await h.clients.entry_staff.put(`/businesses/${h.bid}/cash-summaries/${summaryId}`, { opening: '8400', received: '4303.50', balance: '12703.50', expenses: '1250', cashInHand: '11453.50' });
    page = await h.clients.owner.get(`/businesses/${h.bid}/uploads/${sumId}`);
    const state = (k: string) => page.json.checks.find((c: any) => c.key === k).state;
    expect(state('arithmetic')).toBe('pass');
    expect(state('opening')).toBe('unavailable');
    expect(state('received')).toBe('waiting');
    expect(state('expenses')).toBe('waiting');
    const list = await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads`);
    expect(list.json.notices[0].text).toBe('The cash summary for 2026-10-31 cannot be checked yet: 2 expense rows for that day are not approved.');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/cash-summaries/${summaryId}/approve`)).status).toBe(409);

    // Approve both expense rows and confirm the shift.
    const transport = (await h.clients.owner.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.name === 'Transport').id;
    await h.clients.owner.put(`/businesses/${h.bid}/expense-rows/${p.rowB}`, { narration: 'Auto fare', amount: '150', headId: transport });
    await h.clients.owner.post(`/businesses/${h.bid}/uploads/${p.id}/expense-rows/approve`);
    await decideAll(h);
    await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    page = await h.clients.owner.get(`/businesses/${h.bid}/uploads/${sumId}`);
    expect(state('received')).toBe('pass');   // 4,303.50 confirmed cash
    expect(state('expenses')).toBe('pass');   // 1,100 + 150
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads`)).json.notices).toEqual([]);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/cash-summaries/${summaryId}/approve`)).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/cash-summaries/${summaryId}/approve`)).json.acceptedMismatches).toBe(0);
  });

  it('a failed check can be accepted only with a note, which is logged', async () => {
    const h = await hotel();
    const sumId = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=cash_summary&day=2026-11-05`, png(11), 'image/png')).json.id;
    const summaryId = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${sumId}`)).json.summary.id;
    await h.clients.owner.put(`/businesses/${h.bid}/cash-summaries/${summaryId}`, { opening: '100', received: '0', balance: '100', expenses: '0', cashInHand: '90' });
    // No shift for 5 Nov exists, so the received check waits. Confirm an empty shift is not possible, so check only the arithmetic path:
    const page = await h.clients.owner.get(`/businesses/${h.bid}/uploads/${sumId}`);
    expect(page.json.checks.find((c: any) => c.key === 'arithmetic').state).toBe('fail');
    await sql`INSERT INTO shifts (id, business_id, shift_day, status, created_at) VALUES ('s5', ${h.bid}, '2026-11-05', 'confirmed', 0)`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/cash-summaries/${summaryId}/approve`)).status).toBe(409);
    const ok = await h.clients.owner.post(`/businesses/${h.bid}/cash-summaries/${summaryId}/approve`, { note: 'Rs 10 short, counted twice' });
    expect(ok.json.acceptedMismatches).toBe(1);
    const [s] = await sql`SELECT status, mismatch_note FROM cash_summaries WHERE id = ${summaryId}`;
    expect(s).toEqual({ status: 'approved', mismatch_note: 'Rs 10 short, counted twice' });
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'cash_summary.approve'`)[0].n).toBe(1);
  });
});

describe('register bill numbers against the software report', () => {
  it('flags a short or mistyped number and offers the right bill; picking it makes the bill match', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.map((r) => r.billNo === '2610312' ? { ...r, billNo: '0312' } : r.billNo === '2610314' ? { ...r, billNo: '2610341' } : r);
    const pageId = await fullShift(h, reg);
    const u = await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${pageId}`);
    const byNo = (n: string) => u.json.rows.find((r: any) => r.billNo === n);
    expect(byNo('2610311').billMatch).toEqual({ exact: true, options: [] });
    expect(byNo('0312').billMatch.options[0]).toMatchObject({ billNo: '2610312', amountMatches: true, why: 'short' });
    expect(byNo('2610341').billMatch.options[0]).toMatchObject({ billNo: '2610314', amountMatches: true, why: 'typo' });
    expect(byNo('26103125').billMatch.exact).toBe(false); // really missing from the software report
    const row = byNo('0312');
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${row.id}`, { billNo: '2610312', billType: 'fnb', amount: '380', status: 'checked', payments: [{ mode: 'cash', columnLabel: 'Cash', amount: '380' }] });
    const v = await view(h);
    expect(byBill(v, '2610312').difference).toBe('match');
  });
});

describe('register discounts', () => {
  it('a bill balances when payments equal amount less discount, and is compared to the software after discount', async () => {
    const h = await hotel();
    // Register says 4,500 with a 90 discount, paid 4,410 by UPI: the software report has 4,410.
    const reg = REGISTER_31_OCT.map((r) => (r.billNo === '2610317' ? { ...r, amount: '4500', discount: '90', payments: [{ mode: 'upi' as const, columnLabel: 'UPI XOXO', amount: '4410' }] } : r));
    const pageId = await fullShift(h, reg as never);
    const [row] = await sql`SELECT amount_paise, discount_paise FROM register_rows WHERE bill_no = '2610317'`;
    expect(row).toEqual({ amount_paise: 450000, discount_paise: 9000 });
    const v = await view(h);
    expect(byBill(v, '2610317').difference).toBe('match');
    expect(byBill(v, '2610317').register).toMatchObject({ amountPaise: 441000, discountPaise: 9000 });
    expect(v.json.blockers.join(' ')).not.toMatch(/do not add up/);
    const u = await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${pageId}`);
    expect(u.json.rows.find((r: any) => r.billNo === '2610317').discountPaise).toBe(9000);
  });

  it('Fill discounts sets amount - payments on rows with none yet: a discount, or a tip when paid more', async () => {
    const h = await hotel();
    const page = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(32), 'image/png')).json.id;
    const add = (billNo: string, amount: string, payments: unknown[], discount = '0') =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo, billType: 'fnb', amount, discount, payments, status: 'checked' });
    await add('1', '230', [{ mode: 'card', amount: '219' }]);          // fills 11
    await add('2', '10899', [{ mode: 'upi', amount: '10500' }]);       // fills 399
    await add('3', '179', [{ mode: 'upi', amount: '188' }]);           // paid more: a tip of 9
    await add('4', '100', []);                                          // nothing paid: left alone
    await add('5', '500', [{ mode: 'cash', amount: '450' }], '30');    // has a discount: left alone
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/fill-discounts`);
    expect(res.json.filled).toBe(3);
    const rows = await sql`SELECT bill_no, discount_paise, tip_paise, status FROM register_rows WHERE upload_id = ${page} ORDER BY bill_no`;
    expect(rows.map((r) => [r.bill_no, r.discount_paise, r.tip_paise])).toEqual([['1', 1100, 0], ['2', 39900, 0], ['3', 0, 900], ['4', 0, 0], ['5', 3000, 0]]);
    expect(rows.every((r) => r.status === 'checked')).toBe(true);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'register.fill_discounts'`)[0].n).toBe(1);
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/uploads/${page}/fill-discounts`)).status).toBe(403);
  });

  it('a negative discount is a tip: kept apart, and the bill balances with the extra paid', async () => {
    const h = await hotel();
    // Register 4,401 billed, 9 tip, 4,410 paid by UPI: the software report has 4,410.
    const reg = REGISTER_31_OCT.map((r) => (r.billNo === '2610317' ? { ...r, amount: '4401', discount: '-9', payments: [{ mode: 'upi' as const, columnLabel: 'UPI XOXO', amount: '4410' }] } : r));
    const pageId = await fullShift(h, reg as never);
    const [row] = await sql`SELECT amount_paise, discount_paise, tip_paise FROM register_rows WHERE bill_no = '2610317'`;
    expect(row).toEqual({ amount_paise: 440100, discount_paise: 0, tip_paise: 900 });
    const v = await view(h);
    expect(byBill(v, '2610317').difference).toBe('match');
    expect(byBill(v, '2610317').register).toMatchObject({ amountPaise: 441000, discountPaise: -900 });
    const u = await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${pageId}`);
    expect(u.json.rows.find((r: any) => r.billNo === '2610317').discountPaise).toBe(-900);
  });

  it('matched after a discount: no decision, the register amount is booked for bank matching, earlier decisions cleared', async () => {
    const h = await hotel();
    // Software 4,410; register bill 4,410 with a 30 discount, 4,380 received by UPI.
    const reg = REGISTER_31_OCT.map((r) => (r.billNo === '2610317' ? { ...r, amount: '4380', payments: [{ mode: 'upi' as const, columnLabel: 'UPI XOXO', amount: '4380' }] } : r));
    await fullShift(h, reg as never);
    let v = await view(h);
    expect(byBill(v, '2610317').difference).toBe('amount');
    await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610317').id}`, { decision: 'use_software' });
    const [row] = await sql`SELECT id FROM register_rows WHERE bill_no = '2610317'`;
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${row.id}`, {
      billNo: '2610317', billType: 'fnb', amount: '4410', discount: '30', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI XOXO', amount: '4380' }],
    });
    v = await view(h);
    expect(byBill(v, '2610317')).toMatchObject({ difference: 'match', decision: null });
    expect(v.json.matchedAfterAdjustment).toEqual([{ billNo: '2610317', softwarePaise: 441000, registerPaise: 438000 }]);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.decision_cleared'`)[0].n).toBe(1);
    await decideAll(h).catch(() => undefined);
    for (const [bill, d] of [['26103115', 'use_register'], ['2610318', 'use_register'], ['2610319', 'leave_out'], ['26103120', 'use_register'], ['26103125', 'use_register']]) {
      await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`, { decision: d, note: 'Cancelled in POS' });
    }
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const [t] = await sql`SELECT amount_paise, confirmed_source, match_status FROM transactions WHERE bill_no = '2610317'`;
    expect(t).toEqual({ amount_paise: 438000, confirmed_source: 'register', match_status: 'awaiting_bank_match' });
  });

  it('refuses a discount larger than the bill', async () => {
    const h = await hotel();
    const page = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(31), 'image/png')).json.id;
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo: '1', billType: 'fnb', amount: '100', discount: '150', payments: [] });
    expect(res.status).toBe(400);
  });
});

describe('deleting an upload', () => {
  it('deleting a CSV removes its bills and rebuilds the comparison, logged', async () => {
    const h = await hotel();
    await fullShift(h);
    const [u] = await sql`SELECT u.id FROM uploads u JOIN sales_reports r ON r.upload_id = u.id WHERE r.bill_count = 16`;
    const res = await h.clients.accountant.del(`/businesses/${h.bid}/uploads/${u.id}`);
    expect(res.status).toBe(200);
    expect(res.json.bills).toBe(16);
    expect((await sql`SELECT count(*) AS n FROM software_bills`)[0].n).toBe(3);
    const v = await view(h);
    expect(byBill(v, '2610311').difference).toBe('missing_in_software');
    expect(v.json.gaps.length).toBeGreaterThan(0);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'upload.delete'`)[0].n).toBe(1);
  });

  it('Entry staff can delete only their own uploads; Viewer none', async () => {
    const h = await hotel();
    const mine = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(21), 'image/png')).json.id;
    const owners = (await h.clients.owner.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(22), 'image/png')).json.id;
    expect((await h.clients.viewer.del(`/businesses/${h.bid}/uploads/${mine}`)).status).toBe(403);
    expect((await h.clients.entry_staff.del(`/businesses/${h.bid}/uploads/${owners}`)).status).toBe(403);
    expect((await h.clients.entry_staff.del(`/businesses/${h.bid}/uploads/${mine}`)).status).toBe(200);
    const [u] = await sql`SELECT storage_key FROM uploads WHERE id = ${owners}`;
    expect(u).toBeTruthy();
    expect(await uploads.get(`${h.bid}/${mine}`)).toBeNull();
  });

  it('refused for a confirmed shift and for approved expense lines', async () => {
    const h = await hotel();
    const page = await fullShift(h);
    await decideAll(h);
    await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/uploads/${page}`)).status).toBe(409);
    const [csv] = await sql`SELECT u.id FROM uploads u JOIN sales_reports r ON r.upload_id = u.id WHERE r.bill_count = 3`;
    expect((await h.clients.owner.del(`/businesses/${h.bid}/uploads/${csv.id}`)).status).toBe(409);

    const exp = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(23), 'image/png')).json.id;
    const util = (await h.clients.owner.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.name === 'Utilities').id;
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${exp}/expense-rows`, { narration: 'Gas', amount: '100', headId: util });
    await h.clients.owner.post(`/businesses/${h.bid}/uploads/${exp}/expense-rows/approve`);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/uploads/${exp}`)).status).toBe(409);
  });
});

describe('bills paid together', () => {
  // Three register bills settled by one UPI payment written on the first of them.
  const setup = async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122'].includes(r.billNo));
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    const head = (await add('2610311', '420', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '2370' }])).json.id;   // 420 + 1180 + 780 = 2,380
    const b2 = (await add('2610314', '1180', [], { paidWithRowId: head })).json.id;
    const b3 = (await add('26103122', '780', [], { paidWithRowId: head })).json.id;
    return { h, pageId, head, b2, b3 };
  };

  it('each bill matches its own software bill through the group payment mode; the group must balance', async () => {
    const { h, pageId } = await setup();
    let v = await view(h);
    for (const b of ['2610311', '2610314', '26103122']) expect(byBill(v, b).difference).toBe('match');
    expect(v.json.blockers.join(' ')).toMatch(/paid together: the payment does not equal/);
    // 2,370 paid for 2,380 of bills: Fill shares the 10 discount over the three bills by amount, in rupees.
    const fill = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`);
    expect(fill.json.filled).toBe(3);
    const disc = await sql`SELECT bill_no, discount_paise FROM register_rows WHERE bill_no IN ('2610311', '2610314', '26103122')`;
    expect(disc.reduce((t, x) => t + x.discount_paise, 0)).toBe(1000);
    expect(disc.every((x) => x.discount_paise > 0 && x.discount_paise % 100 === 0)).toBe(true);
    // Filling again changes nothing; a group whose discount a person typed is left alone.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBe(0);
    v = await view(h);
    expect(v.json.blockers.join(' ')).not.toMatch(/paid together/);
    // Each bill received less than the software after its share of the discount: matched after a discount, no decision.
    for (const b of ['2610311', '2610314', '26103122']) expect(byBill(v, b).difference).toBe('match');
    expect(v.json.matchedAfterAdjustment.map((x: any) => x.billNo).sort()).toEqual(['2610311', '2610314', '26103122'].sort());
  });

  it('confirming books one income row per bill, in the group mode', async () => {
    const { h } = await setup();
    await sql`UPDATE register_payments SET amount_paise = 238000 WHERE register_row_id = (SELECT id FROM register_rows WHERE bill_no = '2610311')`;
    await decideAll(h);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const rows = await sql`SELECT bill_no, amount_paise, payment_mode, match_status FROM transactions WHERE bill_no IN ('2610311', '2610314', '26103122') ORDER BY bill_no`;
    expect(rows).toEqual([
      { bill_no: '2610311', amount_paise: 42000, payment_mode: 'upi', match_status: 'awaiting_bank_match' },
      { bill_no: '26103122', amount_paise: 78000, payment_mode: 'upi', match_status: 'awaiting_bank_match' },
      { bill_no: '2610314', amount_paise: 118000, payment_mode: 'upi', match_status: 'awaiting_bank_match' },
    ]);
  });

  it('refuses chains, itself, another shift, and a payment on a bill paid with another', async () => {
    const { h, pageId, head, b2 } = await setup();
    const put = (id: string, extra: Record<string, unknown>) =>
      h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${id}`, { billNo: 'x', billType: 'fnb', amount: '1', payments: [], ...extra });
    expect((await put(b2, { paidWithRowId: b2 })).status).toBe(400);
    const other = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: '9', billType: 'fnb', amount: '1', payments: [] })).json.id;
    expect((await put(other, { paidWithRowId: b2 })).json.error).toMatch(/itself paid with another row/);
    expect((await put(head, { paidWithRowId: other })).json.error).toMatch(/must keep the payment/);
    expect((await put(other, { paidWithRowId: head, payments: [{ mode: 'cash', amount: '1' }] })).status).toBe(400);
    const nextDay = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-11-01`, png(41), 'image/png')).json.id;
    const far = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${nextDay}/register-rows`, { billNo: '8', billType: 'fnb', amount: '1', payments: [] })).json.id;
    expect((await put(far, { paidWithRowId: head })).json.error).toMatch(/same shift/);
  });

  it('a group paid more than one way cannot be confirmed', async () => {
    const { h, head } = await setup();
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, {
      billNo: '2610311', billType: 'fnb', amount: '420', status: 'checked',
      payments: [{ mode: 'upi', amount: '2000' }, { mode: 'cash', amount: '380' }],
    });
    expect((await view(h)).json.blockers.join(' ')).toMatch(/single mode/);
  });
});

describe('finding a bill on register pages', () => {
  it('finds rows by any part of the bill number across pages, only in this business', async () => {
    const h = await hotel();
    await fullShift(h);
    const page2 = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-11-01`, png(51), 'image/png')).json.id;
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page2}/register-rows`, { billNo: '26110120', billType: 'fnb', amount: '50', payments: [] });
    const res = await h.clients.entry_staff.get(`/businesses/${h.bid}/register-rows?bill=3120`);
    expect(res.json.rows.map((r: any) => r.billNo)).toEqual(['26103120']);
    const both = await h.clients.entry_staff.get(`/businesses/${h.bid}/register-rows?bill=120`);
    expect(both.json.rows.map((r: any) => r.billNo).sort()).toEqual(['26103120', '26110120']);
    expect(both.json.rows[0]).toMatchObject({ day: '2026-11-01', uploadId: page2, lineNo: 1 });
    expect((await h.clients.viewer.get(`/businesses/${h.bid}/register-rows?bill=3120`)).status).toBe(403);
    const other = await hotel();
    expect((await other.clients.owner.get(`/businesses/${other.bid}/register-rows?bill=3120`)).json.rows).toEqual([]);
  });
});

describe('use software for a bill missing in the register', () => {
  it('takes a type with the decision and books the sale under that type\'s head', async () => {
    const h = await hotel();
    await fullShift(h);
    let v = await view(h);
    const id = byBill(v, '2610319').id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'use_software', billType: 'bar' })).status).toBe(400);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'use_software', billType: 'room' })).status).toBe(200);
    v = await view(h);
    expect(byBill(v, '2610319')).toMatchObject({ decision: 'use_software', billType: 'room' });
    for (const [bill, d] of [['26103115', 'use_register'], ['2610317', 'use_software'], ['2610318', 'use_register'], ['26103120', 'use_register'], ['26103125', 'use_register']]) {
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`, { decision: d });
    }
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const [t] = await sql`SELECT t.amount_paise, t.payment_mode, t.confirmed_source, hd.name AS head FROM transactions t JOIN heads hd ON hd.id = t.head_id WHERE t.bill_no = '2610319'`;
    expect(t).toEqual({ amount_paise: 35300, payment_mode: 'cash', confirmed_source: 'software', head: 'Room' });
    const [a] = await sql`SELECT after FROM audit_log WHERE action = 'comparison.decide' AND row_id = ${id} ORDER BY id DESC LIMIT 1`;
    expect(JSON.parse(a.after)).toMatchObject({ decision: 'use_software', billType: 'room' });
  });

  it('the type is cleared with the decision when the bill turns up in the register', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    let v = await view(h);
    await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610319').id}`, { decision: 'use_software', billType: 'fnb' });
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: '2610319', billType: 'fnb', amount: '353', status: 'checked', payments: [{ mode: 'cash', amount: '353' }] });
    v = await view(h);
    expect(byBill(v, '2610319')).toMatchObject({ difference: 'match', decision: null, billType: null });
  });
});

describe('use register for a bill paid together', () => {
  it('a bill with no payment of its own counts as paid through its group', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    const [head] = await sql`SELECT id FROM register_rows WHERE bill_no = '26103125'`; // cash 500, missing in the software
    const extra = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, {
      billNo: '193', billType: 'fnb', amount: '676', payments: [], paidWithRowId: head.id, status: 'checked',
    })).json.id;
    const lone = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, {
      billNo: '194', billType: 'fnb', amount: '50', payments: [], status: 'checked',
    })).json.id;
    const v = await view(h);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '193').id}`, { decision: 'use_register' })).status).toBe(200);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '194').id}`, { decision: 'use_register' })).json.error).toMatch(/not paid together/);
    expect(extra && lone).toBeTruthy();
  });
});

describe('cash for a shift', () => {
  async function confirmedWithSummary(cashInHand: string) {
    const h = await hotel();
    await fullShift(h);
    const v = await view(h);
    // 2610319 is cash 353 in the software and missing in the register: booked with Use software.
    for (const [bill, d] of [['26103115', 'use_register'], ['2610317', 'use_software'], ['2610318', 'use_register'], ['26103120', 'use_register'], ['26103125', 'use_register']]) {
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`, { decision: d });
    }
    await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610319').id}`, { decision: 'use_software', billType: 'fnb' });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const sumUpload = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=cash_summary&day=2026-10-31`, png(61), 'image/png')).json.id;
    const sid = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${sumUpload}`)).json.summary.id;
    await h.clients.entry_staff.put(`/businesses/${h.bid}/cash-summaries/${sid}`, { opening: '8400', received: '4303.50', balance: '12703.50', expenses: '0', cashInHand });
    return h;
  }
  const cash = (h: any) => h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`);

  it('should be in hand = opening + confirmed cash sales - approved expenses, against the counted cash', async () => {
    const h = await confirmedWithSummary('12703.50');
    const k = (await cash(h)).json;
    // 4,303.50 register cash + 353 cash bill not in the register = 4,656.50
    expect(k).toMatchObject({ confirmed: true, openingPaise: 840000, openingFrom: 'page', cashSalesPaise: 465650, expensesPaise: 0,
      shouldBePaise: 1305650, countedPaise: 1270350, differencePaise: -35300, settled: false, notInRegisterBookedPaise: 35300 });
    expect(k.notInRegister).toEqual([{ id: expect.any(String), billNo: '2610319', amountPaise: 35300, decision: 'use_software', billType: 'fnb', note: null }]);
  });

  it('a difference is accepted with a note, and only that exact difference', async () => {
    const h = await confirmedWithSummary('12703.50');
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/accept`, { note: 'x' })).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/accept`, {})).status).toBe(400);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/accept`, { note: 'Counted again: 353 in the drawer, not written' })).status).toBe(200);
    expect((await cash(h)).json).toMatchObject({ settled: true, accepted: 'Counted again: 353 in the drawer, not written' });
  });

  it('an Owner books a shortage: an approved Cash expense under Cash shortage, and the cash then agrees', async () => {
    const h = await confirmedWithSummary('12703.50');
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/shortage`, { note: 'x' })).status).toBe(403);
    const res = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/shortage`, { note: 'Cashier to repay' });
    expect(res.json).toEqual({ ok: true, amountPaise: 35300 });
    const [t] = await sql`SELECT t.amount_paise, t.type, t.status, t.source, hd.name AS head, a.kind FROM transactions t
      JOIN heads hd ON hd.id = t.head_id JOIN accounts a ON a.id = t.account_id WHERE t.source = 'cash_shortage'`;
    expect(t).toEqual({ amount_paise: 35300, type: 'expense', status: 'approved', source: 'cash_shortage', head: 'Cash shortage', kind: 'cash' });
    expect((await cash(h)).json).toMatchObject({ differencePaise: 0, settled: true, shortagePaise: 35300 });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/shortage`, { note: 'again' })).status).toBe(409);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'cash.shortage_booked'`)[0].n).toBe(1);
  });

  it('a cash bill missing in the register is only left out with a reason', async () => {
    const h = await hotel();
    await fullShift(h);
    const v = await view(h);
    const id = byBill(v, '2610319').id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'leave_out' })).json.error).toMatch(/Say why/);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'leave_out', note: 'Cancelled in POS' })).status).toBe(200);
  });

  it('before the shift is confirmed there is no difference to settle', async () => {
    const h = await hotel();
    await fullShift(h);
    const k = (await cash(h)).json;
    expect(k).toMatchObject({ confirmed: false, cashSalesPaise: null, shouldBePaise: null, differencePaise: null });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/cash/accept`, { note: 'x' })).status).toBe(409);
  });
});

describe('vendors remembered under a head', () => {
  async function page(h: Awaited<ReturnType<typeof hotel>>) {
    return (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(71 + Math.floor(Math.random() * 100)), 'image/png')).json.id as string;
  }
  it('the first line names the vendor and head; later lines from that vendor get the head by themselves', async () => {
    const h = await hotel();
    const kitchen = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Kitchen purchases', type: 'expense' })).json.id;
    const pg = await page(h);
    const add = (body: Record<string, unknown>) => h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, body);
    expect((await add({ narration: 'Vegetables', vendor: 'Blinkit', amount: '420', headId: kitchen })).status).toBe(201);
    const [p] = await sql`SELECT name, default_head_id FROM parties`;
    expect(p).toEqual({ name: 'Blinkit', default_head_id: kitchen });
    await add({ narration: 'Milk', vendor: 'blinkit', amount: '60' });          // same vendor, any case
    await add({ narration: 'Blinkit eggs', amount: '90' });                     // vendor named in the item
    await add({ narration: 'Auto fare', amount: '50' });                        // no vendor: no head
    const rows = await sql`SELECT t.narration, t.head_id, p.name AS vendor, t.ocr_original FROM transactions t LEFT JOIN parties p ON p.id = t.party_id WHERE t.upload_id = ${pg} ORDER BY t.line_no`;
    expect(rows.map((r) => [r.narration, r.vendor, r.head_id === kitchen])).toEqual([
      ['Vegetables', 'Blinkit', true], ['Milk', 'Blinkit', true], ['Blinkit eggs', 'Blinkit', true], ['Auto fare', null, false],
    ]);
    expect(JSON.parse(rows[1].ocr_original).inferred).toEqual(['head']); // shown as Learned
    expect(rows[0].ocr_original).toBeNull();                             // chosen by the person
    expect((await sql`SELECT count(*) AS n FROM parties`)[0].n).toBe(1);
  });

  it('a vendor first seen without a head learns the first head chosen; moving it later is Owner or Accountant work', async () => {
    const h = await hotel();
    const kitchen = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Kitchen purchases', type: 'expense' })).json.id;
    const util = (await h.clients.owner.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.name === 'Utilities').id;
    const pg = await page(h);
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Groceries', vendor: 'Zepto', amount: '300' });
    expect((await sql`SELECT default_head_id FROM parties`)[0].default_head_id).toBeNull();
    const [row] = await sql`SELECT id FROM transactions WHERE upload_id = ${pg}`;
    await h.clients.entry_staff.put(`/businesses/${h.bid}/expense-rows/${row.id}`, { narration: 'Groceries', vendor: 'Zepto', amount: '300', headId: kitchen });
    const [p] = await sql`SELECT id, default_head_id FROM parties`;
    expect(p.default_head_id).toBe(kitchen);
    // A later different head on one line does not move the vendor.
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Gas', vendor: 'Zepto', amount: '50', headId: util });
    expect((await sql`SELECT default_head_id FROM parties`)[0].default_head_id).toBe(kitchen);
    expect((await h.clients.entry_staff.patch(`/businesses/${h.bid}/parties/${p.id}`, { name: 'Zepto', defaultHeadId: util })).status).toBe(403);
    expect((await h.clients.accountant.patch(`/businesses/${h.bid}/parties/${p.id}`, { name: 'Zepto', defaultHeadId: util })).status).toBe(200);
    const list = (await h.clients.viewer.get(`/businesses/${h.bid}/parties`)).json.parties;
    expect(list).toEqual([expect.objectContaining({ name: 'Zepto', defaultHeadId: util, lines: 2 })]);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'party.update'`)[0].n).toBe(1);
  });
});

describe('a vendor under several heads', () => {
  it('picks the head from a matching earlier item, else offers the vendor\'s heads as choices', async () => {
    const h = await hotel();
    const kitchen = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Kitchen purchases', type: 'expense' })).json.id;
    const house = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Housekeeping', type: 'expense' })).json.id;
    const pg = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(91), 'image/png')).json.id;
    const add = async (narration: string, headId?: string) => (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`,
      { narration, vendor: 'Blinkit', amount: '100', headId: headId ?? null })).json.id;
    await add('Vegetables', kitchen);
    await add('Detergent', house);
    const veg = await add('vegetables');            // same item: Kitchen purchases
    const det = await add('Detergent powder');      // same first word: Housekeeping
    const bread = await add('Bread');               // new item, two heads: no head, choices offered
    const head = async (id: string) => (await sql`SELECT head_id, ocr_original FROM transactions WHERE id = ${id}`)[0];
    expect((await head(veg)).head_id).toBe(kitchen);
    expect(JSON.parse((await head(veg)).ocr_original).inferred).toEqual(['head']);
    expect((await head(det)).head_id).toBe(house);
    expect((await head(bread)).head_id).toBeNull();
    const pageRows = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${pg}`)).json.rows;
    expect(JSON.parse(pageRows.find((r: any) => r.id === bread).vendorHeads).sort()).toEqual([kitchen, house].sort());
    // The main head stays the first one; the vendor is listed under both.
    const [p] = (await h.clients.owner.get(`/businesses/${h.bid}/parties`)).json.parties;
    expect(p.defaultHeadId).toBe(kitchen);
    expect(p.heads.map((x: any) => x.headId).sort()).toEqual([kitchen, house].sort());
  });

  it('a vendor with one head still fills it in for any item', async () => {
    const h = await hotel();
    const kitchen = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Kitchen purchases', type: 'expense' })).json.id;
    const pg = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(92), 'image/png')).json.id;
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Vegetables', vendor: 'Zepto', amount: '10', headId: kitchen });
    const id = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Anything new', vendor: 'Zepto', amount: '10' })).json.id;
    expect((await sql`SELECT head_id FROM transactions WHERE id = ${id}`)[0].head_id).toBe(kitchen);
  });
});

describe('moving a page to another day', () => {
  it('an expense page moves with its lines; once approved only Owner or Accountant can move it', async () => {
    const h = await hotel();
    const head = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Kitchen purchases', type: 'expense' })).json.id;
    const pg = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, png(93), 'image/png')).json.id;
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows`, { narration: 'Milk', amount: '50', headId: head });
    expect((await h.clients.entry_staff.patch(`/businesses/${h.bid}/uploads/${pg}`, { day: '2026-10-30' })).status).toBe(200);
    expect((await sql`SELECT day FROM transactions WHERE upload_id = ${pg}`)[0].day).toBe('2026-10-30');
    expect((await h.clients.entry_staff.patch(`/businesses/${h.bid}/uploads/${pg}`, { day: '2999-01-01' })).status).toBe(400);
    await h.clients.owner.post(`/businesses/${h.bid}/uploads/${pg}/expense-rows/approve`, {});
    expect((await h.clients.entry_staff.patch(`/businesses/${h.bid}/uploads/${pg}`, { day: '2026-10-31' })).status).toBe(403);
    expect((await h.clients.accountant.patch(`/businesses/${h.bid}/uploads/${pg}`, { day: '2026-10-31' })).status).toBe(200);
    expect((await sql`SELECT day FROM transactions WHERE upload_id = ${pg}`)[0].day).toBe('2026-10-31');
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'upload.day_changed' AND row_id = ${pg}`)[0].n).toBe(2);
  });
});

describe('discount for bills paid together, worked out again', () => {
  it('an earlier fill that did not add up is spread again over the group; typed discounts are kept', async () => {
    const h = await hotel();
    const pageId = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(94), 'image/png')).json.id;
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, ...extra });
    const head = (await add('144743', '3481', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '8600' }])).json.id;
    for (const [b, a] of [['144898', '385'], ['144899', '1626'], ['144986', '13820'], ['145003', '795']]) await add(b, a, [], { paidWithRowId: head });
    // The old fill: the whole discount on the paying row, cut to its own amount, marked as worked out.
    await sql`UPDATE register_rows SET discount_paise = 348100, ocr_original = '{"inferred":["discount"]}' WHERE id = ${head}`;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBeGreaterThan(1);
    const rows = await sql`SELECT amount_paise, discount_paise FROM register_rows WHERE upload_id = ${pageId}`;
    expect(rows.reduce((t, r) => t + r.amount_paise - r.discount_paise, 0)).toBe(860000);
    expect(rows.every((r) => r.discount_paise <= r.amount_paise)).toBe(true);
    // A person types a discount on one bill of the group: Fill leaves the group alone.
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, { billNo: '144743', billType: 'fnb', amount: '3481', discount: '100', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '8600' }] });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBe(0);
  });
});

describe('large discounts', () => {
  it('a discount over 20% is not matched by itself; accepting it needs a reason; paid-together bills are judged as a group', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122'].includes(r.billNo));
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    // 420 + 1180 + 780 = 2,380 of bills, 1,500 paid: 880 discount (37%) over the group.
    const head = (await add('2610311', '420', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '1500' }])).json.id;
    await add('2610314', '1180', [], { paidWithRowId: head });
    await add('26103122', '780', [], { paidWithRowId: head });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBe(3);
    let v = await view(h);
    for (const b of ['2610311', '2610314', '26103122']) {
      const c = byBill(v, b);
      expect(c.difference).toBe('amount');
      expect(c.largeDiscount).toMatchObject({ pct: 37, discountPaise: 88000, grossPaise: 238000, large: true });
    }
    const id = byBill(v, '2610314').id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'use_register' })).status).toBe(400);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'use_register', note: 'Group rate' })).status).toBe(200);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610311').id}`, { decision: 'use_software' })).status).toBe(200);
    // A small discount still matches by itself.
    await sql`UPDATE register_payments SET amount_paise = 230000 WHERE register_row_id = ${head}`;
    await sql`UPDATE register_rows SET discount_paise = 0, tip_paise = 0 WHERE upload_id = ${pageId}`;
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`);
    v = await view(h);
    expect(byBill(v, '2610314').difference).toBe('match');
    expect(byBill(v, '2610314').largeDiscount).toBeNull();
  });
});
