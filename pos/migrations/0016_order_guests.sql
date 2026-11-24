-- A guest's name and phone on any order (22 Nov 2026), optional: typed by staff, found by phone in the guest list, or
-- taken from the stay of the room or bed. The phone is copied to the bill when it is printed (never printed on it).
ALTER TABLE orders ADD COLUMN guest_phone TEXT CHECK (guest_phone IS NULL OR (guest_phone GLOB '[0-9]*' AND length(guest_phone) BETWEEN 6 AND 15));
ALTER TABLE orders ADD COLUMN guest_id TEXT REFERENCES guests(id);
ALTER TABLE bills ADD COLUMN guest_phone TEXT;
CREATE INDEX orders_guest_idx ON orders (guest_id) WHERE guest_id IS NOT NULL;
