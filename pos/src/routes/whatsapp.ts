// Settings › WhatsApp (approved 27 Nov 2026). WhatsApp is read by Bookr (the listener on the reception PC sends Bookr the
// photos and PDF bills of the groups Bookr reads); this tab shows whether that is working and lets the hotel choose the
// groups without signing in to Bookr. Owners and managers switch a group's reading or its bill proof; only the Owner
// starts reading a new group. The role is checked here on every request, and Bookr checks the POS key and the role again.
// The key is the Worker secret BOOKR_KEYS; nothing secret reaches the browser.
import { Hono, type Context } from 'hono';
import { body, fail, isUuid } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { bookrLink } from '../sync';
import type { AppEnv, Env } from '../types';

export const whatsappRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId/whatsapp';
whatsappRoutes.use('/businesses/:businessId/whatsapp', requireStaff);
whatsappRoutes.use(`${B}/*`, requireStaff);

type Fetcher = typeof fetch;
/** Calls Bookr. Answers { connected: false } with no Bookr key, and { connected: true, error } when Bookr cannot be reached or says no. */
export async function askBookr(env: Env, bid: string, path: string, extra: Record<string, unknown> = {}, fetcher: Fetcher = (...a) => fetch(...a)) {
  const link = bookrLink(env, bid);
  if (!link) return { connected: false as const };
  try {
    const res = await fetcher(`${link.base}/api/pos/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.key}` },
      body: JSON.stringify({ businessId: link.bookrId, ...extra }),
    });
    const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { connected: true as const, status: res.status, error: typeof answer.error === 'string' ? answer.error : `Bookr answered ${res.status}` };
    return { connected: true as const, ...answer };
  } catch (e) {
    return { connected: true as const, status: 502, error: `Bookr could not be reached (${String((e as Error)?.message ?? e).slice(0, 160).replace(/\.$/, '')}).` };
  }
}

const by = (c: Context<AppEnv>) => ({ name: c.get('staff').name, role: c.get('staff').role });
/** A change: Bookr's refusal is passed on with its reason. */
function changed(c: Context<AppEnv>, r: Awaited<ReturnType<typeof askBookr>>, ok = 200) {
  if (!r.connected) fail(409, 'This POS is not connected to Bookr, so WhatsApp reading cannot be changed here.');
  if ('error' in r && r.error) {
    const s = 'status' in r ? r.status : 502;
    fail(s === 400 || s === 403 || s === 404 || s === 409 ? s : 502, String(r.error));
  }
  return c.json(r, ok as 200);
}

whatsappRoutes.get('/businesses/:businessId/whatsapp', requireAction('whatsapp.edit'), async (c) =>
  c.json(await askBookr(c.env, c.get('businessId'), 'wa')));

whatsappRoutes.patch(`${B}/groups/:id`, requireAction('whatsapp.edit'), async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Group not found.');
  const b = await body(c);
  const change: Record<string, boolean> = {};
  for (const k of ['active', 'posProof'] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') fail(400, `${k} must be true or false.`);
    change[k] = b[k] as boolean;
  }
  if (!Object.keys(change).length) fail(400, 'Nothing to change.');
  return changed(c, await askBookr(c.env, c.get('businessId'), 'wa/edit', { groupId: id, ...change, by: by(c) }));
});

whatsappRoutes.post(`${B}/groups`, requireAction('whatsapp.add'), async (c) => {
  const b = await body(c);
  if (typeof b.waGroupId !== 'string' || !/^[0-9-]+@g\.us$/.test(b.waGroupId)) fail(400, 'Choose a group the reception phone is in.');
  if (b.department !== undefined && b.department !== null && (typeof b.department !== 'string' || b.department.length > 80)) fail(400, 'Department must be short text.');
  if (b.posProof !== undefined && typeof b.posProof !== 'boolean') fail(400, 'posProof must be true or false.');
  return changed(c, await askBookr(c.env, c.get('businessId'), 'wa/add',
    { waGroupId: b.waGroupId, department: (b.department as string | undefined)?.trim() || null, posProof: b.posProof === true, by: by(c) }), 201);
});
