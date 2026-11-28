-- The Bar Count app (mock and data model approved by the owner 28 Nov 2026). Bar staff count on their own phones, at
-- /count/<business id>, signing in with the same mobile number and 6-digit PIN as the Serve app.

-- 1. People on phones (the servers table) get tick boxes: which phone apps they may use, and whether they may approve
-- counts. Only the Owner ticks them. Everyone added before keeps Serve, as now.
--   serve: the Serve app · bar_count: count bar and main-store lists · kitchen_count: count kitchen and main-store lists
--   approve_counts: approve a count, or send rows back, on the phone
ALTER TABLE servers ADD COLUMN access TEXT NOT NULL DEFAULT '["serve"]' CHECK (json_valid(access));

-- 2. Staff (the PC sign-in): Approve counts as a tick box. The Owner always may; managers start ticked (the owner can
-- untick them); anyone else only if the Owner ticks them.
ALTER TABLE staff ADD COLUMN count_approve INTEGER NOT NULL DEFAULT 0 CHECK (count_approve IN (0, 1));
UPDATE staff SET count_approve = 1 WHERE role IN ('owner', 'manager');

-- 3. A count made or approved on a phone says which person did it (by_staff and decided_by stay for the PC).
ALTER TABLE stock_counts ADD COLUMN by_server TEXT REFERENCES servers(id) ON DELETE SET NULL;
ALTER TABLE stock_counts ADD COLUMN decided_by_server TEXT REFERENCES servers(id) ON DELETE SET NULL;
