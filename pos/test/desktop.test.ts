// The Windows app's installer and update files (22 Nov 2026): served from desktop/ in the bucket to anyone, by plain file
// name only; nothing else in the bucket (supplier bill photos) is reachable this way.
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { dispose, env } from './helpers';

afterAll(dispose);

describe('desktop app files', () => {
  it('serves the update file and installer, and nothing else', async () => {
    await env.BILLS.put('desktop/latest.yml', 'version: 1.0.0\npath: Bookr-POS-Setup-1.0.0.exe\n');
    await env.BILLS.put('desktop/Bookr-POS-Setup-1.0.0.exe', new Uint8Array([77, 90, 1, 2]));
    await env.BILLS.put('bills/secret.jpg', 'photo');
    const get = (p: string) => app.request(`/api/desktop/${p}`, {}, env);
    const yml = await get('latest.yml');
    expect(yml.status).toBe(200);
    expect(await yml.text()).toContain('version: 1.0.0');
    const exe = await get('Bookr-POS-Setup-1.0.0.exe');
    expect(exe.status).toBe(200);
    expect(exe.headers.get('Content-Disposition')).toContain('Bookr-POS-Setup-1.0.0.exe');
    expect(new Uint8Array(await exe.arrayBuffer())).toEqual(new Uint8Array([77, 90, 1, 2]));
    for (const bad of ['secret.jpg', '..%2Fbills%2Fsecret.jpg', 'missing.exe', '.hidden.yml']) expect((await get(bad)).status, bad).toBe(404);
  });
});
