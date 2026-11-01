# Bookr

Bookr turns cash-book photos and bank statement sheets into reviewed transactions, with Tally export. It runs on Cloudflare Workers with Hono and TypeScript, stores data in Cloudflare D1 (SQLite), and serves a static front end from the same Worker. Money is stored as integer paise and converted to rupees only for display.

The source design is the Bookkeeping App Build Handover doc and the Bookkeeping App UI prototype.

## Phase 2: Cash capture

- Software sales CSV import with its footer as a control total, and names never stored.
- The 8 am to 8 am shift rule, with missing hours shown.
- Overlapping reports: identical bills skipped, different ones flagged for a person.
- Register, expense list and cash summary pages typed in beside the photo. OCR is not connected yet.
- Compare sales: every difference decided by a person; confirm creates approved income rows; only an Owner can reopen.
- Cash summary checks, including received against the shift's confirmed cash.

See `docs/phase2-context.md` for the design.

## Phase 1: Foundation

- Sign in with email and password, using server-side sessions and an HttpOnly cookie.
- Business switcher and the Choose a business screen. An Owner can create a new business.
- Memberships with four roles per business: Owner, Accountant, Entry staff and Viewer.
- Users and roles screen: change roles, remove people and invite by link. No email is sent in Phase 1.
- Accounts (Cash and bank) with an opening balance and an opening date.
- Income and expense heads with Tally ledger names. Each business starts with a standard list, and custom heads can be added.
- Demo businesses with sample data only: Sample Traders and Sample Hotel.

Later-phase screens appear in the sidebar marked with their phase number.

## Permissions

All permission rules live in [`src/permissions.ts`](src/permissions.ts). Every business route names one action. On every request, [`requireRole`](src/auth.ts) loads the caller's role in that business from the database.

- A non-member gets **404**, so business ids cannot be probed.
- A member whose role does not allow the action gets **403**.
- A business always keeps at least one Owner.
- Any role hiding in the browser is cosmetic. The server makes every decision.

The database is reached only through the Worker's `DB` binding, so no database credential exists anywhere. The browser talks only to `/api` on the same origin.

D1 has no open transactions. Anything that must be atomic runs as one `db.batch([...])`, which commits or rolls back as a whole; for example, an account change and its audit row go in one batch. Two rules are enforced by database triggers, so they hold even when requests arrive at the same moment:
- A business always keeps at least one Owner.
- An invite is accepted at most once, and never after it is revoked or expired.

## Run locally

Needs Node 22. No Docker is needed: wrangler runs D1 locally.

```bash
npm install
npm run db:migrate:local
DEMO_PASSWORD='choose-one-locally' npm run db:seed-demo:local
npm run dev                          # http://127.0.0.1:8787
# in another terminal, once dev is running:
DEMO_PASSWORD='choose-one-locally' npm run db:seed-demo-sales -- --base-url http://127.0.0.1:8787
```

Demo sign-ins, all using the demo password:

| Email | Role |
|---|---|
| owner@example.com | Owner of both demo businesses |
| accountant@example.com | Accountant in Sample Traders, Viewer in Sample Hotel |
| staff1@example.com | Entry staff in Sample Traders |
| viewer@example.com | Viewer in Sample Traders |

## Tests

```bash
npm test
```

Each test file gets its own throwaway local D1 through wrangler's platform proxy, with the migrations applied.

## Demo site

The demo site runs on workers.dev with the `bookr-demo` D1 database. It holds sample data only; never load real business data into it.

```bash
npm run db:migrate:remote
DEMO_PASSWORD="$(security find-generic-password -s bookr-demo-password -w)" npm run db:seed-demo:remote
npm run deploy
DEMO_PASSWORD="$(security find-generic-password -s bookr-demo-password -w)" npm run db:seed-demo-sales -- --base-url https://bookr-demo.bis-directoredu.workers.dev
```

The live demo password is kept in the macOS Keychain on the build Mac (service `bookr-demo-password`), not in the repo.
