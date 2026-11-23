-- Directors' accounts (approved 23 Nov 2026). Each director's family (Bajaj, Kharbanda) has a ledger with a person on
-- every line: what each took (cash, goods from stock, complimentary food at 50% of the bill) and what the hotel gave
-- or repaid them. Balance = taken − given: above zero the family owes the hotel. The ledger starts on a day the user
-- chooses, with each person's opening balance typed in. No existing row changes.

CREATE TABLE directors (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  family      TEXT NOT NULL CHECK (length(trim(family)) > 0),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX directors_name_key ON directors (business_id, lower(name));

-- One ledger line. kind: opening (signed: above zero the person owes), taken (cash), stock_taken (goods from stock),
-- nc (complimentary food at 50%), given (money or goods to the person), repaid (the hotel paying back what the person
-- paid for it). transaction_id: the cash line it explains (kept; the cash did leave the drawer). shift_day + bill_no:
-- the complimentary bill an nc line comes from; income_id: its other side, an income line under "Director NC".
CREATE TABLE director_entries (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  director_id    TEXT NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
  day            TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind           TEXT NOT NULL CHECK (kind IN ('opening', 'taken', 'stock_taken', 'nc', 'given', 'repaid')),
  amount_paise   INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND (kind = 'opening' OR amount_paise > 0)),
  note           TEXT,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  shift_day      TEXT,
  bill_no        TEXT,
  income_id      TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX director_entries_director_idx ON director_entries (director_id, day);
CREATE UNIQUE INDEX director_entries_tx_key ON director_entries (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX director_entries_nc_key ON director_entries (business_id, shift_day, bill_no) WHERE kind = 'nc';
CREATE UNIQUE INDEX director_entries_opening_key ON director_entries (director_id) WHERE kind = 'opening';

-- Names on complimentary bills, sorted once by a person (asked the first time a name comes): a director's family
-- member (which one), staff (listed only), or someone else. name_key is the name in lower case, letters only, with
-- "sir" / "madam" dropped, so DEEPANSH SIR and deepansh are one.
CREATE TABLE nc_names (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name_key    TEXT NOT NULL CHECK (length(name_key) > 0),
  kind        TEXT NOT NULL CHECK (kind IN ('director', 'staff', 'other')),
  director_id TEXT REFERENCES directors(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  CHECK ((kind = 'director') = (director_id IS NOT NULL))
);
CREATE UNIQUE INDEX nc_names_key ON nc_names (business_id, name_key);

-- The day each business's directors' ledger starts (its opening balances are on this day).
ALTER TABLE businesses ADD COLUMN directors_from TEXT;
