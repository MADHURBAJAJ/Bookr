-- Tip paid on top of a bill. Shown to people as a negative discount; kept apart from discounts here.
-- A bill balances when its payments equal amount_paise - discount_paise + tip_paise.
ALTER TABLE register_rows ADD COLUMN tip_paise INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(tip_paise) = 'integer' AND tip_paise >= 0);
