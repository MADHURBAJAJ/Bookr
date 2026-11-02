// Discount or tip worked out for bills paid together (or a single bill): bills minus payment.
// A discount is spread over the group's bills in proportion to their amounts, so no bill gets
// more discount than its own amount. A tip (more paid than billed) goes on the row with the payment.

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
