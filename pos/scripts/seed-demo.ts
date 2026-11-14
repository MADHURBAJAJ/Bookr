// Fills the POS with a demo restaurant (invented data only), on local or remote D1, so it can be tried without Bookr.
// Safe to re-run: it replaces the previous demo restaurant. Nothing is sent to Bookr (no BOOKR_URL or key is set).
//
//   DEMO_PASSWORD=... npx tsx pos/scripts/seed-demo.ts --local
//   DEMO_PASSWORD=... npx tsx pos/scripts/seed-demo.ts --remote
//
// The Owner's password comes from the environment and is never written to the repo or printed; only its PBKDF2 hash goes
// into a temporary SQL file, deleted as soon as wrangler has run it. Counter PINs are demo PINs (1111, 2222, 3333): they
// work only on a counter device the Owner sets up while signed in with the password.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../../src/crypto';
import { shiftDayAt } from '../src/billing';

const target = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
const password = process.env.DEMO_PASSWORD ?? '';
if (!target) throw new Error('Pass --local or --remote');
if (password.length < 12) throw new Error('Set DEMO_PASSWORD (at least 12 characters)');

export const DEMO_BUSINESS = '0000dea0-0000-4000-8000-000000000001';
const lit = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);
const id = () => crypto.randomUUID();
const t = Date.now();
const out: string[] = [];
const insert = (table: string, row: Record<string, string | number | null>) =>
  out.push(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(lit).join(', ')});`);
const B = DEMO_BUSINESS;

// Remove the previous demo restaurant, children first (printed bills and payments are otherwise kept by triggers).
// pos_events, bills and bill_lines go with the business: their no-delete rules hold only while it exists.
for (const table of ['recipes', 'credit_notes', 'drawer_outs', 'allocations', 'debtor_entries', 'payments', 'settlements', 'outbox', 'shift_closes', 'audit_log', 'kots', 'order_lines', 'sessions', 'devices']) {
  out.push(table === 'sessions'
    ? `DELETE FROM sessions WHERE staff_id IN (SELECT id FROM staff WHERE business_id = ${lit(B)});`
    : `DELETE FROM ${table} WHERE business_id = ${lit(B)};`);
}
out.push(`DELETE FROM businesses WHERE id = ${lit(B)};`);

insert('businesses', { id: B, name: 'Sample Restaurant (demo)', fy_start_month: 4, shift_start_hour: 8, tab_age_days: 3, created_at: t });
const hash = await hashPassword(password);
insert('staff', { id: id(), business_id: B, name: 'Owner (demo)', role: 'owner', email: 'pos-owner@example.com', password_hash: hash, pin_hash: null, created_at: t });
for (const [name, role, pin] of [['Ravi (cashier)', 'cashier', '1111'], ['Suresh (captain)', 'captain', '2222'], ['Anil (manager)', 'manager', '3333']]) {
  insert('staff', { id: id(), business_id: B, name, role, email: role === 'manager' ? 'pos-manager@example.com' : null,
    password_hash: role === 'manager' ? hash : null, pin_hash: await hashPassword(pin), created_at: t });
}

// Billing names: a company with GST, and two HUFs without GST with a ₹20 lakh limit (warn at 15 and 18, stop at 19.5).
const company = id();
insert('billing_entities', { id: company, business_id: B, name: 'Sample Hotels Pvt Ltd', kind: 'company', gst_registered: 1, gstin: '29ABCDE1234F1Z5',
  gst_rate_bp: 500, series_prefix: 'C', yearly_limit_paise: null, warn1_paise: null, warn2_paise: null, stop_paise: null, is_default: 1, offered: 1, active: 1, created_at: t });
const hufs: string[] = [];
for (const n of [1, 2]) {
  const e = id();
  hufs.push(e);
  insert('billing_entities', { id: e, business_id: B, name: `Sample HUF ${n}`, kind: 'huf', gst_registered: 0, gstin: null, gst_rate_bp: 0, series_prefix: `H${n}`,
    yearly_limit_paise: 2000000_00, warn1_paise: 1500000_00, warn2_paise: 1800000_00, stop_paise: 1950000_00, is_default: 0, offered: n === 1 ? 1 : 0, active: 1, created_at: t });
}
insert('pay_accounts', { id: id(), business_id: B, name: 'Company QR', entity_id: company, bookr_account_id: null, active: 1, created_at: t });
hufs.forEach((e, i) => insert('pay_accounts', { id: id(), business_id: B, name: `HUF ${i + 1} QR`, entity_id: e, bookr_account_id: null, active: 1, created_at: t }));

const MENU: [string, string, number, 'kitchen' | 'bar'][] = [
  ['Onion Pakora', 'Starters', 140, 'kitchen'], ['Paneer Tikka', 'Starters', 320, 'kitchen'], ['Chicken 65', 'Starters', 340, 'kitchen'],
  ['Masala Dosa', 'Mains', 180, 'kitchen'], ['Veg Thali', 'Mains', 280, 'kitchen'], ['Dal Makhani', 'Mains', 240, 'kitchen'],
  ['Chicken Biryani', 'Mains', 360, 'kitchen'], ['Butter Naan', 'Breads', 60, 'kitchen'], ['Tandoori Roti', 'Breads', 30, 'kitchen'],
  ['Masala Chai', 'Drinks', 40, 'kitchen'], ['Fresh Lime Soda', 'Drinks', 90, 'kitchen'], ['Sweet Lassi', 'Drinks', 110, 'kitchen'],
  ['Gulab Jamun', 'Desserts', 110, 'kitchen'], ['Beer 650 ml', 'Bar', 320, 'bar'], ['Whisky 30 ml', 'Bar', 220, 'bar'], ['Whisky bottle 750 ml', 'Bar', 4800, 'bar'],
];
const menuIds: Record<string, string> = {};
for (const [name, category, rupees, station] of MENU) {
  menuIds[name] = id();
  insert('menu_items', { id: menuIds[name], business_id: B, name, category, price_paise: rupees * 100, sac: '996332', station, active: 1, created_at: t });
}

// Bar stock: a main store and a bar, a whisky and a beer, recipes, and opening stock received and moved to the bar.
const stores = { main: id(), bar: id(), kitchen: id() };
insert('stock_stores', { id: stores.main, business_id: B, name: 'Main store', kind: 'main', created_at: t });
insert('stock_stores', { id: stores.bar, business_id: B, name: 'Bar', kind: 'bar', created_at: t });
insert('stock_stores', { id: stores.kitchen, business_id: B, name: 'Kitchen', kind: 'kitchen', created_at: t });
const whisky = id();
const beer = id();
insert('stock_items', { id: whisky, business_id: B, name: 'Sample Whisky', unit: 'ml', pack_name: 'bottle', pack_size: 750, cost_per_pack_paise: 1800_00, reorder_level: 1500, active: 1, created_at: t });
insert('stock_items', { id: beer, business_id: B, name: 'Sample Beer 650 ml', unit: 'pcs', pack_name: 'case', pack_size: 12, cost_per_pack_paise: 1800_00, reorder_level: 12, active: 1, created_at: t });
for (const [menu, item, qty] of [['Whisky 30 ml', whisky, 30], ['Whisky bottle 750 ml', whisky, 750], ['Beer 650 ml', beer, 1]] as const) {
  insert('recipes', { menu_item_id: menuIds[menu], stock_item_id: item, business_id: B, qty });
}
const day = shiftDayAt(t, 8);
const move = (item: string, store: string, kind: string, qty: number, extra: Record<string, string | number | null> = {}) =>
  insert('stock_moves', { id: id(), business_id: B, item_id: item, store_id: store, kind, qty, by_staff: null, shift_day: day, at: t, ...extra });
move(whisky, stores.main, 'purchase', 6 * 750, { cost_per_pack_paise: 1800_00, vendor: 'Sample Wines', ref: 'DEMO-1' });
move(beer, stores.main, 'purchase', 4 * 12, { cost_per_pack_paise: 1800_00, vendor: 'Sample Wines', ref: 'DEMO-1' });
move(whisky, stores.main, 'transfer_out', -3000, { ref: 'To Bar' });
move(whisky, stores.bar, 'transfer_in', 3000, { ref: 'From Main store' });
move(beer, stores.main, 'transfer_out', -24, { ref: 'To Bar' });
move(beer, stores.bar, 'transfer_in', 24, { ref: 'From Main store' });

const REASONS: [string, string][] = [
  ['discount', 'Regular guest'], ['discount', 'Late service'], ['discount', 'Staff meal'],
  ['comp', "Owner's guest"], ['comp', 'Service recovery'],
  ['void', 'Wrong billing name'], ['void', 'Wrong items'],
  ['kot_cancel', 'Guest changed mind'], ['kot_cancel', 'Not available'], ['kot_cancel', 'Wrong item'],
];
for (const [kind, label] of REASONS) insert('reasons', { id: id(), business_id: B, kind, label, active: 1, created_at: t });

const today = day;
for (const [room, guest] of [['101', 'A. Mehra'], ['204', 'S. Iyer']]) {
  const s = id();
  insert('stays', { id: s, business_id: B, room, guest_name: guest, check_in: today, checked_out_at: null, opened_by: null, created_at: t });
  insert('debtor_accounts', { id: id(), business_id: B, kind: 'room', name: `Room ${room} · ${guest}`, phone: null, stay_id: s, credit_limit_paise: null, created_by: null, created_at: t });
}
insert('debtor_accounts', { id: id(), business_id: B, kind: 'credit', name: 'Sunrise Travels (demo)', phone: null, stay_id: null, credit_limit_paise: 10000_00, created_by: null, created_at: t });

const dir = mkdtempSync(join(tmpdir(), 'pos-seed-'));
const file = join(dir, 'seed.sql');
try {
  writeFileSync(file, out.join('\n'));
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--file', file, '--yes', '-c', 'pos/wrangler.jsonc'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`wrangler failed:\n${res.stderr || res.stdout}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Demo restaurant ready on ${target === '--local' ? 'local' : 'remote'} D1. Sign in as pos-owner@example.com with DEMO_PASSWORD; counter PINs 1111 (cashier), 2222 (captain), 3333 (manager).`);
