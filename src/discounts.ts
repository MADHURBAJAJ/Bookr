// Discount or tip worked out for bills paid together (or a single bill): bills minus payment.
// spreadDifference shares a discount over bills by amount, for a bank correction on a confirmed shift.
// On the register a group's discount is written once, on the paying row: see onPayingRow.

export interface GroupBill { id: string; amountPaise: number }

/** Discount and tip per row, or null when the payment cannot be explained (more discount than the bills). */
export function spreadDifference(head: GroupBill, members: GroupBill[], paidPaise: number): Map<string, { discountPaise: number; tipPaise: number }> | null {
  const rows = [head, ...members];
  const bills = rows.reduce((t, r) => t + r.amountPaise, 0);
  const diff = bills - paidPaise;
  const out = new Map(rows.map((r) => [r.id, { discountPaise: 0, tipPaise: 0 }]));
  if (diff < 0) { out.get(head.id)!.tipPaise = -diff; return out; }
  if (diff === 0) return out;
  if (diff > bills) return null;
  // Proportional shares, in whole rupees when the difference is whole rupees (otherwise paise). Units left
  // over from rounding go to the bills with the largest remainders, never past a bill's own amount.
  const unit = diff % 100 === 0 ? 100 : 1;
  const units = diff / unit;
  const shares = rows.map((r) => ({ r, d: Math.min(Math.floor((units * r.amountPaise) / bills), Math.floor(r.amountPaise / unit)), rest: (units * r.amountPaise) % bills }));
  let left = units - shares.reduce((t, s) => t + s.d, 0);
  for (const s of [...shares].sort((a, b) => b.rest - a.rest || b.r.amountPaise - a.r.amountPaise)) {
    if (!left) break;
    if ((s.d + 1) * unit <= s.r.amountPaise) { s.d += 1; left -= 1; }
  }
  if (left) return null;
  for (const s of shares) s.d *= unit;
  for (const s of shares) out.get(s.r.id)!.discountPaise = s.d;
  return out;
}

/**
 * Discount or tip for bills paid together, as the register writes it: all of it on the row with the payment, even when
 * that is more than the row's own amount (approved 7 Nov 2026). Null when it is more than the group's bills.
 */
export function onPayingRow(head: GroupBill, members: GroupBill[], paidPaise: number): Map<string, { discountPaise: number; tipPaise: number }> | null {
  const rows = [head, ...members];
  const diff = rows.reduce((t, r) => t + r.amountPaise, 0) - paidPaise;
  if (paidPaise < 0) return null;
  const out = new Map(rows.map((r) => [r.id, { discountPaise: 0, tipPaise: 0 }]));
  if (diff > 0) out.get(head.id)!.discountPaise = diff;
  if (diff < 0) out.get(head.id)!.tipPaise = -diff;
  return out;
}

/**
 * Each bill's own figures once a paying row's discount passes its own amount: that row counts as nil, and the rest comes
 * off the group's other bills, largest first, so no bill goes below nil and the group still adds up to the payment.
 * amount_paise is net here, discount_paise signed.
 */
export function spillGroupDiscount<T extends { id: string; amount_paise: number; discount_paise: number; paid_with_row_id: string | null }>(rows: T[]): T[] {
  const out = rows.map((r) => ({ ...r }));
  for (const head of out.filter((r) => !r.paid_with_row_id && r.amount_paise < 0)) {
    let over = -head.amount_paise;
    head.amount_paise = 0;
    head.discount_paise -= over;
    const members = out.filter((m) => m.paid_with_row_id === head.id).sort((a, b) => b.amount_paise - a.amount_paise || a.id.localeCompare(b.id));
    for (const m of members) {
      const take = Math.min(over, m.amount_paise);
      if (take <= 0) continue;
      m.amount_paise -= take;
      m.discount_paise += take;
      over -= take;
    }
  }
  return out;
}

