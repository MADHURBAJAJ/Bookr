import { Hono } from 'hono';
import type { AppEnv, Env } from '../types';
import { requireRole } from '../auth';
import { all, isShiftConfirmed, now, one, stmt, type DB } from '../db';
import { fail, isUuid } from '../http';
import { istDay, istToMs } from '../time';
import { DEFAULT_OCR_MODEL, OcrError, readWithClaude, type PageImage } from '../claude';
import { asReading, draftRegisterRows, expenseStatements, INSTRUCTIONS, registerStatements, SCHEMAS, summaryStatement, type ReadableKind } from '../ocr';
import { refreshComparisons } from '../sales';
import { parsePaise } from '../money';
import { loadHistory, loadParties } from '../parties';

export const ocrRoutes = new Hono<AppEnv>();

const STALE_MS = 5 * 60 * 1000; // a read still running after this is treated as abandoned

// Each read is recorded in audit_log as action 'ocr.read'. The row is written before Claude is
// called (after = NULL while in progress), so it counts toward the daily cap even if the call fails.
function limits(env: Env) {
  const n = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return { daily: n(env.OCR_DAILY_PAGE_LIMIT, 40), parallel: n(env.OCR_MAX_PARALLEL, 3), model: env.CLAUDE_OCR_MODEL || DEFAULT_OCR_MODEL };
}

const dayStart = (t: number) => { const [y, m, d] = istDay(t).split('-').map(Number); return istToMs(y, m, d); };

async function usage(db: DB, businessId: string, t: number) {
  const r = await one<{ used: number; running: number }>(db, `SELECT
      count(*) AS used,
      count(CASE WHEN after IS NULL AND created_at > ? THEN 1 END) AS running
    FROM audit_log WHERE business_id = ? AND action = 'ocr.read' AND created_at >= ?`, t - STALE_MS, businessId, dayStart(t));
  return r!;
}

/** Reserves one read, atomically: under today's cap, under the parallel limit, and not already running for this page. */
async function reserveRead(db: DB, env: Env, bid: string, user: string, uploadId: string, before: Record<string, unknown>): Promise<number> {
  const l = limits(env);
  const t = now();
  const reserve = await stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    SELECT ?, ?, 'ocr.read', 'uploads', ?, ?, NULL, ?
    WHERE (SELECT count(*) FROM audit_log WHERE business_id = ? AND action = 'ocr.read' AND created_at >= ?) < ?
      AND (SELECT count(*) FROM audit_log WHERE business_id = ? AND action = 'ocr.read' AND after IS NULL AND created_at > ?) < ?
      AND NOT EXISTS (SELECT 1 FROM audit_log WHERE business_id = ? AND action = 'ocr.read' AND row_id = ? AND after IS NULL AND created_at > ?)`,
    bid, user, uploadId, JSON.stringify(before), t,
    bid, dayStart(t), l.daily,
    bid, t - STALE_MS, l.parallel,
    bid, uploadId, t - STALE_MS).run();
  if (!reserve.meta.changes) {
    const now2 = await usage(db, bid, t);
    if (now2.used >= l.daily) fail(429, `Today's limit of ${l.daily} page reads for this business is used up. It resets at midnight India time. You can still type the rows in.`);
    if (now2.running >= l.parallel) fail(429, `${now2.running} pages are being read already. Wait for them to finish, then try again.`);
    fail(409, 'This page is already being read.');
  }
  return reserve.meta.last_row_id;
}

ocrRoutes.get('/businesses/:businessId/ocr', requireRole('rows.upload'), async (c) => {
  const l = limits(c.env);
  const u = await usage(c.env.DB, c.get('businessId'), now());
  return c.json({ configured: !!c.env.ANTHROPIC_API_KEY, model: l.model, dailyLimit: l.daily, usedToday: u.used, readingNow: u.running, maxParallel: l.parallel });
});

ocrRoutes.post('/businesses/:businessId/uploads/:uploadId/read', requireRole('rows.upload'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user').id;
  const id = c.req.param('uploadId');
  if (!isUuid(id)) fail(404, 'Upload not found.');
  const u = await one<{ id: string; kind: string; business_day: string; storage_key: string }>(db,
    'SELECT id, kind, business_day, storage_key FROM uploads WHERE id = ? AND business_id = ?', id, bid);
  if (!u) fail(404, 'Upload not found.');
  if (!(u.kind in INSTRUCTIONS)) fail(400, 'Only register pages, expense lists and cash summaries can be read.');
  const kind = u.kind as ReadableKind;

  // Never overwrite what a person has already checked or approved.
  if (kind === 'bill_register') {
    if (await one(db, "SELECT 1 AS ok FROM shifts WHERE business_id = ? AND shift_day = ? AND status = 'confirmed'", bid, u.business_day)) {
      fail(409, 'This shift is confirmed. An Owner must reopen it first.');
    }
    if (await one(db, "SELECT 1 AS ok FROM register_rows WHERE upload_id = ? AND status = 'checked'", u.id)) {
      fail(409, 'Some rows on this page are already checked. Reading again would replace only unchecked rows, so delete or edit rows by hand instead.');
    }
  }
  if (kind === 'expense_list' && (await one(db, "SELECT 1 AS ok FROM transactions WHERE upload_id = ? AND status = 'approved'", u.id))) {
    fail(409, 'Some lines on this page are approved. Edit the remaining lines by hand instead.');
  }
  if (kind === 'cash_summary' && (await one(db, "SELECT 1 AS ok FROM cash_summaries WHERE upload_id = ? AND status = 'approved'", u.id))) {
    fail(409, 'This cash summary is approved.');
  }
  if (!c.env.ANTHROPIC_API_KEY) fail(503, 'Reading pages is not set up: the ANTHROPIC_API_KEY secret is missing on the server. You can still type the rows in.');

  let cashAccount: string | null = null;
  if (kind === 'expense_list') {
    cashAccount = (await one<{ id: string }>(db, `SELECT id FROM accounts WHERE business_id = ? AND kind = 'cash'
      ORDER BY lower(name) = 'cash' DESC, created_at LIMIT 1`, bid))?.id ?? null;
    if (!cashAccount) fail(400, 'This business has no cash account. Add one on Accounts.');
  }

  const l = limits(c.env);
  const auditId = await reserveRead(db, c.env, bid, user, u.id, { kind, model: l.model });
  const finish = (after: Record<string, unknown>) =>
    stmt(db, 'UPDATE audit_log SET after = ? WHERE id = ?', JSON.stringify({ ...after, finishedAt: now() }), auditId);
  await stmt(db, "UPDATE uploads SET status = 'reading' WHERE id = ?", u.id).run();

  try {
    const obj = await c.env.UPLOADS.get(u.storage_key);
    if (!obj) throw new OcrError(502, 'The stored file is missing. Delete this upload and upload the page again.');
    const page: PageImage = { bytes: new Uint8Array(await obj.arrayBuffer()), mediaType: (obj.httpMetadata?.contentType ?? 'image/jpeg') as PageImage['mediaType'] };
    const { data, model } = await readWithClaude(c.env, page, INSTRUCTIONS[kind], SCHEMAS[kind]);
    const ctx = { db, businessId: bid, uploadId: u.id, day: u.business_day, model };

    if (!data.legible) {
      await db.batch([stmt(db, "UPDATE uploads SET status = 'retake' WHERE id = ?", u.id), finish({ ok: true, legible: false, model })]);
      return c.json({ error: 'The page is too unclear to read. Take the photo again in good light, flat and in focus, or type the rows in.' }, 422);
    }

    let written: number | null = null;
    let statements: D1PreparedStatement[];
    let rows = 0;
    if (kind === 'bill_register') {
      // The shift's software bills, to complete short bill numbers; numbers already on the shift's other pages are taken.
      const [sw, taken] = await Promise.all([
        all<{ bill_no: string }>(db, 'SELECT DISTINCT bill_no FROM software_bills WHERE business_id = ? AND shift_day = ?', bid, u.business_day),
        all<{ bill_no: string }>(db, 'SELECT DISTINCT bill_no FROM register_rows WHERE business_id = ? AND shift_day = ? AND upload_id <> ?', bid, u.business_day, u.id),
      ]);
      const r = registerStatements(ctx, data as never, { softwareBills: sw.map((b) => b.bill_no), takenBills: taken.map((b) => b.bill_no) });
      ({ statements, written } = r);
      rows = asReading(data as never).rows.length;
    } else if (kind === 'expense_list') {
      const r = expenseStatements(ctx, data as never, cashAccount!, await loadParties(db, bid), await loadHistory(db, bid));
      ({ statements, written } = r);
      rows = (data as { rows: unknown[] }).rows.length;
    } else {
      statements = [summaryStatement(ctx, data as never)];
    }
    await db.batch([
      ...statements,
      stmt(db, `UPDATE uploads SET status = 'ready', ocr_engine = 'claude_vision', page_written_total_paise = coalesce(?, page_written_total_paise) WHERE id = ?`, written, u.id),
      finish({ ok: true, model, rows, orientation: data.orientation }),
    ]);
    if (kind === 'bill_register') await refreshComparisons(db, bid, u.business_day, user);

    const total = kind === 'bill_register'
      ? await one<{ s: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS s FROM register_rows WHERE upload_id = ?', u.id)
      : kind === 'expense_list' ? await one<{ s: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS s FROM transactions WHERE upload_id = ?', u.id) : null;
    const unclear = await countUnclear(db, kind, u.id);
    return c.json({
      rows, model, orientation: data.orientation, unclearCells: unclear,
      writtenTotalPaise: written, rowsTotalPaise: total?.s ?? null,
      totalMatches: written === null || total === null ? null : written === total.s,
    });
  } catch (e) {
    const err = e instanceof OcrError ? e : null;
    await db.batch([
      stmt(db, "UPDATE uploads SET status = 'failed' WHERE id = ? AND status = 'reading'", u.id),
      finish({ ok: false, error: err?.message ?? 'unexpected' }),
    ]);
    if (isShiftConfirmed(e)) fail(409, 'This shift is confirmed. An Owner must reopen it first.');
    if (err) return c.json({ error: err.message }, err.status);
    throw e;
  }
});

async function countUnclear(db: DB, kind: ReadableKind, uploadId: string): Promise<number> {
  const rows = kind === 'bill_register'
    ? await all<{ o: string | null }>(db, 'SELECT ocr_original AS o FROM register_rows WHERE upload_id = ?', uploadId)
    : kind === 'expense_list'
      ? await all<{ o: string | null }>(db, 'SELECT ocr_original AS o FROM transactions WHERE upload_id = ?', uploadId)
      : await all<{ o: string | null }>(db, 'SELECT ocr_original AS o FROM cash_summaries WHERE upload_id = ?', uploadId);
  return rows.reduce((n, r) => n + ((r.o && (JSON.parse(r.o).unclear as string[] | undefined)?.length) || 0), 0);
}

// "Check reading accuracy" (Owner): reads register pages whose rows have all been checked again, with today's
// method, and compares both the first reading and the new one with what a person ticked. Nothing on the page
// changes; each page counts as one read toward today's limit. Only counts are returned and logged.

const ACCURACY_FIELDS = ['bill_no', 'amount', 'bill_type', 'payments'] as const;
type Field = (typeof ACCURACY_FIELDS)[number];
type Tally = Record<Field, { right: number; wrongRed: number; wrongAmber: number; wrongUnmarked: number }>;
const tally = (): Tally => Object.fromEntries(ACCURACY_FIELDS.map((f) => [f, { right: 0, wrongRed: 0, wrongAmber: 0, wrongUnmarked: 0 }])) as Tally;

ocrRoutes.get('/businesses/:businessId/ocr/accuracy-pages', requireRole('business.edit'), async (c) => {
  const pages = await all(c.env.DB, `SELECT u.id, u.business_day AS day, count(r.id) AS rows FROM uploads u JOIN register_rows r ON r.upload_id = u.id
    WHERE u.business_id = ? AND u.kind = 'bill_register' AND u.ocr_engine = 'claude_vision' AND u.storage_key NOT LIKE 'software-added/%'
    GROUP BY u.id HAVING count(r.id) >= 3 AND sum(r.status <> 'checked') = 0 AND sum(r.ocr_original IS NULL) = 0
    ORDER BY u.business_day DESC, u.created_at DESC LIMIT 15`, c.get('businessId'));
  return c.json({ pages });
});

ocrRoutes.post('/businesses/:businessId/ocr/accuracy/:uploadId', requireRole('business.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('uploadId');
  if (!isUuid(id)) fail(404, 'Upload not found.');
  const u = await one<{ id: string; business_day: string; storage_key: string }>(db,
    "SELECT id, business_day, storage_key FROM uploads WHERE id = ? AND business_id = ? AND kind = 'bill_register'", id, bid);
  if (!u) fail(404, 'Upload not found.');
  const truth = await all<{ id: string; bank: number; bill_no: string; bill_type: string; amount_paise: number; paid_with_row_id: string | null; status: string; ocr_original: string | null; pays: string }>(db, `
    SELECT r.id, r.bill_no, r.bill_type, r.amount_paise, r.paid_with_row_id, r.status, r.ocr_original,
      (SELECT json_group_array(p.mode || ':' || p.amount_paise) FROM register_payments p WHERE p.register_row_id = r.id) AS pays,
      EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target_id = r.id) AS bank
    FROM register_rows r WHERE r.upload_id = ? ORDER BY r.line_no`, u.id);
  if (!truth.length || truth.some((r) => r.status !== 'checked' || !r.ocr_original)) fail(409, 'Only pages whose rows are all checked can be compared.');
  if (!c.env.ANTHROPIC_API_KEY) fail(503, 'Reading pages is not set up on the server.');
  const auditId = await reserveRead(db, c.env, bid, c.get('user').id, u.id, { kind: 'bill_register', purpose: 'accuracy' });
  const finish = (after: Record<string, unknown>) => stmt(db, 'UPDATE audit_log SET after = ? WHERE id = ?', JSON.stringify({ ...after, finishedAt: now() }), auditId).run();
  try {
    const obj = await c.env.UPLOADS.get(u.storage_key);
    if (!obj) throw new OcrError(502, 'The stored file is missing.');
    const page: PageImage = { bytes: new Uint8Array(await obj.arrayBuffer()), mediaType: (obj.httpMetadata?.contentType ?? 'image/jpeg') as PageImage['mediaType'] };
    const { data, model } = await readWithClaude(c.env, page, INSTRUCTIONS.bill_register, SCHEMAS.bill_register);
    const [sw, taken] = await Promise.all([
      all<{ bill_no: string }>(db, 'SELECT DISTINCT bill_no FROM software_bills WHERE business_id = ? AND shift_day = ?', bid, u.business_day),
      all<{ bill_no: string }>(db, 'SELECT DISTINCT bill_no FROM register_rows WHERE business_id = ? AND shift_day = ? AND upload_id <> ?', bid, u.business_day, u.id),
    ]);
    const fresh = draftRegisterRows(asReading(data as never), { softwareBills: sw.map((b) => b.bill_no), takenBills: taken.map((b) => b.bill_no) });
    const byLine = new Map(fresh.map((x) => [x.line, x]));
    const ids = new Map(fresh.map((x) => [x.id, x]));
    const payKey = (ps: string[]) => JSON.stringify([...ps].sort());
    const before = tally(), after = tally();
    const mark = (t: Tally, f: Field, right: boolean, red: boolean, amber: boolean) => {
      t[f][right ? 'right' : red ? 'wrongRed' : amber ? 'wrongAmber' : 'wrongUnmarked']++;
    };
    let missing = 0, bankChanged = 0;
    for (const r of truth) {
      // Amounts and payments changed on UPI matching follow the bank, not the page: not a reading mistake.
      const fields = r.bank ? ACCURACY_FIELDS.filter((f) => f === 'bill_no' || f === 'bill_type') : ACCURACY_FIELDS;
      if (r.bank) bankChanged++;
      const o = JSON.parse(r.ocr_original!) as { line?: number; read?: Record<string, unknown> & { payments?: { mode: string; amount: string | null }[]; paid_with_line?: number | null }; unclear?: string[]; inferred?: string[] };
      const want = { bill_no: r.bill_no, amount: r.amount_paise, bill_type: r.bill_type, payments: r.paid_with_row_id ? 'with another bill' : payKey(JSON.parse(r.pays)) };
      // First reading, as it was stored.
      const rd = o.read ?? {};
      const oldPays = rd.paid_with_line != null ? 'with another bill' : payKey((rd.payments ?? []).map((p) => `${p.mode}:${p.amount == null ? 'x' : parsePaise(p.amount) ?? 'x'}`));
      const old = { bill_no: String(rd.bill_no ?? '').trim(), amount: rd.amount == null ? null : parsePaise(String(rd.amount)), bill_type: rd.bill_type === 'unclear' ? 'fnb' : rd.bill_type, payments: oldPays };
      for (const f of fields) mark(before, f, old[f] === want[f], !!o.unclear?.includes(f), !!o.inferred?.includes(f));
      // New reading: the line at the same place on the page.
      const x = o.line != null ? byLine.get(o.line) : undefined;
      if (!x) { missing++; for (const f of fields) mark(after, f, false, false, false); continue; }
      const now2 = { bill_no: x.billNo, amount: x.amt, bill_type: x.read.bill_type === 'unclear' ? 'fnb' : x.read.bill_type,
        payments: x.paidWith && ids.has(x.paidWith) ? 'with another bill' : payKey(x.pays.map((p) => `${p.mode}:${p.paise ?? 'x'}`)) };
      for (const f of fields) mark(after, f, now2[f] === want[f], x.unclear.has(f), x.inferred.includes(f));
    }
    const result = { uploadId: u.id, day: u.business_day, rows: truth.length, newLines: fresh.length, missing, bankChanged, model, before, after };
    await finish({ ok: true, model, purpose: 'accuracy', rows: truth.length, before, after });
    return c.json(result);
  } catch (e) {
    const err = e instanceof OcrError ? e : null;
    await finish({ ok: false, purpose: 'accuracy', error: err?.message ?? 'unexpected' });
    if (err) fail(err.status, err.message);
    throw e;
  }
});
