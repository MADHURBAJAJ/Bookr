// Offline mode (27 Nov 2026). A counter device the owner turned on for offline gets a letter (A, B, ...). With no internet it
// takes orders, prints KOTs (A1, A2 ...), bills (C261126A001) and receipts (RCPT/26-27/A001), and keeps each as a step. When
// the internet is back it sends the steps here one at a time, oldest first. Each is run through the same route the counter
// calls online (so the person's role, the menu, tax, the cash drawer, stock and Bookr are all checked and done as usual),
// at the time it happened, with the numbers already printed, and saved once even if sent twice.
import { Hono } from 'hono';
import { all, one, stmt } from '../../../src/db';
import { body, fail, isUuid } from '../../../src/http';
import { istDay } from '../../../src/time';
import { app } from '../app';
import { currentDevice, requireAction, requireStaff } from '../auth';
import { markedDb, offlineBillPattern, realTime, runOffline, type OfflineStep } from '../offline';
import { bizOf, clock } from '../util';
import type { AppEnv } from '../types';

export const offlineRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
offlineRoutes.use(`${B}/offline/*`, requireStaff);
offlineRoutes.use(`${B}/devices/:id/offline`, requireStaff);

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DAY = 86_400_000;

/** This browser's counter device, if it is one of this business's (not a station's) and turned on for offline. */
async function offlineDevice(c: Parameters<typeof currentDevice>[0], bid: string) {
  const d = await currentDevice(c);
  if (!d || d.business_id !== bid || d.station_id) return null;
  const row = await one<{ offline_letter: string | null }>(c.env.DB, 'SELECT offline_letter FROM devices WHERE id = ?', d.id);
  return { id: d.id, name: d.name, letter: row?.offline_letter ?? null };
}

// What the counter keeps for offline: its letter, and the offline numbers it already used in the last two days (so a
// counter whose saved data was cleared never prints a number twice).
offlineRoutes.get(`${B}/offline/device`, requireAction('pos.view'), async (c) => {
  const bid = c.get('businessId');
  const d = await offlineDevice(c, bid);
  if (!d?.letter) return c.json({ device: d ? { name: d.name, letter: null } : null });
  const since = realTime() - 2 * DAY;
  const [bills, receipts, kots] = await Promise.all([
    all<{ bill_no: string }>(c.env.DB, 'SELECT bill_no FROM bills WHERE business_id = ? AND offline_device = ? AND printed_at > ?', bid, d.id, since),
    all<{ receipt_no: string }>(c.env.DB, 'SELECT receipt_no FROM settlements WHERE business_id = ? AND offline_device = ? AND at > ?', bid, d.id, since),
    all<{ shift_day: string; offline_label: string }>(c.env.DB, 'SELECT shift_day, offline_label FROM kots WHERE business_id = ? AND offline_label LIKE ? AND printed_at > ?', bid, `${d.letter}%`, since),
  ]);
  return c.json({ device: { name: d.name, letter: d.letter }, used: { bills: bills.map((x) => x.bill_no), receipts: receipts.map((x) => x.receipt_no),
    kots: kots.flatMap((k) => k.offline_label.split(' ').map((l) => ({ shiftDay: k.shift_day, label: l }))) } });
});

// The owner turns a counter device on for offline: it gets the next letter never given in this business. A letter is never
// taken back or given again, so an offline number can never be used twice.
offlineRoutes.post(`${B}/devices/:id/offline`, requireAction('staff.manage'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Device not found.');
  const d = await one<{ id: string; station_id: string | null; revoked_at: number | null; offline_letter: string | null }>(c.env.DB,
    'SELECT id, station_id, revoked_at, offline_letter FROM devices WHERE id = ? AND business_id = ?', id, bid);
  if (!d || d.revoked_at) fail(404, 'Device not found.');
  if (d.station_id) fail(400, "A station's device shows KOTs only; it does not work offline.");
  if (d.offline_letter) return c.json({ letter: d.offline_letter });
  const used = new Set((await all<{ l: string }>(c.env.DB, 'SELECT offline_letter AS l FROM devices WHERE business_id = ? AND offline_letter IS NOT NULL', bid)).map((x) => x.l));
  const letter = [...LETTERS].find((l) => !used.has(l));
  if (!letter) fail(409, 'Every letter is already given to a device.');
  try {
    await stmt(c.env.DB, 'UPDATE devices SET offline_letter = ? WHERE id = ? AND offline_letter IS NULL', letter, id).run();
  } catch { fail(409, 'Another device took that letter at the same moment. Try again.'); }
  return c.json({ letter: (await one<{ l: string }>(c.env.DB, 'SELECT offline_letter AS l FROM devices WHERE id = ?', id))!.l }, 201);
});

// The routes a step may be run through, under this business: making an order, adding items, its note, a KOT, a bill, a
// payment of bills, and a payment on an account (a room).
const ALLOWED: [string, RegExp][] = [
  ['POST', /^\/orders$/],
  ['POST', /^\/orders\/[0-9a-f-]{36}\/items$/],
  ['PUT', /^\/orders\/[0-9a-f-]{36}\/note$/],
  ['POST', /^\/orders\/[0-9a-f-]{36}\/kot$/],
  ['POST', /^\/orders\/[0-9a-f-]{36}\/bill$/],
  ['POST', /^\/settlements$/],
  ['POST', /^\/debtors\/[0-9a-f-]{36}\/receipts$/],
];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

offlineRoutes.post(`${B}/offline/replay`, requireAction('pos.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const d = await offlineDevice(c, bid);
  if (!d?.letter) fail(403, 'This device is not turned on for offline. The owner turns it on in Settings, Counter devices.');
  const data = await body(c);
  const stepId = data.stepId;
  if (typeof stepId !== 'string' || !/^[A-Za-z0-9:._-]{8,100}$/.test(stepId)) fail(400, 'Step id is not valid.');
  const at = data.at;
  const t = realTime();
  if (typeof at !== 'number' || !Number.isInteger(at) || at > t + 2 * 60_000 || at < t - 3 * DAY) fail(400, 'The time of this step is not valid (more than 3 days old, or later than now).');
  const done = await one<{ server_id: string | null }>(db, 'SELECT server_id FROM offline_steps WHERE business_id = ? AND step_id = ?', bid, stepId);
  if (done) return c.json({ ok: true, already: true, serverId: done.server_id });

  const method = data.method;
  const rawPath = data.path;
  if ((method !== 'POST' && method !== 'PUT') || typeof rawPath !== 'string') fail(400, 'Step is not valid.');
  const payload = (data.body ?? {}) as Record<string, unknown>;
  if (typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Step is not valid.');
  const localId = typeof data.localId === 'string' && isUuid(data.localId) ? data.localId : null;

  // The device's own ids (orders and bills made offline) become the server's.
  const text = `${rawPath}\n${JSON.stringify(payload)}`;
  const ids = [...new Set(text.match(UUID_RE) ?? [])];
  const known = ids.length ? await all<{ local_id: string; server_id: string }>(db,
    'SELECT local_id, server_id FROM offline_steps WHERE business_id = ? AND server_id IS NOT NULL AND local_id IN (SELECT value FROM json_each(?))', bid, JSON.stringify(ids)) : [];
  const swap = (s: string) => known.reduce((x, k) => x.split(k.local_id).join(k.server_id), s);
  const path = swap(rawPath);
  const sent = JSON.parse(swap(JSON.stringify(payload))) as Record<string, unknown>;
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) fail(400, 'That cannot be sent up from offline.');

  const b = bizOf(c);
  const step: OfflineStep = { at, deviceId: d.id, letter: d.letter };
  // Numbers printed offline: each must be this device's, for the day (or year) it was printed.
  if (data.kotLabels !== undefined) {
    const k = data.kotLabels as Record<string, unknown>;
    if (!k || typeof k !== 'object' || Object.values(k).some((v) => typeof v !== 'string' || !new RegExp(`^${d.letter}\\d{1,4}$`).test(v))) fail(400, 'KOT label is not valid.');
    step.kotLabels = k as Record<string, string>;
  }
  if (data.billNo !== undefined) {
    const e = await one<{ series_prefix: string }>(db, 'SELECT series_prefix FROM billing_entities WHERE id = ? AND business_id = ?', sent.entityId, bid);
    const yymmdd = istDay(at).slice(2).replace(/-/g, '');
    if (!e || typeof data.billNo !== 'string' || !offlineBillPattern(e.series_prefix, yymmdd, d.letter).test(data.billNo)) fail(400, 'The offline bill number is not valid for this device and day.');
    step.billNo = data.billNo;
  }
  if (data.receiptNo !== undefined) {
    const fy = clock(b, at).fy;
    if (typeof data.receiptNo !== 'string' || !new RegExp(`^RCPT/${fy.slice(2)}/${d.letter}\\d{3,4}$`).test(data.receiptNo)) fail(400, 'The offline receipt number is not valid for this device and year.');
    step.receiptNo = data.receiptNo;
  }

  const serverIdSql = method === 'POST' && path === '/orders' ? '(SELECT id FROM orders WHERE business_id = ? ORDER BY rowid DESC LIMIT 1)'
    : step.billNo ? '(SELECT id FROM bills WHERE business_id = ? AND bill_no = ?)' : 'NULL';
  const serverIdArgs = serverIdSql === 'NULL' ? [] : step.billNo ? [bid, step.billNo] : [bid];
  const marker = stmt(db, `INSERT INTO offline_steps (business_id, step_id, device_id, local_id, server_id, offline_at, staff_id, done_at) VALUES (?, ?, ?, ?, ${serverIdSql}, ?, ?, ?)`,
    bid, stepId, d.id, localId, ...serverIdArgs, at, c.get('staff').id, t);
  const marked = markedDb(db, marker);
  const req = new Request(new URL(`/api/businesses/${bid}${path}`, c.req.url), {
    method, headers: { 'Content-Type': 'application/json', Cookie: c.req.header('Cookie') ?? '' }, body: JSON.stringify(sent),
  });
  let ctx: Parameters<typeof app.fetch>[2];
  try { ctx = c.executionCtx as typeof ctx; } catch { ctx = undefined; }
  let res: Response;
  try {
    res = await runOffline(step, async () => app.fetch(req, { ...c.env, DB: marked.db }, ctx));
  } catch (e) {
    // A UNIQUE failure on the marker: the same step finished meanwhile (sent twice at once).
    const again = await one<{ server_id: string | null }>(db, 'SELECT server_id FROM offline_steps WHERE business_id = ? AND step_id = ?', bid, stepId);
    if (again) return c.json({ ok: true, already: true, serverId: again.server_id });
    throw e;
  }
  const out = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok) return c.json({ ok: false, status: res.status, error: out?.error ?? 'It could not be saved.', code: out?.code ?? null });
  if (!marked.used()) await marker.run();
  const row = await one<{ server_id: string | null }>(db, 'SELECT server_id FROM offline_steps WHERE business_id = ? AND step_id = ?', bid, stepId);
  // A bill whose total here differs from its paper: kept as saved, and marked for the manager to check.
  if (step.billNo) {
    const bill = out?.bill as { totalPaise?: number } | undefined;
    const expect = typeof data.expectTotalPaise === 'number' ? data.expectTotalPaise : null;
    if (expect !== null && bill?.totalPaise !== undefined && bill.totalPaise !== expect) {
      await stmt(db, 'UPDATE offline_steps SET problem = ? WHERE business_id = ? AND step_id = ?',
        `Bill ${step.billNo} was printed offline on ${d.name} for ${(expect / 100).toFixed(2)}; it is saved as ${(bill.totalPaise / 100).toFixed(2)}.`, bid, stepId).run();
      return c.json({ ok: true, serverId: row?.server_id ?? null, data: out, mismatch: true });
    }
  }
  return c.json({ ok: true, serverId: row?.server_id ?? null, data: out });
});


