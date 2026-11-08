// Phase 3, part 2: card settlement reports (ICICI POS layout), by mail or dropped in, matched to card sales and the bank.
// Invented payments only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, env, resetDb, sql } from './helpers';
import { parseCardReport, readCardReport } from '../src/cardsettlement';
import { autoPairs, cardCandidates, settlementDateOf, shiftCards, type CardSale } from '../src/cards';
import { receiveMail } from '../src/mail';
import { folderIdFrom } from '../src/google';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const HEAD = ['Date of Settlement Initiation', 'Merchant ID', 'Terminal ID', 'TXN DT', 'Batch Number', 'RRN', 'Mode of Payment', 'Scheme Name',
  'Card Type', 'Card Category', 'Settlement Currency', 'Transaction Amount', 'Transaction Charges', 'GST', 'Net Settlement Amount',
  'Transaction Date', 'Transaction ID', 'Transaction Type', 'Card Number', 'AUTHCODE', 'Card Program', 'UTR Transaction Reference No'];
const pay = (settled: string, at: string, amount: string, fee: string, gst: string, net: string, id: string, card = '************1111') =>
  [settled, '900000000000001', 'TT000001', at.slice(0, 6) + at.slice(8, 10), '000001', `6300000${id}`, 'CARDS', 'VISA', 'CREDIT', 'Domestic Card', 'INR',
    amount, fee, gst, net, at, `TT000001_${id}`, 'PURCHASE', card, 'A1', 'PREMIUM', ''];
// Two payments settled on 5 Nov: one in the 3 Nov shift (before 8 am on 4 Nov), one in the 4 Nov shift.
const REPORT = [
  HEAD,
  pay('05-NOV-2026', '04-11-2026 02:38:24', '648.0', '-11.53', '0.0', '636.47', '00001'),
  pay('05-NOV-2026', '04-11-2026 22:45:38', '2727.0', '-48.54', '-8.74', '2669.72', '00002', '************2222'),
  ['05-NOV-2026', '900000000000001', 'TT000001', 'TID Subtotal', '', '', '', '', '', '', '', '3375.0', '-60.07', '-8.74', '3306.19'],
  ['05-NOV-2026', '900000000000001', 'MID Subtotal', '', '', '', '', '', '', '', '', '3375.0', '-60.07', '-8.74', '3306.19'],
  ['Grand Total', '', '', '', '', '', '', '', '', '', '', '3375.0', '-60.07', '-8.74', '3306.19'],
];

// ---- A small .xlsx, written the way the card company's files are (inline strings, numbers as numbers), stored uncompressed.
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const colName = (i: number) => String.fromCharCode(65 + i);
function sheetXml(rows: string[][]) {
  const cells = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : /^-?\d+\.\d+$/.test(v)
    ? `<c r="${colName(ci)}${ri + 1}" t="n"><v>${v}</v></c>` : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`)).join('')}</row>`);
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells.join('')}</sheetData></worksheet>`;
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files: Record<string, string>) {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const dir: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const n = enc.encode(name);
    const offset = parts.length;
    const crc = crc32(data);
    u32(parts, 0x04034b50); u16(parts, 20); u16(parts, 0); u16(parts, 0); u16(parts, 0); u16(parts, 0); u32(parts, crc); u32(parts, data.length); u32(parts, data.length);
    u16(parts, n.length); u16(parts, 0); parts.push(...n, ...data);
    u32(dir, 0x02014b50); u16(dir, 20); u16(dir, 20); u16(dir, 0); u16(dir, 0); u16(dir, 0); u16(dir, 0); u32(dir, crc); u32(dir, data.length); u32(dir, data.length);
    u16(dir, n.length); u16(dir, 0); u16(dir, 0); u16(dir, 0); u16(dir, 0); u32(dir, 0); u32(dir, offset); dir.push(...n);
    count += 1;
  }
  const end: number[] = [];
  u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, count); u16(end, count); u32(end, dir.length); u32(end, parts.length); u16(end, 0);
  return new Uint8Array([...parts, ...dir, ...end]);
}
const xlsx = (rows: string[][]) => zip({ 'xl/sharedStrings.xml': '<sst/>', 'xl/worksheets/sheet1.xml': sheetXml(rows) });
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe('reading the card report', () => {
  it('reads payments, skips subtotals, keeps fee and GST positive and checks the Grand Total', async () => {
    const r = await readCardReport(xlsx(REPORT));
    expect(r.problems).toEqual([]);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ settledOn: '2026-11-05', terminalId: 'TT000001', txnId: 'TT000001_00001', amountPaise: 64800, feePaise: 1153, gstPaise: 0,
      netPaise: 63647, cardLast4: '1111', txnType: 'PURCHASE', scheme: 'VISA' });
    expect(r.lines[0].paidAt).toBe(istToMs(2026, 11, 4, 2, 38, 24));
    expect(r.lines[1]).toMatchObject({ amountPaise: 272700, feePaise: 4854, gstPaise: 874, netPaise: 266972 });
  });
  it('says what is wrong', async () => {
    const bad = REPORT.map((r) => [...r]);
    bad[5][11] = '3376.0';
    expect(parseCardReport(bad).problems).toEqual(['The payments do not add up to the Grand Total amount.']);
    expect(parseCardReport([['a', 'b'], ['1', '2']]).problems[0]).toMatch(/not a card settlement report/);
    expect((await readCardReport(new TextEncoder().encode('hello'))).problems[0]).toMatch(/could not be opened/);
  });
  it('the bank credit carries the settlement date', () => {
    expect(settlementDateOf('EZY/ICICIPOS_SET_10XX000000_051126')).toBe('2026-11-05');
    expect(settlementDateOf('UPI/123/x')).toBeNull();
  });
});

describe('card match suggestions', () => {
  const at = istToMs(2026, 11, 4, 2, 38, 0);
  const sale = (id: string, paidAt: number | null, amount: number, extra: Partial<CardSale> = {}): CardSale =>
    ({ id, amount_paise: amount, bill_no: id, shift_day: '2026-11-03', paid_at: paidAt, group_head: null, ...extra });
  const p = (id: string, paidAt: number, amount: number, type = 'PURCHASE') => ({ id, paid_at: paidAt, amount_paise: amount, txn_type: type });
  it('pairs by closest time, each used once; bills paid together count as one; refunds are never matched', () => {
    let r = cardCandidates([p('p1', at, 64800), p('p2', at + 30 * 60e3, 64800)], [sale('b1', at - 2 * 60e3, 64800), sale('b2', at + 28 * 60e3, 64800)]);
    expect(r.clear.get('p1')?.transactionIds).toEqual(['b1']);
    expect(r.clear.get('p2')?.transactionIds).toEqual(['b2']);
    r = cardCandidates([p('p1', at, 50000)], [sale('b1', at, 20000, { group_head: 'g' }), sale('b2', at - 60e3, 30000, { group_head: 'g' })]);
    expect(r.clear.get('p1')?.transactionIds).toEqual(['b1', 'b2']);
    // A register-only bill (no time) fits a payment in its shift, but is never ticked for the person.
    r = cardCandidates([p('p1', at, 64800)], [sale('b1', null, 64800)]);
    expect(r.candidates.get('p1')).toHaveLength(1);
    expect(r.clear.size).toBe(0);
    r = cardCandidates([p('p1', at, 64800, 'REFUND')], [sale('b1', at, 64800)]);
    expect(r.candidates.get('p1')).toEqual([]);
    // More than three hours apart: not offered.
    r = cardCandidates([p('p1', at, 64800)], [sale('b1', at - 4 * 3600e3, 64800)]);
    expect(r.candidates.get('p1')).toEqual([]);
  });
  it('Bookr matches on its own only a payment and a bill within 20 minutes that nothing else could take', () => {
    expect(autoPairs([p('p1', at, 64800)], [sale('b1', at - 5 * 60e3, 64800)]).map((x) => [x.paymentId, x.k.transactionIds])).toEqual([['p1', ['b1']]]);
    // Too far apart, no bill time, two bills, or two payments that want the same bill: left to a person.
    expect(autoPairs([p('p1', at, 64800)], [sale('b1', at - 25 * 60e3, 64800)])).toEqual([]);
    expect(autoPairs([p('p1', at, 64800)], [sale('b1', null, 64800)])).toEqual([]);
    expect(autoPairs([p('p1', at, 64800)], [sale('b1', at, 64800), sale('b2', at + 60e3, 64800)])).toEqual([]);
    expect(autoPairs([p('p1', at, 64800), p('p2', at + 40 * 60e3, 64800)], [sale('b1', at + 10 * 60e3, 64800)])).toEqual([]);
    expect(autoPairs([p('p1', at, 64800, 'VOID')], [sale('b1', at, 64800)])).toEqual([]);
  });
});

describe('card settlements end to end', () => {
  const setup = async () => {
    const h = await businessWithAllRoles('Hotel');
    const o = h.clients.owner;
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'Exospark ICICI', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    const fees = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Card machine charges', type: 'expense' })).json.id;
    const gst = (await o.post(`/businesses/${h.bid}/heads`, { name: 'GST on card charges', type: 'expense' })).json.id;
    // Confirmed card sales (as confirmation makes them), waiting for the card settlement.
    const sale = async (bill: string, shift: string, amount: number) => {
      const id = crypto.randomUUID();
      await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, narration, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
        VALUES (${id}, ${h.bid}, ${shift}, ${amount}, 'income', 'F&B', 'software_report', 'approved', 'card', ${bill}, ${shift}, 'awaiting_card_settlement', ${Date.now()})`;
      return id;
    };
    const s1 = await sale('26110301', '2026-11-03', 64800);
    const s2 = await sale('26110405', '2026-11-04', 272700);
    return { ...h, acc, fees, gst, s1, s2, sale };
  };
  const T = (cells: (string | number)[]) => cells.join('\t');
  const credit = (net: string) => T([1, 'S20000001', '05/11/2026', '05/11/2026 7:47:41 AM', '-', 'EZY/ICICIPOS_SET_10XX000000_051126', 'CR', net, '9000']);

  it('a dropped file is read once; payments match their bills; the day settles by the rule, fee and GST booked apart', async () => {
    const h = await setup();
    const o = h.clients.owner;
    const base = `/businesses/${h.bid}/cards`;
    expect((await h.clients.entry_staff.post(`${base}/file`, { name: 'x_ICICI_POS_CD.xlsx', data: b64(xlsx(REPORT)) })).status).toBe(403);
    expect((await o.post(`${base}/file`, { name: 'x_ICICI_POS_CD.xlsx', data: b64(xlsx(REPORT)) })).json).toMatchObject({ added: 2, skipped: 0, settledOn: ['2026-11-05'] });
    expect((await o.post(`${base}/file`, { name: 'x_ICICI_POS_CD.xlsx', data: b64(xlsx(REPORT)) })).json).toMatchObject({ added: 0, skipped: 2 });
    expect((await o.post(`${base}/file`, { name: 'notes.xlsx', data: b64(new TextEncoder().encode('x')) })).status).toBe(400);

    let v = (await o.get(`${base}?from=2026-11-01&to=2026-11-08`)).json;
    expect(v.suggestedFeeHeadId).toBe(h.fees);
    const day = v.settlements[0];
    expect(day).toMatchObject({ settledOn: '2026-11-05', amountPaise: 337500, feePaise: 6007, gstPaise: 874, netPaise: 330619, bank: null, credits: [] });
    // Neither sale has a time (no software bill joined here), so each fits a payment in its own shift, unticked.
    expect(day.payments.map((p: any) => [p.shiftDay, p.candidates[0]?.billNos[0], p.clear])).toEqual([['2026-11-03', '26110301', false], ['2026-11-04', '26110405', false]]);

    // Totals must agree; then both match in one go.
    expect((await o.post(`${base}/match`, { sets: [{ paymentIds: [day.payments[0].id], transactionIds: [h.s2] }] })).status).toBe(409);
    expect((await o.post(`${base}/match`, { sets: [{ paymentIds: [day.payments[0].id], transactionIds: [h.s1] }, { paymentIds: [day.payments[1].id], transactionIds: [h.s2] }] })).json)
      .toMatchObject({ matched: 2, problems: [] });
    expect((await sql`SELECT match_status FROM transactions WHERE id IN (${h.s1}, ${h.s2})`).map((r) => r.match_status)).toEqual([null, null]);
    // Unmatching one leaves the other.
    expect((await o.post(`${base}/${day.payments[0].id}/unmatch`)).status).toBe(200);
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${h.s1}`)[0].match_status).toBe('awaiting_card_settlement');
    expect((await sql`SELECT count(*) AS n FROM card_matches`)[0].n).toBe(1);
    await o.post(`${base}/match`, { sets: [{ paymentIds: [day.payments[0].id], transactionIds: [h.s1] }] });

    // The bank's credit arrives with no rule set: offered, not settled; settling needs the rule.
    await o.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: credit('3,306.19') });
    v = (await o.get(`${base}?from=2026-11-01&to=2026-11-08`)).json;
    const cr = v.settlements[0].credits[0];
    expect(cr).toMatchObject({ amountPaise: 330619, accountName: 'Exospark ICICI' });
    const settle = { settledOn: '2026-11-05', merchantId: '900000000000001', bankRowId: cr.id };
    expect((await o.post(`${base}/settle`, settle)).json.error).toMatch(/Card settlement rule/);
    // The rule, per card machine (Owner or Accountant): setting it settles the waiting day on its own, fee and GST apart.
    const rule = { feeHeadId: h.fees, gstHeadId: h.gst };
    expect((await h.clients.entry_staff.put(`${base}/rules/TT000001`, rule)).status).toBe(403);
    expect((await o.get(`${base}/rules`)).json.terminals).toEqual([{ terminalId: 'TT000001', merchantId: '900000000000001', payments: 2, rule: null }]);
    expect((await h.clients.accountant.put(`${base}/rules/TT000001`, rule)).json).toMatchObject({ ok: true, autoSettled: 1 });
    const fee = (await sql`SELECT * FROM transactions WHERE head_id = ${h.fees}`)[0];
    const tax = (await sql`SELECT * FROM transactions WHERE head_id = ${h.gst}`)[0];
    expect(fee).toMatchObject({ type: 'expense', amount_paise: 6007, account_id: h.acc, day: '2026-11-05', source: 'bank_sheet', status: 'approved' });
    expect(tax).toMatchObject({ type: 'expense', amount_paise: 874, account_id: h.acc, day: '2026-11-05' });
    expect((await sql`SELECT status, done_by FROM bank_rows WHERE id = ${cr.id}`)[0]).toEqual({ status: 'booked', done_by: null });
    expect(JSON.parse((await sql`SELECT after FROM audit_log WHERE action = 'card.settle'`)[0].after)).toMatchObject({ auto: true, fee: 6007, gst: 874 });
    v = (await o.get(`${base}?from=2026-11-01&to=2026-11-08`)).json;
    expect(v.settlements[0].bank).toMatchObject({ id: cr.id });
    expect((await o.post(`${base}/settle`, settle)).status).toBe(409);

    // Undo from Card settlements, or from Bank sync: both take it apart and remove the fee and the GST.
    expect((await o.post(`${base}/unsettle`, { bankRowId: cr.id })).status).toBe(200);
    expect(await sql`SELECT id FROM transactions WHERE head_id IN (${h.fees}, ${h.gst})`).toEqual([]);
    expect((await sql`SELECT count(*) AS n FROM card_settlements WHERE bank_row_id IS NOT NULL`)[0].n).toBe(0);
    expect((await o.post(`${base}/settle`, settle)).json).toMatchObject({ ok: true, feePaise: 6007, gstPaise: 874 });
    expect((await sql`SELECT done_by FROM bank_rows WHERE id = ${cr.id}`)[0].done_by).not.toBeNull();
    expect((await o.post(`/businesses/${h.bid}/bank-rows/${cr.id}/reopen`)).status).toBe(200);
    expect(await sql`SELECT id FROM transactions WHERE head_id IN (${h.fees}, ${h.gst})`).toEqual([]);
    expect((await sql`SELECT count(*) AS n FROM card_settlements WHERE bank_row_id IS NOT NULL`)[0].n).toBe(0);
    // A credit of another amount is refused.
    await o.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: T([2, 'S20000002', '06/11/2026', '06/11/2026 7:47:41 AM', '-', 'EZY/ICICIPOS_SET_10XX000000_061126', 'CR', '100', '9100']) });
    const [other] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S20000002'`;
    expect((await o.post(`${base}/settle`, { ...settle, bankRowId: other.id })).status).toBe(409);
  });

  it('a payment more than its bill is matched with a tip; one with no bill is booked to a head; Undo removes what was added; Reconcile shows the card picture', async () => {
    const h = await setup();
    const o = h.clients.owner;
    const base = `/businesses/${h.bid}/cards`;
    const fnb = (await o.post(`/businesses/${h.bid}/heads`, { name: 'F&B', type: 'income' })).json.id;
    // The 4 Nov bill is ₹2,700; the guest paid ₹2,727 on the card.
    await sql`UPDATE transactions SET amount_paise = 270000, head_id = ${fnb} WHERE id = ${h.s2}`;
    await o.post(`${base}/file`, { name: 'x_ICICI_POS_CD.xlsx', data: b64(xlsx(REPORT)) });
    const pays = await sql`SELECT id, amount_paise FROM card_settlements ORDER BY paid_at`;
    expect((await o.post(`${base}/${pays[1].id}/tip`, { transactionId: h.s1 })).status).toBe(400); // not a little more than that bill
    expect((await o.post(`${base}/${pays[1].id}/tip`, { transactionId: h.s2 })).json).toMatchObject({ ok: true, tipPaise: 2700 });
    const [tip] = await sql`SELECT * FROM transactions WHERE source = 'bank_sheet' AND type = 'income'`;
    expect(tip).toMatchObject({ amount_paise: 2700, head_id: fnb, shift_day: '2026-11-04', payment_mode: 'card', match_status: null });
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${h.s2}`)[0].match_status).toBeNull();
    // The card picture of the 4 Nov shift: one card bill, matched by a person, with its tip.
    const k = await shiftCards(env.DB, h.bid, '2026-11-04', null);
    expect(k.strip).toMatchObject({ bills: 1, matched: 1, byBookr: 0, noBill: 0 });
    expect(k.done).toMatchObject([{ bills: ['26110405'], tipPaise: 2700, byBookr: false, booked: false }]);
    expect(k.settlements).toMatchObject([{ settledOn: '2026-11-05', ruleSet: false, bank: null }]);
    expect((await o.post(`${base}/${pays[1].id}/unmatch`)).status).toBe(200);
    expect(await sql`SELECT id FROM transactions WHERE source = 'bank_sheet'`).toEqual([]);
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${h.s2}`)[0].match_status).toBe('awaiting_card_settlement');

    // The 3 Nov payment has no bill in the card sales once that bill is paid another way: booked to a head.
    await sql`UPDATE transactions SET match_status = NULL, payment_mode = 'cash' WHERE id = ${h.s1}`;
    const k3 = await shiftCards(env.DB, h.bid, '2026-11-03', null);
    expect(k3.needs.map((n) => n.why)).toEqual(['no_bill']);
    expect(k3.left).toBe(1);
    expect((await h.clients.entry_staff.post(`${base}/${pays[0].id}/book`, { headId: fnb })).status).toBe(403);
    expect((await o.post(`${base}/${pays[0].id}/book`, { headId: h.fees })).status).toBe(400); // an expense head
    expect((await o.post(`${base}/${pays[0].id}/book`, { headId: fnb, note: 'Advance for a room' })).status).toBe(200);
    expect((await sql`SELECT amount_paise, narration, shift_day FROM transactions WHERE source = 'bank_sheet'`)[0]).toEqual({ amount_paise: 64800, narration: 'Advance for a room', shift_day: '2026-11-03' });
    expect((await shiftCards(env.DB, h.bid, '2026-11-03', null)).done).toMatchObject([{ booked: true }]);
    expect((await o.post(`${base}/${pays[0].id}/unmatch`)).status).toBe(200);
    expect(await sql`SELECT id FROM transactions WHERE source = 'bank_sheet'`).toEqual([]);
    // The shift bar counts card items once the shift is confirmed.
    await sql`INSERT INTO shifts (id, business_id, shift_day, status, created_at) VALUES (${crypto.randomUUID()}, ${h.bid}, '2026-11-03', 'confirmed', ${Date.now()})`;
    expect((await o.get(`/businesses/${h.bid}/shifts/2026-11-03/progress`)).json.bank).toMatchObject({ cardsLeft: 1 });
  });

  it('Bookr matches a safe pair on its own as the card report comes in; Undo works on it', async () => {
    const h = await setup();
    const o = h.clients.owner;
    // A software bill of the 3 Nov shift paid 5 minutes before the card payment.
    const rep = crypto.randomUUID(); const sb = crypto.randomUUID(); const cmp = crypto.randomUUID();
    const t = Date.now();
    const up = crypto.randomUUID();
    await sql`INSERT INTO uploads (id, business_id, kind, business_day, storage_key, content_sha256, status, created_at)
      VALUES (${up}, ${h.bid}, 'software_sales_csv', '2026-11-03', 'k', 'sha', 'approved', ${t})`;
    await sql`INSERT INTO sales_reports (id, business_id, upload_id, covers_from, covers_to, first_paid_at, last_paid_at, bill_count, footer_bills, footer_upi_paise,
      footer_card_paise, footer_cash_paise, footer_total_paise, created_at) VALUES (${rep}, ${h.bid}, ${up}, ${t}, ${t}, ${t}, ${t}, 1, 1, 0, 64800, 0, 64800, ${t})`;
    await sql`INSERT INTO software_bills (id, business_id, report_id, pos_no, bill_no, paid_at, shift_day, mode, amount_paise, is_complimentary, created_at)
      VALUES (${sb}, ${h.bid}, ${rep}, '1', '26110301', ${istToMs(2026, 11, 4, 2, 33, 0)}, '2026-11-03', 'card', 64800, 0, ${t})`;
    await sql`INSERT INTO bill_comparisons (id, business_id, shift_day, pos_no, bill_no, software_bill_id, difference, created_at) VALUES (${cmp}, ${h.bid}, '2026-11-03', '1', '26110301', ${sb}, 'match', ${t})`;
    await sql`UPDATE transactions SET comparison_id = ${cmp} WHERE id = ${h.s1}`;
    expect((await o.post(`/businesses/${h.bid}/cards/file`, { name: 'x_ICICI_POS_CD.xlsx', data: b64(xlsx(REPORT)) })).json).toMatchObject({ added: 2, autoMatched: 1 });
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${h.s1}`)[0].match_status).toBeNull();
    expect((await sql`SELECT matched_by FROM card_matches`)[0].matched_by).toBeNull();
    const k = await shiftCards(env.DB, h.bid, '2026-11-03', null);
    expect(k.done).toMatchObject([{ bills: ['26110301'], byBookr: true }]);
    const pid = (await sql`SELECT settlement_id FROM card_matches`)[0].settlement_id;
    expect((await o.post(`/businesses/${h.bid}/cards/${pid}/unmatch`)).status).toBe(200);
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${h.s1}`)[0].match_status).toBe('awaiting_card_settlement');
  });

  it('mail to Bookr\'s address is kept and read; others are turned away; Gmail\'s confirmation is shown', async () => {
    const h = await setup();
    const routed = { ...env, MAIL_ROUTES: JSON.stringify({ 'cards@hotel.test': h.bid }), CARD_MAIL_FROM: '@icicimerchant.test' } as any;
    const mime = (from: string, id: string, attach: Uint8Array | null, text = 'Settlement report attached.') => [
      `From: Card Company <${from}>`, 'To: cards@hotel.test', `Subject: Settlement report`, `Message-ID: <${id}@mail.test>`, 'Date: Thu, 05 Nov 2026 07:44:00 +0530',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', '', text, '',
      ...(attach ? ['--b1', 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="900000000000001_HOTEL_05112026_ICICI_POS_CD.xlsx"',
        'Content-Disposition: attachment; filename="900000000000001_HOTEL_05112026_ICICI_POS_CD.xlsx"', 'Content-Transfer-Encoding: base64', '', b64(attach), ''] : []),
      '--b1--', ''].join('\r\n');
    const send = async (to: string, raw: string) => {
      let rejected: string | null = null;
      const message = { to, from: 'bounce@gmail.test', raw: new Response(raw).body, rawSize: raw.length, headers: new Headers(), setReject: (r: string) => { rejected = r; } } as any;
      await receiveMail(message, routed);
      return rejected;
    };
    const report = mime('reports@icicimerchant.test', 'r1', xlsx(REPORT));
    expect(await send('cards@hotel.test', report)).toBeNull();
    expect(await send('cards@hotel.test', report)).toBeNull(); // the same mail again: kept once
    expect(await send('other@hotel.test', report)).toMatch(/not set up/);
    expect(await send('cards@hotel.test', mime('someone@else.test', 'r2', xlsx(REPORT)))).toMatch(/only reads mail/);
    expect(await send('cards@hotel.test', mime('forwarding-noreply@google.com', 'g1', null,
      'Confirmation code: 123456789\r\nTo allow forwarding, click https://mail-settings.google.com/mail/vf-abc123 here.'))).toBeNull();

    const mails = (await h.clients.owner.get(`/businesses/${h.bid}/cards?from=2026-11-01&to=2026-11-08`)).json.mails;
    expect(mails).toHaveLength(2);
    const read = mails.find((m: any) => m.status === 'read');
    expect(read).toMatchObject({ from: 'reports@icicimerchant.test' });
    expect(read.note).toMatch(/2 new payments/);
    expect(mails.find((m: any) => m.status === 'ignored').note).toMatch(/https:\/\/mail-settings\.google\.com\/mail\/vf-abc123.*code 123456789/);
    expect((await sql`SELECT count(*) AS n FROM card_settlements WHERE mail_id = ${read.id}`)[0].n).toBe(2);
    const [stored] = await sql`SELECT r2_key FROM inbound_mails WHERE id = ${read.id}`;
    expect(await (await env.UPLOADS.get(stored.r2_key))!.text()).toContain('Settlement report attached.');
    // Read again: nothing added twice.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/inbound-mails/${read.id}/read`)).json.note).toMatch(/0 new payments, 2 already in Bookr/);
  });

  it('reports saved in the Drive folder are read once, with Sync all bank accounts; Google problems are said', async () => {
    const h = await setup();
    const o = h.clients.owner;
    // A made-up service account key and Google's answers, so nothing leaves the test.
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64(der)}\n-----END PRIVATE KEY-----\n`;
    env.GOOGLE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'bookr@test.iam.gserviceaccount.com', private_key: pem });
    const file = xlsx(REPORT);
    let listed = [{ id: 'file1', name: '900000000000001_HOTEL_05112026_ICICI_POS_CD.xlsx', modifiedTime: '2026-11-05T02:14:00Z' },
      { id: 'other', name: 'notes.xlsx', modifiedTime: '2026-11-05T02:14:00Z' }];
    let denied = false;
    let scriptCalls: unknown[] = [];
    let scriptDown = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://script.google.com/')) {
        scriptCalls.push(JSON.parse(String(init?.body)));
        return scriptDown ? new Response('<html>Sorry</html>', { status: 500 }) : new Response(JSON.stringify({ saved: 1 }));
      }
      if (u.includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (denied) return new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 404 });
      if (u.includes('/drive/v3/files?')) return new Response(JSON.stringify({ files: listed }));
      if (u.includes('/drive/v3/files/file1?alt=media')) return new Response(file);
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      expect(folderIdFrom('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing')).toBe('1AbCdEfGhIjKlMnOp');
      expect((await o.post(`/businesses/${h.bid}/cards/sync`)).status).toBe(400); // no folder yet
      expect((await o.put(`/businesses/${h.bid}/cards/folder`, { folder: 'not a link!' })).status).toBe(400);
      expect((await o.put(`/businesses/${h.bid}/cards/folder`, { folder: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp' })).json).toMatchObject({ folderId: '1AbCdEfGhIjKlMnOp' });
      let sync = (await o.post(`/businesses/${h.bid}/bank/sync-all`)).json;
      expect(sync.cards).toMatchObject({ ok: true, files: 1, added: 2, problems: [] });
      sync = (await o.post(`/businesses/${h.bid}/bank/sync-all`)).json;
      expect(sync.cards).toMatchObject({ ok: true, files: 0, added: 0 });
      const v = (await o.get(`/businesses/${h.bid}/cards?from=2026-11-01&to=2026-11-08`)).json;
      expect(v.driveFolder).toBe('1AbCdEfGhIjKlMnOp');
      expect(v.settlements[0].payments).toHaveLength(2);
      const got = v.mails[0];
      expect(got).toMatchObject({ from: 'Google Drive', status: 'read' });
      expect((await o.post(`/businesses/${h.bid}/inbound-mails/${got.id}/read`)).json.note).toMatch(/0 new payments, 2 already in Bookr/);
      // Bank sync and Bring in show the card reports beside the bank accounts.
      expect((await o.get(`/businesses/${h.bid}/bank`)).json.cards).toMatchObject({ folder: '1AbCdEfGhIjKlMnOp', gmail: false, payments: 2, lastSettled: '2026-11-05' });
      expect((await o.get(`/businesses/${h.bid}/shifts/2026-11-03/inputs`)).json.bank.cards).toMatchObject({ payments: 2, covered: true });
      expect((await o.get(`/businesses/${h.bid}/shifts/2026-11-04/inputs`)).json.bank.cards).toMatchObject({ covered: false });
      // Not set up: the script is not called. Set up (Worker secrets): Sync asks it to save new mails first, with the code.
      expect(scriptCalls).toEqual([]);
      expect(sync.cards.script).toBeNull();
      env.CARD_SCRIPT_URL = 'https://script.google.com/macros/s/abc/exec';
      env.CARD_SCRIPT_TOKEN = 'code-1';
      expect((await o.post(`/businesses/${h.bid}/cards/sync`)).json).toMatchObject({ files: 0, script: { saved: 1 } });
      expect(scriptCalls).toEqual([{ token: 'code-1' }]);
      scriptDown = true;
      expect((await o.post(`/businesses/${h.bid}/bank/sync-all`)).json.cards).toMatchObject({ ok: true, script: { error: expect.stringMatching(/did not save.*read anyway/) } });
      delete env.CARD_SCRIPT_URL;
      delete env.CARD_SCRIPT_TOKEN;
      denied = true;
      listed = [];
      expect((await o.post(`/businesses/${h.bid}/bank/sync-all`)).json.cards).toMatchObject({ ok: false, error: expect.stringMatching(/Share it with bookr@test/) });
    } finally {
      globalThis.fetch = realFetch;
      delete env.GOOGLE_SERVICE_ACCOUNT;
    }
  });
});
