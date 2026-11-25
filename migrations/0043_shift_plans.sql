-- One list of what a person chose on Reconcile before saving (approved 25 Nov 2026). Until now these lived in three
-- places: shift_choices (a credit or a card payment pays these bills), the audit log (credits ticked for a bill or a
-- group paid in parts, a booked credit that is the same sale as a bill, a card advance for a bill), each with its own
-- checks. Now each choice is one plan, and the credits or card payments it holds are its items: a credit or a card
-- payment can be held by one plan only, of any kind. Saving the shift applies its plans and removes them all; Undo
-- before saving removes one. The audit log keeps the history as before.
--
-- kind: bank_match   a credit pays these bills' UPI sales            items: one credit
--       card_match   a card machine payment pays these bills          items: one card payment
--       bill_parts   a bill paid in several goes, its credits ticked  items: two to six credits
--       group_parts  bills paid together in parts, Match all          items: the credits; head_row_id: the group
--       same_sale    a credit already booked is this bill's sale       items: one (booked) credit
--       card_advance a card advance pays this bill's card sale         items: one card payment
-- comparison_ids: the bills (their comparisons), or the sale ids of an earlier saved shift's bills paid here.
PRAGMA defer_foreign_keys = true;

CREATE TABLE shift_plans (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day      TEXT NOT NULL CHECK (shift_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind           TEXT NOT NULL CHECK (kind IN ('bank_match', 'card_match', 'bill_parts', 'group_parts', 'same_sale', 'card_advance')),
  comparison_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(comparison_ids)),
  head_row_id    TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX shift_plans_day_idx ON shift_plans (business_id, shift_day);

CREATE TABLE shift_plan_items (
  plan_id         TEXT NOT NULL REFERENCES shift_plans(id) ON DELETE CASCADE,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_row_id     TEXT REFERENCES bank_rows(id) ON DELETE CASCADE,
  card_payment_id TEXT REFERENCES card_settlements(id) ON DELETE CASCADE,
  CHECK ((bank_row_id IS NULL) <> (card_payment_id IS NULL)),
  UNIQUE (business_id, bank_row_id),
  UNIQUE (business_id, card_payment_id)
);
CREATE INDEX shift_plan_items_plan_idx ON shift_plan_items (plan_id);

-- What is already chosen on shifts not saved yet moves here. The first choice for a credit stands.
INSERT INTO shift_plans (id, business_id, shift_day, kind, comparison_ids, head_row_id, created_by, created_at)
  SELECT k.id, k.business_id, k.shift_day, k.kind, k.comparison_ids, NULL, k.created_by, k.created_at FROM shift_choices k;
INSERT OR IGNORE INTO shift_plan_items (plan_id, business_id, bank_row_id, card_payment_id)
  SELECT k.id, k.business_id, k.bank_row_id, k.card_payment_id FROM shift_choices k ORDER BY k.created_at;

-- Credits ticked for a bill paid in several goes (not undone).
INSERT INTO shift_plans (id, business_id, shift_day, kind, comparison_ids, head_row_id, created_by, created_at)
  SELECT 'bp-' || a.id, a.business_id, json_extract(a.after, '$.shiftDay'), 'bill_parts', json_array(a.row_id), NULL, a.user_id, a.created_at
  FROM audit_log a JOIN shifts s ON s.business_id = a.business_id AND s.shift_day = json_extract(a.after, '$.shiftDay') AND s.status <> 'confirmed'
  WHERE a.action = 'bank.bill_parts'
    AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.business_id = a.business_id AND x.action = 'bank.bill_parts_undone' AND x.row_id = CAST(a.id AS TEXT));
INSERT OR IGNORE INTO shift_plan_items (plan_id, business_id, bank_row_id)
  SELECT 'bp-' || a.id, a.business_id, j.value FROM audit_log a, json_each(json_extract(a.after, '$.creditIds')) j
  WHERE a.action = 'bank.bill_parts' AND EXISTS (SELECT 1 FROM shift_plans p WHERE p.id = 'bp-' || a.id)
    AND EXISTS (SELECT 1 FROM bank_rows r WHERE r.id = j.value) ORDER BY a.id;

-- Match all on a group paid in parts (not undone).
INSERT INTO shift_plans (id, business_id, shift_day, kind, comparison_ids, head_row_id, created_by, created_at)
  SELECT 'gp-' || a.id, a.business_id, json_extract(a.after, '$.shiftDay'), 'group_parts', '[]', a.row_id, a.user_id, a.created_at
  FROM audit_log a JOIN shifts s ON s.business_id = a.business_id AND s.shift_day = json_extract(a.after, '$.shiftDay') AND s.status <> 'confirmed'
  WHERE a.action = 'bank.group_parts'
    AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.business_id = a.business_id AND x.action = 'bank.group_parts_undone' AND x.row_id = CAST(a.id AS TEXT));
INSERT OR IGNORE INTO shift_plan_items (plan_id, business_id, bank_row_id)
  SELECT 'gp-' || a.id, a.business_id, j.value FROM audit_log a, json_each(json_extract(a.after, '$.creditIds')) j
  WHERE a.action = 'bank.group_parts' AND EXISTS (SELECT 1 FROM shift_plans p WHERE p.id = 'gp-' || a.id)
    AND EXISTS (SELECT 1 FROM bank_rows r WHERE r.id = j.value) ORDER BY a.id;

-- A booked credit chosen as the same sale as a bill (the last word for the credit, still booked).
INSERT INTO shift_plans (id, business_id, shift_day, kind, comparison_ids, head_row_id, created_by, created_at)
  SELECT 'ss-' || a.id, a.business_id, json_extract(a.after, '$.shiftDay'), 'same_sale', json_array(json_extract(a.after, '$.comparisonId')), NULL, a.user_id, a.created_at
  FROM audit_log a JOIN shifts s ON s.business_id = a.business_id AND s.shift_day = json_extract(a.after, '$.shiftDay') AND s.status <> 'confirmed'
  WHERE a.action = 'bank.same_sale_planned'
    AND NOT EXISTS (SELECT 1 FROM audit_log u WHERE u.business_id = a.business_id AND u.action = 'bank.same_sale_unplanned' AND u.row_id = a.row_id AND u.id > a.id)
    AND NOT EXISTS (SELECT 1 FROM audit_log n WHERE n.business_id = a.business_id AND n.action = 'bank.same_sale_planned' AND n.row_id = a.row_id AND n.id > a.id)
    AND EXISTS (SELECT 1 FROM bank_rows r WHERE r.id = a.row_id AND r.status = 'booked');
INSERT OR IGNORE INTO shift_plan_items (plan_id, business_id, bank_row_id)
  SELECT p.id, p.business_id, a.row_id FROM shift_plans p JOIN audit_log a ON p.id = 'ss-' || a.id ORDER BY a.id;

-- A card advance chosen for a bill (the last word for the payment is "planned").
INSERT INTO shift_plans (id, business_id, shift_day, kind, comparison_ids, head_row_id, created_by, created_at)
  SELECT 'ca-' || a.id, a.business_id, json_extract(a.after, '$.shiftDay'), 'card_advance', json_array(json_extract(a.after, '$.comparisonId')), NULL, a.user_id, a.created_at
  FROM audit_log a JOIN shifts s ON s.business_id = a.business_id AND s.shift_day = json_extract(a.after, '$.shiftDay') AND s.status <> 'confirmed'
  WHERE a.action = 'card.advance_planned'
    AND NOT EXISTS (SELECT 1 FROM audit_log n WHERE n.business_id = a.business_id AND n.row_id = a.row_id AND n.action IN ('card.advance_planned', 'card.advance_unplanned')
      AND json_extract(n.after, '$.shiftDay') = json_extract(a.after, '$.shiftDay') AND n.id > a.id)
    AND EXISTS (SELECT 1 FROM card_settlements s2 WHERE s2.id = a.row_id);
INSERT OR IGNORE INTO shift_plan_items (plan_id, business_id, card_payment_id)
  SELECT p.id, p.business_id, a.row_id FROM shift_plans p JOIN audit_log a ON p.id = 'ca-' || a.id ORDER BY a.id;

-- Parts plans whose credits were not all free (one was already held by an earlier choice) are not kept in part.
DELETE FROM shift_plan_items WHERE plan_id IN (
  SELECT 'bp-' || a.id FROM audit_log a WHERE a.action = 'bank.bill_parts'
    AND (SELECT count(*) FROM shift_plan_items i WHERE i.plan_id = 'bp-' || a.id) <> json_array_length(json_extract(a.after, '$.creditIds'))
  UNION ALL
  SELECT 'gp-' || a.id FROM audit_log a WHERE a.action = 'bank.group_parts'
    AND (SELECT count(*) FROM shift_plan_items i WHERE i.plan_id = 'gp-' || a.id) <> json_array_length(json_extract(a.after, '$.creditIds')));

-- A plan left holding nothing (its credit was already held by an earlier choice) goes.
DELETE FROM shift_plans WHERE NOT EXISTS (SELECT 1 FROM shift_plan_items i WHERE i.plan_id = shift_plans.id);

-- shift_choices stays for now (empty from here on) so the running Worker does not fail between this migration and the
-- deploy; a later migration drops it.
DELETE FROM shift_choices;
