-- KOT stations (approved 19 Nov 2026). A business sets up its own stations (Kitchen, Tandoor, Bar, Chinese…), each getting
-- its KOTs on paper, on a screen, or both, at a device signed in as that station. Each category says whether its items make
-- a KOT and which station they go to; an item may say otherwise (like GST). menu_items.station ('kitchen' or 'bar') stays:
-- it is kept in step with the item's station (a bar station → 'bar') and still picks the store stock is taken from.
CREATE TABLE stations (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  how         TEXT NOT NULL DEFAULT 'paper' CHECK (how IN ('paper', 'screen', 'both')),
  copies      INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 3),
  is_bar      INTEGER NOT NULL DEFAULT 0 CHECK (is_bar IN (0, 1)),
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX stations_name_key ON stations (business_id, lower(name));
-- Today's two stations, for every business.
INSERT INTO stations (id, business_id, name, is_bar, sort, created_at) SELECT lower(hex(randomblob(16))), id, 'Kitchen', 0, 0, created_at FROM businesses;
INSERT INTO stations (id, business_id, name, is_bar, sort, created_at) SELECT lower(hex(randomblob(16))), id, 'Bar', 1, 1, created_at FROM businesses;

-- KOT per category (1: print, 0: no KOT) and its station; per item, NULL means "from its category".
ALTER TABLE menu_categories ADD COLUMN kot INTEGER NOT NULL DEFAULT 1 CHECK (kot IN (0, 1));
ALTER TABLE menu_categories ADD COLUMN station_id TEXT REFERENCES stations(id);
ALTER TABLE menu_items ADD COLUMN kot INTEGER CHECK (kot IS NULL OR kot IN (0, 1));
ALTER TABLE menu_items ADD COLUMN station_id TEXT REFERENCES stations(id);
-- A category goes to the station most of its items went to; an item that went elsewhere keeps that as its own.
UPDATE menu_categories SET station_id = (
  SELECT s.id FROM stations s WHERE s.business_id = menu_categories.business_id AND s.is_bar = (
    SELECT CASE WHEN sum(mi.station = 'bar') * 2 > count(*) THEN 1 ELSE 0 END FROM menu_items mi
    WHERE mi.business_id = menu_categories.business_id AND lower(mi.category) = lower(menu_categories.name)));
UPDATE menu_categories SET station_id = (SELECT s.id FROM stations s WHERE s.business_id = menu_categories.business_id AND s.is_bar = 0)
  WHERE station_id IS NULL;
UPDATE menu_items SET station_id = (SELECT s.id FROM stations s WHERE s.business_id = menu_items.business_id AND s.is_bar = (menu_items.station = 'bar'))
  WHERE (menu_items.station = 'bar') <> (SELECT s.is_bar FROM menu_categories c JOIN stations s ON s.id = c.station_id
    WHERE c.business_id = menu_items.business_id AND lower(c.name) = lower(menu_items.category));

-- An order line keeps the station it goes to and whether it makes a KOT (a no-KOT line counts as sent at once).
ALTER TABLE order_lines ADD COLUMN station_id TEXT REFERENCES stations(id);
ALTER TABLE order_lines ADD COLUMN kot INTEGER NOT NULL DEFAULT 1 CHECK (kot IN (0, 1));
UPDATE order_lines SET station_id = (SELECT s.id FROM stations s WHERE s.business_id = order_lines.business_id AND s.is_bar = (order_lines.station = 'bar'));

-- A KOT's station and delivery: printed at the station's device, at the counter (station offline), or only shown on a
-- screen; for a screen, whether the station has started it and when it was ready.
ALTER TABLE kots ADD COLUMN station_id TEXT REFERENCES stations(id);
ALTER TABLE kots ADD COLUMN print_at TEXT NOT NULL DEFAULT 'counter' CHECK (print_at IN ('counter', 'station', 'none'));
ALTER TABLE kots ADD COLUMN station_printed_at INTEGER;
ALTER TABLE kots ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('new', 'started', 'ready'));
ALTER TABLE kots ADD COLUMN started_at INTEGER;
ALTER TABLE kots ADD COLUMN ready_at INTEGER;
CREATE INDEX kots_station_idx ON kots (station_id, status);

-- A device can be a station's device: it shows and prints that station's KOTs, and nothing else.
ALTER TABLE devices ADD COLUMN station_id TEXT REFERENCES stations(id);
ALTER TABLE devices ADD COLUMN last_seen_at INTEGER;
-- KOTs already sent: their station, by the name the report shows ('kitchen' → Kitchen, 'bar' → Bar).
UPDATE kots SET station_id = (SELECT s.id FROM stations s WHERE s.business_id = kots.business_id AND s.is_bar = (kots.station = 'bar'));
UPDATE kots SET station = (SELECT s.name FROM stations s WHERE s.id = kots.station_id) WHERE station_id IS NOT NULL;
