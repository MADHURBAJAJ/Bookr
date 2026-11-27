// Advances on restaurant orders (26 Nov 2026): what is held, for the Counter, the bill and Day close.
import { all, type DB } from '../../src/db';

/** Open restaurant advances with what is left of each (all, or one order's). */
export async function restaurantAdvances(db: DB, bid: string, orderId?: string) {
  const rows = await all<{ id: string; account_id: string; order_id: string | null; guest_name: string; phone: string | null; party_day: string | null; party_time: string | null;
    people: number | null; created_at: number; left_paise: number; taken_paise: number; receipts: string | null; place: string | null; order_status: string | null }>(db, `
    SELECT r.id, r.account_id, r.order_id, r.guest_name, r.phone, r.party_day, r.party_time, r.people, r.created_at,
      -coalesce((SELECT sum(e.amount_paise) FROM debtor_entries e WHERE e.account_id = r.account_id), 0) AS left_paise,
      -coalesce((SELECT sum(e.amount_paise) FROM debtor_entries e WHERE e.account_id = r.account_id AND e.kind = 'advance'), 0) AS taken_paise,
      (SELECT group_concat(s.receipt_no || ' ' || p.mode, ', ') FROM debtor_entries e JOIN payments p ON p.id = e.payment_id JOIN settlements s ON s.id = p.settlement_id
        WHERE e.account_id = r.account_id AND e.kind = 'advance') AS receipts,
      o.place, o.status AS order_status
    FROM restaurant_advances r LEFT JOIN orders o ON o.id = r.order_id
    WHERE r.business_id = ? AND r.status = 'open' ${orderId ? 'AND r.order_id = ?' : ''} ORDER BY coalesce(r.party_day, ''), r.created_at`, ...(orderId ? [bid, orderId] : [bid]));
  return rows.filter((r) => r.left_paise > 0).map((r) => ({ id: r.id, accountId: r.account_id, orderId: r.order_id, place: r.place, orderStatus: r.order_status,
    guestName: r.guest_name, phoneEnd: r.phone ? r.phone.slice(-4) : null, partyDay: r.party_day, partyTime: r.party_time, people: r.people, at: r.created_at,
    leftPaise: r.left_paise, takenPaise: r.taken_paise, receipts: r.receipts }));
}

