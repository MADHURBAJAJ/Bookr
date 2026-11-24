// WhatsApp inbox, phase 3 (approved 24 Nov 2026): pairing a guest's UPI screenshot with the bill it pays, and catching
// the same payment posted twice. Bookr only suggests: every pair shows its confidence and reasons, a person can pair
// or take a pair apart by hand, and a pair taken apart is never made again.
//
// How staff post (seen in the "Guest payment" group): the UPI photo, captioned with the bill number, then the bill photo
// sent as a WhatsApp reply to it. So the strongest signs are the reply and the bill number in the caption; without them,
// the same amount from the same sender within half an hour.

import { all, newId, now, one, stmt, type DB } from './db';

export interface PairItem {
  id: string;
  kind: 'upi' | 'bill';
  sender: string | null;
  messageId: string;
  replyTo: string | null;
  caption: string | null;
  sentAt: number;
  amountPaise: number | null;
  billNo: string | null;
}

export interface Pair { upiId: string; billId: string; confidence: number; reasons: string[] }

const MIN = 60_000;
const NEAR_MS = 30 * MIN; // no reply or bill number: within half an hour
const LINK_MS = 24 * 60 * MIN; // a reply or bill number holds over a longer gap
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

/** Whether the UPI photo's caption names this bill number (e.g. caption "2611241", or "bill 2611241 table 6"). */
export function captionNames(caption: string | null, billNo: string | null): boolean {
  const want = digits(billNo);
  if (want.length < 3) return false;
  return (caption ?? '').match(/\d+/g)?.some((n) => n === want) ?? false;
}

/** One UPI photo and one bill: how likely it is they belong together, and why. null when they should not be paired. */
export function score(u: PairItem, b: PairItem): Pair | null {
  const gap = Math.abs(u.sentAt - b.sentAt);
  const reply = b.replyTo === u.messageId || u.replyTo === b.messageId;
  const named = captionNames(u.caption, b.billNo);
  const linked = (reply || named) && gap <= LINK_MS;
  const reasons: string[] = [];
  if (reply) reasons.push('reply');
  if (named) reasons.push('bill no. in caption');

  let amount: 'same' | 'more' | 'other' = 'other';
  if (u.amountPaise && b.amountPaise) {
    const d = u.amountPaise - b.amountPaise;
    if (d === 0) amount = 'same';
    // The guest paid a little more than the bill (a tip, a rounded amount): up to 10% more.
    else if (d > 0 && d <= b.amountPaise * 0.1) amount = 'more';
    reasons.push(d === 0 ? 'same amount' : d > 0 ? `paid ${rupees(d)} more` : `paid ${rupees(-d)} less`);
  } else reasons.push('amount not read');

  const sameSender = !!u.sender && u.sender === b.sender;
  const minutes = Math.round(gap / MIN);
  reasons.push(minutes < 1 ? 'same minute' : `${minutes} min apart`);

  let confidence: number;
  if (linked) {
    confidence = amount === 'same' ? 95 : amount === 'more' ? 85 : 60;
    if (reply && named) confidence = Math.min(99, confidence + 4);
  } else {
    if (!sameSender || gap > NEAR_MS) return null;
    if (amount === 'same') confidence = gap <= 10 * MIN ? 80 : 70;
    else if (amount === 'more' && gap <= 10 * MIN) confidence = 50;
    else return null;
  }
  return { upiId: u.id, billId: b.id, confidence, reasons };
}

/** The pairs to make among these items: best first, each item in one pair at most. When an item has two equally good
 *  matches with no reply or bill number to tell them apart, both are made less sure ("another fits too"). */
export function choosePairs(items: PairItem[], blocked: Set<string> = new Set()): Pair[] {
  const upis = items.filter((i) => i.kind === 'upi');
  const bills = items.filter((i) => i.kind === 'bill');
  const all: Pair[] = [];
  for (const u of upis) for (const b of bills) {
    if (blocked.has(`${u.id}|${b.id}`)) continue;
    const p = score(u, b);
    if (p) all.push(p);
  }
  const linked = (p: Pair) => p.reasons.includes('reply') || p.reasons.includes('bill no. in caption');
  // Compared on the scores as they first came out, so both of two rivals are marked, not just the first one looked at.
  const first = new Map(all.map((p) => [p, p.confidence]));
  for (const p of all) {
    if (linked(p)) continue;
    const rivals = all.filter((q) => q !== p && (q.upiId === p.upiId || q.billId === p.billId) && first.get(q)! >= first.get(p)!);
    if (rivals.length) { p.confidence = Math.max(30, p.confidence - 30); p.reasons.push('another fits too'); }
  }
  const gapOf = (p: Pair) => Number(/(\d+) min apart/.exec(p.reasons.join(' '))?.[1] ?? 0);
  all.sort((a, b) => b.confidence - a.confidence || gapOf(a) - gapOf(b));
  const used = new Set<string>();
  const out: Pair[] = [];
  for (const p of all) {
    if (used.has(p.upiId) || used.has(p.billId)) continue;
    used.add(p.upiId); used.add(p.billId);
    out.push(p);
  }
  return out;
}

// ----- in the database

type Row = { id: string; kind: 'upi' | 'bill'; sender_number: string | null; sender_name: string | null; wa_message_id: string;
  reply_to_id: string | null; caption: string | null; sent_at: number; amount_paise: number | null; bill_no: string | null };
const toItem = (r: Row): PairItem => ({ id: r.id, kind: r.kind, sender: r.sender_number || r.sender_name, messageId: r.wa_message_id,
  replyTo: r.reply_to_id, caption: r.caption, sentAt: r.sent_at, amountPaise: r.amount_paise, billNo: r.bill_no });

/**
 * Works out Bookr's pairs again in one group around a time (a day each side): items read, still pending, not duplicates.
 * A person's pair, and a pair with a confirmed item, are kept as they are; Bookr's other pairs there are replaced.
 */
export async function pairGroup(db: DB, groupId: string, from: number, to: number) {
  const rows = await all<Row & { business_id: string }>(db, `SELECT id, business_id, kind, sender_number, sender_name, wa_message_id,
      reply_to_id, caption, sent_at, amount_paise, bill_no
    FROM wa_items WHERE group_id = ? AND sent_at BETWEEN ? AND ? AND read_status = 'read' AND kind IN ('upi', 'bill')
      AND status = 'pending' ORDER BY sent_at`, groupId, from - LINK_MS, to + LINK_MS);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const pairs = await all<{ id: string; upi_item_id: string; bill_item_id: string; by_hand: number }>(db,
    `SELECT id, upi_item_id, bill_item_id, by_hand FROM wa_pairs WHERE upi_item_id IN (${marks}) OR bill_item_id IN (${marks})`, ...ids, ...ids);
  const inWindow = new Set(ids);
  // Kept: by hand, or reaching an item outside this set (confirmed, or further away in time).
  const kept = pairs.filter((p) => p.by_hand || !inWindow.has(p.upi_item_id) || !inWindow.has(p.bill_item_id));
  const replace = pairs.filter((p) => !kept.includes(p));
  const taken = new Set(kept.flatMap((p) => [p.upi_item_id, p.bill_item_id]));
  const blocked = new Set((await all<{ upi_item_id: string; bill_item_id: string }>(db,
    `SELECT upi_item_id, bill_item_id FROM wa_not_pairs WHERE upi_item_id IN (${marks}) OR bill_item_id IN (${marks})`, ...ids, ...ids))
    .map((b) => `${b.upi_item_id}|${b.bill_item_id}`));
  const chosen = choosePairs(rows.filter((r) => !taken.has(r.id)).map(toItem), blocked);

  // Nothing changes when the same pairs come out again (keeps their ids and times).
  const same = (p: Pair) => replace.find((r) => r.upi_item_id === p.upiId && r.bill_item_id === p.billId);
  const gone = replace.filter((r) => !chosen.some((p) => p.upiId === r.upi_item_id && p.billId === r.bill_item_id));
  const t = now();
  const bid = rows[0].business_id;
  const statements = [
    ...gone.map((r) => stmt(db, 'DELETE FROM wa_pairs WHERE id = ? AND by_hand = 0', r.id)),
    ...chosen.map((p) => {
      const old = same(p);
      return old
        ? stmt(db, 'UPDATE wa_pairs SET confidence = ?, reasons = ? WHERE id = ?', p.confidence, JSON.stringify(p.reasons), old.id)
        : stmt(db, `INSERT INTO wa_pairs (id, business_id, upi_item_id, bill_item_id, confidence, reasons, by_hand, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT DO NOTHING`, newId(), bid, p.upiId, p.billId, p.confidence, JSON.stringify(p.reasons), t);
    }),
  ];
  // Two runs at once (the minute job and the nudge after a file arrives) can meet here; the unique pair columns stop a
  // second pair for an item, and the loser's batch is simply dropped: the next run works it out again.
  if (statements.length) await db.batch(statements).catch((e) => { if (!String(e).includes('UNIQUE')) throw e; });
  return chosen;
}

/**
 * The same payment or bill posted again as a different photo (the same file is already refused on arrival). An item just
 * read is a duplicate of an earlier one in the business with: the same UTR; or, for a UPI photo with no UTR, the same
 * amount and payee at the same minute; or, for a bill, the same bill number and total. Returns the earlier item's id.
 */
export async function findDuplicate(db: DB, id: string): Promise<string | null> {
  const it = await one<{ business_id: string; kind: string | null; utr: string | null; amount_paise: number | null; doc_at: number | null;
    bill_no: string | null; sent_at: number; created_at: number; payee: string | null }>(db, `SELECT business_id, kind, utr, amount_paise, doc_at, bill_no, sent_at, created_at,
      lower(coalesce(json_extract(extracted_json, '$.reading.upi.payee_vpa'), json_extract(extracted_json, '$.reading.upi.payee_name'))) AS payee
    FROM wa_items WHERE id = ?`, id);
  if (!it) return null;
  // Only one posted before it (by message time, then arrival), so of two copies the later one is the duplicate.
  const earlier = `business_id = ? AND id <> ? AND read_status = 'read' AND status NOT IN ('rejected', 'duplicate') AND kind = ?
    AND (sent_at < ${it.sent_at} OR (sent_at = ${it.sent_at} AND created_at < ${it.created_at}))`;
  const order = 'ORDER BY sent_at, created_at LIMIT 1';
  let hit: { id: string } | null = null;
  if (it.kind === 'upi' && it.utr) {
    hit = await one(db, `SELECT id FROM wa_items WHERE ${earlier} AND utr = ? ${order}`, it.business_id, id, 'upi', it.utr);
  } else if (it.kind === 'upi' && it.amount_paise && it.doc_at) {
    hit = await one(db, `SELECT id FROM wa_items WHERE ${earlier} AND utr IS NULL AND amount_paise = ? AND doc_at = ?
      AND lower(coalesce(json_extract(extracted_json, '$.reading.upi.payee_vpa'), json_extract(extracted_json, '$.reading.upi.payee_name'))) IS ? ${order}`,
      it.business_id, id, 'upi', it.amount_paise, it.doc_at, it.payee);
  } else if (it.kind === 'bill' && it.bill_no && it.amount_paise) {
    hit = await one(db, `SELECT id FROM wa_items WHERE ${earlier} AND bill_no = ? AND amount_paise = ? ${order}`,
      it.business_id, id, 'bill', it.bill_no, it.amount_paise);
  }
  return hit?.id ?? null;
}

/** Marks an item a duplicate of an earlier one (when it is still pending), with a note for the reviewer. */
export async function markDuplicate(db: DB, id: string, of: string) {
  const o = await one<{ sent_at: number; kind: string }>(db, 'SELECT sent_at, kind FROM wa_items WHERE id = ?', of);
  const at = o ? new Date(o.sent_at + 19_800_000).toISOString().slice(0, 16).replace('T', ' ') : '';
  const what = o?.kind === 'bill' ? 'Same bill as one posted' : 'Same payment as one posted';
  await stmt(db, `UPDATE wa_items SET status = 'duplicate', duplicate_of = ?,
      read_note = trim(coalesce(read_note, '') || ' ' || ?) WHERE id = ? AND status = 'pending'`, of, `${what} ${at}.`, id).run();
}

// ----- by hand (the inbox, phase 4)

export class PairError extends Error {}

/** A person pairs a UPI photo with a bill. Any other pair either was in is taken apart (and not made again by Bookr). */
export async function pairByHand(db: DB, businessId: string, upiId: string, billId: string, userId: string) {
  const items = await all<{ id: string; kind: string | null; group_id: string }>(db,
    'SELECT id, kind, group_id FROM wa_items WHERE business_id = ? AND id IN (?, ?)', businessId, upiId, billId);
  const u = items.find((i) => i.id === upiId), b = items.find((i) => i.id === billId);
  if (!u || !b) throw new PairError('Item not found.');
  if (u.kind !== 'upi' || b.kind !== 'bill') throw new PairError('Pair a UPI payment with a bill.');
  const t = now();
  const old = await all<{ id: string; upi_item_id: string; bill_item_id: string }>(db,
    'SELECT id, upi_item_id, bill_item_id FROM wa_pairs WHERE upi_item_id = ? OR bill_item_id = ?', upiId, billId);
  const id = newId();
  await db.batch([
    ...old.filter((p) => !(p.upi_item_id === upiId && p.bill_item_id === billId)).flatMap((p) => [
      stmt(db, 'DELETE FROM wa_pairs WHERE id = ?', p.id),
      stmt(db, `INSERT INTO wa_not_pairs (business_id, upi_item_id, bill_item_id, made_by, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`, businessId, p.upi_item_id, p.bill_item_id, userId, t),
    ]),
    stmt(db, 'DELETE FROM wa_pairs WHERE upi_item_id = ? AND bill_item_id = ?', upiId, billId),
    stmt(db, 'DELETE FROM wa_not_pairs WHERE upi_item_id = ? AND bill_item_id = ?', upiId, billId),
    stmt(db, `INSERT INTO wa_pairs (id, business_id, upi_item_id, bill_item_id, confidence, reasons, by_hand, made_by, created_at)
      VALUES (?, ?, ?, ?, 100, '["paired by hand"]', 1, ?, ?)`, id, businessId, upiId, billId, userId, t),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'wa.pair', 'wa_pairs', ?, ?, ?, ?)`, businessId, userId, id, old.length ? JSON.stringify({ pairs: old }) : null,
      JSON.stringify({ upiItemId: upiId, billItemId: billId }), t),
  ]);
  return id;
}

/** A person takes a pair apart. Bookr will not pair those two again. */
export async function unpair(db: DB, businessId: string, pairId: string, userId: string) {
  const p = await one<{ upi_item_id: string; bill_item_id: string; confidence: number; reasons: string; by_hand: number }>(db,
    'SELECT upi_item_id, bill_item_id, confidence, reasons, by_hand FROM wa_pairs WHERE id = ? AND business_id = ?', pairId, businessId);
  if (!p) throw new PairError('Pair not found.');
  const t = now();
  await db.batch([
    stmt(db, 'DELETE FROM wa_pairs WHERE id = ?', pairId),
    stmt(db, `INSERT INTO wa_not_pairs (business_id, upi_item_id, bill_item_id, made_by, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`, businessId, p.upi_item_id, p.bill_item_id, userId, t),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'wa.unpair', 'wa_pairs', ?, ?, NULL, ?)`, businessId, userId, pairId, JSON.stringify(p), t),
  ]);
}
