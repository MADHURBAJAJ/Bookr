// Save audit A (14 Nov 2026): bills that match or differ, saved. Each save checks the income rows (amount, mode, head,
// source), that the cash before saving equals the cash after, and that nothing is booked or matched twice. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';
import { brief, cmp, decide, income, saveChecked } from './saveKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('A1 bills that agree', () => {
  it('cash, UPI and card book as matched; a cash + UPI bill books both parts', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 10:00', 'CASH', '500'], ['2610312', '31 11:00', 'UPI', '300'], ['2610313', '31 12:00', 'CARD', '942'], ['2610314', '31 13:00', 'UPI', '1000']]);
    await h.register([{ no: '2610311', amount: '500', pays: [['cash', '500']] }, { no: '2610312', amount: '300', pays: [['upi', '300']] },
      { no: '2610313', amount: '942', pays: [['card', '942']] }, { no: '2610314', amount: '1000', pays: [['cash', '400'], ['upi', '600']] }]);
    await sql`UPDATE register_rows SET bill_type = 'room' WHERE bill_no = '2610313'`;
    // The software has one mode: a bill paid two ways is a mode difference, for a person.
    expect((await cmp(h, '2610314')).difference).toBe('mode');
    expect((await decide(h, '2610314', 'use_register')).status).toBe(200);
    const s = await saveChecked(h);
    expect(brief(s.rows)).toEqual([
      ['2610311', 500, 'cash', 'F&B', 'both_matched'],
      ['2610312', 300, 'upi', 'F&B', 'both_matched'],
      ['2610313', 942, 'card', 'Room', 'both_matched'],
      ['2610314', 400, 'cash', 'F&B', 'register'],
      ['2610314', 600, 'upi', 'F&B', 'register'],
    ]);
    const cashAcc = (await sql`SELECT id FROM accounts WHERE business_id = ${h.bid} AND kind = 'cash'`)[0].id;
    expect(s.rows.map((r: any) => [r.payment_mode, r.status, r.match_status, r.account_id === cashAcc])).toEqual([
      ['cash', 'approved', null, true], ['upi', 'approved', 'awaiting_bank_match', false], ['card', 'approved', 'awaiting_card_settlement', false],
      ['cash', 'approved', null, true], ['upi', 'approved', 'awaiting_bank_match', false]]);
    expect(s.after.cashSalesPaise).toBe(90000);
    expect(s.res).toMatchObject({ rows: 5, totalPaise: 274200 });
  });
});

describe('A2 amount or mode differs, with a register discount and a tip', () => {
  it('Use software books the software, Use register the register after discount and tip', async () => {
    const h = await hotel();
    await h.software([
      ['2610321', '31 10:00', 'CASH', '1000'], ['2610322', '31 10:10', 'UPI', '500'], ['2610323', '31 10:20', 'CASH', '800'], ['2610324', '31 10:30', 'CASH', '600'],
      ['2610325', '31 10:40', 'CASH', '400'], ['2610326', '31 10:50', 'UPI', '450'], ['2610327', '31 11:00', 'CASH', '1200'], ['2610328', '31 11:10', 'CASH', '1000'],
    ]);
    await h.register([
      { no: '2610321', amount: '1000', discount: '100', pays: [['cash', '900']] },   // discount: software has the bill before it
      { no: '2610322', amount: '500', discount: '-20', pays: [['upi', '520']] },     // ₹20 tip
      { no: '2610323', amount: '750', pays: [['cash', '750']] },
      { no: '2610324', amount: '650', pays: [['cash', '650']] },
      { no: '2610325', amount: '400', pays: [['upi', '400']] },
      { no: '2610326', amount: '450', pays: [['card', '450']] },
      { no: '2610327', amount: '1300', discount: '100', pays: [['cash', '1200']] },  // software has it after the discount
      { no: '2610328', amount: '1100', discount: '50', pays: [['cash', '1050']] },   // neither figure
    ]);
    const diffs = Object.fromEntries((await sql`SELECT bill_no, difference FROM bill_comparisons WHERE business_id = ${h.bid}`).map((r: any) => [r.bill_no, r.difference]));
    expect(diffs).toEqual({ 2610321: 'match', 2610322: 'match', 2610323: 'amount', 2610324: 'amount', 2610325: 'mode', 2610326: 'mode', 2610327: 'match', 2610328: 'amount' });
    for (const [no, d] of [['2610323', 'use_software'], ['2610324', 'use_register'], ['2610325', 'use_software'], ['2610326', 'use_register'], ['2610328', 'use_register']]) {
      expect((await decide(h, no, d)).status).toBe(200);
    }
    const s = await saveChecked(h);
    expect(brief(s.rows)).toEqual([
      ['2610321', 900, 'cash', 'F&B', 'register'],
      ['2610322', 520, 'upi', 'F&B', 'register'],
      ['2610323', 800, 'cash', 'F&B', 'software'],
      ['2610324', 650, 'cash', 'F&B', 'register'],
      ['2610325', 400, 'cash', 'F&B', 'software'],
      ['2610326', 450, 'card', 'F&B', 'register'],
      ['2610327', 1200, 'cash', 'F&B', 'both_matched'],
      ['2610328', 1050, 'cash', 'F&B', 'register'],
    ]);
    expect(s.after.cashSalesPaise).toBe(500000);
  });
});

describe('A3 amount and mode both differ', () => {
  it('each choice books that side\'s amount and mode', async () => {
    const h = await hotel();
    await h.software([['2610331', '31 10:00', 'CASH', '700'], ['2610332', '31 10:10', 'CASH', '700'], ['2610333', '31 10:20', 'CARD', '1500']]);
    await h.register([{ no: '2610331', amount: '720', pays: [['upi', '720']] }, { no: '2610332', amount: '720', pays: [['upi', '720']] },
      { no: '2610333', amount: '1450', pays: [['cash', '1350'], ['upi', '100']] }]);
    for (const no of ['2610331', '2610332', '2610333']) expect((await cmp(h, no)).difference).toBe('amount_and_mode');
    await decide(h, '2610331', 'use_software');
    await decide(h, '2610332', 'use_register');
    await decide(h, '2610333', 'use_register');
    const s = await saveChecked(h);
    expect(brief(s.rows)).toEqual([
      ['2610331', 700, 'cash', 'F&B', 'software'],
      ['2610332', 720, 'upi', 'F&B', 'register'],
      ['2610333', 1350, 'cash', 'F&B', 'register'],
      ['2610333', 100, 'upi', 'F&B', 'register'],
    ]);
    // Both sides were there, so the UPI is counted now (not on its credit).
    expect(s.rows.filter((r: any) => r.payment_mode === 'upi').map((r: any) => r.status)).toEqual(['approved', 'approved']);
  });
});

describe('A4 only in the software report', () => {
  it('auto-counted, added to the register as Room, left out with a reason, carried forward', async () => {
    const h = await hotel();
    await h.software([['2610340', '31 13:50', 'CASH', '100'], ['2610341', '31 14:00', 'CASH', '300'], ['2610342', '31 14:10', 'UPI', '250'], ['2610343', '31 14:20', 'CARD', '900'],
      ['2610344', '31 14:30', 'CASH', '350'], ['2610345', '31 14:40', 'CASH', '200'], ['2610346', '31 14:50', 'UPI', '150']]);
    await h.register([{ no: '2610340', amount: '100', pays: [['cash', '100']] }]);
    for (const no of ['2610341', '2610342', '2610343', '2610344', '2610345', '2610346']) {
      expect(await cmp(h, no)).toMatchObject({ difference: 'missing_in_register', decision: 'use_software', decided_by: null, bill_type: 'fnb' });
    }
    // Add to the register as Room: it is written on "Added from software report" and then matches.
    const add = await decide(h, '2610344', 'use_software', { billType: 'room' });
    expect(add.json).toMatchObject({ addedToRegister: true });
    expect((await cmp(h, '2610344')).difference).toBe('match');
    // A cash bill is only left out for a reason.
    expect((await decide(h, '2610345', 'leave_out')).status).toBe(400);
    expect((await decide(h, '2610345', 'leave_out', { note: 'Cancelled in POS' })).status).toBe(200);
    expect((await decide(h, '2610346', 'carry_forward')).status).toBe(200);
    const s = await saveChecked(h);
    expect(brief(s.rows)).toEqual([
      ['2610340', 100, 'cash', 'F&B', 'both_matched'],
      ['2610341', 300, 'cash', 'F&B', 'software'],
      ['2610342', 250, 'upi', 'F&B', 'software'],
      ['2610343', 900, 'card', 'F&B', 'software'],
      ['2610344', 350, 'cash', 'Room', 'both_matched'],
    ]);
    // A UPI bill on one side only is counted when its credit comes.
    expect(s.rows.find((r: any) => r.bill_no === '2610342')).toMatchObject({ status: 'reviewed', match_status: 'awaiting_bank_match' });
    expect(s.after.cashSalesPaise).toBe(75000);
  });
});

describe('A5 only in the register', () => {
  it('a new POS number is counted by itself; an old POS or odd number waits for a person; one counted on another day is not counted twice', async () => {
    const h = await hotel();
    await h.software([['2610350', '31 10:00', 'CASH', '200'], ['2610352', '1 09:00', 'UPI', '700']], istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2610350', amount: '200', pays: [['cash', '200']] }, { no: '26103188', amount: '450', pays: [['cash', '450']] },
      { no: '145001', amount: '600', pays: [['cash', '600']] }, { no: '77', amount: '100', pays: [['cash', '100']] }, { no: '2610352', amount: '700', pays: [['upi', '700']] }]);
    expect(await cmp(h, '26103188')).toMatchObject({ difference: 'missing_in_software', decision: 'use_register', decided_by: null });
    expect(await cmp(h, '145001')).toMatchObject({ difference: 'missing_in_software', decision: null });
    expect(await cmp(h, '77')).toMatchObject({ difference: 'missing_in_software', decision: null });
    // The same bill is in the next shift's software: counted on one day only.
    const here = await cmp(h, '2610352');
    const there = await cmp(h, '2610352', '2026-11-01');
    expect([here.decision, there.decision].filter((d) => d === 'use_register' || d === 'use_software')).toHaveLength(1);
    await decide(h, '145001', 'use_register');
    await decide(h, '77', 'use_register');
    const s = await saveChecked(h);
    expect(brief(s.rows.filter((r: any) => r.bill_no !== '2610352'))).toEqual([
      ['145001', 600, 'cash', 'F&B', 'register'],
      ['26103188', 450, 'cash', 'F&B', 'register'],
      ['2610350', 200, 'cash', 'F&B', 'both_matched'],
      ['77', 100, 'cash', 'F&B', 'register'],
    ]);
    await saveChecked(h, '2026-11-01');
    const all = await sql`SELECT shift_day, amount_paise FROM transactions WHERE business_id = ${h.bid} AND bill_no = '2610352'`;
    expect(all, 'bill 2610352 counted once over both days').toHaveLength(1);
    expect(s.after.cashSalesPaise).toBe(135000);
  });
});

describe('A6 the software does not say the mode (U/N)', () => {
  it('same amount counted from the register; different amount by a person; missing ones paid by, complimentary or left out', async () => {
    const h = await hotel();
    await h.software([['2610361', '31 15:00', 'U/N', '400'], ['2610362', '31 15:10', 'U/N', '700'], ['2610363', '31 15:20', 'U/N', '250'],
      ['2610364', '31 15:30', 'U/N', '120'], ['2610365', '31 15:40', 'U/N', '90'], ['2610366', '31 15:50', 'U/N', '330']]);
    await h.register([{ no: '2610361', amount: '400', pays: [['upi', '400']] }, { no: '2610362', amount: '650', pays: [['cash', '650']] }]);
    const acc = h.clients.accountant;
    expect(await cmp(h, '2610361')).toMatchObject({ difference: 'mode', decision: 'use_register' });
    expect((await decide(h, '2610362', 'use_software')).status).toBe(400);
    expect((await decide(h, '2610362', 'use_register')).status).toBe(200);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${(await cmp(h, '2610363')).id}/paid-by`, { mode: 'cash' })).status).toBe(200);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${(await cmp(h, '2610364')).id}/complimentary`, { guestName: 'Staff meal' })).status).toBe(200);
    expect((await decide(h, '2610365', 'leave_out', { note: 'Test bill' })).status).toBe(200);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${(await cmp(h, '2610366')).id}/paid-by`, { mode: 'upi' })).status).toBe(200);
    const s = await saveChecked(h);
    expect(brief(s.rows)).toEqual([
      ['2610361', 400, 'upi', 'F&B', 'register'],
      ['2610362', 650, 'cash', 'F&B', 'register'],
      ['2610363', 250, 'cash', 'F&B', 'register'],
      ['2610366', 330, 'upi', 'F&B', 'register'],
    ]);
    expect(s.after.cashSalesPaise).toBe(90000);
  });
});

describe('A7 PREPAID, ₹0 and complimentary bills', () => {
  it('complimentary books nothing; Paid by turns one into a sale; PREPAID with money in the register is counted from it', async () => {
    const h = await hotel();
    await h.software([['2610371', '31 16:00', 'PREPAID' as never, '800'], ['2610372', '31 16:10', 'CASH', '0'], ['2610373', '31 16:20', 'CASH', '500'],
      ['2610374', '31 16:30', 'CASH', '600'], ['2610375', '31 16:40', 'PREPAID' as never, '450'], ['2610376', '31 16:50', 'PREPAID' as never, '300']]);
    await h.register([{ no: '2610372', amount: '0', pays: [] }, { no: '2610373', amount: '500', pays: [['cash', '500']] },
      { no: '2610374', amount: '600', pays: [['cash', '600']] }, { no: '2610376', amount: '300', pays: [['cash', '300']] }]);
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}/comparisons`;
    expect((await cmp(h, '2610371')).difference).toBe('complimentary');
    expect((await cmp(h, '2610372')).difference).toBe('complimentary');
    expect(await cmp(h, '2610376')).toMatchObject({ difference: 'mode', decision: 'use_register' });
    expect((await acc.post(`${base}/${(await cmp(h, '2610373')).id}/complimentary`, { guestName: 'Mr Rao (owner\'s guest)' })).status).toBe(200);
    expect((await acc.post(`${base}/${(await cmp(h, '2610374')).id}/complimentary`, { guestName: 'Ms Iyer' })).status).toBe(200);
    expect((await cmp(h, '2610373')).difference).toBe('complimentary');
    // Then paid after all: Cash for 2610374, UPI for the PREPAID 2610375.
    expect((await acc.post(`${base}/${(await cmp(h, '2610374')).id}/paid-by`, { mode: 'cash' })).status).toBe(200);
    expect((await acc.post(`${base}/${(await cmp(h, '2610375')).id}/paid-by`, { mode: 'upi' })).status).toBe(200);
    const s = await saveChecked(h);
    expect(brief(s.rows)).toEqual([
      ['2610374', 600, 'cash', 'F&B', 'both_matched'],
      ['2610375', 450, 'upi', 'F&B', 'register'],
      ['2610376', 300, 'cash', 'F&B', 'register'],
    ]);
    expect(s.after.cashSalesPaise).toBe(90000);
    const rep = (await h.clients.owner.get(`/businesses/${h.bid}/reports/complimentary?from=2026-10-31&to=2026-10-31`)).json;
    expect(rep.lines.map((l: any) => [l.billNo, l.why]).sort()).toEqual([['2610371', 'prepaid'], ['2610372', 'zero'], ['2610373', 'marked']]);
    expect(await income(h)).toHaveLength(3);
  });
});
