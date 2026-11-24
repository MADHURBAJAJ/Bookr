import { app } from './app';
import { sendAll } from './sync';
import { receiveMail } from './mail';
import { autoCloseAll } from './routes/shifts';
import type { Env } from './types';

// The POS Worker: /api/* here, the counter screens as static assets (see pos/wrangler.jsonc).
// Every 5 minutes (cron) it closes a shift nobody closed at the shift's hour, and sends Bookr whatever is still waiting.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  // Booking mails forwarded from Gmail (Cloudflare Email Routing → here).
  async email(message: ForwardableEmailMessage, env: Env) {
    await receiveMail(message, env);
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Also closes the shift just ended at the shift's hour if nobody did (24 Nov 2026).
    ctx.waitUntil(autoCloseAll(env.DB).catch((e) => console.error('auto close', e)).then(() => sendAll(env)));
  },
};
