-- Cash drawers (24 Nov 2026, approved by the owner): who answers for the cash, from when to when. A cashier hands the
-- drawer to the next cashier at any time (blind count, open tables handed over by name, the next person accepts with
-- their PIN); the day close counts the drawer and sends cash above the float to the safe. Only one drawer is open at a
-- time; a drawer covers the cash taken from the close of the one before it to its own close.
ALTER TABLE businesses ADD COLUMN float_paise INTEGER NOT NULL DEFAULT 0 CHECK (float_paise >= 0);

CREATE TABLE drawers (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  held_by         TEXT NOT NULL REFERENCES staff(id),
  opened_at       INTEGER NOT NULL,                 -- cash after this time counts in this drawer
  opening_paise   INTEGER NOT NULL CHECK (opening_paise >= 0),
  opening_from    TEXT NOT NULL CHECK (opening_from IN ('float', 'handover')),
  closed_at       INTEGER,
  close_kind      TEXT CHECK (close_kind IN ('handover', 'takeover', 'count', 'day_close')),
  counted         TEXT CHECK (counted IS NULL OR json_valid(counted)),
  counted_paise   INTEGER,
  expected_paise  INTEGER,
  difference_paise INTEGER,
  difference_reason TEXT,
  closed_by       TEXT REFERENCES staff(id),
  accepted_by     TEXT REFERENCES staff(id),       -- the next holder (handover, takeover)
  approved_by     TEXT REFERENCES staff(id),       -- the manager, when the holder was not there
  shift_day       TEXT,                            -- the day closed with this count (day close)
  CHECK ((closed_at IS NULL) = (close_kind IS NULL)),
  CHECK (difference_paise IS NULL OR difference_paise = 0 OR difference_reason IS NOT NULL)
);
CREATE UNIQUE INDEX drawers_one_open ON drawers (business_id) WHERE closed_at IS NULL;
CREATE INDEX drawers_time_idx ON drawers (business_id, closed_at);

-- Who holds each open order once it was handed over: the cashier it came from, and when.
ALTER TABLE orders ADD COLUMN handed_from TEXT REFERENCES staff(id);
ALTER TABLE orders ADD COLUMN held_by TEXT REFERENCES staff(id);
ALTER TABLE orders ADD COLUMN handed_at INTEGER;

-- Lookups of cash by time, for a drawer's window.
CREATE INDEX IF NOT EXISTS payments_at_idx ON payments (business_id, at);
CREATE INDEX IF NOT EXISTS drawer_outs_at_idx ON drawer_outs (business_id, at);
