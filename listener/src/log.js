// The listener's log: one file a day in logs/ (kept 30 days) and the console. It never holds message text, captions or
// file contents: only ids, group names, what was done, and the hourly count of what was sent to WhatsApp.

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_DAYS = 30;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** India time, as the hotel reads it: 2026-11-24 14:05:09. */
export const istStamp = (ms = Date.now()) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

export function makeLog({ dir, level = 'info', console: out = console } = {}) {
  if (dir) mkdirSync(dir, { recursive: true });
  const min = LEVELS[level] ?? LEVELS.info;
  let day = '';
  const write = (lvl, msg) => {
    if (LEVELS[lvl] < min) return;
    const stamp = istStamp();
    const line = `${stamp} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    (lvl === 'error' || lvl === 'warn' ? out.error : out.log).call(out, line);
    if (!dir) return;
    const today = stamp.slice(0, 10);
    if (today !== day) { day = today; prune(dir); }
    try { appendFileSync(join(dir, `listener-${today}.log`), line + '\n'); } catch { /* a full disk must not stop the listener */ }
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}

function prune(dir) {
  const cutoff = istStamp(Date.now() - KEEP_DAYS * 86400_000).slice(0, 10);
  try {
    for (const f of readdirSync(dir)) {
      const m = /^listener-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < cutoff) unlinkSync(join(dir, f));
    }
  } catch { /* nothing to prune */ }
}
