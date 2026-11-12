-- The guest or company name on a software bill (approved 12 Nov 2026): kept from the sales report's NAME column, for the
-- complimentary report. NULL for bills imported before, and where the report's NAME is empty or "U/N".
ALTER TABLE software_bills ADD COLUMN customer_name TEXT;
