-- Phase 3, part 1 (approved 2 Nov 2026): bank statements from Google Sheets (or pasted), UPI matching, rules.

-- Where an account's statement comes from, and what it receives.
CREATE TABLE bank_sources (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id         TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  format             TEXT NOT NULL DEFAULT 'icici' CHECK (format IN ('icici')),
  sheet_id           TEXT,                                   -- Google Sheet ID; NULL = rows are pasted
  tab                TEXT,                                   -- one tab's name; NULL with a sheet = every tab (e.g. monthly tabs)
  receives_upi_label TEXT,                                   -- register payment column paid into this account, e.g. 'UPI Bank 2'
  receives_card      INTEGER NOT NULL DEFAULT 0 CHECK (receives_card IN (0, 1)),
  last_synced_at     INTEGER,
  last_sync_note     TEXT,
  created_at         INTEGER NOT NULL
);

-- One statement line. Transaction ID is the bank's own, unique per account, so re-reading a sheet adds nothing twice.
CREATE TABLE bank_rows (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tran_id        TEXT NOT NULL,
  value_date     TEXT NOT NULL CHECK (value_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  posted_at      INTEGER NOT NULL,                            -- ms, from the posted date and time (India time)
  day            TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  description    TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('CR', 'DR')),
  amount_paise   INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  balance_paise  INTEGER CHECK (balance_paise IS NULL OR typeof(balance_paise) = 'integer'),
  kind           TEXT NOT NULL CHECK (kind IN ('upi_in', 'upi_out', 'upi_fee', 'reversal', 'card_settlement', 'card_purchase', 'other')),
  upi_ref        TEXT,
  vpa            TEXT,                                        -- the other side's UPI ID as the bank shows it (masked)
  remark         TEXT,                                        -- the payer's or payee's note
  pair_row_id    TEXT REFERENCES bank_rows(id) ON DELETE SET NULL, -- a UPI card fee's credit, or a reversal's debit
  status         TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'booked', 'ignored')),
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL, -- the income or expense row booked from it
  note           TEXT,
  done_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  done_at        INTEGER,
  created_at     INTEGER NOT NULL,
  UNIQUE (account_id, tran_id)
);
CREATE INDEX bank_rows_day_idx ON bank_rows (business_id, day, status);
CREATE INDEX bank_rows_ref_idx ON bank_rows (account_id, upi_ref);

-- A bank credit and the confirmed income row(s) it pays: several for bills paid together.
CREATE TABLE bank_matches (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_row_id    TEXT NOT NULL REFERENCES bank_rows(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  matched_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  matched_at     INTEGER NOT NULL
);
CREATE INDEX bank_matches_row_idx ON bank_matches (bank_row_id);

-- Saved rules: checked top to bottom, first match suggests a head (and party). A person books.
CREATE TABLE rules (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  direction   TEXT CHECK (direction IS NULL OR direction IN ('CR', 'DR')),
  account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  contains    TEXT,                                           -- description contains (any case)
  vpa         TEXT,                                           -- UPI ID equals (any case)
  min_paise   INTEGER,
  max_paise   INTEGER,
  head_id     TEXT NOT NULL REFERENCES heads(id),
  party_id    TEXT REFERENCES parties(id) ON DELETE SET NULL,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  CHECK (contains IS NOT NULL OR vpa IS NOT NULL)
);
CREATE INDEX rules_business_idx ON rules (business_id, position);
CREATE INDEX transactions_bank_idx ON transactions (matched_bank_row);
