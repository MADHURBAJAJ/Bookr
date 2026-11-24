// `npm run check-log`: reads the listener's logs and says whether anything was ever sent to WhatsApp that it must not
// send. Every hour the listener writes what went out (protocol only: delivery receipts, acknowledgements, queries) and
// what the guard stopped. Prints the totals; exits 1 when a BLOCKED line or a forbidden kind is found.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What must never appear in the SENT counts (the guard blocks these, so they show under BLOCKED instead). */
const FORBIDDEN = /^(message$|receipt:(read|read-self|played|played-self)$|presence:(?!unavailable$)|chatstate)/;

export function checkLogs(dir) {
  const sent = new Map();
  const blocked = [];
  let hours = 0;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^listener-.*\.log$/.test(f)).sort() : [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (/ ERROR BLOCKED /.test(line)) blocked.push(`${f}: ${line}`);
      const m = /SENT to WhatsApp \(protocol only\): (.*) \| BLOCKED: (.*)$/.exec(line);
      if (!m) continue;
      hours += 1;
      if (m[1] !== 'none') for (const part of m[1].split(', ')) {
        const i = part.lastIndexOf(' ');
        sent.set(part.slice(0, i), (sent.get(part.slice(0, i)) ?? 0) + Number(part.slice(i + 1)));
      }
      if (m[2] !== 'none') blocked.push(`${f}: ${line}`);
    }
  }
  const bad = [...sent.keys()].filter((k) => FORBIDDEN.test(k));
  return { files: files.length, hours, sent, blocked, bad };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
  const r = checkLogs(dir);
  console.log(`${r.files} log file(s), ${r.hours} hourly line(s).`);
  console.log(`Sent to WhatsApp (protocol only): ${[...r.sent].map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}`);
  if (r.bad.length) console.log(`NOT ALLOWED kinds sent: ${r.bad.join(', ')}`);
  if (r.blocked.length) { console.log(`The guard stopped something ${r.blocked.length} time(s) (nothing was sent):`); for (const b of r.blocked.slice(0, 20)) console.log(`  ${b}`); }
  const clean = !r.bad.length && !r.blocked.length;
  const daily = r.sent.get('message:daily-check-to-owner') ?? 0;
  console.log(clean ? `OK: no message, reaction, read receipt, typing or online status was ever sent${daily ? `, except ${daily} morning Daily check message(s) to the owner` : ''}.` : 'Look at the lines above.');
  process.exit(clean ? 0 : 1);
}
