// Today (approved 14 Nov 2026): the shift that ended this morning shows while its files are missing; the shift bar's
// Bring in step reads the software count from progress. Invented business, no files.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';
import { addDays, shiftDayOf } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

describe('Today: bring in', () => {
  it('lists the shift that ended this morning while its sales report and register are not in', async () => {
    const h = await businessWithAllRoles('Hotel');
    const day = addDays(shiftDayOf(Date.now()), -1);
    const home = (await h.clients.accountant.get(`/businesses/${h.bid}/home`)).json;
    expect(home.bringIn).toEqual({ day, software: 0, registerPages: 0 });
    const p = (await h.clients.accountant.get(`/businesses/${h.bid}/shifts/${day}/progress`)).json;
    expect(p).toMatchObject({ software: 0, rows: 0 });
  });
});
