import { app } from './app';
import { receiveMail } from './mail';
import { runReadQueue } from './routes/ocr';
import { runWaQueue } from './waRead';
import type { Env } from './types';

// /api/* is handled here (see run_worker_first in wrangler.jsonc); everything else is a static asset.
// Mail to Bookr's address (Cloudflare Email Routing, "Send to a Worker") arrives in email().
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  email(message: ForwardableEmailMessage, env: Env) {
    return receiveMail(message, env);
  },
  // Every minute (triggers.crons in wrangler.jsonc): read the pages still waiting in the reading queue,
  // and the WhatsApp files waiting to be read.
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReadQueue(env));
    ctx.waitUntil(runWaQueue(env).catch((e) => console.error('wa queue', e)));
  },
};
