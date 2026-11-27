import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import { authRoutes } from './routes/auth';
import { settingsRoutes } from './routes/settings';
import { orderRoutes } from './routes/orders';
import { settleRoutes } from './routes/settle';
import { shiftRoutes } from './routes/shifts';
import { drawerRoutes } from './routes/drawers';
import { reportRoutes } from './routes/reports';
import { ownerReportRoutes } from './routes/owner-report';
import { creditRoutes } from './routes/credit';
import { stockRoutes } from './routes/stock';
import { stockCountRoutes } from './routes/stock-counts';
import { menuUploadRoutes } from './routes/menu-upload';
import { stationRoutes } from './routes/station';
import { adminRoutes } from './routes/admin';
import { eventRoutes } from './routes/events';
import { inventoryRoutes } from './routes/inventory';
import { bookingRoutes } from './routes/bookings';
import { frontDeskRoutes } from './routes/frontdesk';
import { roomDeskRoutes } from './routes/roomdesk';
import { proofRoutes } from './routes/proof';
import { offlineRoutes } from './routes/offline';

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

// The Bookr POS Windows app's installer and its update files (22 Nov 2026), kept under desktop/ in the R2 bucket and open
// to anyone: they hold no password or key. Only plain file names; nothing else in the bucket is reachable from here.
app.get('/desktop/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(file) || !/\.(exe|yml|blockmap)$/.test(file) || !c.env.BILLS) return c.json({ error: 'Not found.' }, 404);
  const obj = await c.env.BILLS.get(`desktop/${file}`);
  if (!obj) return c.json({ error: 'Not found.' }, 404);
  const type = file.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream';
  return new Response(obj.body, { headers: { 'Content-Type': type, 'Content-Length': String(obj.size), 'Cache-Control': file.endsWith('.yml') ? 'no-store' : 'public, max-age=86400',
    ...(file.endsWith('.exe') ? { 'Content-Disposition': `attachment; filename="${file}"` } : {}) } });
});

app.route('/', authRoutes);
app.route('/', settingsRoutes);
app.route('/', orderRoutes);
app.route('/', settleRoutes);
app.route('/', shiftRoutes);
app.route('/', drawerRoutes);
app.route('/', reportRoutes);
app.route('/', ownerReportRoutes);
app.route('/', creditRoutes);
app.route('/', stockRoutes);
app.route('/', stockCountRoutes);
app.route('/', menuUploadRoutes);
app.route('/', stationRoutes);
app.route('/', eventRoutes);
app.route('/', inventoryRoutes);
app.route('/', bookingRoutes);
app.route('/', frontDeskRoutes);
app.route('/', roomDeskRoutes);
app.route('/', proofRoutes);
app.route('/', offlineRoutes);
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
