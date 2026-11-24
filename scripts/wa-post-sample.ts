// Posts one file to /api/wa/ingest as the WhatsApp listener would, then sends a heartbeat. For trying the intake
// without a phone. The secret is read from WA_INGEST_SECRET in the environment, never from the command line.
//
//   WA_INGEST_SECRET=... npx tsx scripts/wa-post-sample.ts --group 120363000000000001@g.us
//   options: --url http://127.0.0.1:8787  --file demo/images/expenses-2026-10-31.png  --message-id ABC123
//            --sender 919800000000 --name "Reception" --caption "2611241" --reply-to <message id it replies to>

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const url = (arg('url', 'http://127.0.0.1:8787') ?? '').replace(/\/$/, '');
const secret = process.env.WA_INGEST_SECRET;
const group = arg('group');
const file = arg('file', 'demo/images/expenses-2026-10-31.png')!;
if (!secret) { console.error('Set WA_INGEST_SECRET in the environment.'); process.exit(1); }
if (!group) { console.error('Give --group <id>@g.us (a group set up and active in wa_groups).'); process.exit(1); }

const bytes = readFileSync(file);
const ext = extname(file).toLowerCase();
const type = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
const meta = {
  messageId: arg('message-id', `TEST${randomBytes(8).toString('hex').toUpperCase()}`),
  groupId: group,
  groupName: 'Test group',
  senderNumber: arg('sender', '919800000000'),
  senderName: arg('name', 'Sample sender'),
  sentAt: Date.now(),
  mediaType: type === 'application/pdf' ? 'document' : 'image',
  caption: arg('caption'),
  replyTo: arg('reply-to'),
};

const form = new FormData();
form.set('meta', JSON.stringify(meta));
form.set('file', new Blob([bytes], { type }), basename(file));
const headers = { 'X-Bookr-WA-Secret': secret };

const res = await fetch(`${url}/api/wa/ingest`, { method: 'POST', headers, body: form });
console.log(`ingest ${meta.messageId}: ${res.status}`, await res.text());

const hb = await fetch(`${url}/api/wa/heartbeat`, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastMessageAt: meta.sentAt, state: 'test-script', version: 'sample' }),
});
console.log(`heartbeat: ${hb.status}`, await hb.text());
