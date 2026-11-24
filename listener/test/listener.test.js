import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createListener } from '../src/listener.js';
import { newStats } from '../src/guard.js';
import { pick, phoneOf } from '../src/media.js';
import { classify, fileType } from '../src/bookr.js';
import { backoff } from '../src/outbox.js';
import { parseEnv, parseGroupsFile } from '../src/config.js';
import { checkLogs } from '../src/check-log.js';

const READ = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
let n = 0;

const photo = (over = {}) => ({
  key: { remoteJid: READ, id: `3EB0${++n}`, participant: '919811111111@s.whatsapp.net', fromMe: false, ...over.key },
  pushName: 'Ravi',
  messageTimestamp: 1_795_500_000,
  message: over.message ?? { imageMessage: { mimetype: 'image/jpeg', fileLength: 120_000, caption: '2611241', contextInfo: { stanzaId: 'PREV1' } } },
});

function setup({ answers = [], localGroups = null, dir } = {}) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'wa-listener-'));
  const lines = [];
  const log = { debug() {}, info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`) };
  const sent = [];
  const downloaded = [];
  const queue = [...answers];
  const bookr = {
    async heartbeat(body) { sent.push(['heartbeat', body]); return { status: 200, body: { ok: true, readGroups: [READ] } }; },
    async ingest(meta, bytes) {
      sent.push(['ingest', meta, bytes.length]);
      const a = queue.shift() ?? { status: 201, body: { stored: true, id: 'x' } };
      if (a instanceof Error) throw a;
      return a;
    },
  };
  let t = 1_800_000_000_000;
  const listener = createListener({
    cfg: { dataDir, localGroups }, log, bookr, stats: newStats(),
    download: async (msg) => { downloaded.push(msg.key.id); return JPEG; },
    now: () => t, rand: () => 0.5, wait: async () => {},
  });
  return { listener, sent, downloaded, lines, dataDir, advance: (ms) => { t += ms; }, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}
const settle = async (l) => { await l.runDownloads(); await new Promise((r) => setImmediate(r)); };

test('keeps only photos and PDFs from groups Bookr reads, decided before downloading', () => {
  const reads = (g) => g === READ;
  const me = { id: '919800000000:5@s.whatsapp.net', name: 'Reception' };
  const r = pick(photo(), { reads, me, groupName: () => 'Guest payment' });
  assert.equal(r.keep, true);
  assert.deepEqual(r.meta, {
    messageId: r.meta.messageId, groupId: READ, groupName: 'Guest payment', senderNumber: '919811111111', senderName: 'Ravi',
    sentAt: 1_795_500_000_000, mediaType: 'image', caption: '2611241', replyTo: 'PREV1',
  });
  const why = (m) => pick(m, { reads, me }).why;
  assert.equal(why(photo({ key: { remoteJid: '919811111111@s.whatsapp.net' } })), 'not a group');
  assert.equal(why(photo({ key: { remoteJid: OTHER } })), 'group not read');
  assert.equal(why(photo({ message: { conversation: 'hello' } })), 'not a photo or PDF');
  assert.equal(why(photo({ message: { videoMessage: { mimetype: 'video/mp4' } } })), 'not a photo or PDF');
  assert.equal(why(photo({ message: { stickerMessage: {} } })), 'not a photo or PDF');
  assert.equal(why(photo({ message: { audioMessage: { ptt: true } } })), 'not a photo or PDF');
  assert.equal(why(photo({ message: { documentMessage: { mimetype: 'application/vnd.ms-excel' } } })), 'not a photo or PDF');
  assert.equal(why(photo({ message: { imageMessage: { fileLength: 11 * 1024 * 1024 } } })), 'larger than 10 MB');
  const pdf = pick(photo({ message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', caption: 'bill 26112376' } } } } }), { reads, me });
  assert.equal(pdf.keep, true);
  assert.equal(pdf.meta.mediaType, 'document');
  assert.equal(pdf.meta.caption, 'bill 26112376');
  // Sent from the reception phone itself: the number and name are the reception's own.
  const own = pick(photo({ key: { fromMe: true, participant: undefined } }), { reads, me });
  assert.equal(own.meta.senderNumber, '919800000000');
  assert.equal(own.meta.senderName, 'Reception');
  // A private group id (@lid) with the phone number alongside; and with no number at all.
  assert.equal(pick(photo({ key: { participant: '1234567@lid', participantAlt: '919822222222@s.whatsapp.net' } }), { reads, me }).meta.senderNumber, '919822222222');
  assert.equal(pick(photo({ key: { participant: '1234567@lid' } }), { reads, me }).meta.senderNumber, undefined);
  assert.equal(phoneOf('919800000000:12@s.whatsapp.net'), '919800000000');
});

test('a kept photo is downloaded once, kept on disk and sent to Bookr; skipped ones are never downloaded', async () => {
  const s = setup();
  try {
    await s.listener.heartbeat();
    const a = photo();
    s.listener.onMessages([a, a, photo({ key: { remoteJid: OTHER } }), photo({ key: { remoteJid: '919811111111@s.whatsapp.net' } }),
      photo({ message: { conversation: 'hi' } })]);
    await settle(s.listener);
    assert.deepEqual(s.downloaded, [a.key.id]);
    await s.listener.sendDue();
    const ingests = s.sent.filter(([k]) => k === 'ingest');
    assert.equal(ingests.length, 1);
    assert.equal(ingests[0][1].messageId, a.key.id);
    assert.equal(s.listener.lastMessageAt, 1_795_500_000_000);
    // The same message again (WhatsApp sends it again after a reconnect): not downloaded or sent again.
    s.listener.onMessages([a]);
    await settle(s.listener);
    await s.listener.sendDue();
    assert.equal(s.downloaded.length, 1);
    assert.equal(s.sent.filter(([k]) => k === 'ingest').length, 1);
    assert.equal(s.listener.outbox.waiting(), 0);
  } finally { s.done(); }
});

test('tries again later when Bookr is down; keeps a refused file aside; waits on a wrong secret', async () => {
  const s = setup({ answers: [new Error('fetch failed'), { status: 502, body: null }, { status: 201, body: { stored: true } },
    { status: 415, body: { error: 'Only JPEG, PNG and PDF files are kept.' } },
    { status: 401, body: { error: 'Wrong or missing listener secret.' } }, { status: 200, body: { stored: false, reason: 'same_file' } }] });
  try {
    await s.listener.heartbeat();
    const a = photo();
    s.listener.onMessages([a]);
    await settle(s.listener);
    await s.listener.sendDue();            // network error
    await s.listener.sendDue();            // not due yet: nothing sent
    assert.equal(s.sent.filter(([k]) => k === 'ingest').length, 1);
    s.advance(60_000);
    await s.listener.sendDue();            // 502
    s.advance(120_000);
    await s.listener.sendDue();            // 201
    assert.equal(s.listener.outbox.waiting(), 0);

    const b = photo();
    s.listener.onMessages([b]);
    await settle(s.listener);
    await s.listener.sendDue();            // 415: for good
    assert.equal(s.listener.outbox.waiting(), 0);
    assert.deepEqual(readdirSync(join(s.dataDir, 'failed')).sort(), [`${b.key.id}.bin`, `${b.key.id}.json`]);

    const c = photo();
    s.listener.onMessages([c]);
    await settle(s.listener);
    await s.listener.sendDue();            // 401: set-up problem, kept, tried in 5 minutes
    assert.equal(s.listener.outbox.waiting(), 1);
    assert.ok(s.lines.some((l) => /ERROR Bookr refused the secret/.test(l)));
    s.advance(5 * 60_000);
    await s.listener.sendDue();            // 200 same_file: done
    assert.equal(s.listener.outbox.waiting(), 0);
  } finally { s.done(); }
});

test('files kept while Bookr was out of reach are sent after a restart (catch-up)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-listener-'));
  const first = setup({ dir, answers: [new Error('offline')] });
  await first.listener.heartbeat();
  const a = photo();
  first.listener.onMessages([a]);
  await settle(first.listener);
  await first.listener.sendDue();
  assert.equal(first.listener.outbox.waiting(), 1);
  // The PC restarts: a new listener on the same folder sends it, and does not take the same message twice.
  const second = setup({ dir });
  second.advance(10 * 60_000);
  await second.listener.sendDue();
  assert.equal(second.sent.filter(([k]) => k === 'ingest').length, 1);
  second.listener.onMessages([a]);
  await settle(second.listener);
  assert.equal(second.downloaded.length, 0);
  second.done();
});

test('the group list comes from Bookr, kept for a start without internet, and GROUPS_FILE can only narrow it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-listener-'));
  const s = setup({ dir });
  assert.equal(s.listener.reads(READ), false, 'nothing is read before Bookr has said which groups');
  await s.listener.heartbeat();
  assert.equal(s.listener.reads(READ), true);
  assert.equal(s.listener.reads(OTHER), false);
  const restarted = setup({ dir });
  assert.equal(restarted.listener.reads(READ), true, 'kept from last time');
  const narrowed = setup({ dir, localGroups: new Set([OTHER]) });
  assert.equal(narrowed.listener.reads(READ), false);
  assert.equal(narrowed.listener.reads(OTHER), false, 'a local file cannot add a group Bookr does not read');
  rmSync(dir, { recursive: true, force: true });
});

test('small helpers: answers, file types, waits, settings', () => {
  assert.deepEqual([200, 201, 400, 401, 403, 408, 413, 415, 429, 500, 503].map(classify),
    ['done', 'done', 'fail', 'setup', 'setup', 'wait', 'fail', 'fail', 'wait', 'wait', 'setup']);
  assert.equal(fileType(JPEG), 'image/jpeg');
  assert.equal(fileType(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.deepEqual([0, 1, 2, 10].map((t) => backoff(t, () => 0.5)), [30_000, 60_000, 120_000, 1_800_000]);
  assert.deepEqual(parseEnv('# note\nBOOKR_URL="https://x.y"\r\nBOOKR_SECRET=abc=def\n\nBAD'), { BOOKR_URL: 'https://x.y', BOOKR_SECRET: 'abc=def' });
  assert.deepEqual([...parseGroupsFile(`${READ}   # Guest payment\nnot-a-group\n# ${OTHER}\n`)], [READ]);
});

test('the log check passes clean logs and catches anything forbidden', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-logs-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'listener-2026-11-24.log'), [
      '2026-11-24 10:00:00 INFO  SENT to WhatsApp (protocol only): ack 12, iq:w:g2 1, receipt:inactive 6 | BLOCKED: none',
      '2026-11-24 11:00:00 INFO  SENT to WhatsApp (protocol only): none | BLOCKED: none',
    ].join('\n'));
    let r = checkLogs(dir);
    assert.equal(r.hours, 2);
    assert.equal(r.sent.get('receipt:inactive'), 6);
    assert.deepEqual([r.bad, r.blocked], [[], []]);
    writeFileSync(join(dir, 'listener-2026-11-25.log'), [
      '2026-11-25 09:00:00 ERROR BLOCKED read receipt (read): the WhatsApp library tried to send it; it was stopped and not sent.',
      '2026-11-25 10:00:00 INFO  SENT to WhatsApp (protocol only): receipt:read 1 | BLOCKED: read receipt (read) 1',
    ].join('\n'));
    r = checkLogs(dir);
    assert.deepEqual(r.bad, ['receipt:read']);
    assert.equal(r.blocked.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
