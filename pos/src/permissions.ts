// Who can do what in the POS (roles approved 14 Nov 2026: captain, cashier, manager, plus the Owner).
// Every business route names one action; the server checks it against the caller's role in that business on every request.

export const ROLES = ['owner', 'manager', 'cashier', 'captain'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;
const TILL: readonly Role[] = ['owner', 'manager', 'cashier'];
const MANAGE: readonly Role[] = ['owner', 'manager'];
const OWNER: readonly Role[] = ['owner'];

export const PERMISSIONS = {
  'pos.view': ALL,               // menu, tables, open orders
  'orders.edit': ALL,            // open an order, add or cancel lines, send KOT, keep as a tab
  'bills.print': TILL,           // bill an order (choose the billing name and discount), reprint
  'bills.settle': TILL,          // take payments; create a credit account at the counter
  'bills.void': MANAGE,          // void an unsettled bill with a reason (manager only from 18 Nov 2026: stops bill-then-void at the bar)
  'bills.refund': TILL,          // a credit note on a paid bill: money given back, with a reason (on the Daily check)
  'stays.edit': TILL,            // open and close in-house stays
  'debtors.receive': TILL,       // take an advance, or a payment against a folio or credit account
  'shift.close': TILL,
  'drawer.float': MANAGE,        // the fixed float left in the cash drawer (24 Nov 2026)
  'serve.manage': MANAGE,        // serving time (28 Nov 2026): mark a forgotten item served, undo a mark, see the photos, unlock a connection
  'reports.view': MANAGE,        // exceptions, shift reports, debtors
  'menu.edit': MANAGE,           // menu items and reason lists
  'stock.edit': MANAGE,          // stock items, recipes, receiving, transfers, breakage, counts and the stock report
  'stock.count': TILL,
  'receipts.cancel': MANAGE,     // cancel a receipt taken by mistake, the same open day (27 Nov 2026)           // typing a bar or kitchen count (27 Nov 2026); a manager approves it
  'menu.upload': OWNER,          // replace the whole menu from a sheet (CSV), after checking what it changes
  'entities.edit': OWNER,        // billing names, GST, limits, which are offered; UPI accounts
  'staff.manage': OWNER,         // staff, PINs, counter devices, business settings
  'whatsapp.edit': MANAGE,       // Settings › WhatsApp: see whether reading works, switch a group's reading or its bill proof on or off (27 Nov 2026)
  'whatsapp.add': OWNER,         // start reading a new group the reception phone is in
  'whatsapp.link': OWNER,        // link, switch or unlink the WhatsApp number the reception PC reads (sees the QR)
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
