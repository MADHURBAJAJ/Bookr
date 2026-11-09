// Audit (9 Nov 2026): more UPI cases (U1–U13), each with what a careful accountant would expect. Invented data only.
// Soft checks: one run reports every case; [audit] lines say what Bookr did. Failures here are findings, not yet fixed.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { at, bill, hotel, log, matchedTo, statusOf } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 900_000 });

const upi = (ref: string, note = 'Paid', vpa = 'guest@okaxis') => `UPI/${ref}/${note}/${vpa}/SAMPLE BANK/ICIa`;
/** Somewhere Bookr offers or makes a match with this credit (a pair, a card, a likely one). */
const offered = (r: any, id: string) => JSON.stringify([r.fixes, r.likely, r.clear, r.slips]).includes(id);
const openOf = (v: any, id: string) => v.json.bank?.open?.find((c: any) => c.id === id);
const noBill = (v: any, id: string) => (v.json.bank?.noBill ?? []).some((c: any) => c.id === id);

describe('UPI audit, part 2', () => {
  it('one shift: refund, failed then retried, change in cash, a split payment, a note, a second import, a re-issued bill, a discount after paying, an owner transfer', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([
      ['2610401', '31 12:00', 'UPI', '2000'],    // U1 cancelled after paying; refunded
      ['2610402', '31 13:00', 'UPI', '700'],     // U2 first try reversed, second went through
      ['2610403', '31 14:00', 'UPI', '550'],     // U3 guest sent 600, got 50 cash back
      ['2610407', '31 15:00', 'UPI', '15000'],   // U7 guest paid 10,000 + 5,000 (app limit)
      ['2610409', '31 16:04', 'UPI', '480'],     // U9 two bills of 480; the note names 2610410
      ['2610410', '31 16:20', 'UPI', '480'],
      ['2610411', '31 17:00', 'UPI', '650'],     // U10 the statement imported twice
      ['2610412', '31 18:00', 'UPI', '900'],     // U11 voided, re-issued as 2610413
      ['2610413', '31 18:05', 'UPI', '900'],
      ['2610414', '31 19:00', 'UPI', '950'],     // U12 discount of 50 given after the guest paid 1,000
      ['2610499', '1 07:59', 'CASH', '1'],
    ]);
    await h.register([
      { no: '2610402', amount: '700', pays: [['upi', '700']] },
      { no: '2610403', amount: '550', pays: [['upi', '550']] },
      { no: '2610407', amount: '15000', pays: [['upi', '15000']] },
      { no: '2610409', amount: '480', pays: [['upi', '480']] },
      { no: '2610410', amount: '480', pays: [['upi', '480']] },
      { no: '2610411', amount: '650', pays: [['upi', '650']] },
      { no: '2610413', amount: '900', pays: [['upi', '900']] },
      { no: '2610414', amount: '1000', pays: [['upi', '1000']] },
      { no: '2610499', amount: '1', pays: [['cash', '1']] },
    ]);
    const L = await h.lines([
      ['31 12:02', 2000, 'CR', upi('810000000001')],                                   // 0 U1 paid
      ['31 12:40', 2000, 'DR', upi('810000000002', 'Refund')],                         // 1 U1 refunded
      ['31 13:01', 700, 'CR', upi('810000000003')],                                    // 2 U2 first try
      ['31 13:03', 700, 'DR', upi('RVSL810000000003')],                                // 3 U2 its reversal
      ['31 13:05', 700, 'CR', upi('810000000004')],                                    // 4 U2 second try
      ['31 14:01', 600, 'CR', upi('810000000005')],                                    // 5 U3
      ['31 15:01', 10000, 'CR', upi('810000000006')],                                  // 6 U7
      ['31 15:02', 5000, 'CR', upi('810000000007')],                                   // 7 U7
      ['31 16:05', 480, 'CR', upi('810000000008', '2610410')],                         // 8 U9 note names 2610410
      ['31 16:21', 480, 'CR', upi('810000000009')],                                    // 9 U9
      ['31 17:02', 650, 'CR', upi('810000000010')],                                    // 10 U10
      ['31 18:06', 900, 'CR', upi('810000000011')],                                    // 11 U11
      ['31 19:01', 1000, 'CR', upi('810000000012')],                                   // 12 U12
      ['31 20:00', 50000, 'CR', upi('810000000013', 'Self transfer', 'owner@okhdfc')], // 13 U13 owner tops up
      ['1 09:00', 2, 'CR', upi('810000000014')],                                       // the bank is in past the shift
    ]);
    const id = L.ids;
    // U10: the same statement imported again adds nothing.
    const again = await h.lines([], 'HUF A', L.text);
    log('U10 second import', again.res);
    expect.soft((await sql`SELECT count(*) AS n FROM bank_rows WHERE amount_paise = 65000`)[0].n, 'U10: one ₹650 line after importing twice').toBe(1);

    const v = await h.view();
    const trial = await h.reconcile();
    // U1 refund: the ₹2,000 in and the ₹2,000 refund cancel; the credit is not "money with no bill".
    log('U1 refund', { credit: openOf(v, id[0]) ?? null, noBill: noBill(v, id[0]), refund: await statusOf(id[1]) });
    expect.soft(noBill(v, id[0]), 'U1: a credit refunded the same day is not money with no bill').toBe(false);
    expect.soft([await statusOf(id[0]), await statusOf(id[1])], 'U1: the credit and its refund are left out together').toEqual(['ignored', 'ignored']);
    // U2 failed then retried: the retry pays the bill; the reversed try is neither extra nor a bill's credit.
    log('U2 retried', { paired: bill(v, '2610402').bank?.creditId === id[4] ? 'second try' : bill(v, '2610402').bank?.creditId === id[2] ? 'reversed try' : null, first: openOf(v, id[2]) ?? null });
    expect.soft(bill(v, '2610402').bank?.creditId, 'U2: paired with the try that went through').toBe(id[4]);
    expect.soft(openOf(v, id[2]), 'U2: the reversed try is not left as a credit to explain').toBeUndefined();
    expect.soft([await statusOf(id[2]), await statusOf(id[3])], 'U2: the reversed try and its reversal are left out together').toEqual(['ignored', 'ignored']);
    // U3 ₹600 for a ₹550 bill, ₹50 given back in cash: told after saving (below), where a difference can be booked.
    // U7 one go written, two credits that add up: backed by both.
    log('U7 split by guest', bill(v, '2610407').bank);
    expect.soft((bill(v, '2610407').bank?.parts ?? []).map((p: any) => p.creditId).sort(), 'U7: the 10,000 + 5,000 back the one ₹15,000 go').toEqual([id[6], id[7]].sort());
    // U9 the note names the bill: it decides, not the time.
    log('U9 note', { '2610409': bill(v, '2610409').bank?.creditId === id[8] ? 'noted credit' : 'other', '2610410': bill(v, '2610410').bank?.creditId === id[8] ? 'noted credit' : 'other' });
    expect.soft(bill(v, '2610410').bank?.creditId, 'U9: the credit whose note says 2610410 pays 2610410').toBe(id[8]);
    // U10 paired once.
    expect.soft(bill(v, '2610411').bank?.creditId, 'U10: 2610411 paired').toBe(id[10]);
    // U11 re-issued: the credit pays the new number; the voided one is told it was re-issued.
    const c11 = trial.fixes.find((f: any) => JSON.stringify(f).includes('2610412'));
    log('U11 re-issued', { paired: bill(v, '2610413').bank?.creditId === id[11], reissuedAs: bill(v, '2610412').reissuedAs, card: c11 ? { kind: c11.kind, title: c11.title } : null });
    expect.soft(bill(v, '2610413').bank?.creditId, 'U11: the credit pays the re-issued bill').toBe(id[11]);
    expect.soft(bill(v, '2610412').reissuedAs, 'U11: on Compare, 2610412 is told it looks issued again as 2610413').toBe('2610413');
    // U12 paid 1,000, software later 950: the bank backs the register.
    log('U12 discount after paying', { diff: bill(v, '2610414').difference, bank: bill(v, '2610414').bank });
    expect.soft(bill(v, '2610414').bank?.suggest, 'U12: the ₹1,000 credit backs the register').toBe('use_register');
    // U13 owner transfer: shown, and something can be done with it other than leave it waiting for a bill.
    const t13 = trial.open?.credits?.find((c: any) => c.id === id[13]);
    log('U13 owner transfer', { open: openOf(v, id[13]) ?? null, trial: t13 ?? null });
    // Shown with its note, as money with no bill; it can be booked directly to a head. Bookr does not tell it as not a sale.
    expect.soft(t13?.noBill && t13?.remark, 'U13: the ₹50,000 is shown, with its note').toBe('Self transfer');

    // Save: U1 left out (cancelled), the rest as the bank or the register says.
    await h.decideRest('2026-10-31', (c) => (c.billNo === '2610401' || c.billNo === '2610412' ? 'leave_out' : undefined));
    const saved = await h.confirm();
    log('saved', { matched: saved.matched, skipped: saved.skipped });
    log('U2 saved', { reversedTry: await matchedTo(id[2]), secondTry: await matchedTo(id[4]) });
    expect.soft(await matchedTo(id[2]), 'U2 saved: the reversed try is not a payment of the bill').toEqual([]);
    expect.soft(await matchedTo(id[4]), 'U2 saved: second try matched').toEqual(['2610402']);
    expect.soft((await matchedTo(id[6])).concat(await matchedTo(id[7])), 'U7 saved: both credits matched').toEqual(['2610407', '2610407']);
    expect.soft(await matchedTo(id[8]), 'U9 saved: noted credit to 2610410').toEqual(['2610410']);
    expect.soft(await matchedTo(id[11]), 'U11 saved').toEqual(['2610413']);
    expect.soft(await matchedTo(id[12]), 'U12 saved').toEqual(['2610414']);
    // The refund and the reversal are not expenses waiting to be booked.
    const home = (await h.clients.owner.get(`/businesses/${h.bid}/home`)).json;
    log('book expenses after saving', home.bookExpenses);
    expect.soft(home.bookExpenses?.count ?? 0, 'U1/U2: the refund and the reversal are not bank payments to book as expenses').toBe(0);
    const rec = await h.reconcile();
    const r3 = rec.fixes.concat(rec.likely ?? []).find((f: any) => JSON.stringify(f).includes(id[5]));
    log('U3 after saving', r3 ? { kind: r3.kind, title: r3.title } : null);
    expect.soft(r3?.kind, 'U3 after saving: the ₹600 told as bill 2610403 with ₹50 change in cash').toBe('change_in_cash');
    expect.soft(r3?.actions?.[0], 'U3: ticks them in Match by hand').toMatchObject({ op: 'pick', credits: [id[5]] });
  });

  it('across shifts: an advance at check-in, part now and rest later, a credit posted next morning', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([
      ['2610420', '31 23:50', 'UPI', '820'],     // U6 its credit posts at 8:20 next morning
      ['2611011', '1 11:00', 'UPI', '3000'],     // U4 room advance paid on 30 Oct
      ['2611012', '1 12:00', 'UPI', '3500'],     // U5 2,000 advance on 31 Oct, 1,500 at checkout
      ['2611099', '2 07:59', 'CASH', '1'],
    ], at('2 07:59').ms + 60_000);
    await h.register([
      { no: '2610420', amount: '820', pays: [['upi', '820']] },
      { no: '2611011', amount: '3000', pays: [['upi', '3000']], day: '2026-11-01' },
      { no: '2611012', amount: '3500', pays: [['upi', '2000'], ['upi', '1500']], day: '2026-11-01' },
      { no: '2611099', amount: '1', pays: [['cash', '1']], day: '2026-11-01' },
    ]);
    const { ids: id } = await h.lines([
      ['30 15:00', 3000, 'CR', upi('820000000001', 'Advance room 204')],              // 0 U4
      ['31 14:00', 2000, 'CR', upi('820000000002', 'Advance')],                       // 1 U5 advance
      ['1 08:20', 820, 'CR', upi('820000000003')],                                    // 2 U6
      ['1 12:02', 1500, 'CR', upi('820000000004')],                                   // 3 U5 rest
      ['2 09:00', 2, 'CR', upi('820000000005')],
    ]);
    // Before saving, Compare pairs only within the shift's reach: these are offered after saving, as likely matches.
    const v1 = await h.view('2026-11-01');
    log('U5 before saving', bill(v1, '2611012').bank);
    // After saving both shifts, what is offered.
    await h.decideRest('2026-10-31'); await h.confirm('2026-10-31');
    await h.decideRest('2026-11-01'); await h.confirm('2026-11-01');
    const r31 = await h.reconcile('2026-10-31');
    const r1 = await h.reconcile('2026-11-01');
    const likelyOf = (r: any, credit: string) => (r.likely ?? []).find((x: any) => x.creditId === credit);
    log('after saving', { U6: likelyOf(r31, id[2]) ?? null, U4: likelyOf(r1, id[0]) ?? null, U5: [likelyOf(r1, id[1]) ?? null, offered(r1, id[3])] });
    expect.soft(likelyOf(r31, id[2])?.billNos, 'U6 after saving: the 8:20 am credit offered for the 11:50 pm bill').toEqual(['2610420']);
    expect.soft(likelyOf(r31, id[2])?.far, 'U6: told as far from the bill').toBe(true);
    expect.soft(likelyOf(r1, id[0])?.billNos, 'U4 after saving: the 30 Oct advance offered for the room bill').toEqual(['2611011']);
    expect.soft(likelyOf(r1, id[1])?.billNos, 'U5 after saving: the 31 Oct advance offered for its part').toEqual(['2611012']);
    expect.soft(offered(r1, id[3]), 'U5 after saving: the rest at checkout offered too').toBe(true);
    // Never ticked or matched by Bookr.
    expect.soft([await statusOf(id[0]), await statusOf(id[1]), await statusOf(id[2])], 'far credits are only offered').toEqual(['unmatched', 'unmatched', 'unmatched']);
  });

  // U8 (approved 9 Nov 2026): UPI paid on the card machine (its QR, or a RuPay credit card through UPI) comes in the
  // machine's settlement with the cards. The bill stays UPI; it is matched to the machine payment.
  it('U8: UPI on the card machine, a UPI card payment, a machine payment closer than a credit, one arriving after saving', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([
      ['2610431', '31 14:10', 'UPI', '314'],     // U8a QR on the machine
      ['2610432', '31 15:00', 'UPI', '230'],     // U8b RuPay credit card through UPI on the machine
      ['2610433', '31 15:02', 'CARD', '230'],    //     a card bill of the same amount, a card swipe
      ['2610434', '31 16:00', 'UPI', '520'],     // U8c machine 3 min away, a credit 40 min away
      ['2610435', '31 17:00', 'UPI', '410'],     // U8d its machine payment comes in after saving
      ['2610499', '1 07:59', 'CASH', '1'],
    ]);
    await h.register([
      { no: '2610431', amount: '314', pays: [['upi', '314']] },
      { no: '2610432', amount: '230', pays: [['upi', '230']] },
      { no: '2610433', amount: '230', pays: [['card', '230']] },
      { no: '2610434', amount: '520', pays: [['upi', '520']] },
      { no: '2610435', amount: '410', pays: [['upi', '410']] },
      { no: '2610499', amount: '1', pays: [['cash', '1']] },
    ]);
    const qr = await h.swipe('31 14:12', 314, 'UPI', { payMode: 'UPI' });
    const upiCard = await h.swipe('31 15:01', 230, 'RUPAY CC', { payMode: 'UPI Card', feePaise: 409, gstPaise: 74 });
    const visa = await h.swipe('31 15:03', 230, 'VISA', { payMode: 'CARDS' });
    const near = await h.swipe('31 16:03', 520, 'UPI', { payMode: 'UPI' });
    const { ids: [credit40] } = await h.lines([['31 16:40', 520, 'CR', upi('830000000001')], ['1 09:00', 2, 'CR', upi('830000000002')]]);

    const v = await h.view();
    log('U8 Compare', { a: bill(v, '2610431').bank, b: bill(v, '2610432').bank, c: bill(v, '2610434').bank });
    expect.soft(bill(v, '2610431').bank?.creditId, 'U8a: the QR payment backs the UPI XOXO bill').toBe(qr);
    expect.soft(bill(v, '2610431').bank?.machine?.settledOn, 'U8a: told when it settles').toBe('2026-11-02');
    expect.soft(bill(v, '2610432').bank?.creditId, 'U8b: the UPI card payment backs the UPI bill').toBe(upiCard);
    expect.soft(bill(v, '2610432').bank?.machine?.label, 'U8b: told as UPI on the machine').toMatch(/UPI on machine/);
    expect.soft(bill(v, '2610434').bank?.creditId, 'U8c: the machine payment 3 min away, not the credit 40 min away').toBe(near);
    expect.soft(bill(v, '2610431').bankNone ?? null, 'U8a: not "no UPI in the bank"').toBeNull();

    await h.decideRest();
    await h.confirm();
    const tx = async (no: string) => (await sql`SELECT t.id, t.payment_mode, t.match_status, (SELECT m.settlement_id FROM card_matches m WHERE m.transaction_id = t.id) AS pay
      FROM transactions t WHERE t.bill_no = ${no} AND t.type = 'income'`)[0];
    expect.soft(await tx('2610431'), 'U8a saved: UPI, received through the machine').toMatchObject({ payment_mode: 'upi', match_status: null, pay: qr });
    expect.soft(await tx('2610432'), 'U8b saved: UPI, matched to the UPI card payment').toMatchObject({ payment_mode: 'upi', match_status: null, pay: upiCard });
    expect.soft((await tx('2610433')).pay ?? visa, 'U8b: the card bill never takes the UPI card payment').not.toBe(upiCard);
    expect.soft(await tx('2610434'), 'U8c saved').toMatchObject({ payment_mode: 'upi', pay: near });
    expect.soft(await statusOf(credit40), 'U8c: the credit 40 min away stays open').toBe('unmatched');
    const ent = await h.entries();
    const e431 = ent.upi.entries.find((x: any) => x.billNo === '2610431');
    log('U8a UPI tab', e431 && { state: e431.state, evidence: e431.evidence });
    expect.soft(e431?.state, 'U8a: done on the UPI tab').toBe('done');
    expect.soft(e431?.evidence, 'U8a: evidence names the machine and its settlement').toMatch(/UPI on machine .*settles 2026-11-02/);

    // U8d: the machine payment arrives after saving: the Card tab offers it as UPI on the machine; undo puts it back.
    const late = await h.swipe('31 17:05', 410, 'UPI', { payMode: 'UPI' });
    const rec = await h.reconcile();
    const need = rec.cards?.needs?.find((n: any) => n.payment.id === late);
    log('U8d Card tab', need && { why: need.why, upi: need.payment.upi, written: need.written?.billNo });
    expect.soft(need?.payment?.upi, 'U8d: told as UPI on the machine').toBe(true);
    expect.soft(need?.written?.billNo, 'U8d: offered for the UPI bill 2610435').toBe('2610435');
    const no = (await h.clients.owner.post(`/businesses/${h.bid}/cards/${late}/was-card`, { transactionIds: [need?.written?.transactionId] })).status;
    expect.soft(no, 'U8d: a UPI payment on the machine is not turned into a card bill').toBe(409);
    const res = await h.clients.owner.post(`/businesses/${h.bid}/cards/${late}/upi-on-machine`, { transactionIds: [need?.written?.transactionId] });
    expect.soft(res.status, JSON.stringify(res.json)).toBe(200);
    expect.soft(await tx('2610435'), 'U8d: matched, still UPI').toMatchObject({ payment_mode: 'upi', match_status: null, pay: late });
    expect.soft((await h.clients.owner.post(`/businesses/${h.bid}/cards/${late}/unmatch`, {})).status, 'U8d: unmatch').toBe(200);
    expect.soft(await tx('2610435'), 'U8d undone: waits for its UPI money again').toMatchObject({ payment_mode: 'upi', match_status: 'awaiting_bank_match', pay: null });
  });
});
