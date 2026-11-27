// Linking from the POS (27 Nov 2026): the QR as rows for the POS, the last 4 digits of the number, and the heartbeat
// carrying the link's progress to Bookr and passing Bookr's request on. Invented ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createListener } from '../src/listener.js';
import { newStats } from '../src/guard.js';
import { last4, qrRows } from '../src/whatsapp.js';

test('the QR is square rows of 0 and 1, with the three corner squares', () => {
  const rows = qrRows('2@sample-ref-not-real,sample-key,sample-identity,sample-adv');
  assert.ok(rows.length >= 21 && rows.length <= 177);
  assert.ok(rows.every((r) => r.length === rows.length && /^[01]+$/.test(r)));
  assert.equal(rows[0].slice(0, 7), '1111111');
  assert.equal(rows[0].slice(-7), '1111111');
  assert.equal(rows.at(-1).slice(0, 7), '1111111');
});

test('only the last 4 digits of the linked number are kept', () => {
  assert.equal(last4('919800001234:12@s.whatsapp.net'), '1234');
  assert.equal(last4('919800005678@s.whatsapp.net'), '5678');
  assert.equal(last4(undefined), null);
});

test('the heartbeat carries the QR and how the link ended, and passes Bookr\'s request on', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wa-link-'));
  const sent = [];
  const answers = [];
  const bookr = {
    async heartbeat(body) { sent.push(body); return { status: 200, body: { ok: true, readGroups: [], link: answers.shift() ?? null } }; },
    async ingest() { return { status: 201, body: { stored: true } }; },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const l = createListener({ cfg: { dataDir, localGroups: null }, log, bookr, stats: newStats(), download: async () => Buffer.alloc(1), wait: async () => {} });
  const asked = [];
  l.setLinkHandler((req) => asked.push(req));
  const id = '00000000-0000-4000-8000-0000000000aa';

  answers.push({ id, action: 'link' });
  l.setLinked(null);
  await l.heartbeat();
  assert.deepEqual(asked, [{ id, action: 'link' }]);
  assert.equal(sent[0].linkedLast4, null);

  l.linkProgress(id, ['111', '101', '111']);
  await l.heartbeat();
  assert.deepEqual(sent.at(-1).link, { id, qrRows: ['111', '101', '111'] });
  assert.equal(l.linking, true);

  l.setLinked('4321');
  l.linkDone(id, 'linked');
  await l.heartbeat();
  assert.deepEqual(sent.at(-1).link, { id, result: 'linked' });
  assert.equal(sent.at(-1).linkedLast4, '4321');
  // Bookr has heard it: the next heartbeat says nothing more about this link.
  await l.heartbeat();
  assert.equal(sent.at(-1).link, undefined);
  assert.equal(l.linking, false);
  rmSync(dataDir, { recursive: true, force: true });
});
