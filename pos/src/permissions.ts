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
  'bills.void': TILL,            // void an unsettled bill with a reason (shown on the exceptions report)
  'stays.edit': TILL,            // open and close in-house stays
  'debtors.receive': TILL,       // take an advance, or a payment against a folio or credit account
  'shift.close': TILL,
  'reports.view': MANAGE,        // exceptions, shift reports, debtors
  'menu.edit': MANAGE,           // menu items and reason lists
  'entities.edit': OWNER,        // billing names, GST, limits, which are offered; UPI accounts
  'staff.manage': OWNER,         // staff, PINs, counter devices, business settings
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
