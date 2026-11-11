// Phase 2 through the API, part 1 of 5 (helpers in phase2-shared.ts). Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, Client, sql, resetDb, uploads } from './helpers';
import { buildSalesCsv, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';
import { byBill, DAY_END, DAY_START, decideAll, fullShift, hotel, png, PNG, todayIst, view } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
// A full shift is ~20 API calls with many queries each; the local D1 proxy is slow per query.
vi.setConfig({ testTimeout: 180_000 });

describe('the bank as a third witness on Compare sales (approved 5 Nov 2026)', () => {
  const HEAD = ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t');
  const line = (n: number, id: string, at: string, amount: number) =>
    [n, id, at.slice(0, 10), at, '-', `UPI/60000000${n}/Paid/ab-${n}@okicici/SAMPLE BANK/ICIaaaa`, 'CR', amount, String(amount)].join('\t');

  it('a group paid together shows the credit equal to its UPI total, each credit once, and a split payment looks for its UPI part', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122', '2610317', '2610318'].includes(r.billNo));
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    // 2,380 in all: 380 cash and 2,000 UPI. Then 5,060 by UPI, for which no credit came.
    const split = (await add('2610311', '420', [{ mode: 'upi', columnLabel: null, amount: '2000' }, { mode: 'cash', columnLabel: null, amount: '380' }])).json.id;
    await add('2610314', '1180', [], { paidWithRowId: split });
    await add('26103122', '780', [], { paidWithRowId: split });
    const none = (await add('2610318', '650', [{ mode: 'upi', columnLabel: null, amount: '5060' }])).json.id;
    await add('2610317', '4410', [], { paidWithRowId: none });
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    const text = [HEAD, line(1, 'S30000011', '31/10/2026 1:00:00 PM', 2000), line(2, 'S30000012', '01/11/2026 8:30:00 AM', 1234)].join('\n');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    const v = await view(h);
    const group = (id: string) => v.json.paidGroups.find((g: any) => g.id === id);
    expect(group(split)).toMatchObject({ upiPaise: 200000, bank: { amountPaise: 200000 } });
    expect(group(none)).toMatchObject({ upiPaise: 506000, bank: null });
    expect(v.json.bank.covered).toBe(true);
    expect(v.json.bank.noBill).toEqual([]);
    expect((await sql`SELECT count(*) AS n FROM bank_rows WHERE tran_id = 'S30000011' AND status = 'matched'`)[0].n).toBe(0); // shown, not matched

    // Reconcile's top line adds up: every UPI bill is matched (its own credit or its group's) or not in the bank yet.
    const trial = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    expect(trial.strip.matchedPaise + trial.strip.billsLeftPaise).toBe(trial.strip.upiSalesPaise);
    expect(trial.open.bills.map((x: any) => x.billNo)).not.toContain('2610314');
    expect(trial.open.bills.map((x: any) => x.billNo)).toContain('2610317'); // its group's credit never came

    // The Difference column counts only bills still to decide: 0 once every one is decided.
    const open = (x: any) => x.json.totals.reduce((t: number, m: any) => t + m.openPaise, 0) + x.json.unknownOpenPaise;
    expect(open(v)).not.toBe(0);
    for (const x of v.json.comparisons) {
      if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision: x.register ? 'use_register' : 'use_software', billType: 'fnb', note: 'Test' });
    }
    const decided = await view(h);
    expect(open(decided)).toBe(0);
    expect(decided.json.totals.find((m: any) => m.mode === 'upi').registerPaise).toBe(v.json.totals.find((m: any) => m.mode === 'upi').registerPaise); // the full reports stay

    // Confirming matches the group's credit to the group's UPI sales, and Unmatch undoes it.
    const done = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(done.json.blockers ?? done.json.error ?? null).toBeNull();
    const [credit] = await sql`SELECT id, status FROM bank_rows WHERE tran_id = 'S30000011'`;
    expect(credit.status).toBe('matched');
    const sales = await sql`SELECT t.amount_paise, t.bill_no FROM transactions t WHERE t.matched_bank_row = ${credit.id}`;
    expect(sales.reduce((a: number, x: any) => a + x.amount_paise, 0)).toBe(200000);
    expect(sales.every((x: any) => ['2610311', '2610314', '26103122'].includes(x.bill_no))).toBe(true);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${credit.id}/match`)).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE matched_bank_row = ${credit.id}`)[0].n).toBe(0);
  });

  it('a mode difference with no UPI credit for its UPI side: the bank backs the other side, for Owner and Accountant only', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => r.billNo !== '2610317');
    const pageId = await fullShift(h, reg);
    // Software: 2610317, ₹ 4,410 by UPI at 1:07 pm. Register: the same bill by card.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: '2610317', billType: 'fnb', amount: '4410', status: 'checked',
      payments: [{ mode: 'card', columnLabel: null, amount: '4410' }] })).status).toBe(201);
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    // Bank not in yet: a missing credit may still come, so nothing is said.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(1, 'S30000031', '31/10/2026 9:00:00 AM', 1234)].join('\n') })).status).toBe(200);
    expect(byBill(await view(h), '2610317')).toMatchObject({ difference: 'mode', bank: null, bankNone: null });
    // Bank in, and no ₹ 4,410 credit (one far away does not count): most likely card, as the register says.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(2, 'S30000032', '31/10/2026 6:00:00 PM', 4410), line(3, 'S30000033', '01/11/2026 8:30:00 AM', 1234)].join('\n') })).status).toBe(200);
    const v = await view(h);
    expect(byBill(v, '2610317').bankNone).toEqual({ suggest: 'use_register', upiPaise: 441000, mode: 'card', takenBy: null });
    for (const role of ['entry_staff', 'viewer'] as const) {
      const x = (await h.clients[role].get(`/businesses/${h.bid}/shifts/2026-10-31`)).json.comparisons.find((c: any) => c.billNo === '2610317');
      expect(x).not.toHaveProperty('bankNone');
    }
    // A credit of ₹ 4,410 near the bill: now the bank backs the software, and "no credit" goes.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [HEAD, line(4, 'S30000034', '31/10/2026 1:08:00 PM', 4410)].join('\n') })).status).toBe(200);
    const after = byBill(await view(h), '2610317');
    expect(after.bank).toMatchObject({ amountPaise: 441000, suggest: 'use_software' });
    expect(after.bankNone).toBeNull();
  });

  it('a bill paid in several UPI goes pairs each payment with its own credit, and confirming matches all of them', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => r.billNo !== '2610317');
    const pageId = await fullShift(h, reg);
    // Software: 2610317, ₹ 4,410 by UPI. Register: the same, written as three UPI payments.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: '2610317', billType: 'fnb', amount: '4410', status: 'checked',
      payments: [{ mode: 'upi', columnLabel: null, amount: '2000' }, { mode: 'upi', columnLabel: null, amount: '1410' }, { mode: 'upi', columnLabel: null, amount: '1000' }] })).status).toBe(201);
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    const text = [HEAD, line(1, 'S30000021', '31/10/2026 12:50:00 PM', 1000), line(2, 'S30000022', '31/10/2026 12:55:00 PM', 2000),
      line(3, 'S30000023', '31/10/2026 1:20:00 PM', 1410), line(4, 'S30000024', '01/11/2026 8:30:00 AM', 1234)].join('\n');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    const v = await view(h);
    const c = byBill(v, '2610317');
    expect(c.bank).toMatchObject({ amountPaise: 441000, fits: 'both' });
    expect(c.bank.parts.map((p: any) => p.amountPaise)).toEqual([100000, 200000, 141000]);
    expect(v.json.bank.noBill.map((x: any) => x.amountPaise)).not.toContain(100000);
    const trial = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    expect(trial.clear.filter((x: any) => x.billNos[0] === '2610317').map((x: any) => x.part)).toEqual(['part 1 of 3 UPI payments', 'part 2 of 3 UPI payments', 'part 3 of 3 UPI payments']);
    expect(trial.open.bills.map((x: any) => x.billNo)).not.toContain('2610317');
    for (const x of v.json.comparisons) {
      if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision: x.register ? 'use_register' : 'use_software', billType: 'fnb', note: 'Test' });
    }
    const done = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(done.json.blockers ?? done.json.error ?? null).toBeNull();
    const matched = await sql`SELECT t.amount_paise AS sale, b.amount_paise AS credit FROM transactions t JOIN bank_rows b ON b.id = t.matched_bank_row WHERE t.bill_no = '2610317' ORDER BY t.amount_paise`;
    expect(matched).toEqual([{ sale: 100000, credit: 100000 }, { sale: 141000, credit: 141000 }, { sale: 200000, credit: 200000 }]);
  });

  it('a UPI payment under the wrong account column: Owner and Accountant are told and change it; on a confirmed shift change and match go together', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => r.billNo !== '2610317');
    const pageId = await fullShift(h, reg);
    // Written under UPI Bank 2; the money came into the UPI XOXO account. Nothing of that amount came into Bank 2.
    const row = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: '2610317', billType: 'fnb', amount: '4410', status: 'checked',
      payments: [{ mode: 'upi', columnLabel: 'UPI BANK 2', amount: '4410' }] })).json.id;
    const xoxo = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    const bank2 = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF B', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${xoxo}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${bank2}/source`, { receivesUpiLabel: 'UPI Bank 2' })).status).toBe(200);
    const paste = (acc: string, text: string) => h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text });
    expect((await paste(xoxo, [HEAD, line(1, 'S30000031', '31/10/2026 1:05:00 PM', 4410), line(2, 'S30000032', '01/11/2026 8:30:00 AM', 1234)].join('\n'))).status).toBe(200);
    expect((await paste(bank2, [HEAD, line(1, 'S30000041', '01/11/2026 8:40:00 AM', 777)].join('\n'))).status).toBe(200);

    const v = await view(h);
    expect(v.json.columnHints).toEqual([expect.objectContaining({ billNo: '2610317', rowId: row, fromLabel: 'UPI BANK 2', toLabel: 'UPI XOXO', accountName: 'HUF A', amountPaise: 441000 })]);
    expect(byBill(v, '2610317').bank).toBeNull(); // the column's account has no such credit
    // Entry staff are told nothing about the bank: no hints, no bank time on Review.
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31`)).json.columnHints).toEqual([]);
    const staffPage = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${pageId}`)).json;
    expect(staffPage.rows.find((r: any) => r.id === row).columnHint).toBeNull();
    const ownerPage = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${pageId}`)).json;
    const hint = ownerPage.rows.find((r: any) => r.id === row).columnHint;
    expect(hint).toMatchObject({ toLabel: 'UPI XOXO', minutes: expect.any(Number) });
    expect((await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.columnHints.map((x: any) => x.billNo)).toEqual(['2610317']);

    // Only people who can match the bank may change it, and only to an account's column.
    const change = (client: any, body: unknown) => client.post(`/businesses/${h.bid}/register-payments/${hint.paymentId}/column`, body);
    expect((await change(h.clients.entry_staff, { columnLabel: 'UPI XOXO' })).status).toBe(403);
    expect((await change(h.clients.owner, { columnLabel: 'UPI Bank 9' })).status).toBe(400);
    // Before confirming: the change alone; then the bank backs the bill and the hint is gone. Put back for the next part.
    expect((await change(h.clients.accountant, { columnLabel: 'UPI XOXO' })).status).toBe(200);
    const after = await view(h);
    expect(after.json.columnHints).toEqual([]);
    expect(byBill(after, '2610317').bank).toMatchObject({ amountPaise: 441000 });
    expect((await change(h.clients.owner, { columnLabel: 'UPI BANK 2' })).status).toBe(200);
    expect((await sql`SELECT column_label FROM register_payments WHERE id = ${hint.paymentId}`)[0].column_label).toBe('UPI BANK 2');

    // Confirmed with the wrong column: Reconcile offers the change and the match in one step.
    for (const x of (await view(h)).json.comparisons) {
      if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision: x.register ? 'use_register' : 'use_software', billType: 'fnb', note: 'Test' });
    }
    const done = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(done.json.blockers ?? done.json.error ?? null).toBeNull();
    const rec = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    const ch = rec.columnHints.find((x: any) => x.billNo === '2610317');
    expect(ch.transactionIds).toHaveLength(1);
    expect((await change(h.clients.owner, { columnLabel: ch.toLabel, creditId: ch.creditId, transactionIds: ch.transactionIds })).json).toEqual({ ok: true, matched: true });
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${ch.creditId}`)[0].status).toBe('matched');
    expect((await sql`SELECT column_label FROM register_payments WHERE id = ${ch.paymentId}`)[0].column_label).toBe('UPI XOXO');
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'register.column_changed'`)[0].n).toBe(3);
    expect((await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.columnHints).toEqual([]);
    // Undo: unmatch, then the column back.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${ch.creditId}/match`)).status).toBe(200);
    expect((await change(h.clients.owner, { columnLabel: 'UPI BANK 2' })).status).toBe(200);
    expect((await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.columnHints.map((x: any) => x.billNo)).toEqual(['2610317']);
  });

  // Two slips (7 Nov 2026): 2610317 (₹ 4,410 at 1:07 pm) paid 3,000 + 1,410 by UPI, written 3,000 + 1,140 with ₹ 270 off;
  // 26103120 (₹ 2,560 at 7:48 pm) paid 2,552 + 8, the 8 written as a discount.
  const slipShift = async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => r.billNo !== '2610317' && r.billNo !== '26103120');
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, discount: string, payments: unknown[]) => h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`,
      { billNo, billType: 'fnb', amount, discount, payments, status: 'checked' });
    const a = (await add('2610317', '4410', '270', [{ mode: 'upi', columnLabel: null, amount: '3000' }, { mode: 'upi', columnLabel: null, amount: '1140' }])).json.id;
    const b = (await add('26103120', '2560', '8', [{ mode: 'upi', columnLabel: null, amount: '2552' }])).json.id;
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    const text = [HEAD, line(1, 'S30000051', '31/10/2026 1:00:00 PM', 3000), line(2, 'S30000052', '31/10/2026 1:15:00 PM', 1410),
      line(3, 'S30000053', '31/10/2026 7:50:00 PM', 2552), line(4, 'S30000054', '31/10/2026 7:51:00 PM', 8), line(5, 'S30000055', '01/11/2026 8:30:00 AM', 1234)].join('\n');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    return { h, pageId, a, b };
  };

  it('a credit with no bill that a register slip explains: the fix is offered on Compare and trial Reconcile, and editing the row lets the bank back the bill', async () => {
    const { h, pageId, a, b } = await slipShift();
    const v = await view(h);
    const slip = (rowId: string) => v.json.slips.find((x: any) => x.rowId === rowId);
    expect(slip(a)).toMatchObject({ kind: 'change_payment', fromPaise: 114000, creditPaise: 141000, after: { discountPaise: 0 }, others: [{ amountPaise: 300000 }] });
    expect(slip(a).after.pays.map((p: any) => p.amountPaise).sort((x: number, y: number) => x - y)).toEqual([141000, 300000]); // saved together: any order
    expect(slip(b)).toMatchObject({ kind: 'add_payment', creditPaise: 800, before: { discountPaise: 800 }, after: { discountPaise: 0 } });
    expect(slip(b).after.pays.map((p: any) => p.amountPaise).sort((x: number, y: number) => x - y)).toEqual([800, 255200]);
    expect(v.json.bank.noBill.map((x: any) => x.amountPaise).sort((p: number, q: number) => p - q)).toEqual([800, 141000]); // the page hides the ones a slip explains; the ₹ 3,000 is a written part of 2610317 (audit S6)
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31`)).json.slips).toEqual([]);
    const trial = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    expect(trial.slips.map((x: any) => x.key).sort()).toEqual(v.json.slips.map((x: any) => x.key).sort());
    // One count on both pages: credits not matched yet, and of them those with no bill of that amount.
    expect(v.json.bank.open.map((x: any) => x.id).sort()).toEqual(trial.open.credits.map((x: any) => x.id).sort());
    expect(trial.strip.creditsLeft).toBe(v.json.bank.open.length);
    expect(trial.strip.creditsNoBill).toBe(2);
    expect(trial.open.credits.filter((x: any) => x.noBill).map((x: any) => x.amountPaise).sort((p: number, q: number) => p - q)).toEqual([800, 141000]);
    // What the button does before confirming: the row as corrected.
    const rows = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${pageId}`)).json.rows;
    for (const s of v.json.slips) {
      const r = rows.find((x: any) => x.id === s.rowId);
      expect((await h.clients.owner.put(`/businesses/${h.bid}/register-rows/${s.rowId}`, { billNo: r.billNo, billType: r.billType, amount: (r.amountPaise / 100).toFixed(2),
        discount: ((s.after.discountPaise - s.after.tipPaise) / 100).toFixed(2), status: r.status,
        payments: s.after.pays.map((p: any) => ({ mode: p.mode, columnLabel: p.label, amount: (p.amountPaise / 100).toFixed(2) })) })).status).toBe(200);
    }
    const after = await view(h);
    expect(after.json.slips).toEqual([]);
    expect(byBill(after, '2610317')).toMatchObject({ difference: 'match', bank: { amountPaise: 441000 } });
    expect(byBill(after, '26103120')).toMatchObject({ difference: 'match', bank: { amountPaise: 256000 } });
  });

  it('a cash bill missing in the register with a UPI credit of its amount is offered as UPI, written in and counted from the register', async () => {
    const h = await hotel();
    await fullShift(h); // 2610319: ₹ 353 cash at 5:35 pm, in the software only
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    const text = [HEAD, line(1, 'S30000071', '31/10/2026 5:40:00 PM', 353), line(2, 'S30000072', '01/11/2026 8:30:00 AM', 1234)].join('\n');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    const v = await view(h);
    const w = v.json.warnings.find((x: any) => x.billNo === '2610319');
    expect(w).toMatchObject({ counted: true, byUpi: { amountPaise: 35300, label: 'UPI XOXO' } }); // counted by Bookr while it waits
    // Bank data: not for entry staff, who see the plain cash warning.
    const staff = (await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31`)).json.warnings.find((x: any) => x.billNo === '2610319');
    expect(staff.byUpi).toBeUndefined();
    expect(staff.text).toMatch(/check the cash/);
    const go = (client: any, body: unknown) => client.post(`/businesses/${h.bid}/comparisons/${w.comparisonId}/paid-by-upi`, body);
    expect((await go(h.clients.entry_staff, { creditId: w.byUpi.creditId, billType: 'fnb' })).status).toBe(403);
    expect((await go(h.clients.accountant, { creditId: w.byUpi.creditId })).status).toBe(200); // its type came with Bookr's decision
    expect((await go(h.clients.accountant, { creditId: w.byUpi.creditId })).status).toBe(400); // done once
    const after = await view(h);
    expect(byBill(after, '2610319')).toMatchObject({ difference: 'mode', decision: 'use_register', register: { mode: 'upi', amountPaise: 35300 } });
    expect(after.json.warnings.find((x: any) => x.billNo === '2610319')).toBeUndefined();
    const [row] = await sql`SELECT r.status, r.remarks, p.column_label FROM register_rows r JOIN register_payments p ON p.register_row_id = r.id WHERE r.bill_no = '2610319'`;
    expect(row).toMatchObject({ status: 'checked', column_label: 'UPI XOXO' });
    expect(row.remarks).toMatch(/Paid by UPI/);
    // Confirming counts it as UPI and matches the credit.
    for (const x of after.json.comparisons) {
      if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision: x.register ? 'use_register' : 'use_software', billType: 'fnb', note: 'Test' });
    }
    const done = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(done.json.blockers ?? done.json.error ?? null).toBeNull();
    const [t] = await sql`SELECT t.payment_mode, t.matched_bank_row FROM transactions t WHERE t.bill_no = '2610319'`;
    expect(t.payment_mode).toBe('upi');
    expect(t.matched_bank_row).toBe(w.byUpi.creditId);
  });

  it('a leftover credit is tried even when some other bill has its amount', async () => {
    const { h, pageId, b } = await slipShift();
    // A ₹ 8 bill elsewhere, paid in cash: the ₹ 8 credit is no longer "no bill", but nothing pairs it either.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`,
      { billNo: '145999', billType: 'fnb', amount: '8', discount: '0', payments: [{ mode: 'cash', columnLabel: null, amount: '8' }], status: 'checked' })).status).toBe(201);
    const v = await view(h);
    expect(v.json.bank.noBill.map((x: any) => x.amountPaise)).not.toContain(800);
    expect(v.json.bank.left).toBeUndefined();
    expect(v.json.slips.find((x: any) => x.rowId === b)).toMatchObject({ kind: 'add_payment', creditPaise: 800 });
    const trial = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    expect(trial.slips.find((x: any) => x.rowId === b)).toMatchObject({ kind: 'add_payment', creditPaise: 800 });
    // Open credits carry their account's column, for writing a ticked credit on a bill's row.
    expect(trial.open.credits.find((x: any) => x.amountPaise === 800)).toMatchObject({ label: 'UPI XOXO' });
  });

  it('the Missed entries report lists bills missed in the register, in the software, and money in neither', async () => {
    const { h, pageId } = await slipShift(); // 2610317 and 26103120 written; the rest of 31 Oct from the register
    // A bill only in the register, and an old POS bill (never in the software report, so left out of the list).
    const regOnly = (billNo: string) => h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`,
      { billNo, billType: 'fnb', amount: '75', discount: '0', payments: [{ mode: 'cash', columnLabel: null, amount: '75' }], status: 'checked' });
    expect((await regOnly('26103199')).status).toBe(201);
    expect((await regOnly('145999')).status).toBe(201);
    // The ₹ 12.34 credit after the shift belongs to 1 Nov; book one inside the shift instead: the ₹ 8 (in no bill once it is booked).
    const credit = (await sql`SELECT id FROM bank_rows WHERE business_id = ${h.bid} AND amount_paise = 800`)[0];
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${credit.id}/book`, { headId: h.fnb, note: 'Tip' })).status).toBe(200);
    const get = (client: any) => client.get(`/businesses/${h.bid}/reports/missed?from=2026-10-31&to=2026-10-31`);
    expect((await get(h.clients.entry_staff)).status).toBe(403);
    const r = (await get(h.clients.viewer)).json;
    expect(r.notInSoftware.find((x: any) => x.billNo === '26103199')).toMatchObject({ day: '2026-10-31', amountPaise: 7500, status: 'open' });
    expect(r.notInSoftware.map((x: any) => x.billNo)).not.toContain('145999');
    expect(r.oldPos.count).toBeGreaterThanOrEqual(1);
    const v = await view(h);
    const swOnly = v.json.comparisons.filter((x: any) => x.difference === 'missing_in_register').map((x: any) => x.billNo).sort();
    expect(r.notInRegister.map((x: any) => x.billNo).sort()).toEqual(swOnly);
    // Booked: listed. Unmatched credits wait until the shift is confirmed.
    expect(r.inNeither).toEqual([expect.objectContaining({ id: credit.id, amountPaise: 800, status: 'booked', note: 'Tip', day: '2026-10-31' })]);
    expect((await h.clients.viewer.get(`/businesses/${h.bid}/reports/missed?from=2026-11-02&to=2026-11-01`)).status).toBe(400);
  });

  it('a bill cannot be ticked without a payment, unless it is paid with another row or discounted to nothing', async () => {
    const h = await hotel();
    const pageId = await fullShift(h, REGISTER_31_OCT.slice(0, 3));
    const add = (body: Record<string, unknown>) => h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`,
      { billType: 'fnb', discount: '0', payments: [], ...body });
    const refused = await add({ billNo: '145901', amount: '500', status: 'checked' });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/how this bill was paid/);
    const draft = await add({ billNo: '145901', amount: '500', status: 'draft' });
    expect(draft.status).toBe(201);
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${draft.json.id}`,
      { billNo: '145901', billType: 'fnb', amount: '500', discount: '0', payments: [], status: 'checked' })).status).toBe(400);
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${draft.json.id}`,
      { billNo: '145901', billType: 'fnb', amount: '500', discount: '0', payments: [{ mode: 'cash', columnLabel: null, amount: '500' }], status: 'checked' })).status).toBe(200);
    expect((await add({ billNo: '145902', amount: '200', paidWithRowId: draft.json.id, status: 'checked' })).status).toBe(201);
    expect((await add({ billNo: '145903', amount: '200', discount: '200', status: 'checked' })).status).toBe(201);
  });

  it('on a confirmed shift the slip fix is recorded and matched in one step; Unmatch puts the register and the sales back', async () => {
    const { h, a, b } = await slipShift();
    for (const x of (await view(h)).json.comparisons) {
      if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision: x.register ? 'use_register' : 'use_software', billType: 'fnb', note: 'Test' });
    }
    const done = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(done.json.blockers ?? done.json.error ?? null).toBeNull();
    const rec = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    const sa = rec.slips.find((x: any) => x.rowId === a);
    const sb = rec.slips.find((x: any) => x.rowId === b);
    expect(sa).toMatchObject({ kind: 'change_payment', others: [{ amountPaise: 300000 }] });
    expect(sb).toMatchObject({ kind: 'add_payment', others: [] }); // its 2,552 was matched on confirm
    const fix = (s: any, client = h.clients.owner) => client.post(`/businesses/${h.bid}/bank-rows/${s.creditId}/slip-fix`, { day: '2026-10-31', key: s.key });
    expect((await fix(sa, h.clients.entry_staff)).status).toBe(403);
    expect((await fix({ ...sa, key: 'slip:chg:nope' })).status).toBe(409);
    expect((await fix(sa)).status).toBe(200);
    expect((await fix(sb)).status).toBe(200);
    const sales = async (billNo: string) => (await sql`SELECT t.amount_paise AS sale, b.amount_paise AS credit FROM transactions t LEFT JOIN bank_rows b ON b.id = t.matched_bank_row
      WHERE t.bill_no = ${billNo} AND t.type = 'income' ORDER BY t.amount_paise`);
    expect(await sales('2610317')).toEqual([{ sale: 141000, credit: 141000 }, { sale: 300000, credit: 300000 }]);
    expect(await sales('26103120')).toEqual([{ sale: 800, credit: 800 }, { sale: 255200, credit: 255200 }]);
    const reg = async (id: string) => ({ ...(await sql`SELECT discount_paise AS d FROM register_rows WHERE id = ${id}`)[0],
      pays: (await sql`SELECT amount_paise AS p FROM register_payments WHERE register_row_id = ${id} ORDER BY amount_paise`).map((x: any) => x.p) });
    expect(await reg(a)).toEqual({ d: 0, pays: [141000, 300000] });
    expect(await reg(b)).toEqual({ d: 0, pays: [800, 255200] });
    expect((await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.slips).toEqual([]);
    // Unmatch: everything back, and the fixes are offered again.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${sa.creditId}/match`)).json.unmatched).toBe(2);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${sb.creditId}/match`)).status).toBe(200);
    expect(await reg(a)).toEqual({ d: 27000, pays: [114000, 300000] });
    expect(await reg(b)).toEqual({ d: 800, pays: [255200] });
    expect((await sales('26103120')).map((x: any) => x.sale)).toEqual([255200]);
    expect((await sales('2610317')).map((x: any) => [x.sale, x.credit])).toEqual([[114000, null], [300000, null]]);
    expect((await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.slips.map((x: any) => x.rowId).sort()).toEqual([a, b].sort());
  });

  it('credits not matched yet say why: no bill of the amount, extra money of a common amount, or a bill still without a credit (with its time)', async () => {
    const h = await hotel();
    await fullShift(h); // 2610311 ₹ 420 UPI at 9:17 am, 2610314 ₹ 1,180 UPI at 12:10 pm
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    const text = [HEAD, line(1, 'S30000091', '31/10/2026 9:18:00 AM', 420), line(2, 'S30000092', '31/10/2026 3:00:00 PM', 420), line(3, 'S30000093', '31/10/2026 4:00:00 PM', 1180),
      line(4, 'S30000094', '31/10/2026 2:00:00 PM', 777), line(5, 'S30000095', '01/11/2026 8:30:00 AM', 1234)].join('\n');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    const v = await view(h);
    const of = (paise: number) => v.json.bank.open.find((x: any) => x.amountPaise === paise);
    expect(v.json.bank.open.map((x: any) => x.amountPaise).sort((p: number, q: number) => p - q)).toEqual([42000, 77700, 118000]); // the 9:18 one paired
    expect(of(77700)).toMatchObject({ why: 'no_bill', bills: [] });
    expect(of(42000)).toMatchObject({ why: 'extra', billsOfAmount: 1, bills: [] });
    expect(of(118000)).toMatchObject({ why: 'unpaired', bills: [{ billNo: '2610314', minutes: -230 }] });
    const trial = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    expect(trial.open.credits.map((x: any) => [x.amountPaise, x.why]).sort((p: any, q: any) => p[0] - q[0])).toEqual([[42000, 'extra'], [77700, 'no_bill'], [118000, 'unpaired']]);
  });

  it('two bills and two credits that trade ₹ 1: offered as one correction, ₹ 1 tip and ₹ 1 off; on a confirmed shift both are matched and one Unmatch puts both back', async () => {
    const h = await hotel();
    await fullShift(h); // 2610311 ₹ 420 UPI at 9:17 am, 2610314 ₹ 1,180 UPI at 12:10 pm, both matching the software
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    // The bank got 419 and 1,181: ₹ 1,600 in all, as the two bills.
    const text = [HEAD, line(1, 'S30000081', '31/10/2026 9:20:00 AM', 419), line(2, 'S30000082', '31/10/2026 12:12:00 PM', 1181), line(3, 'S30000083', '01/11/2026 8:30:00 AM', 1234)].join('\n');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    const v = await view(h);
    const swap = v.json.slips.find((x: any) => x.kind === 'swap');
    const both = [swap, swap.partner].sort((x: any, y: any) => x.fromPaise - y.fromPaise);
    expect(both.map((x: any) => [x.billNo, x.fromPaise, x.creditPaise, x.after.tipPaise, x.after.discountPaise]))
      .toEqual([['2610311', 42000, 41900, 0, 100], ['2610314', 118000, 118100, 100, 0]]);
    expect(swap.key).toBe(swap.partner.key);
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31`)).json.slips).toEqual([]);
    expect((await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.slips.map((x: any) => x.key)).toContain(swap.key);

    for (const x of v.json.comparisons) {
      if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
      await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision: x.register ? 'use_register' : 'use_software', billType: 'fnb', note: 'Test' });
    }
    const done = await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(done.json.blockers ?? done.json.error ?? null).toBeNull();
    const rec = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.slips.find((x: any) => x.kind === 'swap');
    expect(rec.key).toBe(swap.key);
    const fix = (body: Record<string, unknown>) => h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${rec.creditId}/slip-fix`, { day: '2026-10-31', key: rec.key, ...body });
    expect((await fix({})).status).toBe(409); // a swap needs both credits
    expect((await fix({ partnerCreditId: rec.partner.creditId })).status).toBe(200);
    const sales = async (billNo: string) => (await sql`SELECT t.amount_paise AS sale, b.amount_paise AS credit FROM transactions t LEFT JOIN bank_rows b ON b.id = t.matched_bank_row
      WHERE t.bill_no = ${billNo} AND t.type = 'income'`);
    expect(await sales('2610311')).toEqual([{ sale: 41900, credit: 41900 }]);
    expect(await sales('2610314')).toEqual([{ sale: 118100, credit: 118100 }]);
    const reg = async (billNo: string) => (await sql`SELECT r.discount_paise AS d, r.tip_paise AS t, p.amount_paise AS p FROM register_rows r JOIN register_payments p ON p.register_row_id = r.id
      WHERE r.bill_no = ${billNo}`)[0];
    expect(await reg('2610311')).toEqual({ d: 100, t: 0, p: 41900 });
    expect(await reg('2610314')).toEqual({ d: 0, t: 100, p: 118100 });
    // Matched in one step, so one Unmatch puts both bills back.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${rec.partner.creditId}/match`)).json.unmatched).toBe(2);
    expect(await reg('2610311')).toEqual({ d: 0, t: 0, p: 42000 });
    expect(await reg('2610314')).toEqual({ d: 0, t: 0, p: 118000 });
    expect((await sales('2610314')).map((x: any) => [x.sale, x.credit])).toEqual([[118000, null]]);
  });

  it('the shift bar counts what is left on each tab; the bank counts only for people who see the bank', async () => {
    const { h } = await slipShift();
    await view(h); // builds the comparisons
    const p = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/progress`)).json;
    expect(p).toMatchObject({ toCheck: 0, status: expect.anything() });
    expect(p.rows).toBeGreaterThan(10);
    expect(p.toDecide).toBeGreaterThan(0);
    expect(p.bank).toEqual({ billsLeft: 0, creditsLeft: 4, cardsLeft: 0 }); // nothing counted before confirming; four credits inside the shift
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/progress`)).json.bank).toBeNull();
  });

  it('suggests the side the credit backs, warns of money with no bill, and matches the credits on confirm', async () => {
    const h = await hotel();
    await fullShift(h);
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI XOXO' })).status).toBe(200);
    const text = [HEAD,
      line(1, 'S30000001', '31/10/2026 1:00:00 PM', 403),   // bill 26103115: software UPI, register cash
      line(2, 'S30000002', '31/10/2026 1:10:00 PM', 4410),  // bill 2610317: software 4410, register 4140
      line(3, 'S30000003', '31/10/2026 3:00:00 PM', 777),   // no bill of this amount
      line(4, 'S30000004', '01/11/2026 8:30:00 AM', 1234)].join('\n'); // the statement reaches past the shift's end
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text })).status).toBe(200);
    let v = await view(h);
    expect(v.json.bank).toMatchObject({ covered: true });
    expect(v.json.bank.noBill.map((x: any) => x.amountPaise)).toEqual([77700]);
    expect(byBill(v, '26103115').bank).toMatchObject({ amountPaise: 40300, fits: 'both', suggest: 'use_software', minutes: 3 });
    expect(byBill(v, '2610317').bank).toMatchObject({ amountPaise: 441000, fits: 'software', suggest: 'use_software' });
    expect(byBill(v, '2610318').bank).toBeNull(); // no credit: nothing suggested
    // Nothing is decided by the bank: the person accepts.
    expect(byBill(v, '26103115').decision).toBeNull();
    for (const b of ['26103115', '2610317']) {
      expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, b).id}`, { decision: byBill(v, b).bank.suggest, note: 'Bank' })).status).toBe(200);
    }
    for (const b of ['2610318', '26103120', '26103125']) expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, b).id}`, { decision: 'use_register' })).status).toBe(200);
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`);
    expect(res.status).toBe(200);
    expect(res.json.matched).toBe(2);
    const rows = await sql`SELECT r.tran_id, r.status, m.matched_by, m.matched_at, t.bill_no, t.match_status FROM bank_rows r
      JOIN bank_matches m ON m.bank_row_id = r.id JOIN transactions t ON t.id = m.transaction_id ORDER BY r.tran_id`;
    expect(rows.map((r: any) => [r.tran_id, r.bill_no, r.status, r.match_status])).toEqual([['S30000001', '26103115', 'matched', null], ['S30000002', '2610317', 'matched', null]]);
    expect(rows[0].matched_by).toBe(h.users.accountant.id);
    expect(rows[0].matched_at).not.toBe(rows[1].matched_at);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'bank.match' AND after LIKE '%confirming the shift%'`)[0].n).toBe(2);
    // Unmatch undoes one, not both.
    const [one] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S30000001'`;
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${one.id}/match`)).status).toBe(200);
    expect((await sql`SELECT tran_id, status FROM bank_rows WHERE tran_id IN ('S30000001', 'S30000002') ORDER BY tran_id`).map((r: any) => r.status)).toEqual(['unmatched', 'matched']);
    v = await view(h);
    expect(v.json.bank).toBeNull(); // confirmed: the evidence is done
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
    // The bill box suggests the shift's software bills as you type; those not yet on the register are marked so.
    const list = u.json.softwareList as { billNo: string; amountPaise: number; used: boolean }[];
    expect(list.find((b) => b.billNo === '2610312')).toMatchObject({ amountPaise: 38000, used: false });
    expect(list.find((b) => b.billNo === '2610311')).toMatchObject({ used: true });
    const row = byNo('0312');
    await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${row.id}`, { billNo: '2610312', billType: 'fnb', amount: '380', status: 'checked', payments: [{ mode: 'cash', columnLabel: 'Cash', amount: '380' }] });
    const v = await view(h);
    expect(byBill(v, '2610312').difference).toBe('match');
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
