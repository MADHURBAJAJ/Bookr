import type { Role } from './permissions';

export interface Env {
  DB: D1Database;
  UPLOADS: R2Bucket;
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
