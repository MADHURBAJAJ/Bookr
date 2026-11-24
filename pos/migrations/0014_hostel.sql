-- Hostel changes (approved 21 Nov 2026). Table sections themselves live in businesses.tables (JSON), so they need no
-- column: Private Rooms, Dorms (beds, and the whole dorm), Out House, NC and others.

-- KOT numbers start at 101 each shift day: day_no is what is printed and shown; kot_no stays the restaurant's running
-- number underneath (unique, as before). Older KOTs keep showing kot_no.
ALTER TABLE kots ADD COLUMN shift_day TEXT;
ALTER TABLE kots ADD COLUMN day_no INTEGER;
CREATE UNIQUE INDEX kots_day_no_key ON kots (business_id, shift_day, day_no) WHERE day_no IS NOT NULL;

-- Guests, kept for their next check-in: name, phone (digits only, the key a returning guest is found by) and city.
CREATE TABLE guests (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone       TEXT NOT NULL CHECK (phone GLOB '[0-9]*' AND length(phone) BETWEEN 6 AND 15),
  city        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX guests_phone_key ON guests (business_id, phone);
ALTER TABLE stays ADD COLUMN guest_id TEXT REFERENCES guests(id);
ALTER TABLE stays ADD COLUMN phone TEXT;

-- Events: bills printed during the event at its tables count towards it; the organiser's commission is a share of
-- their net sales (after bill discounts, before GST, liquor included).
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  organiser     TEXT NOT NULL CHECK (length(trim(organiser)) > 0),
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER NOT NULL CHECK (ends_at > starts_at),
  commission_bp INTEGER NOT NULL CHECK (commission_bp BETWEEN 0 AND 10000),
  sections      TEXT NOT NULL CHECK (json_valid(sections)),        -- the table sections whose bills count
  menu          TEXT CHECK (menu IS NULL OR json_valid(menu)),     -- menu sections shown at those tables during the event, or all
  created_by    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  cancelled_at  INTEGER
);
CREATE INDEX events_time_idx ON events (business_id, starts_at);

-- What has been paid to an event's organiser. Cash and UPI also go out of the drawer (a paid-out), so shift close counts them.
CREATE TABLE event_payments (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_id      TEXT NOT NULL REFERENCES events(id),
  amount_paise  INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  mode          TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'bank')),
  drawer_out_id TEXT REFERENCES drawer_outs(id),
  note          TEXT,
  shift_day     TEXT NOT NULL,
  by_staff      TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at            INTEGER NOT NULL
);
CREATE INDEX event_payments_event_idx ON event_payments (event_id);
CREATE TRIGGER event_payments_frozen
BEFORE UPDATE ON event_payments
BEGIN
  SELECT RAISE(ABORT, 'event_payment_frozen');
END;
