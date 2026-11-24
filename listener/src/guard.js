// The send guard. The listener is read-only: it never sends a message or a reaction, never marks anything read, and never
// shows the reception number as online or typing. Our own code never calls any of those (see test/readonly.test.js), and
// this guard stops the WhatsApp library itself from doing so.
//
// How: every frame the library sends to WhatsApp after the login handshake goes through one function, sendNode
// (node_modules/baileys/lib/Socket/socket.js), which first hands the frame to the logger as { msg: 'xml send', xml }. Our
// logger looks at each frame there and throws before it is encoded when it is one of the forbidden kinds, so it is never
// sent. assertGuardInPlace() checks at start-up that the installed library still works this way; if a library update
// changes it, the listener refuses to start rather than run unguarded.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class GuardError extends Error {
  constructor(kind) {
    super(`Blocked: the listener never sends to WhatsApp (${kind}).`);
    this.name = 'GuardError';
    this.kind = kind;
  }
}

/** Receipts that tell the sender a message was read or a voice note played. Delivery receipts are allowed. */
const READ_RECEIPTS = new Set(['read', 'read-self', 'played', 'played-self']);
/** Settings and admin actions (type="set"): groups, privacy, about, profile photo, blocking, channels, business, devices, reports. */
const CHANGES = new Set(['w:g2', 'privacy', 'status', 'w:profile:picture', 'blocklist', 'newsletter', 'w:biz', 'md', 'spam', 'w:mex']);

/** The top tag and its attributes, from the library's text form of a frame: <tag a='1' b='2'> or <tag a='1'/>. */
export function topNode(xml) {
  const m = /^<([\w:.-]+)((?:\s+[\w:.-]+='[^']*')*)\s*\/?>/.exec(String(xml).trimStart());
  if (!m) return null;
  const attrs = {};
  for (const a of m[2].matchAll(/([\w:.-]+)='([^']*)'/g)) attrs[a[1]] = a[2];
  return { tag: m[1], attrs };
}

/** The phone number or id part of a WhatsApp id: 919800000000:12@s.whatsapp.net → 919800000000. */
const userOf = (jid) => String(jid ?? '').split('@')[0].split(':')[0];

/**
 * Whether a frame may go to WhatsApp. Returns { ok: true, kind } or { ok: false, kind }.
 * `me` is the linked number's own ids ({ id, lid }), for the library's housekeeping messages to its own phone.
 */
export function checkOutgoing(xml, me = {}) {
  const node = topNode(xml);
  if (!node) return { ok: false, kind: 'unreadable frame' };
  const { tag, attrs } = node;
  switch (tag) {
    case 'message': {
      // The only message allowed: the library asking our own phone for something (a message it could not decrypt, a
      // missing key). It goes to the reception phone itself, category "peer", and nobody sees it.
      const own = [me.id, me.lid].filter(Boolean).map(userOf);
      if (attrs.category === 'peer' && own.includes(userOf(attrs.to))) return { ok: true, kind: 'message:to-own-phone' };
      return { ok: false, kind: 'sending a message or reaction' };
    }
    case 'receipt':
      if (READ_RECEIPTS.has(attrs.type)) return { ok: false, kind: `read receipt (${attrs.type})` };
      return { ok: true, kind: `receipt:${attrs.type || 'delivered'}` };
    case 'presence':
      // "unavailable" keeps the number offline (as a closed WhatsApp Web tab is); anything else would show it online.
      if (attrs.type === 'unavailable') return { ok: true, kind: 'presence:unavailable' };
      return { ok: false, kind: `presence (${attrs.type || 'available'})` };
    case 'chatstate':
      return { ok: false, kind: 'typing or recording' };
    case 'iq':
      // A chat change (mark read or unread, archive, mute, pin, delete) is an app-state patch.
      if (attrs.xmlns === 'w:sync:app:state' && /<patch[\s/>]/.test(xml)) return { ok: false, kind: 'changing a chat (read, archive, mute)' };
      if (attrs.type === 'set' && CHANGES.has(attrs.xmlns)) return { ok: false, kind: `changing a setting (${attrs.xmlns})` };
      return { ok: true, kind: `iq:${attrs.xmlns || '?'}` };
    default:
      return { ok: true, kind: tag };
  }
}

/** Counts of what was sent and blocked, for the hourly line in the log (the log check reads it). */
export function newStats() {
  return { sent: new Map(), blocked: new Map() };
}
const bump = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);

/**
 * The logger handed to the WhatsApp library. It must report level "trace" so the library shows it every frame it
 * sends. The library's own warnings and errors go to our log as short text (never message contents).
 */
export function guardedLogger({ log, stats, me }) {
  const text = (obj, msg) => {
    if (typeof obj === 'string') return obj;
    const err = obj?.err ?? obj?.error;
    return [msg, err?.message ?? (typeof err === 'string' ? err : '')].filter(Boolean).join(': ').slice(0, 300);
  };
  const make = () => ({
    level: 'trace',
    child: () => make(),
    trace(obj) {
      if (obj && typeof obj === 'object' && obj.msg === 'xml send') {
        const r = checkOutgoing(obj.xml, me());
        if (!r.ok) {
          bump(stats.blocked, r.kind);
          log.error(`BLOCKED ${r.kind}: the WhatsApp library tried to send it; it was stopped and not sent.`);
          throw new GuardError(r.kind);
        }
        bump(stats.sent, r.kind);
      }
    },
    debug() {},
    info() {},
    warn(obj, msg) { log.debug(`library: ${text(obj, msg)}`); },
    error(obj, msg) { log.warn(`library: ${text(obj, msg)}`); },
    fatal(obj, msg) { log.error(`library: ${text(obj, msg)}`); },
  });
  return make();
}

/** One log line of what went to WhatsApp since the last line; empties the counts. */
export function statsLine(stats) {
  const fmt = (m) => [...m].sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const line = `SENT to WhatsApp (protocol only): ${fmt(stats.sent)} | BLOCKED: ${fmt(stats.blocked)}`;
  stats.sent.clear();
  stats.blocked.clear();
  return line;
}

/** The installed library's folder (node_modules/baileys/lib). */
export function libraryDir() {
  return dirname(fileURLToPath(import.meta.resolve('baileys')));
}

/**
 * Checks that the installed library sends every frame through sendNode, and that sendNode shows the frame to the
 * logger first. Throws when not: the listener must not connect unguarded.
 */
export function assertGuardInPlace(dir = libraryDir()) {
  const socketDir = join(dir, 'Socket');
  const socket = readFileSync(join(socketDir, 'socket.js'), 'utf8');
  const sendNode = /const sendNode = \(frame\) => \{\s*if \(logger\.level === 'trace'\) \{\s*logger\.trace\(\{ xml: binaryNodeToString\(frame\), msg: 'xml send' \}\);\s*\}\s*const buff = encodeBinaryNode\(frame\);\s*return sendRawMessage\(buff\);/;
  const problems = [];
  if (!sendNode.test(socket)) problems.push('sendNode no longer shows each frame to the logger');
  if ((socket.match(/encodeBinaryNode\(/g) ?? []).length !== 1) problems.push('socket.js encodes frames outside sendNode');
  for (const f of readdirSync(socketDir).filter((n) => n.endsWith('.js') && n !== 'socket.js')) {
    const src = readFileSync(join(socketDir, f), 'utf8');
    if (/encodeBinaryNode\(|sendRawMessage\(|\bws\.send\(/.test(src)) problems.push(`${f} sends frames without sendNode`);
  }
  if (problems.length) {
    throw new Error(`The send guard cannot be put in place on this version of the WhatsApp library (${problems.join('; ')}). `
      + 'Keep the version pinned in package.json, or update src/guard.js for the new version.');
  }
}
