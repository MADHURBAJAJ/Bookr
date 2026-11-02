import type { Role } from './permissions';

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  /** Worker secret. Never sent to the browser or logged. */
  ANTHROPIC_API_KEY?: string;
  /** Worker settings (wrangler.jsonc vars). */
  CLAUDE_OCR_MODEL?: string;
  OCR_DAILY_PAGE_LIMIT?: string;
  OCR_MAX_PARALLEL?: string;
  ASSETS?: { fetch: typeof fetch };
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface Vars {
  user: SessionUser;
  sessionId: string;
  businessId: string;
  role: Role;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
