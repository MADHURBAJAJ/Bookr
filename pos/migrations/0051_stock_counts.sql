-- Bar and kitchen counts with a manager's approval (approved by the owner 27 Nov 2026).
-- A stock item's category (Whisky, Beer, Cigarettes ...): count sheets list items by category.
ALTER TABLE stock_items ADD COLUMN category TEXT CHECK (category IS NULL OR length(category) <= 40);

-- Which items a count covers, saved in Settings (Stock › Count lists): whole categories, less items taken off, plus single items.
CREATE TABLE count_lists (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  store_id    TEXT NOT NULL REFERENCES stock_stores(id),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 40),
  categories  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(categories)),   -- categories on the list
  off_items   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(off_items)),    -- items of those categories taken off
  on_items    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(on_items)),     -- single items from other categories
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX count_lists_name_key ON count_lists (business_id, lower(name));

-- A count: typed from the paper after the shift (compared with the stock at the time it was counted), or live (each row
-- compared with the stock when it was typed). Stock changes only when a manager approves.
CREATE TABLE stock_counts (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  store_id    TEXT NOT NULL REFERENCES stock_stores(id),
  list_id     TEXT REFERENCES count_lists(id),
  mode        TEXT NOT NULL CHECK (mode IN ('after_shift', 'live')),
  counted_at  INTEGER,                         -- after shift: when it was counted
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'waiting', 'approved', 'sent_back', 'dropped')),
  by_staff    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  sent_at     INTEGER,
  decided_by  TEXT REFERENCES staff(id) ON DELETE SET NULL,
  decided_at  INTEGER,
  note        TEXT CHECK (note IS NULL OR length(note) <= 200),
  created_at  INTEGER NOT NULL
);
CREATE INDEX stock_counts_status_idx ON stock_counts (business_id, status);

-- One row per item counted: what was found at the bar counter and in a second place (the store), in units (ml, pcs, g).
CREATE TABLE stock_count_lines (
  count_id    TEXT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES stock_items(id),
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  place1      INTEGER NOT NULL DEFAULT 0 CHECK (place1 >= 0),
  place2      INTEGER NOT NULL DEFAULT 0 CHECK (place2 >= 0),
  at          INTEGER NOT NULL,                -- live: when this row was typed
  recount     INTEGER NOT NULL DEFAULT 0 CHECK (recount IN (0, 1)),   -- the manager asked for it to be counted again
  PRIMARY KEY (count_id, item_id)
);
