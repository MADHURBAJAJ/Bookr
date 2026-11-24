// D1 and R2 stand-ins for the tests, in-process (24 Nov 2026). Node's built-in SQLite answers the same SQL as D1 (both are
// SQLite) without a workerd process and a socket per test file, so the suite no longer spends most of its time starting
// engines and waiting on round trips. Only the parts of the D1 and R2 APIs Bookr uses are here. D1_REAL=1 runs the tests on
// wrangler's local D1 instead (test/d1.ts), worth doing before a live deploy.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

type Row = Record<string, unknown>;

// D1 binds a whole number as an INTEGER and true/false as 1/0. node:sqlite binds every JS number as a REAL and refuses a
// boolean, so a whole number goes in as a BigInt (stored the same way D1 stores it: typeof() says integer, '5' not '5.0').
function toSql(v: unknown, i: number): unknown {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : v;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  // D1 says so at bind time too (undefined, objects, functions).
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${String(v)}' (parameter ${i + 1})`);
}

// A blob comes back from D1 as an array of byte values.
const fromSql = (v: unknown) => (v instanceof Uint8Array ? [...v] : v);
const plain = (r: Row): Row => {
  const o: Row = {};
  for (const k in r) o[k] = fromSql(r[k]);
  return o;
};

// D1's errors read "D1_ERROR: <SQLite's message>" with SQLite's own error as the cause.
function d1Error(e: unknown): Error {
  if (!(e instanceof Error) || e.message.startsWith('D1_')) return e as Error;
  return new Error(`D1_ERROR: ${e.message}`, { cause: e });
}

export function sqliteD1(path: string): { db: D1Database; close: () => void } {
  const sqlite = new DatabaseSync(path);
  // D1 always checks foreign keys. The file is a throwaway copy, so nothing needs to reach the disk.
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
  const cache = new Map<string, StatementSync>();
  const compiled = (q: string) => {
    let st = cache.get(q);
    if (!st) { st = sqlite.prepare(q); cache.set(q, st); }
    return st;
  };
  const counters = sqlite.prepare('SELECT total_changes() AS t, changes() AS c, last_insert_rowid() AS r');

  // Runs one statement and gives D1's result: { success, meta, results }.
  const execute = (q: string, values: unknown[]): D1Result<Row> => {
    const started = performance.now();
    const st = compiled(q);
    const before = Number((counters.get() as Row).t);
    let results: Row[];
    try {
      results = (st.all(...(values as never[])) as Row[]).map(plain);
    } catch (e) {
      throw d1Error(e);
    }
    const after = counters.get() as Row;
    const changed = Number(after.t) !== before;
    return {
      success: true,
      results,
      meta: {
        served_by: 'node:sqlite',
        duration: performance.now() - started,
        changes: changed ? Number(after.c) : 0,
        last_row_id: Number(after.r),
        changed_db: changed,
        size_after: 0,
        rows_read: results.length,
        rows_written: changed ? Number(after.c) : 0,
      },
    } as D1Result<Row>;
  };

  const rawRows = (q: string, values: unknown[], columnNames: boolean): unknown[][] => {
    const st = compiled(q);
    st.setReturnArrays(true);
    try {
      const rows = (st.all(...(values as never[])) as unknown as unknown[][]).map((r) => r.map(fromSql));
      return columnNames ? [st.columns().map((c) => c.name), ...rows] : rows;
    } catch (e) {
      throw d1Error(e);
    } finally {
      st.setReturnArrays(false);
    }
  };

  const BOUND = Symbol('bound');
  type Prepared = D1PreparedStatement & { [BOUND]: { q: string; values: unknown[] } };
  const statement = (q: string, values: unknown[]): Prepared => {
    const s = {
      [BOUND]: { q, values },
      bind: (...v: unknown[]) => {
        // D1 refuses a query with more than 100 bound values; SQLite would take thousands, hiding the mistake.
        if (v.length > 100) throw new Error('D1_ERROR: too many SQL variables');
        return statement(q, v.map(toSql));
      },
      first: async (col?: string) => {
        const row = execute(q, values).results[0];
        if (row === undefined) return null;
        if (col === undefined) return row;
        if (!(col in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`);
        return row[col];
      },
      all: async () => execute(q, values),
      run: async () => execute(q, values),
      raw: async (o?: { columnNames?: boolean }) => rawRows(q, values, o?.columnNames === true),
    };
    return s as unknown as Prepared;
  };

  const db = {
    prepare: (q: string) => statement(q, []),
    // All or nothing, as D1 does it.
    batch: async (list: D1PreparedStatement[]) => {
      const parts = list.map((s) => (s as Prepared)[BOUND]);
      if (parts.some((p) => !p)) throw new Error('D1 batch given a statement from another database');
      sqlite.exec('BEGIN');
      try {
        const out = parts.map((p) => execute(p.q, p.values));
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw d1Error(e);
      }
    },
    // D1's exec takes one statement per line.
    exec: async (q: string) => {
      const started = performance.now();
      const lines = q.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const l of lines) {
        try { sqlite.exec(l); } catch (e) { throw d1Error(e); }
      }
      return { count: lines.length, duration: performance.now() - started };
    },
    dump: async () => { throw new Error('dump() is not available on the test database'); },
    withSession: () => db,
  };
  return { db: db as unknown as D1Database, close: () => sqlite.close() };
}

/** An R2 bucket in memory, with the calls Bookr makes: put, get, head, delete and list. */
export function memoryR2(): R2Bucket {
  type Stored = { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string>; uploaded: Date; etag: string };
  const objects = new Map<string, Stored>();
  let n = 0;
  const toBytes = async (v: unknown): Promise<Uint8Array> => {
    if (v === null || v === undefined) return new Uint8Array();
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
    if (v instanceof ReadableStream) return new Uint8Array(await new Response(v).arrayBuffer());
    throw new Error('R2 put: unsupported value');
  };
  const head = (key: string, o: Stored) => ({
    key, version: o.etag, size: o.bytes.byteLength, etag: o.etag, httpEtag: `"${o.etag}"`, uploaded: o.uploaded,
    httpMetadata: o.httpMetadata ?? {}, customMetadata: o.customMetadata ?? {}, storageClass: 'Standard', checksums: {},
    writeHttpMetadata: (h: Headers) => { if (o.httpMetadata?.contentType) h.set('Content-Type', o.httpMetadata.contentType); },
  });
  const body = (key: string, o: Stored) => {
    const copy = () => o.bytes.slice();
    return {
      ...head(key, o),
      get body() { return new Response(copy()).body!; },
      bodyUsed: false,
      arrayBuffer: async () => copy().buffer,
      bytes: async () => copy(),
      text: async () => new TextDecoder().decode(o.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
      blob: async () => new Blob([copy()], { type: o.httpMetadata?.contentType }),
    };
  };
  const bucket = {
    put: async (key: string, value: unknown, opts?: R2PutOptions) => {
      const httpMetadata = opts?.httpMetadata instanceof Headers ? { contentType: opts.httpMetadata.get('Content-Type') ?? undefined } : opts?.httpMetadata;
      const o: Stored = { bytes: await toBytes(value), httpMetadata, customMetadata: opts?.customMetadata, uploaded: new Date(), etag: `etag-${++n}` };
      objects.set(key, o);
      return head(key, o);
    },
    get: async (key: string) => { const o = objects.get(key); return o ? body(key, o) : null; },
    head: async (key: string) => { const o = objects.get(key); return o ? head(key, o) : null; },
    delete: async (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
    list: async (opts?: R2ListOptions) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(opts?.prefix ?? '')).sort();
      const limit = opts?.limit ?? 1000;
      return { objects: keys.slice(0, limit).map((k) => head(k, objects.get(k)!)), truncated: keys.length > limit, delimitedPrefixes: [] };
    },
  };
  return bucket as unknown as R2Bucket;
}
