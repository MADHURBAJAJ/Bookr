// The front desk (25 Nov 2026): today's board, the room chart, reservations made at the desk, rates per room type, rooms
// out of order, and the reminders to enter a desk reservation in Djubo. Djubo stays the master for rooms: a reservation
// made here is "not in Djubo yet" until Djubo's confirmation mail arrives and links to it (same phone and check-in).
import { Hono, type Context } from 'hono';
import { all, newId, now, one, stmt, type DB } from '../../../src/db';
import { body, fail, isUuid, text } from '../../../src/http';
import { parsePaise } from '../../../src/money';
import { approval, isManager, requireAction, requireStaff } from '../auth';
import { audit, bizOf, clock, dormBed, dormWhole, tableLayout, type Business } from '../util';
import { phoneKey } from './settings';
import { checkReceiptPayments, deskAdvance } from './settle';
import { deskPending } from '../rooms';
import { formCPending } from './roomdesk';
import type { AppEnv } from '../types';

export const frontDeskRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
frontDeskRoutes.use(`${B}/*`, requireStaff);

const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const nights = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / DAY));
const flat = (t: string) => t.toLowerCase().replace(/\s+/g, '');
export const HOLD_HOURS = 6;

// ---------- the rooms and what fills them

/** Sellable rooms and beds by section (a dorm by its beds; its "whole" fills every bed). */
function roomsOf(b: Business) {
  return (tableLayout(b) ?? []).filter((s) => s.kind === 'rooms' || s.kind === 'dorms').map((s) => ({
    name: s.name, kind: s.kind,
    rooms: s.kind === 'dorms' ? (s.dorms ?? []).flatMap((d) => Array.from({ length: d.beds }, (_, i) => dormBed(d.name, i + 1, d.letters))) : s.tables,
    wholes: s.kind === 'dorms' ? Object.fromEntries((s.dorms ?? []).map((d) => [dormWhole(d.name), Array.from({ length: d.beds }, (_, i) => dormBed(d.name, i + 1, d.letters))])) : {},
  }));
}

export interface Bar { room: string; from: string; to: string; kind: 'occ' | 'arr' | 'hold' | 'pos' | 'ooo'; label: string; ref: { type: string; id: string };
  /** For the chart's colours and filters (25 Nov 2026): the guest, where it was booked, and whether it can be stretched here. */
  guest?: string | null; src?: 'direct' | 'mmt' | 'gi' | 'web' | 'desk' | null; byHand?: boolean }
/** Where a booking came from, for the chart: MakeMyTrip, Goibibo, the website, or direct (phone, walk-in, Djubo direct). */
export const srcOf = (channel: string | null, source: string | null): Bar['src'] =>
  /goibibo/i.test(channel ?? '') ? 'gi' : /make\s*my\s*trip|\bmmt\b/i.test(channel ?? '') || source === 'mmt' ? 'mmt' : /website|booking engine/i.test(channel ?? '') ? 'web' : 'direct';

/** Everything on the chart from `from` for `days` nights: Djubo / MakeMyTrip bookings, guests in house, reservations made here, rooms out of order. */
export async function chartData(db: DB, b: Business, from: string, days: number, excludeReservation: string | null = null) {
  const to = addDays(from, days);
  const t = now();
  const today = clock(b, t).shiftDay;
  const secs = roomsOf(b);
  const all_ = secs.flatMap((s) => s.rooms);
  const wholes: Record<string, string[]> = Object.assign({}, ...secs.map((s) => s.wholes));
  // A name as written anywhere ("XIVA", "XIV A", "II · whole") to the chart's rows.
  const rowsFor = (label: string): string[] => {
    const w = Object.entries(wholes).find(([k]) => flat(k) === flat(label));
    if (w) return w[1];
    const r = all_.find((x) => flat(x) === flat(label));
    return r ? [r] : [];
  };
  const bars: Bar[] = [];
  const unassigned: { label: string; from: string; to: string; kind: string; ref: { type: string; id: string }; roomType: string | null }[] = [];
  const put = (labels: string[], f: string, e: string, kind: Bar['kind'], label: string, ref: Bar['ref'], roomType: string | null, extra: Partial<Bar> = {}) => {
    const rows = labels.flatMap(rowsFor);
    if (rows.length) for (const room of rows) bars.push({ room, from: f, to: e, kind, label, ref, ...extra });
    else unassigned.push({ label, from: f, to: e, kind, ref, roomType });
  };
  const [bookings, stays, reservations, blocks] = await Promise.all([
    all<{ id: string; guest_name: string | null; check_in: string; check_out: string; room_labels: string | null; status: string; problem: string | null; channel: string | null;
      source: string; stay_id: string | null; room_type: string | null; rooms: number | null }>(db, `SELECT id, guest_name, check_in, check_out, room_labels, status, problem, channel, source, stay_id, room_type, rooms
      FROM bookings k WHERE business_id = ? AND status IN ('new', 'approved', 'checked_in') AND unplaced = 0 AND check_in IS NOT NULL AND check_out IS NOT NULL
      AND check_in < ? AND check_out > ? AND NOT (source = 'mmt' AND match_id IS NOT NULL AND EXISTS (SELECT 1 FROM bookings m WHERE m.id = k.match_id AND m.status <> 'cancelled'))`, b.id, to, from),
    all<{ id: string; room: string; guest_name: string; check_in: string; plan: string | null; channel: string | null; bsource: string | null; booked: number }>(db, `SELECT s.id, s.room, s.guest_name, s.check_in,
      (SELECT k.channel FROM bookings k WHERE k.stay_id = s.id ORDER BY k.source = 'djubo' DESC LIMIT 1) AS channel,
      (SELECT k.source FROM bookings k WHERE k.stay_id = s.id ORDER BY k.source = 'djubo' DESC LIMIT 1) AS bsource,
      EXISTS (SELECT 1 FROM bookings k WHERE k.stay_id = s.id) AS booked,
      coalesce(s.check_out_plan, (SELECT max(k.check_out) FROM bookings k WHERE k.stay_id = s.id), (SELECT r.check_out FROM reservations r WHERE r.id = s.reservation_id)) AS plan
      FROM stays s WHERE s.business_id = ? AND s.checked_out_at IS NULL`, b.id),
    all<{ id: string; guest_name: string; check_in: string; check_out: string; lines: string; status: string; hold_until: number | null; stay_id: string | null; source: string }>(db,
      `SELECT id, guest_name, check_in, check_out, lines, status, hold_until, stay_id, source FROM reservations WHERE business_id = ? AND status IN ('confirmed', 'hold')
       AND booking_id IS NULL AND stay_id IS NULL AND check_in < ? AND check_out > ? AND id IS NOT ?`, b.id, to, from, excludeReservation),
    all<{ id: string; room: string; from_day: string; to_day: string; note: string }>(db, 'SELECT id, room, from_day, to_day, note FROM room_blocks WHERE business_id = ? AND from_day < ? AND to_day >= ?', b.id, to, from),
  ]);
  for (const s of stays) {
    const end = s.plan && s.plan > today ? s.plan : addDays(today, 1);
    put([s.room], s.check_in, end, 'occ', `${s.guest_name} · in house`, { type: 'stay', id: s.id }, null,
      { guest: s.guest_name, src: s.booked ? srcOf(s.channel, s.bsource) : 'direct', byHand: !s.booked });
  }
  for (const k of bookings) {
    if (k.stay_id) continue;   // shown by its stay
    put((k.room_labels ?? '').split(',').map((x) => x.trim()).filter(Boolean), k.check_in, k.check_out, k.problem ? 'hold' : 'arr',
      `${k.guest_name ?? 'No name'} · ${k.channel ?? (k.source === 'mmt' ? 'MakeMyTrip' : 'Djubo')}`, { type: 'booking', id: k.id }, k.room_type,
      { guest: k.guest_name, src: srcOf(k.channel, k.source), byHand: false });
  }
  for (const r of reservations) {
    if (r.status === 'hold' && (r.hold_until ?? 0) < t) continue;   // a lapsed hold frees its rooms
    const lines = JSON.parse(r.lines) as { type: string; roomNames?: string[] }[];
    const names = lines.flatMap((l) => l.roomNames ?? []);
    put(names, r.check_in, r.check_out, r.status === 'hold' ? 'hold' : 'pos', `${r.guest_name} · ${r.status === 'hold' ? 'hold' : 'not in Djubo yet'}`, { type: 'reservation', id: r.id },
      lines.map((l) => l.type).join(', '), { guest: r.guest_name, src: 'desk', byHand: true });
  }
  for (const x of blocks) put([x.room], x.from_day, addDays(x.to_day, 1), 'ooo', `Out of order · ${x.note}`, { type: 'block', id: x.id }, null, { guest: null, src: null, byHand: true });
  // Housekeeping state per room, and the room-type rates, for the chart (25 Nov 2026).
  const [hk, rates] = await Promise.all([
    all<{ room: string; status: string }>(db, "SELECT room, status FROM room_status WHERE business_id = ? AND status <> 'inspected'", b.id),
    one<{ r: string }>(db, 'SELECT room_rates AS r FROM businesses WHERE id = ?', b.id),
  ]);
  let rateMap: Record<string, number> = {};
  try { rateMap = JSON.parse(rates?.r ?? '{}'); } catch { /* none */ }
  return { from, days, today, sections: secs.map((s) => ({ name: s.name, kind: s.kind, rooms: s.rooms, ratePaise: rateMap[s.name] ?? null })), bars, unassigned,
    housekeeping: Object.fromEntries(hk.map((x) => [x.room, x.status])) };
}

/** Rooms of each type free on every night from..to (a room with any bar on those nights is taken). Unplaced bookings of a type take one each. */
export async function freeRooms(db: DB, b: Business, from: string, to: string, excludeReservation: string | null = null) {
  const c = await chartData(db, b, from, nights(from, to), excludeReservation);
  const busy = new Set(c.bars.filter((x) => x.from < to && x.to > from).map((x) => x.room));
  return c.sections.map((s) => {
    const free = s.rooms.filter((r) => !busy.has(r));
    const unplaced = c.unassigned.filter((u) => u.from < to && u.to > from && (u.roomType ?? '').toLowerCase().split(', ').includes(s.name.toLowerCase())).length;
    return { type: s.name, kind: s.kind, total: s.rooms.length, freeRooms: free, freeCount: Math.max(0, free.length - unplaced) };
  });
}

frontDeskRoutes.get(`${B}/frontdesk/chart`, requireAction('stays.edit'), async (c) => {
  const b = bizOf(c);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('from') ?? '') ? c.req.query('from')! : clock(b).shiftDay;
  const days = Math.min(31, Math.max(1, Number(c.req.query('days')) || 7));
  return c.json(await chartData(c.env.DB, b, from, days));
});

frontDeskRoutes.get(`${B}/frontdesk/free`, requireAction('stays.edit'), async (c) => {
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) fail(400, 'Choose check-in and a later check-out.');
  return c.json({ types: await freeRooms(c.env.DB, bizOf(c), from, to), rates: await ratesOf(c.env.DB, c.get('businessId')) });
});

// ---------- reminders: a reservation made here that Djubo has not confirmed

/** Reservations made here not yet in Djubo: amber after 15 minutes, red after an hour or from the arrival day. */
export async function notInDjubo(db: DB, bid: string, today: string, t = now()) {
  const rows = await all<{ id: string; guest_name: string; phone: string; check_in: string; check_out: string; lines: string; status: string; hold_until: number | null;
    remind_from: number; created_at: number; made_by_name: string | null }>(db, `SELECT r.id, r.guest_name, r.phone, r.check_in, r.check_out, r.lines, r.status, r.hold_until,
      r.remind_from, r.created_at, s.name AS made_by_name FROM reservations r LEFT JOIN staff s ON s.id = r.made_by
    WHERE r.business_id = ? AND r.status IN ('confirmed', 'hold') AND r.booking_id IS NULL AND r.check_out > ?
      AND (r.stay_id IS NULL OR EXISTS (SELECT 1 FROM stays st WHERE st.id = r.stay_id AND st.checked_out_at IS NULL)) ORDER BY r.created_at`, bid, today);
  return rows.filter((r) => !(r.status === 'hold' && (r.hold_until ?? 0) < t)).map((r) => {
    const mins = Math.floor((t - r.remind_from) / 60_000);
    const level = mins >= 60 || r.check_in <= today ? 'red' : mins >= 15 ? 'amber' : null;
    const lines = JSON.parse(r.lines) as { type: string; rooms: number; roomNames?: string[] }[];
    return { id: r.id, guestName: r.guest_name, checkIn: r.check_in, checkOut: r.check_out, status: r.status, madeBy: r.made_by_name, madeAt: r.created_at, minutes: Math.floor((t - r.created_at) / 60_000),
      rooms: lines.map((l) => `${l.type}${l.roomNames?.length ? ` ${l.roomNames.join(', ')}` : ` × ${l.rooms}`}`).join(' · '), level };
  }).filter((r) => r.level);
}

frontDeskRoutes.get(`${B}/frontdesk/alerts`, requireAction('stays.edit'), async (c) => {
  const b = bizOf(c);
  return c.json({ notInDjubo: await notInDjubo(c.env.DB, b.id, clock(b).shiftDay) });
});

// ---------- today's board

frontDeskRoutes.get(`${B}/frontdesk/today`, requireAction('stays.edit'), async (c) => {
  const b = bizOf(c);
  const db = c.env.DB;
  const { t, shiftDay: today } = clock(b);
  const [arrivals, reservations, stays, chart, alerts, desk, unplaced] = await Promise.all([
    all<{ id: string; guestName: string | null; roomType: string | null; roomLabels: string | null; checkIn: string; checkOut: string; channel: string | null; source: string;
      amountPaise: number | null; paidPaise: number | null; deskPaidPaise: number; heldPaise: number; problem: string | null }>(db, `SELECT id, guest_name AS guestName, room_type AS roomType,
      room_labels AS roomLabels, check_in AS checkIn, check_out AS checkOut, channel, source, amount_paise AS amountPaise, paid_paise AS paidPaise, desk_paid_paise AS deskPaidPaise, problem,
      (SELECT coalesce(sum(d.amount_paise), 0) FROM desk_advances d WHERE d.status = 'held' AND (d.booking_id = bk.id OR d.booking_id = bk.match_id)) AS heldPaise
      FROM bookings bk WHERE business_id = ? AND status IN ('approved', 'new') AND unplaced = 0 AND check_in <= ? AND check_out > ? AND stay_id IS NULL
      AND NOT (bk.source = 'mmt' AND EXISTS (SELECT 1 FROM bookings m WHERE m.id = bk.match_id AND m.status <> 'cancelled' AND m.stay_id IS NULL)) ORDER BY guest_name`, b.id, today, today),
    all<{ id: string; guestName: string; checkIn: string; checkOut: string; lines: string; status: string; holdUntil: number | null; totalPaise: number; source: string; heldPaise: number }>(db,
      `SELECT r.id, r.guest_name AS guestName, r.check_in AS checkIn, r.check_out AS checkOut, r.lines, r.status, r.hold_until AS holdUntil, r.total_paise AS totalPaise, r.source,
       (SELECT coalesce(sum(d.amount_paise), 0) FROM desk_advances d WHERE d.reservation_id = r.id AND d.status = 'held') AS heldPaise
       FROM reservations r WHERE r.business_id = ? AND r.status IN ('confirmed', 'hold') AND r.booking_id IS NULL AND r.stay_id IS NULL AND r.check_in <= ? AND r.check_out > ?`, b.id, today, today),
    all<{ id: string; room: string; guestName: string; checkIn: string; plan: string | null; accountId: string; balancePaise: number }>(db, `SELECT s.id, s.room, s.guest_name AS guestName,
      s.check_in AS checkIn, d.id AS accountId,
      coalesce(s.check_out_plan, (SELECT max(k.check_out) FROM bookings k WHERE k.stay_id = s.id), (SELECT r.check_out FROM reservations r WHERE r.id = s.reservation_id)) AS plan,
      coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balancePaise
      FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id WHERE s.business_id = ? AND s.checked_out_at IS NULL ORDER BY s.room`, b.id),
    chartData(db, b, today, 1),
    notInDjubo(db, b.id, today, t),
    deskPending(db, b.id),
    one<{ n: number }>(db, "SELECT count(*) AS n FROM bookings WHERE business_id = ? AND status = 'new' AND unplaced = 1", b.id),
  ]);
  const live = reservations.filter((r) => !(r.status === 'hold' && (r.holdUntil ?? 0) < t));
  const rooms = chart.sections.reduce((n, s) => n + s.rooms.length, 0);
  const busy = new Set(chart.bars.map((x) => x.room)).size;
  const due = (a: (typeof arrivals)[number]) => Math.max(0, (a.amountPaise ?? 0) - Math.max(0, (a.paidPaise ?? 0) - a.deskPaidPaise) - a.heldPaise);
  const toCollect = arrivals.reduce((n, a) => n + due(a), 0) + live.reduce((n, r) => n + Math.max(0, r.totalPaise - r.heldPaise), 0)
    + stays.reduce((n, s) => n + Math.max(0, s.balancePaise), 0);
  return c.json({
    today,
    arrivals: [...arrivals.map((a) => ({ ...a, kind: 'booking', duePaise: due(a) })),
      ...live.map((r) => ({ id: r.id, kind: 'reservation', guestName: r.guestName, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status, source: r.source,
        rooms: (JSON.parse(r.lines) as { type: string; rooms: number; roomNames?: string[] }[]).map((l) => `${l.type}${l.roomNames?.length ? ` ${l.roomNames.join(', ')}` : ` × ${l.rooms}`}`).join(' · '),
        duePaise: Math.max(0, r.totalPaise - r.heldPaise), totalPaise: r.totalPaise }))],
    inHouse: stays,
    leaving: stays.filter((s) => s.plan && s.plan <= today),
    stats: { arriving: arrivals.length + live.length, inHouse: stays.length, leaving: stays.filter((s) => s.plan && s.plan <= today).length, freeTonight: Math.max(0, rooms - busy), toCollectPaise: toCollect },
    alerts: { notInDjubo: alerts, formC: await formCPending(db, b.id, t), deskToTake: desk.filter((d) => d.status !== 'checked_in').length, unplaced: unplaced?.n ?? 0 },
  });
});

// ---------- rates per room type (a manager sets them)

async function ratesOf(db: DB, bid: string): Promise<Record<string, number>> {
  const r = await one<{ r: string }>(db, 'SELECT room_rates AS r FROM businesses WHERE id = ?', bid);
  try { return JSON.parse(r?.r ?? '{}'); } catch { return {}; }
}

frontDeskRoutes.put(`${B}/frontdesk/rates`, requireAction('stays.edit'), async (c) => {
  if (!isManager(c)) fail(403, 'A manager or owner sets room rates.');
  const bid = c.get('businessId');
  const data = await body(c);
  const types = roomsOf(bizOf(c)).map((s) => s.name);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries((data.rates ?? {}) as Record<string, unknown>)) {
    if (!types.includes(k)) fail(400, `"${k}" is not a room type in Settings.`);
    if (v === '' || v === null || v === undefined) continue;
    const p = typeof v === 'string' ? parsePaise(v) : null;
    if (p === null || p <= 0) fail(400, `Rate for ${k} must be an amount in rupees.`);
    out[k] = p;
  }
  const before = await ratesOf(c.env.DB, bid);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET room_rates = ? WHERE id = ?', JSON.stringify(out), bid),
    audit(c.env.DB, bid, c.get('staff').id, 'frontdesk.rates', 'businesses', bid, before, out),
  ]);
  return c.json({ rates: out });
});

// ---------- rooms out of order

frontDeskRoutes.post(`${B}/frontdesk/blocks`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  const b = bizOf(c);
  const room = text(data, 'room', 'Room', { max: 40 })!;
  if (!roomsOf(b).some((s) => s.rooms.includes(room))) fail(400, 'Choose a room or bed from the chart.');
  const from = typeof data.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.from) ? data.from : fail(400, 'From must be a date.');
  const to = typeof data.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.to) ? data.to : fail(400, 'Last night must be a date.');
  if (to < from) fail(400, 'The last night is before the first.');
  const note = text(data, 'note', 'Why it is out of order', { max: 80 })!;
  const id = newId();
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO room_blocks (id, business_id, room, from_day, to_day, note, by_staff, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, bid, room, from, to, note, c.get('staff').id, now()),
    audit(c.env.DB, bid, c.get('staff').id, 'frontdesk.block', 'room_blocks', id, null, { room, from, to, note }),
  ]);
  return c.json({ id }, 201);
});

frontDeskRoutes.delete(`${B}/frontdesk/blocks/:id`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const x = await one(c.env.DB, 'SELECT room, from_day, to_day, note FROM room_blocks WHERE id = ? AND business_id = ?', isUuid(id) ? id : null, bid);
  if (!x) fail(404, 'Not found.');
  await c.env.DB.batch([stmt(c.env.DB, 'DELETE FROM room_blocks WHERE id = ?', id), audit(c.env.DB, bid, c.get('staff').id, 'frontdesk.unblock', 'room_blocks', id, x, null)]);
  return c.json({ ok: true });
});

// ---------- reservations made at the desk

const SOURCES = ['Walk-in', 'Phone', 'WhatsApp', 'Instagram', 'Travel agent', 'Corporate', 'Website', 'Other'];

const resOut = (r: Record<string, unknown> & { lines: string; phone: string }) => ({ ...r, lines: JSON.parse(r.lines), phone: r.phone });

const RES_COLS = `r.id, r.guest_name AS guestName, r.phone, r.email, r.city, r.nationality, r.company, r.gstin, r.check_in AS checkIn, r.check_out AS checkOut,
  r.arrival_time AS arrivalTime, r.lines, r.meal_plan AS mealPlan, r.extras, r.source, r.requests, r.staff_note AS staffNote, r.policy, r.status, r.hold_until AS holdUntil,
  r.total_paise AS totalPaise, r.booking_id AS bookingId, r.stay_id AS stayId, r.created_at AS createdAt, r.cancel_reason AS cancelReason, s.name AS madeBy, k.ext_ref AS bookingRef,
  (SELECT coalesce(sum(d.amount_paise), 0) FROM desk_advances d WHERE d.reservation_id = r.id AND d.status IN ('held', 'applied')) AS advancePaise`;

frontDeskRoutes.get(`${B}/reservations`, requireAction('stays.edit'), async (c) => {
  const b = bizOf(c);
  const today = clock(b).shiftDay;
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, '');
  const [reservations, bookings] = await Promise.all([
    all<Record<string, unknown> & { lines: string; phone: string }>(c.env.DB, `SELECT ${RES_COLS} FROM reservations r LEFT JOIN staff s ON s.id = r.made_by LEFT JOIN bookings k ON k.id = r.booking_id
      WHERE r.business_id = ? AND (? = '' AND r.check_out >= ? OR ? <> '' AND (lower(r.guest_name) LIKE ? OR (? <> '' AND r.phone LIKE ?)))
      ORDER BY r.check_in, r.guest_name LIMIT 300`, b.id, q, addDays(today, -1), q, like, digits, `%${digits}%`),
    all<Record<string, unknown>>(c.env.DB, `SELECT k.id, k.source, k.ext_ref AS extRef, k.guest_name AS guestName, k.phone, k.room_type AS roomType, k.room_labels AS roomLabels, k.rooms,
      k.check_in AS checkIn, k.check_out AS checkOut, k.amount_paise AS amountPaise, k.paid_paise AS paidPaise, k.desk_paid_paise AS deskPaidPaise, k.status, k.problem, k.channel,
      k.unplaced, k.stay_id AS stayId, k.ota_ref AS otaRef, k.entered_by AS enteredBy,
      (SELECT coalesce(sum(d.amount_paise), 0) FROM desk_advances d WHERE d.status = 'held' AND (d.booking_id = k.id OR d.booking_id = k.match_id)) AS heldPaise
      FROM bookings k WHERE k.business_id = ? AND NOT (k.source = 'mmt' AND k.match_id IS NOT NULL)
      AND (? = '' AND k.check_out >= ? OR ? <> '' AND (lower(k.guest_name) LIKE ? OR lower(k.ext_ref) LIKE ? OR lower(coalesce(k.ota_ref, '')) LIKE ? OR (? <> '' AND k.phone LIKE ?)))
      ORDER BY k.check_in, k.guest_name LIMIT 300`, b.id, q, addDays(today, -1), q, like, like, like, digits, `%${digits}%`),
  ]);
  const masked = (p: unknown) => (typeof p === 'string' && p ? `••••${p.slice(-4)}` : null);
  return c.json({ today, now: now(), reservations: reservations.map((r) => ({ ...resOut(r), phone: masked(r.phone) })), bookings: bookings.map((k) => ({ ...k, phone: masked(k.phone) })) });
});

frontDeskRoutes.get(`${B}/reservations/:id`, requireAction('stays.edit'), async (c) => {
  const id = c.req.param('id');
  const r = await one<Record<string, unknown> & { lines: string; phone: string }>(c.env.DB, `SELECT ${RES_COLS} FROM reservations r LEFT JOIN staff s ON s.id = r.made_by
    LEFT JOIN bookings k ON k.id = r.booking_id WHERE r.id = ? AND r.business_id = ?`, isUuid(id) ? id : null, c.get('businessId'));
  if (!r) fail(404, 'Reservation not found.');
  return c.json({ reservation: resOut(r) });
});

/** Reads and checks a reservation as typed: dates, rooms per type (free on those nights), guest, rate and total. */
async function readReservation(c: Context<AppEnv>, data: Record<string, unknown>, editing: { id: string; checkIn: string } | null = null) {
  const b = bizOf(c);
  const db = c.env.DB;
  const { shiftDay: today } = clock(b);
  const checkIn = typeof data.checkIn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.checkIn) ? data.checkIn : fail(400, 'Check-in must be a date.');
  const checkOut = typeof data.checkOut === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.checkOut) ? data.checkOut : fail(400, 'Check-out must be a date.');
  if (checkOut <= checkIn) fail(400, 'Check-out must be after check-in.');
  if (checkIn < today && checkIn !== editing?.checkIn) fail(400, 'Check-in cannot be before today.');
  const n = nights(checkIn, checkOut);
  if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 10) fail(400, 'Choose at least one room.');
  const free = await freeRooms(db, b, checkIn, checkOut, editing?.id ?? null);
  const rates = await ratesOf(db, b.id);
  const lines: { type: string; rooms: number; roomNames: string[]; adults: number; children: number; ratePaise: number }[] = [];
  let lowRate = false;
  for (const raw of data.lines as Record<string, unknown>[]) {
    const f = free.find((x) => x.type === raw?.type);
    if (!f) fail(400, `"${String(raw?.type)}" is not a room type in Settings.`);
    const roomNames = Array.isArray(raw.roomNames) ? [...new Set(raw.roomNames.map(String))] : [];
    const rooms = roomNames.length || Number(raw.rooms);
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 30) fail(400, `${f.type}: how many ${f.kind === 'dorms' ? 'beds' : 'rooms'}?`);
    for (const r of roomNames) if (!f.freeRooms.includes(r)) fail(409, `${r} is not free on those nights.`);
    if (rooms > f.freeCount) fail(409, `${f.type}: only ${f.freeCount} free on those nights.`);
    const adults = Number(raw.adults);
    const children = Number(raw.children ?? 0);
    if (!Number.isInteger(adults) || adults < 1 || adults > 99) fail(400, `${f.type}: how many adults?`);
    if (!Number.isInteger(children) || children < 0 || children > 99) fail(400, `${f.type}: children must be a number.`);
    const rate = typeof raw.rate === 'string' ? parsePaise(raw.rate) : null;
    if (rate === null || rate <= 0) fail(400, `${f.type}: the rate per night must be an amount in rupees.`);
    // Below the room type's rate by more than the cashier's discount limit: a manager approves, as with food.
    const rack = rates[f.type];
    if (rack && (rack - rate) * 10000 > rack * b.disc_limit_bp) lowRate = true;
    lines.push({ type: f.type, rooms, roomNames, adults, children, ratePaise: rate });
  }
  const phone = phoneKey(data.phone);
  if (!phone) fail(400, "Add the guest's mobile number.");
  const hold = data.status === 'hold';
  const holdHours = Number(data.holdHours ?? HOLD_HOURS);
  if (hold && (!Number.isFinite(holdHours) || holdHours <= 0 || holdHours > 72)) fail(400, 'Hold for 1 to 72 hours.');
  const source = typeof data.source === 'string' && SOURCES.includes(data.source) ? data.source : fail(400, 'Say how it was booked.');
  const gstin = text(data, 'gstin', 'GSTIN', { optional: true, max: 15 })?.toUpperCase() ?? null;
  if (gstin && !/^\d{2}[A-Z0-9]{13}$/.test(gstin)) fail(400, 'GSTIN has 15 characters, starting with 2 digits.');
  return {
    checkIn, checkOut, nights: n, lines, lowRate, phone, hold, holdHours, source, gstin,
    guest: text(data, 'guestName', 'Guest name', { max: 80 })!,
    email: text(data, 'email', 'Email', { optional: true, max: 120 }),
    city: text(data, 'city', 'City', { optional: true, max: 60 }),
    nationality: text(data, 'nationality', 'Nationality', { optional: true, max: 40 }),
    company: text(data, 'company', 'Company', { optional: true, max: 80 }),
    arrivalTime: text(data, 'arrivalTime', 'Arrival time', { optional: true, max: 30 }),
    mealPlan: text(data, 'mealPlan', 'Meal plan', { optional: true, max: 40 }),
    extras: text(data, 'extras', 'Extras', { optional: true, max: 120 }),
    requests: text(data, 'requests', 'Special requests', { optional: true, max: 300 }),
    staffNote: text(data, 'staffNote', 'Note for staff', { optional: true, max: 300 }),
    policy: text(data, 'policy', 'Cancellation', { optional: true, max: 60 }),
    totalPaise: lines.reduce((s, l) => s + l.ratePaise * l.rooms * n, 0),
  };
}

frontDeskRoutes.post(`${B}/reservations`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const r = await readReservation(c, data);
  const approver = r.lowRate ? await approval(c, data, 'A rate below the room rate') : null;
  const withMoney = Array.isArray(data.payments) && data.payments.length > 0;
  if (withMoney) await checkReceiptPayments(c, data.payments);
  const t = now();
  const id = newId();
  const note = approver && !isManager(c) ? `${r.staffNote ? `${r.staffNote} · ` : ''}Rate approved by ${approver.name}` : r.staffNote;
  await db.batch([
    stmt(db, `INSERT INTO reservations (id, business_id, guest_name, phone, email, city, nationality, company, gstin, check_in, check_out, arrival_time, lines, meal_plan, extras,
        source, requests, staff_note, policy, status, hold_until, total_paise, remind_from, made_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, bid, r.guest, r.phone, r.email, r.city, r.nationality, r.company, r.gstin, r.checkIn, r.checkOut, r.arrivalTime, JSON.stringify(r.lines), r.mealPlan, r.extras,
      r.source, r.requests, note, r.policy, r.hold ? 'hold' : 'confirmed', r.hold ? t + r.holdHours * 3_600_000 : null, r.totalPaise, t, c.get('staff').id, t),
    audit(db, bid, c.get('staff').id, 'reservation.create', 'reservations', id, null, { guest: r.guest, checkIn: r.checkIn, checkOut: r.checkOut, totalPaise: r.totalPaise }),
  ]);
  const adv = withMoney ? await deskAdvance(c, { payments: data.payments }, { id, guest: r.guest, phone: r.phone, checkIn: r.checkIn, checkOut: r.checkOut }) : null;
  if (adv && r.hold) await stmt(db, "UPDATE reservations SET status = 'confirmed', hold_until = NULL WHERE id = ? AND status = 'hold'", id).run();
  return c.json({ id, totalPaise: r.totalPaise, receipt: adv?.receipt ?? null }, 201);
});

async function openReservation(c: Context<AppEnv>) {
  const id = c.req.param('id');
  const r = await one<{ id: string; status: string; guest_name: string; phone: string; check_in: string; check_out: string; stay_id: string | null }>(c.env.DB,
    'SELECT id, status, guest_name, phone, check_in, check_out, stay_id FROM reservations WHERE id = ? AND business_id = ?', isUuid(id) ? id : null, c.get('businessId'));
  if (!r) fail(404, 'Reservation not found.');
  return r;
}

// An advance on a reservation made here, later.
frontDeskRoutes.post(`${B}/reservations/:id/advance`, requireAction('debtors.receive'), async (c) => {
  const r = await openReservation(c);
  if (r.status === 'cancelled' || r.stay_id) fail(409, r.status === 'cancelled' ? 'This reservation was cancelled.' : 'This guest is checked in: take it on the room bill.');
  const adv = await deskAdvance(c, await body(c), { id: r.id, guest: r.guest_name, phone: r.phone, checkIn: r.check_in, checkOut: r.check_out });
  if (r.status === 'hold') await stmt(c.env.DB, "UPDATE reservations SET status = 'confirmed', hold_until = NULL WHERE id = ? AND status = 'hold'", r.id).run();
  return c.json(adv, 201);
});

// Changing a reservation made here (25 Nov 2026): dates, rooms, rate, guest, notes. Checked again for free rooms, without
// counting its own. Its advances stay with it. If Djubo already has it, Djubo must be changed too (said on screen).
frontDeskRoutes.put(`${B}/reservations/:id`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const cur = await openReservation(c);
  if (cur.status === 'cancelled' || cur.stay_id) fail(409, cur.status === 'cancelled' ? 'This reservation was cancelled.' : 'This guest is checked in: change the stay instead.');
  if (cur.status === 'linked') fail(409, "Djubo has this booking now: change it in Djubo, and its revised mail brings the change here.");
  const data = await body(c);
  const r = await readReservation(c, data, { id: cur.id, checkIn: cur.check_in });
  const approver = r.lowRate ? await approval(c, data, 'A rate below the room rate') : null;
  const before = await one(db, 'SELECT guest_name, phone, check_in, check_out, lines, total_paise, status FROM reservations WHERE id = ?', cur.id);
  const status = cur.status === 'linked' ? 'linked' : r.hold ? 'hold' : 'confirmed';
  await db.batch([
    stmt(db, `UPDATE reservations SET guest_name = ?, phone = ?, email = ?, city = ?, nationality = ?, company = ?, gstin = ?, check_in = ?, check_out = ?, arrival_time = ?, lines = ?,
        meal_plan = ?, extras = ?, source = ?, requests = ?, staff_note = ?, policy = ?, status = ?, hold_until = CASE WHEN ? = 'hold' THEN coalesce(hold_until, ?) ELSE NULL END, total_paise = ? WHERE id = ?`,
      r.guest, r.phone, r.email, r.city, r.nationality, r.company, r.gstin, r.checkIn, r.checkOut, r.arrivalTime, JSON.stringify(r.lines), r.mealPlan, r.extras, r.source, r.requests,
      approver && !isManager(c) ? `${r.staffNote ? `${r.staffNote} · ` : ''}Rate approved by ${approver.name}` : r.staffNote, r.policy, status, status, now() + r.holdHours * 3_600_000, r.totalPaise, cur.id),
    stmt(db, 'UPDATE desk_advances SET check_in = ?, phone = ? WHERE reservation_id = ? AND status = \'held\'', r.checkIn, r.phone, cur.id),
    audit(db, bid, c.get('staff').id, 'reservation.change', 'reservations', cur.id, before, { checkIn: r.checkIn, checkOut: r.checkOut, totalPaise: r.totalPaise }),
  ]);
  return c.json({ id: cur.id, totalPaise: r.totalPaise, inDjubo: cur.status === 'linked' });
});

// Entered in Djubo, mail not here yet: remind again in 15 minutes.
frontDeskRoutes.post(`${B}/reservations/:id/remind-later`, requireAction('stays.edit'), async (c) => {
  const r = await openReservation(c);
  await stmt(c.env.DB, 'UPDATE reservations SET remind_from = ? WHERE id = ?', now(), r.id).run();
  return c.json({ ok: true });
});

// Hold to confirmed (the guest said yes without paying yet).
frontDeskRoutes.post(`${B}/reservations/:id/confirm`, requireAction('stays.edit'), async (c) => {
  const r = await openReservation(c);
  if (r.status !== 'hold') fail(409, 'Only a hold can be confirmed.');
  await stmt(c.env.DB, "UPDATE reservations SET status = 'confirmed', hold_until = NULL WHERE id = ?", r.id).run();
  return c.json({ ok: true });
});

frontDeskRoutes.post(`${B}/reservations/:id/cancel`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const r = await openReservation(c);
  if (r.status === 'cancelled') fail(409, 'Already cancelled.');
  if (r.stay_id) fail(409, 'This guest is checked in.');
  const data = await body(c);
  const reason = text(data, 'reason', 'A reason for cancelling', { max: 120 })!;
  await c.env.DB.batch([
    stmt(c.env.DB, "UPDATE reservations SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, r.id),
    audit(c.env.DB, bid, c.get('staff').id, 'reservation.cancel', 'reservations', r.id, null, { reason }),
  ]);
  const held = await one<{ n: number }>(c.env.DB, "SELECT count(*) AS n FROM desk_advances WHERE reservation_id = ? AND status = 'held'", r.id);
  return c.json({ ok: true, advanceToRefund: (held?.n ?? 0) > 0 });
});

/** A reservation made here, matched by phone and check-in, once Djubo's mail for it arrives. */
export async function linkReservation(db: DB, bid: string, bookingId: string, phone: string | null, checkIn: string | undefined) {
  if (!phone || !checkIn) return;
  await stmt(db, `UPDATE reservations SET status = 'linked', booking_id = ? WHERE business_id = ? AND status IN ('confirmed', 'hold') AND booking_id IS NULL
    AND phone = ? AND check_in = ?`, bookingId, bid, phone, checkIn).run();
  // Its advances follow the booking.
  await stmt(db, `UPDATE desk_advances SET booking_id = ? WHERE business_id = ? AND status = 'held' AND booking_id IS NULL
    AND reservation_id IN (SELECT id FROM reservations WHERE booking_id = ?)`, bookingId, bid, bookingId).run();
}
