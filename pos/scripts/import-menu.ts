// Loads the cleaned menu sheet into one business. The sheet is exported as CSV and kept on your own computer, never in
// the repo. Without --apply it only checks the file and prints what it would do.
//
//   npx tsx pos/scripts/import-menu.ts --csv ~/Downloads/menu.csv --business <business id> --local
//   npx tsx pos/scripts/import-menu.ts --csv ~/Downloads/menu.csv --business <business id> --remote --apply
//
// Items now on the menu are taken off it (old bills still show them); the sheet's items go on with their category GST,
// price at billing and add-ons. Columns read: Item, Price, Price at billing, Tax, Category, Station, Add-ons & choices.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, importSql, parseCsv, readMenu } from './menu-import-lib';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const target = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
const csv = arg('--csv');
const business = arg('--business');
if (!target || !csv || !business) throw new Error('Usage: --csv <file> --business <id> --local|--remote [--apply]');
if (!/^[0-9a-f-]{36}$/i.test(business)) throw new Error('--business must be the business id');

const menu = readMenu(parseCsv(readFileSync(csv, 'utf8').replace(/^﻿/, '')));
const sql = importSql(menu, business, () => crypto.randomUUID(), Date.now());

const run = (args: string[]) => spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, ...args, '-c', 'pos/wrangler.jsonc'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const found = run(['--json', '--command', `SELECT name FROM businesses WHERE id = '${business}'`]);
if (found.status !== 0) throw new Error(`wrangler failed:\n${found.stderr || found.stdout}`);
const name = JSON.parse(found.stdout.slice(found.stdout.indexOf('[')))[0]?.results?.[0]?.name;
if (!name) throw new Error('No business with that id in this database.');

console.log(`${name}: ${menu.items.length} items in ${menu.categories.length} categories, ${menu.groups.length} add-ons.`);
for (const c of menu.categories) console.log(`  ${c.name}: ${menu.items.filter((i) => i.category === c.name).length} items, ${describe(c.tax)}`);
console.log(`  Price at billing: ${menu.items.filter((i) => i.openPrice).length} items`);
for (const g of menu.groups) console.log(`  Add-on ${g.name} (${g.kind === 'one' ? 'pick one' : 'add any'}): ${menu.items.filter((i) => i.groups.includes(g.name)).length} items`);
for (const n of menu.notes) console.log(`  Note: ${n}`);
if (!process.argv.includes('--apply')) { console.log('Checked only. Add --apply to load it.'); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'pos-menu-'));
try {
  const file = join(dir, 'menu.sql');
  writeFileSync(file, sql.join('\n'));
  const res = run(['--file', file, '--yes']);
  if (res.status !== 0) throw new Error(`wrangler failed:\n${res.stderr || res.stdout}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('Loaded. The counter shows the new menu at its next refresh.');
