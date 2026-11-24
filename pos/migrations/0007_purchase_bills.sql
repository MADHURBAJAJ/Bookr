-- A supplier's bill (approved 17 Nov 2026): its photo, kept in the BILLS R2 bucket, and what Claude read from it.
-- The person checks and corrects the reading before anything is received; the stock moves then point at the bill.
CREATE TABLE purchase_bills (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  photo_key   TEXT,                                   -- R2 object key; NULL for a bill typed in without a photo
  read_json   TEXT CHECK (read_json IS NULL OR json_valid(read_json)),   -- what Claude read, exactly as returned
  read_model  TEXT,
  read_error  TEXT,                                   -- why it could not be read (the photo is still kept)
  vendor      TEXT,
  invoice_no  TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'received')),
  by_staff    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  received_at INTEGER
);
CREATE INDEX purchase_bills_day_idx ON purchase_bills (business_id, created_at);

ALTER TABLE stock_moves ADD COLUMN bill_id TEXT REFERENCES purchase_bills(id);
