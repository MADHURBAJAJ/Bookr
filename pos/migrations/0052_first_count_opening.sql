-- An item's first count is its opening stock (27 Nov 2026, approved by the owner). The bar's first count was saved as
-- stock found extra, so the stock report showed a negative cost. Count rows of an item that never had stock in that store
-- before (no purchase, opening stock, transfer in or earlier count) become opening stock. Quantities and times do not
-- change; only how the row is read. Stock moves are otherwise never changed: the lock is lifted for this one update.
DROP TRIGGER IF EXISTS stock_moves_frozen;

UPDATE stock_moves SET kind = 'purchase', vendor = 'Opening stock', ref = coalesce(ref, 'First count')
WHERE kind = 'count' AND qty > 0
  AND NOT EXISTS (SELECT 1 FROM stock_moves p WHERE p.business_id = stock_moves.business_id AND p.item_id = stock_moves.item_id
    AND p.store_id = stock_moves.store_id AND p.kind IN ('purchase', 'transfer_in', 'count') AND p.at < stock_moves.at);

CREATE TRIGGER stock_moves_frozen
BEFORE UPDATE ON stock_moves
BEGIN
  SELECT RAISE(ABORT, 'stock_move_frozen');
END;
