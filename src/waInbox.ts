// The WhatsApp inbox (phase 4, mock approved 24 Nov 2026). Guest payment photos and bills read from the groups, shown
// as cards: a UPI photo with the bill it pays, or one on its own. A person (Owner or Accountant) confirms, rejects,
// corrects or pairs them by hand. Nothing here books anything: a confirmed payment waits for Reconcile (phase 6).
import { all, newId, now, one, stmt, type DB } from './db';
import { shiftDayOf } from './time';
import { pairGroup } from './waPair';

/** The listener counts as offline when it has not called in for this long (spec: 30 minutes). */
export const OFFLINE_MS = 30 * 60_000;
/** A pair "agrees" (Confirm all) when both amounts are read and equal and Bookr is this sure of it. */
export const AGREE_MIN = 80;

export class InboxError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) { super(message); }
}

export const TABS = ['pending', 'confirmed', 'rejected', 'duplicate'] as const;
export type Tab = (typeof TABS)[number];

interface ItemRow {
  id: string; group_id: string; group_name: string; wa_message_id: string; sender_number: string | null; sender_name: string | null;
  sent_at: number; media_type: string; caption: string | null; kind: string | null; read_status: string; read_note: string | null;
  extracted_json: string | null; amount_paise: number | null; utr: string | null; bill_no: string | null; doc_at: number | null;
  status: string; duplicate_of: string | null; paid_as: string | null; tip_paise: number | null; reviewed_by: string | null; reviewed_at: number | null;
}
const ITEM_SQL = `SELECT i.id, i.group_id, g.name AS group_name, i.wa_message_id, i.sender_number, i.sender_name, i.sent_at, i.media_type, i.caption,
    i.kind, i.read_status, i.read_note, i.extracted_json, i.amount_paise, i.utr, i.bill_no, i.doc_at, i.status, i.duplicate_of,
    i.paid_as, i.tip_paise, u.name AS reviewed_by, i.reviewed_at
  FROM wa_items i JOIN wa_groups g ON g.id = i.group_id LEFT JOIN users u ON u.id = i.reviewed_by`;

function itemOut(r: ItemRow) {
  let reading: Record<string, any> | null = null;
  try { reading = r.extracted_json ? JSON.parse(r.extracted_json).reading ?? null : null; } catch { /* kept as null */ }
  return {
    id: r.id, groupName: r.group_name, sentAt: r.sent_at, sender: r.sender_name || r.sender_number, caption: r.caption,
    mediaType: r.media_type, kind: r.kind, readStatus: r.read_status, note: r.read_note,
    amountPaise: r.amount_paise, utr: r.utr, billNo: r.bill_no, docAt: r.doc_at, status: r.status, duplicateOf: r.duplicate_of,
    legible: reading?.legible ?? null, app: reading?.upi?.app ?? null, payee: reading?.upi?.payee_vpa ?? reading?.upi?.payee_name ?? null,
    payer: reading?.upi?.payer_name ?? null, items: reading?.bill?.items ?? null,
    paidAs: r.paid_as, tipPaise: r.tip_paise, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
  };
}
type Item = ReturnType<typeof itemOut>;

export async function listenerStatus(db: DB, t = now()) {
  const s = await one<{ last_heartbeat_at: number | null; last_message_at: number | null; state: string | null; version: string | null }>(db,
    'SELECT last_heartbeat_at, last_message_at, state, version FROM wa_listener_status WHERE id = 1');
  const last = s?.last_heartbeat_at ?? null;
  return {
    lastHeartbeatAt: last, lastMessageAt: s?.last_message_at ?? null, state: s?.state ?? null, version: s?.version ?? null,
    never: last == null, offline: last == null || t - last > OFFLINE_MS,
  };
}

/** One tab of the inbox: cards by shift (newest shift first, in the order sent within a shift), with the counts. */
export async function inbox(db: DB, bid: string, tab: Tab) {
  const limit = tab === 'pending' ? 1000 : 300;
  const [rows, counts, groups, listener] = await Promise.all([
    all<ItemRow>(db, `${ITEM_SQL} WHERE i.business_id = ? AND i.status = ? ORDER BY i.sent_at DESC LIMIT ${limit}`, bid, tab),
    all<{ status: string; n: number }>(db, 'SELECT status, count(*) AS n FROM wa_items WHERE business_id = ? GROUP BY status', bid),
    one<{ n: number }>(db, 'SELECT count(*) AS n FROM wa_groups WHERE business_id = ? AND active = 1', bid),
    listenerStatus(db),
  ]);
  const byId = new Map(rows.map((r) => [r.id, itemOut(r)]));
  const ids = [...byId.keys()];
  const pairs = ids.length ? await all<{ id: string; upi_item_id: string; bill_item_id: string; confidence: number; reasons: string; by_hand: number }>(db,
    `SELECT id, upi_item_id, bill_item_id, confidence, reasons, by_hand FROM wa_pairs WHERE business_id = ? AND upi_item_id IN (SELECT value FROM json_each(?))`,
    bid, JSON.stringify(ids)) : [];
  const used = new Set<string>();
  type Card = { key: string; at: number; pair: { id: string; confidence: number; reasons: string[]; byHand: boolean } | null; upi: Item | null; bill: Item | null; other: Item | null; diffPaise: number | null; agrees: boolean };
  const cards: Card[] = [];
  for (const p of pairs) {
    const u = byId.get(p.upi_item_id), b = byId.get(p.bill_item_id);
    if (!u || !b) continue;
    used.add(u.id); used.add(b.id);
    const diff = u.amountPaise != null && b.amountPaise != null ? u.amountPaise - b.amountPaise : null;
    cards.push({ key: p.id, at: Math.min(u.sentAt, b.sentAt), pair: { id: p.id, confidence: p.confidence, reasons: JSON.parse(p.reasons), byHand: !!p.by_hand },
      upi: u, bill: b, other: null, diffPaise: diff, agrees: tab === 'pending' && diff === 0 && (p.by_hand === 1 || p.confidence >= AGREE_MIN) });
  }
  for (const it of byId.values()) {
    if (used.has(it.id)) continue;
    cards.push({ key: it.id, at: it.sentAt, pair: null, upi: it.kind === 'upi' ? it : null, bill: it.kind === 'bill' ? it : null,
      other: it.kind !== 'upi' && it.kind !== 'bill' ? it : null, diffPaise: null, agrees: false });
  }
  const shifts = new Map<string, Card[]>();
  for (const c of cards.sort((a, b) => a.at - b.at)) {
    const day = shiftDayOf(c.at);
    shifts.set(day, [...(shifts.get(day) ?? []), c]);
  }
  return {
    tab, listener, groups: groups?.n ?? 0,
    counts: Object.fromEntries(TABS.map((t) => [t, counts.find((c) => c.status === t)?.n ?? 0])),
    shifts: [...shifts.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, list]) => ({ day, cards: list })),
  };
}

const audit = (db: DB, bid: string, user: string | null, action: string, table: string, id: string, before: unknown, after: unknown, t: number) =>
  stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bid, user, action, table, id, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), t);

interface Raw { id: string; group_id: string; kind: string | null; status: string; sent_at: number; amount_paise: number | null; read_status: string; utr: string | null; bill_no: string | null; doc_at: number | null; paid_as: string | null; tip_paise: number | null }
async function item(db: DB, bid: string, id: string) {
  const r = await one<Raw>(db, `SELECT id, group_id, kind, status, sent_at, amount_paise, read_status, utr, bill_no, doc_at, paid_as, tip_paise
    FROM wa_items WHERE id = ? AND business_id = ?`, id, bid);
  if (!r) throw new InboxError(404, 'Photo not found.');
  return r;
}
const pairOf = (db: DB, id: string) => one<{ id: string; upi_item_id: string; bill_item_id: string; confidence: number; by_hand: number }>(db,
  'SELECT id, upi_item_id, bill_item_id, confidence, by_hand FROM wa_pairs WHERE upi_item_id = ? OR bill_item_id = ?', id, id);
/** Bookr works out its own pairs again around a photo whose review or values changed. */
const repair = (db: DB, it: { group_id: string; sent_at: number }) => pairGroup(db, it.group_id, it.sent_at, it.sent_at);

/**
 * Confirms a pair: the guest paid the bill with that UPI payment. tip: the UPI paid more and the extra is a tip.
 * Both photos must still be waiting for review.
 */
export async function confirmPair(db: DB, bid: string, pairId: string, user: string, tip: boolean) {
  const p = await one<{ upi_item_id: string; bill_item_id: string }>(db, 'SELECT upi_item_id, bill_item_id FROM wa_pairs WHERE id = ? AND business_id = ?', pairId, bid);
  if (!p) throw new InboxError(404, 'Pair not found. Refresh the page.');
  const [u, b] = await Promise.all([item(db, bid, p.upi_item_id), item(db, bid, p.bill_item_id)]);
  if (u.status !== 'pending' || b.status !== 'pending') throw new InboxError(409, 'Already reviewed. Refresh the page.');
  if (u.amount_paise == null || b.amount_paise == null) throw new InboxError(400, 'Type the amount of both first (Open).');
  const more = u.amount_paise - b.amount_paise;
  if (tip && more <= 0) throw new InboxError(400, 'The payment is not more than the bill: nothing to keep as a tip.');
  const t = now();
  await db.batch(confirmStatements(db, bid, user, pairId, u.id, b.id, tip ? more : null, t));
}
function confirmStatements(db: DB, bid: string, user: string, pairId: string, upiId: string, billId: string, tipPaise: number | null, t: number) {
  return [
    stmt(db, `UPDATE wa_items SET status = 'confirmed', tip_paise = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'`, tipPaise, user, t, upiId),
    stmt(db, `UPDATE wa_items SET status = 'confirmed', paid_as = 'upi', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'`, user, t, billId),
    audit(db, bid, user, 'wa.confirm', 'wa_pairs', pairId, null, { upiItemId: upiId, billItemId: billId, tipPaise }, t),
  ];
}

/** Confirm all that agree: only the pairs that still agree (same amount, sure enough) are confirmed. */
export async function confirmAgreeing(db: DB, bid: string, pairIds: string[], user: string) {
  if (!pairIds.length) return 0;
  const rows = await all<{ id: string; upi_item_id: string; bill_item_id: string }>(db, `SELECT p.id, p.upi_item_id, p.bill_item_id FROM wa_pairs p
      JOIN wa_items u ON u.id = p.upi_item_id JOIN wa_items b ON b.id = p.bill_item_id
    WHERE p.business_id = ? AND p.id IN (SELECT value FROM json_each(?)) AND u.status = 'pending' AND b.status = 'pending'
      AND u.amount_paise IS NOT NULL AND u.amount_paise = b.amount_paise AND (p.by_hand = 1 OR p.confidence >= ?)`,
    bid, JSON.stringify(pairIds.slice(0, 500)), AGREE_MIN);
  if (!rows.length) return 0;
  const t = now();
  await db.batch(rows.flatMap((p) => confirmStatements(db, bid, user, p.id, p.upi_item_id, p.bill_item_id, null, t)));
  return rows.length;
}

/**
 * Confirms a photo on its own: a bill with no UPI photo that was paid in cash (paidAs cash), or a UPI payment with no
 * bill photo. One in a pair is confirmed with its pair.
 */
export async function confirmItem(db: DB, bid: string, id: string, user: string, paidAs: 'cash' | null) {
  const it = await item(db, bid, id);
  if (it.status !== 'pending') throw new InboxError(409, 'Already reviewed. Refresh the page.');
  if (it.kind !== 'upi' && it.kind !== 'bill' && it.kind !== 'card') throw new InboxError(400, 'Say whether it is a UPI payment, a bill or a card slip first (Open).');
  if (await pairOf(db, id)) throw new InboxError(409, 'It is paired: confirm the pair, or unpair it first.');
  if (it.kind === 'bill' && paidAs !== 'cash') throw new InboxError(400, 'A bill without its UPI photo is confirmed as paid in cash, or paired with its payment.');
  if (it.kind !== 'bill' && paidAs) throw new InboxError(400, `A ${it.kind === 'card' ? 'card slip' : 'UPI payment'} is not paid in cash.`);
  if (it.amount_paise == null) throw new InboxError(400, 'Type the amount first (Open).');
  const t = now();
  await db.batch([
    stmt(db, `UPDATE wa_items SET status = 'confirmed', paid_as = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'`, paidAs, user, t, id),
    audit(db, bid, user, 'wa.confirm', 'wa_items', id, null, { kind: it.kind, paidAs }, t),
  ]);
}

/** Rejects a photo (not a guest payment, a failed payment, a mistake). Its pair goes; Bookr pairs what is left again. */
export async function rejectItem(db: DB, bid: string, id: string, user: string) {
  const it = await item(db, bid, id);
  if (it.status === 'rejected') return;
  if (it.status === 'confirmed') throw new InboxError(409, 'It is confirmed. Put it back to check first.');
  const t = now();
  await db.batch([
    stmt(db, 'DELETE FROM wa_pairs WHERE upi_item_id = ? OR bill_item_id = ?', id, id),
    stmt(db, `UPDATE wa_items SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?`, user, t, id),
    audit(db, bid, user, 'wa.reject', 'wa_items', id, { status: it.status }, { status: 'rejected' }, t),
  ]);
  await repair(db, it);
}

/**
 * Puts a confirmed, rejected or duplicate photo back to check (Undo). A confirmed pair comes back together.
 */
export async function restoreItem(db: DB, bid: string, id: string, user: string) {
  const it = await item(db, bid, id);
  if (it.status === 'pending') return;
  const p = it.status === 'confirmed' ? await pairOf(db, id) : null;
  const ids = p ? [p.upi_item_id, p.bill_item_id] : [id];
  const t = now();
  await db.batch([
    ...ids.map((x) => stmt(db, `UPDATE wa_items SET status = 'pending', paid_as = NULL, tip_paise = NULL, duplicate_of = NULL, reviewed_by = NULL, reviewed_at = NULL
      WHERE id = ? AND business_id = ?`, x, bid)),
    audit(db, bid, user, 'wa.restore', 'wa_items', id, { status: it.status, paidAs: it.paid_as, tipPaise: it.tip_paise, pair: p?.id ?? null }, { status: 'pending' }, t),
  ]);
  if (!p) await repair(db, it);
}

export interface ItemEdit { kind?: 'upi' | 'bill' | 'card' | 'other'; amountPaise?: number | null; utr?: string | null; billNo?: string | null; docAt?: number | null }

/** A person corrects what was read. The photo counts as read; Bookr pairs around it again (a pair made by hand stays). */
export async function editItem(db: DB, bid: string, id: string, user: string, e: ItemEdit) {
  const it = await item(db, bid, id);
  if (it.status !== 'pending' && it.status !== 'duplicate') throw new InboxError(409, 'It is reviewed. Put it back to check first.');
  const next = {
    kind: e.kind ?? it.kind, amount_paise: e.amountPaise !== undefined ? e.amountPaise : it.amount_paise,
    utr: e.utr !== undefined ? (e.utr?.replace(/\s+/g, '') || null) : it.utr,
    bill_no: e.billNo !== undefined ? (e.billNo?.trim() || null) : it.bill_no, doc_at: e.docAt !== undefined ? e.docAt : it.doc_at,
  };
  const before = { kind: it.kind, amount_paise: it.amount_paise, utr: it.utr, bill_no: it.bill_no, doc_at: it.doc_at, read_status: it.read_status };
  const t = now();
  const p = await pairOf(db, id);
  const kindChanged = next.kind !== it.kind;
  await db.batch([
    ...(p && kindChanged ? [stmt(db, 'DELETE FROM wa_pairs WHERE id = ?', p.id)] : []),
    stmt(db, `UPDATE wa_items SET kind = ?, amount_paise = ?, utr = ?, bill_no = ?, doc_at = ?, read_status = 'read', read_after = NULL WHERE id = ?`,
      next.kind, next.amount_paise, next.utr, next.bill_no, next.doc_at, id),
    audit(db, bid, user, 'wa.edit', 'wa_items', id, before, next, t),
  ]);
  if (it.status === 'pending') await repair(db, it);
}

// ----- groups

export async function groupsView(db: DB, bid: string) {
  const [groups, seen, heads] = await Promise.all([
    all<{ id: string; wa_group_id: string; name: string; department: string | null; default_head_id: string | null; active: number; pos_proof: number; items: number; last_at: number | null }>(db,
      `SELECT g.id, g.wa_group_id, g.name, g.department, g.default_head_id, g.active, g.pos_proof,
         (SELECT count(*) FROM wa_items i WHERE i.group_id = g.id) AS items, (SELECT max(sent_at) FROM wa_items i WHERE i.group_id = g.id) AS last_at
       FROM wa_groups g WHERE g.business_id = ? ORDER BY g.active DESC, lower(g.name)`, bid),
    // Groups read by another business are not offered here.
    all<{ wa_group_id: string; name: string; last_seen_at: number }>(db,
      `SELECT s.wa_group_id, s.name, s.last_seen_at FROM wa_seen_groups s WHERE NOT EXISTS (SELECT 1 FROM wa_groups g WHERE g.wa_group_id = s.wa_group_id)
       ORDER BY lower(s.name)`),
    all<{ id: string; name: string; type: string }>(db, 'SELECT id, name, type FROM heads WHERE business_id = ? ORDER BY type, lower(name)', bid),
  ]);
  return {
    groups: groups.map((g) => ({ id: g.id, waGroupId: g.wa_group_id, name: g.name, department: g.department, defaultHeadId: g.default_head_id,
      active: !!g.active, posProof: !!g.pos_proof, items: g.items, lastAt: g.last_at })),
    seen: seen.map((s) => ({ waGroupId: s.wa_group_id, name: s.name, lastSeenAt: s.last_seen_at })),
    heads: heads.map((h) => ({ id: h.id, name: h.name, type: h.type })),
    departments: [...new Set(groups.map((g) => g.department).filter((d): d is string => !!d))].sort(),
  };
}

async function checkHead(db: DB, bid: string, headId: string | null | undefined) {
  if (!headId) return;
  if (!await one(db, 'SELECT 1 FROM heads WHERE id = ? AND business_id = ?', headId, bid)) throw new InboxError(400, 'Head not found.');
}

/** Starts reading a group (from the groups the listener sees, or by its id). */
/** `user` is null when the change came from the POS; `by` then names the POS person ("POS · Ravi (manager)") in the history. */
export async function addGroup(db: DB, bid: string, user: string | null, g: { waGroupId: string; name?: string | null; department?: string | null; defaultHeadId?: string | null;
  posProof?: boolean }, by?: string) {
  await checkHead(db, bid, g.defaultHeadId);
  const have = await one<{ id: string; business_id: string }>(db, 'SELECT id, business_id FROM wa_groups WHERE wa_group_id = ?', g.waGroupId);
  if (have && have.business_id !== bid) throw new InboxError(409, 'This group is read for another business.');
  const seen = await one<{ name: string }>(db, 'SELECT name FROM wa_seen_groups WHERE wa_group_id = ?', g.waGroupId);
  const name = g.name?.trim() || seen?.name;
  if (!name) throw new InboxError(400, 'Give the group a name.');
  const t = now();
  const id = have?.id ?? newId();
  await db.batch([
    have
      ? stmt(db, `UPDATE wa_groups SET active = 1, name = ?, department = coalesce(?, department), default_head_id = coalesce(?, default_head_id),
          pos_proof = coalesce(?, pos_proof) WHERE id = ?`,
        name, g.department?.trim() || null, g.defaultHeadId || null, g.posProof === undefined ? null : g.posProof ? 1 : 0, id)
      // A group named for payments is the guests' payment group: its proof shows on the POS Payments screen from the start
      // (24 Nov 2026), the same rule migration 0042 used for existing groups. It can be switched off on the group.
      : stmt(db, 'INSERT INTO wa_groups (id, business_id, wa_group_id, name, department, default_head_id, active, created_at, pos_proof) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        id, bid, g.waGroupId, name, g.department?.trim() || null, g.defaultHeadId || null, t, (g.posProof ?? /payment/i.test(name)) ? 1 : 0),
    audit(db, bid, user, 'wa.group.add', 'wa_groups', id, null, { waGroupId: g.waGroupId, name, ...(by ? { by } : {}) }, t),
  ]);
  return id;
}

export async function editGroup(db: DB, bid: string, user: string | null, id: string, e: { name?: string; department?: string | null; defaultHeadId?: string | null; active?: boolean; posProof?: boolean },
  by?: string) {
  const g = await one<{ name: string; department: string | null; default_head_id: string | null; active: number; pos_proof: number }>(db,
    'SELECT name, department, default_head_id, active, pos_proof FROM wa_groups WHERE id = ? AND business_id = ?', id, bid);
  if (!g) throw new InboxError(404, 'Group not found.');
  await checkHead(db, bid, e.defaultHeadId);
  const next = {
    name: e.name?.trim() || g.name, department: e.department !== undefined ? (e.department?.trim() || null) : g.department,
    default_head_id: e.defaultHeadId !== undefined ? (e.defaultHeadId || null) : g.default_head_id, active: e.active !== undefined ? (e.active ? 1 : 0) : g.active,
    pos_proof: e.posProof !== undefined ? (e.posProof ? 1 : 0) : g.pos_proof,
  };
  const t = now();
  await db.batch([
    stmt(db, 'UPDATE wa_groups SET name = ?, department = ?, default_head_id = ?, active = ?, pos_proof = ? WHERE id = ?', next.name, next.department, next.default_head_id, next.active, next.pos_proof, id),
    audit(db, bid, user, 'wa.group.edit', 'wa_groups', id, g, by ? { ...next, by } : next, t),
  ]);
}

/** The stored file of a photo, for the inbox (signed-in Owner or Accountant of its business only). */
export async function itemFile(db: DB, bid: string, id: string) {
  return one<{ file_key: string; media_type: string }>(db, 'SELECT file_key, media_type FROM wa_items WHERE id = ? AND business_id = ?', id, bid);
}
