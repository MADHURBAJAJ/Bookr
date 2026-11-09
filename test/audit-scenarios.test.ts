// Audit of the payment-matching rules (9 Nov 2026): concrete hotel scenarios of bills, UPI credits and card payments,
// each with what a careful accountant would expect. Invented data only. Failing checks are soft (expect.soft), so one
// run reports every scenario; each also logs what Bookr did ([audit] lines).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';
import { buildSalesCsv, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 600_000 });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pad = (n: number) => String(n).padStart(2, '0');
/** 'D HH:MM': D is 30 or 31 (October) or 1, 2 (November). */
const at = (s: string) => {
  const [d, hm] = s.split(' ');
  const [hh, mm] = hm.split(':').map(Number);
  const dd = Number(d);
  const mo = dd >= 30 ? 10 : 11;
  return {
    csv: `${pad(dd)}-${pad(mo)}-2026.${pad(hh)}:${pad(mm)}:00`,
    bank: `${pad(dd)}/${pad(mo)}/2026 ${hh % 12 === 0 ? 12 : hh % 12}:${pad(mm)}:00 ${hh < 12 ? 'AM' : 'PM'}`,
    ms: istToMs(2026, mo, dd, hh, mm, 0),
  };
};
const log = (name: string, what: unknown) => console.log(`[audit] ${name}: ${JSON.stringify(what)}`);

const HEAD = ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t');
let tran = 0;

type Pay = [mode: 'cash' | 'upi' | 'card', amount: string, label?: string];
interface Reg { no: string; amount: string; pays: Pay[]; discount?: string; paidWith?: string; day?: string }

async function hotel() {
  const h = await businessWithAllRoles('Audit Hotel');
  const o = h.clients.owner;
  const fnb = (await o.post(`/businesses/${h.bid}/heads`, { name: 'F&B', type: 'income' })).json.id;
  const room = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Room', type: 'income' })).json.id;
  await o.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: fnb });
  await o.put(`/businesses/${h.bid}/bill-type-heads/room`, { headId: room });
  const accounts: Record<string, string> = {};
  const pages: Record<string, string> = {};
  const rows: Record<string, string> = {};
  const self = {
    ...h, fnb, accounts, rows,
    /** The software report: one file covering 31 Oct 00:00 to 1 Nov 23:59. */
    async software(bills: [no: string, when: string, mode: SampleBill['mode'], amount: string][]) {
      const list: SampleBill[] = bills.map(([bill, when, mode, amount]) => ({ pos: 'POS-1', bill, when: at(when).csv, name: 'U/N', mode, amount }));
      const res = await o.post(`/businesses/${h.bid}/sales-reports`, { day: '2026-10-31', csv: buildSalesCsv(list),
        coversFrom: istToMs(2026, 10, 31, 0, 0, 0), coversTo: istToMs(2026, 11, 1, 23, 59, 59) });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
    },
    async register(list: Reg[]) {
      for (const r of list) {
        const day = r.day ?? '2026-10-31';
        if (!pages[day]) {
          const page = await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=${day}`, new Uint8Array([...PNG, Object.keys(pages).length + 1]), 'image/png');
          expect(page.status).toBe(201);
          pages[day] = page.json.id;
        }
        const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pages[day]}/register-rows`, {
          billNo: r.no, billType: 'fnb', amount: r.amount, discount: r.discount ?? '0', status: 'checked',
          payments: r.pays.map(([mode, amount, label]) => ({ mode, amount, columnLabel: label ?? (mode === 'upi' ? 'UPI XOXO' : mode === 'card' ? 'Card' : 'Cash') })),
          ...(r.paidWith ? { paidWithRowId: rows[r.paidWith] } : {}),
        });
        expect(res.status, `${r.no}: ${JSON.stringify(res.json)}`).toBe(201);
        rows[r.no] = res.json.id;
      }
    },
    async account(name: string, label: string) {
      const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name, kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
      expect((await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: label })).status).toBe(200);
      accounts[name] = acc;
      return acc as string;
    },
    /** UPI credits into an account (default HUF A, label UPI XOXO). Returns their row ids by "when|amount". */
    async credits(list: [when: string, amount: number][], account = 'HUF A') {
      const lines = list.map(([when, amount]) => {
        tran += 1;
        return [tran, `S${String(50000000 + tran)}`, at(when).bank.slice(0, 10), at(when).bank, '-', `UPI/7${String(10000000000 + tran)}/Paid/p${tran}@okaxis/SAMPLE BANK/ICIa`, 'CR', amount, String(amount)].join('\t');
      });
      const res = await o.post(`/businesses/${h.bid}/bank/${accounts[account]}/paste`, { text: [HEAD, ...lines].join('\n') });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const ids: string[] = [];
      for (let i = tran - list.length + 1; i <= tran; i++) ids.push((await sql`SELECT id FROM bank_rows WHERE tran_id = ${`S${String(50000000 + i)}`}`)[0]?.id);
      return ids;
    },
    async swipe(when: string, amount: number, scheme = 'VISA') {
      const id = crypto.randomUUID();
      await sql`INSERT INTO card_settlements (id, business_id, file_name, settled_on, merchant_id, terminal_id, txn_id, paid_at, txn_type, amount_paise, fee_paise, gst_paise,
        net_paise, scheme, card_last4, created_at) VALUES (${id}, ${h.bid}, 'x_ICICI_POS_CD.xlsx', '2026-11-02', 'M1', 'TT000001', ${'TT_' + id}, ${at(when).ms}, 'PURCHASE',
        ${amount * 100}, 0, 0, ${amount * 100}, ${scheme}, ${scheme === 'UPI' ? null : '4242'}, ${Date.now()})`;
      return id;
    },
    view: (day = '2026-10-31') => o.get(`/businesses/${h.bid}/shifts/${day}`),
    reconcile: async (day = '2026-10-31') => (await o.get(`/businesses/${h.bid}/shifts/${day}/reconcile`)).json,
    entries: async (day = '2026-10-31') => (await o.get(`/businesses/${h.bid}/shifts/${day}/entries`)).json,
    async decideRest(day = '2026-10-31', pick: (c: any) => string | undefined = () => undefined) {
      const v = await self.view(day);
      for (const x of v.json.comparisons) {
        if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
        const decision = pick(x) ?? (x.register ? 'use_register' : 'use_software');
        const res = await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision, billType: 'fnb', note: 'audit' });
        expect(res.status, `${x.billNo} ${decision}: ${JSON.stringify(res.json)}`).toBe(200);
      }
    },
    async confirm(day = '2026-10-31') {
      const res = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/${day}/confirm`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return res.json;
    },
  };
  return self;
}
const bill = (v: any, no: string) => v.json.comparisons.find((c: any) => c.billNo === no);
const statusOf = async (id: string) => (await sql`SELECT status FROM bank_rows WHERE id = ${id}`)[0]?.status;
const matchedTo = async (id: string) => (await sql`SELECT t.bill_no FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.bank_row_id = ${id} ORDER BY t.bill_no`).map((r: any) => r.bill_no);

describe('UPI pairing before saving, and what saving matches', () => {
  it('one shift holding many single-bill scenarios, each with its own amount', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([
      ['2610311', '31 09:00', 'UPI', '510'], ['2610312', '31 09:10', 'UPI', '510'],            // S1 crossed
      ['2610313', '31 10:00', 'UPI', '520'], ['2610314', '31 10:30', 'UPI', '520'],            // S2 one credit for two
      ['2610315', '31 11:00', 'UPI', '530'],                                                    // S3 credit 61 min after
      ['2610316', '31 13:00', 'UPI', '540'],                                                    // S4a credit 90 min before
      ['2610317', '31 15:00', 'UPI', '550'],                                                    // S4b credit 130 min before
      ['26103110', '31 16:00', 'UPI', '1000'],                                                  // S6 two goes, one missing
      ['26103111', '31 16:30', 'UPI', '1100'],                                                  // S6b two goes, one credit of the whole
      ['26103112', '31 17:00', 'UPI', '1500'],                                                  // S9 mixed cash + UPI
      ['26103113', '31 12:00', 'UPI', '403'],                                                   // S11 mode slip
      ['26103114', '31 13:30', 'UPI', '4410'],                                                  // S12 amount slip, a credit of each
      ['26103115', '31 21:30', 'UPI', '610'], ['26103116', '31 21:50', 'UPI', '890'],          // S13 credit = sum of two bills
      ['26103117', '31 18:00', 'UPI', '620'],                                                   // left out, yet a credit came
      ['26103118', '31 19:00', 'UPI', '630'],                                                   // paid twice by the guest
      ['26103119', '1 07:50', 'UPI', '850'], ['2611011', '1 08:10', 'UPI', '850'],              // S10 across 8 am
      ['26103121', '31 09:30', 'UPI', '580'],                                                   // S5c timed bill, no credit near
      ['26103122', '31 20:30', 'UPI', '740'],                                                   // bank-not-in: no credit at all
      ['26103123', '31 20:45', 'UPI', '660'],                                                   // software only, its credit came
    ]);
    await h.register([
      { no: '2610311', amount: '510', pays: [['upi', '510']] }, { no: '2610312', amount: '510', pays: [['upi', '510']] },
      { no: '2610313', amount: '520', pays: [['upi', '520']] }, { no: '2610314', amount: '520', pays: [['upi', '520']] },
      { no: '2610315', amount: '530', pays: [['upi', '530']] },
      { no: '2610316', amount: '540', pays: [['upi', '540']] },
      { no: '2610317', amount: '550', pays: [['upi', '550']] },
      { no: '2610318', amount: '560', pays: [['upi', '560']] },                                 // S5 register only, two credits
      { no: '2610319', amount: '570', pays: [['upi', '570']] },                                 // S5b register only, one credit
      { no: '26103110', amount: '1000', pays: [['upi', '600'], ['upi', '400']] },
      { no: '26103111', amount: '1100', pays: [['upi', '700'], ['upi', '400']] },
      { no: '26103112', amount: '1500', pays: [['cash', '500'], ['upi', '1000']] },
      { no: '26103113', amount: '403', pays: [['cash', '403']] },
      { no: '26103114', amount: '4400', pays: [['upi', '4400']] },
      { no: '26103115', amount: '610', pays: [['upi', '610']] }, { no: '26103116', amount: '890', pays: [['upi', '890']] },
      // 26103117 is in the software only (a bill left out of the register); 26103123 likewise, kept.
      { no: '26103118', amount: '630', pays: [['upi', '630']] },
      { no: '26103119', amount: '850', pays: [['upi', '850']] },
      { no: '2611011', amount: '850', pays: [['upi', '850']], day: '2026-11-01' },
      { no: '26103120', amount: '580', pays: [['upi', '580']] },                                // S5c register only
      { no: '26103121', amount: '580', pays: [['upi', '580']] },
      { no: '26103122', amount: '740', pays: [['upi', '740']] },
    ]);
    const [s1a, s1b, s2, s3, s4a, s4b, s5a, s5b, s5ctrl, s6, s6b, s9, s11, s12reg, s12sw, s13, lo, dupA, dupB, s10, s5c, swOnly] = await h.credits([
      ['31 09:08', 510], ['31 09:40', 510],
      ['31 10:20', 520],
      ['31 12:01', 530],
      ['31 11:30', 540],
      ['31 12:50', 550],
      ['31 10:45', 560], ['31 17:10', 560],
      ['31 14:30', 570],
      ['31 16:05', 600],
      ['31 16:35', 1100],
      ['31 17:05', 1000],
      ['31 12:03', 403],
      ['31 13:28', 4400], ['31 13:33', 4410],
      ['31 22:00', 1500],
      ['31 18:05', 620],
      ['31 19:01', 630], ['31 19:02', 630],
      ['1 08:05', 850],
      ['31 20:00', 580],
      ['31 20:47', 660],
    ]);

    // Bank not yet in (last line 1 Nov 8:05 is in, so first test the "not in" picture on a copy of the rule: see below).
    let v = await h.view();
    log('bank covered with last line 08:05', v.json.bank.covered);

    // S1 crossed times: both bills get a credit, each a different one.
    const p1 = [bill(v, '2610311').bank?.creditId, bill(v, '2610312').bank?.creditId];
    log('S1 crossed', p1.map((id) => (id === s1a ? '09:08' : id === s1b ? '09:40' : id)));
    expect.soft(new Set(p1.filter(Boolean)).size, 'S1: both 510 bills paired to distinct credits').toBe(2);

    // S2 two bills, one credit: exactly one paired (the closer, 2610314), the other left without.
    log('S2 one credit two bills', { a: bill(v, '2610313').bank?.minutes ?? null, b: bill(v, '2610314').bank?.minutes ?? null });
    expect.soft([bill(v, '2610313').bank, bill(v, '2610314').bank].filter(Boolean).length, 'S2: one of the two 520 bills paired').toBe(1);

    // S3 61 min after: not paired before saving, but told as a credit with a bill of its amount waiting.
    const open3 = v.json.bank.open.find((c: any) => c.id === s3);
    log('S3 61 min after', { bank: bill(v, '2610315').bank, open: open3 });
    expect.soft(bill(v, '2610315').bank, 'S3: 61 min after is not a clear pair').toBeNull();
    expect.soft(open3?.why, 'S3: the credit is shown with the waiting 530 bill').toBe('unpaired');

    // S4 paid then closed later: 90 min before pairs (only credit of the amount); 130 min before does not.
    log('S4 90 min before', bill(v, '2610316').bank);
    log('S4 130 min before', bill(v, '2610317').bank);
    expect.soft(bill(v, '2610316').bank?.creditId, 'S4a: credit 90 min before the bill pairs').toBe(s4a);
    expect.soft(bill(v, '2610317').bank, 'S4b: 130 min before is outside the look-back').toBeNull();

    // S5 register-only with two candidate credits: not paired. With one credit: paired.
    log('S5 register only, two credits', bill(v, '2610318').bank);
    log('S5b register only, one credit', bill(v, '2610319').bank);
    expect.soft(bill(v, '2610318').bank, 'S5: register-only bill with two credits is not paired').toBeNull();
    expect.soft(bill(v, '2610319').bank?.creditId, 'S5b: register-only bill with its only credit pairs').toBe(s5ctrl);
    // S5c register-only bill; the only credit of its amount is 10.5 h away from the one timed bill of that amount.
    log('S5c register-only blocked by a far timed bill', { regOnly: bill(v, '26103120').bank, timed: bill(v, '26103121').bank });
    expect.soft(bill(v, '26103120').bank?.creditId, 'S5c: a timed bill 10 h away should not block the register-only pair').toBe(s5c);

    // S6 two UPI goes (600 + 400), only the 600 came: no pair (all or none), and the 600 is not "money with no bill".
    log('S6 one go missing', { bank: bill(v, '26103110').bank, noBill: v.json.bank.noBill.some((c: any) => c.id === s6), open: v.json.bank.open.find((c: any) => c.id === s6) });
    expect.soft(bill(v, '26103110').bank, 'S6: all-or-none').toBeNull();
    expect.soft(v.json.bank.noBill.some((c: any) => c.id === s6), 'S6: the ₹600 is part of bill 26103110, not money with no bill').toBe(false);

    // S6b register wrote two goes (700 + 400), the bank shows one ₹1,100: shown as backed before saving.
    log('S6b two goes written, one credit', bill(v, '26103111').bank);

    // S9 mixed cash 500 + UPI 1000; software says UPI 1500; a ₹1,000 credit: backs the register.
    log('S9 mixed', { diff: bill(v, '26103112').difference, bank: bill(v, '26103112').bank });
    expect.soft(bill(v, '26103112').bank?.creditId, 'S9: the ₹1,000 credit pairs with the UPI part').toBe(s9);
    expect.soft(bill(v, '26103112').bank?.suggest, 'S9: the credit backs the register split (cash 500 + UPI 1000)').toBe('use_register');

    // S11 mode slip: register cash, software UPI, a credit of 403 at 12:03 → Use software.
    log('S11 mode slip', bill(v, '26103113').bank);
    expect.soft(bill(v, '26103113').bank?.suggest, 'S11: suggests Use software').toBe('use_software');

    // S12 amount slip, a credit of each amount: neither side can be chosen from the bank alone.
    const b12 = bill(v, '26103114');
    log('S12 amount slip, credit of each', { bank: b12.bank, other: v.json.bank.open.find((c: any) => c.id === (b12.bank?.creditId === s12reg ? s12sw : s12reg)) });
    expect.soft(b12.bank?.suggest ?? null, 'S12: with a credit for each side, the bank should not pick a side').toBeNull();

    // S13 credit equal to two unrelated bills: a table card offered (not auto-matched); the two bills not told "no credit".
    const trial = await h.reconcile();
    log('trial: clear', trial.clear.map((x: any) => [x.billNos, x.amountPaise, x.part]));
    log('trial: open bills', trial.open.bills.map((x: any) => [x.billNo, x.amountPaise]));
    log('trial: noCredit', trial.noCredit.map((x: any) => [x.kind, x.billNos, x.title]));
    log('trial: slips', trial.slips);
    const table = trial.fixes.find((c: any) => c.kind === 'one_credit_many_bills');
    log('S13 trial table card', table && { billNos: table.billNos, actions: table.actions.length });
    expect.soft(table?.billNos?.sort(), 'S13: offered as one table').toEqual(['26103115', '26103116']);

    // Left out (cancelled), yet a credit of its amount came: the credit should be told as money with no counted bill.
    log('software-only bills before deciding', { lo: [bill(v, '26103117').difference, bill(v, '26103117').decision, bill(v, '26103117').bank?.creditId === lo],
      kept: [bill(v, '26103123').decision, bill(v, '26103123').bank?.creditId === swOnly] });
    const left = await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${bill(v, '26103117').id}`, { decision: 'leave_out', note: 'Cancelled in POS' });
    expect(left.status, JSON.stringify(left.json)).toBe(200);
    v = await h.view();
    const openLo = v.json.bank.open.find((c: any) => c.id === lo);
    log('left out with a credit', { noBill: v.json.bank.noBill.some((c: any) => c.id === lo), open: openLo });
    expect.soft(v.json.bank.noBill.some((c: any) => c.id === lo) || openLo?.why === 'no_bill', 'left out: ₹620 credit has no counted bill').toBe(true);

    // Paid twice: one credit pairs, the other is told as extra money of a common amount.
    const dup = bill(v, '26103118').bank?.creditId;
    const extra = v.json.bank.open.find((c: any) => c.id === (dup === dupA ? dupB : dupA));
    log('paid twice', { paired: dup === dupA ? '19:01' : dup, other: extra?.why });
    expect.soft(extra?.why, 'paid twice: the second ₹630 is extra').toBe('extra');

    // S10 across 8 am: one ₹850 credit at 8:05; a 31 Oct bill at 7:50 and a 1 Nov bill at 8:10. One shift only takes it.
    const nov1 = await h.view('2026-11-01');
    const a10 = bill(v, '26103119').bank?.creditId === s10;
    const b10 = bill(nov1, '2611011')?.bank?.creditId === s10;
    log('S10 across 8 am', { oct31Bill: a10, nov1Bill: b10 });
    expect.soft(Number(a10) + Number(b10), 'S10: the credit is offered to one bill only').toBe(1);

    // Rule (6)/no credit: with the bank in, the ₹740 bill (no credit anywhere) waits; nothing is invented.
    expect.soft(bill(v, '26103122').bank).toBeNull();

    // Reconcile tabs, before saving: UPI tab lists each bill once with its evidence.
    const e = await h.entries();
    const upi = e.upi.entries.filter((x: any) => x.billNo === '26103112');
    log('tabs mixed bill before saving', e.cash.entries.filter((x: any) => x.billNo === '26103112').concat(upi).map((x: any) => [x.mode, x.amountPaise, x.state, x.evidence]));

    // Save: decisions follow the bank where it suggests, else the register.
    await h.decideRest('2026-10-31', (c) => (c.bank?.suggest ?? undefined));
    const done = await h.confirm();
    log('confirm', done);
    // What saving matched.
    const m = async (id: string) => ({ status: await statusOf(id), bills: await matchedTo(id) });
    const after = { lo: await m(lo), swOnly: await m(swOnly), s1a: await m(s1a), s1b: await m(s1b), s2: await m(s2), s4a: await m(s4a), s5b: await m(s5ctrl), s6b: await m(s6b), s9: await m(s9), s11: await m(s11), s12reg: await m(s12reg), s12sw: await m(s12sw), s10: await m(s10) };
    log('after confirm', after);
    expect.soft(after.s1a.bills.length + after.s1b.bills.length, 'S1: both matched on save').toBe(2);
    expect.soft(after.s6b.status, 'S6b: the credit Compare showed as backing bill 26103111 is matched on save (or the bill is flagged)').toBe('matched');
    expect.soft(after.s9.bills, 'S9: the ₹1,000 matched to the UPI part on save').toEqual(['26103112']);

    // After saving: the 61-min and 130-min credits come up as likely; the table as a card; the unpaired 530/550 not "no credit".
    const rec = await h.reconcile();
    log('after save: likely', rec.likely.map((x: any) => [x.billNos, x.amountPaise, x.minutes]));
    log('after save: clear', rec.clear.map((x: any) => [x.billNos, x.amountPaise, x.minutes]));
    log('after save: fixes', rec.fixes.map((x: any) => [x.kind, x.billNos]));
    log('after save: noCredit', rec.noCredit.map((x: any) => [x.kind, x.billNos]));
    log('after save: noBill', rec.noBill.map((x: any) => x.amountPaise));
    const offered = [...rec.clear, ...rec.likely].map((x: any) => x.billNos.join('+'));
    expect.soft(offered, 'S3 after save: 61 min after offered').toContain('2610315');
    expect.soft(offered, 'S4b after save: 130 min before offered').toContain('2610317');
    // S6b is matched on save now, so it is not offered again.
    expect.soft(rec.fixes.some((x: any) => x.kind === 'one_credit_many_bills' && x.billNos.sort().join() === '26103115,26103116'), 'S13 after save: table card').toBe(true);
    expect.soft(rec.fixes.some((x: any) => x.billNos.includes('26103117')), 'left out after save: the explainer never offers to join a bill that was left out').toBe(false);
    expect.soft(rec.noBill.map((x: any) => x.amountPaise), 'S12 after save: the ₹4,410 credit equals software bill 26103114, so not "no bill"').not.toContain(441000);
    const twin = rec.noCredit.find((x: any) => x.billNos.includes('2610313') || x.billNos.includes('2610314'));
    expect.soft(!twin || /went to bill/.test(twin.title), 'S2 after save: the unpaired 520 bill is told its twin took the one credit, not "no UPI payment"').toBe(true);
    expect.soft(rec.noBill.map((x: any) => x.amountPaise), 'S6 after save: ₹600 is half of a bill, not money with no bill').not.toContain(60000);
    void s5a; void s5b;
  });

  it('bank not yet in: nothing is said missing', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 12:00', 'UPI', '740'], ['2610312', '31 13:00', 'UPI', '403']]);
    await h.register([{ no: '2610311', amount: '740', pays: [['upi', '740']] }, { no: '2610312', amount: '403', pays: [['cash', '403']] }]);
    await h.credits([['31 15:00', 777], ['1 07:00', 5]]);          // last line 7:00: before 8:00 − 30 min
    const v = await h.view();
    log('not in: bank', { covered: v.json.bank.covered, noBill: v.json.bank.noBill, left: v.json.bank.left, none: bill(v, '2610312').bankNone });
    expect.soft(v.json.bank.covered).toBe(false);
    expect.soft(v.json.bank.noBill).toEqual([]);
    expect.soft(bill(v, '2610312').bankNone).toBeNull();
    const t = await h.reconcile();
    log('not in: trial', { noCredit: t.noCredit.length, open: t.open.credits.length });
    expect.soft(t.noCredit).toEqual([]);
    // Coverage edge: a line at exactly 7:30 counts as in.
    await h.credits([['1 07:30', 6]]);
    expect.soft((await h.view()).json.bank.covered, 'a line at 7:30 counts as in').toBe(true);
  });
});

describe('bills paid together', () => {
  it('a group with a discount, a group short by ₹2, a group whose credit came into the other account; the tabs before and after saving', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.account('HUF B', 'UPI Bank 2');
    await h.software([
      ['2610311', '31 12:00', 'UPI', '300'], ['2610312', '31 12:05', 'UPI', '500'],     // G1 paid 798, ₹2 discount written
      ['2610313', '31 14:00', 'UPI', '400'], ['2610314', '31 14:05', 'UPI', '600'],     // G2 written 1,000, bank 998
      ['2610315', '31 16:00', 'UPI', '700'], ['2610316', '31 16:05', 'UPI', '500'],     // G3 credit in the other account
    ]);
    await h.register([
      { no: '2610311', amount: '300', discount: '2', pays: [['upi', '798']] }, { no: '2610312', amount: '500', pays: [], paidWith: '2610311' },
      { no: '2610313', amount: '400', pays: [['upi', '1000']] }, { no: '2610314', amount: '600', pays: [], paidWith: '2610313' },
      { no: '2610315', amount: '700', pays: [['upi', '1200']] }, { no: '2610316', amount: '500', pays: [], paidWith: '2610315' },
    ]);
    const [g1, g2] = await h.credits([['31 12:10', 798], ['31 14:10', 998], ['1 08:30', 3]]);
    const [g3] = await h.credits([['31 16:08', 1200]], 'HUF B');
    const v = await h.view();
    const grp = (no: string) => v.json.paidGroups.find((g: any) => g.billNos.includes(no));
    log('G1', { bank: grp('2610311').bank, why: grp('2610311').why, matched: grp('2610311').matched });
    log('G2', { bank: grp('2610313').bank, open: v.json.bank.open.find((c: any) => c.id === g2) });
    log('G3', { bank: grp('2610315').bank, hints: v.json.columnHints });
    log('blockers', v.json.blockers);
    expect.soft(grp('2610311').bank?.creditId, 'G1: ₹798 credit for the group').toBe(g1);
    expect.soft(grp('2610315').bank, 'G3: credit in the other account is not paired').toBeNull();
    expect.soft((v.json.columnHints ?? []).some((x: any) => x.creditId === g3 || x.billNo === '2610315'), 'G3: told the payment may be under the wrong column').toBe(true);
    const t = await h.reconcile();
    log('G2 trial', { fixes: t.fixes.map((x: any) => [x.kind, x.billNos]), open: t.open.credits.find((c: any) => c.id === g2), slips: t.slips });
    expect.soft(JSON.stringify([t.fixes, t.slips ?? null]).includes(g2), 'G2: the ₹998 credit is offered for the ₹1,000 group (₹2 short)').toBe(true);

    // Reconcile tabs before saving: the UPI tab should add up to what was paid by UPI (798 + 1,000 + 1,200 = 2,998).
    let e = await h.entries();
    log('tabs before saving: UPI', e.upi.entries.map((x: any) => [x.billNo, x.amountPaise, x.state, x.evidence]));
    expect.soft(e.upi.totalPaise, 'tabs before saving: UPI total equals the UPI paid').toBe(299800);

    await h.decideRest();
    log('confirm', await h.confirm());
    log('G1 after save', { status: await statusOf(g1), bills: await matchedTo(g1) });
    expect.soft(await matchedTo(g1), 'G1 matched to both bills on save').toEqual(['2610311', '2610312']);
    e = await h.entries();
    log('tabs after saving: UPI', e.upi.entries.map((x: any) => [x.billNo, x.amountPaise, x.state]));
    expect.soft(e.upi.totalPaise, 'tabs after saving: UPI total').toBe(299800);
    const rec = await h.reconcile();
    log('after save G2/G3', { likely: rec.likely.map((x: any) => [x.billNos, x.amountPaise]), fixes: rec.fixes.map((x: any) => [x.kind, x.billNos]), noBill: rec.noBill.map((x: any) => x.amountPaise), slips: rec.slips });
    expect.soft(rec.noBill.map((x: any) => x.amountPaise), 'G2 after save: ₹998 is not "money with no bill"').not.toContain(99800);
  });
});

describe('a same-sale choice made before saving', () => {
  it('two bills chosen to join the same booked credit: only one may take it', async () => {
    const h = await hotel();
    await h.account('HUF B', 'UPI Bank 2');
    await h.software([['2610311', '31 12:00', 'UPI', '650'], ['2610312', '31 18:00', 'UPI', '650']]);
    await h.register([{ no: '2610311', amount: '650', pays: [['upi', '650', 'UPI Bank 2']] }, { no: '2610312', amount: '650', pays: [['upi', '650', 'UPI Bank 2']] }]);
    const [booked] = await h.credits([['30 19:00', 650], ['1 08:30', 3]], 'HUF B');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${booked}/book`, { headId: h.fnb, note: 'Sale' })).status).toBe(200);
    const v = await h.view();
    const a = await h.clients.owner.post(`/businesses/${h.bid}/comparisons/${bill(v, '2610311').id}/same-sale`, { rowId: booked });
    const b = await h.clients.owner.post(`/businesses/${h.bid}/comparisons/${bill(v, '2610312').id}/same-sale`, { rowId: booked });
    log('plans', [a.status, b.status]);
    expect.soft(b.status, 'the second plan on a credit already chosen is refused').toBe(409);
    const t = await h.reconcile();
    log('trial same-sale cards', t.fixes.filter((x: any) => x.kind === 'same_sale').map((x: any) => x.billNos));
    log('confirm', await h.confirm());
    const income = await sql`SELECT bill_no, source, day, matched_bank_row, match_status, status FROM transactions WHERE business_id = ${h.bid} AND type = 'income' AND amount_paise = 65000 ORDER BY bill_no`;
    log('income ₹650 after save', income);
    expect.soft(income.filter((x: any) => x.matched_bank_row === booked).length, 'one sale joins the booked credit').toBe(1);
    expect.soft(income.length, 'two bills + no double count: 2 sales in all (booking replaced by one)').toBe(2);
    expect.soft((await sql`SELECT count(*) AS n FROM bank_matches WHERE bank_row_id = ${booked}`)[0].n, 'credit matched once').toBe(1);
  });
});

describe('card machine', () => {
  it('swipe 25 min away, two same-amount bills crossed, UPI on the machine for a cash bill, a tip, a safe pair, a card bill paid by UPI', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([
      ['2610311', '31 11:30', 'CARD', '942'],                                        // C1 swipe 25 min after
      ['2610312', '31 19:00', 'CARD', '1200'], ['2610313', '31 19:10', 'CARD', '1200'], // C2 crossed
      ['2610314', '31 15:20', 'CASH', '650'],                                        // C3 UPI on machine, written cash
      ['2610315', '31 20:00', 'CARD', '1000'],                                       // C4 tip
      ['2610316', '31 10:00', 'CARD', '777'],                                        // C5 safe pair
      ['2610317', '31 13:00', 'CARD', '880'],                                        // C6 no swipe; UPI credit 40 min later
    ]);
    await h.register([
      { no: '2610311', amount: '942', pays: [['card', '942']] },
      { no: '2610312', amount: '1200', pays: [['card', '1200']] }, { no: '2610313', amount: '1200', pays: [['card', '1200']] },
      { no: '2610314', amount: '650', pays: [['cash', '650']] },
      { no: '2610315', amount: '1000', pays: [['card', '1000']] },
      { no: '2610316', amount: '777', pays: [['card', '777']] },
      { no: '2610317', amount: '880', pays: [['card', '880']] },
    ]);
    const c1 = await h.swipe('31 11:55', 942);
    const c2a = await h.swipe('31 19:08', 1200);
    const c2b = await h.swipe('31 19:12', 1200);
    const c3 = await h.swipe('31 15:22', 650, 'UPI');
    const c4 = await h.swipe('31 20:05', 1100);
    const c5 = await h.swipe('31 10:05', 777);
    await h.swipe('1 09:00', 1);                                                     // the report runs past the shift
    const [up] = await h.credits([['31 13:40', 880], ['1 08:30', 3]]);
    await h.decideRest();
    const res = await h.confirm();
    log('confirm', res);
    const matchOf = async (pid: string) => (await sql`SELECT t.bill_no, m.matched_by FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.settlement_id = ${pid}`).map((r: any) => r.bill_no);
    const auto = { c1: await matchOf(c1), c2a: await matchOf(c2a), c2b: await matchOf(c2b), c4: await matchOf(c4), c5: await matchOf(c5) };
    log('auto-matched on save', auto);
    expect.soft(auto.c5, 'C5: safe pair within 20 min auto-matched').toEqual(['2610316']);
    expect.soft(auto.c1, 'C1: 25 min is not auto').toEqual([]);
    expect.soft([...auto.c2a, ...auto.c2b], 'C2: crossed same amounts are not auto').toEqual([]);
    expect.soft(auto.c4, 'C4: a tip is not auto').toEqual([]);
    const k = (await h.reconcile()).cards;
    const need = (id: string) => k.needs.find((n: any) => n.payment.id === id);
    log('C1 needs', need(c1) && { why: need(c1).why, c: need(c1).candidates.map((x: any) => [x.billNos, x.minutes]) });
    log('C2 needs', [need(c2a), need(c2b)].map((n: any) => n && { why: n.why, c: n.candidates.map((x: any) => [x.billNos, x.minutes]) }));
    log('C3 needs', need(c3) && { why: need(c3).why, written: need(c3).written });
    log('C4 needs', need(c4) && { why: need(c4).why, tip: need(c4).tip });
    log('C6 noSwipe', k.noSwipe.map((x: any) => [x.billNo, x.upi?.creditId === up, x.upi?.minutes]));
    expect.soft(need(c1)?.candidates?.[0]?.billNos, 'C1: offered').toEqual(['2610311']);
    expect.soft(need(c2a)?.candidates?.length, 'C2: both bills offered for each swipe').toBe(2);
    expect.soft(need(c2a)?.candidates?.[0]?.billNos?.[0] !== need(c2b)?.candidates?.[0]?.billNos?.[0], 'C2: the first choices differ').toBe(true);
    expect.soft(need(c3)?.why, 'C3: UPI on machine for a cash bill → Change to card').toBe('written');
    expect.soft(need(c3)?.written?.billNo).toBe('2610314');
    expect.soft(need(c4)?.tip?.tipPaise, 'C4: ₹100 tip').toBe(10000);
    expect.soft(k.noSwipe.find((x: any) => x.billNo === '2610317')?.upi?.creditId, 'C6: card bill with no swipe → the UPI credit 40 min later').toBe(up);
    // The UPI side does not also call the ₹880 credit "money with no bill".
    const rec = await h.reconcile();
    log('C6 UPI side', { noBill: rec.noBill.map((x: any) => x.amountPaise), explains: rec.cards.explains });
    // The Card tab after saving.
    const e = await h.entries();
    log('card tab', e.card.entries.map((x: any) => [x.billNo, x.state, x.evidence]));
  });
});
