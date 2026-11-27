-- Approving expenses at once (approved 28 Nov 2026).
-- Notices: a change after approval (to the owners), an expense the owner removed (to its cashier). Each person clears
-- their own; the change itself stays in the audit log.
CREATE TABLE notices (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('head_after_approval', 'owner_change', 'line_removed')),
  entry_id    TEXT,
  by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  detail      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX notices_user_idx ON notices (business_id, user_id, done_at);

-- An expense the owner (or accountant) removed from a cashier's book: kept to show struck off on that day.
CREATE TABLE removed_cash_lines (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  narration    TEXT,
  removed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  removed_at   INTEGER NOT NULL,
  note         TEXT
);
CREATE INDEX removed_cash_lines_book_day_idx ON removed_cash_lines (account_id, day);

-- Heads learnt from what an expense was for: once set, the next expense with the same words gets that head by itself.
CREATE TABLE head_memory (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  head_id     TEXT NOT NULL REFERENCES heads(id) ON DELETE CASCADE,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (business_id, key)
);
ALTER TABLE cash_entries ADD COLUMN head_learnt INTEGER NOT NULL DEFAULT 0;
