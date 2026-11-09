# Phase 3, part 1: bank statements, UPI matching, rules

Approved 2 Nov 2026 (tables `bank_sources`, `bank_rows`, `bank_matches`, `rules`; migration 0012).

## Accounts used by the hotel

- **Exospark ICICI**: receives "UPI XOXO" and the card machine settlement (`EZY/ICICIPOS_SET_…`). Google Sheet with **one tab per month** → source tab = every tab.
- **Five HUF accounts (ICICI)**: used **in rotation**, any one on a given day, all for "UPI Bank 2". Each has **one tab for the whole year**. All five are marked "UPI Bank 2"; matching looks in all of them.
- More accounts: add them on Accounts (kind bank) and set them up on Bank sync.

## Statement layout (ICICI)

No., Transaction ID, Value Date, Txn Posted Date, ChequeNo., Description, Cr/Dr, Transaction Amount, Available Balance. A title line and header are skipped; "No." restarts daily, so the **Transaction ID** is the key (unique per account). The posted date and time (India time) is used for matching.

| Description | Kind | Handling |
|---|---|---|
| `UPI/<ref>/<note>/<upi id>/<bank>/…` CR | upi_in | matched to UPI sales |
| `UPI/<ref>/<note>/<upi id>//…` DR | upi_out | rules (by note or UPI ID) or booked by hand |
| `EZY/UPICCMDR_~<ref>~ddmmyy` DR | upi_fee | fee on a credit card paid via UPI; paired to the credit with that ref |
| `UPI/RVSL<ref>/…` CR | reversal | paired to the debit with that ref; both left out together |
| `EZY/ICICIPOS_SET_…` CR | card_settlement | card machine; matched with card sales in part 2 (card company emails) |
| `VPS/…` DR | card_purchase | debit card purchase |

## Getting statements into Bookr

- **Paste rows** (always available): copy rows from the sheet and paste on Bank sync. Lines already stored are skipped.
- **Sync** (once Google access is set up): Bookr reads the sheet as a Google service account. The key is the Worker secret `GOOGLE_SERVICE_ACCOUNT` (the JSON key file); it never reaches the browser, logs or repo. Each sheet is shared with the service account's email as **Viewer**.

### Setting up Google access (Owner, once)

1. console.cloud.google.com → create a project (e.g. "Bookr").
2. APIs & Services → Library → enable **Google Sheets API**.
3. IAM & Admin → Service accounts → Create (name "bookr-sheets"), no roles needed.
4. Open it → Keys → Add key → JSON. A file downloads.
5. In the repo folder: `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT` and paste the file's whole contents. Delete the downloaded file afterwards.
6. Bank sync now shows the service account's email: share each Google Sheet with it as Viewer, then set each account's sheet link and tab.

## Matching and booking (a person confirms everything)

- **UPI credit → sale(s)**: same amount; paid within 3 hours by the software's time (register-only bills: within the shift). **Strong** = within 20 minutes. **Clear** = one strong sale for the credit, and that sale has no other strong credit. Clear ones are pre-ticked; a person confirms them together ("Confirm N clear UPI matches") or matches any suggestion by hand. Bills paid together are offered as one sale. A sale written under a different UPI column (e.g. UPI XOXO) is not offered for a UPI Bank 2 account.
- Matching sets `transactions.matched_bank_row` and clears `match_status`; unmatching restores `awaiting_bank_match`. A matched sale blocks reopening its shift.
- **Rules** (Heads and rules; made from any line with "Make a rule"): description contains / UPI ID equals / money in or out / amount range / account → head (and party). First rule that fits wins. Lines a rule fits are pre-ticked; a person books them ("Book N by rules").
- **Book…**: a line becomes an approved income (money in) or expense (money out) row on that bank account (`source = bank_sheet`), under a head of the right type, with an optional party and note.
- **Leave out**: with a reason (e.g. transfer between own accounts). Reversals: "Leave out N reversed payments".
- **Undo** on a booked or left-out line removes its entry (kept in the audit log).
- Permissions: bank work is Owner and Accountant (`bank.link`); rules are `rules.edit`. Every action is audited.

## Part 2: card settlements (approved 8 Nov 2026)

Tables `inbound_mails`, `card_settlements`, `card_matches` (migration 0018). Screen: **Card settlements** (Owner and Accountant, `bank.link`).

- **The report.** ICICI POS sends one Excel file per settlement day (`<MID>_<NAME>_<DDMMYYYY>_ICICI_POS_CD.xlsx`): one row per card payment with its time, amount, fee (Transaction Charges, negative), GST (negative), net amount, RRN, Transaction ID (unique, the key), card brand and last 4, then TID / MID subtotals and a Grand Total (used as a control total). The UTR column is blank. A file holds the previous day's payments, so its payments fall in different shifts: each payment's shift comes from its own time. Read by `src/cardsettlement.ts` (a small zip and sheet reader; Workers have no Excel library). Fee and GST are kept positive.
- **Getting it in.** Dropped on Card settlements, or by mail: Gmail forwards the mail to Bookr's address, Cloudflare Email Routing hands it to the Worker's `email()` handler (`src/mail.ts`). The raw mail is kept in R2 (`mail/<business>/<id>.eml`) before anything is read; Message-ID stops a mail being read twice and the Transaction ID stops a payment being added twice. Mail from senders not in `CARD_MAIL_FROM` is turned away (it bounces back to Gmail); Gmail's forwarding confirmation is kept and its link shown on the screen. "Read again" rereads a stored mail.
- **Payment → bill.** Like UPI: same amount, within 3 hours of the software's bill time; register-only bills (no time) fit a payment in their shift but are never ticked. Paired by closest time first, each used once, up to an hour apart → ticked. Bills paid together count as one; one payment can pay several bills and one bill several payments (`card_matches`), totals must agree. Only PURCHASE rows are matched. Matching clears `awaiting_card_settlement`; Unmatch puts it back. A shift with a card-matched sale cannot be reopened.
- **Day → bank.** A settlement day's net total is matched to an open `EZY/ICICIPOS_SET_…_ddmmyy` credit of exactly that amount (the date at the end is the settlement day; credits from the day before to four days after are offered). Settling books the credit (status booked, note says what it settled) and the fee and the GST by the Card settlement rule (below). Undo on Card settlements, or Undo on Bank sync, takes it apart and removes the fee and GST entries (audit-logged).

### Card on Reconcile, automatic where safe (approved 8 Nov 2026)

Migration 0020: `card_rules` (one per card machine/terminal: fee head, GST head) and `card_settlements.gst_tx_id`. Code: `src/cards.ts` (`autoPairs`, `runCardAuto`, `settleStatements`, `shiftCards`), routes in `src/routes/cards.ts`.

- **Bookr matches on its own** a payment and a card bill of the same amount within 20 minutes when neither has another candidate (`autoPairs`). `card_matches.matched_by` is empty and the audit entry says `auto`. It runs after a card report comes in, after a shift is confirmed and after a card rule is saved. Everything else waits for a person.
- **Card settlement rule** (Heads and rules, per terminal, Owner and Accountant `heads.edit`): the fee (MDR) head, e.g. "Card machine charges" (Tally: Bank Charges), and the GST head, e.g. "GST on card charges". No input credit is claimed; both are expense heads. Fee and GST are booked as **two** expense rows on the bank account and the credit's day.
- **Bookr settles on its own** a settlement day whose open `EZY/ICICIPOS_SET_…_ddmmyy` credit carries that date and exactly its net, when it is the only such credit and the day is the only one claiming it, and the terminal has a rule (`done_by` empty, audit `auto`). Runs after a card report, after bank lines are brought in (paste or sync) and after a rule is saved. Without a rule nothing is settled. Settling by hand uses the rule too ("Set the Card settlement rule on Heads and rules first" when missing). Two or three days in a row that add up exactly to one open credit are offered as "Settle these days together" (never done by Bookr). Undo (Reconcile, Card settlements or Bank sync) removes both rows.
- **Reconcile → Card** (confirmed shifts, beside UPI, by swipe time): a strip (card bills, matched with how many by Bookr, bills with no swipe, swipes with no bill); "Needs you" cards: several bills fit (pick buttons), one further away in time, more than its bill ("Match, ₹X tip": the difference becomes an income row on the shift, `source` bank_sheet, removed on Unmatch), refund or void (shown only), no bill (Book to an income head, removed on Unmatch; or Find the bill on Compare); card bills with no swipe once the card report is in for the shift (a later swipe, or a settlement two days on): **Was cash / Was UPI** (paid another way, now also for card sales not matched; Was cash is highlighted when the shift's cash is over by exactly that amount); Done with Undo ("by Bookr" marked); the settlement (gross, fee, GST, net, "Settled by Bookr" / "No card rule" / waiting) with Undo.
- **Shift bar**: card items (needs + no swipe) count in Reconcile's "N left" once the shift is confirmed.
- **Card settlements** keeps the folder link, the reports received, every day's payments and the history; settling there uses the rule.

### Sync runs the Gmail script (approved 8 Nov 2026)

The Owner's Apps Script (saves `ICICI_POS…xlsx` attachments of card mails without the `bookr-saved` label into the Drive folder, then labels them) is also deployed as a web app (run as the Owner, anyone with the link). Its `doPost` runs only when the body carries the shared code. Worker secrets `CARD_SCRIPT_URL` (the web app address) and `CARD_SCRIPT_TOKEN` (the code; also in the Mac's Keychain as bookr-card-script-token). Sync on Card settlements and Sync all bank accounts call it first (25 s limit), then read the folder; when it fails the folder is still read and the problem is said. The hourly trigger stays as a backup.

### Setting up the mail (Owner, once)

1. A domain on Cloudflare (nameservers at Cloudflare). If the domain already receives company mail, use a subdomain such as `mail.<domain>`: Email Routing replaces the MX records.
2. Dashboard → the domain → Email → Email Routing → Enable.
3. Worker settings (wrangler.jsonc `vars` or the dashboard): `MAIL_ROUTES` = `{"cards@<domain>": "<business id>"}`, `CARD_MAIL_FROM` = the card company's sender address (or `@theirdomain`). Deploy.
4. Email Routing → Routing rules → Create address `cards@<domain>` → Send to a Worker → bookr.
5. Gmail → Settings → Forwarding → Add `cards@<domain>`. Gmail's confirmation mail shows on Card settlements with a "Confirm forwarding" link: open it.
6. Gmail filter: `from:<card company sender>` → Forward to `cards@<domain>`.

### Card machine and the bank, both ways (approved 9 Nov 2026)
Reconcile's card section is called **Card machine**. Each machine payment shows as "UPI on machine" or the card brand and last 4; the strip splits what the machine got into card and UPI on machine. Staff write a UPI payment taken on the machine as "card" in the register, so the machine and the bank are checked against each other the same way as UPI, only once both the card report and the bank are in for the shift:
- A card bill with no machine payment: a UPI credit of its amount near its time, in either account (within 60 minutes, or up to 2 hours before when it is the only one), is offered as **Change to UPI and match**. Two machine payments that add up to it are offered as **Match both**. Otherwise Was cash / Was UPI, as before (cash over by exactly its amount is said).
- A machine payment with no card bill: a bill of its amount written as UPI (no credit yet) or cash, near its time, from the day before to the day after, is offered as **Change to card and match**. Otherwise a tip, else Book to a head.
- An entry the card side explains is told and counted once: the credit or the UPI bill is left out of the UPI side, with a note pointing to Card machine.
- A person confirms every mode change; each is recorded as "paid another way" and can be undone (unmatch, then undo).
- Compare sales shows a machine payment of the card side's amount within 60 minutes as a witness for a card-vs-other mode difference (Owner and Accountant only).
- Not built: a bill paid partly on the machine and partly by UPI credit. It is shown as a note only, because splitting one sale between the card report and the bank needs its own design.

### Reconcile tabs and Save reconcile (approved 9 Nov 2026)
Reconcile has **Cash**, **UPI** and **Card** tabs. Each lists every bill of the shift paid that way: what the register and the software say, what backs it (a bank credit, a machine payment, the cash count), and each change as before → after (the register as read and as corrected, the side used when they differ, a mode changed later). Each tab counts what is left.

A shift is finished on Reconcile with **Save reconcile** (Owner or Accountant), in place of Confirm shift on Compare sales. Before saving, everything is a draft: differences are decided from the tabs (Use register, Use software, Leave out), and a UPI credit and its bill(s) can be ticked to **Match on save**. Such a choice is kept in `shift_choices`; the credit is held, so no other bill or shift is offered it, and Undo removes the choice. Save books the income as confirming did, makes each chosen match whose credit is still open and adds up (a choice that no longer fits is said and logged), then Bookr's clear matches and the card machine's safe matches. Bills still waiting for the bank or the card machine can be saved and matched afterwards, as before. Compare sales stays as the list of all bills.

## Not yet (part 2 and later)

- Refunds and voids on the card report: shown, never matched.
- A card payment less than its bill (a discount given at the machine): matched by hand only after a person corrects the bill.

- Transfers between own accounts as transfer pairs (today: Leave out with a reason).
- A "Owner drawings" head type that is not an expense (needs approval).
- Bank sync screen: tabs Money in / Money out / Done; lines grouped by shift (8 am to 8 am), folded until opened; bulk "Confirm clear matches" and "Book by rules" per shift. Actions named Match to bill / Book under a head / Skip (not business).
- Inside a shift: sections "Bill found" (tick, choose among candidate bills, Match N selected), "No bill found" / "Needs a head" / "Rule suggests a head" (head dropdown per line, Book N selected), each with Select all. Server: POST bank-rows/match-many and book-many, each line checked on its own.
- UPI matching: "Match by hand" panel per shift: bank credits not matched (from 3 h before to 6 h after the shift) beside UPI bills not found; tick one credit and its bill(s) (a paid-together group ticks together); totals and difference shown. Equal → Match; different → Match with this difference: the gap is booked on the bank account under a chosen head (expense if less came in, income if more) with a reason; Unmatch removes it. One bill paid by two credits needs a data-model change (not built; awaiting approval).
- Split payments (migration 0013, approved 2 Nov 2026): bank_matches gains amount_paise and allows one bill to link to several credits (unique per credit and bill). POST bank-rows/match-set takes credits and bills together, splits the credits over the bills in order; a difference is booked apart. Unmatching any credit undoes every credit sharing a bill with it.
- Hand match that changes the bills (migration 0014, approved 2 Nov 2026): when the totals differ, "Change the bills: discount / tip" shares the difference over the chosen bills (whole groups only, one UPI payment), sets each register row's discount/tip, the register payment and the income rows to what the bank received. Every change is in register_bank_adjustments (before/after); the confirmed-shift lock allows only these recorded discount/tip changes. Unmatch records the reverse and restores. Register rows show "Adjusted from bank". "Book it under a head" remains for real shortfalls.
- Change the bills for a bill paid in several UPI goes (approved 2 Nov 2026): tick all its UPI parts (they tick together) and the credits; with as many credits as parts, each register payment becomes a credit (equal amounts paired first, the rest in order) and discount/tip is worked out from the new total. Credits matched in one action are unmatched together; each credit of a bulk action stays separate.
- Match by hand lists one row per bill: a bill paid in several UPI goes shows bill, discount/tip and its payments in one row; bills paid together with one payment are one row. Matching stays per payment underneath.
- Pre-ticked UPI matches: credits and sales are paired by closest time first, each used once, up to 60 minutes apart (was: one strong candidate within 20 minutes); the paired sale is preselected. Register-only bills (no time) are never pre-ticked.
- Fix the bill from a bank credit (migration 0015, approved 2 Nov 2026): on Bank sync, "Fix bill" on a credit whose suggested bill is a register line (confirmed shift, one UPI payment, not paid together) opens an editor: bill number (software-only bills of the shift offered, closest number first), bill amount, discount/tip; bill less discount must equal the credit. Saving corrects the register line and payment; a number that is a software-only bill joins the halves (register sale moves to it, the duplicate software sale and the register-only comparison are removed). All recorded in register_bank_adjustments (text and whole rows); the register and decision locks allow only recorded changes. Unmatch restores everything.
- Bill-amount suggestions: when a UPI credit equals a waiting single bill's bill amount (before discount/tip) and the register shows a different received amount, it is offered in "Bill found", highlighted in amber with what changes, and paired/ticked by time like any match. Matching (also in bulk) corrects the register (discount/tip and payment) the same recorded, reversible way as "Change the bills".
- Paid another way (approved 3 Nov 2026): on UPI matching, a waiting UPI bill (single bill with one payment, or a whole paid-together group) can be changed to cash or card with a reason: the register payment mode, the sale(s) (cash: cash account, counted in the cash check; card: awaiting card settlement) and the comparison register mode change. Recorded in the audit log (sale.repaid, whole before rows); "Put back" restores while the sales are unchanged.
- Match by hand: bank credits list shows the shift's own credits first, then credits up to 1 hour before/after labelled "outside shift"; "Show 3 more hours after the shift" extends it.
- Bank lines booked like cash expense lines: Item (from the bank note), Party (datalist; known by UPI ID or named in the note) and Head (the party's head for that item, as pickHead; else a rule). Booking remembers a new party with its head and adds the UPI ID to the party's aliases, so the next payment to/from it fills party and head ("Learned"). Money out sections: "Head suggested" (pre-ticked) and "Needs a head".
- Unbilled sales: on Money in → No bill found, "Unbilled F&B" / "Unbilled Room" books the UPI credit as income under that bill type's head (Heads and rules), item "Sale not billed (F&B): …" and note "Unbilled sale"; the shift line shows the count and total of unbilled sales.
- Explainer (step B1, 3 Nov 2026): GET shifts/:day/explain on a confirmed shift checks what is left (UPI sales not found, credits with no bill, half-bills) for: number typo (alike numbers + credit = register amount near the software time → Fix the bill), payment written wrong (credit = bill amount → match with correction), paid in parts (same payer, credits within 30 min adding to the bill → match-set change the bills), clear matches (one click), and — only once bank data reaches the shift end — UPI bills with no credit (Was cash / Was card; cash recommended when the cash is over by exactly that amount). Cards never share a bill or credit (best first). Shown on UPI matching as "Bookr's suggestions"; "Not this" hides a card on that device. match-clear never applies matches that would change the register.
- Step A (approved 3 Nov 2026):
  - Bring in (menu): one screen per shift (default yesterday's), in order: software report (CSV preview/import), bank statements (per account "up to", covered when a UPI account reaches the shift end; Sync all bank accounts), pages (upload + list with read state, Read now). GET shifts/:day/inputs; bank part only for bank.link.
  - Sync all: POST bank/sync-all syncs every account with a sheet, one after another; failures are reported per account. Also on Bank sync.
  - Pages are read as soon as they are uploaded (Upload and Bring in), in the browser, up to the server's parallel limit, retrying while busy. Rows stay drafts.
  - Bill drawer: "Details" next to bill numbers (Compare sales, UPI matching, Match by hand, suggestions) opens GET bills/:billNo — software, register (photo link, adjusted), comparison, sale lines and bank credits, history.
  - Reading: an unreadable type is taken as F&B (amber "assumed", inferred bill_type); Compare sales lists assumed bills before confirming. A cell Claude could not read (amount/payment) gets a "Use ₹X?" hint from the software amount (and a bank credit of it near the bill's time); clearly read cells get none. Claude reads without seeing software or bank figures.
- Bring in redesigned (3 Nov 2026): a stepper (Sales report → Bank → Pages → Ready), step cards with a status icon, drop zones (tap or drop) with spinners while uploading/reading, a short CSV card (new bills, UPI/Card/Cash/Total pills, totals-match chip, covered period whole days by default with "change"), the drop area hidden while a file waits (Cancel), three page tiles (register/expenses/cash summary) that set the page type, and Day before/after.
