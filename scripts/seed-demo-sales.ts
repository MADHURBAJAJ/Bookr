// Adds the invented Phase 2 sample data to Sample Hotel on a running Bookr, through its own API,
// so the demo goes through exactly the same checks as a person would. Run after seed-demo.ts.
//
//   DEMO_PASSWORD=... npx tsx scripts/seed-demo-sales.ts --base-url https://bookr-demo.example.workers.dev
//
// It signs in as owner@example.com. The password comes from the environment and is never printed.
// It leaves the 31 Oct shift with differences to decide, two expense lines waiting for a head,
// and a cash summary whose checks are waiting, so every Phase 2 screen has something to show.
import { readFileSync } from 'node:fs';
import { buildSalesCsv, CASH_SUMMARY_31_OCT, EXPENSES_31_OCT, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT } from '../demo/sample-data';
import { istToMs } from '../src/time';

const i = process.argv.indexOf('--base-url');
const base = i > 0 ? process.argv[i + 1]?.replace(/\/$/, '') : '';
const password = process.env.DEMO_PASSWORD ?? '';
if (!base) throw new Error('Pass --base-url');
if (!password) throw new Error('Set DEMO_PASSWORD');

let cookie = '';
async function call(method: string, path: string, body?: unknown, raw?: { bytes: Uint8Array<ArrayBuffer>; type: string }): Promise<any> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: raw ? raw.bytes : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data?.error ?? ''} ${(data?.problems ?? []).join(' ')}`);
  return data;
}

await call('POST', '/auth/login', { email: 'owner@example.com', password });
const me = await call('GET', '/me');
const hotel = me.businesses.find((b: { name: string; isDemo: boolean }) => b.name === 'Sample Hotel' && b.isDemo);
if (!hotel) throw new Error('Sample Hotel not found. Run seed-demo.ts first.');
const b = `/businesses/${hotel.id}`;

const { heads } = await call('GET', `${b}/heads`);
const head = (name: string, type: string) => heads.find((h: { name: string; type: string }) => h.name === name && h.type === type)?.id;
await call('PUT', `${b}/bill-type-heads/fnb`, { headId: head('F&B', 'income') });
await call('PUT', `${b}/bill-type-heads/room`, { headId: head('Room', 'income') });

await call('POST', `${b}/sales-reports`, { day: '2026-10-31', csv: buildSalesCsv(REPORT_31_OCT), coversFrom: istToMs(2026, 10, 31, 0, 0, 0), coversTo: istToMs(2026, 10, 31, 23, 59, 59) });
await call('POST', `${b}/sales-reports`, { day: '2026-11-01', csv: buildSalesCsv(REPORT_1_NOV_EARLY), coversFrom: istToMs(2026, 11, 1, 0, 0, 0), coversTo: istToMs(2026, 11, 1, 7, 59, 59) });

const png = (name: string) => ({ bytes: new Uint8Array(readFileSync(new URL(`../demo/images/${name}`, import.meta.url))), type: 'image/png' });

const reg = await call('POST', `${b}/uploads?kind=bill_register&day=2026-10-31`, undefined, png('register-2026-10-31.png'));
for (const r of REGISTER_31_OCT) {
  await call('POST', `${b}/uploads/${reg.id}/register-rows`, {
    billNo: r.billNo, billType: r.billType, amount: r.amount, remarks: r.remarks ?? null, status: 'checked',
    payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: p.amount })),
  });
}
await call('PATCH', `${b}/uploads/${reg.id}`, { pageWrittenTotal: '16215.50' });

const exp = await call('POST', `${b}/uploads?kind=expense_list&day=2026-10-31`, undefined, png('expenses-2026-10-31.png'));
for (const e of EXPENSES_31_OCT) {
  await call('POST', `${b}/uploads/${exp.id}/expense-rows`, { narration: e.narration, amount: e.amount, headId: e.head ? head(e.head, 'expense') : null });
}
await call('POST', `${b}/uploads/${exp.id}/expense-rows/approve`, {});

const cash = await call('POST', `${b}/uploads?kind=cash_summary&day=2026-10-31`, undefined, png('cash-summary-2026-10-31.png'));
const page = await call('GET', `${b}/uploads/${cash.id}`);
await call('PUT', `${b}/cash-summaries/${page.summary.id}`, CASH_SUMMARY_31_OCT);

// One difference decided, so the screen shows both states.
const shift = await call('GET', `${b}/shifts/2026-10-31`);
const amountDiff = shift.comparisons.find((c: { billNo: string }) => c.billNo === '2610317');
await call('PUT', `${b}/comparisons/${amountDiff.id}`, { decision: 'use_software' });

await call('POST', '/auth/logout', {});
console.log('Sample Hotel now has invented sales for the 31 Oct shift, a register page, an expense list and a cash summary.');
