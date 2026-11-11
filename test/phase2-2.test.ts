// Phase 2 through the API, part 2 of 5 (helpers in phase2-shared.ts). Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, Client, sql, resetDb, uploads } from './helpers';
import { buildSalesCsv, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';
import { byBill, DAY_END, DAY_START, decideAll, fullShift, hotel, png, PNG, todayIst, view } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
// A full shift is ~20 API calls with many queries each; the local D1 proxy is slow per query.
vi.setConfig({ testTimeout: 180_000 });

describe('Reconcile: one screen per confirmed shift (approved 5 Nov 2026)', () => {
  const HEAD = ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t');
  const line = (n: number, id: string, at: string, amount: number) =>
    [n, id, at.slice(0, 10), at, '-', `UPI/70000000${n}/Paid/cd-${n}@okicici/SAMPLE BANK/ICIaaaa`, 'CR', amount, String(amount)].join('\t');

  const upiAccount = async (h: Awaited<ReturnType<typeof hotel>>, label: string, name = 'HUF A') => {
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name, kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: label })).status).toBe(200);
    return acc as string;
  };

  it('trial reconcile: shows the picture before confirming, saves nothing, and never stops the confirm', async () => {
    const h = await hotel();
    await fullShift(h);
    await decideAll(h);
    const xoxo = await upiAccount(h, 'UPI XOXO', 'HUF B');
    const acc = await upiAccount(h, 'UPI Bank 2');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${xoxo}/paste`, { text: [HEAD, line(1, 'S40000001', '31/10/2026 1:10:00 PM', 4410)].join('\n') })).status).toBe(200);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(2, 'S40000003', '31/10/2026 3:00:00 PM', 777), line(3, 'S40000004', '01/11/2026 8:30:00 AM', 1234)].join('\n') })).status).toBe(200);
    const url = `/businesses/${h.bid}/shifts/2026-10-31/reconcile`;
    const r = (await h.clients.owner.get(url)).json;
    expect(r).toMatchObject({ confirmed: false, trial: true, coverage: { covered: true } });
    expect(r.clear.map((x: any) => [x.billNos, x.amountPaise])).toEqual([[['2610317'], 441000]]);
    expect(r.strip.matchedPaise).toBe(441000);
    const kinds = r.noCredit.map((c: any) => c.kind);
    expect(kinds).toContain('no_bill');
    expect(kinds).toContain('no_upi_credit');
    expect(r.noCredit.find((c: any) => c.kind === 'no_bill').title).toContain('777');
    // Looking saves nothing: no credit matched, no income made.
    expect((await sql`SELECT count(*) AS n FROM bank_rows WHERE status = 'matched'`)[0].n).toBe(0);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE shift_day = '2026-10-31' AND type = 'income'`)[0].n).toBe(0);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const after = (await h.clients.owner.get(url)).json;
    expect(after.confirmed).toBe(true);
    expect(after.trial).toBeUndefined();
  });

  it('an earlier open shift takes a credit near the shift change', async () => {
    const h = await hotel();
    const oct31 = await fullShift(h);
    const acc = await upiAccount(h, 'UPI XOXO');
    // Register-only bills of the same amount on both shifts, and one credit minutes after 8 am: it could look right for either.
    const row = (billNo: string) => ({ billNo, billType: 'fnb', amount: '1111', discount: '0', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI XOXO', amount: '1111' }] });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${oct31}/register-rows`, row('26103199'))).status).toBe(201);
    const page = await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-11-01`, png(2), 'image/png');
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page.json.id}/register-rows`, row('2611019'))).status).toBe(201);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(1, 'S40000001', '01/11/2026 8:10:00 AM', 1111)].join('\n') })).status).toBe(200);
    const earlier = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    expect(earlier.clear.map((x: any) => x.billNos)).toEqual([['26103199']]);
    const later = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-11-01/reconcile`)).json;
    expect(later.clear).toEqual([]);
  });

  const incomeFor = async (bid: string, amount: number) => sql`SELECT source, day, status, match_status, matched_bank_row, head_id FROM transactions WHERE business_id = ${bid} AND type = 'income' AND amount_paise = ${amount} ORDER BY source`;

  it('a credit booked directly and its bill that came later become one sale on the booked day; undo puts the booking back', async () => {
    const h = await hotel();
    await fullShift(h);
    const acc = await upiAccount(h, 'UPI Bank 2');
    // Bill 2610318 (₹650, both sides after deciding) was paid; the credit came the day before and was booked as a sale.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(1, 'S40000011', '30/10/2026 7:00:00 PM', 650)].join('\n') })).status).toBe(200);
    const [credit] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S40000011'`;
    const book = (more = {}) => h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${credit.id}/book`, { headId: h.fnb, note: 'Sale', ...more });
    // Before booking the screen is told a bill of this amount waits, and nothing is booked; the person may go on.
    const asked = await book({ checkBills: true });
    expect(asked.json.ok).toBe(false);
    expect(asked.json.waitingBills.map((b: any) => b.billNo)).toContain('2610318');
    expect((await book()).status).toBe(200);
    await decideAll(h);
    const url = `/businesses/${h.bid}/shifts/2026-10-31/reconcile`;
    let r = (await h.clients.owner.get(url)).json;
    const trialCard = r.fixes.find((c: any) => c.kind === 'same_sale');
    expect(trialCard.billNos).toEqual(['2610318']);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    // Not chosen before confirming: both count, until a person joins them.
    expect((await incomeFor(h.bid, 65000)).length).toBe(2);
    r = (await h.clients.owner.get(url)).json;
    const card = r.fixes.find((c: any) => c.kind === 'same_sale');
    expect(card.title).toContain('2610318');
    expect(r.noCredit.some((c: any) => c.billNos.includes('2610318'))).toBe(false);
    const act = card.actions[0];
    expect((await h.clients.entry_staff.post(act.path, act.body)).status).toBe(403);
    expect((await h.clients.owner.post(act.path, act.body)).status).toBe(200);
    let income = await incomeFor(h.bid, 65000);
    expect(income).toEqual([expect.objectContaining({ source: 'software_report', day: '2026-10-30', status: 'approved', match_status: null, matched_bank_row: credit.id })]);
    expect((await sql`SELECT status, transaction_id FROM bank_rows WHERE id = ${credit.id}`)[0]).toMatchObject({ status: 'matched', transaction_id: null });
    // Undo: the booking is back with its note, and the bill waits on its own day again.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${credit.id}/match`)).status).toBe(200);
    income = await incomeFor(h.bid, 65000);
    expect(income.length).toBe(2);
    expect(income.find((x: any) => x.source === 'bank_sheet')).toMatchObject({ day: '2026-10-30', matched_bank_row: credit.id });
    expect(income.find((x: any) => x.source === 'software_report')).toMatchObject({ day: '2026-10-31', match_status: 'awaiting_bank_match', matched_bank_row: null });
    expect((await sql`SELECT status, note FROM bank_rows WHERE id = ${credit.id}`)[0]).toMatchObject({ status: 'booked', note: 'Sale' });
    expect((await sql`SELECT count(*) AS n FROM bank_matches WHERE bank_row_id = ${credit.id}`)[0].n).toBe(0);
  });

  it('chosen before confirming, the confirm joins them, so the sale is never counted twice; Keep them apart cancels', async () => {
    const h = await hotel();
    await fullShift(h);
    const acc = await upiAccount(h, 'UPI Bank 2');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(1, 'S40000012', '30/10/2026 7:00:00 PM', 650)].join('\n') })).status).toBe(200);
    const [credit] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S40000012'`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${credit.id}/book`, { headId: h.fnb })).status).toBe(200);
    await decideAll(h);
    const url = `/businesses/${h.bid}/shifts/2026-10-31/reconcile`;
    const find = async () => (await h.clients.owner.get(url)).json.fixes.find((c: any) => c.kind === 'same_sale');
    const act = (await find()).actions[0];
    expect(act.path).toContain('/comparisons/');
    expect((await h.clients.owner.post(act.path, act.body)).status).toBe(200);
    const plan = await find();
    expect(plan.actions[0].label).toBe('Keep them apart');
    expect((await h.clients.owner.del(plan.actions[0].path, plan.actions[0].body)).status).toBe(200);
    expect((await find()).actions[0].label).toBe('Same sale');
    expect((await h.clients.owner.post(act.path, act.body)).status).toBe(200);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    expect(await incomeFor(h.bid, 65000)).toEqual([expect.objectContaining({ source: 'software_report', day: '2026-10-30', status: 'approved', match_status: null, matched_bank_row: credit.id })]);
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${credit.id}`)[0].status).toBe('matched');
    // Unmatch still works after a join made by the confirm.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${credit.id}/match`)).status).toBe(200);
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${credit.id}`)[0].status).toBe('booked');
    expect((await incomeFor(h.bid, 65000)).find((x: any) => x.source === 'software_report')).toMatchObject({ day: '2026-10-31', status: 'approved', match_status: 'awaiting_bank_match' });
  });

  it('a bill on one side only, stuck because its credit was booked, is counted on the booked day once joined', async () => {
    const h = await hotel();
    const page = await fullShift(h);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo: '26103199', billType: 'fnb', amount: '1111', discount: '0', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '1111' }] })).status).toBe(201);
    const acc = await upiAccount(h, 'UPI Bank 2');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(1, 'S40000013', '30/10/2026 7:00:00 PM', 1111)].join('\n') })).status).toBe(200);
    const [credit] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S40000013'`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${credit.id}/book`, { headId: h.fnb })).status).toBe(200);
    await decideAll(h);
    const v = await view(h);
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, '26103199').id}`, { decision: 'use_register' })).status).toBe(200);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    expect((await incomeFor(h.bid, 111100)).find((x: any) => x.source === 'software_report')).toMatchObject({ status: 'reviewed', day: '2026-10-31' });
    const r = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    const act = r.fixes.find((c: any) => c.kind === 'same_sale').actions[0];
    expect((await h.clients.owner.post(act.path, act.body)).status).toBe(200);
    expect(await incomeFor(h.bid, 111100)).toEqual([expect.objectContaining({ source: 'software_report', status: 'approved', day: '2026-10-30', matched_bank_row: credit.id })]);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${credit.id}/match`)).status).toBe(200);
    const back = await incomeFor(h.bid, 111100);
    expect(back.find((x: any) => x.source === 'software_report')).toMatchObject({ status: 'reviewed', day: '2026-10-31', match_status: 'awaiting_bank_match' });
    expect(back.find((x: any) => x.source === 'bank_sheet')).toMatchObject({ status: 'approved', day: '2026-10-30' });
  });

  it('closes a bill whose credit never came, after the watch and with a reason; it stays in income and can be reopened', async () => {
    const h = await hotel();
    await fullShift(h);
    await decideAll(h);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const list = () => h.clients.owner.get(`/businesses/${h.bid}/unmatched`);
    const bill = (await list()).json.bills.find((b: any) => b.billNo === '2610317');
    expect(bill).toBeTruthy();
    const close = (c: Client, body: unknown) => c.post(`/businesses/${h.bid}/sales/${bill.id}/close`, body);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    await sql`UPDATE transactions SET shift_day = ${today} WHERE id = ${bill.id}`;
    expect((await close(h.clients.owner, { note: 'Guest never paid' })).status).toBe(400);   // still being watched
    await sql`UPDATE transactions SET shift_day = '2026-01-01' WHERE id = ${bill.id}`;
    expect((await list()).json.bills.find((b: any) => b.id === bill.id)).toMatchObject({ canClose: true });
    expect((await close(h.clients.entry_staff, { note: 'x' })).status).toBe(403);
    expect((await close(h.clients.owner, {})).status).toBe(400);                             // a reason is required
    expect((await close(h.clients.accountant, { note: 'Guest never paid' })).status).toBe(200);
    expect((await close(h.clients.owner, { note: 'Again' })).status).toBe(409);
    let u = (await list()).json;
    expect(u.bills.find((b: any) => b.id === bill.id)).toBeUndefined();
    expect(u.closed[0]).toMatchObject({ id: bill.id, note: 'Guest never paid' });
    const income = await sql`SELECT amount_paise, match_status FROM transactions WHERE id = ${bill.id}`;
    expect(income[0]).toMatchObject({ amount_paise: 441000, match_status: null });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/sales/${bill.id}/reopen`)).status).toBe(403);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/sales/${bill.id}/reopen`)).status).toBe(200);
    u = (await list()).json;
    expect(u.bills.find((b: any) => b.id === bill.id)).toBeTruthy();
    expect(u.closed).toEqual([]);
    const log = await sql`SELECT action FROM audit_log WHERE row_id = ${bill.id} AND action IN ('sale.closed', 'sale.reopened') ORDER BY id`;
    expect(log.map((x: any) => x.action)).toEqual(['sale.closed', 'sale.reopened']);
  });

  it('splits what is left into clear, likely and missing; each action moves it to done and can be undone', async () => {
    const h = await hotel();
    await fullShift(h);
    const url = `/businesses/${h.bid}/shifts/2026-10-31/reconcile`;
    expect((await h.clients.owner.get(url)).json).toMatchObject({ confirmed: false, clear: [], likely: [] });
    await decideAll(h);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' })).status).toBe(200);
    const xoxo = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF B', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${xoxo}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${xoxo}/paste`, { text: [HEAD, line(1, 'S40000001', '31/10/2026 1:10:00 PM', 4410)].join('\n') })).status).toBe(200); // bill 2610317, 2 minutes after it
    const text = [HEAD,
      line(2, 'S40000002', '31/10/2026 6:00:00 PM', 650),  // bill 2610318, 160 minutes after it
      line(3, 'S40000003', '31/10/2026 3:00:00 PM', 777),  // no bill of this amount
      line(4, 'S40000004', '01/11/2026 8:30:00 AM', 1234)].join('\n');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    let r = (await h.clients.owner.get(url)).json;
    expect(r.confirmed).toBe(true);
    expect(r.coverage.covered).toBe(true);
    expect(r.clear.map((x: any) => [x.billNos, x.amountPaise, x.minutes])).toEqual([[['2610317'], 441000, 2]]);
    expect(r.likely.map((x: any) => [x.billNos, x.minutes])).toEqual([[['2610318'], 160]]);
    expect(r.noBill.map((x: any) => x.amountPaise)).toEqual([77700]);
    expect(r.strip).toMatchObject({ creditsLeft: 3, creditsLeftPaise: 441000 + 65000 + 77700, matchedPaise: 0 });
    // Clear: one click. Nothing was matched before the click.
    const clearId = r.clear[0].creditId;
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/match-clear`, { ids: [clearId] })).json.matched).toBe(1);
    // Likely: a person ticks it.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${r.likely[0].creditId}/match`, { transactionIds: r.likely[0].transactionIds })).status).toBe(200);
    // Money with no bill: booked as an unbilled sale.
    const fnb = r.unbilledHeads.find((x: any) => x.billType === 'fnb').headId;
    const noBill = r.noBill[0].creditId;
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${noBill}/book`, { headId: fnb, note: 'Unbilled F&B (Reconcile)' })).status).toBe(200);
    r = (await h.clients.owner.get(url)).json;
    expect(r.clear).toEqual([]);
    expect(r.likely).toEqual([]);
    expect(r.noBill).toEqual([]);
    expect(r.done.flatMap((x: any) => x.bills).sort()).toEqual(['2610317', '2610318']);
    expect(r.booked.map((x: any) => x.amountPaise)).toEqual([77700]);
    expect(r.strip).toMatchObject({ creditsLeft: 0, creditsLeftPaise: 0, matchedPaise: 441000 + 65000 });
    // Undone: back where it was.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${clearId}/match`)).status).toBe(200);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${noBill}/reopen`, {})).status).toBe(200);
    r = (await h.clients.owner.get(url)).json;
    expect(r.clear.map((x: any) => x.creditId)).toEqual([clearId]);
    expect(r.noBill.map((x: any) => x.creditId)).toEqual([noBill]);
    // The role is checked for this business on the server.
    expect((await h.clients.viewer.get(url)).status).toBe(403);
    expect((await h.clients.entry_staff.get(url)).status).toBe(403);
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
    const [a] = await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.decide' AND user_id IS NOT NULL`; // not Bookr's own
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
    const [a] = await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.decision_cleared' AND json_extract(before, '$.decided_by') IS NOT NULL`;
    expect(a.n).toBe(1);
    expect(pageId).toBeTruthy();
  });
});

describe('fix the bill from a bank credit (confirmed shift)', () => {
  it('a typo bill number joins the two halves: one sale left, matched; unmatch puts everything back', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    // The register wrote 2610319 as "X2610319", ₹300 by UPI (bill 353 less 53). The software has 2610319 ₹353.
    const reg = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: 'X2610319', billType: 'fnb', amount: '300', status: 'checked',
      payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '300' }] })).json.id;
    let v = await view(h);
    for (const [bill, d] of [['26103115', 'use_register'], ['2610317', 'use_software'], ['2610318', 'use_register'], ['26103120', 'use_register'], ['26103125', 'use_register'], ['X2610319', 'use_register']]) {
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`, { decision: d });
    }
    // Counted separately as well (the old way): the software half by a decision row.
    await sql`UPDATE bill_comparisons SET decision = 'use_software', bill_type = 'fnb' WHERE bill_no = '2610319'`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const before = await sql`SELECT bill_no, amount_paise, payment_mode FROM transactions WHERE bill_no IN ('2610319', 'X2610319') AND type = 'income' ORDER BY bill_no`;
    expect(before).toEqual([{ bill_no: '2610319', amount_paise: 35300, payment_mode: 'cash' }, { bill_no: 'X2610319', amount_paise: 30000, payment_mode: 'upi' }]);

    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t'),
      [1, 'S60000001', '31/10/2026', '31/10/2026 5:40:00 PM', '-', 'UPI/900000000021/UPI/xxq@okaxis/B/ICIq', 'CR', 300, 1].join('\t')].join('\n') });
    const [credit] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S60000001'`;
    const [tr] = await sql`SELECT id FROM transactions WHERE bill_no = 'X2610319'`;
    const opts = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows/${credit.id}/fix-options?tx=${tr.id}`)).json;
    expect(opts.register).toMatchObject({ billNo: 'X2610319', amountPaise: 30000 });
    expect(opts.softwareOnly[0].billNo).toBe('2610319');
    // Net must equal what came in.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${credit.id}/fix-bill`, { registerRowId: reg, billNo: '2610319', amount: '353', discount: '0', note: 'typo' })).status).toBe(400);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/bank-rows/${credit.id}/fix-bill`, { registerRowId: reg, billNo: '2610319', amount: '353', discount: '53', note: 'typo' })).status).toBe(403);
    const r = await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${credit.id}/fix-bill`, { registerRowId: reg, billNo: '2610319', amount: '353', discount: '53', note: 'register typo' });
    expect(r.status).toBe(200);
    expect((await sql`SELECT bill_no, amount_paise, discount_paise FROM register_rows WHERE id = ${reg}`)[0]).toEqual({ bill_no: '2610319', amount_paise: 35300, discount_paise: 5300 });
    expect(await sql`SELECT bill_no, amount_paise, payment_mode, matched_bank_row FROM transactions WHERE bill_no IN ('2610319', 'X2610319') AND type = 'income'`)
      .toEqual([{ bill_no: '2610319', amount_paise: 30000, payment_mode: 'upi', matched_bank_row: credit.id }]);
    expect((await sql`SELECT count(*) AS n FROM bill_comparisons WHERE bill_no = 'X2610319'`)[0].n).toBe(0);
    expect((await sql`SELECT register_row_id, decision FROM bill_comparisons WHERE bill_no = '2610319'`)[0]).toEqual({ register_row_id: reg, decision: 'use_register' });
    // The lock still holds for anything else.
    await expect(sql`UPDATE register_rows SET bill_no = 'Z' WHERE id = ${reg}`).rejects.toThrow(/shift_confirmed/);
    // Unmatch: everything as it was.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${credit.id}/match`)).status).toBe(200);
    expect((await sql`SELECT bill_no, amount_paise, discount_paise FROM register_rows WHERE id = ${reg}`)[0]).toEqual({ bill_no: 'X2610319', amount_paise: 30000, discount_paise: 0 });
    expect(await sql`SELECT bill_no, amount_paise, payment_mode, match_status FROM transactions WHERE bill_no IN ('2610319', 'X2610319') AND type = 'income' ORDER BY bill_no`).toEqual([
      { bill_no: '2610319', amount_paise: 35300, payment_mode: 'cash', match_status: null },
      { bill_no: 'X2610319', amount_paise: 30000, payment_mode: 'upi', match_status: 'awaiting_bank_match' }]);
    expect((await sql`SELECT decision FROM bill_comparisons WHERE bill_no = 'X2610319'`)[0].decision).toBe('use_register');
    expect((await sql`SELECT register_row_id, decision FROM bill_comparisons WHERE bill_no = '2610319'`)[0]).toEqual({ register_row_id: null, decision: 'use_software' });
    v = await view(h);
  });
});

describe('Save reconcile: matches are drafts until the shift is saved (approved 9 Nov 2026)', () => {
  it('a match chosen before saving holds its credit, can be undone, and is made on Save', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    await fullShift(h);
    await decideAll(h);
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' });
    // Bill 2610318 (₹650 by UPI at 3:20 pm): its credit came at 6:45 pm, too late to pair on its own.
    await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t'),
      [1, 'S90000001', '31/10/2026', '31/10/2026 6:45:00 PM', '-', 'UPI/900000000051/UPI/xx51@okaxis/B/ICIa', 'CR', 650, 1].join('\t'),
      [2, 'S90000002', '31/10/2026', '31/10/2026 6:50:00 PM', '-', 'UPI/900000000052/UPI/xx52@okaxis/B/ICIa', 'CR', 651, 1].join('\t')].join('\n') });
    const [cr] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S90000001'`;
    const [odd] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S90000002'`;
    const cmp = (await sql`SELECT id FROM bill_comparisons WHERE bill_no = '2610318'`)[0].id;
    const url = `/businesses/${h.bid}/shifts/2026-10-31/choices`;
    const rec = () => o.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`).then((r) => r.json);
    let r = await rec();
    expect(r.open.bills.map((b: any) => b.billNo)).toContain('2610318');
    expect(r.save).toMatchObject({ canSave: true, blockers: [] });

    expect((await h.clients.entry_staff.post(url, { bankRowId: cr.id, comparisonIds: [cmp] })).status).toBe(403);
    expect((await o.post(url, { bankRowId: odd.id, comparisonIds: [cmp] })).status).toBe(409);   // ₹651 is not the bill's ₹650
    const k = (await h.clients.accountant.post(url, { bankRowId: cr.id, comparisonIds: [cmp] })).json;
    expect(k.ok).toBe(true);
    expect((await o.post(url, { bankRowId: cr.id, comparisonIds: [cmp] })).status).toBe(409);   // held once
    r = await rec();
    expect(r.choices).toMatchObject([{ bankRowId: cr.id, billNos: ['2610318'], amountPaise: 65000, open: true, by: 'accountant' }]);
    expect(r.open.bills.map((b: any) => b.billNo)).not.toContain('2610318');
    expect(r.open.credits.map((c: any) => c.id)).not.toContain(cr.id);
    // Nothing is matched before saving; Undo removes the draft.
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${cr.id}`)[0].status).toBe('unmatched');
    expect((await o.del(`${url}/${k.id}`)).status).toBe(200);
    expect((await rec()).choices).toEqual([]);
    const k2 = (await o.post(url, { bankRowId: cr.id, comparisonIds: [cmp] })).json;

    // Save: the sales are booked and the chosen credit is matched; the draft goes.
    const saved = (await o.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).json;
    expect(saved.skipped).toEqual([]);
    expect((await sql`SELECT matched_bank_row, match_status FROM transactions WHERE bill_no = '2610318' AND type = 'income'`)[0]).toEqual({ matched_bank_row: cr.id, match_status: null });
    expect((await sql`SELECT count(*) AS n FROM shift_choices`)[0].n).toBe(0);
    expect((await o.del(`${url}/${k2.id}`)).status).toBe(404);
    expect((await o.post(url, { bankRowId: odd.id, comparisonIds: [cmp] })).status).toBe(409);   // saved: match directly
  });
});

describe('Reconcile tabs: Cash, UPI and Card (approved 9 Nov 2026)', () => {
  it('lists every bill under its mode with its evidence and its changes, before and after saving', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    await fullShift(h);
    const url = `/businesses/${h.bid}/shifts/2026-10-31/entries`;
    expect((await h.clients.entry_staff.get(url)).status).toBe(403);
    const find = (e: any, mode: string, bill: string) => e[mode].entries.filter((x: any) => x.billNo === bill);
    let e = (await o.get(url)).json;
    expect(e.confirmed).toBe(false);
    // A mode difference waits for a person, under the register's mode until decided.
    expect(find(e, 'cash', '26103115')[0]).toMatchObject({ state: 'decide', register: { mode: 'cash' }, software: { mode: 'upi' },
      edits: [{ text: 'Mode differs (register Cash · software UPI): to decide' }] });
    // Part cash, part UPI: one line in each tab.
    expect(find(e, 'cash', '26103120')[0]).toMatchObject({ amountPaise: 100000, part: 'part 1 of 2' });
    expect(find(e, 'upi', '26103120')[0]).toMatchObject({ amountPaise: 156000, part: 'part 2 of 2' });
    expect(find(e, 'card', '2610313')[0]).toMatchObject({ amountPaise: 94200, state: 'waiting', evidence: null });
    expect(e.cash.left).toBeGreaterThan(0);

    await decideAll(h);
    e = (await o.get(url)).json;
    expect(find(e, 'cash', '26103115')[0]).toMatchObject({ state: 'done', edits: [{ text: 'Mode differs (register Cash · software UPI) → used the register', by: 'accountant' }] });
    expect(e.upi.entries.some((x: any) => x.billNo === '2610319')).toBe(false);   // left out
    expect((await o.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);

    // Saved: the booked sales, and a mode changed later shows as before → after.
    const sale = (await sql`SELECT id FROM transactions WHERE bill_no = '2610318' AND type = 'income'`)[0].id;
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/sales/repay`, { transactionIds: [sale], mode: 'cash', note: 'register slip' })).status).toBe(200);
    e = (await o.get(url)).json;
    expect(e.confirmed).toBe(true);
    expect(find(e, 'upi', '2610318')).toEqual([]);
    expect(find(e, 'cash', '2610318')[0]).toMatchObject({ transactionId: sale, state: 'done', evidence: 'In the cash count' });
    expect(find(e, 'cash', '2610318')[0].edits.map((x: any) => x.text)).toContain('UPI → Cash (register slip)');
    expect(find(e, 'card', '2610313')[0]).toMatchObject({ state: 'waiting' });
    expect(e.card.left).toBe(1);
  });
});

describe('change the bills: one bill paid in two UPI goes', () => {
  it('the register payments become the two bank credits, the false discount goes; unmatch restores', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    // Written as 218 + 210 for a 492 bill, so a 64 discount was filled in; the bank shows 210 + 282.
    const row = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: '9900', billType: 'fnb', amount: '492', discount: '64', status: 'checked',
      payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '218' }, { mode: 'upi', columnLabel: 'UPI Bank 2', amount: '210' }] })).json.id;
    await decideAll(h);
    let v = await view(h);
    await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, '9900').id}`, { decision: 'use_register' });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const parts = await sql`SELECT id, amount_paise FROM transactions WHERE bill_no = '9900' AND type = 'income' ORDER BY amount_paise`;
    expect(parts.map((p) => p.amount_paise)).toEqual([21000, 21800]);
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    const T = (c: (string | number)[]) => c.join('\t');
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
      T([1, 'S50000001', '31/10/2026', '31/10/2026 10:47:00 PM', '-', 'UPI/900000000011/UPI/xxan@okhdfcb/B/HDFa', 'CR', 210, 1]),
      T([2, 'S50000002', '31/10/2026', '31/10/2026 10:54:00 PM', '-', 'UPI/900000000012/UPI/xxan@okhdfcb/B/HDFb', 'CR', 282, 1])].join('\n') });
    const credits = (await sql`SELECT id FROM bank_rows WHERE tran_id IN ('S50000001', 'S50000002') ORDER BY tran_id`).map((r) => r.id);
    // One part only: refused.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: credits, transactionIds: [parts[0].id], treat: 'bills', note: 'typo' })).status).toBe(400);
    const r = await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: credits, transactionIds: parts.map((p) => p.id), treat: 'bills', note: 'register typo 218 for 282' });
    expect(r.status).toBe(200);
    expect((await sql`SELECT amount_paise FROM register_payments WHERE register_row_id = ${row} ORDER BY amount_paise`).map((p) => p.amount_paise)).toEqual([21000, 28200]);
    expect((await sql`SELECT discount_paise, tip_paise FROM register_rows WHERE id = ${row}`)[0]).toEqual({ discount_paise: 0, tip_paise: 0 });
    expect((await sql`SELECT amount_paise FROM transactions WHERE bill_no = '9900' AND type = 'income' ORDER BY amount_paise`).map((p) => p.amount_paise)).toEqual([21000, 28200]);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${credits[0]}/match`)).json.unmatched).toBe(2);
    expect((await sql`SELECT amount_paise FROM register_payments WHERE register_row_id = ${row} ORDER BY amount_paise`).map((p) => p.amount_paise)).toEqual([21000, 21800]);
    expect((await sql`SELECT discount_paise FROM register_rows WHERE id = ${row}`)[0].discount_paise).toBe(6400);
    v = await view(h);
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

describe('use register for a bill paid together', () => {
  it('a bill with no payment of its own counts as paid through its group', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    const [head] = await sql`SELECT id FROM register_rows WHERE bill_no = '26103125'`; // cash 500, missing in the software
    const extra = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, {
      billNo: '193', billType: 'fnb', amount: '676', payments: [], paidWithRowId: head.id, status: 'checked',
    })).json.id;
    const lone = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, {
      billNo: '194', billType: 'fnb', amount: '50', payments: [], status: 'draft', // no payment: cannot be ticked
    })).json.id;
    const v = await view(h);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '193').id}`, { decision: 'use_register' })).status).toBe(200);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/comparisons/${byBill(v, '194').id}`, { decision: 'use_register' })).json.error).toMatch(/not paid together/);
    expect(extra && lone).toBeTruthy();
  });
});
