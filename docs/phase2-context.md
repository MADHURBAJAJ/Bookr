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

Proposed (needs approval): a "Software sales report" upload kind (table, no OCR); a comparison record per bill and shift (software values, register values, difference type: amount differs, payment mode differs, missing in register, missing in software; the decision, who made it, when); bill number and confirmed source on income rows.

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

## Still open

Unknown parties (default blank), OCR engine (test in Phase 2), weekly preset start day (Monday), cash and bank overlap (Transfer when amounts match), logo, part cash and UPI bills, whether Entry staff may upload the software CSV (proposed yes).
