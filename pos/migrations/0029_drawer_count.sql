-- Counting the drawer at Day close can be turned off (26 Nov 2026, the owner's choice): with it off, Day close shows the
-- takings and what is pending and closes the day without a count, as the automatic close does. On (1) as before.
ALTER TABLE businesses ADD COLUMN drawer_count INTEGER NOT NULL DEFAULT 1 CHECK (drawer_count IN (0, 1));
