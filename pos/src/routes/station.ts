// A station's own device (approved 19 Nov 2026): the kitchen or bar tablet or PC, set up by the Owner for one station. It
// signs in with its device cookie alone, sees only its station's KOTs, prints those meant to print there, and on a screen
// marks them started and ready. It can change nothing else.
import { Hono, type Context } from 'hono';
import { all, now, one, stmt } from '../../../src/db';
import { fail } from '../../../src/http';
import { currentDevice } from '../auth';
import type { AppEnv } from '../types';

export const stationRoutes = new Hono<AppEnv>();
const DAY = 86_400_000;

async function stationDevice(c: Context<AppEnv>) {
  const d = await currentDevice(c);
  if (!d?.station_id) fail(401, 'This device is not set up for a station. The Owner sets it up in Settings → Stations.');
  const st = await one<{ id: string; name: string; how: string; copies: number; business: string }>(c.env.DB,
    "SELECT s.id, s.name, s.how, s.copies, b.name AS business FROM stations s JOIN businesses b ON b.id = s.business_id WHERE s.id = ? AND s.active = 1 AND b.status = 'active'", d.station_id);
  if (!st) fail(401, 'This station is no longer in use.');
  return { device: d, station: st };
}

// What the station has: tickets not yet ready (screen), and KOTs to print here. Asking also says the device is online.
stationRoutes.get('/station', async (c) => {
  const { device, station } = await stationDevice(c);
  const t = now();
  const [kots] = await Promise.all([
    all<{ id: string; kot_no: number; place: string; lines: string; by: string | null; at: number; status: string; print_at: string; printed: number | null }>(c.env.DB,
      `SELECT k.id, k.kot_no, o.place, k.lines, st.name AS by, k.printed_at AS at, k.status, k.print_at, k.station_printed_at AS printed
       FROM kots k JOIN orders o ON o.id = k.order_id LEFT JOIN staff st ON st.id = k.by_staff
       WHERE k.station_id = ? AND k.printed_at > ? AND (k.status <> 'ready' OR (k.print_at = 'station' AND k.station_printed_at IS NULL))
       ORDER BY k.kot_no`, station.id, t - DAY),
    stmt(c.env.DB, 'UPDATE devices SET last_seen_at = ? WHERE id = ?', t, device.id).run(),
  ]);
  return c.json({
    station: { name: station.name, how: station.how, copies: station.copies }, business: station.business, device: device.name, now: t,
    kots: kots.map((k) => ({ id: k.id, kotNo: k.kot_no, place: k.place, lines: JSON.parse(k.lines), by: k.by, at: k.at, status: k.status,
      toPrint: k.print_at === 'station' && !k.printed })),
  });
});

async function kot(c: Context<AppEnv>, stationId: string) {
  const k = await one<{ id: string; status: string }>(c.env.DB, 'SELECT id, status FROM kots WHERE id = ? AND station_id = ?', c.req.param('id'), stationId);
  if (!k) fail(404, 'KOT not found at this station.');
  return k;
}
stationRoutes.post('/station/kots/:id/printed', async (c) => {
  const { station } = await stationDevice(c);
  const k = await kot(c, station.id);
  await stmt(c.env.DB, 'UPDATE kots SET station_printed_at = coalesce(station_printed_at, ?) WHERE id = ?', now(), k.id).run();
  return c.json({ ok: true });
});
stationRoutes.post('/station/kots/:id/start', async (c) => {
  const { station } = await stationDevice(c);
  const k = await kot(c, station.id);
  await stmt(c.env.DB, "UPDATE kots SET status = 'started', started_at = coalesce(started_at, ?) WHERE id = ? AND status = 'new'", now(), k.id).run();
  return c.json({ ok: true });
});
stationRoutes.post('/station/kots/:id/ready', async (c) => {
  const { station } = await stationDevice(c);
  const k = await kot(c, station.id);
  await stmt(c.env.DB, "UPDATE kots SET status = 'ready', ready_at = coalesce(ready_at, ?) WHERE id = ?", now(), k.id).run();
  return c.json({ ok: true });
});
