// Read-only access to Google Sheets as a service account. The key lives only in the Worker secret
// GOOGLE_SERVICE_ACCOUNT (the JSON key file Google gives); it never reaches the browser, the logs or the repo.
// The person shares each sheet with the service account's email address as a Viewer.

import type { Env } from './types';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
let cached: { token: string; until: number; email: string } | null = null;

export class GoogleError extends Error {}

interface Key { client_email: string; private_key: string; token_uri?: string }

function readKey(env: Env): Key {
  const raw = env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new GoogleError('Google access is not set up yet. Paste the rows instead, or ask the Owner to set it up.');
  try {
    const k = JSON.parse(raw) as Key;
    if (!k.client_email || !k.private_key) throw new Error();
    return k;
  } catch { throw new GoogleError('The Google key is not valid. Ask the Owner to set it up again.'); }
}

/** The address sheets must be shared with, or null when Google access is not set up. */
export function serviceAccountEmail(env: Env): string | null {
  try { return readKey(env).client_email; } catch { return null; }
}

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function accessToken(env: Env): Promise<string> {
  const key = readKey(env);
  if (cached && cached.email === key.client_email && cached.until > Date.now() + 60_000) return cached.token;
  const pem = key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const signer = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const aud = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(unsigned));
  const res = await fetch(aud, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new GoogleError('Google did not accept the key. Ask the Owner to check the Google setup.');
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, until: Date.now() + j.expires_in * 1000, email: key.client_email };
  return j.access_token;
}

/** The sheet ID from a Google Sheets link, or the ID itself. */
export function sheetIdFrom(v: string): string | null {
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(v) ?? /^([A-Za-z0-9_-]{20,})$/.exec(v.trim());
  return m ? m[1] : null;
}

async function get(env: Env, url: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken(env)}` } });
  if (res.status === 403 || res.status === 404) {
    throw new GoogleError(`Bookr cannot open this sheet. Share it with ${serviceAccountEmail(env)} as a Viewer, and check the link.`);
  }
  if (!res.ok) throw new GoogleError('Google Sheets did not answer. Try again in a minute.');
  return res.json();
}

/** Rows of the named tab, or of every tab when tab is null (e.g. one tab per month). */
export async function readSheet(env: Env, sheetId: string, tab: string | null): Promise<{ tabs: string[]; rows: string[][] }> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`;
  let tabs: string[];
  if (tab) tabs = [tab];
  else {
    const meta = (await get(env, `${base}?fields=sheets.properties.title`)) as { sheets: { properties: { title: string } }[] };
    tabs = meta.sheets.map((s) => s.properties.title);
  }
  const rows: string[][] = [];
  for (const t of tabs) {
    const range = encodeURIComponent(`'${t.replace(/'/g, "''")}'!A:I`);
    const v = (await get(env, `${base}/values/${range}?valueRenderOption=FORMATTED_VALUE`)) as { values?: string[][] };
    rows.push(...(v.values ?? []));
  }
  return { tabs, rows };
}
