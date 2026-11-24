// The listener's two calls to Bookr (src/routes/wa.ts in the Bookr repo): POST /api/wa/ingest with each file, and
// POST /api/wa/heartbeat every minute. The secret goes in the X-Bookr-WA-Secret header, never in the address.

const HEADER = 'X-Bookr-WA-Secret';

/** The file type from its first bytes (Bookr checks again). */
export function fileType(bytes) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * What to do after an ingest answer:
 * - done: Bookr has it, or dropped it on purpose (group not read, already there); never sent again.
 * - fail: Bookr will never take this file (not a photo or PDF, too large, bad details); kept in data/failed.
 * - wait: try again later. `setup` when the cause is the set-up (wrong secret, secret not set on the server).
 */
export function classify(status) {
  if (status === 200 || status === 201) return 'done';
  if (status === 401 || status === 403 || status === 503) return 'setup';
  if (status === 408 || status === 429 || status >= 500) return 'wait';
  if (status >= 400) return 'fail';
  return 'wait';
}

export function bookrClient({ url, secret, version, fetchFn = fetch }) {
  return {
    async ingest(meta, bytes) {
      const form = new FormData();
      form.set('meta', JSON.stringify(meta));
      const type = fileType(bytes);
      form.set('file', new Blob([bytes], { type }), meta.mediaType === 'document' && type === 'application/pdf' ? 'file.pdf' : 'file');
      const res = await fetchFn(`${url}/api/wa/ingest`, {
        method: 'POST', headers: { [HEADER]: secret }, body: form, signal: AbortSignal.timeout(90_000),
      });
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      return { status: res.status, body };
    },

    async heartbeat(body) {
      const res = await fetchFn(`${url}/api/wa/heartbeat`, {
        method: 'POST', headers: { [HEADER]: secret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, ...body }), signal: AbortSignal.timeout(30_000),
      });
      let json = null;
      try { json = await res.json(); } catch { /* not JSON */ }
      return { status: res.status, body: json };
    },
  };
}
