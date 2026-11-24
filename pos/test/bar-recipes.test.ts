// Bar recipes made from drink names, and cocktails suggested by Claude (a mock: no test calls the API). All names invented.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/claude')>();
  return { ...real, askClaude: vi.fn() };
});

import { askClaude, OcrError } from '../../src/claude';
import { propose } from '../src/bar-recipes';
import { dispose, q, setupBusiness } from './helpers';

const mocked = vi.mocked(askClaude);
afterAll(dispose);
beforeEach(() => { mocked.mockReset(); });
const pours = { peg: 30, large: 60, glass: 150 };

describe('recipes from drink names', () => {
  it('reads pegs, bottles, beer, wine and mixers; leaves cocktails, packages and non-drinks', () => {
    const menu = ([
      ['Sample Scotch 30 ml', 'Bar: Pegs', false], ['Sample Scotch', 'Bar: Pegs', false], ['Sample Scotch Large', 'Bar: Pegs', false], ['Sample Scotch Bottle', 'Bar: Bottles', true],
      ['Jager Half Bottle', 'Bar: Bottles', true], ['Jagermeister', 'Bar: Pegs', false], ['Sample Gin 1 L Bottle', 'Bar: Bottles', true],
      ['Sample Lager Pint', 'Bar: Beer', false], ['Kingfisher', 'Bar: Pegs, Beer & Wine', false], ['House Red Wine', 'Bar: Wine', false], ['Sample Sparkling Wine Bottle', 'Bar: Wine', true],
      ['Coke Can', 'Beverages', false], ['Rum Cola', 'Bar: Pegs', false], ['Sample Sunrise', 'Cocktails', false], ['Sample Club', 'Event', false],
      ['Hookah', 'Cocktails & Hookah', false], ['Cold Coffee', 'Beverages', false], ['Vodka Pani Puri', 'Chaat', false], ['Whisky Full Bottle', 'Event', true],
    ] as const).map(([name, category, openPrice], i) => ({ id: `m${i}`, name, category, openPrice }));
    const stock = [{ id: 's1', name: 'Sample Scotch 750 ml', unit: 'ml', packSize: 750 }];
    const { proposals, newItems } = propose(menu, stock, pours);
    const by = (n: string) => proposals.find((p) => p.menuItem === n)!;
    const one = (n: string) => { const p = by(n); return [p.kind, p.lines.map((l) => [l.stockItemId ?? newItems.get(l.newKey!)!.name, l.qty])]; };
    expect(one('Sample Scotch 30 ml')).toEqual(['peg', [['s1', 30]]]);
    expect(one('Sample Scotch')).toEqual(['peg', [['s1', 30]]]);
    expect(one('Sample Scotch Large')).toEqual(['peg', [['s1', 60]]]);
    expect(one('Sample Scotch Bottle')).toEqual(['bottle', [['s1', 750]]]);
    expect(one('Jager Half Bottle')).toEqual(['bottle', [['Jagermeister', 375]]]);
    expect(one('Jagermeister')).toEqual(['peg', [['Jagermeister', 30]]]);       // one stock item for both names
    expect(one('Sample Gin 1 L Bottle')).toEqual(['bottle', [['Sample Gin', 1000]]]);
    expect(one('Sample Lager Pint')).toEqual(['beer', [['Sample Lager Pint', 1]]]);
    expect(one('Kingfisher')).toEqual(['beer', [['Kingfisher', 1]]]);
    expect(one('House Red Wine')).toEqual(['wine', [['House Red Wine', 150]]]);
    expect(one('Sample Sparkling Wine Bottle')).toEqual(['wine', [['Sample Sparkling Wine', 750]]]);
    expect(one('Coke Can')).toEqual(['mixer', [['Coke Can', 1]]]);
    expect(by('Rum Cola').kind).toBe('cocktail');
    expect(by('Sample Sunrise').kind).toBe('cocktail');
    expect(by('Sample Club').kind).toBe('unclear');
    expect(by('Hookah').kind).toBe('skip');
    expect(by('Cold Coffee').kind).toBe('skip');
    expect(by('Vodka Pani Puri').kind).toBe('unclear');
    expect(by('Whisky Full Bottle').note).toContain('not a brand');
    expect([by('Whisky Full Bottle').check, by('Sample Scotch Bottle').check]).toEqual([true, false]);
    expect(by('Sample Scotch Bottle').note).toContain('one full bottle');
    expect(by('Jager Half Bottle').note).toBe('');
    expect(newItems.get([...newItems.keys()].find((k) => newItems.get(k)!.name === 'Sample Gin')!)!.packSize).toBe(1000);
  });
});

describe('Make recipes', () => {
  it('suggests without saving, then makes the approved stock items and recipes at once', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const add = (name: string, category: string, open = false) => ok(owner.post(`${B}/menu`, { name, category, station: 'bar', price: open ? '' : '200', openPrice: open }));
    const peg = (await add('Sample Rum 30 ml', 'Bar: Pegs')).id;
    const bottle = (await add('Sample Rum Bottle', 'Bar: Bottles', true)).id;
    const mojito = (await add('Sample Mojito', 'Cocktails')).id;
    await add('Pool Table', 'Bar: Games');
    const rum = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Rum', unit: 'ml', packName: 'bottle', packSize: 750 }))).id;

    mocked.mockResolvedValue({ model: 'claude-opus-5-5', data: { drinks: [{ n: 1, menuItem: 'Sample Mojito', note: '', lines: [
      { stock: 'Sample Rum', qty: 60, unit: 'ml', isNew: false, packName: 'bottle', packSize: 750 },
      { stock: 'Mint', qty: 8, unit: 'g', isNew: true, packName: 'kg', packSize: 1000 },
    ] }] } });
    const r = await ok(owner.post(`${B}/stock/recipes/suggest`, { peg: 30, large: 60, glass: 150, claude: true }));
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(String(mocked.mock.calls[0][1])).toContain('Sample Mojito');
    // Claude is told the bar's pours and the brands this same run is adding, and to use one form per ingredient.
    const asked = String(mocked.mock.calls[0][1]);
    expect(asked).toContain('a peg (30 ml) or a large peg (60 ml)');
    expect(asked).toContain('whole limes (pcs), not lime juice');
    expect(asked).toMatch(/Stock items being added in this same setup[\s\S]*- Beer \(pcs\)/);
    const p = (id: string) => r.proposals.find((x: any) => x.menuItemId === id);
    expect(p(peg).lines).toEqual([{ stockItemId: rum, qty: 30, label: '30 ml' }]);
    expect(p(bottle).lines).toEqual([{ stockItemId: rum, qty: 750, label: '1 bottle (750 ml)' }]);
    expect(p(mojito)).toMatchObject({ source: 'claude', check: true, lines: [{ stockItemId: rum, qty: 60 }, { newKey: 'new:g:mint', qty: 8 }] });
    expect(r.newItems).toContainEqual({ key: 'new:g:mint', name: 'Mint', unit: 'g', packName: 'kg', packSize: 1000 });   // and the test restaurant's beer
    expect((await q('SELECT count(*) AS n FROM recipes WHERE business_id = ?', s.businessId))[0].n).toBe(0);   // nothing saved yet

    // Approve the peg (changed to 45 ml) and the mojito; Mint is made with them.
    const done = await ok(owner.post(`${B}/stock/recipes/apply`, { newItems: r.newItems.filter((n: any) => n.key === 'new:g:mint'), recipes: [
      { menuItemId: peg, lines: [{ stockItemId: rum, qty: 45 }] },
      { menuItemId: mojito, lines: p(mojito).lines },
    ] }));
    expect(done).toMatchObject({ ok: true, recipes: 2, stockItemsCreated: 1, made: { 'new:g:mint': expect.any(String) } });
    const rows = await q(`SELECT m.name AS drink, s.name AS stock, r.qty FROM recipes r JOIN menu_items m ON m.id = r.menu_item_id JOIN stock_items s ON s.id = r.stock_item_id
      WHERE r.business_id = ? ORDER BY m.name, s.name`, s.businessId);
    expect(rows).toEqual([{ drink: 'Sample Mojito', stock: 'Mint', qty: 8 }, { drink: 'Sample Mojito', stock: 'Sample Rum', qty: 60 }, { drink: 'Sample Rum 30 ml', stock: 'Sample Rum', qty: 45 }]);
    expect((await q("SELECT count(*) AS n FROM audit_log WHERE business_id = ? AND action = 'recipe.auto'", s.businessId))[0].n).toBe(1);
    // A stock item a recipe uses cannot be removed; an unused one can.
    expect((await owner.call('DELETE', `${B}/stock/items/${rum}`, {})).status).toBe(409);
    const spare = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Spare', unit: 'pcs', packSize: 1 }))).id;
    expect(await ok(owner.call('DELETE', `${B}/stock/items/${spare}`, {}))).toEqual({ ok: true, hidden: false });
    expect((await q('SELECT count(*) AS n FROM stock_items WHERE id = ?', spare))[0].n).toBe(0);

    // Next time only the drink still without a recipe is proposed; Claude off, or failing, leaves cocktails for later.
    const again = await ok(owner.post(`${B}/stock/recipes/suggest`, {}));
    const names = again.proposals.map((x: any) => x.menuItem);
    expect(names).toContain('Sample Rum Bottle');
    expect(names).not.toContain('Sample Rum 30 ml');
    expect(names).not.toContain('Sample Mojito');
    mocked.mockRejectedValue(new OcrError(429, 'Claude is busy right now. Try again in a minute.'));
    await ok(owner.post(`${B}/menu`, { name: 'Sample Collins', category: 'Cocktails', station: 'bar', price: '300' }));
    const busy = await ok(owner.post(`${B}/stock/recipes/suggest`, { claude: true }));
    expect(busy.claudeNote).toContain('Claude is busy');
    expect(busy.proposals.find((x: any) => x.menuItem === 'Sample Collins').lines).toEqual([]);

    // Ask Claude for one drink: its recipe comes back for the screen, reusing an ingredient the screen already proposes.
    const collins = busy.proposals.find((x: any) => x.menuItem === 'Sample Collins').menuItemId;
    mocked.mockReset();
    mocked.mockResolvedValue({ model: 'claude-opus-5-5', data: { drinks: [{ n: 1, menuItem: 'Sample Collins', note: '', lines: [
      { stock: 'Sample Gin', qty: 60, unit: 'ml', isNew: true, packName: 'bottle', packSize: 750 },
      { stock: 'Soda', qty: 1, unit: 'pcs', isNew: true, packName: 'pcs', packSize: 1 },
    ] }] } });
    const one = await ok(owner.post(`${B}/stock/recipes/ask`, { menuItemId: collins, peg: 30, large: 60, glass: 150, newItems: [{ key: 'new:pcs:soda', name: 'Soda', unit: 'pcs', packName: 'pcs', packSize: 1 }] }));
    expect(one.proposal).toMatchObject({ menuItemId: collins, source: 'claude', check: true, lines: [{ newKey: 'new:ml:sample gin', qty: 60 }, { newKey: 'new:pcs:soda', qty: 1 }] });
    expect(one.newItems).toEqual([{ key: 'new:ml:sample gin', name: 'Sample Gin', unit: 'ml', packName: 'bottle', packSize: 750 }]);
    expect((await q('SELECT count(*) AS n FROM recipes WHERE menu_item_id = ?', collins))[0].n).toBe(0);
    mocked.mockRejectedValue(new OcrError(429, 'Claude is busy right now. Try again in a minute.'));
    expect((await owner.post(`${B}/stock/recipes/ask`, { menuItemId: collins })).status).toBe(429);

    // Someone else's drink or stock item, or a cashier: refused, nothing changes.
    const other = await setupBusiness();
    expect((await owner.post(`${B}/stock/recipes/apply`, { recipes: [{ menuItemId: other.items['Beer 650 ml'], lines: [{ stockItemId: rum, qty: 1 }] }] })).status).toBe(404);
    const theirs = (await other.ok(other.owner.post(`${other.B}/stock/items`, { name: 'Their Rum', unit: 'ml', packSize: 750 }))).id;
    expect((await owner.post(`${B}/stock/recipes/apply`, { recipes: [{ menuItemId: bottle, lines: [{ stockItemId: theirs, qty: 1 }] }] })).status).toBe(400);
    expect((await counter.post(`${B}/stock/recipes/suggest`, {})).status).toBe(403);
    expect((await owner.post(`${B}/stock/recipes/ask`, { menuItemId: other.items['Beer 650 ml'] })).status).toBe(404);
  });

  it('lists sections, and sends only the chosen kitchen sections to Claude at the chosen detail', async () => {
    const s = await setupBusiness();
    const { B, owner, ok } = s;
    const tikka = (await ok(owner.post(`${B}/menu`, { name: 'Sample Paneer Tikka', category: 'Starters', price: '280' }))).id;
    await ok(owner.post(`${B}/menu`, { name: 'Sample Gulab Jamun', category: 'Desserts', price: '120' }));
    await ok(owner.post(`${B}/menu`, { name: 'Sample Rum 30 ml', category: 'Bar: Pegs', station: 'bar', price: '200' }));
    const secs = (await ok(owner.get(`${B}/stock/recipes/sections`))).sections;
    expect(secs.find((x: any) => x.category === 'Bar: Pegs')).toEqual({ category: 'Bar: Pegs', n: 1, bar: true });
    expect(secs.find((x: any) => x.category === 'Starters')).toEqual({ category: 'Starters', n: 1, bar: false });

    mocked.mockResolvedValue({ model: 'claude-opus-5-5', data: { drinks: [{ n: 1, menuItem: 'Sample Paneer Tikka', note: '', lines: [
      { stock: 'Paneer', qty: 150, unit: 'g', isNew: true, packName: 'kg', packSize: 1000 },
      { stock: 'Oil', qty: 15, unit: 'ml', isNew: true, packName: 'litre', packSize: 1000 },
    ] }] } });
    const r = await ok(owner.post(`${B}/stock/recipes/suggest`, { categories: ['Starters', 'Bar: Pegs'], claude: true, detail: 'major' }));
    expect(mocked).toHaveBeenCalledTimes(1);
    const prompt = String(mocked.mock.calls[0][1]);
    expect(prompt).toContain('MAJOR ingredients');
    expect(prompt).toContain('ONE form and ONE name per ingredient');
    expect(prompt).toContain('1. Sample Paneer Tikka — Starters');
    expect(prompt).not.toContain('Gulab Jamun');                               // a section not chosen
    expect(r.proposals.map((x: any) => x.menuItem).sort()).toEqual(['Sample Paneer Tikka', 'Sample Rum 30 ml']);
    expect(r.proposals.find((x: any) => x.menuItemId === tikka)).toMatchObject({ kind: 'kitchen', source: 'claude', check: true,
      lines: [{ newKey: 'new:g:paneer', qty: 150 }, { newKey: 'new:ml:oil', qty: 15 }] });

    // "All ingredients" asks for everything; Ask Claude on a kitchen dish uses the kitchen question.
    mocked.mockClear();
    await ok(owner.post(`${B}/stock/recipes/ask`, { menuItemId: tikka, detail: 'all' }));
    expect(String(mocked.mock.calls[0][1])).toContain('ALL ingredients');
    // Without Claude, kitchen dishes wait for a person.
    const plain = await ok(owner.post(`${B}/stock/recipes/suggest`, { categories: ['Starters'] }));
    expect(plain.proposals[0]).toMatchObject({ kind: 'kitchen', lines: [] });
    expect(plain.claudeNote).toContain('kitchen dishes were not sent for AI suggestions');
  });
});
