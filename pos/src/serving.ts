// Serving time (mock and data model approved 28 Nov 2026): the rules in one place.
//
// A dish's serve time is its own (0: not timed), else its category's (empty: not timed; bar categories start empty).
// Each KOT line keeps the minutes it was sent with and its order line's id (kots.lines), so menu changes never change old
// results. A line is due at the KOT's time plus its minutes. It is late when it was first marked served after that:
// kot_served.first_at is kept for good, so an undo never makes a late item look on time. A line not marked by the end is
// "not marked", counted apart, never as late or on time. Cancel KOTs, and lines whose dish was taken off the order, are not timed.
import { all, type DB } from '../../src/db';
import { IST_OFFSET_MS } from '../../src/time';
import { CATEGORY_JOIN } from './stations';

const MIN = 60_000;
/** A server may undo their own tap for this long; after it, only a manager can, with a reason. */
export const SERVER_UNDO_MS = 2 * MIN;
/** Amber from this share of the time on. */
export const SOON = 0.8;

/** The minutes each dish should be served in, by item id; items not timed are left out. */
export async function serveMinutes(db: DB, bid: string, itemIds: string[]): Promise<Map<string, number>> {
  if (!itemIds.length) return new Map();
  const rows = await all<{ id: string; mins: number | null }>(db, `SELECT m.id, CASE WHEN m.serve_mins IS NOT NULL THEN m.serve_mins ELSE c.serve_mins END AS mins
    FROM menu_items m ${CATEGORY_JOIN} WHERE m.business_id = ? AND m.id IN (SELECT value FROM json_each(?))`, bid, JSON.stringify([...new Set(itemIds)]));
  return new Map(rows.filter((r) => r.mins && r.mins > 0).map((r) => [r.id, r.mins!]));
}

export interface TimedLine {
  kotId: string; kotNo: number; orderId: string; place: string; station: string; lineNo: number;
  name: string; qty: number; options: string[]; remark: string | null; mins: number;
  sentAt: number; dueAt: number; shiftDay: string;
  /**
   * Still on the running list: its order is open, a tab or billed, or (paid or not) its shift day is not closed yet. A line
   * not marked yet is then still waiting; once the day is closed (or its order long done) it is "not marked".
   */
  orderOpen: boolean;
  servedId: string | null; firstAt: number | null; servedAt: number | null; batch: string | null;
  by: string | null; byManager: boolean; photo: boolean; undoneAt: number | null; undoneBy: string | null; undoReason: string | null;
}
interface KotRow { id: string; kot_no: number; station: string; printed_at: number; lines: string; order_id: string; place: string; shift_day: string; status: string; running: number }
interface ServedRow { id: string; kot_id: string; line_no: number; batch: string; first_at: number; served_at: number | null; photo_at: number | null;
  undone_at: number | null; undone_by: string | null; undo_reason: string | null; server_name: string | null; staff_name: string | null; staff_id: string | null }

/**
 * A KOT stays on the running list until its food is marked served (owner, 28 Nov 2026): a paid bill does not take it off.
 * It leaves when its order is cancelled, or once its shift day is closed if the order is no longer open.
 */
const RUNNING = `o.status <> 'cancelled' AND (o.status IN ('open', 'tab', 'billed')
  OR NOT EXISTS (SELECT 1 FROM shift_closes x WHERE x.business_id = k.business_id AND x.shift_day >= k.shift_day))`;
/**
 * Timed KOT lines: `running` = KOTs still on the running list from the last day (the Serve screen, tables, the manager's page);
 * else the KOTs of shift days from..to (the Daily check and the report). Cancelled orders are left out.
 */
export async function timedLines(db: DB, bid: string, opts: { running: true; now: number } | { running?: false; from: string; to: string }): Promise<TimedLine[]> {
  const kots = opts.running
    ? await all<KotRow>(db, `SELECT k.id, coalesce(k.day_no, k.kot_no) AS kot_no, k.station, k.printed_at, k.lines, k.order_id, o.place, k.shift_day, o.status, 1 AS running
        FROM kots k JOIN orders o ON o.id = k.order_id WHERE k.business_id = ? AND ${RUNNING} AND k.printed_at > ? ORDER BY k.printed_at`, bid, opts.now - 86_400_000)
    : await all<KotRow>(db, `SELECT k.id, coalesce(k.day_no, k.kot_no) AS kot_no, k.station, k.printed_at, k.lines, k.order_id, o.place, k.shift_day, o.status, (${RUNNING}) AS running
        FROM kots k JOIN orders o ON o.id = k.order_id WHERE k.business_id = ? AND o.status <> 'cancelled' AND k.shift_day BETWEEN ? AND ? ORDER BY k.printed_at`, bid, opts.from, opts.to);
  // Only KOTs that carry a timed line (older KOTs and cancel KOTs carry none).
  const timed = kots.map((k) => ({ k, lines: (JSON.parse(k.lines) as Record<string, unknown>[]) }))
    .filter((x) => x.lines.some((l) => typeof l.mins === 'number' && !l.cancelled));
  if (!timed.length) return [];
  const kotIds = JSON.stringify(timed.map((x) => x.k.id));
  const lineIds = JSON.stringify([...new Set(timed.flatMap((x) => x.lines.map((l) => l.lineId).filter((v) => typeof v === 'string')))]);
  const [served, sent] = await Promise.all([
    all<ServedRow>(db, `SELECT ks.id, ks.kot_id, ks.line_no, ks.batch, ks.first_at, ks.served_at, ks.photo_at, ks.undone_at, ks.undone_by, ks.undo_reason,
        sv.name AS server_name, st.name AS staff_name, ks.staff_id
      FROM kot_served ks LEFT JOIN servers sv ON sv.id = ks.server_id LEFT JOIN staff st ON st.id = ks.staff_id WHERE ks.kot_id IN (SELECT value FROM json_each(?))`, kotIds),
    all<{ id: string; sent_qty: number }>(db, 'SELECT id, sent_qty FROM order_lines WHERE id IN (SELECT value FROM json_each(?))', lineIds),
  ]);
  const sentQty = new Map(sent.map((s) => [s.id, s.sent_qty]));
  const out: TimedLine[] = [];
  for (const { k, lines } of timed) {
    lines.forEach((l, lineNo) => {
      if (typeof l.mins !== 'number' || l.cancelled) return;
      // The dish was taken off the order after it was sent (cancel KOT): not timed.
      if (typeof l.lineId === 'string' && !(sentQty.get(l.lineId) ?? 0)) return;
      const s = served.find((r) => r.kot_id === k.id && r.line_no === lineNo);
      out.push({
        kotId: k.id, kotNo: k.kot_no, orderId: k.order_id, place: k.place, station: k.station, lineNo,
        name: String(l.name), qty: Number(l.qty), options: Array.isArray(l.options) ? (l.options as string[]) : [], remark: typeof l.remark === 'string' ? l.remark : null,
        mins: l.mins, sentAt: k.printed_at, dueAt: k.printed_at + l.mins * MIN, shiftDay: k.shift_day, orderOpen: !!k.running,
        servedId: s?.id ?? null, firstAt: s?.first_at ?? null, servedAt: s?.served_at ?? null, batch: s?.batch ?? null,
        by: s ? (s.staff_id ? s.staff_name ?? 'Manager' : s.server_name ?? 'Server') : null, byManager: !!s?.staff_id, photo: !!s?.photo_at,
        undoneAt: s?.undone_at ?? null, undoneBy: s?.undone_by ?? null, undoReason: s?.undo_reason ?? null,
      });
    });
  }
  return out;
}

/** Waiting: not marked served now. */
export const isWaiting = (l: TimedLine) => l.servedAt === null;
/** Minutes late (rounded up), from the first time it was marked served; 0 when on time. */
export const lateMins = (l: TimedLine) => (l.firstAt !== null && l.firstAt > l.dueAt ? Math.ceil((l.firstAt - l.dueAt) / MIN) : 0);
/** A waiting line's state now: 'ok', 'soon' (amber) or 'late' (red), and minutes left (negative: late by). */
export function waitState(l: TimedLine, t: number): { state: 'ok' | 'soon' | 'late'; leftMins: number } {
  const left = Math.floor((l.dueAt - t) / MIN);
  if (t > l.dueAt) return { state: 'late', leftMins: -Math.ceil((t - l.dueAt) / MIN) };
  return { state: t - l.sentAt >= SOON * l.mins * MIN ? 'soon' : 'ok', leftMins: left };
}

/** A line for the screens (no internal ids beyond what a tap needs). */
export function lineOut(l: TimedLine, t: number) {
  const w = isWaiting(l) ? waitState(l, t) : null;
  return {
    kotId: l.kotId, kotNo: l.kotNo, lineNo: l.lineNo, orderId: l.orderId, place: l.place, station: l.station, name: l.name, qty: l.qty, options: l.options, remark: l.remark,
    mins: l.mins, sentAt: l.sentAt, dueAt: l.dueAt, servedId: l.servedId, servedAt: l.servedAt, firstAt: l.firstAt, by: l.by, byManager: l.byManager, photo: l.photo, batch: l.batch,
    state: w ? w.state : lateMins(l) > 0 ? 'served_late' : 'served', leftMins: w?.leftMins ?? null, lateMins: l.servedAt !== null ? lateMins(l) : null,
  };
}

/** Running KOTs as tiles: every timed line of each KOT that still has one waiting, most late first. */
export function kotTiles(lines: TimedLine[], t: number) {
  const byKot = new Map<string, TimedLine[]>();
  for (const l of lines) byKot.set(l.kotId, [...(byKot.get(l.kotId) ?? []), l]);
  return [...byKot.values()].filter((ls) => ls.some(isWaiting)).map((ls) => {
    const items = ls.map((l) => lineOut(l, t));
    const waiting = items.filter((i) => i.servedAt === null);
    const worst = waiting.reduce((a, b) => ((b.leftMins ?? 0) < (a.leftMins ?? 0) ? b : a));
    return { kotId: ls[0].kotId, kotNo: ls[0].kotNo, orderId: ls[0].orderId, place: ls[0].place, station: ls[0].station, sentAt: ls[0].sentAt,
      state: worst.state, leftMins: worst.leftMins, items };
  }).sort((a, b) => (a.leftMins ?? 0) - (b.leftMins ?? 0) || a.sentAt - b.sentAt);
}

const istHour = (ms: number) => new Date(ms + IST_OFFSET_MS).getUTCHours();
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/**
 * The numbers for the Daily check card and the Serving time report. A line never marked is "not marked" once its order is
 * closed; while the order still runs it is "waiting" (the shift is not over). On time is out of the lines marked.
 */
export function servingSummary(lines: TimedLine[]) {
  const marked = lines.filter((l) => l.firstAt !== null);
  const late = marked.filter((l) => lateMins(l) > 0);
  const notMarked = lines.filter((l) => l.firstAt === null && !l.orderOpen);
  const waiting = lines.filter((l) => l.firstAt === null && l.orderOpen);
  const group = <K extends string>(key: (l: TimedLine) => K) => {
    const m = new Map<K, TimedLine[]>();
    for (const l of lines) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
    return [...m].map(([k, ls]) => {
      const mk = ls.filter((l) => l.firstAt !== null);
      const lt = mk.filter((l) => lateMins(l) > 0);
      return { key: k, timed: ls.length, marked: mk.length, late: lt.length, notMarked: ls.filter((l) => l.firstAt === null && !l.orderOpen).length,
        avgMins: avg(mk.map((l) => (l.firstAt! - l.sentAt) / MIN)), avgLateMins: avg(lt.map(lateMins)), setMins: ls[ls.length - 1].mins };
    });
  };
  return {
    timed: lines.length, marked: marked.length, onTime: marked.length - late.length, late: late.length, notMarked: notMarked.length, waiting: waiting.length,
    avgLateMins: avg(late.map(lateMins)),
    worst: [...late].sort((a, b) => lateMins(b) - lateMins(a)).slice(0, 3).map((l) => ({ place: l.place, name: l.name, qty: l.qty, lateMins: lateMins(l),
      servedAt: l.firstAt, by: l.by, batch: l.photo ? l.batch : null })),
    byItem: group((l) => l.name).sort((a, b) => b.late - a.late || b.timed - a.timed),
    byDay: group((l) => l.shiftDay).sort((a, b) => a.key.localeCompare(b.key)),
    byHour: group((l) => String(istHour(l.sentAt)).padStart(2, '0')).sort((a, b) => a.key.localeCompare(b.key)),
    byServer: group((l) => (l.firstAt === null ? (l.orderOpen ? 'Still waiting' : 'Not marked') : l.by ?? 'Unknown')).sort((a, b) => b.marked - a.marked),
  };
}
