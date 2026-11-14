-- Own accounts (approved 14 Nov 2026): how each account of the business appears on its other accounts' statements
-- (UPI IDs, names or words), so a line moving money between them is shown as a transfer, not an expense or a receipt.
-- Filled by a person on Accounts, or remembered when a person books a transfer by hand. JSON list of strings.
ALTER TABLE accounts ADD COLUMN identifiers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(identifiers));
