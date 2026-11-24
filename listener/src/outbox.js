// Files waiting to go to Bookr, kept on disk so a restart or a power cut loses nothing (WhatsApp's download links expire,
// so a file is downloaded once and kept here until Bookr has it). Also the list of messages already handled, so the
// same message is never sent twice (Bookr checks again by message id and by file).
//
//   data/outbox/<id>.json + <id>.bin   waiting, with the try count and when to try next
//   data/failed/<id>.json + <id>.bin   Bookr refused it for good (bad file, too large); kept for a look, never retried
//   data/seen.txt                      one line per handled message: id, time, result (kept 60 days)

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_SEEN_MS = 60 * 86400_000;
const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

export function openOutbox(dataDir, now = () => Date.now()) {
  const dir = join(dataDir, 'outbox');
  const failedDir = join(dataDir, 'failed');
  const seenFile = join(dataDir, 'seen.txt');
  mkdirSync(dir, { recursive: true });
  mkdirSync(failedDir, { recursive: true });

  const seen = new Map();
  if (existsSync(seenFile)) {
    const cutoff = now() - KEEP_SEEN_MS;
    const kept = [];
    for (const line of readFileSync(seenFile, 'utf8').split('\n')) {
      const [id, at] = line.split('\t');
      if (id && Number(at) >= cutoff) { seen.set(id, Number(at)); kept.push(line); }
    }
    writeFileSync(seenFile, kept.length ? kept.join('\n') + '\n' : '');
  }

  const paths = (id, d = dir) => ({ json: join(d, `${safe(id)}.json`), bin: join(d, `${safe(id)}.bin`) });
  const markSeen = (id, result) => {
    seen.set(id, now());
    appendFileSync(seenFile, `${id}\t${now()}\t${result}\n`);
  };

  return {
    /** Already handled, or waiting to go. */
    has: (id) => seen.has(id) || existsSync(paths(id).json),

    add(meta, bytes) {
      const p = paths(meta.messageId);
      writeFileSync(p.bin, bytes);
      writeFileSync(p.json, JSON.stringify({ meta, tries: 0, nextAt: 0, addedAt: now() }));
    },

    /** Waiting items whose time has come, oldest message first. */
    due() {
      const out = [];
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        try {
          const rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          if (rec.nextAt <= now()) out.push(rec);
        } catch { /* half-written at a power cut: its message comes again on catch-up */ }
      }
      return out.sort((a, b) => a.meta.sentAt - b.meta.sentAt);
    },

    waiting: () => readdirSync(dir).filter((n) => n.endsWith('.json')).length,

    bytes: (id) => readFileSync(paths(id).bin),

    done(id, result) {
      const p = paths(id);
      for (const f of [p.json, p.bin]) if (existsSync(f)) unlinkSync(f);
      markSeen(id, result);
    },

    retry(rec, delayMs, why) {
      const next = { ...rec, tries: rec.tries + 1, nextAt: now() + delayMs, lastError: String(why).slice(0, 200) };
      writeFileSync(paths(rec.meta.messageId).json, JSON.stringify(next));
      return next;
    },

    fail(rec, why) {
      const from = paths(rec.meta.messageId);
      const to = paths(rec.meta.messageId, failedDir);
      writeFileSync(from.json, JSON.stringify({ ...rec, failedAt: now(), why: String(why).slice(0, 300) }));
      renameSync(from.bin, to.bin);
      renameSync(from.json, to.json);
      markSeen(rec.meta.messageId, 'failed');
    },
  };
}

/** Wait before the next try: 30 s, 1 min, 2 min … up to 30 min, give or take a fifth. */
export function backoff(tries, rand = Math.random) {
  const base = Math.min(30_000 * 2 ** tries, 30 * 60_000);
  return Math.round(base * (0.8 + 0.4 * rand()));
}
