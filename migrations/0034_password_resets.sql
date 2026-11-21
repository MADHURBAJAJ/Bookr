-- Password reset links (approved 21 Nov 2026). There is no SMS or email, so a person who forgot their password asks
-- the Owner: the Owner makes a link (sent on WhatsApp or copied) for an Accountant, Entry staff or Viewer of their
-- business. The link works once, for 24 hours; setting a new password signs the person out everywhere.
-- Only the link's hash is kept. A newer link for the same person replaces the older one (used_at stays NULL,
-- revoked_at is set). No existing row changes.

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- A link works once: a second use in a race is refused here.
CREATE TRIGGER password_resets_use_once
BEFORE UPDATE OF used_at ON password_resets
WHEN OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL OR NEW.used_at > OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'reset_unusable');
END;
