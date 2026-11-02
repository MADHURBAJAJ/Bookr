-- Discount written against a bill in the register. A bill balances when its payments equal
-- amount_paise - discount_paise. Compare sales uses that net amount against the software report.
ALTER TABLE register_rows ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(discount_paise) = 'integer' AND discount_paise >= 0);
