// The single source of truth for who can do what. Every business-scoped route names one action,
// and the server checks it against the caller's role in that business on every request.

export const ROLES = ['owner', 'accountant', 'entry_staff', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  accountant: 'Accountant',
  entry_staff: 'Entry staff',
  viewer: 'Viewer',
};

const ALL: readonly Role[] = ROLES;
const OWNER: readonly Role[] = ['owner'];
const BOOKS: readonly Role[] = ['owner', 'accountant'];
const PREPARERS: readonly Role[] = ['owner', 'accountant', 'entry_staff'];

// Matches the "What each role can do" table in the Users and roles design.
// Later-phase actions are listed now so the matrix is tested in one place.
export const PERMISSIONS = {
  'business.view': ALL,
  'business.edit': OWNER,
  'members.manage': OWNER,
  'accounts.view': ALL,
  'accounts.edit': BOOKS,
  'heads.view': ALL,
  'heads.edit': BOOKS,
  'rules.edit': BOOKS,
  'rows.upload': PREPARERS,
  'rows.edit': PREPARERS,
  'rows.approve': BOOKS,
  'bank.link': BOOKS,
  'export.run': BOOKS,
  'reports.view': ['owner', 'accountant', 'viewer'],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;

export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function actionsFor(role: Role): Action[] {
  return (Object.keys(PERMISSIONS) as Action[]).filter((a) => can(role, a));
}
