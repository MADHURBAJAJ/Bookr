-- Cashiers sign in with their mobile number (approved 21 Nov 2026).
-- A person may have a mobile number to sign in with; one number per person. It is kept as +91 and ten digits
-- (checked in parts: D1 refuses a GLOB pattern as long as the whole number).
-- A person who joins by phone has no email: their users.email holds a stand-in, <digits>@phone.bookr.invalid,
-- never shown, so the existing NOT NULL and unique rules on email stay as they are.
-- An invite may be for a mobile number (its email then holds the same stand-in) and for a cash book: accepting it
-- makes the person that book's cashier. No existing row changes.

ALTER TABLE users ADD COLUMN phone TEXT;
CREATE UNIQUE INDEX users_phone_key ON users (phone) WHERE phone IS NOT NULL;

CREATE TRIGGER users_phone_insert
BEFORE INSERT ON users
WHEN NEW.phone IS NOT NULL AND NOT (length(NEW.phone) = 13 AND substr(NEW.phone, 1, 3) = '+91' AND substr(NEW.phone, 4, 1) BETWEEN '6' AND '9' AND substr(NEW.phone, 4) NOT GLOB '*[^0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'phone_format');
END;

CREATE TRIGGER users_phone_update
BEFORE UPDATE OF phone ON users
WHEN NEW.phone IS NOT NULL AND NOT (length(NEW.phone) = 13 AND substr(NEW.phone, 1, 3) = '+91' AND substr(NEW.phone, 4, 1) BETWEEN '6' AND '9' AND substr(NEW.phone, 4) NOT GLOB '*[^0-9]*')
BEGIN
  SELECT RAISE(ABORT, 'phone_format');
END;

ALTER TABLE invites ADD COLUMN phone TEXT;
ALTER TABLE invites ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;

CREATE TRIGGER invites_phone_account
BEFORE INSERT ON invites
WHEN (NEW.phone IS NOT NULL AND NOT (length(NEW.phone) = 13 AND substr(NEW.phone, 1, 3) = '+91' AND substr(NEW.phone, 4, 1) BETWEEN '6' AND '9' AND substr(NEW.phone, 4) NOT GLOB '*[^0-9]*'))
  OR (NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a
    WHERE a.id = NEW.account_id AND a.business_id = NEW.business_id AND a.kind = 'cash'))
BEGIN
  SELECT RAISE(ABORT, 'invite_phone_or_book');
END;
