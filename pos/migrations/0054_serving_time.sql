-- Serving time (mock and data model approved 28 Nov 2026). Each dish has a time it should be served in; servers mark food
-- served on their own phones with a photo; the tables screen, the Daily check and a report show what was late.

-- 1. The time, in whole minutes from the KOT. A category's time is for all its items (empty: not timed, as bar categories
-- start); an item may have its own (0: not timed, empty: as its category). Each KOT line keeps the minutes it was sent
-- with (in kots.lines, with its order line's id), so later menu changes don't change old results.
ALTER TABLE menu_categories ADD COLUMN serve_mins INTEGER CHECK (serve_mins IS NULL OR serve_mins BETWEEN 1 AND 240);
ALTER TABLE menu_items ADD COLUMN serve_mins INTEGER CHECK (serve_mins IS NULL OR serve_mins BETWEEN 0 AND 240);
-- Suggested times for food categories (those that make a KOT at a non-bar station), for the owner to check. Bar: not timed.
UPDATE menu_categories SET serve_mins = CASE
    WHEN lower(name) LIKE '%tandoor%' OR lower(name) LIKE '%grill%' OR lower(name) LIKE '%kebab%' OR lower(name) LIKE '%sizzler%' THEN 25
    WHEN lower(name) LIKE '%main%' OR lower(name) LIKE '%curr%' OR lower(name) LIKE '%biryani%' OR lower(name) LIKE '%rice%'
      OR lower(name) LIKE '%thali%' OR lower(name) LIKE '%noodle%' OR lower(name) LIKE '%pasta%' OR lower(name) LIKE '%pizza%' THEN 20
    WHEN lower(name) LIKE '%breakfast%' OR lower(name) LIKE '%egg%' THEN 10
    WHEN lower(name) LIKE '%dessert%' OR lower(name) LIKE '%sweet%' OR lower(name) LIKE '%ice cream%' THEN 8
    ELSE 15 END
  WHERE kot = 1 AND coalesce((SELECT s.is_bar FROM stations s WHERE s.id = menu_categories.station_id), 0) = 0;

-- 2. Servers (a role of their own, approved 28 Nov 2026). Kept apart from staff on purpose: a server can never pass the
-- staff sign-in check, so no staff screen or action is reachable with a server's sign-in. A 6-digit PIN that works on any
-- phone, but only on the Serve page. pin_key (SHA-256 of business and PIN) finds the server and keeps PINs unique among a
-- business's active servers; pin_hash is checked as for staff PINs. Removing a server (active 0) ends their sign-in at once.
CREATE TABLE servers (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  pin_key      TEXT NOT NULL,
  pin_hash     TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX servers_pin_key ON servers (business_id, pin_key) WHERE active = 1;
CREATE INDEX servers_business_idx ON servers (business_id);

-- A server's sign-in: ends at day close (the shift day it was made in is closed), after 16 hours, or on sign-out.
CREATE TABLE serve_sessions (
  id          TEXT PRIMARY KEY,                -- SHA-256 of the cookie token
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX serve_sessions_server_idx ON serve_sessions (server_id);

-- Server PIN tries, per internet connection (stored as a hash, never the address): wrong ones block that connection for a
-- while; the Daily check counts them; a manager can unlock a connection (cleared_at).
CREATE TABLE serve_signins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conn        TEXT NOT NULL,
  ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
  server_id   TEXT REFERENCES servers(id) ON DELETE SET NULL,
  shift_day   TEXT NOT NULL,
  at          INTEGER NOT NULL,
  cleared_at  INTEGER
);
CREATE INDEX serve_signins_conn_idx ON serve_signins (business_id, conn, at);
CREATE INDEX serve_signins_day_idx ON serve_signins (business_id, shift_day);

-- 3. Served, per item on a KOT (its line number in kots.lines). first_at is kept for good and is what "late" is worked
-- out from; served_at is the current state (NULL once undone). One tap (a batch) shares one photo. A manager's mark has
-- staff_id and no photo. Undo and manager marks also go to the exceptions log (pos_events).
CREATE TABLE kot_served (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kot_id      TEXT NOT NULL REFERENCES kots(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL CHECK (line_no >= 0),
  batch       TEXT NOT NULL,
  first_at    INTEGER NOT NULL,
  served_at   INTEGER,
  server_id   TEXT REFERENCES servers(id) ON DELETE SET NULL,
  staff_id    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  photo_at    INTEGER,
  shift_day   TEXT NOT NULL,
  undone_at   INTEGER,
  undone_by   TEXT,
  undo_reason TEXT,
  UNIQUE (kot_id, line_no)
);
CREATE INDEX kot_served_day_idx ON kot_served (business_id, shift_day);
CREATE INDEX kot_served_batch_idx ON kot_served (batch);

-- 4. The exceptions log gains 'serve_undo' and 'serve_manager'. Rebuilt as SQLite cannot change a CHECK (as in 0015).
CREATE TABLE pos_events_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('void', 'reprint', 'kot_cancel', 'discount', 'comp', 'limit_warning', 'credit_note', 'stock_waste', 'stock_count', 'pay_change',
                 'serve_undo', 'serve_manager')),
  ref          TEXT NOT NULL,
  amount_paise INTEGER,
  reason       TEXT,
  detail       TEXT,
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  shift_day    TEXT NOT NULL,
  at           INTEGER NOT NULL
);
INSERT INTO pos_events_new SELECT id, business_id, kind, ref, amount_paise, reason, detail, by_staff, shift_day, at FROM pos_events;
DROP TABLE pos_events;
ALTER TABLE pos_events_new RENAME TO pos_events;
CREATE INDEX pos_events_shift_idx ON pos_events (business_id, shift_day);
CREATE TRIGGER pos_events_frozen
BEFORE UPDATE ON pos_events
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;
CREATE TRIGGER pos_events_no_delete
BEFORE DELETE ON pos_events
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;
