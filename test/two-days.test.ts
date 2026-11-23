// One bill on two days' registers (approved 23 Nov 2026): part paid, an advance, written twice, paid later in cash, or a
// wrong number. The software never prints a number twice, so the two lines are one bill. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';
import { twoDayKind, type TwoDayHome } from '../src/twoDays';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const home = (day: string, sw: number, swMode: string, pays: { mode: string; amountPaise: number }[]): TwoDayHome => ({
  day, comparisonId: 'c', decision: null, confirmed: false, swAmountPaise: sw, swMode, paidAt: null,
  line: { rowId: 'r', uploadId: 'u', lineNo: 1, amountPaise: sw, discountPaise: 0, pays, status: 'checked' },
});
const count = async (bid: string, day: string, rupees: number) => {
  const [u] = await sql`SELECT id FROM uploads WHERE business_id = ${bid} AND id NOT IN (SELECT upload_id FROM cash_summaries) LIMIT 1`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, opening_paise, received_paise, expenses_paise, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${u.id}, ${day}, ${null}, ${null}, ${null}, ${rupees * 100}, 'approved', ${Date.now()})`;
};
const cash = (r: number) => [{ mode: 'cash', amountPaise: r * 100 }];
const upi = (r: number) => [{ mode: 'upi', amountPaise: r * 100 }];

describe('which of the five it is', () => {
  it('reads the two lines against the software bill', () => {
    // ₹730 one day + ₹950 the next, ₹3 off, bill ₹1,683.
    expect(twoDayKind({ day: '2026-11-11', pays: cash(730) }, home('2026-11-12', 168300, 'cash', cash(950)), [])).toBe('part_paid');
    // The whole bill paid the day before; its own day wrote nothing paid.
    expect(twoDayKind({ day: '2026-11-11', pays: cash(500) }, home('2026-11-12', 50000, 'cash', []), [])).toBe('advance');
    // Written UPI on its day, software cash, cash on a later day.
    expect(twoDayKind({ day: '2026-11-03', pays: cash(210) }, home('2026-10-31', 20900, 'cash', upi(210)), [])).toBe('paid_later_cash');
    // The same UPI payment on both days, and no money of its own here.
    expect(twoDayKind({ day: '2026-11-11', pays: upi(230) }, home('2026-11-10', 23000, 'upi', upi(230)), [])).toBe('written_twice');
    // … unless this shift has a ₹230 credit no bill explains.
    expect(twoDayKind({ day: '2026-11-11', pays: upi(230) }, home('2026-11-10', 23000, 'upi', upi(230)), [{ id: 'x', postedAt: 0, amountPaise: 23000 }])).toBe('wrong_number');
    // Nothing paid on the copy.
    expect(twoDayKind({ day: '2026-11-11', pays: [] }, home('2026-11-10', 23000, 'upi', upi(230)), [])).toBe('written_twice');
  });
});

describe('one bill on two days', () => {
  it('part paid: the first day joins the bill as an advance, the drawer moves, and Undo puts it back', async () => {
    const h = await hotel();
    await h.software([['2611011', '1 10:00', 'CASH', '1683'], ['2610311', '31 12:00', 'CASH', '100']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610311', amount: '100', pays: [['cash', '100']] }, { no: '2611011', amount: '730', pays: [['cash', '730']] }]);
    const copyRow = h.rows['2611011'];
    await h.register([{ no: '2611011', amount: '1683', discount: '733', pays: [['cash', '950']], day: '2026-11-01' }]);
    const homeRow = h.rows['2611011'];
    await h.view('2026-11-01');
    await h.view('2026-10-31');
    const cmp = async (row: string) => (await sql`SELECT id, decision, note, linked_to_id, difference FROM bill_comparisons WHERE register_row_id = ${row}`)[0];
    // Never counted by itself on 31 Oct: a person says what it is.
    expect((await cmp(copyRow)).decision).toBeNull();

    const base = `/businesses/${h.bid}`;
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${copyRow}`)[0].upload_id;
    let line = (await h.clients.entry_staff.get(`${base}/uploads/${page}`)).json.rows.find((r: any) => r.id === copyRow);
    expect(line.twoDays).toMatchObject({ kind: 'part_paid', done: null, herePaidPaise: 73000, home: { day: '2026-11-01', paidPaise: 95000, swAmountPaise: 168300, pageNo: 1 } });
    expect(line.numberFlags).toEqual([]);

    // Entry staff cannot decide; the accountant can.
    expect((await h.clients.entry_staff.post(`${base}/register-rows/${copyRow}/two-days`, { action: 'advance' })).status).toBe(403);
    expect((await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days`, { action: 'settle' })).status).toBe(409);
    const res = await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days`, { action: 'advance' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const pays = await sql`SELECT mode, amount_paise FROM register_payments WHERE register_row_id = ${homeRow} ORDER BY amount_paise`;
    expect(pays.map((p: any) => p.amount_paise)).toEqual([73000, 95000]);
    expect((await sql`SELECT discount_paise FROM register_rows WHERE id = ${homeRow}`)[0].discount_paise).toBe(300);
    const c = await cmp(copyRow);
    expect(c).toMatchObject({ decision: 'leave_out', note: 'Part of 2611011: counted on 2026-11-01' });
    expect(c.linked_to_id).toBe((await cmp(homeRow)).id);
    expect((await cmp(homeRow)).difference).toBe('match');
    const late = await sql`SELECT after FROM audit_log WHERE action = 'cash.paid_late' AND business_id = ${h.bid}`;
    expect(JSON.parse(late[0].after)).toMatchObject({ day: '2026-10-31', fromDay: '2026-11-01', amountPaise: 73000 });

    line = (await h.clients.entry_staff.get(`${base}/uploads/${page}`)).json.rows.find((r: any) => r.id === copyRow);
    expect(line.twoDays.done).toBe('advance');
    const homePage = (await sql`SELECT upload_id FROM register_rows WHERE id = ${homeRow}`)[0].upload_id;
    const hl = (await h.clients.entry_staff.get(`${base}/uploads/${homePage}`)).json.rows.find((r: any) => r.id === homeRow);
    expect(hl.paidOtherDay).toEqual([{ day: '2026-10-31', amountPaise: 73000 }]);

    expect((await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days/undo`, {})).status).toBe(200);
    expect((await sql`SELECT amount_paise FROM register_payments WHERE register_row_id = ${homeRow}`).map((p: any) => p.amount_paise)).toEqual([95000]);
    expect((await sql`SELECT discount_paise FROM register_rows WHERE id = ${homeRow}`)[0].discount_paise).toBe(73300);
    expect((await cmp(copyRow)).decision).toBeNull();
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'cash.paid_late_undone' AND business_id = ${h.bid}`)[0].n).toBe(1);
    expect((await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days/undo`, {})).status).toBe(404);
  });

  it('paid later in cash settles the earlier bill, never a second sale; a confirmed day must be reopened first', async () => {
    const h = await hotel();
    await h.software([['2610312', '31 21:00', 'CASH', '209'], ['2611012', '1 10:00', 'CASH', '50']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610312', amount: '210', pays: [['upi', '210']] }]);
    await h.register([{ no: '2611012', amount: '50', pays: [['cash', '50']], day: '2026-11-01' }, { no: '2610312', amount: '210', pays: [['cash', '210']], day: '2026-11-01' }]);
    const copyRow = h.rows['2610312'];
    await h.view('2026-10-31');
    await h.decideRest('2026-10-31', (c: any) => (c.billNo === '2610312' ? 'use_software' : undefined));
    await h.view('2026-11-01');
    expect((await sql`SELECT decision FROM bill_comparisons WHERE register_row_id = ${copyRow}`)[0].decision).toBeNull();
    const base = `/businesses/${h.bid}`;
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${copyRow}`)[0].upload_id;
    const line = (await h.clients.entry_staff.get(`${base}/uploads/${page}`)).json.rows.find((r: any) => r.id === copyRow);
    expect(line.twoDays).toMatchObject({ kind: 'paid_later_cash', hereMode: 'cash', home: { day: '2026-10-31', mode: 'upi', swMode: 'cash' } });
    // The Reconcile line says which day it belongs to, with no typo arrow.
    const v = (await h.view('2026-11-01')).json.comparisons.find((c: any) => c.billNo === '2610312');
    expect(v.onDay).toMatchObject({ day: '2026-10-31', kind: 'paid_later_cash' });
    expect(v.numberFlags).toEqual([]);

    // The bill's own day stays saved: settling changes only this day.
    await h.confirm('2026-10-31');
    // Written UPI, counted as cash, no credit, and the 31 Oct drawer short: a payment not received (23 Nov 2026).
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1000);
    const waiting = async () => (await h.clients.accountant.get(`${base}/reports/pending?from=2026-10-25&to=2026-11-05`)).json.toReceive;
    expect((await waiting()).find((x: any) => x.billNo === '2610312')).toMatchObject({ day: '2026-10-31', mode: 'cash', amountPaise: 20900, group: 'not_received',
      reason: 'Register UPI ₹ 210.00, no credit · counted as cash · explains ₹ 209.00 of ₹ 209.00 short' });
    const res = await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days`, { action: 'settle' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await sql`SELECT decision, note FROM bill_comparisons WHERE register_row_id = ${copyRow}`)[0]).toMatchObject({ decision: 'leave_out', note: 'Paid now: 2026-10-31 bill 2610312' });
    // The 31 Oct drawer no longer waits for it.
    expect((await waiting()).find((x: any) => x.billNo === '2610312')).toBeUndefined();
    const late = await sql`SELECT after FROM audit_log WHERE action = 'cash.paid_late' AND business_id = ${h.bid}`;
    expect(JSON.parse(late[0].after)).toMatchObject({ day: '2026-11-01', fromDay: '2026-10-31', amountPaise: 21000 });
  });

  it('written twice, or a wrong number when this shift has a credit no bill explains', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610313', '31 22:00', 'UPI', '230'], ['2611015', '1 12:00', 'UPI', '230']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610313', amount: '230', pays: [['upi', '230']] }]);
    await h.register([{ no: '2610313', amount: '230', pays: [['upi', '230']], day: '2026-11-01' }]);
    const copyRow = h.rows['2610313'];
    await h.view('2026-10-31');
    await h.view('2026-11-01');
    const base = `/businesses/${h.bid}`;
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${copyRow}`)[0].upload_id;
    const get = async () => (await h.clients.entry_staff.get(`${base}/uploads/${page}`)).json.rows.find((r: any) => r.id === copyRow).twoDays;
    expect(await get()).toMatchObject({ kind: 'written_twice', candidates: [] });
    expect((await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days`, { action: 'advance' })).status).toBe(409);
    // Two ₹230 credits on 1 Nov: one is bill 2611015's, the other is money of its own.
    await h.credits([['1 12:01', 230], ['1 15:00', 230]]);
    expect(await get()).toMatchObject({ kind: 'wrong_number', candidates: [expect.objectContaining({ billNo: '2611015' })] });
  });

  it('written twice on a saved day: the waiting item is closed with Undo, its credit is shown, and choices are counted', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610314', '31 22:00', 'UPI', '230'], ['2611016', '1 10:00', 'CASH', '40']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.credits([['31 21:59', 230]]);
    await h.register([{ no: '2610314', amount: '230', pays: [['upi', '230']] }]);
    await h.register([{ no: '2611016', amount: '40', pays: [['cash', '40']], day: '2026-11-01' }, { no: '2610314', amount: '230', pays: [['upi', '230']], day: '2026-11-01' }]);
    const copyRow = h.rows['2610314'];
    await h.view('2026-10-31');
    await h.view('2026-11-01');
    await h.decideRest('2026-11-01', (c: any) => (c.billNo === '2610314' ? 'carry_forward' : undefined));
    await h.confirm('2026-11-01');
    const base = `/businesses/${h.bid}`;
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${copyRow}`)[0].upload_id;
    const get = async () => (await h.clients.entry_staff.get(`${base}/uploads/${page}`)).json;
    let u = await get();
    let td = u.rows.find((r: any) => r.id === copyRow).twoDays;
    expect(td).toMatchObject({ kind: 'written_twice', here: { decision: 'carry_forward', closed: false, confirmed: true }, home: { creditAt: expect.any(Number) } });
    expect(u.twoDayRight).toEqual({});
    const res = await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days`, { action: 'close' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await sql`SELECT close_note FROM bill_comparisons WHERE register_row_id = ${copyRow}`)[0].close_note).toBe('Written twice: counted on 2026-10-31');
    u = await get();
    td = u.rows.find((r: any) => r.id === copyRow).twoDays;
    expect(td).toMatchObject({ done: 'close', here: { closed: true } });
    expect(u.twoDayRight).toEqual({ close: 1 });
    expect((await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days`, { action: 'close' })).status).toBe(409);
    expect((await h.clients.accountant.post(`${base}/register-rows/${copyRow}/two-days/undo`, {})).status).toBe(200);
    expect((await sql`SELECT closed_at FROM bill_comparisons WHERE register_row_id = ${copyRow}`)[0].closed_at).toBeNull();
    // An Undo starts the count again.
    expect((await get()).twoDayRight).toEqual({});
  });
});
