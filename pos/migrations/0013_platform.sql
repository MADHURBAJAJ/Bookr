-- Bookr POS as a product (approved 19 Nov 2026): restaurants are added by a Bookr POS admin, and each owner sees only
-- the restaurants the admin gives them.
--
-- A person who signs in with an email is a login (login_id). One email belongs to one login; only an admin gives a login
-- a place at a second restaurant (a staff row there with the same login_id). Staff rows that restaurants add get a login
-- of their own, and an email already used by another login is refused, so no one can reach another restaurant by
-- reusing someone's email.
DROP INDEX staff_email_key;
ALTER TABLE staff ADD COLUMN login_id TEXT;
UPDATE staff SET login_id = id WHERE email IS NOT NULL;
CREATE UNIQUE INDEX staff_login_business_key ON staff (business_id, login_id) WHERE login_id IS NOT NULL;
CREATE INDEX staff_email_idx ON staff (lower(email)) WHERE email IS NOT NULL;
-- The Bookr POS support person's place at a restaurant, used only while the owner has support access on.
ALTER TABLE staff ADD COLUMN support INTEGER NOT NULL DEFAULT 0 CHECK (support IN (0, 1));

-- A paused restaurant keeps its data; nobody signs in or bills there until it is resumed.
ALTER TABLE businesses ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused'));
-- Whether the owner lets Bookr POS support open the restaurant to help (off unless the owner turns it on).
ALTER TABLE businesses ADD COLUMN support_access INTEGER NOT NULL DEFAULT 0 CHECK (support_access IN (0, 1));

-- Bookr POS admins: above restaurants, with their own sign-in. They add and pause restaurants and give owners access;
-- they see no bills, menus or sales.
CREATE TABLE platform_admins (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX platform_admins_email_key ON platform_admins (lower(email));
CREATE TABLE admin_sessions (
  id         TEXT PRIMARY KEY,                -- SHA-256 of the cookie token
  admin_id   TEXT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
