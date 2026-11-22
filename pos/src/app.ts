import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import { authRoutes } from './routes/auth';
import { settingsRoutes } from './routes/settings';
import { orderRoutes } from './routes/orders';
import { settleRoutes } from './routes/settle';
import { shiftRoutes } from './routes/shifts';
import { reportRoutes } from './routes/reports';
import { creditRoutes } from './routes/credit';
import { stockRoutes } from './routes/stock';
import { menuUploadRoutes } from './routes/menu-upload';
import { stationRoutes } from './routes/station';
import { adminRoutes } from './routes/admin';
import { eventRoutes } from './routes/events';
import { inventoryRoutes } from './routes/inventory';

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // Changes must be same-origin JSON: a cross-site form cannot send application/json without a preflight.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) throw new HTTPException(403, { message: 'Cross-site request refused.' });
    // JSON, or a raw photo body for a supplier bill. Neither can be sent cross-site without a preflight.
    const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    const photo = c.req.method === 'POST' && /^\/api\/businesses\/[^/]+\/stock\/bills$/.test(c.req.path);
    const menuPage = c.req.method === 'POST' && /^\/api\/businesses\/[^/]+\/menu\/upload\/read$/.test(c.req.path);
    if (type !== 'application/json' && !(photo && ['image/jpeg', 'image/png'].includes(type))
      && !(menuPage && ['image/jpeg', 'image/png', 'application/pdf'].includes(type))) throw new HTTPException(415, { message: 'Send JSON.' });
  }
  await next();
});

app.route('/', authRoutes);
app.route('/', settingsRoutes);
app.route('/', orderRoutes);
app.route('/', settleRoutes);
app.route('/', shiftRoutes);
app.route('/', reportRoutes);
app.route('/', creditRoutes);
app.route('/', stockRoutes);
app.route('/', menuUploadRoutes);
app.route('/', stationRoutes);
app.route('/', eventRoutes);
app.route('/', inventoryRoutes);
app.route('/', adminRoutes);

app.notFound((c) => c.json({ error: 'Not found.' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    // A refusal may carry a code and other short facts for the screen (e.g. the name a phone is saved under).
    const extra = Object.fromEntries(Object.entries((err.cause ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string'));
    return c.json({ error: err.message, ...extra }, err.status);
  }
  console.error(err);
  return c.json({ error: 'Something went wrong.' }, 500);
});
