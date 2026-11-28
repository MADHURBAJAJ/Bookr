// Bill photos on cash book expenses (approved 28 Nov 2026, migration 0049): optional, up to 3, proof only.
// Invented schools, people and amounts; the "photos" are a few bytes with a JPG start.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const jpg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 1, 2, 3]);

describe('bill photos on expenses', () => {
  it('cashier adds bills to own expense, owner and accountant see them, others cannot, removed with the line', async () => {
    const h = await businessWithAllRoles('Test School Group');
    const o = h.clients.owner;
    const c = h.clients.entry_staff;
    const br = (await o.post(`/businesses/${h.bid}/branches`, { name: 'North Campus' })).json.id;
    const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Cashier North', branchId: br, cashierUserId: h.users.entry_staff.id, openingBalance: '5,000', openingDate: '2026-11-01' })).json.id as string;
    const other = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Office cash', openingBalance: '100', openingDate: '2026-11-01' })).json.id as string;
    const t = today();
    const exp = (await c.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: t, kind: 'expense', amount: '350', narration: 'Chalk and dusters' })).json.id as string;
    const rec = (await c.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: t, kind: 'other_in', amount: '50', narration: 'Scrap sold' })).json.id as string;
    const url = (b: string, e: string) => `/businesses/${h.bid}/cashbooks/${b}/entries/${e}/bills`;

    const b1 = await c.upload(url(book, exp), jpg(1), 'image/jpeg');
    expect(b1.status).toBe(201);
    expect((await c.upload(url(book, rec), jpg(2), 'image/jpeg')).status).toBe(400);
    expect((await c.upload(url(book, exp), new Uint8Array([1, 2, 3, 4]), 'image/jpeg')).status).toBe(400);
    // Up to three.
    const b2 = (await o.upload(url(book, exp), jpg(3), 'image/jpeg')).json.id;
    expect((await h.clients.accountant.upload(url(book, exp), jpg(4), 'image/jpeg')).status).toBe(201);
    expect((await c.upload(url(book, exp), jpg(5), 'image/jpeg')).status).toBe(409);

    // The day and the approve list carry the ids; the photo is served to those who see the book.
    const day = (await c.get(`/businesses/${h.bid}/cashbooks/${book}/day/${t}`)).json;
    expect(day.entries.find((e: { id: string }) => e.id === exp).billIds.split(',')).toHaveLength(3);
    const rv = (await o.get(`/businesses/${h.bid}/cashbook-reviews`)).json.lines;
    expect(rv.find((l: { id: string }) => l.id === exp).billIds).toContain(b1.json.id);
    const see = await c.raw(`/businesses/${h.bid}/cashbooks/${book}/bills/${b1.json.id}`);
    expect(see.status).toBe(200);
    expect(see.headers.get('Content-Type')).toBe('image/jpeg');
    expect(see.headers.get('Cache-Control')).toContain('no-store');
    expect((await o.raw(`/businesses/${h.bid}/cashbooks/${book}/bills/${b1.json.id}`)).status).toBe(200);
    // Through another book, or by a viewer of another business: not found.
    expect((await o.raw(`/businesses/${h.bid}/cashbooks/${other}/bills/${b1.json.id}`)).status).toBe(404);
    const stranger = (await businessWithAllRoles('Other Group')).clients.owner;
    expect((await stranger.raw(`/businesses/${h.bid}/cashbooks/${book}/bills/${b1.json.id}`)).status).toBe(404);
    // A viewer cannot add.
    expect((await h.clients.viewer.upload(url(book, exp), jpg(6), 'image/jpeg')).status).toBe(403);

    // Removing one; after approval the cashier cannot change them, the owner can.
    expect((await c.del(`${url(book, exp)}/${b2}`)).status).toBe(200);
    const heads = (await o.get(`/businesses/${h.bid}/heads`)).json.heads as { id: string; type: string }[];
    await h.clients.accountant.put(`/businesses/${h.bid}/cashbook-lines/${exp}/head`, { headId: heads.find((x) => x.type === 'expense')!.id });
    expect((await o.post(`/businesses/${h.bid}/cashbook-lines/review-many`, { ids: [exp], status: 'approved' })).status).toBe(200);
    expect((await c.upload(url(book, exp), jpg(7), 'image/jpeg')).status).toBe(409);
    expect((await o.upload(url(book, exp), jpg(8), 'image/jpeg')).status).toBe(201);

    // A line deleted takes its bills with it.
    const gone = (await c.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: t, kind: 'expense', amount: '20', narration: 'Tape' })).json.id as string;
    const gb = (await c.upload(url(book, gone), jpg(9), 'image/jpeg')).json.id;
    expect((await c.del(`/businesses/${h.bid}/cashbooks/${book}/entries/${gone}`)).status).toBe(200);
    expect((await c.raw(`/businesses/${h.bid}/cashbooks/${book}/bills/${gb}`)).status).toBe(404);
  });
});
