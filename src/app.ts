import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import { requireUser } from './auth';
import { authRoutes } from './routes/auth';
import { businessRoutes } from './routes/businesses';
import { memberRoutes, inviteRoutes } from './routes/members';
import { bookRoutes } from './routes/books';
import { salesRoutes } from './routes/sales';
import { captureRoutes } from './routes/capture';

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

app.route('/', authRoutes);
app.route('/', inviteRoutes);
app.use('/businesses', requireUser);
app.use('/businesses/*', requireUser);
app.route('/', businessRoutes);
app.route('/', memberRoutes);
app.route('/', bookRoutes);
app.route('/', salesRoutes);
app.route('/', captureRoutes);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong.' }, 500);
});
