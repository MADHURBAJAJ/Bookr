-- Complimentary bills (approved 14 Nov 2026).
-- The software report's own word for the mode (e.g. PREPAID), kept as written: the mode column stays upi/card/cash/unknown.
ALTER TABLE software_bills ADD COLUMN mode_text TEXT;

-- A bill a person made complimentary, with the guest's name. Keyed by shift and bill number, so it outlives the
-- comparison rows, which are rebuilt when the register or the software report changes.
CREATE TABLE complimentary_marks (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day   TEXT NOT NULL,
  bill_no     TEXT NOT NULL,
  guest_name  TEXT NOT NULL,
  marked_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  marked_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX complimentary_marks_key ON complimentary_marks (business_id, shift_day, bill_no);
