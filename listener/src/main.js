// Start: `npm start` (what the Windows task runs) or `npm run link` (once, by hand, to scan the QR).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { makeLog } from './log.js';
import { assertGuardInPlace, dailyPermit, GuardError, guardedLogger, newStats } from './guard.js';
import { createDaily } from './daily.js';
import { bookrClient } from './bookr.js';
import { createListener } from './listener.js';
import { runWhatsApp } from './whatsapp.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--link') ? 'link' : 'run';
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const cfg = loadConfig(root);
const log = makeLog({ dir: cfg.logDir, level: cfg.logLevel });

if (cfg.problems.length) {
  for (const p of cfg.problems) log.error(`Setting: ${p}`);
  log.error('Fix listener\\.env (copy .env.example) and start again.');
  process.exit(1);
}

// One listener at a time: two on the same login would throw each other off WhatsApp.
mkdirSync(cfg.dataDir, { recursive: true });
const lock = join(cfg.dataDir, 'listener.lock');
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'));
  let alive = false;
  try { if (pid && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch { /* not running */ }
  if (alive) {
    log.error(`The listener is already running (process ${pid}). ${mode === 'link' ? 'Stop the "Bookr WhatsApp listener" task first (see README).' : ''}`);
    process.exit(1);
  }
}
writeFileSync(lock, String(process.pid));
const unlock = () => { try { if (Number(readFileSync(lock, 'utf8')) === process.pid) unlinkSync(lock); } catch { /* gone */ } };

try {
  assertGuardInPlace();
} catch (e) {
  log.error(e.message);
  unlock();
  process.exit(1);
}

const stats = newStats();
let wa = null;
const listener = createListener({
  cfg, log, stats,
  bookr: bookrClient({ url: cfg.bookrUrl, secret: cfg.secret, version }),
  download: (msg) => wa.download(msg),
});
// The guard needs the reception number's own ids: the library's notes to its own phone are the only messages let through.
// The morning Daily check to the owner, when set up in .env: the guard's one way out, open only while it is sent.
const permit = cfg.daily ? dailyPermit() : null;
const logger = guardedLogger({ log, stats, me: () => wa?.me() ?? {}, permit });
const daily = createDaily({ cfg, log, wa: () => wa });

process.on('uncaughtException', (e) => {
  if (e instanceof GuardError) return; // already in the log as BLOCKED; nothing was sent
  log.error(`Stopped by an error: ${e.stack ?? e.message}`);
  unlock();
  process.exit(1); // the Windows task starts it again in a minute
});
process.on('unhandledRejection', (e) => {
  if (e instanceof GuardError) return;
  log.debug(`unhandled: ${e?.message ?? e}`);
});
const quit = (code = 0) => { listener.stop(); daily.stop(); wa?.stop(); unlock(); setTimeout(() => process.exit(code), 500); };
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0));

log.info(`Bookr WhatsApp listener ${version} starting (${mode === 'link' ? 'linking' : 'read-only'}; Bookr at ${cfg.bookrUrl}).`);
log.info(cfg.daily ? 'It never sends, reacts, marks as read or shows the number online, except the morning Daily check PDF to the owner: see the SENT/BLOCKED line every hour.'
  : 'It never sends, reacts, marks as read or shows the number online: see the SENT/BLOCKED line every hour.');

if (mode === 'link') {
  wa = await runWhatsApp({
    cfg, log, logger, mode, listener, onReady: (h) => { wa = h; },
    onLinked: () => {
      log.info('Linked. Waiting 20 seconds for WhatsApp to finish, then stopping. Start the listener task next (see README).');
      setTimeout(() => quit(0), 20_000);
    },
  });
} else {
  const ok = await listener.heartbeat();
  if (!ok) log.warn('Bookr was not reached at start; using the group list from last time until it answers.');
  listener.start();
  wa = await runWhatsApp({ cfg, log, logger, mode, listener, permit, onReady: (h) => { wa = h; } });
  void listener.sendDue();
  daily.start();
}
