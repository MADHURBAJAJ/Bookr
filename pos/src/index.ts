import { app, staffIcon, staffLabel } from './app';
import { sendAll } from './sync';
import { buildHistory, receiveMail } from './mail';
import { autoCloseAll } from './routes/shifts';
import type { Env } from './types';

// The POS Worker: /api/* here, the counter screens as static assets (see pos/wrangler.jsonc).
// Every 5 minutes (cron) it closes a shift nobody closed at the shift's hour, and sends Bookr whatever is still waiting.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // The Staff app (28 Nov 2026): one phone app for every job, at /staff/<business id>. The older Serve and Bar Count
    // addresses (/serve/<id>, /count/<id>) open the same app, so phones that added them keep working. The page is the POS
    // page carrying the app's own name and icon from the start, so the phone installs "XOXO Staff", not the POS.
    const m = /^\/(staff|serve|count)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(new URL(request.url).pathname);
    if (m && env.ASSETS) {
      const which = m[1].toLowerCase(); const bid = m[2].toLowerCase();
      const b = await env.DB.prepare("SELECT name FROM businesses WHERE id = ? AND status = 'active'").bind(bid).first<{ name: string }>();
      if (!b) return new Response('Not found', { status: 404 });
      const label = staffLabel(b.name); const name = `${label} Staff`; const icon = `${staffIcon(label)}-192.png`;
      const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
      const html = (await page.text())
        .replace('<link rel="manifest" href="/manifest.webmanifest">', `<link rel="manifest" href="/api/${which}-manifest/${bid}">`)
        .replace('<link rel="icon" href="/icon-192.png">', `<link rel="icon" href="${icon}">`)
        .replace('<link rel="apple-touch-icon" href="/icon-192.png">', `<link rel="apple-touch-icon" href="${icon}">`)
        .replace('<title>Bookr POS</title>', `<title>${name}</title><meta name="apple-mobile-web-app-title" content="${name}"><meta name="apple-mobile-web-app-capable" content="yes">`);
      const h = new Headers(page.headers);
      h.set('Content-Type', 'text/html; charset=utf-8'); h.set('Cache-Control', 'no-cache'); h.delete('Content-Length');
      return new Response(html, { status: 200, headers: h });
    }
    if (/^\/(staff|serve|count)\//.test(new URL(request.url).pathname)) return new Response('Not found', { status: 404 });
    return app.fetch(request, env, ctx);
  },
  // Booking mails forwarded from Gmail (Cloudflare Email Routing → here).
  async email(message: ForwardableEmailMessage, env: Env) {
    await receiveMail(message, env);
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Also closes the shift just ended at the shift's hour if nobody did (24 Nov 2026).
    ctx.waitUntil(autoCloseAll(env.DB).catch((e) => console.error('auto close', e)).then(() => sendAll(env))
      // Each booking's mail history (26 Nov 2026): the mails kept before it began are added a batch at a time.
      .then(() => buildHistory(env)).catch((e) => console.error('mail history', e)));
  },
};
