# Restaurant POS

A separate Cloudflare Worker with its own D1 database, kept in the Bookr repository so it shares Bookr's money, India-time and
crypto code. It sends each settled bill, debtor receipt, void and shift close to Bookr, which files them and shows them on its
POS page (not yet booked as income). Plan and decisions: the "Hotel restaurant POS: research and plan" doc.

## Try it on its own, with demo data (not connected to Bookr)

The POS runs fine without Bookr: with no `BOOKR_URL` or key set, its messages for Bookr just wait in its own database.
The demo restaurant is invented data: a company with 5% GST, two HUFs without GST (₹20 lakh limit), 16 menu items,
reasons, two in-house rooms and one credit account.

On this computer:

```bash
npm run pos:migrate:local
DEMO_PASSWORD='choose-one-locally' npm run pos:seed-demo:local
npm run pos:dev                      # http://127.0.0.1:8788
```

On Cloudflare (once): `npx wrangler login`, then `npx wrangler d1 create pos-demo --location apac` and put the
`database_id` it prints into `pos/wrangler.jsonc`. Then:

```bash
npm run pos:migrate:remote
DEMO_PASSWORD='choose-one' npm run pos:seed-demo:remote
npm run pos:deploy
```

Sign in as `pos-owner@example.com` with the demo password, open **Settings › This device** and press **Make this a
counter device**. Sign out: the counter now shows the PIN pad (demo PINs 1111 cashier, 2222 captain, 3333 manager).
Running the seed again resets the demo restaurant.

## Connecting to Bookr

1. In Bookr, the Owner opens **POS** and presses **Connect POS**. The key is shown once.
2. On the POS Worker set `BOOKR_URL` (a var in `pos/wrangler.jsonc`) to Bookr's address, and the key as a secret:
   `npx wrangler secret put BOOKR_KEYS -c pos/wrangler.jsonc` with `{"<business id>": "<key>"}`. Never in the repo or chat.
3. The POS sends after every settle, void, receipt and shift close, every 5 minutes (cron), and on **Send now**. A message
   Bookr already has is not filed twice; one it cannot file is kept on both sides with the reason.
4. **Make a new key** in Bookr replaces the old one (then update the secret); **Disconnect** stops Bookr accepting messages.

Nothing about one hotel is fixed in code. Billing names (a company, HUFs or one name), GST rate, yearly limits, shift start,
tab age limit, menu and reason lists are settings per business.

## What it does

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
