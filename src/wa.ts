// WhatsApp inbox (approved 24 Nov 2026). A read-only listener on the reception number (listener/) sends UPI payment
// screenshots and bills from chosen groups. It is not a person, so it does not sign in: it sends a shared secret in a
// header, checked here. Only groups set up and active in wa_groups are stored; everything else is dropped unseen.

import { z } from 'zod';
import type { Env } from './types';
import { newId, now, one, stmt, type DB } from './db';
import { sniffImage } from './files';

export const WA_SECRET_HEADER = 'X-Bookr-WA-Secret';
export const WA_MAX_BYTES = 10 * 1024 * 1024;

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Whether the header holds the secret (or the one before it, while the listener is moved to a new one). */
export async function secretOk(env: Env, given: string | undefined): Promise<'ok' | 'wrong' | 'not_set'> {
  const secrets = [env.WA_INGEST_SECRET, env.WA_INGEST_SECRET_OLD].filter((s): s is string => !!s && s.length >= 16);
  if (!secrets.length) return 'not_set';
  if (!given) return 'wrong';
  // Compared as digests, every byte, so the time taken says nothing about how much of it was right.
  const g = await digest(given);
  let hit = false;
  for (const s of secrets) {
    const d = await digest(s);
    let diff = 0;
    for (let i = 0; i < d.length; i++) diff |= d[i] ^ g[i];
    if (diff === 0) hit = true;
  }
  return hit ? 'ok' : 'wrong';
}

/** What the listener sends with each file (the "meta" form field, JSON). */
export const IngestMeta = z.object({
  messageId: z.string().trim().min(1).max(128),
  groupId: z.string().trim().regex(/^[0-9-]+@g\.us$/, 'groupId must be a WhatsApp group id (…@g.us).'),
  groupName: z.string().trim().max(200).optional(),
  senderNumber: z.string().trim().max(32).optional(),
  senderName: z.string().trim().max(200).optional(),
  sentAt: z.number().int().min(Date.UTC(2020, 0, 1)),
  mediaType: z.enum(['image', 'document']),
  caption: z.string().max(2000).optional(),
  /** The message this one quotes (a bill photo sent as a reply to its UPI photo): the strongest sign of a pair. */
  replyTo: z.string().trim().min(1).max(128).optional(),
});
export type IngestMeta = z.infer<typeof IngestMeta>;

export type IngestResult =
  | { stored: true; id: string }
  | { stored: false; reason: 'group_not_listed' | 'same_message' | 'same_file'; id?: string };

async function hex(bytes: Uint8Array) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stores one file from the listener, once. Returns why not when it is not stored (never an error: no retry needed). */
export async function ingest(env: Env, meta: IngestMeta, bytes: Uint8Array, mediaType: NonNullable<ReturnType<typeof sniffImage>>): Promise<IngestResult> {
  const db = env.DB;
  const group = await one<{ id: string; business_id: string }>(db, 'SELECT id, business_id FROM wa_groups WHERE wa_group_id = ? AND active = 1', meta.groupId);
  if (!group) return { stored: false, reason: 'group_not_listed' };
  const same = await one<{ id: string }>(db, 'SELECT id FROM wa_items WHERE wa_message_id = ?', meta.messageId);
  if (same) return { stored: false, reason: 'same_message', id: same.id };
  const sha = await hex(bytes);
  const copy = await one<{ id: string }>(db, 'SELECT id FROM wa_items WHERE business_id = ? AND content_sha256 = ?', group.business_id, sha);
  if (copy) return { stored: false, reason: 'same_file', id: copy.id };

  const id = newId();
  const key = `wa/${group.business_id}/${id}`;
  await env.UPLOADS.put(key, bytes, { httpMetadata: { contentType: mediaType } });
  const t = now();
  const r = await stmt(db, `INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sender_number, sender_name, sent_at,
      media_type, file_key, content_sha256, size_bytes, caption, reply_to_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    id, group.business_id, group.id, meta.messageId, meta.senderNumber || null, meta.senderName || null, meta.sentAt,
    mediaType, key, sha, bytes.length, meta.caption?.trim() || null, meta.replyTo ?? null, t).run();
  if (!r.meta.changes) {
    // The same message or file arrived twice at the same moment: the other request stored it.
    await env.UPLOADS.delete(key);
    const won = await one<{ id: string }>(db, 'SELECT id FROM wa_items WHERE wa_message_id = ? OR (business_id = ? AND content_sha256 = ?)', meta.messageId, group.business_id, sha);
    return { stored: false, reason: 'same_message', id: won?.id };
  }
  await noteMessage(db, meta.sentAt);
  return { stored: true, id };
}

/** Moves the listener's "newest message" time forward (never back). */
export const noteMessage = (db: DB, at: number) =>
  stmt(db, 'UPDATE wa_listener_status SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = 1', at).run();

export const HeartbeatBody = z.object({
  lastMessageAt: z.number().int().nonnegative().nullable().optional(),
  state: z.string().trim().max(40).optional(),
  version: z.string().trim().max(40).optional(),
  // The groups the listener can see (phase 4): shown on the group setup screen so nobody types a group id.
  groups: z.array(z.object({ id: z.string().regex(/^[0-9-]+@g\.us$/), name: z.string().trim().min(1).max(200) })).max(300).optional(),
  // Linking from the POS (27 Nov 2026, src/waLink.ts): the linked number's last 4 digits (null: not linked), and the
  // request it is working on: the QR to scan while linking, then how it ended.
  linkedLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
  link: z.object({
    id: z.string().uuid(),
    qrRows: z.array(z.string().regex(/^[01]+$/).max(177)).min(21).max(177).optional(),
    result: z.enum(['linked', 'unlinked', 'expired', 'cancelled']).optional(),
  }).optional(),
});

export async function heartbeat(db: DB, b: z.infer<typeof HeartbeatBody>) {
  const t = now();
  await stmt(db, `UPDATE wa_listener_status SET last_heartbeat_at = ?, state = coalesce(?, state), version = coalesce(?, version),
      last_message_at = CASE WHEN ? IS NULL THEN last_message_at ELSE max(coalesce(last_message_at, 0), ?) END WHERE id = 1`,
    t, b.state ?? null, b.version ?? null, b.lastMessageAt ?? null, b.lastMessageAt ?? null).run();
  if (b.groups?.length) {
    await db.batch(b.groups.map((g) => stmt(db, `INSERT INTO wa_seen_groups (wa_group_id, name, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT (wa_group_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`, g.id, g.name, t)));
  }
  return t;
}

/** The groups Bookr reads (active in any business): the listener downloads files from these only, nothing else. */
export const readGroupIds = async (db: DB) =>
  (await db.prepare('SELECT DISTINCT wa_group_id FROM wa_groups WHERE active = 1 ORDER BY wa_group_id').all<{ wa_group_id: string }>()).results
    .map((r) => r.wa_group_id);
