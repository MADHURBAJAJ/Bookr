-- Bill photos on cash book expenses (approved 28 Nov 2026): optional, up to 3 per expense, proof only (nothing is read
-- from them, and a missing bill does not stop approval). The file is in R2 (UPLOADS), served through the Worker after
-- the same per-business role check as the book.
CREATE TABLE cash_entry_bills (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  entry_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  added_by TEXT REFERENCES users(id),
  added_at INTEGER NOT NULL
);
CREATE INDEX cash_entry_bills_entry ON cash_entry_bills (entry_id);
