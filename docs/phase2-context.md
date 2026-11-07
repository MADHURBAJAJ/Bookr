# Bookr: changes since the handover (read before Phase 2)

These notes override `bookkeeping-handover.md` where they differ. Nothing here is built yet. Items marked Proposed need Madhur's approval before changing the data model.

## Settled

- App name: Bookr. Backend: Cloudflare (Workers, R2, D1 (SQLite)).
- Money is stored as integer paise, never as floating-point numbers. It is converted to rupees only for display.
- D1 has no open transactions, so any work that must be atomic (linked transfer pairs, approvals, role changes, invites) runs as a single D1 batch, which commits or rolls back as one.
- All ten screens are designed in the prototype: https://claude.ai/artifact/MxGBWNinoQeH2nHL7HmWdv
  Newest screens: Compare sales (between Review and Bank sync), Reports, Export, Sign in, and an Accounts screen you added in Phase 1 (to be added to the prototype).
- Role table to follow (Owner, Accountant, Entry staff, Viewer):
  Upload photos: Owner, Accountant, Entry staff. Tag and edit draft rows: same three. Approve rows: Owner, Accountant. Link bank sheets and match UPI: Owner, Accountant. Edit heads and rules: Owner, Accountant. Export: Owner, Accountant. See reports and dashboard: Owner, Accountant, Viewer (not Entry staff). Manage users and businesses: Owner.

## Daily sales now start from the software report

Each day the user uploads a sales CSV from the hotel software. The handwritten bill register is then compared with it, and a person decides every difference (the app never picks a side). Only after that do UPI credits get matched to the bank.

Flow per shift: software CSV, register photo (OCR), compare by bill number, person resolves differences, confirmed sales become income rows, UPI matching against bank credits.

Approved on 2 Nov 2026. The tables are in **Phase 2 design** below.

### CSV format (one sample, 31-10-2026, 62 bills)

- Header row; columns SI.NO, POS.NO, DATE/TIME, BILL NO, NAME, SUBSIDY, MODE OF PAYMENT, BILL AMOUNT, DISCOUNT.
- DATE/TIME like `31-10-2026.09:17:38` (day-month-year, a dot, 24-hour time).
- MODE OF PAYMENT: UPI, CARD, CASH or U/N. One mode per bill. DISCOUNT was always 0.
- Bills are rows where SI.NO is a number. After them come blank lines and a footer (TOTAL BILLS, UPI, CARD, CASH, TOTAL SALE). Use the footer as a control total.
- Sample check: 62 bills; UPI 44,147; CARD 942; CASH 10,003; total 55,092. Bill rows add up to this.
- Bill number = date prefix YYMMDD plus a running number (2610311 = 31 Oct, bill 1). Keep as text. 7 of 62 bills carry a 30 Oct prefix but were paid on 31 Oct, so the prefix is not the payment date. Key on bill number; use DATE/TIME for the shift.
- Rows are not strictly in bill order.
- The file has both room and restaurant bills but no type column. The income type comes from the register.
- Do not store guest names (a few rows have a name, almost all show `U/N`).
- Amount 0 means complimentary: list apart, never a sale, never a difference.
- Part cash, part UPI bills: decided later. Until then they show as a payment-mode difference.

### Shift rule

Shifts run 8 am to 8 am. A report covers two calendar days, so cut by payment time. Shift of day D = D 08:00:00 up to, not including, D+1 08:00:00. In the sample, 7 bills before 08:00 (total 1,538) belong to the 30 Oct shift; 55 bills (total 53,554: UPI 43,038, CARD 732, CASH 9,784) belong to the 31 Oct shift, which is incomplete until the 1 Nov file (00:00 to 08:00) is added. Warn when a shift is missing hours at either end.

The register lists a bill only after it is settled, so a bill paid on 31 Oct appears in the 31 Oct register even if its number starts with 261030.

## Reports arrive by email (Gmail)

MakeMyTrip room bookings, the daily card settlement and the Djubo room software each email transaction reports. Madhur will give the app read access to his Gmail.

Proposed: read-only Gmail scope; fetch only mail from the three listed senders (ideally one label); tokens kept on the server only; each report saved as an unconfirmed import that a person approves; real Gmail only on the production site, with the demo site using sample report files; new tables for the connected mailbox and imported mails, not yet designed.

Phases: card settlement fits Phase 3 with UPI matching. MakeMyTrip and Djubo feed the later room payment check (Phase 6). Samples of these three reports have not been supplied yet. Google may expire the sign-in every 7 days until the app is verified; settle this before production.

## Where this lands in the phases

- Phase 2 (cash capture): register OCR, software CSV import, the shift rule, the Compare sales screen, approval.
- Phase 3: Google Sheet bank tabs, UPI matching, card settlement, saved rules, transfers.
- Phase 6 (later): room payment check using MakeMyTrip and Djubo.

## Settled defaults for later phases

Unknown parties: leave blank. OCR engine: test Google Document AI and Claude vision on real pages in Phase 2. Weekly preset: Monday to Sunday. Cash and bank overlap: treat as a Transfer when amounts match within a few days. Entry staff may upload the software CSV.

## Still open

- **POS series.** Can the software CSV hold more than one POS series, so that two counters issue the same BILL NO? Until this is answered, `pos_no` is part of every bill key.
- **Part cash, part UPI bills.** Until decided, they show as a payment-mode difference.
- **Logo.**
- **Gmail.** The tables for the connected mailbox and imported mails are not designed yet.

## Phase 2 design (approved 2 Nov 2026)

These are D1 tables. Money is integer paise. Times are integer milliseconds (UTC). Calendar days are `YYYY-MM-DD` text, and India time (UTC+5:30) decides which day and which shift a time belongs to. Every table also has `id`, `business_id` and `created_at`. Anything that must happen all at once runs as one D1 batch, and every decision, confirmation, reopening and override is written to `audit_log`.

**Test and demo data.** The real sales CSV is never loaded into the demo site or the repo. Tests and the demo use an invented CSV in the same format. It includes bills before 08:00, a bill whose number carries the previous day's prefix, a complimentary bill, `U/N` modes and names, and the footer.

### Shift rule

The shift of day D runs from D 08:00:00 up to, but not including, D+1 08:00:00. A bill belongs to the shift its payment time falls in. A shift is **complete** only when the coverage windows of the imported reports, joined together, span its whole window. Otherwise the app shows the missing hours at either end.

### `uploads`: one row per file

| Column | Type | Notes |
|---|---|---|
| kind | TEXT | `software_sales_csv`, `bill_register`, `expense_list`, `cash_summary`, `single_bill` |
| business_day | TEXT | The day picked on Upload |
| storage_key | TEXT | Where the file sits in R2. Photos are opened through short-lived links. For a CSV, only a copy with the NAME column blanked is kept. |
| content_sha256 | TEXT | The same file uploaded twice is refused. Unique per business. |
| status | TEXT | `uploaded`, `reading`, `ready`, `retake`, `approved`, `failed` |
| page_written_total_paise | INTEGER | The total written on the page, read by OCR. It is checked against the sum of the page's rows. |
| ocr_engine | TEXT | `document_ai` or `claude_vision` |
| uploaded_by | TEXT | User |

### `sales_reports`: one row per imported software CSV

| Column | Type | Notes |
|---|---|---|
| upload_id | TEXT | Links to `uploads` |
| covers_from, covers_to | INTEGER | The period the file covers. Defaults to the first and last payment times, and can be edited at import. A report may span more than one day. |
| first_paid_at, last_paid_at | INTEGER | As found in the file |
| bill_count | INTEGER | Bill rows found |
| footer_bills | INTEGER | TOTAL BILLS from the footer |
| footer_upi_paise, footer_card_paise, footer_cash_paise, footer_total_paise | INTEGER | The footer, used as a control total |
| bills_added, bills_skipped, bills_flagged | INTEGER | The import result (see overlapping files) |
| replaced_by | TEXT | Set when a corrected file replaces this one |

- **Control total.** If the bill rows do not add up exactly to the footer, the import is refused whole.
- **Corrected file.** A corrected file can replace an earlier report only while none of the shifts it touches is confirmed.

### `software_bills`: one row per bill in a CSV

| Column | Type | Notes |
|---|---|---|
| report_id | TEXT | The report it came from |
| pos_no | TEXT | POS.NO |
| bill_no | TEXT | Kept as text. Unique per business together with `pos_no` (see Still open). |
| si_no | TEXT | As in the file |
| paid_at | INTEGER | From DATE/TIME, read as India time |
| shift_day | TEXT | From `paid_at` and the shift rule |
| mode | TEXT | `upi`, `card`, `cash`, `unknown` (`U/N`) |
| amount_paise | INTEGER | BILL AMOUNT |
| discount_paise | INTEGER | DISCOUNT |
| is_complimentary | INTEGER 0/1 | Amount 0. Listed separately, never a sale and never a difference. |

NAME and SUBSIDY are not stored.

**Overlapping files.** When an imported bill already exists with the same `pos_no` and `bill_no`:
- **Identical values:** the new copy is skipped.
- **Different values:** the bill is flagged, never overwritten.

### `software_bill_conflicts`: flagged overlaps

| Column | Type | Notes |
|---|---|---|
| report_id | TEXT | The import that brought the different values |
| existing_bill_id | TEXT | The bill already stored |
| incoming_paid_at, incoming_mode, incoming_amount_paise, incoming_discount_paise | | The values in the new file |
| decision | TEXT | `keep_existing`, `use_incoming`, or empty while open |
| decided_by, decided_at | TEXT / INTEGER | Owner or Accountant |

A shift cannot be confirmed while any conflict on its bills is open.

### `shifts`: one row per 8 am to 8 am shift

| Column | Type | Notes |
|---|---|---|
| shift_day | TEXT | Day D. Unique per business. |
| status | TEXT | `open`, `comparing`, `confirmed` |
| confirmed_by, confirmed_at | TEXT / INTEGER | |
| reopened_by, reopened_at, reopen_reason | TEXT / INTEGER / TEXT | The last reopening |

- **Missing hours** are worked out from `sales_reports` coverage each time, not stored.
- **Reopening** a confirmed shift is Owner only and is audit-logged. In one batch it removes the income rows that confirmation created (their contents are kept in the audit log) and sets the shift back to `comparing`. It is refused once any of those rows has been matched to the bank or the card settlement.

### `register_rows`: one row per bill read from a register photo

| Column | Type | Notes |
|---|---|---|
| upload_id | TEXT | The photo it came from |
| line_no | INTEGER | Its position on the page, used to highlight the row on the photo |
| shift_day | TEXT | The register page's day. The register for day D is shift D. |
| bill_no | TEXT | As written |
| bill_type | TEXT | `fnb` or `room` |
| amount_paise | INTEGER | Bill amount |
| remarks | TEXT | Kept as written |
| status | TEXT | `draft` or `checked` |
| ocr_original | TEXT (JSON) | The values exactly as OCR read them, before any edit |
| edited_by, edited_at | TEXT / INTEGER | The last person to edit the row |

### `register_payments`: each payment on a register bill

| Column | Type | Notes |
|---|---|---|
| register_row_id | TEXT | Links to `register_rows` |
| mode | TEXT | `cash`, `upi`, `card` |
| column_label | TEXT | The column it was written in, such as "UPI XOXO" or "UPI Bank 2" |
| amount_paise | INTEGER | |

### `bill_comparisons`: one row per bill per shift

| Column | Type | Notes |
|---|---|---|
| shift_day | TEXT | |
| pos_no, bill_no | TEXT | Unique per business, shift, `pos_no` and `bill_no` |
| software_bill_id, register_row_id | TEXT | Either can be empty |
| sw_amount_paise, sw_mode, rg_amount_paise, rg_mode | | A copy of both sides at the moment of comparing |
| difference | TEXT | `match`, `amount`, `mode`, `amount_and_mode`, `missing_in_register`, `missing_in_software`, `complimentary` |
| decision | TEXT | `use_software`, `use_register`, `leave_out`, or empty while undecided. Only for real differences. |
| decided_by, decided_at, note | | |

If new data changes a bill after its decision was made, the decision is cleared and must be made again. The clearing is audit-logged.

### `bill_type_heads`: which income head each bill type uses

| Column | Type | Notes |
|---|---|---|
| bill_type | TEXT | `fnb`, `room` |
| head_id | TEXT | Set once by the Owner. Unique per business and bill type. |

### `cash_summaries`: one row per cash account summary page

| Column | Type | Notes |
|---|---|---|
| upload_id | TEXT | The photo |
| shift_day | TEXT | The day on the page. It is treated like the register: the summary for day D is shift D. |
| opening_paise, received_paise, balance_paise, expenses_paise, cash_in_hand_paise | INTEGER | As written on the page |
| ocr_original | TEXT (JSON) | As OCR read it |
| status | TEXT | `draft`, `checked`, `approved` |
| mismatch_note, mismatch_accepted_by, mismatch_accepted_at | | Needed to approve when a check below fails |

**Checks shown on the summary.** Each one must pass, or the mismatch must be accepted with a note by an Owner or Accountant:
1. opening + received = balance, and balance − expenses = cash in hand.
2. Opening equals the previous day's cash in hand.
3. **Received equals the confirmed cash total of the shift.** That is the sum of the confirmed income rows paid in cash for that shift.
4. Expenses equal the total of that day's approved expense-list rows.

### Expense list pages

Each line of an expense list becomes a draft expense row in `transactions`, paid from the Cash account, with `source = cash_photo`. It is tagged and approved in the Review grid like any other row. There is no separate table.

### `transactions`: first built in Phase 2

| Column | Type | Notes |
|---|---|---|
| account_id | TEXT | The Cash account for cash. Empty for UPI and card until they are matched. |
| day | TEXT | |
| amount_paise | INTEGER | |
| type | TEXT | `income`, `expense`, `transfer` |
| head_id | TEXT | |
| narration | TEXT | |
| source | TEXT | `software_report`, `cash_photo`, `bank_sheet` |
| status | TEXT | `draft`, `reviewed`, `approved` |
| payment_mode | TEXT | |
| upload_id, line_no | TEXT / INTEGER | For rows read from a photo |
| ocr_original | TEXT (JSON) | For rows read from a photo |
| bill_no, pos_no | TEXT | For sales |
| confirmed_source | TEXT | `software`, `register`, `both_matched` |
| comparison_id | TEXT | The decision that made the row |
| shift_day | TEXT | For sales |
| match_status | TEXT | `awaiting_bank_match` (UPI), `awaiting_card_settlement` (card), or empty |
| party_id, transfer_pair_id, matched_bank_row | | Present but empty until Phase 3 |

**Confirming a shift** is one batch: it creates the approved income rows, marks the shift confirmed and writes the audit rows. It is refused while any difference is undecided, any conflict is open, or the shift has missing hours.

### New permission actions (no new roles)

| Action | Owner | Accountant | Entry staff | Viewer |
|---|---|---|---|---|
| Import software CSV, upload photos, edit OCR rows | Yes | Yes | Yes | No |
| Decide differences and conflicts, confirm a shift, approve a cash summary | Yes | Yes | No | No |
| Reopen a confirmed shift | Yes | No | No | No |
| Set the income head for each bill type | Yes | No | No | No |

### As built (2 Nov 2026)

- **OCR: Claude vision is connected (2 Nov 2026).** "Read page" on Review sends the stored photo or PDF to Claude from the Worker and fills draft rows (`ocr_engine = claude_vision`, the full reading in `ocr_original`, with an `unclear` list per row shown as "Needs input"). Settings in `wrangler.jsonc` vars: `CLAUDE_OCR_MODEL` (default `claude-opus-5-5`), `OCR_DAILY_PAGE_LIMIT` (40 per business per India day, failures included), `OCR_MAX_PARALLEL` (3 at a time). The key is the `ANTHROPIC_API_KEY` Worker secret. Reads are recorded in `audit_log` (`ocr.read`), which is also how the cap is counted. The server-side refusal fallback (`fallbacks: "default"`) is on. Nothing read is approved: register rows stay drafts until checked, expense rows have no head until a person sets one, and a cash summary must be saved by a person before approval. Reading again replaces only unchecked rows. Typing rows in still works. `npm run ocr:accuracy` compares a read of the three invented pages with their known values. Document AI is not connected.
- **Using the software side for a bill missing from the register is refused.** The register gives every bill its type (F&B or Room), which decides the income head. The person adds the bill to the register in Review, or leaves it out. The same applies when the software's mode is `U/N`.
- **Confirming a shift also needs:** every register row checked, no bill repeated in the register, and each register bill's payments adding up to its amount.
- **One income row per register payment.** A bill paid partly in cash and partly by UPI that is decided "Use register" becomes two income rows.
- **Matching register to software uses bill number only.** The register has no POS number. With a single POS series this is exact; if a second counter appears, this must be revisited (see Still open).
- **Coverage uses one-second resolution.** A report covering up to 23:59:59 meets one starting at 00:00:00.
- **Photos are served only through the Worker,** after the role check, with `Cache-Control: no-store` and a sandbox Content-Security-Policy, instead of signed links. Only JPG, PNG and PDF are accepted, checked from the file's first bytes.
- **Database triggers lock a confirmed shift.** Its register rows, software bills and decisions cannot change, and it cannot be confirmed twice, whichever request runs first.

- **Bills paid together (approved 2 Nov 2026).** One payment written on one register row can cover several bills: the other rows point to it with `register_rows.paid_with_row_id` (same shift, no chains, no payments of their own). The group balances when its bills, after discounts and tips, equal the one payment; the difference is filled on the row holding the payment. For comparison and confirmation each bill counts as paid in the group's single mode for its own amount, so each matches its own software bill and becomes its own income row. Read page marks bracketed shared payments. **Phase 3 must allow one bank credit to match a group of register bills.**
- **Discounts and tips on register bills.** `discount_paise` and `tip_paise` (both whole paise, never negative), shown as one signed "Disc / tip" figure. A bill balances when payments equal amount − discount + tip; Compare sales uses that figure.

- **Matched after a discount or tip (approved 2 Nov 2026).** A register bill with a discount or tip counts as matched when the software shows its amount before them (or the received amount). No decision is needed; confirmation books the register's received amount (`confirmed_source = register`), which is what Phase 3 bank matching looks for. The payment mode must still agree. Compare sales lists these bills.

- **Cash for a shift (approved 2 Nov 2026).** A panel at the bottom of Compare sales (and under the cash summary page on Review): opening (previous day's cash in hand, else the page's opening) + confirmed cash sales − approved cash expenses − booked shortage = should be in hand, against the counted cash in hand. A difference is accepted with a note (Owner or Accountant; audit-logged, valid only for that exact difference) or, when short, booked by an Owner as an approved Cash expense under "Cash shortage" (`transactions.source = cash_shortage`, migration 0009). A cash bill missing in the register can be left out only with a reason. Cash bills not in the register are listed on the panel.

- **Vendors under heads (approved 2 Nov 2026).** The handover's `parties` table (migration 0010): each vendor (e.g. Blinkit) is remembered under a default expense head (e.g. Kitchen purchases), with other spellings in `aliases`. Expense lines name their vendor (`transactions.party_id`); the first head chosen for a new vendor is remembered, and later lines from it, named or found in the item text, get that head filled in ("Learned", a person can change it). Read page reads the vendor and uses known vendors. Moving or renaming a vendor is Owner or Accountant work (Heads and rules → Vendors), audit-logged. This brings the Phase 3 "party master" forward for expenses.

### New Cloudflare resource

An R2 bucket for photos and redacted CSVs, `bookr-demo-uploads`, on the free tier.
- A vendor can be used under several heads (no data-model change: worked out from past lines). One head so far: it is filled in. Several: the head of an earlier line with the same item (or same first word) is filled in, marked Learned; a new item gets one-click choices of the vendor's heads. The vendor's first head stays its main head; Heads and rules lists the vendor under every head it is used with, with line counts.
- Expense review: the Head dropdown has "+ New head…" (Owner/Accountant). It opens Heads with the new-expense-head form and a way back; adding the head returns to the line with it chosen, and Cancel or Back restores the line as typed.
- "Vendor" is shown as "Party" everywhere (shops, staff paid salary, owner drawings); stored as parties already, so wording only.
- Review: an expense list or cash summary page can be moved to another day ("Page is for"); its lines move with it. Once approved, only Owner/Accountant can move it. Audited as upload.day_changed.
- Until 7 Nov 2026 (replaced, see "Group discounts" at the end): bills paid together: a worked-out discount is shared over the group's bills by amount (whole rupees when possible), never more than a bill's own amount; a tip stays on the paying row. Fill discounts redoes amounts it filled itself, never typed ones.
- Until 7 Nov 2026 (replaced, see "Bills paid together match on their total" at the end): large discounts: a discount over 20% of the bill(s) (the group total for bills paid together) is never matched by itself. Compare sales shows "Large discount N%" with Accept discount (needs a reason), Payment missing · use software, or Leave out. Review shows such discounts in red with the %.
- One-sided bills followed across days (migration 0011): decision carry_forward; linked_to_id joins a late arrival to the same bill on another day ("Already counted on D" / "Count here · matched with D"); a bill is never counted twice (refused on decide, blocker on confirm); left-out bills that reappear need a new reason; watch list "Bills waiting for their other side" (Compare sales, dashboard), closable with a reason by Owner/Accountant after 7 days.
- Bills paid together can run across register pages of the same shift: Review lists other pages' rows ("Paid with page 2 · row 4"), checks the whole group, links to the other page; Fill discounts spreads over the group across pages.
- Register-only bills in bulk (e.g. pending bills of an old POS): tick on Compare sales, "Use register for N selected" with a reason; counted from the register and closed at once (no software bill expected). Skips bills with no payment, a large discount, or already counted on another day. Audited.
- Bills only in the software report (approved 2 Nov 2026): on Compare sales, "Add to register · F&B / Room" writes the bill into the register on the shift's page "Added from software report" (no photo; amount and mode from the software; remarks and ocr_original.source mark it); the bill then matches. Open shifts only (a confirmed shift needs an Owner reopen). Cash ones still show in the cash check as not written by staff; for other days the bill counts as counted on its software side (no double counting). Deleting the line undoes it.

## Reading register pages (November 2026)

- **Grid first.** Claude returns the printed column headings and, for every line, one cell per heading (`RegisterGrid` in `src/ocr.ts`). Bookr maps each heading to its meaning (`headingRole`: bill no, amount, type, discount, cash, UPI, card, remarks; unknown headings such as Closure time are ignored) and builds the bill rows (`gridToReading`). If the headings cannot be told apart, the hotel's usual order is used (`DEFAULT_HEADINGS`). A discount written in the remarks ("Disc 20") is used as the discount. No data model change: the grid line is kept in `ocr_original.grid`.
- **Short bill numbers.** A number that exactly one bill of the shift's software report ends with, and that no other register line of the shift has, is completed (`inferred: bill_no`, `ocr_original.completedFrom` = what the page says; amber "Completed from software"). Several candidates: left as written, red.
- **Red when nothing explains a difference.** Payments are marked unclear when: a discount is written but the payment still differs; a worked-out discount is over 20% or a tip over 10% and no remark mentions it (disc, tip, less, off, comp, NC, round, KOT, credit, due); or a bill has no payment, no bracket and no remark.
- **Payments a line off.** `findSlip` finds lines in a row where each payment fits the next line's (or previous line's) bill amount, allowing an ordinary discount (up to 20%) or tip (up to 10%); at least two of them must not fit their own bill. Often the payment is written a line lower on the paper itself, so reading as a grid alone does not catch it. Those lines are red, and Review offers "Shift them back": `POST /uploads/:id/shift-payments {direction}` moves the payments in one step (unchecked rows only), works worked-out discounts out again, leaves the line with the odd payment red, and logs `register.shift_payments`.
- **Check reading accuracy (Owner, Bring in).** `GET /ocr/accuracy-pages` lists register pages whose rows are all checked; `POST /ocr/accuracy/:uploadId` reads one again and returns counts only (right / wrong-red / wrong-amber / wrong-unmarked per field, first reading vs now). Rows changed on UPI matching are left out of Amount and Payments (they follow the bank, not the page). Nothing on the page changes; each page is one read toward the daily limit (`purpose: 'accuracy'` in the audit entry).

## Review of a register page (November 2026)

- The table runs in the paper's column order: # · Bill no · Amount · Type · Cash · UPI XOXO · UPI Bank 2 · Card · Disc · Remarks · Issue · ✓. A payment's column comes from its mode and, for UPI, its heading (`colOf`); two payments in one column are shown summed and read-only (✎ edits them).
- One plain "Issue" per row (`rowIssues`): red = needs a person (unread cell, bill not in the software report with "did you mean" chips, payments not adding up, discount over 20%, software amount hint); amber = filled in by Bookr (bill number completed, type assumed, discount worked out, payment moved). Only the cell at fault is underlined.
- Top bar: checked count and progress, page-total and payments chips, "Needs you / All" filter, Next issue. Keyboard: Enter ticks the row and moves to the next unticked one; ↑ ↓ move between rows.
- Photo strip: the page turned upright (from the reading's orientation; ⟳ turns it by hand), zoomed to the current row's line. The line's place comes from the reading (`ocr_original.y`, % of page height, asked of Claude from November 2026); for older readings it is estimated, and scrolling over the strip lines it up (remembered per page in the browser). "Whole page" shows the full photo beside the table instead.
- Read page again, Open photo and Delete are in the ⋯ menu. On phones each row is a small card.
- Two bills on one line of the page: ＋ on a row adds a blank draft line just below it (`POST register-rows/:id/insert-below`); later lines move down one and the new line uses the same place on the photo.
- A bill number on more than one line of the shift (this page or another) is red: "Bill X is also on row N".
- A group paid together ends with a total line: "Group of N bills: ₹ bills · paid ₹ paid", green when they match, red with how much over or short.
- The table ends with the page's bottom line (approved 3 Nov 2026): "Rows add up to" per column (amount, cash, UPI XOXO, UPI Bank 2, card, discount) and "Written on the page" under it. Claude reads the written totals from the total line (`total_cells` in the grid, stored as JSON in `uploads.page_column_totals`, migration 0016); people can correct them (`PATCH uploads/:id` with `columnTotals`). Each column is green when it matches and red with the difference when not.
- A page read before 3 Nov has no column totals (`page_column_totals` NULL): on its first open Review reads only its total line (`POST uploads/:id/read-totals`, one read against the daily limit) and stores the totals, or `{}` when there is no total line, so it is never read twice. A full read now always stores `{}` or the totals.
- Deleting a register line asks why (written twice, not on the page, not a bill, cancelled, other + note). The line's bill, amounts and payments go to audit_log (`register.delete`) and come back as `deletedRows` on the page. A column total that differs from the written total only by deleted lines is amber with the reason, not red; the deleted lines are listed under the totals.
- The total written under Bill Amt on the paper is what was paid in all modes, so the totals row compares it with all payments added up (bill amounts shown underneath).
- Old POS bills are 6-digit numbers (`isOldPosBill`): never in the software report, so Review shows "Old POS bill" instead of "Not in software report", and they are left out of the bills-waiting lists.
- The Review pager numbers pages within the day ("Page 2 of 3"); Previous and Next carry on into other days.
- Until 6 Nov 2026, old POS bills on the register were decided 'use register' automatically on comparison (approved 3 Nov 2026; replaced, see Bill number formats), once their payment is written and the discount is not large; audit_log 'comparison.decide' with user NULL and oldPos.

### Compare sales: one-sided bills and bank credit (approved 3 Nov 2026)
- A bill on one side only (missing_in_register / missing_in_software) is decided by Bookr on comparison (`decideOneSided`, audit 'comparison.decide' with user NULL and `auto:true`): software-only bills paid by cash, UPI or card are 'use software' as F&B; register-only bills with a payment written and no large discount are 'use register'. It waits for its other side for 7 days, as before.
- When the other side turns up on another day and the first one was counted, the new one is left out with "Already counted on <day>" and linked, so it is never counted or matched with the bank twice. People can change any of these decisions.
- A cash bill only in the software report shows a warning on the shift ("check the cash"); it is still counted.
- UPI bills on one side only (not linked to another day) are confirmed with status 'reviewed' and `ocr_original.countOnCredit`: not counted until UPI matching matches a credit, then approved and moved to the credit's shift day (`settleOnCredit`, run after every bank change). Unmatching puts them back. Cash and card one-sided bills count on the bill's day (card settlements are not matched per bill).
- A shift can be confirmed before its bank credits arrive. The Compare page has tabs: This shift, Waiting for other side, Waiting for bank credit (`GET awaiting-credit`: confirmed UPI sales not yet matched).

### Compare sales with the bank (approved 5 Nov 2026)
- While a shift is open, each UPI bill (either side says UPI) is paired with an unmatched UPI credit of the same amount (`src/bankEvidence.ts`): within 60 minutes of the software time, closest first, each credit once; a register-only bill (no time) only when it and a credit inside the shift are each other's only choice. Bills paid together are left to UPI matching.
- Where the credit settles a mode or amount difference, the side it equals (and that says UPI) is suggested: outlined with a "bank" tag, and "Accept N bank-backed choices" saves them with the note "Bank: ₹X came in at …". Nothing is decided without a person; no suggestion for a large discount; no credit suggests nothing.
- "Bank in" when the latest UPI line reaches the shift's end (as the explainer). Credits inside the shift with no bill of that amount are a warning only.
- Confirming matches each credit shown to its bill's income row, when the bill is counted as one UPI payment of the credit's amount, as the person confirming (audit 'bank.match', how: matched on confirming the shift). Each match gets its own time so Unmatch undoes one. settleOnCredit runs in the same batch.
- Explainer: one credit for a table (2 to 10 bills within 45 minutes, exactly one set fits) → match-set. ("Round the bill" was built and then removed on 5 Nov 2026, to be discussed again.)
- Review: a row that becomes a group's head for the first time loses a Disc equal to its own amount minus its own payment (the figure Review filled for it alone), so the group is not counted twice.

### Reconcile (approved 5 Nov 2026)
- One screen per shift (`#/b/:id/reconcile/:day`, `GET shifts/:day/reconcile`, `src/reconcile.ts`) in place of UPI matching; old `/upi` links open it. Bank sync keeps money out, rules, and booking any line under a head; its money-in tab points here.
- Strip: UPI counted, matched to the bank, bills not matched, credits not matched (inside the shift). Bills and credits are shown apart, not added: the same money can be on both sides. "Bank reconciled" when both are 0 and the bank is in.
- Lanes: Clear (the clear pairs of this shift's bills, ticked, `match-clear`); Fix and match (explainer cards, with Software / Register / Bank side by side and the mistake struck out, `Card.witnesses`); Needs you (same amount up to 3 hours apart, unticked, each bill and credit once, with how many other matches fit; then Match by hand); Missing (bills with no credit from the explainer; credits with no candidate, booked as Unbilled F&B / Room or another head on Bank sync). Done lists matches with Unmatch and booked credits with Put back.
- Compare's bank evidence follows the same rule as matching: the credit's account label must fit the register's UPI column (`labelFits`).

### Review: issue cards (approved 5 Nov 2026)
Above the rows of an unlocked register page, cards for what Bookr can see clearly but a person must agree to; nothing changes until a button is pressed. Bill written twice with one amount: the later line is struck (unless the earlier has less on it), and either can be deleted as written twice. Same number with different amounts: both shown, no strike, with the software report's amount when there is one. Bills paid together that are short by exactly a member's amount: both or all such members shown, none struck, each can be taken out of the group. A row holding a group's payment is never offered for deleting, since its bills would lose it. "Not this" hides a card in this browser (the row stays red). "Tick the N clean rows" ticks unticked rows with nothing red or amber; it is one click by a person, not an automatic check. A toggle, "As on the register", hides cards and the tick button and leaves the paper-layout page; it is remembered per browser.

### Bill number formats (approved 6 Nov 2026)
New POS numbers are YYMMDD plus an unpadded running number, so 7 to 9 digits. Old POS numbers are 6 digits, and a 6-digit number that is a real date is treated as a new number cut short. A register number of neither format (a short "230") can never meet a software bill, so it is not counted automatically and does not wait: it stays in To decide, blocking confirm, until a person corrects it on Review, marks it "Old POS bill, short number" (counted from the register and closed, nothing to type) or leaves it out. Bills of that kind decided before this rule leave the waiting list and appear in their own card on Compare, where they can be closed the same way. The rule is for register numbers only: the software report is taken as written. The date inside a number is not used to call a bill wrong, since valid numbers can sit a day or more off their shift.
Old POS bills are also confirmed by a person from 6 Nov 2026, replacing the automatic counting approved on 3 Nov: a typo can still look like a valid old number, and no software bill will ever check it. They stay in To decide with "Use register" or "Leave out", and can use the register only once their row is reviewed (the server refuses before that), one at a time or with "Select N reviewed old POS" for many at once. Short numbers follow the same rule. Decisions Bookr already made stay until changed.
Typo flags (`numberFlags`, also 6 Nov 2026), for a register number with no exact software bill of its shift, shown on the Review row and the Compare row until a person decides the bill. Nothing is applied by itself. (1) The number with a date prefix (the shift's date, the next or previous day; it may already hold the end of the date, so "110157" is 26110157) equals a software bill with no register line and the same amount, in this shift or still waiting on an earlier one. (2) The number is one digit off such a bill, same amount. (3) A prefixed number fits that date's running numbers. (4) A new POS number is past its date's last running number. (3) and (4) only speak when reports cover that date, midnight to the end of its shift, since the top of the range grows until then. A new POS number with a flag is not counted automatically, and flagged rows leave the bulk choice. A bill Bookr already counted before a flag appeared stays counted, with a warning on Compare. Still not caught: one old POS number misread as another, and a typo that lands on another valid number with a different amount or no date prefix nearby.

## Reconcile: cards, trial and all unmatched (approved 6 Nov 2026)

- **Suggestions / All open entries** toggle on a shift (remembered per device). Cards carry a reason tag, "Match all N" takes one click, and what Bookr did can be undone from the message at the top. The "Was cash / Was card" card stays, highlighted when the shift's cash fits exactly.
- **Trial reconcile** (`trialReconcile`): `GET shifts/:day/reconcile` on a shift not confirmed yet works the picture out fresh from `shiftView` and saves nothing. Clear pairs are matched by confirming. Corrections change the register row itself. It is optional: Compare shows a warning, and it never blocks a confirm. Roles are unchanged.
- **Earlier open shift first** (`creditsForShift`): a credit near the shift change goes to the previous shift if that shift is not confirmed and its pairing used the credit. One level back only.
- **All unmatched** (`/reconcile/all`, `GET /unmatched`): every shift's leftovers grouped by age (today and yesterday, 2 to 7 days, over 7 days), with search. An opened row gives why it is open, its source, the closest possible matches and the actions.
- **Closed bills** (migration 0017, table `closed_bills`): `POST sales/:txId/close` needs a reason, `sales.decide` (Owner, Accountant) and a bill past `WATCH_DAYS`. It clears `match_status`, so the chase stops, and the sale stays in income. `POST sales/:txId/reopen` puts it back. Both are in the audit log. A table is used rather than a new `match_status` value because changing that CHECK means rebuilding `transactions`.

## A credit booked directly, and its bill later (approved 7 Nov 2026)

`src/sameSale.ts`. A UPI credit booked under a head a bill type uses, and a bill of the same amount from the watch after it (or the day before), get a card; a person says "Same sale". Never joined automatically; small amounts with more than one bill of the amount get no card.
- **Result:** the booking is removed, the credit is matched to the bill, and the sale counts on the **booked day**, so that day's total does not move. The head follows the bill.
- **Undo:** Undo and Unmatch both put the booking back from the audit entry `bank.same_sale`, and the bill goes back to its shift's day, waiting.
- **Before confirming:** there is no sale yet, so `bank.same_sale_planned` in the audit log records the wish (`bank.same_sale_unplanned` cancels), the same way `sale.repaid` is read as current state. The confirm joins them in its batch. No table or column was added.
- **The other order:** the screens book with `checkBills: true`; if a bill of the amount waits within the watch, the server answers `waitingBills` and books nothing until the person says go on.

## Group discounts, on the row with the payment (approved 7 Nov 2026)

The register writes a group's discount once, on the paying row, and it may be more than that row's own amount. Typed, read from the photo or worked out by Fill (`onPayingRow`), it stays there. The limit is the group's bills (`checkDiscount`); a bill cannot shrink, leave or be deleted if the discount would then pass the group. For each bill's figures, `spillGroupDiscount` counts the paying row as nil and takes the rest off the other bills, largest first: nothing goes negative and the group adds up to the payment. A nil row has no sale line. A bank correction on a confirmed shift still shares over the bills (`spreadDifference`), and refuses a group with a nil row.

## Bills paid together match on their total; large discounts need no decision (approved 7 Nov 2026)

- **Total match** (`groupMismatch` in `src/sales.ts`): a group is matched when what was paid equals the software's total, as it stands or before the discount (the software may not have the discount). Every bill must be on both sides, the software must show the group's one mode, and the payment must balance the bills after discount. Each bill stays its own comparison; matched ones are `match`. A group that fails keeps its bills' own differences, decided bill by bill.
- **Compare sales**: bills paid together show as one line with the totals and the reason (`paidGroups`, `groupId`); opening it shows each bill. Matched groups sit under "Paid together, total matches", and a bill whose own figures differ is marked there.
- **Booking**: when the software total equals the payment, each bill is booked at the software's figure, so Room and F&B split as billed. When the software lacks the discount its figures add up to more than was paid, so the register's figures are booked (the discount comes off the paying row first, then the largest bills).
- **Large discounts** (over 20%, `LARGE_DISCOUNT_PCT`) no longer need a decision or a reason on Compare sales, for single bills or groups, and do not stop a register-only bill being counted. Reports lists them (`GET /reports/large-discounts`, `reports.view`), one line per payment. Review still flags them on the row, and reading a page still marks one as unclear, because those are for checking the row against the photo.
- **Paid several ways** (approved 7 Nov 2026): a group's payment may be split, e.g. cash and UPI. The bills take the payments in turn (card, then cash, then UPI; `sharePayments`), so a bill can have part of two and its income rows follow. The totals by mode stay right; which bill took which mode is only a working. In a total match the software's mode for each bill must be one the group was paid in.
- **One button on the group line**: "Use register for N bills" counts a group's bills that no software report will have, through `register-only`. It takes the same bills as the bulk tick boxes (old POS and short numbers, reviewed, not flagged); anything else stays to decide inside the group.
- **Bank on the group line** (`pairGroups`): while a shift is open, the group line shows the first unmatched UPI credit in the shift equal to the group's UPI total (a split payment looks for its UPI part), each credit once and none a single bill has taken. It only shows; it matches nothing.
- **Bills paid in several goes** (7 Nov 2026, `pairEvidence`): a bill whose register has several payments pairs each UPI payment with its own credit of that amount, within an hour of the bill (or the only such credit in the shift when it has no software time). All or none. Compare sales shows "Bank ₹ a + ₹ b", the trial reconcile lists one line per credit, and confirming matches each credit to its payment's sale.

## Wrong UPI column (approved 7 Nov 2026)

A UPI payment written under one account's column (e.g. "UPI Bank 2") whose money came into another account (UPI XOXO)
never matches, because a column that names an account only matches that account's credits. `src/columnHints.ts`
finds these: each shift's UPI payments first take credits in their own column's account (closest to the bill's
software time, within an hour; without a time, only the one credit in the shift); a payment left with none is offered
an unmatched credit of the same amount in another account. Each credit once.

- Review (row note), Compare sales (beside the bank chip, also on a group line) and Reconcile (a card) show it, with a
  button that changes the column. On a confirmed shift Reconcile's button changes the column and matches the credit in
  one step. Undo puts the match and the column back. Nothing changes by itself.
- `POST /businesses/:id/register-payments/:paymentId/column` (bank.link): the label must be an account's UPI label
  (case and spaces ignored); recorded as `register.column_changed`. Register payments are not locked on a confirmed
  shift, so no reopening is needed.
- Only Owner and Accountant: the shift and Review routes send hints (and Review's bank time on an unclear amount) only
  to roles with bank.link. Entry staff get none.

## Register slips the bank explains (approved 7 Nov 2026)

`src/slips.ts`. For each credit with no bill (Compare's "no bill of that amount", Reconcile's no-bill credits), Bookr
tries corrections on single bills (not paid together) paid within an hour by the software's time:
- a payment left out, often written as a discount (₹8 received, written as ₹8 off): add a UPI payment of the credit;
- one UPI payment written wrong (282 written 218; digit swaps rank first), when no credit of the written amount came.
It is offered only when the bill then equals the software. The bill's other UPI payments are paired with their credits
too (the ₹210 of 210 + 282). Each credit and each bill once, closest first.

- Compare sales: on the bill's row ("Bank 282 + 210 fits if 218 → 282, no discount" + Correct the register), and the
  credits it explains leave the "no bill" warning. Reconcile: a Register slip card; the no-credit/no-bill cards it
  explains are hidden. Owner and Accountant only (bank.link); entry staff get none.
- Before confirming the button edits the register row (PUT), with undo. After confirming,
  `POST bank-rows/:id/slip-fix {day, key}` works the correction out again, records each change in
  register_bank_adjustments under the credit (an added payment or sale is recorded as target_id with
  after_text 'added', which undo deletes) and matches the credit(s). Unmatch puts everything back.

## The bill drawer edits the register line (7 Nov 2026)

Clicking a bill on Compare sales opens the bill drawer instead of going to Review. For people with rows.edit it shows
the photo strip of the register line and the row's fields (bill no., amount, discount, the four payment columns,
"1000 + 500" for two payments) with Save; the page under it reloads and an undo toast shows. A confirmed shift's line
is shown locked. Review stays the page-by-page entry screen. Toasts now float at the bottom on pages without a
message line.

## One shift, three tabs (7 Nov 2026)

The left menu has one **Shifts** entry instead of Review, Compare sales and Reconcile. Each of the three shows the
shift bar at the top: ‹ day › and the tabs 1 Register · 2 Compare sales · 3 Reconcile (each only for roles that may
open it), with what is left from `GET shifts/:day/progress` (rows to check, bills to decide, UPI bills and credits not
matched: the bank counts only for bank.link).

The day last worked on (any of the three, or a Review page) is remembered per business on this device
(`bookr.day.<biz>`), and so are the sheet last opened (`bookr.sheet.<biz>`) and the tab last used. Shifts opens the
last tab on that day; the Register tab opens the sheet last opened if it is of that day, else the day's register page
(`#/review?day=`), else the last sheet. Changing the day in the bar keeps the tab. The list of all pages is still
reachable from Review's own links.
