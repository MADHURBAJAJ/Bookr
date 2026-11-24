-- Menu v2 (approved 19 Nov 2026): GST at three levels, price at billing, and add-ons.
--
-- GST: an item's tax comes from the item if it says, else from its category, else from the billing name on the bill.
-- tax_mode: 'billing' = the billing name's rate; 'rate' = gst_bp on the item or category; 'liquor' = outside GST (Table 8,
-- non-GST supply); 'none' = no GST (Table 8, exempt). A billing name not registered for GST charges no GST on anything.
CREATE TABLE menu_categories (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  tax_mode    TEXT NOT NULL DEFAULT 'billing' CHECK (tax_mode IN ('billing', 'rate', 'liquor', 'none')),
  gst_bp      INTEGER CHECK (gst_bp IS NULL OR gst_bp BETWEEN 0 AND 4000),
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  CHECK ((tax_mode = 'rate') = (gst_bp IS NOT NULL))
);
CREATE UNIQUE INDEX menu_categories_name_key ON menu_categories (business_id, lower(name));
-- Every category already on the menu, taking its tax from the billing name, as today.
INSERT INTO menu_categories (id, business_id, name, created_at)
  SELECT lower(hex(randomblob(16))), business_id, category, min(created_at) FROM menu_items GROUP BY business_id, lower(category);

-- The item's own tax (NULL: from its category). Liquor marked under 0008 keeps being liquor.
ALTER TABLE menu_items ADD COLUMN tax_mode TEXT CHECK (tax_mode IS NULL OR tax_mode IN ('billing', 'rate', 'liquor', 'none'));
ALTER TABLE menu_items ADD COLUMN gst_bp INTEGER CHECK (gst_bp IS NULL OR gst_bp BETWEEN 0 AND 4000);
UPDATE menu_items SET tax_mode = 'liquor' WHERE tax = 'none';
-- Price at billing: the price is typed when the item is added (bottles, seafood, catering), never below the lowest price.
ALTER TABLE menu_items ADD COLUMN open_price INTEGER NOT NULL DEFAULT 0 CHECK (open_price IN (0, 1));
ALTER TABLE menu_items ADD COLUMN min_price_paise INTEGER CHECK (min_price_paise IS NULL OR min_price_paise >= 0);

-- Add-ons: a group is "choose one" (Half / Full) or "add any" (Peri Peri Fries, Extra Cheese); a dish offers some groups.
CREATE TABLE addon_groups (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind        TEXT NOT NULL CHECK (kind IN ('one', 'any')),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX addon_groups_name_key ON addon_groups (business_id, lower(name));
CREATE TABLE addon_options (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  group_id    TEXT NOT NULL REFERENCES addon_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  add_paise   INTEGER NOT NULL CHECK (add_paise >= 0),
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX addon_options_group_idx ON addon_options (group_id);
CREATE TABLE menu_item_addons (
  item_id     TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id    TEXT NOT NULL REFERENCES addon_groups(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sort        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

-- An order can now hold the same dish twice with different add-ons or typed prices: one line per (dish, variant).
-- variant = the chosen options and typed price, as a key; options = what was chosen, as shown on the KOT and bill;
-- price_by = who typed the price, for a price-at-billing item.
CREATE TABLE order_lines_v2 (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES menu_items(id),
  name        TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  sac         TEXT NOT NULL,
  station     TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty >= 0),
  sent_qty    INTEGER NOT NULL DEFAULT 0 CHECK (sent_qty >= 0 AND sent_qty <= qty),
  created_at  INTEGER NOT NULL,
  variant     TEXT NOT NULL DEFAULT '',
  options     TEXT CHECK (options IS NULL OR json_valid(options)),
  price_by    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  UNIQUE (order_id, item_id, variant)
);
INSERT INTO order_lines_v2 (id, business_id, order_id, item_id, name, price_paise, sac, station, qty, sent_qty, created_at)
  SELECT id, business_id, order_id, item_id, name, price_paise, sac, station, qty, sent_qty, created_at FROM order_lines;
DROP TABLE order_lines;
ALTER TABLE order_lines_v2 RENAME TO order_lines;
CREATE INDEX order_lines_order_idx ON order_lines (order_id);

-- A bill line keeps what was chosen, its tax and, for a typed price, who typed it. Old lines: tax_kind NULL means taxed
-- (or liquor where taxed = 0) at the bill's own rate.
ALTER TABLE bill_lines ADD COLUMN options TEXT CHECK (options IS NULL OR json_valid(options));
ALTER TABLE bill_lines ADD COLUMN tax_kind TEXT CHECK (tax_kind IS NULL OR tax_kind IN ('gst', 'liquor', 'exempt'));
ALTER TABLE bill_lines ADD COLUMN gst_bp INTEGER;
ALTER TABLE bill_lines ADD COLUMN price_by TEXT REFERENCES staff(id) ON DELETE SET NULL;

-- Tax on a bill or credit note, one row per kind and rate (food at 5%, room at 5%, a service at 18%, liquor, exempt).
-- The bill's own taxable, CGST, SGST and non-GST columns are the sums of these. Never changed once written.
CREATE TABLE bill_taxes (
  bill_id       TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('gst', 'liquor', 'exempt')),
  gst_bp        INTEGER NOT NULL DEFAULT 0,
  value_paise   INTEGER NOT NULL,
  cgst_paise    INTEGER NOT NULL DEFAULT 0,
  sgst_paise    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bill_id, kind, gst_bp)
);
CREATE TRIGGER bill_taxes_frozen
BEFORE UPDATE ON bill_taxes
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;
CREATE TRIGGER bill_taxes_no_delete
BEFORE DELETE ON bill_taxes
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;
CREATE TABLE credit_note_taxes (
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('gst', 'liquor', 'exempt')),
  gst_bp         INTEGER NOT NULL DEFAULT 0,
  value_paise    INTEGER NOT NULL,
  cgst_paise     INTEGER NOT NULL DEFAULT 0,
  sgst_paise     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (credit_note_id, kind, gst_bp)
);
CREATE TRIGGER credit_note_taxes_frozen
BEFORE UPDATE ON credit_note_taxes
BEGIN
  SELECT RAISE(ABORT, 'credit_note_frozen');
END;
