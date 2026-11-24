// What a chosen add-on costs on one dish (approved 19 Nov 2026). Pure, and mirrored in the counter screen (public/app.js,
// optionAdd) so the picker shows the same total the server charges.
//
// A dish's own prices (menu_item_addons.prices, option name in lower case → paise):
// - "pick one": full prices of the dish with each option. The dish's own price is the first option's price, so choosing
//   another option adds the difference (Half 300 / Full 450: Full adds 150).
// - "add any": what the extra costs on this dish, instead of the add-on's usual price.
// Without the dish's own price, the option's own amount is added (as before).

export type Prices = Record<string, number>;
export interface AddonOption { name: string; addPaise: number }

export const priceKey = (name: string) => name.trim().toLowerCase();

/** Reads a stored prices column; anything not a map of whole paise is ignored. */
export function readPrices(json: string | null | undefined): Prices | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Prices = {};
    for (const [k, p] of Object.entries(v)) if (Number.isInteger(p) && (p as number) >= 0) out[priceKey(k)] = p as number;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** What choosing `option` adds to the dish's own price. `options` is the group's options in order. */
export function optionAdd(kind: string, options: AddonOption[], option: AddonOption, prices: Prices | null): number {
  const mine = prices?.[priceKey(option.name)];
  if (kind === 'one') {
    const first = options[0] ? prices?.[priceKey(options[0].name)] : undefined;
    if (mine !== undefined && first !== undefined) return mine - first;
    return option.addPaise;
  }
  return mine ?? option.addPaise;
}

/** For a dish with priced "pick one" add-ons, its own price: the first option's price of the first such group. */
export function basePrice(groups: { kind: string; options: AddonOption[]; prices: Prices | null }[]): number | null {
  for (const g of groups) {
    const p = g.kind === 'one' && g.options[0] ? g.prices?.[priceKey(g.options[0].name)] : undefined;
    if (p !== undefined) return p;
  }
  return null;
}
