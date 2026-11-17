// A cash sheet changed by hand (17 Nov 2026): figures that differ from the photo need a reason, which is kept and
// logged; a revised sheet uploaded later replaces the first page of the day; the first day's opening is checked against
// the Cash account; Funds flow says which shifts are not saved yet. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { fullShift, hotel, png } from './phase2-shared';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

const DAY = '2026-11-05';
const READ = { opening: '1000', received: '500', balance: '1500', expenses: '200', cash_in_hand: '1300' };
const FIGS = { opening: '1000', received: '500', balance: '1500', expenses: '200', cashInHand: '1300' };

async function page(h: Awaited<ReturnType<typeof hotel>>, seed: number) {
  const uploadId = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=cash_summary&day=${DAY}`, png(seed), 'image/png')).json.id;
  const summaryId = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${uploadId}`)).json.summary.id;
  await sql`UPDATE cash_summaries SET ocr_original = ${JSON.stringify({ engine: 'test', read: READ, unclear: [] })} WHERE id = ${summaryId}`;
  return { uploadId, summaryId };
}

describe('a cash sheet changed by hand', () => {
  it('needs a reason when a figure differs from the photo, keeps it and logs it', async () => {
    const h = await hotel();
    const { uploadId, summaryId } = await page(h, 21);
    const put = (b: Record<string, unknown>) => h.clients.owner.put(`/businesses/${h.bid}/cash-summaries/${summaryId}`, b);
    // As read: no reason needed.
    expect((await put(FIGS)).status).toBe(200);
    // Opening changed: refused until a reason is given, naming the photo's figure.
    const changed = { ...FIGS, opening: '1100', balance: '1600', cashInHand: '1400' };
    const no = await put(changed);
    expect(no.status).toBe(400);
    expect(no.json.code).toBe('summary_reason');
    expect(no.json.error).toMatch(/Opening: the photo says ₹1,000, saved as ₹1,100/);
    expect((await put({ ...changed, reason: 'other' })).status).toBe(400); // Other needs a note
    expect((await put({ ...changed, reason: 'revised', reasonNote: 'counted again' })).status).toBe(200);
    const [s] = await sql`SELECT opening_paise, ocr_original FROM cash_summaries WHERE id = ${summaryId}`;
    expect(s.opening_paise).toBe(110000);
    expect(JSON.parse(s.ocr_original).revision).toMatchObject({ reason: 'revised', note: 'counted again' });
    expect(JSON.parse(s.ocr_original).read.opening).toBe('1000'); // the photo's reading is kept
    const [a] = await sql`SELECT after FROM audit_log WHERE action = 'cash_summary.edit' ORDER BY created_at DESC LIMIT 1`;
    expect(a.after).toMatch(/revised/);
    // The upload carries the reasons for the screen, and the day report lists the revised sheet.
    expect((await h.clients.owner.get(`/businesses/${h.bid}/uploads/${uploadId}`)).json.reasons.revised).toBe('Sheet revised, the new one not uploaded');
    const m = (await h.clients.owner.get(`/businesses/${h.bid}/reports/missed?from=${DAY}&to=${DAY}`)).json;
    expect(m.cashRevised).toEqual([expect.objectContaining({ day: DAY, uploadId, reason: 'revised' })]);
    // Back to the photo's figures: the reason goes.
    expect((await put(FIGS)).status).toBe(200);
    const [s2] = await sql`SELECT ocr_original FROM cash_summaries WHERE id = ${summaryId}`;
    expect(JSON.parse(s2.ocr_original).revision).toBeUndefined();
  });

  it('a revised sheet uploaded later replaces the first page, and can be undone', async () => {
    const h = await hotel();
    const first = await page(h, 22);
    await h.clients.owner.put(`/businesses/${h.bid}/cash-summaries/${first.summaryId}`, FIGS);
    const second = await page(h, 23);
    const view = (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${second.uploadId}`)).json;
    expect(view.samePages).toEqual([expect.objectContaining({ id: first.summaryId, replacedBy: null })]);
    const link = (undo = false) => h.clients.owner.post(`/businesses/${h.bid}/cash-summaries/${second.summaryId}/replaces`, { summaryId: first.summaryId, undo });
    expect((await link()).status).toBe(200);
    const [o1] = await sql`SELECT ocr_original FROM cash_summaries WHERE id = ${first.summaryId}`;
    expect(JSON.parse(o1.ocr_original).replacedBy).toBe(second.uploadId);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'cash_summary.replaced'`)[0].n).toBe(1);
    expect((await link(true)).status).toBe(200);
    const [o2] = await sql`SELECT ocr_original FROM cash_summaries WHERE id = ${first.summaryId}`;
    expect(JSON.parse(o2.ocr_original).replacedBy).toBeUndefined();
  });

  it("checks the first day's opening against the Cash account's opening balance", async () => {
    const h = await hotel();
    await sql`UPDATE accounts SET opening_balance_paise = 100000, opening_date = ${DAY} WHERE business_id = ${h.bid} AND kind = 'cash'`;
    const { uploadId, summaryId } = await page(h, 24);
    await h.clients.owner.put(`/businesses/${h.bid}/cash-summaries/${summaryId}`, FIGS);
    const state = async () => (await h.clients.owner.get(`/businesses/${h.bid}/uploads/${uploadId}`)).json.checks.find((c: any) => c.key === 'opening');
    expect(await state()).toMatchObject({ state: 'pass' });
    await sql`UPDATE accounts SET opening_balance_paise = 90000 WHERE business_id = ${h.bid} AND kind = 'cash'`;
    expect(await state()).toMatchObject({ state: 'fail' });
  });

  it('Funds flow names the shifts not saved yet', async () => {
    const h = await hotel();
    await sql`UPDATE accounts SET opening_date = '2026-10-30' WHERE business_id = ${h.bid}`;
    await fullShift(h);
    const r = (await h.clients.owner.get(`/businesses/${h.bid}/reports/funds-flow?from=2026-10-31&to=2026-10-31`)).json;
    expect(r.cashNotes.unsaved).toEqual(['2026-10-31']);
    expect(r.cashNotes.revised).toBeNull();
  });
});
