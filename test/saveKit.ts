// Shared by the "save the shift" audit (save-audit-a … -e, 14 Nov 2026): save a shift and check what it booked, what it
// matched, and that the cash before saving (the draft) is the cash after saving (final). Invented data only.
import { expect } from 'vitest';
import { sql } from './helpers';
import { hotel } from './auditKit';

export type H = Awaited<ReturnType<typeof hotel>>;
export const DAY = '2026-10-31';

/** A counted cash summary for a day (cash in hand, in rupees), as the cash summary page gives it. */
export async function count(h: H, day: string, rupees: number, opening?: number) {
  const u = crypto.randomUUID();
  await sql`INSERT INTO uploads (id, business_id, kind, business_day, storage_key, content_sha256, status, uploaded_by, created_at)
    VALUES (${u}, ${h.bid}, 'cash_summary', ${day}, ${'k/' + u}, ${'sha-' + u}, 'ready', ${h.users.owner.id}, ${Date.now()})`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, opening_paise, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${h.bid}, ${u}, ${day}, ${opening === undefined ? null : opening * 100}, ${rupees * 100}, 'approved', ${Date.now()})`;
}

export const cashOf = async (h: H, day = DAY) => (await h.clients.accountant.get(`/businesses/${h.bid}/shifts/${day}/cash`)).json;
export const cmp = async (h: H, billNo: string, day = DAY) =>
  (await sql`SELECT * FROM bill_comparisons WHERE business_id = ${h.bid} AND shift_day = ${day} AND bill_no = ${billNo}`)[0];

/** The income rows a save made for a shift. */
export const income = async (h: H, day = DAY) => await sql`SELECT t.id, t.bill_no, t.amount_paise, t.payment_mode, hd.name AS head, t.confirmed_source, t.status, t.match_status,
    t.matched_bank_row, t.comparison_id, t.account_id, t.day FROM transactions t LEFT JOIN heads hd ON hd.id = t.head_id
  WHERE t.business_id = ${h.bid} AND t.shift_day = ${day} AND t.source = 'software_report' AND t.type = 'income'
  ORDER BY t.bill_no, t.payment_mode, t.amount_paise`;
/** [bill, rupees, mode, head, source] for each income row. */
export const brief = (rows: any[]) => rows.map((r) => [r.bill_no, r.amount_paise / 100, r.payment_mode, r.head, r.confirmed_source]);

/** Every bank credit matched to a sale, and every card payment, once: bank row → bills, payment → bills. */
export async function matches(h: H) {
  const bank = await sql`SELECT m.bank_row_id AS id, t.bill_no FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.business_id = ${h.bid} ORDER BY t.bill_no`;
  const card = await sql`SELECT m.settlement_id AS id, t.bill_no FROM card_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.business_id = ${h.bid} AND t.source = 'software_report' ORDER BY t.bill_no`;
  return { bank: bank.map((r: any) => [r.id, r.bill_no]), card: card.map((r: any) => [r.id, r.bill_no]) };
}

/** No sale made twice for a bill and mode, and no sale matched twice. */
export async function noDoubles(h: H) {
  const twice = await sql`SELECT comparison_id, payment_mode, count(*) AS n FROM transactions WHERE business_id = ${h.bid} AND source = 'software_report'
    GROUP BY comparison_id, payment_mode, amount_paise HAVING count(*) > 1`;
  expect(twice, 'a sale booked twice').toEqual([]);
  const bankTwice = await sql`SELECT transaction_id, count(DISTINCT bank_row_id) AS n FROM bank_matches WHERE business_id = ${h.bid} GROUP BY transaction_id
    HAVING count(DISTINCT bank_row_id) > 1 AND sum(amount_paise) > (SELECT amount_paise FROM transactions WHERE id = transaction_id)`;
  expect(bankTwice, 'a sale matched to more credits than its amount').toEqual([]);
  const cardTwice = await sql`SELECT transaction_id, count(*) AS n FROM card_matches WHERE business_id = ${h.bid} GROUP BY transaction_id HAVING count(*) > 1`;
  expect(cardTwice, 'a sale matched to two card payments').toEqual([]);
}

/**
 * Saves a shift, checking the draft cash before saving equals the final cash after: the Cash tab's sum, and each bill's
 * counted cash. Returns the save's answer, the cash before and after, and the income rows.
 */
export async function saveChecked(h: H, day = DAY) {
  const before = await cashOf(h, day);
  expect(before.confirmed, 'not saved yet').toBe(false);
  const res = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/${day}/confirm`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const after = await cashOf(h, day);
  expect(after.cashSalesPaise, 'final cash sales = the draft before saving').toBe(before.draft.cashSalesPaise);
  if (before.draft.shouldBePaise !== null) expect(after.shouldBePaise, 'final should-be = the draft').toBe(before.draft.shouldBePaise);
  if (before.draft.differencePaise !== null) expect(after.differencePaise, 'final difference = the draft').toBe(before.draft.differencePaise);
  const counted = (k: any) => Object.fromEntries(k.bills.filter((b: any) => b.countedPaise).map((b: any) => [b.billNo, b.countedPaise]));
  expect(counted(after), 'each bill counted in cash as the draft said').toEqual(counted(before));
  const rows = await income(h, day);
  expect(rows.filter((r: any) => r.payment_mode === 'cash').reduce((t: number, r: any) => t + r.amount_paise, 0), 'cash rows = cash sales').toBe(after.cashSalesPaise);
  await noDoubles(h);
  return { res: res.json, before, after, rows };
}

export const decide = (h: H, billNo: string, decision: string | null, extra: Record<string, unknown> = {}, day = DAY) =>
  cmp(h, billNo, day).then((c) => h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${c.id}`, { decision, ...extra }));
