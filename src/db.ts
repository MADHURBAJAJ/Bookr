// Thin helpers over D1. D1 has no open transactions: anything that must be atomic is sent as one
// db.batch([...]), which commits or rolls back as a whole. Invariants that must hold whichever
// request runs first (last Owner, single-use invites) are database triggers.

export type DB = D1Database;

export function stmt(db: DB, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

export async function all<T = Record<string, unknown>>(db: DB, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await stmt(db, sql, ...params).all<T>()).results;
}

export async function one<T = Record<string, unknown>>(db: DB, sql: string, ...params: unknown[]): Promise<T | null> {
  return stmt(db, sql, ...params).first<T>();
}

export async function run(db: DB, sql: string, ...params: unknown[]): Promise<D1Result> {
  return stmt(db, sql, ...params).run();
}

export const newId = () => crypto.randomUUID();
export const now = () => Date.now();

function message(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
}

export const isUniqueViolation = (e: unknown) => message(e).includes('UNIQUE constraint failed');
export const isLastOwner = (e: unknown) => message(e).includes('last_owner');
export const isInviteUnusable = (e: unknown) => message(e).includes('invite_unusable');
