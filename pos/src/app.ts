import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import { authRoutes } from './routes/auth';
import { settingsRoutes } from './routes/settings';
import { orderRoutes } from './routes/orders';
import { settleRoutes } from './routes/settle';
import { shiftRoutes } from './routes/shifts';

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // Changes must be same-origin JSON: a cross-site form cannot send application/json without a preflight.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) throw new HTTPException(403, { message: 'Cross-site request refused.' });
    const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HTTPException(415, { message: 'Send JSON.' });
  }
  await next();
});

app.route('/', authRoutes);
app.route('/', settingsRoutes);
app.route('/', orderRoutes);
app.route('/', settleRoutes);
app.route('/', shiftRoutes);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong.' }, 500);
});
