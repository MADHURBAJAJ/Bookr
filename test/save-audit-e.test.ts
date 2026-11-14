// Save audit E (14 Nov 2026): saving itself: what blocks it, saving twice, reopening, a saved shift's lock, History, and a
// day with no software report. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { brief, cmp, DAY, decide, income, noDoubles, saveChecked } from './saveKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const confirmPath = (bid: string, day = DAY) => `/businesses/${bid}/shifts/${day}/confirm`;

describe('E16 what blocks saving', () => {
  it('an undecided bill, a row not checked, an amount not read, a group that does not balance, a row whose payments do not add up', async () => {
    const h = await hotel();
    await h.software([['2610461', '31 10:00', 'CASH', '800'], ['2610462', '31 10:10', 'CASH', '300'], ['2610463', '31 10:20', 'CASH', '500'],
      ['2610464', '31 10:30', 'CASH', '500'], ['2610465', '31 10:40', 'CASH', '400'], ['2610466', '31 10:50', 'CASH', '250']]);
    await h.register([{ no: '2610461', amount: '750', pays: [['cash', '750']] },
      { no: '2610463', amount: '300', pays: [['cash', '500']] }, { no: '2610464', amount: '500', pays: [], paidWith: '2610463' },
      { no: '2610465', amount: '400', pays: [['cash', '300']] }]);
    const staff = h.clients.entry_staff;
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${h.rows['2610461']}`)[0].upload_id;
    const draft = await staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo: '2610462', billType: 'fnb', amount: '300', discount: '0', status: 'draft', payments: [{ mode: 'cash', amount: '300', columnLabel: 'Cash' }] });
    expect(draft.status).toBe(201);
    // An amount the reader could not read is not ticked at ₹0.
    const unread = await staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo: '2610466', billType: 'fnb', amount: '0', discount: '0', status: 'draft', payments: [] });
    await sql`UPDATE register_rows SET ocr_original = ${JSON.stringify({ engine: 'claude_vision', read: { bill_no: '2610466', amount: '2?0' }, unclear: ['amount'], inferred: [] })} WHERE id = ${unread.json.id}`;
    const tick = await staff.put(`/businesses/${h.bid}/register-rows/${unread.json.id}`, { billNo: '2610466', billType: 'fnb', amount: '0', discount: '0', status: 'checked', payments: [] });
    expect(tick.status).toBe(400);
    const res = await h.clients.accountant.post(confirmPath(h.bid));
    expect(res.status).toBe(409);
    const said = res.json.problems.join('\n');
    expect(said).toMatch(/not decided yet: bill 2610461/);
    expect(said).toMatch(/2 register rows are not checked/);
    expect(said).toMatch(/Bills 2610463, 2610464 are paid together/);
    expect(said).toMatch(/payments written for bill 2610465 do not add up/);
    expect(await income(h)).toEqual([]);
    expect((await sql`SELECT status FROM shifts WHERE business_id = ${h.bid} AND shift_day = ${DAY}`)[0].status).not.toBe('confirmed');
  });
});

describe('E17 saving twice', () => {
  it('two saves at once book once; a second save is refused; Entry staff and Viewer cannot save', async () => {
    const h = await hotel();
    await h.software([['2610471', '31 10:00', 'CASH', '500'], ['2610472', '31 11:00', 'UPI', '300']]);
    await h.register([{ no: '2610471', amount: '500', pays: [['cash', '500']] }, { no: '2610472', amount: '300', pays: [['upi', '300']] }]);
    expect((await h.clients.entry_staff.post(confirmPath(h.bid))).status).toBe(403);
    expect((await h.clients.viewer.post(confirmPath(h.bid))).status).toBe(403);
    const [a, b] = await Promise.all([h.clients.accountant.post(confirmPath(h.bid)), h.clients.owner.post(confirmPath(h.bid))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await h.clients.accountant.post(confirmPath(h.bid))).status).toBe(409);
    expect(brief(await income(h))).toEqual([['2610471', 500, 'cash', 'F&B', 'both_matched'], ['2610472', 300, 'upi', 'F&B', 'both_matched']]);
    expect(await sql`SELECT 1 FROM audit_log WHERE business_id = ${h.bid} AND action = 'shift.confirm'`).toHaveLength(1);
    await noDoubles(h);
  });
});

describe('E18 reopen, change, save again', () => {
  it('an Owner reopens with a reason; the sales go; saved again, nothing is booked twice', async () => {
    const h = await hotel();
    await h.software([['2610481', '31 10:00', 'CASH', '500'], ['2610482', '31 11:00', 'CASH', '300'], ['2610483', '31 12:00', 'CASH', '200']]);
    await h.register([{ no: '2610481', amount: '500', pays: [['cash', '500']] }, { no: '2610482', amount: '350', pays: [['cash', '350']] }]);
    await decide(h, '2610482', 'use_software');
    const first = await saveChecked(h);
    expect(brief(first.rows)).toEqual([['2610481', 500, 'cash', 'F&B', 'both_matched'], ['2610482', 300, 'cash', 'F&B', 'software'], ['2610483', 200, 'cash', 'F&B', 'software']]);
    const reopen = (c: any, b: unknown) => c.post(`/businesses/${h.bid}/shifts/${DAY}/reopen`, b);
    expect((await reopen(h.clients.accountant, { reason: 'Recount' })).status).toBe(403);
    expect((await reopen(h.clients.owner, {})).status).toBe(400);
    expect((await reopen(h.clients.owner, { reason: 'Register 2610482 was ₹300' })).json).toEqual({ removed: 3 });
    expect(await income(h)).toEqual([]);
    expect((await cmp(h, '2610482')).decision).toBe('use_software');
    // Correct the register line, and write the missing one in the register.
    const put = await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${h.rows['2610482']}`, { billNo: '2610482', billType: 'fnb', amount: '300', discount: '0', status: 'checked', payments: [{ mode: 'cash', amount: '300', columnLabel: 'Cash' }] });
    expect(put.status).toBe(200);
    await h.register([{ no: '2610483', amount: '200', pays: [['cash', '200']] }]);
    const second = await saveChecked(h);
    expect(brief(second.rows)).toEqual([['2610481', 500, 'cash', 'F&B', 'both_matched'], ['2610482', 300, 'cash', 'F&B', 'both_matched'], ['2610483', 200, 'cash', 'F&B', 'both_matched']]);
    expect(second.after.cashSalesPaise).toBe(100000);
    expect(await sql`SELECT 1 FROM audit_log WHERE business_id = ${h.bid} AND action = 'transaction.remove_on_reopen'`).toHaveLength(3);
    expect((await sql`SELECT action FROM audit_log WHERE business_id = ${h.bid} AND action LIKE 'shift.%' ORDER BY id`).map((r: any) => r.action)).toEqual(['shift.confirm', 'shift.reopen', 'shift.confirm']);
  });

  it('a shift whose sale is matched to the bank or the card machine cannot be reopened until the match is undone', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610484', '31 14:00', 'UPI', '450'], ['2610485', '31 11:30', 'CARD', '942']]);
    await h.register([{ no: '2610484', amount: '450', pays: [['upi', '450']] }, { no: '2610485', amount: '942', pays: [['card', '942']] }]);
    const [cr] = await h.credits([['31 14:02', 450], ['1 08:30', 3]]);
    const pay = await h.swipe('31 11:35', 942);
    await h.swipe('1 09:00', 1);
    const s = await saveChecked(h);
    expect(s.res).toMatchObject({ matched: 1, cardMatched: 1 });
    const owner = h.clients.owner;
    const reopen = () => owner.post(`/businesses/${h.bid}/shifts/${DAY}/reopen`, { reason: 'Recheck' });
    expect((await reopen()).status).toBe(409);
    expect((await owner.del(`/businesses/${h.bid}/bank-rows/${cr}/match`)).status).toBe(200);
    expect((await reopen()).status).toBe(409);
    expect((await owner.post(`/businesses/${h.bid}/cards/${pay}/unmatch`, {})).status).toBe(200);
    expect((await reopen()).status).toBe(200);
    // Saved again: matched again, once each.
    const again = await saveChecked(h);
    expect(again.res).toMatchObject({ matched: 1, cardMatched: 1 });
    expect(await sql`SELECT bank_row_id FROM bank_matches WHERE business_id = ${h.bid}`).toEqual([{ bank_row_id: cr }]);
    expect(await sql`SELECT settlement_id FROM card_matches WHERE business_id = ${h.bid}`).toEqual([{ settlement_id: pay }]);
    await noDoubles(h);
  });
});

describe('E19 a saved shift is locked; History', () => {
  it('no decision, register line, complimentary, Paid by, match on save or report changes it', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610491', '31 10:00', 'CASH', '800'], ['2610492', '31 11:00', 'UPI', '300']]);
    await h.register([{ no: '2610491', amount: '750', pays: [['cash', '750']] }, { no: '2610492', amount: '300', pays: [['upi', '300']] }]);
    const [cr] = await h.credits([['1 06:00', 300], ['1 08:30', 3]]);
    await decide(h, '2610491', 'use_register', { note: 'Discount on the bill' });
    await saveChecked(h);
    const acc = h.clients.accountant;
    const staff = h.clients.entry_staff;
    const c91 = await cmp(h, '2610491');
    const c92 = await cmp(h, '2610492');
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${h.rows['2610491']}`)[0].upload_id;
    const tries = {
      decide: await acc.put(`/businesses/${h.bid}/comparisons/${c91.id}`, { decision: 'use_software' }),
      addLine: await staff.post(`/businesses/${h.bid}/uploads/${page}/register-rows`, { billNo: '2610499', billType: 'fnb', amount: '100', discount: '0', status: 'checked', payments: [{ mode: 'cash', amount: '100', columnLabel: 'Cash' }] }),
      editLine: await staff.put(`/businesses/${h.bid}/register-rows/${h.rows['2610491']}`, { billNo: '2610491', billType: 'fnb', amount: '800', discount: '0', status: 'checked', payments: [{ mode: 'cash', amount: '800', columnLabel: 'Cash' }] }),
      deleteLine: await staff.del(`/businesses/${h.bid}/register-rows/${h.rows['2610491']}`, { reason: 'other' }),
      complimentary: await acc.post(`/businesses/${h.bid}/comparisons/${c91.id}/complimentary`, { guestName: 'Guest' }),
      paidBy: await acc.post(`/businesses/${h.bid}/comparisons/${c92.id}/paid-by`, { mode: 'cash' }),
      choice: await acc.post(`/businesses/${h.bid}/shifts/${DAY}/choices`, { bankRowId: cr, comparisonIds: [c92.id] }),
    };
    expect(Object.fromEntries(Object.entries(tries).map(([k, r]) => [k, r.status]))).toEqual({ decide: 409, addLine: 409, editLine: 409, deleteLine: 409, complimentary: 409, paidBy: 409, choice: 409 });
    expect((await sql`SELECT amount_paise FROM register_payments WHERE register_row_id = ${h.rows['2610491']}`)).toEqual([{ amount_paise: 75000 }]);
    expect(await sql`SELECT 1 FROM register_rows WHERE bill_no = '2610499'`).toHaveLength(0);
    expect(brief(await income(h))).toEqual([['2610491', 750, 'cash', 'F&B', 'register'], ['2610492', 300, 'upi', 'F&B', 'both_matched']]);
    // History of the bill: the decision, with who and the note.
    const hist = (await acc.get(`/businesses/${h.bid}/bills/2610491?day=${DAY}`)).json.history;
    expect(hist.map((x: any) => x.action)).toContain('comparison.decide');
  });

  // GAP (save audit, 14 Nov 2026): a bill's History does not say that its sale was removed when the shift was reopened.
  // reopenShift logs 'transaction.remove_on_reopen' on the removed sale's id, and the History query only looks at the
  // bill's current sales, so the step is lost from the bill's History.
  it('the bill\'s History shows its sale removed on reopen', async () => {
    const h = await hotel();
    await h.software([['2610493', '31 10:00', 'CASH', '800']]);
    await h.register([{ no: '2610493', amount: '800', pays: [['cash', '800']] }]);
    await saveChecked(h);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/shifts/${DAY}/reopen`, { reason: 'Recheck' })).status).toBe(200);
    await h.confirm();
    const hist = (await h.clients.accountant.get(`/businesses/${h.bid}/bills/2610493?day=${DAY}`)).json.history;
    expect(hist.map((x: any) => x.action)).toContain('transaction.remove_on_reopen');
  });
});

describe('E20 a day with no software report', () => {
  it('a register-only day cannot be saved, and says why', async () => {
    const h = await hotel();
    await h.register([{ no: '2610501', amount: '500', pays: [['cash', '500']] }]);
    const v = await h.view();
    expect(v.json.canConfirm).toBe(false);
    expect(v.json.blockers.join(' ')).toMatch(/No software report has bills in this shift yet/);
    const res = await h.clients.accountant.post(confirmPath(h.bid));
    expect(res.status).toBe(409);
    expect(await income(h)).toEqual([]);
  });
});
