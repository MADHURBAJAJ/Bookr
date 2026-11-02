-- When a hand match finds the bank received a different amount than the bill (a typo, a discount, a tip),
-- the bill itself is corrected: register payment, discount/tip, and the income row. Approved 2 Nov 2026.
-- Every change is recorded here with before and after; unmatching records the reverse and restores.
CREATE TABLE register_bank_adjustments (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_row_id  TEXT NOT NULL REFERENCES bank_rows(id) ON DELETE CASCADE,
  target       TEXT NOT NULL CHECK (target IN ('register_row', 'register_payment', 'transaction')),
  target_id    TEXT NOT NULL,
  field        TEXT NOT NULL CHECK (field IN ('discount_paise', 'tip_paise', 'amount_paise')),
  before_paise INTEGER NOT NULL,
  after_paise  INTEGER NOT NULL,
  note         TEXT,
  reverses_id  TEXT REFERENCES register_bank_adjustments(id) ON DELETE SET NULL,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX register_bank_adjustments_row_idx ON register_bank_adjustments (bank_row_id);
CREATE INDEX register_bank_adjustments_target_idx ON register_bank_adjustments (target_id);

-- A confirmed shift's register row stays locked, with one exception: its discount and tip may change when the
-- same batch records that exact change as a bank adjustment above. Bill number, type, amount and the rest stay locked.
DROP TRIGGER register_rows_locked_update;
CREATE TRIGGER register_rows_locked_update
BEFORE UPDATE ON register_rows
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND status = 'confirmed' AND shift_day IN (OLD.shift_day, NEW.shift_day))
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
  AND NOT (
    NEW.bill_no IS OLD.bill_no AND NEW.bill_type IS OLD.bill_type AND NEW.amount_paise IS OLD.amount_paise
    AND NEW.paid_with_row_id IS OLD.paid_with_row_id AND NEW.status IS OLD.status AND NEW.shift_day IS OLD.shift_day
    AND NEW.upload_id IS OLD.upload_id AND NEW.line_no IS OLD.line_no AND NEW.remarks IS OLD.remarks
    AND EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target = 'register_row' AND a.target_id = OLD.id
      AND a.field = 'discount_paise' AND a.before_paise = OLD.discount_paise AND a.after_paise = NEW.discount_paise)
    AND EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target = 'register_row' AND a.target_id = OLD.id
      AND a.field = 'tip_paise' AND a.before_paise = OLD.tip_paise AND a.after_paise = NEW.tip_paise)
  )
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
