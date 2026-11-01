import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import { makeSql } from './db';
import { requireUser } from './auth';
import { authRoutes } from './routes/auth';
import { businessRoutes } from './routes/businesses';
import { memberRoutes, inviteRoutes } from './routes/members';
import { bookRoutes } from './routes/books';

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // Changes must be same-origin JSON. A cross-site form cannot send application/json without a preflight.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) throw new HTTPException(403, { message: 'Cross-site request refused.' });
    if (!(c.req.header('Content-Type') ?? '').startsWith('application/json')) {
      throw new HTTPException(415, { message: 'Send JSON.' });
    }
  }
  const sql = makeSql(c.env.HYPERDRIVE.connectionString);
  c.set('sql', sql);
  try {
    await next();
  } finally {
    const closing = sql.end({ timeout: 5 });
    try {
      c.executionCtx.waitUntil(closing);
    } catch {
      await closing; // no execution context outside Workers (tests)
    }
  }
});

app.route('/', authRoutes);
app.route('/', inviteRoutes);
app.use('/businesses', requireUser);
app.use('/businesses/*', requireUser);
app.route('/', businessRoutes);
app.route('/', memberRoutes);
app.route('/', bookRoutes);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong.' }, 500);
});
