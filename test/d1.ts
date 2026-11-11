// A fresh local D1 (the same engine wrangler dev uses, via wrangler's platform proxy) with the
// migrations applied. Each test file gets its own throwaway copy.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

// Splits a migration file into statements. Trigger bodies (BEGIN ... END;) stay whole.
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inTrigger = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/--.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (!current.length && /^CREATE TRIGGER/i.test(line.trim())) inTrigger = true;
    current.push(line);
    const done = inTrigger ? /^END;$/i.test(line.trim()) : line.endsWith(';');
    if (done) {
      out.push(current.join('\n'));
      current = [];
      inTrigger = false;
    }
  }
  if (current.length) out.push(current.join('\n'));
  return out;
}

export async function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), 'bookr-d1-'));
  const proxy = await getPlatformProxy<{ DB: D1Database; UPLOADS: R2Bucket }>({ persist: { path: dir } });
  const db = proxy.env.DB;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const statements = splitStatements(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  const dispose = async () => {
    await proxy.dispose();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db: steady(db), uploads: proxy.env.UPLOADS, dispose };
}

// The local D1 runs in a separate workerd process reached over a socket. On a busy machine (the full suite on 4 cores) that
// connection is now and then reset mid-request ("fetch failed", ECONNRESET), failing a test that is not wrong. A read is
// asked again (up to 3 tries); a write never is, since it may already have run.
const READ = /^\s*(SELECT|WITH)\b/i;
const WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const dropped = (e: unknown) => e instanceof Error && (e.message === 'fetch failed' || /ECONNRESET|socket hang up/.test(String((e as { cause?: unknown }).cause ?? '')));

function steady(db: D1Database): D1Database {
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement, query: string): D1PreparedStatement => {
    const read = READ.test(query) && !WRITE.test(query);
    const retry = <T>(f: () => Promise<T>) => async (): Promise<T> => {
      for (let i = 1; ; i++) {
        try { return await f(); } catch (e) { if (!read || i >= 3 || !dropped(e)) throw e; await new Promise((r) => setTimeout(r, 200 * i)); }
      }
    };
    const out = {
      bind: (...v: unknown[]) => wrap(st.bind(...v), query),
      first: (col?: string) => retry(() => (col === undefined ? st.first() : st.first(col)))(),
      all: () => retry(() => st.all())(),
      raw: (o?: { columnNames?: boolean }) => retry(() => st.raw(o as never))(),
      run: () => retry(() => st.run())(),
    } as unknown as D1PreparedStatement;
    inner.set(out as object, st);
    return out;
  };
  return {
    prepare: (q: string) => wrap(db.prepare(q), q),
    batch: (sts: D1PreparedStatement[]) => db.batch(sts.map((x) => inner.get(x as object) ?? x)),
    exec: (q: string) => db.exec(q),
    dump: () => db.dump(),
    withSession: (...a: unknown[]) => (db as unknown as { withSession: (...a: unknown[]) => unknown }).withSession(...a),
  } as unknown as D1Database;
}
