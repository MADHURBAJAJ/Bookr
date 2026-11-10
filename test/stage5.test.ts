// Stage 5 (approved 10 Nov 2026): money received with no bill on either side. Checks first (an owed bill, part of a
// bill, a payment made twice); then an advance joins its room bill later, a refund due or a tip for staff is held (not
// income), and interest is suggested as interest. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('money with no bill', () => {
  it('matches an owed bill, holds a refund due and a tip, and spots a payment made twice', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:18', 'UPI', '104'], ['2610312', '31 20:00', 'UPI', '900']]);
    await h.register([{ no: '2610311', amount: '104', pays: [['upi', '104']] }, { no: '2610312', amount: '900', pays: [['upi', '900']] }]);
    await h.decideRest();
    await h.confirm();
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}`;
    const tx = async (no: string) => (await sql`SELECT id, matched_bank_row FROM transactions WHERE bill_no = ${no} AND type = 'income'`)[0];

    // Owed: closed at once (no 7-day wait), and its payment two days later is matched to it.
    const owedTx = (await tx('2610311')).id;
    expect((await acc.post(`${base}/sales/${owedTx}/close`, { note: 'Owed by ABC Travels' })).status).toBe(200);
    const [pay] = await h.credits([['2 11:00', 104]]);
    const chk = (await acc.get(`${base}/bank-rows/${pay}/checks`)).json;
    expect(chk.owed.map((o: any) => [o.txId, o.note])).toEqual([[owedTx, 'Owed by ABC Travels']]);
    expect(chk.parts.map((o: any) => o.billNo)).not.toContain('2610311');
    expect((await h.clients.entry_staff.post(`${base}/bank-rows/${pay}/owed-paid`, { txId: owedTx })).status).toBe(403);
    expect((await acc.post(`${base}/bank-rows/${pay}/owed-paid`, { txId: owedTx })).status).toBe(200);
    expect((await tx('2610311')).matched_bank_row).toBe(pay);
    expect(await sql`SELECT 1 FROM closed_bills WHERE transaction_id = ${owedTx}`).toHaveLength(0);

    // Part of a bill: ₹500 on the shift of the ₹900 bill still waiting.
    const { ids: [part, twiceA, twiceB, out, interest] } = await h.lines([
      ['31 20:05', 500, 'CR', 'UPI/700000001/Paid/guest1@okaxis/SAMPLE BANK/ICIa'],
      ['31 21:00', 250, 'CR', 'UPI/700000002/Paid/rahul@okicici/SAMPLE BANK/ICIa'],
      ['31 21:04', 250, 'CR', 'UPI/700000003/Paid/rahul@okicici/SAMPLE BANK/ICIa'],
      ['2 12:00', 250, 'DR', 'UPI/700000004/Refund/guest9@okhdfc/SAMPLE BANK/ICIa'],
      ['2 13:00', 37, 'CR', 'INT PD 01-10-2026 TO 31-10-2026']]);
    expect((await acc.get(`${base}/bank-rows/${part}/checks`)).json.parts.map((o: any) => o.billNo)).toContain('2610312');
    // Paid twice: same payer, four minutes apart.
    expect((await acc.get(`${base}/bank-rows/${twiceB}/checks`)).json.paidTwice).toMatchObject({ id: twiceA, minutes: 4, samePayer: true });

    // Refund due: held, not income; matched to the refund going out, and opened again with it.
    expect((await acc.post(`${base}/bank-rows/${twiceB}/hold`, { kind: 'refund', note: 'Rahul, paid twice' })).status).toBe(200);
    expect(await sql`SELECT 1 FROM transactions WHERE matched_bank_row = ${twiceB}`).toHaveLength(0);
    let held = (await acc.get(`${base}/held`)).json.held;
    expect(held[0]).toMatchObject({ id: twiceB, kind: 'refund', done: false });
    expect(held[0].outs.map((o: any) => o.id)).toEqual([out]);
    expect((await acc.post(`${base}/bank-rows/${twiceB}/held-done`, { outRowId: out })).status).toBe(200);
    held = (await acc.get(`${base}/held`)).json.held;
    expect(held[0]).toMatchObject({ done: true });
    expect((await sql`SELECT status, pair_row_id FROM bank_rows WHERE id = ${out}`)[0]).toEqual({ status: 'ignored', pair_row_id: twiceB });
    expect((await acc.post(`${base}/bank-rows/${twiceB}/reopen`, {})).status).toBe(200);
    expect((await sql`SELECT status FROM bank_rows WHERE id IN (${twiceB}, ${out})`).map((r: any) => r.status)).toEqual(['unmatched', 'unmatched']);

    // A tip for staff: held, then paid out.
    expect((await acc.post(`${base}/bank-rows/${twiceA}/hold`, { kind: 'tip', note: 'Waiters, 31 Oct' })).status).toBe(200);
    expect((await acc.post(`${base}/bank-rows/${twiceA}/held-done`, {})).status).toBe(200);
    expect((await acc.get(`${base}/held`)).json.held.find((x: any) => x.id === twiceA)).toMatchObject({ kind: 'tip', done: true });

    // Not a sale: interest in the description suggests the interest head.
    const rows = (await acc.get(`${base}/bank-rows?from=2026-11-02&to=2026-11-02`)).json.rows;
    const [ih] = await sql`SELECT id FROM heads WHERE business_id = ${h.bid} AND name = 'Interest received'`;
    expect(rows.find((r: any) => r.id === interest).suggest.headId).toBe(ih.id);
  });

  it('books an advance and lets a room bill paid in parts use it', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    const [sales] = await sql`SELECT id FROM heads WHERE business_id = ${h.bid} AND name = 'Sales'`;
    await h.clients.owner.put(`/businesses/${h.bid}/bill-type-heads/room`, { headId: sales.id });
    const [adv] = await h.credits([['30 10:00', 5000]]);
    const acc = h.clients.accountant;
    const base = `/businesses/${h.bid}`;
    expect((await acc.post(`${base}/bank-rows/book-many`, { items: [{ rowId: adv, billType: 'room', item: 'Advance: Mr Sharma, room 12' }] })).json.booked).toBe(1);

    await h.software([['2610341', '31 11:00', 'CASH', '12000']]);
    await h.register([{ no: '2610341', amount: '12000', pays: [['upi', '5000'], ['cash', '7000']] }]);
    await h.decideRest('2026-10-31', () => 'use_register');
    await h.confirm();
    const r = await h.reconcile();
    const card = r.fixes.find((c: any) => c.kind === 'same_sale');
    expect(card?.title, JSON.stringify(r.fixes.map((c: any) => c.title))).toMatch(/^Advance of ₹5,000\.00 received on 30 Oct: does bill 2610341 use it\?/);
    const a = card.actions[0];
    expect((await acc.post(a.path, a.body)).status).toBe(200);
    const [line] = await sql`SELECT matched_bank_row, day FROM transactions WHERE bill_no = '2610341' AND type = 'income' AND payment_mode = 'upi'`;
    expect(line).toEqual({ matched_bank_row: adv, day: '2026-10-30' });
    // Counted once: the advance booking is gone.
    expect(await sql`SELECT 1 FROM transactions WHERE source = 'bank_sheet' AND business_id = ${h.bid}`).toHaveLength(0);
  });
});
