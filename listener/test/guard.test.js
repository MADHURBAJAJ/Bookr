import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGuardInPlace, checkOutgoing, GuardError, guardedLogger, libraryDir, newStats, statsLine, topNode } from '../src/guard.js';

const me = { id: '919800000000:5@s.whatsapp.net', lid: '123456789:5@lid' };
const ok = (xml) => checkOutgoing(xml, me).ok;

test('reads the top tag of a frame as the library writes it', () => {
  assert.deepEqual(topNode("<receipt id='A' to='1@g.us' type='read'/>"), { tag: 'receipt', attrs: { id: 'A', to: '1@g.us', type: 'read' } });
  assert.deepEqual(topNode("<iq xmlns='w:g2' type='get'>\n\t<x/>\n</iq>"), { tag: 'iq', attrs: { xmlns: 'w:g2', type: 'get' } });
  assert.equal(topNode('garbage'), null);
  assert.equal(ok('garbage'), false);
});

test('messages and reactions never go out; only the library\'s notes to the reception phone itself', () => {
  assert.equal(ok("<message to='120363000000000001@g.us' type='text' id='1'>"), false);
  assert.equal(ok("<message to='919811111111@s.whatsapp.net' type='reaction' id='2'/>"), false);
  assert.equal(ok("<message to='919800000000@s.whatsapp.net' category='peer' type='protocol' id='3'/>"), true);
  assert.equal(ok("<message to='123456789@lid' category='peer' id='4'/>"), true);
  assert.equal(ok("<message to='919800000000@s.whatsapp.net' type='text' id='5'/>"), false, 'to own number but not a peer note');
  assert.equal(checkOutgoing("<message to='919800000000@s.whatsapp.net' category='peer'/>", {}).ok, false, 'own ids unknown');
});

test('read and played receipts never go out; delivery receipts do', () => {
  for (const t of ['read', 'read-self', 'played', 'played-self']) assert.equal(ok(`<receipt id='A' to='1@g.us' type='${t}'/>`), false, t);
  for (const t of ['inactive', 'sender', 'peer_msg', 'hist_sync', 'retry', 'server-error']) assert.equal(ok(`<receipt id='A' to='1@g.us' type='${t}'/>`), true, t);
  assert.equal(ok("<receipt id='A' to='1@g.us'/>"), true, 'plain delivered');
});

test('never online, typing or recording', () => {
  assert.equal(ok("<presence name='Reception' type='available'/>"), false);
  assert.equal(ok("<presence type='composing'/>"), false);
  assert.equal(ok("<presence name='Reception'/>"), false);
  assert.equal(ok("<presence name='Reception' type='unavailable'/>"), true);
  assert.equal(ok("<chatstate from='x' to='1@g.us'>\n\t<composing/>\n</chatstate>"), false);
});

test('no chat changes or settings; queries and protocol frames pass', () => {
  assert.equal(ok("<iq to='s.whatsapp.net' type='set' xmlns='w:sync:app:state'>\n\t<sync>\n\t\t<collection name='regular_low'>\n\t\t\t<patch>\n01\n</patch>"), false);
  assert.equal(ok("<iq to='s.whatsapp.net' type='set' xmlns='w:sync:app:state'>\n\t<sync>\n\t\t<collection name='regular_low' return_snapshot='false'/>"), true);
  for (const x of ['w:g2', 'privacy', 'status', 'w:profile:picture', 'blocklist', 'newsletter', 'md', 'spam']) {
    assert.equal(ok(`<iq type='set' xmlns='${x}'/>`), false, x);
  }
  assert.equal(ok("<iq type='get' xmlns='w:g2'/>"), true);
  assert.equal(ok("<iq type='set' xmlns='encrypt'/>"), true, 'uploading keys is part of staying connected');
  assert.equal(ok("<iq type='set' xmlns='passive'/>"), true);
  assert.equal(ok("<ack id='1' class='message'/>"), true);
});

test('the logger stops a forbidden frame by throwing, logs it, and counts both kinds', () => {
  const lines = [];
  const log = { debug() {}, info() {}, warn() {}, error: (m) => lines.push(m) };
  const stats = newStats();
  const logger = guardedLogger({ log, stats, me: () => me });
  assert.equal(logger.level, 'trace', 'the library shows frames only to a trace logger');
  assert.equal(logger.child({ class: 'x' }).level, 'trace');
  logger.trace({ xml: "<ack id='1'/>", msg: 'xml send' });
  logger.trace({ xml: "<receipt id='A' to='1@g.us' type='inactive'/>", msg: 'xml send' });
  assert.throws(() => logger.trace({ xml: "<presence type='available'/>", msg: 'xml send' }), GuardError);
  assert.throws(() => logger.child({}).trace({ xml: "<message to='1@g.us'/>", msg: 'xml send' }), GuardError);
  logger.trace({ something: 'else' }, 'other trace');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^BLOCKED presence \(available\)/);
  assert.equal(statsLine(stats), 'SENT to WhatsApp (protocol only): ack 1, receipt:inactive 1 | BLOCKED: presence (available) 1, sending a message or reaction 1');
  assert.equal(statsLine(stats), 'SENT to WhatsApp (protocol only): none | BLOCKED: none');
});

test('refuses to start when the installed library no longer sends every frame through the guarded function', () => {
  assertGuardInPlace();
  const tmp = mkdtempSync(join(tmpdir(), 'wa-guard-'));
  try {
    cpSync(join(libraryDir(), 'Socket'), join(tmp, 'Socket'), { recursive: true });
    assertGuardInPlace(tmp);
    const f = join(tmp, 'Socket', 'socket.js');
    writeFileSync(f, readFileSync(f, 'utf8').replace("msg: 'xml send'", "msg: 'sending'"));
    assert.throws(() => assertGuardInPlace(tmp), /cannot be put in place/);
    cpSync(join(libraryDir(), 'Socket', 'socket.js'), f);
    writeFileSync(join(tmp, 'Socket', 'chats.js'), readFileSync(join(tmp, 'Socket', 'chats.js'), 'utf8') + '\nsendRawMessage(x);\n');
    assert.throws(() => assertGuardInPlace(tmp), /chats\.js sends frames without sendNode/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
