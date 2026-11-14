# Restaurant POS

A separate Cloudflare Worker with its own D1 database, kept in the Bookr repository so it shares Bookr's money, India-time and
crypto code. It sends each settled bill, debtor receipt, void and shift close to Bookr (the sending and Bookr's receiving end
come next; for now messages wait in the `outbox` table). Plan and decisions: the "Hotel restaurant POS: research and plan" doc.

Nothing about one hotel is fixed in code. Billing names (a company, HUFs or one name), GST rate, yearly limits, shift start,
tab age limit, menu and reason lists are settings per business.

## What it does now (server only; the counter screens come next)

- **Sign-in.** Owners and managers: email and password. Counter staff (cashier, captain): a 4–6 digit PIN, only on a counter
  device an Owner set up; 5 wrong PINs lock PIN sign-in on that device for 15 minutes. Every business route checks the role
  in that business on every request (`src/permissions.ts`, `requireAction` in `src/auth.ts`).
- **Orders and KOT.** Table, room or takeaway orders; one KOT per station (kitchen, bar). Taking away an item already sent to
  the kitchen needs a reason. An order can be kept as a tab across shifts.
- **Bills.** Printed only once every item has gone to the kitchen. The cashier picks the billing name (default preselected)
  and any discount, which needs a reason. Numbers run per billing name and financial year with no gaps
  (`C-2627-00001`, at most 16 characters). GST is charged on prices after discount, CGST and SGST halves, rounded to the
  rupee. A printed bill never changes (database triggers); a mistake is voided with a reason and billed again. A billing
  name with a yearly limit warns at its warning points and is not offered past its stop point.
- **Settle.** A bill closes only when payments add up exactly. Cash (with change), UPI (which account's QR; a QR of
  another billing name is asked about first), card (approval code and last 4 from the slip), post to room, credit account
  (can be created at the counter; limit kept), complimentary (guest name and reason), and advance. One settle can pay
  several bills.
- **Debtors.** Room folios (one per in-house stay; check-out needs a zero balance) and credit accounts, with receipts and
  advances.
- **Shift close.** Drawer count by note against float plus cash taken; a difference needs a reason. Open orders must be billed
  or kept as tabs, and printed bills paid or voided, first. Tabs are listed apart. No payment can land in a closed shift.
- **Exceptions report.** Voids, reprints, cancelled KOT lines, discounts, complimentary bills and limit warnings, append-only.

## Run and test

```bash
npx vitest run pos/                 # unit tests and the full counter flow on a local D1
npx wrangler d1 migrations apply DB --local -c pos/wrangler.jsonc
npx wrangler dev -c pos/wrangler.jsonc
```

Setting up a business needs the `POS_SETUP_TOKEN` Worker secret (`npx wrangler secret put POS_SETUP_TOKEN -c pos/wrangler.jsonc`;
for local dev, a `pos/.dev.vars` file that is never committed). Then `POST /api/setup` with header `X-Setup-Token`
and `{ businessId (the business's id in Bookr), name, ownerName, email, password }`.

Tests use invented data only.
