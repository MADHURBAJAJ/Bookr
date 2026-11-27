-- Cancelling a receipt taken by mistake (27 Nov 2026, approved by the owner): managers and owners only, the same open day,
-- with a reason. Receipts and payments are never changed: the cancel is its own row (one per receipt), the room or credit
-- bill gets entries that undo the receipt's, and every money total leaves cancelled receipts out. The number is kept and
-- shown as CANCELLED wherever receipts are listed; the Daily check lists each cancel.
CREATE TABLE receipt_cancels (
  settlement_id TEXT PRIMARY KEY REFERENCES settlements(id),
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 60),
  note          TEXT CHECK (note IS NULL OR length(note) <= 200),
  by_staff      TEXT REFERENCES staff(id) ON DELETE SET NULL,
  shift_day     TEXT NOT NULL,
  at            INTEGER NOT NULL
);
CREATE INDEX receipt_cancels_day ON receipt_cancels (business_id, shift_day);

-- An advance taken before arrival whose receipt is cancelled: 'cancelled', so it is no longer held for the guest.
-- Rebuilt as SQLite cannot change a CHECK.
CREATE TABLE desk_advances_new (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id     TEXT REFERENCES bookings(id),
  guest_name     TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
  phone          TEXT CHECK (phone IS NULL OR (phone GLOB '[0-9]*' AND length(phone) BETWEEN 6 AND 15)),
  check_in       TEXT CHECK (check_in IS NULL OR check_in GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  settlement_id  TEXT NOT NULL REFERENCES settlements(id),
  status         TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'applied', 'refunded', 'kept', 'cancelled')),
  stay_id        TEXT REFERENCES stays(id),
  by_staff       TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at             INTEGER NOT NULL,
  reservation_id TEXT REFERENCES reservations(id),
  kept_at        INTEGER,
  CHECK (booking_id IS NOT NULL OR (phone IS NOT NULL AND check_in IS NOT NULL))
);
INSERT INTO desk_advances_new (id, business_id, booking_id, guest_name, phone, check_in, amount_paise, settlement_id, status, stay_id, by_staff, at, reservation_id, kept_at)
  SELECT id, business_id, booking_id, guest_name, phone, check_in, amount_paise, settlement_id, status, stay_id, by_staff, at, reservation_id, kept_at FROM desk_advances;
DROP TABLE desk_advances;
ALTER TABLE desk_advances_new RENAME TO desk_advances;
CREATE INDEX desk_advances_booking ON desk_advances (booking_id);
CREATE INDEX desk_advances_held ON desk_advances (business_id, status);
