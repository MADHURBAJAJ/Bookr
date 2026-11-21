// Events, and sales by table section and by hour (approved 21 Nov 2026).
//
// An event (a night run with an organiser) has a start and end time, the table sections whose bills count towards it,
// and the organiser's commission: a share of those bills' net sales (after bill discounts, before GST, liquor included),
// void bills left out. Nothing is tagged on the bill itself: a bill counts when it was printed during the event at one of
// its tables. What the organiser is paid is recorded here; cash and UPI also go out of the drawer, so shift close counts them.
import { Hono } from 'hono';
import { all, newId, now, one, stmt, type DB } from '../../../src/db';
import { body, fail, text } from '../../../src/http';
import { parsePaise } from '../../../src/money';
import { requireAction, requireStaff } from '../auth';
import { audit, bizOf, clock, isTrigger, placeOf, tableLayout, type Section } from '../util';
import type { AppEnv } from '../types';

export const eventRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
eventRoutes.use(`${B}/*`, requireStaff);

const IST = 19_800_000;
const net = 'b.taxable_paise + b.nongst_paise';

/** A time from the screen: an ISO date-time as typed in India time ("2026-11-21T19:00"), or epoch milliseconds. */
function timeOf(v: unknown, label: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d{12,14}$/.test(v)) return Number(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
    const [d, t] = v.split('T');
    return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), +t.slice(0, 2), +t.slice(3, 5)) - IST;
  }
  fail(400, `${label}: choose a date and time.`);
}

/** Bills (not void) printed in [from, to), with the table section their order's place is in. */
async function billsIn(db: DB, bid: string, layout: Section[] | null, from: number, to: number) {
  const rows = await all<{ place: string; kind: string; printed_at: number; netPaise: number; comp: number }>(db,
    `SELECT o.place, o.kind, b.printed_at, ${net} AS netPaise,
       EXISTS (SELECT 1 FROM payments p WHERE p.settlement_id = b.settlement_id AND p.mode = 'comp') AS comp
     FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.business_id = ? AND b.status <> 'void' AND b.printed_at >= ? AND b.printed_at < ?`, bid, from, to);
  return rows.map((r) => {
    const at = r.kind === 'table' ? placeOf(layout, r.place) : null;
    const section = at ? at.section.name : r.kind === 'room' ? 'Room service' : r.kind === 'takeaway' ? 'Takeaway' : 'Other tables';
    return { ...r, section, sectionKind: at?.section.kind ?? null, whole: at?.whole ?? null };
  });
}

async function eventTotals(db: DB, bid: string, layout: Section[] | null, e: { id: string; starts_at: number; ends_at: number; commission_bp: number; sections: string; cancelled_at: number | null }) {
  const secs = JSON.parse(e.sections) as string[];
  const end = e.cancelled_at ? Math.min(e.ends_at, e.cancelled_at) : e.ends_at;
  const bills = (await billsIn(db, bid, layout, e.starts_at, end)).filter((b) => secs.includes(b.section) && !b.comp);
  const netPaise = bills.reduce((t, b) => t + b.netPaise, 0);
  const paid = (await one<{ s: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS s FROM event_payments WHERE event_id = ?', e.id))!.s;
  const commissionPaise = Math.round((netPaise * e.commission_bp) / 10_000);
  return { bills: bills.length, netPaise, commissionPaise, paidPaise: paid, duePaise: Math.max(0, commissionPaise - paid) };
}

const eventOut = (e: Record<string, unknown> & { sections: string; menu: string | null }) => ({
  id: e.id, name: e.name, organiser: e.organiser, startsAt: e.starts_at, endsAt: e.ends_at, commissionBp: e.commission_bp,
  sections: JSON.parse(e.sections), menu: e.menu ? JSON.parse(e.menu) : null, cancelledAt: e.cancelled_at, createdAt: e.created_at,
});
const EVENT_COLS = 'id, name, organiser, starts_at, ends_at, commission_bp, sections, menu, cancelled_at, created_at';

// The event on now (for the counter's banner and its menu), if any.
eventRoutes.get(`${B}/event-mode/now`, requireAction('pos.view'), async (c) => {
  const t = now();
  const e = await one<Record<string, unknown> & { sections: string; menu: string | null }>(c.env.DB,
    `SELECT ${EVENT_COLS} FROM events WHERE business_id = ? AND starts_at <= ? AND ends_at > ? AND cancelled_at IS NULL ORDER BY starts_at DESC LIMIT 1`, c.get('businessId'), t, t);
  return c.json({ event: e ? eventOut(e) : null });
});

// Recent and coming events with their sales, commission, what has been paid and what is still due.
eventRoutes.get(`${B}/event-mode`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const layout = tableLayout(bizOf(c));
  const rows = await all<Record<string, unknown> & { id: string; starts_at: number; ends_at: number; commission_bp: number; sections: string; menu: string | null; cancelled_at: number | null }>(c.env.DB,
    `SELECT ${EVENT_COLS} FROM events WHERE business_id = ? ORDER BY starts_at DESC LIMIT 40`, bid);
  const events = [];
  for (const e of rows) {
    const payments = await all(c.env.DB, `SELECT p.amount_paise AS amountPaise, p.mode, p.note, p.at, s.name AS byName FROM event_payments p LEFT JOIN staff s ON s.id = p.by_staff
      WHERE p.event_id = ? ORDER BY p.at`, e.id);
    events.push({ ...eventOut(e), ...(await eventTotals(c.env.DB, bid, layout, e)), payments });
  }
  return c.json({ events });
});

eventRoutes.post(`${B}/event-mode`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  const name = text(data, 'name', 'Event name', { max: 80 })!;
  const organiser = text(data, 'organiser', 'Organiser', { max: 80 })!;
  const startsAt = timeOf(data.startsAt, 'Starts');
  const endsAt = timeOf(data.endsAt, 'Ends');
  if (endsAt <= startsAt) fail(400, 'The event must end after it starts.');
  if (endsAt - startsAt > 3 * 86_400_000) fail(400, 'An event can last up to 3 days.');
  const pct = typeof data.commission === 'string' ? Number(data.commission) : data.commission;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) fail(400, 'Commission must be a percentage from 0 to 100.');
  const layout = tableLayout(bizOf(c)) ?? [];
  const sections = Array.isArray(data.sections) ? (data.sections as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (!sections.length || sections.some((x) => !layout.some((s) => s.name === x))) fail(400, 'Choose the table sections whose bills count towards the event.');
  const menu = Array.isArray(data.menu) && data.menu.length ? (data.menu as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50) : null;
  const clash = await one<{ name: string }>(c.env.DB, 'SELECT name FROM events WHERE business_id = ? AND cancelled_at IS NULL AND starts_at < ? AND ends_at > ?', bid, endsAt, startsAt);
  if (clash) fail(409, `${clash.name} is on at that time. One event at a time.`);
  const id = newId();
  const t = now();
  const row = { name, organiser, starts_at: startsAt, ends_at: endsAt, commission_bp: Math.round(pct * 100), sections, menu };
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO events (id, business_id, name, organiser, starts_at, ends_at, commission_bp, sections, menu, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, bid, name, organiser, startsAt, endsAt, row.commission_bp, JSON.stringify(sections), menu ? JSON.stringify(menu) : null, c.get('staff').id, t),
    audit(c.env.DB, bid, c.get('staff').id, 'event.create', 'events', id, null, row),
  ]);
  return c.json({ id }, 201);
});

// Ends an event early (or calls off one not started): bills from then on no longer count.
eventRoutes.post(`${B}/event-mode/:id/end`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const e = await one<{ id: string; ends_at: number; cancelled_at: number | null }>(c.env.DB, 'SELECT id, ends_at, cancelled_at FROM events WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!e) fail(404, 'Event not found.');
  const t = now();
  if (e.cancelled_at || e.ends_at <= t) fail(409, 'This event has already ended.');
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE events SET cancelled_at = ? WHERE id = ?', t, e.id),
    audit(c.env.DB, bid, c.get('staff').id, 'event.end', 'events', e.id, null, { at: t }),
  ]);
  return c.json({ ok: true });
});

// A payment to the organiser. Cash and UPI go out of the drawer as a paid-out on this shift.
eventRoutes.post(`${B}/event-mode/:id/payments`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const e = await one<{ id: string; name: string; organiser: string }>(db, 'SELECT id, name, organiser FROM events WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!e) fail(404, 'Event not found.');
  const data = await body(c);
  const amount = typeof data.amount === 'string' ? parsePaise(data.amount) : null;
  if (amount === null || amount <= 0) fail(400, 'Amount must be above zero, in rupees.');
  if (!['cash', 'upi', 'bank'].includes(data.mode as string)) fail(400, 'Paid by cash, UPI or bank transfer.');
  const mode = data.mode as 'cash' | 'upi' | 'bank';
  const note = text(data, 'note', 'Note', { optional: true, max: 120 });
  const { t, shiftDay } = clock(bizOf(c));
  const id = newId();
  const outId = mode === 'bank' ? null : newId();
  try {
    await db.batch([
      ...(outId ? [stmt(db, "INSERT INTO drawer_outs (id, business_id, kind, mode, amount_paise, note, shift_day, by_staff, at) VALUES (?, ?, 'paid_out', ?, ?, ?, ?, ?, ?)",
        outId, bid, mode, amount, `Event commission: ${e.name} (${e.organiser})${note ? ` · ${note}` : ''}`, shiftDay, c.get('staff').id, t)] : []),
      stmt(db, 'INSERT INTO event_payments (id, business_id, event_id, amount_paise, mode, drawer_out_id, note, shift_day, by_staff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, bid, e.id, amount, mode, outId, note, shiftDay, c.get('staff').id, t),
      audit(db, bid, c.get('staff').id, 'event.payment', 'event_payments', id, null, { event: e.name, amount, mode }),
    ]);
  } catch (err) {
    if (isTrigger(err, 'shift_closed')) fail(409, 'This shift is already closed: record the payment on the next shift.');
    throw err;
  }
  return c.json({ id }, 201);
});

// Sales by table section for shifts from..to: Private Rooms, Dorms (beds / whole), Out House, NC (complimentary, at menu price), others.
eventRoutes.get(`${B}/reports/sections`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const b = bizOf(c);
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) fail(400, 'Choose the dates.');
  const startOf = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), b.shift_start_hour) - IST;
  const layout = tableLayout(b);
  const bills = await billsIn(c.env.DB, bid, layout, startOf(from), startOf(to) + 86_400_000);
  const rows = new Map<string, { section: string; kind: string | null; bills: number; netPaise: number }>();
  for (const x of bills) {
    const key = x.sectionKind === 'dorms' ? `${x.section} (${x.whole ? 'whole' : 'beds'})` : x.sectionKind === 'nc' || x.comp ? (x.sectionKind === 'nc' ? x.section : `${x.section} · complimentary`) : x.section;
    const r = rows.get(key) ?? { section: key, kind: x.sectionKind === 'nc' || x.comp ? 'comp' : x.sectionKind, bills: 0, netPaise: 0 };
    r.bills += 1; r.netPaise += x.netPaise;
    rows.set(key, r);
  }
  const order = (layout ?? []).map((s) => s.name);
  const list = [...rows.values()].sort((a, z) => (a.kind === 'comp' ? 1 : 0) - (z.kind === 'comp' ? 1 : 0) || (order.findIndex((n) => a.section.startsWith(n)) + 1 || 99) - (order.findIndex((n) => z.section.startsWith(n)) + 1 || 99) || a.section.localeCompare(z.section));
  return c.json({ from, to, sections: list });
});

// Sales by hour (India time) between two times, for one table section or all: an evening that runs past midnight.
eventRoutes.get(`${B}/reports/hours`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const from = timeOf(c.req.query('from') ?? '', 'From');
  const to = timeOf(c.req.query('to') ?? '', 'To');
  if (to <= from || to - from > 7 * 86_400_000) fail(400, 'Choose a time range of up to 7 days, ending after it starts.');
  const section = c.req.query('section') || null;
  const bills = (await billsIn(c.env.DB, bid, tableLayout(bizOf(c)), from, to)).filter((x) => !x.comp && (!section || x.section === section));
  const hours: { from: number; bills: number; netPaise: number }[] = [];
  for (let h = Math.floor((from + IST) / 3_600_000) * 3_600_000 - IST; h < to; h += 3_600_000) hours.push({ from: h, bills: 0, netPaise: 0 });
  for (const x of bills) {
    const slot = hours.find((h) => x.printed_at >= h.from && x.printed_at < h.from + 3_600_000);
    if (slot) { slot.bills += 1; slot.netPaise += x.netPaise; }
  }
  return c.json({ from, to, section, hours, totalPaise: bills.reduce((t, x) => t + x.netPaise, 0), bills: bills.length });
});

