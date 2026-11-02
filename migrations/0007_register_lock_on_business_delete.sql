-- With bills paid together, deleting a row sets paid_with_row_id to NULL on the rows paid with it.
-- When a whole business is deleted, that update must not be blocked by the confirmed-shift lock.
DROP TRIGGER register_rows_locked_update;
CREATE TRIGGER register_rows_locked_update
BEFORE UPDATE ON register_rows
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND status = 'confirmed' AND shift_day IN (OLD.shift_day, NEW.shift_day))
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
