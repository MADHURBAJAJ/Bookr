import { app } from './app';
import type { Env } from './types';

// /api/* is handled here (see run_worker_first in wrangler.jsonc); everything else is a static asset.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};
