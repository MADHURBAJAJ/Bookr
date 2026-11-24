-- The restaurant's own list of tables, in the order the counter shows them, as a JSON array of names
-- (e.g. ["T1","T2","Lawn 1"]). NULL: the counter shows the tables used in the last 60 days instead.
ALTER TABLE businesses ADD COLUMN tables TEXT;
