import type { Role } from './permissions';

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
  /** Worker secret. Never sent to the browser or logged. */
  ANTHROPIC_API_KEY?: string;
  /** Worker secret: Google service account key (JSON), read-only Sheets access. Never sent to the browser or logged. */
  GOOGLE_SERVICE_ACCOUNT?: string;
  /** Mail addresses Bookr receives at, each to its business: JSON {"cards@example.com": "<business id>"}. */
  MAIL_ROUTES?: string;
  /** Senders whose mail is read (comma-separated addresses or @domains). Others are turned away. Empty: all are kept. */
  CARD_MAIL_FROM?: string;
  /** The Owner's Gmail script (Apps Script web app) that saves card mails into the Drive folder; Sync calls it first. Secret. */
  CARD_SCRIPT_URL?: string;
  /** The code the script checks before it runs. Secret. */
  CARD_SCRIPT_TOKEN?: string;
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
