// Builds the demo businesses with sample data only, on local or remote D1.
// Safe to re-run: it replaces the previous demo data (businesses marked is_demo and the demo users).
//
//   DEMO_PASSWORD=... npx tsx scripts/seed-demo.ts --local
//   DEMO_PASSWORD=... npx tsx scripts/seed-demo.ts --remote
//
// The password comes from the environment and is never written to the repo or printed. Only its
// PBKDF2 hash goes into a temporary SQL file, which is deleted as soon as wrangler has run it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/crypto';
import { DEFAULT_HEADS } from '../src/defaults';

const target = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
const password = process.env.DEMO_PASSWORD ?? '';
if (!target) throw new Error('Pass --local or --remote');
if (password.length < 10) throw new Error('Set DEMO_PASSWORD (at least 10 characters)');

const PEOPLE = [
  { key: 'owner', name: 'Owner (demo)', email: 'owner@example.com' },
  { key: 'accountant', name: 'Accountant A', email: 'accountant@example.com' },
  { key: 'staff', name: 'Entry staff A', email: 'staff1@example.com' },
  { key: 'viewer', name: 'Viewer A', email: 'viewer@example.com' },
] as const;

const lit = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);
const id = () => crypto.randomUUID();
const t = Date.now();
const FY = '2026-04-01';
const out: string[] = [];
const insert = (table: string, row: Record<string, string | number | null>) =>
  out.push(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(lit).join(', ')});`);

// Remove the previous demo data. Deleting a business takes its memberships, accounts and heads with it.
out.push('DELETE FROM businesses WHERE is_demo = 1;');
out.push(`DELETE FROM users WHERE lower(email) IN (${PEOPLE.map((p) => lit(p.email)).join(', ')});`);

const hash = await hashPassword(password);
const users: Record<string, string> = {};
for (const p of PEOPLE) {
  users[p.key] = id();
  insert('users', { id: users[p.key], name: p.name, email: p.email, password_hash: hash, created_at: t, last_active_at: null });
}

function business(name: string, members: [string, string][], accounts: [string, 'cash' | 'bank', string | null, number][], heads: [string, 'income' | 'expense', string][]) {
  const bid = id();
  insert('businesses', { id: bid, name, fy_start: FY, is_demo: 1, created_at: t });
  for (const [user, role] of members) insert('memberships', { business_id: bid, user_id: users[user], role, created_at: t });
  for (const h of DEFAULT_HEADS) insert('heads', { id: id(), business_id: bid, name: h.name, type: h.type, tally_ledger: h.tally, is_custom: 0, created_at: t });
  for (const [hn, type, tally] of heads) insert('heads', { id: id(), business_id: bid, name: hn, type, tally_ledger: tally, is_custom: 1, created_at: t });
  for (const [an, kind, num, p] of accounts)
    insert('accounts', { id: id(), business_id: bid, name: an, kind, account_number: num, opening_balance_paise: p, opening_date: FY, created_at: t });
}

// Amounts are integer paise.
business('Sample Traders',
  [['owner', 'owner'], ['accountant', 'accountant'], ['staff', 'entry_staff'], ['viewer', 'viewer']],
  [['Cash', 'cash', null, 12_500_00], ['HDFC Current', 'bank', 'XXXX4821', 2_45_000_00], ['ICICI Savings', 'bank', 'XXXX9226', 58_300_50]],
  [['Commission received', 'income', 'Commission Received'], ['Packing material', 'expense', 'Packing Expenses']]);

business('Sample Hotel',
  [['owner', 'owner'], ['accountant', 'viewer']],
  [['Cash', 'cash', null, 8_400_00], ['UPI XOXO', 'bank', 'XXXX1107', 31_250_00], ['UPI Bank 2', 'bank', 'XXXX3390', 12_780_00]],
  [['Room', 'income', 'Room Revenue'], ['F&B', 'income', 'Food and Beverage Sales'], ['Laundry', 'expense', 'Laundry Expenses']]);

const dir = mkdtempSync(join(tmpdir(), 'bookr-seed-'));
const file = join(dir, 'seed.sql');
try {
  writeFileSync(file, out.join('\n') + '\n', { mode: 0o600 });
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--file', file, '--yes'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  console.log(`Demo data ready on ${target.slice(2)} D1: Sample Traders and Sample Hotel.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
