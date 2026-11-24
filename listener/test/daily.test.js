// The morning Daily check to the owner (25 Nov 2026): the guard's permit, the send time, and the sender sending once a
// day. The number and key here are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOutgoing, dailyPermit } from '../src/guard.js';
import { createDaily, indiaNow, sendMinute } from '../src/daily.js';

const OWNER = '919800000001';
const msg = (to) => `<message to='${to}' id='X1' type='media'><participants/></message>`;
const token = `<iq to='s.whatsapp.net' type='set' xmlns='privacy' id='1'><tokens><token jid='${OWNER}@s.whatsapp.net' t='1' type='trusted_contact'/></tokens></iq>`;

test('the permit lets the Daily check go to the owner only, while open, at most 4 frames, for 90 seconds', () => {
  let t = 0;
  const p = dailyPermit(() => t);
  assert.equal(checkOutgoing(msg(`${OWNER}@s.whatsapp.net`), {}, p).ok, false, 'closed: nothing');
  assert.equal(checkOutgoing(token, {}, p).ok, false, 'closed: no token either');
  p.open(OWNER);
  assert.equal(checkOutgoing(msg('919800000002@s.whatsapp.net'), {}, p).ok, false, 'another number: never');
  assert.equal(checkOutgoing(`<message to='120363000000000000@g.us' id='X' type='text'/>`, {}, p).ok, false, 'a group: never');
  assert.deepEqual(checkOutgoing(msg(`${OWNER}@s.whatsapp.net`), {}, p), { ok: true, kind: 'message:daily-check-to-owner' });
  assert.deepEqual(checkOutgoing(token, {}, p), { ok: true, kind: 'iq:privacy-token-for-daily-check' });
  assert.equal(checkOutgoing(`<receipt id='1' type='read' to='${OWNER}@s.whatsapp.net'/>`, {}, p).ok, false, 'read receipts stay blocked');
  assert.equal(checkOutgoing(`<presence type='available'/>`, {}, p).ok, false, 'online stays blocked');
  assert.ok(checkOutgoing(msg(`${OWNER}@s.whatsapp.net`), {}, p).ok);
  assert.ok(checkOutgoing(msg(`${OWNER}@s.whatsapp.net`), {}, p).ok);
  assert.equal(checkOutgoing(msg(`${OWNER}@s.whatsapp.net`), {}, p).ok, false, 'a fifth frame: no');
  p.open(OWNER);
  t = 91_000;
  assert.equal(checkOutgoing(msg(`${OWNER}@s.whatsapp.net`), {}, p).ok, false, 'after 90 seconds: no');
  p.open(OWNER); p.close();
  assert.equal(checkOutgoing(msg(`${OWNER}@s.whatsapp.net`), {}, p).ok, false, 'closed again: no');
});

test('the send time moves within the jitter, the same all day', () => {
  const at = 8 * 60 + 15;
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 10, 1) + i * 86_400_000).toISOString().slice(0, 10));
  const mins = days.map((d) => sendMinute(d, at, 10));
  assert.ok(mins.every((m) => m >= at - 10 && m <= at + 10));
  assert.ok(new Set(mins).size > 5, 'it varies');
  assert.equal(sendMinute('2026-11-25', at, 10), sendMinute('2026-11-25', at, 10));
  assert.equal(sendMinute('2026-11-25', at, 0), at);
});

test('the sender sends once a day after its time, keeps trying for a while, and not after 2 pm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-'));
  const cfg = { dataDir: dir, daily: { to: OWNER, posUrl: 'https://pos.example.test', businessId: 'b', key: 'k', atMinutes: 8 * 60 + 15, jitter: 0, chrome: null } };
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };
  const sent = [];
  const handle = { canSend: () => true, sendDailyCheck: async (pdf, name, caption) => sent.push([pdf.toString(), name, caption]) };
  // 25 Nov 2026, India time.
  const ist = (h, m) => Date.UTC(2026, 10, 25, h, m) - 330 * 60_000;
  let t = ist(8, 0);
  let fail = true;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ url: 'https://pos.example.test/report.html#x', day: '2026-11-24', caption: 'Daily check 24 Nov' }) });
  const d = createDaily({ cfg, log, wa: () => handle, now: () => t, fetchImpl, render: async () => { if (fail) throw new Error('no Chrome'); return Buffer.from('PDF'); } });
  assert.deepEqual(indiaNow(t), { date: '2026-11-25', minutes: 480 });
  await d.tick();
  assert.equal(sent.length, 0, 'before its time');
  t = ist(8, 15);
  await d.tick();
  assert.equal(sent.length, 0);
  assert.match(logs.at(-1), /not sent \(try 1 of 5/);
  t = ist(8, 20);
  await d.tick();
  assert.equal(sent.length, 0, 'waits 10 minutes between tries');
  fail = false;
  t = ist(8, 26);
  await d.tick();
  assert.deepEqual(sent, [['PDF', 'Daily check 2026-11-24.pdf', 'Daily check 24 Nov']]);
  t = ist(9, 0);
  await d.tick();
  assert.equal(sent.length, 1, 'once a day, even when asked again');
  // Next day, the listener only starts after 2 pm: skipped, said so.
  t = Date.UTC(2026, 10, 26, 14, 30) - 330 * 60_000;
  await d.tick();
  assert.equal(sent.length, 1);
  assert.match(logs.at(-1), /not sent today: the listener was not running/);
});
