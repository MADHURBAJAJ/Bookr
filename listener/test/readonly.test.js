// Proof that the listener never sends, reacts, marks as read or changes presence.
// 1. The real WhatsApp library, with our guard, asked to do each of those things: every one is stopped before it is
//    encoded, and a stand-in WhatsApp server receives nothing but the opening handshake.
// 2. Our own code never calls any sending function, and only the read-only parts of the connection are reachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import makeWASocket, { initAuthCreds } from 'baileys';
import { GuardError, guardedLogger, newStats, statsLine } from '../src/guard.js';
import { READ_ONLY_PARTS, readOnly, socketOptions, withoutOwnName } from '../src/whatsapp.js';

const here = dirname(fileURLToPath(import.meta.url));
const ME = '919800000000:5@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

async function fakeWhatsApp() {
  const frames = [];
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', (ws) => ws.on('message', (d) => frames.push(d.length)));
  await new Promise((r) => server.on('listening', r));
  return { frames, url: `ws://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A real library socket with a linked-looking login, our guard as its logger, connected to the stand-in server. */
async function guardedSocket(url, { ownName = false } = {}) {
  const creds = { ...initAuthCreds(), registered: true, me: { id: ME, name: 'Reception' } };
  const keys = { get: async () => ({}), set: async () => {} };
  const stats = newStats();
  const logger = guardedLogger({ log: quietLog, stats, me: () => creds.me });
  const sock = makeWASocket({
    ...socketOptions({ auth: { creds, keys }, logger }),
    waWebSocketUrl: url, connectTimeoutMs: 3000, defaultQueryTimeoutMs: 1000, fireInitQueries: false,
  });
  if (ownName) withoutOwnName(sock.ev, creds);
  sock.ev.on('connection.update', () => {});
  return { sock, stats, creds };
}

/** Waits until the stand-in server has the opening handshake, so it is never counted as a later frame. */
async function handshakeArrived(frames) {
  for (let i = 0; i < 100 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(frames.length > 0, 'the socket opened and sent its handshake');
  await new Promise((r) => setTimeout(r, 100));
}

/** Runs fn and returns the GuardError it was stopped with (sync throw or rejected promise), or the other outcome. */
async function outcome(fn) {
  try { await fn(); return 'went through'; } catch (e) { return e instanceof GuardError ? e : `other error: ${e.message}`; }
}

test('the real library is stopped from sending a message, a reaction, a read receipt, typing or online status', async () => {
  const wa = await fakeWhatsApp();
  const { sock, stats } = await guardedSocket(wa.url);
  await handshakeArrived(wa.frames);
  const before = wa.frames.length;
  stats.sent.clear();
  try {
    const tries = {
      'online status': () => sock.sendPresenceUpdate('available'),
      typing: () => sock.sendPresenceUpdate('composing', GROUP),
      'read receipt': () => sock.sendReceipt(GROUP, '919811111111@s.whatsapp.net', ['3EB0ABC'], 'read'),
      'read receipts (bulk)': () => sock.sendReceipts([{ remoteJid: GROUP, id: '3EB0ABD', participant: '919811111111@s.whatsapp.net' }], 'read'),
      'voice note played': () => sock.sendReceipt(GROUP, undefined, ['3EB0ABE'], 'played'),
      'a message': () => sock.sendNode({ tag: 'message', attrs: { to: GROUP, type: 'text', id: 'X1' }, content: [] }),
      'a reaction': () => sock.sendNode({ tag: 'message', attrs: { to: GROUP, type: 'reaction', id: 'X2' }, content: [] }),
      'marking a chat read': () => sock.sendNode({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'w:sync:app:state' },
        content: [{ tag: 'sync', attrs: {}, content: [{ tag: 'collection', attrs: { name: 'regular_low' }, content: [{ tag: 'patch', attrs: {}, content: new Uint8Array([1]) }] }] }] }),
      'leaving a group': () => sock.sendNode({ tag: 'iq', attrs: { to: GROUP, type: 'set', xmlns: 'w:g2' }, content: [{ tag: 'leave', attrs: {} }] }),
    };
    for (const [what, fn] of Object.entries(tries)) {
      const r = await outcome(fn);
      assert.ok(r instanceof GuardError, `${what}: expected the guard to stop it, got ${r}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    // What did reach the server is only what the guard let through: here the library's session telemetry ("ib"),
    // which it sends before trying to go online. Never a message, receipt, presence or typing frame.
    const passed = [...stats.sent];
    assert.deepEqual(passed.map(([k]) => k), ['ib']);
    assert.equal(wa.frames.length - before, passed.reduce((n, [, v]) => n + v, 0), 'every frame that reached the server was one the guard allowed');
    const afterForbidden = wa.frames.length;
    // A delivery receipt (what any linked device sends) and a query pass the guard and do reach the server: so the
    // count above would have caught anything that got through.
    for (const fn of [() => sock.sendReceipt(GROUP, undefined, ['3EB0ABF'], 'inactive'),
      () => sock.sendNode({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:g2', id: 'Q1' }, content: [] })]) {
      const r = await outcome(fn);
      assert.ok(!(r instanceof GuardError), `allowed frame was blocked: ${r?.kind}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(wa.frames.length, afterForbidden + 2, 'the two allowed frames arrived');
    const line = statsLine(stats);
    assert.match(line, /BLOCKED: .*sending a message or reaction 2/);
    assert.match(line, /read receipt \(read\) 2/);
    assert.match(line, /presence \(available\) 1/);
    assert.match(line, /typing or recording 1/);
  } finally {
    sock.end(undefined);
    await wa.close();
  }
});

test('the guard lets the library ask the reception phone itself for a missing message, and nothing else', async () => {
  const wa = await fakeWhatsApp();
  const { sock } = await guardedSocket(wa.url);
  await handshakeArrived(wa.frames);
  try {
    const own = await outcome(() => sock.sendNode({ tag: 'message', attrs: { to: '919800000000@s.whatsapp.net', category: 'peer', type: 'protocol', id: 'P1' }, content: [] }));
    assert.ok(!(own instanceof GuardError));
    const other = await outcome(() => sock.sendNode({ tag: 'message', attrs: { to: '919811111111@s.whatsapp.net', category: 'peer', type: 'protocol', id: 'P2' }, content: [] }));
    assert.ok(other instanceof GuardError);
  } finally {
    sock.end(undefined);
    await wa.close();
  }
});

test("a message from the reception phone itself does not make the library announce its name (shown as online)", async () => {
  // The library, on a message from its own number, emits a creds update with the profile name and then sends a
  // <presence name=…> frame. Without withoutOwnName the guard has to stop that frame by throwing in the middle of
  // handling the message, and the photo is lost (seen on the test number, 24 Nov 2026).
  const name = { me: { id: ME, name: 'Reception desk' } };
  const plain = await fakeWhatsApp();
  const bare = await guardedSocket(plain.url);
  await handshakeArrived(plain.frames);
  try {
    assert.throws(() => bare.sock.ev.emit('creds.update', name), GuardError);
  } finally {
    bare.sock.end(undefined);
    await plain.close();
  }

  const wa = await fakeWhatsApp();
  const { sock, stats, creds } = await guardedSocket(wa.url, { ownName: true });
  await handshakeArrived(wa.frames);
  const before = wa.frames.length;
  try {
    assert.equal(creds.me.name, undefined, 'a saved name is dropped before connecting');
    let seen;
    sock.ev.on('creds.update', (u) => { seen = u; });
    assert.doesNotThrow(() => sock.ev.emit('creds.update', name));
    assert.doesNotThrow(() => sock.ev.emit('creds.update', { me: { id: ME, name: 'Someone else' } }));
    assert.deepEqual(seen, { me: { id: ME } }, 'the update still goes through, without the name');
    // With no name, the library's own online and offline announcements return early too.
    await sock.sendPresenceUpdate('available');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(stats.blocked.size, 0);
    assert.equal(wa.frames.length, before, 'nothing reached the server');
  } finally {
    sock.end(undefined);
    await wa.close();
  }
});

test('the socket is set up never to go online and not to download chat history', () => {
  const o = socketOptions({ auth: {}, logger: {} });
  assert.equal(o.markOnlineOnConnect, false);
  assert.equal(o.syncFullHistory, false);
  assert.equal(o.shouldSyncHistoryMessage(), false);
  assert.equal(o.generateHighQualityLinkPreview, false);
});

test('only the read-only parts of the connection reach the listener', () => {
  const calls = [];
  const fake = new Proxy({ user: { id: ME } }, { get: (t, p) => (p in t ? t[p] : (...a) => calls.push([p, a])) });
  const ro = readOnly(fake);
  assert.deepEqual(Object.keys(ro).sort(), [...READ_ONLY_PARTS].sort());
  assert.ok(Object.isFrozen(ro));
  for (const name of ['sendMessage', 'readMessages', 'sendPresenceUpdate', 'sendReceipt', 'chatModify', 'sendNode', 'relayMessage']) {
    assert.equal(ro[name], undefined, name);
  }
});

test("the listener's own code never calls a sending function", () => {
  const forbidden = /\.(sendMessage|relayMessage|readMessages|sendReceipts?|sendPresenceUpdate|presenceSubscribe|chatModify|star|sendNode|sendRawMessage|query|sendMessageAck|sendRetryRequest|requestPairingCode|logout|groupLeave|groupParticipantsUpdate|groupUpdateSubject|groupUpdateDescription|groupSettingUpdate|updateProfile\w*|updateBlockStatus|updateLastSeenPrivacy|updateOnlinePrivacy|updateReadReceiptsPrivacy|newsletter\w*|rejectCall|sendPeerDataOperationMessage|fetchMessageHistory|requestPlaceholderResend)\s*\(/;
  const dir = join(here, '..', 'src');
  let dailySends = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const code = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    code.forEach((line, i) => {
      // The one exception (25 Nov 2026, the owner's choice): the morning Daily check PDF, to the owner's number only.
      if (f === 'whatsapp.js' && /\/\/ DAILY-CHECK-SEND$/.test(line)) {
        dailySends += 1;
        assert.match(line, /openSock\.sendMessage\(`\$\{cfg\.daily\.to\}@s\.whatsapp\.net`, \{ document: pdf, mimetype: 'application\/pdf', fileName, caption \}\)/);
        return;
      }
      assert.doesNotMatch(line, forbidden, `${f}:${i + 1} ${line.trim()}`);
    });
  }
  assert.equal(dailySends, 1, 'exactly one sending line: the Daily check to the owner');
});
