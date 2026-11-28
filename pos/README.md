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
Running the seed again resets the demo restaurant; `npm run pos:reset-demo:remote` resets it keeping the Owner's present password
(no password typed). A reset also removes counter devices, so set the counter up again afterwards.

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
- **Split bills.** By item (chosen dishes move to a new bill at the same table, each with its own number and GST), or one
  bill paid in equal shares, each share its own way.
- **Credit notes.** Money given back on a paid bill: whole or chosen items, at the bill's own discount and GST, numbered per
  billing name (`C-CN2627-0001`), with a reason and how the money went back. A bill can be found by its number.
- **Money out.** Cash paid out of the drawer, and an unused advance refunded; both reduce the cash expected at shift close.
- **Payments with dates** (28 Nov 2026). Every time shows its date ("28 Nov, 12:41 am"). Pick one shift (◀ date ▶) or
  From–To, up to 7 shifts, newest first, each under its own heading; Today's shift goes back. Only today's shift refreshes
  every 12 seconds and lists bills still unpaid from before; a past shift or a range lists each bill under its own shift.
- **Reports.** Sales by billing name with GST (credit notes netted), by payment mode and by item; discounts, complimentary
  bills and voids; who owes what, aged, with printable statements.
- **Bar stock.** Stores (main, bar, kitchen), items in ml or pieces with their pack size and price, recipes per menu item;
  settled bills take stock by recipe; receiving, transfers, breakage and counts with variance; a stock report per store.
- **Phones and tablets.** Menu and order side by side from tablet width; on a phone a bar at the bottom shows the order.
- **Exceptions report.** Voids, reprints, cancelled KOT lines, discounts, complimentary bills and limit warnings, append-only.
- **Serving time.** Each category has a "Serve in … min" (empty: not timed; bar categories start empty); an item may have
  its own (0: never timed), also as the "Serve time (min)" column of the menu sheet. Each KOT line keeps its minutes, so
  later menu changes don't change old results. Servers (their own role, kept apart from staff) sign in on their own phones
  at `/#/serve/<business id>` with a 6-digit PIN that works only there and opens only the Serve screen: running KOTs,
  **Complete** / **Part** / **Served**, a photo of the KOT and the food. Wrong PINs block only that connection (10 in 15
  minutes; 30 from a connection servers use), a manager unlocks it. Removing a server ends their sign-in at once; sign-ins
  end at day close. A server can undo their own tap for 2 minutes; after that a manager undoes it on **Tables › Serving**
  with a reason, or marks a forgotten item served (no photo). Late is worked out from the first time an item was marked,
  so an undo never makes a late item look on time. The tables screen counts down (amber at 80% of the time, red when
  late); the Daily check has a Serving time card (late, not marked, undos, manager marks, wrong PINs) and Reports has a
  Serving time tab (by item, hour, day and server). Photos are kept in the BILLS bucket (`pos/<business>/served/`) and
  shown only to managers and the Owner.

## Offline mode (27 Nov 2026)

When the internet is off, a counter device the owner turned on (Settings, Counter devices, "Works offline") keeps working
from what it saved on that PC: tables and takeaway, KOTs printed on its own printers, bills, cash / UPI / card payments,
food to a room and payments from guests staying. Rooms (check-in, check-out, refunds), credit, reports, stock, day close
and settings wait for the internet.

- Each device turned on gets a letter (A, B, ...) that is never given again. Its offline bills are numbered
  `C261127A001` (billing name's letter, print date, device letter, its own count), receipts `RCPT/26-27/A001`, KOTs `A1`,
  `A2`. They never clash with the server's numbers and leave no gap in the day's or the year's count.
- What it did is kept as steps on that PC (`pos/public/offline.js`, browser storage) and shown on **Not sent yet**
  (`#/offline`). When the internet is back they go up one at a time to `POST /offline/replay`
  (`pos/src/routes/offline.ts`), which runs each through the usual route with the same sign-in (so the role and every
  rule are checked as usual), at the time it happened, keeping the printed numbers, and saves it once even if sent twice.
- A step the server refuses stays on the PC as "needs a look" with the reason; nothing is dropped. A bill whose total on
  the server differs from its paper is listed on the Daily check.
- The pages themselves are kept by a service worker (`pos/public/sw.js`), so the Windows app opens with no internet once
  it has opened the POS online.
- The Worker needs the `nodejs_als` compatibility flag (in `wrangler.jsonc`) and migration `0050_offline_mode.sql`.

## Settings › WhatsApp (27 Nov 2026)

Bookr reads WhatsApp (the listener on the reception PC, see `listener/README.md`); this tab shows whether that works and
chooses the groups, without signing in to Bookr. Owners and managers see it and switch a group's reading or its
"Proof for bills"; only the Owner starts reading a new group, picked from the groups the reception phone is in.

- The POS checks the role on every request (`whatsapp.edit`, `whatsapp.add` in `src/permissions.ts`) and asks Bookr
  with its existing key (`BOOKR_KEYS`): `POST /api/pos/wa`, `/api/pos/wa/edit`, `/api/pos/wa/add` (`src/routes/pos.ts` in
  Bookr). Bookr checks the key and the role again, and writes the POS person's name in its history
  ("POS · Ravi (manager)").
- No new secret and no migration. Without a Bookr key the tab says the POS is not connected.
- **The WhatsApp number** (27 Nov 2026): the Owner links, switches or unlinks it here (`whatsapp.link`); the reception
  PC picks the request up within a minute and the QR to scan shows on this page, to the Owner only, for 3 minutes. Bookr
  keeps the request and the number's last 4 digits (migration `0044_wa_link.sql` in Bookr); see `listener/README.md`, 2a.

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
