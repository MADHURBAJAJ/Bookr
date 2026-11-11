// Phase 2 through the API, part 5 of 5 (helpers in phase2-shared.ts). Invented data only (demo/sample-data.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, Client, sql, resetDb, uploads } from './helpers';
import { buildSalesCsv, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';
import { byBill, DAY_END, DAY_START, decideAll, fullShift, hotel, png, PNG, todayIst, view } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
// A full shift is ~20 API calls with many queries each; the local D1 proxy is slow per query.
vi.setConfig({ testTimeout: 180_000 });

describe('the card machine as a witness (approved 9 Nov 2026)', () => {
  it('a card bill the machine never got, paid by UPI: changed to UPI and matched; a machine payment of a UPI bill: changed to card; both undo', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    await fullShift(h);
    await decideAll(h);
    expect((await o.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const sale = async (bill: string) => (await sql`SELECT id FROM transactions WHERE bill_no = ${bill} AND type = 'income'`)[0].id as string;
    const card = await sale('2610313');   // ₹942, card, 11:30:45: the machine has no payment for it
    const upi = await sale('2610318');    // ₹650, UPI, 15:20: paid on the machine
    // The card report, covering past the shift: a UPI-on-machine payment of ₹650 two minutes after bill 2610318, and a swipe the next morning.
    const swipe = async (id: string, at: number, amount: number, scheme: string) => {
      await sql`INSERT INTO card_settlements (id, business_id, file_name, settled_on, merchant_id, terminal_id, txn_id, paid_at, txn_type, amount_paise, fee_paise, gst_paise,
        net_paise, scheme, card_last4, created_at) VALUES (${id}, ${h.bid}, 'x_ICICI_POS_CD.xlsx', '2026-11-02', '900000000000001', 'TT000001', ${'TT_' + id}, ${at}, 'PURCHASE',
        ${amount}, 0, 0, ${amount}, ${scheme}, ${scheme === 'UPI' ? null : '4242'}, ${Date.now()})`;
      return id;
    };
    const p650 = await swipe(crypto.randomUUID(), istToMs(2026, 10, 31, 15, 22, 0), 65000, 'UPI');
    await swipe(crypto.randomUUID(), istToMs(2026, 11, 1, 9, 0, 0), 10000, 'VISA');
    // The bank, in past the shift: a UPI credit of ₹942 ten minutes after bill 2610313.
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' });
    await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t'),
      [1, 'S80000001', '31/10/2026', '31/10/2026 11:40:00 AM', '-', 'UPI/900000000041/UPI/xx41@okaxis/B/ICIa', 'CR', 942, 1].join('\t'),
      [2, 'S80000002', '01/11/2026', '01/11/2026 9:30:00 AM', '-', 'UPI/900000000042/UPI/xx42@okaxis/B/ICIa', 'CR', 3, 1].join('\t')].join('\n') });
    const [cr] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S80000001'`;

    const rec = (await o.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json;
    expect(rec.cards.covered).toBe(true);
    expect(rec.cards.bankCovered).toBe(true);
    expect(rec.cards.strip).toMatchObject({ machineUpiPaise: 65000, machineCardPaise: 0 });
    const ns = rec.cards.noSwipe.find((x: any) => x.billNo === '2610313');
    expect(ns.upi).toMatchObject({ creditId: cr.id, amountPaise: 94200, accountName: 'HUF', minutes: 9 });
    const nd = rec.cards.needs.find((x: any) => x.payment.id === p650);
    expect(nd).toMatchObject({ why: 'written', payment: { upi: true, label: 'UPI on machine' }, written: { transactionId: upi, billNo: '2610318', mode: 'upi', minutes: 2 } });
    // Told once: the UPI side leaves out the ₹942 credit and bill 2610318.
    expect(rec.cards.explains).toEqual({ credits: [{ id: cr.id, postedAt: expect.any(Number) }], bills: [{ id: upi, billNo: '2610318', shiftDay: '2026-10-31' }] });
    expect(rec.noBill.map((x: any) => x.creditId)).not.toContain(cr.id);

    // Change to UPI and match: a person does it (Owner or Accountant), and it undoes in two steps.
    const base = `/businesses/${h.bid}/cards`;
    expect((await h.clients.entry_staff.post(`${base}/was-upi`, { transactionIds: [card], bankRowId: cr.id })).status).toBe(403);
    expect((await o.post(`${base}/was-upi`, { transactionIds: [upi], bankRowId: cr.id })).status).toBe(409);   // not a card bill
    const w = (await h.clients.accountant.post(`${base}/was-upi`, { transactionIds: [card], bankRowId: cr.id })).json;
    expect(w).toMatchObject({ ok: true, bills: ['2610313'] });
    expect((await sql`SELECT payment_mode, match_status, matched_bank_row FROM transactions WHERE id = ${card}`)[0]).toEqual({ payment_mode: 'upi', match_status: null, matched_bank_row: cr.id });
    expect((await sql`SELECT p.mode FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.bill_no = '2610313'`)[0].mode).toBe('upi');
    expect((await o.post(`${base}/was-upi`, { transactionIds: [card], bankRowId: cr.id })).status).toBe(409);
    expect((await o.del(`/businesses/${h.bid}/bank-rows/${cr.id}/match`)).status).toBe(200);
    expect((await o.post(`/businesses/${h.bid}/sales/repay/${w.auditId}/undo`, {})).status).toBe(200);
    expect((await sql`SELECT payment_mode, match_status, matched_bank_row FROM transactions WHERE id = ${card}`)[0]).toEqual({ payment_mode: 'card', match_status: 'awaiting_card_settlement', matched_bank_row: null });

    // UPI on the machine (approved 11 Nov 2026): card machine money is a card sale, so bill 2610318 is changed to card and
    // matched to the machine payment, in one recorded step. Unmatch and Undo put it back to waiting for its UPI money.
    expect((await o.post(`${base}/${p650}/was-card`, { transactionIds: [upi] })).status).toBe(409);   // UPI on the machine: use upi-on-machine
    expect((await o.post(`${base}/${p650}/upi-on-machine`, { transactionIds: [card] })).status).toBe(409); // a card bill
    const c2 = (await o.post(`${base}/${p650}/upi-on-machine`, { transactionIds: [upi] })).json;
    expect(c2).toMatchObject({ ok: true, bills: ['2610318'], auditId: expect.any(Number) });
    expect((await sql`SELECT payment_mode, match_status FROM transactions WHERE id = ${upi}`)[0]).toEqual({ payment_mode: 'card', match_status: null });
    expect((await sql`SELECT p.mode FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id WHERE r.bill_no = '2610318'`)[0].mode).toBe('card');
    expect((await sql`SELECT transaction_id FROM card_matches WHERE settlement_id = ${p650}`).map((r) => r.transaction_id)).toEqual([upi]);
    const after = (await o.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.cards;
    expect(after.needs.find((x: any) => x.payment.id === p650)).toBeUndefined();
    expect((await o.post(`${base}/${p650}/unmatch`)).status).toBe(200);
    expect((await o.post(`/businesses/${h.bid}/sales/repay/${c2.auditId}/undo`, {})).status).toBe(200);
    expect((await sql`SELECT payment_mode, match_status FROM transactions WHERE id = ${upi}`)[0]).toEqual({ payment_mode: 'upi', match_status: 'awaiting_bank_match' });
  });

  it('a card bill paid in two machine payments is offered as one pair', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    await fullShift(h);
    await decideAll(h);
    expect((await o.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const ins = async (at: number, amount: number) => {
      const id = crypto.randomUUID();
      await sql`INSERT INTO card_settlements (id, business_id, file_name, settled_on, merchant_id, terminal_id, txn_id, paid_at, txn_type, amount_paise, fee_paise, gst_paise,
        net_paise, scheme, created_at) VALUES (${id}, ${h.bid}, 'x', '2026-11-02', 'M', 'TT000001', ${'TT_' + id}, ${at}, 'PURCHASE', ${amount}, 0, 0, ${amount}, 'VISA', ${Date.now()})`;
      return id;
    };
    const a = await ins(istToMs(2026, 10, 31, 11, 31, 0), 50000);
    const b = await ins(istToMs(2026, 10, 31, 11, 32, 0), 44200);
    await ins(istToMs(2026, 11, 1, 9, 0, 0), 100);
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' });
    await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t'),
      [1, 'S80000002', '01/11/2026', '01/11/2026 9:30:00 AM', '-', 'UPI/900000000042/UPI/xx42@okaxis/B/ICIa', 'CR', 3, 1].join('\t')].join('\n') });
    const k = (await o.get(`/businesses/${h.bid}/shifts/2026-10-31/reconcile`)).json.cards;
    const ns = k.noSwipe.find((x: any) => x.billNo === '2610313');
    expect(ns.parts).toMatchObject({ credit: null });
    expect([...ns.parts.paymentIds].sort()).toEqual([a, b].sort());
    // The two payments are told on the bill, not again on their own.
    expect(k.needs.map((n: any) => n.payment.id)).not.toContain(a);
    const card = (await sql`SELECT id FROM transactions WHERE bill_no = '2610313' AND type = 'income'`)[0].id;
    expect((await o.post(`/businesses/${h.bid}/cards/match`, { sets: [{ paymentIds: [a, b], transactionIds: [card] }] })).json).toMatchObject({ matched: 1, problems: [] });
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${card}`)[0].match_status).toBeNull();
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
    // A bill with no payment cannot be ticked, so it is a draft.
    const add = (billNo: string, amount: string, payments: unknown[], discount = '0') =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo, billType: 'fnb', amount, discount, payments, status: payments.length ? 'checked' : 'draft' });
    await add('1', '230', [{ mode: 'card', amount: '219' }]);          // fills 11
    await add('2', '10899', [{ mode: 'upi', amount: '10500' }]);       // fills 399
    await add('3', '179', [{ mode: 'upi', amount: '188' }]);           // paid more: a tip of 9
    await add('4', '100', []);                                          // nothing paid: left alone
    await add('5', '500', [{ mode: 'cash', amount: '450' }], '30');    // has a discount: left alone
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/fill-discounts`);
    expect(res.json.filled).toBe(3);
    const rows = await sql`SELECT bill_no, discount_paise, tip_paise, status FROM register_rows WHERE upload_id = ${page} ORDER BY bill_no`;
    expect(rows.map((r) => [r.bill_no, r.discount_paise, r.tip_paise])).toEqual([['1', 1100, 0], ['2', 39900, 0], ['3', 0, 900], ['4', 0, 0], ['5', 3000, 0]]);
    expect(rows.map((r) => r.status)).toEqual(['checked', 'checked', 'checked', 'draft', 'checked']);
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
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.decision_cleared' AND json_extract(before, '$.decided_by') IS NOT NULL`)[0].n).toBe(1);
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
    expect(k.notInRegister).toEqual([{ id: expect.any(String), billNo: '2610319', amountPaise: 35300, decision: 'use_software', billType: 'fnb', note: 'Added to the register from the software report' }]);
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

describe('bills on one side only are decided by Bookr (approved 3 Nov 2026)', () => {
  const NOV1 = '2026-11-01';
  it('a software-only bill is counted as F&B and waits; a cash one is flagged on its day; the other side later is "already counted"', async () => {
    const h = await hotel();
    await fullShift(h);
    let v = await view(h);
    expect(byBill(v, '2610319')).toMatchObject({ decision: 'use_software', billType: 'fnb', auto: true }); // cash 353, software only
    // Cash 500, register only, and running number 25 is past the date's last bill (24): a person checks it.
    expect(byBill(v, '26103125').decision ?? null).toBeNull();
    expect(byBill(v, '26103125').numberFlags).toEqual([expect.objectContaining({ kind: 'beyond_range', seq: 25, max: 24, date: '2026-10-31' })]);
    expect(v.json.warnings.map((w: any) => w.billNo)).toEqual(['2610319']);
    expect((await sql`SELECT user_id FROM audit_log WHERE action = 'comparison.decide' AND after LIKE '%"auto":true%' LIMIT 1`)[0].user_id).toBeNull();
    // The register side of 2610319 turns up on 1 Nov: already counted on 31 Oct, so not counted (or matched to the bank) again.
    const page = await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=${NOV1}`, png(7), 'image/png');
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page.json.id}/register-rows`,
      { billNo: '2610319', billType: 'fnb', amount: '353', status: 'checked', payments: [{ mode: 'cash', columnLabel: null, amount: '353' }] })).status).toBe(201);
    const late = byBill(await view(h, NOV1), '2610319');
    expect(late).toMatchObject({ decision: 'leave_out', auto: true, linkedToId: byBill(v, '2610319').id });
    expect(late.note).toMatch(/Already counted on 2026-10-31/);
    const waiting = (await h.clients.owner.get(`/businesses/${h.bid}/waiting-bills`)).json.bills.map((b: any) => b.billNo);
    expect(waiting).not.toContain('2610319');
    // A person can still change it.
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, '2610319').id}`, { decision: 'leave_out', note: 'Cancelled in POS' })).status).toBe(200);
    v = await view(h);
    expect(byBill(v, '2610319')).toMatchObject({ decision: 'leave_out', auto: false });
  });

  it('a UPI bill on one side only is not counted until its bank credit is matched, then counted on the credit\'s shift', async () => {
    const h = await hotel();
    const page = await fullShift(h);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`,
      { billNo: '2610315', billType: 'fnb', amount: '840', status: 'checked', payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '840' }] })).status).toBe(201);
    await decideAll(h);
    expect(byBill(await view(h), '2610315')).toMatchObject({ decision: 'use_register', auto: true });
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const [t] = await sql`SELECT id, status, day, ocr_original FROM transactions WHERE bill_no = '2610315'`;
    expect(t).toMatchObject({ status: 'reviewed', day: '2026-10-31' });
    expect(JSON.parse(t.ocr_original).countOnCredit).toBe(true);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE shift_day = '2026-10-31' AND status = 'reviewed'`)[0].n).toBe(1); // only that one
    const credit = (await h.clients.owner.get(`/businesses/${h.bid}/awaiting-credit`)).json.sales;
    expect(credit.find((x: any) => x.billNo === '2610315')).toMatchObject({ onCredit: true, day: '2026-10-31' });
    // The credit arrives on 2 Nov at 9:15 am: the 2 Nov shift.
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' })).status).toBe(200);
    const line = ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t')
      + '\n' + [1, 'S20000001', '02/11/2026', '02/11/2026 9:15:00 AM', '-', 'UPI/600000000009/Dinner/ab-1@okicici/SAMPLE BANK/ICIaaaa', 'CR', 840, '840'].join('\t');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: line })).status).toBe(200);
    const [row] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S20000001'`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${row.id}/match`, { transactionIds: [t.id] })).status).toBe(200);
    expect((await sql`SELECT status, day, shift_day FROM transactions WHERE id = ${t.id}`)[0]).toEqual({ status: 'approved', day: '2026-11-02', shift_day: '2026-10-31' });
    // Unmatched again: back to waiting, on its own shift.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${row.id}/match`)).status).toBe(200);
    expect((await sql`SELECT status, day FROM transactions WHERE id = ${t.id}`)[0]).toEqual({ status: 'reviewed', day: '2026-10-31' });
  });
});

describe('large discounts need no decision; they are listed on Reports (approved 7 Nov 2026)', () => {
  const setup = async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122'].includes(r.billNo));
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    return { h, pageId, add };
  };

  it('a 37% discount on bills paid together matches on the total, and shows on the report', async () => {
    const { h, pageId, add } = await setup();
    // 420 + 1180 + 780 = 2,380 of bills, 1,500 paid: 880 discount (37%).
    const head = (await add('2610311', '420', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '1500' }])).json.id;
    await add('2610314', '1180', [], { paidWithRowId: head });
    await add('26103122', '780', [], { paidWithRowId: head });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/fill-discounts`)).json.filled).toBe(1);
    const v = await view(h);
    for (const b of ['2610311', '2610314', '26103122']) expect(byBill(v, b).difference).toBe('match');
    expect(v.json.paidGroups).toEqual([expect.objectContaining({ id: head, softwarePaise: 238000, grossPaise: 238000, paidPaise: 150000, modes: ['upi'], matched: true, why: null })]);
    const r = await h.clients.viewer.get(`/businesses/${h.bid}/reports/large-discounts?from=2026-10-31&to=2026-10-31`);
    expect(r.json.lines).toEqual([expect.objectContaining({ day: '2026-10-31', billNos: ['2610311', '2610314', '26103122'], billsPaise: 238000, discountPaise: 88000, pct: 37, paidPaise: 150000, modes: ['upi'], softwarePaise: 238000 })]);
    await decideAll(h);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    // The software has no discount, so the register's figures are booked: the sales add up to what was paid.
    const sales = await sql`SELECT bill_no, amount_paise FROM transactions WHERE bill_no IN ('2610311', '2610314', '26103122') AND type = 'income' ORDER BY bill_no`;
    expect(sales).toEqual([{ bill_no: '26103122', amount_paise: 78000 }, { bill_no: '2610314', amount_paise: 72000 }]);
  });

  it('a large discount on one bill matches when the software shows the bill before it; a small one stays off the report', async () => {
    const { h, add } = await setup();
    await add('2610311', '420', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '300' }], { discount: '120' });
    await add('2610314', '1180', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '1170' }], { discount: '10' });
    const v = await view(h);
    expect(byBill(v, '2610311').difference).toBe('match');
    expect(byBill(v, '2610311').largeDiscount).toBeUndefined();
    const r = await h.clients.owner.get(`/businesses/${h.bid}/reports/large-discounts?from=2026-10-31&to=2026-10-31`);
    expect(r.json.lines.map((l: any) => l.billNos)).toEqual([['2610311']]);
  });

  it('only those who can see reports get the report', async () => {
    const { h } = await setup();
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/reports/large-discounts`)).status).toBe(403);
    expect((await h.clients.accountant.get(`/businesses/${h.bid}/reports/large-discounts`)).status).toBe(200);
  });
});

describe('hand match that changes the bills (bank received a different amount)', () => {
  it('discount spread over a confirmed group: register, payment and income change, recorded; unmatch puts them back; lock holds otherwise', async () => {
    const h = await hotel();
    const reg = REGISTER_31_OCT.filter((r) => !['2610311', '2610314', '26103122'].includes(r.billNo));
    const pageId = await fullShift(h, reg);
    const add = (billNo: string, amount: string, payments: unknown[], extra: Record<string, unknown> = {}) =>
      h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo, billType: 'fnb', amount, payments, status: 'checked', ...extra });
    const head = (await add('2610311', '420', [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '2380' }])).json.id;
    await add('2610314', '1180', [], { paidWithRowId: head });
    await add('26103122', '780', [], { paidWithRowId: head });
    await decideAll(h);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const tx = await sql`SELECT id, amount_paise FROM transactions WHERE bill_no IN ('2610311', '2610314', '26103122') AND type = 'income'`;
    expect(tx.reduce((t, x) => t + x.amount_paise, 0)).toBe(238000);

    // The bank shows 2,330 for that payment: 50 less (the register had a typo).
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    const line = ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t') + '\n'
      + [1, 'S40000001', '31/10/2026', '31/10/2026 9:20:00 AM', '-', 'UPI/900000000001/UPI/xxa@okaxis/B/ICIa', 'CR', 2330, 1].join('\t');
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: line });
    const [row] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S40000001'`;
    const ids = tx.map((x) => x.id);
    // Part of a group only: refused.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: [row.id], transactionIds: ids.slice(0, 1), treat: 'bills', note: 'typo' })).status).toBe(400);
    const r = await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: [row.id], transactionIds: ids, treat: 'bills', note: 'register typo 2380 for 2330' });
    expect(r.status).toBe(200);
    const regs = await sql`SELECT bill_no, discount_paise, tip_paise FROM register_rows WHERE bill_no IN ('2610311', '2610314', '26103122')`;
    expect(regs.reduce((t, x) => t + x.discount_paise, 0)).toBe(5000);
    expect((await sql`SELECT amount_paise FROM register_payments WHERE register_row_id = ${head}`)[0].amount_paise).toBe(233000);
    expect((await sql`SELECT sum(amount_paise) AS s FROM transactions WHERE id IN (${ids[0]}, ${ids[1]}, ${ids[2]})`)[0].s).toBe(233000);
    expect((await sql`SELECT count(*) AS n FROM register_bank_adjustments WHERE bank_row_id = ${row.id}`)[0].n).toBeGreaterThanOrEqual(10);
    expect((await sql`SELECT status FROM shifts WHERE shift_day = '2026-10-31'`)[0].status).toBe('confirmed');
    // The lock still holds for anything else.
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${head}`, { billNo: '2610311', billType: 'fnb', amount: '421', payments: [{ mode: 'upi', amount: '2330' }] })).status).toBe(409);
    await expect(sql`UPDATE register_rows SET discount_paise = 1 WHERE id = ${head}`).rejects.toThrow(/shift_confirmed/);
    // Unmatch: everything back as it was.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${row.id}/match`)).status).toBe(200);
    expect((await sql`SELECT sum(discount_paise) AS d, sum(tip_paise) AS t FROM register_rows WHERE bill_no IN ('2610311', '2610314', '26103122')`)[0]).toEqual({ d: 0, t: 0 });
    expect((await sql`SELECT amount_paise FROM register_payments WHERE register_row_id = ${head}`)[0].amount_paise).toBe(238000);
    expect((await sql`SELECT sum(amount_paise) AS s FROM transactions WHERE id IN (${ids[0]}, ${ids[1]}, ${ids[2]})`)[0].s).toBe(238000);
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

describe('bank credit equal to the bill amount when the register shows a tip', () => {
  it('is suggested, highlighted as a correction, and matching removes the tip from the register', async () => {
    const h = await hotel();
    const pageId = await fullShift(h);
    // Bill 907, payment written as 920, so a 13 tip was filled in. The bank received 907.
    const row = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pageId}/register-rows`, { billNo: 'T907', billType: 'fnb', amount: '907', discount: '-13', status: 'checked',
      payments: [{ mode: 'upi', columnLabel: 'UPI Bank 2', amount: '920' }] })).json.id;
    await decideAll(h);
    const v = await view(h);
    await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, 'T907').id}`, { decision: 'use_register' });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/2026-10-31/confirm`)).status).toBe(200);
    const acc = (await h.clients.owner.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    await h.clients.owner.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' });
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [
      ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t'),
      [1, 'S70000001', '31/10/2026', '31/10/2026 1:37:00 PM', '-', 'UPI/900000000031/UPI/xx95@axl/B/AXLa', 'CR', 907, 1].join('\t')].join('\n') });
    const rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-10-31`)).json.rows;
    const cr = rows.find((r: any) => r.tranId === 'S70000001');
    const k = cr.candidates.find((x: any) => x.billNos[0] === 'T907');
    expect(k).toMatchObject({ amountPaise: 90700, adjust: { receivedPaise: 92000, billPaise: 90700 } });
    const m = (await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-many`, { pairs: [{ rowId: cr.id, transactionIds: k.transactionIds, adjust: true }] })).json;
    expect(m).toMatchObject({ matched: 1, skipped: [] });
    expect((await sql`SELECT tip_paise, discount_paise FROM register_rows WHERE id = ${row}`)[0]).toEqual({ tip_paise: 0, discount_paise: 0 });
    expect((await sql`SELECT amount_paise FROM register_payments WHERE register_row_id = ${row}`)[0].amount_paise).toBe(90700);
    expect((await sql`SELECT amount_paise, match_status FROM transactions WHERE bill_no = 'T907' AND type = 'income'`)[0]).toEqual({ amount_paise: 90700, match_status: null });
    // Unmatch puts the register back.
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${cr.id}/match`)).status).toBe(200);
    expect((await sql`SELECT tip_paise FROM register_rows WHERE id = ${row}`)[0].tip_paise).toBe(1300);
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

describe('bills paid together across register pages', () => {
  it('a bill on page 2 can be paid with a row on page 1 of the same shift; Review and Fill see the whole group', async () => {
    const h = await hotel();
    const page = async (n: number) => (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(n), 'image/png')).json.id;
    const p1 = await page(97);
    const p2 = await page(98);
    const head = (await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${p1}/register-rows`,
      { billNo: '9001', billType: 'fnb', amount: '600', payments: [{ mode: 'upi', columnLabel: null, amount: '1000' }] })).json.id;
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${p2}/register-rows`,
      { billNo: '9002', billType: 'fnb', amount: '500', payments: [], paidWithRowId: head });
    expect(res.status).toBe(201);
    const d2 = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${p2}`)).json;
    expect(d2.pageNo).toBe(2);
    expect(d2.otherPageRows).toEqual([expect.objectContaining({ id: head, pageNo: 1, uploadId: p1, amountPaise: 60000, billType: 'fnb', status: 'draft', remarks: null, payments: [expect.objectContaining({ amountPaise: 100000 })] })]);
    // 600 + 500 = 1,100 against 1,000 paid: Fill on page 2 writes the 100 discount on the paying row on page 1.
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${p2}/fill-discounts`)).json.filled).toBe(1);
    const rows = await sql`SELECT discount_paise FROM register_rows WHERE id IN (${head}, ${res.json.id})`;
    expect(rows.reduce((t, r) => t + r.discount_paise, 0)).toBe(10000);
  });
});
