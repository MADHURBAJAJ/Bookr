-- Bar stock (the "Next" tier, approved 14 Nov 2026), built so kitchen stock can use the same tables later.
-- Quantities are whole units of the item's own unit (ml, pcs or g). Every movement is a row that is never changed;
-- what is on hand in a store is the sum of its movements.
CREATE TABLE stock_stores (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind        TEXT NOT NULL CHECK (kind IN ('main', 'bar', 'kitchen')),   -- sales take from the store matching the menu item's station
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX stock_stores_name_key ON stock_stores (business_id, lower(name));

CREATE TABLE stock_items (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  unit            TEXT NOT NULL CHECK (unit IN ('ml', 'pcs', 'g')),
  pack_name       TEXT NOT NULL DEFAULT 'pack',     -- what it is bought in: bottle, case
  pack_size       INTEGER NOT NULL CHECK (pack_size > 0),   -- units in one pack (750 ml, 12 pcs)
  cost_per_pack_paise INTEGER NOT NULL DEFAULT 0 CHECK (cost_per_pack_paise >= 0),   -- last price paid
  reorder_level   INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),   -- in units, across all stores
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX stock_items_name_key ON stock_items (business_id, lower(name));

-- What one portion of a menu item uses (Whisky 30 ml → 30 ml of the whisky; Beer 650 ml → 1 pcs).
CREATE TABLE recipes (
  menu_item_id  TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  stock_item_id TEXT NOT NULL REFERENCES stock_items(id),
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (menu_item_id, stock_item_id)
);

CREATE TABLE stock_moves (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL REFERENCES stock_items(id),
  store_id        TEXT NOT NULL REFERENCES stock_stores(id),
  kind            TEXT NOT NULL CHECK (kind IN ('purchase', 'transfer_in', 'transfer_out', 'sale', 'waste', 'count')),
  qty             INTEGER NOT NULL CHECK (qty <> 0),     -- signed: into the store positive, out negative
  counted_qty     INTEGER,                               -- a count: what was found (qty is found minus book)
  cost_per_pack_paise INTEGER,                           -- a purchase: what was paid per pack
  ref             TEXT,                                  -- bill number, vendor invoice, transfer id
  vendor          TEXT,
  reason          TEXT,
  by_staff        TEXT REFERENCES staff(id) ON DELETE SET NULL,
  shift_day       TEXT NOT NULL,
  at              INTEGER NOT NULL,
  CHECK (kind <> 'count' OR counted_qty IS NOT NULL),
  CHECK (kind <> 'waste' OR reason IS NOT NULL)
);
CREATE INDEX stock_moves_item_idx ON stock_moves (business_id, item_id, store_id);
CREATE INDEX stock_moves_day_idx ON stock_moves (business_id, shift_day);
CREATE TRIGGER stock_moves_frozen
BEFORE UPDATE ON stock_moves
BEGIN
  SELECT RAISE(ABORT, 'stock_move_frozen');
END;
CREATE TRIGGER stock_moves_no_delete
BEFORE DELETE ON stock_moves
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'stock_move_frozen');
END;
