-- School cash book (approved 20 Nov 2026): cashiers keep their own cash book on the phone, in place of Khatabook.
-- A business has branches; a branch has one or more cashiers; each cashier has their own book (a cash account).
-- A book holds what the cashier types: fees received, expenses, cash handed over or received, and the cash counted.
-- Cash handed over can go anywhere: another cashier's book (any branch), a person (a party, e.g. the owner), or the
-- bank. It stays "sent" until the other side shows it: the receiving book's line, the person ticking it, or the deposit
-- in the bank statement.
--
-- Typed lines live in their own table (cash_entries), not in transactions: adding a source to transactions would mean
-- rebuilding that table, which bank, card and register matches point at (ON DELETE CASCADE), on the live database.
-- Nothing here changes an existing row; the hotel's data is untouched.

CREATE TABLE branches (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX branches_business_name_key ON branches (business_id, lower(name));

-- A cash account becomes a cashier's book when it names its branch and its cashier (a member of the business).
ALTER TABLE accounts ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN cashier_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX accounts_branch_idx ON accounts (branch_id);
CREATE INDEX accounts_cashier_idx ON accounts (cashier_user_id);

CREATE TRIGGER accounts_book_insert
BEFORE INSERT ON accounts
WHEN NEW.branch_id IS NOT NULL OR NEW.cashier_user_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'book_not_cash') WHERE NEW.cashier_user_id IS NOT NULL AND NEW.kind <> 'cash';
  SELECT RAISE(ABORT, 'branch_other_business')
    WHERE NEW.branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.id = NEW.branch_id AND b.business_id = NEW.business_id);
  SELECT RAISE(ABORT, 'cashier_not_member')
    WHERE NEW.cashier_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = NEW.cashier_user_id AND m.business_id = NEW.business_id);
END;

-- Each check runs only for the value being set, and not while the whole business is being deleted (as in 0007).
CREATE TRIGGER accounts_book_update
BEFORE UPDATE OF branch_id, cashier_user_id, kind ON accounts
WHEN (NEW.branch_id IS NOT NULL OR NEW.cashier_user_id IS NOT NULL)
  AND EXISTS (SELECT 1 FROM businesses WHERE id = NEW.business_id)
BEGIN
  SELECT RAISE(ABORT, 'book_not_cash') WHERE NEW.cashier_user_id IS NOT NULL AND NEW.kind <> 'cash';
  SELECT RAISE(ABORT, 'branch_other_business')
    WHERE NEW.branch_id IS NOT NULL AND NEW.branch_id IS NOT OLD.branch_id
      AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.id = NEW.branch_id AND b.business_id = NEW.business_id);
  SELECT RAISE(ABORT, 'cashier_not_member')
    WHERE NEW.cashier_user_id IS NOT NULL AND NEW.cashier_user_id IS NOT OLD.cashier_user_id
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = NEW.cashier_user_id AND m.business_id = NEW.business_id);
END;

-- One line of a cashier's book. Amount is always positive; the kind says which way the cash moved.
--   fee           fees received in cash (checked against the fee software's cash collection for the branch)
--   other_in      any other cash received (e.g. from a person, a party)
--   expense       cash spent, under an expense head, with the slip photo if there is one
--   other_out     any other cash paid out
--   handover_out  cash handed over (see cash_handovers)
--   handover_in   cash received from another cashier's book (the other side of a handover)
CREATE TABLE cash_entries (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  day          TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind         TEXT NOT NULL CHECK (kind IN ('fee', 'other_in', 'expense', 'other_out', 'handover_out', 'handover_in')),
  amount_paise INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  head_id      TEXT REFERENCES heads(id),
  party_id     TEXT REFERENCES parties(id) ON DELETE SET NULL,
  narration    TEXT,
  upload_id    TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  entered_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  entered_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX cash_entries_book_day_idx ON cash_entries (account_id, day);
CREATE INDEX cash_entries_business_day_idx ON cash_entries (business_id, day, kind);

CREATE TRIGGER cash_entries_book_check
BEFORE INSERT ON cash_entries
BEGIN
  SELECT RAISE(ABORT, 'not_a_book')
    WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = NEW.account_id AND a.business_id = NEW.business_id AND a.kind = 'cash');
END;

-- Cash handed over: one per handover_out line. Where it went, and whether the other side shows it yet.
--   to_kind book    another cashier's book (to_account_id); received when that book has its handover_in line (to_entry_id)
--   to_kind person  a person kept as a party (to_party_id), e.g. the owner; received when a person ticks it
--   to_kind bank    a bank account (to_account_id); deposited when the deposit is found in the statement (bank_row_id)
CREATE TABLE cash_handovers (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  from_entry_id TEXT NOT NULL UNIQUE REFERENCES cash_entries(id) ON DELETE CASCADE,
  to_kind       TEXT NOT NULL CHECK (to_kind IN ('book', 'person', 'bank')),
  to_account_id TEXT REFERENCES accounts(id),
  to_party_id   TEXT REFERENCES parties(id),
  status        TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received', 'deposited')),
  to_entry_id   TEXT UNIQUE REFERENCES cash_entries(id) ON DELETE SET NULL,
  bank_row_id   TEXT UNIQUE REFERENCES bank_rows(id) ON DELETE SET NULL,
  settled_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  settled_at    INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK ((to_kind = 'person') = (to_party_id IS NOT NULL)),
  CHECK ((to_kind <> 'person') = (to_account_id IS NOT NULL)),
  CHECK (to_entry_id IS NULL OR to_kind = 'book'),
  CHECK (bank_row_id IS NULL OR to_kind = 'bank'),
  CHECK (status <> 'deposited' OR to_kind = 'bank'),
  CHECK (status <> 'received' OR to_kind <> 'bank')
);
CREATE INDEX cash_handovers_status_idx ON cash_handovers (business_id, status);
CREATE INDEX cash_handovers_to_idx ON cash_handovers (to_account_id, status);

CREATE TRIGGER cash_handovers_check
BEFORE INSERT ON cash_handovers
BEGIN
  SELECT RAISE(ABORT, 'handover_not_out')
    WHERE NOT EXISTS (SELECT 1 FROM cash_entries e WHERE e.id = NEW.from_entry_id AND e.business_id = NEW.business_id AND e.kind = 'handover_out');
  SELECT RAISE(ABORT, 'handover_to_wrong_account')
    WHERE NEW.to_account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM accounts a WHERE a.id = NEW.to_account_id AND a.business_id = NEW.business_id
        AND a.kind = CASE NEW.to_kind WHEN 'bank' THEN 'bank' ELSE 'cash' END);
  SELECT RAISE(ABORT, 'handover_to_own_book')
    WHERE NEW.to_account_id = (SELECT account_id FROM cash_entries WHERE id = NEW.from_entry_id);
END;

CREATE TRIGGER cash_handovers_receive
BEFORE UPDATE OF to_entry_id ON cash_handovers
WHEN NEW.to_entry_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'receive_line_mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM cash_entries i JOIN cash_entries o ON o.id = NEW.from_entry_id
      WHERE i.id = NEW.to_entry_id AND i.kind = 'handover_in' AND i.account_id = NEW.to_account_id
        AND i.amount_paise = o.amount_paise);
END;

-- Cash counted in a book at the end of a day, against what the book says should be in hand.
CREATE TABLE cash_counts (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  day           TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  counted_paise INTEGER NOT NULL CHECK (typeof(counted_paise) = 'integer' AND counted_paise >= 0),
  counted_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  counted_at    INTEGER NOT NULL,
  UNIQUE (account_id, day)
);
