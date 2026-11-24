-- Liquor is outside GST and billed without VAT (approved 18 Nov 2026, option B: one bill, GST on the taxed lines only).
-- A menu item says whether GST applies; a bill line keeps whether it was taxed; a bill and a credit note keep the value of
-- their untaxed lines (after their share of any discount) apart from the taxable value. Old rows: everything taxed, as billed.
ALTER TABLE menu_items ADD COLUMN tax TEXT NOT NULL DEFAULT 'gst' CHECK (tax IN ('gst', 'none'));
ALTER TABLE bill_lines ADD COLUMN taxed INTEGER NOT NULL DEFAULT 1 CHECK (taxed IN (0, 1));
ALTER TABLE bills ADD COLUMN nongst_paise INTEGER NOT NULL DEFAULT 0 CHECK (nongst_paise >= 0);
ALTER TABLE credit_notes ADD COLUMN nongst_paise INTEGER NOT NULL DEFAULT 0 CHECK (nongst_paise >= 0);
CREATE TRIGGER bills_nongst_frozen
BEFORE UPDATE ON bills
WHEN NEW.nongst_paise IS NOT OLD.nongst_paise
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;
CREATE TRIGGER bill_lines_taxed_frozen
BEFORE UPDATE ON bill_lines
WHEN NEW.taxed IS NOT OLD.taxed
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;
