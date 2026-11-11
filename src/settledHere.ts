// Bills settled the next day (approved 11 Nov 2026): a bill counted on an earlier saved shift (often from the software
// alone, while it waited for its register line) whose register line is written in this shift. The line is left out here,
// so the sale is counted once, on its own day. Its payment is the register's: when the earlier shift counted another
// mode (the software's "cash" on a bill closed unpaid), a person changes it there in one recorded step, and the money
// that came in here (a card payment, a UPI credit) then pays it.

import { all, type DB } from './db';

export interface SettledHere {
  /** This shift's left-out register line, and the earlier shift's counted bill. */
  lineId: string; rowId: string | null; uploadId: string | null; rowMode: string | null; rowPaise: number | null;
  comparisonId: string; fromDay: string; billNo: string;
  /** The earlier shift's sale. */
  txId: string; txMode: string; amountPaise: number;
  /** Still waiting for its money: a cash sale, a UPI sale with no credit, a card sale with no card payment. */
  open: boolean;
}

export async function settledHere(db: DB, businessId: string, day: string): Promise<SettledHere[]> {
  const rows = await all<Omit<SettledHere, 'open'> & { matchStatus: string | null; bankRow: string | null; carded: number; n: number }>(db, `
    SELECT here.id AS lineId, here.register_row_id AS rowId, r.upload_id AS uploadId, here.rg_mode AS rowMode, here.rg_amount_paise AS rowPaise,
      e.id AS comparisonId, e.shift_day AS fromDay, e.bill_no AS billNo, t.id AS txId, t.payment_mode AS txMode, t.amount_paise AS amountPaise,
      t.match_status AS matchStatus, t.matched_bank_row AS bankRow,
      EXISTS (SELECT 1 FROM card_matches m WHERE m.transaction_id = t.id) AS carded,
      (SELECT count(*) FROM transactions x WHERE x.comparison_id = e.id AND x.type = 'income' AND x.source = 'software_report') AS n
    FROM bill_comparisons here
    JOIN bill_comparisons e ON e.id = here.linked_to_id AND e.business_id = here.business_id
    JOIN shifts s ON s.business_id = e.business_id AND s.shift_day = e.shift_day AND s.status = 'confirmed'
    JOIN transactions t ON t.comparison_id = e.id AND t.type = 'income' AND t.source = 'software_report'
    LEFT JOIN register_rows r ON r.id = here.register_row_id
    WHERE here.business_id = ? AND here.shift_day = ? AND here.difference = 'missing_in_software' AND here.decision = 'leave_out'
      AND e.shift_day < here.shift_day
    ORDER BY e.shift_day, e.bill_no`, businessId, day);
  // One sale on the earlier shift: a bill counted in two modes there is left to a person.
  return rows.filter((x) => x.n === 1).map(({ matchStatus, bankRow, carded, n: _n, ...x }) => ({
    ...x,
    open: (x.txMode === 'cash' && matchStatus == null) || (x.txMode === 'upi' && matchStatus === 'awaiting_bank_match' && !bankRow)
      || (x.txMode === 'card' && matchStatus === 'awaiting_card_settlement' && !carded),
  }));
}

/** Counted in another mode than its register line here says it was paid: offered as "Paid by card (or UPI) here". */
export const paidOtherwise = (list: SettledHere[]) => list.filter((x) => x.open && (x.rowMode === 'card' || x.rowMode === 'upi')
  && x.rowMode !== x.txMode && x.rowPaise === x.amountPaise);

/** Card sales of an earlier shift whose register line is here: this shift's card payments may pay them. */
export const cardHere = (list: SettledHere[]) => list.filter((x) => x.open && x.txMode === 'card' && x.rowMode === 'card');
