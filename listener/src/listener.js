// The listener's work, apart from connecting to WhatsApp (src/whatsapp.js): decide which messages to keep, download
// them gently, keep them on disk, send them to Bookr with retries, and send the heartbeat every minute.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backoff, openOutbox } from './outbox.js';
import { classify } from './bookr.js';
import { pick } from './media.js';
import { statsLine } from './guard.js';

const HEARTBEAT_MS = 60_000;
const LINK_BEAT_MS = 5_000;
const GROUP_LIST_MS = 30 * 60_000;
const SEND_EVERY_MS = 5_000;
const DOWNLOADS_PER_MIN = 20;
const SETUP_RETRY_MS = 5 * 60_000;
const DOWNLOAD_TRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * deps: { cfg, log, bookr, stats, download(msg) → bytes, now?, rand?, wait? }
 * The WhatsApp side calls attach(socket) on each connection, and the methods below on its events.
 */
export function createListener({ cfg, log, bookr, stats, download, now = () => Date.now(), rand = Math.random, wait = sleep }) {
  const outbox = openOutbox(cfg.dataDir, now);
  const cacheFile = join(cfg.dataDir, 'groups.json');
  /** Group ids Bookr reads, from the last heartbeat answer (kept on disk for a start without internet). */
  let serverGroups = new Set();
  if (existsSync(cacheFile)) {
    try { serverGroups = new Set(JSON.parse(readFileSync(cacheFile, 'utf8')).readGroups ?? []); } catch { /* fetched again */ }
  }
  const names = new Map();
  let state = 'starting';
  let lastMessageAt = null;
  let groupsSentAt = 0;
  let setupProblem = '';
  let sock = null;
  const skipped = new Map();
  const downloads = [];
  let downloading = false;
  const recent = [];
  let sending = false;
  let wakeSender = () => {};
  // Linking from the POS (27 Nov 2026): the linked number's last 4 digits (undefined until known, null when not linked),
  // the request being worked on ({ id, qrRows } while linking, { id, result } once it ended, until Bookr has heard it),
  // and what to do with the request Bookr answers.
  let linkedLast4;
  let linkWork = null;
  let onLink = () => {};
  let beating = null;

  const reads = (g) => serverGroups.has(g) && (!cfg.localGroups || cfg.localGroups.has(g));
  const me = () => sock?.user() ?? {};

  function setReadGroups(ids) {
    const next = new Set(ids);
    const same = next.size === serverGroups.size && [...next].every((g) => serverGroups.has(g));
    if (same) return;
    serverGroups = next;
    writeFileSync(cacheFile, JSON.stringify({ readGroups: [...next], at: now() }));
    const list = [...next].filter(reads).map((g) => names.get(g) ?? g);
    log.info(`Reading ${list.length} group${list.length === 1 ? '' : 's'}${list.length ? `: ${list.join(', ')}` : ''}.`);
    if (cfg.localGroups) {
      const held = [...next].filter((g) => !cfg.localGroups.has(g));
      if (held.length) log.info(`${held.length} group(s) chosen in Bookr are not in GROUPS_FILE, so not read here: ${held.map((g) => names.get(g) ?? g).join(', ')}.`);
    }
  }

  /** One heartbeat at a time; a call while one is on its way waits for it. */
  function heartbeat() {
    if (!beating) beating = beat().finally(() => { beating = null; });
    return beating;
  }
  async function beat() {
    const body = { lastMessageAt, state };
    if (linkedLast4 !== undefined) body.linkedLast4 = linkedLast4;
    const work = linkWork;
    if (work) body.link = { id: work.id, ...(work.qrRows ? { qrRows: work.qrRows } : {}), ...(work.result ? { result: work.result } : {}) };
    if (sock && state === 'connected' && now() - groupsSentAt >= GROUP_LIST_MS) {
      try {
        const all = await sock.groupFetchAllParticipating();
        for (const g of Object.values(all ?? {})) if (g?.id && g.subject) names.set(g.id, g.subject);
        body.groups = Object.values(all ?? {}).filter((g) => g?.id && g.subject).slice(0, 300).map((g) => ({ id: g.id, name: String(g.subject).slice(0, 200) }));
        groupsSentAt = now();
      } catch (e) { log.debug(`group list: ${e.message}`); }
    }
    try {
      const r = await bookr.heartbeat(body);
      if (r.status === 200 && Array.isArray(r.body?.readGroups)) {
        if (setupProblem) { log.info('Bookr accepts the listener again.'); setupProblem = ''; }
        setReadGroups(r.body.readGroups);
        if (work?.result && linkWork === work) linkWork = null;   // Bookr has heard how it ended
        try { onLink(r.body.link ?? null); } catch (e) { log.error(`link: ${e.message}`); }
        return true;
      }
      noteSetup(r.status, r.body?.error);
    } catch (e) {
      log.debug(`heartbeat: ${e.message}`);
    }
    return false;
  }

  function noteSetup(status, error) {
    const why = status === 401 ? 'Bookr refused the secret: BOOKR_SECRET in .env must be the same as WA_INGEST_SECRET in Bookr.'
      : status === 503 ? 'Bookr has no WA_INGEST_SECRET set yet.'
      : `Bookr answered ${status}${error ? `: ${error}` : ''}.`;
    if (why !== setupProblem) { log.error(why); setupProblem = why; }
  }

  /** Messages from WhatsApp: new ones, and the ones that came in while the PC was off (catch-up). */
  function onMessages(messages) {
    for (const msg of messages ?? []) {
      const id = msg?.key?.id;
      if (!id || outbox.has(id)) continue;
      const r = pick(msg, { reads, me: me(), groupName: (g) => names.get(g) });
      if (!r.keep) { skipped.set(r.why, (skipped.get(r.why) ?? 0) + 1); continue; }
      if (downloads.some((d) => d.r.meta.messageId === id)) continue;
      downloads.push({ msg, r, tries: 0 });
    }
    void runDownloads();
  }

  async function runDownloads() {
    if (downloading) return;
    downloading = true;
    try {
      while (downloads.length) {
        // Gently: a short random pause before each file, and no more than 20 a minute.
        while (recent.length && now() - recent[0] > 60_000) recent.shift();
        if (recent.length >= DOWNLOADS_PER_MIN) { await wait(60_000 - (now() - recent[0]) + 100); continue; }
        await wait(1000 + Math.round(rand() * 3000));
        const job = downloads.shift();
        recent.push(now());
        const { meta } = job.r;
        try {
          const bytes = await download(job.msg);
          outbox.add(meta, bytes);
          lastMessageAt = Math.max(lastMessageAt ?? 0, meta.sentAt);
          log.info(`Kept ${meta.mediaType === 'image' ? 'photo' : 'file'} ${meta.messageId} from ${meta.groupName ?? meta.groupId} (${Math.round(bytes.length / 1024)} KB).`);
          wakeSender();
        } catch (e) {
          job.tries += 1;
          if (job.tries < DOWNLOAD_TRIES) {
            log.warn(`Could not download ${meta.messageId} (try ${job.tries}): ${e.message}`);
            setTimeout(() => { downloads.push(job); void runDownloads(); }, backoff(job.tries - 1, rand));
          } else {
            log.error(`Gave up downloading ${meta.messageId} from ${meta.groupName ?? meta.groupId} after ${job.tries} tries: ${e.message}. Ask for it to be sent again.`);
          }
        }
      }
    } finally {
      downloading = false;
    }
  }

  /** Sends what is waiting, one at a time. */
  async function sendDue() {
    if (sending) return;
    sending = true;
    try {
      for (const rec of outbox.due()) {
        const id = rec.meta.messageId;
        let res;
        try {
          res = await bookr.ingest(rec.meta, outbox.bytes(id));
        } catch (e) {
          const next = outbox.retry(rec, backoff(rec.tries, rand), e.message);
          log.warn(`Bookr not reached for ${id} (try ${next.tries}): ${e.message}`);
          continue;
        }
        const what = classify(res.status);
        if (what === 'done') {
          const result = res.body?.stored ? 'stored' : (res.body?.reason ?? 'dropped');
          outbox.done(id, result);
          log.info(`Sent ${id} to Bookr: ${result === 'stored' ? 'stored' : `not stored (${result.replace(/_/g, ' ')})`}.`);
        } else if (what === 'fail') {
          outbox.fail(rec, `${res.status} ${res.body?.error ?? ''}`);
          log.error(`Bookr refused ${id} for good (${res.status}${res.body?.error ? `: ${res.body.error}` : ''}); it is kept in data/failed.`);
        } else if (what === 'setup') {
          outbox.retry(rec, SETUP_RETRY_MS, `${res.status}`);
          noteSetup(res.status, res.body?.error);
          break;
        } else {
          const next = outbox.retry(rec, backoff(rec.tries, rand), `${res.status}`);
          log.warn(`Bookr answered ${res.status} for ${id}; trying again (try ${next.tries}).`);
        }
      }
    } finally {
      sending = false;
    }
  }

  const timers = [];
  return {
    reads,
    names,
    outbox,
    get state() { return state; },
    get lastMessageAt() { return lastMessageAt; },
    setState(s) { state = s; },
    /** A new WhatsApp connection (read-only view, see whatsapp.js). */
    attach(s) { sock = s; groupsSentAt = 0; },
    detach() { sock = null; },
    onMessages,
    onGroups(list) { for (const g of list ?? []) if (g?.id && g.subject) names.set(g.id, g.subject); },
    heartbeat,
    /** The linked number's last 4 digits, or null when this PC is not linked. */
    setLinked(last4) { linkedLast4 = last4; },
    /** Linking for request id: the QR to scan now (rows of 0 and 1). Sent to Bookr at once. */
    linkProgress(id, qrRows) { linkWork = { id, qrRows }; void heartbeat(); },
    /** The request ended: linked, unlinked, expired or cancelled. Sent to Bookr at once, and again until it answers. */
    linkDone(id, result) { linkWork = { id, result }; void heartbeat(); },
    get linking() { return !!linkWork && !linkWork.result; },
    /** What to do with the link request in each heartbeat answer ({ id, action } or null). */
    setLinkHandler(fn) { onLink = fn; },
    sendDue,
    runDownloads,
    /** Starts the timers: heartbeat every minute, sending every 5 seconds (or at once when a file is kept), hourly counts. */
    start() {
      wakeSender = () => void sendDue();
      timers.push(setInterval(() => void heartbeat(), HEARTBEAT_MS));
      // While a link is open (or its end not yet heard by Bookr), every 5 seconds: the QR changes every 20.
      timers.push(setInterval(() => { if (linkWork) void heartbeat(); }, LINK_BEAT_MS));
      timers.push(setInterval(() => void sendDue(), SEND_EVERY_MS));
      timers.push(setInterval(() => {
        log.info(statsLine(stats));
        if (skipped.size) log.info(`Skipped unseen in the last hour: ${[...skipped].map(([k, v]) => `${k} ${v}`).join(', ')}.`);
        skipped.clear();
        const w = outbox.waiting();
        if (w) log.info(`${w} file(s) waiting to go to Bookr.`);
      }, 3600_000));
    },
    stop() { for (const t of timers) clearInterval(t); log.info(statsLine(stats)); },
  };
}
