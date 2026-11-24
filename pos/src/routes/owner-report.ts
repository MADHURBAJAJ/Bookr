// The Daily check for the owner, each morning (25 Nov 2026). The WhatsApp listener, holding a key (Worker secret
// REPORT_KEYS), asks for a link to the last closed shift's Daily check. The link shows that one shift only, read-only,
// and stops working after a day; it is signed with the same key, so nothing is stored. The listener opens it in a hidden
// browser, saves it as a PDF and sends it to the owner with the caption made here.
import { Hono } from 'hono';
import { all } from '../../../src/db';
import { fail } from '../../../src/http';
import type { AppEnv, Env } from '../types';
import { clock, loadBusiness } from '../util';
import { dailyCheckData } from './reports';

export const ownerReportRoutes = new Hono<AppEnv>();
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const rs = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;

const keyOf = (env: Env, bid: string): string | null => {
  try {
    const k = JSON.parse(env.REPORT_KEYS ?? '{}')[bid];
    return typeof k === 'string' && k.length >= 24 ? k : null;
  } catch { return null; }
};
const enc = new TextEncoder();
async function sign(key: string, text: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Same length and same bytes, compared without stopping early. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** The day's money not received, in the same five parts as the Daily check card. */
function notPaid(d: Awaited<ReturnType<typeof dailyCheckData>>, events: { kind: string; amountPaise: number | null }[]) {
  const sum = (xs: { amountPaise: number | null }[]) => xs.reduce((t, x) => t + (x.amountPaise ?? 0), 0);
  return sum(events.filter((e) => e.kind === 'kot_cancel' || e.kind === 'comp'))
    + (d.voidedNotRebilled as { totalPaise: number }[]).reduce((t, b) => t + b.totalPaise, 0)
    + d.unpaid.filter((o) => o.old).reduce((t, o) => t + o.sentPaise, 0);
}

// The link, for the listener: { businessId, key, day? } → { url, day, caption }. Without a day: the last closed shift.
ownerReportRoutes.post('/report/link', async (c) => {
  let data: Record<string, unknown> = {};
  try { data = await c.req.json(); } catch { /* none */ }
  const bid = typeof data.businessId === 'string' ? data.businessId : '';
  const key = keyOf(c.env, bid);
  if (!key || typeof data.key !== 'string' || !same(await sign(key, 'check'), await sign(data.key, 'check'))) fail(403, 'Not allowed.');
  const b = await loadBusiness(c.env.DB, bid);
  const last = addDays(clock(b).shiftDay, -1);
  const day = isDay(data.day) && data.day <= last ? data.day : last;
  const exp = Date.now() + DAY;
  const sig = await sign(key, `${bid}|${day}|${exp}`);
  const origin = new URL(c.req.url).origin;
  const d = await dailyCheckData(c.env.DB, b, bid, day);
  const events = await all<{ kind: string; amountPaise: number | null }>(c.env.DB, 'SELECT kind, amount_paise AS amountPaise FROM pos_events WHERE business_id = ? AND shift_day = ?', bid, day);
  const cash = d.shiftClose && !d.shiftClose.countedAt ? 'cash not counted' : d.shiftClose ? (d.shiftClose.differencePaise === 0 ? 'cash matched'
    : `cash ${d.shiftClose.differencePaise > 0 ? 'over' : 'short'} ${rs(Math.abs(d.shiftClose.differencePaise))}`) : 'shift not closed';
  const np = notPaid(d, events);
  const name = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const caption = `${b.name} · Daily check ${name}\nNet sales ${rs(d.sales.netPaise)} · ${cash}${np ? ` · not paid for ${rs(np)}` : ''}`;
  return c.json({ url: `${origin}/report.html#${encodeURIComponent(bid)}.${day}.${exp}.${sig}`, day, caption });
});

// The page's data, for the link above only: that shift, read-only, until the link expires.
ownerReportRoutes.get('/report/data', async (c) => {
  const bid = c.req.query('b') ?? '';
  const day = c.req.query('d');
  const exp = Number(c.req.query('e'));
  const key = keyOf(c.env, bid);
  if (!key || !isDay(day) || !Number.isFinite(exp) || exp < Date.now() || !same(c.req.query('s') ?? '', await sign(key, `${bid}|${day}|${exp}`))) {
    fail(403, 'This link has expired or is not valid.');
  }
  const b = await loadBusiness(c.env.DB, bid);
  const [d, events] = await Promise.all([dailyCheckData(c.env.DB, b, bid, day!),
    all(c.env.DB, `SELECT e.kind, e.ref, e.amount_paise AS amountPaise, e.reason, e.detail, s.name AS byName, e.at
      FROM pos_events e LEFT JOIN staff s ON s.id = e.by_staff WHERE e.business_id = ? AND e.shift_day = ? ORDER BY e.at DESC, e.id DESC`, bid, day)]);
  return c.json({ business: b.name, shiftStartHour: b.shift_start_hour, tabAgeDays: b.tab_age_days, d, events });
});
