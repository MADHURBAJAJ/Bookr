// Card reports from a Google Drive folder (approved 8 Nov 2026). A script in the Owner's Gmail saves the card
// company's .xlsx files into the folder; Bookr reads the files it has not read yet whenever the bank is synced. Each file
// is kept in R2 and noted as an inbound_mails row ('drive:<file id>'), so it is read once; "Read again" rereads it.

import type { Env } from './types';
import { newId, now, one, stmt } from './db';
import { downloadFile, listFolder } from './google';
import { isCardReportName } from './cardsettlement';
import { readReportFile } from './mail';

/** At most this many new files a sync, so one sync stays quick; the rest come next time. */
const MAX_FILES = 30;

/** Reads the folder's new card reports. Null when no folder is set. Google problems are thrown as GoogleError. */
export async function syncCardFolder(env: Env, businessId: string) {
  const db = env.DB;
  const b = await one<{ card_drive_folder: string | null }>(db, 'SELECT card_drive_folder FROM businesses WHERE id = ?', businessId);
  if (!b?.card_drive_folder) return null;
  const files = (await listFolder(env, b.card_drive_folder)).filter((f) => isCardReportName(f.name));
  const fresh: typeof files = [];
  for (const f of files) {
    if (!(await one(db, 'SELECT 1 FROM inbound_mails WHERE business_id = ? AND message_id = ?', businessId, `drive:${f.id}`))) fresh.push(f);
  }
  // Oldest first, so payments arrive in order.
  const take = fresh.reverse().slice(0, MAX_FILES);
  let added = 0;
  const problems: string[] = [];
  for (const f of take) {
    const bytes = await downloadFile(env, f.id);
    const id = newId();
    const key = `mail/${businessId}/${id}.xlsx`;
    await env.UPLOADS.put(key, bytes, { httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    const t = now();
    await stmt(db, `INSERT INTO inbound_mails (id, business_id, message_id, from_addr, subject, received_at, r2_key, status, note, created_at)
      VALUES (?, ?, ?, 'Google Drive', ?, ?, ?, 'failed', 'Not read yet.', ?) ON CONFLICT (business_id, message_id) DO NOTHING`,
      id, businessId, `drive:${f.id}`, f.name.slice(0, 300), Date.parse(f.modifiedTime) || t, key, t).run();
    const r = await readReportFile(db, businessId, id, f.name, bytes);
    await stmt(db, 'UPDATE inbound_mails SET status = ?, note = ? WHERE id = ?', r.ok ? 'read' : 'failed', r.note.slice(0, 1000), id).run();
    added += r.added;
    if (!r.ok) problems.push(r.note);
  }
  return { files: take.length, more: fresh.length - take.length, added, problems };
}
