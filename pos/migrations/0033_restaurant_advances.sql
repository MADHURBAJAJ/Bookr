-- Advances on restaurant orders (26 Nov 2026): taken on a running table, or for a party booked ahead (name, phone, day and
-- time, people). The money is an advance on its own account (kind credit, named "Advance · <name>") with a numbered receipt,
-- so takings count it on the day taken and using it on a bill later is not counted again; this links it to its order or
-- party. A no-show is given back (a refund) or kept by a manager.
CREATE TABLE restaurant_advances (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES debtor_accounts(id),
  order_id    TEXT REFERENCES orders(id),
  guest_name  TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
  phone       TEXT,
  party_day   TEXT,                 -- a party booked ahead: its day (YYYY-MM-DD) and time
  party_time  TEXT,
  people      INTEGER,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept')),
  kept_note   TEXT,
  created_by  TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX restaurant_advances_open ON restaurant_advances (business_id, status);
