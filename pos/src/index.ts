import { app } from './app';
import { sendAll } from './sync';
import type { Env } from './types';

// The POS Worker: /api/* here, the counter screens as static assets (see pos/wrangler.jsonc).
// Every 5 minutes (cron) it sends Bookr whatever is still waiting in the outbox.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendAll(env));
  },
};
