# Proposal: easier bank reconciliation on top of bank-backed Compare sales

Design only, 3 Nov 2026. Follows [bank-credits-in-compare.md](bank-credits-in-compare.md). No code. Screen designs
are on the published page (same content); every figure in them is a made-up example.

## Why reconciling gets easier once Compare sales uses the bank

Today two separate passes look at the same credits:

1. Compare sales decides each bill **without** the bank.
2. A day later UPI matching and Bank sync look for each bill's credit **again**, and repair what Compare sales got
   wrong on a locked shift (Fix the bill, Change the bills, Paid another way).

With bank-backed Compare sales, pass 1 has already paired most credits with bills, and the corrections have been made
on the register while it was still open. So the reconcile step only has to:

- **accept what Compare sales already paired** (one click per shift),
- **explain what is left**, which is now small and mostly the genuinely odd cases.

The aim: every shift ends with **"Bank reconciled: ₹0 left to explain"**, and reaching it takes a few clicks.

## The cases to handle (from what was matched by hand on 2 Nov)

Every feature built on the evening of 2 Nov came from a credit that had to be matched by hand. These are the cases, and
the evidence that settles each one. "SW" is the software report, "Reg" the register, "Bank" the credit.

| # | Case | SW says | Reg says | Bank says | Who is wrong | Fix (all exist today, recorded and reversible) |
|---|---|---|---|---|---|---|
| 1 | Plain | UPI ₹500 | UPI ₹500 | ₹500 at bill time | nobody | match |
| 2 | Real discount | UPI ₹500 | UPI ₹450 (₹50 off) | ₹450 | nobody | match |
| 3 | Discount written by mistake | UPI ₹500 | UPI ₹450 (₹50 off) | ₹500 | register | remove the discount, match |
| 4 | Real tip | UPI ₹500 | UPI ₹540 (₹40 tip) | ₹540 | nobody | match |
| 5 | Register amount slip (₹5,000 for ₹500) | UPI ₹500 | UPI ₹5,000 | ₹500 | register | use software, correct register |
| 6 | POS amount wrong | UPI ₹5,000 | UPI ₹500 | ₹500 | software | use register, note for the manager |
| 7 | Register wrote cash, guest paid UPI | UPI ₹500 | cash ₹500 | ₹500; cash short ₹500 | register | UPI, match |
| 8 | POS said UPI, guest paid cash | UPI ₹500 | cash ₹500 | nothing; cash right | software | cash |
| 9 | POS said cash, guest paid UPI | cash ₹500 | UPI ₹500 | ₹500 | software | UPI, match |
| 10 | Both wrote cash, guest paid UPI | cash ₹500 | cash ₹500 | ₹500 near bill, no other bill; cash short ₹500 | both | suggest only, a person decides |
| 11 | Card written, UPI paid | card ₹500 | UPI ₹500 | ₹500 | software | UPI, match |
| 12 | Wrong UPI column | UPI ₹500 | UPI XOXO ₹500 | ₹500 into a UPI Bank 2 account | register column | move payment, match |
| 13 | Bill number typo (halves) | 4712 ₹500, not in Reg | 4721 ₹500, not in SW | ₹500 near 4712's time | register number | join halves, match |
| 14 | Paid in two goes | UPI ₹2,000 | UPI ₹2,000 | ₹1,500 + ₹500, same payer | register payments | write two payments, match both |
| 15 | One payment for a table, not bracketed | 3 bills ₹400 + ₹350 + ₹250 | 3 separate bills | ₹1,000 once | register grouping | mark paid together, match |
| 16 | Bill on one side only, real | UPI ₹500 | missing | ₹500 | register | counted on the credit's day, match |
| 17 | Credit late or across 8 am | UPI ₹500, 7:50 am | UPI ₹500 | ₹500 at 8:20 am | nobody | match across shifts |
| 18 | Guest paid twice | UPI ₹500 | UPI ₹500 | ₹500 twice, same payer, minutes apart | nobody | match one; other: refund due or tip |
| 19 | Money with no bill | missing | missing | ₹300 | both | Unbilled F&B / Room, or Not a sale |
| 20 | Credit card on UPI (fee debit follows) | UPI ₹500 | UPI ₹500 | ₹500 in, fee out | nobody | match; fee to bank charges by rule |

The rule of thumb behind every row: **three witnesses; when two agree, the odd one out is the mistake**. Where all three
disagree, or only the bank speaks, a person decides.

(I took these cases from the features and notes written on 2 Nov, not from the live bank data. Reading the actual
matches made by hand would mean looking at real data, so I have not done it; see the questions at the end.)

## The improved matching, step by step

Every step only works on what earlier steps left. Every suggestion carries its **case** (from the table), its
**evidence** in words, a **score**, and the existing reversible action it calls.

### Step 0: Tidy the bank lines (as today, a little more)

Pair reversals and UPI card fees (today), leave out lines a saved rule marks as transfers between own accounts, and set
aside credits from known parties that are not sales (supplier refunds, owner deposits). These never compete for bills.

### Step 1: Take over what Compare sales paired

The credit used as evidence for a bill's decision before confirming is the first suggestion for that bill: **Clear**, no
further checks, as long as the credit is still unmatched. This is most of the shift.

### Step 2: Plain pairs

Same amount, account fits the register column, within 60 minutes of the software time, one credit per bill paired by the
closest time (today's rule, unchanged).

### Step 3: Correction cases (2 to 13)

For each bill left and each credit left, test the cases in the table. A case is only offered when its evidence is all
there (for example case 3 needs the credit to equal the bill amount before discount, and no other bill of the credit's
amount within 60 minutes).

### Step 4: Combinations (14, 15, 18)

- Two goes: two or three credits from one payer within 30 minutes, adding up to one bill (today).
- One credit for several bills: two to four bills within 45 minutes of each other, not already paid together, that
  add up exactly to one credit. Offered only when one set fits; two sets that fit → a person.
- Paid twice: two equal credits from one payer within 15 minutes and one bill → match one, list the other.

### Step 5: What is missing (8, 16, 19), only when the bank is in

The bank is in for a shift when every UPI account's lines reach 3 hours past the shift's end. Then: a UPI bill with no
credit → "Was cash / Was card" (cash first when the cash check is off by exactly that bill); a credit with no bill →
"Unbilled F&B / Room" or "Not a sale".

### Step 6: Across shifts (17)

Credits up to 3 hours after 8 am may belong to the shift before; bills still waiting up to 7 days (the watch) are looked
for in later days' credits, with a lower score.

### The score

| Evidence | Points |
|---|---|
| Amount equals exactly | needed (no points without it; two-goes and table sets: the sum) |
| Within 5 / 20 / 60 / 180 minutes of the software time | +40 / +30 / +15 / +5 |
| Register-only bill (no time): credit inside the shift | +10 |
| Account fits the register column | +10 (does not fit: −20, case 12 only) |
| Two witnesses agree on the amount (SW = Reg, or the credit equals one of them) | +20 |
| Cash check off by exactly this amount, the right way | +20 |
| Same payer paid a bill here before with this kind of case, and it was accepted | +5 |
| Payer's note has the bill or room number | +15 |
| Another bill fits this credit about as well (within 10 points) | −30 |
| Needs a change to the books (cases 3, 5, 6, 7, 9, 11, 12, 13, 15) | −10 |

**90 and above: Clear** (ticked, matched in one click). **70 to 89: Likely** (shown with what will change, a person
ticks). **Below 70:** only in Match by hand, best first. Cases 6 and 10 are never Clear, whatever the score: a person
always looks when the POS or both sides are wrong.

### Learning from what people match by hand

Every hand match is already in the history. Each one gets its case written next to it (in the history note, no new
table). Then once a week, for the Owner:

- **How often each case was accepted** when suggested, and how often a person matched it by hand without a suggestion.
  A case accepted at least 19 times out of 20 can be **moved up** (its Likely ones become Clear), only with the Owner's
  OK on a screen made for this.
- **Who pays often**: payers (UPI IDs) seen before, with the bill type they usually pay (room guest, F&B). This adds the
  +5 above and fills in Unbilled F&B / Room.
- **Where the register goes wrong**: for example "UPI XOXO written for UPI Bank 2: 6 times this week". Shown to the
  Owner to tell the staff; it also lowers the column penalty for that mistake.

## Screens

Published page shows each one drawn out.

1. **Compare sales, with the bank**: banner (is the bank in), a Bank column with a chip on each bill, the ordered "to
   decide" list, one "Accept N bank-backed choices" button.
2. **Reconcile (one screen per shift, replacing the split between UPI matching and Bank sync money-in)**:
   - a balance strip at the top: UPI counted vs bank received, and "left to explain" in rupees, going to ₹0;
   - **Clear** (ticked, one button), **Fix and match** (cards with the three witnesses side by side and the odd one
     out marked, and the exact change in before → after form), **Needs you** (side-by-side by hand, as today),
     **Missing** (bills with no credit, credits with no bill);
   - a Done list at the bottom with Unmatch on each.
3. **The fix card**: three columns (Software, Register, Bank), the one that differs struck through, the reason in one
   line, the change, and two buttons: the fix, and "Not this".
4. **Shift list**: each day with three marks: Compared, Confirmed, Bank reconciled (₹ left).
5. **What Bookr learned (Owner, weekly)**: cases by how often they were accepted, "Make it Clear?" per case, register
   mistakes by kind.

## Effort and order

| Step | Value | Effort | Data model change |
|---|---|---|---|
| Balance strip and "Bank reconciled" mark per shift | High: one number tells whether a shift is done | Low | No |
| Take over Compare sales' pairs (step 1) | High | Low, once bank-backed Compare sales exists | No (better with the optional "which credit" field) |
| Reconcile screen with the four lanes | High: one place instead of two | Medium (mostly moving what exists) | No |
| Score and the new cases 7–12, 15, 18 | Medium-high | Medium | No |
| Learning: case in the history note, weekly report | Medium, grows over time | Low to start | No |
| "Make it Clear" per case | Medium | Low | No, but each move needs the Owner's OK |

Recommended first: **balance strip + Bank reconciled mark**, then **step 1 + the Reconcile screen**, then **the score
with the new cases**.

## Questions for the owner

1. May I read the matches you made by hand yesterday in the live data, only to count which cases they were, with no
   names or UPI IDs written anywhere? It would check the table above against real use.
2. Merge UPI matching and Bank sync's money-in into one Reconcile screen per shift? (Bank sync keeps money out and
   rules.)
3. Is "Likely" (70–89) shown ticked or unticked? Recommended: unticked.
4. Cases where the POS or both sides were wrong (6 and 10): a person always decides, even after learning. Agree?

## Owner's answers (5 Nov 2026)

- Bank-backed choices on Compare sales: pre-selected, the person accepts. UPI bill with no credit: suggest nothing.
  Money with no bill: warning only. One Reconcile screen per shift: yes. Likely matches: unticked. POS or both
  sides wrong: a person always decides. Match the credit at confirm or later: asked again, not yet answered.

## What the hand matches of 2 Nov show (counts only, read from live data 5 Nov)

- 102 credits matched by hand, all UPI in, all at the exact amount, none across 8 am.
- 92 one credit for one bill; 10 one credit for several bills (2, 3, 4, 5, 7 and 8 bills): tables paid at once are
  common and go up to 8 bills, so the 2-to-4 limit in step 4 is too low.
- Time from the software bill to the credit: 59 within 5 min, 19 within 20, 5 within 60, 2 within 180; 17 had no
  software time (register-only bills).
- Bills: 75 the same on both sides (plain), 21 only in the register, 2 only in the software, 2 mode, 2 amount.
- 11 bill-amount fixes to fit the credit, mostly small (₹1, ₹2, ₹6, ₹9, ₹12, ₹30; one of ₹50 over 6 bills and one
  of ₹64): a "small difference, round to the credit" case is missing from the table.
- 12 credits with no bill booked as unbilled income (11 F&B, 1 Room); 21 UPI card fees booked from a list by hand;
  7 reversals set aside. Paid twice, wrong UPI column and bill number typos did not show up.
