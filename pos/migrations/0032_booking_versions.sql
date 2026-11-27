-- Each booking's history of mails (26 Nov 2026): what every Djubo or MakeMyTrip mail said about it, in the order Djubo made
-- the changes ("Modified On", else when the mail came). The booking follows the newest; reading an old mail again only
-- updates its own line. A change that needs a person (a guest in house cancelled, paid lowered, paid above the total, the
-- total changed a lot with the same dates and rooms) is held until someone applies or keeps it.
CREATE TABLE booking_versions (
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  mail_id      TEXT NOT NULL REFERENCES inbound_mails(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_at     INTEGER NOT NULL,                  -- Djubo's time of the change, else when the mail came
  received_at  INTEGER NOT NULL,
  data         TEXT NOT NULL CHECK (json_valid(data)),   -- what the mail said, as read
  status       TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'older', 'held', 'kept')),
  held_reason  TEXT,
  decided_by   TEXT REFERENCES staff(id) ON DELETE SET NULL,
  decided_at   INTEGER,
  PRIMARY KEY (booking_id, mail_id)
);
CREATE INDEX booking_versions_held ON booking_versions (business_id, status);
-- When a kept mail was added to its bookings' history (built once from the mails kept before, a batch at a time).
ALTER TABLE inbound_mails ADD COLUMN history_at INTEGER;
