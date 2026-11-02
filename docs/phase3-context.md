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

## Not yet (part 2 and later)

- Card company daily email (Gmail) and card settlement matching with fees.
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
