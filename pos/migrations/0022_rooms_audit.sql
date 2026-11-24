-- Rooms, after the hotel manager's audit (25 Nov 2026, approved: "build 1 to 14"): bill to a company or another room,
-- the company on the room invoice, room credit notes, no-shows (with the advance kept or given back), housekeeping
-- status, and Form C filed.

-- 1. Money moved off a room's bill to a company's credit account or to another room's bill (a group paying together):
-- the ledger gains 'transfer' (out of one account, into the other, same amount). Rebuilt as SQLite cannot change a CHECK.
CREATE TABLE debtor_entries_new (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES debtor_accounts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('charge', 'receipt', 'advance', 'advance_used', 'refund', 'credit_note', 'room_rent', 'prepaid', 'deposit', 'transfer')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  bill_id      TEXT REFERENCES bills(id),
  payment_id   TEXT REFERENCES payments(id),
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at           INTEGER NOT NULL,
  booking_id   TEXT REFERENCES bookings(id),
  note         TEXT,
  CHECK (kind NOT IN ('room_rent', 'prepaid', 'transfer') OR booking_id IS NOT NULL OR note IS NOT NULL)
);
INSERT INTO debtor_entries_new SELECT id, business_id, account_id, kind, amount_paise, bill_id, payment_id, by_staff, at, booking_id, note FROM debtor_entries;
DROP TABLE debtor_entries;
ALTER TABLE debtor_entries_new RENAME TO debtor_entries;
CREATE INDEX debtor_entries_account_idx ON debtor_entries (account_id);
CREATE TRIGGER debtor_entries_frozen
BEFORE UPDATE ON debtor_entries
BEGIN
  SELECT RAISE(ABORT, 'entry_frozen');
END;

-- 2. Who the room invoice is made out to when a company pays or claims GST (name, GSTIN, address).
ALTER TABLE room_invoices ADD COLUMN bill_to_name TEXT;
ALTER TABLE room_invoices ADD COLUMN bill_to_gstin TEXT;
ALTER TABLE room_invoices ADD COLUMN bill_to_address TEXT;

-- 3. Room credit notes: rent given back on a room invoice (a mistake, a goodwill reduction), numbered RCN/26-27/0001,
-- with GST taken back at the invoice's rate.
CREATE TABLE room_credit_notes (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invoice_id     TEXT NOT NULL REFERENCES room_invoices(id),
  fy             TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  cn_no          TEXT NOT NULL,
  shift_day      TEXT NOT NULL,
  reason         TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  taxable_paise  INTEGER NOT NULL,
  cgst_paise     INTEGER NOT NULL,
  sgst_paise     INTEGER NOT NULL,
  total_paise    INTEGER NOT NULL CHECK (total_paise > 0),
  refund_mode    TEXT NOT NULL CHECK (refund_mode IN ('cash', 'upi', 'none')),
  by_staff       TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at             INTEGER NOT NULL,
  UNIQUE (business_id, fy, seq),
  UNIQUE (business_id, cn_no),
  CHECK (taxable_paise + cgst_paise + sgst_paise = total_paise)
);
CREATE INDEX room_credit_notes_invoice ON room_credit_notes (invoice_id);
CREATE TRIGGER room_credit_notes_frozen BEFORE UPDATE ON room_credit_notes
BEGIN
  SELECT RAISE(ABORT, 'credit_note_frozen');
END;
CREATE TRIGGER room_credit_notes_shift_closed
BEFORE INSERT ON room_credit_notes
WHEN EXISTS (SELECT 1 FROM shift_closes WHERE business_id = NEW.business_id AND shift_day = NEW.shift_day)
BEGIN
  SELECT RAISE(ABORT, 'shift_closed');
END;
CREATE TABLE room_cn_series (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fy          TEXT NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, fy)
);

-- 4. No-shows: a booking or reservation whose guest never came, marked by the night audit.
ALTER TABLE bookings ADD COLUMN no_show_at INTEGER;
ALTER TABLE reservations ADD COLUMN no_show_at INTEGER;

-- An advance taken at the desk on a no-show may be kept as the no-show charge: desk_advances gains 'kept'. Nothing refers
-- to desk_advances, so it is rebuilt with every row.
CREATE TABLE desk_advances_new (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id     TEXT REFERENCES bookings(id),
  guest_name     TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
  phone          TEXT CHECK (phone IS NULL OR (phone GLOB '[0-9]*' AND length(phone) BETWEEN 6 AND 15)),
  check_in       TEXT CHECK (check_in IS NULL OR check_in GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  settlement_id  TEXT NOT NULL REFERENCES settlements(id),
  status         TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'applied', 'refunded', 'kept')),
  stay_id        TEXT REFERENCES stays(id),
  by_staff       TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at             INTEGER NOT NULL,
  reservation_id TEXT REFERENCES reservations(id),
  kept_at        INTEGER,
  CHECK (booking_id IS NOT NULL OR (phone IS NOT NULL AND check_in IS NOT NULL))
);
INSERT INTO desk_advances_new (id, business_id, booking_id, guest_name, phone, check_in, amount_paise, settlement_id, status, stay_id, by_staff, at, reservation_id)
  SELECT id, business_id, booking_id, guest_name, phone, check_in, amount_paise, settlement_id, status, stay_id, by_staff, at, reservation_id FROM desk_advances;
DROP TABLE desk_advances;
ALTER TABLE desk_advances_new RENAME TO desk_advances;
CREATE INDEX desk_advances_booking ON desk_advances (booking_id);
CREATE INDEX desk_advances_held ON desk_advances (business_id, status);

-- 5. Housekeeping: each room or bed is dirty (after a check-out), clean, or inspected (ready to sell). No row: ready.
CREATE TABLE room_status (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  room        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('dirty', 'clean', 'inspected')),
  note        TEXT,
  by_staff    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (business_id, room)
);

-- 6. When Form C was filed for a foreign guest (reminded until then).
ALTER TABLE stays ADD COLUMN form_c_at INTEGER;
