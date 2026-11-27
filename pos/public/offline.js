// Offline mode for the counter (27 Nov 2026). When the internet is off, a counter device the owner turned on for offline
// keeps working from what it saved on this PC: tables and takeaway, KOTs (A1, A2 ...), bills (C261126A001), cash / UPI /
// card payments, food to a room and room payments (RCPT/26-27/A001). Each thing done is kept as a step. When the
// internet is back the steps go up one at a time, oldest first, and the server runs each through its usual rules.
// Nothing secret is kept here: only the screens' own data (menu, tables, orders, stays) and the steps.

const DAY = 86_400_000;
const IST = 19_800_000;
const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const yymmdd = (day) => day.slice(2).replace(/-/g, '');
const uuid = () => crypto.randomUUID();
const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nothing kept */ } },
};
/** A refusal while offline, shown like any server error. */
export class OfflineError extends Error { constructor(message, status = 409, code = 'offline') { super(message); this.status = status; this.code = code; } }
const needsNet = (what) => { throw new OfflineError(`${what} needs the internet. It works again when the internet is back.`); };

// ---------- saved screens: the last answer of each GET the counter needs, for when the internet is off

const CACHE = 'bookr.off.get:';
const KEEP_GET = [/^\/me$/, /^\/businesses\/[^/]+\/(orders|menu|reasons|entities|pay-accounts|stays|credit-accounts|event-mode\/now|kot-picks|offline\/device)$/,
  /^\/businesses\/[^/]+\/orders\/[0-9a-f-]{36}$/, /^\/businesses\/[^/]+\/bills\/[0-9a-f-]{36}$/, /^\/businesses\/[^/]+\/stays\/[0-9a-f-]{36}\/bill$/,
  /^\/businesses\/[^/]+\/frontdesk\/(today|audit|chart\?.*)$/, /^\/businesses\/[^/]+\/bookings(\/arrivals)?$/];
export function remember(path, data) {
  if (!KEEP_GET.some((re) => re.test(path))) return;
  const text = JSON.stringify({ at: Date.now(), data });
  if (text.length > 400_000) return;
  try { localStorage.setItem(CACHE + path, text); } catch { /* full: the screen still works online */ }
}
const saved = (path) => store.get(CACHE + path);

// ---------- this counter's offline state, per business

let s = null;          // { bid, orders, bills, steps, counters, since, device }
let me = null;
let online = true;
let syncing = false;
let listeners = [];
const key = (bid) => `bookr.off.state:${bid}`;
const save = () => { if (s && !store.set(key(s.bid), s)) console.error('offline: could not save on this PC'); };
const changed = () => { save(); listeners.forEach((f) => { try { f(); } catch { /* a screen gone */ } }); };
export const onChange = (f) => { listeners.push(f); };

/** Starts (or switches) for the signed-in person's business. */
export function start(meNow) {
  me = meNow;
  const bid = me.business.id;
  if (s?.bid !== bid) s = store.get(key(bid)) ?? { bid, orders: {}, bills: {}, steps: [], counters: { bill: {}, kot: {}, rcpt: {} }, since: null, device: null };
  s.counters ??= { bill: {}, kot: {}, rcpt: {} };
  save();
}
/** The device's letter and the offline numbers already used (asked of the server while online). */
export function setDevice(d) {
  if (!s) return;
  s.device = d?.device ?? null;
  for (const no of d?.used?.bills ?? []) { const m = /^(.*)(\d{6})[A-Z](\d{3})$/.exec(no); if (m) bump(s.counters.bill, `${m[1]}|${m[2]}`, Number(m[3])); }
  for (const no of d?.used?.receipts ?? []) { const m = /^RCPT\/([\d-]+)\/[A-Z](\d+)$/.exec(no); if (m) bump(s.counters.rcpt, m[1], Number(m[2])); }
  for (const k of d?.used?.kots ?? []) { const m = /^[A-Z](\d+)$/.exec(k.label); if (m) bump(s.counters.kot, k.shiftDay, Number(m[1])); }
  save();
}
const bump = (map, k, n) => { if ((map[k] ?? 0) < n) map[k] = n; };
const next = (map, k) => { map[k] = (map[k] ?? 0) + 1; return map[k]; };

export const letter = () => s?.device?.letter ?? null;
export const isOnline = () => online;
export const isSyncing = () => syncing;
export const offlineSince = () => s?.since ?? null;
const live = () => (s?.steps ?? []).filter((x) => x.status !== 'sent');
export const waiting = () => live();
export const sentToday = () => (s?.steps ?? []).filter((x) => x.status === 'sent' && x.sentAt > Date.now() - DAY);
export const problems = () => live().filter((x) => x.status === 'look' || x.status === 'blocked');
/** True while the counter works from this PC: no internet, or steps still to send. */
export const active = () => !!s && (!online || live().length > 0);
export const allSteps = () => s?.steps ?? [];

export function wentOffline() {
  if (!online) return;
  online = false;
  if (s && !s.since) s.since = Date.now();
  changed();
  probeSoon();
}
let probeTimer = null;
function probeSoon() {
  if (probeTimer) return;
  probeTimer = setInterval(probe, 15_000);
}
/** Tries the internet; when it is back, sends what is waiting. */
export async function probe() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status >= 500) return;
  } catch { return; }
  clearInterval(probeTimer); probeTimer = null;
  online = true;
  changed();
  await sync();
}
window.addEventListener('online', () => { if (!online) probe(); });

// ---------- helpers on the saved menu and orders

const B = () => `/businesses/${me.business.id}`;
const can = (a) => !!me?.actions?.includes(a);
const isMgr = () => ['owner', 'manager'].includes(me?.staff.role);
const shiftDayAt = (ms) => istDay(ms - (me.business.shift_start_hour ?? 8) * 3_600_000);
const fyOf = (day) => {
  const [y, m] = day.split('-').map(Number);
  const startMonth = me.business.fy_start_month ?? 4;
  const st = m >= startMonth ? y : y - 1;
  return startMonth === 1 ? String(st) : `${st}-${String((st + 1) % 100).padStart(2, '0')}`;
};
const menu = () => saved(`${B()}/menu`)?.data ?? { items: [], categories: [], addonGroups: [], stations: [] };
const pkey = (n) => String(n).trim().toLowerCase();
function optionAdd(kind, options, option, prices) {
  const mine = prices?.[pkey(option.name)];
  if (kind === 'one') { const first = options[0] ? prices?.[pkey(options[0].name)] : undefined; return mine !== undefined && first !== undefined ? mine - first : option.addPaise; }
  return mine ?? option.addPaise;
}
const catOf = (m) => menu().categories.find((c) => c.name.toLowerCase() === String(m?.category ?? '').toLowerCase());
const kotOf = (m) => (m.kot ?? catOf(m)?.kot ?? 1) !== 0;
function stationOf(itemId) {
  const m = menu().items.find((x) => x.id === itemId);
  const st = menu().stations.filter((x) => x.active !== false);
  const id = m?.stationId ?? catOf(m)?.stationId ?? null;
  return st.find((x) => x.id === id) ?? [...st].sort((a, b) => Number(!!a.isBar) - Number(!!b.isBar))[0] ?? { id: null, name: m?.station === 'bar' ? 'Bar' : 'Kitchen', copies: 1 };
}

/** The orders list as the server last gave it, with what changed on this PC. */
function ordersList() {
  const base = saved(`${B()}/orders`)?.data ?? { orders: [], tables: [], tablesFixed: false, sections: [] };
  const mine = Object.values(s.orders);
  const orders = base.orders.filter((o) => !s.orders[o.id]).concat(mine.filter((o) => ['open', 'tab', 'billed'].includes(o.status)).map(view));
  return { ...base, orders: orders.sort((a, b) => a.openedAt - b.openedAt) };
}
const view = (o) => ({ ...o, notSent: live().some((x) => x.orderId === o.id), lines: o.lines.filter((l) => l.qty > 0).map(({ synced, optionIds, base, stationId, kotLine, serverLine, variant, ...l }) => l), itemsPaise: o.lines.reduce((t, l) => t + l.qty * l.pricePaise, 0) });
/** An order to change here: one made on this PC, or the server's last copy taken over. */
function orderHere(id) {
  if (s.orders[id]) return s.orders[id];
  const one = saved(`${B()}/orders/${id}`)?.data?.order ?? saved(`${B()}/orders`)?.data?.orders.find((o) => o.id === id);
  if (!one) throw new OfflineError('This order is not saved on this PC. It opens again when the internet is back.', 404);
  const o = { ...one, local: false, lines: one.lines.map((l) => ({ ...l, synced: l.qty, serverLine: true })) };
  s.orders[id] = o;
  return o;
}
const editable = (o) => { if (o.status !== 'open' && o.status !== 'tab') throw new OfflineError('This order is already billed.'); };

function addStep(x) {
  s.steps.push({ id: `${x.orderId ?? 'x'}:${uuid()}`, at: Date.now(), status: 'wait', staff: me.staff.name, ...x });
  // Online with steps still waiting (one needs a look): send the new one as soon as it is kept.
  if (online) setTimeout(() => sync(), 0);
}
/** What the order changed since its last step: items added or taken off before going to the kitchen. */
function flush(o) {
  for (const l of o.lines) {
    let d = l.qty - (l.synced ?? 0);
    while (d !== 0) {
      const part = Math.max(-50, Math.min(50, d));
      const body = l.serverLine ? { lineId: l.id, delta: part } : { itemId: l.itemId, delta: part, options: l.optionIds ?? [], ...(l.base !== undefined ? { price: (l.base / 100).toFixed(2) } : {}) };
      if (!l.serverLine && part < 0) break;   // cannot happen: a line made here only grows before it is sent
      addStep({ orderId: o.id, method: 'POST', path: `/orders/${o.id}/items`, body, what: `${part > 0 ? '+' : ''}${part} × ${l.name}`, place: o.place, quiet: true });
      d -= part;
    }
    l.synced = l.qty;
  }
}

// ---------- which calls are answered here

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Answered here: everything while offline; while online, a call about an order or bill still only on this PC. */
export function handles(method, path, body) {
  if (!s || !me) return false;
  if (!online) return true;
  if (!live().length) return false;
  const ids = [...`${path} ${JSON.stringify(body?.billIds ?? [])}`.matchAll(UUIDS)].map((m) => m[0]);
  return ids.some((id) => (s.orders[id] && s.orders[id].status !== 'closed') || s.bills[id]);
}
/** A server answer with what is still only on this PC laid over it (the tables screen while steps wait). */
export function merge(path, data) {
  if (!s || !me || !live().length || path !== `${B()}/orders` || !data?.orders) return data;
  const mine = Object.values(s.orders);
  return { ...data, orders: data.orders.filter((o) => !s.orders[o.id]).concat(mine.filter((o) => ['open', 'tab', 'billed'].includes(o.status)).map(view)) };
}
/** With no internet at start: the person and business as last saved on this PC, if any. */
export function restore() {
  const saved1 = saved('/me')?.data;
  if (!saved1) return null;
  start(saved1);
  setDevice(saved(`/businesses/${saved1.business.id}/offline/device`)?.data);
  return saved1;
}
export const ready = () => !!s && !!me;

// ---------- the counter's calls, answered here while offline

/** Answers a call from the screens with no internet. Throws OfflineError for what needs the internet. */
export async function local(method, path, body = {}) {
  if (!s || !me) throw new OfflineError('No internet. Sign in again when it is back.', 0, 'network');
  const b = B();
  if (method === 'GET') return getLocal(path);
  if (!letter()) throw new OfflineError('No internet. This device is not turned on for offline: the owner turns it on in Settings, Counter devices.', 0, 'network');
  if (!path.startsWith(b)) needsNet('That');
  const p = path.slice(b.length);
  let m;
  if (p === '/orders' && method === 'POST') return newOrder(body);
  if ((m = /^\/orders\/([0-9a-f-]{36})\/items$/.exec(p)) && method === 'POST') return items(m[1], body);
  if ((m = /^\/orders\/([0-9a-f-]{36})\/kot$/.exec(p)) && method === 'POST') return kot(m[1]);
  if ((m = /^\/orders\/([0-9a-f-]{36})\/note$/.exec(p)) && method === 'PUT') return note(m[1], body);
  if ((m = /^\/orders\/([0-9a-f-]{36})\/cancel$/.exec(p)) && method === 'POST') return dropOrder(m[1], body);
  if ((m = /^\/orders\/([0-9a-f-]{36})\/bill$/.exec(p)) && method === 'POST') return bill(m[1], body);
  if ((m = /^\/bills\/([0-9a-f-]{36})\/reprint$/.exec(p)) && method === 'POST') return reprint(m[1]);
  if (p === '/settlements' && method === 'POST') return settle(body);
  if ((m = /^\/debtors\/([0-9a-f-]{36})\/receipts$/.exec(p)) && method === 'POST') return receipt(m[1], body);
  if (/^\/orders\/[0-9a-f-]{36}\/lines\/[0-9a-f-]{36}\/remark$/.test(p)) needsNet('A remark on one item');
  needsNet('This');
}

function getLocal(path) {
  const b = B();
  if (path === `${b}/orders`) return ordersList();
  let m;
  if ((m = /\/orders\/([0-9a-f-]{36})$/.exec(path)) && path.startsWith(b) && s.orders[m[1]]) {
    const o = s.orders[m[1]];
    return { order: { ...view(o), guest: saved(path)?.data?.order?.guest ?? null } };
  }
  if ((m = /\/bills\/([0-9a-f-]{36})$/.exec(path)) && s.bills[m[1]]) return { bill: s.bills[m[1]] };
  // An order opened before the internet went off and not opened on this PC since: from the saved tables list.
  if ((m = /\/orders\/([0-9a-f-]{36})$/.exec(path)) && path.startsWith(b) && !saved(path)) {
    const o = ordersList().orders.find((x) => x.id === m[1]);
    if (o) return { order: { ...o, guest: null } };
  }
  if (path === `${b}/stays`) {
    const st = saved(path)?.data ?? { stays: [] };
    return { stays: st.stays.map((x) => ({ ...x, balancePaise: x.balancePaise + roomChange(x.accountId) })) };
  }
  if ((m = /\/stays\/([0-9a-f-]{36})\/bill$/.exec(path)) && saved(path)) {
    const d = saved(path).data;
    return { ...d, balancePaise: d.balancePaise + roomChange(d.stay?.accountId) };
  }
  if (path === '/me') return { ...(saved('/me')?.data ?? me), business: { ...me.business, shiftDay: shiftDayAt(Date.now()) } };
  const hit = saved(path);
  if (hit) return hit.data;
  // Lists the screens can do without while offline.
  if (/\/event-mode\/now$/.test(path)) return { event: null };
  if (/\/credit-accounts$/.test(path)) return { accounts: [] };
  if (/\/frontdesk\/alerts$/.test(path)) return { notInDjubo: [] };
  if (/\/bookings\/arrivals$/.test(path)) return { arrivals: [], late: [] };
  throw new OfflineError('No internet, and this page is not saved on this PC.', 0, 'network');
}
/** What steps not yet sent add to a room's account: food put on it (+), payments taken (−). */
export function roomChange(accountId) {
  return live().filter((x) => x.room?.accountId === accountId).reduce((t, x) => t + x.room.amountPaise, 0);
}
export const roomSteps = () => live().filter((x) => x.room);

function newOrder(d) {
  if (!can('orders.edit')) throw new OfflineError('Your role does not allow this.', 403);
  const kind = d.kind;
  if (!['table', 'room', 'takeaway'].includes(kind)) throw new OfflineError('Order kind must be table, room or takeaway.', 400);
  let place = kind === 'takeaway' ? 'Takeaway' : String(d.place ?? '').trim().slice(0, 40);
  if (!place) throw new OfflineError('Type the table.', 400);
  let stayId = null; let guestName = d.guestName ? String(d.guestName).slice(0, 80) : null;
  const stays = saved(`${B()}/stays`)?.data?.stays ?? [];
  const roomKey = (x) => String(x).toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '');
  if (kind === 'room') {
    const st = stays.find((x) => x.id === d.stayId);
    if (!st) throw new OfflineError('That room has no open stay.', 400);
    stayId = st.id; place = `Room ${st.room}`; guestName ??= st.guestName;
  }
  const list = ordersList();
  if (kind === 'table') {
    if (list.orders.some((o) => o.kind === 'table' && o.status === 'open' && o.place.toLowerCase() === place.toLowerCase())) throw new OfflineError(`${place} already has an open order.`);
    const sec = (list.sections ?? []).find((x) => x.tables.some((t) => t.toLowerCase() === place.toLowerCase()));
    if (sec?.kind === 'nc') throw new OfflineError('NC tables need the internet.');
    if (sec && (sec.kind === 'rooms' || sec.kind === 'dorms')) {
      const st = stays.find((x) => roomKey(x.room) === roomKey(place));
      if (st) { stayId = st.id; guestName ??= st.guestName; }
    }
  }
  const id = uuid();
  const t = Date.now();
  const covers = Number.isInteger(d.covers) && d.covers > 0 && d.covers < 100 ? d.covers : null;
  s.orders[id] = { id, local: true, kind, place, stayId, guestName, guestPhone: null, covers, status: 'open', openedAt: t, openedShiftDay: shiftDayAt(t), kotNote: null,
    handedFrom: null, heldBy: null, handedAt: null, lines: [], bill: null };
  addStep({ orderId: id, localId: id, method: 'POST', path: '/orders', body: { kind, place: kind === 'room' ? undefined : place, stayId: stayId ?? undefined, guestName: d.guestName || undefined, covers: covers ?? undefined },
    what: `New order`, place, open: true });
  changed();
  return { id };
}

function items(orderId, d) {
  const o = orderHere(orderId);
  editable(o);
  const delta = d.delta;
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 50) throw new OfflineError('Change must be a whole number of items.', 400);
  if (d.lineId === undefined && delta > 0) {
    const m = menu().items.find((x) => x.id === d.itemId && x.active);
    if (!m) throw new OfflineError('Item not on the menu.', 400);
    const picked = Array.isArray(d.options) ? d.options : [];
    const groups = (m.addonGroups ?? []).map((gid) => menu().addonGroups.find((g) => g.id === gid)).filter(Boolean);
    for (const g of groups.filter((x) => x.kind === 'one')) {
      if (g.options.filter((x) => picked.includes(x.id)).length !== 1) throw new OfflineError(`Choose one ${g.name} for ${m.name}.`, 400);
    }
    const chosen = groups.flatMap((g) => g.options.filter((x) => picked.includes(x.id)).map((x) => ({ group: g.name, name: x.name, addPaise: optionAdd(g.kind, g.options, x, m.addonPrices?.[g.id]) })));
    let base = m.pricePaise;
    let typed = false;
    if (m.openPrice) {
      base = Math.round(Number(String(d.price ?? '').replace(/,/g, '')) * 100);
      if (!Number.isFinite(base) || base <= 0) throw new OfflineError(`Type the price of ${m.name}.`, 400);
      if (m.minPricePaise !== null && m.minPricePaise !== undefined && base < m.minPricePaise) throw new OfflineError(`${m.name} cannot be less than ₹${m.minPricePaise / 100}.`, 400);
      typed = true;
    }
    const unit = Math.max(0, base + chosen.reduce((t, x) => t + x.addPaise, 0));
    const variant = [...picked].sort().join(',') + (typed ? `|${base}` : '');
    const st = stationOf(m.id);
    const hasKot = kotOf(m);
    // The same dish with the same choices adds to its line; a server line counts only when it is the plain one.
    let l = o.lines.find((x) => x.itemId === m.id && (x.serverLine ? variant === '' && !x.options?.length && !x.typedPrice : x.variant === variant));
    if (l) { l.qty += delta; if (!hasKot) l.sentQty = l.qty; } else {
      l = { id: uuid(), itemId: m.id, name: m.name, pricePaise: unit, qty: delta, sentQty: hasKot ? 0 : delta, options: chosen, typedPrice: typed, noKot: !hasKot, remark: null,
        synced: 0, optionIds: picked, variant, stationId: st.id, serverLine: false, ...(typed ? { base } : {}) };
      o.lines.push(l);
    }
  } else {
    const l = d.lineId !== undefined ? o.lines.find((x) => x.id === d.lineId) : o.lines.find((x) => x.itemId === d.itemId && !x.options?.length && !x.typedPrice);
    if (!l) throw new OfflineError('That line is not on the order.', 400);
    if (l.qty + delta < 0) throw new OfflineError('There are not that many on the order.', 400);
    if (!l.noKot && l.qty + delta < l.sentQty) throw new OfflineError('Taking off an item the kitchen already has needs the internet (a reason and a manager). Tell the kitchen meanwhile.');
    l.qty += delta;
    if (l.noKot) l.sentQty = l.qty;
  }
  changed();
  return { order: view(o) };
}

function kot(orderId) {
  const o = orderHere(orderId);
  editable(o);
  const send = o.lines.filter((l) => !l.noKot && l.qty > l.sentQty);
  if (!send.length) throw new OfflineError('Nothing new to send.');
  flush(o);
  const t = Date.now();
  const day = shiftDayAt(t);
  const groups = new Map();
  for (const l of send) {
    const st = l.stationId ? menu().stations.find((x) => x.id === l.stationId) ?? stationOf(l.itemId) : stationOf(l.itemId);
    const k = st.id ?? st.name;
    if (!groups.has(k)) groups.set(k, { st, lines: [] });
    groups.get(k).lines.push(l);
  }
  const kots = [];
  const labels = {};
  for (const [k, g] of groups) {
    const label = `${letter()}${next(s.counters.kot, day)}`;
    labels[k] = label;
    kots.push({ kotNo: label, station: g.st.name, place: o.place, at: t, by: me.staff.name, printAt: 'counter', copies: g.st.copies ?? 1, note: o.kotNote,
      lines: g.lines.map((l) => ({ name: l.name, qty: l.qty - l.sentQty, options: (l.options ?? []).map((x) => x.name), pricePaise: l.pricePaise, ...(l.remark ? { remark: l.remark } : {}) })) });
  }
  for (const l of send) l.sentQty = l.qty;
  addStep({ orderId: o.id, method: 'POST', path: `/orders/${o.id}/kot`, body: {}, kotLabels: labels, what: `KOT ${Object.values(labels).join(', ')}`, place: o.place,
    amountPaise: send.reduce((t2, l) => t2 + l.qty * l.pricePaise, 0) });
  changed();
  return { kots, order: view(o) };
}

function note(orderId, d) {
  const o = orderHere(orderId);
  editable(o);
  o.kotNote = String(d.note ?? '').trim().slice(0, 200) || null;
  addStep({ orderId: o.id, method: 'PUT', path: `/orders/${o.id}/note`, body: { note: o.kotNote ?? '' }, what: 'Note for the kitchen', place: o.place, quiet: true });
  changed();
  return { order: view(o) };
}

function dropOrder(orderId, d) {
  const o = orderHere(orderId);
  if (d?.reasonId || o.lines.some((l) => l.sentQty > 0)) needsNet('Cancelling an order the kitchen already has');
  if (o.local && !s.steps.some((x) => x.orderId === o.id && x.status === 'sent')) {
    s.steps = s.steps.filter((x) => x.orderId !== o.id);
  } else {
    flush(o);
    addStep({ orderId: o.id, method: 'POST', path: `/orders/${o.id}/cancel`, body: {}, what: 'Order dropped (nothing sent)', place: o.place });
  }
  o.status = 'cancelled';
  changed();
  return { ok: true };
}

function bill(orderId, d) {
  if (!can('bills.print')) throw new OfflineError('Your role does not allow this.', 403);
  const o = orderHere(orderId);
  editable(o);
  const ls = o.lines.filter((l) => l.qty > 0);
  if (!ls.length) throw new OfflineError('The order has no items.');
  if (ls.some((l) => l.qty > l.sentQty)) throw new OfflineError('Send the new items to the kitchen first.');
  const ents = saved(`${B()}/entities`)?.data?.entities ?? [];
  const e = ents.find((x) => x.id === d.entityId);
  if (!e || !e.active || !e.offered) throw new OfflineError('That billing name is not offered at the counter.', 400);
  if (d.lineDiscounts?.length) needsNet('A discount on one item');
  const disc = d.discount ?? { kind: 'none' };
  if (disc.kind === 'amount') needsNet('A discount as an amount');
  const discBp = disc.kind === 'pct' ? disc.bp : 0;
  const scBp = d.serviceCharge === false ? 0 : me.business.service_charge_bp ?? 0;
  const tot = hooks.previewTotals(ls, discBp, e, {}, scBp);
  if (tot.total <= 0) throw new OfflineError('Everything on this bill is free: that needs the internet.');
  if (tot.disc > 0 && !(disc.reasonId ?? d.discountReasonId)) throw new OfflineError('A reason for the discount is required.', 400);
  if (tot.disc > 0 && !isMgr() && tot.disc * 10000 > tot.gross * (me.business.disc_limit_bp ?? 1000)) needsNet(`A discount above ${(me.business.disc_limit_bp ?? 1000) / 100}% (a manager's PIN)`);
  if (e.stop_paise !== null && e.stop_paise !== undefined && (e.year_paise ?? 0) + tot.total > e.stop_paise) throw new OfflineError(`${e.name} would pass its stop point. Choose another billing name.`);
  flush(o);
  const t = Date.now();
  const day = istDay(t);
  const billNo = `${e.series_prefix}${yymmdd(day)}${letter()}${String(next(s.counters.bill, `${e.series_prefix}|${yymmdd(day)}`)).padStart(3, '0')}`;
  const id = uuid();
  const reason = tot.disc > 0 ? (saved(`${B()}/reasons`)?.data?.reasons ?? []).find((r) => r.id === (disc.reasonId ?? d.discountReasonId))?.label ?? null : null;
  const taxes = tot.taxes;
  const sum = (f) => taxes.reduce((x, r) => x + f(r), 0);
  const b = {
    id, billNo, orderId: o.id, shiftDay: shiftDayAt(t), printedAt: t, grossPaise: tot.gross, discountPaise: tot.disc, discountReason: reason,
    taxablePaise: sum((r) => (r.kind === 'gst' ? r.valuePaise : 0)), nonGstPaise: sum((r) => (r.kind === 'gst' ? 0 : r.valuePaise)), gstRateBp: e.gst_rate_bp,
    cgstPaise: sum((r) => r.cgstPaise), sgstPaise: sum((r) => r.sgstPaise), roundOffPaise: tot.total - tot.raw, totalPaise: tot.total,
    guestName: (d.guestName ? String(d.guestName).slice(0, 80) : null) ?? o.guestName, status: 'printed', printCount: 1, voidReason: null, entityId: e.id,
    serviceChargeBp: scBp, serviceChargePaise: tot.sc, entityName: e.name, gstRegistered: e.gst_registered ? 1 : 0, gstin: e.gstin, place: o.place, printedBy: me.staff.name,
    items: ls.map((l) => {
      const tax = hooks.dishTax(l.itemId, e); const f = hooks.dishFlags(l.itemId);
      return { id: l.id, name: l.name, sac: menu().items.find((m) => m.id === l.itemId)?.sac ?? '', qty: l.qty, ratePaise: l.pricePaise, amountPaise: l.qty * l.pricePaise, discountPaise: 0,
        taxed: tax.kind === 'gst' ? 1 : 0, options: l.options ?? [], taxKind: tax.kind, gstBp: tax.kind === 'gst' ? tax.bp : null, typedPrice: !!l.typedPrice, serviceCharge: f.sc && scBp > 0 ? 1 : 0, priceIncl: f.incl ? 1 : 0 };
    }),
    taxes, payments: [], differences: [], creditNotes: [], offline: true,
  };
  s.bills[id] = b;
  o.status = 'billed';
  o.bill = { id, billNo, totalPaise: b.totalPaise, entityId: e.id };
  addStep({ orderId: o.id, localId: id, method: 'POST', path: `/orders/${o.id}/bill`, body: { entityId: e.id, guestName: d.guestName || undefined, discount: disc, discountReasonId: d.discountReasonId, ...(d.serviceCharge === false ? { serviceCharge: false } : {}) },
    billNo, expectTotalPaise: b.totalPaise, what: `Bill ${billNo}`, place: o.place, amountPaise: b.totalPaise });
  changed();
  return { bill: b, warning: null };
}

function reprint(billId) {
  const b = s.bills[billId];
  if (!b) needsNet('A copy of a bill made online');
  b.printCount += 1;
  changed();
  return { bill: b };
}

function settle(d) {
  if (!can('bills.settle')) throw new OfflineError('Your role does not allow this.', 403);
  const ids = Array.isArray(d.billIds) ? d.billIds : [];
  if (!ids.length) throw new OfflineError('Choose the bills being paid.', 400);
  if (d.nc) needsNet('Closing an NC table');
  const bills = ids.map((id) => s.bills[id] ?? saved(`${B()}/bills/${id}`)?.data?.bill);
  if (bills.some((x) => !x)) throw new OfflineError('That bill is not saved on this PC.', 404);
  for (const x of bills) if (x.status !== 'printed') throw new OfflineError(`Bill ${x.billNo} is already paid.`);
  const due = bills.reduce((t, x) => t + x.totalPaise, 0);
  const pays = (d.payments ?? []).map((p) => {
    if (!['cash', 'upi', 'card', 'room'].includes(p.mode)) needsNet({ credit: 'A credit account', comp: 'A complimentary bill', advance: 'Using an advance' }[p.mode] ?? 'That payment');
    const amountPaise = Math.round(Number(String(p.amount).replace(/,/g, '')) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new OfflineError('Type the amount.', 400);
    return { ...p, amountPaise };
  });
  if (!pays.length) throw new OfflineError('Add how the bill was paid.', 400);
  const paid = pays.reduce((t, p) => t + p.amountPaise, 0);
  if (paid < due) needsNet('Taking less than the bill');
  if (paid > due && d.difference?.kind !== 'tip') throw new OfflineError(`Payments come to ₹${(paid / 100).toFixed(2)}, more than the bill. Mark it as a tip.`, 400);
  // The QR of another billing name: asked first, as online.
  const accts = saved(`${B()}/pay-accounts`)?.data?.accounts ?? [];
  const ents = new Set(bills.map((x) => x.entityId));
  if (pays.some((p) => p.mode === 'upi' && !ents.has(accts.find((a) => a.id === p.payAccountId)?.entityId)) && !(d.confirm ?? []).includes('entity_mismatch')) {
    throw new OfflineError('The UPI was paid into an account of another billing name. Check, then confirm to settle anyway.', 409, 'entity_mismatch');
  }
  const room = pays.find((p) => p.mode === 'room');
  const stays = saved(`${B()}/stays`)?.data?.stays ?? [];
  const st = room ? stays.find((x) => x.accountId === room.debtorAccountId) : null;
  if (room && !st) throw new OfflineError('Choose an in-house room.', 400);
  const t = Date.now();
  const names = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'To room' };
  for (const x of bills) {
    x.status = 'settled'; x.settledAt = t;
    x.payments = pays.map((p) => ({ id: uuid(), mode: p.mode, shiftDay: shiftDayAt(t), amountPaise: p.amountPaise, cardLast4: p.cardLast4 || null, cardApproval: p.cardApproval || null,
      payAccount: accts.find((a) => a.id === p.payAccountId)?.name ?? null, debtorAccount: st ? `Room ${st.room}` : null, tenderedPaise: p.tendered ? Math.round(Number(p.tendered) * 100) : null }));
    if (!s.bills[x.id]) s.bills[x.id] = x;
    try { orderHere(x.orderId).status = 'closed'; } catch { /* its order is not saved here: the bill is enough */ }
  }
  const placeOf = bills.map((x) => x.place).join(', ');
  addStep({ orderId: bills[0].orderId, method: 'POST', path: '/settlements', body: { billIds: ids, payments: d.payments, difference: d.difference, confirm: d.confirm },
    what: `Paid ${bills.map((x) => x.billNo).join(', ')} · ${[...new Set(pays.map((p) => names[p.mode]))].join(' + ')}`, place: placeOf, amountPaise: paid,
    ...(st ? { room: { accountId: st.accountId, room: st.room, guest: st.guestName, amountPaise: room.amountPaise } } : {}) });
  changed();
  const change = pays.reduce((x, p) => x + (p.tendered ? Math.round(Number(p.tendered) * 100) - p.amountPaise : 0), 0);
  return { settlementId: uuid(), changePaise: change, tipPaise: Math.max(0, paid - due), discountPaise: 0, bills };
}

function receipt(accountId, d) {
  if (!can('debtors.receive')) throw new OfflineError('Your role does not allow this.', 403);
  const stays = saved(`${B()}/stays`)?.data?.stays ?? [];
  const st = stays.find((x) => x.accountId === accountId);
  if (!st) needsNet('Money on a credit account');
  if (!['receipt', 'advance', 'deposit'].includes(d.kind)) throw new OfflineError('Kind must be receipt, advance or deposit.', 400);
  const pays = (d.payments ?? []).map((p) => {
    if (!['cash', 'upi', 'card'].includes(p.mode)) throw new OfflineError('Cash, UPI or card only.', 400);
    const amountPaise = Math.round(Number(String(p.amount).replace(/,/g, '')) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) throw new OfflineError('Type the amount.', 400);
    return { ...p, amountPaise };
  });
  if (!pays.length) throw new OfflineError('Add how it was paid.', 400);
  const total = pays.reduce((x, p) => x + p.amountPaise, 0);
  const owed = st.balancePaise + roomChange(accountId);
  if (d.kind === 'receipt' && total > owed) throw new OfflineError(owed > 0 ? `${st.guestName} owes ₹${(owed / 100).toFixed(2)} (as saved on this PC). Take the rest as an advance.` : `${st.guestName} owes nothing (as saved on this PC). Take it as an advance.`, 400);
  const t = Date.now();
  const fy = fyOf(shiftDayAt(t));
  const fy2 = fy.slice(2);
  const receiptNo = `RCPT/${fy2}/${letter()}${String(next(s.counters.rcpt, fy2)).padStart(3, '0')}`;
  const accts = saved(`${B()}/pay-accounts`)?.data?.accounts ?? [];
  addStep({ method: 'POST', path: `/debtors/${accountId}/receipts`, body: { kind: d.kind, payments: d.payments }, receiptNo,
    what: `Room payment ${receiptNo}`, place: `Room ${st.room}`, amountPaise: total, room: { accountId, room: st.room, guest: st.guestName, amountPaise: -total } });
  changed();
  const balancePaise = owed - total;
  return { settlementId: uuid(), balancePaise, receipt: { receiptNo, kind: d.kind, at: t, name: st.guestName, room: st.room, totalPaise: total, balancePaise,
    payments: pays.map((p) => ({ mode: p.mode, amountPaise: p.amountPaise, payAccountName: accts.find((a) => a.id === p.payAccountId)?.name ?? null, cardLast4: p.cardLast4 || null })) } };
}

/** Functions of the counter screens used here, so a bill made offline is worked out exactly as on screen. */
const hooks = { previewTotals: null, dishTax: null, dishFlags: null };
export const useHooks = (h) => Object.assign(hooks, h);

// ---------- sending up

/**
 * Sends every waiting step, oldest first. A step the server refuses is marked "needs a look" with its reason, and the
 * steps of the same order after it wait for it. Sending again later is always safe: a step already saved is not saved twice.
 */
export async function sync() {
  if (syncing || !s || !online || !letter()) return;
  syncing = true;
  changed();
  try {
    const failed = new Set();
    for (const x of s.steps) {
      if (x.status === 'sent') continue;
      if (x.orderId && failed.has(x.orderId)) { x.status = 'blocked'; x.error = 'Waits for the step above on this order.'; continue; }
      let r;
      try {
        r = await send(x);
      } catch (e) {
        if (e?.network) { online = false; s.since ??= Date.now(); probeSoon(); break; }
        r = { ok: false, error: e.message };
      }
      if (r.ok && r.signin) { break; }
      // A table someone opened online meanwhile: this order goes up as "T5 (offline)", so nothing is lost.
      if (!r.ok && x.open && x.body.place && r.status === 409 && !/\(offline\)$/.test(x.body.place)) {
        x.body = { ...x.body, place: `${x.body.place} (offline)`.slice(0, 40) };
        x.note = `${x.place} was open on another device: saved as ${x.body.place}.`;
        r = await send(x).catch((e) => ({ ok: false, error: e.message }));
      }
      if (r.ok) {
        x.status = 'sent'; x.sentAt = Date.now(); x.error = null;
        if (r.mismatch) x.note = `The total saved differs from the paper. The manager checks this bill.`;
      } else {
        x.status = 'look'; x.error = r.error ?? 'It could not be saved.';
        if (x.orderId) failed.add(x.orderId);
      }
      save();
      listeners.forEach((f) => { try { f(); } catch { /* screen gone */ } });
    }
    // Everything sent: this PC's copies of orders and bills are done with; screens read the server again.
    if (!live().length) {
      s.orders = {}; s.bills = {}; s.since = null;
      s.steps = s.steps.filter((x) => x.status === 'sent' && x.sentAt > Date.now() - DAY);
    } else if (online) {
      // Orders with nothing left to send go back to the server's copy.
      const open = new Set(live().map((x) => x.orderId));
      for (const id of Object.keys(s.orders)) if (!open.has(id)) delete s.orders[id];
    }
  } finally {
    syncing = false;
    changed();
  }
}

async function send(x) {
  const body = { stepId: x.id, at: x.at, method: x.method, path: x.path, body: x.body, localId: x.localId, kotLabels: x.kotLabels, billNo: x.billNo, receiptNo: x.receiptNo, expectTotalPaise: x.expectTotalPaise };
  let res;
  try {
    res = await fetch(`/api${B()}/offline/replay`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { const e = new Error('No internet'); e.network = true; throw e; }
  if (res.status === 401) return { ok: true, signin: true };
  const data = await res.json().catch(() => null);
  if (res.status >= 500) { const e = new Error('No internet'); e.network = true; throw e; }
  if (!res.ok) return { ok: false, status: res.status, error: data?.error ?? 'It could not be saved.' };
  return data;
}

/** Tries a step that needs a look once more (after the manager fixed what it said), and the steps waiting for it. */
export async function retry() {
  for (const x of s?.steps ?? []) if (x.status === 'look' || x.status === 'blocked') x.status = 'wait';
  save();
  await sync();
}
