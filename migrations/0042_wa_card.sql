-- Payment proof list (24 Nov 2026): staff now post the card machine's slip in the Guest payment group, so a WhatsApp
-- file can also be a card slip (kind 'card'). Its approval code and the card's last 4 digits are kept for matching.
-- wa_items is rebuilt to widen its kind check. Dropping the old table would delete its pairs (ON DELETE CASCADE), so the
-- pairs and the pairs a person took apart are copied aside first and put back after.
PRAGMA defer_foreign_keys = true;

CREATE TABLE wa_pairs_keep AS SELECT * FROM wa_pairs;
CREATE TABLE wa_not_pairs_keep AS SELECT * FROM wa_not_pairs;

CREATE TABLE wa_items_new (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  group_id       TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  wa_message_id  TEXT NOT NULL UNIQUE,
  sender_number  TEXT,
  sender_name    TEXT,
  sent_at        INTEGER NOT NULL,
  media_type     TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  file_key       TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes > 0),
  caption        TEXT,
  reply_to_id    TEXT,
  kind           TEXT CHECK (kind IS NULL OR kind IN ('upi', 'bill', 'card', 'other')),
  read_status    TEXT NOT NULL DEFAULT 'waiting' CHECK (read_status IN ('waiting', 'reading', 'read', 'failed')),
  read_started_at INTEGER,
  read_after     INTEGER,
  read_tries     INTEGER NOT NULL DEFAULT 0,
  read_note      TEXT,
  extracted_json TEXT CHECK (extracted_json IS NULL OR json_valid(extracted_json)),
  amount_paise   INTEGER CHECK (amount_paise IS NULL OR (typeof(amount_paise) = 'integer' AND amount_paise > 0)),
  utr            TEXT,
  bill_no        TEXT,
  doc_at         INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'duplicate')),
  duplicate_of   TEXT REFERENCES wa_items_new(id) ON DELETE SET NULL,
  paid_as        TEXT CHECK (paid_as IS NULL OR paid_as IN ('upi', 'cash')),
  tip_paise      INTEGER CHECK (tip_paise IS NULL OR (typeof(tip_paise) = 'integer' AND tip_paise > 0)),
  reviewed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    INTEGER,
  created_at     INTEGER NOT NULL,
  -- A card slip: the approval (auth) code and the card's last 4 digits, as printed.
  card_approval  TEXT,
  card_last4     TEXT
);
INSERT INTO wa_items_new SELECT id, business_id, group_id, wa_message_id, sender_number, sender_name, sent_at, media_type, file_key,
  content_sha256, size_bytes, caption, reply_to_id, kind, read_status, read_started_at, read_after, read_tries, read_note, extracted_json,
  amount_paise, utr, bill_no, doc_at, status, duplicate_of, paid_as, tip_paise, reviewed_by, reviewed_at, created_at, NULL, NULL FROM wa_items;
DROP TABLE wa_items;
ALTER TABLE wa_items_new RENAME TO wa_items;
CREATE UNIQUE INDEX wa_items_sha_key ON wa_items (business_id, content_sha256);
CREATE INDEX wa_items_inbox_idx ON wa_items (business_id, status, sent_at);
CREATE INDEX wa_items_group_idx ON wa_items (group_id, sent_at);
CREATE INDEX wa_items_reply_idx ON wa_items (reply_to_id);
CREATE INDEX wa_items_read_idx ON wa_items (read_status, sent_at);
CREATE INDEX wa_items_utr_idx ON wa_items (business_id, utr);

INSERT OR IGNORE INTO wa_pairs SELECT * FROM wa_pairs_keep;
INSERT OR IGNORE INTO wa_not_pairs SELECT * FROM wa_not_pairs_keep;
DROP TABLE wa_pairs_keep;
DROP TABLE wa_not_pairs_keep;

-- Which groups hold guest payment proof for the POS list (the Guest payment group), not staff or expense groups.
-- Groups already named for payments start switched on.
ALTER TABLE wa_groups ADD COLUMN pos_proof INTEGER NOT NULL DEFAULT 0 CHECK (pos_proof IN (0, 1));
UPDATE wa_groups SET pos_proof = 1 WHERE lower(name) LIKE '%payment%';
