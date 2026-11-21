-- Billing controls (21 Nov 2026).
-- 1. The discount a cashier may give alone, as a share of the bill (1000 = 10%); above it a manager's PIN is needed.
ALTER TABLE businesses ADD COLUMN disc_limit_bp INTEGER NOT NULL DEFAULT 1000 CHECK (disc_limit_bp BETWEEN 0 AND 10000);

-- 2. A discount on one line (an item made free or a share off it), taken off that line before the bill's own discount.
ALTER TABLE bill_lines ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0);

-- 3. A payment taken as the wrong kind (cash entered as UPI) is corrected while its shift is open: only cash, UPI and
-- card, only the kind and its details (UPI account, card slip). Amount, bill and time never change. Each change is on
-- the Daily check (pos_events 'pay_change').
DROP TRIGGER payments_frozen;
CREATE TRIGGER payments_frozen BEFORE UPDATE ON payments
WHEN NEW.id IS NOT OLD.id OR NEW.business_id IS NOT OLD.business_id OR NEW.settlement_id IS NOT OLD.settlement_id
  OR NEW.amount_paise IS NOT OLD.amount_paise OR NEW.debtor_account_id IS NOT OLD.debtor_account_id
  OR NEW.comp_guest IS NOT OLD.comp_guest OR NEW.comp_reason IS NOT OLD.comp_reason OR NEW.shift_day IS NOT OLD.shift_day
  OR NEW.by_staff IS NOT OLD.by_staff OR NEW.at IS NOT OLD.at
  OR OLD.mode NOT IN ('cash', 'upi', 'card') OR NEW.mode NOT IN ('cash', 'upi', 'card')
BEGIN
  SELECT RAISE(ABORT, 'payment_frozen');
END;
CREATE TRIGGER payments_change_shift_closed BEFORE UPDATE ON payments
WHEN EXISTS (SELECT 1 FROM shift_closes WHERE business_id = OLD.business_id AND shift_day = OLD.shift_day)
BEGIN
  SELECT RAISE(ABORT, 'shift_closed');
END;

CREATE TABLE pos_events_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('void', 'reprint', 'kot_cancel', 'discount', 'comp', 'limit_warning', 'credit_note', 'stock_waste', 'stock_count', 'pay_change')),
  ref          TEXT NOT NULL,
  amount_paise INTEGER,
  reason       TEXT,
  detail       TEXT,
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  shift_day    TEXT NOT NULL,
  at           INTEGER NOT NULL
);
INSERT INTO pos_events_new SELECT id, business_id, kind, ref, amount_paise, reason, detail, by_staff, shift_day, at FROM pos_events;
DROP TABLE pos_events;
ALTER TABLE pos_events_new RENAME TO pos_events;
CREATE INDEX pos_events_shift_idx ON pos_events (business_id, shift_day);
CREATE TRIGGER pos_events_frozen
BEFORE UPDATE ON pos_events
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;
CREATE TRIGGER pos_events_no_delete
BEFORE DELETE ON pos_events
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;
