-- The card report's "Mode of Payment" (approved 9 Nov 2026): UPI (the machine's QR), UPI Card (a RuPay credit card paid
-- through UPI) or CARDS. UPI and UPI Card on the machine are UPI sales that reach the bank in the machine's settlement.
ALTER TABLE card_settlements ADD COLUMN pay_mode TEXT;
-- Rows imported before: scheme UPI is UPI; RuPay with no card number is UPI Card; the rest are cards.
UPDATE card_settlements SET pay_mode = CASE
  WHEN upper(coalesce(scheme, '')) = 'UPI' THEN 'UPI'
  WHEN upper(coalesce(scheme, '')) LIKE 'RUPAY%' AND card_last4 IS NULL THEN 'UPI Card'
  ELSE 'CARDS' END;
