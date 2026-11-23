// A one-time password reset link for a locked-out Owner (approved 23 Nov 2026). Nobody can reset an Owner's password
// in the app, so this is made from the server by whoever can run wrangler against the database.
//
//   npx tsx scripts/owner-reset.ts <email or mobile> --local  --url http://localhost:8787
//   npx tsx scripts/owner-reset.ts <email or mobile> --remote --url https://<your domain> [-- <extra wrangler args>]
//
// The link works once, for 1 hour, for that login only. Only its SHA-256 goes into the database (through a temporary
// SQL file, deleted once wrangler has run it). Older unused links for the person stop working.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomToken, sha256 } from '../src/crypto';
import { normalizePhone } from '../src/http';

const args = process.argv.slice(2);
const dash = args.indexOf('--');
const extra = dash >= 0 ? args.slice(dash + 1) : [];
const own = dash >= 0 ? args.slice(0, dash) : args;
const target = own.includes('--remote') ? '--remote' : own.includes('--local') ? '--local' : null;
const urlAt = own.indexOf('--url');
const base = urlAt >= 0 ? own[urlAt + 1]?.replace(/\/+$/, '') : null;
const who = own.find((a, i) => !a.startsWith('--') && own[i - 1] !== '--url');
if (!target || !base || !who) throw new Error('Usage: npx tsx scripts/owner-reset.ts <email or mobile> --local|--remote --url <https://domain> [-- <wrangler args>]');

const phone = who.includes('@') ? null : normalizePhone(who);
if (!who.includes('@') && !phone) throw new Error('Give the email or a 10-digit mobile number.');
const lit = (v: string | number) => (typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);
const userWhere = (a = "") => (phone ? `${a}phone = ${lit(phone)}` : `lower(${a}email) = lower(${lit(who)})`);

const token = randomToken();
const t = Date.now();
const sql = [
  `UPDATE password_resets SET revoked_at = ${t} WHERE used_at IS NULL AND revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE ${userWhere()});`,
  // created_by = the person themselves marks a server-made link (see findReset in src/routes/members.ts).
  `INSERT INTO password_resets (id, user_id, business_id, created_by, token_hash, created_at, expires_at)
    SELECT ${lit(crypto.randomUUID())}, u.id, (SELECT m.business_id FROM memberships m WHERE m.user_id = u.id ORDER BY m.role = 'owner' DESC LIMIT 1), u.id,
      ${lit(await sha256(token))}, ${t}, ${t + 3600000}
    FROM users u WHERE ${userWhere("u.")} AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);`,
  `SELECT count(*) AS made FROM password_resets WHERE created_at = ${t} AND user_id = (SELECT id FROM users WHERE ${userWhere()});`,
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'bookr-reset-'));
const file = join(dir, 'reset.sql');
try {
  writeFileSync(file, sql);
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--file', file, '--json', ...extra], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler failed:\n${r.stderr || r.stdout}`);
  const made = /"made":\s*1/.test(r.stdout);
  if (!made) throw new Error(`No login found for ${who} in any business. Nothing was made.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Reset link for ${who}, works once within 1 hour:\n${base}/#/reset/${token}`);
