// The server's reading queue (18 Nov 2026): pages brought in are queued; what the browser does not finish is read by
// the minute job; a busy Claude is tried again, an unclear photo or a refused read leaves the queue. Claude is mocked.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { readWithClaude, OcrError } from '../src/claude';
import { runReadQueue } from '../src/routes/ocr';
import { businessWithAllRoles, env, sql, resetDb } from './helpers';
import { REGISTER_31_OCT } from '../demo/sample-data';

const mocked = vi.mocked(readWithClaude);
const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 9]);
let seq = 0;

afterAll(() => sql.end());
beforeEach(async () => {
  await resetDb();
  mocked.mockReset();
  Object.assign(env, { ANTHROPIC_API_KEY: 'test-key', CLAUDE_OCR_MODEL: 'claude-opus-5-5', OCR_DAILY_PAGE_LIMIT: '40', OCR_MAX_PARALLEL: '3' });
});
vi.setConfig({ testTimeout: 120_000 });

const reading = () => ({
  data: { orientation: 'upright', legible: true, page_total: null,
    rows: REGISTER_31_OCT.slice(0, 3).map((r, i) => ({ line: i + 1, bill_no: r.billNo, bill_type: r.billType, amount: r.amount, discount: null,
      payments: r.payments.map((p) => ({ column: p.columnLabel, mode: p.mode, amount: p.amount })), remarks: null, unclear: [] })) },
  model: 'claude-opus-5-5',
});

async function setup() {
  const h = await businessWithAllRoles('Hotel');
  const up = async () => (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, PNG(++seq), 'image/png')).json.id as string;
  const queue = (ids: string[], c = h.clients.entry_staff) => c.post(`/businesses/${h.bid}/ocr/queue`, { uploadIds: ids });
  const open = async () => (await sql`SELECT row_id FROM audit_log WHERE action = 'ocr.queue' AND after IS NULL ORDER BY row_id`).map((r) => r.row_id);
  // The job waits a minute after a page is queued or tried; move those times back instead of waiting.
  const age = () => sql`UPDATE audit_log SET created_at = created_at - 120000 WHERE action IN ('ocr.queue', 'ocr.read')`;
  const inputs = async () => (await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/inputs`)).json.pages;
  return { h, up, queue, open, age, inputs };
}

describe('reading queue', () => {
  it('reads a page the browser left, after a minute', async () => {
    const { up, queue, open, age, inputs } = await setup();
    const id = await up();
    expect((await queue([id])).json.queued).toBe(1);
    expect((await queue([id])).json.queued).toBe(0); // already waiting
    expect((await inputs())[0]).toMatchObject({ id, status: 'ready', ocrEngine: null, rows: 0, queued: 1 });
    // Too soon: the browser may still be on it.
    mocked.mockResolvedValue(reading() as never);
    expect((await runReadQueue(env)).started).toBe(0);
    await age();
    expect((await runReadQueue(env)).started).toBe(1);
    expect(await open()).toEqual([]);
    expect((await inputs())[0]).toMatchObject({ ocrEngine: 'claude_vision', rows: 3, queued: 0 });
    const [rows] = await sql`SELECT count(*) AS n, sum(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS d FROM register_rows`;
    expect(Number(rows.n)).toBe(3);
    expect(Number(rows.d)).toBe(3); // drafts, never confirmed
  });

  it('a read in the browser takes the page out of the queue', async () => {
    const { h, up, queue, open } = await setup();
    const id = await up();
    await queue([id]);
    mocked.mockResolvedValueOnce(reading() as never);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${id}/read`)).status).toBe(200);
    expect(await open()).toEqual([]);
  });

  it('Claude busy: tried again, three times at most; an unclear photo leaves at once', async () => {
    const { up, queue, open, age } = await setup();
    const busy = await up();
    const unclear = await up();
    await queue([busy, unclear]);
    mocked.mockImplementation(async (_e, img) => {
      if (img.bytes[8] === seq) return { data: { orientation: 'upright', legible: false, page_total: null, rows: [] }, model: 'm' } as never;
      throw new OcrError(429, 'Claude is busy right now. Try again in a minute.', true);
    });
    await age();
    await runReadQueue(env);
    expect(await open()).toEqual([busy]);
    const [u] = await sql`SELECT status FROM uploads WHERE id = ${unclear}`;
    expect(u.status).toBe('retake');
    for (let i = 0; i < 2; i += 1) { await age(); await runReadQueue(env); }
    expect(await open()).toEqual([]); // third failure: out of the queue, Read now still there
    const [b] = await sql`SELECT status FROM uploads WHERE id = ${busy}`;
    expect(b.status).toBe('failed');
  });

  it('never reads over rows typed in, and takes no other business\'s pages', async () => {
    const { h, up, queue, open, age } = await setup();
    const id = await up();
    await queue([id]);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${id}/register-rows`, { billNo: '2610311', billType: 'fnb', amount: '100',
      payments: [{ mode: 'cash', columnLabel: 'Cash', amount: '100' }], status: 'draft' })).status).toBe(201);
    await age();
    mocked.mockResolvedValue(reading() as never);
    expect((await runReadQueue(env)).started).toBe(0);
    expect(mocked).not.toHaveBeenCalled();
    expect(await open()).toEqual([]);
    const other = await businessWithAllRoles('Other');
    expect((await other.clients.owner.post(`/businesses/${other.bid}/ocr/queue`, { uploadIds: [id] })).json.queued).toBe(0);
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/ocr/queue`, { uploadIds: [id] })).status).toBe(403);
  });
});
