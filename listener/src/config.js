// Settings from listener/.env (copy .env.example). The secret is never printed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** KEY=value lines; # starts a comment; quotes around a value are removed. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/** Group ids, one per line (anything after # is a note): the optional local limit on top of Bookr's list. */
export function parseGroupsFile(text) {
  const ids = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const id = raw.split('#')[0].trim();
    if (/^[0-9-]+@g\.us$/.test(id)) ids.add(id);
  }
  return ids;
}

export function loadConfig(root) {
  const file = join(root, '.env');
  const env = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...pick(process.env) };
  const problems = [];
  const url = (env.BOOKR_URL ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(url)) problems.push('BOOKR_URL is missing (for example https://bookr.thebajajgroup.co).');
  if (/^http:/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) problems.push('BOOKR_URL must start with https:// (http only for 127.0.0.1 while testing).');
  const secret = env.BOOKR_SECRET ?? '';
  if (secret.length < 16) problems.push('BOOKR_SECRET is missing or shorter than 16 characters (the same value as WA_INGEST_SECRET in Bookr).');
  let localGroups = null;
  if (env.GROUPS_FILE) {
    const p = join(root, env.GROUPS_FILE);
    if (!existsSync(p)) problems.push(`GROUPS_FILE ${env.GROUPS_FILE} was not found.`);
    else localGroups = parseGroupsFile(readFileSync(p, 'utf8'));
  }
  // The morning Daily check to the owner (25 Nov 2026): on only when all four are set. The number stays in .env.
  let daily = null;
  if (env.DAILY_TO || env.POS_REPORT_KEY) {
    const digits = String(env.DAILY_TO ?? '').replace(/\D/g, '');
    const to = digits.length === 10 ? `91${digits}` : digits;
    const posUrl = (env.POS_URL ?? '').replace(/\/+$/, '');
    const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(env.DAILY_AT ?? '08:15');
    if (!/^\d{11,15}$/.test(to)) problems.push('DAILY_TO must be the owner\'s WhatsApp number (10 digits, or with the country code).');
    if (!/^https:\/\/[^\s]+$/.test(posUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(posUrl)) problems.push('POS_URL is missing (https://pos.thebajajgroup.co).');
    if (!/^[0-9a-f-]{36}$/i.test(env.POS_BUSINESS_ID ?? '')) problems.push('POS_BUSINESS_ID is missing (the restaurant\'s id in the POS).');
    if ((env.POS_REPORT_KEY ?? '').length < 24) problems.push('POS_REPORT_KEY is missing or shorter than 24 characters (the same key as in the POS\'s REPORT_KEYS).');
    if (!at) problems.push('DAILY_AT must be a time like 08:15.');
    daily = { to, posUrl, businessId: env.POS_BUSINESS_ID ?? '', key: env.POS_REPORT_KEY ?? '', atMinutes: at ? Number(at[1]) * 60 + Number(at[2]) : 495,
      jitter: Math.min(30, Math.max(0, Number(env.DAILY_JITTER ?? 10) || 0)), chrome: env.CHROME_PATH || null };
  }
  return {
    problems,
    daily,
    bookrUrl: url,
    secret,
    localGroups,
    logLevel: env.LOG_LEVEL || 'info',
    authDir: join(root, 'auth'),
    dataDir: join(root, 'data'),
    logDir: join(root, 'logs'),
  };
}

const pick = (e) => Object.fromEntries(['BOOKR_URL', 'BOOKR_SECRET', 'GROUPS_FILE', 'LOG_LEVEL', 'DAILY_TO', 'DAILY_AT', 'DAILY_JITTER', 'POS_URL', 'POS_BUSINESS_ID',
  'POS_REPORT_KEY', 'CHROME_PATH'].filter((k) => e[k]).map((k) => [k, e[k]]));
