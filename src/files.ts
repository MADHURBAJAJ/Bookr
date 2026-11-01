// Photos and redacted CSVs live in R2. They are served only through the Worker, after the same
// per-business role check as every other request, and never cached by the browser.

import type { Context } from 'hono';
import type { AppEnv } from './types';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The real type from the first bytes, whatever the browser claimed. Only these are accepted. */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  return null;
}

export const storageKey = (businessId: string, uploadId: string) => `${businessId}/${uploadId}`;

export async function serveStored(c: Context<AppEnv>, key: string): Promise<Response> {
  const obj = await c.env.UPLOADS.get(key);
  if (!obj) return c.json({ error: 'File not found.' }, 404);
  const type = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  const allowed = ['image/jpeg', 'image/png', 'application/pdf', 'text/csv'];
  return new Response(obj.body, {
    headers: {
      'Content-Type': allowed.includes(type) ? type : 'application/octet-stream',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
}
