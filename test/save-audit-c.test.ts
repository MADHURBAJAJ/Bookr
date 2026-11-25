// Save audit C (14 Nov 2026): the bank and the card machine as evidence when a shift is saved. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { brief, cmp, decide, income, matches, noDoubles, saveChecked, type H } from './saveKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const roomHead = async (h: H) => (await sql`SELECT id FROM heads WHERE business_id = ${h.bid} AND name = 'Room'`)[0].id as string;
const tx = async (h: H, billNo: string) => (await sql`SELECT * FROM transactions WHERE business_id = ${h.bid} AND bill_no = ${billNo} AND source = 'software_report'`);

describe('C10 UPI matched on save', () => {
  async function setUp() {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610401', '31 14:00', 'UPI', '450'], ['2610402', '31 16:00', 'UPI', '620'], ['2610403', '31 12:00', 'UPI', '650'], ['2610404', '31 10:00', 'CASH', '100']]);
    await h.register([{ no: '2610401', amount: '450', pays: [['upi', '450']] }, { no: '2610402', amount: '620', pays: [['upi', '620']] },
      { no: '2610403', amount: '650', pays: [['upi', '650']] }, { no: '2610404', amount: '100', pays: [['cash', '100']] }]);
    const [booked] = await h.credits([['30 19:00', 650]]);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${booked}/book`, { headId: h.fnb, note: 'Sale', override: { reason: 'Booked before its bill (test)' } })).json.ok).toBe(true);
    const [clear, far] = await h.credits([['31 14:02', 450], ['1 06:30', 620], ['1 08:30', 3]]);
    const acc = h.clients.accountant;
    // A credit chosen by hand for 2610402, and the booked 30 Oct credit as the same sale as 2610403.
    expect((await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/choices`, { bankRowId: far, comparisonIds: [(await cmp(h, '2610402')).id] })).status).toBe(200);
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${(await cmp(h, '2610403')).id}/same-sale`, { rowId: booked })).status).toBe(200);
    return { h, booked, clear, far };
  }

  it('a clear credit, a credit chosen by hand, and a credit booked on another day (same sale) are each matched once', async () => {
    const { h, booked, clear, far } = await setUp();
    expect((await h.view()).json.comparisons.find((c: any) => c.billNo === '2610401').bank).toMatchObject({ creditId: clear });
    const s = await saveChecked(h);
    expect(s.res.skipped).toEqual([]);
    const by = Object.fromEntries(s.rows.map((r: any) => [r.bill_no, r]));
    expect(by['2610401']).toMatchObject({ matched_bank_row: clear, match_status: null });
    expect(by['2610402']).toMatchObject({ matched_bank_row: far, match_status: null });
    // Same sale: one sale, on the day the money came, matched to it; the booking is gone.
    expect(by['2610403']).toMatchObject({ matched_bank_row: booked, day: '2026-10-30' });
    expect(await sql`SELECT 1 FROM transactions WHERE business_id = ${h.bid} AND source = 'bank_sheet' AND type = 'income'`).toHaveLength(0);
    expect((await sql`SELECT status FROM bank_rows WHERE id IN (${clear}, ${far}, ${booked})`).map((r: any) => r.status)).toEqual(['matched', 'matched', 'matched']);
    expect((await matches(h)).bank.sort()).toEqual([[booked, '2610403'], [clear, '2610401'], [far, '2610402']].sort());
    expect(s.res.matched).toBe(3);
  });

  // BUG (save audit, 14 Nov 2026): a same-sale join undone after saving comes back by itself when the shift is reopened and
  // saved again. Undo restores the booking but leaves the plan ('bank.same_sale_planned') in the audit log, and plansFor
  // still reads it on the next save.
  it('a same-sale join undone after saving is not made again when the shift is reopened and saved', async () => {
    const { h, booked, clear, far } = await setUp();
    await saveChecked(h);
    const owner = h.clients.owner;
    // Undo: the credit goes back to being booked on 30 Oct. The other matches are undone too, so the shift can reopen.
    for (const id of [booked, clear, far]) expect((await owner.del(`/businesses/${h.bid}/bank-rows/${id}/match`)).status).toBe(200);
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${booked}`)[0].status).toBe('booked');
    expect((await owner.post(`/businesses/${h.bid}/shifts/2026-10-31/reopen`, { reason: 'Recheck the register' })).status).toBe(200);
    await h.confirm();
    // The person undid the join: the bill waits for its own credit, and the 30 Oct booking stays.
    expect((await tx(h, '2610403'))[0]).toMatchObject({ day: '2026-10-31', matched_bank_row: null });
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${booked}`)[0].status).toBe('booked');
  });
});

describe('C11 the card machine', () => {
  it('UPI on the machine for a UPI bill and a card bill, a swipe matched by itself, a swipe chosen', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610411', '31 14:00', 'UPI', '380'], ['2610412', '31 15:00', 'CARD', '700'], ['2610413', '31 11:30', 'CARD', '942'], ['2610414', '31 19:00', 'CARD', '1200']]);
    await h.register([{ no: '2610411', amount: '380', pays: [['upi', '380']] }, { no: '2610412', amount: '700', pays: [['card', '700']] },
      { no: '2610413', amount: '942', pays: [['card', '942']] }, { no: '2610414', amount: '1200', pays: [['card', '1200']] }]);
    await h.credits([['1 08:30', 3]]);
    const p1 = await h.swipe('31 14:01', 380, 'UPI', { payMode: 'UPI' });
    const p2 = await h.swipe('31 15:02', 700, 'UPI', { payMode: 'UPI' });
    const p3 = await h.swipe('31 11:35', 942);
    const p4 = await h.swipe('31 19:25', 1200);
    await h.swipe('1 09:00', 1);
    const acc = h.clients.accountant;
    expect((await h.view()).json.comparisons.find((c: any) => c.billNo === '2610411').bank).toMatchObject({ creditId: p1 });
    for (const [pid, no] of [[p2, '2610412'], [p4, '2610414']]) {
      const r = await acc.post(`/businesses/${h.bid}/shifts/2026-10-31/card-choices`, { paymentId: pid, comparisonIds: [(await cmp(h, no)).id] });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    const s = await saveChecked(h);
    expect(s.res.skipped).toEqual([]);
    expect(s.res.cardMatched).toBe(1);
    expect((await matches(h)).card.sort()).toEqual([[p1, '2610411'], [p2, '2610412'], [p3, '2610413'], [p4, '2610414']].sort());
    expect((await income(h)).map((r: any) => [r.bill_no, r.payment_mode, r.match_status])).toEqual([
      ['2610411', 'upi', null], ['2610412', 'card', null], ['2610413', 'card', null], ['2610414', 'card', null]]);
  });
});

describe('C12 advances joined to a room bill', () => {
  it('a card advance and a UPI advance: each sale counted once, on the day the money came', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}`;
    const adv = await h.swipe('30 13:00', 5000);
    expect((await acc.post(`${base}/cards/${adv}/book`, { billType: 'room', item: 'Advance: Mr Sharma, room 12' })).status).toBe(200);
    const [upiAdv] = await h.credits([['30 18:00', 2000]]);
    expect((await h.clients.owner.post(`${base}/bank-rows/${upiAdv}/book`, { headId: await roomHead(h), note: 'Advance: Ms Das, room 5', override: { reason: 'Booked before its bill (test)' } })).json.ok).toBe(true);
    await h.software([['2610421', '31 11:00', 'CASH', '12000'], ['2610422', '31 12:00', 'UPI', '2000']]);
    await h.register([{ no: '2610421', amount: '12000', pays: [['card', '5000'], ['cash', '7000']] }, { no: '2610422', amount: '2000', pays: [['upi', '2000']] }]);
    await sql`UPDATE register_rows SET bill_type = 'room' WHERE business_id = ${h.bid}`;
    await h.credits([['1 08:30', 3]]);
    await h.swipe('1 09:00', 1);
    await decide(h, '2610421', 'use_register');
    expect((await acc.post(`${base}/shifts/2026-10-31/card-advance`, { paymentId: adv, comparisonId: (await cmp(h, '2610421')).id })).status).toBe(200);
    expect((await acc.post(`${base}/comparisons/${(await cmp(h, '2610422')).id}/same-sale`, { rowId: upiAdv })).status).toBe(200);
    const s = await saveChecked(h);
    expect(s.res.skipped).toEqual([]);
    expect(brief(s.rows)).toEqual([['2610421', 5000, 'card', 'Room', 'register'], ['2610421', 7000, 'cash', 'Room', 'register'], ['2610422', 2000, 'upi', 'Room', 'both_matched']]);
    expect(s.rows.map((r: any) => [r.bill_no, r.payment_mode, r.day])).toEqual([['2610421', 'card', '2026-10-30'], ['2610421', 'cash', '2026-10-31'], ['2610422', 'upi', '2026-10-30']]);
    expect(await sql`SELECT 1 FROM transactions WHERE business_id = ${h.bid} AND source = 'bank_sheet' AND type = 'income'`, 'both advance bookings replaced by the bills').toHaveLength(0);
    expect(s.after.cashSalesPaise).toBe(700000);
    await noDoubles(h);
  });
});

describe('C12 undo after saving', () => {
  // BUG (save audit, 14 Nov 2026): a card advance join undone after saving (Unmatch: "advanceBack") comes back by itself
  // when the shift is reopened and saved again. Undo writes 'card.advance_joined' back but never 'card.advance_unplanned',
  // so cardAdvancePlans still returns the plan on the next save. Same cause as the same-sale case in C10.
  it('a card advance join undone after saving is not made again when the shift is reopened and saved', async () => {
    const h = await hotel();
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}`;
    const adv = await h.swipe('30 13:00', 5000);
    expect((await acc.post(`${base}/cards/${adv}/book`, { billType: 'room', item: 'Advance: Mr Sharma, room 12' })).status).toBe(200);
    await h.software([['2610423', '31 11:00', 'CASH', '12000']]);
    await h.register([{ no: '2610423', amount: '12000', pays: [['card', '5000'], ['cash', '7000']] }]);
    await h.swipe('1 09:00', 1);
    await decide(h, '2610423', 'use_register');
    expect((await acc.post(`${base}/shifts/2026-10-31/card-advance`, { paymentId: adv, comparisonId: (await cmp(h, '2610423')).id })).status).toBe(200);
    await saveChecked(h);
    expect((await acc.post(`${base}/cards/${adv}/unmatch`, {})).json).toMatchObject({ advanceBack: true });
    expect((await h.clients.owner.post(`${base}/shifts/2026-10-31/reopen`, { reason: 'Recheck' })).status).toBe(200);
    await h.confirm();
    const sale = (await sql`SELECT t.day, t.match_status, (SELECT count(*) FROM card_matches m WHERE m.transaction_id = t.id) AS n FROM transactions t
      WHERE t.business_id = ${h.bid} AND t.bill_no = '2610423' AND t.payment_mode = 'card'`)[0];
    // Undone by a person: the bill waits for its own card payment, and the advance stays booked.
    expect(sale).toMatchObject({ day: '2026-10-31', match_status: 'awaiting_card_settlement', n: 0 });
    expect(await sql`SELECT 1 FROM transactions WHERE business_id = ${h.bid} AND source = 'bank_sheet' AND type = 'income'`).toHaveLength(1);
  });
});

describe('C10 a credit both shown as evidence and chosen for another bill', () => {
  it('only the chosen match is made and counted', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610405', '31 14:00', 'UPI', '500'], ['2610406', '31 20:00', 'UPI', '500']]);
    await h.register([{ no: '2610405', amount: '500', pays: [['upi', '500']] }, { no: '2610406', amount: '500', pays: [['upi', '500']] }]);
    const [cr] = await h.credits([['31 14:01', 500], ['1 08:30', 3]]);
    expect((await h.view()).json.comparisons.find((c: any) => c.billNo === '2610405').bank).toMatchObject({ creditId: cr });
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/choices`, { bankRowId: cr, comparisonIds: [(await cmp(h, '2610406')).id] })).status).toBe(200);
    const s = await saveChecked(h);
    expect((await matches(h)).bank).toEqual([[cr, '2610406']]);
    expect(s.rows.find((r: any) => r.bill_no === '2610405')).toMatchObject({ matched_bank_row: null, match_status: 'awaiting_bank_match' });
    expect(s.res.matched).toBe(1);
  });
});

describe('C13 a credit near a bill but not equal', () => {
  it('a credit a few rupees off a group is not matched, and stays open for a person', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610431', '31 14:00', 'UPI', '600'], ['2610432', '31 14:00', 'UPI', '400']]);
    await h.register([{ no: '2610431', amount: '600', pays: [['upi', '1000']] }, { no: '2610432', amount: '400', pays: [], paidWith: '2610431' }]);
    const [cr] = await h.credits([['31 14:05', 995], ['1 08:30', 3]]);
    const v = await h.view();
    expect(v.json.paidGroups[0]).toMatchObject({ matched: true, bank: null });
    const s = await saveChecked(h);
    expect(s.res.matched).toBe(0);
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${cr}`)[0].status).toBe('unmatched');
    expect(s.rows.map((r: any) => r.match_status)).toEqual(['awaiting_bank_match', 'awaiting_bank_match']);
  });
});
