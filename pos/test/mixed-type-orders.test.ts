// A booking with several room types goes in by itself when Settings has every one (27 Nov 2026); food ordered on a room's
// tile before the guest came becomes theirs at check-in. All names and amounts invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';
import { unknownTypes } from '../src/mail';

afterAll(dispose);

describe('mixed room types and room orders', () => {
  it('checks a mixed room type part by part', () => {
    const known = ['quad sharing', 'hexa', 'deluxe'];
    expect(unknownTypes('Quad Sharing, Hexa', known)).toBeNull();
    expect(unknownTypes('quad  sharing ,HEXA', known)).toBeNull();
    expect(unknownTypes('Quad Sharing, Sea View Suite', known)).toBe('room type "Sea View Suite" is not in Settings');
    expect(unknownTypes('Hexa Deluxe', known)).toBe('room type "Hexa Deluxe" is not in Settings');
    expect(unknownTypes(undefined, known)).toBeNull();
  });

  it('an order opened on a room before the guest came becomes theirs at check-in', async () => {
    const s = await setupBusiness();
    const { B, counter, ok, owner } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['R1', 'R2'] }] }));
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'R1' }))).id;
    expect((await q('SELECT stay_id FROM orders WHERE id = ?', order))[0].stay_id).toBeNull();
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'R1', guestName: 'Late Guest' }))).id;
    expect((await q('SELECT stay_id FROM orders WHERE id = ?', order))[0].stay_id).toBe(stay);
  });
});
