// A director's money paid to the company on the card machine (approved 24 Nov 2026): booked from the Card tab as a
// "Paid to the company" line in their account. Not income: the payment is matched to a transfer row (no account, no
// head) so the machine's settlement still pairs with the bank. A card can be remembered as a director's; a later payment
// from it with no bill is then suggested for them, never booked by itself (only the scheme and last 4 digits are known).
// Remembered cards are kept as audit rows ('directors.card_remember' / 'directors.card_forget'), no new table.
import type { DB } from './db';
import { all } from './db';
import type { CardPayment } from './cards';

export const cardKey = (p: Pick<CardPayment, 'scheme' | 'card_type' | 'card_last4'>) =>
  p.card_last4 ? `${(p.scheme ?? p.card_type ?? '').trim().toUpperCase()}|${p.card_last4}` : null;

/** Remembered director cards, by card key: the person's id and name (a person no longer listed is left out). */
export async function directorCards(db: DB, bid: string) {
  const [log, people] = await Promise.all([
    all<{ action: string; row_id: string; after: string | null }>(db, `SELECT action, row_id, after FROM audit_log WHERE business_id = ?
      AND action IN ('directors.card_remember', 'directors.card_forget') ORDER BY id`, bid),
    all<{ id: string; name: string }>(db, 'SELECT id, name FROM directors WHERE business_id = ?', bid).catch(() => []),
  ]);
  const m = new Map<string, { directorId: string; name: string }>();
  for (const x of log) {
    if (x.action === 'directors.card_forget') { m.delete(x.row_id); continue; }
    const id = (JSON.parse(x.after ?? '{}') as { directorId?: string }).directorId;
    const p = people.find((q) => q.id === id);
    if (p) m.set(x.row_id, { directorId: p.id, name: p.name });
  }
  return m;
}
