-- Phase 1: Foundation.
-- Every table except users and sessions carries business_id, so each business stays separate.

CREATE TABLE businesses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  fy_start    date NOT NULL,                 -- financial year start, e.g. 2026-04-01
  is_demo     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  email          text NOT NULL,
  password_hash  text NOT NULL,              -- pbkdf2-sha256$iterations$salt$hash
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE memberships (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'accountant', 'entry_staff', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE sessions (
  id           text PRIMARY KEY,               -- SHA-256 of the cookie token; the token itself is never stored
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'accountant', 'entry_staff', 'viewer')),
  invited_by  uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,            -- SHA-256 of the invite token
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX invites_business_idx ON invites (business_id);

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  kind            text NOT NULL CHECK (kind IN ('cash', 'bank')),
  account_number  text,
  opening_balance numeric(14, 2) NOT NULL DEFAULT 0,
  opening_date    date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_business_name_key ON accounts (business_id, lower(name));

CREATE TABLE heads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  type         text NOT NULL CHECK (type IN ('income', 'expense')),
  tally_ledger text,
  is_custom    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX heads_business_type_name_key ON heads (business_id, type, lower(name));
