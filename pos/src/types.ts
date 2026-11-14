import type { Role } from './permissions';

export interface Env {
  DB: D1Database;
  /** Worker secret: needed once, to create a business and its Owner (POST /api/setup). Never sent to the browser. */
  POS_SETUP_TOKEN?: string;
  /** Bookr's address, e.g. https://bookr.example.com (a setting, not a secret). */
  BOOKR_URL?: string;
  /** Worker secret: the key Bookr gave each business, JSON {"<business id>": "<key>"}. Never sent to the browser. */
  BOOKR_KEYS?: string;
  ASSETS?: { fetch: typeof fetch };
}

export interface Staff {
  id: string;
  name: string;
  role: Role;
  businessId: string;
}

export interface Vars {
  staff: Staff;
  /** The business row, loaded with the session (one database trip instead of two). */
  business: import('./util').Business;
  sessionId: string;
  deviceId: string | null;
  businessId: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
