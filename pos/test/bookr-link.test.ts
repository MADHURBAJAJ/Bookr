// The POS and Bookr together, each with its own database: the POS's outbox goes to Bookr's receiving end in-process.
// All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { app as bookrApp } from '../../src/app';
import { env as bookrEnv, makeBusiness, makeUser, signIn, sql as bookrSql } from '../../test/helpers';
import { sendOutbox } from '../src/sync';
import { billed, db as posDb, dispose, env as posEnv, q, setupBusiness } from './helpers';

afterAll(async () => { await dispose(); await bookrSql.end(); });

// Bookr reached in-process, as if over the network.
const toBookr: typeof fetch = async (url, init) => bookrApp.request(new URL(String(url)).pathname, init as RequestInit, bookrEnv);

async function connected() {
  const owner = await makeUser('owner');
  const bid = await makeBusiness(owner.id, 'Sample Hotel');
  const bookr = await signIn(owner.email);
  const bank = (await bookr.post(`/businesses/${bid}/accounts`, { name: 'Company bank', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
  const key = (await bookr.post(`/businesses/${bid}/pos/link`)).json.key as string;
  const s = await setupBusiness({ businessId: bid, bookrAccountId: bank });
  const env = { ...posEnv, BOOKR_URL: 'https://bookr.example.test', BOOKR_KEYS: JSON.stringify({ [bid]: key }) };
  return { bid, bookr, bank, key, s, env };
}

describe('POS to Bookr', () => {
  it('sends each settled bill with its payment lines once, and Bookr shows the evidence it holds', async () => {
    const { bid, bookr, bank, s, env } = await connected();
    // A card payment and a UPI payment (two bills paid together).
    const a = (await billed(s, [['Masala Dosa', 1]])).bill; // 189
    const b = (await billed(s, [['Masala Chai', 2]])).bill; // 84
    await s.counter.post(`${s.B}/settlements`, { billIds: [a.id], payments: [{ mode: 'card', amount: '189', cardApproval: 'XY12ZZ', cardLast4: '1111' }] });
    await s.counter.post(`${s.B}/settlements`, { billIds: [b.id], payments: [{ mode: 'upi', amount: '84', payAccountId: s.upiCompany }] });
    const voided = (await billed(s, [['Butter Naan', 1]])).bill;
    await s.owner.post(`${s.B}/bills/${voided.id}/void`, { reasonId: s.reasons.void });

    // Evidence already in Bookr: the card machine's payment and a UPI credit of 84 into the company account.
    const t = Date.now();
    await bookrSql`INSERT INTO card_settlements (id, business_id, file_name, settled_on, merchant_id, terminal_id, txn_id, paid_at, txn_type, amount_paise, fee_paise, gst_paise, net_paise, card_last4, auth_code, created_at)
      VALUES (${crypto.randomUUID()}, ${bid}, 'sample.xlsx', '2026-11-15', 'M1', 'T1', ${'TX' + t}, ${t}, 'PURCHASE', 18900, 300, 54, 18546, '1111', 'XY12ZZ', ${t})`;
    await bookrSql`INSERT INTO bank_rows (id, business_id, account_id, tran_id, value_date, posted_at, day, description, direction, amount_paise, kind, upi_ref, created_at)
      VALUES (${crypto.randomUUID()}, ${bid}, ${bank}, ${'S' + t}, '2026-11-14', ${t + 60000}, '2026-11-14', 'UPI/612345678901/Sample/x@bank', 'CR', 8400, 'upi_in', '612345678901', ${t})`;

    const r = await sendOutbox(env, bid, toBookr);
    expect(r).toMatchObject({ sent: 3, rejected: 0, waiting: 0 });
    expect((await q('SELECT count(*) AS n FROM outbox WHERE business_id = ? AND sent_at IS NULL', bid))[0].n).toBe(0);

    const view = (await bookr.get(`/businesses/${bid}/pos?day=${a.shiftDay}`)).json;
    expect(view.link).not.toBeNull();
    expect(view.bills.map((x: any) => [x.billNo, x.totalPaise])).toEqual([[a.billNo, 18900], [b.billNo, 8400]]);
    expect(view.bills[0].payments[0]).toMatchObject({ mode: 'card', cardApproval: 'XY12ZZ', cardLast4: '1111', evidence: 'Card machine payment of ₹189, settled 2026-11-15' });
    expect(view.bills[1].payments[0]).toMatchObject({ mode: 'upi', account: 'Company bank', evidence: 'One bank credit of this amount' });
    expect(view.byMode).toEqual({ card: 18900, upi: 8400 });
    expect(view.voids.map((v: any) => [v.billNo, v.reason])).toEqual([[voided.billNo, 'Wrong billing name']]);

    // A tip on a card payment and a discount at payment reach Bookr with the bill.
    const c2 = (await billed(s, [['Masala Dosa', 1]])).bill; // 189
    await s.counter.post(`${s.B}/settlements`, { billIds: [c2.id], payments: [{ mode: 'card', amount: '200', cardApproval: 'TP12TP', cardLast4: '2222' }], difference: { kind: 'tip' } });
    const d2 = (await billed(s, [['Masala Chai', 2]])).bill; // 84
    await s.counter.post(`${s.B}/settlements`, { billIds: [d2.id], payments: [{ mode: 'cash', amount: '80' }], difference: { kind: 'discount', reasonId: s.reasons.discount } });
    expect(await sendOutbox(env, bid, toBookr)).toMatchObject({ sent: 2, rejected: 0 });
    const v2 = (await bookr.get(`/businesses/${bid}/pos?day=${a.shiftDay}`)).json.bills;
    expect(v2.find((x: any) => x.billNo === c2.billNo)).toMatchObject({ tipPaise: 1100, settleDiscountPaise: 0 });
    expect(v2.find((x: any) => x.billNo === c2.billNo).payments[0]).toMatchObject({ amountPaise: 18900, paymentTotalPaise: 20000 });
    expect(v2.find((x: any) => x.billNo === d2.billNo)).toMatchObject({ settleDiscountPaise: 400, settleDiscountReason: 'Regular guest' });

    // Sent again (as after a lost answer): Bookr keeps one copy.
    await posDb.prepare('UPDATE outbox SET sent_at = NULL WHERE business_id = ?').bind(bid).run();
    expect(await sendOutbox(env, bid, toBookr)).toMatchObject({ sent: 5, rejected: 0 });
    expect((await bookrSql`SELECT count(*) AS n FROM pos_bills WHERE business_id = ${bid}`)[0].n).toBe(4);
  });

  it('keeps messages waiting when Bookr refuses the key or cannot be reached', async () => {
    const { bid, s, env } = await connected();
    const { bill } = await billed(s, [['Masala Chai', 1]]);
    await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: '42' }] });
    const wrong = await sendOutbox({ ...env, BOOKR_KEYS: JSON.stringify({ [bid]: 'bookr-pos-wrong' }) }, bid, toBookr);
    expect(wrong).toMatchObject({ sent: 0, waiting: 1 });
    expect(wrong.error).toMatch(/not connected/);
    const down = await sendOutbox(env, bid, async () => { throw new Error('fetch failed'); });
    expect(down).toMatchObject({ sent: 0, waiting: 1, error: 'fetch failed' });
    expect((await q('SELECT attempts, last_error FROM outbox WHERE business_id = ?', bid))[0]).toMatchObject({ attempts: 2, last_error: 'fetch failed' });
    expect(await sendOutbox(env, bid, toBookr)).toMatchObject({ sent: 1, waiting: 0 });
  });

  it('rejects a message that does not add up and keeps it for a person, without resending it', async () => {
    const { bid, bookr, s, env } = await connected();
    const { bill } = await billed(s, [['Masala Chai', 1]]);
    await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: '42' }] });
    await posDb.prepare("UPDATE outbox SET body = json_set(body, '$.payments[0].amountPaise', 100) WHERE business_id = ?").bind(bid).run();
    expect(await sendOutbox(env, bid, toBookr)).toMatchObject({ sent: 0, rejected: 1, waiting: 0 });
    const view = (await bookr.get(`/businesses/${bid}/pos?day=${bill.shiftDay}`)).json;
    expect(view.bills).toHaveLength(0);
    expect(view.rejected[0].note).toMatch(/do not add up/);
    expect((await q('SELECT last_error FROM outbox WHERE business_id = ?', bid))[0].last_error).toMatch(/Rejected by Bookr/);
  });

  it('lets only the Owner connect a POS, and only that business accepts its key', async () => {
    const { bid, key } = await connected();
    const other = await makeBusiness((await makeUser('o2')).id, 'Other');
    const res = await bookrApp.request('/api/pos/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ businessId: other, messages: [] }) }, bookrEnv);
    expect(res.status).toBe(401);
    const ok = await bookrApp.request('/api/pos/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ businessId: bid, messages: [] }) }, bookrEnv);
    expect(ok.status).toBe(200);
  });

  it('links a POS business to Bookr when Bookr knows it by another id (24 Nov 2026)', async () => {
    const owner = await makeUser('owner');
    const bid = await makeBusiness(owner.id, 'Sample Hostel');
    const bookr = await signIn(owner.email);
    const key = (await bookr.post(`/businesses/${bid}/pos/link`)).json.key as string;
    const s = await setupBusiness();   // the POS's own id for the business, not Bookr's
    expect(s.businessId).not.toBe(bid);
    const bill = (await billed(s, [['Masala Chai', 1]])).bill;
    await s.ok(s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: String(bill.totalPaise / 100) }] }));
    // The plain form sends the POS's id, which Bookr refuses for this key.
    const plain = await sendOutbox({ ...posEnv, BOOKR_URL: 'https://bookr.example.test', BOOKR_KEYS: JSON.stringify({ [s.businessId]: key }) }, s.businessId, toBookr);
    expect(plain.sent).toBe(0);
    // With Bookr's id named, the POS sends that id and Bookr takes the bill.
    const linked = await sendOutbox({ ...posEnv, BOOKR_URL: 'https://bookr.example.test', BOOKR_KEYS: JSON.stringify({ [s.businessId]: { bookrId: bid, key } }) }, s.businessId, toBookr);
    expect(linked).toMatchObject({ sent: 1, rejected: 0, waiting: 0 });
  });
});
