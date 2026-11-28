import { app } from './app';
import { sendAll } from './sync';
import { buildHistory, receiveMail } from './mail';
import { autoCloseAll } from './routes/shifts';
import type { Env } from './types';

// The POS Worker: /api/* here, the counter screens as static assets (see pos/wrangler.jsonc).
// Every 5 minutes (cron) it closes a shift nobody closed at the shift's hour, and sends Bookr whatever is still waiting.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // A server's own address (28 Nov 2026): the POS page, carrying the Serve app's details from the start, so the phone
    // installs "Serve" (opening this page) rather than the POS. Nothing about the business is in it but its id.
    // The Bar Count app (28 Nov 2026) the same way, at /count/<business id>.
    const m = /^\/(serve|count)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(new URL(request.url).pathname);
    if (m && env.ASSETS) {
      const which = m[1].toLowerCase(); const name = which === 'serve' ? 'Serve' : 'Bar Count';
      const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
      const html = (await page.text())
        .replace('<link rel="manifest" href="/manifest.webmanifest">', `<link rel="manifest" href="/api/${which}-manifest/${m[2].toLowerCase()}">`)
        .replace('<title>Bookr POS</title>', `<title>${name}</title><meta name="apple-mobile-web-app-title" content="${name}"><meta name="apple-mobile-web-app-capable" content="yes">`);
      const h = new Headers(page.headers);
      h.set('Content-Type', 'text/html; charset=utf-8'); h.set('Cache-Control', 'no-cache'); h.delete('Content-Length');
      return new Response(html, { status: 200, headers: h });
    }
    if (/^\/(serve|count)\//.test(new URL(request.url).pathname)) return new Response('Not found', { status: 404 });
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
