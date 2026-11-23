import { readScope, readTiming } from './memo';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import { requireUser } from './auth';
import { authRoutes } from './routes/auth';
import { businessRoutes } from './routes/businesses';
import { memberRoutes, inviteRoutes } from './routes/members';
import { bookRoutes } from './routes/books';
import { salesRoutes } from './routes/sales';
import { complimentaryRoutes } from './routes/complimentary';
import { captureRoutes } from './routes/capture';
import { ocrRoutes } from './routes/ocr';
import { bankRoutes } from './routes/bank';
import { cardRoutes } from './routes/cards';
import { dayRoutes } from './routes/day';
import { changesRoutes } from './routes/changes';
import { moneyOutRoutes } from './routes/moneyout';
import { homeRoutes } from './routes/home';
import { expenseRoutes } from './routes/expenses';
import { fundsRoutes } from './routes/funds';
import { cashBookRoutes } from './routes/cashbook';
import { feeRoutes } from './routes/fees';
import { directorRoutes } from './routes/directors';

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // Changes must be same-origin JSON. A cross-site form cannot send application/json without a preflight.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) throw new HTTPException(403, { message: 'Cross-site request refused.' });
    // JSON, or a raw photo or PDF body for uploads. None of these can be sent cross-site without a preflight.
    const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    const upload = c.req.method === 'POST' && /^\/api\/businesses\/[^/]+\/uploads$/.test(c.req.path);
    if (type !== 'application/json' && !(upload && ['image/jpeg', 'image/png', 'application/pdf'].includes(type))) {
      throw new HTTPException(415, { message: 'Send JSON.' });
    }
  }
  await next();
});

// A read-only request gets its own handle, so a read asked twice in it is fetched once (19 Nov 2026).
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' || !c.env?.DB) return next();
  const db = readScope(c.env.DB);
  c.env = { ...c.env, DB: db };
  const start = Date.now();
  await next();
  // Counts and times only (no query text), to see on live where a slow page spends its time.
  const tm = readTiming(db);
  if (tm) try { c.res.headers.set('Server-Timing', `db;desc="${tm.queries} reads";dur=${tm.ms.toFixed(1)}, total;dur=${Date.now() - start}`); } catch { /* a response whose headers cannot change */ }
});

// Several reads in one request (19 Nov 2026): the Shift page's parts, answered together. Each part is run as its own
// request with the same sign-in, so its role is checked as usual; they share one database handle, so a question two
// parts ask (the sign-in, a shift's cash check, its bills) is asked once. Only GETs under a business, at most 12.
app.get('/many', requireUser, async (c) => {
  const paths = new URL(c.req.url).searchParams.getAll('p');
  if (!paths.length || paths.length > 12 || paths.some((p) => !/^\/businesses\/[0-9a-f-]{36}(\/[A-Za-z0-9_\-./?=&%:]*)?$/.test(p) || p.includes('..'))) {
    throw new HTTPException(400, { message: 'Unknown request.' });
  }
  const headers = new Headers();
  for (const k of ['Cookie', 'Authorization', 'User-Agent']) { const v = c.req.header(k); if (v) headers.set(k, v); }
  let ctx: Parameters<typeof app.fetch>[2];
  try { ctx = c.executionCtx as never; } catch { ctx = undefined; }
  const results = await Promise.all(paths.map(async (p) => {
    const res = await app.fetch(new Request(new URL(`/api${p}`, c.req.url), { headers }), c.env, ctx);
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body };
  }));
  return c.json({ results });
});

app.route('/', authRoutes);
app.route('/', inviteRoutes);
app.use('/businesses', requireUser);
app.use('/businesses/*', requireUser);
app.route('/', businessRoutes);
app.route('/', memberRoutes);
app.route('/', bookRoutes);
app.route('/', salesRoutes);
app.route('/', complimentaryRoutes);
app.route('/', captureRoutes);
app.route('/', ocrRoutes);
app.route('/', bankRoutes);
app.route('/', cardRoutes);
app.route('/', dayRoutes);
app.route('/', changesRoutes);
app.route('/', moneyOutRoutes);
app.route('/', homeRoutes);
app.route('/', expenseRoutes);
app.route('/', fundsRoutes);
app.route('/', cashBookRoutes);
app.route('/', feeRoutes);
app.route('/', directorRoutes);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    const code = (err.cause as { code?: string } | undefined)?.code;
    return c.json({ error: err.message, ...(code ? { code } : {}) }, err.status);
  }
  console.error(err);
  return c.json({ error: 'Something went wrong.' }, 500);
});
