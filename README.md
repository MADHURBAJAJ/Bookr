# Bookr

Bookr turns cash-book photos and bank statement sheets into reviewed transactions, with Tally export. It runs on Cloudflare Workers with Hono and TypeScript, uses Postgres through Hyperdrive, and serves a static front end from the same Worker.

The source design is the Bookkeeping App Build Handover doc and the Bookkeeping App UI prototype.

## Phase 1: Foundation (this branch)

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

Database credentials exist only in the Hyperdrive binding. The browser talks only to `/api` on the same origin.

## Run locally

Needs Node 22 and Docker.

```bash
npm install
npm run db:start                     # Postgres 16 on 127.0.0.1:54329
DATABASE_URL=postgres://postgres:bookr@127.0.0.1:54329/bookr npm run db:migrate
echo "DEMO_PASSWORD=$(openssl rand -hex 10)" > .dev.vars     # gitignored
set -a; . ./.dev.vars; set +a
DATABASE_URL=postgres://postgres:bookr@127.0.0.1:54329/bookr npm run db:seed-demo
npm run dev                          # http://127.0.0.1:8787
```

Demo sign-ins, all using `DEMO_PASSWORD`:

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

The tests run against a real local Postgres. They recreate the `bookr_test` database on each run. To use another server, set `TEST_DATABASE_URL`.

## Deploy (not done yet)

Deploying needs the Cloudflare token. Steps:

1. Create a Hyperdrive config for the demo database. Put its id in `wrangler.jsonc` in place of `REPLACE_WITH_HYPERDRIVE_ID`.
2. Run the migrations and the demo seed against the demo database.
3. Run `npx wrangler deploy`.
