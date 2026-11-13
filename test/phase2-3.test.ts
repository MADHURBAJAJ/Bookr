// Phase 2 through the API, part 3 of 5 (helpers in phase2-shared.ts). Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, Client, sql, resetDb, uploads } from './helpers';
import { buildSalesCsv, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';
import { byBill, DAY_END, DAY_START, decideAll, fullShift, hotel, png, PNG, todayIst, view } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
// A full shift is ~20 API calls with many queries each; the local D1 proxy is slow per query.
vi.setConfig({ testTimeout: 180_000 });

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

  it('Reconcile\'s UPI tab shows the group once: its one payment, its credit, and each bill (approved 9 Nov 2026)', async () => {
    const { h, pageId } = await setup();
    await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`);
    const o = h.clients.owner;
    const url = `/businesses/${h.bid}/shifts/2026-10-31/entries`;
    let e = (await o.get(url)).json;
    const g = e.upi.entries.filter((x: any) => x.group);
    expect(g.map((x: any) => x.billNo).sort()).toEqual(['2610311', '26103122', '2610314']);
    expect(g[0].group).toMatchObject({ paymentPaise: 237000, billsPaise: 237000 });
    expect(new Set(g.map((x: any) => x.state))).toEqual(new Set(['waiting']));
    const before = e.upi.left;
    // The group's one credit comes in: the whole block is backed.
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' });
    await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t'),
      [1, 'S95000001', '31/10/2026', '31/10/2026 12:20:00 PM', '-', 'UPI/900000000061/UPI/xx61@okaxis/B/ICIa', 'CR', 2370, 1].join('\t')].join('\n') });
    e = (await o.get(url)).json;
    const g2 = e.upi.entries.filter((x: any) => x.group);
    expect(g2.every((x: any) => x.state === 'done' && /^Bank ₹2,370 at/.test(x.evidence))).toBe(true);
    expect(e.upi.left).toBe(before - 1);   // counted once
  });

  it('each bill matches its own software bill through the group payment mode; the group must balance', async () => {
    const { h, pageId } = await setup();
    let v = await view(h);
    for (const b of ['2610311', '2610314', '26103122']) expect(byBill(v, b).difference).toBe('match');
    // 2,370 paid for 2,380 of bills: the 10 discount is filled by itself on the row with the payment (13 Nov 2026).
    expect(v.json.blockers.join(' ')).not.toMatch(/paid together/);
    const disc = await sql`SELECT bill_no, discount_paise, paid_with_row_id FROM register_rows WHERE bill_no IN ('2610311', '2610314', '26103122')`;
    expect(disc.reduce((t, x) => t + x.discount_paise, 0)).toBe(1000);
    expect(disc.filter((x) => x.discount_paise > 0).every((x) => !x.paid_with_row_id)).toBe(true);
    // Filling again changes nothing; a group whose discount a person typed is left alone.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBe(0);
    v = await view(h);
    expect(v.json.blockers.join(' ')).not.toMatch(/paid together/);
    // The paying row received less than the software after the discount, the others their full amount: all matched, no decision.
    for (const b of ['2610311', '2610314', '26103122']) expect(byBill(v, b).difference).toBe('match');
    expect(v.json.matchedAfterAdjustment).toEqual([]); // shown as a group instead
  });

  it('confirming books one income row per bill, in the group mode', async () => {
    const { h } = await setup();
    await sql`UPDATE register_payments SET amount_paise = 238000 WHERE register_row_id = (SELECT id FROM register_rows WHERE bill_no = '2610311')`;
    await sql`UPDATE register_rows SET discount_paise = 0 WHERE bill_no = '2610311'`; // the filled 10 goes with the full payment
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

  it('a group paid more than one way can be confirmed: the bills take the payments in turn, and they add up by mode', async () => {
    const { h, head } = await setup();
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, {
      billNo: '2610311', billType: 'fnb', amount: '420', status: 'checked',
      payments: [{ mode: 'upi', amount: '2000' }, { mode: 'cash', amount: '380' }],
    });
    const v = await view(h);
    expect(v.json.blockers.join(' ')).not.toMatch(/paid together/);
    expect(v.json.paidGroups[0]).toMatchObject({ modes: expect.arrayContaining(['upi', 'cash']), paidPaise: 238000, matched: true });
    await decideAll(h);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const rows = await sql`SELECT bill_no, amount_paise, payment_mode FROM transactions WHERE bill_no IN ('2610311', '2610314', '26103122') AND type = 'income' ORDER BY bill_no, payment_mode`;
    expect(rows).toEqual([
      { bill_no: '2610311', amount_paise: 38000, payment_mode: 'cash' },
      { bill_no: '2610311', amount_paise: 4000, payment_mode: 'upi' },
      { bill_no: '26103122', amount_paise: 78000, payment_mode: 'upi' },
      { bill_no: '2610314', amount_paise: 118000, payment_mode: 'upi' },
    ]);
  });

  it('a group paid more than one way, not in the software, can be counted from the register', async () => {
    const { h, head } = await setup();
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, {
      billNo: '144698', billType: 'fnb', amount: '420', status: 'checked',
      payments: [{ mode: 'upi', amount: '2000' }, { mode: 'cash', amount: '380' }],
    });
    const v = await view(h);
    expect(v.json.paidGroups[0].why).toMatch(/Not in the software: bill 144698/);
    expect(byBill(v, '144698').register.mode).toBe('mixed');
    const r = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids: [byBill(v, '144698').id], note: 'Old POS bill' });
    expect(r.json).toMatchObject({ decided: 1, skipped: [] });
  });
});

describe('bills on one side only, followed across days', () => {
  const NOV1 = '2026-11-01';
  const regPage = async (h: Awaited<ReturnType<typeof hotel>>, n: number, rows: { billNo: string; amount: string; mode: string }[]) => {
    const page = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=${NOV1}`, png(n), 'image/png')).json.id;
    for (const r of rows) {
      expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, {
        billNo: r.billNo, billType: 'fnb', amount: r.amount, status: 'checked', payments: [{ mode: r.mode, columnLabel: null, amount: r.amount }] })).status).toBe(201);
    }
  };
  const decide = (h: Awaited<ReturnType<typeof hotel>>, id: string, body: Record<string, unknown>) => h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${id}`, body);

  it('counted on 31 Oct, written in the 1 Nov register: linked as already counted, never counted twice', async () => {
    const h = await hotel();
    await fullShift(h);
    expect((await decide(h, byBill(await view(h), '2610319').id, { decision: 'use_software', billType: 'fnb' })).status).toBe(200);
    // Added to the register from the software report: counted, not waiting.
    let waiting = (await h.clients.owner.get(`/businesses/${h.bid}/waiting-bills`)).json.bills;
    expect(waiting.map((b: any) => b.billNo)).not.toContain('2610319');
    await regPage(h, 95, [{ billNo: '2610319', amount: '353', mode: 'cash' }]);
    const late = byBill(await view(h, NOV1), '2610319');
    expect(late.difference).toBe('missing_in_software');
    expect(late.otherDay).toMatchObject({ day: '2026-10-31', side: 'software', decision: 'use_software', amountPaise: 35300 });
    expect((await decide(h, late.id, { decision: 'use_register' })).status).toBe(409);
    expect((await decide(h, late.id, { decision: 'leave_out', linkedToId: late.otherDay.id })).status).toBe(200);
    const after = byBill(await view(h, NOV1), '2610319');
    expect(after).toMatchObject({ decision: 'leave_out', linkedToId: late.otherDay.id });
    expect(after.note).toMatch(/Already counted on 2026-10-31/);
    waiting = (await h.clients.owner.get(`/businesses/${h.bid}/waiting-bills`)).json.bills;
    expect(waiting.map((b: any) => b.billNo)).not.toContain('2610319');
  });

  it('carried forward from 31 Oct, in the 1 Nov software report: counted on 1 Nov, its type from the register', async () => {
    const h = await hotel();
    await fullShift(h);
    const c = byBill(await view(h), '26103125');   // cash 500, register only
    expect((await decide(h, c.id, { decision: 'carry_forward' })).status).toBe(200);
    expect((await decide(h, byBill(await view(h), '2610319').id, { decision: 'carry_forward' })).status).toBe(200);
    expect((await decide(h, byBill(await view(h), '2610312').id, { decision: 'carry_forward' })).status).toBe(400); // a match
    expect((await h.importCsv(h.clients.owner, [{ pos: 'POS-1', bill: '26103125', when: '01-11-2026.10:00:00', name: 'U/N', mode: 'CASH', amount: '500' }],
      { day: NOV1, coversFrom: istToMs(2026, 11, 1, 8, 0, 0), coversTo: istToMs(2026, 11, 2, 7, 59, 59) })).status).toBe(201);
    const late = byBill(await view(h, NOV1), '26103125');
    expect(late.otherDay).toMatchObject({ day: '2026-10-31', side: 'register', decision: 'carry_forward', billType: 'fnb' });
    expect((await decide(h, late.id, { decision: 'use_software', linkedToId: late.otherDay.id })).status).toBe(200);
    const waiting = (await h.clients.owner.get(`/businesses/${h.bid}/waiting-bills`)).json.bills;
    expect(waiting.map((b: any) => b.billNo)).toContain('2610319'); // with the bills Bookr counted and left waiting
    expect(waiting.map((b: any) => b.billNo)).not.toContain('26103125');
  });

  it('left out on 31 Oct, then in the 1 Nov register: leaving it out again needs a reason; an old bill closes after the watch', async () => {
    const h = await hotel();
    await fullShift(h);
    expect((await decide(h, byBill(await view(h), '2610319').id, { decision: 'leave_out', note: 'Cancelled in POS' })).status).toBe(200);
    await regPage(h, 96, [{ billNo: '2610319', amount: '353', mode: 'cash' }]);
    const late = byBill(await view(h, NOV1), '2610319');
    expect(late.otherDay).toMatchObject({ decision: 'leave_out', note: 'Cancelled in POS' });
    expect((await decide(h, late.id, { decision: 'leave_out', linkedToId: late.otherDay.id })).status).toBe(400);
    expect((await decide(h, late.id, { decision: 'use_register', linkedToId: late.otherDay.id })).status).toBe(200);
    // Closing: refused inside the watch, allowed after it, with a reason, by Owner or Accountant.
    const c = byBill(await view(h), '26103125');
    expect((await decide(h, c.id, { decision: 'carry_forward' })).status).toBe(200);
    await sql`UPDATE bill_comparisons SET shift_day = ${todayIst()} WHERE id = ${c.id}`; // inside the watch, whatever today is
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/comparisons/${c.id}/close`, { note: 'Never billed' })).status).toBe(400);
    await sql`UPDATE bill_comparisons SET shift_day = '2026-10-01' WHERE id = ${c.id}`;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/comparisons/${c.id}/close`, { note: 'Never billed' })).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/comparisons/${c.id}/close`, { note: 'Never billed' })).status).toBe(200);
    expect((await h.clients.owner.get(`/businesses/${h.bid}/waiting-bills`)).json.bills.map((b: any) => b.billNo)).not.toContain('26103125');
  });
});

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

  // Names are kept since 12 Nov 2026 (for the complimentary report): on the software bill only, and in the stored copy.
  it('keeps the guest name on its software bill and in the stored copy, nowhere else', async () => {
    const h = await hotel();
    const res = await h.importCsv(h.clients.owner, REPORT_31_OCT);
    const [u] = await sql`SELECT storage_key FROM uploads WHERE kind = 'software_sales_csv'`;
    const stored = await (await uploads.get(u.storage_key))!.text();
    expect(stored).toMatch(/Asha Rao, Room 4/);
    expect((await sql`SELECT customer_name FROM software_bills WHERE bill_no = '26103120'`)[0].customer_name).toBe('Vikram Nair');
    for (const table of ['sales_reports', 'uploads', 'audit_log', 'bill_comparisons']) {
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

  it('Bring in lists the report files covering a shift, with the shifts each covers, and one can be deleted from there', async () => {
    const h = await hotel();
    await fullShift(h);
    const files = (await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/inputs`)).json.software.files;
    expect(files.length).toBeGreaterThan(0);
    const f = files.find((x: any) => x.billCount === 16);
    expect(f).toMatchObject({ uploadId: expect.any(String), replaces: false, days: expect.arrayContaining(['2026-10-31']) });
    expect((await h.clients.owner.del(`/businesses/${h.bid}/uploads/${f.uploadId}`)).status).toBe(200);
    const after = (await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/inputs`)).json.software.files;
    expect(after.map((x: any) => x.uploadId)).not.toContain(f.uploadId);
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
    expect(v.json.blockers.join(' ')).toMatch(/1 bill with two different lines in the software/);
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

describe('typo flags on register numbers', () => {
  it('a number one digit off a free bill of the shift is not counted by Bookr, and shows until a person decides', async () => {
    const h = await hotel();
    const [left, ...rest] = REGISTER_31_OCT;
    const page = await fullShift(h, rest);
    const typo = `${left.billNo.slice(0, -1)}${left.billNo.endsWith('9') ? '8' : '9'}`;
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo: typo, billType: left.billType, amount: left.amount, discount: (left as { discount?: string }).discount ?? '0',
      payments: left.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: p.amount })), status: 'checked' });
    expect(res.status).toBe(201);
    let v = await view(h);
    expect(byBill(v, typo).decision ?? null).toBeNull();
    expect(byBill(v, typo).numberFlags).toEqual([expect.objectContaining({ kind: 'pending_typo', billNo: left.billNo, sameShift: true })]);
    let d = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    expect(d.rows.find((r: any) => r.billNo === typo).numberFlags[0]).toMatchObject({ kind: 'pending_typo', billNo: left.billNo });

    // A person decides: the flag has done its job.
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, typo).id}`, { decision: 'use_register', note: 'checked the photo' })).status).toBe(200);
    v = await view(h);
    expect(byBill(v, typo).numberFlags).toEqual([]);
    d = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    expect(d.rows.find((r: any) => r.billNo === typo).numberFlags).toEqual([]);
  });

  it('a short number with a date prefix equal to a bill still waiting on an earlier shift, same amount', async () => {
    const h = await hotel();
    const left = REGISTER_31_OCT.find((r) => r.billNo === '2610311')!;
    await fullShift(h, REGISTER_31_OCT.filter((r) => r !== left));
    const v31 = await view(h);
    expect(byBill(v31, left.billNo).difference).toBe('missing_in_register');
    const p = await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-11-01`, png(2), 'image/png');
    const short = left.billNo.slice(6);
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${p.json.id}/register-rows`, { billNo: short, billType: left.billType, amount: left.amount, discount: (left as { discount?: string }).discount ?? '0',
      payments: left.payments.map((x) => ({ mode: x.mode, columnLabel: x.columnLabel, amount: x.amount })), status: 'checked' });
    expect(res.status).toBe(201);
    const d = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${p.json.id}`)).json;
    expect(d.rows[0].numberFlags).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'pending', billNo: left.billNo, day: '2026-10-31' })]));
  });
});

describe('register numbers of neither format can never match, so they do not wait', () => {
  it('stay for a person, are marked old POS or decided, and old decisions leave the waiting list', async () => {
    const h = await hotel();
    const page = await fullShift(h);
    const add = (billNo: string) => h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`,
      { billNo, billType: 'fnb', amount: '230', payments: [{ mode: 'cash', columnLabel: null, amount: '230' }], status: 'checked' });
    await add('230');
    await add('193');
    let v = await view(h);
    expect(byBill(v, '230').decision ?? null).toBeNull();
    expect(v.json.canConfirm).toBe(false);

    // Marked as an old POS bill: counted from the register and closed, with nothing to type.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids: [byBill(v, '230').id], note: 'Old POS bill, short number' })).status).toBe(200);
    v = await view(h);
    expect(byBill(v, '230')).toMatchObject({ decision: 'use_register', note: 'Old POS bill, short number' });
    let w = (await h.clients.accountant.get(`/businesses/${h.bid}/waiting-bills`)).json;
    expect([...w.bills, ...w.oddNumbers].map((b: any) => b.billNo)).not.toContain('230');

    // Decided the old way: not waiting, listed apart, and closable without the watch running out.
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, '193').id}`, { decision: 'use_register', note: 'to check' })).status).toBe(200);
    await sql`UPDATE bill_comparisons SET shift_day = ${todayIst()} WHERE id = ${byBill(v, '193').id}`; // inside the watch, whatever today is
    w = (await h.clients.accountant.get(`/businesses/${h.bid}/waiting-bills`)).json;
    expect(w.bills.map((b: any) => b.billNo)).not.toContain('193');
    const odd = w.oddNumbers.find((b: any) => b.billNo === '193');
    expect(odd).toMatchObject({ oddNumber: true, unresolved: false });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/comparisons/${odd.id}/close`, { note: 'Old POS bill, short number' })).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/comparisons/${odd.id}/close`, { note: 'Old POS bill, short number' })).status).toBe(200);
    w = (await h.clients.accountant.get(`/businesses/${h.bid}/waiting-bills`)).json;
    expect(w.oddNumbers).toEqual([]);

    // Settled, so Review no longer asks about the number.
    const d = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    expect(d.rows.find((r: any) => r.billNo === '193').numberSettled).toBe('Old POS bill, short number');
  });
});

describe('register-only bills in bulk (e.g. an old POS)', () => {
  it('a new POS number cannot be marked as an old POS bill', async () => {
    const h = await hotel();
    await fullShift(h);
    const v = await view(h);
    const r = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids: [byBill(v, '26103125').id], note: 'Old POS bill' });
    expect(r.json).toMatchObject({ decided: 0, skipped: [{ billNo: '26103125', reason: 'its number is in the new POS format, so it is not an old POS bill' }] });
    expect(byBill(await view(h), '26103125').decision ?? null).toBeNull();
  });

  it('counts them from the register with a reason, keeps them off the watch list, and skips what cannot be done this way', async () => {
    const h = await hotel();
    const page = await fullShift(h);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    await add('145236', '553', [{ mode: 'upi', columnLabel: null, amount: '553' }]);
    await add('145237', '131', [{ mode: 'cash', columnLabel: null, amount: '131' }]);
    await add('076', '200', [], { status: 'draft' });                              // no payment written (so not ticked)
    await add('078', '1000', [{ mode: 'cash', columnLabel: null, amount: '500' }], { discount: '500' }); // a 50% discount no longer holds it back
    let v = await view(h);
    const ids = ['145236', '145237', '076', '078', '2610319'].map((b) => byBill(v, b).id);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids, note: 'Old POS bill' })).status).toBe(403);
    const r = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids, note: 'Old POS bill' });
    expect(r.json.decided).toBe(3);
    expect(r.json.skipped.map((x: any) => x.billNo).sort()).toEqual(['076', '2610319']);
    v = await view(h);
    expect(byBill(v, '145236')).toMatchObject({ decision: 'use_register', note: 'Old POS bill' });
    const waiting = (await h.clients.owner.get(`/businesses/${h.bid}/waiting-bills`)).json.bills.map((b: any) => b.billNo);
    expect(waiting).not.toContain('145236');
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.decide' AND after LIKE '%noSoftwareBillExpected%'`)[0].n).toBe(3);
  });
});

describe('a UPI sale that was paid another way', () => {
  it('becomes cash: register mode and the sale change, the cash check counts it; put back restores', async () => {
    const h = await hotel();
    await fullShift(h);
    await decideAll(h);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const [sale] = await sql`SELECT id, amount_paise FROM transactions WHERE bill_no = '2610318' AND type = 'income'`;
    const cashBefore = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json.cashSalesPaise;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [sale.id], mode: 'cash', note: 'x' })).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [sale.id], mode: 'cash', note: 'register slip: it was cash' })).status).toBe(200);
    expect((await sql`SELECT payment_mode, match_status, account_id IS NOT NULL AS cash FROM transactions WHERE id = ${sale.id}`)[0]).toEqual({ payment_mode: 'cash', match_status: null, cash: 1 });
    expect((await sql`SELECT p.mode FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.bill_no = '2610318'`)[0].mode).toBe('cash');
    expect((await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json.cashSalesPaise).toBe(cashBefore + sale.amount_paise);
    const upi = (await h.clients.owner.get(`/businesses/${h.bid}/upi?day=2026-10-31`)).json;
    expect(upi.sales.map((x: any) => x.billNo)).not.toContain('2610318');
    expect(upi.repaid[0]).toMatchObject({ mode: 'cash', bills: ['2610318'] });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/sales/repay/${upi.repaid[0].id}/undo`, {})).status).toBe(200);
    expect((await sql`SELECT payment_mode, match_status FROM transactions WHERE id = ${sale.id}`)[0]).toEqual({ payment_mode: 'upi', match_status: 'awaiting_bank_match' });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/sales/repay/${upi.repaid[0].id}/undo`, {})).status).toBe(409);
    // Card: waits for the card settlement.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [sale.id], mode: 'card', note: 'card' })).status).toBe(200);
    expect((await sql`SELECT payment_mode, match_status FROM transactions WHERE id = ${sale.id}`)[0]).toEqual({ payment_mode: 'card', match_status: 'awaiting_card_settlement' });
    // A card sale with no card payment ("Was UPI?" on Reconcile) goes back the same way; not to its own mode.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [sale.id], mode: 'card', note: 'x' })).status).toBe(400);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [sale.id], mode: 'upi', note: 'No card payment in the card report' })).status).toBe(200);
    expect((await sql`SELECT payment_mode, match_status FROM transactions WHERE id = ${sale.id}`)[0]).toEqual({ payment_mode: 'upi', match_status: 'awaiting_bank_match' });
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
