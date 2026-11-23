import type { Role } from './permissions';

export interface Env {
  DB: D1Database;
  /** Worker secret: needed once, to create a business and its Owner (POST /api/setup). Never sent to the browser. */
  POS_SETUP_TOKEN?: string;
  /** Bookr's address, e.g. https://bookr.example.com (a setting, not a secret). */
  BOOKR_URL?: string;
  /** Worker secret: the key Bookr gave each business, JSON {"<business id>": "<key>"}. Never sent to the browser. */
  BOOKR_KEYS?: string;
  ASSETS?: { fetch: typeof fetch };
  /** R2 bucket for photos of supplier bills. Served only through the Worker after a role check. */
  BILLS?: R2Bucket;
  /** Worker secret: the Anthropic API key used to read bill photos. Never sent to the browser. */
  ANTHROPIC_API_KEY?: string;
  /** Which Claude model reads bill photos (a setting, not a secret). */
  CLAUDE_OCR_MODEL?: string;
  /** Most bill photos read per business per day (cost guard). */
  BILL_READS_PER_DAY?: string;
  /** Which business each mail address belongs to, JSON {"bookings@mail.thebajajgroup.co": "<business id>"} (a setting). */
  MAIL_ROUTES?: string;
  /** Who may send booking mails, JSON {"mmt": "@go-mmt.com", "djubo": "@djubo.com"}: addresses or "@domain", comma-separated. */
  BOOKING_MAIL_FROM?: string;
}

export interface Staff {
  id: string;
  name: string;
  role: Role;
  businessId: string;
}

export interface Vars {
  staff: Staff;
  /** The business row, loaded with the session (one database trip instead of two). */
  business: import('./util').Business;
  sessionId: string;
  deviceId: string | null;
  businessId: string;
  /** The signed-in person's login (one per email; the same across the restaurants an admin gave them). */
  loginId: string | null;
  /** True when this is Bookr POS support, let in by the owner's support access. */
  support: boolean;
  /** A Bookr POS admin (admin routes only). */
  admin: { id: string; name: string; email: string };
}

export type AppEnv = { Bindings: Env; Variables: Vars };
