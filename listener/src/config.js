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
  return {
    problems,
    bookrUrl: url,
    secret,
    localGroups,
    logLevel: env.LOG_LEVEL || 'info',
    authDir: join(root, 'auth'),
    dataDir: join(root, 'data'),
    logDir: join(root, 'logs'),
  };
}

const pick = (e) => Object.fromEntries(['BOOKR_URL', 'BOOKR_SECRET', 'GROUPS_FILE', 'LOG_LEVEL'].filter((k) => e[k]).map((k) => [k, e[k]]));
