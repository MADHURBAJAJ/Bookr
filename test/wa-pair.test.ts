// WhatsApp inbox, phase 3 (24 Nov 2026): pairing UPI photos with bills, and duplicates.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { readWithClaude } from '../src/claude';
import { captionNames, choosePairs, findDuplicate, pairByHand, pairGroup, score, unpair, type PairItem } from '../src/waPair';
import { runWaQueue, type WaReading } from '../src/waRead';
import { istToMs } from '../src/time';
import { businessWithAllRoles, env, resetDb, sql, uploads } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
const at = (d: number, h: number, m: number, s = 30) => istToMs(2026, 11, d, h, m, s);
const ASHWIN = '919800000000';

// The 18 real photos of 23-24 Nov 2026 (wa-samples), as Bookr read them; UTRs left out. 5 and 10 have no payment photo.
const SAMPLES: PairItem[] = [
  { id: 'u01', kind: 'upi', amountPaise: 249700, sentAt: at(23, 21, 8) },
  { id: 'b02', kind: 'bill', amountPaise: 249700, billNo: '26112317', sentAt: at(23, 21, 8, 50) },
  { id: 'u03', kind: 'upi', amountPaise: 23000, sentAt: at(23, 21, 9) },
  { id: 'b04', kind: 'bill', amountPaise: 23000, billNo: '26112386', sentAt: at(23, 21, 9, 50) },
  { id: 'b05', kind: 'bill', amountPaise: 12500, billNo: '26112376', sentAt: at(23, 21, 53) },
  { id: 'u06', kind: 'upi', amountPaise: 56400, sentAt: at(23, 22, 0) },
  { id: 'b07', kind: 'bill', amountPaise: 56400, billNo: '26112389', sentAt: at(23, 22, 0, 50) },
  { id: 'u08', kind: 'upi', amountPaise: 20000, sentAt: at(23, 22, 1) },
  { id: 'b09', kind: 'bill', amountPaise: 20000, billNo: '26112390', sentAt: at(23, 22, 27) },
  { id: 'b10', kind: 'bill', amountPaise: 36800, billNo: '26112391', sentAt: at(23, 22, 39) },
  { id: 'u11', kind: 'upi', amountPaise: 90000, sentAt: at(23, 23, 1) },
  { id: 'b12', kind: 'bill', amountPaise: 83900, billNo: '26112392', sentAt: at(23, 23, 2) },
  { id: 'u13', kind: 'upi', amountPaise: 22900, caption: '2611243', sentAt: at(24, 1, 26, 40) },
  { id: 'b14', kind: 'bill', amountPaise: 22900, billNo: '2611243', replyTo: 'm-u13', sentAt: at(24, 1, 27, 10) },
  { id: 'u15', kind: 'upi', amountPaise: 31400, sentAt: at(24, 1, 47) },
  { id: 'b16', kind: 'bill', amountPaise: 31400, billNo: '2611244', sentAt: at(24, 1, 49) },
  { id: 'u17', kind: 'upi', amountPaise: 38500, caption: '2611241', sentAt: at(24, 0, 13) },
  { id: 'b18', kind: 'bill', amountPaise: 36800, billNo: '2611241', replyTo: 'm-u17', sentAt: at(24, 0, 14) },
].map((x) => ({ sender: ASHWIN, replyTo: null, caption: null, billNo: null, messageId: `m-${x.id}`, ...x } as PairItem));

describe('pairing rules', () => {
  it('pairs the 18 real photos as a person would, with the bills that have no payment left alone', () => {
    const got = choosePairs(SAMPLES).map((p) => [p.upiId, p.billId, p.confidence, p.reasons.join(', ')]);
    expect(got.sort()).toEqual([
      ['u01', 'b02', 80, 'same amount, same minute'],
      ['u03', 'b04', 80, 'same amount, same minute'],
      ['u06', 'b07', 80, 'same amount, same minute'],
      ['u08', 'b09', 70, 'same amount, 26 min apart'],
      ['u11', 'b12', 50, 'paid ₹61 more, 1 min apart'],
      ['u13', 'b14', 99, 'reply, bill no. in caption, same amount, 1 min apart'],
      ['u15', 'b16', 80, 'same amount, 2 min apart'],
      ['u17', 'b18', 89, 'reply, bill no. in caption, paid ₹17 more, 1 min apart'],
    ]);
  });

  it('a bill number in the caption is a whole number, not part of one', () => {
    expect(captionNames('2611241', '2611241')).toBe(true);
    expect(captionNames('bill 2611241 table 6', '2611241')).toBe(true);
    expect(captionNames('26112411', '2611241')).toBe(false);
    expect(captionNames('12', '12')).toBe(false);
    expect(captionNames(null, '2611241')).toBe(false);
  });

  const u = (o: Partial<PairItem> = {}) => ({ id: 'u', kind: 'upi', sender: ASHWIN, messageId: 'mu', replyTo: null, caption: null, sentAt: at(23, 21, 0), amountPaise: 50000, billNo: null, ...o } as PairItem);
  const b = (o: Partial<PairItem> = {}) => ({ id: 'b', kind: 'bill', sender: ASHWIN, messageId: 'mb', replyTo: null, caption: null, sentAt: at(23, 21, 2), amountPaise: 50000, billNo: '2611245', ...o } as PairItem);

  it('without a reply or bill number: same sender, within half an hour, same amount (or a little more within 10 min)', () => {
    expect(score(u(), b({ sentAt: at(23, 21, 25) }))?.confidence).toBe(70);
    expect(score(u(), b({ sentAt: at(23, 21, 35) }))).toBeNull();
    expect(score(u(), b({ sender: '919811111111' }))).toBeNull();
    expect(score(u({ amountPaise: 55000 }), b())?.confidence).toBe(50);
    expect(score(u({ amountPaise: 55100 }), b())).toBeNull(); // more than 10% over
    expect(score(u({ amountPaise: 40000 }), b())).toBeNull(); // paid less: part of the bill
    expect(score(u({ amountPaise: null }), b())).toBeNull();
  });

  it('a reply or bill number pairs even from another sender, or with amounts that differ', () => {
    expect(score(u(), b({ replyTo: 'mu', sender: '919811111111' }))).toMatchObject({ confidence: 95 });
    expect(score(u({ replyTo: 'mb' }), b())).toMatchObject({ confidence: 95, reasons: ['reply', 'same amount', '2 min apart'] });
    expect(score(u({ caption: '2611245', amountPaise: 30000 }), b())).toMatchObject({ confidence: 60, reasons: ['bill no. in caption', 'paid ₹200 less', '2 min apart'] });
    expect(score(u({ caption: '2611245' }), b({ sentAt: at(25, 21, 0) }))).toBeNull(); // over a day apart
  });

  it('two equally good bills: the nearer is paired, less sure', () => {
    const p = choosePairs([u(), b({ id: 'b1', sentAt: at(23, 21, 5) }), b({ id: 'b2', sentAt: at(23, 21, 2) })]);
    expect(p).toEqual([{ upiId: 'u', billId: 'b2', confidence: 50, reasons: ['same amount', '2 min apart', 'another fits too'] }]);
  });

  it('a reply wins over a plain same-amount match', () => {
    const p = choosePairs([u(), b({ id: 'b1', sentAt: at(23, 21, 1) }), b({ id: 'b2', sentAt: at(23, 21, 9), replyTo: 'mu' })]);
    expect(p.map((x) => x.billId)).toEqual(['b2']);
  });

  it('never makes a pair a person took apart', () => {
    expect(choosePairs([u(), b()], new Set(['u|b']))).toEqual([]);
  });
});

describe('in the database', () => {
  let bid: string;
  let groupId: string;
  let owner: string;
  let n = 0;
  const add = async (o: { kind: 'upi' | 'bill'; amount: number; sent: number; utr?: string; billNo?: string; caption?: string; reply?: string;
    docAt?: number; payee?: string; status?: string; read?: string }) => {
    const id = `item-${++n}`;
    const extracted = o.kind === 'upi' ? { reading: { upi: { payee_vpa: o.payee ?? 'exosparkgoainn@icici' } } } : { reading: {} };
    await sql`INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sender_number, sent_at, media_type, file_key, content_sha256, size_bytes,
        caption, reply_to_id, kind, read_status, extracted_json, amount_paise, utr, bill_no, doc_at, status, created_at)
      VALUES (${id}, ${bid}, ${groupId}, ${'m-' + id}, ${ASHWIN}, ${o.sent}, 'image/jpeg', ${'k' + n}, ${'s' + n}, 1,
        ${o.caption ?? null}, ${o.reply ?? null}, ${o.kind}, ${o.read ?? 'read'}, ${JSON.stringify(extracted)}, ${o.amount * 100}, ${o.utr ?? null},
        ${o.billNo ?? null}, ${o.docAt ?? null}, ${o.status ?? 'pending'}, ${Date.now() + n})`;
    return id;
  };
  const pairs = async () => (await sql`SELECT upi_item_id, bill_item_id, confidence, by_hand FROM wa_pairs ORDER BY upi_item_id`)
    .map((p) => [p.upi_item_id, p.bill_item_id, p.confidence, p.by_hand]);
  const pairAll = () => pairGroup(env.DB, groupId, at(23, 0, 0), at(25, 0, 0));

  beforeEach(async () => {
    await resetDb();
    const h = await businessWithAllRoles('XOXO');
    bid = h.bid;
    owner = h.users.owner.id;
    groupId = crypto.randomUUID();
    await sql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, active, created_at) VALUES (${groupId}, ${bid}, '120363000000000001@g.us', 'Guest payment', 1, ${Date.now()})`;
  });

  it('pairs, and leaves unread, rejected and confirmed items out', async () => {
    const u1 = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    const b1 = await add({ kind: 'bill', amount: 230, billNo: '26112386', sent: at(23, 21, 10) });
    await add({ kind: 'upi', amount: 125, sent: at(23, 21, 50), read: 'waiting' });
    await add({ kind: 'bill', amount: 125, billNo: '26112376', sent: at(23, 21, 53) });
    await add({ kind: 'upi', amount: 564, sent: at(23, 22, 0), status: 'rejected' });
    await add({ kind: 'bill', amount: 564, billNo: '26112389', sent: at(23, 22, 1) });
    await pairAll();
    expect(await pairs()).toEqual([[u1, b1, 80, 0]]);
    const [p] = await sql`SELECT reasons FROM wa_pairs`;
    expect(JSON.parse(p.reasons)).toEqual(['same amount', '1 min apart']);
  });

  it('a bill sent later as a reply takes the UPI photo from a weaker pair', async () => {
    const u1 = await add({ kind: 'upi', amount: 200, sent: at(23, 22, 0) });
    const b1 = await add({ kind: 'bill', amount: 200, billNo: '26112390', sent: at(23, 22, 5) });
    await pairAll();
    expect(await pairs()).toEqual([[u1, b1, 80, 0]]);
    const b2 = await add({ kind: 'bill', amount: 200, billNo: '26112393', sent: at(23, 22, 20), reply: 'm-' + u1 });
    await pairAll();
    expect(await pairs()).toEqual([[u1, b2, 95, 0]]);
  });

  it('working it out again changes nothing that is still right', async () => {
    await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    await add({ kind: 'bill', amount: 230, sent: at(23, 21, 10) });
    await pairAll();
    const [first] = await sql`SELECT id, created_at FROM wa_pairs`;
    await pairAll();
    expect(await sql`SELECT id, created_at FROM wa_pairs`).toEqual([first]);
  });

  it('a person pairs by hand: the old pairs are taken apart and not made again', async () => {
    const u1 = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    const b1 = await add({ kind: 'bill', amount: 230, sent: at(23, 21, 10) });
    const b2 = await add({ kind: 'bill', amount: 250, sent: at(23, 21, 40) });
    await pairAll();
    await pairByHand(env.DB, bid, u1, b2, owner);
    await pairAll();
    expect(await pairs()).toEqual([[u1, b2, 100, 1]]);
    expect(await sql`SELECT upi_item_id, bill_item_id FROM wa_not_pairs`).toEqual([{ upi_item_id: u1, bill_item_id: b1 }]);
    expect((await sql`SELECT action, user_id FROM audit_log WHERE action LIKE 'wa.%'`)).toEqual([{ action: 'wa.pair', user_id: owner }]);
    await expect(pairByHand(env.DB, bid, b1, u1, owner)).rejects.toThrow('Pair a UPI payment with a bill.');
  });

  it('a pair taken apart stays apart, until a person pairs it again', async () => {
    const u1 = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    const b1 = await add({ kind: 'bill', amount: 230, sent: at(23, 21, 10) });
    await pairAll();
    const [p] = await sql`SELECT id FROM wa_pairs`;
    await unpair(env.DB, bid, p.id, owner);
    await pairAll();
    expect(await pairs()).toEqual([]);
    await pairByHand(env.DB, bid, u1, b1, owner);
    expect(await pairs()).toEqual([[u1, b1, 100, 1]]);
    expect(await sql`SELECT * FROM wa_not_pairs`).toEqual([]);
  });

  it('another business cannot pair or unpair these', async () => {
    const other = await businessWithAllRoles('Other');
    const u1 = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    const b1 = await add({ kind: 'bill', amount: 230, sent: at(23, 21, 10) });
    await expect(pairByHand(env.DB, other.bid, u1, b1, other.users.owner.id)).rejects.toThrow('Item not found.');
    await pairAll();
    const [p] = await sql`SELECT id FROM wa_pairs`;
    await expect(unpair(env.DB, other.bid, p.id, other.users.owner.id)).rejects.toThrow('Pair not found.');
  });

  describe('duplicates', () => {
    it('the same UTR again is the later one', async () => {
      const first = await add({ kind: 'upi', amount: 2497, utr: '319852358212', sent: at(23, 21, 8) });
      const again = await add({ kind: 'upi', amount: 2497, utr: '319852358212', sent: at(23, 21, 30) });
      expect(await findDuplicate(env.DB, again)).toBe(first);
      expect(await findDuplicate(env.DB, first)).toBeNull();
    });

    it('no UTR: same amount, payee and minute', async () => {
      const first = await add({ kind: 'upi', amount: 564, docAt: at(23, 22, 0, 0), sent: at(23, 22, 0) });
      const again = await add({ kind: 'upi', amount: 564, docAt: at(23, 22, 0, 0), sent: at(23, 22, 3) });
      const otherPayee = await add({ kind: 'upi', amount: 564, docAt: at(23, 22, 0, 0), payee: 'someone@okaxis', sent: at(23, 22, 4) });
      const otherMinute = await add({ kind: 'upi', amount: 564, docAt: at(23, 22, 1, 0), sent: at(23, 22, 5) });
      expect(await findDuplicate(env.DB, again)).toBe(first);
      expect(await findDuplicate(env.DB, otherPayee)).toBeNull();
      expect(await findDuplicate(env.DB, otherMinute)).toBeNull();
    });

    it('the same bill photographed again', async () => {
      const first = await add({ kind: 'bill', amount: 368, billNo: '2611241', sent: at(24, 0, 13) });
      const again = await add({ kind: 'bill', amount: 368, billNo: '2611241', sent: at(24, 0, 20) });
      const otherTotal = await add({ kind: 'bill', amount: 400, billNo: '2611241', sent: at(24, 0, 21) });
      expect(await findDuplicate(env.DB, again)).toBe(first);
      expect(await findDuplicate(env.DB, otherTotal)).toBeNull();
    });

    it('after reading: the later copy is set aside with a note and left out of pairing', async () => {
      const mocked = vi.mocked(readWithClaude);
      Object.assign(env, { ANTHROPIC_API_KEY: 'test-key', OCR_MAX_PARALLEL: '3' });
      const reading = (amount: string): WaReading => ({ kind: 'upi', legible: 'clear', bill: null, card: null, unclear: [],
        upi: { amount, date: '23 Nov', time: '9:08 PM', utr: '319852358212', app: 'Paytm', payer_name: null, payer_vpa: null, payer_bank: null,
          payee_name: null, payee_vpa: 'exosparkgoainn@icici', status: 'success' } });
      const ids: string[] = [];
      for (const [i, sent] of [at(23, 21, 8, 40), at(23, 21, 9, 10)].entries()) {
        const id = `w${i}`;
        await uploads.put(`wa/${bid}/${id}`, new Uint8Array([0xff, 0xd8, 0xff, i]));
        await sql`INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sender_number, sent_at, media_type, file_key, content_sha256, size_bytes, created_at)
          VALUES (${id}, ${bid}, ${groupId}, ${'m-' + id}, ${ASHWIN}, ${sent}, 'image/jpeg', ${`wa/${bid}/${id}`}, ${'x' + i}, 4, ${Date.now()})`;
        ids.push(id);
      }
      const bill = await add({ kind: 'bill', amount: 2497, billNo: '26112317', sent: at(23, 21, 9, 30) });
      mocked.mockResolvedValue({ data: reading('2497'), model: 'm' });
      expect((await runWaQueue(env as never)).read).toBe(2);
      const rows = await sql`SELECT id, status, duplicate_of, read_note FROM wa_items WHERE id IN (${ids[0]}, ${ids[1]}) ORDER BY id`;
      expect(rows[0]).toMatchObject({ status: 'pending', duplicate_of: null });
      expect(rows[1]).toMatchObject({ status: 'duplicate', duplicate_of: ids[0], read_note: 'Same payment as one posted 2026-11-23 21:08.' });
      expect(await pairs()).toEqual([[ids[0], bill, 80, 0]]);
    });
  });
});

afterAll(() => sql.end());
