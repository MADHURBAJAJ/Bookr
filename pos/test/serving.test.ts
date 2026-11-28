// Serving time (28 Nov 2026): serve times per category and item, the KOT keeping them, servers on their own phones marking
// items served with a photo, undo (2 minutes for the server, then a manager with a reason), the manager's marks, the
// Daily check and the report, and the server sign-in guards. Invented data only.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { Client, dispose, env, q, setupBusiness } from './helpers';
import { WRONG_LIMIT } from '../src/routes/serve';

afterAll(dispose);
const MIN = 60_000;
let clockAt = Date.UTC(2026, 10, 27, 14, 0); // 7:30 pm in India
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clockAt); });
afterEach(() => { clockAt = Date.now(); vi.useRealTimers(); });
const later = (mins: number) => vi.setSystemTime(Date.now() + mins * MIN);

/** A phone (no counter device): a server signs in on the Serve page. */
async function phone(businessId: string, pin: string, ip = '203.0.113.7') {
  const p = new Client();
  const r = await p.call('POST', '/serve/signin', { businessId, pin }, { 'CF-Connecting-IP': ip });
  return { p, r };
}
async function photo(p: Client, batch: string) {
  const cookie = [...p.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await app.request(`/api/serve/photo/${batch}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Cookie: cookie }, body: new Uint8Array([255, 216, 255, 224, 1, 2, 3]) }, env);
  return res.status;
}

async function business() {
  const s = await setupBusiness();
  const { B, owner, ok } = s;
  const menu = await ok(owner.get(`${B}/menu`));
  const food = menu.categories.find((c: any) => c.name === 'Food');
  // Food: 20 minutes for its items; Butter Naan its own 10; Masala Chai not timed (0).
  await ok(owner.put(`${B}/menu-categories/${food.id}`, { serveMins: 20 }));
  const item = (n: string) => menu.items.find((i: any) => i.name === n);
  for (const [n, m] of [['Butter Naan', 10], ['Masala Chai', 0]] as const) {
    const i = item(n);
    await ok(owner.put(`${B}/menu/${i.id}`, { name: i.name, price: String(i.pricePaise / 100), category: i.category, station: i.station, serveMins: m }));
  }
  const server = (await ok(owner.post(`${B}/servers`, { name: 'Anil', pin: '482915' }))).id;
  return { ...s, server };
}

describe('serving time', () => {
  it('keeps the serve time on the KOT, and lets a server mark part and then the rest served with a photo', async () => {
    const s = await business();
    const { B, counter, ok, businessId } = s;
    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T3' }))).id;
    for (const [n, qty] of [['Masala Dosa', 2], ['Butter Naan', 3], ['Masala Chai', 2]] as const) await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items[n], delta: qty }));
    await ok(counter.post(`${B}/orders/${o}/kot`));
    const kot = (await q('SELECT id, lines FROM kots WHERE order_id = ?', o))[0];
    const lines = JSON.parse(kot.lines);
    expect(lines.map((l: any) => [l.name, l.mins ?? null])).toEqual([['Masala Dosa', 20], ['Butter Naan', 10], ['Masala Chai', null]]);
    expect(lines.every((l: any) => typeof l.lineId === 'string')).toBe(true);
    // A later menu change does not change the KOT.
    const food = (await ok(s.owner.get(`${B}/menu`))).categories.find((c: any) => c.name === 'Food');
    await ok(s.owner.put(`${B}/menu-categories/${food.id}`, { serveMins: 25 }));

    // The server's phone: no device, a 6-digit PIN.
    const { p, r } = await phone(businessId, '482915');
    expect(r.status).toBe(200);
    let list = (await p.get('/serve/kots')).json;
    expect(list.server.name).toBe('Anil');
    expect(list.kots).toHaveLength(1);
    expect(list.kots[0].items.map((i: any) => [i.name, i.mins, i.state])).toEqual([['Masala Dosa', 20, 'ok'], ['Butter Naan', 10, 'ok']]);
    // 9 minutes on: the naan is due in a minute (amber); 11: late.
    later(9);
    expect((await p.get('/serve/kots')).json.kots[0].state).toBe('soon');
    later(2);
    expect((await p.get('/serve/kots')).json.kots[0]).toMatchObject({ state: 'late', leftMins: -1 });

    // Part: only the naan goes out now, with its photo.
    const naan = list.kots[0].items.find((i: any) => i.name === 'Butter Naan').lineNo;
    const part = await p.post(`/serve/kots/${kot.id}/served`, { lines: [naan] });
    expect(part.status).toBe(201);
    expect(await photo(p, part.json.batch)).toBe(200);
    list = (await p.get('/serve/kots')).json;
    expect(list.kots[0].items.map((i: any) => [i.name, i.servedAt !== null, i.photo])).toEqual([['Masala Dosa', false, false], ['Butter Naan', true, true]]);
    expect(list.recent).toEqual([expect.objectContaining({ place: 'T3', items: 1, photo: true })]);
    // Served twice: refused.
    expect((await p.post(`/serve/kots/${kot.id}/served`, { lines: [naan] })).status).toBe(409);
    // The rest: the KOT leaves the list.
    later(5);
    await ok(p.post(`/serve/kots/${kot.id}/served`, { lines: [0] }));
    expect((await p.get('/serve/kots')).json.kots).toEqual([]);

    // The tables screen sees each item's state.
    const live = await ok(counter.get(`${B}/serving/live`));
    expect(live.lines.map((l: any) => [l.name, l.state, l.lateMins, l.by])).toEqual([['Masala Dosa', 'served', 0, 'Anil'], ['Butter Naan', 'served_late', 1, 'Anil']]);
    // Only the Owner and managers see the photo.
    expect((await counter.get(`${B}/serving/photo/${part.json.batch}`)).status).toBe(403);
    const pic = await app.request(`/api${B}/serving/photo/${part.json.batch}`, { headers: { Cookie: [...s.owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, env);
    expect(pic.status).toBe(200);
    expect(pic.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it("lets a server undo for 2 minutes; then only a manager, with a reason, and late stays late", async () => {
    const s = await business();
    const { B, counter, owner, ok, businessId } = s;
    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T5' }))).id;
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Masala Dosa'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${o}/kot`));
    const kotId = (await q('SELECT id FROM kots WHERE order_id = ?', o))[0].id;
    const { p } = await phone(businessId, '482915');

    // Tapped early by mistake, undone within 2 minutes: as if never tapped, and logged.
    const a = await ok(p.post(`/serve/kots/${kotId}/served`, { lines: [0] }));
    later(1);
    await ok(p.post(`/serve/undo/${a.batch}`));
    expect(await q('SELECT * FROM kot_served WHERE kot_id = ?', kotId)).toEqual([]);
    // Served 30 minutes after the KOT: 10 minutes late. Too late for the server to undo.
    later(29);
    const b = await ok(p.post(`/serve/kots/${kotId}/served`, { lines: [0] }));
    later(3);
    expect((await p.post(`/serve/undo/${b.batch}`)).status).toBe(409);

    // A cashier cannot undo; a manager can, with a reason. The first served time stays: still 10 minutes late.
    expect((await counter.post(`${B}/serving/undo`, { kotId, lineNo: 0, reason: 'Wrong table' })).status).toBe(403);
    expect((await owner.post(`${B}/serving/undo`, { kotId, lineNo: 0 })).status).toBe(400);
    await ok(owner.post(`${B}/serving/undo`, { kotId, lineNo: 0, reason: 'Wrong table' }));
    expect((await p.get('/serve/kots')).json.kots).toHaveLength(1);
    let mg = await ok(owner.get(`${B}/serving`));
    expect(mg.waiting.map((w: any) => w.name)).toEqual(['Masala Dosa']);
    // Nobody serves it again: the manager marks it (no photo).
    later(5);
    await ok(owner.post(`${B}/serving/mark`, { kotId, lineNo: 0 }));
    mg = await ok(owner.get(`${B}/serving`));
    expect(mg.waiting).toEqual([]);
    expect(mg.served[0]).toMatchObject({ name: 'Masala Dosa', byManager: true, photo: false, lateMins: 10 });
    expect(mg.log.map((e: any) => e.kind)).toEqual(['serve_manager', 'serve_undo', 'serve_undo']);

    const day = mg.shiftDay;
    const dc = await ok(owner.get(`${B}/reports/daily-check?day=${day}`));
    expect(dc.serving).toMatchObject({ timed: 1, late: 1, onTime: 0, notMarked: 0, undoneByManager: 1, undoneByServer: 1, serverUndos: [{ name: 'Anil', n: 1 }],
      managerMarks: 1, undoneNotServed: [] });
    expect(dc.serving.worst[0]).toMatchObject({ place: 'T5', name: 'Masala Dosa', lateMins: 10 });
    const rep = await ok(owner.get(`${B}/reports/serving?from=${day}&to=${day}`));
    expect(rep.byItem[0]).toMatchObject({ key: 'Masala Dosa', timed: 1, late: 1, setMins: 20 });
  });

  it('does not time a dish taken off the order, and counts what was never marked apart', async () => {
    const s = await business();
    const { B, counter, owner, ok, businessId, reasons, mgr } = s;
    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T8' }))).id;
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Masala Dosa'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Butter Naan'], delta: 2 }));
    await ok(counter.post(`${B}/orders/${o}/kot`));
    const naanLine = (await ok(counter.get(`${B}/orders/${o}`))).order.lines.find((l: any) => l.name === 'Butter Naan').id;
    await ok(counter.post(`${B}/orders/${o}/items`, { lineId: naanLine, delta: -2, reasonId: reasons.kot_cancel, ...mgr }));
    const { p } = await phone(businessId, '482915');
    const tiles = (await p.get('/serve/kots')).json.kots;
    expect(tiles).toHaveLength(1);
    expect(tiles[0].items.map((i: any) => i.name)).toEqual(['Masala Dosa']);
    const day = (await ok(owner.get(`${B}/serving`))).shiftDay;
    // While the order runs, the dosa is still waiting; once its bill is closed and it was never marked, it is "not marked".
    expect((await ok(owner.get(`${B}/reports/daily-check?day=${day}`))).serving).toMatchObject({ timed: 1, waiting: 1, notMarked: 0, late: 0 });
    await q("UPDATE orders SET status = 'closed' WHERE id = ?", o);
    expect((await ok(owner.get(`${B}/reports/daily-check?day=${day}`))).serving).toMatchObject({ timed: 1, waiting: 0, notMarked: 1, late: 0 });
  });

  it('keeps servers to the Serve page: PIN rules, wrong-PIN blocks per connection, removal and day close', async () => {
    const s = await business();
    const { B, owner, counter, ok, businessId } = s;
    // 6 digits, and unique among servers. Only the Owner adds servers.
    expect((await owner.post(`${B}/servers`, { name: 'Short', pin: '1234' })).status).toBe(400);
    expect((await owner.post(`${B}/servers`, { name: 'Twin', pin: '482915' })).status).toBe(409);
    expect((await counter.post(`${B}/servers`, { name: 'X', pin: '111222' })).status).toBe(403);
    // A server's sign-in opens nothing else: no staff route, no other business.
    const { p } = await phone(businessId, '482915');
    expect((await p.get(`${B}/orders`)).status).toBe(401);
    expect((await p.get('/me')).status).toBe(401);
    expect((await p.get(`${B}/serving`)).status).toBe(401);
    // A staff PIN does not work on the Serve page.
    expect((await phone(businessId, '002468')).r.status).toBe(401);

    // Wrong PINs block only that connection; a manager unlocks it.
    const bad = '203.0.113.99';
    for (let i = 0; i < WRONG_LIMIT; i++) expect((await phone(businessId, '000000', bad)).r.status).toBe(401);
    expect((await phone(businessId, '482915', bad)).r.status).toBe(429);
    expect((await phone(businessId, '482915', '198.51.100.4')).r.status).toBe(200);
    const blocks = (await ok(owner.get(`${B}/serving/blocks`))).blocks;
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain(bad);
    await ok(owner.post(`${B}/serving/unblock`, { conn: blocks[0].conn }));
    expect((await phone(businessId, '482915', bad)).r.status).toBe(200);
    const day = (await ok(owner.get(`${B}/serving`))).shiftDay;
    expect((await ok(owner.get(`${B}/reports/daily-check?day=${day}`))).serving.wrongPins).toBe(WRONG_LIMIT + 1);

    // Removed: the open phone stops at its next tap, and the PIN no longer works.
    await ok(owner.put(`${B}/servers/${s.server}`, { active: false }));
    expect((await p.get('/serve/kots')).status).toBe(401);
    expect((await phone(businessId, '482915', '198.51.100.4')).r.status).toBe(401);
    const list = (await ok(owner.get(`${B}/servers`))).servers;
    expect(list[0]).toMatchObject({ name: 'Anil', active: false });

    // Day close ends server sign-ins.
    await ok(owner.post(`${B}/servers`, { name: 'Sunita', pin: '551177' }));
    const sun = (await phone(businessId, '551177')).p;
    expect((await sun.get('/serve/kots')).status).toBe(200);
    await q(`INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise, totals, closed_at)
      VALUES (?, ?, ?, 0, '{}', 0, 0, 0, '{}', ?)`, crypto.randomUUID(), businessId, day, Date.now());
    expect((await sun.get('/serve/kots')).status).toBe(401);
  });

  it('reads and writes the serve time in the menu sheet', async () => {
    const s = await business();
    const { B, owner, ok } = s;
    const res = await app.request(`/api${B}/menu/sheet`, { headers: { Cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, env);
    const csv = (await res.text()).replace(/^﻿/, '');
    expect(csv).toContain('Butter Naan,Food,60,,,Billing name,Kitchen,996332,10\r\n');
    expect(csv).toContain('Masala Chai,Food,40,,,Billing name,Kitchen,996332,0\r\n');
    const changed = csv.replace('Masala Dosa,Food,180,,,Billing name,Kitchen,996332,', 'Masala Dosa,Food,180,,,Billing name,Kitchen,996332,30 min');
    const check = await ok(owner.post(`${B}/menu/upload/check`, { csv: changed }));
    expect(check.otherChanges).toEqual([{ name: 'Masala Dosa', what: ['serve time as its category → 30 min'] }]);
    await ok(owner.post(`${B}/menu/upload/apply`, { csv: changed, planHash: check.planHash }));
    const items = (await ok(owner.get(`${B}/menu`))).items;
    expect(Object.fromEntries(items.map((i: any) => [i.name, i.serveMins]))).toMatchObject({ 'Masala Dosa': 30, 'Butter Naan': 10, 'Masala Chai': 0 });
    expect((await owner.post(`${B}/menu/upload/check`, { csv: changed.replace('30 min', 'soon') })).json.errors[0]).toContain('serve time "soon"');
  });
});
