-- Bookings read from mail (23 Nov 2026, approved): Gmail forwards the Djubo and MakeMyTrip mails to the POS's address
-- (bookings@mail.thebajajgroup.co, Cloudflare Email Routing → this Worker). Each mail is kept as it came (R2, mail/…)
-- before anything is read; what is read from it becomes a booking a person approves, or, once the business switches
-- it on, goes in by itself when it is clean.
CREATE TABLE inbound_mails (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  from_addr   TEXT NOT NULL,
  subject     TEXT,
  source      TEXT NOT NULL CHECK (source IN ('mmt', 'djubo', 'gmail', 'other')),
  received_at INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('read', 'failed', 'ignored')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (business_id, message_id)
);
CREATE INDEX inbound_mails_recent ON inbound_mails (business_id, received_at);

CREATE TABLE bookings (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('mmt', 'djubo')),
  ext_ref      TEXT NOT NULL,                       -- the booking's own number at MakeMyTrip or Djubo
  guest_name   TEXT,
  phone        TEXT CHECK (phone IS NULL OR (phone GLOB '[0-9]*' AND length(phone) BETWEEN 6 AND 15)),
  room_type    TEXT,                                -- as the mail names it (e.g. Quad Sharing)
  rooms        INTEGER,
  guests       INTEGER,
  check_in     TEXT CHECK (check_in IS NULL OR check_in GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  check_out    TEXT CHECK (check_out IS NULL OR check_out GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_paise INTEGER,
  paid_paise   INTEGER,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'cancelled', 'checked_in')),
  how          TEXT CHECK (how IS NULL OR how IN ('person', 'auto')),   -- how it was approved
  problem      TEXT,                                -- why it waits for a person (missing dates, unknown room type, …)
  match_id     TEXT REFERENCES bookings(id),        -- the same stay as read from the other source
  mail_id      TEXT REFERENCES inbound_mails(id),
  stay_id      TEXT REFERENCES stays(id),
  decided_by   TEXT REFERENCES staff(id) ON DELETE SET NULL,
  decided_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (business_id, source, ext_ref)
);
CREATE INDEX bookings_arrivals ON bookings (business_id, check_in);

-- From this time on, clean bookings go in by themselves; NULL: a person approves every one.
ALTER TABLE businesses ADD COLUMN bookings_auto_from INTEGER;
