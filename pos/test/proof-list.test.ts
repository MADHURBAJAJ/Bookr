// Payment proof list (24 Nov 2026): the POS sends its shift's bills to Bookr, which answers each with the proof posted
// in the Guest payment group. Both sides in-process, each with its own database. All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { app as bookrApp } from '../../src/app';
import { env as bookrEnv, makeBusiness, makeUser, signIn, sql as bookrSql } from '../../test/helpers';
import { proofList } from '../src/routes/proof';
import { billed, dispose, env as posEnv, setupBusiness } from './helpers';

afterAll(async () => { await dispose(); await bookrSql.end(); });

const toBookr: typeof fetch = async (url, init) => bookrApp.request(new URL(String(url)).pathname, init as RequestInit, bookrEnv);

describe('the payment proof list', () => {
  it('shows printed bills waiting, settled bills matched or missing, and extras; without Bookr it lists the bills alone', async () => {
    const owner = await makeUser('owner');
    const bid = await makeBusiness(owner.id, 'Sample Hotel');
    const bookr = await signIn(owner.email);
    const key = (await bookr.post(`/businesses/${bid}/pos/link`)).json.key as string;
    const s = await setupBusiness({ businessId: bid });
    const env = { ...posEnv, BOOKR_URL: 'https://bookr.example.test', BOOKR_KEYS: JSON.stringify({ [bid]: key }) };

    const a = (await billed(s, [['Masala Dosa', 1]])).bill; // 189, paid by UPI
    const b = (await billed(s, [['Masala Chai', 2]])).bill; // 84, paid in cash
    const c = (await billed(s, [['Butter Naan', 1]])).bill; // printed, not paid
    await s.counter.post(`${s.B}/settlements`, { billIds: [a.id], payments: [{ mode: 'upi', amount: '189', payAccountId: s.upiCompany }] });
    await s.counter.post(`${s.B}/settlements`, { billIds: [b.id], payments: [{ mode: 'cash', amount: '84' }] });

    const alone = await proofList(posEnv as any, bid, a.shiftDay, 8);
    expect(alone).toMatchObject({ connected: false });
    expect(alone.bills.map((x) => [x.billNo, x.state])).toEqual([[a.billNo, 'settled'], [b.billNo, 'settled'], [c.billNo, 'printed']]);

    // In the Guest payment group: the UPI screenshot captioned with the bill number, and a UPI with no POS bill.
    const g = crypto.randomUUID();
    await bookrSql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, active, pos_proof, created_at) VALUES (${g}, ${bid}, '120363000000000009@g.us', 'Guest payment', 1, 1, ${Date.now()})`;
    let k = 0;
    const post = async (amount: number, caption: string | null) => {
      const id = crypto.randomUUID();
      await bookrSql`INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sent_at, media_type, file_key, content_sha256, size_bytes, caption, kind, read_status, amount_paise, created_at)
        VALUES (${id}, ${bid}, ${g}, ${'m-' + id}, ${Date.now() + ++k}, 'image/jpeg', ${'wa/' + id}, ${'sha' + id}, 4, ${caption}, 'upi', 'read', ${amount}, ${Date.now()})`;
    };
    await post(18900, a.billNo);
    await post(55500, null);

    const r = await proofList(env as any, bid, a.shiftDay, 8, toBookr) as any;
    expect(r.error).toBeUndefined();
    expect(r.rows.map((x: any) => [x.billNo, x.status, x.missing])).toEqual([
      [a.billNo, 'matched', []], [b.billNo, 'missing', ['No cash note']], [c.billNo, 'waiting', []]]);
    expect(r.extras.map((e: any) => e.what)).toEqual(['UPI ₹555, no POS bill']);

    // Bookr down: the bills still show, with why.
    const down = await proofList(env as any, bid, a.shiftDay, 8, async () => { throw new Error('offline'); }) as any;
    expect(down).toMatchObject({ connected: true, error: 'offline' });
    expect(down.bills).toHaveLength(3);
  });
});
