/**
 * Per-request memory for reads (19 Nov 2026). A GET request gets its own handle on the database; the same read asked
 * twice in that request (a shift's cash check, its register and software lines) is fetched once. D1 answers one query
 * at a time, so the Reports page's bank and cash checks were waiting on the same questions two or three times. Writes
 * (POST and the rest) keep the plain handle, so nothing is ever remembered across a change.
 */
import type { DB } from './db';

const store = new WeakMap<object, Map<string, Promise<unknown>>>();

const READ = /^\s*(SELECT|WITH)\b/i;
const WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

/**
 * A handle on the database for one read-only request, whose reads may be remembered. The same SELECT with the same values
 * is answered once; each caller gets its own copy of the list, so sorting one does not reorder another's.
 */
export function readScope(db: DB): DB {
  // Already one (the parts of a combined request share it).
  if (store.has(db)) return db;
  const answers = new Map<string, Promise<D1Result>>();
  const t = { queries: 0, ms: 0 };
  const timed = (p: Promise<D1Result>) => p.then((r) => { t.queries++; t.ms += r.meta?.duration ?? 0; return r; });
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement, q: string, values: unknown[]): D1PreparedStatement => {
    const read = READ.test(q) && !WRITE.test(q);
    const once = <T>(kind: string, f: () => Promise<T>): Promise<T> => {
      if (!read) return f();
      const key = `${kind}\u0000${q}\u0000${JSON.stringify(values)}`;
      let p = answers.get(key) as Promise<T> | undefined;
      if (!p) { p = f(); answers.set(key, p as never); p.catch(() => answers.delete(key)); }
      return p;
    };
    const out = {
      bind: (...v: unknown[]) => wrap(st.bind(...v), q, v),
      // first() read through all(), the same rows (D1's first adds no LIMIT), so its time is counted too.
      first: (col?: string) => once('all', () => timed(st.all())).then((r) => { const row = r.results[0] as Record<string, unknown> | undefined;
        return (row === undefined ? null : col === undefined ? { ...row } : row[col] ?? null) as never; }),
      all: () => once('all', () => timed(st.all())).then((r) => ({ ...r, results: [...r.results] })),
      raw: (o?: { columnNames?: boolean }) => st.raw(o as never),
      run: () => st.run(),
    } as unknown as D1PreparedStatement;
    inner.set(out as object, st);
    return out;
  };
  const scoped = {
    prepare: (q: string) => wrap(db.prepare(q), q, []),
    batch: (s: D1PreparedStatement[]) => db.batch(s.map((x) => inner.get(x as object) ?? x)).then((rs) => { t.queries += rs.length; t.ms += rs.reduce((a, r) => a + (r.meta?.duration ?? 0), 0); return rs; }),
    exec: (q: string) => db.exec(q),
    dump: () => db.dump(),
    withSession: (...a: unknown[]) => (db as unknown as { withSession: (...a: unknown[]) => unknown }).withSession(...a),
  } as unknown as DB;
  store.set(scoped, new Map());
  timings.set(scoped, t);
  return scoped;
}

const timings = new WeakMap<object, { queries: number; ms: number }>();
/** How many reads a read-only request made and the database's time on them (for a Server-Timing header). */
export const readTiming = (db: DB) => timings.get(db) ?? null;

/** The read's answer, fetched once per read-only request; outside one, simply fetched. */
export function remember<T>(db: DB, key: string, read: () => Promise<T>): Promise<T> {
  const m = store.get(db);
  if (!m) return read();
  let p = m.get(key) as Promise<T> | undefined;
  if (!p) { p = read(); m.set(key, p); p.catch(() => m.delete(key)); }
  return p;
}
