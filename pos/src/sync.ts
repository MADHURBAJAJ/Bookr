// Sends the outbox to Bookr: oldest first, up to 50 a call. Bookr answers each message stored, duplicate (already there)
// or rejected (with why); all three are marked sent so nothing is sent forever, and a rejection keeps its reason for a person.
// A failed call (Bookr down, no internet) leaves the messages waiting; they go with the next try.
// Tries: right after each settle, void, receipt and shift close; every 5 minutes (cron); and "Send now" on Shift close.
import { all, now, stmt, type DB } from '../../src/db';
import type { Env } from './types';

export interface SendResult { sent: number; rejected: number; waiting: number; error?: string }

/** The key Bookr gave this business (Worker secret BOOKR_KEYS, JSON {"<business id>": "<key>"}). */
function keyFor(env: Env, businessId: string): string | null {
  try { const k = JSON.parse(env.BOOKR_KEYS ?? '{}')[businessId]; return typeof k === 'string' && k ? k : null; } catch { return null; }
}

/** Where Bookr is and this business's key, or null when the POS is not connected (the payment proof list asks with it). */
export function bookrLink(env: Env, businessId: string): { base: string; key: string } | null {
  const key = keyFor(env, businessId);
  const base = env.BOOKR_URL?.replace(/\/+$/, '');
  return key && base ? { base, key } : null;
}

export async function sendOutbox(env: Env, businessId: string, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<SendResult> {
  const db: DB = env.DB;
  const key = keyFor(env, businessId);
  const base = env.BOOKR_URL?.replace(/\/+$/, '');
  const rows = await all<{ id: string; kind: string; body: string }>(db,
    'SELECT id, kind, body FROM outbox WHERE business_id = ? AND sent_at IS NULL ORDER BY created_at, rowid LIMIT 50', businessId);
  if (!rows.length) return { sent: 0, rejected: 0, waiting: 0 };
  const waiting = async () => (await all<{ n: number }>(db, 'SELECT count(*) AS n FROM outbox WHERE business_id = ? AND sent_at IS NULL', businessId))[0].n;
  if (!key || !base) return { sent: 0, rejected: 0, waiting: await waiting(), error: 'Bookr is not connected yet (BOOKR_URL and BOOKR_KEYS).' };

  let answer: { results?: { id: string; result: string; error?: string }[]; error?: string };
  try {
    const res = await fetcher(`${base}/api/pos/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ businessId, messages: rows.map((r) => ({ id: r.id, kind: r.kind, body: JSON.parse(r.body) })) }),
    });
    answer = (await res.json().catch(() => ({}))) as typeof answer;
    if (!res.ok) throw new Error(answer?.error ?? `Bookr answered ${res.status}`);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    await db.batch(rows.map((r) => stmt(db, 'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', msg, r.id)));
    return { sent: 0, rejected: 0, waiting: await waiting(), error: msg };
  }
  const t = now();
  let sent = 0;
  let rejected = 0;
  const updates = [];
  for (const r of answer.results ?? []) {
    if (!rows.some((x) => x.id === r.id)) continue;
    if (r.result === 'stored' || r.result === 'duplicate') { sent++; updates.push(stmt(db, 'UPDATE outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?', t, r.id)); }
    else { rejected++; updates.push(stmt(db, 'UPDATE outbox SET sent_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?', t, `Rejected by Bookr: ${String(r.error ?? '').slice(0, 250)}`, r.id)); }
  }
  if (updates.length) await db.batch(updates);
  return { sent, rejected, waiting: await waiting() };
}

/** Every business with messages waiting (the cron). */
export async function sendAll(env: Env): Promise<void> {
  const bs = await all<{ business_id: string }>(env.DB, 'SELECT DISTINCT business_id FROM outbox WHERE sent_at IS NULL');
  for (const b of bs) await sendOutbox(env, b.business_id).catch((e) => console.error('outbox', b.business_id, e));
}

/** Sends after a response, without making the counter wait. Outside a Worker request (tests) it does nothing. */
export function sendSoon(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, businessId: string): void {
  let ctx: { waitUntil(p: Promise<unknown>): void };
  try { ctx = c.executionCtx; } catch { return; }
  ctx.waitUntil(sendOutbox(c.env, businessId).catch((e) => console.error('outbox', businessId, e)));
}
