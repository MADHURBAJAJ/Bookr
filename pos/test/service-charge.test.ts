// Service charge and prices that include GST (26 Nov 2026): set by category, an item may say otherwise; service charge
// is on the value before GST and GST is charged on it too; a price with GST in it has its GST worked out of it; the
// guest may have service charge taken off; a credit note gives back its share. All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billTotals, creditNote } from '../src/billing';
import { dispose, setupBusiness } from './helpers';

afterAll(dispose);
const GST5 = { kind: 'gst', bp: 500 } as const;

describe('service charge and prices with GST in them: the sums', () => {
  it('charges service charge before GST, works GST out of an inclusive price, and keeps bills without them as before', () => {
    const t = billTotals([{ qty: 1, pricePaise: 18000, tax: GST5, sc: true }, { qty: 1, pricePaise: 4000, tax: GST5, incl: true }], { kind: 'none' }, 500, 1000);
    // ₹180 + 10% service charge = ₹198 taxable; ₹40 with GST in it = ₹38.10 taxable + ₹0.95 + ₹0.95: ₹236.10 taxable in all.
    expect(t).toMatchObject({ grossPaise: 22000, serviceChargePaise: 1800, taxablePaise: 23610, cgstPaise: 590, sgstPaise: 590, roundOffPaise: 10, totalPaise: 24800 });
    expect(t.taxes).toEqual([{ kind: 'gst', bp: 500, valuePaise: 23610, cgstPaise: 590, sgstPaise: 590 }]);
    // Without a rate, or with no line marked, nothing changes.
    expect(billTotals([{ qty: 1, pricePaise: 18000, tax: GST5, sc: true }], { kind: 'none' }, 500, 0)).toMatchObject({ taxablePaise: 18000, cgstPaise: 450, serviceChargePaise: 0, totalPaise: 18900 });
    expect(billTotals([{ qty: 1, pricePaise: 18000, tax: GST5 }], { kind: 'none' }, 500, 1000)).toMatchObject({ taxablePaise: 18000, cgstPaise: 450, totalPaise: 18900 });
  });

  it('takes the discount first; liquor carries service charge outside GST; a price with GST in it costs the guest exactly that', () => {
    expect(billTotals([{ qty: 1, pricePaise: 18000, tax: GST5, sc: true }], { kind: 'pct', bp: 1000 }, 500, 1000))
      .toMatchObject({ discountPaise: 1800, serviceChargePaise: 1620, taxablePaise: 17820, cgstPaise: 446, totalPaise: 18700 });
    expect(billTotals([{ qty: 1, pricePaise: 32000, tax: { kind: 'liquor' }, sc: true }], { kind: 'none' }, 500, 1000))
      .toMatchObject({ nonGstPaise: 35200, taxablePaise: 0, cgstPaise: 0, totalPaise: 35200 });
    expect(billTotals([{ qty: 3, pricePaise: 10000, tax: GST5, incl: true }], { kind: 'none' }, 500, 0)).toMatchObject({ totalPaise: 30000, roundOffPaise: 0 });
  });

  it('a credit note for part of the bill gives back that part\'s service charge and GST', () => {
    const lines = [{ qty: 1, pricePaise: 18000, tax: GST5, sc: true }, { qty: 1, pricePaise: 4000, tax: GST5, incl: true }];
    const bill = billTotals(lines, { kind: 'none' }, 500, 1000);
    const note = creditNote({ ...bill, gstRateBp: 500, serviceChargeBp: 1000 }, { grossPaise: 0, discountPaise: 0, taxablePaise: 0, nonGstPaise: 0, cgstPaise: 0, sgstPaise: 0, roundOffPaise: 0, totalPaise: 0 },
      [], [{ gross: 18000, tax: GST5, sc: true }], false);
    expect(note).toMatchObject({ grossPaise: 18000, discountPaise: 0, serviceChargePaise: 1800, taxablePaise: 19800, cgstPaise: 495, sgstPaise: 495, totalPaise: 20790 });
  });
});

describe('service charge and prices with GST in them: settings and the bill', () => {
  it('a category carries service charge, an item says otherwise, and the guest may have it taken off', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    expect((await owner.call('PUT', `${B}/service-charge`, { pct: 25 })).status).toBe(400);
    expect((await ok(owner.call('PUT', `${B}/service-charge`, { pct: 10 }))).serviceChargeBp).toBe(1000);
    expect((await ok(owner.get('/me'))).business.service_charge_bp).toBe(1000);
    // The cashier may not change it.
    expect((await counter.call('PUT', `${B}/service-charge`, { pct: 0 })).status).toBe(403);

    const menu = await ok(owner.get(`${B}/menu`));
    const food = menu.categories.find((c: { name: string }) => c.name === 'Food');
    await ok(owner.call('PUT', `${B}/menu-categories/${food.id}`, { serviceCharge: true }));
    // Masala Chai: no service charge, and its price has GST in it.
    const chai = menu.items.find((m: { name: string }) => m.name === 'Masala Chai');
    await ok(owner.call('PUT', `${B}/menu/${chai.id}`, { name: chai.name, category: 'Food', price: '40', serviceCharge: 'no', priceIncl: 'yes' }));
    const after = await ok(owner.get(`${B}/menu`));
    expect(after.categories.find((c: { id: string }) => c.id === food.id)).toMatchObject({ serviceCharge: 1, priceIncl: 0 });
    expect(after.items.find((m: { id: string }) => m.id === chai.id)).toMatchObject({ serviceCharge: 0, priceIncl: 1 });
    // A screen that does not send the choices keeps them.
    await ok(owner.call('PUT', `${B}/menu/${chai.id}`, { name: chai.name, category: 'Food', price: '40' }));
    expect((await ok(owner.get(`${B}/menu`))).items.find((m: { id: string }) => m.id === chai.id)).toMatchObject({ serviceCharge: 0, priceIncl: 1 });

    // Many items at once, from the Menu screen's ticked rows; a wrong value is refused.
    const naan = menu.items.find((m: { name: string }) => m.name === 'Butter Naan');
    expect((await owner.post(`${B}/menu/bulk`, { ids: [naan.id], action: 'serviceCharge', value: 'maybe' })).status).toBe(400);
    await ok(owner.post(`${B}/menu/bulk`, { ids: [naan.id], action: 'serviceCharge', value: 'no' }));
    await ok(owner.post(`${B}/menu/bulk`, { ids: [naan.id], action: 'priceIncl', value: 'yes' }));
    expect((await ok(owner.get(`${B}/menu`))).items.find((m: { id: string }) => m.id === naan.id)).toMatchObject({ serviceCharge: 0, priceIncl: 1 });
    await ok(owner.post(`${B}/menu/bulk`, { ids: [naan.id], action: 'serviceCharge', value: 'category' }));
    await ok(owner.post(`${B}/menu/bulk`, { ids: [naan.id], action: 'priceIncl', value: 'category' }));
    expect((await ok(owner.get(`${B}/menu`))).items.find((m: { id: string }) => m.id === naan.id)).toMatchObject({ serviceCharge: null, priceIncl: null });

    const { bill } = await (await import('./helpers')).billed(s, [['Masala Dosa', 1], ['Masala Chai', 1]]);
    expect(bill).toMatchObject({ serviceChargeBp: 1000, serviceChargePaise: 1800, taxablePaise: 23610, cgstPaise: 590, totalPaise: 24800 });
    expect(bill.items.map((l: { name: string; serviceCharge: number; priceIncl: number }) => [l.name, l.serviceCharge, l.priceIncl])).toEqual([['Masala Dosa', 1, 0], ['Masala Chai', 0, 1]]);

    // Taken off at the guest's request.
    const off = (await (await import('./helpers')).billed(s, [['Masala Dosa', 1]], { serviceCharge: false })).bill;
    expect(off).toMatchObject({ serviceChargeBp: 0, serviceChargePaise: 0, taxablePaise: 18000, totalPaise: 18900 });
    expect(off.items[0].serviceCharge).toBe(0);
  });
});
