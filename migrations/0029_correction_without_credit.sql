-- A correction on a saved shift that is not tied to a bank credit (20 Nov 2026): "Counted twice", where one payment was
-- written in two columns of a register line. The change log's bank credit becomes optional; everything else is as before.
-- The register and decision locks are rebuilt unchanged (they read this table).
DROP TRIGGER register_rows_locked_update;
DROP TRIGGER bill_comparisons_locked;

CREATE TABLE register_bank_adjustments_new (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_row_id  TEXT REFERENCES bank_rows(id) ON DELETE CASCADE,
  target       TEXT NOT NULL CHECK (target IN ('register_row', 'register_payment', 'transaction', 'comparison', 'sale_removed', 'comparison_removed')),
  target_id    TEXT NOT NULL,
  field        TEXT NOT NULL CHECK (field IN ('discount_paise', 'tip_paise', 'amount_paise', 'bill_no', 'decision', 'row')),
  before_paise INTEGER,
  after_paise  INTEGER,
  before_text  TEXT,
  after_text   TEXT,
  before_json  TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  note         TEXT,
  reverses_id  TEXT REFERENCES register_bank_adjustments_new(id) ON DELETE SET NULL,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);
INSERT INTO register_bank_adjustments_new SELECT id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, before_text, after_text, before_json, note,
  reverses_id, created_by, created_at FROM register_bank_adjustments;
DROP TABLE register_bank_adjustments;
ALTER TABLE register_bank_adjustments_new RENAME TO register_bank_adjustments;
CREATE INDEX register_bank_adjustments_row_idx ON register_bank_adjustments (bank_row_id);
CREATE INDEX register_bank_adjustments_target_idx ON register_bank_adjustments (target_id);

CREATE TRIGGER register_rows_locked_update
BEFORE UPDATE ON register_rows
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND status = 'confirmed' AND shift_day IN (OLD.shift_day, NEW.shift_day))
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
  AND NOT (
    NEW.bill_type IS OLD.bill_type AND NEW.paid_with_row_id IS OLD.paid_with_row_id AND NEW.status IS OLD.status
    AND NEW.shift_day IS OLD.shift_day AND NEW.upload_id IS OLD.upload_id AND NEW.line_no IS OLD.line_no AND NEW.remarks IS OLD.remarks
    AND (NEW.discount_paise IS OLD.discount_paise OR EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target = 'register_row' AND a.target_id = OLD.id
      AND a.field = 'discount_paise' AND a.before_paise IS OLD.discount_paise AND a.after_paise IS NEW.discount_paise))
    AND (NEW.tip_paise IS OLD.tip_paise OR EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target = 'register_row' AND a.target_id = OLD.id
      AND a.field = 'tip_paise' AND a.before_paise IS OLD.tip_paise AND a.after_paise IS NEW.tip_paise))
    AND (NEW.amount_paise IS OLD.amount_paise OR EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target = 'register_row' AND a.target_id = OLD.id
      AND a.field = 'amount_paise' AND a.before_paise IS OLD.amount_paise AND a.after_paise IS NEW.amount_paise))
    AND (NEW.bill_no IS OLD.bill_no OR EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target = 'register_row' AND a.target_id = OLD.id
      AND a.field = 'bill_no' AND a.before_text IS OLD.bill_no AND a.after_text IS NEW.bill_no))
  )
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;

CREATE TRIGGER bill_comparisons_locked
BEFORE UPDATE OF decision, linked_to_id ON bill_comparisons
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND shift_day = OLD.shift_day AND status = 'confirmed')
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
  AND NOT (NEW.linked_to_id IS OLD.linked_to_id AND EXISTS (SELECT 1 FROM register_bank_adjustments a WHERE a.target = 'comparison'
    AND a.target_id = OLD.id AND a.field = 'decision' AND a.before_text IS OLD.decision AND a.after_text IS NEW.decision))
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
