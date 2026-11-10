-- A card match chosen before saving (approved 10 Nov 2026): on Reconcile's Card tab a person picks the bill a card
-- machine payment was for while the shift is not saved yet. Kept here like a UPI match (kind 'bank_match'): the
-- payment and the bills by their comparison; Save matches the payment to the card sales it makes, then removes the
-- choice; Undo before saving deletes it. A payment held here is not offered to any other bill.
-- SQLite cannot change a CHECK, so the table is built again with its rows.
PRAGMA defer_foreign_keys = true;

CREATE TABLE shift_choices_new (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day       TEXT NOT NULL CHECK (shift_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind            TEXT NOT NULL CHECK (kind IN ('bank_match', 'card_match')),
  bank_row_id     TEXT REFERENCES bank_rows(id) ON DELETE CASCADE,
  card_payment_id TEXT REFERENCES card_settlements(id) ON DELETE CASCADE,
  comparison_ids  TEXT NOT NULL CHECK (json_valid(comparison_ids)),
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  CHECK ((kind = 'bank_match' AND bank_row_id IS NOT NULL AND card_payment_id IS NULL)
      OR (kind = 'card_match' AND card_payment_id IS NOT NULL AND bank_row_id IS NULL)),
  UNIQUE (business_id, bank_row_id),
  UNIQUE (business_id, card_payment_id)
);

INSERT INTO shift_choices_new (id, business_id, shift_day, kind, bank_row_id, card_payment_id, comparison_ids, created_by, created_at)
  SELECT id, business_id, shift_day, kind, bank_row_id, NULL, comparison_ids, created_by, created_at FROM shift_choices;

DROP TABLE shift_choices;
ALTER TABLE shift_choices_new RENAME TO shift_choices;
CREATE INDEX shift_choices_day_idx ON shift_choices (business_id, shift_day);
