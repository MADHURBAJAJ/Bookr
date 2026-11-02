-- Type (F&B or Room) chosen with "Use software" for a bill the register does not have. The register
-- normally gives each bill its type; this is set only for that decision and cleared with it.
ALTER TABLE bill_comparisons ADD COLUMN bill_type TEXT CHECK (bill_type IS NULL OR bill_type IN ('fnb', 'room'));
