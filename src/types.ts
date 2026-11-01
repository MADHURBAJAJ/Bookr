import type { Sql } from './db';
import type { Role } from './permissions';

export interface Env {
  HYPERDRIVE: { connectionString: string };
  ASSETS?: { fetch: typeof fetch };
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface Vars {
  sql: Sql;
  user: SessionUser;
  sessionId: string;
  businessId: string;
  role: Role;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
