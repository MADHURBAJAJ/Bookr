// Payment proof list (approved 24 Nov 2026). Cashiers settle as usual; nothing at the counter waits on WhatsApp. In the
// background each POS bill and receipt of the shift is matched to the proof staff post in the Guest payment group:
// a UPI screenshot, a card machine slip, or for cash the bill photo captioned "cash...". The POS shows the result to
// every cashier: matched, a difference (amount or mode), no proof yet; and the proof that fits no POS bill (extras).
// Bookr only reads and compares: nothing here changes a bill, a payment or a WhatsApp item.

import { all, type DB } from './db';
import { istToMs } from './time';
import { readCaption, type CaptionMode, type CaptionReading } from './waCaption';

export type PosMode = 'cash' | 'upi' | 'card' | 'room' | 'credit' | 'comp' | 'advance';
export interface ProofTender {
  paymentId: string;
  mode: PosMode;
  amountPaise: number;        // this bill's share
  totalPaise: number;         // the whole tender (one payment can settle bills paid together)
  cardApproval?: string | null;
  cardLast4?: string | null;
  paidAt: number;
}
export interface ProofBill {
  key: string;                // the POS bill id, or the payment id of a receipt
  billNo: string | null;
  kind: 'bill' | 'receipt';
  state: 'printed' | 'settled';
  totalPaise: number;
  discountPaise: number;
  at: number;                 // printed (a bill) or paid (a receipt)
  label: string | null;       // table, guest or the account a receipt is for
  tenders: ProofTender[];
  // A bill of another shift named by proof posted in this one (28 Nov 2026): matched like the others, but listed apart
  // ("Proof for earlier bills"), never as a row of this shift.
  context?: boolean;
  shiftDay?: string | null;
}
export interface ProofItem {
  id: string;
  kind: 'upi' | 'bill' | 'card' | 'other' | null;
  amountPaise: number | null;
  billNo: string | null;
  cardApproval: string | null;
  caption: string | null;
  sentAt: number;
  docAt?: number | null;      // the payment time printed on the screenshot or slip
  messageId: string;
  replyTo: string | null;
  sender: string | null;
}

export interface Evidence { itemId: string; kind: 'upi' | 'bill' | 'card'; amountPaise: number | null; sentAt: number; docAt: number | null; caption: string | null; how: string }
export type RowStatus = 'waiting' | 'matched' | 'difference' | 'missing' | 'not_needed';
export interface ProofRow {
  key: string; billNo: string | null; kind: 'bill' | 'receipt'; state: 'printed' | 'settled'; totalPaise: number; at: number; label: string | null;
  modes: { mode: PosMode; amountPaise: number }[];
  status: RowStatus;
  proof: Evidence[];
  differences: string[];
  missing: string[];
}
export interface Extra { itemIds: string[]; kind: 'upi' | 'bill' | 'card'; amountPaise: number | null; sentAt: number; caption: string | null; sender: string | null; what: string }
export interface EarlierRow extends ProofRow { shiftDay: string | null }
export interface ProofList { rows: ProofRow[]; extras: Extra[]; earlier: EarlierRow[] }

const MIN = 60_000;
const NEEDS_PROOF: PosMode[] = ['cash', 'upi', 'card'];
const NAME: Record<CaptionMode, string> = { cash: 'cash', upi: 'UPI', card: 'card' };
const OLD_MS = 3 * 60 * MIN; // a payment made 3 hours or more before its bill was printed
const wall = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const digits = (s: string) => s.replace(/\D/g, '');

/** The POS bills a reference in a caption or on a bill photo names: the full number ("C261124007", "261124007"), or the
 *  running number alone ("7", "007") when only one bill of the shift has it. */
export function billsNamed(ref: string, bills: ProofBill[]): ProofBill[] {
  const r = alnum(ref);
  if (!r) return [];
  const full = bills.filter((b) => b.billNo && (alnum(b.billNo) === r || (digits(r).length >= 6 && digits(b.billNo) === digits(r))));
  if (full.length) return full;
  if (!/^\d{1,4}$/.test(r)) return [];
  // Bookr POS numbers: letter, YYMMDD, then the number within the day.
  const short = bills.filter((b) => b.billNo && /^[A-Z]*\d{9,}$/.test(alnum(b.billNo)) && Number(digits(b.billNo).slice(6)) === Number(r));
  return short.length === 1 ? short : [];
}

/** Full Bookr POS bill numbers named by these photos (a caption, or the number printed on a bill photo): letter(s),
 *  YYMMDD, the number within the day, so the bill can be found whatever shift it is in. "C261128017", "261128017". */
export function namedBillNos(items: Pick<ProofItem, 'caption' | 'billNo' | 'kind'>[]): string[] {
  const out = new Set<string>();
  const add = (ref: string) => { const r = alnum(ref); if (/^[A-Z]{0,3}\d{9,12}$/.test(r)) out.add(r); };
  for (const i of items) {
    for (const ref of readCaption(i.caption).refs) add(ref);
    if (i.kind === 'bill' && i.billNo) add(i.billNo);
  }
  return [...out];
}

class Groups {
  private up = new Map<string, string>();
  find(a: string): string { const p = this.up.get(a) ?? a; if (p === a) return a; const r = this.find(p); this.up.set(a, r); return r; }
  join(a: string, b: string) { const x = this.find(a), y = this.find(b); if (x !== y) this.up.set(x, y); }
}

type Post = { id: string; items: ProofItem[]; captions: CaptionReading[]; bills: Set<string>; how: Map<string, string> };

/**
 * Matches the shift's bills and receipts to the proof posted. `pairs` are the UPI-and-bill-photo pairs already made in
 * the WhatsApp inbox. Items are those read, not duplicates and not failed payments. `from`/`to`: the shift, for extras.
 */
export function matchProof(bills: ProofBill[], items: ProofItem[], pairs: [string, string][], from: number, to: number): ProofList {
  const useful = items.filter((i) => i.kind === 'upi' || i.kind === 'bill' || i.kind === 'card');
  // A post: photos that go together, through WhatsApp replies or an inbox pair (the UPI photo and its bill photo).
  const g = new Groups();
  const byMsg = new Map(useful.map((i) => [i.messageId, i]));
  const ids = new Set(useful.map((i) => i.id));
  for (const i of useful) if (i.replyTo && byMsg.has(i.replyTo)) g.join(i.id, byMsg.get(i.replyTo)!.id);
  for (const [a, b] of pairs) if (ids.has(a) && ids.has(b)) g.join(a, b);
  const posts = new Map<string, Post>();
  for (const i of useful) {
    const k = g.find(i.id);
    const p: Post = posts.get(k) ?? { id: k, items: [], captions: [], bills: new Set(), how: new Map() };
    p.items.push(i);
    p.captions.push(readCaption(i.caption));
    posts.set(k, p);
  }
  const attach = (p: Post, b: ProofBill, how: string) => { p.bills.add(b.key); if (!p.how.has(b.key)) p.how.set(b.key, how); };

  // 1. Named: the bill number in a caption or printed on the bill photo.
  for (const p of posts.values()) {
    for (const [n, i] of p.items.entries()) {
      for (const ref of p.captions[n].refs) for (const b of billsNamed(ref, bills)) attach(p, b, 'bill no. in caption');
      if (i.kind === 'bill' && i.billNo) for (const b of billsNamed(i.billNo, bills)) attach(p, b, 'bill photo');
    }
  }
  const loose = () => [...posts.values()].filter((p) => !p.bills.size);
  const tenders = bills.flatMap((b) => b.tenders.map((t) => ({ b, t })));
  const hasProof = (b: ProofBill, kind: ProofItem['kind']) => [...posts.values()].some((p) => p.bills.has(b.key) && p.items.some((i) => i.kind === kind));

  // 2. A card slip with the approval code the cashier typed.
  for (const p of loose()) {
    const slip = p.items.find((i) => i.kind === 'card' && i.cardApproval);
    const hit = slip && tenders.find(({ t }) => t.mode === 'card' && t.cardApproval && alnum(t.cardApproval) === alnum(slip.cardApproval!));
    if (hit) attach(p, hit.b, 'approval code');
  }
  // 3. The rest by amount and time, closest first: a bill photo by its total, a UPI screenshot or card slip by the
  //    payment's whole amount, posted from an hour before the payment to two hours after.
  const near = (sentAt: number, at: number) => sentAt >= at - 60 * MIN && sentAt <= at + 120 * MIN;
  const offers: { p: Post; b: ProofBill; gap: number; how: string; slot: string }[] = [];
  for (const p of loose()) {
    const sum = (kind: ProofItem['kind']) => p.items.filter((i) => i.kind === kind).reduce((s, i) => s + (i.amountPaise ?? 0), 0);
    const first = Math.min(...p.items.map((i) => i.sentAt));
    for (const kind of ['upi', 'card'] as const) {
      const amount = sum(kind);
      if (!amount) continue;
      for (const { b, t } of tenders) {
        if (t.mode === kind && t.totalPaise === amount && near(first, t.paidAt)) {
          offers.push({ p, b, gap: Math.abs(first - t.paidAt), how: 'same amount and time', slot: `${t.paymentId}|${kind}` });
        }
      }
    }
    const photo = p.items.find((i) => i.kind === 'bill' && i.amountPaise);
    if (photo && !p.items.some((i) => i.kind !== 'bill')) {
      for (const b of bills) {
        if (b.kind === 'bill' && b.totalPaise === photo.amountPaise && near(photo.sentAt, b.at)) {
          offers.push({ p, b, gap: Math.abs(photo.sentAt - b.at), how: 'same total and time', slot: `${b.key}|bill` });
        }
      }
    }
  }
  offers.sort((x, y) => x.gap - y.gap);
  const taken = new Set<string>();
  for (const o of offers) {
    if (o.p.bills.size || taken.has(o.slot)) continue;
    // Two posts of the same amount at the same distance: leave both for a person.
    if (offers.some((x) => x.p !== o.p && x.slot === o.slot && x.gap === o.gap && !x.p.bills.size)) continue;
    const kind = o.slot.endsWith('|bill') ? 'bill' : o.slot.endsWith('|card') ? 'card' : 'upi';
    // One bill photo a bill; payments are told apart by their slot (a split can have two UPI screenshots).
    if (kind === 'bill' && hasProof(o.b, kind)) continue;
    taken.add(o.slot);
    for (const t of o.b.tenders) if (o.slot.startsWith(t.paymentId)) for (const x of tenders) if (x.t.paymentId === t.paymentId) attach(o.p, x.b, o.how);
    attach(o.p, o.b, o.how);
  }

  // 4. Each bill: what it needs against what was posted.
  const rowOf = (b: ProofBill): ProofRow => {
    const mine = [...posts.values()].filter((p) => p.bills.has(b.key));
    const proof: Evidence[] = mine.flatMap((p) => p.items.map((i) => ({ itemId: i.id, kind: i.kind as Evidence['kind'], amountPaise: i.amountPaise,
      sentAt: i.sentAt, docAt: i.docAt ?? null, caption: i.caption, how: p.how.get(b.key)! })));
    const captions = mine.flatMap((p) => p.captions);
    const modes = new Map<PosMode, number>();
    const seen = new Set<string>();
    for (const t of b.tenders) {
      // A payment shared with other bills is proved by its whole amount.
      if (seen.has(t.paymentId)) continue;
      seen.add(t.paymentId);
      modes.set(t.mode, (modes.get(t.mode) ?? 0) + (NEEDS_PROOF.includes(t.mode) ? t.totalPaise : t.amountPaise));
    }
    // One payment posted for several bills (a caption naming two bills, or bills paid together): checked against what
    // those bills together were settled by in that mode, each payment counted once.
    const together = (mode: CaptionMode, has: (p: Post) => boolean) => {
      const keys = new Set<string>([b.key]);
      for (const p of mine) if (has(p)) for (const k of p.bills) keys.add(k);
      const group = bills.filter((x) => keys.has(x.key));
      const paid = new Map<string, number>();
      for (const x of group) for (const t of x.tenders) if (t.mode === mode) paid.set(t.paymentId, t.totalPaise);
      const names = group.length > 1 ? ` for ${group.map((x) => x.billNo ?? 'a receipt').join(' + ')}` : '';
      return { need: [...paid.values()].reduce((a, v) => a + v, 0), names, many: group.length > 1 };
    };
    const differences: string[] = [];
    const missing: string[] = [];
    const posted = (kind: 'upi' | 'card') => proof.filter((e) => e.kind === kind);
    const said = (mode: CaptionMode) => captions.flatMap((c) => c.tenders.filter((t) => t.mode === mode));
    if (b.state === 'settled') {
      for (const mode of NEEDS_PROOF as CaptionMode[]) {
        const need = modes.get(mode);
        if (mode === 'cash') {
          const notes = said('cash');
          if (need && !notes.length) missing.push('No cash note');
          const written = notes.filter((n) => n.amountPaise != null).reduce((s, n) => s + n.amountPaise!, 0);
          const all = together('cash', (p) => p.captions.some((c) => c.tenders.some((t) => t.mode === 'cash')));
          if (need && written && written !== all.need) differences.push(`Cash ${rs(written)} in caption, settled ${rs(all.need)} cash${all.names}`);
          if (!need && notes.length) differences.push(`Caption says cash, settled as ${settledAs(modes)}`);
          continue;
        }
        const ev = posted(mode);
        const got = ev.reduce((s, e) => s + (e.amountPaise ?? 0), 0);
        if (need && !ev.length) missing.push(mode === 'upi' ? 'No UPI screenshot' : 'No card slip');
        const all = together(mode, (p) => p.items.some((i) => i.kind === mode));
        if (need && ev.length && got && got !== all.need) differences.push(`${NAME[mode]} ${rs(got)} posted, settled ${rs(all.need)} ${NAME[mode]}${all.names}`);
        if (!need && ev.length && !(all.many && got === all.need)) differences.push(`${mode === 'upi' ? 'UPI screenshot' : 'Card slip'} ${got ? `${rs(got)} ` : ''}posted, settled as ${settledAs(modes)}`);
        if (!need && !ev.length && said(mode).length) differences.push(`Caption says ${NAME[mode]}, settled as ${settledAs(modes)}`);
      }
      const disc = captions.find((c) => c.discountPaise != null)?.discountPaise;
      // An old screenshot or slip posted again for this bill: its payment was made well before the bill was printed.
      for (const e of proof) {
        if ((e.kind === 'upi' || e.kind === 'card') && e.docAt != null && e.docAt < b.at - OLD_MS) {
          differences.push(`${e.kind === 'upi' ? 'Screenshot' : 'Card slip'} is from ${wall(e.docAt)}, before the bill`);
        }
      }
      if (disc != null && disc !== b.discountPaise) differences.push(`Discount ${rs(disc)} in caption, ${rs(b.discountPaise)} on the bill`);
    }
    const needsAny = [...modes.keys()].some((m) => NEEDS_PROOF.includes(m));
    const status: RowStatus = b.state === 'printed' ? 'waiting'
      : differences.length ? 'difference' : missing.length ? 'missing' : needsAny || proof.length ? 'matched' : 'not_needed';
    return { key: b.key, billNo: b.billNo, kind: b.kind, state: b.state, totalPaise: b.totalPaise, at: b.at, label: b.label,
      modes: [...modes].map(([mode, amountPaise]) => ({ mode, amountPaise })), status, proof, differences, missing };
  };
  const rows = bills.filter((b) => !b.context).map(rowOf);
  // Bills of other shifts with proof posted in this one.
  const inShift = (e: Evidence) => e.sentAt >= from && e.sentAt < to;
  const earlier: EarlierRow[] = bills.filter((b) => b.context).map((b) => ({ ...rowOf(b), shiftDay: b.shiftDay ?? null }))
    .filter((r) => r.proof.some(inShift)).sort((a, b) => a.at - b.at);

  // 5. Extras: proof posted in the shift that fits no POS bill. A bill photo counts only when it says how it was paid
  //    or names a bill the POS does not have.
  const extras: Extra[] = [];
  for (const p of loose()) {
    const first = p.items.reduce((a, i) => (i.sentAt < a.sentAt ? i : a));
    if (first.sentAt < from || first.sentAt >= to) continue;
    const pay = p.items.find((i) => i.kind === 'upi' || i.kind === 'card');
    const photo = p.items.find((i) => i.kind === 'bill');
    const cash = p.captions.flatMap((c) => c.tenders).find((t) => t.mode === 'cash');
    if (!pay && !cash && !photo?.billNo) continue;
    const main = pay ?? photo ?? first;
    const amount = pay ? p.items.filter((i) => i.kind === main.kind).reduce((s, i) => s + (i.amountPaise ?? 0), 0) || null
      : cash?.amountPaise ?? photo?.amountPaise ?? null;
    const what = pay ? `${pay.kind === 'upi' ? 'UPI' : 'Card'}${amount ? ` ${rs(amount)}` : ''}, no POS bill`
      : `${cash ? 'Cash' : 'Bill photo'}${photo?.billNo ? ` bill ${photo.billNo}` : ''}${amount ? ` ${rs(amount)}` : ''}, not in the POS`;
    extras.push({ itemIds: p.items.map((i) => i.id), kind: main.kind as Extra['kind'], amountPaise: amount, sentAt: first.sentAt,
      caption: p.items.map((i) => i.caption).filter(Boolean).join(' / ') || null, sender: first.sender, what });
  }
  extras.sort((a, b) => a.sentAt - b.sentAt);
  return { rows, extras, earlier };
}

function settledAs(modes: Map<PosMode, number>) {
  const m = [...modes.keys()];
  return m.length ? m.map((x) => (x === 'upi' ? 'UPI' : x)).join(' + ') : 'nothing';
}

// ----- in the database

/** The shift's window: from its start hour on the day to the same hour the next day (India time). */
export function shiftWindow(day: string, startHour: number): [number, number] {
  const [y, m, d] = day.split('-').map(Number);
  const from = istToMs(y, m, d, startHour);
  return [from, from + 24 * 60 * MIN];
}

/** The proof posted around a shift in the business's proof groups, and how many photos are still being read. */
export async function loadProof(db: DB, businessId: string, from: number, to: number, billNos: (string | null)[] = []) {
  // A bill number or a reply can tie a photo posted a little before the shift, or after it, to a bill of the shift.
  const lo = from - 6 * 60 * MIN, hi = to + 6 * 60 * MIN;
  // Proof posted later still for a bill of this shift (an old bill paid days after): found by the date part of its
  // number in a caption or on a bill photo, up to 30 days on (28 Nov 2026).
  const dates = [...new Set(billNos.map((n) => digits(n ?? '')).filter((d) => d.length >= 9).map((d) => d.slice(0, 6)))].slice(0, 4);
  const late = dates.length ? ` OR (i.sent_at > ? AND i.sent_at <= ? AND (${dates.map(() => '(i.caption LIKE ? OR i.bill_no LIKE ?)').join(' OR ')}))` : '';
  const lateArgs = dates.length ? [hi, hi + 30 * 24 * 60 * MIN, ...dates.flatMap((d) => [`%${d}%`, `%${d}%`])] : [];
  const rows = await all<{ id: string; kind: ProofItem['kind']; amount_paise: number | null; bill_no: string | null; card_approval: string | null;
    caption: string | null; sent_at: number; doc_at: number | null; wa_message_id: string; reply_to_id: string | null; sender: string | null; read_status: string; status: string }>(db,
    `SELECT i.id, i.kind, i.amount_paise, i.bill_no, i.card_approval, i.caption, i.sent_at, i.doc_at, i.wa_message_id, i.reply_to_id,
       coalesce(i.sender_name, i.sender_number) AS sender, i.read_status, i.status
     FROM wa_items i JOIN wa_groups g ON g.id = i.group_id
     WHERE i.business_id = ? AND g.pos_proof = 1 AND (i.sent_at BETWEEN ? AND ?${late}) ORDER BY i.sent_at`, businessId, lo, hi, ...lateArgs);
  const items: ProofItem[] = rows.filter((r) => r.read_status === 'read' && r.status !== 'rejected' && r.status !== 'duplicate')
    .map((r) => ({ id: r.id, kind: r.kind, amountPaise: r.amount_paise, billNo: r.bill_no, cardApproval: r.card_approval, caption: r.caption,
      sentAt: r.sent_at, docAt: r.doc_at, messageId: r.wa_message_id, replyTo: r.reply_to_id, sender: r.sender }));
  const reading = rows.filter((r) => (r.read_status === 'waiting' || r.read_status === 'reading') && r.sent_at >= from && r.sent_at < to).length;
  const ids = items.map((i) => i.id);
  const pairs: [string, string][] = [];
  // 40 at a time: each id is bound twice, and D1 refuses more than 100 bound values (a busy shift has well over 50 photos).
  for (let k = 0; k < ids.length; k += 40) {
    const part = ids.slice(k, k + 40);
    const marks = part.map(() => '?').join(',');
    for (const p of await all<{ upi_item_id: string; bill_item_id: string }>(db,
      `SELECT upi_item_id, bill_item_id FROM wa_pairs WHERE upi_item_id IN (${marks}) OR bill_item_id IN (${marks})`, ...part, ...part)) {
      pairs.push([p.upi_item_id, p.bill_item_id]);
    }
  }
  return { items, pairs, reading };
}
