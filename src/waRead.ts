// WhatsApp inbox, phase 2 (approved 24 Nov 2026): reading each stored file with Claude. The minute job (and a nudge
// right after a file arrives) reads waiting files: a UPI payment screenshot or a bill, or neither. What was read goes
// into extracted_json and a few columns for pairing; a person still reviews every item. A failed payment is set aside
// (rejected, with a note); a file that is neither is deleted after a week if nobody touched it.

import { z } from 'zod';
import type { Env } from './types';
import { all, now, one, stmt, type DB } from './db';
import { OcrError, readWithClaude, type PageImage } from './claude';
import { parsePaise } from './money';
import { istDay, istToMs } from './time';
import { findDuplicate, markDuplicate, pairGroup } from './waPair';

const Rupees = z.string().nullable().describe('Rupees exactly as shown: digits with a decimal point if shown, no ₹ sign, no commas. null if not shown or unreadable.');
const Text = z.string().nullable();

export const WaReading = z.object({
  kind: z.enum(['upi', 'bill', 'card', 'other']).describe('upi: a UPI payment screen or receipt (Paytm, Google Pay, PhonePe, a bank app, or a photo of a phone showing one). bill: a printed bill or invoice. card: a card machine (POS terminal) charge slip, or a photo of the card machine\'s own screen showing a card payment. other: anything else.'),
  legible: z.enum(['clear', 'unsure', 'unreadable']).describe('clear: every value you give is plainly readable. unsure: some values are a best guess (blur, glare, cracks, partly covered). unreadable: the key values cannot be read.'),
  upi: z.object({
    amount: Rupees,
    date: Text.describe('Payment date exactly as shown, e.g. "23 Nov", "23 November 2026". null if not shown. Not the phone\'s clock in the status bar.'),
    time: Text.describe('Payment time exactly as shown, e.g. "9:08 PM". null if not shown. Not the phone\'s clock in the status bar.'),
    utr: Text.describe('The UPI reference: "UPI transaction ID", "UPI Ref No", "Ref. No", "UTR" or "Transaction ID", exactly as shown. null if none is shown.'),
    app: Text.describe('The app, e.g. Paytm, Google Pay, PhonePe, Navi, Kotak811, BHIM.'),
    payer_name: Text,
    payer_vpa: Text.describe('Payer UPI ID if shown.'),
    payer_bank: Text.describe('The paying bank and last digits if shown, e.g. "Union Bank of India - 0668".'),
    payee_name: Text,
    payee_vpa: Text.describe('Payee UPI ID if shown, e.g. exosparkgoainn@icici.'),
    status: z.enum(['success', 'failed', 'pending', 'unknown']).describe('success only when the screen shows the payment went through (Paid, Payment successful, a green tick).'),
  }).nullable().describe('Fill only when kind is upi; otherwise null.'),
  bill: z.object({
    vendor: Text.describe('The name printed at the top.'),
    bill_no: Text.describe('Bill No / Invoice No exactly as printed.'),
    date: Text.describe('Bill date exactly as printed, e.g. "23/11/26".'),
    time: Text.describe('Bill time exactly as printed, e.g. "21:08". null if not printed.'),
    sub_total: Rupees,
    service_charge: Rupees,
    gst: Rupees.describe('All GST added together (CGST + SGST, or IGST). null if none.'),
    total: Rupees.describe('Grand total / amount payable.'),
    items: Text.describe('A short summary of the items, e.g. "2 Heineken, 1 Sev Puri".'),
  }).nullable().describe('Fill only when kind is bill; otherwise null.'),
  card: z.object({
    source: z.enum(['slip', 'screen']).optional().describe('slip: the printed charge slip. screen: a photo of the card machine\'s display, with no slip.'),
    amount: Rupees.describe('The amount charged (AMOUNT / TOTAL / SALE), on the slip or the machine\'s screen. Rupees as shown, no ₹ sign, no commas.'),
    date: Text.describe('Date exactly as printed or shown on the machine. null if not shown. Not a phone\'s clock.'),
    time: Text.describe('Time exactly as printed or shown on the machine. null if not shown. Not a phone\'s clock.'),
    approval_code: Text.describe('APPR CODE / AUTH CODE / Approval code exactly as printed or shown. null if not shown (a machine\'s screen often shows none).'),
    last4: Text.describe('The last 4 digits of the card number (printed like XXXX XXXX XXXX 1234). Digits only. null if not shown.'),
    status: z.enum(['approved', 'declined', 'unknown']).describe('approved only when the slip or screen says APPROVED / SALE completed / Transaction successful; declined when it says DECLINED, VOID or failed.'),
  }).nullable().describe('Fill only when kind is card; otherwise null.'),
  unclear: z.array(z.string()).describe('Names of the fields that are shown but could not be read with confidence. A field the image simply does not show is null and is not listed here.'),
});
export type WaReading = z.infer<typeof WaReading>;

const pad = (n: number) => String(n).padStart(2, '0');
function istWall(ms: number) {
  const t = new Date(ms + (5 * 60 + 30) * 60 * 1000);
  return `${istDay(ms)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** What Claude is asked. The caption and time help only with the year and context: the picture decides the values. */
export function waInstructions(item: { sent_at: number; caption: string | null; group_name: string }) {
  return [
    'This image or PDF was posted in a WhatsApp work group of a hotel in Goa, India. It is usually a guest\'s UPI payment screen (often a photo of the guest\'s phone), a printed bill from the hotel, a card machine\'s charge slip, or a photo of the card machine\'s screen after a card payment.',
    `Message details: group "${item.group_name}", sent ${istWall(item.sent_at)} India time${item.caption ? `, caption "${item.caption.slice(0, 200)}"` : ''}.`,
    'Read only what the image shows. Never fill a value from the caption or guess one: give null and name the field in unclear instead.',
    'Ignore adverts, offers, scratch cards and rewards on payment screens.',
    'If the payment screen is blurred, tilted or partly covered, still give what you can read and set legible to unsure.',
  ].join('\n');
}

const KEY_FIELDS = new Set(['amount', 'date', 'time', 'utr', 'status', 'bill_no', 'total', 'approval_code']);

export interface WaRead {
  kind: 'upi' | 'bill' | 'card' | 'other';
  amountPaise: number | null;
  utr: string | null;
  billNo: string | null;
  cardApproval: string | null;
  cardLast4: string | null;
  docAt: number | null;
  failed: boolean;
  notes: string[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A date as written on a screen or bill (Claude copies it as shown): "2026-11-23", "23/11/26" (day first, as in India),
 *  "23 Nov", "23 November 2026", "Nov 23, 2026". With no year: the message's year, or the year before when that would
 *  put it days after the message (a 31 Dec payment sent on 1 Jan). null when it is not a real date. */
export function parseDate(text: string | null, sentAt: number): { y: number; m: number; d: number } | null {
  const v = (text ?? '').trim().replace(/\s+/g, ' ');
  let y: number | null = null, m = 0, d = 0;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v))) { d = +r[1]; m = +r[2]; y = r[3].length === 2 ? 2000 + +r[3] : +r[3]; }
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.?,? ?(\d{4})?$/.exec(v))) { d = +r[1]; m = MONTHS.indexOf(r[2].slice(0, 3).toLowerCase()) + 1; y = r[3] ? +r[3] : null; }
  else if ((r = /^([A-Za-z]{3,9})\.? (\d{1,2}),? ?(\d{4})?$/.exec(v))) { m = MONTHS.indexOf(r[1].slice(0, 3).toLowerCase()) + 1; d = +r[2]; y = r[3] ? +r[3] : null; }
  else return null;
  if (!m) return null;
  if (y == null) {
    y = +istDay(sentAt).slice(0, 4);
    if (istToMs(y, m, d) > sentAt + 2 * 86400_000) y -= 1;
  }
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** A time as written: "21:08", "9:08 PM", "10:00 pm", "12:09 AM", "1.47 a.m.". → [hour (0-23), minute]; null if not one. */
export function parseTime(text: string | null): [number, number] | null {
  const r = /^(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([ap])?\.?\s*(?:m\.?)?$/i.exec((text ?? '').trim());
  if (!r) return null;
  let h = +r[1];
  const mi = +r[2];
  if (r[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (r[3].toLowerCase() === 'p' ? 12 : 0);
  }
  return h <= 23 && mi <= 59 ? [h, mi] : null;
}

/** The moment a screen or bill shows (India time). A time with no date takes the message's day, or the day before when
 *  that would put it after the message (paid 23:58, sent 00:02). A date with no time is not placed. */
export function docTime(date: string | null, time: string | null, sentAt: number): number | null {
  const hm = parseTime(time);
  if (!hm) return null;
  const day = parseDate(date, sentAt);
  if (day) return istToMs(day.y, day.m, day.d, hm[0], hm[1]);
  if (date && date.trim()) return null; // a date was shown but not understood: do not guess the day
  const [y, m, d] = istDay(sentAt).split('-').map(Number);
  const at = istToMs(y, m, d, hm[0], hm[1]);
  return at > sentAt + 10 * 60_000 ? at - 86400_000 : at;
}

const money = (v: string | null | undefined) => {
  const p = v == null ? null : parsePaise(v);
  return p != null && p > 0 ? p : null;
};

/** Turns Claude's reading into the columns kept for pairing, with notes for the reviewer. */
export function settle(r: WaReading, sentAt: number): WaRead {
  const notes: string[] = [];
  if (r.legible === 'unreadable') notes.push('Too unclear to read; check it by hand.');
  else {
    // Only the values Bookr uses; payer details a screen does not show are no reason to check.
    const key = r.unclear.filter((f) => KEY_FIELDS.has(f));
    if (key.length) notes.push(`Check: ${key.join(', ')}.`);
    else if (r.legible === 'unsure') notes.push('Check: some values are a best guess.');
  }
  let out: WaRead = { kind: r.kind, amountPaise: null, utr: null, billNo: null, cardApproval: null, cardLast4: null, docAt: null, failed: false, notes };
  if (r.kind === 'upi' && r.upi) {
    const u = r.upi;
    out = { ...out, amountPaise: money(u.amount), utr: u.utr?.replace(/\s+/g, '') || null, docAt: docTime(u.date, u.time, sentAt) };
    if (u.status === 'failed') { out.failed = true; notes.unshift('The screenshot shows a failed payment.'); }
    else if (u.status !== 'success') notes.push(`Payment status: ${u.status}.`);
  } else if (r.kind === 'bill' && r.bill) {
    const b = r.bill;
    out = { ...out, amountPaise: money(b.total), billNo: b.bill_no?.trim() || null, docAt: docTime(b.date, b.time, sentAt) };
  } else if (r.kind === 'card' && r.card) {
    const c = r.card;
    const last4 = (c.last4 ?? '').replace(/\D/g, '').slice(-4);
    out = { ...out, amountPaise: money(c.amount), cardApproval: c.approval_code?.replace(/\s+/g, '').toUpperCase() || null,
      cardLast4: last4.length === 4 ? last4 : null, docAt: docTime(c.date, c.time, sentAt) };
    if (c.source === 'screen') notes.push('A photo of the card machine screen, not the printed slip.');
    if (c.status === 'declined') { out.failed = true; notes.unshift(`${c.source === 'screen' ? 'The card machine screen' : 'The slip'} shows a declined or void charge.`); }
    else if (c.status !== 'approved') notes.push('Card slip: approval not clear.');
  }
  if (out.kind !== 'other' && !out.amountPaise && r.legible !== 'unreadable') notes.push('No amount read.');
  // A time printed after the message was sent, or days before it, is most likely misread.
  if (out.docAt && (out.docAt > sentAt + 10 * 60_000 || out.docAt < sentAt - 3 * 86400_000)) {
    notes.push(`The time read (${istWall(out.docAt)}) is far from when it was sent.`);
  }
  return out;
}

// ----- the queue

const STALE_MS = 5 * 60_000; // a read still running after this is treated as abandoned
const MAX_TRIES = 3;
const OTHER_KEEP_MS = 7 * 86400_000;

export const waLimits = (env: Env) => {
  const n = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return { daily: n(env.WA_DAILY_READ_LIMIT, 150), parallel: n(env.OCR_MAX_PARALLEL, 3) };
};

const dayStart = (t: number) => { const [y, m, d] = istDay(t).split('-').map(Number); return istToMs(y, m, d); };

/** Reads counted today (India time), across businesses: one listener, one limit. A read Claude never did is free. */
export async function readsToday(db: DB, t = now()) {
  const r = await one<{ n: number }>(db, `SELECT count(*) AS n FROM audit_log WHERE action = 'wa.read' AND created_at >= ?
    AND json_extract(after, '$.free') IS NOT 1`, dayStart(t));
  return r?.n ?? 0;
}

type Item = { id: string; business_id: string; group_id: string; file_key: string; media_type: PageImage['mediaType']; sent_at: number; caption: string | null; group_name: string; read_tries: number };

/** One step of the queue: tidy up, then read what is waiting, within today's limit and a few at a time. */
export async function runWaQueue(env: Env): Promise<{ read: number; failed: number; skipped: string | null }> {
  const db = env.DB;
  const t = now();
  await deleteOldOther(env, t);
  if (!env.ANTHROPIC_API_KEY) return { read: 0, failed: 0, skipped: 'no key' };
  await stmt(db, `UPDATE wa_items SET read_status = 'waiting' WHERE read_status = 'reading' AND read_started_at < ?`, t - STALE_MS).run();
  const l = waLimits(env);
  const room = l.daily - await readsToday(db, t);
  if (room <= 0) return { read: 0, failed: 0, skipped: 'daily limit' };
  const running = (await one<{ n: number }>(db, `SELECT count(*) AS n FROM wa_items WHERE read_status = 'reading'`))?.n ?? 0;
  const take = Math.min(room, l.parallel - running);
  if (take <= 0) return { read: 0, failed: 0, skipped: 'busy' };
  const waiting = await all<Item>(db, `SELECT i.id, i.business_id, i.group_id, i.file_key, i.media_type, i.sent_at, i.caption, g.name AS group_name, i.read_tries
    FROM wa_items i JOIN wa_groups g ON g.id = i.group_id
    WHERE i.read_status = 'waiting' AND coalesce(i.read_after, 0) <= ? ORDER BY i.sent_at LIMIT ?`, t, take);
  let read = 0, failed = 0;
  const done: Item[] = [];
  await Promise.all(waiting.map(async (it) => {
    // Claim it: another run (the minute job, or the nudge after a file arrives) may have taken it already.
    const claim = await stmt(db, `UPDATE wa_items SET read_status = 'reading', read_started_at = ? WHERE id = ? AND read_status = 'waiting'`, t, it.id).run();
    if (!claim.meta.changes) return;
    const ok = await readItem(env, it);
    if (ok) { read += 1; done.push(it); } else failed += 1;
  }));
  // Then, one at a time: a payment or bill posted twice is set aside, and each group's pairs are worked out again.
  for (const it of done.sort((a, b) => a.sent_at - b.sent_at)) {
    const of = await findDuplicate(db, it.id);
    if (of) await markDuplicate(db, it.id, of);
  }
  const groups = new Map<string, [number, number]>();
  for (const it of done) {
    const g = groups.get(it.group_id);
    groups.set(it.group_id, g ? [Math.min(g[0], it.sent_at), Math.max(g[1], it.sent_at)] : [it.sent_at, it.sent_at]);
  }
  for (const [groupId, [from, to]] of groups) await pairGroup(db, groupId, from, to);
  return { read, failed, skipped: null };
}

async function readItem(env: Env, it: Item): Promise<boolean> {
  const db = env.DB;
  const audit = (after: Record<string, unknown>) => stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    VALUES (?, NULL, 'wa.read', 'wa_items', ?, NULL, ?, ?)`, it.business_id, it.id, JSON.stringify(after), now());
  const obj = await env.UPLOADS.get(it.file_key);
  if (!obj) {
    await stmt(db, `UPDATE wa_items SET read_status = 'failed', read_note = 'The file is missing from storage.' WHERE id = ?`, it.id).run();
    return false;
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  try {
    const { data, model } = await readWithClaude(env, { bytes, mediaType: it.media_type }, waInstructions(it), WaReading);
    const s = settle(data, it.sent_at);
    await db.batch([
      stmt(db, `UPDATE wa_items SET read_status = 'read', read_tries = read_tries + 1, read_after = NULL, kind = ?, extracted_json = ?,
          amount_paise = ?, utr = ?, bill_no = ?, card_approval = ?, card_last4 = ?, doc_at = ?, read_note = ?,
          status = CASE WHEN ? AND status = 'pending' THEN 'rejected' ELSE status END WHERE id = ?`,
        s.kind, JSON.stringify({ model, reading: data }), s.amountPaise, s.utr, s.billNo, s.cardApproval, s.cardLast4, s.docAt, s.notes.join(' ') || null,
        s.failed ? 1 : 0, it.id),
      audit({ ok: true, model, kind: s.kind }),
    ]);
    return true;
  } catch (e) {
    const err = e instanceof OcrError ? e : new OcrError(502, 'Reading failed unexpectedly.');
    if (!(e instanceof OcrError)) console.error('wa read', e);
    const tries = it.read_tries + (err.free ? 0 : 1);
    const last = !err.free && (tries >= MAX_TRIES || err.status === 400);
    // Busy or not set up: try again in a minute. Claude could not read it: wait longer each time, then give up.
    const after = now() + (err.free ? 60_000 : 2 ** tries * 60_000);
    await db.batch([
      stmt(db, `UPDATE wa_items SET read_status = ?, read_tries = ?, read_after = ?, read_note = ? WHERE id = ?`,
        last ? 'failed' : 'waiting', tries, last ? null : after, err.message.slice(0, 300), it.id),
      audit({ ok: false, free: err.free ? 1 : 0, error: err.message.slice(0, 200), ...(err.detail ? { detail: err.detail } : {}) }),
    ]);
    return false;
  }
}

/** A file that is neither a payment nor a bill is kept a week, then deleted (file and row) if nobody touched it. */
async function deleteOldOther(env: Env, t: number) {
  const old = await all<{ id: string; file_key: string }>(env.DB, `SELECT id, file_key FROM wa_items
    WHERE kind = 'other' AND status = 'pending' AND created_at < ? LIMIT 50`, t - OTHER_KEEP_MS);
  for (const o of old) {
    await env.UPLOADS.delete(o.file_key);
    await stmt(env.DB, 'DELETE FROM wa_items WHERE id = ?', o.id).run();
  }
}
