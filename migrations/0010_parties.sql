-- Vendors (the handover's "parties"), each remembered under a default expense head, e.g.
-- Blinkit -> Kitchen purchases. An expense line names its vendor in transactions.party_id.
CREATE TABLE parties (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases)),   -- other spellings, e.g. ["blinkit.com"]
  default_head_id TEXT REFERENCES heads(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX parties_business_name_key ON parties (business_id, lower(name));
CREATE INDEX transactions_party_idx ON transactions (party_id);
