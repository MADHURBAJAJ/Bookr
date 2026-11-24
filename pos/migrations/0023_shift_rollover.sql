-- Shift close at the shift's hour (24 Nov 2026, approved by the owner): a shift nobody closed by hand is closed
-- automatically at the shift start hour (8 am), "not counted yet", and the drawer is counted later; a close by hand
-- starts the next shift at once. counted_at is when the drawer was counted (NULL: not counted yet); auto = 1 when
-- the close was made by the server.
ALTER TABLE shift_closes ADD COLUMN counted_at INTEGER;
ALTER TABLE shift_closes ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
UPDATE shift_closes SET counted_at = closed_at;
