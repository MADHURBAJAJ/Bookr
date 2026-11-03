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
- Bills paid together: a worked-out discount is shared over the group's bills by amount (whole rupees when possible), never more than a bill's own amount; a tip stays on the paying row. Fill discounts redoes amounts it filled itself, never typed ones.
- Large discounts: a discount over 20% of the bill(s) (the group total for bills paid together) is never matched by itself. Compare sales shows "Large discount N%" with Accept discount (needs a reason), Payment missing · use software, or Leave out. Review shows such discounts in red with the %.
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
