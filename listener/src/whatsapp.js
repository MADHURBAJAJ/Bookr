// The connection to WhatsApp, as a linked device of the reception number. Read-only: the rest of the listener gets only
// the read-only view below (readOnly), and src/guard.js stops the library itself from sending anything else.

import { existsSync, rmSync } from 'node:fs';
import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState,
} from 'baileys';
import qrcode from 'qrcode-terminal';

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
 * Keeps the connection up. mode 'link' shows the QR to scan and stops once linked; mode 'run' never shows a QR (at
 * boot nobody is there to scan it): when not linked it says so in the log and in the heartbeat, and waits.
 */
export async function runWhatsApp({ cfg, log, logger, listener, mode = 'run', onLinked = () => {}, onReady = () => {} }) {
  let retry = 0;
  let stopped = false;
  let current = null;
  /** The linked number's ids from the saved login (known before the connection opens). */
  let creds = null;

  const version = await Promise.race([
    fetchLatestBaileysVersion().then((r) => r.version).catch(() => undefined),
    new Promise((r) => setTimeout(() => r(undefined), 10_000)),
  ]);

  async function connect() {
    if (stopped) return;
    const { state, saveCreds } = await useMultiFileAuthState(cfg.authDir);
    creds = state.creds;
    if (!state.creds.me?.id && mode === 'run') {
      listener.setState('not_linked');
      log.error('This PC is not linked to WhatsApp. Stop the listener task, run "npm run link" and scan the QR with the reception phone.');
      setTimeout(() => void connect(), 5 * 60_000);
      return;
    }
    listener.setState('connecting');
    const sock = makeWASocket(socketOptions({ version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger }));
    withoutOwnName(sock.ev, state.creds);
    const ro = readOnly(sock);
    current = ro;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      if (u.qr && mode === 'link') {
        listener.setState('waiting_for_qr');
        console.log('\nOn the reception phone: WhatsApp → Settings → Linked devices → Link a device, then scan:\n');
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        retry = 0;
        listener.setState('connected');
        listener.attach(ro);
        const me = ro.user();
        log.info(`Connected to WhatsApp as ${String(me.id ?? '').split(':')[0].split('@')[0] || 'the linked number'} (read-only).`);
        void listener.heartbeat();
        if (mode === 'link') onLinked();
      }
      if (u.connection === 'close') {
        listener.detach();
        if (current === ro) current = null;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (stopped) return;
        if (code === DisconnectReason.loggedOut) {
          listener.setState('logged_out');
          log.error('WhatsApp logged this PC out (unlinked on the phone, or not connected for about two weeks). '
            + 'The old login was removed. Stop the listener task, run "npm run link" and scan the QR again.');
          if (existsSync(cfg.authDir)) rmSync(cfg.authDir, { recursive: true, force: true });
          if (mode === 'run') setTimeout(() => void connect(), 5 * 60_000);
          else void connect();
          return;
        }
        // 515 (restart required) comes right after a QR scan: connect again at once.
        const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(5_000 * 2 ** retry, 5 * 60_000);
        retry += 1;
        listener.setState('reconnecting');
        log.warn(`WhatsApp connection closed (${code ?? 'no code'}); connecting again in ${Math.round(wait / 1000)} s.`);
        setTimeout(() => void connect().catch((e) => log.error(`connect: ${e.message}`)), wait);
      }
    });
    if (mode === 'run') {
      sock.ev.on('messages.upsert', ({ messages }) => listener.onMessages(messages));
      sock.ev.on('groups.upsert', (list) => listener.onGroups(list));
      sock.ev.on('groups.update', (list) => listener.onGroups(list));
    }
  }

  // Set before the first connection, so a library frame sent while connecting already has the ids to check against.
  const handle = {
    stop() { stopped = true; current?.end(); },
    /** Downloads one kept photo or file (asks the sender's phone to upload it again when WhatsApp's copy has expired). */
    download(msg) {
      const ro = current;
      return downloadMediaMessage(msg, 'buffer', {}, ro ? { logger, reuploadRequest: ro.updateMediaMessage } : undefined);
    },
    me: () => ({ id: creds?.me?.id, lid: creds?.me?.lid, name: creds?.me?.name }),
  };
  onReady(handle);
  await connect();
  return handle;
}
