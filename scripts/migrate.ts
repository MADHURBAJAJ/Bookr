// Applies migrations/*.sql in order, once each. Usage: DATABASE_URL=... npm run db:migrate
import { readdir, readFile } from 'node:fs/promises';
import postgres from 'postgres';

export async function migrate(url: string, log = console.log) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const text = await readFile(new URL(file, dir), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      log(`applied ${file}`);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL');
  await migrate(url);
}
