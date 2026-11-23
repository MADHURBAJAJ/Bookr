// Change password, and a server-made reset link for a locked-out Owner (approved 23 Nov 2026).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, PASSWORD, businessWithAllRoles, resetDb, sql } from './helpers';
import { randomToken, sha256 } from '../src/crypto';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const login = async (email: string, password: string) => {
  const c = new Client();
  return { c, status: (await c.post('/auth/login', { email, password })).status };
};

describe('change password', () => {
  it('with the current password; others are signed out, this device stays', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const email = h.users.owner.email;
    const other = await login(email, PASSWORD);
    const o = h.clients.owner;
    expect((await o.put('/me/password', { current: 'wrong-password-x', password: 'a-new-password-1' })).status).toBe(401);
    expect((await o.put('/me/password', { current: PASSWORD, password: 'short' })).status).toBe(400);
    expect((await o.put('/me/password', { current: PASSWORD, password: 'a-new-password-1' })).status).toBe(200);
    expect((await o.get('/me')).status).toBe(200);
    expect((await other.c.get('/me')).status).toBe(401);
    expect((await login(email, PASSWORD)).status).toBe(401);
    expect((await login(email, 'a-new-password-1')).status).toBe(200);
  });

  it('forgotten: without the current password only on a sign-in from the last 7 days', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    expect((await o.put('/me/password', { password: 'a-new-password-1' })).status).toBe(200);
    await sql`UPDATE sessions SET created_at = ${Date.now() - 8 * 86400000} WHERE user_id = ${h.users.owner.id}`;
    const r = await o.put('/me/password', { password: 'a-new-password-2' });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/7 days/);
  });
});

describe('owner reset link made from the server', () => {
  it('works for an Owner once; an owner link made in the app for an Owner still does not', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const ownerId = h.users.owner.id;
    const token = randomToken();
    const t = Date.now();
    // What scripts/owner-reset.ts writes: made by the person themselves.
    await sql`INSERT INTO password_resets (id, user_id, business_id, created_by, token_hash, created_at, expires_at)
      VALUES (${crypto.randomUUID()}, ${ownerId}, ${h.bid}, ${ownerId}, ${await sha256(token)}, ${t}, ${t + 3600000})`;
    const guest = new Client();
    expect((await guest.get(`/resets/${token}`)).status).toBe(200);
    expect((await guest.post(`/resets/${token}`, { password: 'a-new-password-1' })).status).toBe(200);
    expect((await login(h.users.owner.email, 'a-new-password-1')).status).toBe(200);
    expect((await new Client().post(`/resets/${token}`, { password: 'a-new-password-2' })).status).toBe(404);
    // Made by someone else for an Owner: refused, as before.
    const t2 = randomToken();
    await sql`INSERT INTO password_resets (id, user_id, business_id, created_by, token_hash, created_at, expires_at)
      VALUES (${crypto.randomUUID()}, ${ownerId}, ${h.bid}, ${h.users.accountant.id}, ${await sha256(t2)}, ${t}, ${t + 3600000})`;
    expect((await new Client().get(`/resets/${t2}`)).status).toBe(404);
  });
});
