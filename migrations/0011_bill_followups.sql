-- Bills found on only one side (software or register) are watched across shifts:
--   decision 'carry_forward'  = not counted yet; expected in another day's data
--   linked_to_id              = the same bill's comparison on another day (late arrival <-> earlier entry);
--                               it is what stops a bill being counted twice
--   closed_at/by, close_note  = a one-sided bill still unmatched after the watch, closed with a reason
-- SQLite cannot change a CHECK in place, so the table is rebuilt with every row copied across.
-- Income rows point at comparisons (ON DELETE SET NULL), so those links are saved first and put back.
CREATE TABLE _keep_tx_comparison AS SELECT id, comparison_id FROM transactions WHERE comparison_id IS NOT NULL;

CREATE TABLE bill_comparisons_new (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day        TEXT NOT NULL,
  pos_no           TEXT NOT NULL,
  bill_no          TEXT NOT NULL,
  software_bill_id TEXT REFERENCES software_bills(id) ON DELETE SET NULL,
  register_row_id  TEXT REFERENCES register_rows(id) ON DELETE SET NULL,
  sw_amount_paise  INTEGER,
  sw_mode          TEXT,
  rg_amount_paise  INTEGER,
  rg_mode          TEXT,
  difference       TEXT NOT NULL CHECK (difference IN ('match', 'amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software', 'complimentary')),
  decision         TEXT CHECK (decision IS NULL OR decision IN ('use_software', 'use_register', 'leave_out', 'carry_forward')),
  decided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at       INTEGER,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  bill_type        TEXT CHECK (bill_type IS NULL OR bill_type IN ('fnb', 'room')),
  linked_to_id     TEXT REFERENCES bill_comparisons(id) ON DELETE SET NULL,
  closed_at        INTEGER,
  closed_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  close_note       TEXT,
  CHECK (decision IS NULL OR difference NOT IN ('match', 'complimentary')),
  CHECK (decision IS NOT 'carry_forward' OR difference IN ('missing_in_register', 'missing_in_software')),
  CHECK (linked_to_id IS NULL OR linked_to_id <> id),
  CHECK ((closed_at IS NULL) = (close_note IS NULL))
);
INSERT INTO bill_comparisons_new (id, business_id, shift_day, pos_no, bill_no, software_bill_id, register_row_id, sw_amount_paise, sw_mode,
  rg_amount_paise, rg_mode, difference, decision, decided_by, decided_at, note, created_at, bill_type)
SELECT id, business_id, shift_day, pos_no, bill_no, software_bill_id, register_row_id, sw_amount_paise, sw_mode,
  rg_amount_paise, rg_mode, difference, decision, decided_by, decided_at, note, created_at, bill_type FROM bill_comparisons;
DROP TABLE bill_comparisons;
ALTER TABLE bill_comparisons_new RENAME TO bill_comparisons;

UPDATE transactions SET comparison_id = (SELECT k.comparison_id FROM _keep_tx_comparison k WHERE k.id = transactions.id)
WHERE id IN (SELECT id FROM _keep_tx_comparison);
DROP TABLE _keep_tx_comparison;

CREATE UNIQUE INDEX bill_comparisons_key ON bill_comparisons (business_id, shift_day, pos_no, bill_no);
CREATE INDEX bill_comparisons_bill_idx ON bill_comparisons (business_id, bill_no);
CREATE INDEX bill_comparisons_linked_idx ON bill_comparisons (linked_to_id);

-- A confirmed shift's decisions and links stay as they were. Closing an old one-sided bill is still allowed.
CREATE TRIGGER bill_comparisons_locked
BEFORE UPDATE OF decision, linked_to_id ON bill_comparisons
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND shift_day = OLD.shift_day AND status = 'confirmed')
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
