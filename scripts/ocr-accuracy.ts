// Accuracy check for "Read page": reads the three invented demo pages through a running Bookr and
// compares every cell with the values the pages were drawn from (demo/sample-data.ts).
//
//   DEMO_PASSWORD=... npx tsx scripts/ocr-accuracy.ts --base-url https://bookr-demo.bis-directoredu.workers.dev
//
// It works in Sample Traders (sample data only), uses 3 of that business's daily page reads,
// and deletes the pages afterwards unless --keep is given. The Claude key stays a Worker secret.
// Run it after changing CLAUDE_OCR_MODEL (or the engine) to compare results.
import { readFileSync } from 'node:fs';
import { CASH_SUMMARY_31_OCT, EXPENSES_31_OCT, REGISTER_31_OCT } from '../demo/sample-data';
import { parsePaise } from '../src/money';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const base = arg('--base-url')?.replace(/\/$/, '');
const keep = process.argv.includes('--keep');
const password = process.env.DEMO_PASSWORD ?? '';
if (!base || !password) throw new Error('Pass --base-url and set DEMO_PASSWORD');
const DAY = '2026-10-31';

let cookie = '';
async function call(method: string, path: string, body?: unknown, raw?: Uint8Array<ArrayBuffer>): Promise<any> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(raw ? { 'Content-Type': 'image/png' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data: any = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${data?.error ?? ''}`), { status: res.status });
  return data;
}

const p = (rupees: string) => parsePaise(rupees)!;
interface Score { page: string; cells: number; matched: number; unclear: number; misses: string[] }
const score = (page: string): Score => ({ page, cells: 0, matched: 0, unclear: 0, misses: [] });
const check = (s: Score, label: string, want: unknown, got: unknown) => {
  s.cells++;
  if (JSON.stringify(want) === JSON.stringify(got)) s.matched++;
  else s.misses.push(`${label}: expected ${JSON.stringify(want)}, read ${JSON.stringify(got)}`);
};
const unclearCount = (o: string | null) => (o ? (JSON.parse(o).unclear?.length ?? 0) : 0);

await call('POST', '/auth/login', { email: 'owner@example.com', password });
const me = await call('GET', '/me');
const biz = me.businesses.find((b: any) => b.name === 'Sample Traders' && b.isDemo);
if (!biz) throw new Error('Sample Traders (demo) not found');
const b = `/businesses/${biz.id}`;
const status = await call('GET', `${b}/ocr`);
if (!status.configured) throw new Error('Reading pages is not configured on this server (no ANTHROPIC_API_KEY secret).');

// Remove pages left over from an earlier run.
const before = await call('GET', `${b}/uploads`);
for (const u of before.uploads.filter((x: any) => x.day === DAY && ['bill_register', 'expense_list', 'cash_summary'].includes(x.kind))) {
  await call('DELETE', `${b}/uploads/${u.id}`, {});
}

const img = (name: string) => new Uint8Array(readFileSync(new URL(`../demo/images/${name}`, import.meta.url)));
const pages = [
  { kind: 'bill_register', file: 'register-2026-10-31.png' },
  { kind: 'expense_list', file: 'expenses-2026-10-31.png' },
  { kind: 'cash_summary', file: 'cash-summary-2026-10-31.png' },
];
const scores: Score[] = [];
const created: string[] = [];
const started = Date.now();

for (const pg of pages) {
  const { id } = await call('POST', `${b}/uploads?kind=${pg.kind}&day=${DAY}`, undefined, img(pg.file));
  created.push(id);
  const t = Date.now();
  await call('POST', `${b}/uploads/${id}/read`, {});
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const u = await call('GET', `${b}/uploads/${id}`);
  const s = score(`${pg.kind} (${secs}s)`);
  if (pg.kind === 'bill_register') {
    check(s, 'row count', REGISTER_31_OCT.length, u.rows.length);
    REGISTER_31_OCT.forEach((want, i) => {
      const got = u.rows[i];
      const tag = `line ${i + 1}`;
      check(s, `${tag} bill no`, want.billNo, got?.billNo);
      check(s, `${tag} type`, want.billType, got?.billType);
      check(s, `${tag} amount`, p(want.amount), got?.amountPaise);
      const norm = (xs: { mode: string; amountPaise?: number; amount?: string }[]) =>
        xs.map((x) => `${x.mode}:${x.amountPaise ?? p(x.amount!)}`).sort();
      check(s, `${tag} payments`, norm(want.payments), norm(got?.payments ?? []));
      s.unclear += unclearCount(got?.ocrOriginal ?? null);
    });
    check(s, 'page total', p('16215.50'), u.pageWrittenTotalPaise);
  } else if (pg.kind === 'expense_list') {
    check(s, 'row count', EXPENSES_31_OCT.length, u.rows.length);
    EXPENSES_31_OCT.forEach((want, i) => {
      const got = u.rows[i];
      check(s, `line ${i + 1} item`, want.narration.toLowerCase(), (got?.narration ?? '').trim().toLowerCase());
      check(s, `line ${i + 1} amount`, p(want.amount), got?.amountPaise);
      s.unclear += unclearCount(got?.ocrOriginal ?? null);
    });
    check(s, 'page total', p('2910'), u.pageWrittenTotalPaise);
  } else {
    const c = CASH_SUMMARY_31_OCT;
    const g = u.summary;
    check(s, 'opening', p(c.opening), g.openingPaise);
    check(s, 'received', p(c.received), g.receivedPaise);
    check(s, 'balance', p(c.balance), g.balancePaise);
    check(s, 'expenses', p(c.expenses), g.expensesPaise);
    check(s, 'cash in hand', p(c.cashInHand), g.cashInHandPaise);
    s.unclear += unclearCount(g.ocrOriginal);
  }
  scores.push(s);
}

if (!keep) for (const id of created) await call('DELETE', `${b}/uploads/${id}`, {});
await call('POST', '/auth/logout', {});

const total = scores.reduce((a, s) => ({ cells: a.cells + s.cells, matched: a.matched + s.matched }), { cells: 0, matched: 0 });
console.log(`Engine: claude_vision · model ${status.model} · ${new Date().toISOString().slice(0, 10)} · ${((Date.now() - started) / 1000).toFixed(0)}s`);
for (const s of scores) {
  console.log(`  ${s.page.padEnd(28)} ${s.matched}/${s.cells} cells match (${((100 * s.matched) / s.cells).toFixed(1)}%), ${s.unclear} marked unclear`);
  for (const m of s.misses) console.log(`      ✗ ${m}`);
}
console.log(`  Overall: ${total.matched}/${total.cells} (${((100 * total.matched) / total.cells).toFixed(1)}%)`);
