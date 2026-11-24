-- Bookings from mail, more of what the mails carry (23 Nov 2026, approved: "build 1 to 4"):
-- the OTA's own booking number and PNR, so a Djubo booking and its MakeMyTrip booking are matched exactly by number
-- (Djubo's "Vendor Booking Id" is MakeMyTrip's NH… number; Djubo's "Reference ID" is MakeMyTrip's PNR); Djubo's room
-- and bed numbers ("II B"), for check-in; the channel; and Djubo's "could not place this booking" alerts.
ALTER TABLE bookings ADD COLUMN ota_ref TEXT;              -- MakeMyTrip / Goibibo booking number (NH…, GH…)
ALTER TABLE bookings ADD COLUMN pnr TEXT;                  -- the OTA's PNR (Djubo's Reference ID)
ALTER TABLE bookings ADD COLUMN room_labels TEXT;          -- Djubo's room / bed numbers, comma-separated
ALTER TABLE bookings ADD COLUMN channel TEXT;              -- e.g. MAKE MY TRIP, Direct
ALTER TABLE bookings ADD COLUMN unplaced INTEGER NOT NULL DEFAULT 0 CHECK (unplaced IN (0, 1));   -- Djubo could not place it
CREATE INDEX bookings_pnr ON bookings (business_id, pnr) WHERE pnr IS NOT NULL;
CREATE INDEX bookings_ota_ref ON bookings (business_id, ota_ref) WHERE ota_ref IS NOT NULL;
