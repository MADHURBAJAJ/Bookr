-- WhatsApp inbox, phase 1 (approved 24 Nov 2026). A read-only listener on the reception number sends UPI payment
-- screenshots and bills from chosen work groups to /api/wa/ingest. Each file is kept in R2 and waits here for a person
-- to review it. Nothing is booked from this table by itself. No existing row changes.

-- A WhatsApp group Bookr takes files from. Only active groups are stored; anything else the listener sends is dropped.
-- wa_group_id: WhatsApp's own id (e.g. 120363012345678901@g.us). default_head_id: the head a confirmed item starts with.
CREATE TABLE wa_groups (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  wa_group_id     TEXT NOT NULL UNIQUE CHECK (length(trim(wa_group_id)) > 0),
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  department      TEXT,
  default_head_id TEXT REFERENCES heads(id) ON DELETE SET NULL,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      INTEGER NOT NULL
);
CREATE INDEX wa_groups_business_idx ON wa_groups (business_id);

-- One image or PDF from a group message. wa_message_id is WhatsApp's id, so a message sent twice is stored once;
-- content_sha256 stops the same file forwarded again (a new message id) being stored twice in a business.
-- kind and extracted_json are filled in when the file is read (phase 2). status is the person's review.
CREATE TABLE wa_items (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  group_id       TEXT NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
  wa_message_id  TEXT NOT NULL UNIQUE,
  sender_number  TEXT,
  sender_name    TEXT,
  sent_at        INTEGER NOT NULL,                            -- ms, the message's time
  media_type     TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  file_key       TEXT NOT NULL,                               -- R2 key
  content_sha256 TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes > 0),
  caption        TEXT,
  reply_to_id    TEXT,                                        -- WhatsApp id of the message this one replies to (staff reply to a UPI photo with its bill)
  kind           TEXT CHECK (kind IS NULL OR kind IN ('upi', 'bill', 'other')),
  -- Reading (phase 2): the minute job reads waiting files with Claude. read_after: not before this (after a failed try).
  read_status    TEXT NOT NULL DEFAULT 'waiting' CHECK (read_status IN ('waiting', 'reading', 'read', 'failed')),
  read_started_at INTEGER,
  read_after     INTEGER,
  read_tries     INTEGER NOT NULL DEFAULT 0,
  read_note      TEXT,
  extracted_json TEXT CHECK (extracted_json IS NULL OR json_valid(extracted_json)),
  -- What was read, kept as columns for pairing and matching. amount_paise: a UPI payment's amount or a bill's total.
  -- doc_at: the time printed on the screenshot or bill (ms), which can differ from sent_at.
  amount_paise   INTEGER CHECK (amount_paise IS NULL OR (typeof(amount_paise) = 'integer' AND amount_paise > 0)),
  utr            TEXT,
  bill_no        TEXT,
  doc_at         INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'duplicate')),
  duplicate_of   TEXT REFERENCES wa_items(id) ON DELETE SET NULL, -- the earlier item with the same UTR (or the same bill)
  -- The person's review (phase 4). paid_as: how a confirmed bill was paid (upi: with its paired UPI photo; cash: no photo,
  -- paid in cash). tip_paise: on a confirmed UPI photo that paid more than its bill, the extra kept as a tip.
  paid_as        TEXT CHECK (paid_as IS NULL OR paid_as IN ('upi', 'cash')),
  tip_paise      INTEGER CHECK (tip_paise IS NULL OR (typeof(tip_paise) = 'integer' AND tip_paise > 0)),
  reviewed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX wa_items_sha_key ON wa_items (business_id, content_sha256);
CREATE INDEX wa_items_inbox_idx ON wa_items (business_id, status, sent_at);
CREATE INDEX wa_items_group_idx ON wa_items (group_id, sent_at);
CREATE INDEX wa_items_reply_idx ON wa_items (reply_to_id);
CREATE INDEX wa_items_read_idx ON wa_items (read_status, sent_at);
CREATE INDEX wa_items_utr_idx ON wa_items (business_id, utr);

-- A UPI screenshot and the bill it pays (phase 3). One pair per item; confidence 0-100. reasons: JSON list of why,
-- e.g. ["reply","same amount"]. Bookr's own pairs (by_hand 0) are worked out again as files arrive; a person's are kept.
CREATE TABLE wa_pairs (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  upi_item_id  TEXT NOT NULL UNIQUE REFERENCES wa_items(id) ON DELETE CASCADE,
  bill_item_id TEXT NOT NULL UNIQUE REFERENCES wa_items(id) ON DELETE CASCADE,
  confidence   INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  reasons      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons)),
  by_hand      INTEGER NOT NULL DEFAULT 0 CHECK (by_hand IN (0, 1)),
  made_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  CHECK (upi_item_id <> bill_item_id)
);

-- A pair a person took apart: Bookr never makes it again.
CREATE TABLE wa_not_pairs (
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  upi_item_id  TEXT NOT NULL REFERENCES wa_items(id) ON DELETE CASCADE,
  bill_item_id TEXT NOT NULL REFERENCES wa_items(id) ON DELETE CASCADE,
  made_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (upi_item_id, bill_item_id)
);

-- The listener's last sign of life (one row). It serves every business, so it has no business_id.
CREATE TABLE wa_listener_status (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  last_heartbeat_at INTEGER,
  last_message_at   INTEGER,                                  -- ms, the newest message it has sent
  state             TEXT,                                     -- what the listener says: connected, waiting_for_qr, ...
  version           TEXT
);
INSERT INTO wa_listener_status (id) VALUES (1);

-- Groups the listener can see, sent with its heartbeat (phase 4), so a person can choose which to read on the group
-- setup screen without typing WhatsApp's group id. Like the status, not of any one business.
CREATE TABLE wa_seen_groups (
  wa_group_id  TEXT PRIMARY KEY CHECK (length(trim(wa_group_id)) > 0),
  name         TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL
);
