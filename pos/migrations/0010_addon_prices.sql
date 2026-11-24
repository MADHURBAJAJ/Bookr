-- Add-on prices per dish (approved 19 Nov 2026). A "pick one" (Half / Full) has only option names; each dish that offers
-- it sets its own full price for each option (Tandoori Chicken Half 300 / Full 450, Biryani Half 199 / Full 349). An "add
-- any" (Extra Cheese) has its usual price on the option; a dish may set its own (Extra Cheese 80 on a pizza).
-- prices: JSON object, option name in lower case → paise. NULL: the add-on's own prices.
ALTER TABLE menu_item_addons ADD COLUMN prices TEXT CHECK (prices IS NULL OR json_valid(prices));
