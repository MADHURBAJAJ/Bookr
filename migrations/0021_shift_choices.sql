-- Save reconcile (approved 9 Nov 2026): a shift is finished on Reconcile, and its matches are drafts until Save. A match
-- chosen before saving is kept here: the UPI credit and the bills (by their comparison, as the sales do not exist yet).
-- Saving books the income and makes each match, then removes the choice; Undo before saving deletes it. A credit held
-- here is not offered to any other bill or shift.
CREATE TABLE shift_choices (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day      TEXT NOT NULL CHECK (shift_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind           TEXT NOT NULL CHECK (kind IN ('bank_match')),
  bank_row_id    TEXT NOT NULL REFERENCES bank_rows(id) ON DELETE CASCADE,
  comparison_ids TEXT NOT NULL CHECK (json_valid(comparison_ids)),
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (business_id, bank_row_id)
);
CREATE INDEX shift_choices_day_idx ON shift_choices (business_id, shift_day);
