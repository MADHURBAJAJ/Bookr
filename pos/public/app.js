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
/** '2026-11-17' → '17 Nov'. */
const dayName = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : d ?? '');
/** '2026-11-17' plus n days, as 'YYYY-MM-DD'. */
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** How long ago, short: '12 min', '2 h 5 min', '3 d'. */
function since(ms) {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(m / 1440)} d`;
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
async function api(method, path, body, extraHeaders = {}) {
  if (body === undefined && method !== 'GET') body = {};
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !['/me', '/auth/login', '/auth/pin'].includes(path) && !path.startsWith('/admin')) { me = null; go('#/signin'); throw new ApiError('Please sign in.', 401, 'signin'); }
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong.', res.status, data?.code);
  return data;
}

// ---------- state

let me = null;          // { staff, business, actions }
let cache = {};         // menu, reasons, entities, payAccounts, stays, credit (loaded per screen)
let ui = {};            // the current screen's own state; reset on every route change
let flash = null;       // { kind, text, link?: [href, text] } shown once at the top
const can = (a) => !!me?.actions.includes(a);
const B = () => `/businesses/${me.business.id}`;

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
window.addEventListener('hashchange', route);

// Menu, reasons and UPI accounts change only in Settings, so they are fetched once per sign-in (Settings fetches afresh).
// Stays, credit accounts and billing names carry balances and year totals, so they are fetched every time.
const KEEP = ['menu', 'reasons', 'payAccounts'];
async function load(...keys) {
  const paths = { menu: '/menu', reasons: '/reasons', entities: '/entities', payAccounts: '/pay-accounts', stays: '/stays', credit: '/credit-accounts' };
  await Promise.all(keys.filter((k) => !(KEEP.includes(k) && cache[k])).map(async (k) => {
    const d = await api('GET', B() + paths[k]);
    cache[k] = k === 'menu' ? d.items : k === 'entities' ? d.entities : k === 'payAccounts' ? d.accounts : k === 'credit' ? d.accounts : d[k];
    if (k === 'menu') { cache.menuCats = d.categories ?? []; cache.addonGroups = d.addonGroups ?? []; cache.stations = d.stations ?? []; }
  }));
}
const reasonsOf = (kind) => (cache.reasons ?? []).filter((r) => r.kind === kind);
const counterEntities = () => (cache.entities ?? []).filter((e) => e.active && e.offered);

// ---------- rendering

// ---------- day and night colours (Warm teal / Teal night), chosen per device: Auto switches at 7 pm and 7 am
const THEME_KEY = 'pos-theme';
const THEME_NAMES = { auto: 'Auto', day: 'Day', night: 'Night' };
function themeMode() { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } }
function applyTheme() {
  const m = themeMode();
  const h = new Date().getHours();
  document.documentElement.dataset.theme = m === 'night' || (m === 'auto' && (h >= 19 || h < 7)) ? 'night' : 'day';
}
applyTheme();
setInterval(applyTheme, 60_000);
const THEME_ICON = {
  day: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  night: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
  auto: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>`,
};
const themeButton = () => html`<button type="button" class="themebtn" data-act="theme" title="Colours: Auto switches to night at 7 pm and back at 7 am" aria-label="Colours: ${THEME_NAMES[themeMode()]}. Change">${THEME_ICON[themeMode()]}<span>${THEME_NAMES[themeMode()]}</span></button>`;

// Row actions as icons: the label is the tooltip and what a screen reader says.
const ICON = {
  edit: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  off: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10 10 0 0 1 12 20C5 20 1 12 1 12a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>`,
  on: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
};
const iconBtn = (act, id, icon, label, cls = '') => html`<button class="ibtn ${cls}" type="button" data-act="${act}" data-id="${id}" title="${label}" aria-label="${label}">${ICON[icon]}</button>`;

function shell(active, body) {
  const links = [['#/', 'Tables', 'pos.view'], ['#/rooms', 'Rooms and credit', 'pos.view'], ['#/shift', 'Shift close', 'shift.close'],
    ['#/stock', 'Stock', 'stock.edit'], ['#/reports', 'Reports', 'reports.view'], ['#/exceptions', 'Daily check', 'reports.view'], ['#/settings', 'Settings', 'menu.edit']].filter((l) => can(l[2]));
  const navLinks = links.map(([h, t]) => html`<a href="${h}" ${active === h ? html`aria-current="page"` : ''}>${t}</a>`);
  const current = links.find(([h]) => h === active)?.[1] ?? 'Menu';
  return html`<header class="top"><div class="top-in">
    <div class="brandbox"><span class="product">Bookr POS</span>${(me.restaurants ?? []).length > 1
      ? html`<select class="switcher" data-act-change="switchRestaurant" aria-label="Restaurant">${me.restaurants.map((r) => html`<option value="${r.id}" ${r.id === me.business.id ? 'selected' : ''}>${r.name}</option>`)}</select>`
      : html`<a class="brand" href="#/" title="${me.business.name}">${me.business.name}</a>`}</div>
    <nav class="mainnav" aria-label="Main">${navLinks}</nav>
    ${links.length > 1 ? html`<details class="navmenu"><summary aria-label="Go to: ${current}">${current} <span aria-hidden="true">▾</span></summary><nav aria-label="Main">${navLinks}</nav></details>` : ''}
    <div class="who">${themeButton()}<span class="shiftchip" title="Shift of ${dayName(me.business.shiftDay)}: a shift runs 8 am to 8 am" aria-label="Shift ${dayName(me.business.shiftDay)}">${dayName(me.business.shiftDay)}</span>
      <span class="person">${me.staff.name}</span><button type="button" data-act="logout">Sign out</button></div>
  </div></header>
  ${me.support ? html`<div class="supportbar" role="status">You are in ${me.business.name} as Bookr POS support. The owner can see this visit.</div>` : ''}
  <main>${flash ? html`<div class="msg ${flash.kind} flash" role="status"><span>${flash.text}</span>${flash.link ? html`<a href="${flash.link[0]}">${flash.link[1]}</a>` : ''}</div>` : ''}${body}</main>`;
}
/** A page title with an optional line under it and controls on the right. */
const pageHead = (title, sub, right) => html`<div class="phead"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>${right ?? ''}</div>`;
/** Tabs that are links (each tab has its own address). */
const tabsNav = (label, items, current) => html`<nav class="tabs" aria-label="${label}">${items.map(([href, text, key]) => html`<a href="${href}" ${key === current ? html`aria-current="page"` : ''}>${text}</a>`)}</nav>`;
/** A headline number. tone: '', 'good', 'warn' or 'bad'. */
const kpi = (k, v, n, tone = '') => html`<div class="kpi ${tone}"><span class="k">${k}</span><span class="v">${v}</span>${n ? html`<span class="n">${n}</span>` : ''}</div>`;

function paint(view) { root.innerHTML = asHtml(view); flash = null; const f = root.querySelector('[autofocus]'); if (f) f.focus(); }
const errorBox = () => (ui.error ? html`<div class="msg bad" role="alert">${ui.error}</div>` : '');

async function route() {
  ui = {};
  document.title = 'Bookr POS';
  stopStation();
  try {
    // A station's own device shows its KOTs; nobody signs in on it.
    if (location.hash.startsWith('#/station')) return await stationScreen();
    // Bookr POS admin: its own sign-in, separate from every restaurant's.
    if (location.hash.startsWith('#/admin')) return await adminScreen();
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
    if (path === 'stock') return await stockScreen(a);
    if (path === 'settings') return await settingsScreen(a);
    return await tablesScreen();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'signin') return; // already sent to the sign-in screen
    root.innerHTML = asHtml(html`<main><div class="msg bad" role="alert">${e.message}</div><p style="margin-top:12px"><a href="#/">Back to tables</a></p></main>`);
  }
}

// ---------- events: buttons carry data-act; inputs carry data-model (a key in ui)

const actions = {};
actions.theme = () => {
  const next = { auto: 'day', day: 'night', night: 'auto' }[themeMode()];
  try { localStorage.setItem(THEME_KEY, next); } catch { /* a private window: this visit only */ }
  applyTheme(); rerender();
};
root.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  ev.preventDefault();
  const fn = actions[el.dataset.act];
  if (!fn || el.classList.contains('busy')) return;
  // Taps that only change the screen finish at once; one that waits on the server shows it is working, and a second tap is ignored.
  el.classList.add('busy');
  const wait = setTimeout(() => el.setAttribute('aria-busy', 'true'), 150);
  try { await fn(el.dataset, el); } catch (e) {
    if (e instanceof ApiError && e.code === 'signin') return; // already sent to the sign-in screen
    ui.error = e.message; rerender();
  } finally { clearTimeout(wait); el.classList.remove('busy'); el.removeAttribute('aria-busy'); }
});
root.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.model) {
    ui[el.dataset.model] = el.type === 'checkbox' ? el.checked : el.value;
    // data-live="name" redraws only when that check's answer changes; a bare data-live redraws on every key.
    const check = LIVE_CHECKS[el.dataset.live];
    if (check) { const v = check(); if ((ui.liveSeen?.[el.dataset.model] ?? false) === v) return; ui.liveSeen = { ...ui.liveSeen, [el.dataset.model]: v }; }
    if (el.dataset.live !== undefined) refocus(el.dataset.model, () => rerender());
  }
});
root.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.model && el.tagName === 'SELECT') { ui[el.dataset.model] = el.value; rerender(); }
  if (el.dataset.actChange) Promise.resolve(actions[el.dataset.actChange](el.dataset, el)).catch((e) => { ui.error = e.message; rerender(); });
});
root.addEventListener('submit', (ev) => { ev.preventDefault(); const b = ev.target.querySelector('[data-submit]'); if (b) b.click(); });
let rerender = () => {};
const LIVE_CHECKS = {
  // Admin, Add a restaurant: the form changes only when the email does or stops belonging to an owner already here.
  knownOwner: () => { const e = (ui.rOwnerEmail ?? '').trim().toLowerCase(); return !!e && (ui.rests ?? []).some((r) => r.owners.some((o) => o.email.toLowerCase() === e)); },
};
/** Repaints while typing without losing the field being typed in. */
function refocus(model, paintNow) {
  const was = root.querySelector(`[data-model="${model}"]`);
  let at = null;
  try { at = was ? [was.selectionStart, was.selectionEnd] : null; } catch { /* boxes without a cursor position */ }
  paintNow();
  const el = root.querySelector(`[data-model="${model}"]`);
  if (!el) return;
  el.focus();
  const n = el.value.length;
  try { el.setSelectionRange(at?.[0] ?? n, at?.[1] ?? n); } catch { /* email and number boxes */ }
}

// ---------- sign-in

async function signIn() {
  const d = await api('GET', '/device');
  if (d.device?.station) { go('#/station'); return; }
  ui.device = d.device; ui.people = d.people ?? []; ui.pin = ''; ui.who = null;
  rerender = () => {
    const initials = (n) => String(n).replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
    if (ui.device && !ui.passwordMode) {
      const person = ui.people.find((p) => p.id === ui.who);
      ui.pinPad = !!person;
      paint(html`<div class="signwrap"><main class="signin panel" style="padding:24px">
        <div><p class="brandline">${ui.device.businessName} · Bookr POS</p><h1>${person ? `PIN for ${person.name}` : 'Who is signing in?'}</h1>
          <p class="quiet small">${ui.device.name}${ui.device.locked ? ' · PIN sign-in is locked for a few minutes' : ''}</p></div>
        ${errorBox()}
        ${person ? html`
          <div class="dots" role="img" aria-label="${plural(ui.pin.length, 'digit')} typed">${[...Array(Math.max(4, ui.pin.length))].map((_, i) => html`<span class="${i < ui.pin.length ? 'on' : ''}"></span>`)}</div>
          <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => html`<button type="button" data-act="pinKey" data-k="${k}">${k}</button>`)}
            <button type="button" data-act="pinBack" aria-label="Delete last digit">⌫</button><button type="button" data-act="pinKey" data-k="0">0</button>
            <button type="button" data-act="pinGo" class="ok">Sign in</button></div>
          <p class="quiet tiny" style="text-align:center">On a keyboard, type the PIN and press Enter.</p>
          <button class="btn" type="button" data-act="pinWho" data-id="">Not ${person.name}? Choose someone else</button>`
        : html`<div class="people">${ui.people.map((p) => html`<button type="button" class="person-btn" data-act="pinWho" data-id="${p.id}"><span class="avatar" aria-hidden="true">${initials(p.name)}</span><span>${p.name}</span></button>`)}</div>
          <button class="btn ghost" type="button" data-act="pwMode">Owner or manager: sign in with email</button>`}
      </main></div>`);
    } else {
      ui.pinPad = false;
      paint(html`<div class="signwrap"><main class="signin"><form class="panel" style="padding:24px">
        <div>${ui.device ? html`<p class="brandline">${ui.device.businessName}</p>` : ''}<p class="brandline">Bookr POS</p><h1>Sign in</h1><p class="quiet small">Owner and manager sign in with email.</p></div>${errorBox()}
        <label class="f">Email<input class="in" type="email" autocomplete="username" data-model="email" value="${ui.email ?? ''}" autofocus></label>
        <label class="f">Password<input class="in" type="password" autocomplete="current-password" data-model="password"></label>
        <button class="btn pri big" type="submit" data-act="login" data-submit>Sign in</button>
        ${ui.device ? html`<button class="btn" type="button" data-act="pwMode">Back to PIN sign-in</button>` : html`<p class="quiet small">Counter staff sign in with a PIN on a counter device. An Owner sets up a device from Settings, This device.</p>`}
      </form></main></div>`);
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
// A counter PC has a keyboard: digits, Backspace and Enter work on the PIN pad.
document.addEventListener('keydown', (ev) => {
  if (!ui.pinPad || ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.matches?.('input, textarea, select')) return;
  if (/^\d$/.test(ev.key)) { ev.preventDefault(); actions.pinKey({ k: ev.key }); }
  else if (ev.key === 'Backspace') { ev.preventDefault(); actions.pinBack(); }
  else if (ev.key === 'Enter' && !ev.target.closest?.('button')) { ev.preventDefault(); root.querySelector('[data-act="pinGo"]')?.click(); }
});
actions.pwMode = () => { ui.passwordMode = !ui.passwordMode; ui.error = null; rerender(); };
actions.login = async () => { await api('POST', '/auth/login', { email: ui.email ?? '', password: ui.password ?? '' }); me = null; go('#/'); };
actions.logout = async () => { await api('POST', '/auth/logout'); me = null; cache = {}; go('#/signin'); };
// An owner of more than one restaurant moves between them; only their own appear in the list.
actions.switchRestaurant = async (_d, el) => {
  await api('POST', '/auth/switch', { businessId: el.value });
  me = null; cache = {}; go('#/');
};

// ---------- tables

/** Where an order stands, as the counter needs to see it. */
function orderState(o) {
  if (o.status === 'billed') return 'billed';
  if (o.status === 'tab') return 'tab';
  return o.lines.some((l) => l.qty > l.sentQty) ? 'new' : 'open';
}
const STATE_TEXT = { billed: 'Bill printed · to pay', tab: 'Tab', new: 'Not sent to kitchen', open: 'With kitchen' };
const STATE_SHORT = { billed: 'To pay', tab: 'Tab', new: 'Not sent', open: 'With kitchen' };
const orderHref = (o) => (o.status === 'billed' ? `#/settle/${o.bill.id}` : `#/order/${o.id}`);
const KIND_TEXT = { table: 'Table', room: 'Room service', takeaway: 'Takeaway' };

async function tablesScreen() {
  const [{ orders, tables, tablesFixed }] = await Promise.all([api('GET', B() + '/orders'), load('stays')]);
  ui.orders = orders; ui.tables = tables ?? []; ui.tablesFixed = !!tablesFixed;
  rerender = () => {
    const showGrid = can('orders.edit') && ui.tables.length > 0;
    // Orders that need the cashier first: bills waiting for money, then dishes not yet sent, then the rest.
    const rank = { billed: 0, new: 1, open: 2, tab: 3 };
    const rest = ui.orders.filter((o) => !(showGrid && o.kind === 'table')).sort((a, b) => rank[orderState(a)] - rank[orderState(b)] || a.openedAt - b.openedAt);
    const n = (s) => ui.orders.filter((o) => orderState(o) === s).length;
    const onFloor = ui.orders.filter((o) => o.status !== 'billed').reduce((t, o) => t + o.itemsPaise, 0);
    const card = (o) => {
      const s = orderState(o);
      return html`<a class="ocard ${s}" href="${orderHref(o)}">
        <div class="top-l"><div><div class="kind">${KIND_TEXT[o.kind] ?? o.kind}</div><div class="pl">${o.place}</div></div>
          <span class="amt">${rs(o.status === 'billed' ? o.bill?.totalPaise ?? 0 : o.itemsPaise)}</span></div>
        <div class="row" style="gap:6px"><span class="badge ${s}">${s === 'billed' ? `Bill ${o.bill?.billNo} · to pay` : s === 'tab' ? `Tab since ${dayName(o.openedShiftDay)}` : STATE_TEXT[s]}</span></div>
        <span class="small quiet">${o.guestName ? o.guestName + ' · ' : ''}${plural(o.lines.reduce((t, l) => t + l.qty, 0), 'item')} · opened ${time(o.openedAt)} (${since(o.openedAt)})</span></a>`;
    };
    paint(shell('#/', html`
      <div class="floorbar">
        <div><h1>Tables and orders</h1><p class="sub quiet" style="margin-top:4px">Tap a free table to start an order. Tap a busy one to add dishes or take payment.</p></div>
        ${can('orders.edit') ? html`<div class="startbar" role="group" aria-label="Start an order">
          <button class="btn ${ui.picking === 'table' ? 'pri' : ''}" type="button" data-act="newOrder" data-kind="table">New table order</button>
          <button class="btn ${ui.picking === 'room' ? 'pri' : ''}" type="button" data-act="newOrder" data-kind="room">Room service</button>
          <button class="btn ${ui.picking === 'takeaway' ? 'pri' : ''}" type="button" data-act="newOrder" data-kind="takeaway">Takeaway</button></div>` : ''}
      </div>
      ${errorBox()}
      ${ui.picking ? newOrderForm() : ''}
      <div class="row between" style="margin-bottom:14px;align-items:center">
        <div class="counts" style="margin:0">
          <span class="badge billed">${n('billed')} to pay</span><span class="badge new">${n('new')} not sent</span>
          <span class="badge open">${n('open')} with kitchen</span><span class="badge tab">${plural(n('tab'), 'tab')}</span>
          <span class="small quiet" style="align-self:center">Running total ${rs(onFloor)}</span></div>
        ${can('bills.print') ? html`<form class="findbill" role="search"><label class="vh" for="findNo">Find a bill</label><input class="in" id="findNo" data-model="findNo" placeholder="Find a bill: number or its end" value="${ui.findNo ?? ''}" inputmode="search">
          <button class="btn" type="submit" data-act="findBill" data-submit>Find bill</button></form>` : ''}
      </div>
      ${ui.found ? html`<div class="found" role="status">${ui.found.length ? ui.found.map((b) => html`<a class="chip" href="#/${b.status === 'printed' ? 'settle' : 'done'}/${b.id}">${b.billNo} · ${b.place} · ${rs(b.totalPaise)} · ${b.status === 'settled' ? 'paid' : b.status}</a>`) : html`<span class="quiet">No bill with that number.</span>`}</div>` : ''}
      ${showGrid ? tableGrid() : ''}
      <div class="sect"><h2>${showGrid ? 'Room service, takeaway and tabs' : 'Open orders'}</h2>
        ${rest.length ? html`<span class="small quiet">Bills to pay first, then oldest</span>` : ''}</div>
      ${rest.length ? html`<div class="olist">${rest.map(card)}</div>` : html`<p class="empty">${showGrid ? 'No room service, takeaway or tab open.' : 'No open orders. Start one above.'}</p>`}`));
  };
  rerender();
}
/** Tables used before: a busy one opens its order or bill, a free one starts an order with one tap. */
function tableGrid() {
  const busy = new Map(ui.orders.filter((o) => o.kind === 'table').map((o) => [o.place.toLowerCase(), o]));
  // An open order at a table that is not in the list (typed by hand) still shows, at the end.
  const listed = new Set(ui.tables.map((t) => t.toLowerCase()));
  const cells = [...ui.tables, ...[...busy.values()].filter((o) => !listed.has(o.place.toLowerCase())).map((o) => o.place)];
  const free = cells.filter((t) => !busy.has(t.toLowerCase())).length;
  return html`<div class="sect"><h2>Tables <span class="small quiet" style="font-weight:500">· ${free} free of ${cells.length}</span></h2>
      <div class="legend" aria-hidden="true"><span><i class="free"></i>Free</span><span><i class="new"></i>Not sent</span><span><i class="open"></i>With kitchen</span><span><i class="billed"></i>To pay</span><span><i class="tab"></i>Tab</span></div></div>
    ${ui.tablesFixed ? '' : html`<p class="small quiet" style="margin:-4px 0 10px">Showing tables used lately. Set your own list in Settings, Tables.</p>`}
    <div class="tgrid">${cells.map((t) => {
      const o = busy.get(t.toLowerCase());
      if (!o) return html`<button type="button" class="tcell free" data-act="quickTable" data-place="${t}" aria-label="${t}, free: start an order"><span class="tn">${t}</span><span class="ts">Free</span></button>`;
      const s = orderState(o);
      return html`<a class="tcell ${s}" href="${orderHref(o)}" aria-label="${t}, ${STATE_TEXT[s]}"><span class="tn">${t}</span>
        <span class="ta">${rs(s === 'billed' ? o.bill?.totalPaise ?? 0 : o.itemsPaise)}</span><span class="ts">${STATE_SHORT[s]} · ${since(o.openedAt)}</span></a>`;
    })}</div>`;
}
actions.quickTable = async (d) => { const r = await api('POST', B() + '/orders', { kind: 'table', place: d.place }); go(`#/order/${r.id}`); };
function newOrderForm() {
  const k = ui.picking;
  return html`<form class="panel" style="margin-bottom:18px;max-width:640px">
    <h2>${k === 'table' ? 'New table order' : k === 'room' ? 'Room service' : 'Takeaway'}</h2>
    ${k === 'table' ? html`<div class="grid2"><label class="f">Table<input class="in" data-model="place" autofocus placeholder="e.g. T4"></label>
      <label class="f">Guests<input class="in" inputmode="numeric" data-model="covers"></label></div>
      <label class="f">Guest name (for a tab, optional)<input class="in" data-model="guestName"></label>` : ''}
    ${k === 'room' ? (cache.stays.length ? html`<div class="f">Which room<div class="chips">${cache.stays.map((s) => html`<button type="button" class="chip" aria-pressed="${ui.stayId === s.id}" data-act="pickStay" data-id="${s.id}">Room ${s.room} · ${s.guestName}</button>`)}</div></div>`
      : html`<p class="quiet">No room has an open stay. Open one on Rooms and credit.</p>`) : ''}
    ${k === 'takeaway' ? html`<label class="f">Guest name (optional)<input class="in" data-model="guestName" autofocus></label>` : ''}
    <div class="row"><button class="btn pri" type="submit" data-act="openOrder" data-submit>Start order</button><button class="btn" type="button" data-act="newOrder" data-kind="">Cancel</button></div>
  </form>`;
}
actions.findBill = async () => { ui.found = (await api('GET', `${B()}/bills?no=${encodeURIComponent(ui.findNo ?? '')}`)).bills; rerender(); };
actions.newOrder = (d) => { ui.picking = d.kind || null; ui.stayId = null; ui.error = null; rerender(); };
actions.pickStay = (d) => { ui.stayId = d.id; rerender(); };
actions.openOrder = async () => {
  const covers = Number(ui.covers);
  // The server asks for a place on every order; for room service it is the chosen room (the server then names it from the stay).
  const stay = ui.picking === 'room' ? cache.stays.find((s) => s.id === ui.stayId) : null;
  const r = await api('POST', B() + '/orders', { kind: ui.picking, place: stay ? `Room ${stay.room}` : ui.place, stayId: ui.stayId, guestName: ui.guestName, covers: Number.isInteger(covers) && covers > 0 ? covers : undefined });
  go(`#/order/${r.id}`);
};

// ---------- order

async function orderScreen(id) {
  await load('menu', 'reasons');
  ui.order = (await api('GET', `${B()}/orders/${id}`)).order;
  ui.cat = 'All'; ui.q = '';
  rerender = () => {
    const o = ui.order;
    if (o.status === 'billed' || o.status === 'closed') { paint(shell('#/', html`<p class="empty">This order is already billed. <a href="#/">Back to tables</a></p>`)); return; }
    const menu = cache.menu.filter((m) => m.active);
    const cats = ['All', ...new Set(menu.map((m) => m.category))];
    const qty = (itemId) => o.lines.filter((l) => l.itemId === itemId).reduce((t, l) => t + l.qty, 0);
    const unsent = o.lines.some((l) => l.qty > l.sentQty);
    const newCount = o.lines.reduce((t, l) => t + Math.max(0, l.qty - l.sentQty), 0);
    const count = o.lines.reduce((n, l) => n + l.qty, 0);
    const total = o.lines.reduce((t, l) => t + l.qty * l.pricePaise, 0);
    const q = ui.q.trim().toLowerCase();
    const shown = menu.filter((m) => (q ? m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q) : ui.cat === 'All' || m.category === ui.cat));
    const line = (l) => html`<div>
      <div class="line"><div class="grow"><div class="nm">${l.name}</div>
          ${l.options?.length ? html`<div class="mods">${l.options.map((x) => '+ ' + x.name).join('  ')}</div>` : ''}
          <div class="sub">${rs(l.pricePaise)} each${l.typedPrice ? ' · price typed' : ''}${l.noKot ? ' · no KOT' : ''}${l.sentQty && l.qty > l.sentQty ? ` · ${l.sentQty} sent, ${l.qty - l.sentQty} new` : ''}</div></div>
        <button class="sq" type="button" data-act="less" data-id="${lineKey(l)}" aria-label="One less ${l.name}">−</button>
        <span class="qty" aria-label="${l.qty} of ${l.name}">${l.qty}</span>
        <button class="sq" type="button" data-act="more" data-id="${lineKey(l)}" aria-label="One more ${l.name}">+</button>
        <span class="lt">${rs(l.qty * l.pricePaise)}</span></div>
      ${ui.asking === lineKey(l) ? html`<div class="msg warn" role="alert"><p style="margin-bottom:8px"><strong>Already sent to the kitchen.</strong> Why cancel one?</p>
        <div class="chips">${reasonsOf('kot_cancel').map((r) => html`<button type="button" class="chip" data-act="lessWhy" data-id="${lineKey(l)}" data-r="${r.id}">${r.label}</button>`)}
        <button type="button" class="chip" data-act="lessNo">Keep it</button></div></div>` : ''}</div>`;
    const fresh = o.lines.filter((l) => l.qty > l.sentQty);
    const sent = o.lines.filter((l) => l.qty <= l.sentQty);
    paint(shell('#/', html`<div class="order">
      <section class="menu" aria-label="Menu">
        <form class="menu-search" role="search"><input class="in" type="search" data-model="q" data-live placeholder="Search dishes and drinks" value="${ui.q}" aria-label="Search the menu" autocomplete="off" enterkeyhint="done">
          ${q && shown.length ? html`<button class="vh" type="submit" data-act="addFirst" data-id="${shown[0].id}" data-submit tabindex="-1">Add ${shown[0].name}</button>` : ''}</form>
        ${q ? html`<p class="small quiet">${shown.length ? html`${plural(shown.length, 'match', 'matches')}. Press Enter to add <strong>${shown[0].name}</strong>.` : 'Nothing on the menu matches.'}</p>` : ''}
        <div class="menu-body">
          ${q ? html`<div></div>` : html`<nav class="cats" aria-label="Menu categories">${cats.map((c) => html`<button type="button" class="chip" aria-pressed="${ui.cat === c}" data-act="cat" data-c="${c}">${c}<span class="c">${c === 'All' ? menu.length : menu.filter((m) => m.category === c).length}</span></button>`)}</nav>`}
          <div class="items">${shown.map((m) => html`<button type="button" class="item ${qty(m.id) ? 'has' : ''}" data-act="dish" data-id="${m.id}" data-station="${m.station}" aria-label="Add ${m.name}, ${m.openPrice ? 'price typed' : rs(m.pricePaise)}${qty(m.id) ? `, ${qty(m.id)} on the order` : ''}">
            <strong>${m.name}</strong><span class="p">${m.openPrice ? 'Price at billing' : `${groupsOf(m).some((g) => g.kind === 'one') ? 'from ' : ''}${rs(m.pricePaise)}`}${m.station === 'bar' ? ' · Bar' : ''}</span>
            ${needsPicker(m) ? html`<span class="has-add">${groupsOf(m).some((g) => g.kind === 'one') ? 'Choose' : m.openPrice ? 'Type price' : '+ add-ons'}</span>` : ''}
            ${qty(m.id) ? html`<span class="q" aria-hidden="true">${qty(m.id)}</span>` : ''}</button>`)}</div>
        </div>
      </section>
      <section class="ticket panel" aria-label="Order" id="ticket">
        <div class="tk-head"><div><p class="tiny quiet" style="font-weight:700">${KIND_TEXT[o.kind] ?? o.kind}${o.status === 'tab' ? ` · tab since ${dayName(o.openedShiftDay)}` : ''}</p><h2>${o.place}</h2>
            <p class="quiet small">${o.guestName ? o.guestName + ' · ' : ''}opened ${time(o.openedAt)}</p></div>
          <a class="btn" href="#/">Tables</a></div>
        <div class="tk-body">
          ${errorBox()}
          ${ui.kotDone ? html`<div class="msg ok" role="status">${ui.kotDone}</div>` : ''}
          ${o.lines.length ? '' : html`<p class="empty" style="margin-top:12px">Tap dishes on the menu to add them.</p>`}
          ${fresh.length ? html`<div class="tk-group new"><p class="label"><span>New · not sent yet</span><span>${newCount}</span></p>${fresh.map(line)}</div>` : ''}
          ${sent.length ? html`<div class="tk-group"><p class="label"><span>Sent to kitchen or bar</span><span>${sent.reduce((t, l) => t + l.qty, 0)}</span></p>${sent.map(line)}</div>` : ''}
          ${ui.splitting ? html`<div class="msg warn"><p style="margin-bottom:8px"><strong>Split bill:</strong> choose what moves to a new bill at this table. Each bill gets its own number and GST.</p>
            ${o.lines.map((l) => html`<div class="line"><span class="grow">${l.name}${l.options?.length ? ` (${l.options.map((x) => x.name).join(', ')})` : ''} <span class="quiet small">(${l.qty} on this bill)</span></span>
              <button class="sq" type="button" data-act="splitLess" data-id="${l.id}" aria-label="Move one less ${l.name}">−</button>
              <span class="qty">${ui.split[l.id] ?? 0}</span>
              <button class="sq" type="button" data-act="splitMore" data-id="${l.id}" aria-label="Move one more ${l.name}">+</button></div>`)}
            <div class="row" style="margin-top:10px"><button class="btn pri" type="button" data-act="splitGo">Move to a new bill</button><button class="btn" type="button" data-act="splitNo">Cancel</button></div></div>` : ''}
          ${ui.tabAsk ? html`<form class="msg warn"><label class="f">Guest name for the tab<input class="in" data-model="tabGuest" value="${o.guestName ?? ''}" autofocus></label>
            <div class="row" style="margin-top:8px"><button class="btn pri" type="submit" data-act="tabGo" data-submit>Keep as tab</button></div></form>` : ''}
        </div>
        <div class="tk-foot">
          <div class="tk-total"><span>${plural(count, 'item')}</span><strong>${rs(total)}</strong></div>
          <div class="tk-main ${can('bills.print') ? '' : 'one'}">
            <button class="btn ${unsent ? 'pri' : ''}" type="button" data-act="kot" ${unsent ? '' : 'disabled'}>Send KOT${unsent ? ` · ${newCount} new` : ''}</button>
            ${can('bills.print') ? html`<button class="btn ${o.lines.length && !unsent ? 'go' : ''}" type="button" data-act="toBill" ${!o.lines.length || unsent ? 'disabled' : ''}>Bill</button>` : ''}</div>
          ${unsent && can('bills.print') ? html`<p class="hint">Send the new dishes to the kitchen before billing.</p>` : ''}
          <div class="tk-more">${count > 1 && !ui.splitting ? html`<button class="btn" type="button" data-act="splitAsk">Split bill</button>` : ''}
            ${o.status === 'open' ? html`<button class="btn" type="button" data-act="keepTab">Keep as a tab</button>` : ''}
            ${!o.lines.some((l) => l.sentQty) ? html`<button class="btn danger" type="button" data-act="dropOrder">Cancel order</button>` : ''}</div>
        </div>
      </section></div>
      <div class="orderbar"><div class="ob-t">${o.place} · ${rs(total)}<span class="small" role="status">${ui.kotDone && !unsent ? 'KOT sent ✓' : `${plural(count, 'item')}${unsent ? ` · ${newCount} not sent` : ''}`}</span></div>
        <div class="row" style="gap:8px;flex-wrap:nowrap">${unsent ? html`<button class="btn pri" type="button" data-act="kot">Send KOT</button>` : ''}
          <button class="btn" type="button" data-act="toTicket">${unsent ? 'Order' : 'View order'}</button></div></div>
      ${ui.pick ? pickerSheet() : ''}`));
  };
  rerender();
}
/** A dish's add-on groups, in its own order. */
const groupsOf = (m) => (m.addonGroups ?? []).map((id) => (cache.addonGroups ?? []).find((g) => g.id === id)).filter(Boolean);
const needsPicker = (m) => m.openPrice || groupsOf(m).length > 0;
/**
 * What choosing an option adds on this dish: the same rule as the server (pos/src/addons.ts). A dish's own prices for a
 * "pick one" are full prices (the dish's price is the first one's); for an "add any", what the extra costs on this dish.
 */
const pkey = (n) => String(n).trim().toLowerCase();
function optionAdd(kind, options, option, prices) {
  const mine = prices?.[pkey(option.name)];
  if (kind === 'one') { const first = options[0] ? prices?.[pkey(options[0].name)] : undefined; return mine !== undefined && first !== undefined ? mine - first : option.addPaise; }
  return mine ?? option.addPaise;
}
/** A ticket line's handle: its id once saved; before that, its dish (a plain line). */
const lineKey = (l) => l.id ?? `item:${l.itemId}`;

// The add-on box: choose one from each "choose one" group, any from "add any", a typed price for a price-at-billing dish.
function pickerSheet() {
  const p = ui.pick;
  const m = cache.menu.find((x) => x.id === p.itemId);
  const gs = groupsOf(m);
  const typed = m.openPrice ? toPaise(ui.pickPrice ?? '') : null;
  const base = m.openPrice ? (typed ?? 0) : m.pricePaise;
  const add = (g, o) => optionAdd(g.kind, g.options, o, m.addonPrices?.[g.id]);
  const unit = Math.max(0, base + gs.flatMap((g) => g.options.filter((o) => p.chosen.includes(o.id)).map((o) => add(g, o))).reduce((t, x) => t + x, 0));
  const missing = gs.filter((g) => g.kind === 'one' && !g.options.some((o) => p.chosen.includes(o.id)));
  const priceBad = m.openPrice && (!typed || (m.minPricePaise != null && typed < m.minPricePaise));
  const ready = !missing.length && !priceBad;
  const opening = p.opening; p.opening = false;
  return html`<div class="scrim" data-act="pickClose"><div class="sheet ${opening ? 'opening' : ''}" role="dialog" aria-modal="true" aria-labelledby="pk-h" data-act="pickStay">
    <div class="sh-head"><h2 id="pk-h">${m.name}</h2><p class="small quiet">${m.openPrice ? `Type the price${m.minPricePaise != null ? `: at least ${rs(m.minPricePaise)}` : ''}` : rs(m.pricePaise)}</p></div>
    <form class="sh-body">
      ${m.openPrice ? html`<label class="f">Price (₹)<input class="in" inputmode="decimal" data-model="pickPrice" data-live value="${ui.pickPrice ?? ''}" autofocus></label>` : ''}
      ${gs.map((g) => html`<div class="group"><p class="label">${g.name}${g.kind === 'one' ? html`<span class="req">Pick one</span>` : html` · pick any`}</p>
        <div class="opts ${g.kind === 'one' ? 'radio' : 'check'}" role="${g.kind === 'one' ? 'radiogroup' : 'group'}" aria-label="${g.name}">${g.options.map((o) => html`<button type="button" class="opt" role="${g.kind === 'one' ? 'radio' : 'checkbox'}" aria-checked="${p.chosen.includes(o.id)}" data-act="pickOpt" data-g="${g.id}" data-id="${o.id}">
          <span class="mark"></span><span class="nm">${o.name}</span><span class="money">${g.kind === 'one' ? (m.addonPrices?.[g.id] || !add(g, o) ? rs(base + add(g, o)) : `+${rs(add(g, o))}`) : add(g, o) ? `+${rs(add(g, o))}` : ''}</span></button>`)}</div></div>`)}
      ${errorBox()}
    </form>
    <div class="sh-foot">
      <div class="stepper" aria-label="Quantity"><button type="button" data-act="pickQty" data-d="-1" aria-label="One less">−</button><span>${p.qty}</span><button type="button" data-act="pickQty" data-d="1" aria-label="One more">+</button></div>
      <button class="btn" type="button" data-act="pickClose">Cancel</button>
      <button class="btn go add" type="button" data-act="pickAdd" data-submit ${ready ? '' : 'disabled'}>${ready ? `Add · ${rs(unit * p.qty)}` : missing.length ? `Pick ${missing[0].name.toLowerCase()} first` : 'Type the price first'}</button>
    </div></div></div>`;
}
actions.dish = (d) => {
  const m = cache.menu.find((x) => x.id === d.id);
  if (needsPicker(m)) { ui.pick = { itemId: m.id, chosen: [], qty: 1, opening: true }; ui.pickPrice = ''; ui.error = null; rerender(); return; }
  change({ itemId: m.id }, 1);
};
actions.pickStay = () => {};
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && ui.pick) { ui.pick = null; ui.error = null; rerender(); } });
actions.pickClose = (d, el) => { if (el.classList.contains('sheet')) return; ui.pick = null; ui.error = null; rerender(); };
actions.pickOpt = (d) => {
  const g = cache.addonGroups.find((x) => x.id === d.g);
  const p = ui.pick;
  if (g.kind === 'one') p.chosen = [...p.chosen.filter((id) => !g.options.some((o) => o.id === id)), d.id];
  else p.chosen = p.chosen.includes(d.id) ? p.chosen.filter((id) => id !== d.id) : [...p.chosen, d.id];
  rerender();
};
actions.pickQty = (d) => { ui.pick.qty = Math.max(1, ui.pick.qty + Number(d.d)); rerender(); };
actions.pickAdd = async () => {
  await saved();
  const p = ui.pick;
  const r = await api('POST', `${B()}/orders/${ui.order.id}/items`, { itemId: p.itemId, delta: p.qty, options: p.chosen, price: ui.pickPrice || undefined });
  ui.order = r.order; ui.pick = null; ui.pickPrice = undefined; ui.error = null; ui.kotDone = null; rerender();
};
actions.addFirst = (d) => { ui.q = ''; actions.dish(d); if (!ui.pick) root.querySelector('[data-model="q"]')?.focus(); };
actions.toTicket = () => document.getElementById('ticket')?.scrollIntoView({ behavior: 'smooth' });
actions.cat = (d) => { ui.cat = d.c; rerender(); };
// Dish taps show at once and are saved one after another behind the screen. Sending the KOT, billing or leaving waits for them.
let saving = Promise.resolve();
let pendingSaves = 0;
/** target: {itemId} for a plain dish (its plain line, or a new one), or {key} for a line on the ticket. */
function change(target, delta, reasonId) {
  const o = ui.order;
  const plain = (x) => !x.options?.length && !x.typedPrice;
  const l = target.key ? o.lines.find((x) => lineKey(x) === target.key) : o.lines.find((x) => x.itemId === target.itemId && plain(x));
  const itemId = target.itemId ?? l?.itemId;
  const lineId = l?.id;
  if (l) l.qty += delta;
  else { const m = cache.menu.find((x) => x.id === itemId); o.lines.push({ itemId, name: m.name, pricePaise: m.pricePaise, qty: delta, sentQty: 0, options: [] }); }
  o.lines = o.lines.filter((x) => x.qty > 0);
  ui.error = null; ui.kotDone = null; rerender();
  const orderId = o.id;
  pendingSaves++;
  saving = saving.then(async () => {
    try {
      const r = await api('POST', `${B()}/orders/${orderId}/items`, lineId ? { lineId, delta, reasonId } : { itemId, delta, reasonId });
      // A cancel of something already sent tells its station; print it here if the station's device is offline.
      if (r.kots?.length) { printKots(r.kots.filter((k) => k.printAt === 'counter')); flash = { kind: 'ok', text: kotSummary(r.kots) }; }
      if (--pendingSaves === 0 && ui.order?.id === orderId) { ui.order = r.order; rerender(); }
    } catch (e) {
      pendingSaves--;
      if (ui.order?.id !== orderId) return;
      // Put the screen back to what the server holds, and say what failed.
      ui.order = (await api('GET', `${B()}/orders/${orderId}`).catch(() => ({ order: ui.order }))).order;
      ui.error = e.message; rerender();
    }
  });
}
const saved = () => saving;
actions.more = (d) => change({ key: d.id }, 1);
actions.less = (d) => {
  const l = ui.order.lines.find((x) => lineKey(x) === d.id);
  if (l.qty <= l.sentQty) { ui.asking = d.id; rerender(); return; }
  change({ key: d.id }, -1);
};
actions.lessWhy = (d) => { ui.asking = null; change({ key: d.id }, -1, d.r); };
actions.toBill = async () => { await saved(); if (!ui.error) go(`#/bill/${ui.order.id}`); };
actions.lessNo = () => { ui.asking = null; rerender(); };
actions.kot = async () => {
  await saved();
  const { kots, order } = await api('POST', `${B()}/orders/${ui.order.id}/kot`);
  ui.order = order;
  ui.kotDone = kotSummary(kots);
  printKots(kots.filter((k) => k.printAt === 'counter')); rerender();
};
actions.keepTab = () => { ui.tabAsk = true; rerender(); };
actions.splitAsk = () => { ui.splitting = true; ui.split = {}; rerender(); };
actions.splitNo = () => { ui.splitting = false; rerender(); };
actions.splitMore = (d) => { const l = ui.order.lines.find((x) => x.id === d.id); ui.split[d.id] = Math.min(l.qty, (ui.split[d.id] ?? 0) + 1); rerender(); };
actions.splitLess = (d) => { ui.split[d.id] = Math.max(0, (ui.split[d.id] ?? 0) - 1); rerender(); };
actions.splitGo = async () => {
  await saved();
  const lines = Object.entries(ui.split).filter(([, q]) => q > 0).map(([lineId, qty]) => ({ lineId, qty }));
  const r = await api('POST', `${B()}/orders/${ui.order.id}/split`, { lines });
  flash = { kind: 'ok', text: `Split. This is the new bill; ${ui.order.place} keeps the rest.` };
  go(`#/order/${r.id}`);
};
actions.tabGo = async () => { await saved(); await api('POST', `${B()}/orders/${ui.order.id}/tab`, { guestName: ui.tabGuest ?? ui.order.guestName }); flash = { kind: 'ok', text: `${ui.order.place} kept as a tab.` }; go('#/'); };
actions.dropOrder = async () => { await saved(); await api('POST', `${B()}/orders/${ui.order.id}/cancel`); go('#/'); };

// ---------- bill (choose the billing name and discount, then print)

// ---------- tax: the same rules as the server (pos/src/billing.ts), for the preview before printing
const roundDiv = (n, d) => Math.floor((n * 2 + d) / (2 * d));
/** A dish's tax: the dish's own, else its category's, else the billing name's rate; no GST at all when not registered. */
function dishTax(itemId, e) {
  const m = cache.menu.find((x) => x.id === itemId);
  const c = (cache.menuCats ?? []).find((x) => x.name.toLowerCase() === (m?.category ?? '').toLowerCase());
  const from = m?.taxMode ? m : c?.taxMode ? c : { taxMode: 'billing' };
  if (from.taxMode === 'liquor') return { kind: 'liquor' };
  if (from.taxMode === 'none') return { kind: 'exempt' };
  const bp = from.taxMode === 'rate' ? from.gstBp : e?.gst_rate_bp ?? 0;
  return { kind: 'gst', bp: e?.gst_registered ? bp : 0 };
}
function previewTotals(lines, discBp, e) {
  const gross = lines.reduce((t, l) => t + l.qty * l.pricePaise, 0);
  const disc = roundDiv(gross * discBp, 10000);
  const m = new Map();
  for (const l of lines) {
    const tax = dishTax(l.itemId, e); const k = `${tax.kind}:${tax.bp ?? 0}`;
    const b = m.get(k) ?? { tax, gross: 0 }; b.gross += l.qty * l.pricePaise; m.set(k, b);
  }
  const ord = { gst: 0, liquor: 1, exempt: 2 };
  const bs = [...m.values()].filter((b) => b.gross > 0).sort((a, b) => ord[a.tax.kind] - ord[b.tax.kind] || (a.tax.bp ?? 0) - (b.tax.bp ?? 0));
  let left = disc;
  const taxes = bs.map((b, i) => {
    const share = i === bs.length - 1 ? left : roundDiv(b.gross * disc, gross); left -= share;
    const v = b.gross - share; const half = b.tax.kind === 'gst' ? roundDiv(v * b.tax.bp, 20000) : 0;
    return { kind: b.tax.kind, bp: b.tax.bp ?? 0, valuePaise: v, cgstPaise: half, sgstPaise: half };
  });
  const raw = taxes.reduce((t, r) => t + r.valuePaise + r.cgstPaise + r.sgstPaise, 0);
  const total = roundDiv(raw, 100) * 100;
  return { gross, disc, taxes, raw, total };
}
const taxTag = (t) => (t.kind === 'liquor' ? 'liquor, no GST' : t.kind === 'exempt' ? 'no GST' : t.bp ? `GST ${t.bp / 100}%` : 'no GST');
/** A bill's tax rows as lines: value and CGST/SGST for each rate, then liquor and no-GST values. */
const taxLines = (rows, cls, registered = true) => rows.map((r) => r.kind === 'gst'
  ? (registered && r.bp ? html`<div class="${cls}"><span class="quiet">Taxable at ${r.bp / 100}%</span><span>${rs(r.valuePaise)}</span></div>
      <div class="${cls}"><span class="quiet">CGST ${r.bp / 200}%</span><span>${rs(r.cgstPaise)}</span></div><div class="${cls}"><span class="quiet">SGST ${r.bp / 200}%</span><span>${rs(r.sgstPaise)}</span></div>` : '')
  : html`<div class="${cls}"><span class="quiet">${r.kind === 'liquor' ? '* Liquor, no GST' : '† No GST'}</span><span>${rs(r.valuePaise)}</span></div>`);

async function billScreen(orderId) {
  await saved();
  const [{ order }] = await Promise.all([api('GET', `${B()}/orders/${orderId}`), load('entities', 'reasons', 'menu')]);
  ui.order = order;
  const ents = counterEntities();
  ui.entityId = (ents.find((e) => e.is_default) ?? ents[0])?.id;
  ui.disc = 0; ui.discReason = null;
  rerender = () => {
    const o = ui.order;
    const e = ents.find((x) => x.id === ui.entityId);
    // The same sums as the server: each line taxed by dish, category or billing name; the discount shared by value.
    const { gross, disc, taxes, raw, total } = previewTotals(o.lines, ui.disc * 100, e);
    const near = e && e.warn1_paise !== null && e.year_paise + total >= e.warn1_paise;
    const ready = e && !(ui.disc && !ui.discReason);
    paint(shell('#/', html`
      ${pageHead(html`Bill for ${o.place}`, 'Check the name on the bill and any discount, then print. A printed bill cannot be edited.', html`<a class="btn" href="#/order/${o.id}">Back to the order</a>`)}
      ${errorBox()}
      <div class="two rev">
      <section class="panel">
        ${ents.length > 1 ? html`<div><p class="label">Bill in the name of</p>
          <div class="choice">${ents.map((x) => html`<button type="button" class="chip" aria-pressed="${ui.entityId === x.id}" data-act="ent" data-id="${x.id}"><span>${x.name}</span><span class="s">${x.gst_registered ? `GST ${x.gst_rate_bp / 100}%` : 'No GST'}${x.is_default ? ' · usual' : ''}</span></button>`)}</div></div>` : ''}
        ${near ? html`<div class="msg warn">${e.name} has ${rs(e.year_paise)} billed this year${e.stop_paise ? `; it stops at ${rs(e.stop_paise)}` : ''}.</div>` : ''}
        <div><p class="label">Discount</p>
          <div class="chips">${[0, 5, 10, 15].map((p) => html`<button type="button" class="chip" aria-pressed="${ui.disc === p}" data-act="disc" data-p="${p}">${p ? p + '%' : 'None'}</button>`)}</div>
          ${ui.disc ? html`<p class="label" style="margin-top:14px">Reason for the discount (required)</p><div class="chips">${reasonsOf('discount').map((r) => html`<button type="button" class="chip" aria-pressed="${ui.discReason === r.id}" data-act="discWhy" data-id="${r.id}">${r.label}</button>`)}</div>` : ''}</div>
        <label class="f">Guest name on the bill (optional)<input class="in" data-model="guestName" value="${ui.guestName ?? o.guestName ?? ''}"></label>
      </section>
      <section class="panel">
        <div class="preview" aria-label="Bill preview">
          <div class="pl"><strong>${e?.name ?? 'Choose a billing name'}</strong><span class="quiet">${o.place}</span></div><hr>
          ${o.lines.filter((l) => l.qty > 0).map((l) => html`<div class="pl"><span>${l.qty} × ${l.name}${l.options?.length ? ` (${l.options.map((x) => x.name).join(', ')})` : ''} <span class="small quiet">${taxTag(dishTax(l.itemId, e))}</span></span><span>${rs(l.qty * l.pricePaise)}</span></div>`)}<hr>
          <div class="pl"><span class="quiet">Items</span><span>${rs(gross)}</span></div>
          ${disc ? html`<div class="pl"><span class="quiet">Discount ${ui.disc}%</span><span>${rs(-disc)}</span></div>` : ''}
          ${taxLines(taxes, 'pl', !!e?.gst_registered)}
          ${total !== raw ? html`<div class="pl"><span class="quiet">Round off</span><span>${rs(total - raw)}</span></div>` : ''}
          <hr><div class="pl tot"><span>Total</span><span>${rs(total)}</span></div>
        </div>
        <button class="btn go big wide" type="button" data-act="printBill" ${ready ? '' : 'disabled'}>Print bill · ${rs(total)}</button>
        ${ui.disc && !ui.discReason ? html`<p class="hint">Choose a reason for the discount to print.</p>` : ''}
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
  const [{ bill }, { orders }] = await Promise.all([api('GET', `${B()}/bills/${billId}`), api('GET', B() + '/orders'), load('reasons', 'payAccounts', 'stays', 'credit', 'entities')]);
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
    const done = left === 0 || diffOk(left);
    // Cash: the note handed over, and the change, worked out as it is typed or tapped.
    const thisAmt = left > 0 ? (ui.amount !== undefined ? toPaise(ui.amount) : shareOf(due, left)) : null;
    const given = ui.tendered ? toPaise(ui.tendered) : null;
    const notes = thisAmt ? [...new Set([Math.ceil(thisAmt / 10000) * 10000, Math.ceil(thisAmt / 50000) * 50000, Math.ceil(thisAmt / 100000) * 100000, Math.ceil(thisAmt / 200000) * 200000])].filter((n) => n > thisAmt).slice(0, 4) : [];
    paint(shell('#/', html`
      ${pageHead(html`Take payment · ${ui.bill.place}`, `Bill ${ui.bill.billNo} · ${ui.bill.entityName}${ui.bill.gstRegistered ? '' : ' · no GST'}`, html`<a class="btn" href="#/">Tables</a>`)}
      <div class="two">
      <section class="panel">
        <div class="preview">
          ${ui.bill.items.map((l) => html`<div class="pl"><span>${l.qty} × ${l.name}${l.options?.length ? ` (${l.options.map((x) => x.name ?? x).join(', ')})` : ''}</span><span>${rs(l.amountPaise)}</span></div>`)}<hr>
          ${ui.bill.discountPaise ? html`<div class="pl"><span class="quiet">Discount · ${ui.bill.discountReason}</span><span>${rs(-ui.bill.discountPaise)}</span></div>` : ''}
          ${taxLines(ui.bill.taxes ?? [], 'pl', !!ui.bill.gstRegistered)}
          <div class="pl tot"><span>This bill</span><span>${rs(ui.bill.totalPaise)}</span></div></div>
        ${ui.others.length ? html`<div><p class="label">Paid together with (one payment for several bills)</p>
          <div class="chips">${ui.others.map((o) => html`<button type="button" class="chip" aria-pressed="${ui.together.includes(o.bill.id)}" data-act="together" data-id="${o.bill.id}">${o.place} · ${o.bill.billNo} · ${rs(o.bill.totalPaise)}</button>`)}</div></div>` : ''}
        <div class="row"><button class="btn" type="button" data-act="reprint">Reprint bill</button>${can('bills.void') ? html`<button class="btn danger" type="button" data-act="voidAsk">Void bill</button>` : ''}</div>
        ${can('bills.void') ? '' : html`<p class="small quiet">Voiding a bill needs a manager: they sign in with their PIN on this device.</p>`}
        ${ui.voidAsk ? html`<div class="msg warn" role="alert"><p style="margin-bottom:8px"><strong>Void ${ui.bill.billNo}?</strong> The number stays used, and the order opens again to be billed afresh.</p>
          <div class="chips">${reasonsOf('void').map((r) => html`<button type="button" class="chip" data-act="voidGo" data-r="${r.id}">${r.label}</button>`)}<button type="button" class="chip" data-act="voidAsk">Keep the bill</button></div></div>` : ''}
      </section>
      <section class="panel">
        <div class="due"><div><span class="k">${ui.together.length ? `To pay · ${ui.together.length + 1} bills` : 'To pay'}</span><div class="v">${rs(due)}</div></div>
          ${ui.pays.length ? html`<div style="text-align:right"><span class="k">${left > 0 ? 'Still to pay' : left < 0 ? 'Paid over' : 'Paid'}</span><div class="v" style="font-size:24px;color:${left > 0 ? 'var(--warn)' : 'var(--go-dark)'}">${rs(Math.abs(left) || paid)}</div></div>` : ''}</div>
        ${errorBox()}
        ${!ui.pays.length && !ui.shares ? html`<div><p class="label">Paid in full · one tap settles</p><div class="quick">
          <button class="btn go" type="button" data-act="quick" data-m="cash"><span>Cash</span><span class="s">${rs(due)} exact</span></button>
          ${cache.payAccounts.filter((a) => a.active).map((a) => html`<button class="btn pri" type="button" data-act="quick" data-m="upi" data-id="${a.id}"><span>UPI</span><span class="s">${a.name}</span></button>`)}</div></div>
          <p class="divider">Or card, room, credit, complimentary, change, part payments</p>` : ''}
        <div><p class="label">${ui.pays.length ? 'Next payment' : 'Payment by'}</p>
          <div class="chips">${modes.map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${m === k}" data-act="mode" data-m="${k}">${t}</button>`)}</div></div>
        <div class="row small"><span class="quiet" style="font-weight:650">Split equally between</span>${[2, 3, 4, 5, 6].map((n) => html`<button type="button" class="chip" aria-pressed="${ui.shares === n}" data-act="shares" data-n="${n}" aria-label="Split equally between ${n}">${n}</button>`)}
          ${ui.shares ? html`<span class="badge open">Share ${Math.min(ui.pays.length + 1, ui.shares)} of ${ui.shares}</span>` : ''}</div>
        <form class="grid2">
          ${amountField ? html`<label class="f">${m === 'cash' ? 'Amount for this bill (₹)' : 'Amount (₹)'}<input class="in" inputmode="decimal" data-model="amount" data-live value="${ui.amount ?? (left > 0 ? rupees(shareOf(due, left)) : '')}"></label>` : ''}
          ${m === 'cash' ? html`<label class="f">Cash given (₹, optional)<input class="in" inputmode="decimal" data-model="tendered" data-live value="${ui.tendered ?? ''}"></label>
            ${notes.length ? html`<div class="f" style="grid-column:1/-1">Note handed over<div class="chips">${notes.map((n) => html`<button type="button" class="chip" aria-pressed="${given === n}" data-act="tender" data-p="${n}">${rs(n)}</button>`)}</div></div>` : ''}
            ${given && thisAmt && given > thisAmt ? html`<p class="change" role="status" style="grid-column:1/-1">Give change: ${rs(given - thisAmt)}</p>` : ''}` : ''}
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
        <div><button class="btn ${left > 0 ? 'pri' : ''}" type="button" data-act="addPay" ${left > 0 ? '' : 'disabled'}>Add this payment</button></div>
        ${ui.pays.length && left > 0 ? html`<div class="msg warn"><p style="margin-bottom:8px"><strong>${rs(left)} still to pay.</strong> Take another payment, or mark it as a discount (the printed bill stays as it is):</p>
          <div class="chips">${reasonsOf('discount').map((r) => html`<button type="button" class="chip" aria-pressed="${ui.diff?.kind === 'discount' && ui.diff.reasonId === r.id}" data-act="diffDisc" data-id="${r.id}">${r.label}</button>`)}</div></div>` : ''}
        ${left < 0 ? html`<div class="msg warn"><p style="margin-bottom:8px"><strong>Paid ${rs(-left)} more than the bill.</strong> Mark it as a tip for staff, or remove the payment and enter cash given so change is worked out.</p>
          <button type="button" class="chip" aria-pressed="${ui.diff?.kind === 'tip'}" data-act="diffTip">Mark ${rs(-left)} as a tip</button></div>` : ''}
        ${ui.mismatch ? html`<div class="msg warn" role="alert"><p style="margin-bottom:8px">${ui.mismatch}</p><button class="btn" type="button" data-act="settle" data-confirm="1">Settle anyway</button></div>` : ''}
        <div class="paylist"><p class="label">Payments taken</p>
          ${ui.pays.length ? ui.pays.map((p, i) => html`<div class="line"><strong style="min-width:96px">${p.label}</strong><span class="grow quiet small">${p.detail}</span><span class="num" style="font-weight:700">${rs(p.amountPaise)}</span>
            <button class="ibtn danger" type="button" data-act="dropPay" data-i="${i}" title="Remove this payment" aria-label="Remove ${p.label} ${rs(p.amountPaise)}">${ICON.trash}</button></div>`) : html`<p class="quiet small">None yet. The bill closes only when payments add up to the total.</p>`}</div>
        <div class="paybar"><span class="st ${done ? 'ok' : ''}" role="status">${left === 0 ? 'Paid in full' : diffOk(left) ? (left > 0 ? `Paid, with ${rs(left)} discount` : `Paid, with ${rs(-left)} tip`) : left > 0 ? 'Left to pay ' + rs(left) : 'Over by ' + rs(-left)}</span>
          <button class="btn go" type="button" data-act="settle" ${done && ui.pays.length ? '' : 'disabled'}>Settle bill</button></div>
      </section></div>`));
  };
  rerender();
}
actions.tender = (d) => { ui.tendered = rupees(Number(d.p)); rerender(); };
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
/** A difference marked to match: a discount (with a reason) when paid less, a tip when paid more. */
const diffOk = (left) => (left > 0 && ui.diff?.kind === 'discount' && !!ui.diff.reasonId) || (left < 0 && ui.diff?.kind === 'tip');
actions.diffDisc = (d) => { ui.diff = { kind: 'discount', reasonId: d.id }; rerender(); };
actions.diffTip = () => { ui.diff = ui.diff?.kind === 'tip' ? null : { kind: 'tip' }; rerender(); };
actions.dropPay = (d) => { ui.pays.splice(Number(d.i), 1); ui.amount = undefined; ui.mismatch = null; ui.diff = null; rerender(); };
actions.addPay = () => {
  ui.error = null;
  const due = ui.bill.totalPaise + ui.together.reduce((s, id) => s + ui.others.find((o) => o.bill.id === id).bill.totalPaise, 0);
  const left = due - ui.pays.reduce((s, p) => s + p.amountPaise, 0);
  const m = ui.mode;
  let amountPaise = ['room', 'credit', 'comp'].includes(m) ? shareOf(due, left) : toPaise(ui.amount ?? rupees(shareOf(due, left)));
  if (!amountPaise || amountPaise <= 0) throw new Error('Type the amount.');
  // More than is left: on cash, UPI or card it may be a tip (asked on screen); other ways cannot carry one.
  if (amountPaise > left && !['cash', 'upi', 'card'].includes(m)) throw new Error('More than what is left to pay.');
  if (amountPaise > left && m === 'cash' && ui.tendered) throw new Error('Type the bill amount here, and the note handed over as "cash given".');
  const p = { mode: m, amount: rupees(amountPaise), amountPaise, label: { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Room', credit: 'Credit', comp: 'Complimentary', advance: 'Advance' }[m], detail: '' };
  if (m === 'cash' && ui.tendered) {
    const t = toPaise(ui.tendered);
    if (t === null || t <= 0) throw new Error('Type the cash given in rupees.');
    if (t < amountPaise) {
      // Less cash than the bill: what was handed over is what was paid; the rest is still to pay (or a discount).
      p.amountPaise = t; p.amount = rupees(t); p.detail = 'Cash given';
    } else { p.tendered = rupees(t); p.detail = t > amountPaise ? `Given ${rs(t)} · change ${rs(t - amountPaise)}` : 'Exact'; }
  }
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
  ui.diff = null;
  ui.amount = undefined; ui.tendered = undefined; ui.cardApproval = undefined; ui.cardLast4 = undefined;
  rerender();
};
/** The whole amount by cash, or by one account's UPI QR, settled at once. */
actions.quick = async (d) => {
  const due = ui.bill.totalPaise + ui.together.reduce((s, id) => s + ui.others.find((o) => o.bill.id === id).bill.totalPaise, 0);
  const acct = cache.payAccounts.find((a) => a.id === d.id);
  ui.pays = [d.m === 'cash' ? { mode: 'cash', amount: rupees(due), amountPaise: due, label: 'Cash', detail: 'Exact' }
    : { mode: 'upi', amount: rupees(due), amountPaise: due, payAccountId: acct.id, label: 'UPI', detail: acct.name }];
  ui.diff = null;
  // A refusal clears the payment again; a "billing name differs" question keeps it, so "Settle anyway" works.
  try { await actions.settle({}); } catch (e) { ui.pays = []; throw e; }
};
actions.settle = async (d) => {
  ui.error = null;
  const dueNow = ui.bill.totalPaise + ui.together.reduce((s2, id) => s2 + ui.others.find((o) => o.bill.id === id).bill.totalPaise, 0);
  const leftNow = dueNow - ui.pays.reduce((s2, p) => s2 + p.amountPaise, 0);
  const body = { billIds: [ui.bill.id, ...ui.together], payments: ui.pays.map(({ label, detail, amountPaise, ...p }) => p), confirm: d.confirm ? ['entity_mismatch'] : [],
    difference: leftNow !== 0 && diffOk(leftNow) ? ui.diff : undefined };
  try {
    const r = await api('POST', B() + '/settlements', body);
    const paidBy = [...new Set(ui.pays.map((p) => p.label))].join(' + ');
    flash = { kind: 'ok', text: `${ui.bill.place}: ${ui.bill.billNo} settled · ${paidBy}.${r.changePaise ? ` Give change: ${rs(r.changePaise)}.` : ''}`, link: [`#/done/${ui.bill.id}`, 'View receipt'] };
    go('#/');
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
  if (can('bills.refund') && bill.status === 'settled') await load('payAccounts', 'stays', 'credit');
  ui.done = bill; ui.cn = null;
  const credited = {};
  for (const n of bill.creditNotes) for (const l of n.lines) credited[l.lineId] = (credited[l.lineId] ?? 0) + l.qty;
  const leftOf = (i) => i.qty - (credited[i.id] ?? 0);
  rerender = () => {
    const cn = ui.cn;
    const anyLeft = bill.items.some((i) => leftOf(i) > 0);
    const st = bill.status === 'settled' ? ['', '✓', 'Paid and settled'] : bill.status === 'void' ? ['void', '×', 'Void'] : ['wait', '!', 'Printed, not paid'];
    paint(shell('#/', html`<div class="two rev">
    <section class="panel">
      <div class="done-head"><span class="tick ${st[0]}" aria-hidden="true">${st[1]}</span><div><h1>${st[2]}</h1>
        <p class="quiet">Bill ${bill.billNo} · ${bill.place} · <strong class="money" style="color:var(--ink)">${rs(bill.totalPaise)}</strong></p></div></div>
      ${bill.status === 'printed' && can('bills.settle') ? html`<a class="btn go big" href="#/settle/${bill.id}">Take payment</a>` : ''}
      ${bill.creditNotes.length ? html`<div class="sums"><div><strong>Money given back</strong></div>${bill.creditNotes.map((n) => html`<div><span>${n.cnNo} · ${n.reason} · ${n.refundMode}</span><span>${rs(-n.totalPaise)}</span></div>`)}</div>` : ''}
      <p class="quiet">The printed bill cannot be edited. Before payment a mistake is voided and billed again; after payment, money given back is a credit note.</p>
      ${errorBox()}
      <div class="row"><a class="btn pri big" href="#/">Next order</a><button class="btn" type="button" data-act="printDone">Print receipt</button>
        ${can('bills.refund') && bill.status === 'settled' && anyLeft && !cn ? html`<button class="btn danger" type="button" data-act="cnAsk">Give money back</button>` : ''}</div>
      ${cn ? html`<form class="msg warn" style="display:flex;flex-direction:column;gap:10px"><strong>Credit note on ${bill.billNo}</strong>
        <div class="chips"><button type="button" class="chip" aria-pressed="${cn.full}" data-act="cnFull">Whole bill (what is left)</button><button type="button" class="chip" aria-pressed="${!cn.full}" data-act="cnPart">Chosen items</button></div>
        ${cn.full ? '' : bill.items.filter((i) => leftOf(i) > 0).map((i) => html`<div class="line"><span class="grow">${i.name} <span class="small quiet">(${leftOf(i)} left)</span></span>
          <button class="sq" type="button" data-act="cnLess" data-id="${i.id}" aria-label="One less ${i.name}">−</button><span class="qty" style="width:26px;text-align:center;font-weight:800">${cn.qty[i.id] ?? 0}</span>
          <button class="sq" type="button" data-act="cnMore" data-id="${i.id}" data-max="${leftOf(i)}" aria-label="One more ${i.name}">+</button></div>`)}
        <label class="f">Reason (required)<input class="in" data-model="cnReason" value="${ui.cnReason ?? ''}" placeholder="e.g. Cold food, wrong order"></label>
        <div class="f">Money goes back by<div class="chips">${[['cash', 'Cash from the drawer'], ['upi', 'UPI'], ['card', 'Card machine reversal'], ['account', 'Credit to folio or account'], ['none', 'Nothing (not paid in money)']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${cn.mode === k}" data-act="cnMode" data-m="${k}">${t}</button>`)}</div></div>
        ${cn.mode === 'upi' ? html`<div class="chips">${cache.payAccounts.filter((a) => a.active).map((a) => html`<button type="button" class="chip" aria-pressed="${cn.payAccountId === a.id}" data-act="cnPick" data-k="payAccountId" data-id="${a.id}">${a.name}</button>`)}</div>` : ''}
        ${cn.mode === 'account' ? html`<div class="chips">${[...cache.stays.map((x) => ({ id: x.accountId, name: `Room ${x.room} · ${x.guestName}` })), ...cache.credit.map((x) => ({ id: x.id, name: x.name }))].map((a) => html`<button type="button" class="chip" aria-pressed="${cn.debtorAccountId === a.id}" data-act="cnPick" data-k="debtorAccountId" data-id="${a.id}">${a.name}</button>`)}</div>` : ''}
        <div class="row"><button class="btn danger" type="submit" data-act="cnGo" data-submit>Make credit note</button><button class="btn" type="button" data-act="cnNo">Cancel</button></div></form>` : ''}
    </section>
    <section class="panel" style="align-items:center"><p class="label" style="align-self:flex-start">Receipt</p>${receipt(bill)}</section></div>`));
  };
  rerender();
}
actions.cnAsk = () => { ui.cn = { full: true, qty: {}, mode: 'cash' }; rerender(); };
actions.cnNo = () => { ui.cn = null; rerender(); };
actions.cnFull = () => { ui.cn.full = true; rerender(); };
actions.cnPart = () => { ui.cn.full = false; rerender(); };
actions.cnMore = (d) => { ui.cn.qty[d.id] = Math.min(Number(d.max), (ui.cn.qty[d.id] ?? 0) + 1); rerender(); };
actions.cnLess = (d) => { ui.cn.qty[d.id] = Math.max(0, (ui.cn.qty[d.id] ?? 0) - 1); rerender(); };
actions.cnMode = (d) => { ui.cn.mode = d.m; rerender(); };
actions.cnPick = (d) => { ui.cn[d.k] = d.id; rerender(); };
actions.cnGo = async () => {
  const cn = ui.cn;
  const r = await api('POST', `${B()}/bills/${ui.done.id}/credit-note`, {
    full: cn.full, lines: cn.full ? undefined : Object.entries(cn.qty).filter(([, q]) => q > 0).map(([lineId, qty]) => ({ lineId, qty })),
    reason: ui.cnReason ?? '', refundMode: cn.mode, payAccountId: cn.payAccountId, debtorAccountId: cn.debtorAccountId,
  });
  printCreditNote(r.bill, r.creditNote);
  flash = { kind: 'ok', text: r.creditNote.message }; route();
};
function printCreditNote(b, n) {
  printArea.innerHTML = asHtml(html`<div class="receipt"><div class="hd">${b.entityName}</div>${b.gstRegistered ? html`<div class="c">GSTIN ${b.gstin}</div>` : ''}
    <div class="c">CREDIT NOTE</div><div class="rl"><span>${n.cnNo}</span><span>${dateTime(Date.now())}</span></div><div>Against bill ${b.billNo}</div><hr>
    <div class="rl"><span>Value</span><span>${rs(n.taxablePaise)}</span></div>
    ${n.cgstPaise ? html`<div class="rl"><span>CGST</span><span>${rs(n.cgstPaise)}</span></div><div class="rl"><span>SGST</span><span>${rs(n.sgstPaise)}</span></div>` : ''}
    <div class="rl" style="font-weight:700"><span>TOTAL</span><span>${rs(n.totalPaise)}</span></div></div>`);
  window.print();
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
    <hr>${b.items.map((l) => html`<div class="rl"><span>${l.qty} × ${l.name}${l.taxKind === 'exempt' ? ' †' : l.taxKind === 'liquor' || l.taxed === 0 ? ' *' : ''}${b.gstRegistered && l.taxKind === 'gst' && (b.taxes ?? []).filter((r) => r.kind === 'gst').length > 1 ? ` (${l.gstBp / 100}%)` : ''}</span><span>${rs(l.amountPaise)}</span></div>
      ${(l.options ?? []).map((x) => html`<div style="padding-left:14px">+ ${x.name ?? x}</div>`)}`)}<hr>
    <div class="rl"><span>Items</span><span>${rs(b.grossPaise)}</span></div>
    ${b.discountPaise ? html`<div class="rl"><span>Discount</span><span>${rs(-b.discountPaise)}</span></div>` : ''}
    ${taxLines(b.taxes ?? [], 'rl', !!b.gstRegistered)}
    ${b.gstRegistered && b.items[0]?.sac ? html`<div class="small">SAC ${[...new Set(b.items.map((l) => l.sac))].join(', ')}</div>` : ''}
    ${b.roundOffPaise ? html`<div class="rl"><span>Round off</span><span>${rs(b.roundOffPaise)}</span></div>` : ''}
    <div class="rl" style="font-weight:700"><span>TOTAL</span><span>${rs(b.totalPaise)}</span></div>
    ${b.payments?.length ? html`<hr>${b.payments.map((p) => html`<div class="rl"><span>${{ cash: 'Cash', upi: 'UPI', card: 'Card', room: 'To room', credit: 'On credit', comp: 'Complimentary', advance: 'Advance' }[p.mode]}${p.cardLast4 ? ' ****' + p.cardLast4 : ''}</span><span>${rs(p.amountPaise)}</span></div>`)}` : ''}
    ${(b.differences ?? []).map((x) => html`<div class="rl"><span>${x.kind === 'tip' ? `Tip (${x.mode})` : `Discount at payment`}</span><span>${rs(x.kind === 'tip' ? x.amountPaise : x.amountPaise)}</span></div>`)}
    ${b.status === 'void' ? html`<div class="c" style="font-weight:700">VOID</div>` : ''}
  </div>`;
}
function printReceipt(b) { printArea.innerHTML = asHtml(receipt(b)); window.print(); }
/** One KOT slip (counter or station printer). A cancel KOT says CANCEL in large type. */
const kotSlip = (k) => {
  const cancel = k.lines.some((l) => l.cancelled);
  return html`<div class="receipt" style="page-break-after:always"><div class="hd">${cancel ? 'CANCEL · ' : ''}KOT ${k.kotNo} · ${String(k.station).toUpperCase()}</div>
    <div class="rl"><span>${k.place}</span><span>${time(k.at ?? Date.now())}</span></div>${k.by ? html`<div class="rl"><span>${k.by}</span></div>` : ''}<hr>
    ${k.lines.map((l) => html`<div style="font-size:15px;${l.cancelled ? 'font-weight:700' : ''}">${l.cancelled ? `CANCEL ${Math.abs(l.qty)}` : l.qty} × ${l.name}</div>${(l.options ?? []).map((x) => html`<div style="padding-left:18px">+ ${x}</div>`)}`)}</div>`;
};
function printKots(kots) {
  if (!kots.length) return;
  printArea.innerHTML = asHtml(html`${kots.flatMap((k) => Array.from({ length: k.copies ?? 1 }, () => kotSlip(k)))}`);
  window.print();
}
/** Where each KOT went, for the counter: "KOT 12 Kitchen (printed there), 13 Tandoor (on its screen), 14 Bar (printed here)". */
const kotSummary = (kots) => `KOT ${kots.map((k) => `${k.kotNo} ${k.station} (${k.printAt === 'counter' ? 'printed here' : k.printAt === 'station' ? 'printed there' : 'on its screen'})`).join(', ')}.`;

// ---------- rooms and credit accounts

async function roomsScreen() {
  await load('stays', 'credit', 'payAccounts');
  rerender = () => paint(shell('#/rooms', html`${pageHead('Rooms and credit', 'In-house guests and credit accounts: what each owes, payments, advances and refunds.')}
    ${ui.refund ? html`<form class="panel" style="margin-bottom:16px;max-width:720px;border-color:var(--pri-line)"><h2>Refund advance to ${ui.refund.name}</h2>${errorBox()}
      <p class="quiet small">${rs(ui.refund.max)} of advance is held.</p>
      <div class="chips">${[['cash', 'Cash from the drawer'], ['upi', 'UPI']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.refundMode ?? 'cash') === k}" data-act="pick" data-k="refundMode" data-id="${k}">${t}</button>`)}</div>
      <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="refundAmount" value="${ui.refundAmount ?? rupees(ui.refund.max)}" autofocus></label>
        <label class="f">Note (optional)<input class="in" data-model="refundNote"></label></div>
      <div class="row"><button class="btn pri" type="submit" data-act="refundGo" data-submit>Refund</button><button class="btn" type="button" data-act="refundNo">Cancel</button></div></form>` : ''}
    ${ui.recv ? html`<form class="panel" style="margin-bottom:16px;max-width:720px;border-color:var(--pri-line)"><h2>Payment from ${ui.recv.name}</h2>${errorBox()}
      <div class="chips"><button type="button" class="chip" aria-pressed="${ui.recvKind !== 'advance'}" data-act="pick" data-k="recvKind" data-id="receipt">Against what is owed</button>
        <button type="button" class="chip" aria-pressed="${ui.recvKind === 'advance'}" data-act="pick" data-k="recvKind" data-id="advance">Advance</button></div>
      <div class="chips">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.recvMode ?? 'cash') === k}" data-act="pick" data-k="recvMode" data-id="${k}">${t}</button>`)}</div>
      <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="recvAmount" value="${ui.recvAmount ?? ''}" autofocus></label>
        ${ui.recvMode === 'upi' ? html`<div class="f">QR paid into<div class="chips">${cache.payAccounts.filter((a) => a.active).map((a) => html`<button type="button" class="chip" aria-pressed="${ui.payAccountId === a.id}" data-act="pick" data-k="payAccountId" data-id="${a.id}">${a.name}</button>`)}</div></div>` : ''}
        ${ui.recvMode === 'card' ? html`<label class="f">Approval code<input class="in" data-model="cardApproval" maxlength="6"></label><label class="f">Card last 4<input class="in" inputmode="numeric" data-model="cardLast4" maxlength="4"></label>` : ''}</div>
      <div class="row"><button class="btn pri" type="submit" data-act="recvGo" data-submit>Take payment</button><button class="btn" type="button" data-act="recvNo">Cancel</button></div></form>` : ''}
  <div class="grid2" style="align-items:start">
    <section class="panel"><h2>In-house rooms</h2>${ui.recv || ui.refund ? '' : errorBox()}
      <div class="scroll"><table class="t cards"><thead><tr><th>Room</th><th>Guest</th><th>Since</th><th class="num">Owes</th><th></th></tr></thead><tbody>
        ${cache.stays.map((s) => html`<tr><td data-label="Room"><strong>${s.room}</strong></td><td data-label="Guest">${s.guestName}</td><td data-label="Since">${s.checkIn}</td><td class="num" data-label="Owes">${rs(s.balancePaise)}</td>
          <td class="act"><div class="row"><button class="btn" type="button" data-act="recv" data-id="${s.accountId}" data-n="Room ${s.room} · ${s.guestName}">Take payment</button>
          ${s.balancePaise < 0 ? html`<button class="btn" type="button" data-act="refundAsk" data-id="${s.accountId}" data-n="Room ${s.room} · ${s.guestName}" data-max="${-s.balancePaise}">Refund advance</button>` : ''}
          <button class="btn" type="button" data-act="checkOut" data-id="${s.id}">Check out</button></div></td></tr>`)}
      </tbody></table></div>
      ${can('stays.edit') ? html`<form class="grid2"><label class="f">Room<input class="in" data-model="room"></label><label class="f">Guest name<input class="in" data-model="guest"></label>
        <button class="btn pri" type="submit" data-act="openStay" data-submit>Open stay</button></form>` : ''}
    </section>
    <section class="panel"><h2>Credit accounts</h2>
      <div class="scroll"><table class="t cards"><thead><tr><th>Name</th><th class="num">Owes</th><th class="num">Limit</th><th></th></tr></thead><tbody>
        ${cache.credit.map((a) => html`<tr><td data-label="Name"><strong>${a.name}</strong>${a.phone ? html`<div class="small quiet">${a.phone}</div>` : ''}</td><td class="num" data-label="Owes">${rs(a.balancePaise)}</td>
          <td class="num" data-label="Limit">${a.creditLimitPaise ? rs(a.creditLimitPaise) : '—'}</td><td class="act"><div class="row"><button class="btn" type="button" data-act="recv" data-id="${a.id}" data-n="${a.name}">Take payment</button>
          ${a.balancePaise < 0 ? html`<button class="btn" type="button" data-act="refundAsk" data-id="${a.id}" data-n="${a.name}" data-max="${-a.balancePaise}">Refund advance</button>` : ''}</div></td></tr>`)}
      </tbody></table></div><p class="small quiet">New credit accounts are made at the settle screen. A negative amount owed is an advance.</p>
    </section>
  </div>`));
  rerender();
}
actions.openStay = async () => { await api('POST', B() + '/stays', { room: ui.room, guestName: ui.guest }); flash = { kind: 'ok', text: `Stay opened for room ${ui.room}.` }; route(); };
actions.checkOut = async (d) => { await api('POST', `${B()}/stays/${d.id}/check-out`); flash = { kind: 'ok', text: 'Checked out.' }; route(); };
actions.recv = (d) => { ui.recv = { id: d.id, name: d.n }; ui.refund = null; ui.recvMode = 'cash'; ui.recvKind = 'receipt'; ui.error = null; rerender(); };
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
    paint(shell('#/shift', html`${pageHead(`Shift close · ${dayName(s.shiftDay)}`, 'A shift runs 8 am to 8 am. Check the takings, count the drawer, then close.')}
      <div class="kpis">${kpi('Should be in the drawer', rs(expected), 'Float plus cash in, less cash out')}${kpi('Counted', rs(counted))}
        ${kpi(diff === 0 ? 'Drawer agrees' : diff < 0 ? 'Drawer short' : 'Drawer over', rs(Math.abs(diff)), ui.closed ? 'Shift closed' : 'Before closing', diff === 0 ? 'good' : 'bad')}
        ${s.openOrders.length || s.unpaidBills.length ? kpi('Still open', String(s.openOrders.length + s.unpaidBills.length), 'Orders or bills to finish first', 'warn') : ''}</div>
      <div class="two rev">
      <section class="panel"><h2>Takings</h2>
        ${ui.closed ? html`<div class="msg ok">Closed at ${dateTime(ui.closed.closedAt)} · counted ${rs(ui.closed.countedPaise)} · difference ${rs(ui.closed.differencePaise)}</div>` : ''}
        <div class="sums">${s.byMode.map((m) => html`<div><span>${modeName[m.mode]} (${m.n})</span><span>${rs(m.paise)}</span></div>`)}
          ${s.byAccount.map((a) => html`<div><span class="quiet">UPI: ${a.name}</span><span>${rs(a.paise)}</span></div>`)}
          ${s.receipts.map((m) => html`<div><span class="quiet">Received on folios and credit: ${modeName[m.mode]}</span><span>${rs(m.paise)}</span></div>`)}</div>
        <div class="sums">${s.billed.map((b) => html`<div><span>${b.entity}: ${b.first} to ${b.last}${b.voids ? ` (${b.voids} void)` : ''}</span><span>${rs(b.paise)}</span></div>`)}</div>
        <div class="sums">${s.events.map((e) => html`<div><span>${{ void: 'Voids', reprint: 'Reprints', kot_cancel: 'Cancelled KOT lines', discount: 'Discounts', comp: 'Complimentary', limit_warning: 'Limit warnings', credit_note: 'Credit notes', stock_waste: 'Stock breakage', stock_count: 'Stock count variances' }[e.kind]}</span><span>${e.n} · ${rs(e.paise)}</span></div>`)}</div>
        ${s.tabs.length ? html`<div class="sums"><div><strong>Tabs carried to the next shift (not in these totals)</strong></div>${s.tabs.map((t) => html`<div><span>${t.place} · ${t.guest} · since ${t.since}${t.old ? ' · overdue' : ''}</span><span>${rs(t.paise)}</span></div>`)}</div>` : ''}
        ${s.tips.length || s.discountsAtPayment.n ? html`<div class="sums">${s.tips.map((t) => html`<div><span>Tips on ${t.mode} (${t.n}) · for staff, not sales</span><span>${rs(t.paise)}</span></div>`)}
          ${s.discountsAtPayment.n ? html`<div><span>Discounts at payment (${s.discountsAtPayment.n})</span><span>${rs(s.discountsAtPayment.paise)}</span></div>` : ''}</div>` : ''}
        ${s.creditNotes.length ? html`<div class="sums"><div><strong>Credit notes (money given back)</strong></div>${s.creditNotes.map((n) => html`<div><span>${n.cnNo} on ${n.billNo} · ${n.reason} · ${n.refundMode}</span><span>${rs(-n.totalPaise)}</span></div>`)}</div>` : ''}
        ${s.drawerOuts.length ? html`<div class="sums"><div><strong>Paid out of the drawer</strong></div>${s.drawerOuts.map((o) => html`<div><span>${o.kind === 'refund' ? 'Advance refunded' : 'Paid out'}${o.mode === 'upi' ? ' (UPI)' : ''}${o.note && o.note !== 'Advance refunded' ? ' · ' + o.note : ''} · ${o.byName ?? ''}</span><span>${rs(-o.amountPaise)}</span></div>`)}</div>` : ''}
        ${ui.closed ? '' : html`<form class="grid2" style="align-items:end"><label class="f">Cash paid out (₹)<input class="in" inputmode="decimal" data-model="outAmount" value="${ui.outAmount ?? ''}"></label>
          <label class="f">What for<input class="in" data-model="outNote" value="${ui.outNote ?? ''}" placeholder="e.g. Vegetables"></label>
          <button class="btn" type="submit" data-act="paidOut" data-submit>Record paid out</button></form>`}
        ${s.openOrders.length ? html`<div class="msg bad">Bill these orders or keep them as a tab first: ${s.openOrders.map((o) => o.place).join(', ')}.</div>` : ''}
        ${s.unpaidBills.length ? html`<div class="msg bad">Printed but not paid: ${s.unpaidBills.map((b) => b.bill_no).join(', ')}.</div>` : ''}
      </section>
      ${ui.closed ? '' : html`<form class="panel"><h2>Count the cash drawer</h2>${errorBox()}
        <label class="f">Opening float (₹)<input class="in" inputmode="decimal" data-model="float" data-live value="${ui.float ?? ''}"></label>
        <div class="notes">${notes.map((n) => html`<label class="f">₹${n} notes<input class="in" inputmode="numeric" data-model="c${n}" data-note="${n}" value="${ui.counts[n] ?? ''}"></label>`)}
          <label class="f">Coins and loose (₹)<input class="in" inputmode="decimal" data-model="loose" data-live value="${ui.loose ?? ''}"></label></div>
        <div class="sums"><div><span>Should be in the drawer</span><span>${rs(expected)}</span></div><div><span>Counted</span><span>${rs(counted)}</span></div>
          <div class="big" style="color:${diff ? 'var(--bad)' : 'var(--go-dark)'}"><span>${diff === 0 ? 'Agrees' : diff < 0 ? 'Short' : 'Over'}</span><span>${rs(Math.abs(diff))}</span></div></div>
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

// Meal periods by the hour the bill was printed (India time).
const PERIODS = [['Breakfast', 6, 11], ['Lunch', 11, 16], ['Evening', 16, 19], ['Dinner', 19, 23], ['Late night', 23, 30]];
const periodOf = (h) => PERIODS.find(([, a, b]) => (h < 6 ? h + 24 : h) >= a && (h < 6 ? h + 24 : h) < b)[0];
const pct = (part, whole) => (whole ? `${Math.round((part * 1000) / whole) / 10}%` : '');
const bar = (part, max) => html`<div class="bar" style="width:${max ? Math.max(2, Math.round((part * 100) / max)) : 0}%"></div>`;
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;

async function insightsTab(tab, head, from, to) {
  const r = await api('GET', `${B()}/reports/insights?from=${from}&to=${to}`);
  const title = from === to ? from : `${from} to ${to}`;
  const net = r.byService.reduce((t, x) => t + x.netPaise, 0);
  const bills = r.byService.reduce((t, x) => t + x.bills, 0);
  const none = html`<p class="quiet">No bills in these shifts.</p>`;
  if (tab === 'when') {
    // KOT lines by hour and station → one row per hour: kitchen items, bar items, value sent, guests.
    const hours = [...new Set(r.byHour.map((h) => h.hour))].map((hour) => {
      const k = r.byHour.find((h) => h.hour === hour && h.station === 'kitchen');
      const b = r.byHour.find((h) => h.hour === hour && h.station === 'bar');
      return { hour, kitchen: k?.items ?? 0, bar: b?.items ?? 0, valuePaise: (k?.valuePaise ?? 0) + (b?.valuePaise ?? 0),
        covers: r.coversByHour.find((c) => c.hour === hour)?.covers ?? 0 };
    }).sort((a, b) => ((a.hour + 24 - 6) % 24) - ((b.hour + 24 - 6) % 24));
    const sentTotal = hours.reduce((t, h) => t + h.valuePaise, 0);
    const periods = PERIODS.map(([name]) => {
      const hs = hours.filter((h) => periodOf(h.hour) === name);
      const add = (k) => hs.reduce((t, h) => t + h[k], 0);
      return { name, kitchen: add('kitchen'), bar: add('bar'), valuePaise: add('valuePaise'), covers: add('covers') };
    }).filter((p) => p.kitchen || p.bar);
    const maxHour = Math.max(0, ...hours.map((h) => h.valuePaise));
    const kindName = { table: 'Dine-in', room: 'Room service', takeaway: 'Takeaway' };
    rerender = () => paint(shell('#/reports', html`${head}
      <section class="panel"><h2>When and where · ${title}</h2>
        <p class="quiet small">Net sales = after bill discounts, before GST. Void bills left out. Meal periods and hours go by when each KOT printed.</p>
        ${bills ? html`<div class="sums"><div class="big"><span>Net sales · ${bills} bills · average ${rs(Math.round(net / bills))}</span><span>${rs(net)}</span></div></div>` : none}</section>
      ${bills ? html`<div style="margin-top:16px">
        <section class="panel"><h2>By service</h2>
          <div class="scroll"><table class="t"><thead><tr><th>Service</th><th class="num">Bills</th><th class="num">Net sales</th><th class="num">Share</th><th class="num">Average bill</th><th class="num">Guests</th><th class="num">Per guest</th><th class="num">Turns</th></tr></thead><tbody>
            ${r.byService.map((x) => html`<tr><td>${kindName[x.kind] ?? x.kind}</td><td class="num">${x.bills}</td><td class="num">${rs(x.netPaise)}</td><td class="num">${pct(x.netPaise, net)}</td>
              <td class="num">${rs(Math.round(x.netPaise / x.bills))}</td><td class="num">${x.covers || ''}</td><td class="num">${x.covers ? rs(Math.round(x.coveredNetPaise / x.covers)) : ''}</td>
              <td class="num">${x.kind === 'table' && x.placeDays ? (Math.round((x.bills * 10) / x.placeDays) / 10).toFixed(1) : ''}</td></tr>`)}</tbody></table></div>
          <p class="small quiet">Per guest counts only orders where the number of guests was entered. Turns = bills per table per shift, for tables that were used.</p>
        </section></div>
      <div class="grid2" style="margin-top:16px;align-items:start">
        <section class="panel"><h2>By meal period (KOT time)</h2>
          <div class="scroll"><table class="t"><thead><tr><th>Period</th><th class="num">Kitchen items</th><th class="num">Bar items</th><th class="num">Value sent</th><th class="num">Share</th><th class="num">Guests</th></tr></thead><tbody>
            ${periods.map((p) => html`<tr><td>${p.name}</td><td class="num">${p.kitchen || ''}</td><td class="num">${p.bar || ''}</td><td class="num">${rs(p.valuePaise)}</td><td class="num">${pct(p.valuePaise, sentTotal)}</td><td class="num">${p.covers || ''}</td></tr>`)}</tbody></table></div>
          <p class="small quiet">Breakfast 6–11, lunch 11–4, evening 4–7, dinner 7–11, late night 11 pm–6 am.</p>
          <h2>By hour (KOT time)</h2>
          <div class="hours">${hours.map((h) => html`<div class="hrow"><span class="small">${hourLabel(h.hour)}</span>${bar(h.valuePaise, maxHour)}<span class="num small">${rs(h.valuePaise)} · K ${h.kitchen} · B ${h.bar}</span></div>`)}</div>
          <p class="small quiet">Every dish sent to the kitchen or bar, by the hour its KOT printed, at menu price before discounts and GST. K = kitchen items, B = bar items. Guests count at their order's first KOT.</p></section>
        <section class="panel"><h2>By who took the order</h2>
          <div class="scroll"><table class="t"><thead><tr><th>Staff</th><th class="num">Bills</th><th class="num">Net sales</th><th class="num">Average bill</th><th class="num">Discounts</th><th class="num">Voids</th></tr></thead><tbody>
            ${r.byStaff.map((x) => html`<tr><td>${x.name}<div class="small quiet">${x.role ?? ''}</div></td><td class="num">${x.bills}</td><td class="num">${rs(x.netPaise)}</td>
              <td class="num">${x.bills ? rs(Math.round(x.netPaise / x.bills)) : ''}</td><td class="num">${x.discountBills ? `${x.discountBills} · ${rs(x.discountPaise)}` : ''}</td><td class="num">${x.voids || ''}</td></tr>`)}</tbody></table></div></section>
      </div>` : ''}`));
    rerender();
    return;
  }
  const itemsTotal = r.mix.reduce((t, m) => t + m.amountPaise, 0);
  const st = (k) => r.mix.filter((m) => m.station === k).reduce((t, m) => t + m.amountPaise, 0);
  const cats = Object.values(r.mix.reduce((acc, m) => {
    const c = acc[m.category] ?? (acc[m.category] = { category: m.category, qty: 0, amountPaise: 0, stations: new Set() });
    c.qty += m.qty; c.amountPaise += m.amountPaise; c.stations.add(m.station); return acc;
  }, {})).sort((a, b) => b.amountPaise - a.amountPaise);
  const maxCat = Math.max(0, ...cats.map((c) => c.amountPaise));
  rerender = () => paint(shell('#/reports', html`${head}
    <section class="panel"><h2>Menu mix · ${title}</h2>
      <p class="quiet small">Item values are before bill discounts and GST. Void bills left out. Cuisine comes from each dish's category in Settings, Menu.</p>
      ${itemsTotal ? html`<div class="sums"><div><span>Kitchen</span><span>${rs(st('kitchen'))} · ${pct(st('kitchen'), itemsTotal)}</span></div>
        <div><span>Bar</span><span>${rs(st('bar'))} · ${pct(st('bar'), itemsTotal)}</span></div>
        <div class="big"><span>All items</span><span>${rs(itemsTotal)}</span></div></div>` : none}</section>
    ${itemsTotal ? html`<div class="grid2" style="margin-top:16px;align-items:start">
      <section class="panel"><h2>By cuisine or category</h2>
        <div class="hours">${cats.map((c) => html`<div class="hrow"><span class="small">${c.category}</span>${bar(c.amountPaise, maxCat)}<span class="num small">${rs(c.amountPaise)} · ${pct(c.amountPaise, itemsTotal)}</span></div>`)}</div>
      </section>
    </div>
    <div class="grid2" style="margin-top:16px;align-items:start">${[['kitchen', 'Kitchen'], ['bar', 'Bar']].map(([k, name]) => {
      const list = r.items.filter((i) => i.station === k);
      const unsold = r.notSold.filter((n) => n.station === k);
      return html`<section class="panel"><h2>${name} dishes, best first</h2>
        ${list.length ? html`<div class="scroll"><table class="t"><thead><tr><th>#</th><th>Dish</th><th>Category</th><th class="num">Qty</th><th class="num">Value</th><th class="num">Share of ${name.toLowerCase()}</th></tr></thead><tbody>
          ${list.map((i, n) => html`<tr><td class="quiet">${n + 1}</td><td>${i.name}</td><td>${i.category}</td><td class="num">${i.qty}</td><td class="num">${rs(i.amountPaise)}</td><td class="num">${pct(i.amountPaise, st(k))}</td></tr>`)}</tbody></table></div>`
          : html`<p class="quiet small">Nothing from the ${name.toLowerCase()} was billed.</p>`}
        <h2>${name}: on the menu, not sold</h2>
        <p class="small quiet">Dishes on the menu that were on no bill in these dates. Worth a look if they stay here week after week.</p>
        ${unsold.length ? html`<div class="sums">${unsold.map((n) => html`<div><span>${n.name}</span><span class="quiet">${n.category}</span></div>`)}</div>` : html`<p class="quiet small">Every ${name.toLowerCase()} dish sold at least once.</p>`}</section>`;
    })}
    </div>` : ''}`));
  rerender();
}

async function gstTab(head, month) {
  const r = await api('GET', `${B()}/reports/gstr1?month=${month}`);
  ui.gst = r;
  const money = (p) => rupees(p);
  rerender = () => paint(shell('#/reports', html`${head}
    <section class="panel"><div class="row" style="justify-content:space-between"><h2>GSTR-1 working · ${month}</h2>${r.entities.length ? html`<button class="btn" type="button" data-act="gstCsv">Download for CA (CSV)</button>` : ''}</div>
      <p class="quiet small">By bill date (when printed, India time), not shift. All sales are shown as B2C small (unregistered buyers): the POS does not take a guest's GSTIN yet. Credit notes are netted off in B2C. Check with your CA before filing.</p>
      ${r.entities.length ? '' : html`<p class="quiet">No bills in this month.</p>`}</section>
    ${r.entities.map((e) => html`<section class="panel" style="margin-top:16px"><h2>${e.name}</h2>
      ${e.registered ? html`<p class="small">GSTIN ${e.gstin}</p>
        <h3>B2C small (Table 7)</h3>
        <div class="scroll"><table class="t"><thead><tr><th>Rate</th><th class="num">Taxable value (₹)</th><th class="num">CGST (₹)</th><th class="num">SGST (₹)</th></tr></thead><tbody>
          ${e.b2cs.map((x) => html`<tr><td>${x.ratePct}%</td><td class="num">${money(x.taxablePaise)}</td><td class="num">${money(x.cgstPaise)}</td><td class="num">${money(x.sgstPaise)}</td></tr>`)}</tbody></table></div>
        <h3>SAC summary (Table 12)</h3>
        <div class="scroll"><table class="t"><thead><tr><th>SAC</th><th>Rate</th><th class="num">Quantity</th><th class="num">Taxable value (₹)</th><th class="num">CGST (₹)</th><th class="num">SGST (₹)</th></tr></thead><tbody>
          ${e.sac.map((x) => html`<tr><td>${x.sac}</td><td>${x.ratePct}%</td><td class="num">${x.qty}</td><td class="num">${money(x.taxablePaise)}</td><td class="num">${money(x.cgstPaise)}</td><td class="num">${money(x.sgstPaise)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="small quiet">Not registered for GST: no GSTR-1. Turnover this month ${rs(e.totalPaise)}; watch the ₹20 lakh registration limit on the Billing names screen.</p>`}
      ${e.registered && (e.nonGstPaise || e.exemptPaise) ? html`<h3>Nil-rated, exempt and non-GST supplies (Table 8)</h3>
        <div class="sums">${e.nonGstPaise ? html`<div><span>Non-GST: liquor (net of credit notes)</span><span>${money(e.nonGstPaise)}</span></div>` : ''}
          ${e.exemptPaise ? html`<div><span>Exempt: items set to no GST (net of credit notes)</span><span>${money(e.exemptPaise)}</span></div>` : ''}</div>` : ''}
      <h3>Documents issued (Table 13)</h3>
      <div class="scroll"><table class="t"><thead><tr><th>Document</th><th>From</th><th>To</th><th class="num">Total</th><th class="num">Cancelled</th><th class="num">Net issued</th></tr></thead><tbody>
        ${[['Invoices', e.invoices], ['Credit notes', e.creditNotes]].filter(([, x]) => x).map(([name, x]) => html`<tr><td>${name}</td><td>${x.from}</td><td>${x.to}</td><td class="num">${x.total}</td><td class="num">${x.cancelled}</td><td class="num">${x.total - x.cancelled}</td></tr>`)}</tbody></table></div>
    </section>`)}`));
  rerender();
}
actions.gstGo = () => go(`#/reports/gst/${ui.gstMonth}`);
/** The month's GSTR-1 working as one CSV file for the CA (made in the browser from what is on screen). */
actions.gstCsv = () => {
  const r = ui.gst;
  const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [['Month', 'Billing name', 'GSTIN', 'Section', 'Rate or SAC or document', 'Quantity or from', 'Taxable value or to', 'CGST or total', 'SGST or cancelled']];
  for (const e of r.entities) {
    if (e.registered) {
      for (const x of e.b2cs) rows.push([r.month, e.name, e.gstin, 'B2C small', `${x.ratePct}%`, '', rupees(x.taxablePaise), rupees(x.cgstPaise), rupees(x.sgstPaise)]);
      for (const x of e.sac) rows.push([r.month, e.name, e.gstin, `SAC summary at ${x.ratePct}%`, x.sac, x.qty, rupees(x.taxablePaise), rupees(x.cgstPaise), rupees(x.sgstPaise)]);
      if (e.nonGstPaise) rows.push([r.month, e.name, e.gstin, 'Non-GST supplies (liquor)', '', '', rupees(e.nonGstPaise), '', '']);
      if (e.exemptPaise) rows.push([r.month, e.name, e.gstin, 'Exempt supplies', '', '', rupees(e.exemptPaise), '', '']);
    }
    if (e.invoices) rows.push([r.month, e.name, e.gstin ?? '', 'Documents: invoices', 'Invoices', e.invoices.from, e.invoices.to, e.invoices.total, e.invoices.cancelled]);
    if (e.creditNotes) rows.push([r.month, e.name, e.gstin ?? '', 'Documents: credit notes', 'Credit notes', e.creditNotes.from, e.creditNotes.to, e.creditNotes.total, e.creditNotes.cancelled]);
  }
  const blob = new Blob([rows.map((row) => row.map(cell).join(',')).join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `gstr1-working-${r.month}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

async function reportsScreen(tab = 'sales', range = '') {
  const [qf, qt] = range.split('_');
  const isD = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
  const from = isD(qf) ? qf : me.business.shiftDay;
  const to = isD(qt) ? qt : from;
  ui.from = from; ui.to = to; ui.repTab = tab;
  ui.gstMonth = /^\d{4}-\d{2}$/.test(qf ?? '') ? qf : me.business.shiftDay.slice(0, 7);
  const modeName = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Posted to rooms', credit: 'On credit', comp: 'Complimentary', advance: 'Advances used' };
  const today = me.business.shiftDay;
  const ranges = [['This shift', today, today], ['Last shift', addDays(today, -1), addDays(today, -1)], ['Last 7 shifts', addDays(today, -6), today], ['This month', today.slice(0, 8) + '01', today]];
  const head = html`${pageHead('Reports', tab === 'owed' ? 'Rooms and credit accounts: what is owed right now.' : tab === 'gst' ? `GSTR-1 working for ${ui.gstMonth}` : `Shift ${from === to ? dayName(from) : `${dayName(from)} to ${dayName(to)}`} · a shift runs 8 am to 8 am`)}
    ${tabsNav('Reports', [['sales', 'Sales'], ['when', 'When and where'], ['mix', 'Menu mix'], ['gst', 'GSTR-1'], ['owed', 'Who owes']].map(([k, t]) => [`#/reports/${k}/${from}_${to}`, t, k]), tab)}
    ${tab === 'gst' ? html`<form class="row" style="align-items:end;margin-bottom:16px"><label class="f">Month<input class="in" type="month" data-model="gstMonth" value="${ui.gstMonth}"></label>
      <button class="btn" type="submit" data-act="gstGo" data-submit>Show</button></form>`
    : tab !== 'owed' ? html`<div class="row" style="align-items:end;margin-bottom:16px;justify-content:space-between">
      <div class="ranges" role="group" aria-label="Quick dates">${ranges.map(([t, a, b]) => html`<a class="chip" href="#/reports/${tab}/${a}_${b}" aria-pressed="${from === a && to === b}">${t}</a>`)}</div>
      <form class="row" style="align-items:end"><label class="f">From<input class="in" type="date" data-model="from" value="${from}"></label><label class="f">To<input class="in" type="date" data-model="to" value="${to}"></label>
      <button class="btn" type="submit" data-act="repGo" data-submit>Show</button></form></div>` : ''}`;
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
  if (tab === 'when' || tab === 'mix') { await insightsTab(tab, head, from, to); return; }
  if (tab === 'gst') { await gstTab(head, ui.gstMonth); return; }
  const r = await api('GET', `${B()}/reports/sales?from=${from}&to=${to}`);
  const sum = (k) => r.byEntity.reduce((t, e) => t + e[k], 0);
  const cnTotal = r.creditNotes.reduce((t, n) => t + n.totalPaise, 0);
  const salesBills = sum('bills');
  rerender = () => paint(shell('#/reports', html`${head}
    <div class="kpis">${kpi('Sales with GST', rs(sum('totalPaise') - cnTotal), cnTotal ? `After ${rs(cnTotal)} of credit notes` : 'What guests paid for')}
      ${kpi('Net sales', rs(sum('taxablePaise') + sum('nonGstPaise')), 'After discounts, before GST; liquor included')}
      ${kpi('Bills', String(salesBills), salesBills ? `Average ${rs(Math.round((sum('taxablePaise') + sum('nonGstPaise')) / salesBills))} before GST` : '')}
      ${kpi('Discounts', rs(sum('discountPaise')), sum('grossPaise') ? `${pct(sum('discountPaise'), sum('grossPaise'))} of items` : '', sum('discountPaise') ? 'warn' : '')}
      ${r.voids.length ? kpi('Void bills', String(r.voids.length), rs(r.voids.reduce((t, v) => t + v.totalPaise, 0)), 'bad') : ''}</div>
    <section class="panel"><h2>Sales by name on the bill</h2>
      <div class="scroll"><table class="t"><thead><tr><th>Name on bill</th><th>Bills</th><th class="num">Items</th><th class="num">Discount</th><th class="num">Taxable</th><th class="num">Liquor, no GST</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Total</th></tr></thead><tbody>
        ${r.byEntity.map((e) => html`<tr><td>${e.name}<div class="small quiet">${e.gstRegistered ? 'GSTIN ' + e.gstin : 'Not registered for GST'}</div></td><td>${e.bills}<div class="small quiet">${e.firstBill} to ${e.lastBill}</div></td>
          <td class="num">${rs(e.grossPaise)}</td><td class="num">${rs(e.discountPaise)}</td><td class="num">${rs(e.taxablePaise)}</td><td class="num">${rs(e.nonGstPaise)}</td><td class="num">${rs(e.cgstPaise)}</td><td class="num">${rs(e.sgstPaise)}</td><td class="num"><strong>${rs(e.totalPaise)}</strong></td></tr>`)}
        <tr><td><strong>Total</strong></td><td>${sum('bills')}</td><td class="num">${rs(sum('grossPaise'))}</td><td class="num">${rs(sum('discountPaise'))}</td><td class="num">${rs(sum('taxablePaise'))}</td><td class="num">${rs(sum('nonGstPaise'))}</td>
          <td class="num">${rs(sum('cgstPaise'))}</td><td class="num">${rs(sum('sgstPaise'))}</td><td class="num"><strong>${rs(sum('totalPaise'))}</strong></td></tr>
        ${r.creditNotes.map((n) => html`<tr><td>Less credit notes · ${n.name}<div class="small quiet">${n.first} to ${n.last}</div></td><td>${n.n}</td><td></td><td></td>
          <td class="num">${rs(-n.taxablePaise)}</td><td class="num">${rs(-n.nonGstPaise)}</td><td class="num">${rs(-n.cgstPaise)}</td><td class="num">${rs(-n.sgstPaise)}</td><td class="num">${rs(-n.totalPaise)}</td></tr>`)}
        ${r.creditNotes.length ? html`<tr><td><strong>Net</strong></td><td></td><td></td><td></td><td class="num">${rs(sum('taxablePaise') - r.creditNotes.reduce((t, n) => t + n.taxablePaise, 0))}</td><td class="num">${rs(sum('nonGstPaise') - r.creditNotes.reduce((t, n) => t + n.nonGstPaise, 0))}</td>
          <td class="num">${rs(sum('cgstPaise') - r.creditNotes.reduce((t, n) => t + n.cgstPaise, 0))}</td><td class="num">${rs(sum('sgstPaise') - r.creditNotes.reduce((t, n) => t + n.sgstPaise, 0))}</td>
          <td class="num"><strong>${rs(sum('totalPaise') - r.creditNotes.reduce((t, n) => t + n.totalPaise, 0))}</strong></td></tr>` : ''}</tbody></table></div></section>
    <div class="grid2" style="margin-top:16px;align-items:start">
      <section class="panel"><h2>By payment</h2><div class="sums">${r.byMode.map((m) => html`<div><span>${modeName[m.mode]} (${m.n})</span><span>${rs(m.paise)}</span></div>`)}</div>
        ${r.discounts.length ? html`<h2>Discounts</h2><div class="sums">${r.discounts.map((d) => html`<div><span>${d.reason} (${d.n})</span><span>${rs(d.paise)}</span></div>`)}</div>` : ''}
        ${r.comps.length ? html`<h2>Complimentary</h2><div class="sums">${r.comps.map((c) => html`<div><span>${c.day} · ${c.guest} · ${c.reason} · by ${c.byName ?? ''}</span><span>${rs(c.paise)}</span></div>`)}</div>` : ''}
        ${r.paymentDiscounts.length ? html`<h2>Discounts at payment</h2><div class="sums">${r.paymentDiscounts.map((d) => html`<div><span>${d.reason} (${d.n})</span><span>${rs(d.paise)}</span></div>`)}</div>` : ''}
        ${r.tips.length ? html`<h2>Tips (for staff, not sales)</h2><div class="sums">${r.tips.map((t) => html`<div><span>${modeName[t.mode] ?? t.mode} (${t.n})</span><span>${rs(t.paise)}</span></div>`)}</div><p class="small quiet">By payment above includes these tips.</p>` : ''}
        ${r.creditNoteList.length ? html`<h2>Credit notes</h2><div class="sums">${r.creditNoteList.map((n) => html`<div><span>${n.cnNo} on ${n.billNo} · ${n.reason} · ${n.refundMode}</span><span>${rs(n.totalPaise)}</span></div>`)}</div>` : ''}
        ${r.voids.length ? html`<h2>Void bills</h2><div class="sums">${r.voids.map((v) => html`<div><span>${v.billNo} · ${v.reason}</span><span>${rs(v.totalPaise)}</span></div>`)}</div>` : ''}
        ${r.days.length > 1 ? html`<h2>By shift</h2><div class="sums">${r.days.map((d) => html`<div><span>${d.day} (${d.bills} bills)</span><span>${rs(d.totalPaise)}</span></div>`)}</div>` : ''}</section>
      <section class="panel"><h2>Items sold</h2><div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
        ${r.items.map((i) => html`<tr><td>${i.name}</td><td class="num">${i.qty}</td><td class="num">${rs(i.amountPaise)}</td></tr>`)}</tbody></table></div></section>
    </div>`));
  rerender();
}
actions.repGo = () => go(`#/reports/${ui.repTab ?? 'sales'}/${ui.from}_${ui.to}`);
actions.statement = async (d) => { ui.statement = await api('GET', `${B()}/debtors/${d.id}`); rerender(); };
actions.printStatement = () => {
  const st = ui.statement; let bal = 0;
  printArea.innerHTML = asHtml(html`<div class="receipt"><div class="hd">${me.business.name}</div><div class="c">STATEMENT</div><div>${st.account.name}</div><hr>
    ${st.entries.map((e) => { bal += e.amountPaise; return html`<div class="rl"><span>${dateTime(e.at)} ${e.billNo ?? e.kind}</span><span>${rs(e.amountPaise)}</span></div>`; })}
    <hr><div class="rl" style="font-weight:700"><span>Balance</span><span>${rs(bal)}</span></div></div>`);
  window.print();
};

// ---------- stock (Owner and manager)

async function stockScreen(tab = 'hand') {
  const st = await api('GET', `${B()}/stock`);
  await load('menu');
  ui.st = st;
  const tabs = [['hand', 'On hand'], ['receive', 'Receive'], ['transfer', 'Transfer'], ['waste', 'Breakage'], ['count', 'Count'], ['handover', 'Bar handover'], ['report', 'Report'], ['items', 'Items and recipes']];
  const low = st.items.filter((i) => i.active && i.low).length;
  const head = html`${pageHead('Stock', `Bar and kitchen stores${low ? ` · ${plural(low, 'item')} below reorder level` : ''}`)}${tabsNav('Stock', tabs.map(([k, t]) => [`#/stock/${k}`, t, k]), tab)}`;
  const items = st.items.filter((i) => i.active);
  const storeSel = (model, label) => html`<label class="f">${label}<select class="in" data-model="${model}"><option value="">Choose</option>${st.stores.map((x) => html`<option value="${x.id}" ${ui[model] === x.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>`;
  const itemSel = (model) => html`<label class="f">Item<select class="in" data-model="${model}"><option value="">Choose</option>${items.map((i) => html`<option value="${i.id}" ${ui[model] === i.id ? 'selected' : ''}>${i.name} (${i.unit})</option>`)}</select></label>`;
  const qtyText = (q, i) => i.unit === 'ml' || i.unit === 'g' ? `${q} ${i.unit}${i.packSize > 1 && Math.abs(q) >= i.packSize ? ` (${(q / i.packSize).toFixed(1)} ${i.packName})` : ''}` : `${q} ${i.unit}`;
  if (tab === 'report') { ui.rFrom ??= me.business.shiftDay; ui.rTo ??= me.business.shiftDay; ui.rStore ??= st.stores.find((x) => x.kind === 'bar')?.id ?? st.stores[0]?.id; }
  if (tab === 'handover') { ui.hFrom ??= me.business.shiftDay; ui.hTo ??= me.business.shiftDay; ui.hStore ??= st.stores.find((x) => x.kind === 'bar')?.id ?? st.stores[0]?.id; }
  if (tab === 'handover' && ui.hStore) ui.handovers = await api('GET', `${B()}/stock/handovers?from=${ui.hFrom}&to=${ui.hTo}&storeId=${ui.hStore}`);
  if (tab === 'report' && ui.rStore) ui.report = await api('GET', `${B()}/stock/report?from=${ui.rFrom}&to=${ui.rTo}&storeId=${ui.rStore}`);
  rerender = () => {
    let body = '';
    if (!st.stores.length && tab !== 'items') body = html`<section class="panel"><p>No stores yet. Add them on <a href="#/stock/items">Items and recipes</a>.</p></section>`;
    else if (tab === 'hand') body = html`<section class="panel"><h2>Stock on hand</h2>${errorBox()}<div class="scroll"><table class="t"><thead><tr><th>Item</th>${st.stores.map((x) => html`<th class="num">${x.name}</th>`)}<th class="num">Total</th><th class="num">Value</th></tr></thead><tbody>
      ${items.map((i) => html`<tr><td>${i.name}${i.low ? html`<div class="small" style="color:var(--bad)">Below reorder level (${qtyText(i.reorderLevel, i)})</div>` : ''}</td>
        ${st.stores.map((x) => html`<td class="num" style="${i.byStore[x.id] < 0 ? 'color:var(--bad)' : ''}">${qtyText(i.byStore[x.id], i)}</td>`)}<td class="num"><strong>${qtyText(i.total, i)}</strong></td><td class="num">${rs(i.valuePaise)}</td></tr>`)}
      <tr><td><strong>Total value</strong></td>${st.stores.map(() => html`<td></td>`)}<td></td><td class="num"><strong>${rs(items.reduce((t, i) => t + i.valuePaise, 0))}</strong></td></tr></tbody></table></div>
      <p class="small quiet">Value is at the last price paid. Bar sales take stock from the bar store when a bill is settled, by each menu item's recipe.</p></section>`;
    else if (tab === 'receive') {
      ui.rcLines ??= [{ k: 1, desc: '' }];
      const lineTotal = ui.rcLines.reduce((t, l) => t + (int(ui[`rcl${l.k}packs`]) || 0) * (toPaise(ui[`rcl${l.k}cost`] ?? '') ?? 0), 0);
      const billTotal = ui.rcTotal != null ? Math.round(ui.rcTotal * 100) : null;
      body = html`<section class="panel"><h2>Supplier bill</h2>
        <p class="small quiet">Take a photo of the bill, or choose one. Claude reads it into the lines below; you check every line before anything is received. You can also type the bill in without a photo.</p>
        <div class="row"><label class="btn pri" style="${ui.rcReading ? 'pointer-events:none;opacity:.6' : ''}">${ui.rcReading ? 'Reading the bill…' : ui.rcBillId ? 'Take another photo' : 'Take or choose photo'}<input type="file" accept="image/*" data-bill-photo class="vh"></label>
          ${ui.rcBillId ? html`<a class="btn" href="/api${B()}/stock/bills/${ui.rcBillId}/photo" target="_blank" rel="noopener">See the photo</a>` : ''}</div>
        ${ui.rcReading ? html`<p class="small quiet">This can take up to a minute.</p>` : ''}
        ${ui.rcError ? html`<div class="msg warn">${ui.rcError}</div>` : ''}
        ${ui.rcRead ? html`<div class="msg ok">Read ${ui.rcLines.length} line${ui.rcLines.length === 1 ? '' : 's'}${ui.rcUnmatched ? `; ${ui.rcUnmatched} need${ui.rcUnmatched === 1 ? 's' : ''} a stock item chosen` : ''}. Check quantities and prices against the photo.</div>` : ''}</section>
      <form class="panel" style="margin-top:16px"><h2>Check and receive</h2>${errorBox()}
        <div class="grid3">${storeSel('rcStore', 'Into store')}<label class="f">Vendor<input class="in" data-model="rcVendor" value="${ui.rcVendor ?? ''}"></label>
          <label class="f">Invoice number<input class="in" data-model="rcInv" value="${ui.rcInv ?? ''}"></label></div>
        <div class="scroll"><table class="t"><thead><tr><th>Stock item</th><th class="num">Packs</th><th class="num">Price paid per pack, tax included (₹)</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${ui.rcLines.map((l) => {
            const it = items.find((i) => i.id === ui[`rcl${l.k}item`]);
            const amt = (int(ui[`rcl${l.k}packs`]) || 0) * (toPaise(ui[`rcl${l.k}cost`] ?? '') ?? 0);
            return html`<tr><td><select class="in" data-model="rcl${l.k}item" aria-label="Stock item" style="${it ? '' : 'border-color:var(--warn-line)'}"><option value="">Choose</option>${items.map((i) => html`<option value="${i.id}" ${it?.id === i.id ? 'selected' : ''}>${i.name} (${i.packName} of ${i.packSize} ${i.unit})</option>`)}</select>
                ${l.desc ? html`<div class="small quiet">On the bill: ${l.desc}</div>` : ''}</td>
              <td class="num"><input class="in" style="max-width:90px;min-width:60px" inputmode="numeric" data-live data-model="rcl${l.k}packs" value="${ui[`rcl${l.k}packs`] ?? ''}" aria-label="Packs">${it ? html`<div class="small quiet">${it.packName}s</div>` : ''}</td>
              <td class="num"><input class="in" style="max-width:120px" inputmode="decimal" data-live data-model="rcl${l.k}cost" value="${ui[`rcl${l.k}cost`] ?? ''}" aria-label="Price per pack"></td>
              <td class="num">${amt ? rs(amt) : ''}</td>
              <td><button class="ibtn danger" type="button" data-act="rcDrop" data-k="${l.k}" title="Remove this line" aria-label="Remove this line">${ICON.trash}</button></td></tr>`;
          })}</tbody></table></div>
        <div class="row" style="justify-content:space-between"><button class="btn" type="button" data-act="rcAdd">Add a line</button>
          <div class="sums" style="min-width:260px"><div><span>Lines total</span><span>${rs(lineTotal)}</span></div>
            ${billTotal != null ? html`<div><span>Bill total (read)</span><span>${rs(billTotal)}</span></div>
              ${Math.abs(billTotal - lineTotal) >= 100 ? html`<div style="color:var(--bad)"><span>Difference</span><span>${rs(billTotal - lineTotal)}</span></div>` : ''}` : ''}</div></div>
        <div><button class="btn pri" type="submit" data-act="stReceive" data-submit>Receive</button></div></form>`;
    }
    else if (tab === 'transfer') body = html`<form class="panel"><h2>Move stock between stores</h2>${errorBox()}<div class="grid3">${storeSel('trFrom', 'From')}${storeSel('trTo', 'To')}${itemSel('trItem')}
        <label class="f">Quantity (${items.find((i) => i.id === ui.trItem)?.unit ?? 'units'})<input class="in" inputmode="numeric" data-model="trQty" value="${ui.trQty ?? ''}"></label></div>
      <p class="small quiet">A 750 ml bottle is 750; a case of 12 beers is 12.</p><div><button class="btn pri" type="submit" data-act="stTransfer" data-submit>Move</button></div></form>`;
    else if (tab === 'waste') body = html`<form class="panel"><h2>Breakage, spillage or loss</h2>${errorBox()}<div class="grid3">${storeSel('waStore', 'Store')}${itemSel('waItem')}
        <label class="f">Quantity (${items.find((i) => i.id === ui.waItem)?.unit ?? 'units'})<input class="in" inputmode="numeric" data-model="waQty" value="${ui.waQty ?? ''}"></label>
        <label class="f" style="grid-column:1/-1">Reason (required)<input class="in" data-model="waReason" value="${ui.waReason ?? ''}" placeholder="e.g. Bottle broken"></label></div>
      <div><button class="btn pri" type="submit" data-act="stWaste" data-submit>Record</button></div><p class="small quiet">Shown on the exceptions report with who recorded it.</p></form>`;
    else if (tab === 'count') {
      const sid = ui.ctStore;
      body = html`<form class="panel"><h2>Count a store</h2>${errorBox()}<div class="grid3">${storeSel('ctStore', 'Store')}</div>
        ${sid ? html`<p class="small quiet">Type what is physically there, in ${'ml'} for bottles (a full 750 ml bottle is 750) and pieces for the rest. Leave blank to skip an item.</p>
          <div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">Book</th><th>Counted</th></tr></thead><tbody>
          ${items.map((i) => html`<tr><td>${i.name}</td><td class="num">${qtyText(i.byStore[sid] ?? 0, i)}</td><td><input class="in" inputmode="numeric" style="max-width:160px" data-model="ct_${i.id}" value="${ui['ct_' + i.id] ?? ''}" aria-label="Counted ${i.name}"></td></tr>`)}</tbody></table></div>
          <div><button class="btn pri" type="submit" data-act="stCount" data-submit>Save count</button></div>` : ''}
        ${ui.countResult ? html`<div class="sums">${ui.countResult.map((l) => html`<div><span>${l.name}: book ${l.book}, counted ${l.counted} ${l.unit}</span><span style="color:${l.variance ? 'var(--bad)' : 'var(--go-dark)'}">${l.variance ? `${l.variance > 0 ? '+' : ''}${l.variance} ${l.unit} · ${rs(l.valuePaise)}` : 'agrees'}</span></div>`)}</div>` : ''}</form>`;
    } else if (tab === 'handover') {
      const h = ui.handovers;
      body = html`<section class="panel"><form class="row" style="align-items:end">${storeSel('hStore', 'Store')}<label class="f">From<input class="in" type="date" data-model="hFrom" value="${ui.hFrom}"></label>
          <label class="f">To<input class="in" type="date" data-model="hTo" value="${ui.hTo}"></label><button class="btn" type="submit" data-act="stHandover" data-submit>Show</button></form>
        <p class="small quiet">Count the bar on <a href="#/stock/count">Count</a> at every bartender change. Each count shows here with what went missing since the count before, and who billed bar drinks in that time, so a shortage belongs to a shift. Values are at cost (last price paid).</p>
        ${h && h.counts.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Count</th><th>Since</th><th class="num">Missing</th><th class="num">Extra</th><th class="num">Breakage</th><th>Billed in between</th></tr></thead><tbody>
          ${h.counts.map((k) => html`<tr><td>${dateTime(k.at)}<div class="small quiet">by ${k.byName ?? ''} · ${k.detail}</div></td>
            <td>${k.sinceAt ? dateTime(k.sinceAt) : html`<span class="quiet">first count</span>`}</td>
            <td class="num" style="${k.missingPaise ? 'color:var(--bad);font-weight:700' : ''}">${k.missingPaise ? rs(k.missingPaise) : 'none'}</td>
            <td class="num">${k.extraPaise ? rs(k.extraPaise) : ''}</td><td class="num">${k.wastePaise ? rs(k.wastePaise) : ''}</td>
            <td>${k.billedBy.length ? k.billedBy.map((b) => html`<div>${b.name} · ${rs(b.paise)}</div>`) : html`<span class="quiet">no bar bills</span>`}</td></tr>`)}</tbody></table></div>`
          : html`<p class="quiet">No counts of this store in these dates.</p>`}</section>`;
    } else if (tab === 'report') {
      const r = ui.report;
      body = html`<section class="panel"><form class="row" style="align-items:end">${storeSel('rStore', 'Store')}<label class="f">From<input class="in" type="date" data-model="rFrom" value="${ui.rFrom}"></label>
          <label class="f">To<input class="in" type="date" data-model="rTo" value="${ui.rTo}"></label><button class="btn" type="submit" data-act="stReport" data-submit>Show</button></form>
        ${r ? html`<h2>${r.store.name} · ${r.from === r.to ? r.from : `${r.from} to ${r.to}`}</h2>
          ${r.cost ? html`<div class="sums">
            <div><span>${r.store.kind === 'bar' ? 'Bar' : 'Kitchen'} sales (before discounts and GST)</span><span>${rs(r.cost.salesPaise)}</span></div>
            <div><span>Cost of what recipes used (expected)</span><span>${rs(r.cost.expectedCostPaise)} · ${pct(r.cost.expectedCostPaise, r.cost.salesPaise) || '–'}</span></div>
            <div><span>+ Breakage</span><span>${rs(r.cost.wastePaise)}</span></div>
            <div><span style="${r.cost.missingPaise > 0 ? 'color:var(--bad)' : ''}">+ Missing at count</span><span style="${r.cost.missingPaise > 0 ? 'color:var(--bad)' : ''}">${rs(r.cost.missingPaise)}</span></div>
            <div class="big"><span>Actual cost · cost %</span><span>${rs(r.cost.actualCostPaise)} · ${pct(r.cost.actualCostPaise, r.cost.salesPaise) || '–'}</span></div></div>
            <p class="small quiet">Costs are at the last price paid. The gap between expected and actual cost % is what leaked: breakage plus stock missing at the count. Count often (daily for the bar) so missing stock shows up the same week.</p>` : ''}
          <div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">Opening</th><th class="num">Received</th><th class="num">In</th><th class="num">Out</th><th class="num">Sold</th><th class="num">Breakage</th><th class="num">Variance</th><th class="num">Closing</th></tr></thead><tbody>
          ${r.items.map((i) => html`<tr><td>${i.name} <span class="small quiet">${i.unit}</span></td><td class="num">${i.opening}</td><td class="num">${i.received}</td><td class="num">${i.transferIn}</td><td class="num">${i.transferOut}</td><td class="num">${i.sold}</td>
            <td class="num">${i.waste}${i.waste ? html`<div class="small quiet">${rs(i.wasteValuePaise)}</div>` : ''}</td><td class="num" style="${i.variance ? 'color:var(--bad)' : ''}">${i.variance}${i.variance ? html`<div class="small">${rs(i.varianceValuePaise)}</div>` : ''}</td>
            <td class="num"><strong>${i.closing}</strong><div class="small quiet">${rs(i.closingValuePaise)}</div></td></tr>`)}</tbody></table></div>
          <p class="small quiet">Sold comes from bills by recipe. Variance is what counts found against the book: a minus means stock went missing.</p>` : ''}</section>`;
    } else if (tab === 'items') body = html`<div class="grid2" style="align-items:start">
      <section class="panel"><h2>Stock items</h2>${errorBox()}
        <div class="scroll"><table class="t"><thead><tr><th>Item</th><th>Unit</th><th>Pack</th><th class="num">Price per pack</th><th class="num">Reorder at</th></tr></thead><tbody>
          ${st.items.map((i) => html`<tr><td>${i.name}${i.active ? '' : ' (not used)'}</td><td>${i.unit}</td><td>${i.packName} of ${i.packSize}</td><td class="num">${rs(i.costPerPackPaise)}</td><td class="num">${i.reorderLevel}</td></tr>`)}</tbody></table></div>
        <form class="grid2"><label class="f">Name<input class="in" data-model="siName" placeholder="e.g. Sample Whisky"></label>
          <label class="f">Counted in<select class="in" data-model="siUnit"><option value="ml">ml</option><option value="pcs" ${ui.siUnit === 'pcs' ? 'selected' : ''}>pieces</option><option value="g" ${ui.siUnit === 'g' ? 'selected' : ''}>g</option></select></label>
          <label class="f">Bought as<input class="in" data-model="siPack" placeholder="bottle, case"></label><label class="f">Units in one (e.g. 750)<input class="in" inputmode="numeric" data-model="siSize"></label>
          <label class="f">Price per pack (₹)<input class="in" inputmode="decimal" data-model="siCost"></label><label class="f">Reorder when total is at or below (units)<input class="in" inputmode="numeric" data-model="siReorder"></label>
          <div><button class="btn pri" type="submit" data-act="stItem" data-submit>Add stock item</button></div></form>
        <h2>Stores</h2><p>${st.stores.map((x) => x.name).join(', ') || 'None yet'}</p>
        <form class="row" style="align-items:end"><label class="f">Store name<input class="in" data-model="sStoreName" placeholder="e.g. Bar"></label>
          <label class="f">Kind<select class="in" data-model="sStoreKind"><option value="bar">Bar</option><option value="main" ${ui.sStoreKind === 'main' ? 'selected' : ''}>Main store</option><option value="kitchen" ${ui.sStoreKind === 'kitchen' ? 'selected' : ''}>Kitchen</option></select></label>
          <button class="btn" type="submit" data-act="stStore" data-submit>Add store</button></form></section>
      <section class="panel"><h2>Recipes</h2><p class="small quiet">What one portion of a menu item uses. Bar items take from the bar store; kitchen items from the kitchen store.</p>
        <div class="sums">${cache.menu.filter((m) => st.recipes.some((r) => r.menuItemId === m.id)).map((m) => html`<div><span>${m.name}</span><span>${st.recipes.filter((r) => r.menuItemId === m.id).map((r) => { const i = st.items.find((x) => x.id === r.stockItemId); return `${r.qty} ${i?.unit ?? ''} ${i?.name ?? ''}`; }).join(' + ')}</span></div>`)}</div>
        <form class="grid2"><label class="f">Menu item<select class="in" data-model="rcMenu"><option value="">Choose</option>${cache.menu.map((m) => html`<option value="${m.id}" ${ui.rcMenu === m.id ? 'selected' : ''}>${m.name}</option>`)}</select></label>
          ${itemSel('rcStock')}<label class="f">Uses (${items.find((i) => i.id === ui.rcStock)?.unit ?? 'units'} per portion)<input class="in" inputmode="numeric" data-model="rcQty"></label>
          <div class="f">&nbsp;<div class="row"><button class="btn pri" type="submit" data-act="stRecipe" data-submit>Set recipe</button><button class="btn" type="button" data-act="stRecipeClear">Remove recipe</button></div></div></form></section></div>`;
    paint(shell('#/stock', html`${head}${body}`));
  };
  rerender();
}
const int = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(v) : NaN);
actions.stHandover = async () => { ui.handovers = await api('GET', `${B()}/stock/handovers?from=${ui.hFrom}&to=${ui.hTo}&storeId=${ui.hStore}`); rerender(); };
actions.stReceive = async () => {
  const lines = ui.rcLines.map((l) => ({ itemId: ui[`rcl${l.k}item`], packs: int(ui[`rcl${l.k}packs`]), costPerPack: (ui[`rcl${l.k}cost`] ?? '').trim() || undefined }));
  if (!lines.length) throw new Error('Add what was received.');
  if (lines.some((l) => !l.itemId)) throw new Error('Choose the stock item on every line, or remove the line.');
  if (lines.some((l) => !(l.packs > 0))) throw new Error('Type how many packs on every line.');
  await api('POST', `${B()}/stock/purchases`, { storeId: ui.rcStore, vendor: ui.rcVendor, invoiceNo: ui.rcInv, billId: ui.rcBillId ?? undefined, lines });
  flash = { kind: 'ok', text: `Received ${lines.length} line${lines.length === 1 ? '' : 's'}${ui.rcVendor ? ' from ' + ui.rcVendor : ''}.` }; go('#/stock/hand');
};
actions.rcAdd = () => { const k = Math.max(0, ...ui.rcLines.map((l) => l.k)) + 1; ui.rcLines.push({ k, desc: '' }); rerender(); };
actions.rcDrop = (d) => { ui.rcLines = ui.rcLines.filter((l) => String(l.k) !== d.k); rerender(); };
/** A bill photo: made smaller on the device (at most 2000 px, JPEG), kept on the server and read by Claude into the lines. */
async function sendBillPhoto(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  const r = await fetch(`/api${B()}/stock/bills`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  const data = await r.json().catch(() => null);
  if (r.status === 401) { me = null; go('#/signin'); throw new ApiError('Please sign in.', 401, 'signin'); }
  if (!r.ok) throw new ApiError(data?.error ?? 'Could not send the photo.', r.status);
  return data;
}
root.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (!el.matches?.('[data-bill-photo]') || !el.files?.[0]) return;
  ui.rcReading = true; ui.rcError = null; ui.error = null; rerender();
  try {
    const r = await sendBillPhoto(el.files[0]);
    ui.rcBillId = r.billId; ui.rcError = r.error; ui.rcRead = !!r.read;
    if (r.read) {
      if (r.read.vendor) ui.rcVendor = r.read.vendor;
      if (r.read.invoiceNo) ui.rcInv = r.read.invoiceNo;
      ui.rcTotal = r.read.totalRupees;
      ui.rcLines = r.read.lines.map((l, i) => {
        const k = i + 1;
        ui[`rcl${k}item`] = l.stockItemId ?? ''; ui[`rcl${k}packs`] = l.packs != null ? String(l.packs) : ''; ui[`rcl${k}cost`] = l.pricePerPackRupees != null ? String(l.pricePerPackRupees) : '';
        return { k, desc: `${l.description}${l.lineTotalRupees != null ? ' · ' + rs(Math.round(l.lineTotalRupees * 100)) : ''}` };
      });
      if (!ui.rcLines.length) ui.rcLines = [{ k: 1, desc: '' }];
      ui.rcUnmatched = r.read.lines.filter((l) => !l.stockItemId).length;
    }
  } catch (e) { if (!(e instanceof ApiError && e.code === 'signin')) ui.rcError = e.message; }
  ui.rcReading = false; rerender();
});
actions.stTransfer = async () => { await api('POST', `${B()}/stock/transfers`, { fromStoreId: ui.trFrom, toStoreId: ui.trTo, lines: [{ itemId: ui.trItem, qty: int(ui.trQty) }] }); flash = { kind: 'ok', text: 'Moved.' }; go('#/stock/hand'); };
actions.stWaste = async () => { await api('POST', `${B()}/stock/waste`, { storeId: ui.waStore, itemId: ui.waItem, qty: int(ui.waQty), reason: ui.waReason }); flash = { kind: 'ok', text: 'Recorded.' }; go('#/stock/hand'); };
actions.stCount = async () => {
  const lines = ui.st.items.filter((i) => i.active && String(ui['ct_' + i.id] ?? '').trim() !== '').map((i) => ({ itemId: i.id, counted: int(ui['ct_' + i.id]) }));
  const r = await api('POST', `${B()}/stock/counts`, { storeId: ui.ctStore, lines });
  const keep = ui.ctStore; await stockScreen('count'); ui.ctStore = keep; ui.countResult = r.lines; rerender();
};
actions.stReport = async () => { ui.report = await api('GET', `${B()}/stock/report?from=${ui.rFrom}&to=${ui.rTo}&storeId=${ui.rStore}`); rerender(); };
actions.stItem = async () => { await api('POST', `${B()}/stock/items`, { name: ui.siName, unit: ui.siUnit ?? 'ml', packName: ui.siPack, packSize: int(ui.siSize), costPerPack: ui.siCost, reorderLevel: int(ui.siReorder || '0') }); route(); };
actions.stStore = async () => { await api('POST', `${B()}/stock/stores`, { name: ui.sStoreName, kind: ui.sStoreKind ?? 'bar' }); route(); };
actions.stRecipe = async () => { await api('PUT', `${B()}/stock/recipes/${ui.rcMenu}`, { lines: [{ stockItemId: ui.rcStock, qty: int(ui.rcQty) }] }); route(); };
actions.stRecipeClear = async () => { await api('PUT', `${B()}/stock/recipes/${ui.rcMenu}`, { lines: [] }); route(); };

// ---------- exceptions

async function exceptionsScreen(day = me.business.shiftDay) {
  const [{ events }, d] = await Promise.all([api('GET', `${B()}/events?day=${encodeURIComponent(day)}`), api('GET', `${B()}/reports/daily-check?day=${encodeURIComponent(day)}`)]);
  const kind = { void: 'Void', reprint: 'Reprint', kot_cancel: 'KOT line cancelled', discount: 'Discount', comp: 'Complimentary', limit_warning: 'Limit warning', credit_note: 'Credit note', stock_waste: 'Stock breakage or waste', stock_count: 'Stock count variance' };
  const modeName = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Posted to rooms', credit: 'On credit', comp: 'Complimentary', advance: 'Advances used' };
  const ev = (k) => d.events[k] ?? { n: 0, paise: 0 };
  const df = (k) => d.differences[k] ?? { n: 0, paise: 0 };
  const flag = (n, text, money) => html`<div><span style="${n ? 'color:var(--warn)' : ''}">${text}</span><span>${n ? `${n}${money !== undefined ? ' · ' + rs(money) : ''}` : 'none'}</span></div>`;
  const broken = d.series.filter((x) => x.missing.length).concat(d.creditNoteSeries.filter((x) => x.missing.length));
  const statusName = { open: 'Open order', tab: 'Tab', billed: 'Bill printed, not paid' };
  const exCount = ['void', 'discount', 'comp', 'kot_cancel', 'reprint', 'credit_note', 'stock_waste', 'stock_count', 'limit_warning'].reduce((t, k) => t + ev(k).n, 0) + df('discount').n;
  const oldUnpaid = d.unpaid.filter((o) => o.old).length;
  rerender = () => paint(shell('#/exceptions', html`${pageHead(`Daily check · shift ${dayName(day)}`, 'The owner\'s morning page: money, the cash close, bill numbers and anything unusual.',
      html`<form class="row" style="align-items:end"><label class="f">Shift<input class="in" type="date" data-model="day" value="${ui.day ?? day}" style="width:auto"></label><button class="btn" type="submit" data-act="exDay" data-submit>Show</button></form>`)}
    <div class="kpis">${kpi(`Net sales · ${plural(d.sales.bills, 'bill')}`, rs(d.sales.netPaise), `${rs(d.sales.totalPaise)} with GST`)}
      ${d.shiftClose ? kpi('Cash close', d.shiftClose.differencePaise === 0 ? 'Matched' : `${d.shiftClose.differencePaise > 0 ? 'Over' : 'Short'} ${rs(Math.abs(d.shiftClose.differencePaise))}`, d.shiftClose.reason ?? 'Shift closed', d.shiftClose.differencePaise === 0 ? 'good' : 'bad')
        : kpi('Cash close', 'Not closed', 'The shift is not closed yet', 'warn')}
      ${kpi('Bill numbers', broken.length ? 'Gaps found' : 'Unbroken', broken.length ? 'See below' : `Financial year ${d.fy}`, broken.length ? 'bad' : 'good')}
      ${kpi('Exceptions', String(exCount), 'Voids, discounts, comps, cancels, reprints and more', exCount ? 'warn' : 'good')}
      ${kpi('Sent, not paid', String(d.unpaid.length), oldUnpaid ? `${oldUnpaid} overdue` : 'Right now', oldUnpaid ? 'bad' : d.unpaid.length ? 'warn' : 'good')}</div>
    <div class="grid2" style="align-items:start">
      <section class="panel"><h2>Money</h2>
        <div class="sums"><div class="big"><span>Net sales · ${plural(d.sales.bills, 'bill')}</span><span>${rs(d.sales.netPaise)}</span></div>
          <div><span class="quiet">With GST</span><span>${rs(d.sales.totalPaise)}</span></div>
          ${d.byMode.map((m) => html`<div><span>${modeName[m.mode] ?? m.mode} (${m.n})</span><span>${rs(m.paise)}</span></div>`)}</div>
        <h2>Shift close</h2>
        ${d.shiftClose ? html`<p>${d.shiftClose.differencePaise === 0 ? 'Closed, cash matched.' : html`<span style="color:var(--bad)">Closed, cash ${d.shiftClose.differencePaise > 0 ? 'over' : 'short'} by ${rs(Math.abs(d.shiftClose.differencePaise))}</span> · ${d.shiftClose.reason ?? ''}`}</p>`
          : html`<p style="color:var(--warn)">Not closed yet.</p>`}
        <h2>Bill numbers (${d.fy})</h2>
        ${broken.length ? html`<div class="msg bad">${broken.map((x) => html`<div>${x.name}: ${x.missing.join(', ')} missing</div>`)}</div>`
          : html`<p>${d.series.length ? 'Every series is unbroken: no number missing.' : 'No bills this year yet.'}</p>`}
        <div class="sums">${d.series.map((x) => html`<div><span>${x.name} · ${x.prefix}</span><span>${x.count} bills, last ${x.lastNo ?? x.last}</span></div>`)}</div></section>
      <section class="panel"><h2>Exceptions</h2>
        <div class="sums">${flag(ev('void').n, 'Void bills', ev('void').paise)}${flag(ev('discount').n + df('discount').n, 'Discounts', ev('discount').paise + df('discount').paise)}
          ${flag(ev('comp').n, 'Complimentary', ev('comp').paise)}${flag(ev('kot_cancel').n, 'Cancelled after KOT')}${flag(ev('reprint').n, 'Reprints')}
          ${flag(ev('credit_note').n, 'Credit notes', ev('credit_note').paise)}${flag(df('tip').n, 'Tips', df('tip').paise)}
          ${flag(ev('stock_waste').n, 'Breakage', ev('stock_waste').paise)}${flag(ev('stock_count').n, 'Stock count differences')}
          <div><span style="${d.bar.missingPaise ? 'color:var(--bad);font-weight:700' : d.bar.counts ? '' : 'color:var(--warn)'}">Bar: missing at count</span>
            <span>${d.bar.counts ? `${d.bar.missingPaise ? rs(d.bar.missingPaise) : 'none'} · ${d.bar.counts} count${d.bar.counts === 1 ? '' : 's'}` : 'bar not counted'}</span></div>${flag(ev('limit_warning').n, 'Billing name limit warnings')}</div>
        <h2>Sent to kitchen, not paid (right now)</h2>
        <p class="small quiet">Every order holding food or drinks already sent to the kitchen or bar, with no paid bill. Old ones (tabs past ${me.business.tab_age_days ?? 3} days, others past 6 hours) are in red.</p>
        ${d.unpaid.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Where</th><th>State</th><th class="num">Sent</th><th class="num">Open for</th></tr></thead><tbody>
          ${d.unpaid.map((o) => html`<tr style="${o.old ? 'color:var(--bad)' : ''}"><td><a href="#/order/${o.id}">${o.place}</a>${o.guestName ? html`<div class="small quiet">${o.guestName}</div>` : ''}</td>
            <td>${statusName[o.status]}${o.billNo ? ' · ' + o.billNo : ''}${o.voided ? html`<div class="small">A bill was voided</div>` : ''}</td><td class="num">${rs(o.sentPaise)}</td>
            <td class="num">${o.hours >= 24 ? `${Math.floor(o.hours / 24)} d ${o.hours % 24} h` : `${o.hours} h`}</td></tr>`)}</tbody></table></div>` : html`<p>Nothing: everything sent was paid for.</p>`}</section>
    </div>
    ${(d.typedPrices ?? []).length ? html`<section class="panel" style="margin-top:16px"><h2>Prices typed at billing</h2>
      <p class="quiet small">Bottles and other price-at-billing items, with the price typed and who typed it.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Bill</th><th>Item</th><th class="num">Qty</th><th class="num">Price typed</th><th class="num">Lowest allowed</th><th>Typed by</th></tr></thead><tbody>
        ${d.typedPrices.map((x) => html`<tr><td>${x.billNo}</td><td>${x.name}</td><td class="num">${x.qty}</td><td class="num">${rs(x.pricePaise)}</td><td class="num">${x.minPricePaise == null ? '—' : rs(x.minPricePaise)}</td><td>${x.byName ?? ''}</td></tr>`)}</tbody></table></div></section>` : ''}
    <section class="panel" style="margin-top:16px"><h2>Every exception, in order</h2>
    <p class="quiet small">Every void, reprint, cancelled KOT line, discount and complimentary bill, with who and why. Nothing here can be changed.</p>
    <div class="scroll"><table class="t"><thead><tr><th>Time</th><th>What</th><th>Bill or item</th><th class="num">Amount</th><th>By</th><th>Reason</th></tr></thead><tbody>
      ${events.length ? events.map((e) => html`<tr><td>${time(e.at)}</td><td>${kind[e.kind]}</td><td>${e.ref}</td><td class="num">${e.amountPaise === null ? '' : rs(e.amountPaise)}</td><td>${e.byName ?? ''}</td><td>${e.reason ?? ''}${e.detail ? html`<div class="small quiet">${e.detail}</div>` : ''}</td></tr>`)
        : html`<tr><td colspan="6" class="quiet">Nothing in this shift.</td></tr>`}</tbody></table></div></section>`));
  rerender();
}
actions.exDay = () => go(`#/exceptions/${ui.day}`);

// ---------- settings (Owner and manager)

const splitTables = (text) => (text ?? '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
actions.tablesAddRange = () => {
  const from = int(ui.tFrom ?? '1'); const to = int(ui.tTo ?? '12'); const prefix = (ui.tPrefix ?? 'T').trim();
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || to - from >= 150) throw new Error('Type a from and to number, such as 1 and 12.');
  const have = splitTables(ui.tableText);
  const add = Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`).filter((t) => !have.some((h) => h.toLowerCase() === t.toLowerCase()));
  ui.tableText = [...have, ...add].join(', '); ui.error = null; rerender();
};
actions.tablesSave = async () => { await api('PUT', B() + '/tables', { tables: splitTables(ui.tableText) }); flash = { kind: 'ok', text: 'Tables saved. The counter shows them now.' }; route(); };
actions.tablesClear = async () => { await api('PUT', B() + '/tables', { tables: [] }); flash = { kind: 'ok', text: 'List cleared. The counter shows the tables used lately.' }; route(); };
async function settingsScreen(tab = 'menu') {
  const tabs = [['menu', 'Menu', 'menu.edit'], ['categories', 'Categories', 'menu.edit'], ['addons', 'Add-ons', 'menu.edit'], ['stations', 'Stations', 'menu.edit'], ['tables', 'Tables', 'menu.edit'], ['reasons', 'Reasons', 'menu.edit'], ['entities', 'Billing names', 'entities.edit'], ['accounts', 'UPI accounts', 'entities.edit'],
    ['staff', 'Staff and PINs', 'staff.manage'], ['device', 'This device', 'staff.manage']].filter((t) => can(t[2]));
  if (!tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
  for (const k of KEEP) delete cache[k];
  await load('menu', 'reasons', 'entities', 'payAccounts');
  if (tab === 'staff') { ui.staff = (await api('GET', B() + '/staff')).staff; if (!me.support) ui.supportInfo = await api('GET', B() + '/support'); }
  if (tab === 'device') ui.devices = (await api('GET', B() + '/devices')).devices;
  if (tab === 'menu' && can('menu.upload')) ui.uploads = (await api('GET', B() + '/menu/uploads')).uploads;
  if (tab === 'tables') { ui.tableList = (await api('GET', B() + '/tables')).tables; ui.tableText = ui.tableList.join(', '); }
  const head = html`${pageHead('Settings', 'Changes here reach every counter device at once.')}${tabsNav('Settings', tabs.map(([k, t]) => [`#/settings/${k}`, t, k]), tab)}`;
  const kinds = { discount: 'Discount', comp: 'Complimentary', void: 'Void', kot_cancel: 'Cancelled KOT line' };
  rerender = () => {
    let body = '';
    const menuShown = menuFilter();
    if (tab === 'menu') body = html`${menuSheetPanel()}<section class="panel"><h2>Menu</h2>${ui.upName ? '' : errorBox()}
      <div class="gtools"><input class="in" type="search" data-model="mQ" data-live value="${ui.mQ ?? ''}" placeholder="Search items or categories" aria-label="Search items">
        <select class="in" style="flex:0 1 220px" data-model="mCat" aria-label="Category"><option value="">All categories</option>${[...new Set(cache.menu.map((m) => m.category))].sort().map((c) => html`<option ${ui.mCat === c ? 'selected' : ''}>${c}</option>`)}</select>
        <span class="small quiet">${menuShown.length === cache.menu.length ? plural(cache.menu.length, 'item') : `${menuShown.length} of ${cache.menu.length} items`}</span>
        <button class="btn" type="button" data-act="mNew">+ Add item</button></div>
      ${menuShown.length ? '' : html`<p class="quiet">No item matches${ui.mQ ? ` “${ui.mQ}”` : ''}${ui.mCat ? ` in ${ui.mCat}` : ''}.</p>`}
      ${menuBulkBar()}
      <div class="scroll"><table class="t cards"><thead><tr><th class="selcol"><input type="checkbox" class="sel" data-act-change="mSelAll" aria-label="Tick every item shown" ${menuShown.length && menuShown.every((m) => (ui.mSel ?? []).includes(m.id)) ? 'checked' : ''}></th><th>Item</th><th class="num">Price (before GST)</th><th>Category</th><th>Station</th><th>Tax</th><th></th></tr></thead><tbody>
        ${menuShown.map((m) => html`<tr class="${(ui.mSel ?? []).includes(m.id) ? 'picked' : ''}"><td class="selcol"><input type="checkbox" class="sel" data-act-change="mSel" data-id="${m.id}" aria-label="Tick ${m.name}" ${(ui.mSel ?? []).includes(m.id) ? 'checked' : ''}></td><td data-label="Item"><strong>${m.name}</strong>${m.active ? '' : ' (off the menu)'}${groupsOf(m).some((g) => g.kind === 'one') ? html` <span class="tag-one">Choose</span>` : ''}${groupsOf(m).some((g) => g.kind === 'any') ? html` <span class="tag-any">+ add-ons</span>` : ''}
          ${groupsOf(m).length ? html`<div class="small quiet">${groupsOf(m).map((g) => g.name).join(', ')}</div>` : ''}</td>
          <td data-label="Price (before GST)" class="num">${m.openPrice ? `Typed${m.minPricePaise != null ? `, at least ${rs(m.minPricePaise)}` : ''}` : `${groupsOf(m).some((g) => g.kind === 'one') ? 'from ' : ''}${rs(m.pricePaise)}`}</td><td data-label="Category">${m.category}</td><td data-label="Station">${routeOf(m)}</td>
          <td data-label="Tax">${m.taxMode ? taxName(m) : html`<span class="quiet">${taxName(catOf(m) ?? { taxMode: 'billing' })} · from category</span>`}</td>
          <td class="act"><div class="irow">${iconBtn('itemEdit', m.id, 'edit', `Edit ${m.name}`)}${m.active ? iconBtn('itemToggle', m.id, 'off', `Take ${m.name} off the menu`) : iconBtn('itemToggle', m.id, 'on', `Put ${m.name} back on the menu`)}${iconBtn('itemDelete', m.id, 'trash', `Delete ${m.name}`, 'danger')}</div></td></tr>`)}</tbody></table></div>
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editItem ? 'Edit item' : 'Add item'}</h2><label class="f">Name<input class="in" data-model="iName" value="${ui.iName ?? ''}" ${ui.editItem ? 'autofocus' : ''}></label><label class="f">Category<input class="in" data-model="iCat" value="${ui.iCat ?? ''}"></label>
        <label class="f">Price at billing<select class="in" data-model="iOpen"><option value="no">No: fixed price</option><option value="yes" ${ui.iOpen === 'yes' ? 'selected' : ''}>Yes: typed when ordered (bottles, catch of the day)</option></select></label>
        ${ui.iOpen === 'yes' ? html`<label class="f">Lowest price allowed (₹, optional)<input class="in" inputmode="decimal" data-model="iMin" value="${ui.iMin ?? ''}"></label>`
          : choicePrice() !== null ? html`<label class="f">Price (₹, before GST)<input class="in" data-model="iPrice" value="${choicePrice()}" readonly aria-describedby="ip-n"><span class="small quiet" id="ip-n" style="font-weight:400">The first choice's price, set below.</span></label>`
          : html`<label class="f">Price (₹, before GST)<input class="in" inputmode="decimal" data-model="iPrice" value="${ui.iPrice ?? ''}"></label>`}
        ${itemKotFields()}
        <label class="f">Tax<select class="in" data-model="iTax">${taxChoices(true).map(([v, t]) => html`<option value="${v}" ${(ui.iTax ?? 'category') === v ? 'selected' : ''}>${t}</option>`)}</select></label>
        <div style="grid-column:1/-1">${itemAddons()}</div>
        <div class="f">&nbsp;<div class="row"><button class="btn pri" type="submit" data-act="addItem" data-submit>${ui.editItem ? 'Save item' : 'Add item'}</button>${ui.editItem ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></div></form></section>`;
    if (tab === 'categories') body = html`<section class="panel"><h2>Categories and GST</h2>
      <p class="quiet small">Each item takes its GST from its own setting if it has one, else from its category here, else from the billing name on the bill. A billing name not registered for GST charges none. Check rates with your CA.</p>${errorBox()}
      <p class="quiet small">KOT works the same way: each item follows its category unless the item says otherwise. "No KOT" items go on the order and the bill but never to a station (cigarettes, room charges).</p>
      <div class="scroll"><table class="t cards"><thead><tr><th>Category</th><th class="num">Items</th><th>GST</th><th>KOT</th><th>Station</th></tr></thead><tbody>
        ${cache.menuCats.map((c) => html`<tr><td data-label="Category"><strong>${c.name}</strong></td><td data-label="Items" class="num">${cache.menu.filter((m) => m.active && m.category.toLowerCase() === c.name.toLowerCase()).length}</td>
          <td data-label="GST"><select class="in" data-act-change="catTax" data-id="${c.id}" aria-label="GST for ${c.name}">${taxChoices(false).map(([v, t]) => html`<option value="${v}" ${taxValue(c) === v ? 'selected' : ''}>${t}</option>`)}</select></td>
          <td data-label="KOT"><select class="in" data-act-change="catKot" data-id="${c.id}" aria-label="KOT for ${c.name}"><option value="yes">Print KOT</option><option value="no" ${c.kot === 0 ? 'selected' : ''}>No KOT</option></select></td>
          <td data-label="Station">${c.kot === 0 ? html`<span class="quiet small">Not sent anywhere</span>` : html`<select class="in" data-act-change="catStation" data-id="${c.id}" aria-label="Station for ${c.name}">${activeStations().map((x) => html`<option value="${x.id}" ${c.stationId === x.id ? 'selected' : ''}>${x.name}</option>`)}</select>`}</td></tr>`)}</tbody></table></div></section>`;
    if (tab === 'addons') body = addonsTab();
    if (tab === 'stations') body = stationsTab();
    if (tab === 'tables') body = html`<section class="panel"><h2>Tables</h2>
      <p class="quiet small">The tables the counter shows as a grid, in this order. Leave the list empty to show the tables used in the last 60 days instead.</p>${errorBox()}
      ${ui.tableList.length ? html`<div class="tgrid">${ui.tableList.map((t) => html`<span class="tcell free">${t}</span>`)}</div>` : html`<p class="quiet">No list yet: the counter shows recent tables.</p>`}
      <form class="grid3"><h2 style="grid-column:1/-1">Make a numbered set</h2>
        <label class="f">Name starts with<input class="in" data-model="tPrefix" value="${ui.tPrefix ?? 'T'}" maxlength="12"></label>
        <label class="f">From number<input class="in" inputmode="numeric" data-model="tFrom" value="${ui.tFrom ?? '1'}"></label>
        <label class="f">To number<input class="in" inputmode="numeric" data-model="tTo" value="${ui.tTo ?? '12'}"></label>
        <div class="row" style="grid-column:1/-1"><button class="btn" type="button" data-act="tablesAddRange">Add these to the list below</button></div></form>
      <form class="f"><label class="f">All tables, in order (separate with commas or new lines)<textarea class="in" rows="4" data-model="tableText">${ui.tableText}</textarea></label>
        <div class="row" style="margin-top:8px"><button class="btn pri" type="submit" data-act="tablesSave" data-submit>Save tables</button>
          ${ui.tableList.length ? html`<button class="btn" type="button" data-act="tablesClear">Clear the list (show recent tables)</button>` : ''}</div></form></section>`;
    if (tab === 'reasons') body = html`<section class="panel"><h2>Reasons</h2>${errorBox()}
      ${Object.entries(kinds).map(([k, t]) => html`<div><p class="small quiet" style="font-weight:600;margin-bottom:6px">${t}</p><div class="chips">${reasonsOf(k).map((r) => html`<span class="chip" style="display:inline-flex;align-items:center;gap:8px">${r.label}<button class="btn ghost" style="padding:0 12px;margin-right:-10px" type="button" data-act="retire" data-id="${r.id}" aria-label="Remove ${r.label}">×</button></span>`)}</div></div>`)}
      <form class="grid3"><label class="f">For<select class="in" data-model="rKind">${Object.entries(kinds).map(([k, t]) => html`<option value="${k}" ${ui.rKind === k ? 'selected' : ''}>${t}</option>`)}</select></label>
        <label class="f">Reason<input class="in" data-model="rLabel"></label><div class="f">&nbsp;<button class="btn pri" type="submit" data-act="addReason" data-submit>Add reason</button></div></form></section>`;
    if (tab === 'entities') body = html`<section class="panel"><h2>Billing names</h2><p class="quiet small">With one name, the counter never asks. With more, the cashier picks one on each bill; the default is preselected.</p>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Name on bill</th><th>GST</th><th>Series</th><th class="num">Billed this year</th><th>Limit</th><th></th></tr></thead><tbody>
        ${cache.entities.map((e) => html`<tr><td>${e.name}<div class="small quiet">${e.kind}${e.is_default ? ' · default' : ''}${e.active ? '' : ' · inactive'}</div></td>
          <td>${e.gst_registered ? `${e.gst_rate_bp / 100}% · ${e.gstin}` : 'Not registered'}</td><td>${e.series_prefix}</td><td class="num">${rs(e.year_paise)}</td>
          <td>${e.yearly_limit_paise ? `${rs(e.yearly_limit_paise)} · stops at ${rs(e.stop_paise)}` : '—'}</td>
          <td><div class="row"><button class="btn" type="button" data-act="entFlag" data-id="${e.id}" data-f="offered">${e.offered ? 'Offered' : 'Not offered'}</button>
            ${e.is_default ? '' : html`<button class="btn" type="button" data-act="entFlag" data-id="${e.id}" data-f="is_default">Make default</button>`}
            ${iconBtn('entEdit', e.id, 'edit', `Edit ${e.name}`)}</div></td></tr>`)}</tbody></table></div>
      <form class="panel" style="padding:0;border:0"><h2>${ui.editEntity ? 'Edit billing name' : 'Add a billing name'}</h2>
        <div class="grid3"><label class="f">Name as printed<input class="in" data-model="eName" value="${ui.eName ?? ''}" ${ui.editEntity ? 'autofocus' : ''}></label>
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
          <td class="act">${iconBtn('acctEdit', a.id, 'edit', `Edit ${a.name}`)}</td></tr>`)}</tbody></table></div>
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editAcct ? 'Edit account' : 'Add account'}</h2><label class="f">Account name<input class="in" data-model="aName" value="${ui.aName ?? ''}" ${ui.editAcct ? 'autofocus' : ''}></label>
        <label class="f">Belongs to<select class="in" data-model="aEntity"><option value="">Choose</option>${cache.entities.map((e) => html`<option value="${e.id}" ${ui.aEntity === e.id ? 'selected' : ''}>${e.name}</option>`)}</select></label>
        <label class="f">Bookr account id (optional)<input class="in" data-model="aBookr" value="${ui.aBookr ?? ''}"></label>
        ${ui.editAcct ? html`<label class="f">Status<select class="in" data-model="aActive"><option value="yes">In use</option><option value="no" ${ui.aActive === 'no' ? 'selected' : ''}>Not used</option></select></label>` : ''}
        <div class="row"><button class="btn pri" type="submit" data-act="addAccount" data-submit>${ui.editAcct ? 'Save account' : 'Add account'}</button>${ui.editAcct ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>`;
    if (tab === 'staff') body = html`<section class="panel"><h2>Staff and PINs</h2>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Name</th><th>Role</th><th>Sign-in</th></tr></thead><tbody>
        ${ui.staff.filter((s) => !s.support).map((s) => html`<tr><td>${s.name}${s.active ? '' : ' (inactive)'}</td><td>${s.role}</td><td>${s.email ?? ''}${s.hasPin ? ' · PIN set' : ''}</td>
          <td class="act">${iconBtn('staffEdit', s.id, 'edit', `Edit ${s.name}`)}</td></tr>`)}</tbody></table></div>
      ${ui.supportInfo ? supportPanel() : ''}
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editStaff ? 'Edit person (leave PIN and password empty to keep them)' : 'Add person'}</h2><label class="f">Name<input class="in" data-model="sName" value="${ui.sName ?? ''}" ${ui.editStaff ? 'autofocus' : ''}></label>
        <label class="f">Role<select class="in" data-model="sRole">${['cashier', 'captain', 'manager', 'owner'].map((r) => html`<option value="${r}" ${ui.sRole === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`)}</select></label>
        <label class="f">PIN (4–6 digits)<input class="in" inputmode="numeric" data-model="sPin" maxlength="6" autocomplete="off"></label>
        ${['manager', 'owner'].includes(ui.sRole) ? html`<label class="f">Email<input class="in" type="email" data-model="sEmail" value="${ui.sEmail ?? ''}"></label><label class="f">Password (12+ characters)<input class="in" type="password" data-model="sPassword" autocomplete="new-password"></label>` : ''}
        ${ui.editStaff ? html`<label class="f">Status<select class="in" data-model="sActive"><option value="yes">Active</option><option value="no" ${ui.sActive === 'no' ? 'selected' : ''}>Inactive (cannot sign in)</option></select></label>` : ''}
        <div class="row"><button class="btn pri" type="submit" data-act="addStaff" data-submit>${ui.editStaff ? 'Save person' : 'Add person'}</button>${ui.editStaff ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>`;
    if (tab === 'device') body = html`<section class="panel"><h2>Counter devices</h2><p class="quiet small">Counter staff sign in with a PIN only on a device set up here. Set up the billing PC or tablet by signing in on it as the Owner and pressing the button below.</p>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Device</th><th>Added</th><th></th></tr></thead><tbody>
        ${ui.devices.map((d) => html`<tr><td>${d.name}</td><td>${dateTime(d.createdAt)}</td><td>${d.revokedAt ? 'Removed' : iconBtn('revoke', d.id, 'trash', `Remove ${d.name}`, 'danger')}</td></tr>`)}</tbody></table></div>
      <form class="row"><label class="f grow">Name for this device<input class="in" data-model="dName" placeholder="Billing counter"></label><button class="btn pri" type="submit" data-act="addDevice" data-submit>Make this a counter device</button></form></section>`;
    paint(shell('#/settings', html`${head}${body}`));
  };
  rerender();
}
// Support access: off unless the owner turns it on; every visit by Bookr POS support is listed here.
function supportPanel() {
  const s = ui.supportInfo;
  return html`<div class="supportbox"><h2>Bookr POS support access</h2>
    <p class="quiet small">${s.on ? 'On: Bookr POS support can open this restaurant as a manager to help you. Turn it off when you are done; anyone from support is signed out at once.'
      : 'Off: nobody from Bookr POS can open this restaurant. Turn it on only when you have asked for help.'}</p>
    <div class="row"><button class="btn ${s.on ? 'danger' : 'pri'}" type="button" data-act="supportToggle">${s.on ? 'Turn support access off' : 'Turn support access on'}</button></div>
    ${s.visits.length ? html`<details><summary class="small">Support visits (${s.visits.length})</summary><ul class="small">${s.visits.map((v) => html`<li>${dateTime(v.at)} · ${v.by}</li>`)}</ul></details>` : html`<p class="quiet small">No support visits yet.</p>`}</div>`;
}
actions.supportToggle = async () => {
  const on = !ui.supportInfo.on;
  await api('PUT', B() + '/support', { on });
  flash = { kind: 'ok', text: on ? 'Support access is on.' : 'Support access is off. Anyone from support has been signed out.' }; route();
};

// ---------- Bookr POS admin (#/admin): restaurants and their owners; never a restaurant's bills, menus or sales
async function adminScreen() {
  try { ui.admin = (await api('GET', '/admin/me')).admin; } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e; ui.admin = null; }
  if (ui.admin) ui.rests = (await api('GET', '/admin/restaurants')).restaurants;
  document.title = 'Bookr POS admin';
  rerender = () => {
    if (!ui.admin) {
      paint(html`<div class="signwrap"><main class="signin"><form class="panel" style="padding:24px">
        <div><p class="brandline">Bookr POS</p><h1>${ui.setupMode ? 'First admin' : 'Admin sign in'}</h1>
          <p class="quiet small">${ui.setupMode ? 'Once only, with the setup token kept as a Worker secret. Use an email that is not a restaurant login.' : 'For the people who run Bookr POS. Restaurant owners sign in on the main page.'}</p></div>${errorBox()}
        ${ui.setupMode ? html`<label class="f">Setup token<input class="in" type="password" data-model="xToken" autocomplete="off"></label>
          <label class="f">Your name<input class="in" data-model="xName" value="${ui.xName ?? ''}"></label>` : ''}
        <label class="f">Email<input class="in" type="email" autocomplete="username" data-model="xEmail" value="${ui.xEmail ?? ''}" autofocus></label>
        <label class="f">Password${ui.setupMode ? ' (12+ characters)' : ''}<input class="in" type="password" autocomplete="${ui.setupMode ? 'new-password' : 'current-password'}" data-model="xPassword"></label>
        <button class="btn pri big" type="submit" data-act="${ui.setupMode ? 'adminSetup' : 'adminLogin'}" data-submit>${ui.setupMode ? 'Create admin and sign in' : 'Sign in'}</button>
        <button class="btn ghost" type="button" data-act="adminSetupMode">${ui.setupMode ? 'Back to sign in' : 'First time: create the first admin'}</button>
      </form></main></div>`);
      return;
    }
    const ownerEmails = (r) => r.owners.map((o) => o.email.toLowerCase());
    const copyChoices = ui.rOwnerEmail ? ui.rests.filter((r) => ownerEmails(r).includes(ui.rOwnerEmail.trim().toLowerCase())) : [];
    const known = copyChoices.length > 0;
    const row = (r) => {
      const open = ui.rowAct?.id === r.id ? ui.rowAct.kind : null;
      return html`<tr><td data-label="Restaurant"><strong>${r.name}</strong><div class="small quiet">Added ${dateTime(r.createdAt)}</div></td>
        <td data-label="Owners">${r.owners.map((o) => html`<div>${o.name} <span class="small quiet">${o.email}</span>${o.active ? '' : ' (inactive)'}</div>`)}</td>
        <td data-label="Status">${r.status === 'active' ? 'Active' : html`<strong class="badtext">Paused</strong>`}${r.supportAccess ? html`<div class="small">Support access on</div>` : ''}</td>
        <td data-label="Bills this month" class="num">${r.billsThisMonth}</td>
        <td data-label="Last used">${r.lastUsedAt ? since(r.lastUsedAt) + ' ago' : html`<span class="quiet">Never</span>`}</td>
        <td class="act"><div class="row">
          <button class="btn" type="button" data-act="adminStatus" data-id="${r.id}" data-to="${r.status === 'active' ? 'paused' : 'active'}">${r.status === 'active' ? 'Pause' : 'Resume'}</button>
          <button class="btn" type="button" data-act="adminRow" data-id="${r.id}" data-kind="owner">Add owner</button>
          ${r.owners.length ? html`<button class="btn" type="button" data-act="adminRow" data-id="${r.id}" data-kind="password">Reset password</button>` : ''}
          ${r.supportAccess && r.status === 'active' ? html`<button class="btn" type="button" data-act="adminVisit" data-id="${r.id}">Open for support</button>` : ''}</div>
          ${open === 'owner' ? html`<form class="grid3 rowform"><label class="f">Owner's email<input class="in" type="email" data-model="oEmail" autofocus></label>
            <label class="f">Name (new owner)<input class="in" data-model="oName"></label><label class="f">Temporary password (new owner)<input class="in" type="password" data-model="oPassword" autocomplete="new-password"></label>
            <p class="small quiet" style="grid-column:1/-1">An owner who already has a Bookr POS login keeps their own password; name and password are then not needed.</p>
            <div class="row"><button class="btn pri" type="submit" data-act="adminAddOwner" data-submit>Give access</button><button class="btn" type="button" data-act="adminRow">Cancel</button></div></form>` : ''}
          ${open === 'password' ? html`<form class="grid3 rowform"><label class="f">Owner<select class="in" data-model="pOwner">${r.owners.map((o) => html`<option value="${o.id}">${o.name} (${o.email})</option>`)}</select></label>
            <label class="f">New temporary password (12+)<input class="in" type="password" data-model="pPassword" autocomplete="new-password" autofocus></label>
            <p class="small quiet" style="grid-column:1/-1">Works at every restaurant this owner has, and signs them out everywhere.</p>
            <div class="row"><button class="btn pri" type="submit" data-act="adminPassword" data-submit>Set password</button><button class="btn" type="button" data-act="adminRow">Cancel</button></div></form>` : ''}
        </td></tr>`;
    };
    paint(html`<header class="top"><div class="top-in"><span class="brand">Bookr POS admin</span><div class="who">${themeButton()}<span class="person">${ui.admin.name}</span><button type="button" data-act="adminLogout">Sign out</button></div></div></header>
      <main>${flash ? html`<div class="msg ${flash.kind} flash" role="status"><span>${flash.text}</span></div>` : ''}
      ${pageHead('Restaurants', 'Each restaurant is separate: its owners see only the restaurants given to them. You see names, owners and use, never bills, menus or sales.')}
      ${errorBox()}
      <section class="panel"><div class="scroll"><table class="t cards"><thead><tr><th>Restaurant</th><th>Owners</th><th>Status</th><th class="num">Bills this month</th><th>Last used</th><th></th></tr></thead>
        <tbody>${ui.rests.length ? ui.rests.map(row) : html`<tr><td colspan="6" class="quiet">No restaurants yet. Add the first one below.</td></tr>`}</tbody></table></div></section>
      <section class="panel"><form class="grid3"><h2 style="grid-column:1/-1">Add a restaurant</h2>
        <label class="f">Restaurant name<input class="in" data-model="rName" value="${ui.rName ?? ''}"></label>
        <label class="f">Owner's email<input class="in" type="text" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" data-model="rOwnerEmail" data-live="knownOwner" value="${ui.rOwnerEmail ?? ''}"></label>
        ${known ? html`<p class="small quiet" style="grid-column:1/-1">This owner already has a Bookr POS login: the new restaurant is added to it and they keep their password.</p>
          <label class="f">Copy the menu from (optional)<select class="in" data-model="rCopy"><option value="">Start with an empty menu</option>${copyChoices.map((r) => html`<option value="${r.id}" ${ui.rCopy === r.id ? 'selected' : ''}>${r.name}</option>`)}</select></label>`
        : html`<label class="f">Owner's name<input class="in" data-model="rOwnerName" value="${ui.rOwnerName ?? ''}"></label>
          <label class="f">Temporary password (12+ characters)<input class="in" type="password" data-model="rOwnerPassword" autocomplete="new-password"></label>`}
        <div class="row" style="grid-column:1/-1"><button class="btn pri" type="submit" data-act="adminAddRestaurant" data-submit>Add restaurant</button></div></form></section>
      <section class="panel"><details ${ui.showAddAdmin ? 'open' : ''}><summary>Add another admin</summary><form class="grid3" style="margin-top:12px">
        <label class="f">Name<input class="in" data-model="nName"></label><label class="f">Email<input class="in" type="email" data-model="nEmail"></label>
        <label class="f">Password (12+ characters)<input class="in" type="password" data-model="nPassword" autocomplete="new-password"></label>
        <div class="row"><button class="btn pri" type="submit" data-act="adminAddAdmin" data-submit>Add admin</button></div></form></details></section></main>`);
  };
  rerender();
}
actions.adminSetupMode = () => { ui.setupMode = !ui.setupMode; ui.error = null; rerender(); };
actions.adminLogin = async () => { await api('POST', '/admin/login', { email: ui.xEmail ?? '', password: ui.xPassword ?? '' }); route(); };
actions.adminSetup = async () => {
  await api('POST', '/admin/setup', { name: ui.xName ?? '', email: ui.xEmail ?? '', password: ui.xPassword ?? '' }, { 'X-Setup-Token': ui.xToken ?? '' });
  await actions.adminLogin();
};
actions.adminLogout = async () => { await api('POST', '/admin/logout'); route(); };
actions.adminRow = (d) => { ui.rowAct = d.id ? { id: d.id, kind: d.kind } : null; ui.error = null; Object.assign(ui, { oEmail: '', oName: '', oPassword: '', pPassword: '', pOwner: null }); rerender(); };
actions.adminStatus = async (d) => {
  const r = ui.rests.find((x) => x.id === d.id);
  if (d.to === 'paused' && !confirm(`Pause ${r.name}? Everyone there is signed out and cannot sign in until you resume it.`)) return;
  await api('PUT', `/admin/restaurants/${d.id}`, { status: d.to });
  flash = { kind: 'ok', text: `${r.name} ${d.to === 'paused' ? 'paused' : 'resumed'}.` }; route();
};
actions.adminAddOwner = async () => {
  await api('POST', `/admin/restaurants/${ui.rowAct.id}/owners`, { ownerEmail: ui.oEmail ?? '', ownerName: ui.oName || undefined, ownerPassword: ui.oPassword || undefined });
  flash = { kind: 'ok', text: `${ui.oEmail} can now open this restaurant.` }; route();
};
actions.adminPassword = async () => {
  const r = ui.rests.find((x) => x.id === ui.rowAct.id);
  const id = ui.pOwner || r.owners[0].id;
  await api('POST', `/admin/owners/${id}/password`, { password: ui.pPassword ?? '' });
  flash = { kind: 'ok', text: `Password set for ${r.owners.find((o) => o.id === id).name}. Share it with them privately.` }; route();
};
actions.adminVisit = async (d) => { await api('POST', `/admin/restaurants/${d.id}/visit`); me = null; cache = {}; go('#/'); };
actions.adminAddRestaurant = async () => {
  const email = (ui.rOwnerEmail ?? '').trim();
  const known = ui.rests.some((r) => r.owners.some((o) => o.email.toLowerCase() === email.toLowerCase()));
  await api('POST', '/admin/restaurants', known ? { name: ui.rName ?? '', ownerEmail: email, copyFrom: ui.rCopy || undefined }
    : { name: ui.rName ?? '', ownerEmail: email, ownerName: ui.rOwnerName ?? '', ownerPassword: ui.rOwnerPassword ?? '' });
  flash = { kind: 'ok', text: `${ui.rName} added. ${known ? 'The owner sees it in their restaurant list.' : 'Share the temporary password with the owner privately.'}` }; route();
};
actions.adminAddAdmin = async () => {
  await api('POST', '/admin/admins', { name: ui.nName ?? '', email: ui.nEmail ?? '', password: ui.nPassword ?? '' });
  flash = { kind: 'ok', text: `${ui.nName} can now sign in at #/admin.` }; route();
};

const entityBody = (e, change) => ({
  name: e.name, kind: e.kind, gstRegistered: !!e.gst_registered, gstin: e.gstin, gstRateBp: e.gst_rate_bp, seriesPrefix: e.series_prefix,
  yearlyLimit: e.yearly_limit_paise ? rupees(e.yearly_limit_paise) : '', warn1: e.warn1_paise ? rupees(e.warn1_paise) : '', warn2: e.warn2_paise ? rupees(e.warn2_paise) : '',
  stopAt: e.stop_paise ? rupees(e.stop_paise) : '', isDefault: !!e.is_default, offered: !!e.offered, active: !!e.active, ...change,
});
// ---------- the menu as a sheet: download, change in Excel or Google Sheets, check, apply (Owner)
// A file can be the sheet (CSV), an Excel file (.xlsx, read here in the browser), or photos or a PDF of a printed menu
// (read by Claude on the server into the sheet layout). Columns are matched by their headings and can be changed on
// screen; GST and the station are never guessed: when the file has none for a category, it is chosen here once.
const TAX_TEXT = (t) => (t.mode === 'billing' ? 'Billing name rate' : t.mode === 'rate' ? `GST ${t.bp / 100}%` : t.mode === 'liquor' ? 'Liquor, outside GST' : 'No GST');
const TAX_PICK = [['', 'Choose GST'], ['Billing name', 'Billing name rate (food)'], ['GST 5%', 'GST 5%'], ['GST 12%', 'GST 12%'], ['GST 18%', 'GST 18%'], ['GST 28%', 'GST 28%'], ['GST 40%', 'GST 40%'], ['No GST (liquor)', 'Liquor: outside GST'], ['No GST', 'No GST (exempt)']];
const COLUMN_HELP = [
  ['Item', 'The name as on the bill. Needed.'],
  ['Category', 'The menu section (Starters, Bar…). GST is set per category; items that differ keep their own.'],
  ['Price (₹)', 'Before GST: 250, 250.50, ₹1,250. Leave empty, or write MRP or Market price, for price at billing.'],
  ['Price at billing', 'Yes for bottles and other items whose price is typed when ordered. Otherwise empty.'],
  ['Lowest price (₹)', 'For price at billing only: the least that can be typed. Optional.'],
  ['Tax', 'Billing name (its rate, 5% for food), GST 5% / 12% / 18% / 28% / 40%, No GST (liquor), or No GST. Left empty: asked per category.'],
  ['Station', 'Where the KOT goes: a station\u2019s name (Kitchen, Bar, Tandoor…), or No KOT for things that never go to a station. Left empty: asked per category.'],
  ['SAC', 'Optional, 4 to 8 digits. Empty: kept, or 996332 for a new item.'],
];
function menuSheetPanel() {
  const r = ui.upCheck;
  const list = (title, items, show = (x) => x) => (items?.length ? html`<details><summary>${title} (${items.length})</summary><ul class="small">${items.map((x) => html`<li>${show(x)}</li>`)}</ul></details>` : '');
  const colPick = r?.headings ? html`<details ${r.exactHeadings ? '' : 'open'} style="margin-top:12px"><summary>Columns in ${ui.upName} (${r.exactHeadings ? 'as in the sample' : 'matched by their headings: check them'})</summary>
      <div class="scroll"><table class="t"><thead><tr><th>Used as</th><th>Column in the file</th></tr></thead><tbody>
      ${r.fields.map((f) => html`<tr><td>${f.name}${['item', 'price'].includes(f.key) ? ' (needed)' : ''}</td><td><select class="in" data-act-change="upCol" data-f="${f.key}" aria-label="Column for ${f.name}">
        <option value="-1">Not in the file</option>${r.headings.map((h, i) => html`<option value="${i}" ${r.columns[f.key] === i ? 'selected' : ''}>${h || `Column ${i + 1}`}</option>`)}</select></td></tr>`)}
      </tbody></table></div></details>` : '';
  const needs = r?.needs?.length ? html`<div class="msg warn" style="margin-top:12px"><p><strong>Choose for each category</strong> what the file leaves empty. GST is never guessed.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Category</th><th class="num">Items</th><th>GST</th><th>Station</th></tr></thead><tbody>
      ${r.needs.map((n) => { const d = ui.upDefaults[n.category] ?? {}; return html`<tr><td>${n.category}</td><td class="num">${n.items}</td>
        <td>${n.tax ? html`<select class="in" data-model-def="${n.category}" data-k="tax" aria-label="GST for ${n.category}">${TAX_PICK.map(([v, t]) => html`<option value="${v}" ${(d.tax ?? '') === v ? 'selected' : ''}>${t}</option>`)}</select>` : 'From the file'}</td>
        <td>${n.station ? html`<select class="in" data-model-def="${n.category}" data-k="station" aria-label="Station for ${n.category}"><option value="">Choose</option>${[...activeStations().map((x) => x.name), 'No KOT'].map((v) => html`<option ${(d.station ?? '') === v ? 'selected' : ''}>${v}</option>`)}</select>` : 'From the file'}</td></tr>`; })}
      </tbody></table></div><div class="row" style="margin-top:8px"><button class="btn pri" type="button" data-act="upRecheck">Check again</button></div></div>` : '';
  return html`<section class="panel" style="margin-bottom:16px"><h2>Menu sheet</h2>
    <p class="quiet small">Download the menu, change it in Excel or Google Sheets and upload it back. An Excel file, another system's export, or photos or a PDF of a printed menu also work.
      You see every change before anything is changed. Items are matched by name (and category); items not in the file are taken off the menu, and old bills keep them.</p>
    <div class="row"><a class="btn" href="/api${B()}/menu/sheet" download="menu.csv">Download menu</a><a class="btn" href="/api${B()}/menu/sample" download="menu-sample.csv">Download a sample</a>
      ${can('menu.upload') ? html`<label class="btn pri">${ui.upReading ?? 'Upload menu'}<input type="file" multiple accept=".csv,text/csv,.xlsx,image/jpeg,image/png,application/pdf" data-menu-file class="vh"></label>` : ''}</div>
    <details style="margin-top:10px"><summary>What the columns mean</summary><div class="scroll"><table class="t"><tbody>${COLUMN_HELP.map(([k, v]) => html`<tr><th style="white-space:nowrap">${k}</th><td class="small">${v}</td></tr>`)}</tbody></table></div>
      <p class="small quiet">Column order does not matter, and other columns are skipped. Other headings are understood too (Rate, MRP, Item Name, Group, Department, KOT, HSN…). Add-ons and choices are not in the sheet for now: set them in the Add-ons tab; uploading keeps each dish's add-ons as they are.</p></details>
    ${ui.upRead ? html`<p class="small" style="margin-top:10px">${ui.upRead} <a href="#" data-act="upReadCsv">Download what was read</a> to correct it in a sheet if you prefer.</p>` : ''}
    ${r ? html`<div class="msg ${r.ok ? 'ok' : 'bad'}" style="margin-top:14px" role="status">
      ${r.ok ? html`<p><strong>${ui.upName}: ready to apply.</strong> Nothing has changed yet.</p>` : html`<p><strong>${ui.upName}: ${r.errorCount ? `${plural(r.errorCount, 'thing')} to fix` : 'not ready'}</strong> before it can be applied.</p>
        <ul class="small">${(r.errors ?? []).map((e) => html`<li>${e}</li>`)}</ul>${r.errorCount > (r.errors ?? []).length ? html`<p class="small">…and ${r.errorCount - r.errors.length} more.</p>` : ''}`}</div>
      ${colPick}${needs}
      ${r.ok ? html`<div class="kpis" style="margin-top:12px">${kpi('Items on the menu', String(r.items), `${r.openPrice} with price at billing`)}${kpi('New', String(r.added.length), r.back.length ? `${r.back.length} back on the menu` : 'Not on the menu before')}
        ${kpi('Price changes', String(r.priceChanges.length), `${r.otherChanges.length} other changes`)}${kpi('Taken off', String(r.off.length), 'Kept for old bills', r.off.length ? 'warn' : 'good')}</div>
        ${errorBox()}
        ${list('Price changes', r.priceChanges, (x) => `${x.name}: ${rs(x.from)} → ${rs(x.to)}`)}
        ${list('New items', r.added)}${list('Back on the menu', r.back)}${list('Taken off the menu', r.off)}
        ${list('Other changes', r.otherChanges, (x) => `${x.name}: ${x.what.join('; ')}`)}
        ${list('GST by category', r.categories, (c) => `${c.name}: ${TAX_TEXT(c.tax)}${c.was && (c.was.mode !== c.tax.mode || c.was.bp !== c.tax.bp) ? ` (was ${TAX_TEXT(c.was)})` : c.was ? '' : ' (new category)'}`)}
        ${list('Items with their own GST', r.notes)}
        ${list('Add-ons', r.groups, (g) => `${g.name} (${g.def.kind === 'one' ? 'pick one' : 'add any'}): ${g.def.options.map((o) => `${o.name}${o.addPaise ? ' +' + rs(o.addPaise) : ''}`).join(' / ')} · ${plural(g.items, 'item')}${g.was ? '' : ' · new'}`)}
        ${r.off.length > 20 && r.off.length * 2 > r.off.length + r.items - r.added.length ? html`<label class="msg warn" style="display:flex;gap:10px;align-items:center;margin-top:12px"><input type="checkbox" data-model="upSure" data-live ${ui.upSure ? 'checked' : ''}>
          <span><strong>${plural(r.off.length, 'item')} will be taken off the menu</strong>: more than the file keeps. Tick if this file is meant to be the whole menu.</span></label>` : ''}
        <div class="row" style="margin-top:12px"><button class="btn go" type="button" data-act="upApply" ${r.off.length > 20 && r.off.length * 2 > r.off.length + r.items - r.added.length && !ui.upSure ? 'disabled' : ''}>Apply this menu${r.off.length ? ` (${r.off.length} taken off)` : ''}</button><button class="btn" type="button" data-act="upCancel">Cancel</button></div>`
      : html`${errorBox()}<div class="row" style="margin-top:8px"><button class="btn" type="button" data-act="upCancel">Close</button></div>`}` : ui.upName ? errorBox() : ''}
    ${can('menu.upload') && ui.uploads?.length ? html`<details style="margin-top:12px"><summary>Menus uploaded before (${ui.uploads.length})</summary><ul class="small">
      ${ui.uploads.map((u) => html`<li><a href="/api${B()}/menu/uploads/${u.name}" download>${dateTime(u.at)}</a> · ${u.by ?? ''} · ${plural(u.items, 'item')}</li>`)}</ul></details>` : ''}
  </section>`;
}

// Excel (.xlsx) in the browser: an .xlsx is a zip of XML files; the first sheet becomes CSV rows. No library needed.
async function xlsxRows(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let e = buf.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This Excel file could not be opened. Save it as CSV and upload that.');
  const files = new Map();
  let p = dv.getUint32(e + 16, true);
  for (let n = dv.getUint16(e + 10, true); n > 0; n--) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    const off = dv.getUint32(p + 42, true);
    files.set(name, { method, size, off });
    p += 46 + nl + xl + cl;
  }
  const read = async (name) => {
    const f = files.get(name); if (!f) return null;
    const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
    const raw = buf.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(raw);
    if (f.method !== 8) throw new Error('This Excel file could not be opened. Save it as CSV and upload that.');
    return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  };
  const xml = (t) => new DOMParser().parseFromString(t, 'application/xml');
  const shared = [...xml((await read('xl/sharedStrings.xml')) ?? '<sst/>').getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  const wb = xml(await read('xl/workbook.xml'));
  const rels = xml((await read('xl/_rels/workbook.xml.rels')) ?? '<Relationships/>');
  const first = wb.getElementsByTagName('sheet')[0];
  const rid = first?.getAttribute('r:id') ?? first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const target = [...rels.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid)?.getAttribute('Target') ?? 'worksheets/sheet1.xml';
  const sheet = xml(await read(target.startsWith('/') ? target.slice(1) : `xl/${target}`));
  const col = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  return [...sheet.getElementsByTagName('row')].map((row) => {
    const out = [];
    for (const c of row.getElementsByTagName('c')) {
      const t = c.getAttribute('t'); const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? [...c.getElementsByTagName('t')].map((x) => x.textContent).join('') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
      if (!t && /^-?\d+\.\d{3,}$/.test(val)) val = String(Math.round(Number(val) * 100) / 100);
      out[col(c.getAttribute('r') ?? '')] = val;
    }
    return Array.from(out, (x) => x ?? '');
  });
}
const csvOf = (rows) => rows.map((r) => r.map((v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\n');

/** Photos or a PDF of a printed menu: each read by Claude on the server; the rows joined into one sheet. */
async function readMenuPages(files) {
  const all = [];
  for (const [i, f] of files.entries()) {
    ui.upReading = `Reading page ${i + 1} of ${files.length}…`; rerender();
    const r = await fetch(`/api${B()}/menu/upload/read`, { method: 'POST', headers: { 'Content-Type': f.type }, body: f, credentials: 'same-origin' });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(data?.error ?? 'Could not read the menu.', r.status);
    const rows = parseCsvRows(data.csv);
    all.push(...(all.length ? rows.slice(1) : rows));
  }
  return all;
}
function parseCsvRows(t) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

async function upCheckNow() {
  ui.upReading = 'Checking…'; rerender();
  try {
    ui.upCheck = await api('POST', `${B()}/menu/upload/check`, { csv: ui.upCsv, columns: ui.upCols ?? undefined, defaults: ui.upDefaults });
  } finally { ui.upReading = null; rerender(); }
}
root.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset?.modelDef !== undefined) { (ui.upDefaults[el.dataset.modelDef] ??= {})[el.dataset.k] = el.value || undefined; return; }
  if (!el.matches?.('[data-menu-file]') || !el.files?.length) return;
  const files = [...el.files];
  Object.assign(ui, { error: null, upCheck: null, upCols: null, upDefaults: {}, upRead: null, upSure: false, upName: files.map((f) => f.name).join(', ') });
  try {
    const pages = files.filter((f) => /^image\/(jpeg|png)$|^application\/pdf$/.test(f.type));
    if (pages.length && pages.length !== files.length) throw new Error('Upload either one sheet, or photos and PDFs of a printed menu, not both at once.');
    if (!pages.length && files.length > 1) throw new Error('Upload one sheet at a time.');
    const f = files[0];
    if (pages.length) {
      if (pages.length > 10) throw new Error('At most 10 pages at a time.');
      const rows = await readMenuPages(pages);
      ui.upCsv = csvOf(rows);
      ui.upRead = `Claude read ${plural(rows.length - 1, 'item')} from ${plural(pages.length, 'page')}. Check the prices against the menu before applying.`;
    } else if (/\.xlsx$/i.test(f.name)) { if (f.size > 5 * 1024 * 1024) throw new Error('The file is larger than 5 MB.'); ui.upReading = 'Opening…'; rerender(); ui.upCsv = csvOf(await xlsxRows(f)); }
    else if (/\.xls$/i.test(f.name)) throw new Error('This is an old Excel file (.xls). In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV, and upload that.');
    else { if (f.size > 1024 * 1024) throw new Error('The file is larger than 1 MB.'); ui.upCsv = await f.text(); }
    if (ui.upCsv.length > 1024 * 1024) throw new Error('The menu is larger than 1 MB as a sheet.');
    await upCheckNow();
  } catch (e) { ui.error = e.message; ui.upReading = null; rerender(); } finally { el.value = ''; }
});
actions.upCol = async (d, el) => { ui.upCols = { ...(ui.upCols ?? ui.upCheck.columns), [d.f]: Number(el.value) }; await upCheckNow(); };
actions.upRecheck = () => upCheckNow();
actions.upReadCsv = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + ui.upCsv], { type: 'text/csv' })); a.download = 'menu-read.csv'; a.click(); };
actions.upCancel = () => { Object.assign(ui, { upCheck: null, upCsv: null, upCols: null, upRead: null, upName: null, error: null }); rerender(); };
actions.upApply = async () => {
  const r = await api('POST', `${B()}/menu/upload/apply`, { csv: ui.upCsv, columns: ui.upCols ?? undefined, defaults: ui.upDefaults, planHash: ui.upCheck.planHash });
  flash = { kind: 'ok', text: `Menu applied: ${plural(r.items, 'item')}, ${r.added} new, ${r.priceChanges} price changes, ${r.off} taken off. The counter shows it at its next refresh.` };
  route();
};

// ---------- add-ons and choices in Settings (approved 19 Nov 2026): a "pick one" names its options and each dish sets its own
// full prices; an "add any" has a usual price, which a dish can change. Tick boxes on the item, a new add-on made in
// place, and many dishes ticked (and priced) at once from the Add-ons tab.
const rupeesShort = (p) => rupees(p).replace(/\.00$/, '');
const optLine = (g) => g.kind === 'one' ? g.options.map((o) => `${o.name}${o.addPaise ? ' +' + rs(o.addPaise) : ''}`).join(' / ')
  : g.options.map((o) => (pkey(o.name) === pkey(g.name) ? '' : o.name + ' ') + (o.addPaise ? 'usual ' + rs(o.addPaise) : 'free')).join(' / ');
const kindTag = (g) => html`<span class="${g.kind === 'one' ? 'tag-one' : 'tag-any'}">${g.kind === 'one' ? 'Pick one' : 'Add any'}</span>`;
/** One price box: data-pf names the form ("item" or a dish id in the Add-ons tab), data-g the add-on, data-o the option. */
const priceBox = (form, g, o, value, label) => html`<label class="pbox">${label ?? ''}<span class="money"><i>₹</i><input class="in" inputmode="decimal" data-pf="${form}" data-g="${g.id}" data-o="${pkey(o.name)}" value="${value ?? ''}" aria-label="${o.name} price"></span></label>`;
/** Prices to send for one add-on on one dish: a "pick one" all its typed prices; an "add any" only those that differ from usual. */
function pricesOut(g, typed) {
  if (!typed) return null;
  const out = {};
  for (const o of g.options) {
    const v = String(typed[pkey(o.name)] ?? '').trim();
    if (!v) continue;
    if (g.kind === 'any' && toPaise(v) === o.addPaise) continue;
    out[pkey(o.name)] = v;
  }
  return Object.keys(out).length ? out : null;
}
const groupById = (id) => cache.addonGroups.find((x) => x.id === id);
const itemPricesOut = (id) => pricesOut(groupById(id), ui.iPrices?.[id]);
/** The dish's price from a ticked, fully priced "pick one": its first option's typed price. */
function choicePrice() {
  for (const id of ui.iGroups ?? []) {
    const g = groupById(id);
    if (g?.kind !== 'one') continue;
    const t = ui.iPrices?.[id] ?? {};
    if (g.options.every((o) => toPaise(t[pkey(o.name)] ?? '') !== null)) return String(t[pkey(g.options[0].name)]).trim();
  }
  return null;
}

/** The new-or-edit box for an add-on. State in ui.gd: { id, kind, name, price, several, legacy, options: [{ name, price }] }. */
function groupBox(title, createLabel) {
  const d = ui.gd;
  const one = d.kind === 'one';
  const rows = one || d.several;
  return html`<div class="gbox" role="group" aria-label="${title}"><p class="gbox-h">${title}</p>
    <div class="seg" role="radiogroup" aria-label="Kind">
      <label><input type="radio" name="gdKind" value="any" data-act-change="gdKind" ${!one ? 'checked' : ''}><b>Add any</b><span>An extra the guest may add, like cheese. One usual price.</span></label>
      <label><input type="radio" name="gdKind" value="one" data-act-change="gdKind" ${one ? 'checked' : ''}><b>Pick one</b><span>The guest must choose, like Half / Full. Each dish sets its prices.</span></label></div>
    ${!rows ? html`<div class="gtwo"><label class="f">Name<input class="in" data-gd="name" value="${d.name}" placeholder="Extra Cheese"></label>
        <label class="f">Usual price<span class="money"><i>₹</i><input class="in" data-gd="price" inputmode="decimal" value="${d.price ?? ''}" placeholder="50"></span></label></div>
        <p class="small quiet" style="margin:0">Several extras under one name, like Toppings: Olives / Corn? <button class="btn ghost" type="button" data-act="gdSeveral">Add several options</button></p>`
    : html`<label class="f">Name<input class="in" data-gd="name" value="${d.name}" placeholder="${one ? 'Half or Full' : 'Toppings'}"></label>
      <div class="f">${one ? 'Options (names only; each dish sets its own prices)' : 'Options and usual prices'}
        ${d.options.map((o, i) => html`<div class="optrow ${one && !d.legacy ? 'noprice' : ''}"><input class="in" data-gdo="${i}" data-k="name" value="${o.name}" placeholder="${one ? (i ? 'Full' : 'Half') : 'Olives'}" aria-label="Option ${i + 1} name">
          ${one && !d.legacy ? '' : html`<span class="money"><i>${one ? '+₹' : '₹'}</i><input class="in" data-gdo="${i}" data-k="price" inputmode="decimal" value="${o.price}" aria-label="Option ${i + 1} price"></span>`}
          <button class="btn" type="button" data-act="gdOptX" data-i="${i}" aria-label="Remove option ${i + 1}" ${d.options.length < (one ? 3 : 2) ? 'disabled' : ''}>×</button></div>`)}
        <div><button class="btn ghost" type="button" data-act="gdOptAdd">+ another option</button></div>
        ${one && d.legacy ? html`<p class="small quiet" style="margin:0">+₹ amounts are used only on dishes without their own prices.</p>` : ''}</div>`}
    <div class="row"><button class="btn pri" type="button" data-act="gdSave">${createLabel}</button><button class="btn" type="button" data-act="gdCancel">Cancel</button></div></div>`;
}
function gdBody() {
  const d = ui.gd;
  if (d.kind === 'any' && !d.several) return { name: d.name.trim(), kind: 'any', options: [{ name: d.name.trim(), price: String(d.price ?? '').trim() }] };
  const options = d.options.filter((o) => o.name.trim()).map((o) => ({ name: o.name.trim(), price: d.kind === 'one' && !d.legacy ? '' : String(o.price ?? '').trim() }));
  return { name: d.name.trim() || (d.kind === 'one' ? options.map((o) => o.name).join(' or ') : ''), kind: d.kind, options };
}
const gdOf = (g) => {
  const single = g.kind === 'any' && g.options.length === 1 && pkey(g.options[0].name) === pkey(g.name);
  return { id: g.id, kind: g.kind, name: g.name, price: single ? rupeesShort(g.options[0].addPaise) : '', several: g.kind === 'any' && !single,
    legacy: g.kind === 'one' && g.options.some((o) => o.addPaise), options: g.options.map((o) => ({ name: o.name, price: o.addPaise ? rupeesShort(o.addPaise) : '' })) };
};
const newGd = (kind = 'one') => ({ id: null, kind, name: '', price: '', several: false, legacy: false, options: [{ name: '', price: '' }, { name: '', price: '' }] });
async function reloadMenu() { const d = await api('GET', `${B()}/menu`); cache.menu = d.items; cache.menuCats = d.categories ?? []; cache.addonGroups = d.addonGroups ?? []; cache.stations = d.stations ?? []; }

function itemAddons() {
  const on = ui.iGroups ?? [];
  const name = ui.iName || 'this dish';
  return html`<div class="ticks" role="group" aria-labelledby="ia-h"><div class="ticks-h"><span id="ia-h">Add-ons and choices for this item</span><span class="quiet small">${on.length ? `${on.length} ticked` : 'none ticked'}</span></div>
    ${cache.addonGroups.length ? '' : html`<p class="small quiet" style="padding:10px 14px;margin:0">No add-ons yet. Make the first one below.</p>`}
    ${cache.addonGroups.map((g) => {
      const ticked = on.includes(g.id);
      const t = ui.iPrices?.[g.id] ?? {};
      return html`<div class="atick ${ticked ? 'on' : ''}"><label class="atick-l"><input type="checkbox" data-act-change="iGroupTick" data-id="${g.id}" ${ticked ? 'checked' : ''}>
        <span class="nm">${g.name}</span>${kindTag(g)}<span class="opts">${g.kind === 'one' ? `${g.options.map((o) => o.name).join(' / ')} · prices set per dish` : optLine(g)}</span></label>
        ${ticked ? html`<div class="aprices">${g.options.map((o) => priceBox('item', g, o, t[pkey(o.name)] ?? (g.kind === 'any' ? rupeesShort(o.addPaise) : ''), g.kind === 'one' || g.options.length > 1 ? o.name : 'Price'))}
          <span class="pnote">${g.kind === 'one' ? html`Full prices for <b>${name}</b>, not extra amounts. The dish's price is the ${g.options[0]?.name} price.${g.options.some((o) => o.addPaise) ? ` Left empty: ${optLine(g)}.` : ''}`
            : pricesOut(g, t) ? html`<span class="changed">Changed for this dish (usual ${g.options.map((o) => rs(o.addPaise)).join(' / ')})</span>` : 'The usual price; change it for this dish if needed.'}</span></div>` : ''}</div>`;
    })}
  </div>
  ${ui.gd && ui.gdFor === 'item' ? groupBox('New add-on or choice', 'Create and tick') : html`<button class="btn ghost" type="button" data-act="gdNewItem" style="margin-top:6px">+ New add-on or choice</button>`}`;
}
actions.iGroupTick = (d, el) => { const g = ui.iGroups ?? []; ui.iGroups = el.checked ? [...g, d.id] : g.filter((x) => x !== d.id); rerender(); };
actions.gdNewItem = () => { ui.gd = newGd('one'); ui.gdFor = 'item'; ui.error = null; rerender(); root.querySelector('[data-gd="name"]')?.focus(); };
actions.gdKind = (d, el) => { ui.gd.kind = el.value; while (el.value === 'one' && ui.gd.options.length < 2) ui.gd.options.push({ name: '', price: '' }); rerender(); };
actions.gdSeveral = () => { const d = ui.gd; d.several = true; d.options = [{ name: d.name, price: d.price ?? '' }, { name: '', price: '' }]; if (d.options[0].name) d.name = ''; rerender(); };
actions.gdOptAdd = () => { ui.gd.options.push({ name: '', price: '' }); rerender(); root.querySelectorAll('[data-gdo][data-k="name"]')[ui.gd.options.length - 1]?.focus(); };
actions.gdOptX = (d) => { ui.gd.options.splice(Number(d.i), 1); rerender(); };
actions.gdCancel = () => { ui.gd = null; ui.error = null; if (ui.gdFor === 'tab' && !ui.gSel) ui.gSel = cache.addonGroups[0]?.id ?? null; rerender(); };
actions.gdSave = async () => {
  const body = gdBody();
  if (!body.name) throw new Error('Give the add-on a name.');
  if (ui.gd.id) await api('PUT', `${B()}/addon-groups/${ui.gd.id}`, body);
  const id = ui.gd.id ?? (await api('POST', `${B()}/addon-groups`, body)).id;
  await reloadMenu();
  if (ui.gdFor === 'item') ui.iGroups = [...new Set([...(ui.iGroups ?? []), id])];
  if (ui.gdFor === 'tab') gSelect(id);
  flash = { kind: 'ok', text: `${body.name} ${ui.gd.id ? 'saved' : ui.gdFor === 'item' ? `created and ticked${body.kind === 'one' ? ': type its prices for this dish' : ''}` : 'created. Tick the dishes that offer it.'}.` };
  ui.gd = null; ui.error = null; rerender();
};
root.addEventListener('input', (ev) => {
  const el = ev.target;
  const ds = el.dataset ?? {};
  if (ds.pf === 'item') {
    ((ui.iPrices ??= {})[ds.g] ??= {})[ds.o] = el.value;
    // The dish's price follows the first choice's price as it is typed.
    const g = groupById(ds.g);
    if (g?.kind === 'one' && pkey(g.options[0]?.name ?? '') === ds.o && ui.iOpen !== 'yes') { const p = root.querySelector('[data-model="iPrice"]'); if (p) { p.value = el.value; ui.iPrice = el.value; } }
    return;
  }
  if (ds.pf) { ((ui.gPrices ??= {})[ds.pf] ??= {})[ds.o] = el.value; return; }
  if (!ui.gd) return;
  if (ds.gd) ui.gd[ds.gd] = el.value;
  if (ds.gdo !== undefined) ui.gd.options[Number(ds.gdo)][ds.k] = el.value;
});

/** Settings → Add-ons: the list on the left; the chosen one's dishes, ticked and priced, on the right. */
function gSelect(id) {
  ui.gSel = id;
  const g = groupById(id);
  ui.gItems = cache.menu.filter((m) => (m.addonGroups ?? []).includes(id)).map((m) => m.id);
  ui.gPrices = Object.fromEntries(cache.menu.filter((m) => m.addonPrices?.[id]).map((m) => [m.id, Object.fromEntries(Object.entries(m.addonPrices[id]).map(([k, v]) => [k, rupeesShort(v)]))]));
  if (g?.kind === 'any') for (const mid of ui.gItems) ui.gPrices[mid] ??= Object.fromEntries(g.options.map((o) => [pkey(o.name), rupeesShort(o.addPaise)]));
}
function addonsTab() {
  const gs = cache.addonGroups;
  if (ui.gSel === undefined) gSelect(gs[0]?.id ?? null);
  const g = groupById(ui.gSel);
  const count = (id) => cache.menu.filter((m) => m.active && (m.addonGroups ?? []).includes(id)).length;
  const on = new Set(ui.gItems ?? []);
  const shown = gShown(on);
  const cats = [...new Set(shown.map((m) => m.category))];
  const items = (c) => shown.filter((m) => m.category === c);
  const filtering = !!String(ui.gQ ?? '').trim() || ui.gOnly;
  return html`<section class="panel"><h2>Add-ons and choices</h2>
    <p class="quiet small">"Pick one" is a choice the order must make (Half or Full); each dish has its own prices for it. "Add any" is an extra (Peri Peri Fries, Extra Cheese) at its usual price unless a dish says otherwise. Choose one on the left, then tick the dishes that offer it. Old orders keep the names and prices they were taken with.</p>
    ${errorBox()}
    <div class="gsplit">
      <div class="glist">${gs.map((x) => html`<button type="button" class="gcard" aria-pressed="${x.id === ui.gSel && !ui.gd}" data-act="gSel" data-id="${x.id}"><b>${x.name}</b>
          <small>${x.kind === 'one' ? `Pick one · ${x.options.map((o) => o.name).join(' / ')}` : `Add any · ${optLine(x)}`} · ${plural(count(x.id), 'dish', 'dishes')}</small></button>`)}
        <button class="btn ghost" type="button" data-act="gdNewTab" style="justify-self:start">+ New add-on or choice</button></div>
      <div class="gmain">
        ${ui.gd && ui.gdFor === 'tab' ? groupBox(ui.gd.id ? `Edit ${ui.gd.name}` : 'New add-on or choice', ui.gd.id ? 'Save add-on' : 'Create')
          : g ? html`<div class="row" style="justify-content:space-between"><h3 style="margin:0">${g.name} ${kindTag(g)}</h3>
              <button class="btn" type="button" data-act="gdEdit">Change name or options</button></div>
            <p class="small quiet" style="margin:0">${g.kind === 'one' ? `Tick the dishes that offer it and type each dish's full prices (${g.options.map((o) => o.name).join(', ')}).` : `Ticked dishes get the usual ${g.options.map((o) => rs(o.addPaise)).join(' / ')}; change it for a dish if needed.`}</p>
            <div class="gtools"><input class="in" type="search" data-model="gQ" data-live value="${ui.gQ ?? ''}" placeholder="Search dishes or categories" aria-label="Search dishes">
              <button type="button" class="chip" aria-pressed="${!!ui.gOnly}" data-act="gOnly">Ticked only</button>
              <span class="gcount">Offered on ${plural(on.size, 'dish', 'dishes')}</span>
              <button class="btn pri" type="button" data-act="gSaveItems">Save</button></div>
            ${shown.length ? '' : html`<p class="quiet">${ui.gOnly && !String(ui.gQ ?? '').trim() ? 'No dish is ticked yet.' : `No dish matches “${ui.gQ}”.`}</p>`}
            ${cats.length > 1 && !filtering ? html`<div class="row" style="gap:6px"><button class="btn ghost" type="button" data-act="gOpenAll">Open all</button><button class="btn ghost" type="button" data-act="gCloseAll">Close all</button></div>` : ''}
            ${cats.map((c) => { const its = items(c); const n = its.filter((m) => on.has(m.id)).length; const open = filtering || ui.gOpen?.includes(c); return html`<div class="gcat"><div class="gcat-h">
              <button type="button" class="gcat-t" data-act="gToggle" data-cat="${c}" aria-expanded="${open}"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span><b>${c}</b><span class="small quiet">${n ? `${n} of ${its.length} ticked` : plural(its.length, 'dish', 'dishes')}</span></button>
              <label class="small"><input type="checkbox" data-act-change="gTickCat" data-cat="${c}" ${n === its.length ? 'checked' : ''}>${filtering ? `Tick all ${its.length} shown` : 'Tick all'}</label></div>
              ${open ? html`<div class="grows">${its.map((m) => html`<div class="grow-r"><label><input type="checkbox" data-act-change="gTickItem" data-id="${m.id}" ${on.has(m.id) ? 'checked' : ''}><span>${m.name}</span></label>
                <span class="gps">${on.has(m.id) ? g.options.map((o) => priceBox(m.id, g, o, ui.gPrices?.[m.id]?.[pkey(o.name)] ?? '', g.kind === 'one' || g.options.length > 1 ? o.name : '')) : html`<span class="quiet small">${m.openPrice ? 'typed' : rs(m.pricePaise)}</span>`}</span></div>`)}</div>` : ''}</div>`; })}
            <div class="row"><button class="btn pri" type="button" data-act="gSaveItems">Save · ${plural(on.size, 'dish', 'dishes')}</button></div>`
          : html`<p class="quiet">No add-ons yet. Make the first one with "New add-on or choice".</p>`}
      </div></div></section>`;
}
actions.gSel = (d) => { ui.gd = null; gSelect(d.id); ui.error = null; ui.gOnly = false; rerender(); };
actions.gdNewTab = () => { ui.gd = newGd('any'); ui.gdFor = 'tab'; ui.error = null; rerender(); root.querySelector('[data-gd="name"]')?.focus(); };
actions.gdEdit = () => { ui.gd = gdOf(groupById(ui.gSel)); ui.gdFor = 'tab'; rerender(); };
const gTick = (id, yes) => {
  const g = groupById(ui.gSel);
  const s2 = new Set(ui.gItems);
  if (yes) { s2.add(id); if (g.kind === 'any') (ui.gPrices ??= {})[id] ??= Object.fromEntries(g.options.map((o) => [pkey(o.name), rupeesShort(o.addPaise)])); } else s2.delete(id);
  ui.gItems = [...s2];
};
actions.gTickItem = (d, el) => { gTick(d.id, el.checked); rerender(); };
// The dishes the list shows: matching the search (name or category, any word order) and, if asked, only those ticked.
function gShown(on) {
  const words = String(ui.gQ ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return cache.menu.filter((m) => m.active && (!ui.gOnly || on.has(m.id))
    && words.every((w) => m.name.toLowerCase().includes(w) || m.category.toLowerCase().includes(w)));
}
actions.gOnly = () => { ui.gOnly = !ui.gOnly; rerender(); };
// Categories start closed; open one to tick its dishes one by one (searching or "Ticked only" shows them open).
actions.gToggle = (d) => { const o = new Set(ui.gOpen ?? []); o.has(d.cat) ? o.delete(d.cat) : o.add(d.cat); ui.gOpen = [...o]; rerender(); };
actions.gOpenAll = () => { ui.gOpen = [...new Set(cache.menu.filter((m) => m.active).map((m) => m.category))]; rerender(); };
actions.gCloseAll = () => { ui.gOpen = []; rerender(); };
// "Tick all" ticks the dishes shown in that category (all of them when nothing is searched).
actions.gTickCat = (d, el) => { for (const m of gShown(new Set(ui.gItems)).filter((x) => x.category === d.cat)) gTick(m.id, el.checked); rerender(); };
actions.gSaveItems = async () => {
  const g = groupById(ui.gSel);
  // Dishes off the menu keep this add-on, with their own prices; only the dishes shown are changed.
  const off = cache.menu.filter((m) => !m.active && (m.addonGroups ?? []).includes(ui.gSel))
    .map((m) => ({ id: m.id, prices: m.addonPrices?.[ui.gSel] ? Object.fromEntries(Object.entries(m.addonPrices[ui.gSel]).map(([k, v]) => [k, rupees(v)])) : null }));
  await api('PUT', `${B()}/addon-groups/${ui.gSel}/items`, { items: [...ui.gItems.map((id) => ({ id, prices: pricesOut(g, ui.gPrices?.[id]) })), ...off] });
  await reloadMenu();
  gSelect(ui.gSel);
  flash = { kind: 'ok', text: `${g.name}: offered on ${plural(ui.gItems.length, 'dish', 'dishes')}.` }; rerender();
};

// ---------- KOT stations (approved 19 Nov 2026): where each dish's KOT goes, set per category and per item like GST

const activeStations = () => (cache.stations ?? []).filter((x) => x.active);
const stationName = (id) => (cache.stations ?? []).find((x) => x.id === id)?.name ?? '';
const catOfItem = (m) => (cache.menuCats ?? []).find((c) => c.name.toLowerCase() === m.category.toLowerCase());
/** Where an item's KOT goes, as words: its station, or "No KOT"; "(category)" when it follows its category. */
function routeOf(m) {
  const c = catOfItem(m);
  const kot = m.kot ?? c?.kot ?? 1;
  const own = m.kot != null || m.stationId;
  if (!kot) return html`No KOT${own ? '' : html` <span class="quiet small">· category</span>`}`;
  return html`${stationName(m.stationId ?? c?.stationId) || m.station}${own ? '' : html` <span class="quiet small">· category</span>`}`;
}
function itemKotFields() {
  const c = (cache.menuCats ?? []).find((x) => x.name.toLowerCase() === String(ui.iCat ?? '').trim().toLowerCase());
  const catKot = c ? (c.kot === 0 ? 'No KOT' : 'Print KOT') : 'Print KOT';
  const kot = ui.iKot ?? 'category';
  const sends = kot === 'yes' || (kot === 'category' && c?.kot !== 0);
  return html`<label class="f">KOT<select class="in" data-model="iKot"><option value="category">From its category (${catKot})</option>
      <option value="yes" ${kot === 'yes' ? 'selected' : ''}>Print KOT</option><option value="no" ${kot === 'no' ? 'selected' : ''}>No KOT (bill only)</option></select></label>
    ${sends ? html`<label class="f">Station<select class="in" data-model="iStationId"><option value="">From its category${c?.stationId ? ` (${stationName(c.stationId)})` : ''}</option>
      ${activeStations().map((x) => html`<option value="${x.id}" ${ui.iStationId === x.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>`
      : html`<div class="f small quiet" style="align-self:end;padding-bottom:12px">No KOT: on the order and bill, never sent to a station.</div>`}`;
}
actions.catKot = async (d, el) => { await api('PUT', `${B()}/menu-categories/${d.id}`, { kot: el.value === 'yes' }); await reloadMenu(); flash = { kind: 'ok', text: 'Saved.' }; rerender(); };
actions.catStation = async (d, el) => { await api('PUT', `${B()}/menu-categories/${d.id}`, { stationId: el.value }); await reloadMenu(); flash = { kind: 'ok', text: `KOTs for ${catName(d.id)} now go to ${stationName(el.value)}.` }; rerender(); };
const catName = (id) => (cache.menuCats ?? []).find((c) => c.id === id)?.name ?? '';

const HOW = [['paper', 'Paper', 'Prints at once'], ['screen', 'Screen', 'Tickets to tap ready'], ['both', 'Screen and paper', 'Screen, and a slip']];
function stationsTab() {
  const sts = cache.stations ?? [];
  const uses = (id) => cache.menuCats.filter((c) => c.stationId === id && c.kot !== 0).map((c) => c.name);
  return html`<section class="panel"><div class="row" style="justify-content:space-between"><h2>Stations</h2><button class="btn pri" type="button" data-act="stNew">+ New station</button></div>
    <p class="quiet small">Where KOTs go. Each station gets them on paper, on a screen, or both, at a tablet or PC set up as that station's device (with its thermal printer for paper).
      When a station's device is off or offline, its KOTs print at the counter instead, so nothing is missed. Categories and items choose their station.</p>${errorBox()}
    ${ui.stNew ? html`<form class="stcard" style="border-color:var(--pri)"><label class="f">Name<input class="in" data-model="stName" value="${ui.stName ?? ''}" placeholder="Tandoor, Chinese, Dessert counter" autofocus></label>
      <div class="row"><button class="btn pri" type="submit" data-act="stAdd" data-submit>Add station</button><button class="btn" type="button" data-act="stNo">Cancel</button></div></form>` : ''}
    <div class="stgrid">${sts.map((x) => html`<div class="stcard ${x.active ? '' : 'off'}"><div class="row" style="justify-content:space-between"><b class="stname">${x.name}</b>
        ${!x.active ? html`<span class="tag-any">Not in use</span>` : x.devices ? html`<span class="${x.online ? 'pill-on' : 'pill-off'}">${x.online ? 'Device online' : `Device offline${x.lastSeenAt ? ` · seen ${since(x.lastSeenAt)} ago` : ''}`}</span>` : html`<span class="pill-off">No device yet</span>`}</div>
      <div class="how" role="radiogroup" aria-label="How ${x.name} gets KOTs">${HOW.map(([v, t, sub]) => html`<label><input type="radio" name="how-${x.id}" value="${v}" data-act-change="stHow" data-id="${x.id}" ${x.how === v ? 'checked' : ''}>${t}<span>${sub}</span></label>`)}</div>
      <div class="row">${x.how !== 'screen' ? html`<label class="f" style="width:110px">Copies<select class="in" data-act-change="stCopies" data-id="${x.id}">${[1, 2, 3].map((n) => html`<option ${x.copies === n ? 'selected' : ''}>${n}</option>`)}</select></label>` : ''}
        <label class="chk"><input type="checkbox" data-act-change="stBar" data-id="${x.id}" ${x.isBar ? 'checked' : ''}>Bar station (bar stock and reports)</label></div>
      <p class="small quiet" style="margin:0">${uses(x.id).length ? `Categories: ${uses(x.id).join(', ')}` : 'No category sends KOTs here yet. Choose it in Categories.'}</p>
      <div class="row">${can('staff.manage') && x.active ? html`<button class="btn" type="button" data-act="stDevice" data-id="${x.id}">Make this browser ${x.name}'s device</button>` : ''}
        ${ui.stRen === x.id ? html`<input class="in" style="max-width:180px" data-model="stRenName" value="${ui.stRenName ?? ''}" aria-label="New name"><button class="btn pri" type="button" data-act="stRenameGo" data-id="${x.id}">Save</button>`
          : iconBtn('stRename', x.id, 'edit', `Rename ${x.name}`)}
        <button class="btn ghost" type="button" data-act="stActive" data-id="${x.id}">${x.active ? 'Stop using' : 'Use again'}</button></div></div>`)}</div>
    <details style="margin-top:6px"><summary>Setting up a station's device</summary><ol class="small">
      <li>On the tablet or PC at the station, open this POS and sign in as the Owner.</li>
      <li>Go to Settings → Stations and press "Make this browser …'s device". It then shows that station's KOTs and nothing else.</li>
      <li>For paper: connect its thermal printer and make it the device's default printer. To print without a print window, start Chrome with the --kiosk-printing option (a shortcut on the device).</li>
      <li>Keep the screen on and the page open. If it is closed or loses the internet, the counter prints that station's KOTs.</li></ol></details></section>`;
}
const stBody = (x, change) => ({ name: x.name, how: x.how, copies: x.copies, isBar: x.isBar, active: x.active, ...change });
const stSave = async (id, change, text) => { const x = cache.stations.find((y) => y.id === id); await api('PUT', `${B()}/stations/${id}`, stBody(x, change)); await reloadMenu(); flash = { kind: 'ok', text: text ?? `${change.name ?? x.name} saved.` }; rerender(); };
actions.stNew = () => { ui.stNew = true; ui.error = null; rerender(); };
actions.stNo = () => { ui.stNew = false; rerender(); };
actions.stAdd = async () => { await api('POST', `${B()}/stations`, { name: ui.stName ?? '' }); await reloadMenu(); flash = { kind: 'ok', text: `${ui.stName} added. Choose it for its categories in Categories.` }; ui.stNew = false; ui.stName = ''; rerender(); };
actions.stHow = (d, el) => stSave(d.id, { how: el.value });
actions.stCopies = (d, el) => stSave(d.id, { copies: Number(el.value) });
actions.stBar = (d, el) => stSave(d.id, { isBar: el.checked });
actions.stActive = (d) => { const x = cache.stations.find((y) => y.id === d.id); return stSave(d.id, { active: !x.active }, `${x.name} ${x.active ? 'is no longer in use' : 'is in use again'}.`); };
actions.stRename = (d) => { const x = cache.stations.find((y) => y.id === d.id); ui.stRen = d.id; ui.stRenName = x.name; rerender(); };
actions.stRenameGo = async (d) => { const name = String(ui.stRenName ?? '').trim(); ui.stRen = null; await stSave(d.id, { name }); };
actions.stDevice = async (d) => {
  const x = cache.stations.find((y) => y.id === d.id);
  await api('POST', `${B()}/devices`, { name: `${x.name} device`, stationId: x.id });
  await api('POST', '/auth/logout').catch(() => {});
  me = null; go('#/station');
};

// ---------- a station's own device: its KOTs on a screen and/or printed here, nothing else
let stationTimer = null;
const stationPrinting = new Set();
function stopStation() { if (stationTimer) { clearInterval(stationTimer); stationTimer = null; } }
async function stationFetch(method, path) {
  const r = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(data?.error ?? 'Could not reach the server.', r.status);
  return data;
}
async function stationScreen() {
  ui.st = null; ui.stErr = null; ui.printed = ui.printed ?? [];
  const tick = async () => {
    try {
      ui.st = await stationFetch('GET', '/station'); ui.stErr = null; ui.stAt = Date.now();
      // Print what is meant to print here, one at a time, then tell the server.
      if (ui.st.station.how !== 'screen') for (const k of ui.st.kots.filter((x) => x.toPrint && !stationPrinting.has(x.id))) {
        stationPrinting.add(k.id);
        printKots([{ ...k, station: ui.st.station.name, copies: ui.st.station.copies }]);
        await stationFetch('POST', `/station/kots/${k.id}/printed`).catch(() => stationPrinting.delete(k.id));
        ui.printed = [{ ...k, printedAt: Date.now() }, ...ui.printed].slice(0, 12);
      }
    } catch (e) {
      ui.stErr = e.status === 401 ? 'setup' : e.message;
    }
    if (location.hash.startsWith('#/station')) rerender();
  };
  rerender = () => paintStation();
  paintStation();
  await tick();
  stopStation();
  stationTimer = setInterval(tick, 4000);
}
function paintStation() {
  const st = ui.st;
  if (ui.stErr === 'setup') {
    root.innerHTML = asHtml(html`<main class="kds-wrap"><div class="kds-msg"><h1>Not a station device</h1><p>This browser is not set up for a station. The Owner sets it up in Settings → Stations.</p>
      <p><a class="btn" href="#/">Sign in</a></p></div></main>`);
    return;
  }
  if (!st) { root.innerHTML = asHtml(html`<main class="kds-wrap"><p class="kds-msg">Loading…</p></main>`); return; }
  const now = Date.now();
  const screen = st.station.how !== 'paper';
  const open = st.kots.filter((k) => k.status !== 'ready');
  const mins = (k) => Math.floor((now - k.at) / 60000);
  const late = (k) => (mins(k) >= 15 ? 'late' : mins(k) >= 10 ? 'mid' : '');
  root.innerHTML = asHtml(html`<main class="kds-wrap"><div class="kds-bar"><div><b>${st.station.name}</b> <span>${st.business} · ${st.device}</span></div>
      <div><span class="${ui.stErr ? 'kds-off' : 'kds-on'}">${ui.stErr ? `Not connected: ${ui.stErr}` : `Connected · ${time(ui.stAt)}`}</span>
        <span>${screen ? `${open.length} open` : 'Printing KOTs here'}</span></div></div>
    ${screen ? (open.length ? html`<div class="kds-tickets">${open.map((k) => { const cancel = k.lines.some((l) => l.cancelled); return html`<div class="kds-tk ${late(k)} ${cancel ? 'cancel' : ''}">
        <div class="kds-h"><span>${cancel ? 'CANCEL · ' : ''}${k.place}</span><span>${mins(k)} min · ${k.by ?? ''}</span></div>
        <ul>${k.lines.map((l) => html`<li class="${l.cancelled ? 'cx' : ''}">${l.cancelled ? `Cancel ${Math.abs(l.qty)}` : l.qty} × ${l.name}${(l.options ?? []).map((o) => html`<small>+ ${o}</small>`)}</li>`)}</ul>
        <div class="kds-act">${cancel ? html`<button type="button" class="go" data-act="kdsReady" data-id="${k.id}">Seen</button>` : html`<button type="button" data-act="kdsStart" data-id="${k.id}" ${k.status === 'started' ? 'disabled' : ''}>${k.status === 'started' ? 'Started' : 'Start'}</button>
          <button type="button" class="go" data-act="kdsReady" data-id="${k.id}">Ready</button>`}</div>
        <div class="kds-foot">KOT ${k.kotNo}${st.station.how === 'both' ? html` · <button type="button" class="kds-link" data-act="kdsPrint" data-id="${k.id}">Print again</button>` : ''}</div></div>`; })}</div>`
      : html`<p class="kds-empty">No open KOTs.</p>`)
      : html`<div class="kds-printed"><h2>Printed here</h2>${ui.printed.length ? html`<ul>${ui.printed.map((k) => html`<li>KOT ${k.kotNo} · ${k.place} · ${time(k.printedAt)} <button type="button" class="kds-link" data-act="kdsPrint" data-id="${k.id}">Print again</button></li>`)}</ul>` : html`<p>Nothing yet this session. New KOTs print as they come.</p>`}</div>`}
  </main>`);
}
actions.kdsStart = async (d) => { await stationFetch('POST', `/station/kots/${d.id}/start`); const k = ui.st.kots.find((x) => x.id === d.id); if (k) k.status = 'started'; paintStation(); };
actions.kdsReady = async (d) => { await stationFetch('POST', `/station/kots/${d.id}/ready`); ui.st.kots = ui.st.kots.filter((x) => x.id !== d.id); paintStation(); };
actions.kdsPrint = (d) => { const k = ui.st.kots.find((x) => x.id === d.id) ?? ui.printed.find((x) => x.id === d.id); if (k) printKots([{ ...k, station: ui.st.station.name, copies: 1 }]); };

// Tax choices: an item can follow its category; a category can follow the billing name.
const RATES = [5, 12, 18, 28, 40, 0];
const taxChoices = (forItem) => [...(forItem ? [['category', 'From its category']] : []), ['billing', 'Billing name rate (food)'],
  ...RATES.map((r) => [`rate:${r}`, `GST ${r}%`]), ['liquor', 'Liquor: outside GST'], ['none', 'No GST (exempt)']];
const taxValue = (x) => (!x?.taxMode ? 'category' : x.taxMode === 'rate' ? `rate:${x.gstBp / 100}` : x.taxMode);
const taxName = (x) => taxChoices(true).find(([v]) => v === taxValue(x))?.[1] ?? '';
const catOf = (m) => (cache.menuCats ?? []).find((c) => c.name.toLowerCase() === m.category.toLowerCase());
/** The API form of a tax choice. */
const taxBody = (v) => (v?.startsWith('rate:') ? { taxMode: 'rate', gstRate: Number(v.slice(5)) } : { taxMode: v ?? 'category' });
const itemBody = (m) => ({ name: m.name, category: m.category, price: rupees(m.pricePaise), sac: m.sac, stationId: m.stationId ?? '', kot: m.kot == null ? 'category' : m.kot ? 'yes' : 'no', ...taxBody(taxValue(m)),
  openPrice: !!m.openPrice, minPrice: m.minPricePaise != null ? rupees(m.minPricePaise) : '', active: !!m.active,
  addonGroups: (m.addonGroups ?? []).map((id) => ({ id, prices: m.addonPrices?.[id] ? Object.fromEntries(Object.entries(m.addonPrices[id]).map(([k, v]) => [k, rupees(v)])) : null })) });
actions.itemToggle = async (d) => { const m = cache.menu.find((x) => x.id === d.id); await menuBulk([m.id], m.active ? 'off' : 'on'); };
actions.itemDelete = async (d) => {
  const m = cache.menu.find((x) => x.id === d.id);
  if (!confirm(`Delete ${m.name}?\n\nIf it has ever been ordered, it is taken off the menu instead, so past bills still show it.`)) return;
  await menuBulk([m.id], 'delete');
};
// Ticked rows on the Menu screen, and one change to all of them.
actions.mSel = (d, el) => { const s = new Set(ui.mSel ?? []); if (el.checked) s.add(d.id); else s.delete(d.id); ui.mSel = [...s]; rerender(); };
actions.mSelAll = (_d, el) => { const s = new Set(ui.mSel ?? []); for (const m of menuFilter()) { if (el.checked) s.add(m.id); else s.delete(m.id); } ui.mSel = [...s]; rerender(); };
actions.mSelClear = () => { ui.mSel = []; rerender(); };
actions.mBulk = async (d) => {
  const n = plural(ui.mSel.length, 'item');
  if (d.do === 'delete' && !confirm(`Delete ${n}?\n\nItems that have ever been ordered are taken off the menu instead, so past bills still show them.`)) return;
  await menuBulk(ui.mSel, d.do);
};
actions.mBulkPick = async (d, el) => {
  let v = el.value;
  if (!v) return;
  if (d.do === 'category' && v === '__new') { v = (prompt('Name of the new category') ?? '').trim(); if (!v) { el.value = ''; return; } }
  await menuBulk(ui.mSel, d.do, d.do === 'tax' ? taxBody(v) : v);
};
async function menuBulk(ids, action, value) {
  const r = await api('POST', `${B()}/menu/bulk`, { ids, action, value });
  const n = plural(ids.length, 'item');
  flash = { kind: 'ok', text: action === 'delete'
    ? [r.deleted ? `${plural(r.deleted, 'item')} deleted.` : '', r.takenOff ? `${plural(r.takenOff, 'item')} ${r.takenOff === 1 ? 'was' : 'were'} ordered before, so taken off the menu instead.` : ''].filter(Boolean).join(' ')
    : { off: `${n} taken off the menu.`, on: `${n} put back on the menu.`, category: `${n} moved to ${value}.`, station: `${n}: station changed.`, tax: `${n}: tax changed.` }[action] };
  route();
}
function menuBulkBar() {
  const sel = ui.mSel ?? [];
  if (!sel.length) return '';
  const cats = [...new Set(cache.menu.map((m) => m.category))].sort();
  return html`<div class="bulkbar" role="region" aria-label="Change ticked items"><strong>${plural(sel.length, 'item')} ticked</strong>
    <button class="btn" type="button" data-act="mBulk" data-do="off">Take off menu</button>
    <button class="btn" type="button" data-act="mBulk" data-do="on">Put back</button>
    <select class="in" data-act-change="mBulkPick" data-do="category" aria-label="Move ticked items to a category"><option value="">Category…</option>${cats.map((c) => html`<option>${c}</option>`)}<option value="__new">New category…</option></select>
    <select class="in" data-act-change="mBulkPick" data-do="station" aria-label="Station for ticked items"><option value="">Station…</option><option value="category">As its category says</option>${activeStations().map((x) => html`<option value="${x.id}">${x.name}</option>`)}<option value="none">No KOT</option></select>
    <select class="in" data-act-change="mBulkPick" data-do="tax" aria-label="Tax for ticked items"><option value="">Tax…</option>${taxChoices(true).map(([v, t]) => html`<option value="${v}">${t}</option>`)}</select>
    <button class="btn danger" type="button" data-act="mBulk" data-do="delete">Delete</button>
    <button class="btn ghost" type="button" data-act="mSelClear">Clear ticks</button></div>`;
}
actions.catTax = async (d, el) => {
  await api('PUT', `${B()}/menu-categories/${d.id}`, taxBody(el.value));
  const c = cache.menuCats.find((x) => x.id === d.id); Object.assign(c, el.value.startsWith('rate:') ? { taxMode: 'rate', gstBp: Number(el.value.slice(5)) * 100 } : { taxMode: el.value, gstBp: null });
  flash = { kind: 'ok', text: `${c.name}: ${taxName(c)}.` }; route();
};
actions.addItem = async () => {
  const open = ui.iOpen === 'yes';
  const body = { name: ui.iName, category: ui.iCat, price: open ? '' : ui.iPrice ?? '', stationId: ui.iStationId ?? '', kot: ui.iKot ?? 'category', ...taxBody(ui.iTax ?? 'category'),
    openPrice: open, minPrice: open ? ui.iMin ?? '' : '', addonGroups: (ui.iGroups ?? []).map((id) => ({ id, prices: itemPricesOut(id) })) };
  const fromChoice = !open && choicePrice();
  if (fromChoice) body.price = fromChoice;
  if (ui.editItem) { const m = cache.menu.find((x) => x.id === ui.editItem); await api('PUT', `${B()}/menu/${m.id}`, { ...body, sac: m.sac, active: !!m.active }); }
  else await api('POST', B() + '/menu', body);
  flash = { kind: 'ok', text: `${ui.iName} ${ui.editItem ? 'saved' : 'added'}.` }; route();
};
/** Items the Menu tab shows: matching the search (name or category, any word order) and the chosen category. */
function menuFilter() {
  const words = String(ui.mQ ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return cache.menu.filter((m) => (!ui.mCat || m.category === ui.mCat) && words.every((w) => m.name.toLowerCase().includes(w) || m.category.toLowerCase().includes(w)));
}
const toItemForm = () => setTimeout(() => root.querySelector('form.grid3')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
actions.mNew = () => { Object.assign(ui, { editItem: null, iName: '', iCat: ui.mCat ?? '', iPrice: '', iStationId: '', iKot: 'category', iTax: 'category', iOpen: 'no', iMin: '', iGroups: [], iPrices: {} }); rerender(); toItemForm(); root.querySelector('[data-model="iName"]')?.focus({ preventScroll: true }); };
actions.itemEdit = (d) => { const m = cache.menu.find((x) => x.id === d.id); Object.assign(ui, { editItem: m.id, iName: m.name, iCat: m.category, iPrice: rupees(m.pricePaise), iStationId: m.stationId ?? '', iKot: m.kot == null ? 'category' : m.kot ? 'yes' : 'no', iTax: taxValue(m),
  iOpen: m.openPrice ? 'yes' : 'no', iMin: m.minPricePaise != null ? rupees(m.minPricePaise) : '', iGroups: [...(m.addonGroups ?? [])],
  iPrices: Object.fromEntries(Object.entries(m.addonPrices ?? {}).map(([g, ps]) => [g, Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, rupeesShort(v)]))])) }); rerender(); };
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
actions.revoke = async (d) => {
  const dev = ui.devices.find((x) => x.id === d.id);
  if (!confirm(`Remove ${dev?.name ?? 'this device'}? Staff can no longer sign in with a PIN on it until an Owner sets it up again.`)) return;
  await api('POST', `${B()}/devices/${d.id}/revoke`); route();
};

route();
