// Supplier bill photos read by Claude, checked by a person, then received into stock. The Claude call is a mock:
// no test calls the API. All names, bills and amounts are invented.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { OcrError, readWithClaude } from '../../src/claude';
import { app } from '../src/app';
import { dispose, env, q, setupBusiness } from './helpers';

const mocked = vi.mocked(readWithClaude);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

afterAll(dispose);
beforeEach(() => { mocked.mockReset(); });

async function upload(s: Awaited<ReturnType<typeof setupBusiness>>, who: 'owner' | 'counter', bytes: Uint8Array, type = 'image/jpeg') {
  const client = s[who];
  const res = await app.request(`/api${s.B}/stock/bills`, {
    method: 'POST', body: new Blob([bytes as BlobPart]),
    headers: { 'Content-Type': type, Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  }, env);
  return { status: res.status, json: await res.json() as any };
}

describe('supplier bill photos', () => {
  it('keeps the photo, reads it into a draft, and receives the checked lines against the bill once', async () => {
    const s = await setupBusiness();
    const { B, owner, ok } = s;
    const store = (await ok(owner.post(`${B}/stock/stores`, { name: 'Main store', kind: 'main' }))).id;
    const whisky = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Whisky 750 ml', unit: 'ml', packName: 'bottle', packSize: 750, costPerPack: '1800' }))).id;
    mocked.mockResolvedValue({ model: 'claude-opus-5-5', data: {
      vendor: 'Sample Wines', invoiceNo: 'SW-118', billDate: '2026-11-17', totalRupees: 3800,
      lines: [
        { description: 'SAMPLE WHISKY 750ML', stockItemId: whisky, packs: 2, pricePerPackRupees: 1900, lineTotalRupees: 3800 },
        { description: 'Unknown mixer', stockItemId: 'not-an-item-of-this-business', packs: 1, pricePerPackRupees: null, lineTotalRupees: null },
      ] } });

    expect((await upload(s, 'counter', JPEG)).status).toBe(403); // a cashier does not handle stock
    expect((await upload(s, 'owner', JPEG, 'image/gif')).status).toBe(415);

    const r = await upload(s, 'owner', JPEG);
    expect(r.status).toBe(201);
    expect(r.json.error).toBeNull();
    expect(r.json.read.vendor).toBe('Sample Wines');
    expect(r.json.read.lines[1].stockItemId).toBeNull(); // a match outside this business is dropped
    // Claude was asked with this business's stock items in the instructions.
    expect(mocked.mock.calls[0][2]).toContain('Sample Whisky 750 ml');

    // The photo is kept and served back to people who handle stock.
    const photo = await app.request(`/api${B}/stock/bills/${r.json.billId}/photo`, { headers: { Cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, env);
    expect(photo.status).toBe(200);
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG);

    // The person corrects the price and receives one line against the bill.
    await ok(owner.post(`${B}/stock/purchases`, { storeId: store, vendor: 'Sample Wines', invoiceNo: 'SW-118', billId: r.json.billId,
      lines: [{ itemId: whisky, packs: 2, costPerPack: '1850' }] }));
    const [move] = await q("SELECT bill_id, qty, cost_per_pack_paise FROM stock_moves WHERE business_id = ? AND kind = 'purchase'", s.businessId);
    expect(move).toEqual({ bill_id: r.json.billId, qty: 1500, cost_per_pack_paise: 185000 });
    expect((await q('SELECT status FROM purchase_bills WHERE id = ?', r.json.billId))[0].status).toBe('received');
    // The same bill cannot be received twice.
    const again = await owner.post(`${B}/stock/purchases`, { storeId: store, vendor: 'Sample Wines', billId: r.json.billId, lines: [{ itemId: whisky, packs: 2 }] });
    expect(again.status).toBe(409);
  });

  it('keeps the photo and says why when Claude cannot read it, so the bill is typed in', async () => {
    const s = await setupBusiness();
    // The real reader, with no ANTHROPIC_API_KEY on the server: it refuses before any network call.
    const real = await vi.importActual<typeof import('../../src/claude')>('../../src/claude');
    mocked.mockImplementation(real.readWithClaude);
    const r = await upload(s, 'owner', JPEG);
    expect(r.status).toBe(201);
    expect(r.json.read).toBeNull();
    expect(r.json.error).toMatch(/not set up/);
    const [row] = await q('SELECT photo_key, read_error FROM purchase_bills WHERE id = ?', r.json.billId);
    expect(row.photo_key).toMatch(/\.jpg$/);
  });
});
