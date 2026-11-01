-- Phase 1: Foundation (D1 / SQLite).
-- Ids are UUID text made by the Worker. Times are integer milliseconds since 1970 (UTC).
-- Calendar dates are 'YYYY-MM-DD' text. Money is integer paise.
-- Every table except users and sessions carries business_id, so each business stays separate.

CREATE TABLE businesses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  fy_start    TEXT NOT NULL CHECK (fy_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  is_demo     INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at  INTEGER NOT NULL
);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,              -- pbkdf2-sha256$iterations$salt$hash
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE memberships (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'accountant', 'entry_staff', 'viewer')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- A business always keeps at least one Owner. Enforced in the database, so it holds
-- whichever request runs first. Deleting the whole business is still allowed.
CREATE TRIGGER memberships_keep_owner_update
BEFORE UPDATE OF role ON memberships
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
  AND (SELECT count(*) FROM memberships WHERE business_id = OLD.business_id AND role = 'owner') <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_owner');
END;

CREATE TRIGGER memberships_keep_owner_delete
BEFORE DELETE ON memberships
WHEN OLD.role = 'owner'
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
  AND (SELECT count(*) FROM memberships WHERE business_id = OLD.business_id AND role = 'owner') <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_owner');
END;

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,               -- SHA-256 of the cookie token; the token itself is never stored
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'accountant', 'entry_staff', 'viewer')),
  invited_by  TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,            -- SHA-256 of the invite token
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX invites_business_idx ON invites (business_id);

-- An invite is used at most once, and never after it is revoked or expired. Enforced here so that
-- an accept batch rolls back whole if another request got there first.
CREATE TRIGGER invites_accept_once
BEFORE UPDATE OF accepted_at ON invites
WHEN NEW.accepted_at IS NOT NULL
  AND (OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL OR OLD.expires_at <= NEW.accepted_at)
BEGIN
  SELECT RAISE(ABORT, 'invite_unusable');
END;

CREATE TABLE accounts (
  id                    TEXT PRIMARY KEY,
  business_id           TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind                  TEXT NOT NULL CHECK (kind IN ('cash', 'bank')),
  account_number        TEXT,
  opening_balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (typeof(opening_balance_paise) = 'integer'),
  opening_date          TEXT NOT NULL CHECK (opening_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounts_business_name_key ON accounts (business_id, lower(name));

CREATE TABLE heads (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  tally_ledger TEXT,
  is_custom    INTEGER NOT NULL DEFAULT 1 CHECK (is_custom IN (0, 1)),
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX heads_business_type_name_key ON heads (business_id, type, lower(name));
