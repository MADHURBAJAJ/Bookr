-- Servers sign in with their mobile number and PIN (approved 28 Nov 2026): the mobile says who it is, so the invite can
-- go to their WhatsApp and PINs need not differ between servers. One active server per mobile. Servers added before keep
-- working once a mobile is given (Settings › Staff and PINs › Servers).
ALTER TABLE servers ADD COLUMN phone TEXT;
DROP INDEX IF EXISTS servers_pin_key;
CREATE UNIQUE INDEX servers_phone_key ON servers (business_id, phone) WHERE active = 1 AND phone IS NOT NULL;
