-- When what was paid differs from the bill (approved 14 Nov 2026): paid less is a discount given at payment, with a reason;
-- paid more (on UPI, card or cash kept) is a tip. The printed bill and its GST never change; the payments keep their real
-- amounts, so Bookr still matches them to the bank and the card machine. Rows are only added.
CREATE TABLE settle_differences (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  settlement_id TEXT NOT NULL REFERENCES settlements(id),
  kind          TEXT NOT NULL CHECK (kind IN ('discount', 'tip')),
  bill_id       TEXT REFERENCES bills(id),        -- a discount: the bill it was given on
  payment_id    TEXT REFERENCES payments(id),     -- a tip: the payment that carried it
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
  reason        TEXT,
  shift_day     TEXT NOT NULL,
  by_staff      TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at            INTEGER NOT NULL,
  CHECK ((kind = 'discount') = (bill_id IS NOT NULL AND reason IS NOT NULL)),
  CHECK ((kind = 'tip') = (payment_id IS NOT NULL))
);
CREATE INDEX settle_differences_shift_idx ON settle_differences (business_id, shift_day);
CREATE TRIGGER settle_differences_frozen
BEFORE UPDATE ON settle_differences
BEGIN
  SELECT RAISE(ABORT, 'difference_frozen');
END;
