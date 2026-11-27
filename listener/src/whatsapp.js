// The connection to WhatsApp, as a linked device of the reception number. Read-only: the rest of the listener gets only
// the read-only view below (readOnly), and src/guard.js stops the library itself from sending anything else.

import { existsSync, rmSync } from 'node:fs';
import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState,
} from 'baileys';
import { createRequire } from 'node:module';
import qrcode from 'qrcode-terminal';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

/** The QR as rows of 0 and 1 (1 = dark), for the POS to draw. Exported for the test. */
export function qrRows(text) {
  const q = new QRCode(-1, QRErrorCorrectLevel.L);
  q.addData(text);
  q.make();
  return q.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
}

/** The last 4 digits of the linked number, from its WhatsApp id (919876543210:12@s.whatsapp.net). */
export function last4(id) {
  const digits = String(id ?? '').split(':')[0].split('@')[0].replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** How long a link asked for from the POS stays open for scanning. */
export const LINK_MS = 3 * 60_000;

/**
 * The only parts of the WhatsApp connection the listener uses: events in, the linked number's own ids, the list of its
 * groups, a request for an expired photo to be uploaded again, and closing. Nothing that sends, reacts, marks read or
 * changes presence is reachable from here (test/readonly.test.js checks this list and the source).
 */
export const READ_ONLY_PARTS = ['ev', 'user', 'groupFetchAllParticipating', 'updateMediaMessage', 'end'];
export function readOnly(sock) {
  return Object.freeze({
    ev: sock.ev,
    user: () => sock.user ?? {},
    groupFetchAllParticipating: () => sock.groupFetchAllParticipating(),
    updateMediaMessage: (m) => sock.updateMediaMessage(m),
    end: () => sock.end(undefined),
  });
}

/** The socket settings: never online, no history download, no link previews. Exported for the test. */
export function socketOptions({ version, auth, logger }) {
  return {
    ...(version ? { version } : {}),
    auth,
    logger,
    browser: Browsers.windows('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    emitOwnEvents: false,
    getMessage: async () => undefined,
  };
}

/**
 * Keeps the library from ever learning the linked number's own profile name. When a message comes from the reception
 * phone itself, the library reads its name and announces it with a presence frame, which WhatsApp takes as "online".
 * The guard would stop that frame, but by throwing in the middle of handling the message, so the photo would be lost.
 * Without a name the library never builds that frame (and its online and offline announcements return early).
 * Applied before the connection opens; the name is never used by the listener.
 */
export function withoutOwnName(ev, creds) {
  if (creds.me) delete creds.me.name;
  const emit = ev.emit.bind(ev);
  ev.emit = (event, data) => {
    if (event === 'creds.update' && data?.me && 'name' in data.me) {
      const { name, ...me } = data.me;
      data = { ...data, me };
    }
    return emit(event, data);
  };
  return ev;
}

/**
 * Keeps the connection up. mode 'link' shows the QR to scan and stops once linked; mode 'run' never shows a QR by itself
 * (at boot nobody is there to scan it): when not linked it says so in the log and in the heartbeat, and waits.
 * In mode 'run' the Owner can link, switch or unlink from the POS (27 Nov 2026): Bookr passes the request on in the
 * heartbeat answer and main.js calls link(id) or unlink(id) below. A link sends the QR to Bookr for 3 minutes.
 * Switching does not log the old number out (that would be a message to WhatsApp): this PC forgets its login, and the
 * old phone still lists it under Linked devices until removed there.
 */
export async function runWhatsApp({ cfg, log, logger, listener, mode = 'run', onLinked = () => {}, onReady = () => {}, permit = null }) {
  let retry = 0;
  let stopped = false;
  /** Each connection belongs to one generation; a link or unlink starts a new one, and the old one's events and timers are ignored. */
  let gen = 0;
  /** A link asked for from the POS: { id, timer }; and the requests already finished, never started again. */
  let linking = null;
  const ended = new Set();
  const finish = (id) => { ended.add(id); if (ended.size > 50) ended.delete(ended.values().next().value); };
  let current = null;
  /** The open connection's full socket: kept here, never handed to the listener; used only by sendDailyCheck below. */
  let openSock = null;
  /** The linked number's ids from the saved login (known before the connection opens). */
  let creds = null;

  const version = await Promise.race([
    fetchLatestBaileysVersion().then((r) => r.version).catch(() => undefined),
    new Promise((r) => setTimeout(() => r(undefined), 10_000)),
  ]);

  const later = (fn, ms) => { const g = gen; setTimeout(() => { if (g === gen) fn(); }, ms); };

  async function connect() {
    if (stopped) return;
    const myGen = gen;
    const { state, saveCreds } = await useMultiFileAuthState(cfg.authDir);
    if (myGen !== gen) return;
    creds = state.creds;
    listener.setLinked?.(last4(state.creds.me?.id));
    if (!state.creds.me?.id && mode === 'run' && !linking) {
      listener.setState('not_linked');
      log.error('This PC is not linked to WhatsApp. Stop the listener task, run "npm run link" and scan the QR with the reception phone.');
      later(() => void connect(), 5 * 60_000);
      return;
    }
    listener.setState('connecting');
    const sock = makeWASocket(socketOptions({ version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger }));
    withoutOwnName(sock.ev, state.creds);
    const ro = readOnly(sock);
    current = ro;

    sock.ev.on('creds.update', (...a) => { if (myGen === gen) return saveCreds(...a); });
    sock.ev.on('connection.update', (u) => {
      if (myGen !== gen) {   // a connection from before a link or unlink: only let go of it
        if (u.connection === 'close') { if (openSock === sock) openSock = null; if (current === ro) { current = null; listener.detach(); } }
        return;
      }
      if (u.qr && mode === 'link') {
        listener.setState('waiting_for_qr');
        console.log('\nOn the reception phone: WhatsApp → Settings → Linked devices → Link a device, then scan:\n');
        qrcode.generate(u.qr, { small: true });
      }
      if (u.qr && linking) {
        listener.setState('waiting_for_qr');
        listener.linkProgress(linking.id, qrRows(u.qr));
        log.info('New QR sent to Bookr for the POS: scan it with the phone to link.');
      }
      if (u.connection === 'open') {
        retry = 0;
        openSock = sock;
        listener.setState('connected');
        listener.attach(ro);
        const me = ro.user();
        listener.setLinked?.(last4(me.id ?? creds?.me?.id));
        log.info(`Connected to WhatsApp as ${String(me.id ?? '').split(':')[0].split('@')[0] || 'the linked number'} (read-only).`);
        if (linking) {
          const { id, timer } = linking;
          clearTimeout(timer);
          linking = null;
          finish(id);
          log.info('Linked from the POS.');
          listener.linkDone(id, 'linked');
        } else void listener.heartbeat();
        if (mode === 'link') onLinked();
      }
      if (u.connection === 'close') {
        if (openSock === sock) openSock = null;
        listener.detach();
        if (current === ro) current = null;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (stopped) return;
        if (code === DisconnectReason.loggedOut) {
          listener.setState('logged_out');
          log.error('WhatsApp logged this PC out (unlinked on the phone, or not connected for about two weeks). '
            + 'The old login was removed. Stop the listener task, run "npm run link" and scan the QR again.');
          if (existsSync(cfg.authDir)) rmSync(cfg.authDir, { recursive: true, force: true });
          listener.setLinked?.(null);
          if (mode === 'run' && !linking) later(() => void connect(), 5 * 60_000);
          else void connect();
          return;
        }
        // 515 (restart required) comes right after a QR scan: connect again at once.
        const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(5_000 * 2 ** retry, 5 * 60_000);
        retry += 1;
        listener.setState('reconnecting');
        log.warn(`WhatsApp connection closed (${code ?? 'no code'}); connecting again in ${Math.round(wait / 1000)} s.`);
        later(() => void connect().catch((e) => log.error(`connect: ${e.message}`)), wait);
      }
    });
    if (mode === 'run') {
      sock.ev.on('messages.upsert', ({ messages }) => listener.onMessages(messages));
      sock.ev.on('groups.upsert', (list) => listener.onGroups(list));
      sock.ev.on('groups.update', (list) => listener.onGroups(list));
    }
  }

  // Set before the first connection, so a library frame sent while connecting already has the ids to check against.
  /** Ends the connection now, forgets this PC's login, and starts a new generation. Sends nothing to WhatsApp. */
  function forget() {
    gen += 1;
    const old = current;
    current = null;
    openSock = null;
    listener.detach();
    try { old?.end(); } catch { /* already closed */ }
    if (existsSync(cfg.authDir)) rmSync(cfg.authDir, { recursive: true, force: true });
    creds = null;
    listener.setLinked?.(null);
  }

  const handle = {
    stop() { stopped = true; if (linking) clearTimeout(linking.timer); current?.end(); },
    /** Link a number from the POS (request id): forget the number linked now, if any, and send the QR to Bookr for 3 minutes. */
    link(id) {
      if (linking?.id === id || ended.has(id) || stopped) return;
      if (linking) clearTimeout(linking.timer);
      log.info('The Owner asked from the POS to link a WhatsApp number: forgetting the present login and asking WhatsApp for a QR.');
      forget();
      const timer = setTimeout(() => handle.endLink(id, 'expired'), LINK_MS);
      linking = { id, timer };
      void connect().catch((e) => log.error(`connect: ${e.message}`));
    },
    /** A link not scanned in time, or cancelled in the POS: stop asking for QRs; this PC stays unlinked. */
    endLink(id, result) {
      if (!linking || linking.id !== id) return;
      clearTimeout(linking.timer);
      linking = null;
      finish(id);
      forget();
      listener.setState('not_linked');
      log.info(result === 'expired' ? 'Nobody scanned the QR in 3 minutes: not linked.' : 'Linking cancelled in the POS: not linked.');
      listener.linkDone(id, result);
    },
    /** Unlink from the POS: forget the login and stop reading. */
    unlink(id) {
      if (ended.has(id)) return;
      finish(id);
      if (linking) { clearTimeout(linking.timer); finish(linking.id); linking = null; }
      log.info('The Owner unlinked the WhatsApp number from the POS: this PC forgets its login and stops reading.');
      forget();
      listener.setState('not_linked');
      listener.linkDone(id, 'unlinked');
    },
    /** The link being worked on, if any. */
    linkingId: () => linking?.id ?? null,
    /** Downloads one kept photo or file (asks the sender's phone to upload it again when WhatsApp's copy has expired). */
    download(msg) {
      const ro = current;
      return downloadMediaMessage(msg, 'buffer', {}, ro ? { logger, reuploadRequest: ro.updateMediaMessage } : undefined);
    },
    me: () => ({ id: creds?.me?.id, lid: creds?.me?.lid, name: creds?.me?.name }),
    canSend: () => !!(openSock && cfg.daily && permit),
    /**
     * The one message the listener sends (25 Nov 2026, the owner's choice): the morning Daily check PDF to the owner's
     * own number. The guard lets it through only while its permit is open, to that number, for 90 seconds.
     */
    async sendDailyCheck(pdf, fileName, caption) {
      if (!openSock || !cfg.daily || !permit) throw new Error('not connected to WhatsApp');
      permit.open(cfg.daily.to);
      try {
        await openSock.sendMessage(`${cfg.daily.to}@s.whatsapp.net`, { document: pdf, mimetype: 'application/pdf', fileName, caption }); // DAILY-CHECK-SEND
      } finally {
        setTimeout(() => permit.close(), 15_000);   // the token WhatsApp asks for right after the message
      }
    },
  };
  onReady(handle);
  await connect();
  return handle;
}
