-- Money taken at reception (24 Nov 2026, approved: "build as recommended"). Reception also enters what it takes in Djubo;
-- the POS works out from Djubo's mails which part of a booking's advance was taken at the desk (entered or changed in
-- Djubo by a reception user) and asks for it here, so every rupee taken at the desk gets a POS receipt and is counted in
-- the drawer. The booking team's advances stay "paid before arrival".

-- The Djubo user names that work at reception (JSON list, e.g. ["Suresh Ramoda"]).
ALTER TABLE businesses ADD COLUMN reception_users TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reception_users));

-- Of a booking's advance in Djubo, the part entered by reception (money taken at the desk), and when it last went up.
ALTER TABLE bookings ADD COLUMN desk_paid_paise INTEGER NOT NULL DEFAULT 0 CHECK (desk_paid_paise >= 0);
ALTER TABLE bookings ADD COLUMN desk_paid_at INTEGER;
ALTER TABLE bookings ADD COLUMN entered_by TEXT;     -- who made or last changed it in Djubo, as the mail says

-- An advance taken at the desk before the guest checks in: for a booking, or before Djubo has the booking (then with the
-- guest's name, phone and check-in, and attached to the booking when its mail arrives). Its money is a receipt
-- (settlements / payments, numbered); at check-in it moves onto the room's bill.
CREATE TABLE desk_advances (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id     TEXT REFERENCES bookings(id),
  guest_name     TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
  phone          TEXT CHECK (phone IS NULL OR (phone GLOB '[0-9]*' AND length(phone) BETWEEN 6 AND 15)),
  check_in       TEXT CHECK (check_in IS NULL OR check_in GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  settlement_id  TEXT NOT NULL REFERENCES settlements(id),
  status         TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'applied', 'refunded')),
  stay_id        TEXT REFERENCES stays(id),
  by_staff       TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at             INTEGER NOT NULL,
  CHECK (booking_id IS NOT NULL OR (phone IS NOT NULL AND check_in IS NOT NULL))
);
CREATE INDEX desk_advances_booking ON desk_advances (booking_id);
CREATE INDEX desk_advances_held ON desk_advances (business_id, status);

-- Each Djubo mail's advance and who entered it, so the desk's part is worked out again the same way however often the
-- mails are read (each increase made by a reception user is money taken at the desk).
CREATE TABLE booking_paid_log (
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  mail_id      TEXT NOT NULL REFERENCES inbound_mails(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  paid_paise   INTEGER NOT NULL,
  entered_by   TEXT,
  received_at  INTEGER NOT NULL,
  PRIMARY KEY (booking_id, mail_id)
);
