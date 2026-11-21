-- Settling a count that came out short or extra (approved 21 Nov 2026). Only the Owner settles, on the phone or the PC.
-- A count's gap is the cash counted against what the book says through that day, so an unsettled gap carries on to
-- later counts until the book or the cash changes. Ways to settle:
--   shortage    short: a "Cash shortage" expense is written in the book on the count's day, so the book agrees
--   extra       extra: a "Cash extra" money-in line is written in the book on the count's day, so the book agrees
--   given_back  extra: it was someone else's money and was given back; nothing is written
--   found       a line was missed; the cashier adds it, which closes the gap (if not, the next count shows it again)
-- Same money (a short and then an extra of the same amount) needs nothing: the later count agrees with the book.
-- settle_gap_paise keeps the gap as it was when settled; settle_entry_id the line written for shortage or extra.
-- No existing row changes.

ALTER TABLE cash_counts ADD COLUMN settle TEXT CHECK (settle IS NULL OR settle IN ('shortage', 'extra', 'given_back', 'found'));
ALTER TABLE cash_counts ADD COLUMN settle_note TEXT;
ALTER TABLE cash_counts ADD COLUMN settle_gap_paise INTEGER;
ALTER TABLE cash_counts ADD COLUMN settle_entry_id TEXT REFERENCES cash_entries(id) ON DELETE SET NULL;
ALTER TABLE cash_counts ADD COLUMN settled_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cash_counts ADD COLUMN settled_at INTEGER;
