-- One check-in for a booking of several rooms or beds (24 Nov 2026). The first room's stay holds the booking, the rent and
-- the one bill; each other room or bed is its own stay, so it shows taken, and points to the first one here. Food charged
-- to any of them goes on the first room's bill; checking out the first room checks out the group.
ALTER TABLE stays ADD COLUMN group_stay_id TEXT REFERENCES stays(id);
CREATE INDEX stays_group ON stays (group_stay_id) WHERE group_stay_id IS NOT NULL;
