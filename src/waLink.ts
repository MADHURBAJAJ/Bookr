// Linking a WhatsApp number from the POS (approved 27 Nov 2026). The Owner asks in POS › Settings › WhatsApp; Bookr keeps
// the one open request (wa_listener_status, migration 0044); the listener picks it up with its heartbeat (every minute,
// every few seconds while linking), sends the QR as rows of 0 and 1 while it links, and says how it ended. The QR is
// kept only while a link is open, 3 minutes at most, and cleared when it ends. Only the last 4 digits of the number are kept.
import { now, one, stmt, type DB } from './db';

export const LINK_MS = 3 * 60_000;
/** A request the listener has not finished in time is over: 3 minutes to scan, and half a minute for its last word. */
const OPEN_MS = LINK_MS + 30_000;
/** The PC counts as on when it was heard from in the last 3 minutes (its heartbeat is every minute). */
export const PC_ON_MS = 3 * 60_000;

type Row = { last_heartbeat_at: number | null; linked_last4: string | null; linked_at: number | null; linked_by: string | null; link_id: string | null;
  link_action: 'link' | 'unlink' | null; link_at: number | null; link_by: string | null; link_business_id: string | null; link_result: string | null;
  qr_rows: string | null; qr_at: number | null };
const row = (db: DB) => one<Row>(db, `SELECT last_heartbeat_at, linked_last4, linked_at, linked_by, link_id, link_action, link_at, link_by, link_business_id,
  link_result, qr_rows, qr_at FROM wa_listener_status WHERE id = 1`);
const open = (r: Row | null, t: number) => !!(r?.link_id && r.link_at && t - r.link_at < OPEN_MS);
const clearRequest = (db: DB, result: string) => stmt(db, `UPDATE wa_listener_status SET link_id = NULL, link_action = NULL, link_at = NULL, link_by = NULL,
  link_business_id = NULL, qr_rows = NULL, qr_at = NULL, link_result = ? WHERE id = 1`, result);

export class LinkError extends Error { constructor(readonly status: 400 | 409, message: string) { super(message); } }

/** What the POS shows. qrRows only while a link is open (the POS shows it to the Owner only). */
export async function linkView(db: DB) {
  const t = now();
  const r = await row(db);
  const live = open(r, t);
  return {
    pcOn: !!(r?.last_heartbeat_at && t - r.last_heartbeat_at < PC_ON_MS),
    last4: r?.linked_last4 ?? null, linkedAt: r?.linked_last4 ? r.linked_at : null, linkedBy: r?.linked_last4 ? r.linked_by : null,
    request: live ? { id: r!.link_id!, action: r!.link_action!, at: r!.link_at!, by: r!.link_by, endsAt: r!.link_at! + LINK_MS } : null,
    qrRows: live && r!.link_action === 'link' && r!.qr_rows ? JSON.parse(r!.qr_rows) as string[] : null,
    qrAt: live ? r!.qr_at : null,
    lastResult: live ? null : r?.link_result ?? null,
  };
}

/** The Owner asks (from the POS): link a number (logging the PC out of any number first), unlink, or cancel. */
export async function askLink(db: DB, bid: string, action: 'link' | 'unlink' | 'cancel', by: string) {
  const t = now();
  const r = await row(db);
  if (action === 'cancel') {
    if (open(r, t)) await db.batch([clearRequest(db, 'cancelled'), audit(db, bid, 'wa.link.cancel', { by }, t)]);
    return;
  }
  if (!r?.last_heartbeat_at || t - r.last_heartbeat_at >= PC_ON_MS) throw new LinkError(409, 'The reception PC is off, so the number cannot be changed now. Switch the PC on first.');
  if (action === 'unlink' && !r.linked_last4) throw new LinkError(400, 'No WhatsApp number is linked.');
  const id = crypto.randomUUID();
  await db.batch([
    stmt(db, `UPDATE wa_listener_status SET link_id = ?, link_action = ?, link_at = ?, link_by = ?, link_business_id = ?, qr_rows = NULL, qr_at = NULL,
      link_result = NULL WHERE id = 1`, id, action, t, by, bid),
    audit(db, bid, `wa.link.${action}`, { by, ...(r.linked_last4 ? { from: `ending ${r.linked_last4}` } : {}) }, t),
  ]);
  return id;
}

const audit = (db: DB, bid: string, action: string, after: unknown, t: number) =>
  stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, NULL, ?, 'wa_listener_status', '1', NULL, ?, ?)`,
    bid, action, JSON.stringify(after), t);

/** The listener's word on linking, from its heartbeat. Answers the request it should work on now (or null). */
export async function noteLink(db: DB, b: { linkedLast4?: string | null; link?: { id: string; qrRows?: string[]; result?: string } }) {
  const t = now();
  let r = await row(db);
  const mine = !!(b.link && r?.link_id === b.link.id && open(r, t));
  const writes = [];
  if (b.link?.result && mine) {
    const res = b.link.result;
    if (res === 'linked') {
      writes.push(stmt(db, 'UPDATE wa_listener_status SET linked_last4 = ?, linked_at = ?, linked_by = ? WHERE id = 1', b.linkedLast4 ?? null, t, r!.link_by));
    } else if (res === 'unlinked') {
      writes.push(stmt(db, 'UPDATE wa_listener_status SET linked_last4 = NULL, linked_at = NULL, linked_by = NULL WHERE id = 1'));
    }
    writes.push(clearRequest(db, res));
    if (r!.link_business_id) writes.push(audit(db, r!.link_business_id, `wa.link.${res}`, { by: r!.link_by, ...(res === 'linked' && b.linkedLast4 ? { number: `ending ${b.linkedLast4}` } : {}) }, t));
  } else if (b.link?.qrRows && mine && r!.link_action === 'link') {
    writes.push(stmt(db, 'UPDATE wa_listener_status SET qr_rows = ?, qr_at = ? WHERE id = 1', JSON.stringify(b.link.qrRows), t));
  }
  // The number as the listener has it now (also when linked or unlinked on the PC itself).
  if (b.linkedLast4 !== undefined && !(b.link?.result && mine)) {
    if (b.linkedLast4 === null) writes.push(stmt(db, 'UPDATE wa_listener_status SET linked_last4 = NULL, linked_at = NULL, linked_by = NULL WHERE id = 1'));
    else if (b.linkedLast4 !== r?.linked_last4) writes.push(stmt(db, 'UPDATE wa_listener_status SET linked_last4 = ?, linked_at = ?, linked_by = NULL WHERE id = 1', b.linkedLast4, t));
  }
  // A request nobody finished in time is over; its QR goes.
  if (r?.link_id && !open(r, t)) writes.push(clearRequest(db, 'expired'));
  if (writes.length) await db.batch(writes);
  r = await row(db);
  return open(r, t) ? { id: r!.link_id!, action: r!.link_action! } : null;
}
