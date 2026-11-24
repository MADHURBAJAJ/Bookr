// Accuracy check for reading WhatsApp files: reads every sample in wa-samples/ with the same instructions, schema
// and model as the Worker (src/waRead.ts), and compares with wa-samples/expected.json. Each sample is one paid read.
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/wa-accuracy.ts            (all samples)
//   ANTHROPIC_API_KEY=... npx tsx scripts/wa-accuracy.ts --only 08   (files whose name contains "08")
//   options: --dir wa-samples  --model claude-opus-5-5  --save results.json
//            --from wa-samples/results.json   (score readings saved earlier again, with no new reads and no key)
//
// The key is read from the environment and never printed. wa-samples/ is ignored by Git (real guest data).

import { readFileSync, writeFileSync } from 'node:fs';
import { readWithClaude } from '../src/claude';
import { settle, waInstructions, WaReading } from '../src/waRead';
import { choosePairs, type PairItem } from '../src/waPair';
import { istDay } from '../src/time';

const arg = (name: string, d?: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg('dir', 'wa-samples')!;
const only = arg('only');
const model = arg('model', process.env.CLAUDE_OCR_MODEL || 'claude-opus-5-5')!;
const from = arg('from');
const earlier = from ? new Map((JSON.parse(readFileSync(from, 'utf8')) as { file: string; model: string; reading: WaReading }[]).map((x) => [x.file, x])) : null;
if (!earlier && !process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY in the environment.'); process.exit(1); }

interface Expected { file: string; kind: 'upi' | 'bill'; amount?: number; total?: number; utr?: string | null; billNo?: string; at?: string | null; sentAround?: string; caption?: string; replyTo?: string; pairsWith?: string | null; note?: string }
const exp = JSON.parse(readFileSync(`${dir}/expected.json`, 'utf8')) as { group: { name: string }; items: Expected[] };
const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_OCR_MODEL: model } as never;

const fmt = (ms: number | null) => (ms == null ? null : `${istDay(ms)} ${new Date(ms + 19_800_000).toISOString().slice(11, 16)}`);
let checks = 0, right = 0;
const rows: string[] = [];
const saved: unknown[] = [];
const forPairs: PairItem[] = [];
let last = Date.parse('2026-11-23T21:00+05:30');

for (const e of exp.items) {
  // When it was posted: a little after the time on it, or when known (sentAround) for a screen that shows no time.
  const sentAt = e.at ? Date.parse(e.at) + 30_000 : e.sentAround ? Date.parse(e.sentAround) + 30_000 : last + 60_000;
  last = sentAt;
  if (only && !e.file.includes(only)) continue;
  const bytes = new Uint8Array(readFileSync(`${dir}/${e.file}`));
  const mediaType = e.file.endsWith('.pdf') ? 'application/pdf' : e.file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const started = Date.now();
  let line = `${e.file.padEnd(28)} `;
  try {
    const old = earlier?.get(e.file);
    if (earlier && !old) throw new Error('not in the saved readings');
    const { data, model: used } = old ? { data: old.reading, model: old.model }
      : await readWithClaude(env, { bytes, mediaType }, waInstructions({ sent_at: sentAt, caption: e.caption ?? null, group_name: exp.group.name }), WaReading);
    const s = settle(data, sentAt);
    if (s.kind === 'upi' || s.kind === 'bill') forPairs.push({ id: e.file, kind: s.kind, sender: 'sample-sender', messageId: e.file, replyTo: e.replyTo ?? null,
      caption: e.caption ?? null, sentAt, amountPaise: s.amountPaise, billNo: s.billNo });
    saved.push({ file: e.file, model: used, reading: data, settled: s });
    const misses: string[] = [];
    const check = (label: string, want: unknown, got: unknown) => {
      if (want === undefined) return;
      checks++;
      if (JSON.stringify(want) === JSON.stringify(got)) right++; else misses.push(`${label} ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    };
    check('kind', e.kind, s.kind);
    const wantPaise = (e.kind === 'upi' ? e.amount : e.total);
    check('amount', wantPaise == null ? undefined : Math.round(wantPaise * 100), s.amountPaise);
    if (e.kind === 'upi' && e.utr !== undefined && !(e.utr ?? '').includes('?')) check('utr', e.utr, s.utr);
    if (e.kind === 'bill') check('billNo', e.billNo, s.billNo);
    if (e.at) check('time', fmt(Date.parse(e.at)), fmt(s.docAt));
    line += `${misses.length ? '✗' : '✓'} ${s.kind.padEnd(5)} ₹${s.amountPaise == null ? '—' : s.amountPaise / 100} ${s.utr ?? s.billNo ?? ''} ${fmt(s.docAt) ?? ''}`
      + `${misses.length ? `\n${' '.repeat(31)}${misses.join('; ')}` : ''}${s.notes.length ? `\n${' '.repeat(31)}notes: ${s.notes.join(' ')}` : ''}`
      + ` (${((Date.now() - started) / 1000).toFixed(1)} s)`;
  } catch (err) {
    line += `! ${(err as Error).message}`;
  }
  rows.push(line);
  console.log(line);
}

console.log(`\n${right}/${checks} values right (${checks ? Math.round((100 * right) / checks) : 0}%), ${earlier ? `saved readings from ${from}` : `model ${model}`}, ${rows.length} files.`);
// Pairs, worked out as the Worker would (src/waPair.ts), against pairsWith in the answer key.
if (!only) {
  const got = choosePairs(forPairs);
  const want = exp.items.filter((e) => e.pairsWith).map((e) => `${e.pairsWith}|${e.file}`);
  console.log('\nPairs:');
  for (const p of got) console.log(`  ${want.includes(`${p.upiId}|${p.billId}`) ? '✓' : '✗'} ${p.upiId.padEnd(22)} + ${p.billId.padEnd(26)} ${String(p.confidence).padStart(3)}%  ${p.reasons.join(', ')}`);
  for (const w of want.filter((w) => !got.some((p) => `${p.upiId}|${p.billId}` === w))) console.log(`  ✗ missed ${w.replace('|', ' + ')}`);
  const alone = exp.items.filter((e) => e.kind === 'bill' && e.pairsWith === null).map((e) => e.file);
  for (const a of alone) console.log(`  ${got.some((p) => p.billId === a) ? '✗ paired, but has no payment photo:' : '✓ left alone (no payment photo):'} ${a}`);
}
const save = arg('save');
if (save) { writeFileSync(save, JSON.stringify(saved, null, 2)); console.log(`Readings saved to ${save}.`); }
