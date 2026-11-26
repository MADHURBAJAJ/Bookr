-- Service charge and prices that include GST (26 Nov 2026, approved by the owner). One service charge rate for the
-- business (0 = none). Each category says whether its items carry service charge and whether their menu price already
-- includes GST; an item may say otherwise (NULL = as its category). A bill keeps the rate it was printed with (0 when
-- the guest asked for it to be taken off) and the amount; each bill line keeps how it was charged.
ALTER TABLE businesses ADD COLUMN service_charge_bp INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_bp BETWEEN 0 AND 2000);
ALTER TABLE menu_categories ADD COLUMN service_charge INTEGER NOT NULL DEFAULT 0 CHECK (service_charge IN (0, 1));
ALTER TABLE menu_categories ADD COLUMN price_incl INTEGER NOT NULL DEFAULT 0 CHECK (price_incl IN (0, 1));
ALTER TABLE menu_items ADD COLUMN service_charge INTEGER CHECK (service_charge IS NULL OR service_charge IN (0, 1));
ALTER TABLE menu_items ADD COLUMN price_incl INTEGER CHECK (price_incl IS NULL OR price_incl IN (0, 1));
ALTER TABLE bills ADD COLUMN service_charge_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN service_charge_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bill_lines ADD COLUMN service_charge INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bill_lines ADD COLUMN price_incl INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_notes ADD COLUMN service_charge_paise INTEGER NOT NULL DEFAULT 0;
