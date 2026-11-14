// Restaurant POS counter screens. Talks only to /api on the same origin; the server decides every permission and rule.
// Hiding buttons by role here is for tidiness only. Every value from the server is escaped before it is shown.

const root = document.getElementById('app');
const printArea = document.getElementById('print');

// ---------- helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += (Array.isArray(v) ? v.map(asHtml).join('') : asHtml(v)) + strings[i + 1]; });
  return { __html: out };
}
const asHtml = (v) => (v && typeof v === 'object' && '__html' in v ? v.__html : v === false || v === null || v === undefined ? '' : esc(v));

/** Paise → '₹1,234.50' (or '₹1,234'). */
function rs(p) {
  const neg = p < 0; const a = Math.abs(p);
  const r = Math.floor(a / 100).toLocaleString('en-IN'); const ps = a % 100;
  return `${neg ? '−' : ''}₹${r}${ps ? '.' + String(ps).padStart(2, '0') : ''}`;
}
/** Paise → '1234.50', the form the server reads. */
const rupees = (p) => `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`;
/** Typed rupees → paise, or null. */
function toPaise(t) {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(t ?? '').replace(/,/g, '').trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}
const time = (ms) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dateTime = (ms) => new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
async function api(method, path, body) {
  if (body === undefined && method !== 'GET') body = {};
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !['/me', '/auth/login', '/auth/pin'].includes(path)) { me = null; go('#/signin'); throw new ApiError('Please sign in.', 401); }
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong.', res.status, data?.code);
  return data;
}

// ---------- state

let me = null;          // { staff, business, actions }
let cache = {};         // menu, reasons, entities, payAccounts, stays, credit (loaded per screen)
let ui = {};            // the current screen's own state; reset on every route change
let flash = null;       // { kind, text } shown once at the top
const can = (a) => !!me?.actions.includes(a);
const B = () => `/businesses/${me.business.id}`;

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
window.addEventListener('hashchange', route);

async function load(...keys) {
  const paths = { menu: '/menu', reasons: '/reasons', entities: '/entities', payAccounts: '/pay-accounts', stays: '/stays', credit: '/credit-accounts' };
  await Promise.all(keys.map(async (k) => {
    const d = await api('GET', B() + paths[k]);
    cache[k] = k === 'menu' ? d.items : k === 'entities' ? d.entities : k === 'payAccounts' ? d.accounts : k === 'credit' ? d.accounts : d[k];
  }));
}
const reasonsOf = (kind) => (cache.reasons ?? []).filter((r) => r.kind === kind);
const counterEntities = () => (cache.entities ?? []).filter((e) => e.active && e.offered);

// ---------- rendering

function shell(active, body) {
  const links = [['#/', 'Tables', 'pos.view'], ['#/rooms', 'Rooms and credit', 'pos.view'], ['#/shift', 'Shift close', 'shift.close'],
    ['#/reports', 'Reports', 'reports.view'], ['#/exceptions', 'Exceptions', 'reports.view'], ['#/settings', 'Settings', 'menu.edit']].filter((l) => can(l[2]));
  return html`<header class="top">
    <div class="row"><span class="brand">${me.business.name}</span>
      <nav aria-label="Main">${links.map(([h, t]) => html`<a href="${h}" ${active === h ? html`aria-current="page"` : ''}>${t}</a>`)}</nav></div>
    <div class="who"><span>Shift ${me.business.shiftDay} · ${me.staff.name}</span><button type="button" data-act="logout">Sign out</button></div>
  </header>
  <main>${flash ? html`<div class="msg ${flash.kind}" role="status" style="margin-bottom:14px">${flash.text}</div>` : ''}${body}</main>`;
}

function paint(view) { root.innerHTML = asHtml(view); flash = null; const f = root.querySelector('[autofocus]'); if (f) f.focus(); }
const errorBox = () => (ui.error ? html`<div class="msg bad" role="alert">${ui.error}</div>` : '');

async function route() {
  ui = {};
  try {
    if (!me) {
      try { me = await api('GET', '/me'); } catch { me = null; }
    }
    if (!me) return await signIn();
    const [path, a, b] = location.hash.replace(/^#\/?/, '').split('/');
    if (path === 'order') return await orderScreen(a);
    if (path === 'bill') return await billScreen(a);
    if (path === 'settle') return await settleScreen(a, b);
    if (path === 'done') return await doneScreen(a);
    if (path === 'rooms') return await roomsScreen();
    if (path === 'shift') return await shiftScreen();
    if (path === 'exceptions') return await exceptionsScreen(a);
    if (path === 'reports') return await reportsScreen(a, b);
    if (path === 'settings') return await settingsScreen(a);
    return await tablesScreen();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    root.innerHTML = asHtml(html`<main><div class="msg bad" role="alert">${e.message}</div><p style="margin-top:12px"><a href="#/">Back to tables</a></p></main>`);
  }
}

// ---------- events: buttons carry data-act; inputs carry data-model (a key in ui)

const actions = {};
root.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  ev.preventDefault();
  const fn = actions[el.dataset.act];
  if (!fn) return;
  try { await fn(el.dataset, el); } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    ui.error = e.message; rerender();
  }
});
root.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.model) {
    ui[el.dataset.model] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.live !== undefined) refocus(el.dataset.model, () => rerender());
  }
});
root.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.model && el.tagName === 'SELECT') { ui[el.dataset.model] = el.value; rerender(); }
});
root.addEventListener('submit', (ev) => { ev.preventDefault(); const b = ev.target.querySelector('[data-submit]'); if (b) b.click(); });
let rerender = () => {};
/** Repaints while typing without losing the field being typed in. */
function refocus(model, paintNow) {
  paintNow();
  const el = root.querySelector(`[data-model="${model}"]`);
  if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n); } catch { /* number-like inputs */ } }
}

// ---------- sign-in

async function signIn() {
  const d = await api('GET', '/device');
  ui.device = d.device; ui.people = d.people ?? []; ui.pin = ''; ui.who = null;
  rerender = () => {
    if (ui.device && !ui.passwordMode) {
      const person = ui.people.find((p) => p.id === ui.who);
      paint(html`<main><div class="signin panel">
        <h1>${ui.device.businessName}</h1><p class="quiet">${ui.device.name}${ui.device.locked ? ' · PIN sign-in is locked for a few minutes' : ''}</p>
        ${errorBox()}
        ${person ? html`<p>PIN for <strong>${person.name}</strong></p>
          <div class="dots" aria-live="polite">${'•'.repeat(ui.pin.length)}</div>
          <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => html`<button type="button" data-act="pinKey" data-k="${k}">${k}</button>`)}
            <button type="button" data-act="pinBack" aria-label="Delete">⌫</button><button type="button" data-act="pinKey" data-k="0">0</button>
            <button type="button" data-act="pinGo" class="pri" style="background:var(--accent);color:#fff;border-color:var(--accent)">OK</button></div>
          <button class="btn" type="button" data-act="pinWho" data-id="">Someone else</button>`
        : html`<p>Who is signing in?</p><div class="chips">${ui.people.map((p) => html`<button type="button" class="chip" data-act="pinWho" data-id="${p.id}">${p.name}</button>`)}</div>
          <button class="btn" type="button" data-act="pwMode">Owner or manager: sign in with email</button>`}
      </div></main>`);
    } else {
      paint(html`<main><form class="signin panel">
        <h1>Sign in</h1>${errorBox()}
        <label class="f">Email<input class="in" type="email" autocomplete="username" data-model="email" value="${ui.email ?? ''}" autofocus></label>
        <label class="f">Password<input class="in" type="password" autocomplete="current-password" data-model="password"></label>
        <button class="btn pri" type="submit" data-act="login" data-submit>Sign in</button>
        ${ui.device ? html`<button class="btn" type="button" data-act="pwMode">Back to PIN sign-in</button>` : html`<p class="quiet small">Counter staff sign in with a PIN on a counter device. An Owner sets up a device from Settings.</p>`}
      </form></main>`);
    }
  };
  rerender();
}
actions.pinWho = (d) => { ui.who = d.id || null; ui.pin = ''; ui.error = null; rerender(); };
actions.pinKey = (d) => { if (ui.pin.length < 6) ui.pin += d.k; rerender(); };
actions.pinBack = () => { ui.pin = ui.pin.slice(0, -1); rerender(); };
actions.pinGo = async () => {
  try { await api('POST', '/auth/pin', { staffId: ui.who, pin: ui.pin }); } catch (e) { ui.pin = ''; throw e; }
  me = null; go('#/');
};
actions.pwMode = () => { ui.passwordMode = !ui.passwordMode; ui.error = null; rerender(); };
actions.login = async () => { await api('POST', '/auth/login', { email: ui.email ?? '', password: ui.password ?? '' }); me = null; go('#/'); };
actions.logout = async () => { await api('POST', '/auth/logout'); me = null; cache = {}; go('#/signin'); };

// ---------- tables

async function tablesScreen() {
  const [{ orders }] = await Promise.all([api('GET', B() + '/orders'), load('stays')]);
  ui.orders = orders;
  rerender = () => {
    const tile = (o) => {
      const st = o.status === 'billed' ? html`<span class="st billed">Bill ${o.bill?.billNo} · ${rs(o.bill?.totalPaise ?? 0)} to pay</span>`
        : o.status === 'tab' ? html`<span class="st tab">Tab since ${o.openedShiftDay}</span>`
        : html`<span class="st open">Order open · ${o.lines.length} items</span>`;
      const href = o.status === 'billed' ? `#/settle/${o.bill.id}` : `#/order/${o.id}`;
      return html`<a class="tile" href="${href}" style="color:inherit;text-decoration:none"><span class="name">${o.place}</span>${st}
        <span class="small quiet">${o.guestName ? o.guestName + ' · ' : ''}${rs(o.itemsPaise)} · opened ${time(o.openedAt)}</span></a>`;
    };
    paint(shell('#/', html`<div class="row" style="justify-content:space-between;margin-bottom:16px"><h1>Tables and orders</h1>
        ${can('orders.edit') ? html`<div class="row"><button class="btn pri" type="button" data-act="newOrder" data-kind="table">New table order</button>
          <button class="btn" type="button" data-act="newOrder" data-kind="room">Room service</button>
          <button class="btn" type="button" data-act="newOrder" data-kind="takeaway">Takeaway</button></div>` : ''}</div>
      ${errorBox()}
      ${ui.picking ? newOrderForm() : ''}
      ${ui.orders.length ? html`<div class="tiles">${ui.orders.map(tile)}</div>` : html`<p class="quiet">No open orders. Start one above.</p>`}`));
  };
  rerender();
}
function newOrderForm() {
  const k = ui.picking;
  return html`<form class="panel" style="margin-bottom:16px;max-width:560px">
    <h2>${k === 'table' ? 'New table order' : k === 'room' ? 'Room service' : 'Takeaway'}</h2>
    ${k === 'table' ? html`<div class="grid2"><label class="f">Table<input class="in" data-model="place" autofocus placeholder="e.g. T4"></label>
      <label class="f">Guests<input class="in" inputmode="numeric" data-model="covers"></label></div>
      <label class="f">Guest name (for a tab, optional)<input class="in" data-model="guestName"></label>` : ''}
    ${k === 'room' ? (cache.stays.length ? html`<div class="chips">${cache.stays.map((s) => html`<button type="button" class="chip" aria-pressed="${ui.stayId === s.id}" data-act="pickStay" data-id="${s.id}">Room ${s.room} · ${s.guestName}</button>`)}</div>`
      : html`<p class="quiet">No room has an open stay. Open one on Rooms and credit.</p>`) : ''}
    ${k === 'takeaway' ? html`<label class="f">Guest name (optional)<input class="in" data-model="guestName" autofocus></label>` : ''}
    <div class="row"><button class="btn pri" type="submit" data-act="openOrder" data-submit>Start order</button><button class="btn" type="button" data-act="newOrder" data-kind="">Cancel</button></div>
  </form>`;
}
actions.newOrder = (d) => { ui.picking = d.kind || null; ui.stayId = null; ui.error = null; rerender(); };
actions.pickStay = (d) => { ui.stayId = d.id; rerender(); };
actions.openOrder = async () => {
  const covers = Number(ui.covers);
  const r = await api('POST', B() + '/orders', { kind: ui.picking, place: ui.place, stayId: ui.stayId, guestName: ui.guestName, covers: Number.isInteger(covers) && covers > 0 ? covers : undefined });
  go(`#/order/${r.id}`);
};

// ---------- order

async function orderScreen(id) {
  await load('menu', 'reasons');
  ui.order = (await api('GET', `${B()}/orders/${id}`)).order;
  ui.cat = 'All';
  rerender = () => {
    const o = ui.order;
    if (o.status === 'billed' || o.status === 'closed') { paint(shell('#/', html`<p>This order is already billed. <a href="#/">Back to tables</a></p>`)); return; }
    const menu = cache.menu.filter((m) => m.active);
    const cats = ['All', ...new Set(menu.map((m) => m.category))];
    const qty = (itemId) => o.lines.find((l) => l.itemId === itemId)?.qty ?? 0;
    const unsent = o.lines.some((l) => l.qty > l.sentQty);
    paint(shell('#/', html`<div class="order">
      <section class="menu" aria-label="Menu">
        <div class="chips">${cats.map((c) => html`<button type="button" class="chip" aria-pressed="${ui.cat === c}" data-act="cat" data-c="${c}">${c}</button>`)}</div>
        <div class="items">${menu.filter((m) => ui.cat === 'All' || m.category === ui.cat).map((m) => html`<button type="button" class="item" data-act="add" data-id="${m.id}">
          <strong>${m.name}</strong><span class="quiet small">${rs(m.pricePaise)}</span>${qty(m.id) ? html`<span class="q">${qty(m.id)}</span>` : ''}</button>`)}</div>
      </section>
      <section class="ticket panel" aria-label="Order">
        <div class="row" style="justify-content:space-between"><div><h2>${o.place}</h2><p class="quiet small">${o.guestName ?? ''}${o.status === 'tab' ? ' · tab since ' + o.openedShiftDay : ''}</p></div>
          <a class="btn" href="#/">Back</a></div>
        ${errorBox()}
        ${ui.kotDone ? html`<div class="msg ok" role="status">${ui.kotDone}</div>` : ''}
        <div>${o.lines.length ? o.lines.map((l) => html`<div>
            <div class="line"><div class="grow"><div><strong>${l.name}</strong></div>
              <div class="sent ${l.qty > l.sentQty ? 'new' : ''}">${l.sentQty === 0 ? 'Not sent to kitchen' : l.qty > l.sentQty ? `${l.sentQty} sent · ${l.qty - l.sentQty} new` : 'Sent to kitchen'}</div></div>
              <button class="sq" type="button" data-act="less" data-id="${l.itemId}" aria-label="One less ${l.name}">−</button>
              <span style="width:22px;text-align:center;font-weight:700">${l.qty}</span>
              <button class="sq" type="button" data-act="add" data-id="${l.itemId}" aria-label="One more ${l.name}">+</button>
              <span class="num" style="width:76px;font-weight:600">${rs(l.qty * l.pricePaise)}</span></div>
            ${ui.asking === l.itemId ? html`<div class="msg warn"><p style="margin-bottom:8px"><strong>Already sent to the kitchen.</strong> Why cancel one?</p>
              <div class="chips">${reasonsOf('kot_cancel').map((r) => html`<button type="button" class="chip" data-act="lessWhy" data-id="${l.itemId}" data-r="${r.id}">${r.label}</button>`)}
              <button type="button" class="chip" data-act="lessNo">Keep it</button></div></div>` : ''}
          </div>`) : html`<p class="quiet">Tap dishes to add them.</p>`}</div>
        <div class="sums"><div class="big"><span>Items</span><span>${rs(o.lines.reduce((s, l) => s + l.qty * l.pricePaise, 0))}</span></div></div>
        <div class="row"><button class="btn grow" type="button" data-act="kot" ${unsent ? '' : 'disabled'}>Send KOT</button>
          ${can('bills.print') ? html`<a class="btn pri grow" href="#/bill/${o.id}" ${!o.lines.length || unsent ? html`aria-disabled="true" style="pointer-events:none;opacity:.5"` : ''}>Bill</a>` : ''}</div>
        ${ui.splitting ? html`<div class="msg warn"><p style="margin-bottom:8px"><strong>Split bill:</strong> choose what moves to a new bill at this table. Each bill gets its own number and GST.</p>
          ${o.lines.map((l) => html`<div class="line"><span class="grow">${l.name} <span class="quiet small">(${l.qty} on this bill)</span></span>
            <button class="sq" type="button" data-act="splitLess" data-id="${l.itemId}" aria-label="Move one less ${l.name}">−</button>
            <span style="width:22px;text-align:center;font-weight:700">${ui.split[l.itemId] ?? 0}</span>
            <button class="sq" type="button" data-act="splitMore" data-id="${l.itemId}" aria-label="Move one more ${l.name}">+</button></div>`)}
          <div class="row" style="margin-top:10px"><button class="btn pri" type="button" data-act="splitGo">Move to a new bill</button><button class="btn" type="button" data-act="splitNo">Cancel</button></div></div>` : ''}
        <div class="row">${o.lines.reduce((n, l) => n + l.qty, 0) > 1 && !ui.splitting ? html`<button class="btn grow" type="button" data-act="splitAsk">Split bill</button>` : ''}
          ${o.status === 'open' ? html`<button class="btn grow" type="button" data-act="keepTab">Keep open as a tab</button>` : ''}
          ${!o.lines.some((l) => l.sentQty) ? html`<button class="btn danger" type="button" data-act="dropOrder">Cancel order</button>` : ''}</div>
        ${ui.tabAsk ? html`<form class="msg warn"><label class="f">Guest name for the tab<input class="in" data-model="tabGuest" value="${o.guestName ?? ''}" autofocus></label>
          <div class="row" style="margin-top:8px"><button class="btn pri" type="submit" data-act="tabGo" data-submit>Keep as tab</button></div></form>` : ''}
      </section></div>`));
  };
  rerender();
}
actions.cat = (d) => { ui.cat = d.c; rerender(); };
actions.add = async (d) => { ui.error = null; ui.kotDone = null; ui.order = (await api('POST', `${B()}/orders/${ui.order.id}/items`, { itemId: d.id, delta: 1 })).order; rerender(); };
actions.less = async (d) => {
  const l = ui.order.lines.find((x) => x.itemId === d.id);
  if (l.qty <= l.sentQty) { ui.asking = d.id; rerender(); return; }
  ui.order = (await api('POST', `${B()}/orders/${ui.order.id}/items`, { itemId: d.id, delta: -1 })).order; rerender();
};
actions.lessWhy = async (d) => { ui.asking = null; ui.order = (await api('POST', `${B()}/orders/${ui.order.id}/items`, { itemId: d.id, delta: -1, reasonId: d.r })).order; rerender(); };
actions.lessNo = () => { ui.asking = null; rerender(); };
actions.kot = async () => {
  const { kots } = await api('POST', `${B()}/orders/${ui.order.id}/kot`);
  ui.order = (await api('GET', `${B()}/orders/${ui.order.id}`)).order;
  ui.kotDone = `KOT ${kots.map((k) => k.kotNo).join(', ')} sent (${kots.map((k) => k.station).join(', ')}).`;
  printKots(kots); rerender();
};
actions.keepTab = () => { ui.tabAsk = true; rerender(); };
actions.splitAsk = () => { ui.splitting = true; ui.split = {}; rerender(); };
actions.splitNo = () => { ui.splitting = false; rerender(); };
actions.splitMore = (d) => { const l = ui.order.lines.find((x) => x.itemId === d.id); ui.split[d.id] = Math.min(l.qty, (ui.split[d.id] ?? 0) + 1); rerender(); };
actions.splitLess = (d) => { ui.split[d.id] = Math.max(0, (ui.split[d.id] ?? 0) - 1); rerender(); };
actions.splitGo = async () => {
  const lines = Object.entries(ui.split).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));
  const r = await api('POST', `${B()}/orders/${ui.order.id}/split`, { lines });
  flash = { kind: 'ok', text: `Split. This is the new bill; ${ui.order.place} keeps the rest.` };
  go(`#/order/${r.id}`);
};
actions.tabGo = async () => { await api('POST', `${B()}/orders/${ui.order.id}/tab`, { guestName: ui.tabGuest ?? ui.order.guestName }); flash = { kind: 'ok', text: `${ui.order.place} kept as a tab.` }; go('#/'); };
actions.dropOrder = async () => { await api('POST', `${B()}/orders/${ui.order.id}/cancel`); go('#/'); };

// ---------- bill (choose the billing name and discount, then print)

async function billScreen(orderId) {
  await load('entities', 'reasons');
  ui.order = (await api('GET', `${B()}/orders/${orderId}`)).order;
  const ents = counterEntities();
  ui.entityId = (ents.find((e) => e.is_default) ?? ents[0])?.id;
  ui.disc = 0; ui.discReason = null;
  rerender = () => {
    const o = ui.order;
    const e = ents.find((x) => x.id === ui.entityId);
    const gross = o.lines.reduce((s, l) => s + l.qty * l.pricePaise, 0);
    const disc = Math.floor((gross * ui.disc * 2 + 100) / 200);
    const taxable = gross - disc;
    const half = e ? Math.floor((taxable * e.gst_rate_bp * 2 + 20000) / 40000) : 0;
    const raw = taxable + 2 * half;
    const total = Math.floor((raw * 2 + 100) / 200) * 100;
    const near = e && e.warn1_paise !== null && e.year_paise + total >= e.warn1_paise;
    paint(shell('#/', html`<div class="settle">
      <section class="panel"><div class="row" style="justify-content:space-between"><h2>${o.place} · bill</h2><a class="btn" href="#/order/${o.id}">Back</a></div>
        ${errorBox()}
        ${ents.length > 1 ? html`<div><p class="small quiet" style="font-weight:600;margin-bottom:6px">Bill in the name of</p>
          <div class="chips">${ents.map((x) => html`<button type="button" class="chip" aria-pressed="${ui.entityId === x.id}" data-act="ent" data-id="${x.id}">${x.name}${x.gst_registered ? ` (GST ${x.gst_rate_bp / 100}%)` : ' (no GST)'}</button>`)}</div></div>` : ''}
        ${near ? html`<div class="msg warn">${e.name} has ${rs(e.year_paise)} billed this year${e.stop_paise ? `; it stops at ${rs(e.stop_paise)}` : ''}.</div>` : ''}
        <div><p class="small quiet" style="font-weight:600;margin-bottom:6px">Discount</p>
          <div class="chips">${[0, 5, 10, 15].map((p) => html`<button type="button" class="chip" aria-pressed="${ui.disc === p}" data-act="disc" data-p="${p}">${p ? p + '%' : 'None'}</button>`)}</div>
          ${ui.disc ? html`<p class="small quiet" style="margin:10px 0 6px;font-weight:600">Reason (required)</p><div class="chips">${reasonsOf('discount').map((r) => html`<button type="button" class="chip" aria-pressed="${ui.discReason === r.id}" data-act="discWhy" data-id="${r.id}">${r.label}</button>`)}</div>` : ''}</div>
        <label class="f">Guest name on the bill (optional)<input class="in" data-model="guestName" value="${ui.guestName ?? o.guestName ?? ''}"></label>
        <div class="sums">${o.lines.map((l) => html`<div><span>${l.qty} × ${l.name}</span><span>${rs(l.qty * l.pricePaise)}</span></div>`)}
          ${disc ? html`<div><span class="quiet">Discount ${ui.disc}%</span><span>${rs(-disc)}</span></div>` : ''}
          ${half ? html`<div><span class="quiet">CGST ${e.gst_rate_bp / 200}%</span><span>${rs(half)}</span></div><div><span class="quiet">SGST ${e.gst_rate_bp / 200}%</span><span>${rs(half)}</span></div>` : ''}
          ${total !== raw ? html`<div><span class="quiet">Round off</span><span>${rs(total - raw)}</span></div>` : ''}
          <div class="big"><span>Total</span><span>${rs(total)}</span></div></div>
        <button class="btn pri" type="button" data-act="printBill" ${!e || (ui.disc && !ui.discReason) ? 'disabled' : ''}>Print bill</button>
      </section></div>`));
  };
  rerender();
}
actions.ent = (d) => { ui.entityId = d.id; rerender(); };
actions.disc = (d) => { ui.disc = Number(d.p); if (!ui.disc) ui.discReason = null; rerender(); };
actions.discWhy = (d) => { ui.discReason = d.id; rerender(); };
actions.printBill = async () => {
  const r = await api('POST', `${B()}/orders/${ui.order.id}/bill`, {
    entityId: ui.entityId, guestName: ui.guestName,
    discount: ui.disc ? { kind: 'pct', bp: ui.disc * 100, reasonId: ui.discReason } : { kind: 'none' },
  });
  printReceipt(r.bill);
  if (r.warning) flash = { kind: 'warn', text: r.warning };
  go(`#/settle/${r.bill.id}`);
};

// ---------- settle

async function settleScreen(billId) {
  await load('reasons', 'payAccounts', 'stays', 'credit', 'entities');
  const [{ bill }, { orders }] = await Promise.all([api('GET', `${B()}/bills/${billId}`), api('GET', B() + '/orders')]);
  if (bill.status !== 'printed') { go(`#/done/${billId}`); return; }
  ui.bill = bill; ui.others = orders.filter((o) => o.status === 'billed' && o.bill && o.bill.id !== billId);
  ui.together = []; ui.pays = []; ui.mode = 'cash';
  rerender = () => {
    const due = ui.bill.totalPaise + ui.together.reduce((s, id) => s + ui.others.find((o) => o.bill.id === id).bill.totalPaise, 0);
    const paid = ui.pays.reduce((s, p) => s + p.amountPaise, 0);
    const left = due - paid;
    const m = ui.mode;
    const amountField = ['cash', 'upi', 'card', 'advance'].includes(m);
    const advanceAccts = [...cache.stays.map((s) => ({ id: s.accountId, name: `Room ${s.room} · ${s.guestName}`, bal: s.balancePaise })), ...cache.credit.map((c) => ({ id: c.id, name: c.name, bal: c.balancePaise }))].filter((a) => a.bal < 0);
    const modes = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['room', 'Post to room'], ['credit', 'Credit account'], ['comp', 'Complimentary'], ['advance', 'Use advance']];
    paint(shell('#/', html`<div class="settle">
      <section class="panel"><div class="row" style="justify-content:space-between"><h2>${ui.bill.place} · ${ui.bill.billNo}</h2><a class="btn" href="#/">Tables</a></div>
        <p class="small quiet">${ui.bill.entityName}${ui.bill.gstRegistered ? '' : ' · no GST'}</p>
        <div class="sums">${ui.bill.items.map((l) => html`<div><span>${l.qty} × ${l.name}</span><span>${rs(l.amountPaise)}</span></div>`)}
          ${ui.bill.discountPaise ? html`<div><span class="quiet">Discount · ${ui.bill.discountReason}</span><span>${rs(-ui.bill.discountPaise)}</span></div>` : ''}
          ${ui.bill.cgstPaise ? html`<div><span class="quiet">CGST + SGST</span><span>${rs(ui.bill.cgstPaise + ui.bill.sgstPaise)}</span></div>` : ''}
          <div class="big"><span>This bill</span><span>${rs(ui.bill.totalPaise)}</span></div></div>
        ${ui.others.length ? html`<div><p class="small quiet" style="font-weight:600;margin-bottom:6px">Paid together with</p>
          <div class="chips">${ui.others.map((o) => html`<button type="button" class="chip" aria-pressed="${ui.together.includes(o.bill.id)}" data-act="together" data-id="${o.bill.id}">${o.place} · ${o.bill.billNo} · ${rs(o.bill.totalPaise)}</button>`)}</div></div>` : ''}
        <div class="sums"><div class="big"><span>To pay</span><span>${rs(due)}</span></div></div>
        <div class="row">${can('bills.void') ? html`<button class="btn danger" type="button" data-act="voidAsk">Void bill</button>` : ''}<button class="btn" type="button" data-act="reprint">Reprint</button></div>
        ${ui.voidAsk ? html`<div class="msg warn"><p style="margin-bottom:8px"><strong>Void ${ui.bill.billNo}?</strong> The number stays used, and the order opens again to be billed afresh.</p>
          <div class="chips">${reasonsOf('void').map((r) => html`<button type="button" class="chip" data-act="voidGo" data-r="${r.id}">${r.label}</button>`)}<button type="button" class="chip" data-act="voidAsk">Keep the bill</button></div></div>` : ''}
      </section>
      <section class="panel"><h2>How was it paid?</h2>
        <div class="chips">${modes.map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${m === k}" data-act="mode" data-m="${k}">${t}</button>`)}</div>
        <div class="row small"><span class="quiet">Split equally between</span>${[2, 3, 4, 5, 6].map((n) => html`<button type="button" class="chip" style="min-height:36px" aria-pressed="${ui.shares === n}" data-act="shares" data-n="${n}">${n}</button>`)}
          ${ui.shares ? html`<span>Share ${Math.min(ui.pays.length + 1, ui.shares)} of ${ui.shares}</span>` : ''}</div>
        <form class="grid2">
          ${amountField ? html`<label class="f">${m === 'cash' ? 'Amount for this bill (₹)' : 'Amount (₹)'}<input class="in" inputmode="decimal" data-model="amount" value="${ui.amount ?? (left > 0 ? rupees(shareOf(due, left)) : '')}"></label>` : ''}
          ${m === 'cash' ? html`<label class="f">Cash given (₹, optional)<input class="in" inputmode="decimal" data-model="tendered" value="${ui.tendered ?? ''}"></label>` : ''}
          ${m === 'upi' ? html`<div class="f" style="grid-column:1/-1">QR paid into<div class="chips">${cache.payAccounts.filter((a) => a.active).map((a) => html`<button type="button" class="chip" aria-pressed="${ui.payAccountId === a.id}" data-act="pick" data-k="payAccountId" data-id="${a.id}">${a.name}</button>`)}</div></div>` : ''}
          ${m === 'card' ? html`<label class="f">Approval code (from the slip)<input class="in" data-model="cardApproval" value="${ui.cardApproval ?? ''}" maxlength="6" autocomplete="off"></label>
            <label class="f">Card last 4<input class="in" inputmode="numeric" data-model="cardLast4" value="${ui.cardLast4 ?? ''}" maxlength="4" autocomplete="off"></label>` : ''}
          ${m === 'room' ? html`<div class="f" style="grid-column:1/-1">In-house room${cache.stays.length ? html`<div class="chips">${cache.stays.map((s) => html`<button type="button" class="chip" aria-pressed="${ui.debtorAccountId === s.accountId}" data-act="pick" data-k="debtorAccountId" data-id="${s.accountId}">Room ${s.room} · ${s.guestName}</button>`)}</div>` : html`<span>No open stays.</span>`}</div>` : ''}
          ${m === 'credit' ? html`<div class="f" style="grid-column:1/-1">Credit account<div class="chips">${cache.credit.map((c) => html`<button type="button" class="chip" aria-pressed="${ui.debtorAccountId === c.id}" data-act="pick" data-k="debtorAccountId" data-id="${c.id}">${c.name}</button>`)}
              <button type="button" class="chip" aria-pressed="${ui.debtorAccountId === 'new'}" data-act="pick" data-k="debtorAccountId" data-id="new">New account</button></div></div>
            ${ui.debtorAccountId === 'new' ? html`<label class="f">Name<input class="in" data-model="newName" value="${ui.newName ?? ''}"></label><label class="f">Phone<input class="in" inputmode="tel" data-model="newPhone" value="${ui.newPhone ?? ''}"></label>` : ''}` : ''}
          ${m === 'comp' ? html`<label class="f">Guest name (required)<input class="in" data-model="compGuest" value="${ui.compGuest ?? ''}"></label>
            <div class="f">Reason (required)<div class="chips">${reasonsOf('comp').map((r) => html`<button type="button" class="chip" aria-pressed="${ui.compReason === r.id}" data-act="pick" data-k="compReason" data-id="${r.id}">${r.label}</button>`)}</div></div>` : ''}
          ${m === 'advance' ? html`<div class="f" style="grid-column:1/-1">Whose advance${advanceAccts.length ? html`<div class="chips">${advanceAccts.map((a) => html`<button type="button" class="chip" aria-pressed="${ui.debtorAccountId === a.id}" data-act="pick" data-k="debtorAccountId" data-id="${a.id}">${a.name} · ${rs(-a.bal)} left</button>`)}</div>` : html`<span>Nobody has an advance.</span>`}</div>` : ''}
        </form>
        ${errorBox()}
        ${ui.mismatch ? html`<div class="msg warn"><p style="margin-bottom:8px">${ui.mismatch}</p><button class="btn" type="button" data-act="settle" data-confirm="1">Settle anyway</button></div>` : ''}
        <div><button class="btn" type="button" data-act="addPay" ${left > 0 ? '' : 'disabled'}>Add this payment</button></div>
        <div><p class="small quiet" style="font-weight:600">Payments</p>
          ${ui.pays.length ? ui.pays.map((p, i) => html`<div class="line"><strong style="width:130px">${p.label}</strong><span class="grow quiet small">${p.detail}</span><span class="num">${rs(p.amountPaise)}</span>
            <button class="btn" type="button" data-act="dropPay" data-i="${i}">Remove</button></div>`) : html`<p class="quiet small">None yet. The bill closes only when payments add up to the total.</p>`}</div>
        <div class="row" style="justify-content:space-between"><strong style="font-size:17px;color:${left === 0 ? 'var(--accent)' : 'inherit'}">${left === 0 ? 'Paid in full' : left > 0 ? 'Left to pay ' + rs(left) : 'Over by ' + rs(-left)}</strong>
          <button class="btn pri" type="button" data-act="settle" ${left === 0 && ui.pays.length ? '' : 'disabled'}>Settle</button></div>
      </section></div>`));
  };
  rerender();
}
/** With "split equally", each payment is an equal share; the last share takes what is left (the odd paise). */
function shareOf(due, left) {
  if (!ui.shares) return left;
  const share = Math.floor(due / ui.shares);
  return ui.pays.length >= ui.shares - 1 ? left : Math.min(left, share);
}
actions.shares = (d) => { const n = Number(d.n); ui.shares = ui.shares === n ? null : n; ui.amount = undefined; rerender(); };
actions.together = (d) => { ui.together = ui.together.includes(d.id) ? ui.together.filter((x) => x !== d.id) : [...ui.together, d.id]; ui.amount = undefined; rerender(); };
actions.mode = (d) => { ui.mode = d.m; ui.error = null; ui.amount = undefined; ui.debtorAccountId = null; rerender(); };
actions.pick = (d) => { ui[d.k] = d.id; rerender(); };
actions.dropPay = (d) => { ui.pays.splice(Number(d.i), 1); ui.amount = undefined; ui.mismatch = null; rerender(); };
actions.addPay = () => {
  ui.error = null;
  const due = ui.bill.totalPaise + ui.together.reduce((s, id) => s + ui.others.find((o) => o.bill.id === id).bill.totalPaise, 0);
  const left = due - ui.pays.reduce((s, p) => s + p.amountPaise, 0);
  const m = ui.mode;
  let amountPaise = ['room', 'credit', 'comp'].includes(m) ? shareOf(due, left) : toPaise(ui.amount ?? rupees(shareOf(due, left)));
  if (!amountPaise || amountPaise <= 0) throw new Error('Type the amount.');
  if (amountPaise > left) throw new Error(m === 'cash' ? 'Type the bill amount here, and the note handed over as "cash given".' : 'More than what is left to pay.');
  const p = { mode: m, amount: rupees(amountPaise), amountPaise, label: { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Room', credit: 'Credit', comp: 'Complimentary', advance: 'Advance' }[m], detail: '' };
  if (m === 'cash' && ui.tendered) { const t = toPaise(ui.tendered); if (t === null || t < amountPaise) throw new Error('Cash given must be at least the amount.'); p.tendered = rupees(t); p.detail = t > amountPaise ? `Given ${rs(t)} · change ${rs(t - amountPaise)}` : 'Exact'; }
  if (m === 'upi') { if (!ui.payAccountId) throw new Error("Choose which account's QR was paid."); p.payAccountId = ui.payAccountId; p.detail = cache.payAccounts.find((a) => a.id === ui.payAccountId).name; }
  if (m === 'card') {
    const code = (ui.cardApproval ?? '').trim().toUpperCase(); const last4 = (ui.cardLast4 ?? '').trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Type the 6-character approval code from the card slip.');
    if (!/^\d{4}$/.test(last4)) throw new Error("Type the card's last 4 digits from the slip.");
    Object.assign(p, { cardApproval: code, cardLast4: last4, detail: `Approval ${code} · ****${last4}` });
  }
  if (m === 'room') { if (!ui.debtorAccountId) throw new Error('Choose the room.'); p.debtorAccountId = ui.debtorAccountId; p.detail = cache.stays.find((s) => s.accountId === ui.debtorAccountId).room; p.detail = 'Room ' + p.detail; }
  if (m === 'credit') {
    if (!ui.debtorAccountId) throw new Error('Choose a credit account, or New account.');
    if (ui.debtorAccountId === 'new') { if (!(ui.newName ?? '').trim()) throw new Error("Type the new account's name."); p.newCredit = { name: ui.newName.trim(), phone: ui.newPhone }; p.detail = ui.newName.trim() + ' (new)'; }
    else { p.debtorAccountId = ui.debtorAccountId; p.detail = cache.credit.find((c) => c.id === ui.debtorAccountId).name; }
  }
  if (m === 'comp') {
    if (!(ui.compGuest ?? '').trim()) throw new Error("A complimentary bill needs the guest's name.");
    if (!ui.compReason) throw new Error('Choose why it is complimentary.');
    Object.assign(p, { compGuest: ui.compGuest.trim(), reasonId: ui.compReason, detail: `${ui.compGuest.trim()} · ${reasonsOf('comp').find((r) => r.id === ui.compReason).label}` });
  }
  if (m === 'advance') { if (!ui.debtorAccountId) throw new Error('Choose whose advance to use.'); p.debtorAccountId = ui.debtorAccountId; p.detail = 'Advance'; }
  ui.pays.push(p);
  ui.amount = undefined; ui.tendered = undefined; ui.cardApproval = undefined; ui.cardLast4 = undefined;
  rerender();
};
actions.settle = async (d) => {
  ui.error = null;
  const body = { billIds: [ui.bill.id, ...ui.together], payments: ui.pays.map(({ label, detail, amountPaise, ...p }) => p), confirm: d.confirm ? ['entity_mismatch'] : [] };
  try {
    const r = await api('POST', B() + '/settlements', body);
    if (r.changePaise) flash = { kind: 'ok', text: `Give change: ${rs(r.changePaise)}` };
    go(`#/done/${ui.bill.id}`);
  } catch (e) {
    if (e.code === 'entity_mismatch') { ui.mismatch = e.message; rerender(); return; }
    throw e;
  }
};
actions.voidAsk = () => { ui.voidAsk = !ui.voidAsk; rerender(); };
actions.voidGo = async (d) => { await api('POST', `${B()}/bills/${ui.bill.id}/void`, { reasonId: d.r }); flash = { kind: 'ok', text: `${ui.bill.billNo} is void. Bill the order again.` }; go(`#/order/${ui.bill.orderId}`); };
actions.reprint = async () => { const r = await api('POST', `${B()}/bills/${(ui.bill ?? ui.done).id}/reprint`, { reason: 'Copy' }); printReceipt(r.bill); };

async function doneScreen(billId) {
  const { bill } = await api('GET', `${B()}/bills/${billId}`);
  ui.done = bill;
  rerender = () => paint(shell('#/', html`<div class="settle">
    <section class="panel" style="align-items:center">${receipt(bill)}</section>
    <section class="panel"><h1>${bill.status === 'settled' ? 'Settled' : bill.status === 'void' ? 'Void' : 'Printed, not paid'}</h1>
      <p>${bill.billNo} · ${bill.place} · ${rs(bill.totalPaise)}</p>
      <p class="quiet">The printed bill cannot be edited. A mistake before payment is fixed by voiding it with a reason and billing again.</p>
      <div class="row"><button class="btn pri" type="button" data-act="printDone">Print receipt</button><a class="btn" href="#/">Next order</a></div>
    </section></div>`));
  rerender();
}
actions.printDone = () => printReceipt(ui.done);

// ---------- printing (the browser's print dialog; a thermal printer set as the default prints 80 mm slips)

function receipt(b) {
  return html`<div class="receipt">
    <div class="hd">${b.entityName}</div>
    ${b.gstRegistered ? html`<div class="c">GSTIN ${b.gstin}</div><div class="c">TAX INVOICE</div>` : html`<div class="c">BILL</div>`}
    <div class="rl"><span>Bill ${b.billNo}</span><span>${dateTime(b.printedAt)}</span></div>
    <div class="rl"><span>${b.place}</span><span>${b.printedBy ?? ''}</span></div>
    ${b.guestName ? html`<div>Guest: ${b.guestName}</div>` : ''}
    ${b.printCount > 1 ? html`<div class="c">COPY ${b.printCount - 1}</div>` : ''}
    <hr>${b.items.map((l) => html`<div class="rl"><span>${l.qty} × ${l.name}</span><span>${rs(l.amountPaise)}</span></div>`)}<hr>
    <div class="rl"><span>Items</span><span>${rs(b.grossPaise)}</span></div>
    ${b.discountPaise ? html`<div class="rl"><span>Discount</span><span>${rs(-b.discountPaise)}</span></div>` : ''}
    ${b.gstRegistered ? html`<div class="rl"><span>CGST ${b.gstRateBp / 200}% (SAC ${b.items[0]?.sac ?? ''})</span><span>${rs(b.cgstPaise)}</span></div><div class="rl"><span>SGST ${b.gstRateBp / 200}%</span><span>${rs(b.sgstPaise)}</span></div>` : ''}
    ${b.roundOffPaise ? html`<div class="rl"><span>Round off</span><span>${rs(b.roundOffPaise)}</span></div>` : ''}
    <div class="rl" style="font-weight:700"><span>TOTAL</span><span>${rs(b.totalPaise)}</span></div>
    ${b.payments?.length ? html`<hr>${b.payments.map((p) => html`<div class="rl"><span>${{ cash: 'Cash', upi: 'UPI', card: 'Card', room: 'To room', credit: 'On credit', comp: 'Complimentary', advance: 'Advance' }[p.mode]}${p.cardLast4 ? ' ****' + p.cardLast4 : ''}</span><span>${rs(p.amountPaise)}</span></div>`)}` : ''}
    ${b.status === 'void' ? html`<div class="c" style="font-weight:700">VOID</div>` : ''}
  </div>`;
}
function printReceipt(b) { printArea.innerHTML = asHtml(receipt(b)); window.print(); }
function printKots(kots) {
  printArea.innerHTML = asHtml(html`${kots.map((k) => html`<div class="receipt" style="page-break-after:always"><div class="hd">KOT ${k.kotNo} · ${k.station.toUpperCase()}</div>
    <div class="rl"><span>${k.place}</span><span>${time(Date.now())}</span></div><hr>${k.lines.map((l) => html`<div style="font-size:15px">${l.qty} × ${l.name}</div>`)}</div>`)}`);
  window.print();
}

// ---------- rooms and credit accounts

async function roomsScreen() {
  await load('stays', 'credit', 'payAccounts');
  rerender = () => paint(shell('#/rooms', html`<div class="grid2" style="align-items:start">
    <section class="panel"><h2>In-house rooms</h2>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Room</th><th>Guest</th><th>Since</th><th class="num">Owes</th><th></th></tr></thead><tbody>
        ${cache.stays.map((s) => html`<tr><td>${s.room}</td><td>${s.guestName}</td><td>${s.checkIn}</td><td class="num">${rs(s.balancePaise)}</td>
          <td><div class="row"><button class="btn" type="button" data-act="recv" data-id="${s.accountId}" data-n="Room ${s.room} · ${s.guestName}">Take payment</button>
          ${s.balancePaise < 0 ? html`<button class="btn" type="button" data-act="refundAsk" data-id="${s.accountId}" data-n="Room ${s.room} · ${s.guestName}" data-max="${-s.balancePaise}">Refund advance</button>` : ''}
          <button class="btn" type="button" data-act="checkOut" data-id="${s.id}">Check out</button></div></td></tr>`)}
      </tbody></table></div>
      ${can('stays.edit') ? html`<form class="grid2"><label class="f">Room<input class="in" data-model="room"></label><label class="f">Guest name<input class="in" data-model="guest"></label>
        <button class="btn pri" type="submit" data-act="openStay" data-submit>Open stay</button></form>` : ''}
    </section>
    <section class="panel"><h2>Credit accounts</h2>
      <div class="scroll"><table class="t"><thead><tr><th>Name</th><th class="num">Owes</th><th class="num">Limit</th><th></th></tr></thead><tbody>
        ${cache.credit.map((a) => html`<tr><td>${a.name}${a.phone ? html`<div class="small quiet">${a.phone}</div>` : ''}</td><td class="num">${rs(a.balancePaise)}</td>
          <td class="num">${a.creditLimitPaise ? rs(a.creditLimitPaise) : '—'}</td><td><div class="row"><button class="btn" type="button" data-act="recv" data-id="${a.id}" data-n="${a.name}">Take payment</button>
          ${a.balancePaise < 0 ? html`<button class="btn" type="button" data-act="refundAsk" data-id="${a.id}" data-n="${a.name}" data-max="${-a.balancePaise}">Refund advance</button>` : ''}</div></td></tr>`)}
      </tbody></table></div><p class="small quiet">New credit accounts are made at the settle screen. A negative amount owed is an advance.</p>
    </section>
    ${ui.refund ? html`<form class="panel" style="grid-column:1/-1;max-width:640px"><h2>Refund advance to ${ui.refund.name}</h2>
      <p class="quiet small">${rs(ui.refund.max)} of advance is held.</p>
      <div class="chips">${[['cash', 'Cash from the drawer'], ['upi', 'UPI']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.refundMode ?? 'cash') === k}" data-act="pick" data-k="refundMode" data-id="${k}">${t}</button>`)}</div>
      <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="refundAmount" value="${ui.refundAmount ?? rupees(ui.refund.max)}"></label>
        <label class="f">Note (optional)<input class="in" data-model="refundNote"></label></div>
      <div class="row"><button class="btn pri" type="submit" data-act="refundGo" data-submit>Refund</button><button class="btn" type="button" data-act="refundNo">Cancel</button></div></form>` : ''}
    ${ui.recv ? html`<form class="panel" style="grid-column:1/-1;max-width:640px"><h2>Payment from ${ui.recv.name}</h2>
      <div class="chips"><button type="button" class="chip" aria-pressed="${ui.recvKind !== 'advance'}" data-act="pick" data-k="recvKind" data-id="receipt">Against what is owed</button>
        <button type="button" class="chip" aria-pressed="${ui.recvKind === 'advance'}" data-act="pick" data-k="recvKind" data-id="advance">Advance</button></div>
      <div class="chips">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.recvMode ?? 'cash') === k}" data-act="pick" data-k="recvMode" data-id="${k}">${t}</button>`)}</div>
      <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="recvAmount" value="${ui.recvAmount ?? ''}"></label>
        ${ui.recvMode === 'upi' ? html`<div class="f">QR paid into<div class="chips">${cache.payAccounts.filter((a) => a.active).map((a) => html`<button type="button" class="chip" aria-pressed="${ui.payAccountId === a.id}" data-act="pick" data-k="payAccountId" data-id="${a.id}">${a.name}</button>`)}</div></div>` : ''}
        ${ui.recvMode === 'card' ? html`<label class="f">Approval code<input class="in" data-model="cardApproval" maxlength="6"></label><label class="f">Card last 4<input class="in" inputmode="numeric" data-model="cardLast4" maxlength="4"></label>` : ''}</div>
      <div class="row"><button class="btn pri" type="submit" data-act="recvGo" data-submit>Take payment</button><button class="btn" type="button" data-act="recvNo">Cancel</button></div></form>` : ''}
  </div>`));
  rerender();
}
actions.openStay = async () => { await api('POST', B() + '/stays', { room: ui.room, guestName: ui.guest }); flash = { kind: 'ok', text: `Stay opened for room ${ui.room}.` }; route(); };
actions.checkOut = async (d) => { await api('POST', `${B()}/stays/${d.id}/check-out`); flash = { kind: 'ok', text: 'Checked out.' }; route(); };
actions.recv = (d) => { ui.recv = { id: d.id, name: d.n }; ui.recvMode = 'cash'; ui.recvKind = 'receipt'; ui.error = null; rerender(); };
actions.recvNo = () => { ui.recv = null; rerender(); };
actions.refundAsk = (d) => { ui.refund = { id: d.id, name: d.n, max: Number(d.max) }; ui.recv = null; ui.refundAmount = undefined; ui.refundMode = 'cash'; ui.error = null; rerender(); };
actions.refundNo = () => { ui.refund = null; rerender(); };
actions.refundGo = async () => {
  const r = await api('POST', `${B()}/debtors/${ui.refund.id}/refund`, { mode: ui.refundMode ?? 'cash', amount: ui.refundAmount ?? rupees(ui.refund.max), note: ui.refundNote });
  flash = { kind: 'ok', text: `Refunded. ${ui.refund.name} now ${r.balancePaise < 0 ? 'holds ' + rs(-r.balancePaise) + ' of advance' : 'owes ' + rs(r.balancePaise)}.` }; route();
};
actions.recvGo = async () => {
  const p = { mode: ui.recvMode ?? 'cash', amount: ui.recvAmount ?? '', payAccountId: ui.payAccountId, cardApproval: ui.cardApproval, cardLast4: ui.cardLast4 };
  const r = await api('POST', `${B()}/debtors/${ui.recv.id}/receipts`, { kind: ui.recvKind ?? 'receipt', payments: [p] });
  flash = { kind: 'ok', text: `${ui.recv.name} now owes ${rs(r.balancePaise)}.` }; route();
};

// ---------- shift close

async function shiftScreen() {
  const day = me.business.shiftDay;
  const d = await api('GET', `${B()}/shifts/${day}`);
  ui.s = d.summary; ui.closed = d.closed; ui.counts = {};
  const notes = ['2000', '500', '200', '100', '50', '20', '10'];
  rerender = () => {
    const s = ui.s;
    const counted = notes.reduce((t, n) => t + (Number(ui.counts[n]) || 0) * Number(n) * 100, 0) + (toPaise(ui.loose || '0') ?? 0);
    const float = toPaise(ui.float || '0') ?? 0;
    const expected = float + s.cashInPaise - s.cashOutPaise;
    const diff = counted - expected;
    const modeName = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Posted to rooms', credit: 'On credit', comp: 'Complimentary', advance: 'Advances used' };
    paint(shell('#/shift', html`<div class="settle">
      <section class="panel"><h2>Shift ${s.shiftDay}</h2>
        ${ui.closed ? html`<div class="msg ok">Closed at ${dateTime(ui.closed.closedAt)} · counted ${rs(ui.closed.countedPaise)} · difference ${rs(ui.closed.differencePaise)}</div>` : ''}
        <div class="sums">${s.byMode.map((m) => html`<div><span>${modeName[m.mode]} (${m.n})</span><span>${rs(m.paise)}</span></div>`)}
          ${s.byAccount.map((a) => html`<div><span class="quiet">UPI: ${a.name}</span><span>${rs(a.paise)}</span></div>`)}
          ${s.receipts.map((m) => html`<div><span class="quiet">Received on folios and credit: ${modeName[m.mode]}</span><span>${rs(m.paise)}</span></div>`)}</div>
        <div class="sums">${s.billed.map((b) => html`<div><span>${b.entity}: ${b.first} to ${b.last}${b.voids ? ` (${b.voids} void)` : ''}</span><span>${rs(b.paise)}</span></div>`)}</div>
        <div class="sums">${s.events.map((e) => html`<div><span>${{ void: 'Voids', reprint: 'Reprints', kot_cancel: 'Cancelled KOT lines', discount: 'Discounts', comp: 'Complimentary', limit_warning: 'Limit warnings' }[e.kind]}</span><span>${e.n} · ${rs(e.paise)}</span></div>`)}</div>
        ${s.tabs.length ? html`<div class="sums"><div><strong>Tabs carried to the next shift (not in these totals)</strong></div>${s.tabs.map((t) => html`<div><span>${t.place} · ${t.guest} · since ${t.since}${t.old ? ' · overdue' : ''}</span><span>${rs(t.paise)}</span></div>`)}</div>` : ''}
        ${s.drawerOuts.length ? html`<div class="sums"><div><strong>Paid out of the drawer</strong></div>${s.drawerOuts.map((o) => html`<div><span>${o.kind === 'refund' ? 'Advance refunded' : 'Paid out'}${o.mode === 'upi' ? ' (UPI)' : ''}${o.note && o.note !== 'Advance refunded' ? ' · ' + o.note : ''} · ${o.byName ?? ''}</span><span>${rs(-o.amountPaise)}</span></div>`)}</div>` : ''}
        ${ui.closed ? '' : html`<form class="grid2" style="align-items:end"><label class="f">Cash paid out (₹)<input class="in" inputmode="decimal" data-model="outAmount" value="${ui.outAmount ?? ''}"></label>
          <label class="f">What for<input class="in" data-model="outNote" value="${ui.outNote ?? ''}" placeholder="e.g. Vegetables"></label>
          <button class="btn" type="submit" data-act="paidOut" data-submit>Record paid out</button></form>`}
        ${s.openOrders.length ? html`<div class="msg bad">Bill these orders or keep them as a tab first: ${s.openOrders.map((o) => o.place).join(', ')}.</div>` : ''}
        ${s.unpaidBills.length ? html`<div class="msg bad">Printed but not paid: ${s.unpaidBills.map((b) => b.bill_no).join(', ')}.</div>` : ''}
      </section>
      ${ui.closed ? '' : html`<form class="panel"><h2>Count the cash drawer</h2>${errorBox()}
        <label class="f">Opening float (₹)<input class="in" inputmode="decimal" data-model="float" data-live value="${ui.float ?? ''}"></label>
        <div class="grid3">${notes.map((n) => html`<label class="f">₹${n} notes<input class="in" inputmode="numeric" data-model="c${n}" data-note="${n}" value="${ui.counts[n] ?? ''}"></label>`)}
          <label class="f">Coins and loose (₹)<input class="in" inputmode="decimal" data-model="loose" data-live value="${ui.loose ?? ''}"></label></div>
        <div class="sums"><div><span>Should be in the drawer</span><span>${rs(expected)}</span></div><div><span>Counted</span><span>${rs(counted)}</span></div>
          <div class="big" style="color:${diff ? 'var(--bad)' : 'var(--accent)'}"><span>${diff === 0 ? 'Agrees' : diff < 0 ? 'Short' : 'Over'}</span><span>${rs(Math.abs(diff))}</span></div></div>
        ${diff ? html`<label class="f">Reason for the difference (required)<input class="in" data-model="reason" value="${ui.reason ?? ''}"></label>` : ''}
        <button class="btn pri" type="submit" data-act="closeShift" data-submit>Close shift</button></form>`}
    </div>`));
  };
  rerender();
}
root.addEventListener('input', (ev) => { const n = ev.target.dataset?.note; if (n) { ui.counts[n] = ev.target.value; refocus(ev.target.dataset.model, () => rerender()); } });
actions.paidOut = async () => {
  await api('POST', B() + '/drawer-outs', { amount: ui.outAmount ?? '', note: ui.outNote ?? '' });
  flash = { kind: 'ok', text: `Paid out ${rs(toPaise(ui.outAmount) ?? 0)} recorded.` }; route();
};
actions.closeShift = async () => {
  const counted = {}; for (const [k, v] of Object.entries(ui.counts)) counted[k] = Number(v) || 0;
  counted.loose = ui.loose || '0';
  const r = await api('POST', `${B()}/shifts/${ui.s.shiftDay}/close`, { openingFloat: ui.float || '0', counted, reason: ui.reason });
  flash = { kind: r.differencePaise ? 'warn' : 'ok', text: `Shift closed. ${r.message}` }; route();
};

// ---------- reports (Owner and manager)

async function reportsScreen(tab = 'sales', range = '') {
  const [qf, qt] = range.split('_');
  const isD = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
  const from = isD(qf) ? qf : me.business.shiftDay;
  const to = isD(qt) ? qt : from;
  ui.from = from; ui.to = to;
  const modeName = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Posted to rooms', credit: 'On credit', comp: 'Complimentary', advance: 'Advances used' };
  const head = html`<div class="row" style="justify-content:space-between;margin-bottom:16px"><div class="chips">
      ${[['sales', 'Sales'], ['owed', 'Who owes']].map(([k, t]) => html`<a class="chip" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit" href="#/reports/${k}/${from}_${to}" aria-pressed="${tab === k}">${t}</a>`)}</div>
    ${tab === 'sales' ? html`<form class="row"><label class="f">From<input class="in" type="date" data-model="from" value="${from}"></label><label class="f">To<input class="in" type="date" data-model="to" value="${to}"></label>
      <div class="f">&nbsp;<button class="btn" type="submit" data-act="repGo" data-submit>Show</button></div></form>` : ''}</div>`;
  if (tab === 'owed') {
    const { accounts } = await api('GET', `${B()}/reports/debtors`);
    ui.statement = null;
    rerender = () => paint(shell('#/reports', html`${head}<section class="panel"><h2>Who owes what</h2>
      <p class="quiet small">Rooms in house and credit accounts. A negative amount is an advance held. Ages count from the bills still unpaid.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Account</th><th class="num">Owes</th><th class="num">0–30 days</th><th class="num">31–60</th><th class="num">61–90</th><th class="num">Over 90</th><th class="num">Limit</th><th></th></tr></thead><tbody>
        ${accounts.map((a) => html`<tr><td>${a.name}<div class="small quiet">${a.kind === 'room' ? 'Room folio' : 'Credit account'}${a.phone ? ' · ' + a.phone : ''}</div></td>
          <td class="num"><strong>${rs(a.balancePaise)}</strong></td><td class="num">${a.d0_30 ? rs(a.d0_30) : ''}</td><td class="num">${a.d31_60 ? rs(a.d31_60) : ''}</td>
          <td class="num">${a.d61_90 ? rs(a.d61_90) : ''}</td><td class="num">${a.d90 ? rs(a.d90) : ''}</td><td class="num">${a.creditLimitPaise ? rs(a.creditLimitPaise) : ''}</td>
          <td><button class="btn" type="button" data-act="statement" data-id="${a.id}">Statement</button></td></tr>`)}
        <tr><td><strong>Total</strong></td><td class="num"><strong>${rs(accounts.reduce((t, a) => t + a.balancePaise, 0))}</strong></td><td colspan="6"></td></tr></tbody></table></div></section>
      ${ui.statement ? html`<section class="panel" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2>Statement · ${ui.statement.account.name}</h2><button class="btn" type="button" data-act="printStatement">Print</button></div>
        <div class="scroll"><table class="t"><thead><tr><th>When</th><th>What</th><th class="num">Charged</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead><tbody>
          ${(() => { let bal = 0; return ui.statement.entries.map((e) => { bal += e.amountPaise; return html`<tr><td>${dateTime(e.at)}</td>
            <td>${{ charge: 'Bill', receipt: 'Payment', advance: 'Advance paid', advance_used: 'Advance used on bill', refund: 'Advance refunded' }[e.kind]}${e.billNo ? ' ' + e.billNo : ''}${e.mode ? ' · ' + e.mode : ''}</td>
            <td class="num">${e.amountPaise > 0 ? rs(e.amountPaise) : ''}</td><td class="num">${e.amountPaise < 0 ? rs(-e.amountPaise) : ''}</td><td class="num">${rs(bal)}</td></tr>`; }); })()}
        </tbody></table></div></section>` : ''}`));
    rerender();
    return;
  }
  const r = await api('GET', `${B()}/reports/sales?from=${from}&to=${to}`);
  const sum = (k) => r.byEntity.reduce((t, e) => t + e[k], 0);
  rerender = () => paint(shell('#/reports', html`${head}
    <section class="panel"><h2>Sales ${from === to ? from : `${from} to ${to}`}</h2>
      <div class="scroll"><table class="t"><thead><tr><th>Name on bill</th><th>Bills</th><th class="num">Items</th><th class="num">Discount</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Total</th></tr></thead><tbody>
        ${r.byEntity.map((e) => html`<tr><td>${e.name}<div class="small quiet">${e.gstRegistered ? 'GSTIN ' + e.gstin : 'Not registered for GST'}</div></td><td>${e.bills}<div class="small quiet">${e.firstBill} to ${e.lastBill}</div></td>
          <td class="num">${rs(e.grossPaise)}</td><td class="num">${rs(e.discountPaise)}</td><td class="num">${rs(e.taxablePaise)}</td><td class="num">${rs(e.cgstPaise)}</td><td class="num">${rs(e.sgstPaise)}</td><td class="num"><strong>${rs(e.totalPaise)}</strong></td></tr>`)}
        <tr><td><strong>Total</strong></td><td>${sum('bills')}</td><td class="num">${rs(sum('grossPaise'))}</td><td class="num">${rs(sum('discountPaise'))}</td><td class="num">${rs(sum('taxablePaise'))}</td>
          <td class="num">${rs(sum('cgstPaise'))}</td><td class="num">${rs(sum('sgstPaise'))}</td><td class="num"><strong>${rs(sum('totalPaise'))}</strong></td></tr></tbody></table></div></section>
    <div class="grid2" style="margin-top:16px;align-items:start">
      <section class="panel"><h2>By payment</h2><div class="sums">${r.byMode.map((m) => html`<div><span>${modeName[m.mode]} (${m.n})</span><span>${rs(m.paise)}</span></div>`)}</div>
        ${r.discounts.length ? html`<h2>Discounts</h2><div class="sums">${r.discounts.map((d) => html`<div><span>${d.reason} (${d.n})</span><span>${rs(d.paise)}</span></div>`)}</div>` : ''}
        ${r.comps.length ? html`<h2>Complimentary</h2><div class="sums">${r.comps.map((c) => html`<div><span>${c.day} · ${c.guest} · ${c.reason} · by ${c.byName ?? ''}</span><span>${rs(c.paise)}</span></div>`)}</div>` : ''}
        ${r.voids.length ? html`<h2>Void bills</h2><div class="sums">${r.voids.map((v) => html`<div><span>${v.billNo} · ${v.reason}</span><span>${rs(v.totalPaise)}</span></div>`)}</div>` : ''}
        ${r.days.length > 1 ? html`<h2>By shift</h2><div class="sums">${r.days.map((d) => html`<div><span>${d.day} (${d.bills} bills)</span><span>${rs(d.totalPaise)}</span></div>`)}</div>` : ''}</section>
      <section class="panel"><h2>Items sold</h2><div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
        ${r.items.map((i) => html`<tr><td>${i.name}</td><td class="num">${i.qty}</td><td class="num">${rs(i.amountPaise)}</td></tr>`)}</tbody></table></div></section>
    </div>`));
  rerender();
}
actions.repGo = () => go(`#/reports/sales/${ui.from}_${ui.to}`);
actions.statement = async (d) => { ui.statement = await api('GET', `${B()}/debtors/${d.id}`); rerender(); };
actions.printStatement = () => {
  const st = ui.statement; let bal = 0;
  printArea.innerHTML = asHtml(html`<div class="receipt"><div class="hd">${me.business.name}</div><div class="c">STATEMENT</div><div>${st.account.name}</div><hr>
    ${st.entries.map((e) => { bal += e.amountPaise; return html`<div class="rl"><span>${dateTime(e.at)} ${e.billNo ?? e.kind}</span><span>${rs(e.amountPaise)}</span></div>`; })}
    <hr><div class="rl" style="font-weight:700"><span>Balance</span><span>${rs(bal)}</span></div></div>`);
  window.print();
};

// ---------- exceptions

async function exceptionsScreen(day = me.business.shiftDay) {
  const { events } = await api('GET', `${B()}/events?day=${encodeURIComponent(day)}`);
  const kind = { void: 'Void', reprint: 'Reprint', kot_cancel: 'KOT line cancelled', discount: 'Discount', comp: 'Complimentary', limit_warning: 'Limit warning' };
  rerender = () => paint(shell('#/exceptions', html`<section class="panel"><div class="row" style="justify-content:space-between"><h1>Exceptions · shift ${day}</h1>
      <form class="row"><input class="in" type="date" data-model="day" value="${ui.day ?? day}" style="width:auto"><button class="btn" type="submit" data-act="exDay" data-submit>Show</button></form></div>
    <p class="quiet small">Every void, reprint, cancelled KOT line, discount and complimentary bill, with who and why. Nothing here can be changed.</p>
    <div class="scroll"><table class="t"><thead><tr><th>Time</th><th>What</th><th>Bill or item</th><th class="num">Amount</th><th>By</th><th>Reason</th></tr></thead><tbody>
      ${events.length ? events.map((e) => html`<tr><td>${time(e.at)}</td><td>${kind[e.kind]}</td><td>${e.ref}</td><td class="num">${e.amountPaise === null ? '' : rs(e.amountPaise)}</td><td>${e.byName ?? ''}</td><td>${e.reason ?? ''}${e.detail ? html`<div class="small quiet">${e.detail}</div>` : ''}</td></tr>`)
        : html`<tr><td colspan="6" class="quiet">Nothing in this shift.</td></tr>`}</tbody></table></div></section>`));
  rerender();
}
actions.exDay = () => go(`#/exceptions/${ui.day}`);

// ---------- settings (Owner and manager)

async function settingsScreen(tab = 'menu') {
  const tabs = [['menu', 'Menu', 'menu.edit'], ['reasons', 'Reasons', 'menu.edit'], ['entities', 'Billing names', 'entities.edit'], ['accounts', 'UPI accounts', 'entities.edit'],
    ['staff', 'Staff and PINs', 'staff.manage'], ['device', 'This device', 'staff.manage']].filter((t) => can(t[2]));
  if (!tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
  await load('menu', 'reasons', 'entities', 'payAccounts');
  if (tab === 'staff') ui.staff = (await api('GET', B() + '/staff')).staff;
  if (tab === 'device') ui.devices = (await api('GET', B() + '/devices')).devices;
  const head = html`<div class="chips" style="margin-bottom:16px">${tabs.map(([k, t]) => html`<a class="chip" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit" href="#/settings/${k}" aria-pressed="${k === tab}">${t}</a>`)}</div>`;
  const kinds = { discount: 'Discount', comp: 'Complimentary', void: 'Void', kot_cancel: 'Cancelled KOT line' };
  rerender = () => {
    let body = '';
    if (tab === 'menu') body = html`<section class="panel"><h2>Menu</h2>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Item</th><th>Category</th><th>Station</th><th class="num">Price (before GST)</th><th></th></tr></thead><tbody>
        ${cache.menu.map((m) => html`<tr><td>${m.name}</td><td>${m.category}</td><td>${m.station}</td><td class="num">${rs(m.pricePaise)}</td>
          <td><div class="row"><button class="btn" type="button" data-act="itemEdit" data-id="${m.id}">Edit</button><button class="btn" type="button" data-act="itemToggle" data-id="${m.id}">${m.active ? 'Take off menu' : 'Put back'}</button></div></td></tr>`)}</tbody></table></div>
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editItem ? 'Edit item' : 'Add item'}</h2><label class="f">Name<input class="in" data-model="iName" value="${ui.iName ?? ''}"></label><label class="f">Category<input class="in" data-model="iCat" value="${ui.iCat ?? ''}"></label>
        <label class="f">Price (₹, before GST)<input class="in" inputmode="decimal" data-model="iPrice" value="${ui.iPrice ?? ''}"></label>
        <label class="f">Station<select class="in" data-model="iStation"><option value="kitchen">Kitchen</option><option value="bar" ${ui.iStation === 'bar' ? 'selected' : ''}>Bar</option></select></label>
        <div class="f">&nbsp;<div class="row"><button class="btn pri" type="submit" data-act="addItem" data-submit>${ui.editItem ? 'Save item' : 'Add item'}</button>${ui.editItem ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></div></form></section>`;
    if (tab === 'reasons') body = html`<section class="panel"><h2>Reasons</h2>${errorBox()}
      ${Object.entries(kinds).map(([k, t]) => html`<div><p class="small quiet" style="font-weight:600;margin-bottom:6px">${t}</p><div class="chips">${reasonsOf(k).map((r) => html`<span class="chip" style="display:inline-flex;align-items:center;gap:8px">${r.label}<button class="btn" style="min-height:32px;padding:0 8px" type="button" data-act="retire" data-id="${r.id}" aria-label="Remove ${r.label}">×</button></span>`)}</div></div>`)}
      <form class="grid3"><label class="f">For<select class="in" data-model="rKind">${Object.entries(kinds).map(([k, t]) => html`<option value="${k}" ${ui.rKind === k ? 'selected' : ''}>${t}</option>`)}</select></label>
        <label class="f">Reason<input class="in" data-model="rLabel"></label><div class="f">&nbsp;<button class="btn pri" type="submit" data-act="addReason" data-submit>Add reason</button></div></form></section>`;
    if (tab === 'entities') body = html`<section class="panel"><h2>Billing names</h2><p class="quiet small">With one name, the counter never asks. With more, the cashier picks one on each bill; the default is preselected.</p>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Name on bill</th><th>GST</th><th>Series</th><th class="num">Billed this year</th><th>Limit</th><th></th></tr></thead><tbody>
        ${cache.entities.map((e) => html`<tr><td>${e.name}<div class="small quiet">${e.kind}${e.is_default ? ' · default' : ''}${e.active ? '' : ' · inactive'}</div></td>
          <td>${e.gst_registered ? `${e.gst_rate_bp / 100}% · ${e.gstin}` : 'Not registered'}</td><td>${e.series_prefix}</td><td class="num">${rs(e.year_paise)}</td>
          <td>${e.yearly_limit_paise ? `${rs(e.yearly_limit_paise)} · stops at ${rs(e.stop_paise)}` : '—'}</td>
          <td><div class="row"><button class="btn" type="button" data-act="entFlag" data-id="${e.id}" data-f="offered">${e.offered ? 'Offered' : 'Not offered'}</button>
            ${e.is_default ? '' : html`<button class="btn" type="button" data-act="entFlag" data-id="${e.id}" data-f="is_default">Make default</button>`}
            <button class="btn" type="button" data-act="entEdit" data-id="${e.id}">Edit</button></div></td></tr>`)}</tbody></table></div>
      <form class="panel" style="padding:0;border:0"><h2>${ui.editEntity ? 'Edit billing name' : 'Add a billing name'}</h2>
        <div class="grid3"><label class="f">Name as printed<input class="in" data-model="eName" value="${ui.eName ?? ''}"></label>
          <label class="f">Kind<select class="in" data-model="eKind">${['company', 'llp', 'partnership', 'proprietor', 'huf', 'other'].map((k) => html`<option value="${k}" ${ui.eKind === k ? 'selected' : ''}>${k.toUpperCase() === 'HUF' || k === 'llp' ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)}</option>`)}</select></label>
          <label class="f">Bill series prefix<input class="in" data-model="ePrefix" maxlength="4" value="${ui.ePrefix ?? ''}"></label>
          <label class="f">Registered under GST?<select class="in" data-model="eGst"><option value="no">No</option><option value="yes" ${ui.eGst === 'yes' ? 'selected' : ''}>Yes</option></select></label>
          ${ui.eGst === 'yes' ? html`<label class="f">GSTIN<input class="in" data-model="eGstin" maxlength="15" value="${ui.eGstin ?? ''}"></label><label class="f">Food GST rate (%)<input class="in" inputmode="decimal" data-model="eRate" value="${ui.eRate ?? '5'}"></label>` : ''}
          <label class="f">Yearly limit (₹, optional)<input class="in" inputmode="decimal" data-model="eLimit" value="${ui.eLimit ?? ''}"></label>
          <label class="f">Warn at (₹)<input class="in" inputmode="decimal" data-model="eWarn1" value="${ui.eWarn1 ?? ''}"></label><label class="f">Warn again at (₹)<input class="in" inputmode="decimal" data-model="eWarn2" value="${ui.eWarn2 ?? ''}"></label>
          <label class="f">Stop offering at (₹)<input class="in" inputmode="decimal" data-model="eStop" value="${ui.eStop ?? ''}"></label></div>
        <div class="row"><button class="btn pri" type="submit" data-act="addEntity" data-submit>Save billing name</button>${ui.editEntity ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>`;
    if (tab === 'accounts') body = html`<section class="panel"><h2>UPI accounts</h2><p class="quiet small">Each QR's bank account belongs to one billing name. A bill paid into another name's account is asked about at the counter.</p>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Account</th><th>Belongs to</th><th>Bookr account id</th></tr></thead><tbody>
        ${cache.payAccounts.map((a) => html`<tr><td>${a.name}${a.active ? '' : ' (not used)'}</td><td>${a.entityName}</td><td class="small">${a.bookrAccountId ?? ''}</td>
          <td><button class="btn" type="button" data-act="acctEdit" data-id="${a.id}">Edit</button></td></tr>`)}</tbody></table></div>
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editAcct ? 'Edit account' : 'Add account'}</h2><label class="f">Account name<input class="in" data-model="aName" value="${ui.aName ?? ''}"></label>
        <label class="f">Belongs to<select class="in" data-model="aEntity"><option value="">Choose</option>${cache.entities.map((e) => html`<option value="${e.id}" ${ui.aEntity === e.id ? 'selected' : ''}>${e.name}</option>`)}</select></label>
        <label class="f">Bookr account id (optional)<input class="in" data-model="aBookr" value="${ui.aBookr ?? ''}"></label>
        ${ui.editAcct ? html`<label class="f">Status<select class="in" data-model="aActive"><option value="yes">In use</option><option value="no" ${ui.aActive === 'no' ? 'selected' : ''}>Not used</option></select></label>` : ''}
        <div class="row"><button class="btn pri" type="submit" data-act="addAccount" data-submit>${ui.editAcct ? 'Save account' : 'Add account'}</button>${ui.editAcct ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>`;
    if (tab === 'staff') body = html`<section class="panel"><h2>Staff and PINs</h2>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Name</th><th>Role</th><th>Sign-in</th></tr></thead><tbody>
        ${ui.staff.map((s) => html`<tr><td>${s.name}${s.active ? '' : ' (inactive)'}</td><td>${s.role}</td><td>${s.email ?? ''}${s.hasPin ? ' · PIN set' : ''}</td>
          <td><button class="btn" type="button" data-act="staffEdit" data-id="${s.id}">Edit</button></td></tr>`)}</tbody></table></div>
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editStaff ? 'Edit person (leave PIN and password empty to keep them)' : 'Add person'}</h2><label class="f">Name<input class="in" data-model="sName" value="${ui.sName ?? ''}"></label>
        <label class="f">Role<select class="in" data-model="sRole">${['cashier', 'captain', 'manager', 'owner'].map((r) => html`<option value="${r}" ${ui.sRole === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`)}</select></label>
        <label class="f">PIN (4–6 digits)<input class="in" inputmode="numeric" data-model="sPin" maxlength="6" autocomplete="off"></label>
        ${['manager', 'owner'].includes(ui.sRole) ? html`<label class="f">Email<input class="in" type="email" data-model="sEmail" value="${ui.sEmail ?? ''}"></label><label class="f">Password (12+ characters)<input class="in" type="password" data-model="sPassword" autocomplete="new-password"></label>` : ''}
        ${ui.editStaff ? html`<label class="f">Status<select class="in" data-model="sActive"><option value="yes">Active</option><option value="no" ${ui.sActive === 'no' ? 'selected' : ''}>Inactive (cannot sign in)</option></select></label>` : ''}
        <div class="row"><button class="btn pri" type="submit" data-act="addStaff" data-submit>${ui.editStaff ? 'Save person' : 'Add person'}</button>${ui.editStaff ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>`;
    if (tab === 'device') body = html`<section class="panel"><h2>Counter devices</h2><p class="quiet small">Counter staff sign in with a PIN only on a device set up here. Set up the billing PC or tablet by signing in on it as the Owner and pressing the button below.</p>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Device</th><th>Added</th><th></th></tr></thead><tbody>
        ${ui.devices.map((d) => html`<tr><td>${d.name}</td><td>${dateTime(d.createdAt)}</td><td>${d.revokedAt ? 'Removed' : html`<button class="btn danger" type="button" data-act="revoke" data-id="${d.id}">Remove</button>`}</td></tr>`)}</tbody></table></div>
      <form class="row"><label class="f grow">Name for this device<input class="in" data-model="dName" placeholder="Billing counter"></label><button class="btn pri" type="submit" data-act="addDevice" data-submit>Make this a counter device</button></form></section>`;
    paint(shell('#/settings', html`${head}${body}`));
  };
  rerender();
}
const entityBody = (e, change) => ({
  name: e.name, kind: e.kind, gstRegistered: !!e.gst_registered, gstin: e.gstin, gstRateBp: e.gst_rate_bp, seriesPrefix: e.series_prefix,
  yearlyLimit: e.yearly_limit_paise ? rupees(e.yearly_limit_paise) : '', warn1: e.warn1_paise ? rupees(e.warn1_paise) : '', warn2: e.warn2_paise ? rupees(e.warn2_paise) : '',
  stopAt: e.stop_paise ? rupees(e.stop_paise) : '', isDefault: !!e.is_default, offered: !!e.offered, active: !!e.active, ...change,
});
actions.itemToggle = async (d) => { const m = cache.menu.find((x) => x.id === d.id); await api('PUT', `${B()}/menu/${m.id}`, { name: m.name, category: m.category, price: rupees(m.pricePaise), sac: m.sac, station: m.station, active: !m.active }); route(); };
actions.addItem = async () => {
  const body = { name: ui.iName, category: ui.iCat, price: ui.iPrice ?? '', station: ui.iStation ?? 'kitchen' };
  if (ui.editItem) { const m = cache.menu.find((x) => x.id === ui.editItem); await api('PUT', `${B()}/menu/${m.id}`, { ...body, sac: m.sac, active: !!m.active }); }
  else await api('POST', B() + '/menu', body);
  flash = { kind: 'ok', text: `${ui.iName} ${ui.editItem ? 'saved' : 'added'}.` }; route();
};
actions.itemEdit = (d) => { const m = cache.menu.find((x) => x.id === d.id); Object.assign(ui, { editItem: m.id, iName: m.name, iCat: m.category, iPrice: rupees(m.pricePaise), iStation: m.station }); rerender(); };
actions.editCancel = () => route();
actions.retire = async (d) => { await api('POST', `${B()}/reasons/${d.id}/retire`); route(); };
actions.addReason = async () => { await api('POST', B() + '/reasons', { kind: ui.rKind ?? 'discount', label: ui.rLabel }); route(); };
actions.entFlag = async (d) => {
  const e = cache.entities.find((x) => x.id === d.id);
  await api('PUT', `${B()}/entities/${e.id}`, entityBody(e, d.f === 'offered' ? { offered: !e.offered } : { isDefault: true, offered: true }));
  route();
};
actions.addEntity = async () => {
  const rate = ui.eGst === 'yes' ? Math.round(Number(ui.eRate ?? '5') * 100) : 0;
  const body = { name: ui.eName, kind: ui.eKind ?? 'company', seriesPrefix: ui.ePrefix, gstRegistered: ui.eGst === 'yes', gstin: ui.eGstin, gstRateBp: rate,
    yearlyLimit: ui.eLimit, warn1: ui.eWarn1, warn2: ui.eWarn2, stopAt: ui.eStop };
  if (ui.editEntity) { const e = cache.entities.find((x) => x.id === ui.editEntity); await api('PUT', `${B()}/entities/${e.id}`, { ...body, isDefault: !!e.is_default, offered: !!e.offered, active: !!e.active }); }
  else await api('POST', B() + '/entities', body);
  flash = { kind: 'ok', text: `${ui.eName} added.` }; route();
};
actions.entEdit = (d) => {
  const e = cache.entities.find((x) => x.id === d.id);
  const r = (p) => (p ? rupees(p) : '');
  Object.assign(ui, { editEntity: e.id, eName: e.name, eKind: e.kind, ePrefix: e.series_prefix, eGst: e.gst_registered ? 'yes' : 'no', eGstin: e.gstin ?? '', eRate: String(e.gst_rate_bp / 100),
    eLimit: r(e.yearly_limit_paise), eWarn1: r(e.warn1_paise), eWarn2: r(e.warn2_paise), eStop: r(e.stop_paise) });
  rerender();
};
actions.addAccount = async () => {
  const body = { name: ui.aName, entityId: ui.aEntity, bookrAccountId: ui.aBookr };
  if (ui.editAcct) await api('PUT', `${B()}/pay-accounts/${ui.editAcct}`, { ...body, active: ui.aActive !== 'no' });
  else await api('POST', B() + '/pay-accounts', body);
  route();
};
actions.acctEdit = (d) => { const a = cache.payAccounts.find((x) => x.id === d.id); Object.assign(ui, { editAcct: a.id, aName: a.name, aEntity: a.entityId, aBookr: a.bookrAccountId ?? '', aActive: a.active ? 'yes' : 'no' }); rerender(); };
actions.addStaff = async () => {
  const body = { name: ui.sName, role: ui.sRole ?? 'cashier', pin: ui.sPin, email: ui.sEmail, password: ui.sPassword };
  if (ui.editStaff) await api('PUT', `${B()}/staff/${ui.editStaff}`, { ...body, active: ui.sActive !== 'no' });
  else await api('POST', B() + '/staff', body);
  flash = { kind: 'ok', text: `${ui.sName} ${ui.editStaff ? 'saved' : 'added'}.` }; route();
};
actions.staffEdit = (d) => { const p = ui.staff.find((x) => x.id === d.id); Object.assign(ui, { editStaff: p.id, sName: p.name, sRole: p.role, sEmail: p.email ?? '', sActive: p.active ? 'yes' : 'no', sPin: '', sPassword: '' }); rerender(); };
actions.addDevice = async () => { await api('POST', B() + '/devices', { name: ui.dName || 'Billing counter' }); flash = { kind: 'ok', text: 'This browser is now a counter device. Staff can sign in here with their PIN.' }; route(); };
actions.revoke = async (d) => { await api('POST', `${B()}/devices/${d.id}/revoke`); route(); };

route();
