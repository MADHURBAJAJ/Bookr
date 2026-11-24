import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types';
import { body, fail, isUuid } from '../http';
import { sniffImage } from '../files';
import { requireRole } from '../auth';
import { parsePaise } from '../money';
import { istToMs } from '../time';
import { HeartbeatBody, heartbeat, ingest, IngestMeta, readGroupIds, secretOk, WA_MAX_BYTES, WA_SECRET_HEADER } from '../wa';
import { runWaQueue } from '../waRead';
import { PairError, pairByHand, unpair } from '../waPair';
import { addGroup, confirmAgreeing, confirmItem, confirmPair, editGroup, editItem, groupsView, inbox, InboxError, itemFile, rejectItem,
  restoreItem, TABS, type ItemEdit, type Tab } from '../waInbox';

/**
 * The WhatsApp listener's two calls (see src/wa.ts). Not under /businesses and not signed in: the listener sends the
 * shared secret (Worker secret WA_INGEST_SECRET; WA_INGEST_SECRET_OLD is also accepted while it is being changed).
 * - POST /wa/ingest: multipart form with "meta" (JSON: messageId, groupId, groupName?, senderNumber?, senderName?,
 *   sentAt (ms), mediaType (image | document), caption?, replyTo? (the quoted message's id)) and "file" (a JPEG, PNG or PDF, up to 10 MB). Answers 201 when
 *   stored, 200 with stored: false when it was dropped on purpose (group not listed, already here) so the listener does
 *   not try again. Anything 4xx is the listener's mistake; 5xx can be tried again.
 * - POST /wa/heartbeat: JSON { lastMessageAt?, state?, version?, groups? ([{ id, name }]: the groups it can see) }, every minute.
 *   Answers { ok, serverTime, readGroups }: the group ids Bookr reads. The listener downloads files from those only.
 *
 * The inbox (phase 4) is under /businesses/:businessId/wa, for a signed-in Owner or Accountant (wa.review).
 */
export const waRoutes = new Hono<AppEnv>();

async function checkSecret(c: Context<AppEnv>) {
  const s = await secretOk(c.env, c.req.header(WA_SECRET_HEADER));
  if (s === 'not_set') fail(503, 'WhatsApp intake is not set up: the WA_INGEST_SECRET secret is missing on the server.');
  if (s === 'wrong') fail(401, 'Wrong or missing listener secret.');
}

waRoutes.post('/wa/ingest', async (c) => {
  await checkSecret(c);
  if (Number(c.req.header('Content-Length') ?? 0) > WA_MAX_BYTES + 64 * 1024) throw new HTTPException(413, { message: 'The file is larger than 10 MB.' });
  let form: FormData;
  try { form = await c.req.raw.formData(); } catch { fail(400, 'Send a multipart form with "meta" and "file".'); }
  let raw: unknown;
  try { raw = JSON.parse(String(form.get('meta') ?? '')); } catch { fail(400, '"meta" must be JSON.'); }
  const parsed = IngestMeta.safeParse(raw);
  if (!parsed.success) fail(400, `"meta" is not right: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 300));
  const file = form.get('file');
  if (!file || typeof file === 'string') fail(400, 'No "file" sent.');
  if (file.size > WA_MAX_BYTES) throw new HTTPException(413, { message: 'The file is larger than 10 MB.' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) fail(400, 'The file is empty.');
  const type = sniffImage(bytes);
  if (!type) throw new HTTPException(415, { message: 'Only JPEG, PNG and PDF files are kept.' });
  const r = await ingest(c.env, parsed.data, bytes, type);
  // Read it now, after answering, rather than waiting up to a minute for the minute job.
  if (r.stored) {
    try { c.executionCtx.waitUntil(runWaQueue(c.env).catch((e) => console.error('wa queue', e))); } catch { /* no execution context (tests): the minute job reads it */ }
  }
  return c.json(r, r.stored ? 201 : 200);
});

waRoutes.post('/wa/heartbeat', async (c) => {
  await checkSecret(c);
  let raw: unknown = {};
  try { raw = await c.req.json(); } catch { fail(400, 'Request body must be a JSON object.'); }
  const parsed = HeartbeatBody.safeParse(raw);
  if (!parsed.success) fail(400, 'Heartbeat is not right.');
  const at = await heartbeat(c.env.DB, parsed.data);
  return c.json({ ok: true, serverTime: at, readGroups: await readGroupIds(c.env.DB) });
});

// ----- the inbox (phase 4)

/** Signed in: mounted after the sign-in check in app.ts (the listener's two calls above are not). */
export const waInboxRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId/wa';
/** Runs an inbox change, turning its refusals into answers. */
async function act<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof InboxError) fail(e.status, e.message);
    if (e instanceof PairError) fail(e.message.includes('not found') ? 404 : 400, e.message);
    throw e;
  }
}
const idParam = (c: Context<AppEnv>, name = 'id') => { const v = c.req.param(name); if (!isUuid(v)) fail(404, 'Not found.'); return v; };

waInboxRoutes.get(`${B}/inbox`, requireRole('wa.review'), async (c) => {
  const tab = (c.req.query('tab') ?? 'pending') as Tab;
  if (!TABS.includes(tab)) fail(400, 'Unknown tab.');
  return c.json(await inbox(c.env.DB, c.get('businessId'), tab));
});

waInboxRoutes.get(`${B}/items/:id/file`, requireRole('wa.review'), async (c) => {
  const f = await itemFile(c.env.DB, c.get('businessId'), idParam(c));
  if (!f) fail(404, 'Photo not found.');
  const obj = await c.env.UPLOADS.get(f.file_key);
  if (!obj) fail(404, 'The stored photo is missing.');
  return new Response(obj.body, { headers: { 'Content-Type': f.media_type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
});

waInboxRoutes.post(`${B}/pairs/:id/confirm`, requireRole('wa.review'), async (c) => {
  const b = await body(c);
  await act(() => confirmPair(c.env.DB, c.get('businessId'), idParam(c), c.get('user').id, b.tip === true));
  return c.json({ ok: true });
});

waInboxRoutes.post(`${B}/confirm-agreeing`, requireRole('wa.review'), async (c) => {
  const b = await body(c);
  const ids = Array.isArray(b.pairIds) ? b.pairIds.filter((x): x is string => typeof x === 'string' && isUuid(x)) : [];
  if (!ids.length) fail(400, 'No pairs given.');
  return c.json({ confirmed: await confirmAgreeing(c.env.DB, c.get('businessId'), ids, c.get('user').id) });
});

waInboxRoutes.post(`${B}/items/:id/confirm`, requireRole('wa.review'), async (c) => {
  const b = await body(c);
  if (b.paidAs !== undefined && b.paidAs !== null && b.paidAs !== 'cash') fail(400, 'paidAs can only be cash.');
  await act(() => confirmItem(c.env.DB, c.get('businessId'), idParam(c), c.get('user').id, b.paidAs === 'cash' ? 'cash' : null));
  return c.json({ ok: true });
});

waInboxRoutes.post(`${B}/items/:id/reject`, requireRole('wa.review'), async (c) => {
  await act(() => rejectItem(c.env.DB, c.get('businessId'), idParam(c), c.get('user').id));
  return c.json({ ok: true });
});

waInboxRoutes.post(`${B}/items/:id/restore`, requireRole('wa.review'), async (c) => {
  await act(() => restoreItem(c.env.DB, c.get('businessId'), idParam(c), c.get('user').id));
  return c.json({ ok: true });
});

/** Corrects what was read: kind, amount (rupees text), utr, billNo, paidAt ("YYYY-MM-DD HH:MM" India time). Empty clears. */
waInboxRoutes.patch(`${B}/items/:id`, requireRole('wa.review'), async (c) => {
  const b = await body(c);
  const e: ItemEdit = {};
  if (b.kind !== undefined) {
    if (b.kind !== 'upi' && b.kind !== 'bill' && b.kind !== 'other') fail(400, 'Kind is upi, bill or other.');
    e.kind = b.kind;
  }
  if (b.amount !== undefined) {
    const raw = String(b.amount ?? '').trim();
    const p = raw ? parsePaise(raw) : null;
    if (raw && (p == null || p <= 0)) fail(400, 'Amount must be rupees above zero, like 2497 or 2497.50.');
    e.amountPaise = p;
  }
  for (const [k, key, max] of [['utr', 'utr', 60], ['billNo', 'billNo', 40]] as const) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && typeof b[k] !== 'string') fail(400, `${k} must be text.`);
    const v = (b[k] as string | null)?.trim() ?? '';
    if (v.length > max) fail(400, `${k} is too long.`);
    e[key] = v || null;
  }
  if (b.paidAt !== undefined) {
    const v = String(b.paidAt ?? '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(v);
    if (v && !m) fail(400, 'Paid at must be a date and time.');
    e.docAt = m ? istToMs(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
  }
  await act(() => editItem(c.env.DB, c.get('businessId'), idParam(c), c.get('user').id, e));
  return c.json({ ok: true });
});

waInboxRoutes.post(`${B}/pairs`, requireRole('wa.review'), async (c) => {
  const b = await body(c);
  const upi = typeof b.upiItemId === 'string' && isUuid(b.upiItemId) ? b.upiItemId : fail(400, 'Choose the UPI photo.');
  const bill = typeof b.billItemId === 'string' && isUuid(b.billItemId) ? b.billItemId : fail(400, 'Choose the bill.');
  const bid = c.get('businessId');
  const st = await c.env.DB.prepare(`SELECT count(*) AS n FROM wa_items WHERE business_id = ? AND id IN (?, ?) AND status = 'pending'`).bind(bid, upi, bill).first<{ n: number }>();
  if ((st?.n ?? 0) < 2) fail(409, 'Both must still be waiting to check.');
  const id = await act(() => pairByHand(c.env.DB, bid, upi, bill, c.get('user').id));
  return c.json({ id }, 201);
});

waInboxRoutes.delete(`${B}/pairs/:id`, requireRole('wa.review'), async (c) => {
  await act(() => unpair(c.env.DB, c.get('businessId'), idParam(c), c.get('user').id));
  return c.json({ ok: true });
});

waInboxRoutes.get(`${B}/groups`, requireRole('wa.review'), async (c) => c.json(await groupsView(c.env.DB, c.get('businessId'))));

const optText = (v: unknown, label: string, max = 80) => {
  if (v === undefined) return undefined;
  if (v !== null && typeof v !== 'string') fail(400, `${label} must be text.`);
  const t = (v as string | null)?.trim() ?? '';
  if (t.length > max) fail(400, `${label} is too long.`);
  return t || null;
};
const optHead = (v: unknown) => (v === undefined ? undefined : v === null || v === '' ? null : typeof v === 'string' && isUuid(v) ? v : fail(400, 'Head not found.'));

waInboxRoutes.post(`${B}/groups`, requireRole('wa.review'), async (c) => {
  const b = await body(c);
  const waGroupId = typeof b.waGroupId === 'string' && /^[0-9-]+@g\.us$/.test(b.waGroupId.trim()) ? b.waGroupId.trim() : fail(400, 'Group id looks like 120363012345678901@g.us.');
  const id = await act(() => addGroup(c.env.DB, c.get('businessId'), c.get('user').id, {
    waGroupId, name: optText(b.name, 'Name', 200), department: optText(b.department, 'Department'), defaultHeadId: optHead(b.defaultHeadId) }));
  return c.json({ id }, 201);
});

waInboxRoutes.patch(`${B}/groups/:id`, requireRole('wa.review'), async (c) => {
  const b = await body(c);
  if (b.active !== undefined && typeof b.active !== 'boolean') fail(400, 'active must be true or false.');
  await act(() => editGroup(c.env.DB, c.get('businessId'), c.get('user').id, idParam(c), {
    name: optText(b.name, 'Name', 200) ?? undefined, department: optText(b.department, 'Department'), defaultHeadId: optHead(b.defaultHeadId),
    active: b.active as boolean | undefined }));
  return c.json({ ok: true });
});
