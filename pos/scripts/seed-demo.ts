// Fills the POS with a demo restaurant (invented data only), on local or remote D1, so it can be tried without Bookr.
// Safe to re-run: it replaces the previous demo restaurant. Nothing is sent to Bookr (no BOOKR_URL or key is set).
//
//   DEMO_PASSWORD=... npx tsx pos/scripts/seed-demo.ts --local
//   DEMO_PASSWORD=... npx tsx pos/scripts/seed-demo.ts --remote
//   npx tsx pos/scripts/seed-demo.ts --remote --keep-password   (reset, keeping the Owner's present password)
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
const keep = process.argv.includes('--keep-password');
if (!target) throw new Error('Pass --local or --remote');
if (!keep && password.length < 12) throw new Error('Set DEMO_PASSWORD (at least 12 characters), or pass --keep-password');

/** The Owner's present password hash, read from the database (never printed), so a reset needs no password typed. */
function presentHash(): string {
  const res = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target!, '--json', '--command',
    "SELECT password_hash FROM staff WHERE lower(email) = 'pos-owner@example.com'", '-c', 'pos/wrangler.jsonc'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0) throw new Error('Could not read the present demo Owner; set DEMO_PASSWORD instead.');
  const h = JSON.parse(res.stdout.slice(res.stdout.indexOf('[')))[0]?.results?.[0]?.password_hash;
  if (typeof h !== 'string' || !h.startsWith('pbkdf2-sha256$')) throw new Error('No demo Owner found to keep; set DEMO_PASSWORD instead.');
  return h;
}

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
for (const table of ['settle_differences', 'recipes', 'credit_notes', 'drawer_outs', 'allocations', 'debtor_entries', 'payments', 'settlements', 'outbox', 'shift_closes', 'audit_log', 'kots', 'order_lines', 'sessions', 'devices']) {
  out.push(table === 'sessions'
    ? `DELETE FROM sessions WHERE staff_id IN (SELECT id FROM staff WHERE business_id = ${lit(B)});`
    : `DELETE FROM ${table} WHERE business_id = ${lit(B)};`);
}
out.push(`DELETE FROM businesses WHERE id = ${lit(B)};`);

insert('businesses', { id: B, name: 'Sample Restaurant (demo)', fy_start_month: 4, shift_start_hour: 8, tab_age_days: 3, tables: JSON.stringify(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'Lawn 1', 'Lawn 2', 'Bar 1', 'Bar 2']), created_at: t });
// KOT stations: the kitchen prints, the tandoor has a screen, the bar has both.
const ST = { kitchen: id(), tandoor: id(), bar: id() };
insert('stations', { id: ST.kitchen, business_id: B, name: 'Kitchen', how: 'paper', copies: 1, is_bar: 0, sort: 0, active: 1, created_at: t });
insert('stations', { id: ST.tandoor, business_id: B, name: 'Tandoor', how: 'screen', copies: 1, is_bar: 0, sort: 1, active: 1, created_at: t });
insert('stations', { id: ST.bar, business_id: B, name: 'Bar', how: 'both', copies: 1, is_bar: 1, sort: 2, active: 1, created_at: t });
const hash = keep ? presentHash() : await hashPassword(password);
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
  ['Tandoori Chicken', 'Starters', 300, 'kitchen'], ['Veg Burger', 'Snacks', 160, 'kitchen'], ['Cheese Sandwich', 'Snacks', 150, 'kitchen'],
  ['Masala Dosa', 'Mains', 180, 'kitchen'], ['Veg Thali', 'Mains', 280, 'kitchen'], ['Dal Makhani', 'Mains', 240, 'kitchen'],
  ['Chicken Biryani', 'Mains', 199, 'kitchen'], ['Butter Naan', 'Breads', 60, 'kitchen'], ['Tandoori Roti', 'Breads', 30, 'kitchen'],
  ['Masala Chai', 'Drinks', 40, 'kitchen'], ['Fresh Lime Soda', 'Drinks', 90, 'bar'], ['Sweet Lassi', 'Drinks', 110, 'bar'],
  ['Gulab Jamun', 'Desserts', 110, 'kitchen'], ['Beer 650 ml', 'Bar', 320, 'bar'], ['Whisky 30 ml', 'Bar', 220, 'bar'], ['Whisky bottle 750 ml', 'Bar', 0, 'bar'],
  ['Laundry (per piece)', 'Hotel', 50, 'kitchen'], ['Dental kit', 'Hotel', 60, 'kitchen'],
];
// GST by category: food takes the billing name's rate; the bar is liquor (outside GST); hotel services 18% (demo rates).
const CATEGORY_TAX: Record<string, { tax_mode: string; gst_bp: number | null }> = {
  Bar: { tax_mode: 'liquor', gst_bp: null }, Hotel: { tax_mode: 'rate', gst_bp: 1800 },
};
// KOT by category: breads to the tandoor, the bar to the bar, hotel charges make no KOT.
const CATEGORY_KOT: Record<string, { kot: number; station_id: string }> = {
  Breads: { kot: 1, station_id: ST.tandoor }, Bar: { kot: 1, station_id: ST.bar }, Drinks: { kot: 1, station_id: ST.bar }, Hotel: { kot: 0, station_id: ST.kitchen },
};
[...new Set(MENU.map((m) => m[1]))].forEach((name, i) =>
  insert('menu_categories', { id: id(), business_id: B, name, tax_mode: CATEGORY_TAX[name]?.tax_mode ?? 'billing', gst_bp: CATEGORY_TAX[name]?.gst_bp ?? null, sort: i, created_at: t,
    kot: CATEGORY_KOT[name]?.kot ?? 1, station_id: CATEGORY_KOT[name]?.station_id ?? ST.kitchen }));
const menuIds: Record<string, string> = {};
for (const [name, category, rupees, station] of MENU) {
  menuIds[name] = id();
  // The bottle's price is typed at billing, never under ₹4,000; the dental kit carries no GST although its category does.
  const bottle = name === 'Whisky bottle 750 ml';
  insert('menu_items', { id: menuIds[name], business_id: B, name, category, price_paise: rupees * 100, sac: '996332', station,
    tax_mode: name === 'Dental kit' ? 'none' : null, gst_bp: null, open_price: bottle ? 1 : 0, min_price_paise: bottle ? 4000_00 : null, active: 1, created_at: t,
    // Tandoori dishes go to the tandoor although Starters go to the kitchen; chai is made in the kitchen although Drinks go to the bar.
    station_id: name === 'Tandoori Chicken' || name === 'Paneer Tikka' ? ST.tandoor : name === 'Masala Chai' ? ST.kitchen : null });
}
// Add-ons: a choice the order must make (each dish with its own prices), and extras (a usual price; a dish may differ).
const ADDONS: [string, 'one' | 'any', [string, number][], [string, Record<string, number> | null][]][] = [
  ['Half or Full', 'one', [['Half', 0], ['Full', 0]], [['Tandoori Chicken', { half: 300_00, full: 450_00 }], ['Chicken Biryani', { half: 199_00, full: 360_00 }]]],
  ['Peri Peri Fries', 'any', [['Peri Peri Fries', 30]], [['Veg Burger', null], ['Cheese Sandwich', null]]],
  ['Extra Cheese', 'any', [['Extra Cheese', 50]], [['Veg Burger', null], ['Masala Dosa', { 'extra cheese': 40_00 }]]],
  ['Butter', 'any', [['Butter', 30]], [['Masala Dosa', null]]],
];
for (const [n, [name, kind, options, dishes]] of ADDONS.entries()) {
  const g = id();
  insert('addon_groups', { id: g, business_id: B, name, kind, created_at: t });
  options.forEach(([o, rupees], i) => insert('addon_options', { id: id(), business_id: B, group_id: g, name: o, add_paise: rupees * 100, sort: i, active: 1 }));
  for (const [d, prices] of dishes) insert('menu_item_addons', { item_id: menuIds[d], group_id: g, business_id: B, sort: n, prices: prices ? JSON.stringify(prices) : null });
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
console.log(`Demo restaurant ready on ${target === '--local' ? 'local' : 'remote'} D1. Sign in as pos-owner@example.com with ${keep ? 'the same password as before' : 'DEMO_PASSWORD'}; counter PINs 1111 (cashier), 2222 (captain), 3333 (manager).`);
