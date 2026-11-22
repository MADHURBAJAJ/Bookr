import { all, now, stmt, type DB } from './db';
import { completeBillNo } from './ocr';

/**
 * Bill numbers completed when the software report comes in after the page was read (approved 22 Nov 2026): a number
 * Claude read that the software does not have, on a line nobody has ticked or changed the number of, becomes the one
 * software bill it stands for (its end, or a doubled digit read once, for the same amount). Shown in amber as before.
 */
export async function completeLateNumbers(db: DB, businessId: string, day: string): Promise<number> {
  const [sw, rows, pays] = await Promise.all([
    all<{ bill_no: string; amount_paise: number }>(db,
      'SELECT bill_no, max(amount_paise) AS amount_paise FROM software_bills WHERE business_id = ? AND shift_day = ? GROUP BY bill_no', businessId, day),
    all<{ id: string; bill_no: string; amount_paise: number; status: string; ocr_original: string | null }>(db,
      'SELECT id, bill_no, amount_paise, status, ocr_original FROM register_rows WHERE business_id = ? AND shift_day = ?', businessId, day),
    all<{ register_row_id: string; amount_paise: number }>(db, `SELECT p.register_row_id, p.amount_paise FROM register_payments p
      JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
  ]);
  if (!sw.length) return 0;
  const software = new Map(sw.map((b) => [b.bill_no, b.amount_paise]));
  const used = new Set(rows.map((r) => r.bill_no).filter((b) => software.has(b)));
  const changes: { id: string; from: string; to: string; ocr: string }[] = [];
  for (const r of rows) {
    if (r.status !== 'draft' || !r.ocr_original || software.has(r.bill_no)) continue;
    let o: Record<string, any>;
    try { o = JSON.parse(r.ocr_original); } catch { continue; }
    // Only the number as Claude read it: one a person typed is theirs.
    const read = typeof o.read?.bill_no === 'string' ? o.read.bill_no.replace(/\s+/g, '') : null;
    if (o.engine !== 'claude_vision' || read !== r.bill_no || o.completedFrom) continue;
    const paid = pays.filter((p) => p.register_row_id === r.id).reduce((t, p) => t + p.amount_paise, 0);
    const hit = completeBillNo(r.bill_no, [r.amount_paise, paid], software, used);
    if (!hit || hit === 'several') continue;
    used.add(hit.billNo);
    const inferred = new Set<string>(o.inferred ?? []);
    inferred.add('bill_no');
    Object.assign(o, { inferred: [...inferred], completedFrom: r.bill_no, unclear: (o.unclear ?? []).filter((f: string) => f !== 'bill_no') });
    changes.push({ id: r.id, from: r.bill_no, to: hit.billNo, ocr: JSON.stringify(o) });
  }
  if (!changes.length) return 0;
  const t = now();
  const res = await db.batch(changes.flatMap((x) => [
    stmt(db, "UPDATE register_rows SET bill_no = ?, ocr_original = ? WHERE id = ? AND business_id = ? AND status = 'draft' AND bill_no = ?", x.to, x.ocr, x.id, businessId, x.from),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, NULL, 'register.number_completed', 'register_rows', ?, ?, ?, ?)`, businessId, x.id, JSON.stringify({ billNo: x.from }), JSON.stringify({ billNo: x.to }), t),
  ]));
  return res.filter((_, i) => i % 2 === 0).reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}
