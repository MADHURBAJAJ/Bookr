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
  return { db, uploads: proxy.env.UPLOADS, dispose };
}
