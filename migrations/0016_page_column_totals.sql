-- The totals written on the bottom line of a register page, one per column (approved 3 Nov 2026), as JSON in paise:
-- {"amount":…, "discount":…, "cash":…, "upi":…, "upi2":…, "card":…}; a column with no total written is left out.
-- Read from the photo and correctable on Review, where each is checked against its column's rows.
ALTER TABLE uploads ADD COLUMN page_column_totals TEXT CHECK (page_column_totals IS NULL OR json_valid(page_column_totals));
