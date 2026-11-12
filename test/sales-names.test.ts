// The software report's NAME is kept (approved 12 Nov 2026), for the complimentary report. A report imported before names
// were kept fills them in when the same file is uploaded again; nothing else changes. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './phase2-shared';
import { buildSalesCsv, REPORT_31_OCT } from '../demo/sample-data';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('names on software bills', () => {
  it('are kept on import, shown on the bill, and filled in from the same file again', async () => {
    const h = await hotel();
    const o = h.clients.owner;
    const csv = buildSalesCsv(REPORT_31_OCT);
    const post = (extra: Record<string, unknown> = {}) => o.post(`/businesses/${h.bid}/sales-reports`, { day: '2026-10-31', csv, ...extra });
    expect((await post()).status).toBe(201);
    const name = async (no: string) => (await sql`SELECT customer_name FROM software_bills WHERE bill_no = ${no}`)[0].customer_name;
    expect(await name('2610314')).toBe('Asha Rao, Room 4');
    const v = (await o.get(`/businesses/${h.bid}/shifts/2026-10-31`)).json;
    expect(v.comparisons.find((c: any) => c.billNo === '26103120').software.name).toBe('Vikram Nair');

    // The same file again: nothing to fill, so refused as before.
    expect((await post()).status).toBe(409);
    // A report imported before names were kept: the same file fills them in, and adds no report or bill.
    await sql`UPDATE software_bills SET customer_name = NULL`;
    const before = (await sql`SELECT count(*) AS n FROM software_bills`)[0].n;
    expect((await post({ dryRun: true })).json).toEqual({ namesOnly: true, names: 2 });
    expect((await post()).json).toEqual({ namesOnly: true, names: 2 });
    expect(await name('2610314')).toBe('Asha Rao, Room 4');
    expect((await sql`SELECT count(*) AS n FROM software_bills`)[0].n).toBe(before);
    expect((await sql`SELECT count(*) AS n FROM sales_reports`)[0].n).toBe(1);
  });
});
