// Mail sent to Bookr's address (Cloudflare Email Routing → this Worker's email handler). Gmail forwards the card
// company's daily settlement mail here. The raw mail is kept in R2 first, so nothing is lost when it cannot be read;
// then its card report is read into card_settlements. Nothing is matched or booked here: a person confirms on Card settlements.

import PostalMime, { type Address, type Email } from 'postal-mime';
import type { Env } from './types';
import { newId, now, one, stmt, type DB } from './db';
import { isCardReportName, readCardReport } from './cardsettlement';
import { importCardLines } from './cards';

const GMAIL_CONFIRM = 'forwarding-noreply@google.com';

/** The business an address belongs to, from MAIL_ROUTES. */
export function businessFor(env: Env, to: string): string | null {
  try {
    const routes = JSON.parse(env.MAIL_ROUTES ?? '{}') as Record<string, string>;
    const hit = Object.entries(routes).find(([addr]) => addr.trim().toLowerCase() === to.trim().toLowerCase());
    return hit?.[1] ?? null;
  } catch { return null; }
}

/** Whether CARD_MAIL_FROM lets this sender in (an address, or "@domain"). Not set: everyone. */
export function senderAllowed(env: Env, from: string): boolean {
  const list = (env.CARD_MAIL_FROM ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const f = from.toLowerCase();
  return !list.length || list.some((x) => (x.startsWith('@') ? f.endsWith(x) : f === x));
}

const addressOf = (a: Address | undefined) => (a && 'address' in a && a.address ? a.address : a?.group?.[0]?.address ?? '').toLowerCase();

/** Cloudflare's email handler. A mail Bookr does not want is turned away, so it bounces back to Gmail and shows there. */
export async function receiveMail(message: ForwardableEmailMessage, env: Env) {
  const businessId = businessFor(env, message.to);
  if (!businessId) { message.setReject('This address is not set up in Bookr.'); return; }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const mail = await PostalMime.parse(raw);
  const from = addressOf(mail.from);
  if (from !== GMAIL_CONFIRM && !senderAllowed(env, from)) { message.setReject('Bookr only reads mail from the card company.'); return; }
  await storeMail(env, businessId, raw, mail);
}

/** Keeps the mail (once per Message-ID) and reads it. Returns the stored mail's id, or null when it was already there. */
export async function storeMail(env: Env, businessId: string, raw: Uint8Array, mail?: Email) {
  const db = env.DB;
  mail ??= await PostalMime.parse(raw);
  const messageId = (mail.messageId ?? '').trim() || `sha256:${await sha256(raw)}`;
  if (await one(db, 'SELECT 1 FROM inbound_mails WHERE business_id = ? AND message_id = ?', businessId, messageId)) return null;
  const id = newId();
  const key = `mail/${businessId}/${id}.eml`;
  await env.UPLOADS.put(key, raw, { httpMetadata: { contentType: 'message/rfc822' } });
  const t = now();
  const receivedAt = mail.date && !Number.isNaN(Date.parse(mail.date)) ? Date.parse(mail.date) : t;
  await stmt(db, `INSERT INTO inbound_mails (id, business_id, message_id, from_addr, subject, received_at, r2_key, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', 'Not read yet.', ?) ON CONFLICT (business_id, message_id) DO NOTHING`,
    id, businessId, messageId, addressOf(mail.from), (mail.subject ?? '').slice(0, 300), receivedAt, key, t).run();
  await readMail(db, businessId, id, mail);
  return id;
}

/** Reads a stored mail's card report(s) and notes what happened on the mail. */
export async function readMail(db: DB, businessId: string, mailId: string, mail: Email) {
  let status: 'read' | 'failed' | 'ignored';
  let note: string;
  if (addressOf(mail.from) === GMAIL_CONFIRM) {
    // Gmail sends a link to confirm forwarding to this address; the Owner opens it once.
    const link = /https:\/\/(?:mail-settings\.google\.com|mail\.google\.com)\/\S+/.exec(mail.text ?? mail.html ?? '')?.[0]?.replace(/[)>."']+$/, '');
    const code = /confirmation code:?\s*(\d{6,})/i.exec(mail.text ?? '')?.[1];
    status = 'ignored';
    note = `Gmail asks to confirm forwarding to Bookr.${link ? ` Open ${link}` : ''}${code ? ` (code ${code})` : ''}`;
  } else {
    const files = mail.attachments.filter((a) => a.filename && /\.xlsx$/i.test(a.filename));
    const reports = files.filter((a) => isCardReportName(a.filename!));
    const chosen = reports.length ? reports : files;
    if (!chosen.length) {
      status = 'ignored';
      note = 'No card settlement report (.xlsx) attached.';
    } else {
      const parts: string[] = [];
      let read = 0;
      for (const a of chosen) {
        const bytes = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content as ArrayBuffer);
        const r = await readReportFile(db, businessId, mailId, a.filename!, bytes);
        if (r.ok) read += 1;
        parts.push(r.note);
      }
      status = read ? 'read' : 'failed';
      note = parts.join(' · ');
    }
  }
  await stmt(db, 'UPDATE inbound_mails SET status = ?, note = ? WHERE id = ?', status, note.slice(0, 1000), mailId).run();
  return { status, note };
}

/** Reads one card report file (from a mail or the Drive folder) into card_settlements. */
export async function readReportFile(db: DB, businessId: string, mailId: string, name: string, bytes: Uint8Array) {
  const r = await readCardReport(bytes);
  if (!r.lines.length) return { ok: false, added: 0, note: `${name}: ${r.problems[0] ?? 'nothing read'}` };
  const done = await importCardLines(db, businessId, name, mailId, r.lines);
  return { ok: true, added: done.added,
    note: `${name}: ${done.added} new payment${done.added === 1 ? '' : 's'}${done.skipped ? `, ${done.skipped} already in Bookr` : ''}${r.problems.length ? `; ${r.problems.join(' ')}` : ''}` };
}

async function sha256(bytes: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
