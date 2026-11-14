import type { Role } from './permissions';

export interface Env {
  DB: D1Database;
  /** Worker secret: needed once, to create a business and its Owner (POST /api/setup). Never sent to the browser. */
  POS_SETUP_TOKEN?: string;
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
  sessionId: string;
  deviceId: string | null;
  businessId: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
