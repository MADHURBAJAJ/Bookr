-- Restaurant POS (approved 14 Nov 2026). A separate Worker with its own D1; it pushes settled bills and shift closes to Bookr.
-- Same rules as Bookr: ids are UUID text made by the Worker, money is integer paise, times are integer milliseconds (UTC),
-- days are 'YYYY-MM-DD' worked out in India time, and every business table carries business_id.
-- Nothing about one hotel is fixed here: billing names, GST rates, limits, shift start and reasons are settings per business.

CREATE TABLE businesses (
  id               TEXT PRIMARY KEY,             -- the same id as the business in Bookr
  name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
  fy_start_month   INTEGER NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  shift_start_hour INTEGER NOT NULL DEFAULT 8 CHECK (shift_start_hour BETWEEN 0 AND 23),
  tab_age_days     INTEGER NOT NULL DEFAULT 3 CHECK (tab_age_days BETWEEN 1 AND 60),
  created_at       INTEGER NOT NULL
);

-- People who use the POS. Owners and managers sign in with email and password (settings, reports);
-- counter staff sign in with a PIN, and only on a counter device an Owner has set up.
CREATE TABLE staff (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  role          TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'captain')),
  email         TEXT,
  password_hash TEXT,
  pin_hash      TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  CHECK (role NOT IN ('owner', 'manager') OR (email IS NOT NULL AND password_hash IS NOT NULL))
);
CREATE UNIQUE INDEX staff_email_key ON staff (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX staff_business_idx ON staff (business_id);

-- A counter device (the billing PC or tablet). Its cookie holds a token; only the token's hash is stored.
-- Wrong PINs are counted per device; too many lock PIN sign-in on it for a while.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  added_by      TEXT REFERENCES staff(id) ON DELETE SET NULL,
  pin_failures  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                 -- SHA-256 of the cookie token
  staff_id     TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  device_id    TEXT REFERENCES devices(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('password', 'pin')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_staff_idx ON sessions (staff_id);

-- The names bills go out in. Most businesses have one; a business may have several (a company and HUFs).
CREATE TABLE billing_entities (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind             TEXT NOT NULL CHECK (kind IN ('company', 'llp', 'partnership', 'proprietor', 'huf', 'other')),
  gst_registered   INTEGER NOT NULL CHECK (gst_registered IN (0, 1)),
  gstin            TEXT,
  gst_rate_bp      INTEGER NOT NULL DEFAULT 0 CHECK (gst_rate_bp BETWEEN 0 AND 2800),   -- 500 = 5%
  series_prefix    TEXT NOT NULL CHECK (series_prefix GLOB '[A-Z0-9]*' AND length(series_prefix) BETWEEN 1 AND 4),
  yearly_limit_paise INTEGER CHECK (yearly_limit_paise IS NULL OR yearly_limit_paise > 0),
  warn1_paise      INTEGER,
  warn2_paise      INTEGER,
  stop_paise       INTEGER,                     -- not offered once the year's bills reach this
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  offered          INTEGER NOT NULL DEFAULT 1 CHECK (offered IN (0, 1)),   -- shown at the counter (e.g. the HUF in use today)
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at       INTEGER NOT NULL,
  CHECK (gst_registered = 1 OR gst_rate_bp = 0),
  CHECK (gst_registered = 0 OR gstin IS NOT NULL)
);
CREATE UNIQUE INDEX billing_entities_prefix_key ON billing_entities (business_id, series_prefix);
CREATE UNIQUE INDEX billing_entities_default_key ON billing_entities (business_id) WHERE is_default = 1;

-- Running bill number per billing name and financial year ('2026-27'). Gapless: a number is taken in the same batch
-- that writes the bill, and a printed bill is never deleted (a mistake is voided, keeping its number).
CREATE TABLE bill_series (
  entity_id  TEXT NOT NULL REFERENCES billing_entities(id) ON DELETE CASCADE,
  fy         TEXT NOT NULL,
  next_no    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, fy)
);

-- Where UPI money goes: each QR's bank account and the billing name it belongs to.
CREATE TABLE pay_accounts (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
  entity_id        TEXT NOT NULL REFERENCES billing_entities(id),
  bookr_account_id TEXT,                         -- the account in Bookr, so its matching knows where to look
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at       INTEGER NOT NULL
);

CREATE TABLE menu_items (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  category    TEXT NOT NULL DEFAULT 'Other',
  price_paise INTEGER NOT NULL CHECK (typeof(price_paise) = 'integer' AND price_paise >= 0),
  sac         TEXT NOT NULL DEFAULT '996332',
  station     TEXT NOT NULL DEFAULT 'kitchen' CHECK (station IN ('kitchen', 'bar')),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  INTEGER NOT NULL
);
CREATE INDEX menu_items_business_idx ON menu_items (business_id, category);

-- Reason lists the business chooses. A discount, a complimentary bill, a void and a cancelled KOT line each need one.
CREATE TABLE reasons (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('discount', 'comp', 'void', 'kot_cancel')),
  label       TEXT NOT NULL CHECK (length(trim(label)) > 0),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX reasons_key ON reasons (business_id, kind, lower(label));

-- In-house stays (no PMS link): staff open one at check-in and post food to it.
CREATE TABLE stays (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  room        TEXT NOT NULL CHECK (length(trim(room)) > 0),
  guest_name  TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
  check_in    TEXT NOT NULL CHECK (check_in GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  checked_out_at INTEGER,
  opened_by   TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX stays_open_room_key ON stays (business_id, lower(room)) WHERE checked_out_at IS NULL;

-- Who owes: a room folio (one per stay), a credit account (company, staff, guest).
CREATE TABLE debtor_accounts (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('room', 'credit')),
  name               TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone              TEXT,
  stay_id            TEXT UNIQUE REFERENCES stays(id),
  credit_limit_paise INTEGER CHECK (credit_limit_paise IS NULL OR credit_limit_paise > 0),
  created_by         TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  CHECK ((kind = 'room') = (stay_id IS NOT NULL))
);

CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('table', 'room', 'takeaway')),
  place            TEXT NOT NULL CHECK (length(trim(place)) > 0),   -- table name, room, or 'Takeaway'
  stay_id          TEXT REFERENCES stays(id),
  guest_name       TEXT,
  covers           INTEGER,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'tab', 'billed', 'closed', 'cancelled')),
  opened_by        TEXT REFERENCES staff(id) ON DELETE SET NULL,
  opened_at        INTEGER NOT NULL,
  opened_shift_day TEXT NOT NULL,
  CHECK (status <> 'tab' OR guest_name IS NOT NULL)
);
CREATE INDEX orders_status_idx ON orders (business_id, status);

CREATE TABLE order_lines (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES menu_items(id),
  name        TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  sac         TEXT NOT NULL,
  station     TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty >= 0),
  sent_qty    INTEGER NOT NULL DEFAULT 0 CHECK (sent_qty >= 0 AND sent_qty <= qty),
  created_at  INTEGER NOT NULL,
  UNIQUE (order_id, item_id)
);

CREATE TABLE kots (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kot_no      INTEGER NOT NULL,
  station     TEXT NOT NULL,
  lines       TEXT NOT NULL CHECK (json_valid(lines)),   -- [{name, qty}] as printed
  by_staff    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  printed_at  INTEGER NOT NULL,
  UNIQUE (business_id, kot_no)
);

CREATE TABLE bills (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id          TEXT NOT NULL REFERENCES orders(id),
  entity_id         TEXT NOT NULL REFERENCES billing_entities(id),
  fy                TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  bill_no           TEXT NOT NULL CHECK (length(bill_no) <= 16),
  shift_day         TEXT NOT NULL,
  printed_at        INTEGER NOT NULL,
  printed_by        TEXT REFERENCES staff(id) ON DELETE SET NULL,
  gross_paise       INTEGER NOT NULL,
  discount_paise    INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  discount_reason   TEXT,
  taxable_paise     INTEGER NOT NULL,
  gst_rate_bp       INTEGER NOT NULL,
  cgst_paise        INTEGER NOT NULL,
  sgst_paise        INTEGER NOT NULL,
  round_off_paise   INTEGER NOT NULL,
  total_paise       INTEGER NOT NULL CHECK (total_paise >= 0),
  guest_name        TEXT,
  status            TEXT NOT NULL DEFAULT 'printed' CHECK (status IN ('printed', 'settled', 'void')),
  print_count       INTEGER NOT NULL DEFAULT 1,
  settlement_id     TEXT,
  settled_at        INTEGER,
  void_reason       TEXT,
  void_by           TEXT REFERENCES staff(id) ON DELETE SET NULL,
  void_at           INTEGER,
  CHECK (discount_paise = 0 OR discount_reason IS NOT NULL),
  CHECK ((status = 'void') = (void_reason IS NOT NULL)),
  UNIQUE (entity_id, fy, seq),
  UNIQUE (business_id, bill_no)
);
CREATE INDEX bills_shift_idx ON bills (business_id, shift_day);
CREATE INDEX bills_entity_fy_idx ON bills (entity_id, fy, status);

-- A printed bill's money and number never change; a mistake is voided (with a reason) and a new bill printed.
CREATE TRIGGER bills_frozen
BEFORE UPDATE ON bills
WHEN NEW.bill_no IS NOT OLD.bill_no OR NEW.entity_id IS NOT OLD.entity_id OR NEW.seq IS NOT OLD.seq OR NEW.fy IS NOT OLD.fy
  OR NEW.gross_paise IS NOT OLD.gross_paise OR NEW.discount_paise IS NOT OLD.discount_paise OR NEW.taxable_paise IS NOT OLD.taxable_paise
  OR NEW.cgst_paise IS NOT OLD.cgst_paise OR NEW.sgst_paise IS NOT OLD.sgst_paise OR NEW.round_off_paise IS NOT OLD.round_off_paise
  OR NEW.total_paise IS NOT OLD.total_paise OR NEW.order_id IS NOT OLD.order_id OR NEW.printed_at IS NOT OLD.printed_at
  OR (OLD.status <> 'printed' AND NEW.status IS NOT OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;
CREATE TRIGGER bills_no_delete
BEFORE DELETE ON bills
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;

CREATE TABLE bill_lines (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bill_id      TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  item_id      TEXT,
  name         TEXT NOT NULL,
  sac          TEXT NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  rate_paise   INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL
);
CREATE INDEX bill_lines_bill_idx ON bill_lines (bill_id);
CREATE TRIGGER bill_lines_frozen BEFORE UPDATE ON bill_lines
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;
CREATE TRIGGER bill_lines_no_delete
BEFORE DELETE ON bill_lines
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'bill_frozen');
END;

-- One settle: the payments that paid one or more bills (bills paid together), or a debtor receipt with no bill.
CREATE TABLE settlements (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('bills', 'receipt')),
  shift_day   TEXT NOT NULL,
  by_staff    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at          INTEGER NOT NULL
);

-- One tender. Each carries what matches it later in Bookr: the UPI account, the card slip's approval code and last 4,
-- the folio or credit account, or the complimentary guest and reason.
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  settlement_id     TEXT NOT NULL REFERENCES settlements(id),
  mode              TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'room', 'credit', 'comp', 'advance')),
  amount_paise      INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  tendered_paise    INTEGER,                    -- cash handed over; change = tendered - amount
  pay_account_id    TEXT REFERENCES pay_accounts(id),
  card_approval     TEXT,
  card_last4        TEXT,
  debtor_account_id TEXT REFERENCES debtor_accounts(id),
  comp_guest        TEXT,
  comp_reason       TEXT,
  shift_day         TEXT NOT NULL,
  by_staff          TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at                INTEGER NOT NULL,
  CHECK (mode <> 'upi' OR pay_account_id IS NOT NULL),
  CHECK (mode <> 'card' OR (card_approval IS NOT NULL AND card_last4 IS NOT NULL)),
  CHECK (mode NOT IN ('room', 'credit', 'advance') OR debtor_account_id IS NOT NULL),
  CHECK (mode <> 'comp' OR (comp_guest IS NOT NULL AND comp_reason IS NOT NULL)),
  CHECK (tendered_paise IS NULL OR (mode = 'cash' AND tendered_paise >= amount_paise))
);
CREATE INDEX payments_shift_idx ON payments (business_id, shift_day);
CREATE TRIGGER payments_frozen BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payment_frozen');
END;

-- How each payment is shared over the bills it paid (bills paid together, or one bill paid several ways).
CREATE TABLE allocations (
  payment_id   TEXT NOT NULL REFERENCES payments(id),
  bill_id      TEXT NOT NULL REFERENCES bills(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  PRIMARY KEY (payment_id, bill_id)
);
CREATE INDEX allocations_bill_idx ON allocations (bill_id);

-- The debtor ledger. Positive = owed to the business (a charge); negative = paid or paid in advance.
CREATE TABLE debtor_entries (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES debtor_accounts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('charge', 'receipt', 'advance', 'advance_used')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  bill_id      TEXT REFERENCES bills(id),
  payment_id   TEXT REFERENCES payments(id),
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX debtor_entries_account_idx ON debtor_entries (account_id);
CREATE TRIGGER debtor_entries_frozen BEFORE UPDATE ON debtor_entries
BEGIN
  SELECT RAISE(ABORT, 'entry_frozen');
END;

CREATE TABLE shift_closes (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day         TEXT NOT NULL,
  opening_float_paise INTEGER NOT NULL,
  counted           TEXT NOT NULL CHECK (json_valid(counted)),   -- {"500": 14, "200": 9, "other_paise": 21000}
  counted_paise     INTEGER NOT NULL,
  expected_paise    INTEGER NOT NULL,
  difference_paise  INTEGER NOT NULL,
  difference_reason TEXT,
  totals            TEXT NOT NULL CHECK (json_valid(totals)),
  closed_by         TEXT REFERENCES staff(id) ON DELETE SET NULL,
  closed_at         INTEGER NOT NULL,
  UNIQUE (business_id, shift_day),
  CHECK (difference_paise = 0 OR difference_reason IS NOT NULL)
);

-- No payment lands in a closed shift.
CREATE TRIGGER payments_shift_closed
BEFORE INSERT ON payments
WHEN EXISTS (SELECT 1 FROM shift_closes WHERE business_id = NEW.business_id AND shift_day = NEW.shift_day)
BEGIN
  SELECT RAISE(ABORT, 'shift_closed');
END;

-- The exceptions report: voids, reprints, cancelled KOT lines, discounts, complimentary bills. Rows are only added.
CREATE TABLE pos_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('void', 'reprint', 'kot_cancel', 'discount', 'comp', 'limit_warning')),
  ref          TEXT NOT NULL,                  -- bill number or KOT line
  amount_paise INTEGER,
  reason       TEXT,
  detail       TEXT,
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  shift_day    TEXT NOT NULL,
  at           INTEGER NOT NULL
);
CREATE INDEX pos_events_shift_idx ON pos_events (business_id, shift_day);
CREATE TRIGGER pos_events_frozen BEFORE UPDATE ON pos_events
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;
CREATE TRIGGER pos_events_no_delete
BEFORE DELETE ON pos_events
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;

-- Who changed a setting: before and after, as in Bookr's audit_log. Rows are only added.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id    TEXT REFERENCES staff(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  row_table   TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  before      TEXT CHECK (before IS NULL OR json_valid(before)),
  after       TEXT CHECK (after IS NULL OR json_valid(after)),
  created_at  INTEGER NOT NULL
);
CREATE INDEX audit_log_business_idx ON audit_log (business_id, created_at DESC);

-- Messages waiting to be sent to Bookr: one per settled bill, debtor receipt, void and shift close.
-- Each carries its own id, so Bookr ignores a message sent twice.
CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('bill_settled', 'bill_void', 'receipt', 'shift_closed')),
  body        TEXT NOT NULL CHECK (json_valid(body)),
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
CREATE INDEX outbox_pending_idx ON outbox (business_id, sent_at);
