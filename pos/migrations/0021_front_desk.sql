-- The front desk (25 Nov 2026, approved: "build as recommended"). Rooms becomes its own tab: today's board, a room chart,
-- reservations, new reservations made at the desk, and check-in with ID details and a printed registration card.
-- Djubo stays the master for rooms: a reservation made here is shown as "not in Djubo yet" (and reception reminded)
-- until Djubo's confirmation mail arrives and links to it by phone and dates.

-- The rate per room type for reservations made here (GST included, paise per night): {"Deluxe": 160000}.
ALTER TABLE businesses ADD COLUMN room_rates TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(room_rates));

-- A reservation made at the desk (phone, WhatsApp, walk-in for later).
CREATE TABLE reservations (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  guest_name    TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
  phone         TEXT NOT NULL CHECK (phone GLOB '[0-9]*' AND length(phone) BETWEEN 6 AND 15),
  email         TEXT,
  city          TEXT,
  nationality   TEXT,
  company       TEXT,
  gstin         TEXT,
  check_in      TEXT NOT NULL CHECK (check_in GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  check_out     TEXT NOT NULL CHECK (check_out GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND check_out > check_in),
  arrival_time  TEXT,
  lines         TEXT NOT NULL CHECK (json_valid(lines)),   -- [{type, rooms, roomNames, adults, children, ratePaise}]
  meal_plan     TEXT,
  extras        TEXT,
  source        TEXT NOT NULL,                            -- Walk-in, Phone, WhatsApp, Instagram, Travel agent, Corporate
  requests      TEXT,
  staff_note    TEXT,
  policy        TEXT,
  status        TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'hold', 'linked', 'cancelled')),
  hold_until    INTEGER,
  total_paise   INTEGER NOT NULL CHECK (total_paise >= 0),
  booking_id    TEXT REFERENCES bookings(id),             -- Djubo's booking, once its mail arrives
  stay_id       TEXT REFERENCES stays(id),
  remind_from   INTEGER NOT NULL,                         -- reminders to enter it in Djubo count from here
  made_by       TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  cancel_reason TEXT
);
CREATE INDEX reservations_open ON reservations (business_id, status, check_in);
CREATE INDEX reservations_phone ON reservations (business_id, phone, check_in);

-- An advance taken with a reservation made here.
ALTER TABLE desk_advances ADD COLUMN reservation_id TEXT REFERENCES reservations(id);

-- A room or bed out of order (repairs) for some nights.
CREATE TABLE room_blocks (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  room        TEXT NOT NULL,
  from_day    TEXT NOT NULL,
  to_day      TEXT NOT NULL CHECK (to_day >= from_day),   -- the last night out of order
  note        TEXT NOT NULL CHECK (length(trim(note)) > 0),
  by_staff    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX room_blocks_days ON room_blocks (business_id, from_day);

-- Check-in details for the registration card: guests, each adult's ID (type and last 4 digits only), address, travel,
-- a foreign guest's passport and visa (Form C), and the card's number (GRC-2627-0001).
ALTER TABLE stays ADD COLUMN adults INTEGER;
ALTER TABLE stays ADD COLUMN children INTEGER;
ALTER TABLE stays ADD COLUMN id_docs TEXT CHECK (id_docs IS NULL OR json_valid(id_docs));   -- [{type, last4, name}]
ALTER TABLE stays ADD COLUMN address TEXT;
ALTER TABLE stays ADD COLUMN coming_from TEXT;
ALTER TABLE stays ADD COLUMN going_to TEXT;
ALTER TABLE stays ADD COLUMN nationality TEXT;
ALTER TABLE stays ADD COLUMN foreign_info TEXT CHECK (foreign_info IS NULL OR json_valid(foreign_info));   -- {passportLast4, visa, visaExpiry, arrivedOn, formC}
ALTER TABLE stays ADD COLUMN check_out_plan TEXT;
ALTER TABLE stays ADD COLUMN reservation_id TEXT REFERENCES reservations(id);
ALTER TABLE stays ADD COLUMN grc_no TEXT;
CREATE UNIQUE INDEX stays_grc_key ON stays (business_id, grc_no) WHERE grc_no IS NOT NULL;
CREATE TABLE grc_series (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fy          TEXT NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, fy)
);
