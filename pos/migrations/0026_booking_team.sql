-- Who does NOT need a POS receipt (24 Nov 2026, approved by the owner): the Djubo users of the booking team. Money anyone
-- else enters in Djubo (reception, a new person, a name typed differently) is taken as taken at the desk and needs a POS
-- receipt; OTA bookings ("System") never do. This replaces the list of reception users.
ALTER TABLE businesses ADD COLUMN no_receipt_users TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(no_receipt_users));
