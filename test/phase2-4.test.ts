// Phase 2 through the API, part 4 of 5 (helpers in phase2-shared.ts). Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, Client, sql, resetDb, uploads } from './helpers';
import { buildSalesCsv, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';
import { byBill, DAY_END, DAY_START, decideAll, fullShift, hotel, png, PNG, todayIst, view } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
// A full shift is ~20 API calls with many queries each; the local D1 proxy is slow per query.
vi.setConfig({ testTimeout: 180_000 });

describe('confirming a shift', () => {
  it('lists what blocks confirmation', async () => {
    const h = await hotel();
    await fullShift(h);
    const res = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(res.status).toBe(409);
    expect(res.json.problems.join(' ')).toMatch(/4 differences are not decided/); // bills on one side only, and a U/N bill the register has at the same amount, are decided by Bookr, except 26103125: past its date's last running number
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

describe('discount for bills paid together, on the row with the payment (approved 7 Nov 2026)', () => {
  const start = async () => {
    const h = await hotel();
    const pageId = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(94), 'image/png')).json.id;
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, ...extra });
    return { h, pageId, add };
  };
  it('Fill puts a discount larger than the paying row on that row; a typed discount is kept', async () => {
    const { h, pageId, add } = await start();
    const head = (await add('144743', '3481', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '8600' }])).json.id;
    for (const [b, a] of [['144898', '385'], ['144899', '1626'], ['144986', '13820'], ['145003', '795']]) await add(b, a, [], { paidWithRowId: head });
    // An older fill, shared over the bills and marked as worked out, is written again on the paying row.
    await sql`UPDATE register_rows SET discount_paise = 100, ocr_original = '{"inferred":["discount"]}' WHERE paid_with_row_id = ${head}`;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBeGreaterThan(1);
    const rows = await sql`SELECT id, amount_paise, discount_paise FROM register_rows WHERE upload_id = ${pageId}`;
    expect(rows.reduce((t, r) => t + r.amount_paise - r.discount_paise, 0)).toBe(860000);
    expect(rows.find((r) => r.id === head).discount_paise).toBe(2010700 - 860000);
    expect(rows.filter((r) => r.id !== head).every((r) => r.discount_paise === 0)).toBe(true);
    // A person types a discount on one bill of the group: Fill leaves the group alone.
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, { billNo: '144743', billType: 'fnb', amount: '3481', discount: '100', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '8600' }] });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBe(0);
  });
  it('a typed discount may pass its row up to the group, and no further; a bill leaving cannot strand it', async () => {
    const { h, add } = await start();
    const pay = [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '700' }];
    const head = (await add('2610317', '100', pay)).json.id;
    const b = (await add('2610318', '900', [], { paidWithRowId: head })).json.id;
    const put = (discount: string) => h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, { billNo: '2610317', billType: 'fnb', amount: '100', discount, payments: pay });
    expect((await put('1001')).status).toBe(400);
    expect((await put('300')).status).toBe(200);
    expect((await sql`SELECT discount_paise FROM register_rows WHERE id = ${head}`)[0].discount_paise).toBe(30000);
    // A row of its own still cannot have more discount than its amount.
    expect((await add('2610319', '100', [], { discount: '101' })).status).toBe(400);
    // The other bill cannot leave, or shrink below what the discount needs, or go.
    const member = (extra: Record<string, unknown>) => h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${b}`, { billNo: '2610318', billType: 'fnb', amount: '900', paidWithRowId: head, payments: [], ...extra });
    expect((await member({ amount: '100' })).status).toBe(400);
    expect((await member({ paidWithRowId: null })).status).toBe(400);
    expect((await h.clients.entry_staff.del(`/businesses/${h.bid}/register-rows/${b}`, { reason: 'other' })).status).toBe(400);
    expect((await member({ amount: '200' })).status).toBe(200);
  });
  it('each bill stays right when the discount passes the paying row: no negative sale, and the group adds up to the payment', async () => {
    const h = await hotel();
    // 2610317 is ₹4,410 in the software and 2610318 ₹650. Make the paying row the small one.
    const page = await fullShift(h, REGISTER_31_OCT.filter((r) => !['2610317', '2610318'].includes(r.billNo)));
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    // ₹650 + ₹4,410 of bills, ₹860 discount written on the ₹650 row, ₹4,200 paid.
    const head = await add('2610318', '650', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '4200' }], { discount: '860' });
    expect(head.status).toBe(400); // the group does not exist yet
    const made = await add('2610318', '650', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '4200' }]);
    await add('2610317', '4410', [], { paidWithRowId: made.json.id });
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${made.json.id}`, { billNo: '2610318', billType: 'fnb', amount: '650', discount: '860', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '4200' }] })).status).toBe(200);
    const v = await view(h);
    expect(byBill(v, '2610318').register.amountPaise).toBe(0);
    expect(byBill(v, '2610317').register.amountPaise).toBe(420000);
    expect(v.json.blockers.join(' ')).not.toMatch(/paid together/);
    for (const c of v.json.comparisons) {
      if (c.decision || c.difference === 'match' || c.difference === 'complimentary') continue;
      const decision = c.register ? 'use_register' : 'use_software';
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${c.id}`, { decision, note: 'Test' });
    }
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const sales = await sql`SELECT bill_no, amount_paise FROM transactions WHERE bill_no IN ('2610317', '2610318') AND type = 'income'`;
    expect(sales).toEqual([expect.objectContaining({ bill_no: '2610317', amount_paise: 420000 })]);
  });
});

describe('bills paid together match on their total (approved 7 Nov 2026)', () => {
  const setup = async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122'].includes(r.billNo));
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    const head = (await add('2610311', '420', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '2180' }])).json.id;
    await add('2610314', '1180', [], { paidWithRowId: head, billType: 'room' });
    await add('26103122', '780', [], { paidWithRowId: head });
    // 2,380 of bills, 2,180 paid.
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`);
    return { h, pageId, add, head };
  };
  const refresh = (h: Awaited<ReturnType<typeof hotel>>, id: string) =>
    h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${id}`, { billNo: '2610311', billType: 'fnb', amount: '420', discount: '200', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '2180' }] });

  it('software total after the discount: matches, and each bill is booked at the software figure, so Room and F&B split as billed', async () => {
    const { h, head } = await setup();
    await sql`UPDATE software_bills SET amount_paise = 30000 WHERE bill_no = '2610311'`; // 300 + 1,100 + 780 = 2,180 in the software
    await sql`UPDATE software_bills SET amount_paise = 110000 WHERE bill_no = '2610314'`;
    await refresh(h, head);
    const v = await view(h);
    for (const b of ['2610311', '2610314', '26103122']) expect(byBill(v, b).difference).toBe('match');
    expect(v.json.paidGroups[0]).toMatchObject({ softwarePaise: 218000, paidPaise: 218000, matched: true });
    await decideAll(h);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const sales = await sql`SELECT bill_no, amount_paise FROM transactions WHERE bill_no IN ('2610311', '2610314', '26103122') AND type = 'income' ORDER BY bill_no`;
    expect(sales).toEqual([{ bill_no: '2610311', amount_paise: 30000 }, { bill_no: '26103122', amount_paise: 78000 }, { bill_no: '2610314', amount_paise: 110000 }]);
  });

  it('a total that is neither figure waits for a person, and says why', async () => {
    const { h, head } = await setup();
    await sql`UPDATE software_bills SET amount_paise = 100000 WHERE bill_no = '2610314'`; // 2,200: neither 2,380 nor 2,180
    await refresh(h, head);
    const v = await view(h);
    expect(byBill(v, '2610314').difference).toBe('amount');
    expect(v.json.paidGroups[0]).toMatchObject({ matched: false, why: `Software ₹ ${(2200).toLocaleString('en-IN')}, paid ₹ ${(2180).toLocaleString('en-IN')}` });
  });

  it('another mode in the software waits for a person, even when the total agrees', async () => {
    const { h, head } = await setup();
    await sql`UPDATE software_bills SET mode = 'cash' WHERE bill_no = '26103122'`;
    await refresh(h, head);
    const v = await view(h);
    expect(byBill(v, '26103122').difference).toBe('mode');
    expect(v.json.paidGroups[0]).toMatchObject({ matched: false, why: 'Mode differs: bill 26103122' });
  });

  it('a bill not in the software waits for a person, even when the total agrees', async () => {
    const { h, add, head } = await setup();
    // 88888888 is written with them but is not in the software. With ₹ 300 off, the ₹ 2,180 paid still balances.
    await add('88888888', '100', [], { paidWithRowId: head });
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, { billNo: '2610311', billType: 'fnb', amount: '420', discount: '300', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '2180' }] });
    const v = await view(h);
    expect(byBill(v, '88888888').difference).toBe('missing_in_software');
    expect(v.json.paidGroups[0]).toMatchObject({ matched: false, why: 'Not in the software: bill 88888888' });
  });
});

describe('the explainer (what is left after matching, explained)', () => {
  it('finds a number typo, a payment written wrong and a bill paid in two goes; each card fixes in one click', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    const add = (body: Record<string, unknown>) => h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billType: 'fnb', status: 'checked', ...body });
    // Typo: register X2610319 ₹300 (software 2610319 ₹353); payment written wrong: bill 907 written as 920; two goes: 492 written 218 + 210.
    await add({ billNo: 'X2610319', amount: '300', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '300' }] });
    await add({ billNo: 'T907', amount: '907', discount: '-13', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '920' }] });
    await add({ billNo: 'S492', amount: '492', discount: '64', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '218' }, { mode: 'upi', columnLabel: 'UPI Bank 2', amount: '210' }] });
    let v = await view(h);
    for (const [bill, d] of [['26103115', 'use_register'], ['2610317', 'use_software'], ['2610318', 'use_register'], ['26103120', 'use_register'], ['26103125', 'use_register'],
      ['X2610319', 'use_register'], ['T907', 'use_register'], ['S492', 'use_register']]) {
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`, { decision: d });
    }
    await sql`UPDATE bill_comparisons SET decision = 'use_software', bill_type = 'fnb' WHERE bill_no = '2610319'`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' });
    const T = (c: (string | number)[]) => c.join('\t');
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
      T([1, 'S80000001', '31/10/2026', '31/10/2026 5:40:00 PM', '-', 'UPI/1/UPI/xxa@okaxis/B/x', 'CR', 300, 1]),
      T([2, 'S80000002', '31/10/2026', '31/10/2026 6:00:00 PM', '-', 'UPI/2/UPI/xxb@okaxis/B/x', 'CR', 907, 1]),
      T([3, 'S80000003', '31/10/2026', '31/10/2026 10:47:00 PM', '-', 'UPI/3/UPI/xxan02@okhdfcb/B/x', 'CR', 210, 1]),
      T([4, 'S80000004', '31/10/2026', '31/10/2026 10:54:00 PM', '-', 'UPI/4/UPI/xxan02@okhdfcb/B/x', 'CR', 282, 1]),
      T([5, 'S80000005', '01/11/2026', '01/11/2026 7:59:00 AM', '-', 'UPI/5/UPI/xxz@okaxis/B/x', 'CR', 1, 1])].join('\n') });

    const ex = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/explain`)).json;
    expect(ex.coverage.covered).toBe(true);
    const kinds = ex.cards.map((c: any) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['number_typo', 'payment_written_wrong', 'paid_in_parts']));
    const typo = ex.cards.find((c: any) => c.kind === 'number_typo');
    expect(typo.title).toMatch(/X2610319 is probably 2610319/);
    // Apply every card's first action, as the screen does.
    for (const k of ['number_typo', 'payment_written_wrong', 'paid_in_parts']) {
      const c = ex.cards.find((x: any) => x.kind === k);
      const a = c.actions[0];
      const res = await h.clients.owner.post(a.path, a.body);
      expect([k, res.status]).toEqual([k, 200]);
    }
    expect((await sql`SELECT bill_no, amount_paise, discount_paise FROM register_rows WHERE bill_no IN ('2610319', 'T907', 'S492') ORDER BY bill_no`).map((r) => [r.bill_no, r.amount_paise, r.discount_paise]))
      .toEqual([['2610319', 35300, 5300], ['S492', 49200, 0], ['T907', 90700, 0]]);
    expect((await sql`SELECT count(*) AS n FROM bank_rows WHERE status = 'matched'`)[0].n).toBe(4);
    // Nothing left to explain for these.
    const after = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/explain`)).json;
    expect(after.cards.filter((c: any) => ['number_typo', 'payment_written_wrong', 'paid_in_parts'].includes(c.kind))).toEqual([]);
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

describe('use software for a bill missing in the register', () => {
  it('takes a type with the decision and books the sale under that type\'s head', async () => {
    const h = await hotel();
    await fullShift(h);
    let v = await view(h);
    const id = byBill(v, '2610319').id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'use_software', billType: 'bar' })).status).toBe(400);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${id}`, { decision: 'use_software', billType: 'room' })).status).toBe(200);
    v = await view(h);
    // Written into the register on the shift's "Added from software report" page: now an ordinary match.
    expect(byBill(v, '2610319')).toMatchObject({ difference: 'match', decision: null });
    expect(byBill(v, '2610319').register).toMatchObject({ billType: 'room', amountPaise: 35300, mode: 'cash' });
    const [added] = await sql`SELECT r.remarks, r.status, u.storage_key FROM register_rows r JOIN uploads u ON u.id = r.upload_id WHERE r.bill_no = '2610319'`;
    expect(added).toMatchObject({ remarks: 'Added from software report', status: 'checked', storage_key: 'software-added/2026-10-31' });
    for (const [bill, d] of [['26103115', 'use_register'], ['2610317', 'use_software'], ['2610318', 'use_register'], ['26103120', 'use_register'], ['26103125', 'use_register']]) {
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`, { decision: d });
    }
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const [t] = await sql`SELECT t.amount_paise, t.payment_mode, t.confirmed_source, hd.name AS head FROM transactions t JOIN heads hd ON hd.id = t.head_id WHERE t.bill_no = '2610319'`;
    expect(t).toEqual({ amount_paise: 35300, payment_mode: 'cash', confirmed_source: 'both_matched', head: 'Room' });
    const [a] = await sql`SELECT after FROM audit_log WHERE action = 'register.added_from_software' ORDER BY id DESC LIMIT 1`;
    expect(JSON.parse(a.after)).toMatchObject({ billNo: '2610319', billType: 'room', amountPaise: 35300, mode: 'cash' });
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

describe('bring in, sync all and the bill drawer', () => {
  it('the checklist shows what has arrived; staff see no bank; sync all reports each account; a bill shows all its sides', async () => {
    const h = await hotel();
    await fullShift(h);
    const staff = (await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/inputs`)).json;
    expect(staff.software.bills).toBeGreaterThan(0);
    expect(staff.pages.filter((p: any) => p.kind === 'bill_register').length).toBe(1);
    // Each page says how much is left to review and how much is done, and who uploaded it (for deleting).
    const reg = staff.pages.find((p: any) => p.kind === 'bill_register');
    const [{ n: ticked }] = await sql`SELECT count(*) AS n FROM register_rows WHERE upload_id = ${reg.id} AND status = 'checked'`;
    expect(reg.reviewed).toBe(Number(ticked));
    expect(reg.unclear + reg.reviewed).toBe(reg.rows);
    expect(reg.uploadedBy).toBeTruthy();
    expect(staff.bank).toBeNull();
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { sheet: 'https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyz0123456789ABCD/edit', tab: '2026', receivesUpiLabel: 'UPI Bank 2' });
    const owner = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/inputs`)).json;
    expect(owner.bank).toMatchObject({ covered: false });
    // No Google access in tests: the account reports why, the call itself works.
    const sync = (await h.clients.owner.post(`/businesses/${h.bid}/bank/sync-all`, {})).json;
    expect(sync.results).toEqual([expect.objectContaining({ name: 'HUF', ok: false })]);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/bank/sync-all`, {})).status).toBe(403);
    // Bill drawer: software, register and comparison of one bill.
    const b = (await h.clients.viewer.get(`/businesses/${h.bid}/bills/2610317?day=2026-10-31`)).json;
    expect(b.comparisons[0]).toMatchObject({ bill_no: '2610317', difference: 'amount' });
    expect(b.register[0]).toMatchObject({ bill_no: '2610317', amount_paise: 414000 });
    expect(b.money).toEqual([]);
  });
});

describe('old POS bills (6 digits) wait for a person to confirm them', () => {
  it('are not decided by Bookr, while new POS numbers still are', async () => {
    const h = await hotel();
    const page = await fullShift(h);
    const add = (billNo: string, amount: string, payments: unknown[]) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked' });
    await add('145236', '553', [{ mode: 'upi', columnLabel: null, amount: '553' }]);
    await add('2610315', '300', [{ mode: 'cash', columnLabel: null, amount: '300' }]);
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo: '145237', billType: 'fnb', amount: '100', payments: [{ mode: 'cash', columnLabel: null, amount: '100' }], status: 'draft' });
    let v = await view(h);
    expect(byBill(v, '145236').decision ?? null).toBeNull();
    expect(byBill(v, '145236').register.reviewed).toBe(true);

    // Not reviewed yet: it cannot use the register, alone or in bulk.
    const early = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids: [byBill(v, '145237').id], note: 'Old POS bill' });
    expect(early.json).toMatchObject({ decided: 0, skipped: [{ billNo: '145237', reason: 'its register row is not reviewed yet' }] });
    expect(v.json.canConfirm).toBe(false);
    expect(byBill(v, '2610315')).toMatchObject({ decision: 'use_register', auto: true }); // counted, waits for its software bill

    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids: [byBill(v, '145236').id], note: 'Old POS bill' })).status).toBe(200);
    v = await view(h);
    expect(byBill(v, '145236')).toMatchObject({ decision: 'use_register', note: 'Old POS bill' });
    expect(byBill(v, '145236').auto).toBeFalsy();
    const [log] = await sql`SELECT user_id FROM audit_log WHERE action = 'comparison.decide' AND after LIKE '%noSoftwareBillExpected%'`;
    expect(log.user_id).not.toBeNull();
  });
});

describe('a shift with many one-sided bills', () => {
  it('loads with more one-sided bills than D1 allows query values (100)', async () => {
    const h = await hotel();
    await fullShift(h);
    const page = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(99), 'image/png')).json.id;
    for (let i = 0; i < 120; i += 1) {
      await sql`INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, status, created_at)
        VALUES (${crypto.randomUUID()}, ${h.bid}, ${page}, ${i + 1}, '2026-10-31', ${`77${String(i).padStart(4, '0')}`}, 'fnb', 10000, 'checked', 0)`;
    }
    // One more through the API rebuilds the shift's comparisons.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`,
      { billNo: '7799999', billType: 'fnb', amount: '100', status: 'checked', payments: [{ mode: 'cash', columnLabel: null, amount: '100' }] })).status).toBe(201);
    const v = await view(h);
    expect(v.status).toBe(200);
    expect(v.json.comparisons.filter((c: any) => c.difference === 'missing_in_software').length).toBeGreaterThan(100);
  });
});
