// Phase 3, part 1: bank statements (ICICI layout), pairing, rules, UPI matching. Invented lines only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';
import { classify, parseStatementText } from '../src/bankstatement';
import { upiCandidates, type UpiIncome } from '../src/bank';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

// Same columns as the bank's sheet; the names, IDs and amounts are made up.
const T = (cells: (string | number)[]) => cells.join('\t');
const STATEMENT = [
  'Transactions List - -SAMPLE TRADERS HUF (INR) - 000000000001',
  T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
  T([1, 'S10000001', '31/10/2026', '31/10/2026 10:03:47 AM', '-', 'UPI/600000000001/Breakfast/xxab-1@okicici/SAMPLE BANK/ICIaaaa', 'CR', 840, '1840']),
  T([2, 'S10000002', '31/10/2026', '31/10/2026 10:03:48 AM', '-', 'EZY/UPICCMDR_~600000000001~311026', 'DR', 8.92, '1831.08']),
  T([3, 'S10000003', '31/10/2026', '31/10/2026 8:48:36 PM', '-', 'UPI/110000000001/UPI Pay/xxh225@okaxis//ICIbbbb', 'DR', 1418, '413.08']),
  T([4, 'S10000004', '31/10/2026', '31/10/2026 9:00:00 PM', '-', 'UPI/110000000002/salary/xx6056@ybl//ICIcccc', 'DR', 300, '113.08']),
  T([5, 'S10000005', '31/10/2026', '31/10/2026 9:00:01 PM', '-', 'UPI/RVSL110000000002/salary/xx6056@ybl//ICIcccc', 'CR', 300, '413.08']),
  T([1, 'S10000006', '01/11/2026', '01/11/2026 7:47:41 AM', '-', 'EZY/ICICIPOS_SET_10XX000000_011126', 'CR', '5,328.92', '5742.00']),
  T(['', '', '', '', '', 'Total', '', '', '']),
].join('\n');

describe('reading a statement', () => {
  it('reads lines, skips the title and header, and knows each kind', () => {
    const p = parseStatementText(STATEMENT);
    expect(p.problems).toEqual([]);
    expect(p.lines.map((l) => l.kind)).toEqual(['upi_in', 'upi_fee', 'upi_out', 'upi_out', 'reversal', 'card_settlement']);
    expect(p.lines[0]).toMatchObject({ tranId: 'S10000001', direction: 'CR', amountPaise: 84000, day: '2026-10-31', upiRef: '600000000001', vpa: 'xxab-1@okicici', remark: 'Breakfast' });
    expect(p.lines[0].postedAt).toBe(istToMs(2026, 10, 31, 10, 3, 47));
    expect(p.lines[1]).toMatchObject({ amountPaise: 892, upiRef: '600000000001' });
    expect(p.lines[2]).toMatchObject({ vpa: 'xxh225@okaxis', remark: 'UPI Pay' });
    expect(p.lines[4]).toMatchObject({ upiRef: '110000000002' });
    expect(p.lines[5]).toMatchObject({ amountPaise: 532892, postedAt: istToMs(2026, 11, 1, 7, 47, 41) });
    expect(classify('VPS/SOME SHOP /2026/NORTH GOA', 'DR').kind).toBe('card_purchase');
  });
  it('12 AM and 12 PM, and a bad amount is reported', () => {
    const p = parseStatementText([T([1, 'S101', '01/11/2026', '01/11/2026 12:05:03 AM', '-', 'UPI/1/x/a@b//c', 'CR', 30, 1]), T([2, 'S102', '01/11/2026', '01/11/2026 12:05:03 PM', '-', 'UPI/2/x/a@b//c', 'CR', 'abc', 1])].join('\n'));
    expect(p.lines[0].postedAt).toBe(istToMs(2026, 11, 1, 0, 5, 3));
    expect(p.problems[0]).toMatch(/amount/);
  });
});

describe('UPI match suggestions', () => {
  const credit = (id: string, at: number, amount: number) => ({ id, posted_at: at, amount_paise: amount, label: 'UPI Bank 2' }) as any;
  const sale = (id: string, paidAt: number | null, amount: number, extra: Partial<UpiIncome> = {}): UpiIncome =>
    ({ id, amount_paise: amount, bill_no: id, shift_day: '2026-10-31', paid_at: paidAt, group_head: null, labels: 'UPI Bank 2', ...extra });
  it('credits and sales pair by closest time, each used once, up to an hour apart', () => {
    const at = istToMs(2026, 10, 31, 10, 0, 0);
    let r = upiCandidates([credit('c1', at + 5 * 60e3, 84000)], [sale('b1', at, 84000), sale('b2', at + 2 * 3600e3, 84000)]);
    expect(r.candidates.get('c1')!.map((k) => k.transactionIds[0])).toEqual(['b1', 'b2']);
    expect(r.clear.get('c1')?.transactionIds).toEqual(['b1']);
    // Two credits, one sale: the closer credit gets it.
    r = upiCandidates([credit('c1', at + 60e3, 84000), credit('c2', at + 120e3, 84000)], [sale('b1', at, 84000)]);
    expect([...r.clear.keys()]).toEqual(['c1']);
    // Two credits, two sales: paired by time, not blocked; the paired sale is first in each list.
    r = upiCandidates([credit('c1', at + 60e3, 23000), credit('c2', at + 10 * 60e3, 23000)], [sale('b1', at, 23000), sale('b2', at + 7 * 60e3, 23000)]);
    expect(r.clear.get('c1')?.transactionIds).toEqual(['b1']);
    expect(r.clear.get('c2')?.transactionIds).toEqual(['b2']);
    expect(r.candidates.get('c2')![0].transactionIds).toEqual(['b2']);
    // 51 minutes apart and alone: ticked; over an hour: not.
    expect(upiCandidates([credit('c1', at + 51 * 60e3, 1000)], [sale('b1', at, 1000)]).clear.size).toBe(1);
    expect(upiCandidates([credit('c1', at + 70 * 60e3, 1000)], [sale('b1', at, 1000)]).clear.size).toBe(0);
  });
  it('bills paid together are offered as one; a sale written under another UPI column is not offered', () => {
    const at = istToMs(2026, 10, 31, 12, 0, 0);
    const r = upiCandidates([credit('c1', at, 100000)], [sale('b1', at, 60000, { group_head: 'g' }), sale('b2', at, 40000, { group_head: 'g' }), sale('b3', at, 100000, { labels: 'UPI XOXO' })]);
    expect(r.candidates.get('c1')!.map((k) => k.transactionIds.sort().join('+'))).toEqual(['b1+b2']);
  });
});

describe('bank lines through the API', () => {
  const setup = async () => {
    const h = await businessWithAllRoles('Hotel');
    const o = h.clients.owner;
    const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
    expect((await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: 'UPI Bank 2' })).status).toBe(200);
    const veg = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Vegetables', type: 'expense' })).json.id;
    const sales = (await o.post(`/businesses/${h.bid}/heads`, { name: 'F&B', type: 'income' })).json.id;
    return { ...h, acc, veg, sales };
  };

  it('paste adds each line once; only Owner and Accountant work with the bank', async () => {
    const h = await setup();
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT })).status).toBe(403);
    expect((await h.clients.viewer.get(`/businesses/${h.bid}/bank`)).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT })).json).toMatchObject({ added: 6, skipped: 0 });
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT })).json).toMatchObject({ added: 0, skipped: 6 });
    const [fee] = await sql`SELECT pair_row_id FROM bank_rows WHERE tran_id = 'S10000002'`;
    const [cr] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S10000001'`;
    expect(fee.pair_row_id).toBe(cr.id);
    // Sync needs Google access, which tests do not have.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/sync`)).status).toBe(400);
    const b = (await h.clients.owner.get(`/businesses/${h.bid}/bank`)).json;
    expect(b.accounts[0]).toMatchObject({ name: 'HUF A', rows: 6, receivesUpiLabel: 'UPI Bank 2' });
    expect(b.googleEmail).toBeNull();
  });

  it('a credit matches a confirmed UPI sale by a person; never twice; unmatch puts it back', async () => {
    const h = await setup();
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT });
    const sale = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${sale}, ${h.bid}, '2026-10-31', 84000, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '2610399', '2026-10-31', 'awaiting_bank_match', 0)`;
    const rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-10-31`)).json.rows;
    const cr = rows.find((r: any) => r.tranId === 'S10000001');
    expect(cr.candidates[0].transactionIds).toEqual([sale]);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${cr.id}/match`, { transactionIds: [sale] })).status).toBe(200);
    expect((await sql`SELECT matched_bank_row, match_status FROM transactions WHERE id = ${sale}`)[0]).toEqual({ matched_bank_row: cr.id, match_status: null });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${cr.id}/match`, { transactionIds: [sale] })).status).toBe(409);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${cr.id}/match`)).status).toBe(200);
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${sale}`)[0].match_status).toBe('awaiting_bank_match');
    // A wrong amount is refused.
    const other = rows.find((r: any) => r.tranId === 'S10000005');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${other.id}/match`, { transactionIds: [sale] })).status).toBe(400);
  });

  it('rules suggest a head; a person books by rule or by hand; reversals cancel; reopen undoes', async () => {
    const h = await setup();
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT });
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/rules`, { name: 'Veg', vpa: 'XXH225@okaxis', headId: h.veg })).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/rules`, { name: 'Veg', direction: 'CR', vpa: 'xxh225@okaxis', headId: h.veg })).status).toBe(400);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/rules`, { name: 'Veg', vpa: 'XXH225@okaxis', headId: h.veg })).status).toBe(201);
    let rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-11-01`)).json.rows;
    const veg = rows.find((r: any) => r.tranId === 'S10000003');
    expect(veg.rule).toMatchObject({ name: 'Veg', headId: h.veg });
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/book-by-rules`, { ids: rows.map((r: any) => r.id) })).json.booked).toBe(1);
    const [tx] = await sql`SELECT type, head_id, source, amount_paise, account_id, matched_bank_row FROM transactions WHERE matched_bank_row = ${veg.id}`;
    expect(tx).toMatchObject({ type: 'expense', head_id: h.veg, source: 'bank_sheet', amount_paise: 141800, account_id: h.acc });
    // Money received cannot go under an expense head.
    const settle = rows.find((r: any) => r.tranId === 'S10000006');
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${settle.id}/book`, { headId: h.veg })).status).toBe(400);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${settle.id}/book`, { headId: h.sales, party: 'Card machine' })).status).toBe(200);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/ignore-reversals`)).json.pairs).toBe(1);
    rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-11-01`)).json.rows;
    expect(rows.filter((r: any) => r.status === 'ignored').map((r: any) => r.tranId).sort()).toEqual(['S10000004', 'S10000005']);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${veg.id}/reopen`)).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE matched_bank_row = ${veg.id}`)[0].n).toBe(0);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action LIKE 'bank.%'`)[0].n).toBeGreaterThanOrEqual(4);
  });

  it('match-many and book-many do the ticked lines, each checked on its own', async () => {
    const h = await setup();
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT });
    const sale = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${sale}, ${h.bid}, '2026-10-31', 84000, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '145251', '2026-10-31', 'awaiting_bank_match', 0)`;
    const rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-11-01`)).json.rows;
    const id = (t: string) => rows.find((r: any) => r.tranId === t).id;
    const m = (await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/match-many`, { pairs: [
      { rowId: id('S10000001'), transactionIds: [sale] }, { rowId: id('S10000005'), transactionIds: [sale] }] })).json;
    expect(m.matched).toBe(1);
    expect(m.skipped[0]).toMatch(/another credit/);
    // Unmatching one credit of a bulk action undoes only that one.
    const sale2 = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${sale2}, ${h.bid}, '2026-10-31', 30000, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '145252', '2026-10-31', 'awaiting_bank_match', 0)`;
    await sql`UPDATE transactions SET matched_bank_row = NULL, match_status = 'awaiting_bank_match' WHERE id = ${sale}`;
    await sql`DELETE FROM bank_matches`;
    await sql`UPDATE bank_rows SET status = 'unmatched'`;
    const m2 = (await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/match-many`, { pairs: [
      { rowId: id('S10000001'), transactionIds: [sale] }, { rowId: id('S10000005'), transactionIds: [sale2] }] })).json;
    expect(m2.matched).toBe(2);
    expect((await h.clients.accountant.del(`/businesses/${h.bid}/bank-rows/${id('S10000001')}/match`)).json.unmatched).toBe(1);
    const b = (await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [
      { rowId: id('S10000003'), headId: h.veg }, { rowId: id('S10000006'), headId: h.veg }, { rowId: id('S10000004') }] })).json;
    expect(b.booked).toBe(1);
    expect(b.skipped.join(' ')).toMatch(/income head/);
    expect(b.skipped.join(' ')).toMatch(/choose a head/);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: id('S10000004'), headId: h.veg }] })).status).toBe(403);
  });

  it('match with a difference: the gap is booked under the chosen head with a reason; unmatch removes it', async () => {
    const h = await setup();
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT });
    const disc = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Discount allowed', type: 'expense' })).json.id;
    const sale = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${sale}, ${h.bid}, '2026-10-31', 89000, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '238', '2026-10-31', 'awaiting_bank_match', 0)`;
    const upi = (await h.clients.owner.get(`/businesses/${h.bid}/upi?day=2026-10-31`)).json;
    expect(upi.credits.map((c: any) => c.tranId)).toContain('S10000001');
    const cr = upi.credits.find((c: any) => c.tranId === 'S10000001');
    // 840 came in for a bill of 890: refused as a plain match, needs a head and a reason, and an expense head.
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${cr.id}/match`, { transactionIds: [sale] })).status).toBe(400);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${cr.id}/match-with-difference`, { transactionIds: [sale] })).status).toBe(400);
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${cr.id}/match-with-difference`, { transactionIds: [sale], headId: h.sales, note: 'x' })).status).toBe(400);
    const ok = await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${cr.id}/match-with-difference`, { transactionIds: [sale], headId: disc, note: 'Register typo' });
    expect(ok.json.differencePaise).toBe(-5000);
    const [d] = await sql`SELECT type, amount_paise, head_id FROM transactions WHERE matched_bank_row = ${cr.id} AND source = 'bank_sheet'`;
    expect(d).toEqual({ type: 'expense', amount_paise: 5000, head_id: disc });
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${cr.id}/match`)).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE matched_bank_row = ${cr.id}`)[0].n).toBe(0);
  });

  it('one bill paid in two goes: both credits match it, with amounts; unmatching one undoes both', async () => {
    const h = await setup();
    const two = [STATEMENT.split('\n')[1],
      T([1, 'S20000001', '31/10/2026', '31/10/2026 1:00:00 PM', '-', 'UPI/700000000001/UPI/xxg-1@okaxis/SAMPLE BANK/ICIx', 'CR', 1000, '1']),
      T([2, 'S20000002', '31/10/2026', '31/10/2026 1:02:00 PM', '-', 'UPI/700000000002/UPI/xxg-1@okaxis/SAMPLE BANK/ICIy', 'CR', 500, '1'])].join('\n');
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: two });
    const sale = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${sale}, ${h.bid}, '2026-10-31', 150000, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '2610350', '2026-10-31', 'awaiting_bank_match', 0)`;
    const upi = (await h.clients.owner.get(`/businesses/${h.bid}/upi?day=2026-10-31`)).json;
    const ids = upi.credits.filter((c: any) => c.tranId.startsWith('S2')).map((c: any) => c.id);
    expect(ids.length).toBe(2);
    const r = await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: ids, transactionIds: [sale] });
    expect(r.json).toMatchObject({ differencePaise: 0, links: 2 });
    const links = await sql`SELECT amount_paise FROM bank_matches WHERE transaction_id = ${sale} ORDER BY amount_paise`;
    expect(links.map((l) => l.amount_paise)).toEqual([50000, 100000]);
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${sale}`)[0].match_status).toBeNull();
    // Again: refused, already matched.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: ids, transactionIds: [sale] })).status).toBe(409);
    const u = await h.clients.accountant.del(`/businesses/${h.bid}/bank-rows/${ids[1]}/match`);
    expect(u.json.unmatched).toBe(2);
    expect((await sql`SELECT count(*) AS n FROM bank_rows WHERE status = 'matched'`)[0].n).toBe(0);
    expect((await sql`SELECT match_status FROM transactions WHERE id = ${sale}`)[0].match_status).toBe('awaiting_bank_match');
  });

  it('several credits with a shortfall: bills paid in part and the shortfall booked under the head chosen', async () => {
    const h = await setup();
    const disc = (await h.clients.owner.post(`/businesses/${h.bid}/heads`, { name: 'Discount allowed', type: 'expense' })).json.id;
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: [STATEMENT.split('\n')[1],
      T([1, 'S30000001', '31/10/2026', '31/10/2026 2:00:00 PM', '-', 'UPI/800000000001/UPI/xxq@okaxis/B/ICIq', 'CR', 2139, '1'])].join('\n') });
    const a = crypto.randomUUID(); const b = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${a}, ${h.bid}, '2026-10-31', 65000, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '238', '2026-10-31', 'awaiting_bank_match', 0),
             (${b}, ${h.bid}, '2026-10-31', 153900, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '213', '2026-10-31', 'awaiting_bank_match', 0)`;
    const [row] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S30000001'`;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: [row.id], transactionIds: [a, b] })).status).toBe(400);
    const r = await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: [row.id], transactionIds: [a, b], headId: disc, note: 'register typo' });
    expect(r.json.differencePaise).toBe(-5000);
    expect((await sql`SELECT sum(amount_paise) AS s FROM bank_matches WHERE bank_row_id = ${row.id}`)[0].s).toBe(213900);
    expect((await sql`SELECT amount_paise, type FROM transactions WHERE source = 'bank_sheet' AND matched_bank_row = ${row.id}`)[0]).toEqual({ amount_paise: 5000, type: 'expense' });
  });

  it('change the bills on a bill only in the software report: its sale becomes what the bank received, reversibly', async () => {
    const h = await setup();
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT });
    const sale = crypto.randomUUID();
    await sql`INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, source, status, payment_mode, bill_no, shift_day, match_status, created_at)
      VALUES (${sale}, ${h.bid}, '2026-10-31', 83400, 'income', ${h.sales}, 'software_report', 'approved', 'upi', '26103018', '2026-10-31', 'awaiting_bank_match', 0)`;
    const [row] = await sql`SELECT id FROM bank_rows WHERE tran_id = 'S10000001'`;
    const r = await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/match-set`, { rowIds: [row.id], transactionIds: [sale], treat: 'bills', note: 'tip' });
    expect(r.status).toBe(200);
    expect((await sql`SELECT amount_paise FROM transactions WHERE id = ${sale}`)[0].amount_paise).toBe(84000);
    expect((await h.clients.owner.del(`/businesses/${h.bid}/bank-rows/${row.id}/match`)).status).toBe(200);
    expect((await sql`SELECT amount_paise FROM transactions WHERE id = ${sale}`)[0].amount_paise).toBe(83400);
  });

  it('bank payments book with item, party and head; the party is learned by UPI ID and fills in next time', async () => {
    const h = await setup();
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT });
    let rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-10-31`)).json.rows;
    const veg = rows.find((r: any) => r.tranId === 'S10000003');
    expect(veg.suggest).toMatchObject({ party: null, headId: null });
    const b = (await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: veg.id, headId: h.veg, party: 'Ramesh Veg', item: 'Vegetables' }] })).json;
    expect(b.booked).toBe(1);
    const [tx] = await sql`SELECT t.narration, p.name, p.aliases, t.head_id FROM transactions t JOIN parties p ON p.id = t.party_id WHERE t.matched_bank_row = ${veg.id}`;
    expect(tx).toMatchObject({ narration: 'Vegetables', name: 'Ramesh Veg', head_id: h.veg });
    expect(JSON.parse(tx.aliases)).toContain('xxh225@okaxis');
    // A second payment to the same UPI ID: party and head filled in, marked learned.
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: [STATEMENT.split('\n')[1],
      T([9, 'S10000009', '31/10/2026', '31/10/2026 9:30:00 PM', '-', 'UPI/110000000009/UPI Pay/xxh225@okaxis//ICIz', 'DR', 500, '1'])].join('\n') });
    rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-10-31`)).json.rows;
    expect(rows.find((r: any) => r.tranId === 'S10000009').suggest).toMatchObject({ party: 'Ramesh Veg', headId: h.veg, learned: true });
    // Booking it with only the party known: the head comes from the party.
    const id9 = rows.find((r: any) => r.tranId === 'S10000009').id;
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: id9, party: 'Ramesh Veg' }] })).json.booked).toBe(1);
    expect((await sql`SELECT head_id FROM transactions WHERE matched_bank_row = ${id9}`)[0].head_id).toBe(h.veg);
  });

  it('a UPI payment for a sale nobody billed is booked under the F&B (or Room) income head', async () => {
    const h = await setup();
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.acc}/paste`, { text: STATEMENT });
    const rows = (await h.clients.owner.get(`/businesses/${h.bid}/bank-rows?from=2026-10-31&to=2026-10-31`)).json.rows;
    const cr = rows.find((r: any) => r.tranId === 'S10000001');
    const dr = rows.find((r: any) => r.tranId === 'S10000003');
    // No head set for F&B bills yet: refused with the reason.
    let b = (await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: cr.id, billType: 'fnb', item: '2 beers' }] })).json;
    expect(b.booked).toBe(0);
    expect(b.skipped[0]).toMatch(/Heads and rules/);
    await h.clients.owner.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: h.sales });
    b = (await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: [{ rowId: cr.id, billType: 'fnb', item: '2 beers' }, { rowId: dr.id, billType: 'fnb' }] })).json;
    expect(b.booked).toBe(1);
    expect(b.skipped[0]).toMatch(/only money received/);
    const [tx] = await sql`SELECT type, head_id, narration, amount_paise FROM transactions WHERE matched_bank_row = ${cr.id}`;
    expect(tx).toMatchObject({ type: 'income', head_id: h.sales, amount_paise: 84000 });
    expect(tx.narration).toMatch(/Sale not billed \(F&B\): 2 beers/);
    expect((await sql`SELECT note FROM bank_rows WHERE id = ${cr.id}`)[0].note).toBe('Unbilled sale');
  });
});
