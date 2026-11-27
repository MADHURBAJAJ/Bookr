// WhatsApp inbox, phase 2 (24 Nov 2026): reading stored files. Claude is mocked; no test calls the API.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { OcrError, readWithClaude } from '../src/claude';
import { runWaQueue, settle, waInstructions, type WaReading } from '../src/waRead';
import { istToMs } from '../src/time';
import { businessWithAllRoles, env, resetDb, sql, uploads } from './helpers';

const mocked = vi.mocked(readWithClaude);
vi.setConfig({ testTimeout: 60_000 });

const SENT = istToMs(2026, 11, 23, 21, 8, 40);
const upi = (over: Partial<NonNullable<WaReading['upi']>> = {}, top: Partial<WaReading> = {}): WaReading => ({
  kind: 'upi', legible: 'clear', bill: null, card: null, unclear: [],
  upi: { amount: '2497', date: '2026-11-23', time: '21:08', utr: '3198 5235 8212', app: 'Paytm', payer_name: null, payer_vpa: null, payer_bank: null,
    payee_name: 'M S Exospark Goa Inn Private Limited', payee_vpa: 'exosparkgoainn@icici', status: 'success', ...over },
  ...top,
});
const bill = (over: Partial<NonNullable<WaReading['bill']>> = {}): WaReading => ({
  kind: 'bill', legible: 'clear', upi: null, card: null, unclear: [],
  bill: { vendor: 'XOXO HOSTEL', bill_no: '26112317', date: '2026-11-23', time: '21:08', sub_total: '2270.00', service_charge: '113.50', gst: '113.50', total: '2497.00', items: '3 Black N White 30, 5 Budweiser Pint', ...over },
});

describe('settle: what is kept from a reading', () => {
  it('a UPI screen: amount in paise, UTR without spaces, the time on the screen', () => {
    expect(settle(upi(), SENT)).toEqual({ kind: 'upi', amountPaise: 249700, utr: '319852358212', billNo: null, cardApproval: null, cardLast4: null,
      docAt: istToMs(2026, 11, 23, 21, 8), failed: false, notes: [] });
  });

  it('a bill: bill number and grand total', () => {
    expect(settle(bill(), SENT)).toMatchObject({ kind: 'bill', amountPaise: 249700, billNo: '26112317', utr: null, docAt: istToMs(2026, 11, 23, 21, 8) });
  });

  it('a card slip: amount, approval code and last 4 digits; a declined slip is marked', () => {
    const card = (over: Partial<NonNullable<WaReading['card']>> = {}): WaReading => ({ kind: 'card', legible: 'clear', upi: null, bill: null, unclear: [],
      card: { amount: '1,250.00', date: '23/11/26', time: '21:06', approval_code: 'a1b 2c3', last4: 'XXXX XXXX XXXX 4417', status: 'approved', ...over } });
    expect(settle(card({ amount: '1250.00' }), SENT)).toEqual({ kind: 'card', amountPaise: 125000, utr: null, billNo: null, cardApproval: 'A1B2C3',
      cardLast4: '4417', docAt: istToMs(2026, 11, 23, 21, 6), failed: false, notes: [] });
    expect(settle(card({ status: 'declined' }), SENT)).toMatchObject({ failed: true, notes: ['The slip shows a declined or void charge.'] });
    expect(settle(card({ status: 'unknown', last4: '44' }), SENT)).toMatchObject({ cardLast4: null, notes: ['Card slip: approval not clear.'] });
    // A photo of the card machine's screen (28 Nov 2026): the amount and time it shows, often no approval code or digits.
    expect(settle(card({ source: 'screen', amount: '980', approval_code: null, last4: null }), SENT)).toMatchObject({ kind: 'card', amountPaise: 98000,
      cardApproval: null, cardLast4: null, docAt: istToMs(2026, 11, 23, 21, 6), failed: false, notes: ['A photo of the card machine screen, not the printed slip.'] });
    expect(settle(card({ source: 'screen', status: 'declined' }), SENT)).toMatchObject({ failed: true, notes: ['The card machine screen shows a declined or void charge.', 'A photo of the card machine screen, not the printed slip.'] });
    expect(waInstructions({ sent_at: SENT, caption: null, group_name: 'Guest payment' })).toContain('a photo of the card machine\'s screen');
  });

  it('a failed payment is marked, a pending one noted', () => {
    expect(settle(upi({ status: 'failed' }), SENT)).toMatchObject({ failed: true, notes: ['The screenshot shows a failed payment.'] });
    expect(settle(upi({ status: 'pending' }), SENT)).toMatchObject({ failed: false, notes: ['Payment status: pending.'] });
  });

  it('a blurred screen says what to check, and an unreadable one says so', () => {
    expect(settle(upi({ amount: '200', utr: null, date: null, time: null }, { legible: 'unsure', unclear: ['date', 'time'] }), SENT).notes)
      .toEqual(['Check: date, time.']);
    expect(settle(upi({ amount: null }, { legible: 'unreadable' }), SENT).notes).toEqual(['Too unclear to read; check it by hand.']);
    expect(settle(upi({ amount: null }), SENT).notes).toEqual(['No amount read.']);
  });

  it('a time with no date takes the message day, or the day before just after midnight', () => {
    expect(settle(upi({ date: null, time: '21:05' }), SENT).docAt).toBe(istToMs(2026, 11, 23, 21, 5));
    const justAfter = istToMs(2026, 11, 24, 0, 2);
    expect(settle(upi({ date: null, time: '23:58' }), justAfter).docAt).toBe(istToMs(2026, 11, 23, 23, 58));
  });

  it('reads dates and times as the screens and bills show them (real samples, 24 Nov 2026)', () => {
    const sent = istToMs(2026, 11, 24, 0, 10);
    const at = (date: string | null, time: string | null) => settle(upi({ date, time }), sent).docAt;
    expect(at('24 Nov', '12:09 AM')).toBe(istToMs(2026, 11, 24, 0, 9)); // Paytm
    expect(at('23 November 2026', '10:00 pm')).toBe(istToMs(2026, 11, 23, 22, 0)); // Google Pay
    expect(at('23 Nov 2026', '9:09 PM')).toBe(istToMs(2026, 11, 23, 21, 9)); // Navi
    expect(at('Nov 23, 2026', '9:09 p.m.')).toBe(istToMs(2026, 11, 23, 21, 9));
    expect(at('2026-11-23', '21:09')).toBe(istToMs(2026, 11, 23, 21, 9));
    expect(at(null, '12:05 am')).toBe(istToMs(2026, 11, 24, 0, 5)); // time only: the message's day
    expect(settle(bill({ date: '23/11/26', time: '21:08' }), SENT).docAt).toBe(istToMs(2026, 11, 23, 21, 8));
    expect(settle(bill({ date: '24/11/2026', time: '01:26' }), istToMs(2026, 11, 24, 1, 27)).docAt).toBe(istToMs(2026, 11, 24, 1, 26));
  });

  it('a date with no year sent just after new year is last year', () => {
    expect(settle(upi({ date: '31 Dec', time: '11:58 PM' }), istToMs(2027, 1, 1, 0, 1)).docAt).toBe(istToMs(2026, 12, 31, 23, 58));
  });

  it('does not guess a time or date it cannot understand', () => {
    expect(settle(upi({ time: '25:10' }), SENT).docAt).toBeNull();
    expect(settle(upi({ time: '13:10 PM' }), SENT).docAt).toBeNull();
    expect(settle(upi({ date: '31/02/26' }), SENT).docAt).toBeNull();
    expect(settle(upi({ date: 'yesterday' }), SENT).docAt).toBeNull();
  });

  it('asks to check only the values Bookr uses, not payer details a screen does not show', () => {
    expect(settle(upi({}, { legible: 'clear', unclear: ['payer_name', 'payer_vpa', 'payer_bank'] }), SENT).notes).toEqual([]);
    expect(settle(upi({}, { legible: 'unsure', unclear: ['date', 'payer_name'] }), SENT).notes).toEqual(['Check: date.']);
    expect(settle(upi({}, { legible: 'unsure', unclear: ['payer_name'] }), SENT).notes).toEqual(['Check: some values are a best guess.']);
  });

  it('a date with no time is not placed in the day', () => {
    expect(settle(upi({ time: null }), SENT).docAt).toBeNull();
  });

  it('a time far from when it was sent is flagged', () => {
    expect(settle(upi({ date: '2026-11-20' }), SENT).notes[0]).toMatch(/far from when it was sent/);
  });

  it('nonsense amounts are not kept', () => {
    expect(settle(upi({ amount: '₹2,497' }), SENT).amountPaise).toBeNull();
    expect(settle(upi({ amount: '0' }), SENT).amountPaise).toBeNull();
    expect(settle(bill({ total: '2,497.00' }), SENT).amountPaise).toBe(249700);
  });

  it('the instructions carry the group, India time and caption, and say not to fill from the caption', () => {
    const text = waInstructions({ sent_at: SENT, caption: '2611241', group_name: 'Guest payment' });
    expect(text).toContain('group "Guest payment", sent 2026-11-23 21:08 India time, caption "2611241"');
    expect(text).toMatch(/Never fill a value from the caption/);
  });
});

describe('the reading queue', () => {
  let bid: string;
  let groupId: string;
  let n = 0;
  const add = async (over: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    const key = `wa/${bid}/${id}`;
    await uploads.put(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47, ++n]), { httpMetadata: { contentType: 'image/png' } });
    const row = { sent_at: SENT + n, caption: null, created_at: Date.now(), ...over };
    await sql`INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sent_at, media_type, file_key, content_sha256, size_bytes, caption, created_at)
      VALUES (${id}, ${bid}, ${groupId}, ${'M' + n}, ${row.sent_at}, 'image/png', ${key}, ${'sha' + n}, 5, ${row.caption}, ${row.created_at})`;
    return { id, key };
  };
  const item = async (id: string) => (await sql`SELECT * FROM wa_items WHERE id = ${id}`)[0];

  beforeEach(async () => {
    await resetDb();
    mocked.mockReset();
    Object.assign(env, { ANTHROPIC_API_KEY: 'test-key', CLAUDE_OCR_MODEL: 'claude-opus-5-5', OCR_MAX_PARALLEL: '3' });
    delete env.WA_DAILY_READ_LIMIT;
    bid = (await businessWithAllRoles('XOXO')).bid;
    groupId = crypto.randomUUID();
    await sql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, active, created_at) VALUES (${groupId}, ${bid}, '120363000000000001@g.us', 'Guest payment', 1, ${Date.now()})`;
  });

  it('reads a waiting file and keeps what was read', async () => {
    const { id } = await add({ caption: '2611241' });
    mocked.mockResolvedValueOnce({ data: upi(), model: 'claude-opus-5-5' });
    expect(await runWaQueue(env as never)).toEqual({ read: 1, failed: 0, skipped: null });
    const [page, instructions] = mocked.mock.calls[0].slice(1, 3) as [unknown, string];
    expect(page).toMatchObject({ mediaType: 'image/png' });
    expect(instructions).toContain('caption "2611241"');
    expect(await item(id)).toMatchObject({ read_status: 'read', kind: 'upi', amount_paise: 249700, utr: '319852358212', bill_no: null,
      doc_at: istToMs(2026, 11, 23, 21, 8), status: 'pending', read_tries: 1, read_note: null });
    expect(JSON.parse((await item(id)).extracted_json)).toEqual({ model: 'claude-opus-5-5', reading: upi() });
    const [a] = await sql`SELECT * FROM audit_log WHERE action = 'wa.read'`;
    expect(a).toMatchObject({ business_id: bid, user_id: null, row_id: id });
    // Read once: the next run has nothing to do.
    expect(await runWaQueue(env as never)).toEqual({ read: 0, failed: 0, skipped: null });
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('sets a failed payment aside for the reviewer', async () => {
    const { id } = await add();
    mocked.mockResolvedValueOnce({ data: upi({ status: 'failed' }), model: 'm' });
    await runWaQueue(env as never);
    expect(await item(id)).toMatchObject({ status: 'rejected', read_note: 'The screenshot shows a failed payment.' });
  });

  it('reads a few at a time, oldest first', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await add()).id);
    mocked.mockResolvedValue({ data: bill(), model: 'm' });
    expect((await runWaQueue(env as never)).read).toBe(3);
    expect((await sql`SELECT id FROM wa_items WHERE read_status = 'read' ORDER BY sent_at`).map((r) => r.id)).toEqual(ids.slice(0, 3));
    expect((await runWaQueue(env as never)).read).toBe(2);
  });

  it('stops at the daily limit; a read Claude never did is free', async () => {
    env.WA_DAILY_READ_LIMIT = '2';
    for (let i = 0; i < 4; i++) await add();
    mocked.mockRejectedValueOnce(new OcrError(429, 'Claude is busy right now.', true));
    mocked.mockResolvedValue({ data: bill(), model: 'm' });
    // Room for 2: one is read, one finds Claude busy (free, so it does not use up the limit).
    expect(await runWaQueue(env as never)).toEqual({ read: 1, failed: 1, skipped: null });
    expect(await runWaQueue(env as never)).toEqual({ read: 1, failed: 0, skipped: null });
    expect(await runWaQueue(env as never)).toEqual({ read: 0, failed: 0, skipped: 'daily limit' });
    expect((await sql`SELECT count(*) AS n FROM wa_items WHERE read_status = 'waiting'`)[0].n).toBe(2);
  });

  it('Claude busy: tried again after a minute, the try not counted', async () => {
    const { id } = await add();
    mocked.mockRejectedValueOnce(new OcrError(429, 'Claude is busy right now. Try again in a minute.', true));
    await runWaQueue(env as never);
    const it1 = await item(id);
    expect(it1).toMatchObject({ read_status: 'waiting', read_tries: 0, read_note: 'Claude is busy right now. Try again in a minute.' });
    expect(it1.read_after).toBeGreaterThan(Date.now() + 30_000);
    expect((await runWaQueue(env as never)).read).toBe(0); // not yet
    await sql`UPDATE wa_items SET read_after = 0`;
    mocked.mockResolvedValueOnce({ data: bill(), model: 'm' });
    expect((await runWaQueue(env as never)).read).toBe(1);
  });

  it('Claude could not read it: tried three times, waiting longer each time, then failed', async () => {
    const { id } = await add();
    mocked.mockRejectedValue(new OcrError(502, 'Claude could not read this file.'));
    for (let i = 1; i <= 3; i++) {
      await runWaQueue(env as never);
      expect(await item(id)).toMatchObject({ read_tries: i, read_status: i < 3 ? 'waiting' : 'failed' });
      await sql`UPDATE wa_items SET read_after = 0 WHERE read_after IS NOT NULL`;
    }
    await runWaQueue(env as never);
    expect(mocked).toHaveBeenCalledTimes(3);
  });

  it('a photo too large to read fails at once', async () => {
    const { id } = await add();
    mocked.mockRejectedValueOnce(new OcrError(400, 'This photo is larger than 5 MB.'));
    await runWaQueue(env as never);
    expect(await item(id)).toMatchObject({ read_status: 'failed', read_tries: 1 });
  });

  it('a file missing from storage fails without calling Claude', async () => {
    const { id, key } = await add();
    await uploads.delete(key);
    await runWaQueue(env as never);
    expect(await item(id)).toMatchObject({ read_status: 'failed', read_note: 'The file is missing from storage.' });
    expect(mocked).not.toHaveBeenCalled();
  });

  it('a file being read is not read twice; one left reading for 5 minutes is read again', async () => {
    const { id } = await add();
    await sql`UPDATE wa_items SET read_status = 'reading', read_started_at = ${Date.now()} WHERE id = ${id}`;
    expect((await runWaQueue(env as never)).read).toBe(0);
    await sql`UPDATE wa_items SET read_started_at = ${Date.now() - 6 * 60_000} WHERE id = ${id}`;
    mocked.mockResolvedValueOnce({ data: bill(), model: 'm' });
    expect((await runWaQueue(env as never)).read).toBe(1);
  });

  it('without the Claude key nothing is read and nothing fails', async () => {
    delete env.ANTHROPIC_API_KEY;
    const { id } = await add();
    expect(await runWaQueue(env as never)).toEqual({ read: 0, failed: 0, skipped: 'no key' });
    expect(await item(id)).toMatchObject({ read_status: 'waiting' });
  });

  it('deletes a file that is neither payment nor bill after a week, if nobody touched it', async () => {
    const week = 8 * 86400_000;
    const old = await add({ created_at: Date.now() - week });
    const kept = await add({ created_at: Date.now() - week });
    const recent = await add();
    await sql`UPDATE wa_items SET kind = 'other', read_status = 'read'`;
    await sql`UPDATE wa_items SET status = 'confirmed' WHERE id = ${kept.id}`;
    await runWaQueue(env as never);
    expect((await sql`SELECT id FROM wa_items ORDER BY sent_at`).map((r) => r.id)).toEqual([kept.id, recent.id]);
    expect(await uploads.get(old.key)).toBeNull();
    expect(await uploads.get(kept.key)).not.toBeNull();
  });
});

afterAll(() => sql.end());
