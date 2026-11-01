// Recreates a clean test database on the local Postgres and applies the migrations.
import postgres from 'postgres';
import { migrate } from '../scripts/migrate';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:bookr@127.0.0.1:54329/bookr_test';

export default async function setup() {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.slice(1);
  const admin = postgres({ ...parse(url), database: 'postgres', max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    throw new Error(`Cannot reach the test Postgres at ${url.host}. Start it with "npm run db:start". (${(e as Error).message})`);
  } finally {
    await admin.end();
  }
  await migrate(TEST_DB_URL, () => {});
}

function parse(url: URL) {
  return { host: url.hostname, port: Number(url.port || 5432), username: url.username, password: decodeURIComponent(url.password) };
}
