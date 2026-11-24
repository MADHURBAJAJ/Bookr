import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { businessWithAllRoles, env, resetDb, sql, uploads } from './helpers';

// WhatsApp intake, phase 1 (24 Nov 2026): the listener's ingest and heartbeat calls.

const SECRET = 'test-wa-secret-0123456789';
const GROUP = '120363000000000001@g.us';
let seq = 0;

/** A PNG-looking file: the PNG signature then a unique tail, so each one has its own hash. */
const png = (tag = String(++seq)) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`wa-${tag}`)]);
const meta = (over: Record<string, unknown> = {}) => ({
  messageId: `MSG${++seq}`, groupId: GROUP, groupName: 'Kitchen purchase', senderNumber: '919800000001', senderName: 'Ravi',
  sentAt: Date.UTC(2026, 10, 24, 6, 30), mediaType: 'image', caption: 'milk', ...over,
});

async function post(m: unknown, bytes: Uint8Array | null, secret: string | null = SECRET, type = 'image/png') {
  const form = new FormData();
  form.set('meta', typeof m === 'string' ? m : JSON.stringify(m));
  if (bytes) form.set('file', new Blob([bytes.slice()], { type }), 'x.png');
  const res = await app.request('/api/wa/ingest', { method: 'POST', body: form, headers: secret ? { 'X-Bookr-WA-Secret': secret } : {} }, env);
  return { status: res.status, json: await res.json() as any };
}
async function beat(body: unknown, secret: string | null = SECRET) {
  const res = await app.request('/api/wa/heartbeat', { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Bookr-WA-Secret': secret } : {}) } }, env);
  return { status: res.status, json: await res.json() as any };
}
const items = () => sql`SELECT * FROM wa_items ORDER BY created_at`;

let bid: string;
beforeEach(async () => {
  await resetDb();
  env.WA_INGEST_SECRET = SECRET;
  delete env.WA_INGEST_SECRET_OLD;
  bid = (await businessWithAllRoles('XOXO')).bid;
  await sql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, department, active, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${GROUP}, 'Kitchen purchase', 'Kitchen', 1, ${Date.now()})`;
  await sql`UPDATE wa_listener_status SET last_heartbeat_at = NULL, last_message_at = NULL, state = NULL, version = NULL`;
});
afterAll(() => { delete env.WA_INGEST_SECRET; return sql.end(); });

describe('secret', () => {
  it('turns the listener away when no secret is set on the server', async () => {
    delete env.WA_INGEST_SECRET;
    expect((await post(meta(), png())).status).toBe(503);
    expect(await items()).toHaveLength(0);
  });

  it('refuses a wrong or missing secret, and stores nothing', async () => {
    expect((await post(meta(), png(), 'wrong-secret-0123456789')).status).toBe(401);
    expect((await post(meta(), png(), null)).status).toBe(401);
    expect((await beat({}, 'nope')).status).toBe(401);
    expect(await items()).toHaveLength(0);
  });

  it('accepts the old secret while it is being changed', async () => {
    env.WA_INGEST_SECRET = 'the-new-secret-0123456789';
    env.WA_INGEST_SECRET_OLD = SECRET;
    expect((await post(meta(), png())).status).toBe(201);
    expect((await post(meta(), png(), 'the-new-secret-0123456789')).status).toBe(201);
  });

  it('a signed-in user cookie is no way in', async () => {
    const h = await businessWithAllRoles('Other');
    const form = new FormData();
    form.set('meta', JSON.stringify(meta()));
    form.set('file', new Blob([png()], { type: 'image/png' }), 'x.png');
    const res = await app.request('/api/wa/ingest', { method: 'POST', body: form, headers: { Cookie: h.clients.owner.cookie } }, env);
    expect(res.status).toBe(401);
  });
});

describe('ingest', () => {
  it('stores a file from a listed group, in R2 and as a pending item', async () => {
    const bytes = png();
    const m = meta();
    const r = await post(m, bytes);
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ stored: true, id: expect.any(String) });
    const [it] = await items();
    expect(it).toMatchObject({ id: r.json.id, business_id: bid, wa_message_id: m.messageId, sender_number: '919800000001', sender_name: 'Ravi',
      sent_at: m.sentAt, media_type: 'image/png', caption: 'milk', status: 'pending', read_status: 'waiting', kind: null, size_bytes: bytes.length });
    expect(it.file_key).toBe(`wa/${bid}/${it.id}`);
    const obj = await uploads.get(it.file_key);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
    expect(obj!.httpMetadata?.contentType).toBe('image/png');
    const [st] = await sql`SELECT last_message_at FROM wa_listener_status`;
    expect(st.last_message_at).toBe(m.sentAt);
  });

  it('keeps which message a bill photo replies to', async () => {
    const upi = meta({ caption: '2611241' });
    await post(upi, png());
    const bill = await post(meta({ replyTo: upi.messageId, caption: undefined }), png());
    const [row] = await sql`SELECT reply_to_id, caption FROM wa_items WHERE id = ${bill.json.id}`;
    expect(row).toEqual({ reply_to_id: upi.messageId, caption: null });
    const [first] = await sql`SELECT reply_to_id FROM wa_items WHERE wa_message_id = ${upi.messageId}`;
    expect(first.reply_to_id).toBeNull();
    expect((await post(meta({ replyTo: '' }), png())).status).toBe(400);
  });

  it('takes a PDF bill', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, ...new TextEncoder().encode('-1.4 bill')]);
    const r = await post(meta({ mediaType: 'document' }), pdf, SECRET, 'application/pdf');
    expect(r.status).toBe(201);
    expect((await items())[0].media_type).toBe('application/pdf');
  });

  it('drops a group that is not listed, or not active, without storing anything', async () => {
    const r = await post(meta({ groupId: '120363999999999999@g.us' }), png());
    expect(r).toEqual({ status: 200, json: { stored: false, reason: 'group_not_listed' } });
    await sql`UPDATE wa_groups SET active = 0`;
    expect((await post(meta(), png())).json.reason).toBe('group_not_listed');
    expect(await items()).toHaveLength(0);
    expect((await uploads.list({ prefix: `wa/${bid}/` })).objects).toHaveLength(0);
  });

  it('refuses a private chat id', async () => {
    expect((await post(meta({ groupId: '919800000001@s.whatsapp.net' }), png())).status).toBe(400);
    expect(await items()).toHaveLength(0);
  });

  it('the same message sent again is stored once', async () => {
    const m = meta();
    const first = await post(m, png('same'));
    const again = await post(m, png('same'));
    expect(again).toEqual({ status: 200, json: { stored: false, reason: 'same_message', id: first.json.id } });
    expect(await items()).toHaveLength(1);
  });

  it('the same image forwarded again (a new message id) is stored once', async () => {
    const first = await post(meta(), png('fwd'));
    const fwd = await post(meta({ senderName: 'Someone else' }), png('fwd'));
    expect(fwd).toEqual({ status: 200, json: { stored: false, reason: 'same_file', id: first.json.id } });
    expect(await items()).toHaveLength(1);
    expect((await uploads.list({ prefix: `wa/${bid}/` })).objects).toHaveLength(1);
  });

  it('keeps only JPEG, PNG and PDF, whatever the form says', async () => {
    const webp = new TextEncoder().encode('RIFF....WEBPVP8 ');
    expect((await post(meta(), webp, SECRET, 'image/png')).status).toBe(415);
    expect(await items()).toHaveLength(0);
  });

  it('refuses meta that is missing or not right', async () => {
    expect((await post('not json', png())).status).toBe(400);
    expect((await post(meta({ messageId: '' }), png())).status).toBe(400);
    expect((await post(meta({ sentAt: 'yesterday' }), png())).status).toBe(400);
    expect((await post(meta({ mediaType: 'video' }), png())).status).toBe(400);
    expect((await post(meta(), null)).status).toBe(400);
    expect(await items()).toHaveLength(0);
  });

  it('refuses a file over 10 MB', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await post(meta(), big, SECRET, 'image/jpeg')).status).toBe(413);
    expect(await items()).toHaveLength(0);
  });

  it('a JSON body is not a file', async () => {
    const res = await app.request('/api/wa/ingest', { method: 'POST', body: JSON.stringify(meta()),
      headers: { 'Content-Type': 'application/json', 'X-Bookr-WA-Secret': SECRET } }, env);
    expect(res.status).toBe(400);
  });

  it('multipart stays refused everywhere else', async () => {
    const form = new FormData();
    form.set('x', '1');
    const res = await app.request(`/api/businesses/${bid}/uploads`, { method: 'POST', body: form }, env);
    expect(res.status).toBe(415);
  });
});

describe('heartbeat', () => {
  it('records the time, state and version, and never moves the newest message back', async () => {
    const before = Date.now();
    const r = await beat({ lastMessageAt: 2_000_000_000_000, state: 'connected', version: '0.1.0' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    let [st] = await sql`SELECT * FROM wa_listener_status`;
    expect(st.last_heartbeat_at).toBeGreaterThanOrEqual(before);
    expect(st).toMatchObject({ last_message_at: 2_000_000_000_000, state: 'connected', version: '0.1.0' });
    await beat({ lastMessageAt: 1_900_000_000_000 });
    await beat({});
    [st] = await sql`SELECT * FROM wa_listener_status`;
    expect(st).toMatchObject({ last_message_at: 2_000_000_000_000, state: 'connected' });
  });

  it('a first heartbeat with no message yet leaves the newest message empty', async () => {
    await beat({ state: 'waiting_for_qr' });
    const [st] = await sql`SELECT * FROM wa_listener_status`;
    expect(st).toMatchObject({ last_message_at: null, state: 'waiting_for_qr' });
  });
});
