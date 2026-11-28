// Restaurant POS counter screens. Talks only to /api on the same origin; the server decides every permission and rule.
// Hiding buttons by role here is for tidiness only. Every value from the server is escaped before it is shown.

import * as offline from './offline.js';

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
const rupees = (p) => (p < 0 ? '-' : '') + `${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`;
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

class ApiError extends Error { constructor(message, status, code, data) { super(message); this.status = status; this.code = code; this.data = data; } }
let approvalCreds = null;   // extra fields while a step is tried again: a manager's { approverId, approverPin }, or { guestChoice }
async function api(method, path, body, extraHeaders = {}) {
  if (body === undefined && method !== 'GET') body = {};
  if (approvalCreds && method !== 'GET' && body && typeof body === 'object') body = { ...body, ...approvalCreds };
  // Offline mode (27 Nov 2026): with no internet, or for an order still only on this PC, the counter answers from this PC.
  if (offline.handles(method, path, body)) return localApi(method, path, body);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (!offline.ready()) offline.restore();
    if (offline.ready() && !path.startsWith('/admin') && !path.startsWith('/auth')) { offline.wentOffline(); return localApi(method, path, body); }
    throw new ApiError('No internet. Check the Wi-Fi, then try again.', 0, 'network');
  }
  const data = await res.json().catch(() => null);
  if (res.ok && method === 'GET') { offline.remember(path, data); return offline.merge(path, data); }
  if (res.status === 401 && !['/me', '/auth/login', '/auth/pin'].includes(path) && !path.startsWith('/admin') && !path.startsWith('/serve/')) { me = null; go('#/signin'); throw new ApiError('Please sign in.', 401, 'signin'); }
  if (!res.ok) throw new ApiError(data?.error ?? 'Something went wrong.', res.status, data?.code, data);
  return data;
}
async function localApi(method, path, body) {
  try { return await offline.local(method, path, body); } catch (e) {
    if (e instanceof offline.OfflineError) throw new ApiError(e.message, e.status, e.code);
    throw e;
  }
}

// ---------- state

let me = null;          // { staff, business, actions }
let cache = {};         // menu, reasons, entities, payAccounts, stays, credit (loaded per screen)
let reopenStay = null;  // the room bill to show again after the rooms screen reloads (a payment or refund taken on it)
let pendingOut = false;  // a late check-in of a guest who has already left: the bill opens for payment and check-out
let ui = {};            // the current screen's own state; reset on every route change
let flash = null;       // { kind, text, link?: [href, text] } shown once at the top
const can = (a) => !!me?.actions.includes(a);
const B = () => `/businesses/${me.business.id}`;

// Where the app starts (24 Nov 2026): Counter for anyone who works the counter (front desk and billing), Tables for the
// others. Only on opening the app or signing in; the Tables link itself still goes to Tables.
let startHere = true;
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
  check: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`,
  skip: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  on: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
};
const iconBtn = (act, id, icon, label, cls = '') => html`<button class="ibtn ${cls}" type="button" data-act="${act}" data-id="${id}" title="${label}" aria-label="${label}">${ICON[icon]}</button>`;

// Full screen on the counter (21 Nov 2026): no app needed. Chrome can also install Bookr POS as its own window (the
// install icon in the address bar), which opens without the address bar.
const FULL_ICON = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
// In the Bookr POS Windows app: the window's own full screen, and a minimize button (23 Nov 2026).
const MIN_ICON = html`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 18h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const fullButton = () => (window.bookrDesktop?.minimize ? html`<button type="button" class="themebtn" data-act="deskMin" title="Minimize" aria-label="Minimize">${MIN_ICON}</button>
  <button type="button" class="themebtn" data-act="deskFull" title="Full screen on or off (F11)" aria-label="Full screen on or off">${FULL_ICON}</button>`
  : document.fullscreenEnabled ? html`<button type="button" class="themebtn" data-act="fullScreen" title="${document.fullscreenElement ? 'Leave full screen' : 'Full screen'}" aria-label="${document.fullscreenElement ? 'Leave full screen' : 'Full screen'}">${FULL_ICON}</button>` : '');
function shell(active, body) {
  const links = [['#/counter', 'Counter', 'stays.edit'], ['#/', 'Tables', 'pos.view'], ['#/rooms', 'Rooms', 'pos.view'], ['#/credit', 'Credit', 'pos.view'], ['#/payments', 'Payments', 'pos.view'], ['#/shift', 'Day close', 'shift.close'],
    ['#/stock', 'Stock', can('stock.edit') ? 'stock.edit' : 'stock.count'], ['#/reports', 'Reports', 'reports.view'], ['#/exceptions', 'Daily check', 'reports.view'], ['#/settings', 'Settings', 'menu.edit']].filter((l) => can(l[2]));
  const navLinks = links.map(([h, t]) => html`<a href="${h}" ${active === h ? html`aria-current="page"` : ''}>${t}</a>`);
  const current = links.find(([h]) => h === active)?.[1] ?? 'Menu';
  return html`<header class="top"><div class="top-in">
    <div class="brandbox"><span class="product">Bookr POS</span>${(me.restaurants ?? []).length > 1
      ? html`<select class="switcher" data-act-change="switchRestaurant" aria-label="Restaurant">${me.restaurants.map((r) => html`<option value="${r.id}" ${r.id === me.business.id ? 'selected' : ''}>${r.name}</option>`)}</select>`
      : html`<a class="brand" href="#/" title="${me.business.name}">${me.business.name}</a>`}</div>
    <nav class="mainnav" aria-label="Main">${navLinks}</nav>
    ${links.length > 1 ? html`<details class="navmenu"><summary aria-label="Go to: ${current}">${current} <span aria-hidden="true">▾</span></summary><nav aria-label="Main">${navLinks}</nav></details>` : ''}
    <div class="who">${netChip()}${drawerChip()}${fullButton()}${themeButton()}<span class="shiftchip" title="Shift of ${dayName(me.business.shiftDay)}: a shift runs 8 am to 8 am" aria-label="Shift ${dayName(me.business.shiftDay)}">${dayName(me.business.shiftDay)}</span>
      <span class="person">${me.staff.name}</span><button type="button" data-act="logout">Sign out</button></div>
  </div></header>
  ${netBand(active)}
  ${me.support ? html`<div class="supportbar" role="status">You are in ${me.business.name} as Bookr POS support. The owner can see this visit.</div>` : ''}
  <main>${flash ? html`<div class="msg ${flash.kind} flash" role="status"><span>${flash.text}</span>${flash.link ? html`<a href="${flash.link[0]}" ${/^https?:/.test(flash.link[0]) ? html`target="_blank" rel="noopener noreferrer"` : ''}>${flash.link[1]}</a>` : ''}</div>` : ''}${active === '#/rooms' ? '' : deskBannerBox()}${body}${rcModal()}</main>`;
}
/** A page title with an optional line under it and controls on the right. */
const pageHead = (title, sub, right) => html`<div class="phead"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>${right ?? ''}</div>`;
/** Tabs that are links (each tab has its own address). */
/** Who holds the cash drawer (24 Nov 2026), with the way to hand it over. */
const drawerChip = () => (can('shift.close') ? html`<a class="drawerchip ${me.drawer ? '' : 'none'}" href="#/handover" title="${me.drawer ? `Cash drawer: ${me.drawer.holder} since ${time(me.drawer.since)}. Tap to hand it over.` : 'Nobody holds the cash drawer yet: the next person to take cash starts it.'}">${me.drawer ? html`Drawer: <b>${me.drawer.holder}</b> · ${time(me.drawer.since)}` : 'Drawer: nobody yet'}</a>` : '');
const tabsNav = (label, items, current) => html`<nav class="tabs" aria-label="${label}">${items.map(([href, text, key]) => html`<a href="${href}" ${key === current ? html`aria-current="page"` : ''}>${text}</a>`)}</nav>`;
/** A headline number. tone: '', 'good', 'warn' or 'bad'. */
const kpi = (k, v, n, tone = '') => html`<div class="kpi ${tone}"><span class="k">${k}</span><span class="v">${v}</span>${n ? html`<span class="n">${n}</span>` : ''}</div>`;

let shownFlash = null;
function paint(view) { root.innerHTML = asHtml(view); shownFlash = flash; flash = null; sortable(); const f = root.querySelector('[autofocus]'); if (f) f.focus(); }
/** Every data table with more than two rows sorts by any titled column (25 Nov 2026): a Total row stays at the bottom. */
function sortable() {
  for (const table of root.querySelectorAll('table.t')) {
    if (!table.tBodies[0] || [...table.tBodies[0].rows].filter((r) => r.children.length > 1).length < 3) continue;
    for (const th of table.querySelectorAll('thead th:not([data-sort])')) if (th.textContent.trim() && th.colSpan === 1) th.setAttribute('data-sort', '');
  }
}
const errorBox = () => html`${ui.drawerAsk ? html`<div class="msg warn" role="alert" style="display:block"><p style="margin-bottom:8px"><strong>The cash drawer is with ${ui.drawerAsk.holder}.</strong> Only the person holding it takes cash.</p>
  <div class="row"><a class="btn pri" href="#/handover">${ui.drawerAsk.holder} is here: hand it to me</a><a class="btn" href="#/handover/takeover">${ui.drawerAsk.holder} has left: I take it over</a>
    <button class="btn ghost" type="button" data-act="drawerAskNo">Cancel</button></div></div>` : ''}${ui.guestAsk ? html`<div class="msg warn" role="alert"><p style="margin-bottom:8px"><strong>${ui.guestAsk.message}</strong></p>
  <div class="row"><button class="btn pri" type="button" data-act="guestChoice" data-c="saved">Yes, ${ui.guestAsk.savedName}</button>
    <button class="btn" type="button" data-act="guestChoice" data-c="update">Use the name I typed</button><button class="btn ghost" type="button" data-act="guestChoiceNo">Cancel</button></div></div>` : ''}${ui.approval ? approvalBox() : ''}${ui.error && ui.openFood?.length ? html`<div class="row" style="margin:6px 0">${ui.openFood.map((o) => html`<button class="btn sm" type="button" data-act="openFoodGo" data-id="${o.id}">Open ${o.place} · ${rs(o.amountPaise)}</button>`)}</div>` : ''}${ui.error ? html`<div class="msg bad" role="alert">${ui.error}</div>` : ''}`;
/** The manager's PIN for a step a cashier may not take alone (asked for by the server). */
const approvalBox = () => {
  const a = ui.approval;
  return html`<form class="msg warn approve" role="alert"><p style="margin-bottom:8px"><strong>${a.message}</strong></p>
    ${a.approvers.length ? html`<div class="row"><select class="in" data-model="apId" aria-label="Approved by">${a.approvers.map((x) => html`<option value="${x.id}" ${ui.apId === x.id ? 'selected' : ''}>${x.name}</option>`)}</select>
      <input class="in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-model="apPin" placeholder="Manager's PIN" aria-label="Manager's or owner's PIN" autofocus></div>
      <div class="row" style="margin-top:8px"><button class="btn pri" type="submit" data-act="approveGo" data-submit>Approve</button><button class="btn ghost" type="button" data-act="approveNo">Cancel</button></div>`
    : html`<p>No manager or owner has a PIN yet. The Owner sets one in Settings, Staff and PINs.</p><button class="btn ghost" type="button" data-act="approveNo">Close</button>`}</form>`;
};

async function route() {
  ui = {};
  document.title = 'Bookr POS';
  stopStation();
  stopProof();
  stopWaLink();
  stopServe();
  stopLive();
  try {
    // A server's own phone (28 Nov 2026): the Serve page, its own PIN sign-in, nothing else.
    if (location.hash.startsWith('#/serve/')) return await serveScreen(location.hash.split('/')[2] ?? '');
    // A station's own device shows its KOTs; nobody signs in on it.
    if (location.hash.startsWith('#/station')) return await stationScreen();
    // Bookr POS admin: its own sign-in, separate from every restaurant's.
    if (location.hash.startsWith('#/admin')) return await adminScreen();
    if (!me) {
      try { me = await api('GET', '/me'); } catch { me = null; }
    }
    if (!me) return await signIn();
    offlineReady();
    const [path, a, b] = location.hash.replace(/^#\/?/, '').split('/');
    if (path === 'offline') return offlineScreen();
    if (!offline.isOnline() && !OFFLINE_PATHS.includes(path ?? '')) return offlineOnly();
    if (startHere) {
      startHere = false;
      if ((path === '' || path === 'signin') && can('stays.edit')) { location.replace('#/counter'); return; }
    }
    // Desk density (25 Nov 2026): compact controls for a mouse and keyboard; the floor, order and payment screens stay
    // touch-sized for a tablet.
    document.body.classList.toggle('desk', !['', 'order', 'bill', 'settle', 'done', 'signin'].includes(path ?? ''));
    if (path === 'order') return await orderScreen(a);
    if (path === 'bill') return await billScreen(a);
    if (path === 'settle') return await settleScreen(a, b);
    if (path === 'done') return await doneScreen(a);
    refreshDeskAlerts();
    if (path === 'rooms') return await roomsScreen(a);
    if (path === 'counter') return await counterScreen();
    if (path === 'credit') return await creditScreen();
    if (path === 'payments') return a === 'bills' ? await billsScreen(b) : await paymentsScreen(a);
    // A bill by its number (25 Nov 2026): opens it, from Daily check, a room bill or anywhere a number is shown.
    if (path === 'billno') {
      const r = await api('GET', `${B()}/bills?no=${encodeURIComponent(a ?? '')}`).catch(() => ({ bills: [] }));
      const hit = r.bills.find((x) => x.billNo === a) ?? r.bills[0];
      location.replace(hit ? `#/done/${hit.id}` : '#/payments/bills'); return;
    }
    if (path === 'shift') return await shiftScreen();
    if (path === 'serving') return await servingScreen();
    if (path === 'handover') return await handoverScreen(a);
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
actions.fullScreen = async () => {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  else await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
};
document.addEventListener('fullscreenchange', () => rerender());
actions.deskMin = () => window.bookrDesktop?.minimize();
actions.deskFull = () => window.bookrDesktop?.toggleFullScreen();
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
  try { await fn(el.dataset, el); } catch (e) { await actionError(e, el.dataset.act, el.dataset); } finally { clearTimeout(wait); el.classList.remove('busy'); el.removeAttribute('aria-busy'); }
});
/** What a failed tap shows: a sign-in, a question (same guest? a manager's PIN?) that retries the tap, or the error. */
async function actionError(e, act, dataset) {
  {
    if (e instanceof ApiError && e.code === 'signin') return; // already sent to the sign-in screen
    // A step a cashier may not take alone: ask for a manager's PIN, then do the same tap again with it.
    // A phone already saved under another name: ask which name is right, then do the same tap again.
    if (e instanceof ApiError && e.code === 'guest_differs') {
      ui.guestAsk = { message: e.message, savedName: e.data?.savedName, act, data: { ...dataset } }; ui.error = null; rerender(); return;
    }
    // Cash while the drawer is with someone else (24 Nov 2026): hand it over, or take it over.
    if (e instanceof ApiError && e.code === 'drawer_held') { ui.drawerAsk = { holder: e.data?.holder ?? 'someone else' }; ui.error = null; rerender(); return; }
    // A room still marked dirty (25 Nov 2026): asked, then the same tap again.
    // Food still open at check-out (27 Nov 2026): the error lists it, with a button to each order.
    ui.openFood = e instanceof ApiError && e.code === 'open_food' ? e.data?.orders ?? [] : null;
    if (e instanceof ApiError && e.code === 'room_dirty') {
      if (confirm(e.message)) { await Promise.resolve(actions[act]({ ...dataset, dirtyOk: '1' })).catch((x) => actionError(x, act, dataset)); }
      return;
    }
    if (e instanceof ApiError && e.code === 'approval') {
      const approvers = (await api('GET', `${B()}/approvers`).catch(() => ({ approvers: [] }))).approvers;
      ui.approval = { message: e.message, act, data: { ...dataset }, approvers }; ui.apId = approvers[0]?.id; ui.apPin = ''; ui.error = null;
      rerender(); return;
    }
    ui.error = e.message; rerender();
  }
}
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
  if (el.dataset.actChange) Promise.resolve(actions[el.dataset.actChange](el.dataset, el)).catch((e) => actionError(e, el.dataset.actChange, el.dataset));
});
root.addEventListener('submit', (ev) => { ev.preventDefault(); const b = ev.target.querySelector('[data-submit]'); if (b) b.click(); });
let rerender = () => {};
/** Why a typed phone is not valid, or null: the same check the server makes (Indian mobile, or + and a country code). */
function phoneProblem(v) {
  const t = String(v ?? '').trim();
  if (!t) return null;
  if (/[^\d\s+()-]/.test(t)) return 'Phone: use digits only.';
  let d = t.replace(/\D/g, '');
  const foreign = t.startsWith('+') && !/^\+\s*91/.test(t);
  if (foreign) return d.length < 8 || d.length > 15 ? `Phone: ${d.length} digits. A foreign number has 8 to 15 digits with its country code.` : null;
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10) return `Phone: ${d.length} digit${d.length === 1 ? '' : 's'}. A mobile has 10, starting 6, 7, 8 or 9. A foreign number starts with + and the country code.`;
  if (!/^[6-9]/.test(d)) return 'Phone: a mobile starts with 6, 7, 8 or 9. A foreign number starts with + and the country code.';
  if (/^(\d)\1+$/.test(d) || d === '9876543210' || d === '6789012345') return 'Phone: that does not look like a real number.';
  return null;
}
/** The check under a phone box, as it is typed: why it is wrong, or a tick once it is a full valid number. */
const phoneHint = (v) => { const t = String(v ?? '').trim(); if (!t) return ''; const p = phoneProblem(t);
  return p ? html`<p class="phint bad" role="status">✗ ${p}</p>` : html`<p class="phint ok" role="status">✓ Valid number</p>`; };
actions.discLimitSave = async () => {
  const b = me.business;
  await api('PUT', `${B()}/settings`, { name: b.name, fyStartMonth: b.fy_start_month, shiftStartHour: b.shift_start_hour, tabAgeDays: b.tab_age_days, discLimitPct: Number(ui.discLimit ?? b.disc_limit_bp / 100) });
  me = await api('GET', '/me'); flash = { kind: 'ok', text: `Saved: a cashier may give up to ${me.business.disc_limit_bp / 100}% alone.` }; route();
};
actions.drawerCountSet = async (d) => {
  const on = d.on === '1';
  await api('PUT', `${B()}/drawer/count-setting`, { on });
  me.business.drawer_count = on ? 1 : 0;
  flash = { kind: 'ok', text: on ? 'The drawer is counted at Day close.' : 'Day close no longer counts the drawer.' }; route();
};
actions.floatSave = async () => {
  await api('PUT', `${B()}/drawer/float`, { amount: String(ui.floatAmt ?? (me.business.float_paise ?? 0) / 100) });
  me = await api('GET', '/me'); flash = { kind: 'ok', text: `Saved: ${rs(me.business.float_paise)} stays in the drawer at each day close.` }; route();
};
actions.guestChoiceNo = () => { ui.guestAsk = null; rerender(); };
actions.guestChoice = async (d) => {
  const a = ui.guestAsk; ui.guestAsk = null;
  approvalCreds = { guestChoice: d.c };
  try { await actions[a.act](a.data); } finally { approvalCreds = null; }
};
actions.deskPrinters = () => window.bookrDesktop?.openPrinters();
actions.approveNo = () => { ui.approval = null; ui.apPin = ''; rerender(); };
actions.approveGo = async () => {
  const a = ui.approval;
  if (!/^\d{4,6}$/.test(ui.apPin ?? '')) throw new Error("Type the manager's or owner's 4 to 6 digit PIN.");
  approvalCreds = { approverId: ui.apId, approverPin: ui.apPin };
  ui.approval = null; ui.apPin = '';
  try { await actions[a.act](a.data); } finally { approvalCreds = null; }
};
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
  me = null; startHere = true; go('#/');
};
/** The desk screens where the counter's shortcut keys work: Counter, Tables and Rooms. */
const onDesk = () => /^#\/(counter|rooms)?(\/.*)?$|^#?$/.test(location.hash) && !/^#\/(order|bill|settle|done)/.test(location.hash);
let pendingPick = null;   // a new order asked for by a shortcut on Rooms: opened on Tables
// Keyboard shortcuts (25 Nov 2026): / searches the screen, N starts a new reservation (on Rooms), Esc closes the side
// panel or the open form. Not while typing in a field (except Esc).
const ESC_KEYS = ['roomBill', 'recv', 'refund', 'adv', 'rbForm', 'chartSel', 'resSel', 'drawer', 'approval', 'guestAsk', 'useSel'];
document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ui.pinPad) return;
  const typing = ev.target.matches?.('input, textarea, select');
  if (ev.key === 'Escape') {
    if (typing) { ev.target.blur(); if (!ESC_KEYS.some((k) => ui[k])) return; }
    const open = ESC_KEYS.filter((k) => ui[k]);
    if (!open.length) return;
    ev.preventDefault();
    // The innermost first: a form inside the side panel, then the panel itself.
    const k = ['approval', 'guestAsk', 'recv', 'refund', 'adv', 'rbForm'].find((x) => ui[x]) ?? open[0];
    ui[k] = null; if (k === 'roomBill' || k === 'drawer' || k === 'chartSel') { ui.roomBill = ui.drawer = ui.chartSel = null; ui.rbForm = null; }
    ui.error = null; rerender(); return;
  }
  if (typing) return;
  if (ev.key === '/') {
    const box = root.querySelector('input[type="search"], [data-search]');
    if (box) { ev.preventDefault(); box.focus(); box.select?.(); }
  } else if ((ev.key === 'n' || ev.key === 'N') && onDesk() && can('stays.edit')) {
    ev.preventDefault(); go('#/rooms/new');
  } else if ((ev.key === 'c' || ev.key === 'C') && onDesk() && can('stays.edit')) {
    ev.preventDefault(); go('#/rooms/checkin');
  } else if ((ev.key === 'a' || ev.key === 'A') && /^#\/(counter|tables)?$|^$|^#$/.test(location.hash) && can('debtors.receive')) {
    // A party's advance (A), from the Counter (26 Nov 2026).
    ev.preventDefault(); actions.partyAdv();
  } else if (['t', 'r', 'k'].includes(ev.key.toLowerCase()) && onDesk() && can('orders.edit')) {
    // New table (T), room service (R), takeaway (K) from Counter, Tables or Rooms (24 Nov 2026).
    ev.preventDefault();
    const kind = { t: 'table', r: 'room', k: 'takeaway' }[ev.key.toLowerCase()];
    if (/^#\/(counter)?$|^$|^#$/.test(location.hash)) actions.newOrder({ kind }); else { pendingPick = kind; go('#/'); }
  }
});
// Sortable tables: a header with data-sort sorts its table's rows on click (numbers by value, ₹ and commas ignored).
root.addEventListener('click', (ev) => {
  const th = ev.target.closest?.('th[data-sort]');
  if (!th) return;
  const table = th.closest('table');
  const tbody = table.tBodies[0];
  const idx = [...th.parentElement.children].indexOf(th);
  const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
  table.querySelectorAll('th[aria-sort]').forEach((x) => x.removeAttribute('aria-sort'));
  th.setAttribute('aria-sort', dir);
  const key = (tr) => { const c = tr.children[idx]; const v = (c?.dataset.v ?? c?.textContent ?? '').trim(); const n = Number(v.replace(/[₹,\s]/g, '')); return Number.isFinite(n) && /\d/.test(v) && !/[a-z]{2}/i.test(v.replace(/₹/g, '')) ? n : v.toLowerCase(); };
  const isTotal = (r) => /^total\b/i.test(r.children[0]?.textContent.trim() ?? '');
  const rows = [...tbody.rows].filter((r) => r.children.length > 1 && !isTotal(r));
  const totals = [...tbody.rows].filter(isTotal);
  rows.sort((a, b) => { const x = key(a); const y = key(b); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return dir === 'ascending' ? c : -c; });
  rows.forEach((r) => tbody.appendChild(r)); totals.forEach((r) => tbody.appendChild(r));
});
// A counter PC has a keyboard: digits, Backspace and Enter work on the PIN pad.
document.addEventListener('keydown', (ev) => {
  if (!ui.pinPad || ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.matches?.('input, textarea, select')) return;
  if (/^\d$/.test(ev.key)) { ev.preventDefault(); actions.pinKey({ k: ev.key }); }
  else if (ev.key === 'Backspace') { ev.preventDefault(); actions.pinBack(); }
  else if (ev.key === 'Enter' && !ev.target.closest?.('button')) { ev.preventDefault(); root.querySelector('[data-act="pinGo"]')?.click(); }
});
actions.pwMode = () => { ui.passwordMode = !ui.passwordMode; ui.error = null; rerender(); };
actions.login = async () => { await api('POST', '/auth/login', { email: ui.email ?? '', password: ui.password ?? '' }); me = null; startHere = true; go('#/'); };
actions.logout = async () => { await api('POST', '/auth/logout'); me = null; cache = {}; go('#/signin'); };
// An owner of more than one restaurant moves between them; only their own appear in the list.
actions.switchRestaurant = async (_d, el) => {
  await api('POST', '/auth/switch', { businessId: el.value });
  me = null; cache = {}; startHere = true; go('#/');
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

// ---------- Counter (24 Nov 2026): the shared front desk and restaurant billing desk on one screen. Restaurant on the left
// (running tables, carried over first; room service, takeaway and tabs), front desk on the right (today's numbers, every
// room and bed tonight, arriving, leaving, money owed), with one search and the alerts on top. Shortcut keys: / search,
// T new table, R room service, K takeaway, C check in, N new reservation (also on Tables and Rooms).
// ---------- advances on restaurant orders (26 Nov 2026): on a running order, or for a party booked ahead.
function advanceTakeForm() {
  const f = ui.advForm;
  const accs = (cache.payAccounts ?? []).filter((a) => a.active);
  return html`<form class="panel" style="border-color:var(--pri-line);margin:8px 0"><h3 style="margin:0">${f.orderId ? `Advance on ${f.place}` : 'Advance for a party booked ahead'}</h3>${errorBox()}
    <div class="grid2"><label class="f">Guest name<input class="in" data-model="advGName" value="${ui.advGName ?? f.name ?? ''}" autofocus></label>
      <label class="f">Phone${f.orderId ? ' (optional)' : ''}<input class="in" inputmode="tel" data-model="advGPhone" value="${ui.advGPhone ?? ''}"></label></div>
    ${f.orderId ? '' : html`<div class="grid3"><label class="f">Day<input class="in" type="date" data-model="advDay" value="${ui.advDay ?? me.business.shiftDay}"></label>
      <label class="f">Time<input class="in" type="time" data-model="advTime" value="${ui.advTime ?? ''}"></label>
      <label class="f">People<input class="in" inputmode="numeric" data-model="advPeople" value="${ui.advPeople ?? ''}"></label></div>`}
    <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="advAmt" value="${ui.advAmt ?? ''}"></label>
      <div class="f">Paid by<div class="chips">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.advMode ?? 'cash') === k}" data-act="pick" data-k="advMode" data-id="${k}">${t}</button>`)}</div></div></div>
    ${ui.advMode === 'upi' ? html`<div class="f">QR paid into<div class="chips">${accs.map((a) => html`<button type="button" class="chip" aria-pressed="${ui.advAcc === a.id}" data-act="pick" data-k="advAcc" data-id="${a.id}">${a.name}</button>`)}</div></div>` : ''}
    <div class="row"><button class="btn pri" type="submit" data-act="advTakeGo" data-submit>Take advance and print receipt</button><button class="btn" type="button" data-act="advFormNo">Cancel</button></div></form>`;
}
actions.partyAdv = () => { ui.advForm = {}; ui.advMode = 'cash'; Object.assign(ui, { advGName: undefined, advGPhone: undefined, advDay: undefined, advTime: undefined, advPeople: undefined, advAmt: undefined, advAcc: undefined }); ui.error = null; rerender(); };
actions.advOrder = () => { ui.advForm = { orderId: ui.order.id, place: ui.order.place, name: ui.order.guestName ?? '' }; ui.advMode = 'cash'; Object.assign(ui, { advGName: undefined, advGPhone: undefined, advAmt: undefined, advAcc: undefined }); ui.error = null; rerender(); };
actions.advFormNo = () => { ui.advForm = null; rerender(); };
actions.advTakeGo = async () => {
  const f = ui.advForm;
  const mode = ui.advMode ?? 'cash';
  if (mode === 'upi' && !ui.advAcc) throw new Error("Choose which account's QR was paid.");
  const people = Number(ui.advPeople);
  const r = await api('POST', `${B()}/restaurant-advances`, { orderId: f.orderId, guestName: ui.advGName ?? f.name ?? '', phone: ui.advGPhone || undefined,
    partyDay: f.orderId ? undefined : ui.advDay ?? me.business.shiftDay, partyTime: f.orderId ? undefined : ui.advTime || undefined, people: Number.isInteger(people) && people > 0 ? people : undefined,
    payments: [{ mode, amount: ui.advAmt ?? '', payAccountId: mode === 'upi' ? ui.advAcc : undefined }] });
  printJobs([{ kind: 'bill', html: asHtml(receiptSlip(r.receipt)) }]);
  ui.advForm = null;
  flash = { kind: 'ok', text: `${r.receipt.receiptNo}: advance ${rs(r.receipt.totalPaise)} from ${r.receipt.name} taken.` };
  if (f.orderId) { ui.oadv = (await api('GET', `${B()}/restaurant-advances?orderId=${f.orderId}`)).advances; rerender(); } else route();
};
function advancesHeldList() {
  const today = me.business.shiftDay;
  // Restaurant tables only (not rooms or dorm beds), not running now.
  const restTables = (ui.sections ?? []).filter((x) => !['rooms', 'dorms', 'nc'].includes(x.kind)).flatMap((x) => x.tables ?? []);
  const free = (restTables.length ? restTables : ui.tables ?? []).filter((t) => !(ui.orders ?? []).some((o) => o.kind === 'table' && o.place.toLowerCase() === t.toLowerCase()));
  return html`<div class="sect"><h3 style="margin:0">Advances held</h3><span class="small quiet">${ui.radv.length} · ${rs(ui.radv.reduce((t, x) => t + x.leftPaise, 0))}</span></div>
    <div class="ctrlist">${ui.radv.map((x) => { const done = x.orderStatus === 'closed' || x.orderStatus === 'cancelled'; const noShow = !x.orderId && x.partyDay && x.partyDay < today;
      return html`<div class="drow" style="flex-wrap:wrap"><span class="grow"><strong>${x.guestName}</strong>
        <small>${x.orderId ? `${x.place}${done ? ' · bill paid, advance left over' : ''}` : `Party ${dayName(x.partyDay)}${x.partyTime ? `, ${x.partyTime}` : ''}${x.people ? ` · ${x.people} people` : ''}${noShow ? ' · date passed' : ''}`} · ${x.receipts ?? ''}${x.phoneEnd ? ` · phone …${x.phoneEnd}` : ''}</small></span>
        <span class="dright"><span class="num">${rs(x.leftPaise)}</span>
          ${!x.orderId && !noShow && can('orders.edit') ? html`<button class="btn sm" type="button" data-act="advOpenAsk" data-id="${x.id}">${ui.advOpen === x.id ? 'Cancel' : 'Open their table'}</button>` : ''}
          ${(done || noShow) && isMgr() ? html`<button class="btn sm" type="button" data-act="advBack" data-id="${x.id}" data-a="${x.accountId}" data-m="cash" data-amt="${rupees(x.leftPaise)}">Give back cash</button>
            <button class="btn sm" type="button" data-act="advBack" data-id="${x.id}" data-a="${x.accountId}" data-m="upi" data-amt="${rupees(x.leftPaise)}">Give back UPI</button>
            <button class="btn sm ghost" type="button" data-act="advKeep" data-id="${x.id}">Keep</button>` : (done || noShow) ? html`<span class="status warn">A manager gives it back or keeps it</span>` : ''}</span>
        ${ui.advOpen === x.id ? html`<div class="chips" style="width:100%;margin-top:6px"><span class="small quiet">Their table:</span>${free.map((t) => html`<button type="button" class="chip" data-act="advOpenGo" data-id="${x.id}" data-place="${t}">${t}</button>`)}</div>` : ''}</div>`; })}</div>`;
}
actions.advOpenAsk = (d) => { ui.advOpen = ui.advOpen === d.id ? null : d.id; rerender(); };
actions.advOpenGo = async (d) => {
  const x = ui.radv.find((y) => y.id === d.id);
  const r = await api('POST', B() + '/orders', { kind: 'table', place: d.place });
  await api('POST', `${B()}/restaurant-advances/${d.id}/link`, { orderId: r.id });
  flash = { kind: 'ok', text: `${x.guestName}'s ${rs(x.leftPaise)} advance is on ${d.place}.` };
  go(`#/order/${r.id}`);
};
actions.advBack = async (d) => {
  await api('POST', `${B()}/debtors/${d.a}/refund`, { mode: d.m, amount: d.amt, note: 'Restaurant advance given back' });
  flash = { kind: 'ok', text: `₹${d.amt} given back (${d.m === 'cash' ? 'cash from the drawer' : 'UPI'}).` }; route();
};
actions.advKeep = async (d) => {
  const note = prompt('Why is this advance kept (not given back)?');
  if (!note || !note.trim()) return;
  await api('POST', `${B()}/restaurant-advances/${d.id}/keep`, { note: note.trim() });
  flash = { kind: 'ok', text: 'Advance kept.' }; route();
};
actions.advLinkHere = async (d) => {
  await api('POST', `${B()}/restaurant-advances/${d.id}/link`, { orderId: ui.order.id });
  ui.oadv = (await api('GET', `${B()}/restaurant-advances?orderId=${ui.order.id}`)).advances;
  ui.waitAdv = (ui.waitAdv ?? []).filter((x) => x.id !== d.id);
  flash = { kind: 'ok', text: 'Advance put on this order.' }; rerender();
};

async function counterScreen() {
  const today = me.business.shiftDay;
  const [{ orders, tables, tablesFixed, sections }, fd, chart] = await Promise.all([
    api('GET', B() + '/orders'),
    api('GET', B() + '/frontdesk/today').catch(() => null),
    api('GET', `${B()}/frontdesk/chart?from=${today}&days=1`).catch(() => null),
    load('stays'),
  ]);
  ui.orders = orders; ui.tables = tables ?? []; ui.tablesFixed = !!tablesFixed; ui.sections = sections ?? []; ui.fd = fd; ui.cchart = chart;
  ui.arrivals = (fd?.arrivals ?? []).filter((a) => a.kind === 'booking');
  ui.radv = can('pos.view') ? (await api('GET', B() + '/restaurant-advances').catch(() => ({ advances: [] }))).advances : [];
  if (can('debtors.receive')) await load('payAccounts').catch(() => null);
  rerender = () => {
    const orderN = (st) => ui.orders.filter((o) => orderState(o) === st).length;
    const toPay = ui.orders.filter((o) => orderState(o) === 'billed').reduce((t, o) => t + (o.bill?.totalPaise ?? 0), 0);
    const carried = ui.orders.filter(isCarried);
    const overdue = carried.filter((o) => o.openedShiftDay < addDays(me.business.shiftDay, -1));
    const rest = ui.orders.filter((o) => o.kind !== 'table').sort((a, b) => a.openedAt - b.openedAt);
    const f = ui.fd;
    const alerts = [
      ...(f?.alerts.notInDjubo ?? []).map((x) => ({ tone: x.level === 'red' ? 'bad' : 'warn', text: `Not in Djubo yet: ${x.guestName} · ${x.rooms}`, href: '#/rooms/list' })),
      ...(ui.radv ?? []).filter((x) => !x.orderId && x.partyDay === today).map((x) => ({ tone: 'info', text: `Party today: ${x.guestName}${x.partyTime ? `, ${x.partyTime}` : ''} · ${rs(x.leftPaise)} advance`, href: '#/' })),
      ...(ui.radv ?? []).filter((x) => (!x.orderId && x.partyDay && x.partyDay < today) || x.orderStatus === 'closed' || x.orderStatus === 'cancelled').map((x) => ({ tone: 'warn', text: `Advance to give back: ${x.guestName} · ${rs(x.leftPaise)}`, href: '#/' })),
      ...overdue.map((o) => ({ tone: 'bad', text: `${o.place} open since ${dayName(o.openedShiftDay)}: clear before the day closes`, href: orderHref(o) })),
      ...(f?.alerts.deskToTake ? [{ tone: 'warn', text: `Reception money to take: ${plural(f.alerts.deskToTake, 'booking')}`, href: '#/rooms' }] : []),
      ...(f?.alerts.unplaced ? [{ tone: 'bad', text: `Djubo could not place ${plural(f.alerts.unplaced, 'booking')}`, href: '#/rooms/list' }] : []),
      ...(f?.alerts.formC ?? []).map((x) => ({ tone: x.level === 'red' ? 'bad' : 'info', text: `Form C due: ${x.room} · ${x.guestName}`, href: '#/rooms' })),
      ...(f?.nightsNotCharged ?? []).map((x) => ({ tone: 'bad', text: `Nights not charged: ${x.room} · ${x.guestName} (rent till ${dayName(x.coveredTo)})`, href: '#/rooms' })),
    ];
    paint(shell('#/counter', html`
      <div class="ctrtop">
        ${can('bills.print') ? html`<form class="findbill ctrfind" role="search"><label class="vh" for="findNo">Search</label>
          <input class="in" id="findNo" type="search" data-model="findNo" placeholder="Search: guest, phone, room, table or bill no.   /" value="${ui.findNo ?? ''}" autocomplete="off">
          <button class="btn" type="submit" data-act="findBill" data-submit>Search</button></form>` : ''}
        ${alerts.length ? html`<div class="ctralerts">${alerts.map((a) => html`<a class="status ${a.tone}" href="${a.href}">${a.text}</a>`)}</div>` : ''}
      </div>
      ${errorBox()}
      ${ui.found ? searchResults(ui.found) : ''}
      <div class="ctr">
        <section class="panel ctrcol" aria-label="Restaurant">
          <div class="row"><h2 class="grow" style="margin:0">Restaurant</h2>
            ${can('orders.edit') ? html`<button class="btn pri sm" type="button" data-act="newOrder" data-kind="table">New table · T</button>
              <button class="btn sm" type="button" data-act="newOrder" data-kind="room">Room service · R</button>
              <button class="btn sm" type="button" data-act="newOrder" data-kind="takeaway">Takeaway · K</button>` : ''}
            ${can('debtors.receive') ? html`<button class="btn sm" type="button" data-act="partyAdv">Party advance · A</button>` : ''}</div>
          ${ui.picking ? newOrderForm() : ''}
          ${ui.advForm ? advanceTakeForm() : ''}
          <div class="kpis">${kpi('Running', String(ui.orders.length))}${kpi('To pay', rs(toPay), plural(orderN('billed'), 'bill'))}${kpi('With kitchen', String(orderN('open')))}
            ${kpi('Not sent', String(orderN('new')), '', orderN('new') ? 'warn' : '')}${kpi('Carried over', String(carried.length), overdue.length ? `${overdue.length} overdue` : '', overdue.length ? 'bad' : '')}</div>
          ${can('orders.edit') && ui.tables.length ? tableGrid() : ''}
          ${(ui.radv ?? []).length ? advancesHeldList() : ''}
          <div class="sect"><h3 style="margin:0">Room service, takeaway and tabs</h3><span class="small quiet">${rest.length}</span></div>
          ${rest.length ? html`<div class="ctrlist">${rest.map((o) => { const st = orderState(o); return html`<a class="drow" href="${orderHref(o)}"><span class="grow"><strong>${o.place}</strong>
            <small>${KIND_TEXT[o.kind] ?? o.kind}${o.guestName ? ` · ${o.guestName}` : ''} · ${since(o.openedAt)}</small></span>
            <span class="dright">${carriedTag(o)}<span class="num">${rs(st === 'billed' ? o.bill?.totalPaise ?? 0 : o.itemsPaise)}</span> <span class="badge ${st}">${st === 'billed' ? 'To pay' : st === 'tab' ? 'Tab' : STATE_TEXT[st]}</span></span></a>`; })}</div>`
            : html`<p class="empty">No room service, takeaway or tab open.</p>`}
        </section>
        <section class="panel ctrcol" aria-label="Front desk">${f ? counterDesk(f) : html`<p class="empty">Could not load the front desk.</p>`}</section>
      </div>
      <p class="small quiet ctrkeys"><kbd>/</kbd> search · <kbd>T</kbd> new table · <kbd>R</kbd> room service · <kbd>K</kbd> takeaway · <kbd>C</kbd> check in · <kbd>N</kbd> new reservation · <kbd>Esc</kbd> close · the keys work on Tables and Rooms too</p>`));
  };
  rerender();
}
/** The front desk half of Counter: today's numbers, every room and bed tonight, then arriving, leaving and money owed. */
function counterDesk(f) {
  const today = f.today;
  const leavingRooms = new Set(f.leaving.map((x) => roomKeyOf(x.room)));
  const hk = ui.cchart?.housekeeping ?? {};
  const tonight = (room) => {
    const key = roomKeyOf(room);
    if (leavingRooms.has(key)) return ['out', 'Leaving'];
    const bar = (ui.cchart?.bars ?? []).find((b) => roomKeyOf(b.room) === key && b.from <= today && b.to > today);
    if (bar?.kind === 'occ') return ['inh', (bar.guest ?? bar.label ?? 'In house').split(' ')[0]];
    if (bar && ['arr', 'pos', 'hold'].includes(bar.kind)) return ['arr', 'Arriving'];
    if (bar?.kind === 'ooo') return ['ooo', 'Out of order'];
    return hk[room] === 'dirty' ? ['dirty', 'Dirty'] : ['free', 'Free'];
  };
  const secs = ui.cchart?.sections ?? [];
  const roomSecs = secs.filter((x) => x.kind === 'rooms');
  const dormSecs = secs.filter((x) => x.kind === 'dorms');
  const beds = dormSecs.flatMap((x) => x.rooms);
  const bedFree = beds.filter((b) => ['free', 'dirty'].includes(tonight(b)[0])).length;
  const due = (p) => (p ? html`<span class="status warn">Collect ${rs(p)}</span>` : html`<span class="status ok">Prepaid</span>`);
  const owes = (b) => (b > 0 ? html`<span class="status warn">Owes ${rs(b)}</span>` : b < 0 ? html`<span class="status info">Holds ${rs(-b)}</span>` : html`<span class="status ok">Settled</span>`);
  const owing = f.inHouse.filter((x) => x.balancePaise > 0 && !(x.plan && x.plan <= today));
  const group = (title, n, href, rows, empty) => html`<div class="ctrgroup"><div class="sect"><h3 style="margin:0">${title}</h3><a class="small" href="${href}">${n > rows.length ? `All ${n}` : 'Open'}</a></div>${rows.length ? rows : html`<p class="empty">${empty}</p>`}</div>`;
  const dormOf = new Map(dormSecs.flatMap((x) => (x.rooms ?? []).map((b) => [b, b.replace(/\s*[A-Z]$|\s*·\s*Bed \d+$/, '')])));
  const dorms = [...new Set(beds.map((b) => dormOf.get(b)))];
  return html`<div class="row"><h2 class="grow" style="margin:0">Front desk</h2>
      <a class="btn pri sm" href="#/rooms/checkin">Check in · C</a><a class="btn sm" href="#/rooms/new">New reservation · N</a>
      <button class="btn sm" type="button" data-act="counterAdv">Take advance</button></div>
    <div class="kpis">${kpi('Arriving', String(f.stats.arriving), f.stats.toCollectPaise ? `${rs(f.stats.toCollectPaise)} to collect today` : '')}${kpi('In house', String(f.stats.inHouse))}
      ${kpi('Leaving', String(f.stats.leaving), '', f.leaving.some((x) => x.balancePaise > 0) ? 'warn' : '')}${kpi('Free tonight', String(f.stats.freeTonight), 'rooms and beds')}</div>
    ${roomSecs.length ? html`<div class="sect"><h3 style="margin:0">Tonight · ${plural(roomSecs.reduce((n, x) => n + x.rooms.length, 0), 'room')}</h3><a class="small" href="#/rooms/chart">Room chart</a></div>
      <div class="ctrrooms">${roomSecs.flatMap((x) => x.rooms).map((r) => { const [k, t] = tonight(r); return html`<span class="ctrroom c-${k}" title="${r}: ${t}"><strong>${r}</strong><small>${t}</small></span>`; })}</div>` : ''}
    ${beds.length ? html`<div class="sect"><h3 style="margin:0">Dorms · ${plural(beds.length, 'bed')}</h3><span class="small quiet">${beds.length - bedFree} taken · ${bedFree} free</span></div>
      <div class="ctrdorms">${dorms.map((d) => html`<div class="ctrdorm"><strong>${d}</strong><div>${beds.filter((b) => dormOf.get(b) === d).map((b) => { const [k, t] = tonight(b); return html`<span class="ctrbed c-${k}" title="${b}: ${t}"></span>`; })}</div></div>`)}</div>
      <p class="small quiet" style="margin:0">Teal in house · amber arriving · grey leaving · dashed free · red outline dirty</p>` : ''}
    ${group('Arriving today', f.arrivals.length, '#/rooms', f.arrivals.slice(0, 4).map((x) => html`<button type="button" class="drow" data-act="goCheckin" data-kind="${x.kind}" data-id="${x.id}"><span class="grow"><strong>${x.guestName ?? 'No name'}</strong>
      <small>${x.kind === 'reservation' ? x.rooms : `${x.roomType ?? '?'}${x.roomLabels ? ` ${x.roomLabels}` : ''}`} · till ${dayName(x.checkOut)}</small></span><span class="dright">${due(x.duePaise)}<span class="btn sm">Check in</span></span></button>`), 'No more arrivals today.')}
    ${group('Leaving today', f.leaving.length, '#/rooms', f.leaving.slice(0, 4).map((x) => html`<button type="button" class="drow" data-act="counterBill" data-id="${x.id}"><span class="grow"><strong>${x.room} · ${x.guestName}</strong><small>check-out 11 am</small></span>
      <span class="dright">${owes(x.balancePaise)}<span class="btn sm">Check out</span></span></button>`), 'Nobody is due to leave today.')}
    ${group('In house with money owed', owing.length, '#/rooms', owing.slice(0, 4).map((x) => html`<button type="button" class="drow" data-act="counterBill" data-id="${x.id}"><span class="grow"><strong>${x.room} · ${x.guestName}</strong><small>${x.plan ? `till ${dayName(x.plan)}` : 'no check-out date'}</small></span>
      <span class="dright">${owes(x.balancePaise)}<span class="btn sm">Room bill</span></span></button>`), 'Nobody in house owes anything.')}`;
}
actions.counterBill = (d) => { reopenStay = d.id; go('#/rooms'); };
actions.counterAdv = () => { pendingAdv = true; go('#/rooms'); };
let pendingAdv = false;   // "Take advance" on Counter opens the form on Rooms, where it lives

async function tablesScreen() {
  const [{ orders, tables, tablesFixed, sections }, ev, live] = await Promise.all([api('GET', B() + '/orders'), api('GET', B() + '/event-mode/now').catch(() => ({ event: null })),
    api('GET', B() + '/serving/live').catch(() => ({ lines: [] })), load('stays')]);
  ui.svLive = live.lines;
  // Serving timers (28 Nov 2026): the orders and their timers again every 30 seconds.
  startLive(async () => { const [o, l] = await Promise.all([api('GET', B() + '/orders'), api('GET', B() + '/serving/live')]); ui.orders = o.orders; ui.svLive = l.lines; });
  ui.orders = orders; ui.tables = tables ?? []; ui.tablesFixed = !!tablesFixed; ui.sections = sections ?? []; ui.event = ev.event;
  if (pendingPick) { ui.picking = pendingPick; pendingPick = null; }
  // Restaurant advances (26 Nov 2026): taken and held here as on the Counter.
  ui.radv = can('pos.view') ? (await api('GET', B() + '/restaurant-advances').catch(() => ({ advances: [] }))).advances : [];
  if (can('debtors.receive')) await load('payAccounts').catch(() => null);
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
        <div class="row" style="gap:6px">${carriedTag(o)}${svTile(o)}<span class="badge ${s}">${s === 'billed' ? `Bill ${o.bill?.billNo} · to pay` : s === 'tab' ? `Tab since ${dayName(o.openedShiftDay)}` : STATE_TEXT[s]}</span></div>
        <span class="small quiet">${o.guestName ? o.guestName + ' · ' : ''}${plural(o.lines.reduce((t, l) => t + l.qty, 0), 'item')} · opened ${time(o.openedAt)} (${since(o.openedAt)})</span></a>`;
    };
    paint(shell('#/', html`
      <div class="floorbar">
        <div><h1>Tables and orders</h1><p class="sub quiet" style="margin-top:4px">Tap a free table to start an order. Tap a busy one to add dishes or take payment.</p></div>
        ${can('orders.edit') ? html`<div class="startbar" role="group" aria-label="Start an order">
          <button class="btn ${ui.picking === 'table' ? 'pri' : ''}" type="button" data-act="newOrder" data-kind="table">New table order</button>
          <button class="btn ${ui.picking === 'room' ? 'pri' : ''}" type="button" data-act="newOrder" data-kind="room">Room service</button>
          <button class="btn ${ui.picking === 'takeaway' ? 'pri' : ''}" type="button" data-act="newOrder" data-kind="takeaway">Takeaway</button>
          ${can('debtors.receive') ? html`<button class="btn ${ui.advForm ? 'pri' : ''}" type="button" data-act="partyAdv">Party advance</button>` : ''}
          ${can('serve.manage') ? html`<a class="btn" href="#/serving">Serving</a>` : ''}</div>` : can('serve.manage') ? html`<a class="btn" href="#/serving">Serving</a>` : ''}
      </div>
      ${errorBox()}
      ${ui.event ? eventStrip(ui.event) : ''}
      ${ui.picking ? newOrderForm() : ''}
      ${ui.advForm ? advanceTakeForm() : ''}
      <div class="row between" style="margin-bottom:14px;align-items:center">
        <div class="counts" style="margin:0">
          <span class="badge billed">${n('billed')} to pay</span><span class="badge new">${n('new')} not sent</span>
          <span class="badge open">${n('open')} with kitchen</span><span class="badge tab">${plural(n('tab'), 'tab')}</span>
          <span class="small quiet" style="align-self:center">Running total ${rs(onFloor)}</span></div>
        ${can('bills.print') ? html`<form class="findbill" role="search"><label class="vh" for="findNo">Search</label><input class="in" id="findNo" data-model="findNo" placeholder="Search: bill no., guest name, phone, table or room" value="${ui.findNo ?? ''}" inputmode="search" autocomplete="off">
          <button class="btn" type="submit" data-act="findBill" data-submit>Search</button></form>` : ''}
      </div>
      ${ui.found ? searchResults(ui.found) : ''}
      ${showGrid ? tableGrid() : ''}
      ${(ui.radv ?? []).length ? advancesHeldList() : ''}
      <div class="sect"><h2>${showGrid ? 'Room service, takeaway and tabs' : 'Open orders'}</h2>
        ${rest.length ? html`<span class="small quiet">Bills to pay first, then oldest</span>` : ''}</div>
      ${rest.length ? html`<div class="olist">${rest.map(card)}</div>` : html`<p class="empty">${showGrid ? 'No room service, takeaway or tab open.' : 'No open orders. Start one above.'}</p>`}`));
  };
  rerender();
}
/** The tables, by section (Private Rooms, Dorms, Out House, NC…): a busy one opens its order or bill, a free one starts an order. */
const roomKeyOf = (x) => String(x).toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '');
const isMgr = () => ['owner', 'manager'].includes(me?.staff.role);
/** A dorm bed's name: by letter as in Djubo ("II B") when the dorm says so, else "II · Bed 2" (23 Nov 2026). */
const bedName = (d, i) => (d.letters ? `${d.name} ${String.fromCharCode(65 + i)}` : `${d.name} · Bed ${i + 1}`);
const bedLabel = (d, i) => (d.letters ? `${d.name} ${String.fromCharCode(65 + i)}` : `Bed ${i + 1}`);
const SECTION_NOTE = { rooms: "Orders go on the room's folio or are paid at the table", dorms: 'Each bed is sold on its own; “whole” is for a group that books all of it',
  outhouse: 'Guests not staying with us', nc: 'Non-chargeable: closes as complimentary in the person’s name · managers and owners only', other: '' };
const eventStrip = (e) => html`<div class="msg warn evstrip" role="status"><span class="evtag">EVENT ON</span><span><strong>${e.name}</strong> · ${e.organiser} · until ${time(e.endsAt)} · ${e.sections.join(', ')} bills count towards ${e.commissionBp / 100}% commission${e.menu ? ` · menu: ${e.menu.join(', ')}` : ''}</span></div>`;
/** A table carried over (24 Nov 2026): from an earlier day (red once carried over two day closes), or handed over by a cashier today. */
const isCarried = (o) => o.status !== 'tab' && (o.openedShiftDay < me.business.shiftDay || !!o.handedFrom);
const carriedTag = (o) => (o.status === 'tab' ? ''
  : o.openedShiftDay < addDays(me.business.shiftDay, -1) ? html`<span class="ctag over">From ${dayName(o.openedShiftDay)} · overdue</span>`
  : o.openedShiftDay < me.business.shiftDay ? html`<span class="ctag day">From ${dayName(o.openedShiftDay)}</span>`
  : o.handedFrom ? html`<span class="ctag who">From ${o.handedFrom}</span>` : '');
function tableGrid() {
  const busy = new Map(ui.orders.filter((o) => o.kind === 'table').map((o) => [o.place.toLowerCase(), o]));
  const secs = ui.sections.length ? ui.sections : [{ name: 'Tables', kind: 'other', tables: ui.tables }];
  // An open order at a table that is not in the list (typed by hand) still shows, at the end.
  const listed = new Set(secs.flatMap((x) => x.tables).map((t) => t.toLowerCase()));
  const extra = [...busy.values()].filter((o) => !listed.has(o.place.toLowerCase())).map((o) => o.place);
  const all = [...secs, ...(extra.length ? [{ name: 'Other tables', kind: 'other', tables: extra }] : [])];
  // Who is staying in a room or bed, and which night of their stay it is (22 Nov 2026).
  const stayAt = (t) => cache.stays?.find((x) => roomKeyOf(x.room) === roomKeyOf(t)) ?? null;
  const nightOf = (st) => Math.max(1, Math.round((Date.parse(me.business.shiftDay) - Date.parse(st.checkIn)) / 86_400_000) + 1);
  const isRoom = (kind) => kind === 'rooms' || kind === 'dorms';
  const cell = (t, kind, blocked, label = t) => {
    const o = busy.get(t.toLowerCase());
    const nc = kind === 'nc';
    if (!o && blocked) return html`<span class="tcell free blocked" aria-label="${t}: ${blocked}"><span class="tn">${label}</span><span class="ts">${blocked}</span></span>`;
    const guest = isRoom(kind) ? stayAt(t) : null;
    if (!o) {
      // A guest staying: the order goes on their folio. An empty room or bed: a walk-in order.
      return html`<button type="button" class="tcell free ${nc ? 'nc' : ''} ${guest ? 'stay' : ''}" data-act="quickTable" data-place="${t}" aria-label="${t}, ${guest ? `${guest.guestName} staying` : 'empty'}: start an order">
        <span class="tn">${label}</span>${guest ? html`<span class="tg">${guest.guestName}</span><span class="ts">Staying · night ${nightOf(guest)}</span>`
          : html`<span class="ts">${nc ? html`<span class="ncbadge">NC</span> Free` : label !== t ? 'Empty' : isRoom(kind) ? 'Empty · tap for walk-in' : 'Free'}</span>`}</button>`;
    }
    const s = orderState(o);
    const who = guest?.guestName ?? o.guestName;
    return html`<a class="tcell ${s} ${nc ? 'nc' : ''}" href="${orderHref(o)}" aria-label="${t}, ${STATE_TEXT[s]}${o.notSent ? ', not sent yet' : ''}">${carriedTag(o)}${o.notSent ? html`<span class="offtag">NOT SENT</span>` : ''}<span class="tn">${label}</span>${who ? html`<span class="tg">${who}</span>` : ''}
      <span class="ta">${rs(s === 'billed' ? o.bill?.totalPaise ?? 0 : o.itemsPaise)}</span><span class="ts">${nc ? html`<span class="ncbadge">NC</span> ` : ''}${STATE_SHORT[s]} · ${since(o.openedAt)}</span>${svTile(o)}</a>`;
  };
  const used = (t) => busy.has(t.toLowerCase()) || !!stayAt(t);
  const free = all.flatMap((x) => x.tables).filter((t) => !busy.has(t.toLowerCase())).length;
  const total = all.flatMap((x) => x.tables).length;
  // Opens on Running tables: every table, room or bed with an order now (22 Nov 2026).
  ui.tSec ??= tSecMemo;
  // Tabs: Running tables, then by kind: Private rooms, Dorms, Out House, NC (and Tables for any other section).
  const rooms = all.filter((x) => x.kind === 'rooms');
  const dorms = all.filter((x) => x.kind === 'dorms');
  const bedsOf = (x) => x.tables.filter((t) => !/ · whole$/.test(t));
  const roomList = rooms.flatMap((x) => x.tables);
  const bedList = dorms.flatMap(bedsOf);
  const KIND_TAB = [['rooms', 'Private rooms'], ['dorms', 'Dorms'], ['outhouse', 'Out House'], ['nc', 'NC'], ['other', 'Tables']];
  // A bed is taken when someone stays in it, it has an order, or its dorm room has a whole-room order.
  const dormOfBed = new Map(dorms.flatMap((x) => (x.dorms ?? []).flatMap((d) => Array.from({ length: d.beds }, (_, i) => [bedName(d, i).toLowerCase(), d.name]))));
  const bedTaken = (t) => used(t) || busy.has(`${dormOfBed.get(t.toLowerCase()) ?? t} · whole`.toLowerCase());
  const countOf = (k) => (k === 'rooms' ? `${roomList.length} · ${roomList.filter(used).length} occupied`
    : k === 'dorms' ? `${bedList.length} beds · ${bedList.filter(bedTaken).length} taken`
    : String(all.filter((x) => x.kind === k).reduce((n, x) => n + x.tables.length, 0)));
  const tabList = KIND_TAB.filter(([k]) => all.some((x) => x.kind === k));
  const running = all.flatMap((x) => x.tables).filter((t) => busy.has(t.toLowerCase()));
  const tabs = html`<div class="secttabs" role="group" aria-label="Sections"><button type="button" data-act="tSec" data-name="running" aria-pressed="${ui.tSec === 'running'}">Running tables<span class="n">${running.length}</span></button>
    ${tabList.map(([k, t]) => html`<button type="button" data-act="tSec" data-name="${k}" aria-pressed="${ui.tSec === k}">${t}<span class="n">${countOf(k)}</span></button>`)}</div>`;
  // Small room types (1 or 2 rooms) share one row, where the first of them comes.
  const groups = [];
  let small = null;
  for (const x of all.filter((y) => ui.tSec === 'running' || y.kind === ui.tSec)) {
    if (x.kind === 'rooms' && x.tables.length <= 2) {
      if (small) { small.names.push(x.name); small.tables.push(...x.tables); continue; }
      small = { ...x, names: [x.name], tables: [...x.tables] }; groups.push(small); continue;
    }
    groups.push({ ...x, names: [x.name], tables: [...x.tables] });
  }
  const dormCard = (d) => {
    const whole = `${d.name} · whole`;
    const beds = Array.from({ length: d.beds }, (_, i) => bedName(d, i));
    const wholeBusy = busy.has(whole.toLowerCase());
    const bedBusy = beds.some((b) => busy.has(b.toLowerCase()));
    const taken = beds.filter(bedTaken).length;
    return html`<div class="dormcard ${wholeBusy ? 'whole' : ''}"><div class="dh"><b>${d.name}</b><span class="small quiet">${wholeBusy ? 'Whole room order' : taken ? `${taken} of ${d.beds} beds` : 'Empty'}</span></div>
      <div class="tgrid ${d.beds === 4 ? 'four' : ''}">${beds.map((b, i) => cell(b, 'dorms', wholeBusy ? 'In the whole-room order' : null, bedLabel(d, i)))}</div>
      <div class="wholebtn">${cell(whole, 'dorms', bedBusy ? 'Beds have their own orders' : null, 'Order for the whole room')}</div></div>`;
  };
  const head = (x) => {
    const occ = x.kind === 'rooms' ? `${x.tables.filter(used).length} of ${x.tables.length} occupied` : x.kind === 'dorms' ? `${bedsOf(x).filter(bedTaken).length} of ${bedsOf(x).length} beds taken` : SECTION_NOTE[x.kind];
    return html`<div class="grouph"><h3>${x.names.join(', ')}</h3>${occ ? html`<span class="small quiet">${occ}</span>` : ''}</div>`;
  };
  // Running tables: only what has an order, beds by their full name.
  if (ui.tSec === 'running') {
    for (const g of groups) g.tables = g.tables.filter((t) => busy.has(t.toLowerCase()));
    const live = groups.filter((g) => g.tables.length);
    // Carried over first, oldest first (24 Nov 2026), then the rest in the order of the sections.
    const carried = live.flatMap((x) => x.tables.map((t) => [t, x.kind])).filter(([t]) => isCarried(busy.get(t.toLowerCase())))
      .sort((a, b) => busy.get(a[0].toLowerCase()).openedAt - busy.get(b[0].toLowerCase()).openedAt);
    const carriedSet = new Set(carried.map(([t]) => t));
    return html`<div class="sect"><h2>Tables <span class="small quiet" style="font-weight:500">· ${free} free of ${total}</span></h2></div>${tabs}
      ${carried.length ? html`<div class="grouph"><h3>Carried over</h3><span class="small quiet">${plural(carried.length, 'table')} from an earlier day or cashier: settle these first</span></div>
        <div class="tgrid roomgrid">${carried.map(([t, k]) => cell(t, k, null))}</div>` : ''}
      ${live.length > 0 && running.length > carried.length ? html`<div class="grouph"><span class="small quiet">${plural(running.length - carried.length, 'running order')}, in the order of your sections</span></div>
        <div class="tgrid roomgrid">${live.flatMap((x) => x.tables.filter((t) => !carriedSet.has(t)).map((t) => cell(t, x.kind, null)))}</div>` : carried.length ? ''
        : html`<p class="empty">No table, room or bed has an order right now. Choose Private rooms, Dorms, Out House or NC to start one.</p>`}`;
  }
  const body = (x) => (x.kind === 'dorms' ? html`<div class="dormcards">${(x.dorms ?? []).map(dormCard)}</div>`
    : html`<div class="tgrid ${x.kind === 'rooms' ? 'roomgrid' : ''}">${x.tables.map((t) => cell(t, x.kind, x.kind === 'nc' && !isMgr() ? 'Managers only' : null))}</div>`);
  return html`<div class="sect"><h2>Tables <span class="small quiet" style="font-weight:500">· ${free} free of ${total}</span></h2>
      <div class="legend" aria-hidden="true"><span><i class="free"></i>Free</span>${roomList.length || bedList.length ? html`<span><i class="stay"></i>Guest staying, no order</span>` : ''}<span><i class="new"></i>Not sent</span><span><i class="open"></i>With kitchen</span><span><i class="billed"></i>To pay</span><span><i class="tab"></i>Tab</span></div></div>
    ${ui.tablesFixed ? '' : html`<p class="small quiet" style="margin:-4px 0 10px">Showing tables used lately. Set your own tables, in sections, in Settings, Rooms and tables.</p>`}
    ${tabs}
    ${groups.map((x) => html`${all.length > 1 ? head(x) : ''}${body(x)}`)}`;
}
let tSecMemo = 'running';   // the Tables tab last chosen, kept while moving between screens
actions.tSec = (d) => { ui.tSec = tSecMemo = d.name; rerender(); };
actions.quickTable = async (d) => { const r = await api('POST', B() + '/orders', { kind: 'table', place: d.place }); go(`#/order/${r.id}`); };
/** In-house guests, found by name, room or phone (21 Nov 2026): for room service and for putting a bill on a room. */
function stayPicker(act, chosen, idOf) {
  const q = (ui.stQ ?? '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const list = cache.stays.filter((s) => !q || s.guestName.toLowerCase().includes(q) || String(s.room).toLowerCase().includes(q) || (digits.length >= 2 && (s.phone ?? '').includes(digits)));
  const phoneText = (p) => {
    if (!p) return '';
    const at = digits.length >= 2 ? p.indexOf(digits) : -1;
    if (at < 0) return html`Phone ••••${p.slice(-4)}`;
    return html`Phone ${'•'.repeat(at)}<mark>${p.slice(at, at + digits.length)}</mark>${p.slice(at + digits.length).replace(/\d(?=\d{4})/g, '•')}`;
  };
  if (!cache.stays.length) return html`<p class="quiet">No room has an open stay. Check a guest in on Rooms.</p>`;
  return html`<div class="f stayfind">Which guest
    <input class="in" type="search" data-model="stQ" data-live value="${ui.stQ ?? ''}" placeholder="Search by guest name, room or phone" aria-label="Search guests by name, room or phone" autocomplete="off">
    <div class="stayhits">${list.slice(0, 12).map((s) => html`<button type="button" class="stayhit" aria-pressed="${chosen === idOf(s)}" data-act="${act}" data-k="debtorAccountId" data-id="${idOf(s)}">
      <strong>${String(s.room).match(/^\d/) ? 'Room ' : ''}${s.room} · ${s.guestName}</strong><span class="small">since ${dayName(s.checkIn)}</span>
      <span class="small quiet">${phoneText(s.phone)}</span><span class="small">${rs(Math.max(0, s.balancePaise))} on folio</span></button>`)}
      ${list.length ? '' : html`<p class="small quiet">No guest matches “${ui.stQ}”.</p>`}${list.length > 12 ? html`<p class="small quiet">${list.length - 12} more: type more of the name, room or phone.</p>` : ''}</div></div>`;
}
function newOrderForm() {
  const k = ui.picking;
  return html`<form class="panel" style="margin-bottom:18px;max-width:640px">
    <h2>${k === 'table' ? 'New table order' : k === 'room' ? 'Room service' : 'Takeaway'}</h2>
    ${k === 'table' ? html`<div class="grid2"><label class="f">Table<input class="in" data-model="place" autofocus placeholder="e.g. T4"></label>
      <label class="f">Guests<input class="in" inputmode="numeric" data-model="covers"></label></div>
      <div class="grid2"><label class="f">Guest name (optional)<input class="in" data-model="guestName"></label><label class="f">Phone (optional)<input class="in" inputmode="tel" data-model="guestPhone" data-live value="${ui.guestPhone ?? ''}"></label></div>${phoneHint(ui.guestPhone)}` : ''}
    ${k === 'room' ? stayPicker('pickStay', ui.stayId, (s) => s.id) : ''}
    ${k === 'takeaway' ? html`<div class="grid2"><label class="f">Guest name (optional)<input class="in" data-model="guestName" autofocus></label><label class="f">Phone (optional)<input class="in" inputmode="tel" data-model="guestPhone" data-live value="${ui.guestPhone ?? ''}"></label></div>${phoneHint(ui.guestPhone)}` : ''}
    <div class="row"><button class="btn pri" type="submit" data-act="openOrder" data-submit>Start order</button><button class="btn" type="button" data-act="newOrder" data-kind="">Cancel</button></div>
  </form>`;
}
actions.findBill = async () => { ui.found = await api('GET', `${B()}/search?q=${encodeURIComponent((ui.findNo ?? '').trim())}`); rerender(); };
actions.findClose = () => { ui.found = null; ui.findNo = ''; rerender(); };
const PAID_BY = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'To room', credit: 'On credit', comp: 'Complimentary', advance: 'Advance' };
/** The counter's search results (22 Nov 2026): what is open now, then bills, each a link to the order or the receipt. */
function searchResults(r) {
  const who = (x) => [x.guestName, x.phone].filter(Boolean).join(' · ') || html`<span class="quiet">No guest</span>`;
  const openState = (o) => (o.billNo ? `Bill ${o.billNo} · to pay` : o.status === 'tab' ? 'Tab' : 'Open');
  const billState = (b) => (b.status === 'void' ? 'Void' : `Paid${b.modes.length ? ` · ${b.modes.map((m) => PAID_BY[m] ?? m).join(', ')}` : ''}`);
  return html`<div class="results" role="status"><div class="row between"><strong>${plural(r.open.length + r.bills.length, 'result')}</strong><button class="btn ghost" type="button" data-act="findClose">Close</button></div>
    ${r.open.length ? html`<p class="rh">Open now</p>${r.open.map((o) => html`<a class="rrow" href="${o.billId ? `#/settle/${o.billId}` : `#/order/${o.id}`}"><b>${o.place}</b><span>${who(o)}</span><span class="quiet">opened ${time(o.openedAt)}</span><span class="num">${rs(o.amountPaise)}</span><span><span class="badge ${o.billNo ? 'billed' : o.status === 'tab' ? 'tab' : 'open'}">${openState(o)}</span></span></a>`)}` : ''}
    ${r.bills.length ? html`<p class="rh">Bills${r.days ? ` (last ${r.days} days)` : ''}</p>${r.bills.map((b) => html`<a class="rrow" href="#/done/${b.id}"><b>${b.billNo}</b><span>${who(b)}</span><span class="quiet">${dateTime(b.printedAt)} · ${b.place}</span><span class="num">${rs(b.totalPaise)}</span><span><span class="badge ${b.status === 'void' ? 'void' : 'paid'}">${billState(b)}</span></span></a>`)}` : ''}
    ${r.open.length || r.bills.length ? '' : html`<p class="quiet">Nothing matches “${ui.findNo}”. Phone numbers need at least 4 digits.</p>`}</div>`;
}
actions.newOrder = (d) => { ui.picking = d.kind || null; ui.stayId = null; ui.error = null; rerender(); };
actions.pickStay = (d) => { ui.stayId = d.id; rerender(); };
actions.openOrder = async () => {
  const covers = Number(ui.covers);
  // The server asks for a place on every order; for room service it is the chosen room (the server then names it from the stay).
  const stay = ui.picking === 'room' ? cache.stays.find((s) => s.id === ui.stayId) : null;
  const r = await api('POST', B() + '/orders', { kind: ui.picking, place: stay ? `Room ${stay.room}` : ui.place, stayId: ui.stayId, guestName: ui.guestName, guestPhone: ui.picking === 'room' ? undefined : ui.guestPhone, covers: Number.isInteger(covers) && covers > 0 ? covers : undefined });
  go(`#/order/${r.id}`);
};

// ---------- order

/** The guest on an order (22 Nov 2026): name and phone boxes, always shown, saved when you leave them; a returning guest's visits. */
/**
 * A restaurant table for a guest in house (27 Nov 2026): linked, their check-out waits for it and paying offers their
 * room bill first. Before typing, only guests who left their room with the bill open are offered; typing shows the top 5.
 */
function guestLinkBox(o) {
  if (o.kind !== 'table' || (o.status !== 'open' && o.status !== 'tab') || !can('orders.edit')) return '';
  const stays = cache.stays ?? [];
  const linked = o.stayId ? stays.find((x) => x.id === o.stayId) : null;
  // A room or bed tile belongs to whoever is staying in it: nothing to choose.
  if (linked && roomKeyOf(roomShow(linked.room)) === roomKeyOf(o.place)) return '';
  if (o.stayId && !linked) return '';
  if (linked) return html`<div class="small" style="padding:0 16px 8px">For a guest in house: <strong>${roomShow(linked.room)} · ${linked.guestName}</strong>${String(linked.room).endsWith(' (left room)') ? html` <span class="status warn">Left room</span>` : ''}
    <button class="btn sm ghost" type="button" data-act="glSet" data-id="">Not this guest</button></div>`;
  if (!ui.glOpen) return html`<div class="small" style="padding:0 16px 8px"><button class="btn sm ghost" type="button" data-act="glAsk">For a guest in house?</button></div>`;
  const q = String(ui.glQ ?? '').trim().toLowerCase();
  const heads = stays.filter((x) => !x.groupStayId);
  const list = q ? heads.filter((x) => `${roomShow(x.room)} ${x.guestName}`.toLowerCase().includes(q)).slice(0, 5) : heads.filter((x) => String(x.room).endsWith(' (left room)')).slice(0, 5);
  return html`<div class="panel" style="margin:0 16px 10px;padding:10px"><div class="row" style="justify-content:space-between"><strong class="small">For a guest in house?</strong><button class="btn sm ghost" type="button" data-act="glNo">Cancel</button></div>
    <input class="in" data-model="glQ" data-live value="${ui.glQ ?? ''}" placeholder="Type a name or room" autofocus>
    <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">${list.map((x) => html`<button class="btn sm" type="button" style="text-align:left" data-act="glSet" data-id="${x.id}">${roomShow(x.room)} · ${x.guestName}${String(x.room).endsWith(' (left room)') ? ' · left room' : ''}</button>`)}
      ${list.length ? '' : html`<span class="small quiet">${q ? 'No guest in house matches.' : 'Type 2 or 3 letters of the name or room.'}</span>`}</div></div>`;
}
actions.glAsk = async () => { ui.glOpen = true; ui.glQ = ''; await load('stays'); rerender(); };
actions.glNo = () => { ui.glOpen = false; rerender(); };
actions.glSet = async (d) => {
  await api('POST', `${B()}/orders/${ui.order.id}/stay`, { stayId: d.id || null });
  ui.glOpen = false;
  ui.order = (await api('GET', `${B()}/orders/${ui.order.id}`)).order;
  flash = { kind: 'ok', text: d.id ? 'Linked: their check-out waits for this table, and paying offers their room bill.' : 'Unlinked.' };
  rerender();
};
function guestLine(o) {
  const g = ui.guest ?? { name: o.guestName, phone: o.guestPhone, visits: 0 };
  return html`<form class="guestedit"><div class="grid2">
      <label class="f">Guest name<input class="in" data-model="gName" data-guest-box value="${ui.gName ?? g.name ?? ''}" placeholder="${o.status === 'tab' ? 'Required for a tab' : 'Optional'}" autocomplete="off"></label>
      <label class="f">Phone<input class="in" inputmode="tel" data-model="gPhone" data-guest-box data-live value="${ui.gPhone ?? ''}" placeholder="${g.phone ? `${g.phone} on file` : '10-digit mobile'}" autocomplete="off"></label></div>
    ${phoneHint(ui.gPhone)}
    ${g.visits ? html`<p class="small guestl ret"><strong>Returning guest</strong> · ${g.visits === 1 ? 'came once before' : `came ${g.visits} times before`}${g.lastVisit ? `, last ${dayName(g.lastVisit)}` : ''}${g.usualPaise ? ` · usually ${rs(g.usualPaise)}` : ''}</p>` : ''}
    <button class="vh" type="submit" data-act="gSave" data-submit tabindex="-1">Save guest</button></form>`;
}
// Saved when the cursor leaves the name and phone boxes (not when moving from one to the other), or on Enter.
// The screen redraws as a phone is typed (for its check), which also moves the cursor: wait a moment and save only if the
// cursor is really outside both boxes.
root.addEventListener('focusout', (ev) => {
  if (ev.target.dataset?.guestBox === undefined) return;
  setTimeout(() => {
    if (document.activeElement?.dataset?.guestBox !== undefined || !ui.order) return;
    Promise.resolve(actions.gSave({})).catch((e) => actionError(e, 'gSave', {}));
  }, 0);
});
actions.gSave = async () => {
  const g = ui.guest ?? {};
  const name = (ui.gName ?? g.name ?? '').trim();
  const phone = (ui.gPhone ?? '').trim();
  if (phone && phoneProblem(phone)) return;                       // the box already says why; nothing is saved
  if (name === (g.name ?? '') && !phone) return;                  // nothing changed
  const r = await api('POST', `${B()}/orders/${ui.order.id}/guest`, { guestName: name, ...(phone ? { guestPhone: phone } : {}) });
  ui.guest = r.guest; ui.order.guestName = r.guest.name; ui.order.guestPhone = r.guest.phone; ui.gName = undefined; ui.gPhone = undefined;
  flash = null; rerender();
};

async function orderScreen(id) {
  await load('menu', 'reasons', 'stays');
  ui.glOpen = false;
  const [o, ev] = await Promise.all([api('GET', `${B()}/orders/${id}`), api('GET', `${B()}/event-mode/now`).catch(() => ({ event: null }))]);
  ui.order = o.order; ui.event = ev.event; ui.guest = o.order.guest;
  ui.cat = 'All'; ui.q = '';
  // Advances on this order, and parties' advances waiting for a table (26 Nov 2026).
  const adv = can('pos.view') ? (await api('GET', `${B()}/restaurant-advances`).catch(() => ({ advances: [] }))).advances : [];
  ui.oadv = adv.filter((x) => x.orderId === id);
  ui.waitAdv = adv.filter((x) => !x.orderId && x.partyDay && x.partyDay <= me.business.shiftDay);
  if (can('debtors.receive')) await load('payAccounts').catch(() => null);
  rerender = () => {
    const o = ui.order;
    if (o.status === 'billed' || o.status === 'closed') { paint(shell('#/', html`<p class="empty">This order is already billed. <a href="#/">Back to tables</a></p>`)); return; }
    // During an event, its tables show only the event's menu sections (the full menu is one tap away).
    const evMenu = ui.event?.menu && o.kind === 'table' && ui.event.tables.some((t) => t.toLowerCase() === o.place.toLowerCase()) && !ui.fullMenu ? ui.event.menu : null;
    const menu = cache.menu.filter((m) => m.active && (!evMenu || evMenu.includes(m.category)));
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
          ${l.remark ? html`<div class="mods" style="color:var(--warn);font-weight:600">✎ ${l.remark}</div>` : ''}
          <div class="sub">${rs(l.pricePaise)} each${l.typedPrice ? ' · price typed' : ''}${l.noKot ? ' · no KOT' : ''}${l.sentQty && l.qty > l.sentQty ? ` · ${l.sentQty} sent, ${l.qty - l.sentQty} new` : ''}</div>
          ${l.qty > l.sentQty && !l.noKot && ui.remFor !== l.id ? html`<button type="button" class="btn ghost addln" style="padding:2px 8px;font-size:12.5px" data-act="remOpen" data-id="${l.id}">${l.remark ? '✎ Change remark' : '+ Remark'}</button>` : ''}</div>
        <button class="sq" type="button" data-act="less" data-id="${lineKey(l)}" aria-label="One less ${l.name}">−</button>
        <span class="qty" aria-label="${l.qty} of ${l.name}">${l.qty}</span>
        <button class="sq" type="button" data-act="more" data-id="${lineKey(l)}" aria-label="One more ${l.name}">+</button>
        <span class="lt">${rs(l.qty * l.pricePaise)}</span></div>
      ${ui.remFor === l.id ? html`<form class="msg" style="display:block;background:var(--soft)">
        <input class="in" data-model="remText" data-live value="${ui.remText ?? ''}" maxlength="120" placeholder="Type a remark, or tap one below" aria-label="Remark for ${l.name}" autofocus autocomplete="off">
        ${pickLists(ui.remText, [[`Used on ${l.name}`, cache.kotPicks?.byItem?.[l.itemId] ?? []], ['Used most often', cache.kotPicks?.all ?? []]], KOT_PICKS, 'remPick')}
        <div class="row" style="margin-top:6px"><button class="btn pri" type="submit" data-act="remSave" data-submit>Done</button><button class="btn ghost" type="button" data-act="remNo">Cancel</button>
          ${l.remark ? html`<button class="btn ghost" type="button" data-act="remClear">Remove remark</button>` : ''}</div></form>` : ''}
      ${ui.asking === lineKey(l) ? (ui.approve?.key === lineKey(l)
        ? html`<form class="msg warn approve" role="alert"><p style="margin-bottom:8px"><strong>A manager or owner approves</strong> cancelling one ${l.name} (${reasonsOf('kot_cancel').find((r) => r.id === ui.approve.reasonId)?.label ?? ''}).</p>
          ${ui.approvers?.length ? html`<div class="row"><select class="in" data-model="apId" aria-label="Approved by">${ui.approvers.map((a) => html`<option value="${a.id}" ${ui.apId === a.id ? 'selected' : ''}>${a.name}</option>`)}</select>
            <input class="in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-model="apPin" placeholder="Their PIN" aria-label="Their PIN" autofocus>
            <button class="btn pri" type="submit" data-act="lessApprove" data-submit>Approve</button><button class="btn ghost" type="button" data-act="lessNo">Keep it</button></div>`
          : html`<p>No manager or owner has a PIN yet. The Owner sets one in Settings, Staff and PINs.</p><button class="btn ghost" type="button" data-act="lessNo">Keep it</button>`}</form>`
        : html`<div class="msg warn" role="alert"><p style="margin-bottom:8px"><strong>Already sent to the kitchen.</strong> Why cancel one?${isMgr() ? '' : ' A manager or owner approves next.'}</p>
        <div class="chips">${reasonsOf('kot_cancel').map((r) => html`<button type="button" class="chip" data-act="lessWhy" data-id="${lineKey(l)}" data-r="${r.id}">${r.label}</button>`)}
        <button type="button" class="chip" data-act="lessNo">Keep it</button></div></div>`) : ''}</div>`;
    const fresh = o.lines.filter((l) => l.qty > l.sentQty);
    const sent = o.lines.filter((l) => l.qty <= l.sentQty);
    paint(shell('#/', html`<div class="order">
      <section class="menu" aria-label="Menu">
        ${evMenu || (ui.fullMenu && ui.event?.menu) ? html`<p class="small evnote">${evMenu ? html`<strong>${ui.event.name}</strong>: event menu (${evMenu.join(', ')}). <button class="btn ghost addln" type="button" data-act="fullMenu">Show the full menu</button>` : html`Full menu. <button class="btn ghost addln" type="button" data-act="fullMenu">Back to the event menu</button>`}</p>` : ''}
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
            <p class="quiet small">opened ${time(o.openedAt)}</p></div>
          <a class="btn" href="#/">Tables</a></div>
        ${guestLine(o)}${guestLinkBox(o)}
        <div class="tk-body">
          ${errorBox()}
          ${ui.kotDone ? html`<div class="msg ok" role="status">${ui.kotDone}</div>` : ''}
          ${o.lines.length ? '' : html`<p class="empty" style="margin-top:12px">Tap dishes on the menu to add them.</p>`}
          ${fresh.length ? html`<div class="tk-group new"><p class="label"><span>New · not sent yet</span><span>${newCount}</span></p>${fresh.map(line)}</div>` : ''}
          ${sent.length ? html`<div class="tk-group"><p class="label"><span>Sent to kitchen or bar</span><span>${sent.reduce((t, l) => t + l.qty, 0)}</span></p>${sent.map(line)}</div>` : ''}
          ${o.lines.length ? (ui.noteOpen ? html`<form class="msg" style="display:block;background:var(--soft);margin-top:8px"><p class="label" style="margin-bottom:6px">Note for the whole order · prints on every KOT</p>
              <input class="in" data-model="noteText" data-live value="${ui.noteText ?? ''}" maxlength="200" placeholder="Type a note, or tap one below" aria-label="Note for the whole order" autofocus autocomplete="off">
              ${pickLists(ui.noteText, [['Used most often', cache.kotPicks?.notes ?? []]], KOT_NOTE_PICKS, 'notePick')}
              <div class="row" style="margin-top:6px"><button class="btn pri" type="submit" data-act="noteSave" data-submit>Save note</button><button class="btn ghost" type="button" data-act="noteNo">Cancel</button></div></form>`
            : html`<div class="row" style="margin-top:8px;align-items:center">${o.kotNote ? html`<span class="small" style="color:var(--warn);font-weight:600">📝 Note: ${o.kotNote}</span>` : ''}
              <button type="button" class="btn ghost addln" style="padding:2px 8px;font-size:12.5px" data-act="noteOpen">${o.kotNote ? 'Change note' : '+ Note for the kitchen'}</button></div>`) : ''}
          ${ui.splitting ? html`<div class="msg warn"><p style="margin-bottom:8px"><strong>Split bill:</strong> choose what moves to a new bill at this table. Each bill gets its own number and GST.</p>
            ${o.lines.map((l) => html`<div class="line"><span class="grow">${l.name}${l.options?.length ? ` (${l.options.map((x) => x.name).join(', ')})` : ''} <span class="quiet small">(${l.qty} on this bill)</span></span>
              <button class="sq" type="button" data-act="splitLess" data-id="${l.id}" aria-label="Move one less ${l.name}">−</button>
              <span class="qty">${ui.split[l.id] ?? 0}</span>
              <button class="sq" type="button" data-act="splitMore" data-id="${l.id}" aria-label="Move one more ${l.name}">+</button></div>`)}
            <div class="row" style="margin-top:10px"><button class="btn pri" type="button" data-act="splitGo">Move to a new bill</button><button class="btn" type="button" data-act="splitNo">Cancel</button></div></div>` : ''}
          ${ui.tabAsk ? html`<form class="msg warn"><p class="small" style="margin:0 0 6px">A tab needs the guest's name and phone.</p>
            <div class="grid2"><label class="f">Guest name<input class="in" data-model="tabGuest" value="${ui.tabGuest ?? o.guestName ?? ''}" autofocus></label>
            <label class="f">Phone<input class="in" inputmode="tel" data-model="tabPhone" data-live value="${ui.tabPhone ?? ''}" placeholder="${ui.guest?.phone ? `On file ${ui.guest.phone}` : ''}"></label></div>${phoneHint(ui.tabPhone)}
            <div class="row" style="margin-top:8px"><button class="btn pri" type="submit" data-act="tabGo" data-submit>Keep as tab</button></div></form>` : ''}
        </div>
        <div class="tk-foot">
          ${(ui.oadv ?? []).map((x) => html`<div class="msg ok" style="display:block;margin-bottom:6px"><strong>Advance ${rs(x.leftPaise)}</strong> · ${x.guestName} · ${x.receipts ?? ''}<div class="small">It comes off the bill at payment.</div></div>`)}
          ${(ui.waitAdv ?? []).length && can('orders.edit') ? html`<div class="msg warn" style="display:block;margin-bottom:6px"><strong>Party advance waiting</strong>
            ${ui.waitAdv.map((x) => html`<div class="line" style="gap:8px;margin-top:4px"><span class="grow small">${x.guestName} · ${dayName(x.partyDay)}${x.partyTime ? `, ${x.partyTime}` : ''} · ${rs(x.leftPaise)}${x.phoneEnd ? ` · …${x.phoneEnd}` : ''}</span><button class="btn sm" type="button" data-act="advLinkHere" data-id="${x.id}">Put on this table</button></div>`)}</div>` : ''}
          ${ui.advForm ? advanceTakeForm() : ''}
          <div class="tk-total"><span>${plural(count, 'item')}</span><strong>${rs(total)}</strong></div>
          <div class="tk-main ${can('bills.print') ? '' : 'one'}">
            <button class="btn ${unsent ? 'pri' : ''}" type="button" data-act="kot" ${unsent ? '' : 'disabled'}>Send KOT${unsent ? ` · ${newCount} new` : ''}</button>
            ${can('bills.print') ? html`<button class="btn ${o.lines.length && !unsent ? 'go' : ''}" type="button" data-act="toBill" ${!o.lines.length || unsent ? 'disabled' : ''}>Bill</button>` : ''}</div>
          ${unsent && can('bills.print') ? html`<p class="hint">Send the new dishes to the kitchen before billing.</p>` : ''}
          <div class="tk-more">${can('debtors.receive') && !ui.advForm ? html`<button class="btn" type="button" data-act="advOrder">Take advance</button>` : ''}${count > 1 && !ui.splitting ? html`<button class="btn" type="button" data-act="splitAsk">Split bill</button>` : ''}
            ${o.status === 'open' ? html`<button class="btn" type="button" data-act="keepTab">Keep as a tab</button>` : ''}
            ${!o.lines.some((l) => l.sentQty) ? html`<button class="btn danger" type="button" data-act="dropOrder">Cancel order</button>`
              : ui.wholeCancel ? '' : html`<button class="btn danger" type="button" data-act="wholeAsk">Cancel whole order</button>`}</div>
          ${ui.wholeCancel ? wholeCancelBox(o) : ''}
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
// Remarks for the kitchen (26 Nov 2026): one tap for the usual ones; anything else is typed.
const KOT_PICKS = ['No onion', 'No garlic', 'Less spicy', 'Extra spicy', 'Jain', 'Extra sugar', 'Less sugar', 'No sugar', 'No ice', 'Pack to go'];
const KOT_NOTE_PICKS = ['Extra tissues', 'Serve together', 'Starters first', 'Kids at table'];
/** Text with a pick added: replaces what is being typed after the last comma (if it is part of the pick), else adds it. */
const addPick = (cur, v) => {
  const parts = String(cur ?? '').split(',').map((x) => x.trim());
  const last = parts[parts.length - 1] ?? '';
  const done = parts.slice(0, -1).filter(Boolean);
  if (last && !v.toLowerCase().includes(last.toLowerCase())) done.push(last);
  if (!done.some((x) => x.toLowerCase() === v.toLowerCase())) done.push(v);
  return done.join(', ');
};
/** Quick picks (26 Nov 2026): what staff typed before, most used first (per dish, then overall), filtered by what is being
 *  typed; the usual ones fill in while there is little history. A new typed one is offered as "+ add". */
function pickLists(text, groups, defaults, act) {
  const parts = String(text ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const typing = String(text ?? '').trim().endsWith(',') ? '' : parts[parts.length - 1] ?? '';
  const taken = new Set(String(text ?? '').trim().endsWith(',') ? parts : parts.slice(0, -1));
  const seen = new Set();
  const ok = (v) => { const k = v.toLowerCase(); if (seen.has(k) || taken.has(k) || (typing && (k === typing || !k.includes(typing)))) return false; seen.add(k); return true; };
  const shown = groups.map(([title, list]) => [title, list.filter(([v]) => ok(v)).slice(0, 12)]);
  const extra = defaults.filter((v) => ok(v)).slice(0, Math.max(0, 10 - shown.reduce((t, [, l]) => t + l.length, 0)));
  const known = [...groups.flatMap(([, l]) => l.map(([v]) => v)), ...defaults].some((v) => v.toLowerCase() === typing);
  const chip = (v, n) => html`<button type="button" class="chip" data-act="${act}" data-v="${v}">${v}${n ? html` <span class="small quiet">${n}</span>` : ''}</button>`;
  return html`<div style="display:flex;flex-direction:column;gap:6px;margin:8px 0">
    ${shown.filter(([, l]) => l.length).map(([title, l]) => html`<div><p class="label" style="margin-bottom:4px">${title}</p><div class="chips">${l.map(([v, n]) => chip(v, n))}</div></div>`)}
    ${extra.length ? html`<div class="chips">${extra.map((v) => chip(v, 0))}</div>` : ''}
    ${typing && !known ? html`<div class="chips"><button type="button" class="chip" style="border-style:dashed" data-act="${act}" data-v="${String(text).split(',').pop().trim()}">+ add "${String(text).split(',').pop().trim()}"</button></div>` : ''}</div>`;
}
const loadPicks = async () => { if (!cache.kotPicks) cache.kotPicks = await api('GET', `${B()}/kot-picks`).catch(() => null); };
actions.remOpen = async (d) => { const l = ui.order.lines.find((x) => x.id === d.id); ui.remFor = d.id; ui.remText = l?.remark ?? ''; await loadPicks(); rerender(); };
actions.remPick = (d) => { ui.remText = addPick(ui.remText, d.v); rerender(); };
actions.remNo = () => { ui.remFor = null; rerender(); };
const remSet = async (remark) => {
  const r = await api('PUT', `${B()}/orders/${ui.order.id}/lines/${ui.remFor}/remark`, { remark });
  ui.order = r.order; ui.remFor = null; delete cache.kotPicks; rerender();
};
actions.remSave = () => remSet(String(ui.remText ?? '').trim());
actions.remClear = () => remSet('');
actions.noteOpen = async () => { ui.noteOpen = true; ui.noteText = ui.order.kotNote ?? ''; await loadPicks(); rerender(); };
actions.notePick = (d) => { ui.noteText = addPick(ui.noteText, d.v); rerender(); };
actions.noteNo = () => { ui.noteOpen = false; rerender(); };
actions.noteSave = async () => {
  const r = await api('PUT', `${B()}/orders/${ui.order.id}/note`, { note: String(ui.noteText ?? '').trim() });
  ui.order = r.order; ui.noteOpen = false; delete cache.kotPicks; rerender();
};

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
  return html`<div class="scrim" data-act="pickClose"><div class="sheet ${opening ? 'opening' : ''}" role="dialog" aria-modal="true" aria-labelledby="pk-h" data-act="sheetStay">
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
// Put on the room's bill (25 Nov 2026): straight back to Tables; the guest pays it at check-out.
actions.folioPost = async () => {
  await api('POST', `${B()}/settlements`, { billIds: [ui.bill.id], payments: [{ mode: 'room', amount: rupees(ui.bill.totalPaise), debtorAccountId: ui.folio.accountId }] });
  flash = { kind: 'ok', text: `${rs(ui.bill.totalPaise)} put on ${ui.folio.room} · ${ui.folio.guestName}'s room bill (${ui.bill.billNo}). Paid at check-out.`, link: [`#/done/${ui.bill.id}`, 'View bill'] };
  go('#/');
};
actions.ncClose = async () => {
  if (!confirm(`Close bill ${ui.bill.billNo} as NC (complimentary for ${ui.ncPlace})?`)) return;
  await api('POST', `${B()}/settlements`, { billIds: [ui.bill.id], nc: true });
  go(`#/done/${ui.bill.id}`);
};
actions.sheetStay = () => {};   // a tap inside the dish sheet keeps it open
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
function change(target, delta, reasonId, approval) {
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
      const r = await api('POST', `${B()}/orders/${orderId}/items`, { ...(lineId ? { lineId } : { itemId }), delta, reasonId, ...(approval ?? {}) });
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
// Cancelling what the kitchen already has: a manager or owner does it themselves, or approves it with their PIN (21 Nov 2026).
actions.lessWhy = async (d) => {
  if (isMgr()) { ui.asking = null; change({ key: d.id }, -1, d.r); return; }
  ui.approvers = (await api('GET', `${B()}/approvers`)).approvers;
  ui.approve = { key: d.id, reasonId: d.r }; ui.apId = ui.approvers[0]?.id; ui.apPin = '';
  rerender();
};
actions.lessApprove = () => {
  const a = ui.approve;
  if (!/^\d{4,6}$/.test(ui.apPin ?? '')) throw new Error('Type the 4 to 6 digit PIN.');
  ui.asking = null; ui.approve = null;
  change({ key: a.key }, -1, a.reasonId, { approverId: ui.apId, approverPin: ui.apPin });
  ui.apPin = '';
};
actions.toBill = async () => { await saved(); if (!ui.error) go(`#/bill/${ui.order.id}`); };
actions.fullMenu = () => { ui.fullMenu = !ui.fullMenu; ui.cat = 'All'; rerender(); };
// Cancelling a whole order already sent to the kitchen: one reason and one approval for all of it (21 Nov 2026).
function wholeCancelBox(o) {
  const w = ui.wholeCancel;
  const sent = o.lines.filter((l) => l.sentQty > 0 && !l.noKot);
  return html`<form class="msg warn approve" role="alert" style="margin-top:10px"><p style="margin-bottom:8px"><strong>Cancel the whole order?</strong> ${plural(sent.reduce((t, l) => t + l.sentQty, 0), 'item')} already with the kitchen get a cancel KOT.</p>
    <div class="chips">${reasonsOf('kot_cancel').map((r) => html`<button type="button" class="chip" aria-pressed="${w.reasonId === r.id}" data-act="wholeWhy" data-r="${r.id}">${r.label}</button>`)}</div>
    ${isMgr() ? '' : ui.approvers?.length ? html`<div class="row" style="margin-top:8px"><select class="in" data-model="apId" aria-label="Approved by">${ui.approvers.map((a) => html`<option value="${a.id}" ${ui.apId === a.id ? 'selected' : ''}>${a.name}</option>`)}</select>
        <input class="in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-model="apPin" placeholder="Manager's PIN" aria-label="Manager's or owner's PIN"></div>`
      : html`<p>No manager or owner has a PIN yet. The Owner sets one in Settings, Staff and PINs.</p>`}
    <div class="row" style="margin-top:8px"><button class="btn danger" type="submit" data-act="wholeGo" data-submit ${w.reasonId ? '' : 'disabled'}>Cancel whole order</button><button class="btn ghost" type="button" data-act="wholeNo">Keep the order</button></div></form>`;
}
actions.wholeAsk = async () => {
  await saved();
  if (!isMgr()) { ui.approvers = (await api('GET', `${B()}/approvers`)).approvers; ui.apId = ui.approvers[0]?.id; }
  ui.wholeCancel = { reasonId: null }; ui.apPin = ''; ui.error = null; rerender();
};
actions.wholeWhy = (d) => { ui.wholeCancel.reasonId = d.r; rerender(); };
actions.wholeNo = () => { ui.wholeCancel = null; ui.apPin = ''; rerender(); };
actions.wholeGo = async () => {
  if (!isMgr() && !/^\d{4,6}$/.test(ui.apPin ?? '')) throw new Error("Type the manager's or owner's 4 to 6 digit PIN.");
  const r = await api('POST', `${B()}/orders/${ui.order.id}/cancel`, { reasonId: ui.wholeCancel.reasonId, ...(isMgr() ? {} : { approverId: ui.apId, approverPin: ui.apPin }) });
  printKots(r.kots.filter((k) => k.printAt === 'counter'));
  flash = { kind: 'ok', text: `${ui.order.place}: order cancelled. ${r.kots.length ? kotSummary(r.kots) : ''}` };
  go('#/');
};
actions.lessNo = () => { ui.asking = null; ui.approve = null; ui.apPin = ''; rerender(); };
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
actions.tabGo = async () => { await saved(); await api('POST', `${B()}/orders/${ui.order.id}/tab`, { guestName: ui.tabGuest ?? ui.order.guestName, guestPhone: ui.tabPhone || undefined }); flash = { kind: 'ok', text: `${ui.order.place} kept as a tab.` }; go('#/'); };
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
/** A dish's service charge and price-includes-GST (26 Nov 2026): the dish's own choice, else its category's. */
function dishFlags(itemId) {
  const m = cache.menu.find((x) => x.id === itemId);
  const c = (cache.menuCats ?? []).find((x) => x.name.toLowerCase() === (m?.category ?? '').toLowerCase());
  return { sc: !!(m?.serviceCharge ?? c?.serviceCharge ?? 0), incl: !!(m?.priceIncl ?? c?.priceIncl ?? 0) };
}
function previewTotals(lines, discBp, e, lineBp = {}, scBp = 0) {
  const gross = lines.reduce((t, l) => t + l.qty * l.pricePaise, 0);
  // Item discounts first, off their own lines; the bill's discount then shares what is left (as the server does).
  const offOf = (l) => (lineBp[l.id] ? Math.floor((l.qty * l.pricePaise * lineBp[l.id] + 5000) / 10000) : 0);
  const lineDisc = lines.reduce((t, l) => t + offOf(l), 0);
  const base = gross - lineDisc;
  const billDisc = roundDiv(base * discBp, 10000);
  const m = new Map();
  for (const l of lines) {
    const tax = dishTax(l.itemId, e); const f = dishFlags(l.itemId);
    const k = `${tax.kind}:${tax.bp ?? 0}:${f.incl ? 1 : 0}:${f.sc ? 1 : 0}`;
    const b = m.get(k) ?? { tax, ...f, gross: 0 }; b.gross += l.qty * l.pricePaise - offOf(l); m.set(k, b);
  }
  const ord = { gst: 0, liquor: 1, exempt: 2 };
  const bs = [...m.values()].filter((b) => b.gross > 0).sort((a, b) => ord[a.tax.kind] - ord[b.tax.kind] || (a.tax.bp ?? 0) - (b.tax.bp ?? 0)
    || Number(a.incl) - Number(b.incl) || Number(a.sc) - Number(b.sc));
  let left = billDisc;
  const rows = new Map();
  let sc = 0;
  bs.forEach((b, i) => {
    const share = i === bs.length - 1 ? left : roundDiv(b.gross * billDisc, base); left -= share;
    // As the server (pos/src/billing.ts charge()): GST worked out of a price that includes it, service charge on the
    // value before GST, and GST on the service charge too.
    const after = b.gross - share; const bp = b.tax.kind === 'gst' ? b.tax.bp : 0; const inside = b.incl && bp > 0;
    let half = inside ? roundDiv(after * bp, 2 * (10000 + bp)) : 0;
    const value = after - 2 * half;
    const s = b.sc && scBp > 0 ? roundDiv(value * scBp, 10000) : 0;
    half = inside ? half + roundDiv(s * bp, 20000) : roundDiv((value + s) * bp, 20000);
    sc += s;
    const k = `${b.tax.kind}:${bp}`;
    const r = rows.get(k) ?? { kind: b.tax.kind, bp, valuePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    r.valuePaise += value + s; r.cgstPaise += half; r.sgstPaise += half; rows.set(k, r);
  });
  const taxes = [...rows.values()];
  const raw = taxes.reduce((t, r) => t + r.valuePaise + r.cgstPaise + r.sgstPaise, 0);
  const total = roundDiv(raw, 100) * 100;
  return { gross, disc: lineDisc + billDisc, lineDisc, billDisc, offOf, taxes, raw, total, sc };
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
  ui.disc = 0; ui.discReason = null; ui.lineBp = {}; ui.noSc = false;
  rerender = () => {
    const o = ui.order;
    const e = ents.find((x) => x.id === ui.entityId);
    const billed = o.lines.filter((l) => l.qty > 0);
    // The same sums as the server: each line taxed by dish, category or billing name; the discount shared by value.
    // Service charge (26 Nov 2026): the business's rate on items that carry it, unless the guest asked for it off.
    const scBp = ui.noSc ? 0 : me.business.service_charge_bp ?? 0;
    const scAny = (me.business.service_charge_bp ?? 0) > 0 && billed.some((l) => dishFlags(l.itemId).sc);
    const { gross, disc, lineDisc, billDisc, offOf, taxes, raw, total, sc } = previewTotals(billed, ui.disc * 100, e, ui.lineBp, scBp);
    const near = e && e.warn1_paise !== null && e.year_paise + total >= e.warn1_paise;
    const anyDisc = disc > 0;
    const ready = e && !(anyDisc && !ui.discReason) && total > 0;
    const limit = me.business.disc_limit_bp ?? 1000;
    const needsMgr = !isMgr() && anyDisc && (disc * 10000 > gross * limit || billed.some((l) => ui.lineBp[l.id] === 10000));
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
          <p class="label" style="margin-top:14px">Discount on one item <button type="button" class="chip" aria-pressed="${!!ui.itemDisc}" data-act="itemDiscOpen">${ui.itemDisc ? 'Hide' : 'Show items'}</button></p>
          ${ui.itemDisc ? html`<div class="paylist">${billed.map((l) => html`<div class="line"><span class="grow">${l.qty} × ${l.name}</span>
            <span class="chips">${[[0, 'None'], [2500, '25% off'], [5000, '50% off'], [10000, 'Free']].map(([bp, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.lineBp[l.id] ?? 0) === bp}" data-act="lineDisc" data-id="${l.id}" data-bp="${bp}">${t}</button>`)}</span></div>`)}</div>` : ''}
          ${anyDisc ? html`<p class="label" style="margin-top:14px">Reason for the discount (required)</p><div class="chips">${reasonsOf('discount').map((r) => html`<button type="button" class="chip" aria-pressed="${ui.discReason === r.id}" data-act="discWhy" data-id="${r.id}">${r.label}</button>`)}</div>` : ''}
          ${needsMgr ? html`<p class="hint">A discount above ${limit / 100}% or a free item needs a manager's PIN when you print.</p>` : ''}</div>
        ${scAny ? html`<div><p class="label">Service charge</p>
          <div class="row"><button type="button" class="chip" aria-pressed="${!!ui.noSc}" data-act="noSc">${ui.noSc ? 'Removed: put it back' : 'Remove service charge'}</button>
          <span class="small quiet">${ui.noSc ? 'Taken off because the guest asked.' : `${(me.business.service_charge_bp ?? 0) / 100}% is optional: take it off if the guest asks.`}</span></div></div>` : ''}
        <label class="f">Guest name on the bill (optional)<input class="in" data-model="guestName" value="${ui.guestName ?? o.guestName ?? ''}"></label>
      </section>
      <section class="panel">
        <div class="preview" aria-label="Bill preview">
          <div class="pl"><strong>${e?.name ?? 'Choose a billing name'}</strong><span class="quiet">${o.place}</span></div><hr>
          ${billed.map((l) => html`<div class="pl"><span>${l.qty} × ${l.name}${l.options?.length ? ` (${l.options.map((x) => x.name).join(', ')})` : ''} <span class="small quiet">${taxTag(dishTax(l.itemId, e))}</span></span><span>${rs(l.qty * l.pricePaise)}</span></div>
            ${offOf(l) ? html`<div class="pl"><span class="quiet" style="padding-left:14px">${ui.lineBp[l.id] === 10000 ? 'Free' : `${ui.lineBp[l.id] / 100}% off`}</span><span>${rs(-offOf(l))}</span></div>` : ''}`)}<hr>
          <div class="pl"><span class="quiet">Items</span><span>${rs(gross)}</span></div>
          ${lineDisc ? html`<div class="pl"><span class="quiet">Item discounts</span><span>${rs(-lineDisc)}</span></div>` : ''}
          ${billDisc ? html`<div class="pl"><span class="quiet">Discount ${ui.disc}%</span><span>${rs(-billDisc)}</span></div>` : ''}
          ${sc ? html`<div class="pl"><span class="quiet">Service charge ${scBp / 100}%</span><span>${rs(sc)}</span></div>` : ''}
          ${taxLines(taxes, 'pl', !!e?.gst_registered)}
          ${total !== raw ? html`<div class="pl"><span class="quiet">Round off</span><span>${rs(total - raw)}</span></div>` : ''}
          <hr><div class="pl tot"><span>Total</span><span>${rs(total)}</span></div>
        </div>
        <button class="btn go big wide" type="button" data-act="printBill" ${ready ? '' : 'disabled'}>Print bill · ${rs(total)}</button>
        ${anyDisc && !ui.discReason ? html`<p class="hint">Choose a reason for the discount to print.</p>` : ''}
        ${total <= 0 && e ? html`<p class="hint">Everything is free: print it with no discount and choose Complimentary when taking payment.</p>` : ''}
      </section></div>`));
  };
  rerender();
}
actions.ent = (d) => { ui.entityId = d.id; rerender(); };
actions.disc = (d) => { ui.disc = Number(d.p); rerender(); };
actions.itemDiscOpen = () => { ui.itemDisc = !ui.itemDisc; rerender(); };
actions.noSc = () => { ui.noSc = !ui.noSc; rerender(); };
actions.lineDisc = (d) => { const bp = Number(d.bp); if (bp) ui.lineBp[d.id] = bp; else delete ui.lineBp[d.id]; rerender(); };
actions.discWhy = (d) => { ui.discReason = d.id; rerender(); };
actions.printBill = async () => {
  const r = await api('POST', `${B()}/orders/${ui.order.id}/bill`, {
    entityId: ui.entityId, guestName: ui.guestName,
    discount: ui.disc ? { kind: 'pct', bp: ui.disc * 100, reasonId: ui.discReason } : { kind: 'none' },
    lineDiscounts: Object.entries(ui.lineBp).map(([lineId, bp]) => ({ lineId, bp })), discountReasonId: ui.discReason ?? undefined,
    ...(ui.noSc ? { serviceCharge: false } : {}),
  });
  printReceipt(r.bill);
  if (r.warning) flash = { kind: 'warn', text: r.warning };
  go(`#/settle/${r.bill.id}`);
};

// ---------- settle

async function settleScreen(billId) {
  const [{ bill }, { orders, sections }] = await Promise.all([api('GET', `${B()}/bills/${billId}`), api('GET', B() + '/orders'), load('reasons', 'payAccounts', 'stays', 'credit', 'entities')]);
  if (bill.status !== 'printed') { go(`#/done/${billId}`); return; }
  // A bill from an NC table closes as complimentary in the person's name (managers and owners).
  const ord = orders.find((o) => o.bill?.id === billId);
  ui.ncPlace = ord?.kind === 'table' && (sections ?? []).some((x) => x.kind === 'nc' && x.tables.some((t) => t.toLowerCase() === ord.place.toLowerCase())) ? ord.place : null;
  // Room service, a private room or a dorm bed with a guest staying: the bill goes to their folio, ready to post (21 Nov 2026).
  ui.folio = !ui.ncPlace && ord?.stayId ? cache.stays.find((x) => x.id === ord.stayId) ?? null : null;
  // A room's order not linked to anyone (opened before the guest came, 27 Nov 2026): the guest staying there now.
  if (!ui.folio && !ui.ncPlace && ord?.kind === 'table') ui.folio = cache.stays.find((x) => roomKeyOf(x.room) === roomKeyOf(ord.place)) ?? null;
  ui.bill = bill; ui.others = orders.filter((o) => o.status === 'billed' && o.bill && o.bill.id !== billId);
  ui.together = []; ui.pays = []; ui.mode = ui.folio ? 'room' : 'cash';
  if (ui.folio) ui.debtorAccountId = ui.folio.accountId;
  // An advance taken on this order is used by itself (26 Nov 2026): the guest pays only the rest.
  if (ord && !ui.ncPlace) {
    const adv = (await api('GET', `${B()}/restaurant-advances?orderId=${ord.id}`).catch(() => ({ advances: [] }))).advances;
    let left = bill.totalPaise;
    for (const x of adv) {
      const use = Math.min(x.leftPaise, left);
      if (use <= 0) continue;
      ui.pays.push({ mode: 'advance', amount: rupees(use), amountPaise: use, debtorAccountId: x.accountId, label: 'Advance', detail: `${x.guestName} · ${x.receipts ?? ''}` });
      left -= use;
    }
    if (ui.pays.length) ui.mode = 'cash';
  }
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
      ${ui.folio && !ui.together.length && !ui.pays.length ? html`<div class="msg ok ncclose"><span><strong>${/^\d/.test(ui.folio.room) ? 'Room ' : ''}${ui.folio.room} · ${ui.folio.guestName}</strong> is staying: this bill goes on their folio, paid at check-out.</span>
        <button class="btn pri" type="button" data-act="folioPost">Post ${rs(ui.bill.totalPaise)} to their folio</button></div>` : ''}
      ${ui.ncPlace ? html`<div class="msg warn ncclose"><span><span class="ncbadge">NC</span> <strong>${ui.ncPlace}</strong> is an NC table: this bill closes as complimentary in that name, with no payment.</span>
        ${isMgr() ? html`<button class="btn pri" type="button" data-act="ncClose">Close as NC · ${rs(ui.bill.totalPaise)}</button>` : html`<span class="small">A manager or owner closes NC bills.</span>`}</div>` : ''}
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
          ${m === 'card' ? html`<label class="f">Approval code (optional)<input class="in" data-model="cardApproval" value="${ui.cardApproval ?? ''}" maxlength="12" autocomplete="off"></label>
            <label class="f">Card last 4 (optional)<input class="in" inputmode="numeric" data-model="cardLast4" value="${ui.cardLast4 ?? ''}" maxlength="4" autocomplete="off"></label>` : ''}
          ${m === 'room' ? html`<div style="grid-column:1/-1">${stayPicker('pick', ui.debtorAccountId, (s) => s.accountId)}</div>` : ''}
          ${m === 'credit' ? creditPicker() : ''}
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
actions.mode = async (d) => {
  ui.mode = d.m; ui.error = null; ui.amount = undefined; ui.debtorAccountId = null;
  // On credit (25 Nov 2026): the guest typed on the table is used. Their phone finds their credit account; with no account,
  // a new one is filled in with the table's name and phone.
  if (d.m === 'credit') {
    ui.cm ??= await api('GET', `${B()}/bills/${ui.bill.id}/credit-match`).catch(() => null);
    const cm = ui.cm;
    if (cm?.matches.length === 1) ui.debtorAccountId = cm.matches[0].id;
    else if (cm && !cm.matches.length && cm.guestName) { ui.debtorAccountId = 'new'; ui.newName = cm.guestName; ui.useGuestPhone = cm.hasPhone; ui.newPhone = undefined; }
  }
  rerender();
};
/** Credit accounts at payment: the ones with the table's phone first, then the rest; or a new one from the table's guest. */
function creditPicker() {
  const cm = ui.cm;
  const ids = new Set((cm?.matches ?? []).map((x) => x.id));
  const chip = (c, extra = '') => html`<button type="button" class="chip" aria-pressed="${ui.debtorAccountId === c.id}" data-act="pick" data-k="debtorAccountId" data-id="${c.id}">${c.name}${extra}</button>`;
  return html`${cm?.matches.length ? html`<div class="f" style="grid-column:1/-1">Same phone as the table (••••${cm.phoneEnd})<div class="chips">${cm.matches.map((c) => chip(c, ` · owes ${rs(c.balancePaise)}`))}</div></div>` : ''}
    <div class="f" style="grid-column:1/-1">${cm?.matches.length ? 'Or another credit account' : 'Credit account'}<div class="chips">${cache.credit.filter((c) => !ids.has(c.id)).map((c) => chip(c))}
      <button type="button" class="chip" aria-pressed="${ui.debtorAccountId === 'new'}" data-act="pick" data-k="debtorAccountId" data-id="new">New account</button></div></div>
    ${ui.debtorAccountId === 'new' ? html`<label class="f">Name (required)<input class="in" data-model="newName" value="${ui.newName ?? ui.bill.guestName ?? ''}"></label>
      ${ui.useGuestPhone ? html`<div class="f">Phone<span class="in" style="display:flex;align-items:center;justify-content:space-between;gap:8px">Table's phone ••••${cm?.phoneEnd ?? ''}<button class="btn ghost" type="button" data-act="otherPhone">Use another</button></span></div>`
        : html`<label class="f">Phone (required)<input class="in" inputmode="tel" data-model="newPhone" value="${ui.newPhone ?? ''}"></label>`}` : ''}`;
}
actions.otherPhone = () => { ui.useGuestPhone = false; ui.newPhone = ''; rerender(); };
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
    // Both optional (26 Nov 2026): checked only when typed.
    if (code && !/^[A-Z0-9]{1,12}$/.test(code)) throw new Error('The approval code is letters and digits only.');
    if (last4 && !/^\d{4}$/.test(last4)) throw new Error("The card's last digits are 4 digits.");
    Object.assign(p, { cardApproval: code, cardLast4: last4, detail: [code && `Approval ${code}`, last4 && `****${last4}`].filter(Boolean).join(' · ') });
  }
  if (m === 'room') { if (!ui.debtorAccountId) throw new Error('Choose the room.'); p.debtorAccountId = ui.debtorAccountId; p.detail = cache.stays.find((s) => s.accountId === ui.debtorAccountId).room; p.detail = 'Room ' + p.detail; }
  if (m === 'credit') {
    if (!ui.debtorAccountId) throw new Error('Choose a credit account, or New account.');
    if (ui.debtorAccountId === 'new') {
      const nm = (ui.newName ?? ui.bill.guestName ?? '').trim();
      if (!nm) throw new Error("Type the new account's name.");
      if (ui.useGuestPhone) { p.newCredit = { name: nm, phone: '', useGuestPhone: true }; p.detail = `${nm} (new) · ••••${ui.cm?.phoneEnd ?? ''}`; }
      else {
        if (!(ui.newPhone ?? '').trim()) throw new Error("Type the new account's phone number.");
        p.newCredit = { name: nm, phone: ui.newPhone }; p.detail = nm + ' (new)';
      }
    }
    else { p.debtorAccountId = ui.debtorAccountId; p.detail = (cache.credit.find((c) => c.id === ui.debtorAccountId) ?? ui.cm?.matches.find((c) => c.id === ui.debtorAccountId))?.name ?? 'Credit'; }
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
  // Advances already on the bill stay; the rest is paid now (26 Nov 2026).
  const kept = ui.pays.filter((p) => p.mode === 'advance');
  const rest = due - kept.reduce((t, p) => t + p.amountPaise, 0);
  ui.pays = [...kept, d.m === 'cash' ? { mode: 'cash', amount: rupees(rest), amountPaise: rest, label: 'Cash', detail: 'Exact' }
    : { mode: 'upi', amount: rupees(rest), amountPaise: rest, payAccountId: acct.id, label: 'UPI', detail: acct.name }];
  ui.diff = null;
  // A refusal clears the payment again; a "billing name differs" question keeps it, so "Settle anyway" works.
  try { await actions.settle({}); } catch (e) { ui.pays = ui.pays.filter((p) => p.mode === 'advance'); throw e; }
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
  if (bill.status === 'settled' && (can('bills.refund') || can('bills.settle'))) await load('payAccounts', 'stays', 'credit');
  ui.done = bill; ui.cn = null;
  const credited = {};
  for (const n of bill.creditNotes) for (const l of n.lines) credited[l.lineId] = (credited[l.lineId] ?? 0) + l.qty;
  const leftOf = (i) => i.qty - (credited[i.id] ?? 0);
  rerender = () => {
    const cn = ui.cn;
    const anyLeft = bill.items.some((i) => leftOf(i) > 0);
    // Credit to a room goes back only to the room (or credit account) this bill was put on, while it is open.
    const onAcc = (bill.accounts ?? []).filter((a) => a.open && a.leftPaise > 0);
    const allOnAcc = onAcc.length > 0 && bill.payments.every((p) => p.mode === 'room' || p.mode === 'credit');
    const st = bill.status === 'settled' ? ['', '✓', 'Paid and settled'] : bill.status === 'void' ? ['void', '×', 'Void'] : ['wait', '!', 'Printed, not paid'];
    paint(shell('#/', html`<div class="two rev">
    <section class="panel">
      <div class="done-head"><span class="tick ${st[0]}" aria-hidden="true">${st[1]}</span><div><h1>${st[2]}</h1>
        <p class="quiet">Bill ${bill.billNo} · ${bill.place} · <strong class="money" style="color:var(--ink)">${rs(bill.totalPaise)}</strong></p></div></div>
      ${bill.status === 'printed' && can('bills.settle') ? html`<a class="btn go big" href="#/settle/${bill.id}">Take payment</a>` : ''}
      ${bill.status === 'settled' && bill.payments.length ? html`<div class="sums"><div><strong>Paid by</strong></div>${bill.payments.map((p) => html`<div><span>${PAY_NAME[p.mode] ?? p.mode}${p.payAccount ? ` · ${p.payAccount}` : ''}${p.cardLast4 ? ` · ****${p.cardLast4}` : ''}
          ${can('bills.settle') && ['cash', 'upi', 'card'].includes(p.mode) && !ui.pc ? html` <button class="btn ghost" type="button" data-act="pcAsk" data-id="${p.id}" data-m="${p.mode}">Change</button>` : ''}</span><span>${rs(p.amountPaise)}</span></div>`)}</div>
        ${ui.pc ? html`<form class="msg warn" style="display:flex;flex-direction:column;gap:10px"><strong>Change how ${rs(bill.payments.find((p) => p.id === ui.pc.id).amountPaise)} was paid</strong>
          <div class="chips">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${ui.pc.mode === k}" data-act="pcMode" data-m="${k}">${t}</button>`)}</div>
          ${ui.pc.mode === 'upi' ? html`<div class="chips">${cache.payAccounts.filter((a) => a.active).map((a) => html`<button type="button" class="chip" aria-pressed="${ui.pc.payAccountId === a.id}" data-act="pcAcc" data-id="${a.id}">${a.name}</button>`)}</div>` : ''}
          ${ui.pc.mode === 'card' ? html`<div class="grid2"><label class="f">Approval code (from the slip)<input class="in" data-model="pcAppr" maxlength="6" autocomplete="off"></label><label class="f">Card last 4<input class="in" inputmode="numeric" data-model="pcLast4" maxlength="4" autocomplete="off"></label></div>` : ''}
          <label class="f">Reason (required)<input class="in" data-model="pcWhy" value="${ui.pcWhy ?? ''}" placeholder="e.g. Guest paid by UPI, entered as cash"></label>
          <p class="small quiet">Only while this shift is open. A cashier needs a manager's PIN. It shows on the Daily check.</p>
          <div class="row"><button class="btn pri" type="submit" data-act="pcGo" data-submit>Save change</button><button class="btn" type="button" data-act="pcNo">Cancel</button></div></form>` : ''}` : ''}
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
        <div class="f">Money goes back by<div class="chips">${onAcc.map((a) => html`<button type="button" class="chip" aria-pressed="${cn.mode === 'account' && cn.debtorAccountId === a.accountId}" data-act="cnAcc" data-id="${a.accountId}">Take off ${a.name} bill</button>`)}
          ${[...(allOnAcc ? [] : [['cash', 'Cash from the drawer'], ['upi', 'UPI'], ['card', 'Card machine reversal']]), ['none', 'Nothing (not paid in money)']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${cn.mode === k}" data-act="cnMode" data-m="${k}">${t}</button>`)}</div>
          ${onAcc.length ? html`<span class="small quiet">Goes back only to the ${onAcc.length > 1 ? 'rooms or accounts' : onAcc[0].kind === 'room' ? 'room' : 'account'} this bill was put on${allOnAcc ? '. Cash, UPI and card are hidden: it was not paid in money.' : '.'}</span>` : ''}</div>
        ${cn.mode === 'upi' ? html`<div class="chips">${cache.payAccounts.filter((a) => a.active).map((a) => html`<button type="button" class="chip" aria-pressed="${cn.payAccountId === a.id}" data-act="cnPick" data-k="payAccountId" data-id="${a.id}">${a.name}</button>`)}</div>` : ''}
        <div class="row"><button class="btn danger" type="submit" data-act="cnGo" data-submit>Make credit note</button><button class="btn" type="button" data-act="cnNo">Cancel</button></div></form>` : ''}
    </section>
    <section class="panel" style="align-items:center"><p class="label" style="align-self:flex-start">Receipt</p>${receipt(bill, true)}</section></div>`));
  };
  rerender();
}
const PAY_NAME = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'To room', credit: 'On credit', comp: 'Complimentary', advance: 'Advance' };
actions.pcAsk = (d) => { ui.pc = { id: d.id, mode: d.m === 'cash' ? 'upi' : 'cash', payAccountId: null }; ui.pcWhy = ''; ui.error = null; rerender(); };
actions.pcMode = (d) => { ui.pc.mode = d.m; rerender(); };
actions.pcAcc = (d) => { ui.pc.payAccountId = d.id; rerender(); };
actions.pcNo = () => { ui.pc = null; rerender(); };
actions.pcGo = async () => {
  const p = ui.pc;
  await api('POST', `${B()}/payments/${p.id}/change`, { mode: p.mode, payAccountId: p.payAccountId ?? undefined, cardApproval: ui.pcAppr, cardLast4: ui.pcLast4, reason: ui.pcWhy });
  flash = { kind: 'ok', text: 'Payment changed. It shows on the Daily check.' }; route();
};
actions.cnAsk = () => {
  const onAcc = (ui.done.accounts ?? []).filter((a) => a.open && a.leftPaise > 0);
  const allOnAcc = onAcc.length > 0 && ui.done.payments.every((p) => p.mode === 'room' || p.mode === 'credit');
  ui.cn = allOnAcc ? { full: true, qty: {}, mode: 'account', debtorAccountId: onAcc[0].accountId } : { full: true, qty: {}, mode: 'cash' };
  rerender();
};
actions.cnAcc = (d) => { ui.cn.mode = 'account'; ui.cn.debtorAccountId = d.id; rerender(); };
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
  printJobs([{ kind: 'bill', html: asHtml(html`<div class="receipt"><div class="hd">${b.entityName}</div>${b.gstRegistered ? html`<div class="c">GSTIN ${b.gstin}</div>` : ''}
    <div class="c">CREDIT NOTE</div><div class="rl"><span>${n.cnNo}</span><span>${dateTime(Date.now())}</span></div><div>Against bill ${b.billNo}</div><hr>
    <div class="rl"><span>Value</span><span>${rs(n.taxablePaise)}</span></div>
    ${n.cgstPaise ? html`<div class="rl"><span>CGST</span><span>${rs(n.cgstPaise)}</span></div><div class="rl"><span>SGST</span><span>${rs(n.sgstPaise)}</span></div>` : ''}
    <div class="rl" style="font-weight:700"><span>TOTAL</span><span>${rs(n.totalPaise)}</span></div></div>`) }]);
}
actions.printDone = () => printReceipt(ui.done);

// ---------- printing (the browser's print dialog; a thermal printer set as the default prints 80 mm slips)

/** A bill as printed. The cashier's name is not printed (23 Nov 2026); it is kept with the bill and shown on screen (`onScreen`). */
function receipt(b, onScreen = false) {
  return html`<div class="receipt">
    <div class="hd">${b.entityName}</div>
    ${b.gstRegistered ? html`<div class="c">GSTIN ${b.gstin}</div><div class="c">TAX INVOICE</div>` : html`<div class="c">BILL</div>`}
    <div class="rl"><span>Bill ${b.billNo}</span><span>${dateTime(b.printedAt)}</span></div>
    <div class="rl"><span>${b.place}</span>${onScreen && b.printedBy ? html`<span class="quiet">by ${b.printedBy}</span>` : ''}</div>
    ${b.guestName ? html`<div>Guest: ${b.guestName}</div>` : ''}
    ${b.printCount > 1 ? html`<div class="c">COPY ${b.printCount - 1}</div>` : ''}
    <hr>${b.items.map((l) => html`<div class="rl"><span>${l.qty} × ${l.name}${l.taxKind === 'exempt' ? ' †' : l.taxKind === 'liquor' || l.taxed === 0 ? ' *' : ''}${b.gstRegistered && l.priceIncl && l.taxKind === 'gst' ? ' ^' : ''}${b.gstRegistered && l.taxKind === 'gst' && (b.taxes ?? []).filter((r) => r.kind === 'gst').length > 1 ? ` (${l.gstBp / 100}%)` : ''}</span><span>${rs(l.amountPaise)}</span></div>
      ${(l.options ?? []).map((x) => html`<div style="padding-left:14px">+ ${x.name ?? x}</div>`)}
      ${l.discountPaise ? html`<div class="rl"><span style="padding-left:14px">${l.discountPaise >= l.amountPaise ? 'Free' : 'Discount'}</span><span>${rs(-l.discountPaise)}</span></div>` : ''}`)}<hr>
    <div class="rl"><span>Items</span><span>${rs(b.grossPaise)}</span></div>
    ${b.discountPaise ? html`<div class="rl"><span>Discount</span><span>${rs(-b.discountPaise)}</span></div>` : ''}
    ${b.serviceChargePaise ? html`<div class="rl"><span>Service charge ${b.serviceChargeBp / 100}%</span><span>${rs(b.serviceChargePaise)}</span></div>` : ''}
    ${b.gstRegistered && b.items.some((l) => l.priceIncl && l.taxKind === 'gst') ? html`<div class="small">Prices marked ^ include GST.</div>` : ''}
    ${taxLines(b.taxes ?? [], 'rl', !!b.gstRegistered)}
    ${b.gstRegistered && b.items[0]?.sac ? html`<div class="small">SAC ${[...new Set(b.items.map((l) => l.sac))].join(', ')}</div>` : ''}
    ${b.roundOffPaise ? html`<div class="rl"><span>Round off</span><span>${rs(b.roundOffPaise)}</span></div>` : ''}
    <div class="rl" style="font-weight:700"><span>TOTAL</span><span>${rs(b.totalPaise)}</span></div>
    ${b.payments?.length ? html`<hr>${b.payments.map((p) => html`<div class="rl"><span>${{ cash: 'Cash', upi: 'UPI', card: 'Card', room: 'To room', credit: 'On credit', comp: 'Complimentary', advance: 'Advance' }[p.mode]}${p.cardLast4 ? ' ****' + p.cardLast4 : ''}</span><span>${rs(p.amountPaise)}</span></div>`)}` : ''}
    ${(b.differences ?? []).map((x) => html`<div class="rl"><span>${x.kind === 'tip' ? `Tip (${x.mode})` : `Discount at payment`}</span><span>${rs(x.kind === 'tip' ? x.amountPaise : x.amountPaise)}</span></div>`)}
    ${b.status === 'void' ? html`<div class="c" style="font-weight:700">VOID</div>` : ''}
  </div>`;
}
function printReceipt(b) { printJobs([{ kind: 'bill', html: asHtml(receipt(b)) }]); }
/**
 * Prints slips (22 Nov 2026). In the Bookr POS Windows app each goes straight to its own printer, chosen on that PC:
 * bills to the bill printer, each station's KOTs to that station's printer. In a browser: the print window, as before.
 * If the app cannot print one (no printer chosen, printer off), the print window opens for it so nothing is lost.
 */
async function printJobs(jobs) {
  if (!jobs.length) return;
  const browserPrint = (list) => { printArea.innerHTML = list.map((j) => Array.from({ length: j.copies ?? 1 }, () => j.html).join('')).join(''); window.print(); };
  if (!window.bookrDesktop?.print) { browserPrint(jobs); return; }
  const failed = [];
  for (const j of jobs) {
    const r = await window.bookrDesktop.print(j).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (!r?.ok) failed.push({ j, error: r?.error });
  }
  if (failed.length) {
    flash = { kind: 'warn', text: `Not printed: ${failed[0].error ?? 'the printer did not answer'}. Choose printers in Printers (Ctrl+Shift+P). The print window opens instead.` };
    rerender();
    browserPrint(failed.map((f) => f.j));
  }
}
/** One KOT slip (counter or station printer). A cancel KOT says CANCEL in large type. */
const kotSlip = (k) => {
  const cancel = k.lines.some((l) => l.cancelled);
  return html`<div class="receipt" style="page-break-after:always"><div class="hd">${cancel ? 'CANCEL · ' : ''}KOT ${k.kotNo} · ${String(k.station).toUpperCase()}</div>
    <div class="rl"><span>${k.place}</span><span>${time(k.at ?? Date.now())}</span></div>${k.by ? html`<div class="rl"><span>${k.by}</span></div>` : ''}<hr>
    ${k.lines.map((l) => html`<div style="font-size:15px;${l.cancelled ? 'font-weight:700' : ''}">${l.cancelled ? `CANCEL ${Math.abs(l.qty)}` : l.qty} × ${l.name}${l.mins && !l.cancelled ? html` <span style="font-size:12px">· by ${time((k.at ?? Date.now()) + l.mins * 60000)}</span>` : ''}</div>${(l.options ?? []).map((x) => html`<div style="padding-left:18px">+ ${x}</div>`)}${l.remark ? html`<div style="padding-left:18px;font-weight:700;font-size:15px">» ${String(l.remark).toUpperCase()}</div>` : ''}`)}
    ${k.note ? html`<hr><div style="border:2px solid #000;padding:3px 6px;font-weight:700;font-size:14px">NOTE: ${String(k.note).toUpperCase()}</div>` : ''}</div>`;
};
function printKots(kots) {
  if (!kots.length) return;
  printJobs(kots.map((k) => ({ kind: 'kot', station: k.station, copies: k.copies ?? 1, html: asHtml(kotSlip(k)) })));
}
/** Where each KOT went, for the counter: "KOT 12 Kitchen (printed there), 13 Tandoor (on its screen), 14 Bar (printed here)". */
const kotSummary = (kots) => `KOT ${kots.map((k) => `${k.kotNo} ${k.station} (${k.printAt === 'counter' ? 'printed here' : k.printAt === 'station' ? 'printed there' : 'on its screen'})`).join(', ')}.`;

// ---------- rooms and credit accounts

// ---------- the front desk (25 Nov 2026): Rooms has its own tab; credit accounts have theirs.
let pendingCheckin = null;   // the arrival to check in, chosen on Today or Reservations
let pendingNew = null;       // a room and night tapped on the chart, for a new reservation
let deskBanner = [];         // desk reservations not in Djubo for an hour, shown on every screen
async function refreshDeskAlerts() {
  if (!me || !can('stays.edit')) return;
  try {
    const r = await api('GET', `${B()}/frontdesk/alerts`);
    const red = r.notInDjubo.filter((x) => x.level === 'red');
    const changed = JSON.stringify(red) !== JSON.stringify(deskBanner);
    deskBanner = red;
    // The banner is on every screen but Rooms (which lists them itself); a redraw keeps the message on screen.
    if (changed && typeof rerender === 'function' && !location.hash.startsWith('#/rooms')) { flash = shownFlash; rerender(); }
  } catch { /* no banner */ }
}
setInterval(refreshDeskAlerts, 5 * 60 * 1000);
const deskBannerBox = () => (deskBanner.length ? html`<div class="msg bad" role="alert" style="margin-bottom:12px;display:block"><strong>Not in Djubo yet: ${deskBanner.map((x) => `${x.guestName} (${x.rooms}, ${dayName(x.checkIn)})`).join('; ')}</strong>
  <div class="small">Made here more than an hour ago, or arriving today, and Djubo's confirmation has not come. Enter ${deskBanner.length === 1 ? 'it' : 'them'} in Djubo now, or the room can be sold twice.</div>
  <div class="row" style="margin-top:6px"><a class="btn" href="#/rooms">Open the front desk</a></div></div>` : '');

/** Payment, refund and advance forms shared by Rooms and Credit. */
function moneyForms() {
  return html`${ui.refund ? html`<form class="panel" style="margin-bottom:16px;max-width:720px;border-color:var(--pri-line)"><h2>Refund to ${ui.refund.name}</h2>${errorBox()}
      <p class="quiet small">${rs(ui.refund.max)} is held.</p>
      <div class="chips">${[['cash', 'Cash from the drawer'], ['upi', 'UPI']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.refundMode ?? 'cash') === k}" data-act="pick" data-k="refundMode" data-id="${k}">${t}</button>`)}</div>
      <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="refundAmount" value="${ui.refundAmount ?? rupees(ui.refund.max)}" autofocus></label>
        <label class="f">Note (optional)<input class="in" data-model="refundNote"></label></div>
      <div class="row"><button class="btn pri" type="submit" data-act="refundGo" data-submit>Refund</button><button class="btn" type="button" data-act="refundNo">Cancel</button></div></form>` : ''}
    ${ui.recv ? html`<form class="panel" style="margin-bottom:16px;max-width:720px;border-color:var(--pri-line)"><h2>Payment from ${ui.recv.name}</h2>${errorBox()}
      <div class="chips"><button type="button" class="chip" aria-pressed="${ui.recvKind !== 'advance' && ui.recvKind !== 'deposit'}" data-act="pick" data-k="recvKind" data-id="receipt">Against what is owed</button>
        <button type="button" class="chip" aria-pressed="${ui.recvKind === 'advance'}" data-act="pick" data-k="recvKind" data-id="advance">Advance</button>
        ${ui.recv.room ? html`<button type="button" class="chip" aria-pressed="${ui.recvKind === 'deposit'}" data-act="pick" data-k="recvKind" data-id="deposit">Deposit (refundable)</button>` : ''}</div>
      ${payFields()}
      <div class="row"><button class="btn pri" type="submit" data-act="recvGo" data-submit>Take payment</button><button class="btn" type="button" data-act="recvNo">Cancel</button></div></form>` : ''}
    ${ui.adv ? advanceForm() : ''}`;
}
/** Cash, UPI or card, and the amount. */
const payFields = (amountKey = 'recvAmount') => html`<div class="chips">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.recvMode ?? 'cash') === k}" data-act="pick" data-k="recvMode" data-id="${k}">${t}</button>`)}</div>
  <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="${amountKey}" ${amountKey === 'nrAdv' ? 'data-live' : ''} value="${ui[amountKey] ?? ''}"></label>
    ${ui.recvMode === 'upi' ? html`<div class="f">QR paid into<div class="chips">${cache.payAccounts.filter((a) => a.active).map((a) => html`<button type="button" class="chip" aria-pressed="${ui.payAccountId === a.id}" data-act="pick" data-k="payAccountId" data-id="${a.id}">${a.name}</button>`)}</div></div>` : ''}
    ${ui.recvMode === 'card' ? html`<label class="f">Approval code (optional)<input class="in" data-model="cardApproval" maxlength="12"></label><label class="f">Card last 4 (optional)<input class="in" inputmode="numeric" data-model="cardLast4" maxlength="4"></label>` : ''}</div>`;
const payOf = (amountKey = 'recvAmount') => ({ mode: ui.recvMode ?? 'cash', amount: ui[amountKey] ?? '', payAccountId: ui.payAccountId, cardApproval: ui.cardApproval, cardLast4: ui.cardLast4 });

const ROOM_VIEWS = [['today', 'Today'], ['chart', 'Room chart'], ['list', 'Reservations'], ['new', '+ New reservation'], ['checkin', 'Check-in'], ['house', 'Housekeeping'],
  ['audit', 'Night audit'], ['register', 'Guest register']];
let pendingEdit = null;   // a reservation to change, opened in the reservation form
async function roomsScreen(view) {
  const v = ROOM_VIEWS.some(([k]) => k === view) ? view : 'today';
  const [o] = await Promise.all([api('GET', B() + '/orders'), load('stays', 'payAccounts')]);
  // Rooms and beds as set in Settings, Rooms and tables: check-in picks from them (none set up: the room is typed).
  ui.roomSecs = (o.sections ?? []).filter((x) => x.kind === 'rooms' || x.kind === 'dorms');
  ui.view = v;
  if (can('stays.edit')) {
    const today = me.business.shiftDay;
    [ui.bk, ui.arrivals, ui.fd] = await Promise.all([api('GET', B() + '/bookings').catch(() => null), api('GET', B() + '/bookings/arrivals').then((r) => { ui.lateArrivals = r.late ?? []; return r.arrivals; }).catch(() => []),
      v === 'today' || v === 'checkin' ? api('GET', B() + '/frontdesk/today').catch(() => null) : null]);
    if (v === 'chart') { ui.chartFrom = today; await loadChart(); }
    if (v === 'list') ui.res = await api('GET', `${B()}/reservations`);
    if (v === 'audit' || v === 'today') ui.audit = await api('GET', `${B()}/frontdesk/audit`).catch(() => null);
    if (v === 'house' || v === 'checkin') ui.hk = await api('GET', `${B()}/frontdesk/housekeeping`).catch(() => null);
    if (v === 'register') { ui.regFrom = addDays(today, -6); ui.regTo = today; ui.reg = await api('GET', `${B()}/frontdesk/register?from=${ui.regFrom}&to=${ui.regTo}`); }
    if (v === 'new') {
      ui.nrIn = pendingNew?.day ?? today; ui.nrOut = addDays(ui.nrIn, 1); ui.nrStatus = 'confirmed'; ui.nrSource = 'Phone'; ui.nrMeal = 'Room only (EP)'; ui.nrPolicy = 'Non-refundable';
      ui.nrPicks = pendingNew ? { [pendingNew.type]: [pendingNew.room] } : {};
      pendingNew = null;
      // Changing a reservation (25 Nov 2026): the form opens with it filled in.
      if (pendingEdit) {
        const r = pendingEdit; pendingEdit = null;
        Object.assign(ui, { nrEdit: r.id, nrIn: r.checkIn, nrOut: r.checkOut, nrTime: r.arrivalTime ?? '', nrMeal: r.mealPlan ?? ui.nrMeal, nrExtras: r.extras ?? '', gPhone: r.phone, guest: r.guestName,
          nrEmail: r.email ?? '', gCity: r.city ?? '', nrNat: r.nationality ?? 'Indian', nrCo: r.company ?? '', nrGstin: r.gstin ?? '', nrSource: r.source, nrReq: r.requests ?? '', nrNote: r.staffNote ?? '',
          nrStatus: r.status === 'hold' ? 'hold' : 'confirmed', nrPolicy: r.policy ?? ui.nrPolicy });
        ui.nrPicks = {};
        for (const l of r.lines) { ui.nrPicks[l.type] = l.roomNames; ui[`nrRooms_${l.type}`] = l.roomNames.length ? undefined : String(l.rooms); ui[`nrAdults_${l.type}`] = String(l.adults); ui[`nrKids_${l.type}`] = String(l.children); ui[`nrRate_${l.type}`] = rupees(l.ratePaise); }
      }
      await loadFree();
    }
    if (v === 'checkin' && pendingCheckin) {
      const p = pendingCheckin; pendingCheckin = null;
      if (p.kind === 'booking') await actions.pickArrival({ id: p.id }, null, true); else await pickReservation(p.id);
    }
    // A room bill open before a payment or refund stays open after it.
    if (reopenStay) ui.roomBill = await api('GET', `${B()}/stays/${reopenStay}/bill`).catch(() => null);
    // Checked in and out together (25 Nov 2026): the bill opens at check-out, after what was paid is taken.
    if (reopenStay && pendingOut && ui.roomBill && ui.roomBill.balancePaise === 0) {
      ui.rbForm = 'checkout';
      if (!isMgr() && ui.roomBill.rentPaise <= 0) { ui.approvers = (await api('GET', `${B()}/approvers`).catch(() => ({ approvers: [] }))).approvers; ui.apId = ui.approvers[0]?.id; }
    }
  }
  reopenStay = null; pendingOut = false;
  if (pendingAdv) { pendingAdv = false; actions.advNew(); }
  rerender = () => paint(shell('#/rooms', html`${pageHead('Rooms', '')}
    ${can('stays.edit') ? tabsNav('Rooms', ROOM_VIEWS.map(([k, t]) => [k === 'today' ? '#/rooms' : `#/rooms/${k}`, k === 'list' && inboxCount(ui.bk) ? html`${t} <span class="status warn" title="Waiting for you">${inboxCount(ui.bk)}</span>` : t, k]), v) : ''}
    ${drawerOpen() ? html`<aside class="drawer" aria-label="Details">${moneyForms()}${ui.roomBill ? roomBillPanel(ui.roomBill) : ui.chartSel ? chartSelPanel() : ui.drawer ? ui.drawer() : ''}</aside>` : moneyForms()}
    ${!can('stays.edit') ? inHouseTable() : v === 'today' ? todayView() : v === 'chart' ? chartView() : v === 'list' ? listView() : v === 'new' ? newResView()
      : v === 'audit' ? auditView() : v === 'house' ? houseView() : v === 'register' ? registerView() : checkinView()}`));
  rerender();
}

/** The side panel (25 Nov 2026): a room bill, a chart booking or free cell, or another detail, beside the page. */
const drawerOpen = () => !!(ui.roomBill || ui.chartSel || ui.drawer);
/** The guests in house, as before (for a captain who cannot check in). */
const inHouseTable = () => html`<section class="panel"><h2>In house</h2>${ui.recv || ui.refund || ui.roomBill || ui.adv ? '' : errorBox()}
  <div class="scroll"><table class="t cards"><thead><tr><th>Room</th><th>Guest</th><th>Since</th><th class="num">Owes</th><th></th></tr></thead><tbody>
    ${byRoom(cache.stays.filter((s) => !s.groupStayId || !cache.stays.some((y) => y.id === s.groupStayId))).map((s) => { const grp = [s, ...cache.stays.filter((y) => y.groupStayId === s.id)];
      return { ...s, room: compactRooms(grp.map((y) => y.room)), balancePaise: grp.reduce((n, y) => n + y.balancePaise, 0) }; }).map((s) => html`<tr><td data-label="Room"><strong>${s.room}</strong></td><td data-label="Guest">${s.guestName}</td><td data-label="Since">${dayName(s.checkIn)}</td><td class="num" data-label="Owes">${rs(s.balancePaise)}</td>
      <td class="act"><div class="row">${can('stays.edit') ? html`<button class="btn pri" type="button" data-act="roomBill" data-id="${s.id}">Room bill</button>` : ''}
      ${can('debtors.receive') ? html`<button class="btn" type="button" data-act="recv" data-id="${s.accountId}" data-n="Room ${s.room} · ${s.guestName}" data-room="1">Take payment</button>` : ''}</div></td></tr>`)}
  </tbody></table></div></section>`;

/** Reservations made here that Djubo has not confirmed, with what to do. */
const notInDjuboBox = (list) => (list?.length ? html`${list.map((x) => html`<div class="msg ${x.level === 'red' ? 'bad' : 'warn'}" role="alert" style="margin-bottom:10px;display:block">
    <strong>Not in Djubo yet · ${x.minutes >= 60 ? `${Math.floor(x.minutes / 60)} h` : `${x.minutes} min`}: ${x.guestName} · ${x.rooms} · ${dayName(x.checkIn)} → ${dayName(x.checkOut)}</strong>
    <div class="small">Made here ${dateTime(x.madeAt)}${x.madeBy ? ` by ${x.madeBy}` : ''}. Djubo's confirmation has not come. Enter it in Djubo now, or the room can be sold twice.</div>
    <div class="row" style="margin-top:6px"><button class="btn pri" type="button" data-act="resOpen" data-id="${x.id}">Open reservation</button>
      <button class="btn" type="button" data-act="resLater" data-id="${x.id}">Entered in Djubo · remind me in 15 min</button>
      <button class="btn ghost" type="button" data-act="resCancel" data-id="${x.id}">Cancel reservation</button></div></div>`)}` : '');

/** Today (25 Nov 2026 redesign): the day in figures, what needs attention, then arrivals, guests in house and departures.
 *  Rows open the side panel; the only filled button is in the panel. */
function todayView() {
  const fd = ui.fd;
  if (!fd) return html`<p class="quiet">Could not load today's board.</p>`;
  const s = fd.stats;
  const a = ui.audit;
  const today = fd.today;
  // Needs attention: each item says what is wrong, where, and opens the place to fix it.
  const items = [
    ...fd.alerts.notInDjubo.map((x) => ({ tone: x.level === 'red' ? 'bad' : 'warn', icon: '!', title: `Not in Djubo yet: ${x.guestName}`, sub: `${x.rooms} · ${dayName(x.checkIn)} · made ${x.minutes >= 60 ? `${Math.floor(x.minutes / 60)} h` : `${x.minutes} min`} ago`, act: 'resOpen', id: x.id })),
    ...(fd.alerts.unplaced ? [{ tone: 'bad', icon: '!', title: `Djubo could not place ${plural(fd.alerts.unplaced, 'booking')}`, sub: 'Create it in Djubo by hand', act: 'goTo', href: '#/rooms/list' }] : []),
    ...(cache.stays ?? []).filter((x) => String(x.room).startsWith(WAITING_ROOM)).map((x) => ({ tone: 'warn', icon: '⌂', title: `Waiting for a room: ${x.guestName}`,
      sub: 'Checked in, no room yet. Give a room when one is free and clean', act: 'giveRoom', id: x.id })),
    ...(fd.nightsNotCharged ?? []).map((x) => ({ tone: 'bad', icon: '₹', title: `Nights not charged: ${x.room} · ${x.guestName}`,
      sub: `staying till ${dayName(x.plan)}, rent till ${dayName(x.coveredTo)} (${plural(x.nights, 'night')}). Extend in Djubo: the rent comes with its email`, act: 'roomBill', id: x.stayId })),
    ...(fd.missingBeds ?? []).map((x) => ({ tone: 'warn', icon: '⇆', title: `Beds missing: ${x.guestName} · ${x.room}`,
      sub: `Booked ${x.booked}, ${x.have} in the POS${x.sharing ? ` (+${x.sharing} sharing)` : ''}. Assign ${x.missing} more, or mark as sharing`, act: 'bedsPanel', id: x.stayId })),
    ...((fd.held ?? []).length ? [{ tone: fd.held.some((x) => x.reason?.startsWith('Cancelled')) ? 'bad' : 'warn', icon: '!', title: `${plural(fd.held.length, 'booking change')} to check before applying`,
      sub: fd.held.slice(0, 3).map((x) => `${x.room ?? x.extRef} · ${x.guestName ?? ''}: ${x.reason}`).join(' · '), act: 'heldPanel' }] : []),
    ...(fd.alerts.djuboToMode ? [{ tone: 'warn', icon: '₹', title: `${plural(fd.alerts.djuboToMode, 'payment')} taken in Djubo · ${rs(fd.djubo.open.reduce((t, x) => t + x.amountPaise, 0))}`, sub: 'Counted on the day marked. Pick Cash, UPI or Card for each', act: 'djPanel' }] : []),
    ...(fd.alerts.djuboLowered ? [{ tone: 'bad', icon: '₹', title: `Djubo lowered ${plural(fd.alerts.djuboLowered, 'payment')} after its receipt`, sub: 'Refund it, or correct it in Djubo', act: 'djPanel' }] : []),
    ...(fd.alerts.rentTwice ?? []).map((x) => ({ tone: 'bad', icon: '₹', title: `Rent may be counted twice: ${x.room} · ${x.guestName}`, sub: `extra night added by hand, and Djubo sent ${x.refs} for it. Take the hand-added night off`, act: 'roomBill', id: x.stayId })),
    ...(fd.alerts.deskToTake ? [{ tone: 'warn', icon: '₹', title: `${plural(fd.alerts.deskToTake, 'payment')} entered in Djubo by reception`, sub: 'Take it here so a receipt prints', act: 'deskPanel' }] : []),
    ...(fd.alerts.formC ?? []).map((x) => ({ tone: x.level === 'red' ? 'bad' : 'warn', icon: 'C', title: `Form C not filed: ${x.room} · ${x.guestName}`, sub: `checked in ${x.hours} h ago · due within 24 h`, act: 'roomBill', id: x.stayId })),
    ...(a?.overstays ?? []).map((x) => ({ tone: 'bad', icon: '⏱', title: `Past check-out: ${x.room} · ${x.guestName}`, sub: `was due out ${dayName(x.plan)}`, act: 'roomBill', id: x.id })),
    ...(a?.notArrived ?? []).filter((x) => x.checkIn < today).map((x) => ({ tone: 'warn', icon: '?', title: `Did not arrive: ${x.guestName ?? 'No name'}`, sub: `was due ${dayName(x.checkIn)} · no-show?`, act: 'goTo', href: '#/rooms/audit' })),
    ...(a?.noDate ?? []).map((x) => ({ tone: 'mute', icon: '?', title: `No check-out date: ${roomShow(x.room)} · ${x.guestName}`, sub: 'Set it with Extend stay', act: 'roomBill', id: x.id })),
    ...(a?.dirty?.length ? [{ tone: 'mute', icon: '◆', title: `${plural(a.dirty.length, 'room')} not ready`, sub: a.dirty.slice(0, 6).map((x) => `${x.room} ${x.status}`).join(' · '), act: 'goTo', href: '#/rooms/house' }] : []),
  ];
  const row = (attrs, left, right) => html`<button type="button" class="drow" ${attrs}><span class="grow">${left}</span><span class="dright">${right}</span></button>`;
  // One tile per party, closed each time the screen opens (27 Nov 2026).
  // Search (27 Nov 2026): by guest name or room, over arriving, in-house and leaving.
  const rq = (ui.rmQ ?? '').trim().toLowerCase();
  const hit = (...xs) => !rq || xs.some((x) => String(x ?? '').toLowerCase().includes(rq));
  const tileHit = (t) => !rq || t.bills.some((b) => [b.head, ...b.members].some((x) => hit(x.guestName, x.room)));
  const arrivals = fd.arrivals.filter((x) => hit(x.guestName, x.roomLabels, x.rooms, x.roomType));
  const inTiles = partyTiles(fd.inHouse).filter(tileHit);
  const outTiles = partyTiles(fd.leaving).filter(tileHit);
  const tile = (t, kind) => {
    const all = t.bills.flatMap((b) => [b.head, ...b.members]);
    const first = t.bills[0].head;
    const dj = all.reduce((n, x) => n + (x.djuboPaise ?? 0), 0);
    const bal = all.reduce((n, x) => n + x.balancePaise, 0);
    const right = kind === 'out' ? (bal === 0 ? html`<span class="status ok">Ready to check out</span>` : owes(bal))
      : html`${dj ? html`<span class="status info">Paid in Djubo ${rs(dj)}</span> ` : ''}${owes(bal - dj)}`;
    // A guest who left the room with the bill open (27 Nov 2026): still in house, tagged, until checked out.
    const left = all.some((x) => String(x.room).endsWith(' (left room)'));
    const sub = left ? 'left the room · bill open, check out when paid' : kind === 'out' ? 'check-out 11 am' : `${first.plan ? `till ${dayName(first.plan)}` : 'no check-out date'}${dj ? ' · Djubo payment: pick how paid' : ''}`;
    const tag = left ? html` <span class="status warn">Left room</span>` : '';
    // One tile per guest or party (27 Nov 2026): a group's beds or bills open inside its own tile.
    if (all.length === 1) return html`<div class="dtile ${left ? 'left' : ''}">${row(html`data-act="roomBill" data-id="${first.id}"`, html`<strong>${roomShow(first.room)} · ${first.guestName}${tag}</strong><small>${sub}</small>`, right)}</div>`;
    const two = t.bills.length > 1;
    const roomsOf = (b) => compactRooms([b.head, ...b.members].map((x) => roomShow(x.room)));
    const k = `${kind}:${t.key}`;
    const open = !!ui.tileOpen?.[k];
    const n = two ? t.bills.length : all.length;
    return html`<div class="dtile grp ${left ? 'left' : ''}">
      ${row(html`data-act="roomBill" data-id="${first.id}"`, html`<strong>${t.bills.map(roomsOf).join(', ')} · ${first.guestName}${tag}</strong><small>${sub}${two ? ' · 2 bookings, one party' : ''}</small>`, right)}
      <div class="dtbar"><button type="button" class="chip" aria-expanded="${open}" data-act="tileTog" data-k="${k}">${open ? '▾' : '▸'} ${n} ${two ? (n === 1 ? 'bill' : 'bills') : (n === 1 ? 'bed' : 'beds')}</button></div>
      ${open ? html`<div class="dtbeds">${two
        ? t.bills.map((b) => { const bb = [b.head, ...b.members]; const v = bb.reduce((q, x) => q + x.balancePaise - (kind === 'out' ? 0 : x.djuboPaise ?? 0), 0);
            return row(html`data-act="roomBill" data-id="${b.head.id}"`, html`<span>${roomsOf(b)} · its own bill</span>`, owes(v)); })
        : all.map((x, i) => row(html`data-act="roomBill" data-id="${first.id}"`, html`<span>${roomShow(x.room)}${i === 0 ? ' · the bill' : ''}</span>`, ''))}</div>` : ''}
    </div>`;
  };
  const due = (p, prepaidText = 'Prepaid') => (p ? html`<span class="status warn">Collect ${rs(p)}</span>` : html`<span class="status ok">${prepaidText}</span>`);
  const owes = (b) => (b > 0 ? html`<span class="status warn">Owes ${rs(b)}</span>` : b < 0 ? html`<span class="status info">Holds ${rs(-b)}</span>` : html`<span class="status ok">Settled</span>`);
  return html`<div class="kpis">${kpi('Arriving today', String(s.arriving))}${kpi('In house', String(s.inHouse))}${kpi('Leaving today', String(s.leaving))}${kpi('Free tonight', String(s.freeTonight), 'rooms and beds')}${kpi('To collect today', rs(s.toCollectPaise), '', s.toCollectPaise ? 'warn' : '')}</div>
    ${errorBox()}
    <div class="row"><input class="in grow" type="search" data-model="rmQ" data-live value="${ui.rmQ ?? ''}" placeholder="Search guest name or room" aria-label="Search rooms by guest name or room" autocomplete="off">
      ${rq ? html`<button class="btn sm" type="button" data-act="rmQClear">Clear</button>` : ''}</div>
    <div class="today4">
      <section class="dcol attn"><div class="dch"><h2>Needs attention</h2>${items.length ? html`<span class="status ${items.some((x) => x.tone === 'bad') ? 'bad' : 'warn'}">${items.length}</span>` : html`<span class="status ok">All clear</span>`}</div>
        ${items.length ? items.map((x) => row(html`data-act="${x.act}" data-id="${x.id ?? ''}" data-href="${x.href ?? ''}"`,
          html`<span class="ico t-${x.tone}" aria-hidden="true">${x.icon}</span><span><strong>${x.title}</strong><small>${x.sub}</small></span>`, '')) : html`<p class="empty">Nothing needs you right now.</p>`}
        <div class="dfoot"><button class="btn sm" type="button" data-act="advNew">Take advance (no booking yet)</button></div></section>
      <section class="dcol"><div class="dch"><h2>Arriving</h2><span class="faint">${arrivals.length}</span></div>
        ${arrivals.length ? arrivals.map((x) => row(html`data-act="todayArrival" data-kind="${x.kind}" data-id="${x.id}"`,
          html`<strong>${x.guestName ?? 'No name'}</strong><small>${x.kind === 'reservation' ? x.rooms : `${x.roomType ?? '?'}${x.roomLabels ? ` ${x.roomLabels}` : ''}`} · till ${dayName(x.checkOut)} · ${x.kind === 'reservation' ? `${x.source}, not in Djubo` : x.channel ?? (x.source === 'mmt' ? 'MakeMyTrip' : 'Djubo')}${(() => { const c = (ui.arrivals ?? []).find((y) => y.id === x.id)?.continues; return c ? ` · already in ${c.map((y) => y.room).join(', ')}: extension` : ''; })()}</small>`,
          html`${x.djuboPaise ? html`<span class="status info">Paid in Djubo ${rs(x.djuboPaise)}</span> ` : ''}${due(x.duePaise)}`)) : html`<p class="empty">${rq ? 'No arrival matches.' : 'No more arrivals today.'}</p>`}</section>
      <section class="dcol"><div class="dch"><h2>In house</h2><span class="faint">${inTiles.length}${!rq && inTiles.length !== fd.inHouse.length ? ` · ${fd.inHouse.length} rooms and beds` : ''}</span></div>
        ${inTiles.length ? inTiles.map((t) => tile(t, 'in')) : html`<p class="empty">${rq ? 'No guest in house matches.' : 'No guests in house.'}</p>`}</section>
      <section class="dcol"><div class="dch"><h2>Leaving today</h2><span class="faint">${outTiles.length}</span></div>
        ${outTiles.length ? outTiles.map((t) => tile(t, 'out')) : html`<p class="empty">${rq ? 'Nobody leaving matches.' : 'Nobody is due to leave today.'}</p>`}</section>
    </div>`;
}
actions.openFoodGo = (d) => { ui.openFood = null; ui.error = null; ui.roomBill = null; go(`#/order/${d.id}`); };
actions.rmQClear = () => { ui.rmQ = ''; rerender(); };
actions.tileTog = (d) => { ui.tileOpen = { ...ui.tileOpen, [d.k]: !ui.tileOpen?.[d.k] }; rerender(); };
/** A room name's Roman number (XIV A → 14), or null when it does not start with one. */
function romanOf(room) {
  const m = /^([IVXLC]+)(?=\s|$|[-–,])/.exec(String(room ?? '').trim());
  if (!m) return null;
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let n = 0;
  for (let i = 0; i < m[1].length; i++) { const a = V[m[1][i]], b = V[m[1][i + 1]] ?? 0; n += a < b ? -a : a; }
  return n;
}
/** Rooms in their real order (27 Nov 2026): I, II … XXIV by number, then the bed letter; other names after, numbers in order. */
function cmpRoom(a, b) {
  const ra = romanOf(a), rb = romanOf(b);
  if (ra !== null && rb !== null && ra !== rb) return ra - rb;
  if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
  return String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });
}
const byRoom = (list) => [...list].sort((x, y) => cmpRoom(x.room, y.room));
/** A room as shown: without the "(left room)" mark the POS keeps on a guest who left it with the bill open. */
const roomShow = (r) => (String(r).startsWith(WAITING_ROOM) ? 'No room yet' : String(r).replace(/ \(left room\)$/, ''));
/** A guest checked in before a room was free (room later, 28 Nov 2026): their stay's placeholder room starts with this. */
const WAITING_ROOM = 'Waiting for room · ';
/** Rooms in short: "XIV A–F" when the beds of one room run in order, else listed. */
function compactRooms(list) {
  const by = new Map();
  for (const r of list) { const m = /^(.*\S)\s+([A-Z])$/.exec(r); const k = m ? m[1] : r; if (!by.has(k)) by.set(k, []); by.get(k).push(m ? m[2] : null); }
  return [...by].map(([k, ls]) => {
    if (ls.includes(null) || ls.length < 2) return ls.map((l) => (l ? `${k} ${l}` : k)).join(', ');
    const c = [...ls].sort().map((l) => l.charCodeAt(0));
    return c.every((x, i) => !i || x === c[i - 1] + 1) ? `${k} ${String.fromCharCode(c[0])}–${String.fromCharCode(c[c.length - 1])}` : ls.sort().map((l) => `${k} ${l}`).join(', ');
  }).join(', ');
}
/**
 * In house as one tile per party (27 Nov 2026): a group's beds under its first room (one bill), and bookings Djubo split
 * for the same guest and the same check-in day (Vikash Kumar's X and VI A) on one tile, each keeping its own bill.
 */
function partyTiles(list) {
  const heads = byRoom(list.filter((x) => !x.groupStayId || !list.some((y) => y.id === x.groupStayId)));
  const tiles = [];
  for (const h of heads) {
    const bill = { head: h, members: list.filter((x) => x.groupStayId === h.id) };
    const key = `${String(h.guestName ?? '').trim().toLowerCase()}|${h.checkIn}`;
    const t = tiles.find((x) => x.key === key);
    if (t) t.bills.push(bill); else tiles.push({ key, bills: [bill] });
  }
  return tiles;
}
actions.goTo = (d) => go(d.href);
actions.deskPanel = () => { ui.roomBill = null; ui.chartSel = null; ui.drawer = () => html`<div class="dhead"><h2>Money at reception</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>${deskMoneyPanel(ui.bk)}`; rerender(); };
/** An arrival on Today, in the side panel: the booking card and Check in. */
actions.todayArrival = async (d) => {
  ui.roomBill = null; ui.chartSel = null;
  if (d.kind === 'reservation') {
    const r = (await api('GET', `${B()}/reservations/${d.id}`)).reservation;
    ui.drawer = () => html`<div class="dhead"><h2>${r.guestName}</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>${reservationCard(r, Date.now())}`;
  } else {
    const a = (ui.arrivals ?? []).find((x) => x.id === d.id);
    if (a?.continues) ctPrepare(a);
    ui.drawer = () => html`<div class="dhead"><h2>${a?.guestName ?? 'Arrival'}</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>
      <section class="panel">${a ? bookingCard(a) : html`<p class="quiet">Booking not found.</p>`}${a?.continues ? continueBox(a) : ''}<div class="row">${a?.continues ? '' : html`<button class="btn pri" type="button" data-act="goCheckin" data-kind="booking" data-id="${d.id}">Check in</button>`}
        ${a && dueOf(a) && can('debtors.receive') ? html`<button class="btn" type="button" data-act="advTake" data-id="${d.id}" data-n="${a.guestName ?? ''}" data-amount="${rupees(dueOf(a))}">Take advance now</button>` : ''}</div></section>`;
  }
  rerender();
};
actions.goCheckin = (d) => { pendingCheckin = { kind: d.kind, id: d.id }; go('#/rooms/checkin'); };
actions.resLater = async (d) => { await api('POST', `${B()}/reservations/${d.id}/remind-later`); flash = { kind: 'ok', text: 'Reminder again in 15 minutes if Djubo has not confirmed it.' }; await refreshDeskAlerts(); route(); };
actions.resCancel = async (d) => {
  const reason = prompt('Why is this reservation cancelled?');
  if (!reason) return;
  const r = await api('POST', `${B()}/reservations/${d.id}/cancel`, { reason });
  flash = { kind: r.advanceToRefund ? 'warn' : 'ok', text: r.advanceToRefund ? 'Reservation cancelled. Its advance is waiting to be given back (Money at reception).' : 'Reservation cancelled.' };
  await refreshDeskAlerts(); route();
};
actions.resOpen = (d) => actions.resPick(d);

// ----- room chart
// ----- room chart (25 Nov 2026 redesign): sticky dates and rooms, filters, search, bars by source, side panel, drag to extend
const SRC = { direct: ['D', 'Direct'], mmt: ['MMT', 'MakeMyTrip'], gi: ['GI', 'Goibibo'], web: ['WEB', 'Website'], desk: ['HERE', 'Made here'] };
const KIND = { occ: 'In house', arr: 'Booked', hold: 'Hold', pos: 'Not in Djubo yet', ooo: 'Out of order' };
async function loadChart() { ui.chartDays ??= window.innerWidth >= 1600 ? 14 : 7; ui.chart = await api('GET', `${B()}/frontdesk/chart?from=${ui.chartFrom}&days=${ui.chartDays}`); }
actions.chartMove = async (d) => {
  const step = ui.chartDays;
  ui.chartFrom = d.n === '0' ? me.business.shiftDay : addDays(ui.chartFrom, d.n === '-' ? -step : step);
  await loadChart(); rerender();
};
actions.chartDays = async (d) => { ui.chartDays = Number(d.n); await loadChart(); rerender(); };
actions.chartToggle = (d) => { const k = `chartHide_${d.k}`; ui[k] = !ui[k]; rerender(); };
function chartView() {
  const c = ui.chart;
  if (!c) return '';
  const dates = Array.from({ length: c.days }, (_, i) => addDays(c.from, i));
  const end = addDays(c.from, c.days);
  const idx = (d) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${c.from}T12:00:00Z`)) / 86400000);
  const head = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
  const q = String(ui.chartQ ?? '').trim().toLowerCase();
  const shown = (b) => !ui[`chartHide_${b.kind}`] && !(b.src && ui[`chartHide_${b.src}`]);
  const bars = c.bars.filter(shown);
  const hit = (b) => q && ((b.guest ?? '').toLowerCase().includes(q) || b.label.toLowerCase().includes(q));
  const freeOnly = !!ui.chartFree;
  const cell = (room, sec, rowBars, key, loose = false) => {
    const cells = [];
    let i = 0;
    while (i < c.days) {
      const d = dates[i];
      const b = rowBars.find((x) => x.from <= d && x.to > d);
      if (b) {
        const span = Math.max(1, Math.min(idx(b.to > end ? end : b.to), c.days) - i);
        const startsBefore = b.from < c.from;
        cells.push(html`<td colspan="${span}" class="${dates.slice(i, i + span).includes(c.today) ? 'today' : ''}"><button type="button" class="cbar k-${b.kind} s-${b.src ?? 'none'} ${hit(b) ? 'hit' : ''} ${startsBefore ? 'cont' : ''}"
          data-act="${loose ? 'chartLoose' : 'chartSel'}" data-i="${loose ? c.unassigned.indexOf(b.u) : c.bars.indexOf(b)}" title="${b.label} · ${dayName(b.from)} → ${dayName(b.to)}${b.src ? ` · ${SRC[b.src][1]}` : ''}">
          ${b.src && b.kind !== 'ooo' ? html`<span class="srct">${SRC[b.src][0]}</span>` : ''}<span class="gn">${b.kind === 'ooo' ? b.label : b.guest ?? b.label}</span>${b.kind === 'occ' ? html`<span class="st">in</span>` : b.kind === 'hold' ? html`<span class="st">hold</span>` : ''}
          ${b.byHand && b.kind === 'occ' && b.ref.type === 'stay' ? html`<span class="grip" data-grip="${b.ref.id}" title="Drag to extend the stay"></span>` : ''}</button></td>`);
        i += span;
      } else {
        cells.push(loose ? html`<td class="${d === c.today ? 'today' : ''}"></td>` : html`<td class="${d === c.today ? 'today' : ''}" data-day="${d}"><button type="button" class="cfree" data-act="chartNew" data-room="${room}" data-type="${sec.name}" data-day="${d}" aria-label="${room}, ${head(d)}: free"></button></td>`);
        i += 1;
      }
    }
    return html`<tr data-row="${key}"><th class="croom" scope="row">${loose ? html`<span class="noroom" title="Booked in Djubo with no room number yet">no room yet</span>` : room}${!loose && c.housekeeping?.[room] ? html` <span class="status ${c.housekeeping[room] === 'dirty' ? 'bad' : 'warn'} dia hk">${c.housekeeping[room]}</span>` : ''}</th>${cells}</tr>`;
  };
  const sections = c.sections.filter((s) => !ui.chartType || s.name === ui.chartType);
  const body = sections.map((sec) => {
    let rooms = sec.rooms.map((r) => ({ r, bars: bars.filter((b) => b.room === r) }));
    if (freeOnly) rooms = rooms.filter((x) => !x.bars.length);
    if (q) rooms = rooms.filter((x) => x.r.toLowerCase().includes(q) || x.bars.some(hit));
    // Booked with no room number yet: a line of their own under the room type, so the night is not lost from view.
    const loose = freeOnly ? [] : c.unassigned.filter((u) => (u.roomType ?? '').toLowerCase().split(', ').includes(sec.name.toLowerCase()) && (!q || u.label.toLowerCase().includes(q)));
    if (!rooms.length && !loose.length) return '';
    return html`<tr class="cgrp"><th colspan="${c.days + 1}">${sec.name}<span class="gmeta">${plural(sec.rooms.length, sec.kind === 'dorms' ? 'bed' : 'room')}${sec.ratePaise ? ` · ${rs(sec.ratePaise)}/night` : ''}</span></th></tr>
      ${rooms.map((x) => cell(x.r, sec, x.bars, x.r))}
      ${loose.map((u, i) => cell('', sec, [{ ...u, u, room: '', guest: u.label.split(' · ')[0], byHand: false, src: /make\s*my\s*trip|mmt/i.test(u.label) ? 'mmt' : /goibibo/i.test(u.label) ? 'gi' : u.kind === 'pos' ? 'desk' : 'direct' }], `loose-${sec.name}-${i}`, true))}`;
  });
  const chip = (k, label, extra = '') => html`<button type="button" class="chip sm ${extra}" aria-pressed="${!ui[`chartHide_${k}`]}" data-act="chartToggle" data-k="${k}">${label}</button>`;
  return html`<div class="ctool">
      <div class="row"><button class="btn" type="button" data-act="chartMove" data-n="-" title="Earlier">‹</button><strong class="crange">${dayName(c.from)} – ${dayName(addDays(c.from, c.days - 1))}</strong>
        <button class="btn" type="button" data-act="chartMove" data-n="+" title="Later">›</button><button class="btn ghost" type="button" data-act="chartMove" data-n="0">Today</button>
        <span class="segs">${[7, 14].map((n) => html`<button type="button" class="chip sm" aria-pressed="${ui.chartDays === n}" data-act="chartDays" data-n="${n}">${n} days</button>`)}</span></div>
      <div class="row grow" style="justify-content:flex-end"><input class="in" type="search" data-model="chartQ" data-live value="${ui.chartQ ?? ''}" placeholder="Guest or room   /" aria-label="Search guest or room" style="max-width:220px">
        <select class="in" data-model="chartType" aria-label="Room type" style="max-width:180px"><option value="">All room types</option>${c.sections.map((s) => html`<option ${ui.chartType === s.name ? 'selected' : ''}>${s.name}</option>`)}</select>
        <button type="button" class="chip sm" aria-pressed="${freeOnly}" data-act="pick" data-k="chartFree" data-id="${freeOnly ? '' : '1'}">Only free</button>
        <button class="btn" type="button" data-act="blockAsk">Out of order…</button></div></div>
    <div class="cfilt"><span class="label" style="margin:0">Show</span>${chip('occ', 'In house')}${chip('arr', 'Booked')}${chip('pos', 'Made here')}${chip('hold', 'Holds')}${chip('ooo', 'Out of order')}
      <span class="label" style="margin:0 0 0 10px">Source</span>${['direct', 'mmt', 'gi', 'web'].map((k) => chip(k, html`<span class="srct s-${k}">${SRC[k][0]}</span> ${SRC[k][1]}`))}</div>
    ${errorBox()}
    <div class="chartwrap"><table class="chart"><thead><tr><th class="croom">Room</th>${dates.map((d) => html`<th class="${d === c.today ? 'today' : ''} ${[0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()) ? 'wkend' : ''}">${head(d)}${d === c.today ? html`<span class="tmark">today</span>` : ''}</th>`)}</tr></thead>
      <tbody>${body}</tbody></table></div>
    <div class="legend"><span><i class="lg k-occ"></i>In house (solid)</span><span><i class="lg k-arr"></i>Booked (tinted, edge = source)</span><span><i class="lg k-pos"></i>Made here, not in Djubo (dashed)</span>
      <span><i class="lg k-hold"></i>Hold (hatched)</span><span><i class="lg k-ooo"></i>Out of order (striped)</span><span class="kbd">/</span> search · <span class="kbd">N</span> new · <span class="kbd">Esc</span> close · drag the end of an in-house stay made here to extend it</div>`;
}
/** A booking, stay or blocked room picked on the chart, in the side panel. */
function chartSelPanel() {
  const sel = ui.chartSel;
  if (sel.free) return freeCellPanel(sel);
  if (sel.res) return html`<div class="dhead"><h2>${sel.room}</h2><button class="btn ghost" type="button" data-act="chartSelNo" title="Close (Esc)">Close</button></div>${reservationCard(sel.res, Date.now())}`;
  const n = Math.max(1, Math.round((Date.parse(sel.to) - Date.parse(sel.from)) / 86400000));
  const today = me.business.shiftDay;
  return html`<div class="dhead"><h2>${sel.room}</h2><button class="btn ghost" type="button" data-act="chartSelNo" title="Close (Esc)">Close</button></div>
    <section class="panel"><div><strong style="font-size:16px">${sel.guest ?? sel.label}</strong></div>
      <div class="row">${sel.src ? html`<span class="srct s-${sel.src}">${SRC[sel.src][0]}</span><span class="small">${SRC[sel.src][1]}</span>` : ''}<span class="status ${sel.kind === 'ooo' ? 'bad' : sel.kind === 'occ' ? 'info' : sel.kind === 'arr' ? 'ok' : 'warn'}">${KIND[sel.kind]}</span></div>
      <div class="small quiet">${dayName(sel.from)} → ${dayName(sel.to)} · ${plural(n, 'night')}</div>
      <div class="row">${sel.ref.type === 'booking' && sel.from <= today ? html`<button class="btn pri" type="button" data-act="goCheckin" data-kind="booking" data-id="${sel.ref.id}">Check in</button>` : ''}
        ${sel.ref.type === 'booking' && sel.from < today ? html`<button class="btn" type="button" data-act="noShow" data-kind="booking" data-id="${sel.ref.id}" data-held="0">No-show</button>` : ''}
        ${sel.ref.type === 'block' ? html`<button class="btn" type="button" data-act="blockDel" data-id="${sel.ref.id}">Back in use</button>` : ''}</div>
      ${sel.ref.type === 'booking' ? html`<p class="small quiet">From Djubo: change dates or rooms in Djubo; its revised mail updates this chart.</p>` : ''}</section>`;
}
/** A free room and night: a quick reservation here, or mark it out of order. */
function freeCellPanel(sel) {
  const rate = ui.chart.sections.find((s) => s.name === sel.type)?.ratePaise;
  const nights = Math.max(1, Number(ui.qrN) || 1);
  return html`<div class="dhead"><h2>${sel.room} · free</h2><button class="btn ghost" type="button" data-act="chartSelNo" title="Close (Esc)">Close</button></div>
    <form class="panel"><div class="small quiet">${sel.type} · from ${dayName(sel.day)}</div>${errorBox()}
      <div class="grid2"><label class="f">Nights<input class="in" inputmode="numeric" data-model="qrN" data-live value="${ui.qrN ?? '1'}"></label>
        <label class="f">Rate per night (₹, GST incl.)<input class="in" inputmode="decimal" data-model="qrRate" value="${ui.qrRate ?? (rate ? rupees(rate) : '')}"></label>
        <label class="f">Mobile<input class="in" type="tel" inputmode="tel" data-model="gPhone" data-act-change="gLookup" value="${ui.gPhone ?? ''}" autofocus></label>
        <label class="f">Guest name<input class="in" data-model="guest" value="${ui.guest ?? ''}"></label></div>
      <div class="chips">${['Phone', 'WhatsApp', 'Walk-in', 'Instagram', 'Travel agent'].map((x) => html`<button type="button" class="chip sm" aria-pressed="${(ui.qrSrc ?? 'Phone') === x}" data-act="pick" data-k="qrSrc" data-id="${x}">${x}</button>`)}</div>
      <div class="small">Check-out ${dayName(addDays(sel.day, nights))} · total ${rs((toPaise(ui.qrRate ?? (rate ? rupees(rate) : '0')) ?? 0) * nights)}</div>
      <div class="row"><button class="btn pri" type="submit" data-act="qrSave" data-submit>Save reservation</button>
        <button class="btn" type="button" data-act="chartFull" data-room="${sel.room}" data-type="${sel.type}" data-day="${sel.day}">Full form</button>
        <button class="btn ghost" type="button" data-act="blockAsk" data-room="${sel.room}" data-day="${sel.day}">Out of order…</button></div>
      <p class="small quiet">Then enter it in Djubo. Until Djubo's mail arrives it shows as "made here" and reception is reminded.</p></form>`;
}
actions.chartSel = async (d) => {
  const b = { ...ui.chart.bars[Number(d.i)] };
  if (b.ref.type === 'stay') { ui.chartSel = null; await actions.roomBill({ id: b.ref.id }); return; }
  if (b.ref.type === 'reservation') b.res = (await api('GET', `${B()}/reservations/${b.ref.id}`)).reservation;
  ui.chartSel = b; ui.roomBill = null; ui.error = null; rerender();
};
actions.chartSelNo = () => { ui.chartSel = null; rerender(); };
actions.chartLoose = async (d) => {
  const u = ui.chart.unassigned[Number(d.i)];
  const b = { ...u, room: `${u.roomType ?? ''} · no room yet`, guest: u.label.split(' · ')[0], src: /make\s*my\s*trip|mmt/i.test(u.label) ? 'mmt' : /goibibo/i.test(u.label) ? 'gi' : u.kind === 'pos' ? 'desk' : 'direct' };
  if (u.ref.type === 'reservation') b.res = (await api('GET', `${B()}/reservations/${u.ref.id}`)).reservation;
  ui.chartSel = b; ui.roomBill = null; rerender();
};
actions.chartNew = (d) => { ui.chartSel = { free: true, room: d.room, type: d.type, day: d.day }; ui.roomBill = null; ui.qrN = '1'; ui.qrRate = undefined; ui.guest = ''; ui.gPhone = ''; ui.error = null; rerender(); };
actions.chartFull = (d) => { pendingNew = { room: d.room, type: d.type, day: d.day }; go('#/rooms/new'); };
actions.qrSave = async () => {
  const sel = ui.chartSel;
  const rate = ui.qrRate ?? rupees(ui.chart.sections.find((s) => s.name === sel.type)?.ratePaise ?? 0);
  const nights = Math.max(1, Number(ui.qrN) || 1);
  const r = await api('POST', `${B()}/reservations`, { checkIn: sel.day, checkOut: addDays(sel.day, nights), guestName: ui.guest ?? '', phone: ui.gPhone ?? '', source: ui.qrSrc ?? 'Phone',
    lines: [{ type: sel.type, roomNames: [sel.room], adults: 2, rate }], nationality: 'Indian' });
  const full = (await api('GET', `${B()}/reservations/${r.id}`)).reservation;
  flash = { kind: 'ok', text: `Reservation saved: ${full.guestName}, ${sel.room}, ${dayName(sel.day)} for ${plural(nights, 'night')}. Now enter it in Djubo.`, link: [waLink(full), 'Send confirmation on WhatsApp'] };
  ui.chartSel = null; await loadChart(); await refreshDeskAlerts(); rerender();
};
actions.blockAsk = (d) => {
  ui.chartSel = null; ui.roomBill = null; ui.blkRoom = d.room ?? ui.blkRoom; ui.blkFrom = d.day ?? ui.blkFrom; ui.blkTo = d.day ?? ui.blkTo;
  ui.drawer = () => html`<div class="dhead"><h2>Room out of order</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>
    <form class="panel">${errorBox()}<label class="f">Room or bed<select class="in" data-model="blkRoom"><option value="">Choose</option>${ui.chart.sections.flatMap((s) => s.rooms).map((r) => html`<option ${ui.blkRoom === r ? 'selected' : ''}>${r}</option>`)}</select></label>
      <label class="f">Why<input class="in" data-model="blkNote" value="${ui.blkNote ?? ''}" placeholder="e.g. AC repair"></label>
      <div class="grid2"><label class="f">First night<input class="in" type="date" data-model="blkFrom" value="${ui.blkFrom ?? ui.chart.today}"></label><label class="f">Last night<input class="in" type="date" data-model="blkTo" value="${ui.blkTo ?? ui.blkFrom ?? ui.chart.today}"></label></div>
      <div class="row"><button class="btn pri" type="submit" data-act="blockAdd" data-submit>Mark out of order</button></div></form>`;
  rerender();
};
actions.blockAdd = async () => {
  await api('POST', `${B()}/frontdesk/blocks`, { room: ui.blkRoom ?? '', from: ui.blkFrom ?? ui.chart.today, to: ui.blkTo ?? ui.blkFrom ?? ui.chart.today, note: ui.blkNote ?? '' });
  flash = { kind: 'ok', text: `${ui.blkRoom} marked out of order.` }; ui.blkNote = ''; ui.drawer = null; await loadChart(); rerender();
};
actions.blockDel = async (d) => { await api('DELETE', `${B()}/frontdesk/blocks/${d.id}`); ui.chartSel = null; await loadChart(); rerender(); };
// Drag to extend (a stay checked in here, not from Djubo): drag the bar's end to a later night; the room bill opens on
// "Extend stay" with that date, to confirm and add the rent. Djubo stays are extended in Djubo.
root.addEventListener('mousedown', (ev) => {
  const grip = ev.target.closest?.('[data-grip]');
  if (!grip || !ui.chart) return;
  ev.preventDefault(); ev.stopPropagation();
  const stayId = grip.dataset.grip;
  let last = null;
  const over = (e) => {
    root.querySelectorAll('td.dragto').forEach((x) => x.classList.remove('dragto'));
    const td = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('td[data-day]');
    if (td && td.closest('tr') === grip.closest('tr')) { td.classList.add('dragto'); last = td.dataset.day; } else last = null;
  };
  const up = async () => {
    document.removeEventListener('mousemove', over); document.removeEventListener('mouseup', up);
    root.querySelectorAll('td.dragto').forEach((x) => x.classList.remove('dragto'));
    if (!last) return;
    await actions.roomBill({ id: stayId });
    ui.rbForm = 'extend'; ui.exTo = addDays(last, 1); ui.exRate = undefined; rerender();
  };
  document.addEventListener('mousemove', over); document.addEventListener('mouseup', up);
}, true);

// ----- reservations list
const resStatus = (r, now) => (r.status === 'cancelled' ? ['bad', 'Cancelled'] : r.stayId ? ['open', 'Checked in'] : r.status === 'linked' ? ['open', `In Djubo ${r.bookingRef ?? ''}`]
  : r.status === 'hold' ? ((r.holdUntil ?? 0) < now ? ['bad', 'Hold lapsed'] : ['new', `Hold till ${time(r.holdUntil)}`]) : ['new', 'Not in Djubo yet']);
const bkStatus = (k) => (k.status === 'cancelled' ? ['bad', 'Cancelled'] : k.status === 'checked_in' ? ['open', 'Checked in'] : k.unplaced ? ['bad', 'Djubo could not place']
  : k.problem ? ['new', /hold/.test(k.problem) ? 'Website hold' : 'Check it'] : ['open', 'Confirmed']);
// Reservations sorted by the latest email (28 Nov 2026): the choice is kept on this computer.
const RES_SORT_KEY = 'bookr-pos-res-sort';
function resSort() { try { return localStorage.getItem(RES_SORT_KEY) === 'stay' ? 'stay' : 'mail'; } catch { return 'mail'; } }
actions.resSort = (d) => { try { localStorage.setItem(RES_SORT_KEY, d.id); } catch { /* this visit only */ } rerender(); };
/** When the row's latest email came (a desk reservation: when it was made), for sorting and the "Email came" column. */
const mailWhen = (kind, x) => (kind === 'res' ? x.createdAt : x.mailAt ?? x.createdAt) ?? 0;
function mailCell(kind, x, nowMs) {
  const at = mailWhen(kind, x);
  if (!at) return html`<span class="quiet">—</span>`;
  const fresh = nowMs - at < 3600000;
  const what = kind === 'res' ? `Made here${x.madeBy ? ` by ${x.madeBy}` : ''}` : x.status === 'cancelled' ? 'Cancelled' : (x.mailCount ?? 0) > 1 ? 'Revised' : 'New booking';
  const first = kind === 'bk' && x.mailFirstAt && x.mailCount > 1 && dayKey(x.mailFirstAt) !== dayKey(at) ? html`<br>first ${dateTime(x.mailFirstAt)}` : '';
  return html`<strong class="money">${dateTime(at)}</strong>${fresh ? html` <span class="status warn">NEW</span>` : ''}
    <div class="small quiet">${what}${kind === 'bk' && x.mailCount > 1 ? ` · ${x.mailCount} emails` : ''}${first}</div>`;
}
const dayKey = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);
function listView() {
  const r = ui.res ?? { reservations: [], bookings: [] };
  const f = ui.resF ?? 'upcoming';
  const sort = resSort();
  const rows = [
    ...r.reservations.filter((x) => x.status !== 'linked').map((x) => ({ kind: 'res', x, checkIn: x.checkIn, st: resStatus(x, r.now) })),
    ...r.bookings.map((x) => ({ kind: 'bk', x, checkIn: x.checkIn ?? '', st: bkStatus(x) })),
  ].filter((y) => f === 'all' || (f === 'upcoming' && !['Cancelled', 'Hold lapsed'].includes(y.st[1]) && y.st[1] !== 'Checked in')
    || (f === 'house' && y.st[1] === 'Checked in') || (f === 'holds' && /hold/i.test(y.st[1])) || (f === 'nodjubo' && y.st[1] === 'Not in Djubo yet') || (f === 'cancelled' && y.st[1] === 'Cancelled'))
    .sort((a, b) => (sort === 'mail' ? mailWhen(b.kind, b.x) - mailWhen(a.kind, a.x) || a.checkIn.localeCompare(b.checkIn) : a.checkIn.localeCompare(b.checkIn)));
  const sel = ui.resSel;
  const inbox = inboxCount(ui.bk);
  const seg = html`<div class="segs" style="margin-bottom:12px"><button type="button" class="chip" aria-pressed="${ui.resTab !== 'inbox'}" data-act="pick" data-k="resTab" data-id="list">All reservations</button>
    <button type="button" class="chip" aria-pressed="${ui.resTab === 'inbox'}" data-act="pick" data-k="resTab" data-id="inbox">Waiting for you ${inbox ? html`<span class="status warn">${inbox}</span>` : ''}</button></div>`;
  if (ui.resTab === 'inbox') return html`${seg}${errorBox()}${ui.bk ? bookingsPanel(ui.bk) : html`<p class="empty">Could not load bookings from mail.</p>`}`;
  return html`${seg}<form class="row" style="margin-bottom:10px"><input class="in" type="search" data-model="resQ" value="${ui.resQ ?? ''}" placeholder="Name, phone, Djubo or MakeMyTrip number" style="flex:1 1 240px" aria-label="Search reservations">
      <button class="btn" type="submit" data-act="resSearch" data-submit>Search</button></form>
    <div class="row" style="margin-bottom:10px;justify-content:space-between;gap:8px"><div class="chips">${[['upcoming', 'Upcoming'], ['house', 'In house'], ['holds', 'Holds'], ['nodjubo', 'Not in Djubo'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${f === k}" data-act="pick" data-k="resF" data-id="${k}">${t}</button>`)}</div>
      <div class="chips" role="group" aria-label="Sort"><span class="small quiet" style="align-self:center">Sort</span>${[['mail', 'Latest email first'], ['stay', 'Stay date']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${sort === k}" data-act="resSort" data-id="${k}">${t}</button>`)}</div></div>
    ${errorBox()}
    ${sel ? reservationCard(sel, r.now) : ''}
    <section class="panel" style="padding:0;overflow:hidden"><div class="scroll" style="max-height:calc(100vh - 290px)"><table class="t cards"><thead><tr><th>Email came</th><th data-sort>Guest</th><th data-sort>Stay</th><th data-sort>Room</th><th data-sort>Source</th><th data-sort>Status</th><th class="num" data-sort>Total</th><th class="num" data-sort>To collect</th></tr></thead><tbody>
      ${rows.length ? rows.map(({ kind, x, st }) => html`<tr>
        <td data-label="Email came">${mailCell(kind, x, r.now ?? Date.now())}</td>
        <td data-label="Guest">${kind === 'res' ? html`<button class="linkbtn" type="button" data-act="resPick" data-id="${x.id}"><strong>${x.guestName}</strong></button>` : html`<button class="linkbtn" type="button" data-act="bkOpen" data-id="${x.id}"><strong>${x.guestName ?? 'No name'}</strong></button>`}
          <div class="small quiet">${kind === 'res' ? 'made here' : `${x.source === 'mmt' ? 'MakeMyTrip' : 'Djubo'} ${x.extRef}`}${x.phone ? ` · ${x.phone}` : ''}</div></td>
        <td data-label="Stay" data-v="${x.checkIn}">${dayName(x.checkIn)} → ${dayName(x.checkOut)}</td>
        <td data-label="Room">${kind === 'res' ? x.lines.map((l) => `${l.type}${l.roomNames.length ? ` ${l.roomNames.join(', ')}` : ` × ${l.rooms}`}`).join(' · ') : `${x.roomType ?? '?'}${x.roomLabels ? ` ${x.roomLabels}` : ''}`}</td>
        <td data-label="Source">${kind === 'res' ? x.source : x.channel ?? '—'}</td>
        <td data-label="Status"><span class="badge ${st[0]}">${st[1]}</span></td>
        <td class="num" data-label="Total">${kind === 'res' ? rs(x.totalPaise) : x.amountPaise != null ? rs(x.amountPaise) : x.fromReport ? html`—<div class="small quiet">Djubo's report</div>` : '—'}</td>
        <td class="num" data-label="To collect">${kind === 'res' ? rs(Math.max(0, x.totalPaise - x.advancePaise)) : x.amountPaise || (x.fromReport && x.amountPaise == null) ? rs(dueOf(x)) : '—'}</td></tr>`) : html`<tr><td colspan="8"><p class="empty">No reservations match. Try "All", or search by name, phone or booking number.</p></td></tr>`}
    </tbody></table></div></section>`;
}
actions.resSearch = async () => { ui.res = await api('GET', `${B()}/reservations${ui.resQ ? `?q=${encodeURIComponent(ui.resQ)}` : ''}`); ui.resF = 'all'; rerender(); };
actions.resPick = async (d) => {
  const r = (await api('GET', `${B()}/reservations/${d.id}`)).reservation;
  ui.roomBill = null; ui.chartSel = null;
  ui.drawer = () => html`<div class="dhead"><h2>${r.guestName}</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>${reservationCard(r, Date.now())}`;
  rerender();
};
/** A Djubo or MakeMyTrip booking from the list, in the side panel. */
actions.bkOpen = (d) => {
  const k = ui.res?.bookings.find((x) => x.id === d.id);
  if (!k) return;
  const today = me.business.shiftDay;
  ui.roomBill = null; ui.chartSel = null;
  ui.drawer = () => html`<div class="dhead"><h2>${k.guestName ?? 'Booking'}</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>
    <section class="panel">${bookingCard(k)}${k.problem ? html`<div class="small" style="color:var(--warn)">Check: ${k.problem}</div>` : ''}
      <div class="row">${k.status === 'approved' && !k.stayId && k.checkIn <= today ? html`<button class="btn pri" type="button" data-act="goCheckin" data-kind="booking" data-id="${k.id}">Check in</button>` : ''}
        ${k.stayId ? html`<button class="btn pri" type="button" data-act="roomBill" data-id="${k.stayId}">Room bill</button>` : ''}
        ${['approved', 'new'].includes(k.status) && !k.stayId && k.checkIn < today ? html`<button class="btn" type="button" data-act="noShow" data-kind="booking" data-id="${k.id}" data-held="${k.heldPaise}">No-show</button>` : ''}
        ${k.status === 'new' ? html`<button class="btn" type="button" data-act="pick" data-k="resTab" data-id="inbox">Approve in Waiting for you</button>` : ''}</div>
      <p class="small quiet">Change dates or rooms in Djubo; its revised mail updates this booking.</p></section>`;
  rerender();
};
/** How many things wait in the inbox: bookings to approve (a MakeMyTrip + Djubo pair counts once), Djubo alerts, mails to look at. */
/** What waits in the inbox (24 Nov 2026): bookings to approve; website holds waiting for the guest to pay (not for you);
 *  and MakeMyTrip copies of a booking Djubo could not place, shown with that alert as one item. */
function waitingGroups(r) {
  const base = r.waiting.filter((b) => !(b.source === 'mmt' && b.matchId && r.waiting.some((x) => x.id === b.matchId)));
  const alertPnrs = new Set((r.alerts ?? []).map((a) => a.pnr).filter(Boolean));
  const copyOfAlert = (b) => b.source === 'mmt' && b.pnr && alertPnrs.has(b.pnr);
  const isHold = (b) => /website hold/i.test(b.problem ?? '');
  return { approve: base.filter((b) => !copyOfAlert(b) && !isHold(b)), holds: base.filter((b) => !copyOfAlert(b) && isHold(b)), copies: base.filter(copyOfAlert) };
}
const inboxCount = (r) => (r ? waitingGroups(r).approve.length + (r.alerts?.length ?? 0)
  + r.mails.filter((m) => m.status === 'failed' || m.source === 'gmail').length : 0);
/** The WhatsApp message confirming a reservation, ready for staff to send. */
const waLink = (r) => {
  const n = Math.max(1, Math.round((Date.parse(r.checkOut) - Date.parse(r.checkIn)) / 86400000));
  const msg = `Hello ${r.guestName}, your stay at ${me.business.name} is ${r.status === 'hold' ? 'on hold' : 'confirmed'}.\n${dayName(r.checkIn)} → ${dayName(r.checkOut)} (${n} night${n === 1 ? '' : 's'})\n`
    + `${r.lines.map((l) => `${l.type}${l.roomNames.length ? ` ${l.roomNames.join(', ')}` : ` × ${l.rooms}`}`).join(', ')}${r.mealPlan ? ` · ${r.mealPlan}` : ''}\nTotal ₹${rupees(r.totalPaise)}`
    + `${r.advancePaise ? `, advance received ₹${rupees(r.advancePaise)}, balance at check-in ₹${rupees(Math.max(0, r.totalPaise - r.advancePaise))}` : ''}.\nCheck-in from 1 pm, check-out 11 am.${r.policy ? ` ${r.policy}.` : ''}`;
  const to = String(r.phone ?? '').replace(/\D/g, '');
  return `https://wa.me/${to.length === 10 ? `91${to}` : to}?text=${encodeURIComponent(msg)}`;
};
function reservationCard(r, now) {
  const st = resStatus(r, now);
  const open = r.status !== 'cancelled' && !r.stayId;
  return html`<section class="panel" style="margin-bottom:12px;border-color:var(--pri-line)">
    <div class="line"><h2 class="grow" style="margin:0">${r.guestName} <span class="badge ${st[0]}">${st[1]}</span></h2>${ui.drawer ? '' : html`<button class="btn ghost" type="button" data-act="pick" data-k="resSel" data-id="">Close</button>`}</div>
    <div class="small">${dayName(r.checkIn)} → ${dayName(r.checkOut)}${r.arrivalTime ? ` · arriving ${r.arrivalTime}` : ''} · ${r.lines.map((l) => `${l.type}${l.roomNames.length ? ` ${l.roomNames.join(', ')}` : ` × ${l.rooms}`} · ${l.adults} adult${l.adults === 1 ? '' : 's'}${l.children ? `, ${l.children} child` : ''} · ${rs(l.ratePaise)}/night`).join(' · ')}</div>
    <div class="small">${r.source} · made ${dateTime(r.createdAt)}${r.madeBy ? ` by ${r.madeBy}` : ''}${r.mealPlan ? ` · ${r.mealPlan}` : ''}${r.policy ? ` · ${r.policy}` : ''}${r.company ? ` · ${r.company}${r.gstin ? ` (${r.gstin})` : ''}` : ''}</div>
    ${r.requests ? html`<div class="small">Requests: ${r.requests}</div>` : ''}${r.staffNote ? html`<div class="small quiet">Staff note: ${r.staffNote}</div>` : ''}
    <div>Total ${rs(r.totalPaise)} · advance ${rs(r.advancePaise)} · <strong>balance ${rs(Math.max(0, r.totalPaise - r.advancePaise))}</strong></div>
    ${r.cancelReason ? html`<div class="small" style="color:var(--bad)">Cancelled: ${r.cancelReason}</div>` : ''}
    ${open ? html`<div class="row" style="flex-wrap:wrap">
      ${r.checkIn <= me.business.shiftDay ? html`<button class="btn pri" type="button" data-act="goCheckin" data-kind="reservation" data-id="${r.id}">Check in</button>` : ''}
      <button class="btn" type="button" data-act="resAdv" data-id="${r.id}" data-n="${r.guestName}">Take advance</button>
      ${r.status !== 'linked' ? html`<button class="btn" type="button" data-act="resEdit" data-id="${r.id}">Change</button>` : ''}
      ${r.checkIn <= me.business.shiftDay ? html`<button class="btn ghost" type="button" data-act="noShow" data-kind="reservation" data-id="${r.id}" data-held="${r.advancePaise}">No-show</button>` : ''}
      ${r.status === 'hold' ? html`<button class="btn" type="button" data-act="resConfirm" data-id="${r.id}">Confirm (no money yet)</button>` : ''}
      ${r.status !== 'linked' ? html`<button class="btn" type="button" data-act="resLater" data-id="${r.id}">Entered in Djubo · remind me in 15 min</button>` : ''}
      <a class="btn" href="${waLink(r)}" target="_blank" rel="noopener noreferrer">Send confirmation on WhatsApp</a>
      <button class="btn ghost" type="button" data-act="resCancel" data-id="${r.id}">Cancel reservation</button></div>` : ''}
  </section>`;
}
actions.resEdit = async (d) => { pendingEdit = (await api('GET', `${B()}/reservations/${d.id}`)).reservation; go('#/rooms/new'); };
/** A guest who never came: the booking or reservation leaves the board; an advance taken here is kept (the no-show charge) or given back. */
actions.noShow = async (d) => {
  const held = Number(d.held) || 0;
  let advance = 'refund';
  if (held) {
    const keep = confirm(`Mark as no-show. Keep the advance of ${rs(held)} as the no-show charge? (Cancel to choose giving it back.)`);
    advance = keep ? 'keep' : 'refund';
    if (!keep && !confirm(`Mark as no-show and give the advance of ${rs(held)} back later (Money at reception)?`)) return;
  } else if (!confirm('Mark this guest as a no-show?')) return;
  await api('POST', `${B()}/${d.kind === 'booking' ? 'bookings' : 'reservations'}/${d.id}/no-show`, { advance });
  flash = { kind: 'ok', text: advance === 'keep' ? 'No-show marked; the advance is kept as the no-show charge.' : held ? 'No-show marked; give the advance back under Money at reception.' : 'No-show marked.' };
  await refreshDeskAlerts(); route();
};
actions.resConfirm = async (d) => { await api('POST', `${B()}/reservations/${d.id}/confirm`); flash = { kind: 'ok', text: 'Confirmed.' }; route(); };
actions.resAdv = (d) => { ui.adv = { reservationId: d.id, name: d.n }; ui.recvMode = 'cash'; ui.recvAmount = undefined; ui.error = null; rerender(); scrollTo(0, 0); };

// ----- new reservation
async function loadFree() {
  if (!ui.nrIn || !ui.nrOut || ui.nrOut <= ui.nrIn) { ui.free = null; return; }
  const r = await api('GET', `${B()}/frontdesk/free?from=${ui.nrIn}&to=${ui.nrOut}`);
  ui.free = r.types; ui.rates = r.rates;
  for (const t of r.types) {
    if (ui[`nrRate_${t.type}`] === undefined && r.rates[t.type]) ui[`nrRate_${t.type}`] = rupees(r.rates[t.type]);
    ui.nrPicks[t.type] = (ui.nrPicks[t.type] ?? []).filter((x) => t.freeRooms.includes(x));
  }
}
actions.nrDates = async () => { if (ui.nrOut <= ui.nrIn) ui.nrOut = addDays(ui.nrIn, 1); await loadFree(); rerender(); };
actions.nrPick = (d) => { const l = ui.nrPicks[d.t] ?? (ui.nrPicks[d.t] = []); ui.nrPicks[d.t] = l.includes(d.r) ? l.filter((x) => x !== d.r) : [...l, d.r]; rerender(); };
const nrNights = () => Math.max(1, Math.round((Date.parse(ui.nrOut) - Date.parse(ui.nrIn)) / 86400000));
function nrLines() {
  return (ui.free ?? []).map((t) => {
    const picks = ui.nrPicks[t.type] ?? [];
    const rooms = picks.length || Number(ui[`nrRooms_${t.type}`] || 0);
    return { type: t.type, rooms, roomNames: picks, adults: Number(ui[`nrAdults_${t.type}`] || (rooms ? 2 * rooms : 0)), children: Number(ui[`nrKids_${t.type}`] || 0), rate: ui[`nrRate_${t.type}`] ?? '' };
  }).filter((l) => l.rooms > 0);
}
function newResView() {
  const n = nrNights();
  const lines = nrLines();
  const total = lines.reduce((s, l) => s + (toPaise(l.rate) ?? 0) * l.rooms * n, 0);
  const perNight = lines.length ? Math.max(...lines.map((l) => toPaise(l.rate) ?? 0)) : 0;
  const bp = perNight > 750000 ? 1800 : 500;
  const taxable = Math.round(total * 10000 / (10000 + bp));
  const chip = (k, v, t = v) => html`<button type="button" class="chip" aria-pressed="${ui[k] === v}" data-act="pick" data-k="${k}" data-id="${v}">${t}</button>`;
  return html`<form class="panel" style="max-width:1000px">${errorBox()}
    ${ui.nrEdit ? html`<div class="msg warn">Changing a reservation. Its advance stays with it.</div>` : ''}
    <h2>1 · Dates and rooms</h2>
    <div class="grid3"><label class="f">Check-in<input class="in" type="date" data-model="nrIn" data-act-change="nrDates" value="${ui.nrIn}"></label>
      <label class="f">Check-out · ${plural(n, 'night')}<input class="in" type="date" data-model="nrOut" data-act-change="nrDates" value="${ui.nrOut}"></label>
      <label class="f">Arrival time<input class="in" data-model="nrTime" value="${ui.nrTime ?? ''}" placeholder="e.g. around 2 pm"></label></div>
    <div class="scroll"><table class="t"><thead><tr><th>Room type</th><th>Free</th><th>Pick rooms or beds</th><th>How many</th><th>Adults</th><th>Children</th><th class="num">Rate / night (₹, GST incl.)</th></tr></thead><tbody>
      ${(ui.free ?? []).map((t) => html`<tr><td><strong>${t.type}</strong></td><td><span class="badge ${t.freeCount ? 'open' : 'bad'}">${t.freeCount ? `${t.freeCount} free` : 'full'}</span></td>
        <td><div class="chips">${t.freeRooms.map((r) => html`<button type="button" class="chip" aria-pressed="${(ui.nrPicks[t.type] ?? []).includes(r)}" data-act="nrPick" data-t="${t.type}" data-r="${r}">${r}</button>`)}</div></td>
        <td>${(ui.nrPicks[t.type] ?? []).length ? html`<span>${(ui.nrPicks[t.type] ?? []).length}</span>` : html`<input class="in" style="width:70px" inputmode="numeric" data-model="nrRooms_${t.type}" data-live value="${ui[`nrRooms_${t.type}`] ?? ''}" ${t.freeCount ? '' : 'disabled'}>`}</td>
        <td><input class="in" style="width:70px" inputmode="numeric" data-model="nrAdults_${t.type}" data-live value="${ui[`nrAdults_${t.type}`] ?? ''}" placeholder="2"></td>
        <td><input class="in" style="width:70px" inputmode="numeric" data-model="nrKids_${t.type}" data-live value="${ui[`nrKids_${t.type}`] ?? ''}" placeholder="0"></td>
        <td class="num"><input class="in" style="width:110px;text-align:right" inputmode="decimal" data-model="nrRate_${t.type}" data-live value="${ui[`nrRate_${t.type}`] ?? ''}"></td></tr>`)}
    </tbody></table></div>
    ${isMgr() ? html`<p class="small quiet">Room rates come from <a href="#/settings/bookings">Settings › Rooms and bookings</a>. A rate lower than that by more than the discount limit needs a manager's PIN.</p>` : ''}
    ${ui.ratesEdit ? ratesForm() : ''}
    <div class="f">Meal plan<div class="chips">${['Room only (EP)', 'Breakfast (CP)', 'Breakfast + 1 meal (MAP)', 'All meals (AP)'].map((m) => chip('nrMeal', m))}</div></div>
    <label class="f">Extras (optional)<input class="in" data-model="nrExtras" value="${ui.nrExtras ?? ''}" placeholder="e.g. extra mattress, early check-in, pickup"></label>

    <h2 style="margin-top:14px">2 · Guest</h2>
    <div class="grid3"><label class="f">Mobile (required)<input class="in" type="tel" inputmode="tel" data-model="gPhone" data-act-change="gLookup" value="${ui.gPhone ?? ''}" placeholder="Finds a returning guest"></label>
      <label class="f">Full name, as on ID (required)<input class="in" data-model="guest" value="${ui.guest ?? ''}"></label>
      <label class="f">Email<input class="in" type="email" data-model="nrEmail" value="${ui.nrEmail ?? ''}"></label>
      <label class="f">Coming from (city)<input class="in" data-model="gCity" value="${ui.gCity ?? ''}"></label>
      <label class="f">Nationality<input class="in" data-model="nrNat" value="${ui.nrNat ?? 'Indian'}"></label>
      <label class="f">Company (business invoice)<input class="in" data-model="nrCo" value="${ui.nrCo ?? ''}"></label>
      <label class="f">Company GSTIN<input class="in" data-model="nrGstin" value="${ui.nrGstin ?? ''}" maxlength="15"></label></div>
    ${ui.gFound ? html`<div class="msg ok">Returning guest: <strong>${ui.gFound.name}</strong> · ${plural(ui.gFound.stays.length, 'earlier stay')}</div>` : ''}
    ${ui.nrNat && !/^indian?$/i.test(ui.nrNat.trim()) ? html`<div class="msg warn">Foreign national: passport and visa details are taken at check-in for Form C (to be filed within 24 hours of arrival).</div>` : ''}

    <h2 style="margin-top:14px">3 · Source and policy</h2>
    <div class="f">Booked by<div class="chips">${['Walk-in', 'Phone', 'WhatsApp', 'Instagram', 'Travel agent', 'Corporate', 'Website', 'Other'].map((x) => chip('nrSource', x))}</div></div>
    <div class="grid2"><label class="f">Special requests<input class="in" data-model="nrReq" value="${ui.nrReq ?? ''}"></label><label class="f">Note for staff (not for the guest)<input class="in" data-model="nrNote" value="${ui.nrNote ?? ''}"></label></div>
    <div class="row"><div class="f">Status<div class="chips">${chip('nrStatus', 'confirmed', 'Confirmed')}${chip('nrStatus', 'hold', 'Hold (no money yet)')}</div></div>
      ${ui.nrStatus === 'hold' ? html`<label class="f">Hold for (hours)<input class="in" style="width:90px" inputmode="numeric" data-model="nrHold" value="${ui.nrHold ?? '6'}"></label>` : ''}
      <div class="f">Cancellation<div class="chips">${chip('nrPolicy', 'Non-refundable')}${chip('nrPolicy', 'Free cancellation till 48 hours before')}</div></div></div>

    <h2 style="margin-top:14px">4 · Money</h2>
    <div class="grid2"><div class="sums"><div><span>${lines.map((l) => `${l.type} × ${l.rooms}`).join(', ') || 'No rooms yet'} · ${plural(n, 'night')}</span><span>${rs(total)}</span></div>
        <div><span class="quiet">Value</span><span>${rs(taxable)}</span></div><div><span class="quiet">GST ${bp / 100}% (CGST + SGST)</span><span>${rs(total - taxable)}</span></div>
        <div class="big"><span>Total</span><span>${rs(total)}</span></div></div>
      ${ui.nrEdit ? html`<div class="small quiet">Take any further advance from the reservation (Take advance).</div>` : html`<div><p class="label">Advance now (optional)</p>${payFields('nrAdv')}`}
        ${ui.nrEdit ? '' : html`<p class="small">Balance at check-in: <strong>${rs(Math.max(0, total - (toPaise(ui.nrAdv) ?? 0)))}</strong></p></div>`}</div>
    <div class="msg warn" style="margin-top:10px">Then enter it in Djubo: Djubo is the master for rooms. Until Djubo's confirmation mail arrives, this shows as "Not in Djubo yet" and reception is reminded.</div>
    <div class="row" style="margin-top:10px"><button class="btn pri" type="submit" data-act="nrSave" data-submit>${ui.nrEdit ? 'Save the change' : `Save reservation${toPaise(ui.nrAdv) ? ' and print advance receipt' : ''}`}</button><a class="btn" href="#/rooms">Cancel</a></div>
  </form>`;
}
actions.nrSave = async () => {
  const lines = nrLines();
  if (!lines.length) throw new Error('Choose at least one room or bed.');
  const adv = ui.nrEdit ? null : toPaise(ui.nrAdv);
  const r = await api(ui.nrEdit ? 'PUT' : 'POST', `${B()}/reservations${ui.nrEdit ? `/${ui.nrEdit}` : ''}`, {
    checkIn: ui.nrIn, checkOut: ui.nrOut, arrivalTime: ui.nrTime || undefined, lines, mealPlan: ui.nrMeal, extras: ui.nrExtras || undefined,
    guestName: ui.guest ?? '', phone: ui.gPhone ?? '', email: ui.nrEmail || undefined, city: ui.gCity || undefined, nationality: ui.nrNat ?? 'Indian', company: ui.nrCo || undefined, gstin: ui.nrGstin || undefined,
    source: ui.nrSource, requests: ui.nrReq || undefined, staffNote: ui.nrNote || undefined, status: ui.nrStatus, holdHours: ui.nrHold ? Number(ui.nrHold) : undefined, policy: ui.nrPolicy,
    payments: adv ? [payOf('nrAdv')] : undefined,
  });
  if (r.receipt) printJobs([{ kind: 'bill', html: asHtml(receiptSlip(r.receipt)) }]);
  const full = (await api('GET', `${B()}/reservations/${r.id}`)).reservation;
  if (ui.nrEdit) { flash = { kind: 'ok', text: `Reservation changed for ${full.guestName}: ${rs(r.totalPaise)}. Change it in Djubo too if it is there.`, link: [waLink(full), 'Send the change on WhatsApp'] }; go('#/rooms/list'); return; }
  flash = { kind: 'ok', text: `Reservation saved for ${full.guestName}: ${rs(r.totalPaise)}${r.receipt ? `, advance ${rs(r.receipt.totalPaise)} (${r.receipt.receiptNo})` : ''}. Now enter it in Djubo.`, link: [waLink(full), 'Send confirmation on WhatsApp'] };
  go('#/rooms/list');
};
function ratesForm(page = false) {
  return html`<div class="panel" style="${page ? '' : 'margin:8px 0;border-color:var(--pri-line)'}"><${page ? 'h2' : 'h3'}>Rates per room type (₹ per night, GST included)</${page ? 'h2' : 'h3'}>${page ? html`<p class="small quiet">Filled in for reservations made at the desk. Djubo and MakeMyTrip bookings keep their own amounts.</p>` : ''}
    <div class="grid3">${(ui.free ?? []).map((t) => html`<label class="f">${t.type}<input class="in" inputmode="decimal" data-model="rate_${t.type}" value="${ui[`rate_${t.type}`] ?? (ui.rates?.[t.type] ? rupees(ui.rates[t.type]) : '')}"></label>`)}</div>
    <div class="row"><button class="btn pri" type="button" data-act="ratesSave">Save rates</button>${page ? '' : html`<button class="btn ghost" type="button" data-act="pick" data-k="ratesEdit" data-id="">Close</button>`}</div></div>`;
}
actions.ratesEdit = () => { ui.ratesEdit = 'on'; rerender(); };
actions.ratesSave = async () => {
  const rates = Object.fromEntries((ui.free ?? []).map((t) => [t.type, ui[`rate_${t.type}`] ?? (ui.rates?.[t.type] ? rupees(ui.rates[t.type]) : '')]));
  const r = await api('PUT', `${B()}/frontdesk/rates`, { rates });
  ui.rates = r.rates; ui.ratesEdit = ''; for (const [k, v] of Object.entries(r.rates)) ui[`nrRate_${k}`] = rupees(v);
  flash = { kind: 'ok', text: 'Rates saved.' }; rerender();
};

// ----- check-in
async function pickReservation(id) {
  const r = (await api('GET', `${B()}/reservations/${id}`)).reservation;
  ui.resPicked = r; ui.bookingId = null;
  ui.guest = r.guestName; ui.gPhone = r.phone; ui.gCity = r.city ?? ''; ui.ciNat = r.nationality ?? 'Indian'; ui.ciOut = r.checkOut;
  ui.ciAdults = String(r.lines.reduce((s, l) => s + l.adults, 0)); ui.ciKids = String(r.lines.reduce((s, l) => s + l.children, 0));
  const first = r.lines.flatMap((l) => l.roomNames)[0];
  if (first) ui.room = first; else ui.roomQ = r.lines[0]?.type ?? '';
}
actions.pickRes = async (d) => { await pickReservation(d.id); rerender(); };
// ----- night audit (25 Nov 2026): what is left before the day is closed
function auditView() {
  const a = ui.audit;
  if (!a) return '';
  // A checklist: each step shows its count, is ticked when nothing is left, and its rows carry the action that clears them.
  const steps = [
    { id: 'arr', short: 'To arrive', title: 'Due to arrive, not checked in', list: a.notArrived, tone: 'warn', rows: a.notArrived.map((x) => [html`<strong>${x.guestName ?? 'No name'}</strong><small>${x.kind === 'reservation' ? 'made here' : x.channel ?? 'Djubo'} · ${dayName(x.checkIn)} → ${dayName(x.checkOut)}${x.heldPaise ? ` · advance ${rs(x.heldPaise)}` : ''}</small>`,
      html`${x.checkIn < a.today ? html`<span class="status bad">was due ${dayName(x.checkIn)}</span>` : ''}<button class="btn sm" type="button" data-act="goCheckin" data-kind="${x.kind}" data-id="${x.id}">Check in</button><button class="btn sm ghost" type="button" data-act="noShow" data-kind="${x.kind}" data-id="${x.id}" data-held="${x.heldPaise}">No-show</button>`]) },
    { id: 'over', short: 'Overstays', title: 'Past their check-out date', list: a.overstays, tone: 'bad', rows: a.overstays.map((x) => [html`<strong>${x.room} · ${x.guestName}</strong><small>was due out ${dayName(x.plan)}</small>`,
      html`${x.balancePaise ? html`<span class="status warn">Owes ${rs(x.balancePaise)}</span>` : ''}<button class="btn sm pri" type="button" data-act="roomBill" data-id="${x.id}">Extend or check out</button>`]) },
    { id: 'out', short: 'Due out', title: 'Due out today', list: a.dueOut, tone: 'warn', rows: a.dueOut.map((x) => [html`<strong>${x.room} · ${x.guestName}</strong>`,
      html`${x.balancePaise > 0 ? html`<span class="status warn">Owes ${rs(x.balancePaise)}</span>` : x.balancePaise < 0 ? html`<span class="status info">Holds ${rs(-x.balancePaise)}</span>` : html`<span class="status ok">Settled</span>`}<button class="btn sm" type="button" data-act="roomBill" data-id="${x.id}">Room bill</button>`]) },
    { id: 'formc', short: 'Form C', title: 'Form C not filed', list: a.formC, tone: a.formC.some((x) => x.level === 'red') ? 'bad' : 'warn', rows: a.formC.map((x) => [html`<strong>${x.room} · ${x.guestName}</strong><small>checked in ${x.hours} h ago · due within 24 h</small>`,
      html`<button class="btn sm" type="button" data-act="formC" data-id="${x.stayId}">Mark filed</button>`]) },
    { id: 'bal', short: 'Balances', title: 'In house with money owed or held', list: a.balances, tone: 'info', rows: a.balances.map((x) => [html`<strong>${x.room} · ${x.guestName}</strong>`,
      html`${x.balancePaise > 0 ? html`<span class="status warn">Owes ${rs(x.balancePaise)}</span>` : html`<span class="status info">Holds ${rs(-x.balancePaise)}</span>`}<button class="btn sm" type="button" data-act="roomBill" data-id="${x.id}">Room bill</button>`]) },
    { id: 'nodate', short: 'No check-out date', title: 'In house with no check-out date', list: a.noDate, tone: 'warn', rows: a.noDate.map((x) => [html`<strong>${x.room} · ${x.guestName}</strong>`, html`<button class="btn sm" type="button" data-act="roomBill" data-id="${x.id}">Set the date</button>`]) },
    { id: 'hk', short: 'Not ready', title: 'Rooms not ready', list: a.dirty, tone: 'mute', rows: a.dirty.length ? [[html`<span class="rpc">${a.dirty.map((x) => html`<span class="status ${x.status === 'dirty' ? 'bad' : 'warn'} dia">${x.room} · ${x.status}</span>`)}</span>`, html`<a class="btn sm" href="#/rooms/house">Housekeeping</a>`]] : [] },
  ];
  const open = steps.filter((x) => x.list.length).length;
  return html`${errorBox()}
    <div class="auditbar"><div><strong>${open ? `${plural(open, 'step')} left before the day is closed` : 'Everything is done for today'}</strong>
      <div class="small quiet">Every guest due has arrived or is a no-show, every guest due out has left or is extended, and nothing is unpaid by mistake.</div></div>
      <nav class="ajump" aria-label="Jump to a step">${steps.map((x) => html`<a href="#/rooms/audit" data-act="jump" data-to="au-${x.id}" class="status ${x.list.length ? x.tone : 'ok'}">${x.list.length ? x.list.length : '✓'} ${x.short}</a>`)}</nav></div>
    ${notInDjuboBox(a.notInDjubo)}
    <ol class="achk">${steps.map((x) => html`<li id="au-${x.id}" class="astep ${x.list.length ? '' : 'done'}"><div class="ash"><span class="atick" aria-hidden="true">${x.list.length ? '' : '✓'}</span><h2>${x.title}</h2>
      <span class="status ${x.list.length ? x.tone : 'ok'}">${x.list.length ? x.list.length : 'Done'}</span></div>
      ${x.rows.map(([l, r]) => html`<div class="arow"><span class="grow">${l}</span><span class="dright">${r}</span></div>`)}</li>`)}</ol>
    <section class="panel blockers-n"><div class="bh"><h2>Arriving tomorrow · ${dayName(a.tomorrow)}</h2><span class="status mute">${a.tomorrow_.length}</span></div>
      ${a.tomorrow_.length ? html`<div class="small">${a.tomorrow_.map((x) => `${x.guestName ?? 'No name'}${x.roomLabels ? ` · ${x.roomLabels}` : x.roomType ? ` · ${x.roomType}` : ''}`).join(' · ')}</div>` : html`<p class="empty">No arrivals tomorrow yet.</p>`}</section>`;
}
actions.jump = (d) => { document.getElementById(d.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

// ----- housekeeping (25 Nov 2026): dirty after a check-out or a move; clean; inspected (ready to sell)
const HK = { dirty: ['bad', 'Dirty'], clean: ['warn', 'Clean'], inspected: ['ok', 'Ready'] };
function houseView() {
  const h = ui.hk;
  if (!h) return '';
  const sel = new Set(ui.hkSel ?? []);
  const all = h.sections.flatMap((x) => x.rooms);
  const n = (st) => all.filter((r) => r.status === st).length;
  const f = ui.hkF ?? '';
  const chip = (k, label, count) => html`<button type="button" class="chip sm" aria-pressed="${f === k}" data-act="pick" data-k="hkF" data-id="${k}">${label} <span class="quiet">${count}</span></button>`;
  return html`<div class="kpis">${kpi('Dirty', String(n('dirty')), '', n('dirty') ? 'bad' : '')}${kpi('Clean, not inspected', String(n('clean')), '', n('clean') ? 'warn' : '')}${kpi('Ready to sell', String(n('inspected')))}${kpi('Occupied', String(all.filter((r) => r.guest).length))}</div>
    ${errorBox()}
    <div class="ctool"><div class="cfilt">${chip('', 'All', all.length)}${chip('dirty', 'Dirty', n('dirty'))}${chip('clean', 'Clean', n('clean'))}${chip('inspected', 'Ready', n('inspected'))}</div>
      <span class="small quiet grow">Tap rooms, shift-click to choose a run. Marked dirty at check-out and on a move.</span>
      ${n('dirty') ? html`<button type="button" class="btn sm" data-act="hkAll" data-s="dirty">Choose all dirty</button>` : ''}${n('clean') ? html`<button type="button" class="btn sm" data-act="hkAll" data-s="clean">Choose all clean</button>` : ''}</div>
    ${h.sections.map((sec) => {
      const rooms = sec.rooms.filter((r) => !f || r.status === f);
      return rooms.length ? html`<section class="hkg"><div class="rph"><strong>${sec.name}</strong><span class="small quiet">${sec.rooms.filter((r) => r.status === 'inspected').length} of ${sec.rooms.length} ready</span></div>
        <div class="hkt">${rooms.map((r) => html`<button type="button" class="hkc s-${r.status} ${sel.has(r.room) ? 'on' : ''}" aria-pressed="${sel.has(r.room)}" data-act="hkPick" data-r="${r.room}" title="${r.by ? `${HK[r.status][1]} · ${r.by}` : HK[r.status][1]}">
          <span class="hkn">${r.room}</span><span class="status ${HK[r.status][0]} ${r.status === 'dirty' ? 'dia' : ''}">${HK[r.status][1]}</span><small>${r.guest ?? 'vacant'}</small></button>`)}</div></section>` : '';
    })}
    ${f && !all.some((r) => r.status === f) ? html`<p class="empty">No rooms are ${HK[f][1].toLowerCase()} right now.</p>` : ''}
    <div class="hkbar"><span class="grow">${sel.size ? html`<strong>${plural(sel.size, 'room')} chosen</strong> <button type="button" class="btn ghost sm" data-act="hkClear">Clear</button>` : html`<span class="quiet">Choose rooms to mark them</span>`}</span>
      <button class="btn" type="button" data-act="hkSet" data-s="dirty" ${sel.size ? '' : 'disabled'}>Dirty</button><button class="btn" type="button" data-act="hkSet" data-s="clean" ${sel.size ? '' : 'disabled'}>Clean</button>
      <button class="btn pri" type="button" data-act="hkSet" data-s="inspected" ${sel.size ? '' : 'disabled'}>Inspected · ready</button></div>`;
}
let shiftClick = false;
document.addEventListener('click', (e) => { shiftClick = e.shiftKey; }, true);
actions.hkPick = (d) => {
  const s0 = new Set(ui.hkSel ?? []);
  const order = (ui.hk?.sections ?? []).flatMap((x) => x.rooms).filter((r) => !ui.hkF || r.status === ui.hkF).map((r) => r.room);
  if (shiftClick && ui.hkLast && order.includes(ui.hkLast)) {
    const [i, j] = [order.indexOf(ui.hkLast), order.indexOf(d.r)].sort((x, y) => x - y);
    order.slice(i, j + 1).forEach((r) => s0.add(r));
  } else if (s0.has(d.r)) s0.delete(d.r); else s0.add(d.r);
  ui.hkLast = d.r; ui.hkSel = [...s0]; rerender();
};
actions.hkAll = (d) => { ui.hkSel = [...new Set([...(ui.hkSel ?? []), ...(ui.hk?.sections ?? []).flatMap((x) => x.rooms).filter((r) => r.status === d.s).map((r) => r.room)])]; rerender(); };
actions.hkClear = () => { ui.hkSel = []; rerender(); };
actions.hkSet = async (d) => {
  await api('POST', `${B()}/frontdesk/housekeeping`, { rooms: ui.hkSel ?? [], status: d.s });
  ui.hk = await api('GET', `${B()}/frontdesk/housekeeping`); flash = { kind: 'ok', text: `${plural((ui.hkSel ?? []).length, 'room')} marked ${d.s === 'inspected' ? 'ready' : d.s}.` }; ui.hkSel = []; rerender();
};

// ----- guest register and past stays (25 Nov 2026): who stayed, with ID (type and last 4) and address, for police checks
function registerView() {
  const r = ui.reg;
  if (!r) return '';
  return html`<form class="row" style="align-items:end;margin-bottom:10px;flex-wrap:wrap"><label class="f">From<input class="in" type="date" data-model="regFrom" value="${ui.regFrom}"></label><label class="f">To<input class="in" type="date" data-model="regTo" value="${ui.regTo}"></label>
      <label class="f" style="flex:1 1 220px">Or search name, phone, room or card number<input class="in" type="search" data-model="regQ" value="${ui.regQ ?? ''}"></label>
      <button class="btn" type="submit" data-act="regGo" data-submit>Show</button><button class="btn" type="button" data-act="regCsv">Download (CSV)</button></form>
    ${errorBox()}
    <section class="panel"><div class="scroll"><table class="t cards"><thead><tr><th>Card</th><th>Room</th><th>Guest</th><th>Arrived</th><th>Left</th><th>ID</th><th>From / address</th><th></th></tr></thead><tbody>
      ${r.stays.length ? r.stays.map((x) => html`<tr><td data-label="Card">${x.grcNo ?? '—'}</td><td data-label="Room">${x.room}</td>
        <td data-label="Guest"><strong>${x.guestName}</strong><div class="small quiet">${x.phone ?? ''}${x.nationality ? ` · ${x.nationality}` : ''}${x.adults ? ` · ${x.adults} adult${x.adults === 1 ? '' : 's'}` : ''}</div></td>
        <td data-label="Arrived">${dateTime(x.arrivedAt)}</td><td data-label="Left">${x.leftAt ? dateTime(x.leftAt) : html`<span class="badge open">in house</span>`}</td>
        <td data-label="ID">${x.idDocs.map((d) => html`<div class="small">${d.type} ••${d.last4}${d.name ? ` · ${d.name}` : ''}</div>`)}${x.foreign ? html`<div class="small">Passport ••${x.foreign.passportLast4 ?? ''} · Form C ${x.formCAt || x.foreign.formC ? 'filed' : html`<strong style="color:var(--bad)">not filed</strong>`}</div>` : ''}</td>
        <td data-label="From">${x.comingFrom ?? ''}${x.address ? html`<div class="small quiet">${x.address}</div>` : ''}</td>
        <td class="act"><div class="row"><button class="btn" type="button" data-act="roomBill" data-id="${x.id}">${x.invoiceNo ? `Bill · ${x.invoiceNo}` : 'Room bill'}</button><button class="btn ghost" type="button" data-act="rbGrc" data-id="${x.id}">Card</button></div></td></tr>`)
        : html`<tr><td colspan="8" class="quiet">No stays in these dates.</td></tr>`}
    </tbody></table></div></section>`;
}
actions.regGo = async () => {
  ui.reg = await api('GET', `${B()}/frontdesk/register?${ui.regQ ? `q=${encodeURIComponent(ui.regQ)}` : `from=${ui.regFrom}&to=${ui.regTo}`}`); rerender();
};
actions.regCsv = () => downloadCsv(`guest-register-${ui.regFrom}-to-${ui.regTo}.csv`, [
  ['Card', 'Room', 'Guest', 'Phone', 'Nationality', 'Adults', 'Arrived', 'Left', 'IDs (type, last 4)', 'Passport (last 4)', 'Form C', 'Address', 'Coming from', 'Going to', 'Invoice'],
  ...ui.reg.stays.map((x) => [x.grcNo ?? '', x.room, x.guestName, x.phone ?? '', x.nationality ?? '', x.adults ?? '', dateTime(x.arrivedAt), x.leftAt ? dateTime(x.leftAt) : 'in house',
    x.idDocs.map((d) => `${d.type} ${d.last4}${d.name ? ` (${d.name})` : ''}`).join('; '), x.foreign?.passportLast4 ?? '', x.foreign ? (x.formCAt || x.foreign.formC ? 'filed' : 'not filed') : '',
    x.address ?? '', x.comingFrom ?? '', x.goingTo ?? '', x.invoiceNo ?? '']),
]);
const ID_TYPES = ['Aadhaar', 'Driving licence', 'Passport', 'Voter ID', 'PAN', 'Other'];
/** Check-in (25 Nov 2026 redesign): one screen in four steps, Guest → Room → ID → Payment. The room picker is searchable,
 *  grouped by room type, with what is free and what is dirty; Enter checks in. */
function checkinView() {
  const resArr = (ui.fd?.arrivals ?? []).filter((a) => a.kind === 'reservation');
  const adults = Math.max(1, Math.min(10, Number(ui.ciAdults) || 1));
  const foreign = ui.ciNat && !/^indian?$/i.test(ui.ciNat.trim());
  const picked = ui.bookingId ? ui.arrivals.find((a) => a.id === ui.bookingId) : null;
  const due = picked ? dueOf(picked) : ui.resPicked ? Math.max(0, ui.resPicked.totalPaise - ui.resPicked.advancePaise) : 0;
  const step = (n, title, body, extra = '') => html`<section class="cistep"><div class="cih"><span class="cin">${n}</span><h2>${title}</h2>${extra}</div>${body}</section>`;
  return html`${ui.recv || ui.refund || ui.roomBill || ui.adv ? '' : errorBox()}
    <form class="ciwrap">
      <div class="cicol">
        ${step(1, 'Guest', html`
          ${ui.arrivals?.length || resArr.length ? html`<div class="f">Arriving today<div class="cilist">
            ${ui.arrivals.map((a) => html`<button type="button" class="drow ${ui.bookingId === a.id ? 'on' : ''}" data-act="pickArrival" data-id="${a.id}"><span class="grow"><strong>${a.guestName}</strong><small>${a.roomLabels ? `Djubo ${a.roomLabels}` : a.roomType ?? 'room?'} · till ${dayName(a.checkOut)} · ${a.channel ?? 'Djubo'}${a.checkIn < me.business.shiftDay ? ` · was due ${dayName(a.checkIn)}` : ''}${a.continues ? ` · already in ${a.continues.map((x) => x.room).join(', ')}: extension` : ''}</small></span>
              <span class="dright">${dueOf(a) ? html`<span class="status warn">Collect ${rs(dueOf(a))}</span>` : html`<span class="status ok">Prepaid</span>`}</span></button>`)}
            ${resArr.map((a) => html`<button type="button" class="drow ${ui.resPicked?.id === a.id ? 'on' : ''}" data-act="pickRes" data-id="${a.id}"><span class="grow"><strong>${a.guestName}</strong><small>${a.rooms} · made here, not in Djubo</small></span>
              <span class="dright">${a.duePaise ? html`<span class="status warn">Collect ${rs(a.duePaise)}</span>` : html`<span class="status ok">Paid</span>`}</span></button>`)}</div></div>`
            : html`<p class="small quiet">No bookings due today: check in a walk-in below.</p>`}
          ${(ui.lateArrivals ?? []).length ? html`<div class="f">Not checked in from earlier days <span class="small quiet">· missed at the desk: check in late, or in and out together if the guest has left</span><div class="cilist">
            ${ui.lateArrivals.map((a) => html`<button type="button" class="drow ${ui.bookingId === a.id ? 'on' : ''}" data-act="pickArrival" data-id="${a.id}"><span class="grow"><strong>${a.guestName ?? 'No name'}</strong><small>${a.roomLabels ? `Djubo ${a.roomLabels}` : a.roomType ?? 'room?'} · ${dayName(a.checkIn)} → ${dayName(a.checkOut)} · ${a.channel ?? 'Djubo'}</small></span>
              <span class="dright"><span class="status bad">was due ${dayName(a.checkIn)}</span></span></button>`)}</div></div>` : ''}
          ${picked ? bookingCard(picked) : ''}
          ${picked?.continues ? continueBox(picked) : ''}
          ${ui.resPicked ? html`<div class="msg warn" style="display:block"><strong>${ui.resPicked.guestName}</strong> · reservation made here, not in Djubo yet · total ${rs(ui.resPicked.totalPaise)} · advance ${rs(ui.resPicked.advancePaise)}
            <div class="small">Its rate goes on the room bill now; Djubo's amount replaces it when Djubo's mail arrives.</div></div>` : ''}
          <div class="grid2"><label class="f">Mobile<input class="in" type="tel" inputmode="tel" data-model="gPhone" data-act-change="gLookup" value="${ui.gPhone ?? ''}" placeholder="Finds a returning guest" autocomplete="off" autofocus></label>
            <label class="f">Guest name, as on ID<input class="in" data-model="guest" value="${ui.guest ?? ''}"></label></div>
          ${ui.gFound ? html`<div class="msg ok">Returning guest: <strong>${ui.gFound.name}</strong> · ${plural(ui.gFound.stays.length, 'earlier stay')}${ui.gFound.stays[0] ? ` · last ${dayName(ui.gFound.stays[0].checkIn)} (${ui.gFound.stays[0].room})` : ''}</div>` : ''}
          <div class="grid3"><label class="f">Adults<input class="in" inputmode="numeric" data-model="ciAdults" data-live value="${ui.ciAdults ?? '1'}"></label>
            <label class="f">Children<input class="in" inputmode="numeric" data-model="ciKids" value="${ui.ciKids ?? '0'}"></label>
            <label class="f">Check-out<input class="in" type="date" data-model="ciOut" value="${ui.ciOut ?? addDays(me.business.shiftDay, 1)}"></label></div>`)}
        ${step(3, 'ID', html`<p class="small quiet" style="margin:0">Shown and checked for each adult. Only the last 4 characters are kept.</p>
          ${Array.from({ length: adults }, (_, i) => html`<div class="ciid"><select class="in" data-model="idT_${i}" aria-label="Guest ${i + 1} ID type">${ID_TYPES.map((t) => html`<option ${(ui[`idT_${i}`] ?? (foreign ? 'Passport' : 'Aadhaar')) === t ? 'selected' : ''}>${t}</option>`)}</select>
            <input class="in" data-model="idN_${i}" value="${ui[`idN_${i}`] ?? ''}" autocomplete="off" placeholder="ID number or last 4" aria-label="Guest ${i + 1} ID number">
            <input class="in" data-model="idName_${i}" value="${ui[`idName_${i}`] ?? (i === 0 ? ui.guest ?? '' : '')}" placeholder="Name on ID" aria-label="Guest ${i + 1} name on ID"></div>`)}
          <div class="grid2"><label class="f">Nationality<input class="in" data-model="ciNat" data-live value="${ui.ciNat ?? 'Indian'}"></label><label class="f">Coming from<input class="in" data-model="gCity" value="${ui.gCity ?? ''}"></label>
            <label class="f">Home address<input class="in" data-model="ciAddr" value="${ui.ciAddr ?? ''}"></label><label class="f">Going to next (optional)<input class="in" data-model="ciNext" value="${ui.ciNext ?? ''}"></label></div>
          ${foreign ? html`<div class="msg warn" style="display:block"><strong>Foreign guest: Form C</strong> is due within 24 hours of arrival.
            <div class="grid2" style="margin-top:6px"><label class="f">Passport number<input class="in" data-model="fPass" value="${ui.fPass ?? ''}"></label><label class="f">Visa type<input class="in" data-model="fVisa" value="${ui.fVisa ?? ''}"></label>
              <label class="f">Visa valid till<input class="in" type="date" data-model="fVisaTo" value="${ui.fVisaTo ?? ''}"></label><label class="f">Arrived in India on<input class="in" type="date" data-model="fArr" value="${ui.fArr ?? ''}"></label></div>
            <label class="tickline" style="margin-top:6px"><input type="checkbox" data-model="fFormC" ${ui.fFormC ? 'checked' : ''}> Form C filed</label></div>` : ''}`)}
        ${step(4, 'Payment', html`<div class="row between"><span>${due ? html`To collect at check-in: <strong>${rs(due)}</strong>` : picked || ui.resPicked ? 'Nothing to collect for the room.' : 'Add the rent on the room bill after check-in.'}</span>
            <span class="small quiet">The room bill opens after check-in, to take it with a receipt.</span></div>
          ${ui.ciLate ? html`<div class="msg warn" style="display:block">Late check-in: the stay starts on <strong>${dayName(addDays(me.business.shiftDay, -ui.ciLate))}</strong>, the booking's date, so nights, rent and the register are right.
            ${ui.ciLeft ? html`<label class="tickline" style="margin-top:6px"><input type="checkbox" data-model="ciOutToo" data-act-change="ciOutTog" ${ui.ciOutToo ? 'checked' : ''}> The guest has already left: check in and out together (take what was paid, or move what is owed to Credit, then check out)</label>` : ''}
            ${ui.ciLeft && ui.ciOutToo && ui.room ? html`<div class="small" style="margin-top:4px">Recorded as a past stay in <strong>${[ui.room, ...(ui.ciRooms ?? [])].join(', ')}</strong>: whoever is in ${ui.ciRooms?.length ? 'them' : 'it'} today is not affected, and the room is not marked dirty.</div>` : ''}
          ${ui.ciLate > 2 && !isMgr() ? (ui.approvers?.length ? html`<div class="row" style="margin-top:6px"><span class="small">More than 2 days late: a manager approves.</span><select class="in" data-model="apId" aria-label="Approved by">${ui.approvers.map((x) => html`<option value="${x.id}" ${ui.apId === x.id ? 'selected' : ''}>${x.name}</option>`)}</select>
              <input class="in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-model="apPin" placeholder="Manager's PIN" aria-label="Manager's PIN" style="max-width:160px"></div>`
              : html`<p class="small">More than 2 days late: a manager or owner must do this (no manager has a PIN yet).</p>`) : ''}</div>` : ''}
          <div class="row"><button class="btn pri" type="submit" data-act="openStay" data-submit>Check in and print registration card</button>
            <button class="btn" type="button" data-act="openStay" data-noprint="1">Check in without printing</button>
            ${ui.ciLate ? '' : html`<button class="btn" type="button" data-act="openStay" data-later="1" title="Room not ready yet: check in now and give the room from Rooms › Today">Check in now, room later</button>`}<span class="small quiet">Enter checks in</span></div>`)}
      </div>
      <div class="cicol">${step(2, 'Room', ui.roomSecs.length ? roomPicker() : html`<label class="f">Room or bed<input class="in" data-model="room" value="${ui.room ?? ''}" placeholder="e.g. 101, or Dorm A · Bed 2"></label>`,
        ui.room ? html`<span class="status info" style="margin-left:auto">${[ui.room, ...(ui.ciRooms ?? [])].join(', ')}</span>` : html`<span class="status mute" style="margin-left:auto">choose one</span>`)}</div>
    </form>`;
}
/**
 * Where the guest is going, against Djubo (28 Nov 2026): the rooms picked, in big letters; green when they are Djubo's,
 * amber when not, with why Djubo's room was not used (a guest not out yet, not cleaned).
 */
function djuboBar(who, hk) {
  const picked = ui.room ? [ui.room, ...(ui.ciMulti ? ui.ciRooms ?? [] : [])] : [];
  const dj = ui.ciHits ?? [];
  if (!ui.bookingId || !picked.length) return '';
  const missing = dj.filter((t) => !picked.includes(t));
  const extra = picked.filter((t) => !dj.includes(t));
  const why = (t) => (who(t) ? `${t}: ${who(t).guestName} not out yet` : hk[t] === 'dirty' ? `${t}: not cleaned` : '');
  if (!dj.length) return html`<div class="cibar"><span class="small quiet">Checking in to</span><strong class="cibig">${picked.join(', ')}</strong><span class="small">Djubo gave no room: tell Djubo which room after check-in.</span></div>`;
  if (!missing.length && !extra.length) return html`<div class="cibar same"><span class="small quiet">Checking in to</span><strong class="cibig">${picked.join(', ')}</strong><span class="small">✓ Same as Djubo.</span></div>`;
  const reasons = missing.map(why).filter(Boolean);
  return html`<div class="cibar diff"><span class="small quiet">Checking in to</span><strong class="cibig">${picked.join(', ')}</strong>
    <span><strong>Different from Djubo</strong> (Djubo: ${dj.join(', ')})${missing.length && extra.length ? `: ${extra.join(', ')} instead of ${missing.join(', ')}` : ''}.</span>
    ${reasons.length ? html`<span class="small">${reasons.join(' · ')}</span>` : ''}<span class="small">After check-in, move the guest in Djubo too.</span></div>`;
}
/** The room picker at check-in: search, only free (default), rooms and beds grouped by type with free counts and dirty marks. */
function roomPicker() {
  const who = (t) => cache.stays.find((x) => roomKeyOf(x.room) === roomKeyOf(t));
  const hk = Object.fromEntries((ui.hk?.sections ?? []).flatMap((x) => x.rooms).map((x) => [x.room, x.status]));
  const q = (ui.roomQ ?? '').trim().toLowerCase();
  const all = !!ui.rpAll;
  // A whole category by its name or a short form of it ("dlx" finds Deluxe).
  const loose = (text) => { let k = 0; for (const ch of text.toLowerCase()) if (ch === q[k]) k++; return k === q.length; };
  const groups = ui.roomSecs.map((x) => {
    const units = x.kind === 'dorms' ? (x.dorms ?? []).flatMap((d) => {
      const beds = Array.from({ length: d.beds }, (_, i) => bedName(d, i));
      const whole = `${d.name} · whole`;
      const anyBed = beds.some((b) => who(b));
      return [{ t: whole, label: `${d.name} whole`, taken: who(whole)?.guestName ?? (anyBed ? 'beds in use' : null) },
        ...beds.map((b) => ({ t: b, label: b, taken: who(b)?.guestName ?? (who(whole) ? 'booked whole' : null) }))];
    }) : (x.tables ?? []).map((t) => ({ t, label: t, taken: who(t)?.guestName ?? null }));
    const typeHit = !!q && !/^\d/.test(q) && (x.name.toLowerCase().includes(q) || loose(x.name));
    const shown = units.filter((u) => (all || !u.taken) && (!q || typeHit || u.t.toLowerCase().includes(q)));
    return { x, shown, free: units.filter((u) => !u.taken && !/· whole$/.test(u.t)).length, total: units.filter((u) => !/· whole$/.test(u.t)).length };
  }).filter((g) => g.shown.length);
  return html`<div class="row"><input class="in grow" type="search" data-model="roomQ" data-live value="${ui.roomQ ?? ''}" placeholder="Search room, bed or type   /" aria-label="Search rooms and beds" autocomplete="off">
      <button type="button" class="chip sm" aria-pressed="${!all}" data-act="pick" data-k="rpAll" data-id="${all ? '' : '1'}">Only free</button></div>
    <label class="tickline small"><input type="checkbox" data-act="ciMultiTog" ${ui.ciMulti ? 'checked' : ''}> Several rooms or beds for this guest${ui.ciMulti ? ': tap each one; the first holds the bill' : ''}</label>
    ${djuboBar(who, hk)}
    ${(ui.ciTaken ?? []).length ? html`<div class="msg warn">Djubo has ${ui.ciTaken.join(', ')} for this booking, but ${ui.ciTaken.length === 1 ? 'it is' : 'they are'} taken now. Choose ${ui.ciTaken.length === 1 ? 'another' : 'others'} below, or check the guest there out first.</div>` : ''}
    ${(ui.ciRooms ?? []).length ? html`<div class="msg ok">Checking in to <strong>${[ui.room, ...ui.ciRooms].join(', ')}</strong> · one bill, on ${ui.room}</div>` : ''}
    ${ui.bookingId && ui.room && (ui.ciBooked ?? 1) > 1 + (ui.ciMulti ? (ui.ciRooms ?? []).length : 0) ? html`<div class="msg warn" style="display:block"><strong>Booked for ${ui.ciBooked} rooms or beds, ${1 + (ui.ciMulti ? (ui.ciRooms ?? []).length : 0)} picked.</strong>
      Pick the others where the guests are, or:
      <label class="tickline small" style="margin-top:4px"><input type="checkbox" data-model="ciShare" data-live ${ui.ciShare ? 'checked' : ''}> The others share (no extra beds)</label>
      <div class="small">Not ticked: the check-in goes ahead and Today shows "Beds missing" until they are assigned.</div></div>` : ''}
    <div class="rpick">${groups.length ? groups.map((g) => html`<div class="rpg"><div class="rph"><strong>${g.x.name}</strong><span class="small quiet">${g.free} of ${g.total} free</span></div>
      <div class="rpc">${g.shown.map((u) => html`<button type="button" class="rp ${ui.room === u.t || (ui.ciRooms ?? []).includes(u.t) ? 'on' : ''} ${u.taken ? 'taken' : ''} ${hk[u.t] === 'dirty' ? 'dirty' : ''} ${(ui.ciHits ?? []).includes(u.t) ? 'dj' : ''}" ${u.taken && !(ui.ciLeft && ui.ciOutToo) ? 'disabled' : ''} data-act="pickRoom" data-name="${u.t}"
        title="${u.taken ? `${u.t}: ${u.taken}` : hk[u.t] === 'dirty' ? `${u.t}: dirty` : u.t}" ${u.taken && ui.ciLeft && ui.ciOutToo ? 'data-past="1"' : ''}>${(ui.ciHits ?? []).includes(u.t) ? html`<span class="rptag">Djubo</span>` : ''}${u.label}${hk[u.t] === 'dirty' && !u.taken ? html`<span class="rpd">dirty</span>` : ''}${u.taken ? html`<span class="rpd">${u.taken}</span>` : ''}</button>`)}</div></div>`)
      : html`<p class="empty">No free room or bed matches. Turn off "Only free" to see taken ones.</p>`}</div>`;
}
/** What is still to pay on a booking (Djubo's total less its advance), or 0. */
// Paid before arrival is Djubo's advance less what reception entered (money taken at the desk, collected here with a receipt),
// and less any advance already taken here for the booking (24 Nov 2026).
const prepaidOf = (b) => Math.max(0, (b?.paidPaise ?? 0) - (b?.deskPaidPaise ?? 0));
const dueOf = (b) => (b && b.fromReport && b.amountPaise == null ? Math.max(0, (b.reportDuePaise ?? 0) - (b.heldPaise ?? 0))
  : b && b.amountPaise ? Math.max(0, b.amountPaise - prepaidOf(b) - (b.heldPaise ?? 0)) : 0);
/** '2026-11-23 15:51' (India time, as the booking mail says it) → '23 Nov, 3:51 pm'. */
const stampText = (v) => {
  if (!v) return '';
  const [d, t] = String(v).split(' ');
  if (!t) return dayName(d);
  const [h, m] = t.split(':').map(Number);
  return `${dayName(d)}, ${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
/** The booking card (24 Nov 2026): who, how long, where it was booked, when, the room, and what is still to collect. */
// ---------- each booking's mail history and changes held for a person (26 Nov 2026)
const HIST_STATUS = { applied: ['cur', 'Used'], older: ['', 'Older: not used'], held: ['held', 'Waiting for a check'], kept: ['', 'Kept as it was'] };
function histList(list) {
  if (!list.length) return html`<p class="small quiet">No emails kept for this booking yet.</p>`;
  const first = list.findIndex((x) => x.status === 'applied');
  return html`<div class="hist">${list.map((x, i) => { const [cls, label] = HIST_STATUS[x.status] ?? ['', x.status];
    return html`<div class="hev ${i === first ? 'cur' : ''} ${x.status}"><span class="hdot" aria-hidden="true"></span><div>
      <div class="line" style="gap:8px;flex-wrap:wrap"><strong>${x.cancelled ? 'Cancelled' : x.subject?.match(/revised|modif/i) ? 'Revised' : 'Booking'} · ${x.source === 'mmt' ? 'MakeMyTrip' : 'Djubo'} ${x.extRef}</strong>
        <span class="status ${i === first ? 'ok' : cls === 'held' ? 'warn' : 'mute'}">${i === first ? 'The bill follows this one' : label}</span></div>
      <div class="small quiet">${x.source === 'djubo' ? 'Djubo changed' : 'Email came'} ${dateTime(x.orderAt)}${x.enteredBy ? ` by ${x.enteredBy}` : ''}${x.decidedBy ? ` · ${x.status === 'kept' ? 'kept' : 'applied'} by ${x.decidedBy}` : ''}</div>
      <div class="small">Total ${x.amountPaise === null ? '—' : rs(x.amountPaise)} · Paid ${x.paidPaise === null ? '—' : rs(x.paidPaise)}${x.checkIn ? ` · ${dayName(x.checkIn)} → ${dayName(x.checkOut)}` : ''}${x.roomLabels?.length ? ` · ${x.roomLabels.join(', ')}` : ''}</div>
      ${x.heldReason ? html`<div class="small" style="color:var(--warn)">${x.heldReason}</div>` : ''}</div></div>`; })}</div>`;
}
actions.bkHist = async (d) => {
  if (ui.bkHist?.id === d.id) { ui.bkHist = null; rerender(); return; }
  // On a room bill (27 Nov 2026): the whole stay's bookings, one per night, and the guest's earlier ones not on a bill.
  if (d.stay) { const r = await api('GET', `${B()}/stays/${d.stay}/history`); ui.bkHist = { id: d.id, stay: true, list: r.history, n: r.bookings, off: r.offBill, f: 'all' }; rerender(); return; }
  ui.bkHist = { id: d.id, list: (await api('GET', `${B()}/bookings/${d.id}/history`)).history }; rerender();
};
actions.bkHistF = (d) => { ui.bkHist.f = d.f; rerender(); };
/** A stay's email history: each booking's newest applied email is the one its bill follows; each line says its night. */
function stayHistList(h) {
  const list = h.list.filter((x) => h.f === 'all' || (h.f === 'bill' ? x.onBill : !x.onBill));
  const cur = new Set(); const seen = new Set();
  for (const x of h.list) if (x.onBill && x.status === 'applied' && !seen.has(x.bookingId)) { seen.add(x.bookingId); cur.add(x.mailId + x.bookingId); }
  const nOn = h.list.filter((x) => x.onBill).length;
  return html`${h.n > 1 || h.off ? html`<p class="small" style="margin:4px 0">${plural(h.n, 'booking')}${h.n > 1 ? ', one per night or extension' : ''}${h.off ? ` · ${h.off} before this bill, not on it` : ''}</p>
      <div class="chips" style="margin-bottom:6px"><button type="button" class="chip" aria-pressed="${h.f === 'all'}" data-act="bkHistF" data-f="all">All ${h.list.length} emails</button>
        <button type="button" class="chip" aria-pressed="${h.f === 'bill'}" data-act="bkHistF" data-f="bill">On this bill (${nOn})</button>
        ${h.off ? html`<button type="button" class="chip" aria-pressed="${h.f === 'off'}" data-act="bkHistF" data-f="off">Not on this bill (${h.list.length - nOn})</button>` : ''}</div>` : ''}
    ${list.length ? html`<div class="hist">${list.map((x) => { const [cls, label] = HIST_STATUS[x.status] ?? ['', x.status]; const isCur = cur.has(x.mailId + x.bookingId);
      return html`<div class="hev ${isCur ? 'cur' : ''} ${x.status}"><span class="hdot" aria-hidden="true" style="${x.onBill ? '' : 'border-color:var(--warn)'}"></span><div>
        ${x.checkIn ? html`<div class="tiny" style="font-weight:800;color:var(--pri);letter-spacing:.3px">NIGHT ${dayName(x.checkIn)} → ${dayName(x.checkOut)}</div>` : ''}
        <div class="line" style="gap:8px;flex-wrap:wrap"><strong>${x.cancelled ? 'Cancelled' : x.subject?.match(/revised|modif/i) ? 'Revised' : 'Booking'} · ${x.source === 'mmt' ? 'MakeMyTrip' : 'Djubo'} ${x.extRef}</strong>
          <span class="status ${!x.onBill ? 'warn' : isCur ? 'ok' : cls === 'held' ? 'warn' : 'mute'}">${!x.onBill ? 'Not on this bill' : isCur ? 'The bill follows this one' : label}</span></div>
        <div class="small quiet">${x.source === 'djubo' ? 'Djubo changed' : 'Email came'} ${dateTime(x.orderAt)}${x.enteredBy ? ` by ${x.enteredBy}` : ''}${x.decidedBy ? ` · ${x.status === 'kept' ? 'kept' : 'applied'} by ${x.decidedBy}` : ''}</div>
        <div class="small">Total ${x.amountPaise === null ? '—' : rs(x.amountPaise)} · Paid ${x.paidPaise === null ? '—' : rs(x.paidPaise)}${x.roomLabels?.length ? ` · ${x.roomLabels.join(', ')}` : ''}</div>
        ${x.heldReason ? html`<div class="small" style="color:var(--warn)">${x.heldReason}</div>` : ''}</div></div>`; })}</div>` : html`<p class="small quiet">No emails kept for these bookings yet.</p>`}`;
}
const heldVal = (x, k) => (k === 'status' ? (x.cancelled ? 'Cancelled' : x.status === 'checked_in' ? 'Checked in' : x.status ?? 'Confirmed') : x[k] === null || x[k] === undefined ? '—' : rs(x[k]));
function heldPanel() {
  const list = ui.fd?.held ?? [];
  return html`<div class="dhead"><h2>Booking changes to check</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>
    <p class="small quiet">These changes from Djubo or MakeMyTrip were not applied by themselves: check them in Djubo, then apply or keep. Until then the bill stays as it is.</p>
    ${list.length ? list.map((x) => html`<div class="msg ${x.reason?.startsWith('Cancelled') ? 'bad' : 'warn'}" style="display:block;margin-top:10px">
      <strong>${x.reason}: ${x.room ? `${x.room} · ` : ''}${x.guestName ?? 'No name'}</strong>
      <div class="small">${x.source === 'mmt' ? 'MakeMyTrip' : 'Djubo'} ${x.extRef} · changed ${dateTime(x.at)}${x.mail.enteredBy ? ` by ${x.mail.enteredBy}` : ''}</div>
      <div class="scroll"><table class="t" style="margin-top:6px"><thead><tr><th></th><th class="num">Now</th><th class="num">The new email says</th></tr></thead><tbody>
        ${x.mail.cancelled || x.now.status === 'checked_in' ? html`<tr><td>Status</td><td class="num">${x.now.status === 'checked_in' ? 'Checked in' : 'Confirmed'}</td><td class="num"><strong>${x.mail.cancelled ? 'Cancelled' : 'Confirmed'}</strong></td></tr>` : ''}
        <tr><td>Total</td><td class="num">${heldVal(x.now, 'amountPaise')}</td><td class="num">${x.mail.cancelled ? '—' : heldVal(x.mail, 'amountPaise')}</td></tr>
        <tr><td>Paid</td><td class="num">${heldVal(x.now, 'paidPaise')}</td><td class="num">${heldVal(x.mail, 'paidPaise')}</td></tr>
        <tr><td>Dates</td><td class="num">${x.now.checkIn ? `${dayName(x.now.checkIn)} → ${dayName(x.now.checkOut)}` : '—'}</td><td class="num">${x.mail.checkIn ? `${dayName(x.mail.checkIn)} → ${dayName(x.mail.checkOut)}` : '—'}</td></tr></tbody></table></div>
      ${x.reason?.startsWith('Cancelled') ? html`<div class="small">Often a room change or a rebooking in Djubo: if the guest is staying, keep it, and the new booking's rent comes when it is linked. Apply only if the guest has really left.</div>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn" type="button" data-act="heldKeep" data-b="${x.bookingId}" data-m="${x.mailId}">Keep as it is</button>
        <button class="btn ${x.reason?.startsWith('Cancelled') ? '' : 'pri'}" type="button" data-act="heldApply" data-b="${x.bookingId}" data-m="${x.mailId}">${x.reason?.startsWith('Cancelled') ? 'Apply: the guest left' : 'Apply the change'}</button></div></div>`)
      : html`<p class="empty">Nothing to check.</p>`}`;
}
// A booking's rooms or beds missing in the POS (26 Nov 2026): add them where the guests are, or mark that they share.
function bedsPanel() {
  const x = (ui.fd?.missingBeds ?? []).find((y) => y.stayId === ui.bedsFor);
  if (!x) return html`<div class="dhead"><h2>Assign beds</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="">Close</button></div><p class="empty">Nothing missing now.</p>`;
  const busy = new Set((cache.stays ?? []).map((s) => roomKeyOf(s.room)));
  const secs = (ui.roomSecs ?? []).map((sec) => ({ name: sec.name, beds: (sec.tables ?? []).filter((t) => !/· whole$/.test(t) && !busy.has(roomKeyOf(t))) })).filter((sec) => sec.beds.length);
  const mine = secs.findIndex((sec) => (ui.roomSecs.find((r) => r.name === sec.name)?.tables ?? []).some((t) => roomKeyOf(t) === roomKeyOf(x.room)));
  if (mine > 0) secs.unshift(...secs.splice(mine, 1));
  const picked = ui.bedsPick ?? [];
  const djubo = (x.djuboBeds ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const djuboTaken = djubo.filter((t) => busy.has(roomKeyOf(t)) && roomKeyOf(t) !== roomKeyOf(x.room));
  return html`<div class="dhead"><h2>Assign beds · ${x.guestName}</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>${errorBox()}
    <p class="small">${x.extRef ? `Djubo ${x.extRef} · ` : ''}<strong>booked ${x.booked}</strong> · in the POS: <strong>${x.have}</strong>${x.sharing ? ` (+${x.sharing} sharing)` : ''} · first room <strong>${x.room}</strong></p>
    ${djubo.length ? html`<div class="msg warn" style="display:block">Djubo has <strong>${djubo.join(', ')}</strong> for this booking${djuboTaken.length ? html`, but ${djuboTaken.join(', ')} ${djuboTaken.length === 1 ? 'has' : 'have'} another guest` : ''}. Djubo's beds are only a suggestion: pick where the guests really are.</div>` : ''}
    <h3 style="margin-top:10px">Free beds tonight, same kind first · pick ${x.missing}</h3>
    ${secs.length ? secs.map((sec) => html`<div class="small quiet" style="margin-top:6px">${sec.name}</div><div class="chips">${sec.beds.map((t) => html`<button type="button" class="chip" aria-pressed="${picked.includes(t)}" data-act="bedsToggle" data-id="${t}">${t}</button>`)}</div>`)
      : html`<p class="empty">No free beds tonight.</p>`}
    <div class="row" style="margin-top:12px"><button class="btn pri" type="button" data-act="bedsGo" ${picked.length ? '' : 'disabled'}>${picked.length ? `Add ${picked.join(', ')} to ${x.guestName}'s group` : 'Pick the beds'}</button>
      <button class="btn" type="button" data-act="bedsShare">${x.missing === 1 ? 'Sharing (no extra bed)' : `The other ${x.missing} share (no extra beds)`}</button></div>
    <p class="small quiet">Added beds join the group: food and payments go on ${x.room}'s bill; rent stays as the booking has it.</p>`;
}
actions.bedsPanel = (d) => { ui.roomBill = null; ui.chartSel = null; ui.bedsFor = d.id; ui.bedsPick = []; ui.error = null; ui.drawer = bedsPanel; rerender(); };
actions.bedsToggle = (d) => { const p = ui.bedsPick ?? []; ui.bedsPick = p.includes(d.id) ? p.filter((t) => t !== d.id) : [...p, d.id]; rerender(); };
const bedsDone = async (text) => {
  [ui.fd] = await Promise.all([api('GET', B() + '/frontdesk/today').catch(() => ui.fd), load('stays')]);
  cache.stays = (await api('GET', B() + '/stays')).stays ?? cache.stays;
  flash = { kind: 'ok', text }; ui.bedsPick = [];
  if (!(ui.fd?.missingBeds ?? []).some((y) => y.stayId === ui.bedsFor)) ui.drawer = null;
  rerender();
};
actions.bedsGo = async () => {
  const x = ui.fd.missingBeds.find((y) => y.stayId === ui.bedsFor);
  await api('POST', `${B()}/stays/${ui.bedsFor}/add-beds`, { rooms: ui.bedsPick });
  await bedsDone(`${ui.bedsPick.join(', ')} added to ${x.guestName}'s group.`);
};
actions.bedsShare = async () => {
  const x = ui.fd.missingBeds.find((y) => y.stayId === ui.bedsFor);
  await api('POST', `${B()}/stays/${ui.bedsFor}/sharing`, { beds: x.missing });
  await bedsDone(`Marked as sharing: no extra beds for ${x.guestName}.`);
};
actions.heldPanel = () => { ui.roomBill = null; ui.chartSel = null; ui.drawer = heldPanel; rerender(); };
const heldDo = async (d, what) => {
  await api('POST', `${B()}/bookings/${d.b}/versions/${encodeURIComponent(d.m)}/${what}`, {});
  ui.fd = await api('GET', B() + '/frontdesk/today').catch(() => ui.fd);
  flash = { kind: 'ok', text: what === 'apply' ? 'Change applied.' : 'Kept as it was.' };
  if (!(ui.fd?.held ?? []).length) ui.drawer = null;
  rerender();
};
actions.heldApply = (d) => heldDo(d, 'apply');
actions.heldKeep = (d) => heldDo(d, 'keep');

function bookingCard(a, onBill = false) {
  const nights = a.checkIn && a.checkOut ? Math.max(1, Math.round((Date.parse(a.checkOut) - Date.parse(a.checkIn)) / 86400000)) : null;
  // On the room bill, the bill itself says what is left to collect; the card shows only what the booking says.
  const due = onBill ? 0 : dueOf(a);
  const refs = [a.source === 'djubo' ? `Djubo ${a.extRef}` : `MakeMyTrip ${a.extRef}`, a.source === 'djubo' && a.otaRef ? `OTA ${a.otaRef}` : '', a.pnr ? `PNR ${a.pnr}` : ''].filter(Boolean).join(' · ');
  return html`<div class="msg ${due ? 'warn' : 'ok'}" style="margin-top:8px;display:block">
    <div><strong>${a.guestName ?? 'No name'}</strong>${a.guests ? ` · ${plural(a.guests, 'guest')}` : ''}${nights ? ` · ${plural(nights, 'night')} (${dayName(a.checkIn)} → ${dayName(a.checkOut)})` : ''}</div>
    <div class="small">Booked via ${a.channel ?? (a.source === 'mmt' ? 'MakeMyTrip' : 'Djubo')} · ${refs}${a.enteredBy && a.enteredBy !== 'System' ? ` · by ${a.enteredBy}` : ''}</div>
    ${a.bookedAt ? html`<div class="small">Booked on ${stampText(a.bookedAt)}${a.changedAt ? ` · changed ${stampText(a.changedAt)}` : ''}</div>` : ''}
    <div class="small">Room: ${a.roomType ?? '?'}${a.roomLabels ? ` ${a.roomLabels}` : ''}${a.rooms > 1 ? ` × ${a.rooms}` : ''}${a.mealPlan ? ` · ${a.mealPlan}` : ''}</div>
    ${a.requests ? html`<div class="small">Requests: ${a.requests}</div>` : ''}
    ${a.deskPaidPaise ? html`<div class="small"><strong>Entered in Djubo as taken at reception: ${rs(a.deskPaidPaise)}</strong>${a.heldPaise ? ` · ${rs(a.heldPaise)} already taken here (advance receipt)` : ' · take it here so a receipt prints'}</div>` : ''}
    ${a.fromReport ? html`<div class="small" style="margin-top:4px"><strong>From Djubo's daily report</strong> (made before the POS read Djubo's mails): no phone or total rent in it.${a.amountPaise == null ? html` Djubo says ${a.reportDuePaise ? html`<strong>${rs(a.reportDuePaise)} still to collect</strong>` : 'nothing left to collect'}.` : ''}</div>` : ''}
    ${a.amountPaise ? html`<div style="margin-top:4px">Total ${rs(a.amountPaise)}${prepaidOf(a) ? ` · Paid before arrival ${rs(prepaidOf(a))}` : ''} ${onBill ? '' : html` · ${due ? html`<strong>To collect ${rs(due)}</strong>` : html`<strong>To collect: nothing ✓</strong>`}`}</div>` : ''}
  </div>`;
}
actions.reportRent = async (d) => {
  const r = await api('POST', `${B()}/stays/${d.id}/report-rent`, { total: ui.rptRent ?? '' });
  ui.rptRent = ''; ui.roomBill = r; ui.error = null; flash = { kind: 'ok', text: `Total rent saved: ${rs(r.rentPaise)} on the room bill.` }; rerender();
};
/** One line of the room bill in plain words. */
const MODE_NAME = { cash: 'Cash', upi: 'UPI', card: 'Card' };
// ---------- cancelling a receipt taken by mistake (27 Nov 2026): managers and owners, the same open day, with a reason.
// What has to be done first is said before the form opens.
function rcModal() {
  const x = ui.rcx;
  if (!x) return '';
  const r = x.receipt;
  return html`<div class="scrim" style="position:fixed;inset:0;background:var(--scrim);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px">
    <div class="panel" role="dialog" aria-modal="true" aria-label="Cancel receipt" style="max-width:520px;width:100%;max-height:90vh;overflow:auto">
      <div class="row" style="justify-content:space-between;align-items:center"><h2>Cancel ${r.receiptNo ?? 'receipt'}</h2><button class="btn ghost" type="button" data-act="rcClose">Close</button></div>
      <p style="margin:4px 0">${r.who} · <strong>${rs(r.totalPaise)}</strong> · ${r.modes}<br><span class="small quiet">Taken ${dateTime(r.at)}</span></p>
      ${errorBox()}
      ${x.blockers.length ? html`<div class="msg warn" role="alert" style="display:block"><strong>This receipt can't be cancelled yet</strong>
          <ul style="margin:6px 0 0;padding-left:18px">${x.blockers.map((b) => html`<li>${b}</li>`)}</ul></div>
        <div class="row" style="margin-top:10px"><button class="btn" type="button" data-act="rcClose">Close</button></div>`
      : html`<div class="f" style="margin-top:8px">Why is it cancelled?<div class="chips">${x.reasons.map((w) => html`<button type="button" class="chip" aria-pressed="${ui.rcWhy === w}" data-act="pick" data-k="rcWhy" data-id="${w}">${w}</button>`)}</div></div>
        <label class="f">Note (optional)<input class="in" data-model="rcNote" value="${ui.rcNote ?? ''}" maxlength="200" placeholder="e.g. guest paid by UPI, the cash receipt was printed by mistake"></label>
        <p class="small quiet" style="margin:0">The receipt number stays, marked CANCELLED. ${rs(r.totalPaise)} comes off the guest's bill and off today's money; a slip prints and the Daily check lists it.</p>
        <div class="row" style="margin-top:10px"><button class="btn danger" type="button" data-act="rcGo" ${ui.rcWhy ? '' : 'disabled'}>Cancel the receipt</button><button class="btn" type="button" data-act="rcClose">Keep it</button></div>`}
    </div></div>`;
}
actions.rcAsk = async (d) => { ui.error = null; ui.rcWhy = null; ui.rcNote = ''; ui.rcx = await api('GET', `${B()}/receipts/${d.id}/cancel`); rerender(); };
actions.rcClose = () => { ui.rcx = null; ui.error = null; rerender(); };
actions.rcGo = async () => {
  const r = await api('POST', `${B()}/receipts/${ui.rcx.receipt.id}/cancel`, { reason: ui.rcWhy, note: ui.rcNote ?? '' });
  const x = r.slip;
  printJobs([{ kind: 'bill', html: asHtml(html`<div class="receipt"><div class="hd">${me.business.name}</div><div class="hd" style="border:2px solid #000;margin:6px 0">RECEIPT CANCELLED</div>
    <div class="rl"><span>${x.receiptNo ?? ''}</span><span>${rs(x.totalPaise)}</span></div><div>${x.who}</div><div>${x.modes}</div>
    <div>Taken: ${dateTime(x.takenAt)}</div><div>Cancelled: ${dateTime(x.cancelledAt)}</div><div>By: ${x.by}</div><div>Why: ${x.reason}</div>${x.note ? html`<div>Note: ${x.note}</div>` : ''}</div>`) }]);
  ui.rcx = null;
  flash = { kind: 'ok', text: `${x.receiptNo ?? 'Receipt'} cancelled: ${rs(x.totalPaise)} is off the bill and off today's money.` };
  route();
};
/** A receipt's number, struck through and marked when it was cancelled; a Cancel button for managers otherwise. */
const rcTag = (cancelled) => (cancelled ? html` <span class="status bad">CANCELLED</span>` : '');
const rcBtn = (sid, cancelled) => (sid && !cancelled && can('receipts.cancel') ? html` <button class="btn sm ghost" type="button" data-act="rcAsk" data-id="${sid}">Cancel</button>` : '');
function folioLabel(l) {
  const no = l.receiptNo ? ` ${l.receiptNo}` : '';
  const how = l.mode ? ` · ${MODE_NAME[l.mode] ?? l.mode}` : '';
  return ({
    room_rent: l.bookingRef ? `Room rent (Djubo ${l.bookingRef})` : l.note ?? 'Room charge',
    prepaid: l.note ?? 'Paid before arrival',
    charge: `Food bill ${l.billNo ?? ''}`,
    receipt: `Payment${no}${how}`, advance: `Advance${no}${how}`, deposit: `Deposit${no}${how}`,
    refund: 'Refunded', advance_used: `Advance used on bill ${l.billNo ?? ''}`, credit_note: `Credit note on bill ${l.billNo ?? ''}`,
  })[l.kind] ?? l.kind;
}
/** The room's bill (24 Nov 2026): rent, charges, food, payments, what is still to collect, and check-out with the invoice. */
// ---------- money reception marked in Djubo (26 Nov 2026): counted on the day it was marked; pick how it was paid.
const djDone = {};   // mailId -> its receipt, picked in this session (for Print)
function djRow(x) {
  const k = x.mailId;
  const done = djDone[k];
  const accs = (cache.payAccounts ?? []).filter((a) => a.active);
  return html`<div class="djrow"><div class="line" style="gap:8px;align-items:baseline"><span class="grow"><strong>${x.guestName ?? 'No name'}</strong> · Djubo ${x.extRef}${x.checkIn ? ` · stay ${dayName(x.checkIn)} → ${dayName(x.checkOut)}` : ''}
      <span class="small quiet" style="display:block">Marked by ${x.by ?? '?'}, ${dateTime(x.at)}</span></span><strong class="num">${rs(x.amountPaise)}</strong></div>
    ${x.settlementId || done ? html`<div class="line" style="gap:8px"><span class="status ok">${MODE_NAME[done?.payments[0].mode ?? x.mode] ?? x.mode} · ${done?.receiptNo ?? x.receiptNo}</span>
        ${done ? html`<button class="btn sm ghost" type="button" data-act="djPrint" data-m="${k}">Print receipt</button>` : ''}</div>`
      : html`<div class="chips" role="group" aria-label="How ${x.guestName ?? 'the guest'} paid">${['cash', 'upi', 'card'].map((m) => html`<button type="button" class="chip" aria-pressed="${ui.djUpi === k && m === 'upi'}" data-act="djMode" data-b="${x.bookingId}" data-m="${k}" data-mode="${m}">${MODE_NAME[m]}</button>`)}
          <button type="button" class="chip" data-act="djLinkOpen" data-b="${x.bookingId}" data-m="${k}">Already taken in the POS</button>
          <span class="status warn">Pick how it was paid</span></div>
        ${ui.djLink?.mailId === k ? html`<div style="margin-top:4px">${ui.djLink.list.length ? html`<div class="small quiet">The same money, already taken here: pick its receipt (no new receipt is made)</div>
            <div class="chips">${ui.djLink.list.map((r) => html`<button type="button" class="chip" data-act="djLinkGo" data-b="${x.bookingId}" data-m="${k}" data-id="${r.settlementId}">${r.receiptNo} · ${MODE_NAME[r.mode] ?? r.mode} · ${rs(r.amountPaise)} · ${dateTime(r.at)}</button>`)}</div>`
          : html`<div class="small" style="color:var(--warn)">No receipt for this guest in the last 14 days that isn't linked already. Pick Cash, UPI or Card instead.</div>`}</div>` : ''}
        ${ui.djUpi === k ? html`<div class="chips" style="margin-top:4px"><span class="small quiet">QR paid into</span>${accs.map((a) => html`<button type="button" class="chip" data-act="djUpiAcc" data-b="${x.bookingId}" data-m="${k}" data-id="${a.id}">${a.name}</button>`)}</div>` : ''}`}</div>`;
}
async function djSave(bookingId, mailId, mode, payAccountId) {
  const r = await api('POST', `${B()}/bookings/${bookingId}/djubo-paid`, { mailId, mode, payAccountId });
  djDone[mailId] = r.receipt; ui.djUpi = null;
  flash = { kind: 'ok', text: `${r.receipt.receiptNo}: ${rs(r.receipt.totalPaise)} from ${r.receipt.name}, ${MODE_NAME[mode]}, counted on ${dayName(r.shiftDay)}.` };
  if (location.hash.startsWith('#/rooms')) {
    const [fd, bill] = await Promise.all([api('GET', B() + '/frontdesk/today').catch(() => ui.fd), ui.roomBill ? api('GET', `${B()}/stays/${ui.roomBill.stay.id}/bill`) : null]);
    ui.fd = fd; if (bill) ui.roomBill = bill;
    rerender();
  } else route();
}
actions.djMode = async (d) => {
  if (d.mode === 'upi') {
    const accs = (cache.payAccounts ?? []).filter((a) => a.active);
    if (accs.length !== 1) { ui.djUpi = d.m; rerender(); return; }
    return djSave(d.b, d.m, 'upi', accs[0].id);
  }
  return djSave(d.b, d.m, d.mode);
};
actions.djUpiAcc = (d) => djSave(d.b, d.m, 'upi', d.id);
actions.djLinkOpen = async (d) => {
  if (ui.djLink?.mailId === d.m) { ui.djLink = null; rerender(); return; }
  const r = await api('GET', `${B()}/bookings/${d.b}/djubo-receipts?mailId=${encodeURIComponent(d.m)}`);
  ui.djLink = { mailId: d.m, list: r.receipts }; rerender();
};
actions.djLinkGo = async (d) => {
  const r = await api('POST', `${B()}/bookings/${d.b}/djubo-link`, { mailId: d.m, settlementId: d.id });
  ui.djLink = null;
  flash = { kind: 'ok', text: `Linked to ${r.receiptNo}: counted once, no new receipt.` };
  if (location.hash.startsWith('#/rooms')) {
    const [fd, bill] = await Promise.all([api('GET', B() + '/frontdesk/today').catch(() => ui.fd), ui.roomBill ? api('GET', `${B()}/stays/${ui.roomBill.stay.id}/bill`) : null]);
    ui.fd = fd; if (bill) ui.roomBill = bill;
    rerender();
  } else route();
};
actions.djPrint = (d) => { if (djDone[d.m]) printJobs([{ kind: 'bill', html: asHtml(receiptSlip(djDone[d.m])) }]); };
actions.djPanel = () => {
  ui.roomBill = null; ui.chartSel = null;
  ui.drawer = () => { const f = ui.fd?.djubo ?? { open: [], lowered: [] }; return html`<div class="dhead"><h2>Taken in Djubo by reception</h2><button class="btn ghost" type="button" data-act="pick" data-k="drawer" data-id="" title="Close (Esc)">Close</button></div>
    <p class="small quiet">Money reception marked in Djubo, counted on the day it was marked. Pick how each was paid: that makes its receipt. A day can't close until each of its payments has one.</p>
    ${f.lowered.length ? html`<div class="msg warn" style="display:block">${f.lowered.map((x) => html`<div><strong>Djubo lowered ${x.guestName ?? x.extRef} by ${rs(x.paise)}</strong> after its receipt: refund it, or correct it in Djubo.</div>`)}</div>` : ''}
    ${f.open.length ? f.open.map(djRow) : html`<p class="empty">Nothing waiting.</p>`}`; };
  rerender();
};

function roomBillPanel(r) {
  // Money reception marked in Djubo for this stay, waiting for its mode (26 Nov 2026): already taken, so not to collect.
  const djWait = r.djubo ?? [];
  const djSum = djWait.reduce((t, x) => t + x.amountPaise, 0);
  if (djSum) r = { ...r, balancePaise: r.balancePaise - djSum };
  const st = r.stay;
  const grp = (st.group ?? []).filter((g) => !g.checkedOutAt);
  const name = `Room ${[st.room, ...grp.map((g) => g.room)].join(', ')} · ${st.guestName}`;
  const f = ui.rbForm;   // which form is open on the bill: charge, lower, transfer, move, extend, checkout, cn
  const out = !!st.checkedOutAt;
  const inv = r.invoice;
  const stays = (cache.stays ?? []).filter((x) => x.id !== st.id);
  const form = () => {
    if (f === 'charge' || f === 'lower') return html`<form class="grid2" style="margin-top:10px"><label class="f">${f === 'lower' ? 'Take off (₹)' : 'Amount (₹, GST included)'}<input class="in" inputmode="decimal" data-model="rbAmt" value="${ui.rbAmt ?? ''}" autofocus></label>
      <label class="f">${f === 'lower' ? 'Why' : 'What for'}<input class="in" data-model="rbNote" value="${ui.rbNote ?? ''}" placeholder="${f === 'lower' ? 'e.g. Discount at the desk' : 'e.g. Room rent, Extra bed, Late check-out'}"></label>
      <div class="row" style="grid-column:1/-1"><button class="btn pri" type="submit" data-act="rbChargeGo" data-submit>${f === 'lower' ? 'Take off' : 'Add to the room bill'}</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div></form>`;
    if (f === 'transfer') return html`<form class="panel" style="margin-top:10px"><h3>Move ${rs(r.balancePaise)} off this room's bill</h3>
      <div class="chips"><button type="button" class="chip" aria-pressed="${ui.tfTo !== 'room'}" data-act="pick" data-k="tfTo" data-id="credit">To a company or credit account</button>
        <button type="button" class="chip" aria-pressed="${ui.tfTo === 'room'}" data-act="pick" data-k="tfTo" data-id="room">To another room (one pays for the group)</button></div>
      ${ui.tfTo === 'room' ? html`<label class="f">Room that pays<select class="in" data-model="tfStay"><option value="">Choose</option>${stays.map((x) => html`<option value="${x.id}" ${ui.tfStay === x.id ? 'selected' : ''}>${x.room} · ${x.guestName}</option>`)}</select></label>`
        : html`<div class="chips">${(cache.credit ?? []).map((a) => html`<button type="button" class="chip" aria-pressed="${ui.tfAcc === a.id}" data-act="pick" data-k="tfAcc" data-id="${a.id}">${a.name}</button>`)}
            <button type="button" class="chip" aria-pressed="${ui.tfAcc === 'new'}" data-act="pick" data-k="tfAcc" data-id="new">New account</button></div>
          ${ui.tfAcc === 'new' ? html`<div class="grid2"><label class="f">Company or person<input class="in" data-model="tfName" value="${ui.tfName ?? st.company ?? ''}"></label><label class="f">Phone<input class="in" inputmode="tel" data-model="tfPhone" value="${ui.tfPhone ?? ''}"></label></div>` : ''}`}
      <label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="tfAmt" value="${ui.tfAmt ?? rupees(r.balancePaise)}"></label>
      <div class="row"><button class="btn pri" type="submit" data-act="rbTransfer" data-submit>Move it</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div></form>`;
    // Move room (27 Nov 2026): one box, the form and what moves under it, filled in as soon as a room or guest is picked.
    if (f === 'move') {
      const swap = !!ui.mvSwap;
      return html`<form class="panel" style="margin-top:10px"><h3>${swap ? 'Swap rooms with another guest' : 'Move the guest to another room'}</h3>
      <div class="chips"><button type="button" class="chip" aria-pressed="${!swap}" data-act="mvKind" data-id="">To a free room</button><button type="button" class="chip" aria-pressed="${swap}" data-act="mvKind" data-id="1">Swap with another guest</button></div>
      <div class="grid2">${swap
        ? html`<label class="f">Swap with<select class="in" data-model="swWith" data-act-change="mvLoad"><option value="">Choose</option>${(cache.stays ?? []).filter((y) => y.id !== st.id && !/\(past stay\)$/.test(y.room)).map((y) => html`<option value="${y.id}" ${ui.swWith === y.id ? 'selected' : ''}>${y.room} · ${y.guestName}</option>`)}</select></label>`
        : html`<label class="f">New room or bed<select class="in" data-model="mvRoom" data-act-change="mvLoad"><option value="">Choose</option>${ui.roomSecs.flatMap((x) => x.tables ?? []).filter((t) => t !== st.room && !/· whole$/.test(t) && !(cache.stays ?? []).some((y) => y.room === t)).map((t) => html`<option ${ui.mvRoom === t ? 'selected' : ''}>${t}</option>`)}</select></label>`}
        <label class="f">Why (optional)<input class="in" data-model="mvWhy" value="${ui.mvWhy ?? ''}" placeholder="${swap ? 'e.g. guests asked to exchange' : 'e.g. AC not working, upgrade'}"></label></div>
      ${mvBox(st)}
      <div class="row"><button class="btn pri" type="submit" data-act="${swap ? 'rbSwap' : 'rbMove'}" data-submit>${mvButton(st)}</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div></form>`;
    }
    // The guest left the room but the bill is still open (27 Nov 2026): free the room, and choose what happens to open food.
    if (f === 'left') {
      const lr = ui.lr;
      if (!lr) return html`<p class="quiet" style="margin-top:10px">Loading…</p>`;
      const live = lr.orders.filter((o) => o.status === 'open' || o.status === 'tab');
      return html`<div class="panel" style="margin-top:10px"><h3>${lr.stay.guestName} has left ${lr.rooms.join(', ')}</h3>
        <p class="small quiet" style="margin:0">${lr.rooms.join(', ')} ${lr.rooms.length > 1 ? 'are' : 'is'} freed and marked dirty, so the next guest can be checked in. The bill stays open, and the guest stays in In house tagged "Left room" until checked out.</p>
        ${lr.orders.length ? html`<div class="small"><strong>Food still open:</strong> ${lr.orders.map((o) => `${o.place} ${rs(o.totalPaise)}${o.status === 'billed' ? ' (printed, not paid)' : ''}${o.unsent ? ` · ${o.unsent} not sent to the kitchen` : ''}`).join(' · ')}</div>
          <div class="row"><button class="btn pri" type="button" data-act="lrBill">Bill it to the room now</button></div>
          <p class="small quiet" style="margin:0">Prints each bill and puts it on the room bill.${lr.orders.some((o) => o.unsent) ? ' Send the KOT (or remove) the items not sent first.' : ''}</p>
          ${live.length <= 1 ? html`<div class="small">Or move it to the table they are sitting at:</div>
            <div class="chips">${lr.freeTables.slice(0, 24).map((t) => html`<button type="button" class="chip" data-act="lrGo" data-move="table" data-t="${t}">${t}</button>`)}</div>` : ''}
          <div class="row"><button class="btn" type="button" data-act="lrGo" data-move="wait">Not at a table yet: keep it waiting</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div>`
        : html`<div class="row"><button class="btn pri" type="button" data-act="lrGo" data-move="">Free the room</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div>`}</div>`;
    }
    // Extensions are made in Djubo (26 Nov 2026): the date and rent follow its mail. A manager can extend here when Djubo is down.
    if (f === 'djuboExt') return html`<div class="msg ok" style="display:block;margin-top:10px"><strong>Extend this booking in Djubo</strong>
      <div class="small">Change the check-out in Djubo${r.booking ? ` (Djubo ${r.booking.extRef})` : ''}. The POS updates the date and the rent by itself when Djubo's email comes, usually in a few minutes; a new booking from Djubo for the extra nights shows under Arrivals as "extension": press Continue on it.</div>
      ${isMgr() ? html`<div class="row" style="margin-top:8px"><button class="btn sm ghost" type="button" data-act="rbForm" data-f="extend">Djubo is down: extend without Djubo (manager)</button></div>` : ''}</div>`;
    if (f === 'extend') return html`<form class="panel" style="margin-top:10px"><h3>Extend without Djubo (manager)</h3>
      <div class="grid3"><label class="f">New check-out<input class="in" type="date" data-model="exTo" value="${ui.exTo ?? addDays(st.checkOutPlan ?? me.business.shiftDay, 1)}"></label>
        <label class="f">Rent per extra night (₹, GST incl.)<input class="in" inputmode="decimal" data-model="exRate" value="${ui.exRate ?? ''}"></label>
        <label class="f">Why not in Djubo<input class="in" data-model="exWhy" value="${ui.exWhy ?? ''}" placeholder="e.g. Djubo down"></label></div>
      <p class="small quiet">Marked "by hand (manager)". When Djubo's booking for these nights comes and is continued, this rent gives way to Djubo's. Put it in Djubo as soon as it is back, so OTAs don't sell the room.</p>
      <div class="row"><button class="btn pri" type="submit" data-act="rbExtend" data-submit>Extend</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div></form>`;
    if (f === 'checkout') return html`<form class="panel" style="margin-top:10px"><h3>${r.rentPaise > 0 ? 'Check out and print the room invoice' : r.booking?.fromReport && r.booking.amountPaise == null ? 'Check out (no POS invoice: total rent not known, stay began before the POS)' : 'Check out (no room rent on this bill: no invoice)'}</h3>
      <label class="f" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" data-model="coCo" data-live ${ui.coCo ?? !!st.company ? 'checked' : ''}> Invoice in a company's name (GST claim)</label>
      ${ui.coCo ?? !!st.company ? html`<div class="grid3"><label class="f">Company<input class="in" data-model="coName" value="${ui.coName ?? st.company ?? ''}"></label>
        <label class="f">GSTIN<input class="in" data-model="coGstin" maxlength="15" value="${ui.coGstin ?? st.gstin ?? ''}"></label><label class="f">Address<input class="in" data-model="coAddr" value="${ui.coAddr ?? ''}"></label></div>` : ''}
      ${r.rentPaise <= 0 && !(r.booking?.fromReport && r.booking.amountPaise == null) && !isMgr() ? html`<div class="msg warn" style="display:block">No room rent on this bill. Add it (Add charge, "Room rent"), or a manager approves checking out without it.
        ${ui.approvers?.length ? html`<div class="row" style="margin-top:6px"><select class="in" data-model="apId" aria-label="Approved by">${ui.approvers.map((x) => html`<option value="${x.id}" ${ui.apId === x.id ? 'selected' : ''}>${x.name}</option>`)}</select>
          <input class="in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-model="apPin" placeholder="Manager's PIN" aria-label="Manager's PIN" style="max-width:160px"></div>` : html`<div class="small">No manager has a PIN yet.</div>`}</div>` : ''}
      <div class="row"><button class="btn pri" type="submit" data-act="checkOut" data-id="${st.id}" data-submit>Check out${r.rentPaise > 0 ? ' and print invoice' : ''}</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div></form>`;
    if (f === 'cn') return html`<form class="panel" style="margin-top:10px"><h3>Room credit note on ${inv.invoiceNo}</h3>
      <div class="grid2"><label class="f">Amount given back (₹, GST included)<input class="in" inputmode="decimal" data-model="cnAmt" value="${ui.cnAmt ?? ''}"></label><label class="f">Reason<input class="in" data-model="cnWhy" value="${ui.cnWhy ?? ''}"></label></div>
      <div class="chips">${[['none', 'No money back (lowers the invoice)'], ['cash', 'Cash from the drawer'], ['upi', 'UPI']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.cnMode ?? 'none') === k}" data-act="pick" data-k="cnMode" data-id="${k}">${t}</button>`)}</div>
      <div class="row"><button class="btn pri" type="submit" data-act="rbCn" data-submit>Make credit note</button><button class="btn" type="button" data-act="rbFormNo">Cancel</button></div></form>`;
    return '';
  };
  return html`<section class="panel" style="margin-bottom:16px;max-width:820px;border-color:var(--pri-line)">
    <div class="line"><h2 class="grow" style="margin:0">${name}${out ? html` <span class="badge bad">checked out ${dateTime(st.checkedOutAt)}</span>` : ''}</h2><button class="btn ghost" type="button" data-act="rbClose">Close</button></div>${ui.recv || ui.refund || ui.adv ? '' : errorBox()}
    ${!out && grp.length ? html`<div class="msg ok" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="flex:1 1 100%">One bill for ${st.room} and ${grp.map((g) => g.room).join(', ')}: food and payments of all of them come here. Checking out ${st.room} checks out all.</span>
      ${grp.map((g) => html`<button class="btn sm" type="button" data-act="bedOut" data-id="${g.id}" data-r="${g.room}">${g.room} leaves early</button>`)}</div>` : ''}
    ${!out && st.foreign && !st.formCAt ? html`<div class="msg warn" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="grow">Foreign guest: Form C is due within 24 hours of arrival.</span><button class="btn" type="button" data-act="formC" data-id="${st.id}">Form C filed</button></div>` : ''}
    ${r.booking?.fromReport && r.booking.amountPaise == null && !st.checkedOutAt ? html`<form class="msg warn" style="display:block;margin-top:8px"><strong>Total rent not known: check-out goes without a POS invoice</strong>
      <div class="small">This stay began before the POS: its booking came from Djubo's daily report, which has only what is still to collect (${rs(r.booking.reportDuePaise ?? 0)}), and that must be paid first. Djubo or the OTA has its invoice. To print a POS invoice instead, type the total rent from Djubo (optional).</div>
      <div class="row" style="margin-top:6px"><input class="in" inputmode="decimal" data-model="rptRent" value="${ui.rptRent ?? ''}" placeholder="Total rent in Djubo (₹)" style="max-width:220px">
        <button class="btn pri" type="submit" data-act="reportRent" data-id="${st.id}" data-submit>Save total</button></div></form>` : ''}
    ${r.booking ? html`${bookingCard(r.booking, true)}<div class="row" style="margin:4px 0 8px"><button class="btn sm ghost" type="button" data-act="bkHist" data-id="${r.booking.id}" data-stay="${st.id}">${ui.bkHist?.id === r.booking.id ? 'Hide email history' : 'Email history'}</button></div>
      ${ui.bkHist?.id === r.booking.id ? (ui.bkHist.stay ? stayHistList(ui.bkHist) : histList(ui.bkHist.list)) : ''}` : html`<p class="small quiet">${st.checkOutPlan ? `Staying till ${dayName(st.checkOutPlan)}. ` : ''}No booking from Djubo on this room: add the room rent by hand (Add charge, "Room rent").</p>`}
    <table class="t" style="margin-top:10px"><tbody>
      ${r.lines.map((l) => { const rcpt = ['receipt', 'advance', 'deposit'].includes(l.kind) && l.settlementId; const undo = rcpt && l.amountPaise > 0;
        return html`<tr><td>${undo ? html`<span class="quiet">${l.note ?? 'Receipt cancelled'}</span>` : html`<span style="${rcpt && l.cancelled ? 'text-decoration:line-through' : ''}">${l.billNo && ['charge', 'advance_used', 'credit_note'].includes(l.kind) ? html`<a href="#/billno/${l.billNo}">${folioLabel(l)}</a>` : folioLabel(l)}</span>${rcpt ? rcTag(l.cancelled) : ''}${rcpt && l.amountPaise < 0 ? rcBtn(l.settlementId, l.cancelled) : ''}`}<div class="small quiet">${dateTime(l.at)}</div></td><td class="num">${rs(l.amountPaise)}</td></tr>`; })}
      ${djWait.map((x) => html`<tr><td>Paid at reception, in Djubo<div class="small quiet">${dateTime(x.at)} · ${x.by ?? ''} · pick how it was paid, below</div></td><td class="num">${rs(-x.amountPaise)}</td></tr>`)}
      <tr><td><strong>${r.balancePaise > 0 ? 'To collect' : r.balancePaise < 0 ? 'Held for the guest (deposit or advance)' : 'Nothing to collect'}</strong></td><td class="num"><strong>${rs(Math.abs(r.balancePaise))}</strong></td></tr>
    </tbody></table>
    ${inv ? html`<div class="msg ok" style="margin-top:8px;display:block">Invoice <strong>${inv.invoiceNo}</strong> · ${rs(inv.totalPaise)}${inv.billToName ? ` · to ${inv.billToName}${inv.billToGstin ? ` (${inv.billToGstin})` : ''}` : ''}
      ${(inv.creditNotes ?? []).map((n) => html`<div class="small">Credit note ${n.cnNo} · ${n.reason} · ${rs(-n.totalPaise)}</div>`)}
      <div class="row" style="margin-top:6px"><button class="btn" type="button" data-act="rbReprint">Reprint invoice</button><button class="btn" type="button" data-act="rbGrc" data-id="${st.id}">Reprint registration card</button>
        ${can('bills.refund') ? html`<button class="btn ghost" type="button" data-act="rbForm" data-f="cn">Credit note</button>` : ''}</div></div>` : ''}
    ${f ? form() : out ? '' : html`
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      ${r.balancePaise > 0 ? html`<button class="btn pri" type="button" data-act="recv" data-id="${st.accountId}" data-n="${name}" data-room="1" data-amount="${rupees(r.balancePaise)}">Take payment ${rs(r.balancePaise)}</button>` : ''}
      <button class="btn" type="button" data-act="recv" data-id="${st.accountId}" data-n="${name}" data-room="1" data-kind="deposit">Take deposit</button>
      <button class="btn" type="button" data-act="rbForm" data-f="charge">Add charge</button>
      ${r.rentPaise > 0 ? html`<button class="btn ghost" type="button" data-act="rbForm" data-f="lower">Take rent off</button>` : ''}
      ${r.balancePaise > 0 ? html`<button class="btn" type="button" data-act="rbForm" data-f="transfer">Bill to company / another room</button>` : ''}
      <button class="btn" type="button" data-act="rbForm" data-f="move">Move room</button>
      ${String(st.room).endsWith(' (left room)') ? '' : html`<button class="btn" type="button" data-act="lrOpen">Left the room, bill still open</button>`}
      <button class="btn" type="button" data-act="rbForm" data-f="${f === 'djuboExt' ? '' : 'djuboExt'}">Extend in Djubo</button>
      <button class="btn ghost" type="button" data-act="rbGrc" data-id="${st.id}">Registration card</button>
      ${r.balancePaise < 0 ? html`<button class="btn" type="button" data-act="refundAsk" data-id="${st.accountId}" data-n="${name}" data-max="${-r.balancePaise}">Refund ${rs(-r.balancePaise)}</button>` : ''}
      ${djWait.length ? html`<div class="msg warn" style="display:block;width:100%"><strong>Paid at reception, in Djubo: pick how</strong>${djWait.map(djRow)}<div class="small">Check-out waits for this.</div></div>` : ''}
      ${(r.djuboCovered ?? []).length && !out ? (() => {
        // Djubo money covered by POS receipts on this bill (28 Nov 2026): nothing to pick; what is left is the bill's balance.
        const due = r.lines.filter((l) => l.amountPaise > 0).reduce((t, l) => t + l.amountPaise, 0);
        return html`<div class="msg ok" style="display:block;width:100%">${r.djuboCovered.map((x) => html`<div><strong>Djubo ${rs(x.deskPaidPaise)} (${x.extRef}) · covered by ${x.coveredBy.join(', ')}</strong></div>`)}
          <div class="small">Total due ${rs(due)} · received ${rs(due - Math.max(0, r.balancePaise))} · <strong>balance to take ${rs(Math.max(0, r.balancePaise))}</strong></div></div>`;
      })() : ''}
      ${r.balancePaise === 0 && !djWait.length ? (() => {
        // One click (25 Nov 2026): the form opens only for a company invoice, or when a manager must approve (no room rent).
        const rentUnknown = !!(r.booking?.fromReport && r.booking.amountPaise == null);
        return r.rentPaise <= 0 && !rentUnknown && !isMgr()
          ? html`<button class="btn pri" type="button" data-act="rbForm" data-f="checkout">Check out</button>`
          : html`<button class="btn pri" type="button" data-act="checkOut" data-id="${st.id}">Check out${r.rentPaise > 0 ? ' and print invoice' : ''}</button>
            ${r.rentPaise > 0 ? html`<button class="btn ghost" type="button" data-act="rbForm" data-f="checkout">Company invoice (GST)…</button>` : ''}`;
      })() : ''}
    </div>`}
    <p class="small quiet" style="margin-top:8px">Room rent comes from Djubo's booking (GST included). Food bills are invoiced on their own; the room invoice prints at check-out.</p>
  </section>`;
}
actions.roomBill = async (d) => { ui.roomBill = await api('GET', `${B()}/stays/${d.id}/bill`); ui.recv = ui.refund = ui.rbForm = null; ui.error = null; if (!cache.credit) await load('credit'); rerender(); scrollTo(0, 0); };
actions.rbClose = () => { ui.roomBill = null; ui.rbForm = null; rerender(); };
/** Give a room to a guest checked in with "room later": their bill with Move room open. */
actions.giveRoom = async (d) => { await actions.roomBill(d); await actions.rbForm({ f: 'move' }); rerender(); };
actions.rbForm = async (d) => {
  ui.rbForm = d.f; ui.rbAmt = ui.rbNote = undefined; ui.mvSwap = null; ui.mvCheck = null; ui.mvAtt = null; ui.mvRoom = ui.swWith = undefined; ui.error = null;
  if (d.f === 'transfer') await load('credit');
  // No room rent on the bill: a manager approves the check-out (25 Nov 2026).
  if (d.f === 'checkout' && !isMgr() && (ui.roomBill?.rentPaise ?? 0) <= 0 && !ui.approvers) { ui.approvers = (await api('GET', `${B()}/approvers`).catch(() => ({ approvers: [] }))).approvers; ui.apId = ui.approvers[0]?.id; ui.apPin = ''; }
  rerender();
};
actions.rbFormNo = () => { ui.rbForm = null; rerender(); };
actions.lrOpen = async () => { ui.rbForm = 'left'; ui.lr = null; ui.error = null; rerender(); ui.lr = await api('GET', `${B()}/stays/${ui.roomBill.stay.id}/left-room`); rerender(); };
actions.lrGo = async (d) => {
  const r = await api('POST', `${B()}/stays/${ui.roomBill.stay.id}/left-room`, d.move ? { move: d.move, table: d.t } : {});
  ui.rbForm = null; ui.lr = null;
  flash = { kind: 'ok', text: `${r.rooms.join(', ')} freed and marked dirty.${r.table ? ` The open food is on ${r.table}.` : ''} Check out when the guest pays.` };
  reopenStay = ui.roomBill.stay.id; await load('stays'); route();
};
/** Bill each open order to the room (the usual bill and payment), then free the room. */
actions.lrBill = async () => {
  const lr = ui.lr;
  await load('entities');
  const ents = counterEntities();
  const ent = (ents.find((e) => e.is_default) ?? ents[0])?.id;
  for (const o of lr.orders) {
    let billId = o.billId; let total = o.totalPaise;
    if (!billId) {
      const b = await api('POST', `${B()}/orders/${o.id}/bill`, { entityId: ent, discount: { kind: 'none' } });
      billId = b.bill.id; total = b.bill.totalPaise;
    }
    await api('POST', `${B()}/settlements`, { billIds: [billId], payments: [{ mode: 'room', amount: rupees(total), debtorAccountId: lr.stay.accountId }] });
  }
  await actions.lrGo({ move: '' });
};
actions.rbChargeGo = async () => {
  ui.roomBill = await api('POST', `${B()}/stays/${ui.roomBill.stay.id}/charges`, { amount: ui.rbAmt ?? '', note: ui.rbNote ?? '', lower: ui.rbForm === 'lower' });
  ui.rbForm = null; flash = { kind: 'ok', text: 'Room bill updated.' }; rerender();
};
actions.rbTransfer = async () => {
  const body = ui.tfTo === 'room' ? { to: 'room', stayId: ui.tfStay, amount: ui.tfAmt } : ui.tfAcc === 'new' ? { to: 'credit', newCredit: { name: ui.tfName ?? ui.roomBill.stay.company ?? '', phone: ui.tfPhone ?? '' }, amount: ui.tfAmt }
    : { to: 'credit', debtorAccountId: ui.tfAcc, amount: ui.tfAmt };
  if (ui.tfTo === 'room' ? !ui.tfStay : !ui.tfAcc) throw new Error(ui.tfTo === 'room' ? 'Choose the room that pays.' : 'Choose a credit account, or New account.');
  ui.roomBill = await api('POST', `${B()}/stays/${ui.roomBill.stay.id}/transfer`, body);
  ui.rbForm = null; flash = { kind: 'ok', text: 'Moved off the room bill.' }; await load('stays', 'credit'); rerender();
};
const mvFor = () => (ui.mvSwap ? `w:${ui.swWith ?? ''}` : `r:${ui.mvRoom ?? ''}`);
const mvCk = () => (ui.mvCheck && ui.mvCheckFor === mvFor() ? ui.mvCheck : null);
function mvButton(st) {
  const ck = mvCk();
  if (ui.mvSwap) return ck ? `Swap with ${ck.guests[1].guestName}` : 'Swap rooms';
  return ui.mvRoom ? `Move ${st.guestName} to ${ui.mvRoom}` : 'Move guest';
}
function mvBox(st) {
  const ck = mvCk();
  if (!ck) return html`<p class="small quiet">${ui.mvSwap ? 'Choose the guest' : 'Choose the room'} to see what moves with ${st.guestName}.</p>`;
  const ordName = (o) => `Food order${o.billNo ? ` · bill ${o.billNo}, printed, not paid` : o.status === 'tab' ? ' · on a tab' : ' · open'}${o.items ? ` · ${o.items}` : ''}`;
  const guest = (g) => {
    const food = g.orders.reduce((t, o) => t + o.totalPaise, 0);
    return html`<div class="msg ok" style="display:flex;flex-direction:column;gap:4px"><strong>Goes with ${g.guestName} to ${g.to}</strong>
      <div class="row small"><span>Room bill (rent, payments, food already on it)</span><span class="num">${rs(g.balancePaise)}</span></div>
      ${g.orders.map((o) => html`<div class="row small"><span>${ordName(o)}</span><span class="num">${rs(o.totalPaise)}</span></div>`)}
      ${g.orders.length ? html`<div class="row small"><strong>Due with these orders</strong><strong class="num">${rs(g.balancePaise + food)}</strong></div>` : ''}</div>`;
  };
  const loose = ck.loose.filter((x) => x.orders.length).map((x) => html`<div class="msg warn" style="display:flex;flex-direction:column;gap:6px"><strong>On the ${x.room} table, on nobody's bill</strong>
    ${x.orders.map((o) => html`<div class="row small"><span>${ordName(o)} · ${dateTime(o.openedAt)}</span><span class="num">${rs(o.totalPaise)}</span></div>
      <div class="chips">${ck.guests.map((g) => html`<button type="button" class="chip" aria-pressed="${ui.mvAtt?.[o.id] === g.stayId}" data-act="mvAtt" data-o="${o.id}" data-s="${g.stayId}">Put on ${g.guestName}'s bill</button>`)}
        <button type="button" class="chip" aria-pressed="${!ui.mvAtt?.[o.id]}" data-act="mvAtt" data-o="${o.id}" data-s="">Leave on the ${x.room} table</button></div>`)}</div>`);
  return html`<div style="display:flex;flex-direction:column;gap:8px">${ck.guests.map(guest)}${loose}
    <p class="small quiet">${ui.mvSwap ? 'Neither room is marked dirty.' : `${st.room} is marked dirty.`} Change the room in Djubo too.</p></div>`;
}
actions.mvKind = (d) => { ui.mvSwap = d.id || null; ui.mvCheck = null; rerender(); };
actions.mvAtt = (d) => { ui.mvAtt = { ...ui.mvAtt, [d.o]: d.s }; rerender(); };
actions.mvLoad = async () => {
  const key = mvFor();
  const q = ui.mvSwap ? (ui.swWith ? `with=${encodeURIComponent(ui.swWith)}` : '') : (ui.mvRoom ? `room=${encodeURIComponent(ui.mvRoom)}` : '');
  if (!q) { ui.mvCheck = null; rerender(); return; }
  const ck = await api('GET', `${B()}/stays/${ui.roomBill.stay.id}/move-check?${q}`);
  if (mvFor() !== key) return;
  // An order on nobody's bill starts on the bill of the guest whose room it is on; on a free room it stays on the table.
  const att = {};
  for (const x of ck.loose) { const g = ck.guests.find((y) => y.from === x.room); for (const o of x.orders) att[o.id] = g?.stayId ?? ''; }
  ui.mvCheck = ck; ui.mvCheckFor = key; ui.mvAtt = att; rerender();
};
const mvAttach = () => { const ck = mvCk(); return ck ? ck.loose.flatMap((x) => x.orders).filter((o) => ui.mvAtt?.[o.id]).map((o) => ({ orderId: o.id, stayId: ui.mvAtt[o.id] })) : []; };
actions.rbMove = async (d) => {
  if (!ui.mvRoom) throw new Error('Choose the new room.');
  if (!mvCk()) await actions.mvLoad();
  ui.roomBill = await api('POST', `${B()}/stays/${ui.roomBill.stay.id}/move`, { room: ui.mvRoom, reason: ui.mvWhy ?? '', attach: mvAttach(), dirtyOk: d.dirtyOk === '1' || undefined });
  ui.rbForm = null; ui.mvCheck = null; flash = { kind: 'ok', text: `Moved to ${ui.mvRoom}. Change it in Djubo too.` }; reopenStay = ui.roomBill.stay.id; route();
};
// Two in-house guests exchange rooms (25 Nov 2026).
actions.rbSwap = async () => {
  if (!ui.swWith) throw new Error('Choose the guest to swap with.');
  const other = (cache.stays ?? []).find((y) => y.id === ui.swWith);
  const from = ui.roomBill.stay.room;
  if (!mvCk()) await actions.mvLoad();
  ui.roomBill = await api('POST', `${B()}/stays/${ui.roomBill.stay.id}/swap`, { withStayId: ui.swWith, reason: ui.mvWhy ?? '', attach: mvAttach() });
  ui.rbForm = null; ui.mvSwap = null; ui.mvCheck = null; await load('stays');
  flash = { kind: 'ok', text: `Swapped: ${ui.roomBill.stay.guestName} is now in ${ui.roomBill.stay.room}${other ? `, ${other.guestName} in ${from}` : ''}. Change both in Djubo too.` };
  reopenStay = ui.roomBill.stay.id; route();
};
actions.rbExtend = async () => {
  ui.roomBill = await api('POST', `${B()}/stays/${ui.roomBill.stay.id}/extend`, { to: ui.exTo ?? addDays(ui.roomBill.stay.checkOutPlan ?? me.business.shiftDay, 1), rate: ui.exRate || undefined, reason: ui.exWhy ?? '' });
  ui.rbForm = null; flash = { kind: 'ok', text: `Stay extended to ${dayName(ui.roomBill.stay.checkOutPlan)}.` }; rerender();
};
actions.rbCn = async () => {
  const r = await api('POST', `${B()}/room-invoices/${ui.roomBill.invoice.id}/credit-note`, { amount: ui.cnAmt ?? '', reason: ui.cnWhy ?? '', refundMode: ui.cnMode ?? 'none' });
  ui.roomBill = r.bill; ui.rbForm = null;
  const n = r.bill.invoice.creditNotes.find((x) => x.cnNo === r.cnNo);
  printJobs([{ kind: 'bill', html: asHtml(html`<div class="receipt"><div class="hd">${r.bill.invoice.entityName}</div>${r.bill.invoice.gstRegistered ? html`<div class="c">GSTIN ${r.bill.invoice.gstin}</div>` : ''}
    <div class="c">CREDIT NOTE</div><div class="rl"><span>${n.cnNo}</span><span>${dateTime(n.at)}</span></div><div>Against room invoice ${r.bill.invoice.invoiceNo}</div><div>${n.reason}</div><hr>
    <div class="rl"><span>Value</span><span>${rs(n.taxablePaise)}</span></div><div class="rl"><span>CGST</span><span>${rs(n.cgstPaise)}</span></div><div class="rl"><span>SGST</span><span>${rs(n.sgstPaise)}</span></div>
    <div class="rl" style="font-weight:700"><span>TOTAL</span><span>${rs(n.totalPaise)}</span></div></div>`) }]);
  flash = { kind: 'ok', text: `${r.cnNo} made.` }; rerender();
};
actions.rbReprint = () => printJobs([{ kind: 'bill', html: asHtml(roomInvoiceSlip(ui.roomBill)) }]);
actions.rbGrc = async (d) => printJobs([{ kind: 'bill', html: asHtml(grcSlip((await api('GET', `${B()}/stays/${d.id}/grc`)).grc)) }]);
actions.formC = async (d) => { await api('POST', `${B()}/stays/${d.id}/form-c`); if (ui.roomBill) ui.roomBill = await api('GET', `${B()}/stays/${d.id}/bill`); flash = { kind: 'ok', text: 'Form C marked filed.' }; if (ui.audit) ui.audit = await api('GET', `${B()}/frontdesk/audit`); rerender(); };
/** A payment receipt slip (24 Nov 2026): its number, the room and guest, how it was paid, and what is left to pay. */
const receiptSlip = (r) => html`<div class="receipt"><div class="hd">${me.business.name}</div><div class="c">${r.kind === 'deposit' ? 'DEPOSIT RECEIPT (REFUNDABLE)' : r.kind === 'advance' ? 'ADVANCE RECEIPT' : 'PAYMENT RECEIPT'}</div>
  <div class="rl"><span>${r.receiptNo}</span><span>${dateTime(r.at)}</span></div>
  <div>${r.room ? `Room ${r.room} · ` : r.place ? `${r.place} · ` : ''}${r.name}</div>${r.party ? html`<div>Party ${dayName(r.party.day)}${r.party.time ? `, ${r.party.time}` : ''}${r.party.people ? ` · ${r.party.people} people` : ''}</div>` : ''}${r.booking ? html`<div>Booking ${r.booking}</div>` : ''}${r.checkIn ? html`<div>Stay from ${dayName(r.checkIn)}${r.checkOut ? ` to ${dayName(r.checkOut)}` : ''}</div>` : ''}<hr>
  ${r.payments.map((p) => html`<div class="rl"><span>${MODE_NAME[p.mode] ?? p.mode}${p.payAccountName ? ` (${p.payAccountName})` : ''}${p.cardLast4 ? ` ****${p.cardLast4}` : ''}</span><span>${rs(p.amountPaise)}</span></div>`)}
  <div class="rl" style="font-weight:700"><span>RECEIVED</span><span>${rs(r.totalPaise)}</span></div><hr>
  ${r.balancePaise === null || r.balancePaise === undefined ? '' : html`<div class="rl"><span>${r.balancePaise > 0 ? 'Still to pay' : r.balancePaise < 0 ? 'Held for you' : 'Nothing more to pay'}</span><span>${r.balancePaise ? rs(Math.abs(r.balancePaise)) : ''}</span></div>`}
  <div class="c small">Thank you</div></div>`;
/** Money taken at reception (24 Nov 2026): what reception entered in Djubo that still needs a POS receipt, and advances
 *  taken here waiting for their Djubo booking. */
function deskMoneyPanel(r) {
  const take = r.deskToTake ?? [];
  const wait = r.advancesWaiting ?? [];
  const upcoming = [...(r.arriving ?? []), ...(r.waiting ?? [])].filter((b) => !b.stayId && b.status !== 'cancelled');
  return html`<section class="panel" style="margin-bottom:16px;max-width:760px">
    <div class="line"><h2 class="grow" style="margin:0">Money at reception</h2><button class="btn" type="button" data-act="advNew">Take advance (no booking yet)</button></div>
    ${take.length ? html`<div class="msg warn" style="display:block;margin-top:8px"><strong>Payments to take: entered in Djubo by reception</strong>
      ${take.map((x) => html`<div class="line" style="gap:8px;border-top:1px solid var(--warn-line);padding:6px 0;flex-wrap:wrap"><span class="grow small"><strong>${x.guestName ?? 'No name'}</strong> · Djubo ${x.extRef} · stay ${dayName(x.checkIn)} → ${dayName(x.checkOut)} · ${x.enteredBy ?? ''}, ${dateTime(x.deskPaidAt)}</span>
        <button class="btn pri" type="button" data-act="advTake" data-id="${x.id}" data-n="${x.guestName ?? ''}" data-amount="${rupees(x.pendingPaise)}">Take ${rs(x.pendingPaise)}</button></div>`)}
      <div class="small">Take the money here so a receipt prints and the drawer counts it.</div></div>` : html`<p class="small quiet" style="margin:6px 0 0">Nothing entered in Djubo by reception is waiting for a receipt.</p>`}
    ${wait.length ? html`<h3 style="margin-top:12px">Advances waiting for their Djubo booking</h3>
      ${wait.map((a) => html`<div class="line" style="gap:8px;border-top:1px solid var(--line);padding:6px 0;flex-wrap:wrap"><span class="grow small"><strong>${a.guestName}</strong> · ${a.phone ?? ''} · from ${dayName(a.checkIn)} · ${a.receiptNo} · ${rs(a.amountPaise)}
          ${a.bookingStatus === 'cancelled' ? html`<br><span style="color:var(--bad)">Booking ${a.bookingRef} was cancelled: give the advance back.</span>` : ''}</span>
        ${a.bookingStatus === 'cancelled' ? html`<button class="btn" type="button" data-act="advRefund" data-id="${a.id}" data-m="cash">Refund cash</button><button class="btn" type="button" data-act="advRefund" data-id="${a.id}" data-m="upi">Refund UPI</button>`
          : html`<select class="in" data-model="at_${a.id}" aria-label="Booking"><option value="">Choose its booking</option>${upcoming.map((b) => html`<option value="${b.id}" ${ui['at_' + a.id] === b.id ? 'selected' : ''}>${b.guestName ?? '?'} · ${dayName(b.checkIn)} · ${b.extRef}</option>`)}</select>
            <button class="btn" type="button" data-act="advAttach" data-id="${a.id}">Link</button>`}</div>`)}
      <p class="small quiet">Linked by itself when Djubo's mail has the same phone and check-in day.</p>` : ''}
  </section>`;
}
/** Taking an advance at the desk: for a booking (from Payments to take), or before Djubo has the booking. */
function advanceForm() {
  const a = ui.adv;
  return html`<form class="panel" style="margin-bottom:16px;max-width:720px;border-color:var(--pri-line)"><h2>${a.bookingId || a.reservationId ? `Advance from ${a.name}` : 'Take advance (no booking in Djubo yet)'}</h2>${errorBox()}
    ${a.bookingId || a.reservationId ? '' : html`<div class="grid2"><label class="f">Guest name<input class="in" data-model="advName" value="${ui.advName ?? ''}" autofocus></label>
      <label class="f">Phone<input class="in" type="tel" inputmode="tel" data-model="advPhone" value="${ui.advPhone ?? ''}"></label>
      <label class="f">Check-in<input class="in" type="date" data-model="advIn" value="${ui.advIn ?? ''}"></label></div>`}
    <div class="chips">${[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.recvMode ?? 'cash') === k}" data-act="pick" data-k="recvMode" data-id="${k}">${t}</button>`)}</div>
    <div class="grid2"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="recvAmount" value="${ui.recvAmount ?? ''}"></label>
      ${ui.recvMode === 'upi' ? html`<div class="f">QR paid into<div class="chips">${cache.payAccounts.filter((x) => x.active).map((x) => html`<button type="button" class="chip" aria-pressed="${ui.payAccountId === x.id}" data-act="pick" data-k="payAccountId" data-id="${x.id}">${x.name}</button>`)}</div></div>` : ''}
      ${ui.recvMode === 'card' ? html`<label class="f">Approval code (optional)<input class="in" data-model="cardApproval" maxlength="12"></label><label class="f">Card last 4 (optional)<input class="in" inputmode="numeric" data-model="cardLast4" maxlength="4"></label>` : ''}</div>
    <div class="row"><button class="btn pri" type="submit" data-act="advGo" data-submit>Take advance and print receipt</button><button class="btn" type="button" data-act="advNo">Cancel</button></div></form>`;
}
actions.advNew = () => { ui.adv = {}; ui.recvMode = 'cash'; ui.recvAmount = undefined; ui.advName = ui.advPhone = ui.advIn = undefined; ui.error = null; rerender(); scrollTo(0, 0); };
actions.advTake = (d) => { ui.adv = { bookingId: d.id, name: d.n }; ui.recvMode = 'cash'; ui.recvAmount = d.amount; ui.error = null; rerender(); scrollTo(0, 0); };
actions.advNo = () => { ui.adv = null; rerender(); };
actions.advGo = async () => {
  const p = { mode: ui.recvMode ?? 'cash', amount: ui.recvAmount ?? '', payAccountId: ui.payAccountId, cardApproval: ui.cardApproval, cardLast4: ui.cardLast4 };
  const r = ui.adv.reservationId ? await api('POST', `${B()}/reservations/${ui.adv.reservationId}/advance`, { payments: [p] })
    : await api('POST', `${B()}/desk-advances`, ui.adv.bookingId ? { bookingId: ui.adv.bookingId, payments: [p] }
      : { guestName: ui.advName ?? '', phone: ui.advPhone ?? '', checkIn: ui.advIn ?? '', payments: [p] });
  printJobs([{ kind: 'bill', html: asHtml(receiptSlip(r.receipt)) }]);
  flash = { kind: 'ok', text: `${r.receipt.receiptNo}: advance ${rs(r.receipt.totalPaise)} from ${r.receipt.name} taken.` }; route();
};
actions.advAttach = async (d) => {
  if (!ui['at_' + d.id]) { ui.error = 'Choose the booking first.'; rerender(); return; }
  await api('POST', `${B()}/desk-advances/${d.id}/attach`, { bookingId: ui['at_' + d.id] });
  flash = { kind: 'ok', text: 'Advance linked to its booking.' }; route();
};
actions.advRefund = async (d) => {
  if (!confirm(`Give this advance back by ${d.m === 'upi' ? 'UPI' : 'cash'}?`)) return;
  await api('POST', `${B()}/desk-advances/${d.id}/refund`, { mode: d.m });
  flash = { kind: 'ok', text: 'Advance refunded.' }; route();
};
actions.bkLink = async (d) => {
  const stayId = ui['lk_' + d.id];
  if (!stayId) { ui.error = 'Choose the room first.'; rerender(); return; }
  await api('POST', `${B()}/bookings/${d.id}/link-stay`, { stayId });
  reopenStay = stayId; flash = { kind: 'ok', text: 'Booking linked to the room. Its rent is on the room bill.' }; route();
};
actions.bkDeskSave = async () => {
  // An unchanged box keeps the names it shows (24 Nov 2026: saving it untouched used to clear them).
  const users = String(ui.bkDesk ?? (ui.bk?.bookingTeam ?? []).join(', ')).split(',').map((x) => x.trim()).filter(Boolean);
  if (!users.length && (ui.bk?.bookingTeam ?? []).length && !confirm('Remove everyone from the booking team? Money they enter in Djubo would then need a POS receipt.')) return;
  await api('PUT', `${B()}/bookings/booking-team`, { users });
  flash = { kind: 'ok', text: users.length ? `No receipt needed for: ${users.join(', ')} and OTA bookings. Everyone else's money in Djubo needs a POS receipt.` : 'Everyone\'s money in Djubo needs a POS receipt (OTA bookings excepted).' }; route();
};
/** The stay's tax invoice for room rent, with what was paid and the food bills paid on their own. */
function roomInvoiceSlip(bill) {
  const inv = bill.invoice;
  const sum = (kinds) => bill.lines.filter((l) => kinds.includes(l.kind)).reduce((t, l) => t + l.amountPaise, 0);
  const prepaid = bill.lines.filter((l) => l.kind === 'prepaid');
  const atHotel = -sum(['receipt', 'advance', 'deposit']) - sum(['refund']);
  const food = bill.lines.filter((l) => l.kind === 'charge');
  return html`<div class="receipt"><div class="hd">${inv.entityName}</div>${inv.gstRegistered ? html`<div class="c">GSTIN ${inv.gstin}</div><div class="c">TAX INVOICE</div>` : html`<div class="c">INVOICE</div>`}
    <div class="rl"><span>${inv.invoiceNo}</span><span>${dateTime(inv.at)}</span></div>
    ${inv.billToName ? html`<div>Billed to: ${inv.billToName}</div>${inv.billToGstin ? html`<div>GSTIN: ${inv.billToGstin}</div>` : ''}${inv.billToAddress ? html`<div>${inv.billToAddress}</div>` : ''}` : ''}
    <div>Guest: ${inv.guestName}</div><div>Room ${inv.room} · ${dayName(inv.checkIn)} → ${dayName(inv.checkOut)} (${plural(inv.nights, 'night')})</div><hr>
    ${inv.lines.map((l) => html`<div class="rl"><span>${l.name}</span><span>${rs(l.amountPaise)}</span></div>`)}<hr>
    ${inv.gstRateBp ? html`<div class="rl"><span>Value</span><span>${rs(inv.taxablePaise)}</span></div><div class="rl"><span>CGST ${inv.gstRateBp / 200}%</span><span>${rs(inv.cgstPaise)}</span></div>
      <div class="rl"><span>SGST ${inv.gstRateBp / 200}%</span><span>${rs(inv.sgstPaise)}</span></div><div class="small">SAC 996311</div>` : ''}
    <div class="rl" style="font-weight:700"><span>TOTAL</span><span>${rs(inv.totalPaise)}</span></div><hr>
    ${prepaid.map((l) => html`<div class="rl"><span>${l.note}</span><span>${rs(l.amountPaise)}</span></div>`)}
    ${atHotel ? html`<div class="rl"><span>Paid at the hotel</span><span>${rs(-atHotel)}</span></div>` : ''}
    ${bill.lines.filter((l) => l.kind === 'transfer' && l.amountPaise < 0).map((l) => html`<div class="rl"><span>${l.note}</span><span>${rs(l.amountPaise)}</span></div>`)}
    ${(inv.creditNotes ?? []).map((n) => html`<div class="rl"><span>Credit note ${n.cnNo}</span><span>${rs(-n.totalPaise)}</span></div>`)}
    ${food.length ? html`<div class="small">Food bills ${food.map((l) => l.billNo).join(', ')} (${rs(food.reduce((t, l) => t + l.amountPaise, 0))}) are invoiced on their own.</div>` : ''}
    <div class="rl" style="font-weight:700"><span>BALANCE</span><span>${rs(0)}</span></div>
    <div class="c small">Thank you for staying with us</div></div>`;
}
actions.pickArrival = async (d, _el, quiet) => {
  const a = ui.arrivals.find((x) => x.id === d.id) ?? (ui.lateArrivals ?? []).find((x) => x.id === d.id);
  if (!a) return;
  // A late check-in (25 Nov 2026): the booking's own date; more than 2 days late, a manager approves.
  ui.ciLate = a.checkIn && a.checkIn < me.business.shiftDay ? Math.round((Date.parse(me.business.shiftDay) - Date.parse(a.checkIn)) / 86400000) : 0;
  ui.ciLeft = !!(a.checkOut && a.checkOut <= me.business.shiftDay);
  ui.ciOutToo = !!(a.checkOut && a.checkOut < me.business.shiftDay);   // left before today: almost surely gone
  if (ui.ciLate > 2 && !isMgr() && !ui.approvers) { ui.approvers = (await api('GET', `${B()}/approvers`).catch(() => ({ approvers: [] }))).approvers; ui.apId = ui.approvers[0]?.id; }
  ui.bookingId = a.id; ui.resPicked = null; ui.guest = a.guestName; ui.gPhone = a.phone ?? ''; ui.gFound = null;
  ui.ciOut = a.checkOut; ui.ciAdults = a.guests ? String(a.guests) : ui.ciAdults;
  // Djubo's room or bed number when a room here is named the same; else the room type, to narrow the list.
  // Djubo writes "XIVA" or "XIV A": compared without spaces.
  const flat = (t) => String(t).toLowerCase().replace(/\s+/g, '');
  // Every room or bed of the booking (24 Nov 2026): one check-in puts the guest in all of them, billed on the first.
  const names = ui.roomSecs.flatMap((x) => x.tables ?? []);
  const labels = (a.roomLabels ?? '').split(',').map(flat).filter(Boolean);
  const hits = [...new Set(labels.map((l) => names.find((t) => flat(t) === l)).filter(Boolean))];
  const busy = (t) => (cache.stays ?? []).some((x) => roomKeyOf(x.room) === roomKeyOf(t));
  // A guest who has left is recorded in Djubo's room as a past stay (25 Nov 2026), even when it is taken today.
  const pastOk = ui.ciLeft && ui.ciOutToo;
  const free = pastOk ? hits : hits.filter((t) => !busy(t));
  ui.ciTaken = pastOk ? [] : hits.filter(busy);
  ui.ciHits = hits;
  ctPrepare(a, hits);
  ui.ciMulti = labels.length > 1 || (a.rooms ?? 1) > 1;
  ui.ciBooked = Math.max(a.rooms ?? 1, 1); ui.ciShare = false;
  ui.room = free[0] ?? null; ui.ciRooms = free.slice(1);
  // A mixed type ("Quad Sharing, Hexa") would match nothing: the search starts empty (27 Nov 2026).
  ui.roomQ = hits.length === 1 && free.length ? hits[0] : hits.length || (a.roomType ?? '').includes(',') ? '' : a.roomType ?? '';
  if (!quiet) rerender();
};
/** Bookings from mail: waiting for a person (approve, fix, cancel), arriving soon, the mails received, and automatic. */
function bookingsPanel(r, mode = 'inbox') {
  const src = { mmt: 'MakeMyTrip', djubo: 'Djubo' };
  const inWaiting = new Set(r.waiting.map((x) => x.id));
  const types = (ui.roomSecs ?? []).map((x) => x.name);
  const row = (b) => {
    const fixing = ui.bkFix === b.id;
    const matched = b.matchId ? [...r.waiting, ...r.arriving].find((x) => x.id === b.matchId) : null;
    return html`<div class="line" style="flex-wrap:wrap;gap:8px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)">
      <div class="grow"><strong>${b.guestName ?? 'No name'}</strong> <span class="small quiet">${src[b.source]} ${b.extRef}${b.phone ? ` · ${b.phone}` : ''}</span>
        <div class="small">${b.roomType ?? 'Room type?'}${b.rooms > 1 ? ` × ${b.rooms}` : ''}${b.roomLabels ? ` (Djubo ${b.roomLabels})` : ''} · ${b.checkIn ? dayName(b.checkIn) : '?'} → ${b.checkOut ? dayName(b.checkOut) : '?'}${b.guests ? ` · ${plural(b.guests, 'guest')}` : ''}${b.amountPaise ? ` · ${rs(b.amountPaise)}` : ''}${b.channel ? ` · ${b.channel}` : ''}</div>
        ${b.bookedAt || b.mealPlan ? html`<div class="small quiet">${b.bookedAt ? `Booked ${stampText(b.bookedAt)}${b.changedAt ? ` · changed ${stampText(b.changedAt)}` : ''}` : ''}${b.bookedAt && b.mealPlan ? ' · ' : ''}${b.mealPlan ?? ''}</div>` : ''}
        ${b.requests ? html`<div class="small">Requests: ${b.requests}</div>` : ''}
        ${b.amountPaise ? html`<div class="small">${dueOf(b) ? html`<strong>To collect at the hotel: ${rs(dueOf(b))}</strong>` : 'Nothing to collect'}${[prepaidOf(b) ? `paid before arrival ${rs(prepaidOf(b))}` : '',
          b.heldPaise ? `advance taken here ${rs(b.heldPaise)}` : '', b.deskPaidPaise ? `reception entered ${rs(b.deskPaidPaise)} in Djubo` : ''].filter(Boolean).map((x) => ` · ${x}`).join('')}</div>` : ''}
        ${b.problem ? html`<div class="small" style="color:var(--warn)">Check: ${b.problem}</div>` : ''}
        ${b.status === 'approved' && !b.stayId && b.checkIn && b.checkIn <= r.today && (r.unbooked ?? []).length ? html`<div class="row" style="margin-top:4px;align-items:center">
          <select class="in" data-model="lk_${b.id}" aria-label="In-house room"><option value="">Guest already in a room?</option>${r.unbooked.map((x) => html`<option value="${x.id}" ${ui['lk_' + b.id] === x.id ? 'selected' : ''}>${x.room} · ${x.guestName}</option>`)}</select>
          <button class="btn" type="button" data-act="bkLink" data-id="${b.id}">This is the guest in that room</button></div>` : ''}
        ${matched ? html`<div class="small quiet">Same stay in ${src[matched.source]} ${matched.extRef}</div>` : ''}
        ${b.status !== 'new' ? html`<div class="small quiet">${b.status === 'checked_in' ? 'Checked in' : b.how === 'auto' ? 'Approved by Bookr' : 'Approved'}</div>` : ''}
        ${fixing ? html`<form class="grid2" style="margin-top:8px"><label class="f">Guest name<input class="in" data-model="bkName" value="${ui.bkName ?? b.guestName ?? ''}"></label>
          <label class="f">Room type<select class="in" data-model="bkType"><option value="">Choose</option>${types.map((t) => html`<option ${(ui.bkType ?? b.roomType) === t ? 'selected' : ''}>${t}</option>`)}</select></label>
          <label class="f">Check-in<input class="in" type="date" data-model="bkIn" value="${ui.bkIn ?? b.checkIn ?? ''}"></label><label class="f">Check-out<input class="in" type="date" data-model="bkOut" value="${ui.bkOut ?? b.checkOut ?? ''}"></label>
          <label class="f">Phone (only to change it)<input class="in" inputmode="tel" data-model="bkPhone" data-live value="${ui.bkPhone ?? ''}"></label>${phoneHint(ui.bkPhone)}
          <div class="row"><button class="btn pri" type="submit" data-act="bkApprove" data-id="${b.id}" data-fix="1" data-submit>Save and approve</button><button class="btn ghost" type="button" data-act="bkFixNo">Cancel</button></div></form>` : ''}</div>
      ${b.status === 'new' && !fixing ? html`<div class="row"><button class="btn pri sm" type="button" data-act="bkApprove" data-id="${b.id}" data-pair="${matched && inWaiting.has(matched.id) ? matched.id : ''}">Approve${matched && inWaiting.has(matched.id) ? ' both' : ''}</button><button class="btn sm" type="button" data-act="bkFix" data-id="${b.id}">Fix</button>
        <button class="btn ghost sm" type="button" data-act="bkCancel" data-id="${b.id}">Cancel booking</button></div>` : ''}</div>`;
  };
  // A MakeMyTrip booking and its Djubo copy waiting together show as one item (the Djubo one: it has the phone and room).
  const { approve: waiting, holds, copies } = waitingGroups(r);
  const auto0 = r.autoFrom ? new Date(r.autoFrom + 19_800_000).toISOString().slice(0, 10) : null;
  if (mode === 'settings') {
    return html`<section class="panel"><h2>Bookings from mail</h2>
      <p class="small quiet">Read from the Djubo and MakeMyTrip mails forwarded by Gmail. ${auto0 ? (auto0 <= r.today ? `Automatic since ${dayName(auto0)}: clean bookings go in by themselves; odd ones wait in Reservations › Waiting for you.` : `Automatic from ${dayName(auto0)}; until then a person approves each one.`) : 'A person approves each one.'}</p>
      <form class="row" style="align-items:end"><label class="f">Automatic from<input class="in" type="date" data-model="bkAuto" value="${ui.bkAuto ?? auto0 ?? addDays(r.today, 10)}"></label>
        <button class="btn" type="submit" data-act="bkAutoSave" data-submit>Save</button>${auto0 ? html`<button class="btn ghost" type="button" data-act="bkAutoOff">Turn off</button>` : ''}</form>
      <form class="row" style="align-items:end"><label class="f" style="flex:1">Djubo users who don't need a POS receipt (booking team)<input class="in" data-model="bkDesk" value="${ui.bkDesk ?? (r.bookingTeam ?? []).join(', ')}" placeholder="e.g. the booking team's names, as Djubo shows them"></label>
        <button class="btn" type="submit" data-act="bkDeskSave" data-submit>Save</button></form>
      <p class="small quiet">Money anyone else enters in Djubo (reception, someone new) needs a POS receipt and shows on Today until it is taken here. OTA bookings never need one. Separate names with commas.</p></section>`;
  }
  const linkable = r.arriving.filter((b) => b.status === 'approved' && !b.stayId && b.checkIn && b.checkIn <= r.today && (r.unbooked ?? []).length);
  const problems = r.mails.filter((m) => m.status === 'failed' || (m.source === 'gmail'));
  const auto = r.autoFrom ? new Date(r.autoFrom + 19_800_000).toISOString().slice(0, 10) : null;
  return html`<section class="panel"><div class="row between"><h2>Waiting for you</h2><span class="small quiet">${auto ? (auto <= r.today ? `Automatic since ${dayName(auto)}: only odd bookings wait here.` : `Automatic from ${dayName(auto)}.`) : 'A person approves each booking.'}
      ${isMgr() ? html`<a href="#/settings/bookings">Settings</a>` : ''}</span></div>
    ${r.alerts?.length ? html`<div class="msg bad" role="alert" style="margin:8px 0"><p style="margin:0 0 6px"><strong>Djubo could not place ${plural(r.alerts.length, 'booking')}.</strong> Create ${r.alerts.length === 1 ? 'it' : 'them'} in Djubo by hand, or rooms may be sold twice.</p>
      ${r.alerts.map((b) => html`<div class="line" style="gap:8px;border-top:1px solid var(--bad-line);padding:6px 0"><span class="grow small"><strong>${b.guestName ?? 'No name'}</strong> · ${b.channel ?? 'OTA'} ref ${b.pnr}${b.phone ? ` · ${b.phone}` : ''}<br>
        ${b.roomType ?? '?'}${b.rooms > 1 ? ` × ${b.rooms}` : ''} · ${b.checkIn ? dayName(b.checkIn) : '?'} → ${b.checkOut ? dayName(b.checkOut) : '?'}${b.amountPaise ? ` · ${rs(b.amountPaise)}` : ''}
        ${copies.filter((x) => x.pnr === b.pnr).map((x) => html`<br><span class="quiet">MakeMyTrip's copy ${x.extRef} waits with it, and goes in by itself once Djubo has the booking.</span>`)}</span>
        <button class="btn" type="button" data-act="bkHandled" data-id="${b.id}">Done in Djubo</button></div>`)}
      <p class="small" style="margin:6px 0 0">It clears by itself when Djubo's confirmation for the same booking arrives.</p></div>` : ''}
    <h3>To approve (${waiting.length})</h3>${waiting.length ? waiting.map(row) : html`<p class="empty">Nothing to approve. New bookings from Djubo and MakeMyTrip appear here.</p>`}
    ${holds.length ? html`<h3 style="margin-top:12px">On hold, not paid yet (${holds.length})</h3><p class="small quiet" style="margin:0">Website bookings Djubo holds until the guest pays. Nothing to do: each goes in by itself when Djubo confirms it. Cancel one only if it is not going to be paid.</p>${holds.map(row)}` : ''}
    ${linkable.length ? html`<h3 style="margin-top:12px">Arriving today: guest already in a room? (${linkable.length})</h3>${linkable.map(row)}` : ''}
    ${problems.length ? html`<h3 style="margin-top:12px">Mails to look at</h3>${problems.map((m) => {
      // Gmail's forwarding confirmation: its link as a button (only a Google mail-settings link, opened in a new tab).
      const link = m.source === 'gmail' ? /https:\/\/(?:mail-settings\.google\.com|mail\.google\.com)\/\S+/.exec(m.note ?? '')?.[0] : null;
      return html`<div class="line" style="gap:8px;border-top:1px solid var(--line);padding:8px 0">
      <span class="grow small"><strong>${m.subject || '(no subject)'}</strong> · ${dateTime(m.receivedAt)}<br><span class="quiet">${link ? 'Gmail asks to confirm forwarding to Bookr POS.' : m.note}</span></span>
      ${link ? html`<a class="btn" href="${link}" target="_blank" rel="noopener noreferrer">Confirm forwarding</a>`
        : m.source !== 'gmail' ? html`<button class="btn" type="button" data-act="bkReread" data-id="${m.id}">Read again</button>` : ''}</div>`; })}` : ''}
    <div class="line" style="gap:8px;margin-top:8px"><p class="small quiet grow" style="margin:0">${plural(r.mails.length, 'mail')} received lately.</p>
      <button class="btn" type="button" data-act="bkRereadAll"${ui.bkRereading ? ' disabled' : ''}>${ui.bkRereading ? `Reading… ${ui.bkRereading}` : 'Read all again'}</button></div></section>`;
}
actions.bkFix = (d) => { ui.bkFix = d.id; ui.bkName = ui.bkType = ui.bkIn = ui.bkOut = ui.bkPhone = undefined; rerender(); };
actions.bkFixNo = () => { ui.bkFix = null; rerender(); };
actions.bkApprove = async (d) => {
  const fix = d.fix ? { guestName: ui.bkName, roomType: ui.bkType, checkIn: ui.bkIn, checkOut: ui.bkOut, phone: ui.bkPhone || undefined } : {};
  await api('POST', `${B()}/bookings/${d.id}/approve`, fix);
  // The other copy of the same stay (MakeMyTrip + Djubo) is approved with it.
  if (d.pair && !d.fix) await api('POST', `${B()}/bookings/${d.pair}/approve`, {}).catch(() => null);
  flash = { kind: 'ok', text: 'Booking approved.' }; route();
};
actions.bkCancel = async (d) => { if (!confirm('Cancel this booking?')) return; await api('POST', `${B()}/bookings/${d.id}/cancel`); route(); };
actions.bkHandled = async (d) => { await api('POST', `${B()}/bookings/${d.id}/cancel`); flash = { kind: 'ok', text: 'Marked as done in Djubo.' }; route(); };
actions.bkReread = async (d) => { await api('POST', `${B()}/mails/${d.id}/read-again`); flash = { kind: 'ok', text: 'Read again.' }; route(); };
// Every Djubo and MakeMyTrip mail read again, oldest first, a few per call.
actions.bkRereadAll = async () => {
  if (!confirm('Read all Djubo and MakeMyTrip mails again? Bookings are brought up to date from the mails; a change you made by hand with Fix may be replaced.')) return;
  let from = 0;
  try {
    for (;;) {
      const r = await api('POST', `${B()}/mails/read-all-again`, { from });
      ui.bkRereading = `${r.done} of ${r.total}`; rerender();
      if (r.next === null) { flash = { kind: 'ok', text: `${plural(r.done, 'mail')} read again.` }; break; }
      from = r.next;
    }
  } finally { ui.bkRereading = null; route(); }
};
actions.bkAutoSave =async () => { await api('PUT', `${B()}/bookings/auto`, { from: ui.bkAuto ?? addDays(ui.bk.today, 10) }); flash = { kind: 'ok', text: 'Automatic saved.' }; route(); };
actions.bkAutoOff = async () => { await api('PUT', `${B()}/bookings/auto`, { from: null }); flash = { kind: 'ok', text: 'Automatic is off: a person approves each booking.' }; route(); };
actions.openStay = async (d = {}) => {
  // Check-in details for the registration card (25 Nov 2026): guests, each adult's ID, address and travel, Form C.
  const adults = Math.max(1, Math.min(10, Number(ui.ciAdults) || 1));
  const foreignGuest = ui.ciNat && !/^indian?$/i.test(ui.ciNat.trim());
  const idDocs = Array.from({ length: adults }, (_, i) => ({ type: ui[`idT_${i}`] ?? (foreignGuest ? 'Passport' : 'Aadhaar'), number: ui[`idN_${i}`] ?? '', name: ui[`idName_${i}`] ?? (i === 0 ? ui.guest : '') }))
    .filter((x) => String(x.number).trim());
  const foreign = foreignGuest ? { passport: ui.fPass ?? '', visa: ui.fVisa ?? '', visaExpiry: ui.fVisaTo ?? '', arrivedOn: ui.fArr ?? '', formC: !!ui.fFormC } : undefined;
  const later = d.later === '1';
  const r = await api('POST', B() + '/stays', { room: later ? undefined : ui.room, roomLater: later || undefined, rooms: later ? [] : ui.ciMulti ? ui.ciRooms ?? [] : [], guestName: ui.guest, phone: ui.gPhone || undefined, city: ui.gCity || undefined, bookingId: ui.bookingId || undefined,
    reservationId: ui.resPicked?.id, dirtyOk: d.dirtyOk === '1' || undefined, adults,
    sharingBeds: ui.ciShare ? Math.max(0, (ui.ciBooked ?? 1) - 1 - (ui.ciMulti ? (ui.ciRooms ?? []).length : 0)) || undefined : undefined, children: Number(ui.ciKids) || 0, checkOutPlan: ui.ciOut ?? addDays(me.business.shiftDay, 1), idDocs, address: ui.ciAddr || undefined, comingFrom: ui.gCity || undefined,
    goingTo: ui.ciNext || undefined, nationality: ui.ciNat || undefined, foreign, past: !!(ui.ciLate && ui.ciLeft && ui.ciOutToo) || undefined, ...(ui.ciLate > 2 && !isMgr() ? { approverId: ui.apId, approverPin: ui.apPin } : {}) });
  if (!d.noprint) printJobs([{ kind: 'bill', html: asHtml(grcSlip((await api('GET', `${B()}/stays/${r.id}/grc`)).grc)) }]);
  const due = dueOf(ui.arrivals?.find((a) => a.id === ui.bookingId));
  // The room bill opens, ready to take what is still to pay (24 Nov 2026).
  reopenStay = r.id;
  pendingOut = !!(ui.ciLate && ui.ciLeft && ui.ciOutToo);
  if (pendingOut) { flash = { kind: 'warn', text: `${ui.guest} checked in late to ${(r.rooms ?? [ui.room]).join(', ')}. ${due ? `Take the ${rs(due)} that was paid (Take payment), or move it to Credit if it was not, then` : 'Now'} check out below.` }; await refreshDeskAlerts(); go('#/rooms'); return; }
  flash = { kind: due ? 'warn' : 'ok', text: `${ui.guest} checked in ${later ? 'with no room yet: give one from Rooms › Today when it is ready' : `to ${(r.rooms ?? [ui.room]).join(', ')}`}${r.grcNo ? ` · ${r.grcNo}` : ''}.${due ? ` Collect ${rs(due)} still to pay (Take payment, below).` : ''}` };
  await refreshDeskAlerts(); go('#/rooms');
};
/** The guest registration card, printed at check-in for the guest to sign. */
function grcSlip(g) {
  const nights = g.checkOut ? Math.max(1, Math.round((Date.parse(g.checkOut) - Date.parse(g.checkIn)) / 86400000)) : null;
  return html`<div class="receipt"><div class="hd">${g.business}</div><div class="c">GUEST REGISTRATION CARD</div>
    <div class="rl"><span>${g.grcNo ?? ''}</span><span>Room ${g.room}</span></div><hr>
    <div>Name: ${g.guestName}</div>${g.phone ? html`<div>Mobile: ${g.phone}</div>` : ''}
    <div>Arrival: ${dateTime(g.arrivedAt)}</div>${g.checkOut ? html`<div>Departure: ${dayName(g.checkOut)}, 11 am${nights ? ` (${plural(nights, 'night')})` : ''}</div>` : ''}
    <div>Guests: ${g.adults ?? 1} adult${(g.adults ?? 1) === 1 ? '' : 's'}${g.children ? `, ${g.children} child${g.children === 1 ? '' : 'ren'}` : ''}</div>
    ${g.nationality ? html`<div>Nationality: ${g.nationality}</div>` : ''}
    ${g.idDocs.map((x, i) => html`<div>ID ${i + 1}: ${x.type} ••${x.last4}${x.name ? ` · ${x.name}` : ''}</div>`)}
    ${g.foreign ? html`<div>Passport ••${g.foreign.passportLast4 ?? ''} · Visa ${g.foreign.visa ?? ''}${g.foreign.visaExpiry ? ` till ${dayName(g.foreign.visaExpiry)}` : ''}</div>` : ''}
    ${g.address ? html`<div>Address: ${g.address}</div>` : ''}${g.comingFrom ? html`<div>Coming from: ${g.comingFrom}</div>` : ''}${g.goingTo ? html`<div>Going to: ${g.goingTo}</div>` : ''}<hr>
    ${g.rentPaise ? html`<div class="rl"><span>Room rent (GST incl.)</span><span>${rs(g.rentPaise)}</span></div>` : ''}${g.mealPlan ? html`<div>Meal plan: ${g.mealPlan}</div>` : ''}
    ${g.prepaidPaise ? html`<div class="rl"><span>Paid before arrival</span><span>${rs(g.prepaidPaise)}</span></div>` : ''}${g.paidPaise ? html`<div class="rl"><span>Paid here</span><span>${rs(g.paidPaise)}</span></div>` : ''}
    <div class="small" style="margin-top:6px">Check-out 11 am. Outside food and alcohol not allowed. I agree to the rate and the house rules.</div>
    <div class="rl" style="margin-top:28px"><span>Guest signature</span><span>Reception</span></div></div>`;
}

// ---------- credit accounts (25 Nov 2026: their own tab)
// ---------- payment proof list (24 Nov 2026): every bill and receipt of the shift against the proof staff post in the
// Guest payment group. Bookr reads WhatsApp and matches; this screen asks every 12 seconds. Settling never waits on it.

let proofTimer = null;
function stopProof() { if (proofTimer) { clearInterval(proofTimer); proofTimer = null; } }
const PROOF_TABS = [['', 'All'], ['diff', 'Differences'], ['missing', 'No proof'], ['extras', 'Extras'], ['bills', 'Bills']];
const PROOF_STATUS = {
  matched: ['ok', '✓ Matched'], waiting: ['warn', 'Printed, no proof yet'], missing: ['bad', 'Settled, no proof'],
  difference: ['info', 'Difference'], not_needed: ['', 'No proof needed'], unknown: ['', '—'],
};
const PROOF_MODE = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Room', credit: 'Credit', comp: 'Comp', advance: 'Advance' };

// Which shift or shifts Payments shows (28 Nov 2026): one shift (◀ date ▶) or From–To, up to 7 shifts, newest first.
// Kept while moving between its tabs; "Today's shift" goes back. A shift runs from the start hour to the same hour next
// day, so a bill after midnight sits under the shift before; every row shows its own date and time.
let payDays = null;
const PAY_MAX = 7;
function payState() {
  const t = me.business.shiftDay;
  if (!payDays) payDays = { mode: 'one', day: t, from: addDays(t, -(PAY_MAX - 1)), to: t };
  return payDays;
}
const payList = () => {
  const p = payState();
  if (p.mode === 'one') return [p.day];
  const out = [];
  for (let d = p.to; d >= p.from && out.length < PAY_MAX; d = addDays(d, -1)) out.push(d);
  return out;
};
const shiftName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
const dm = (ms) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
/** "28 Nov, 12:41 am": the date always shown, as a bill after midnight belongs to the shift before. */
const payWhen = (ms) => html`<span class="pay-when"><b>${dm(ms)}</b>, ${time(ms)}</span>`;

async function paymentsScreen(tab = '') {
  const p = payState();
  const today = me.business.shiftDay;
  if (p.day > today) p.day = today;
  if (p.to > today) p.to = today;
  const days = payList();
  const live = p.mode === 'one' && p.day === today;
  const load = async () => { ui.pfDays = await Promise.all(days.map((d) => api('GET', `${B()}/proof?day=${d}${p.mode === 'range' ? '&open=0' : ''}`))); };
  await load();
  rerender = () => {
    const all = ui.pfDays;
    const first = all[0] ?? {};
    const rowsOf = (d) => {
      const byKey = new Map((d.rows ?? []).map((r) => [r.key, r]));
      return d.bills.map((b) => byKey.get(b.key) ?? { ...b, status: 'unknown', proof: [], differences: [], missing: [] }).reverse();
    };
    const shifts = all.map((d) => {
      const rows = rowsOf(d);
      const extras = [...(d.extras ?? [])].reverse();
      const c = { matched: rows.filter((r) => r.status === 'matched').length, missing: rows.filter((r) => r.status === 'missing').length,
        diff: rows.filter((r) => r.status === 'difference').length, waiting: rows.filter((r) => r.status === 'waiting').length, extras: extras.length };
      return { d, rows, extras, c };
    });
    const sum = (k) => shifts.reduce((n, x) => n + x.c[k], 0);
    const n = { matched: sum('matched'), missing: sum('missing'), diff: sum('diff'), waiting: sum('waiting'), extras: sum('extras') };
    const stale = live && first.listener?.lastSeenAt && Date.now() - first.listener.lastSeenAt > 10 * 60_000;
    // Connected to Bookr, but Bookr has never heard from the WhatsApp listener (24 Nov 2026): say so, or bills just show no proof.
    const neverSeen = first.connected !== false && !first.error && !first.listener?.lastSeenAt;
    const proofText = (e) => html`${{ upi: 'UPI', card: 'Card slip', bill: 'Bill photo' }[e.kind]}${e.amountPaise ? ` ${rs(e.amountPaise)}` : ''} · ${payWhen(e.sentAt)}${e.caption ? ` · “${e.caption}”` : ''}`;
    const row = (r) => {
      const [tone, label] = PROOF_STATUS[r.status] ?? PROOF_STATUS.unknown;
      return html`<tr><td>${payWhen(r.at)}</td><td class="mono">${r.billNo && r.kind !== 'receipt' ? html`<a href="#/done/${r.key}">${r.billNo}</a>` : r.billNo ?? 'Receipt'}</td><td>${r.label ?? ''}</td><td class="num">${rs(r.totalPaise)}</td>
        <td>${r.modes.length ? r.modes.map((m) => `${PROOF_MODE[m.mode] ?? m.mode} ${rs(m.amountPaise)}`).join(' + ') : html`<span class="quiet">not paid</span>`}</td>
        <td class="small">${r.proof.length ? r.proof.map((e) => html`<div>${proofText(e)}</div>`) : html`<span class="quiet">—</span>`}</td>
        <td>${tone ? html`<span class="status ${tone}">${label}</span>` : html`<span class="quiet small">${label}</span>`}
          ${[...r.differences, ...r.missing].map((x) => html`<div class="small">${x}</div>`)}</td></tr>`;
    };
    const tableOf = (x) => {
      if (tab === 'extras') return x.extras.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Posted</th><th>What</th><th>Caption</th><th>By</th></tr></thead><tbody>
          ${x.extras.map((e) => html`<tr><td>${payWhen(e.sentAt)}</td><td>${e.what}</td><td class="small">${e.caption ?? ''}</td><td class="small">${e.sender ?? ''}</td></tr>`)}</tbody></table></div>`
        : html`<p class="empty">No extra proof: everything posted fits a POS bill.</p>`;
      const shown = tab === 'diff' ? x.rows.filter((r) => r.status === 'difference') : tab === 'missing' ? x.rows.filter((r) => r.status === 'missing') : x.rows;
      return shown.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Date and time</th><th>Bill</th><th>Table</th><th class="num">Amount</th><th>Paid by</th><th>Proof posted</th><th>Status</th></tr></thead>
          <tbody>${shown.map(row)}</tbody></table></div>`
        : html`<p class="empty">${tab ? 'Nothing here.' : 'No bills in this shift.'}</p>`;
    };
    const cancelled = all.flatMap((d) => (d.cancelledReceipts ?? []));
    const start = me.business.shift_start_hour ?? 8;
    const title = p.mode === 'one' ? `Payments · ${shiftName(p.day)}${p.day === today ? " (today's shift)" : ''}` : `Payments · ${shiftName(days.at(-1))} to ${shiftName(days[0])}`;
    const bar = html`<div class="pay-bar">
      <span class="pay-mode" role="group" aria-label="One shift or several"><button type="button" class="chip" data-act="payMode" data-v="one" aria-pressed="${p.mode === 'one'}">One day</button><button type="button" class="chip" data-act="payMode" data-v="range" aria-pressed="${p.mode === 'range'}">From–To</button></span>
      ${p.mode === 'one' ? html`<button class="btn" type="button" data-act="payStep" data-n="-1" aria-label="Previous shift">◀</button>
          <input class="in" type="date" id="payDay" value="${p.day}" max="${today}" data-act-change="payPick" data-k="day" aria-label="Shift">
          <button class="btn" type="button" data-act="payStep" data-n="1" aria-label="Next shift" ${p.day >= today ? 'disabled' : ''}>▶</button>`
        : html`<label class="small pay-lab">From <input class="in" type="date" id="payFrom" value="${p.from}" max="${today}" data-act-change="payPick" data-k="from"></label>
          <label class="small pay-lab">To <input class="in" type="date" id="payTo" value="${p.to}" max="${today}" data-act-change="payPick" data-k="to"></label>
          <span class="small quiet">Up to ${PAY_MAX} days</span>`}
      <span class="grow"></span>
      <button class="btn ${live ? '' : 'pri'}" type="button" data-act="payToday">Today's shift</button></div>`;
    // Proof posted in this shift for a bill of another shift (28 Nov 2026): found by the bill's number, shown apart and not
    // counted here. The bill itself is under its own shift.
    const earlierOf = (x) => {
      const list = (x.d.earlier ?? []).filter((r) => tab === 'diff' ? r.status === 'difference' : tab !== 'extras' && tab !== 'missing');
      return list.length ? html`<section class="panel"><div class="row between" style="margin-bottom:6px"><h2>Proof for earlier bills</h2>
          <span class="small quiet">Posted in this shift for bills of another shift; counted there, not here.</span></div>
          <div class="scroll"><table class="t"><thead><tr><th>Bill printed</th><th>Bill</th><th>Shift</th><th>Table</th><th class="num">Amount</th><th>Paid by</th><th>Proof posted</th><th>Status</th></tr></thead>
          <tbody>${list.map((r) => {
            const [tone, label] = PROOF_STATUS[r.status] ?? PROOF_STATUS.unknown;
            return html`<tr><td>${payWhen(r.at)}</td><td class="mono"><a href="#/done/${r.key}">${r.billNo}</a></td><td class="small">${r.shiftDay ? shiftName(r.shiftDay) : ''}</td><td>${r.label ?? ''}</td>
              <td class="num">${rs(r.totalPaise)}</td><td>${r.modes.map((m) => `${PROOF_MODE[m.mode] ?? m.mode} ${rs(m.amountPaise)}`).join(' + ')}</td>
              <td class="small">${r.proof.map((e) => html`<div>${proofText(e)}</div>`)}</td>
              <td>${tone ? html`<span class="status ${tone}">${label}</span>` : ''}${[...r.differences, ...r.missing].map((y) => html`<div class="small">${y}</div>`)}</td></tr>`;
          })}</tbody></table></div></section>` : '';
    };
    const body = p.mode === 'one' ? html`<section class="panel">${tableOf(shifts[0])}</section>${earlierOf(shifts[0])}`
      : shifts.map((x) => html`<section class="panel"><div class="row between" style="margin-bottom:6px"><h2>${shiftName(x.d.day)} shift</h2>
          <span class="small quiet">${plural(x.rows.length, 'bill')} · ${x.c.matched} matched${x.c.missing ? html` · <b style="color:var(--bad)">${x.c.missing} no proof</b>` : ''}${x.c.diff ? ` · ${plural(x.c.diff, 'difference')}` : ''}</span></div>
          ${tableOf(x)}</section>`);
    paint(shell('#/payments', html`${pageHead(title, `Every bill and receipt against the proof posted in the Guest payment group: a UPI screenshot, the card slip, or “cash” on the bill photo. A shift runs ${start} am to ${start} am, so a bill after midnight belongs to the shift before.`)}
      ${bar}
      ${p.mode === 'one' && !live ? html`<p class="small quiet" style="margin:-4px 0 12px">A past shift: shown as checked now, not refreshed. Bills still unpaid show on today's shift.</p>` : ''}
      ${p.mode === 'range' ? html`<p class="small quiet" style="margin:-4px 0 12px">Shown as checked now, not refreshed. Each bill is under the shift it was printed or paid in.</p>` : ''}
      ${cancelled.length ? html`<div class="msg warn" style="display:block;margin-bottom:12px"><b>Cancelled receipts (no proof needed)</b>${cancelled.map((x) => html`<div><span style="text-decoration:line-through">${x.receiptNo ?? 'Receipt'} · ${rs(x.totalPaise)}</span> <span class="status bad">CANCELLED</span> · ${x.who ?? ''} · ${x.reason} · by ${x.byName ?? ''}</div>`)}</div>` : ''}
      ${first.connected === false ? html`<div class="msg warn">This POS is not connected to Bookr, so no proof is shown. The bills are listed below.</div>` : ''}
      ${all.find((d) => d.error) ? html`<div class="msg warn">Bookr could not be reached (${all.find((d) => d.error).error}).${live ? ' Trying again every few seconds;' : ''} The bills are listed below.</div>` : ''}
      ${neverSeen ? html`<div class="msg warn">WhatsApp is not connected to Bookr yet, so no payment proof can show. The listener on the reception PC needs setting up, and the Guest payment group adding in Bookr (Settings › WhatsApp groups, with POS proof on).</div>` : ''}
      ${stale ? html`<div class="msg warn">WhatsApp has not been read since ${payWhen(first.listener.lastSeenAt)}: new proof will not show until the reception PC is back.</div>` : ''}
      <div class="kpis">${kpi('Matched', String(n.matched), `of ${n.matched + n.missing + n.diff} paid needing proof`, 'good')}
        ${kpi('Settled, no proof', String(n.missing), '', n.missing ? 'bad' : '')}
        ${kpi('Printed, not paid', String(n.waiting), '', 'warn')}
        ${kpi('Differences', String(n.diff), '', n.diff ? 'bad' : '')}
        ${kpi('Extras', String(n.extras), 'proof with no POS bill')}</div>
      ${live && first.reading ? html`<p class="small quiet">${first.reading} photo${first.reading === 1 ? ' is' : 's are'} being read.</p>` : ''}
      ${tabsNav('Payments', PROOF_TABS.map(([k, t]) => [k === 'bills' && p.mode === 'one' ? `#/payments/bills/${p.day}` : k ? `#/payments/${k}` : '#/payments',
        k && n[k] ? html`${t} <span class="status ${k === 'extras' ? 'info' : 'bad'}">${n[k]}</span>` : t, k]), tab)}
      ${body}`));
  };
  rerender();
  // Today's shift only: asks again every 12 seconds while this screen is open and the window is in front.
  if (live) {
    proofTimer = setInterval(async () => {
      if (document.hidden) return;
      try { await load(); rerender(); } catch { /* the next tick tries again */ }
    }, 12_000);
  }
}
actions.payMode = (d) => { payState().mode = d.v === 'range' ? 'range' : 'one'; route(); };
actions.payStep = (d) => { const p = payState(); const next = addDays(p.day, Number(d.n)); if (next <= me.business.shiftDay) { p.day = next; route(); } };
actions.payToday = () => { const p = payState(); p.mode = 'one'; p.day = me.business.shiftDay; route(); };
actions.payPick = (d, el) => {
  const v = el.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
  const p = payState();
  const today = me.business.shiftDay;
  p[d.k] = v > today ? today : v;
  if (p.mode === 'range') {
    if (p.from > p.to) [p.from, p.to] = [p.to, p.from];
    // Up to 7 shifts: a longer range keeps its last 7 days.
    if (addDays(p.from, PAY_MAX - 1) < p.to) { p.from = addDays(p.to, -(PAY_MAX - 1)); flash = { kind: 'warn', text: `Up to ${PAY_MAX} days at a time: showing ${dayName(p.from)} to ${dayName(p.to)}.` }; }
  }
  route();
};

// ---------- Payments › Bills (25 Nov 2026): every bill of a shift, filtered and searched; a tap opens the bill.
const BILL_FILTERS = [['', 'All'], ['topay', 'To pay'], ['room', 'To room'], ['credit', 'Credit'], ['nc', 'NC'], ['void', 'Void'], ['roominv', 'Room invoices']];
async function billsScreen(dayArg) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayArg ?? '') ? dayArg : me.business.shiftDay;
  const r = await api('GET', `${B()}/bill-list?day=${day}`);
  // Room invoices (made at check-out) sit in the same list, marked Room; a tap opens the guest's room bill.
  r.bills = [...r.bills, ...(r.roomInvoices ?? []).map((i) => ({ id: i.id, roomInvoice: true, stayId: i.stayId, billNo: i.invoiceNo, status: 'settled', totalPaise: i.totalPaise, printedAt: i.at,
    place: i.room, guestName: i.billToName ? `${i.guestName} · ${i.billToName}` : i.guestName, modes: [], creditNotes: i.creditNotes, inv: i }))].sort((x, y) => y.printedAt - x.printedAt);
  // How each line was paid (26 Nov 2026): a room invoice by the money taken on its room bill, prepaid or moved to an
  // account; a bill on a room as on the room bill until that guest checks out, then paid with the room invoice.
  const roomNo = (b) => (b.roomPlace ?? b.room?.split(' · ')[0] ?? '').replace(/^Room /, '');
  const roomPaidWith = (b) => b.modes.includes('room') && b.roomOut;
  const kindOf = (b) => (b.roomInvoice ? 'roominv' : b.status === 'void' ? 'void' : b.status === 'printed' ? 'topay' : b.modes.includes('comp') ? 'nc'
    : b.modes.includes('room') && !roomPaidWith(b) ? 'room' : b.modes.includes('credit') ? 'credit' : 'paid');
  const invState = (i) => (i.movedPaise > 0 ? ['warn', 'On credit'] : i.paid.length ? ['ok', 'Paid'] : i.prepaidPaise > 0 ? ['ok', 'Prepaid'] : ['ok', 'Paid']);
  const sub = (t) => html`<div class="small quiet">${t}</div>`;
  const paidBy = (b) => {
    if (b.roomInvoice) {
      const i = b.inv;
      const parts = [...i.paid.map((p) => `${PAID_BY[p.mode] ?? p.mode} ${rs(p.amountPaise)}`), ...(i.prepaidPaise ? [`Prepaid${i.prepaidTo ? ` · ${i.prepaidTo}` : ''} ${rs(i.prepaidPaise)}`] : []),
        ...(i.movedPaise ? [`On credit · ${i.movedTo.join(', ') || 'account'} ${rs(i.movedPaise)}`] : [])];
      const notes = ['room invoice', i.foodBills ? `includes ${plural(i.foodBills, 'food bill')}` : '', b.creditNotes ? plural(b.creditNotes, 'credit note') : ''].filter(Boolean).join(' · ');
      return html`${parts.join(' · ') || 'Nothing to collect'}${sub(notes)}`;
    }
    if (b.status === 'void') return html`<span class="quiet">—</span>`;
    if (b.status === 'printed') return html`<span class="quiet">not paid</span>`;
    return html`${b.modes.map((m) => (m === 'room' ? (b.roomOut ? `With room ${roomNo(b)}` : `To room ${roomNo(b)}`) : m === 'credit' && b.credit ? `On credit · ${b.credit}` : PAID_BY[m] ?? m)).join(' + ')}${
      b.modes.includes('room') ? sub(b.roomOut ? (b.roomInvoiceNo ? `room invoice ${b.roomInvoiceNo}` : 'paid at check-out') : 'on the room bill, not paid yet') : ''}${
      b.modes.includes('credit') && b.creditOwesPaise != null ? sub(b.creditOwesPaise > 0 ? `account owes ${rs(b.creditOwesPaise)}` : 'account paid up') : ''}`;
  };
  const tone = { void: ['bad', 'Void'], topay: ['warn', 'To pay'], nc: ['mute', 'NC'], room: ['info', 'On room bill'], credit: ['warn', 'On credit'], paid: ['ok', 'Paid'], roominv: ['info', 'Room'] };
  const stateOf = (b) => (b.roomInvoice ? invState(b.inv) : kindOf(b) === 'paid' && roomPaidWith(b) ? ['ok', 'Paid with room'] : tone[kindOf(b)]);
  rerender = () => {
    const f = ui.bF ?? '';
    const q = String(ui.bQ ?? '').trim().toLowerCase();
    const shown = r.bills.filter((b) => (!f || kindOf(b) === f) && (!q || `${b.billNo} ${b.place} ${b.guestName ?? ''}`.toLowerCase().includes(q)));
    const live = r.bills.filter((b) => b.status !== 'void' && !b.roomInvoice);
    const n = (k) => r.bills.filter((b) => kindOf(b) === k).length;
    paint(shell('#/payments', html`${pageHead(`Payments · ${dayName(day)}`, 'Every bill of the shift, restaurant and room. Tap a restaurant bill to open it (a copy, take payment if unpaid, give money back); a room invoice opens the guest\'s room bill.')}
      ${tabsNav('Payments', PROOF_TABS.map(([k, t]) => [k ? `#/payments/${k}` : '#/payments', t, k]), 'bills')}
      <div class="row" style="align-items:end;flex-wrap:wrap;margin-bottom:12px"><a class="btn" href="#/payments/bills/${addDays(day, -1)}" aria-label="Previous shift">‹</a>
        <label class="f">Shift<input class="in" type="date" data-model="bDay" value="${ui.bDay ?? day}" style="width:auto"></label>
        <a class="btn" href="#/payments/bills/${addDays(day, 1)}" aria-label="Next shift">›</a><button class="btn" type="button" data-act="bDayGo">Show</button>
        <input class="in grow" type="search" data-model="bQ" data-live value="${ui.bQ ?? ''}" placeholder="Search bill no., table or guest" aria-label="Search bills" style="flex:1 1 220px"></div>
      <div class="kpis">${kpi('Restaurant bills', String(live.length), `${rs(live.reduce((t, b) => t + b.totalPaise, 0))} with GST`)}${n('roominv') ? kpi('Room invoices', String(n('roominv')), rs(r.bills.filter((b) => b.roomInvoice).reduce((t, b) => t + b.totalPaise, 0))) : ''}${kpi('To pay', String(n('topay')), n('topay') ? 'printed, not paid' : 'none', n('topay') ? 'warn' : '')}
        ${kpi('On room or credit', String(n('room') + n('credit')), 'paid later')}${kpi('Void', String(n('void')), '', n('void') ? 'warn' : '')}</div>
      <div class="chips" style="margin-bottom:10px">${BILL_FILTERS.map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${f === k}" data-act="pick" data-k="bF" data-id="${k}">${t}${k ? ` ${n(k)}` : ` ${r.bills.length}`}</button>`)}</div>
      <section class="panel">${shown.length ? html`<div class="scroll"><table class="t cards"><thead><tr><th>Time</th><th>Bill</th><th>Table / room</th><th>Guest</th><th class="num">Amount</th><th>Paid by</th><th>Status</th></tr></thead><tbody>
        ${shown.map((b) => b.roomInvoice ? html`<tr class="rowlink" data-act="counterBill" data-id="${b.stayId}" style="cursor:pointer"><td data-label="Time">${time(b.printedAt)}</td><td data-label="Bill" class="mono"><span style="color:var(--pri);text-decoration:underline">${b.billNo}</span></td>
          <td data-label="Room">${b.place}</td><td data-label="Guest">${b.guestName ?? ''}</td><td class="num" data-label="Amount">${rs(b.totalPaise)}</td><td data-label="Paid by">${paidBy(b)}</td><td data-label="Status"><span class="status ${stateOf(b)[0]}">${stateOf(b)[1]}</span></td></tr>`
          : html`<tr class="rowlink" data-act="goTo" data-href="#/done/${b.id}" style="cursor:pointer"><td data-label="Time">${time(b.printedAt)}</td><td data-label="Bill" class="mono"><a href="#/done/${b.id}">${b.billNo}</a></td>
          <td data-label="Table">${b.place}</td><td data-label="Guest">${b.guestName ?? ''}${b.phone ? html`<div class="small quiet">${b.phone}</div>` : ''}</td><td class="num" data-label="Amount">${rs(b.totalPaise)}</td>
          <td data-label="Paid by">${paidBy(b)}</td><td data-label="Status"><span class="status ${stateOf(b)[0]}">${stateOf(b)[1]}</span></td></tr>`)}</tbody></table></div>`
        : html`<p class="empty">${r.bills.length ? 'No bill matches.' : 'No bills in this shift.'}</p>`}</section>`));
  };
  rerender();
}
actions.bDayGo = () => go(`#/payments/bills/${ui.bDay ?? me.business.shiftDay}`);

async function creditScreen() {
  await load('credit', 'payAccounts');
  rerender = () => paint(shell('#/credit', html`${pageHead('Credit', 'Credit accounts: what each owes, how old it is, and payments.')}
    ${cache.credit.length ? html`<div class="kpis">${kpi('Owed to you', rs(cache.credit.reduce((t, a) => t + Math.max(0, a.balancePaise), 0)), plural(cache.credit.filter((a) => a.balancePaise > 0).length, 'account'))}
      ${kpi('Unpaid over 30 days', String(cache.credit.filter((a) => (a.oldestDays ?? 0) > 30).length), 'accounts', cache.credit.some((a) => (a.oldestDays ?? 0) > 30) ? 'bad' : '')}
      ${kpi('Advances held', rs(cache.credit.reduce((t, a) => t + Math.max(0, -a.balancePaise), 0)))}</div>` : ''}
    ${moneyForms()}
    <section class="panel">${ui.recv || ui.refund ? '' : errorBox()}
      <div class="row" style="margin-bottom:8px"><input class="in" type="search" data-model="crQ" data-live value="${ui.crQ ?? ''}" placeholder="Search name or phone" aria-label="Search credit accounts" style="flex:0 1 320px"></div>
      <div class="scroll"><table class="t cards"><thead><tr><th data-sort>Name</th><th class="num" data-sort>Owes</th><th class="num" data-sort>Oldest unpaid</th><th class="num" data-sort>Limit</th><th></th></tr></thead><tbody>
        ${cache.credit.length ? '' : html`<tr><td colspan="5"><p class="empty">No credit accounts yet. One is made when a bill is settled on credit.</p></td></tr>`}
        ${cache.credit.filter((a) => !ui.crQ || `${a.name} ${a.phone ?? ''}`.toLowerCase().includes(String(ui.crQ).toLowerCase())).map((a) => html`<tr>
          <td data-label="Name"><strong>${a.name}</strong>${a.phone ? html`<div class="small quiet">${a.phone}</div>` : ''}</td><td class="num" data-label="Owes" data-v="${a.balancePaise}">${rs(a.balancePaise)}</td>
          <td class="num" data-label="Oldest unpaid" data-v="${a.oldestDays ?? -1}">${a.oldestDays === null || a.oldestDays === undefined ? '—' : html`<span class="status ${a.oldestDays > 30 ? 'bad' : a.oldestDays > 7 ? 'warn' : 'mute'}">${plural(a.oldestDays, 'day')}</span>`}</td>
          <td class="num" data-label="Limit">${a.creditLimitPaise ? rs(a.creditLimitPaise) : '—'}</td>
          <td class="act"><div class="row">${can('debtors.receive') ? html`<button class="btn pri" type="button" data-act="recv" data-id="${a.id}" data-n="${a.name}">Take payment</button>` : ''}
            ${a.balancePaise < 0 && can('debtors.receive') ? html`<button class="btn" type="button" data-act="refundAsk" data-id="${a.id}" data-n="${a.name}" data-max="${-a.balancePaise}">Refund advance</button>` : ''}</div></td></tr>`)}
      </tbody></table></div><p class="small quiet">New credit accounts are made at the settle screen. Every payment prints a numbered receipt. A negative amount owed is an advance.</p>
    </section>`));
  rerender();
}
// One room, or several for one guest (24 Nov 2026): the first chosen holds the bill, the others are checked in with it.
actions.pickRoom = (d) => {
  ui.error = null;
  const extra = ui.ciRooms ?? [];
  if (!ui.ciMulti) { ui.room = d.name; ui.ciRooms = []; rerender(); return; }
  if (ui.room === d.name) { ui.room = extra[0] ?? null; ui.ciRooms = extra.slice(1); }
  else if (extra.includes(d.name)) ui.ciRooms = extra.filter((x) => x !== d.name);
  else if (!ui.room) ui.room = d.name;
  else ui.ciRooms = [...extra, d.name];
  rerender();
};
// One bed of a group leaves before the others (24 Nov 2026): its bill stays on the first room.
actions.bedOut = async (d) => {
  if (!confirm(`Check out ${d.r} only? The bill stays on this room.`)) return;
  await api('POST', `${B()}/stays/${d.id}/check-out`, {});
  ui.roomBill = await api('GET', `${B()}/stays/${ui.roomBill.stay.id}/bill`); await load('stays');
  flash = { kind: 'ok', text: `${d.r} checked out and marked dirty.` }; rerender();
};
// Ticking "already left" lets Djubo's room be used even when taken today (a past stay); unticking needs a free room.
actions.ciOutTog = (_d, el) => {
  ui.ciOutToo = !!el.checked;
  const busy = (t) => (cache.stays ?? []).some((x) => roomKeyOf(x.room) === roomKeyOf(t));
  const hits = ui.ciHits ?? [];
  const usable = ui.ciOutToo ? hits : hits.filter((t) => !busy(t));
  ui.ciTaken = ui.ciOutToo ? [] : hits.filter(busy);
  if (hits.length) { ui.room = usable[0] ?? null; ui.ciRooms = usable.slice(1); }
  rerender();
};
/** A booking that continues a guest already in house (25 Nov 2026): pairs each of their rooms with one Djubo gives. */
function ctPrepare(a, hits) {
  if (!hits) {
    const flat = (t) => String(t).toLowerCase().replace(/\s+/g, '');
    const names = (ui.roomSecs ?? []).flatMap((x) => x.tables ?? []);
    hits = [...new Set((a.roomLabels ?? '').split(',').map(flat).filter(Boolean).map((l) => names.find((t) => flat(t) === l)).filter(Boolean))];
  }
  if (a.continues) {
    const left = [...hits];
    const pairs = a.continues.map((x) => ({ ...x, djubo: null }));
    for (const p of pairs) { const i = left.indexOf(p.room); if (i >= 0) { p.djubo = p.room; left.splice(i, 1); } }
    for (const p of pairs) if (!p.djubo && left.length) p.djubo = left.shift();
    ui.ctPairs = pairs; ui.ctExtra = left;
    for (const p of pairs) {
      const takenBy = p.djubo && p.djubo !== p.room ? (cache.stays ?? []).find((x) => roomKeyOf(x.room) === roomKeyOf(p.djubo) && !a.continues.some((y) => y.id === x.id)) : null;
      p.takenBy = takenBy?.guestName ?? null;
      ui[`ct_${p.id}`] = p.djubo && p.djubo !== p.room && !takenBy ? 'move' : 'keep';
    }
  } else { ui.ctPairs = null; ui.ctExtra = null; }
}
/** The extension box (25 Nov 2026): the guest's rooms against Djubo's, a choice where they differ, and one button. */
function continueBox(a) {
  const pairs = ui.ctPairs ?? [];
  return html`<div class="msg ok" style="display:block;margin-top:8px"><strong>${a.guestName} is already in house: this booking continues the stay.</strong>
    <div class="small">Djubo made the extension as a new booking. It is added to the guest's stay: the stay runs to ${dayName(a.checkOut)}, its rent goes on the bill of ${pairs[0]?.room ?? 'the first room'}, and the booking leaves the arrivals.</div>
    ${pairs.map((p) => html`<div class="line" style="gap:8px;border-top:1px solid var(--go-line);padding:6px 0;flex-wrap:wrap"><span class="grow"><strong>${p.room}</strong> · ${p.guestName}${p.djubo ? (p.djubo === p.room ? html` <span class="status ok">Djubo has ${p.djubo} too</span>` : html` <span class="status warn">Djubo has ${p.djubo}</span>`) : html` <span class="status mute">no room in Djubo for it</span>`}</span>
      ${p.djubo && p.djubo !== p.room ? (p.takenBy ? html`<span class="small">${p.djubo} has ${p.takenBy}: keeps ${p.room} (change it in Djubo, or free ${p.djubo} first)</span>`
        : html`<span class="chips"><button type="button" class="chip" aria-pressed="${ui[`ct_${p.id}`] === 'move'}" data-act="pick" data-k="ct_${p.id}" data-id="move">Move to ${p.djubo} (Djubo's room)</button>
          <button type="button" class="chip" aria-pressed="${ui[`ct_${p.id}`] === 'keep'}" data-act="pick" data-k="ct_${p.id}" data-id="keep">Keep ${p.room} (change it in Djubo)</button></span>`) : ''}</div>`)}
    ${(ui.ctExtra ?? []).length ? html`<div class="small" style="margin-top:4px">Djubo also has ${ui.ctExtra.join(', ')} for this booking: check that room in separately if the guest takes it.</div>` : ''}
    <div class="row" style="margin-top:8px"><button class="btn pri" type="button" data-act="ciContinue" data-id="${a.id}">Extend the stay to ${dayName(a.checkOut)}</button></div></div>`;
}
actions.ciContinue = async (d) => {
  const pairs = ui.ctPairs ?? [];
  const bill = await api('POST', `${B()}/bookings/${d.id}/continue`, { stays: pairs.map((p) => ({ id: p.id, moveTo: ui[`ct_${p.id}`] === 'move' ? p.djubo : undefined })) });
  const moved = pairs.filter((p) => ui[`ct_${p.id}`] === 'move');
  reopenStay = bill.stay.id;
  flash = { kind: 'ok', text: `Stay extended${moved.length ? `; moved ${moved.map((p) => `${p.room} → ${p.djubo}`).join(', ')}` : ''}. The booking's rent is on ${bill.stay.room}'s bill.` };
  await refreshDeskAlerts(); go('#/rooms');
};
actions.ciMultiTog = () => { ui.ciMulti = !ui.ciMulti; if (!ui.ciMulti) ui.ciRooms = []; rerender(); };
// A phone number typed at check-in finds a returning guest: their name and city fill in, and their earlier stays show.
actions.gLookup = async (_d, el) => {
  const digits = el.value.replace(/\D/g, '');
  if (digits.length < 6) { ui.gFound = null; rerender(); return; }
  const r = await api('GET', `${B()}/guests/lookup?phone=${encodeURIComponent(el.value)}`);
  ui.gFound = r.guest;
  if (r.guest) { ui.guest = r.guest.name; ui.gCity = r.guest.city ?? ''; }
  rerender();
};
actions.checkOut = async (d) => {
  const st = ui.roomBill?.stay;
  const co = ui.coCo ?? !!st?.company;
  const r = await api('POST', `${B()}/stays/${d.id}/check-out`, { ...(co ? { billTo: { name: ui.coName ?? st?.company ?? '', gstin: ui.coGstin ?? st?.gstin ?? '', address: ui.coAddr ?? '' } } : {}),
    ...(ui.approvers?.length && ui.apPin ? { approverId: ui.apId, approverPin: ui.apPin } : {}) });
  // The stay's tax invoice for the room rent prints at check-out (24 Nov 2026).
  if (r.bill?.invoice) printJobs([{ kind: 'bill', html: asHtml(roomInvoiceSlip(r.bill)) }]);
  ui.roomBill = null;
  flash = { kind: 'ok', text: `Checked out.${r.bill?.invoice ? ` Invoice ${r.bill.invoice.invoiceNo} printed.` : ''}` }; route();
};
actions.recv = (d) => { ui.recv = { id: d.id, name: d.n, room: !!d.room }; ui.refund = null; ui.recvMode = 'cash'; ui.recvKind = d.kind ?? 'receipt'; ui.recvAmount = d.amount ?? undefined; ui.error = null; rerender(); scrollTo(0, 0); };
actions.recvNo = () => { ui.recv = null; rerender(); };
actions.refundAsk = (d) => { ui.refund = { id: d.id, name: d.n, max: Number(d.max) }; ui.recv = null; ui.refundAmount = undefined; ui.refundMode = 'cash'; ui.error = null; rerender(); };
actions.refundNo = () => { ui.refund = null; rerender(); };
actions.refundGo = async () => {
  const r = await api('POST', `${B()}/debtors/${ui.refund.id}/refund`, { mode: ui.refundMode ?? 'cash', amount: ui.refundAmount ?? rupees(ui.refund.max), note: ui.refundNote });
  reopenStay = ui.roomBill?.stay.id ?? null;
  flash = { kind: 'ok', text: `Refunded. ${ui.refund.name} now ${r.balancePaise < 0 ? 'holds ' + rs(-r.balancePaise) + ' of advance' : 'owes ' + rs(r.balancePaise)}.` }; route();
};
actions.recvGo = async () => {
  const p = { mode: ui.recvMode ?? 'cash', amount: ui.recvAmount ?? '', payAccountId: ui.payAccountId, cardApproval: ui.cardApproval, cardLast4: ui.cardLast4 };
  const r = await api('POST', `${B()}/debtors/${ui.recv.id}/receipts`, { kind: ui.recvKind ?? 'receipt', payments: [p] });
  // Every payment on a room or account gets its numbered receipt (24 Nov 2026).
  if (r.receipt) printJobs([{ kind: 'bill', html: asHtml(receiptSlip(r.receipt)) }]);
  flash = { kind: 'ok', text: `${r.receipt?.receiptNo ? r.receipt.receiptNo + ': ' : ''}${ui.recv.name} ${r.balancePaise < 0 ? 'holds ' + rs(-r.balancePaise) : 'now owes ' + rs(r.balancePaise)}.` };
  reopenStay = ui.roomBill?.stay.id ?? null;
  route();
};

// ---------- shift close

// ---------- Day close › Takings (26 Nov 2026): "Close" (today's money by type, then the steps to close) and "Breakdown"
// (a table of money in by type and where from; a tap on an amount lists the bills and receipts behind it).
const TK_MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']];
const tkOf = (rows, mode) => rows.find((x) => x.mode === mode)?.paise ?? 0;
/** Money given back the same day by this mode (26 Nov 2026): refunds from the drawer and credit-note refunds, taken off takings. */
const tkBack = (s, mode) => (s.drawerOuts ?? []).filter((o) => o.kind === 'refund' && o.mode === mode).reduce((t, o) => t + o.amountPaise, 0)
  + (s.creditNotes ?? []).filter((n) => n.refundMode === mode).reduce((t, n) => t + n.totalPaise, 0);
function takingsClose(s) {
  const tot = TK_MODES.map(([m, t]) => ({ m, t, bills: tkOf(s.byMode, m), rooms: tkOf(s.receipts, m), back: tkBack(s, m) }));
  const all = tot.reduce((x, r) => x + r.bills + r.rooms - r.back, 0);
  const notMoney = [['room', 'on rooms'], ['credit', 'on credit']].map(([m, t]) => [t, tkOf(s.byMode, m)]).filter(([, v]) => v);
  const look = [...s.events.filter((e) => e.n).map((e) => `${{ void: 'Voids', reprint: 'Reprints', kot_cancel: 'Cancelled KOT lines', discount: 'Discounts', comp: 'Complimentary', limit_warning: 'Limit warnings', credit_note: 'Credit notes', stock_waste: 'Stock breakage', stock_count: 'Stock count variances', pay_change: 'Payment type changed' }[e.kind] ?? e.kind} ${e.n}`),
    ...(s.tips.length ? [`Tips ${rs(s.tips.reduce((t, x) => t + x.paise, 0))}`] : []), ...(s.discountsAtPayment.n ? [`Discounts at payment ${s.discountsAtPayment.n}`] : []),
    ...(s.drawerOuts.length ? [`Paid out ${rs(s.drawerOuts.reduce((t, o) => t + o.amountPaise, 0))}`] : [])];
  const billed = s.billed.reduce((t, b) => t + b.paise, 0);
  const step = (n, title, sub, value) => html`<div class="tkstep"><span class="tkn">${n}</span><div><strong>${title}</strong><div class="small quiet">${sub}</div></div><div class="tkv">${value}</div></div>`;
  return html`<div class="tkcards">${tot.map((r) => html`<div class="tkcard"><span class="l">${r.t}</span><span class="v">${rs(r.bills + r.rooms - r.back)}</span><span class="s">bills ${rs(r.bills)} · rooms ${rs(r.rooms)}${r.back ? ` · given back −${rs(r.back)}` : ''}</span></div>`)}</div>
    <div class="tkbig"><span>Money in today</span><span>${rs(all)}</span></div>
    <p class="label" style="margin:6px 0 0">To close the day</p>
    <div>${ui.countOn ? step(1, 'Count the cash drawer', 'Use the "Count the cash drawer" form. What the drawer should hold shows after you count.', '') : ''}
      ${step(ui.countOn ? 2 : 1, s.byAccount.length === 1 ? `Match UPI in the ${s.byAccount[0].name} app` : 'Match UPI in each bank app', s.byAccount.length > 1 ? s.byAccount.map((a) => `${a.name} ${rs(a.paise)}`).join(' · ') : 'all UPI today, bills and rooms, less refunds', rs(tot[1].bills + tot[1].rooms - tot[1].back))}
      ${step(ui.countOn ? 3 : 2, 'Card machine settlement', tot[2].bills + tot[2].rooms ? 'all card payments today, bills and rooms' : 'no card payments today', rs(tot[2].bills + tot[2].rooms - tot[2].back))}
      ${step(ui.countOn ? 4 : 3, 'Bills printed today', html`${s.billed.map((b) => `${b.first} to ${b.last}${b.voids ? ` (${b.voids} void)` : ''}`).join(' · ') || 'no bills'}${notMoney.length ? ` · ${notMoney.map(([t, v]) => `${rs(v)} ${t}, not money yet`).join(' · ')}` : ''}${s.unpaidBills.length ? html` · <span style="color:var(--warn)">${plural(s.unpaidBills.length, 'bill')} not paid yet</span>` : s.billed.length ? html` · all paid <span style="color:var(--go)">✓</span>` : ''}`, rs(billed))}
      ${step(ui.countOn ? 5 : 4, 'Anything to look at', look.length ? look.join(' · ') : 'voids, discounts, credit notes, cancelled KOTs, paid out', look.length ? html`<button type="button" class="chip" data-act="pick" data-k="tkTab" data-id="detail">See breakdown</button>` : html`<span class="status mute">none</span>`)}</div>`;
}
function takingsTable(s) {
  const pays = s.payments ?? [];
  const cell = (m, k, v) => (v ? html`<button type="button" class="tkcell" aria-pressed="${ui.tkList === `${m}:${k}`}" data-act="pick" data-k="tkList" data-id="${ui.tkList === `${m}:${k}` ? '' : `${m}:${k}`}">${rs(v)}</button>` : html`<span class="quiet">${rs(0)}</span>`);
  const rows = TK_MODES.map(([m, t]) => ({ m, t: m === 'upi' && s.byAccount.length === 1 ? `UPI · ${s.byAccount[0].name}` : t, bills: tkOf(s.byMode, m), rooms: tkOf(s.receipts, m), back: tkBack(s, m) }));
  const [lm, lk] = (ui.tkList ?? '').split(':');
  const listed = lm ? pays.filter((p) => p.mode === lm && (lk === 'all' || (lk === 'bills' ? p.kind === 'bills' : p.kind !== 'bills'))) : [];
  const ref = (p) => (p.kind === 'bills' ? html`<a href="#/done/${p.billId}">${p.bills}</a>`
    : p.stayId ? html`<button type="button" class="linkbtn" data-act="counterBill" data-id="${p.stayId}">${p.receiptNo ?? 'Receipt'}</button>` : html`<span>${p.receiptNo ?? 'Receipt'}</span>`);
  const what = (p) => (p.kind === 'bills' ? p.place ?? '' : p.account ?? (p.advGuest ? `Advance · ${p.advGuest}` : ''));
  const notMoney = [['room', 'To room (not paid yet)'], ['credit', 'On credit'], ['comp', 'Complimentary'], ['advance', 'Paid from advances taken earlier']].map(([m, t]) => [t, tkOf(s.byMode, m)]).filter(([, v]) => v);
  return html`<div class="scroll"><table class="t"><thead><tr><th>Money in</th><th class="num">Restaurant bills</th><th class="num">Rooms and credit</th><th class="num">Total today</th></tr></thead><tbody>
    ${rows.map((r) => html`<tr><td>${r.t}</td><td class="num">${cell(r.m, 'bills', r.bills)}</td><td class="num">${cell(r.m, 'rooms', r.rooms)}</td><td class="num"><strong>${cell(r.m, 'all', r.bills + r.rooms)}</strong></td></tr>`)}
    ${rows.some((r) => r.back) ? html`<tr><td>Given back (refunds)</td><td></td><td></td><td class="num">${rows.filter((r) => r.back).map((r) => `${r.t} −${rs(r.back)}`).join(' · ')}</td></tr>` : ''}
    <tr class="tktot"><td>Total</td><td class="num">${rs(rows.reduce((t, r) => t + r.bills, 0))}</td><td class="num">${rs(rows.reduce((t, r) => t + r.rooms, 0))}</td><td class="num">${rs(rows.reduce((t, r) => t + r.bills + r.rooms - r.back, 0))}</td></tr></tbody></table></div>
    ${lm ? html`<div class="tklist"><div class="row between"><strong>${{ cash: 'Cash', upi: 'UPI', card: 'Card' }[lm]} · ${{ bills: 'restaurant bills', rooms: 'rooms and credit', all: 'all today' }[lk]} · ${listed.length}</strong>
        <button type="button" class="btn" data-act="pick" data-k="tkList" data-id="">Close</button></div>
      <div class="scroll"><table class="t"><tbody>${listed.map((p) => html`<tr><td>${time(p.at)}</td><td>${ref(p)}${p.kind !== 'bills' ? html`${rcTag(p.cancelled)}${rcBtn(p.settlementId, p.cancelled)}` : ''}</td><td>${what(p)}</td><td class="num" style="${p.cancelled ? 'text-decoration:line-through' : ''}">${rs(p.amountPaise)}</td></tr>`)}</tbody></table></div>
      <p class="small quiet">Tap a bill number to open the bill, or a receipt number to open the room bill.</p></div>` : html`<p class="small quiet">Tap an amount to list the bills and receipts behind it.</p>`}
    ${(s.cancelledReceipts ?? []).length ? html`<div class="sums"><div><strong>Receipts cancelled today (not counted above)</strong></div>${s.cancelledReceipts.map((x) => html`<div><span>${x.receiptNo ?? 'Receipt'} · ${x.who ?? ''} · ${x.reason}${x.byName ? ` · by ${x.byName}` : ''}</span><span>${rs(x.totalPaise)}</span></div>`)}</div>` : ''}
    ${notMoney.length ? html`<div class="sums"><div><strong>Not money yet, or counted on another day</strong></div>${notMoney.map(([t, v]) => html`<div><span>${t}</span><span>${rs(v)}</span></div>`)}</div>` : ''}`;
}
async function shiftScreen() {
  // The day moves on at its hour or when it is closed by hand (24 Nov 2026): read the current one afresh.
  try { me = await api('GET', '/me'); } catch { /* keep the one we have */ }
  const day = me.business.shiftDay;
  const [d] = await Promise.all([api('GET', `${B()}/shifts/${day}`), load('payAccounts').catch(() => null)]);
  ui.s = d.summary; ui.closed = d.closed; ui.counts = {}; ui.last = d.lastClosed; ui.endsAt = d.endsAt; ui.dz = d.drawer; ui.floatSet = d.floatPaise; ui.overdue = d.overdue; ui.notIn = d.notCheckedIn ?? []; ui.countOn = d.drawerCount !== false;
  const notes = NOTE_VALUES;
  rerender = () => {
    const s = ui.s;
    const counted = notes.reduce((t, n) => t + (Number(ui.counts[n]) || 0) * Number(n) * 100, 0) + (toPaise(ui.loose || '0') ?? 0);
    const modeName = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Posted to rooms', credit: 'On credit', comp: 'Complimentary', advance: 'Advances used' };
    const carried = [...s.openOrders.map((o) => o.place), ...s.unpaidBills.map((x) => `${x.place ?? ''} ${x.bill_no}`.trim())];
    const djOpen = (s.djubo ?? []).filter((x) => !x.settlementId);
    const block = ui.overdue.length + (s.notInDjubo?.length ?? 0) + (s.deskMissing?.length ?? 0) + djOpen.length + (s.notCharged?.length ?? 0) + (s.waitingRoom?.length ?? 0);
    const cd = ui.countDiff;
    // Counting turned off (26 Nov 2026): the page is the takings and what is pending, and Close the day closes it.
    // Refunds given back today come off (26 Nov 2026): a receipt taken by mistake and refunded nets to nothing.
    const moneyIn = [...s.byMode, ...s.receipts].filter((m) => ['cash', 'upi', 'card'].includes(m.mode)).reduce((t, m) => t + m.paise, 0) - ['cash', 'upi', 'card'].reduce((t, m) => t + tkBack(s, m), 0);
    const cashIn = [...s.byMode, ...s.receipts].filter((m) => m.mode === 'cash').reduce((t, m) => t + m.paise, 0) - tkBack(s, 'cash');
    const upiIn = [...s.byMode, ...s.receipts].filter((m) => m.mode === 'upi').reduce((t, m) => t + m.paise, 0) - tkBack(s, 'upi');
    const billedPaise = s.billed.reduce((t, b) => t + b.paise, 0);
    const openPaise = s.openOrders.reduce((t, o) => t + o.paise, 0);
    paint(shell('#/shift', html`${pageHead(`Day close · ${dayName(s.shiftDay)}`, ui.countOn ? `The day runs ${me.business.shift_start_hour} am to ${me.business.shift_start_hour} am. Count the drawer, check the day, then close it. Closing does not change who holds the drawer.`
        : `The day runs ${me.business.shift_start_hour} am to ${me.business.shift_start_hour} am. Check what is pending and today's takings, then close the day. It closes by itself at ${me.business.shift_start_hour} am if nobody does.`)}
      ${ui.countOn ? '' : html`<div class="kpis">${kpi('Money in today', rs(moneyIn), `cash ${rs(cashIn)} · UPI ${rs(upiIn)}`)}
        ${kpi('Bills printed', String(s.billed.reduce((t, b) => t + b.n - b.voids, 0)), `${rs(billedPaise)}${s.unpaidBills.length ? ` · ${plural(s.unpaidBills.length, 'bill')} not paid` : s.billed.length ? ' · all paid' : ''}`)}
        ${kpi('Tables carried on', String(s.openOrders.length), s.openOrders.length ? `${rs(openPaise)} open` : 'none open')}
        ${ui.overdue.length ? kpi('Open since an earlier day', String(ui.overdue.length), 'clear before closing', 'bad') : ''}</div>`}
      ${ui.countOn ? html`<div class="kpis">${kpi('Cash drawer', ui.dz ? ui.dz.holder : 'Nobody yet', ui.dz ? `since ${dateTime(ui.dz.since)}` : 'starts with the next cash')}
        ${kpi('Float kept', ui.floatSet ? rs(ui.floatSet) : 'Not set', ui.floatSet ? 'the rest goes to the safe' : 'set it in Settings, Staff')}
        ${kpi('Tables carried on', String(carried.length), carried.length ? 'into the next day, with their holder' : 'none open')}
        ${ui.overdue.length ? kpi('Open since an earlier day', String(ui.overdue.length), 'clear before closing', 'bad') : ''}</div>` : ''}
      ${!ui.countOn && s.openOrders.length ? html`<div class="msg warn" style="display:block;margin-bottom:12px"><strong>${plural(s.openOrders.length, 'table')} still open · ${rs(openPaise)}</strong>
        <div class="small">${[...s.openOrders].sort((a, b) => b.paise - a.paise).map((o) => `${o.place} ${rs(o.paise)}`).join(' · ')}. They carry into ${dayName(addDays(s.shiftDay, 1))}; their sale counts on the day the bill prints.</div>
        <div class="row" style="margin-top:6px"><a class="btn" href="#/">Go to Tables</a></div></div>` : ''}
      ${ui.notIn.length && can('stays.edit') ? html`<div class="msg warn" style="display:block;margin-bottom:12px"><strong>Arrivals not checked in: ${ui.notIn.length}</strong> · check each in (late, if the guest has left), or mark a no-show.
        <div class="small">${ui.notIn.slice(0, 12).map((x) => `${x.guestName ?? 'No name'}${x.roomLabels ? ` (${x.roomLabels})` : ''} · ${dayName(x.checkIn)}`).join(' · ')}${ui.notIn.length > 12 ? ` · and ${ui.notIn.length - 12} more` : ''}</div>
        <div class="row" style="margin-top:6px"><a class="btn" href="#/rooms/checkin">Go to Check-in</a><a class="btn ghost" href="#/rooms/audit">Night audit (no-shows)</a></div></div>` : ''}
      ${ui.countOn && ui.last && !ui.last.countedAt ? html`<section class="panel blockers"><div class="bh"><h2>${dayName(ui.last.shiftDay)} closed by itself</h2><span class="status warn">Drawer not counted</span></div>
        <p class="small">It closed at ${dateTime(ui.last.closedAt)}. Its cash is still in ${ui.dz ? `${ui.dz.holder}'s` : 'the'} drawer: count it now, or it is counted at the next handover.</p>
        <div class="row"><a class="btn pri" href="#/handover/count">Count the drawer now</a></div></section>` : ''}
      ${block ? html`<section class="panel blockers"><div class="bh"><h2>Before you close</h2><span class="status bad">${block}</span></div>
        ${(s.waitingRoom ?? []).length ? html`<div class="msg bad" style="display:block"><strong>Waiting for a room: ${s.waitingRoom.map((x) => x.guestName).join(', ')}</strong>
          <div class="small">Checked in with no room yet. Give each a room (Rooms › Today, Give room) before the day closes.</div>
          <div class="row" style="margin-top:6px"><a class="btn" href="#/rooms">Go to Rooms</a></div></div>` : ''}
        ${(() => {
          // Rent till today means they leave today (28 Nov 2026): not "no rent" until they are still here at the close.
          const past = (s.notCharged ?? []).filter((x) => x.coveredTo < s.shiftDay);
          const leaving = (s.notCharged ?? []).filter((x) => x.coveredTo >= s.shiftDay);
          const names = (l) => l.map((x) => `${x.room} · ${x.guestName}`).join(', ');
          return html`${past.length ? html`<div class="msg bad" style="display:block"><strong>No rent for tonight: ${names(past)}</strong>
            <div class="small">Staying past their booking (rent till ${past.map((x) => dayName(x.coveredTo)).join(', ')}). Extend in Djubo (the rent comes with its email, and Continue a new booking), or a manager extends without Djubo.</div>
            <div class="row" style="margin-top:6px"><a class="btn" href="#/rooms">Go to Rooms</a></div></div>` : ''}
          ${leaving.length ? html`<div class="msg warn" style="display:block"><strong>Leaving today, not checked out yet: ${names(leaving)}</strong>
            <div class="small">Check each out when they leave. If one stays tonight, extend in Djubo or a manager extends without Djubo. The day can't close while they are still in house without rent for tonight.</div>
            <div class="row" style="margin-top:6px"><a class="btn" href="#/rooms">Go to Rooms</a></div></div>` : ''}`;
        })()}
        ${djOpen.length ? html`<div class="msg warn" style="display:block"><strong>Taken in Djubo today, how it was paid not picked: ${plural(djOpen.length, 'payment')} · ${rs(djOpen.reduce((t, x) => t + x.amountPaise, 0))}</strong>
          <div class="small">Pick Cash, UPI or Card for each, in "Taken in Djubo today" below.</div></div>` : ''}
        ${ui.overdue.length ? html`<div class="msg bad" style="display:block"><strong>Open since an earlier day:</strong> ${ui.overdue.map((o) => `${o.place}${o.bill_no ? ` (${o.bill_no})` : ''} · since ${dayName(o.since)}`).join(', ')}
          <div class="small">Take payment, post to a room, put on credit, or void with a manager. <a href="#/">Go to Tables</a></div></div>` : ''}
        ${s.notInDjubo?.length ? html`<div class="msg bad" style="display:block"><strong>Reservations made here, not in Djubo yet: ${s.notInDjubo.length}</strong>
          ${s.notInDjubo.map((x) => html`<div class="small">${x.guestName} · ${x.rooms} · ${dayName(x.checkIn)} → ${dayName(x.checkOut)}${x.madeBy ? ` · made by ${x.madeBy}` : ''}</div>`)}
          <div class="small">Enter them in Djubo, or give a reason below.</div><div class="row" style="margin-top:6px"><a class="btn" href="#/rooms">Go to Rooms</a></div></div>` : ''}
        ${s.deskMissing?.length ? html`<div class="msg bad" style="display:block"><strong>Taken at reception in Djubo, not in the POS: ${rs(s.deskMissing.reduce((t, x) => t + x.pendingPaise, 0))}</strong>
          ${s.deskMissing.map((x) => html`<div class="small">Djubo ${x.extRef} · ${x.guestName ?? ''} · ${x.enteredBy ?? ''}, ${time(x.at)} · ${rs(x.pendingPaise)}</div>`)}
          <div class="small">Take it in Rooms so a receipt prints, or give a reason below.</div><div class="row" style="margin-top:6px"><a class="btn" href="#/rooms">Go to Rooms</a></div></div>` : ''}
      </section>` : ''}
      ${(s.djubo ?? []).length ? html`<section class="panel" style="margin-bottom:12px"><div class="row between"><h2>Taken in Djubo today · ${rs(s.djubo.reduce((t, x) => t + x.amountPaise, 0))}</h2>${djOpen.length ? html`<span class="status warn">${djOpen.length} to pick</span>` : html`<span class="status ok">All picked</span>`}</div>
        <p class="small quiet" style="margin:0">Marked in Djubo today by reception (not the booking team or the OTAs), for any stay date. Counted in today's takings once you pick how each was paid; the day can't close before.</p>
        ${s.djubo.map(djRow)}</section>` : ''}
      ${(s.advancesHeld ?? []).length ? html`<section class="panel" style="margin-bottom:12px"><div class="row between"><h2>Restaurant advances held · ${rs(s.advancesHeld.reduce((t, x) => t + x.leftPaise, 0))}</h2><span class="small quiet">not used on a bill yet</span></div>
        ${s.advancesHeld.map((x) => html`<div class="line" style="gap:8px;border-top:1px solid var(--line);padding:6px 0"><span class="grow small"><strong>${x.guestName}</strong> · ${x.orderId ? x.place : `party ${dayName(x.partyDay)}${x.partyTime ? `, ${x.partyTime}` : ''}`} · ${x.receipts ?? ''}</span><span class="num">${rs(x.leftPaise)}</span></div>`)}
        <p class="small quiet" style="margin:4px 0 0">Counted in takings on the day each was taken; using it on a bill later is not counted again.</p></section>` : ''}
      ${carried.length ? html`<p class="small quiet" style="margin-bottom:12px">Carrying into ${dayName(addDays(s.shiftDay, 1))}: ${carried.join(', ')}. Their sale stays on the day the bill was printed; the money counts when paid.</p>` : ''}
      <div class="two rev">
      <section class="panel"><div class="row between"><h2>Takings</h2><div class="chips">${[['close', 'Close'], ['detail', 'Breakdown']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${(ui.tkTab ?? 'close') === k}" data-act="pick" data-k="tkTab" data-id="${k}">${t}</button>`)}</div></div>
        ${ui.closed ? html`<div class="msg ok">Closed at ${dateTime(ui.closed.closedAt)} · counted ${rs(ui.closed.countedPaise)} · difference ${rs(ui.closed.differencePaise)}</div>` : ''}
        ${(ui.tkTab ?? 'close') === 'close' ? takingsClose(s) : html`${takingsTable(s)}
        <div class="sums">${s.billed.map((b) => html`<div><span>${b.entity}: ${b.first} to ${b.last}${b.voids ? ` (${b.voids} void)` : ''}</span><span>${rs(b.paise)}</span></div>`)}</div>
        <div class="sums">${s.events.map((e) => html`<div><span>${{ void: 'Voids', reprint: 'Reprints', kot_cancel: 'Cancelled KOT lines', discount: 'Discounts', comp: 'Complimentary', limit_warning: 'Limit warnings', credit_note: 'Credit notes', stock_waste: 'Stock breakage', stock_count: 'Stock count variances' }[e.kind]}</span><span>${e.n} · ${rs(e.paise)}</span></div>`)}</div>
        ${s.tabs.length ? html`<div class="sums"><div><strong>Tabs carried to the next day (not in these totals)</strong></div>${s.tabs.map((t) => html`<div><span>${t.place} · ${t.guest} · since ${t.since}${t.old ? ' · overdue' : ''}</span><span>${rs(t.paise)}</span></div>`)}</div>` : ''}
        ${s.tips.length || s.discountsAtPayment.n ? html`<div class="sums">${s.tips.map((t) => html`<div><span>Tips on ${t.mode} (${t.n}) · for staff, not sales</span><span>${rs(t.paise)}</span></div>`)}
          ${s.discountsAtPayment.n ? html`<div><span>Discounts at payment (${s.discountsAtPayment.n})</span><span>${rs(s.discountsAtPayment.paise)}</span></div>` : ''}</div>` : ''}
        ${s.creditNotes.length ? html`<div class="sums"><div><strong>Credit notes (money given back)</strong></div>${s.creditNotes.map((n) => html`<div><span>${n.cnNo} on ${n.billNo} · ${n.reason} · ${n.refundMode}</span><span>${rs(-n.totalPaise)}</span></div>`)}</div>` : ''}
        ${s.drawerOuts.length ? html`<div class="sums"><div><strong>Paid out of the drawer</strong></div>${s.drawerOuts.map((o) => html`<div><span>${o.kind === 'refund' ? 'Advance refunded' : 'Paid out'}${o.mode === 'upi' ? ' (UPI)' : ''}${o.note && o.note !== 'Advance refunded' ? ' · ' + o.note : ''} · ${o.byName ?? ''}</span><span>${rs(-o.amountPaise)}</span></div>`)}</div>` : ''}
        `}
        ${ui.closed || !ui.countOn ? '' : html`<form class="grid2" style="align-items:end"><label class="f">Cash paid out (₹)<input class="in" inputmode="decimal" data-model="outAmount" value="${ui.outAmount ?? ''}"></label>
          <label class="f">What for<input class="in" data-model="outNote" value="${ui.outNote ?? ''}" placeholder="e.g. Vegetables"></label>
          <button class="btn" type="submit" data-act="paidOut" data-submit>Record paid out</button></form>`}
      </section>
      ${ui.closed || ui.countOn ? '' : html`<form class="panel"><h2>Close the day</h2>${errorBox()}
        <p class="small quiet">Closes ${dayName(s.shiftDay)} now and starts ${dayName(addDays(s.shiftDay, 1))}.${s.openOrders.length ? ` The ${plural(s.openOrders.length, 'open table')} carry on.` : ''} No drawer count (turned off in Settings, Staff).</p>
        ${s.notInDjubo?.length ? html`<label class="f">Why ${plural(s.notInDjubo.length, 'reservation')} made here ${s.notInDjubo.length === 1 ? 'is' : 'are'} not in Djubo yet (required)<input class="in" data-model="djuboReason" value="${ui.djuboReason ?? ''}"></label>` : ''}
        ${s.deskMissing?.length ? html`<label class="f">Why reception's Djubo payments are not in the POS (required)<input class="in" data-model="deskReason" value="${ui.deskReason ?? ''}" placeholder="e.g. Entered in Djubo by mistake"></label>` : ''}
        <button class="btn pri" type="submit" data-act="closeShift" data-submit ${ui.overdue.length || djOpen.length || (s.notCharged ?? []).length || (s.waitingRoom ?? []).length ? 'disabled' : ''}>Close the day</button>${djOpen.length ? html`<p class="small" style="color:var(--warn)">Pick how the ${plural(djOpen.length, 'Djubo payment')} ${djOpen.length === 1 ? 'was' : 'were'} paid first (above).</p>` : ''}</form>`}
      ${ui.closed || !ui.countOn ? '' : html`<form class="panel"><h2>Count the cash drawer</h2>${errorBox()}
        ${ui.floatSet ? html`<div class="row between"><span>Float (fixed in Settings)</span><strong>${rs(ui.floatSet)}</strong></div>`
          : html`<label class="f">Opening float (₹)<input class="in" inputmode="decimal" data-model="float" value="${ui.float ?? ''}"></label>`}
        <div class="notes">${notes.map((n) => html`<label class="f">₹${n} notes<input class="in" inputmode="numeric" data-model="c${n}" data-note="${n}" value="${ui.counts[n] ?? ''}"></label>`)}
          <label class="f">Coins and loose (₹)<input class="in" inputmode="decimal" data-model="loose" data-live value="${ui.loose ?? ''}"></label></div>
        <div class="sums"><div><span>Counted</span><span>${rs(counted)}</span></div>
          ${cd ? html`<div><span>Should hold</span><span>${rs(cd.expected)}</span></div><div class="big" style="color:var(--bad)"><span>${cd.diff < 0 ? 'Short' : 'Over'}</span><span>${rs(Math.abs(cd.diff))}</span></div>`
            : html`<div><span class="quiet">What the drawer should hold shows after you close: count first.</span><span></span></div>`}</div>
        ${cd ? html`<label class="f">Reason for the difference (required)<input class="in" data-model="reason" value="${ui.reason ?? ''}" autofocus></label>` : ''}
        ${s.notInDjubo?.length ? html`<label class="f">Why ${plural(s.notInDjubo.length, 'reservation')} made here ${s.notInDjubo.length === 1 ? 'is' : 'are'} not in Djubo yet (required)<input class="in" data-model="djuboReason" value="${ui.djuboReason ?? ''}" placeholder="e.g. Entered in Djubo, mail not come yet"></label>` : ''}
        ${s.deskMissing?.length ? html`<label class="f">Why reception's Djubo payments are not in the POS (required)<input class="in" data-model="deskReason" value="${ui.deskReason ?? ''}" placeholder="e.g. Entered in Djubo by mistake"></label>` : ''}
        <button class="btn pri" type="submit" data-act="closeShift" data-submit ${ui.overdue.length || djOpen.length || (s.notCharged ?? []).length || (s.waitingRoom ?? []).length ? 'disabled' : ''}>Close the day</button>${djOpen.length ? html`<p class="small" style="color:var(--warn)">Pick how the ${plural(djOpen.length, 'Djubo payment')} ${djOpen.length === 1 ? 'was' : 'were'} paid first (above).</p>` : ''}
        <p class="small quiet">${Date.now() < ui.endsAt ? `The day ends at ${time(ui.endsAt)} (${dayName(addDays(s.shiftDay, 1))}) and closes by itself then if nobody closes it. Closing now starts ${dayName(addDays(s.shiftDay, 1))} at once: money taken after this goes there.` : ''}</p></form>`}
      ${(ui.last?.noRent ?? []).length ? html`<div class="msg bad" style="display:block;margin-top:14px"><strong>${dayName(ui.last.shiftDay)} closed by itself with no rent for: ${ui.last.noRent.map((x) => `${x.room} · ${x.guestName} (rent till ${dayName(x.coveredTo)})`).join(', ')}</strong>
        <div class="small">Get the nights into Djubo (the rent comes with its email), or a manager extends without Djubo.</div></div>` : ''}
      ${ui.last && can('staff.manage') ? html`<details class="panel" style="margin-top:14px"><summary>Reopen ${dayName(ui.last.shiftDay)} (owner)</summary>
        <p class="small quiet">Closed ${ui.last.auto ? 'by itself' : `by ${ui.last.by ?? 'staff'}`} at ${dateTime(ui.last.closedAt)}. Reopening removes the close (kept in the log); close it again after. Bookr keeps the first close it was sent.</p>
        <div class="row"><input class="in grow" data-model="reopenWhy" value="${ui.reopenWhy ?? ''}" placeholder="Why reopen (required)"><button class="btn" type="button" data-act="reopenShift" data-day="${ui.last.shiftDay}">Reopen</button></div></details>` : ''}
    </div>`));
  };
  rerender();
}
const NOTE_VALUES = ['2000', '500', '200', '100', '50', '20', '10'];
root.addEventListener('input', (ev) => { const n = ev.target.dataset?.note; if (n) { ui.counts[n] = ev.target.value; refocus(ev.target.dataset.model, () => rerender()); } });
actions.paidOut = async () => {
  await api('POST', B() + '/drawer-outs', { amount: ui.outAmount ?? '', note: ui.outNote ?? '' });
  flash = { kind: 'ok', text: `Paid out ${rs(toPaise(ui.outAmount) ?? 0)} recorded.` }; route();
};
actions.reopenShift = async (d) => {
  if (!confirm(`Reopen the ${dayName(d.day)} shift?`)) return;
  await api('POST', `${B()}/shifts/${d.day}/reopen`, { reason: ui.reopenWhy ?? '' });
  flash = { kind: 'ok', text: `The ${dayName(d.day)} shift is open again.` }; route();
};
actions.closeShift = async () => {
  const counted = {}; for (const [k, v] of Object.entries(ui.counts)) counted[k] = Number(v) || 0;
  counted.loose = ui.loose || '0';
  try {
    const r = await api('POST', `${B()}/shifts/${ui.s.shiftDay}/close`, { openingFloat: ui.floatSet ? undefined : ui.float || '0', counted, reason: ui.reason, deskReason: ui.deskReason, djuboReason: ui.djuboReason });
    flash = { kind: r.differencePaise ? 'warn' : 'ok', text: r.noCount ? r.message : `Day closed. ${r.message}` }; me = await api('GET', '/me'); route();
  } catch (e) {
    // Blind count (24 Nov 2026): the expected amount comes back only after counting, with a request for the reason.
    if (e instanceof ApiError && e.code === 'count_differs') { ui.countDiff = { expected: Number(e.data.expectedPaise), diff: Number(e.data.differencePaise) }; ui.error = null; rerender(); return; }
    throw e;
  }
};
actions.drawerAskNo = () => { ui.drawerAsk = null; rerender(); };

// ---------- cash drawer handover (24 Nov 2026): any time; blind count; open tables pass on by name; the next cashier accepts with their PIN.
// Modes: hand over (default), take over (the holder has left: a manager confirms), count (keep it, just count).
async function handoverScreen(mode = '') {
  try { me = await api('GET', '/me'); } catch { /* keep */ }
  const d = await api('GET', `${B()}/drawer`);
  ui.hd = d; ui.hMode = mode === 'takeover' ? 'takeover' : mode === 'count' ? 'count' : 'handover';
  const dz = d.drawer;
  const mine = dz && dz.heldBy === me.staff.id;
  // Handing over: to whoever is signed in, unless the holder is signed in (then they choose).
  ui.hTo ??= mine ? d.staff.find((x) => x.id !== me.staff.id && x.role === 'cashier')?.id ?? '' : me.staff.id;
  rerender = () => {
    const counted = NOTE_VALUES.reduce((t, n) => t + (Number(ui[`h${n}`]) || 0) * Number(n) * 100, 0) + (toPaise(ui.hLoose || '0') ?? 0);
    const cd = ui.countDiff;
    const title = ui.hMode === 'takeover' ? 'Take the drawer over' : ui.hMode === 'count' ? 'Count the drawer' : 'Hand over the drawer';
    const to = d.staff.find((x) => x.id === ui.hTo);
    paint(shell('#/handover', html`${pageHead(title, ui.hMode === 'takeover' ? `${dz?.holder ?? 'The holder'} has left. You count the drawer and a manager confirms; any difference stays with ${dz?.holder ?? 'them'}.`
      : ui.hMode === 'count' ? 'Count the drawer and keep it. Any difference is recorded now.' : 'Any time the person at the till changes. Settle what you can, count the drawer, and the next person accepts with their PIN.')}
      ${errorBox()}
      ${!dz && ui.hMode !== 'count' ? html`<p class="empty">Nobody holds the cash drawer now. The next person to take cash starts it with the float${d.floatPaise ? ` (${rs(d.floatPaise)})` : ''}.</p>` : html`
      <div class="kpis">${kpi('Held by', dz ? dz.holder : 'Nobody yet', dz ? `since ${dateTime(dz.since)}` : 'this count starts from the float')}${kpi('Started with', rs(dz ? dz.openingPaise : d.floatPaise), !dz || dz.openingFrom === 'float' ? 'the float' : 'handed over')}
        ${kpi('Open tables', String(d.tables.length), d.tables.length ? (ui.hMode === 'count' ? 'stay as they are' : `pass to ${ui.hMode === 'takeover' ? 'you' : to?.name ?? 'the next person'}`) : 'none')}</div>
      <div class="two">
        <section class="panel"><h2>Open tables</h2>
          ${d.tables.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Table</th><th>State</th><th class="num">Amount</th><th></th></tr></thead><tbody>
            ${d.tables.map((x) => html`<tr><td><strong>${x.place}</strong>${x.openedShiftDay < me.business.shiftDay ? html` <span class="status warn">From ${dayName(x.openedShiftDay)}</span>` : ''}</td>
              <td>${x.billNo ? html`<span class="status ok">To pay · ${x.billNo}</span>` : x.status === 'tab' ? html`<span class="status info">Tab</span>` : html`<span class="status info">Open</span>`}</td>
              <td class="num">${rs(x.paise)}</td><td class="act"><a class="btn sm" href="${x.billId ? `#/settle/${x.billId}` : `#/order/${x.orderId}`}">${x.billId ? 'Paid now' : 'Open'}</a></td></tr>`)}</tbody></table></div>
            <p class="small quiet">"Paid now" takes the payment first, so the cash is in the drawer before the count. ${ui.hMode === 'count' ? '' : 'The rest pass on by name and show "From" on the Tables screen.'}</p>`
            : html`<p class="empty">No open tables.</p>`}
        </section>
        <form class="panel"><h2>${ui.hMode === 'count' ? 'Count' : 'Blind count'}</h2>
          ${ui.hMode === 'handover' ? html`<label class="f">Taking over<select class="in" data-model="hTo">${d.staff.filter((x) => x.id !== dz?.heldBy).map((x) => html`<option value="${x.id}" ${ui.hTo === x.id ? 'selected' : ''}>${x.name}${x.id === me.staff.id ? ' (you)' : ''}</option>`)}</select></label>
            ${!mine ? html`<label class="f">${dz?.holder}'s PIN (handing over)<input class="in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-model="hFromPin" value=""></label>` : ''}
            ${ui.hTo && ui.hTo !== me.staff.id ? html`<label class="f">${to?.name ?? 'Their'} PIN (accepting)<input class="in" type="password" inputmode="numeric" maxlength="6" autocomplete="off" data-model="hToPin" value=""></label>` : ''}` : ''}
          <div class="notes">${NOTE_VALUES.map((n) => html`<label class="f">₹${n} notes<input class="in" inputmode="numeric" data-model="h${n}" data-live value="${ui[`h${n}`] ?? ''}"></label>`)}
            <label class="f">Coins and loose (₹)<input class="in" inputmode="decimal" data-model="hLoose" data-live value="${ui.hLoose ?? ''}"></label></div>
          <div class="sums"><div><span>Counted</span><span>${rs(counted)}</span></div>
            ${cd ? html`<div><span>Should hold</span><span>${rs(cd.expected)}</span></div><div class="big" style="color:var(--bad)"><span>${cd.diff < 0 ? 'Short' : 'Over'}</span><span>${rs(Math.abs(cd.diff))}</span></div>`
              : html`<div><span class="quiet">What it should hold shows after you save the count.</span><span></span></div>`}</div>
          ${cd ? html`<label class="f">Reason for the difference (required)<input class="in" data-model="hReason" value="${ui.hReason ?? ''}" autofocus></label>` : ''}
          <button class="btn pri" type="submit" data-act="drawerGo" data-submit>${ui.hMode === 'takeover' ? 'Count and take over' : ui.hMode === 'count' ? 'Save the count' : `Count and hand to ${to?.name ?? '…'}`}</button>
          <p class="small quiet">${ui.hMode === 'handover' ? html`Holder has left? <a href="#/handover/takeover">Take it over</a> instead.` : ui.hMode === 'takeover' ? 'A manager confirms with their PIN.' : ''}</p>
        </form>
      </div>`}`));
  };
  rerender();
}
actions.drawerGo = async () => {
  const counted = {}; for (const n of NOTE_VALUES) counted[n] = Number(ui[`h${n}`]) || 0;
  counted.loose = ui.hLoose || '0';
  const path = ui.hMode === 'takeover' ? 'takeover' : ui.hMode === 'count' ? 'count' : 'handover';
  try {
    const r = await api('POST', `${B()}/drawer/${path}`, { counted, reason: ui.hReason, toId: ui.hTo, fromPin: ui.hFromPin, toPin: ui.hToPin });
    flash = { kind: r.differencePaise ? 'warn' : 'ok', text: r.message }; me = await api('GET', '/me'); go('#/');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'count_differs') { ui.countDiff = { expected: Number(e.data.expectedPaise), diff: Number(e.data.differencePaise) }; ui.error = null; rerender(); return; }
    throw e;
  }
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

/** Room sales (25 Nov 2026): each room invoice, room credit notes and no-show charges kept, with GST. */
async function roomsReportTab(head, from, to) {
  const r = await api('GET', `${B()}/reports/rooms?from=${from}&to=${to}`);
  const t = r.totals;
  rerender = () => paint(shell('#/reports', html`${head}
    ${r.occupancy ? html`<div class="kpis">${kpi('Occupancy', r.occupancy.pct == null ? '—' : `${r.occupancy.pct}%`, `rooms ${r.occupancy.rooms.pct ?? '—'}% · beds ${r.occupancy.beds.pct ?? '—'}%`)}
      ${kpi('ADR', r.occupancy.adrPaise == null ? '—' : rs(r.occupancy.adrPaise), 'per night sold, before GST')}
      ${kpi('RevPAR', r.occupancy.revparPaise == null ? '—' : rs(r.occupancy.revparPaise), 'per room or bed available')}
      ${kpi('Nights sold', String(r.occupancy.rooms.sold + r.occupancy.beds.sold), `of ${r.occupancy.rooms.available + r.occupancy.beds.available} available${r.occupancy.upTo < r.to ? ` · up to ${dayName(r.occupancy.upTo)}` : ''}`)}</div>` : ''}
    <div class="kpis">${kpi('Room invoices', String(t.invoices))}${kpi('Room nights', String(t.nights))}${kpi('Room sales (before GST)', rs(t.taxablePaise))}${kpi('GST on rooms', rs(t.gstPaise))}${kpi('No-show charges kept', rs(t.noShowPaise))}</div>
    <p class="small quiet">Occupancy counts the guests who stayed each night, rooms and dorm beds together. ADR is room revenue before GST per night sold, as earned each night (see Room revenue by day). RevPAR is ADR × occupancy. Room invoices are made at check-out.</p>
    ${r.byDay?.days?.length ? roomRevenueTable(r.byDay, t.taxablePaise) : ''}
    <section class="panel" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2>Room invoices</h2>${r.invoices.length ? html`<button class="btn" type="button" data-act="roomsCsv">Download (CSV)</button>` : ''}</div>
      <div class="scroll"><table class="t"><thead><tr><th>Invoice</th><th>Day</th><th>Guest / company</th><th>Room</th><th class="num">Nights</th><th>Rate</th><th class="num">Value</th><th class="num">GST</th><th class="num">Total</th></tr></thead><tbody>
        ${r.invoices.length ? r.invoices.map((x) => html`<tr><td>${x.invoiceNo}</td><td>${dayName(x.day)}</td><td>${x.guestName}${x.billToName ? html`<div class="small quiet">${x.billToName}${x.billToGstin ? ` · ${x.billToGstin}` : ''}</div>` : ''}</td><td>${x.room}</td>
          <td class="num">${x.nights}</td><td>${x.gstRateBp / 100}%</td><td class="num">${rs(x.taxablePaise)}</td><td class="num">${rs(x.cgstPaise + x.sgstPaise)}</td><td class="num">${rs(x.totalPaise)}</td></tr>`) : html`<tr><td colspan="9" class="quiet">No room invoices in these shifts.</td></tr>`}</tbody></table></div></section>
    ${r.creditNotes.length ? html`<section class="panel" style="margin-top:16px"><h2>Room credit notes</h2><div class="sums">${r.creditNotes.map((n) => html`<div><span>${n.cnNo} on ${n.invoiceNo} · ${n.reason} · ${n.refundMode}</span><span>${rs(-n.totalPaise)}</span></div>`)}</div></section>` : ''}
    ${(r.noRent ?? []).length ? html`<section class="panel" style="margin-top:16px;border-color:var(--bad-line)"><h2>Checked out with no room rent</h2>
      <p class="small quiet">Stays that brought in no room rent (a walk-in whose rent was never added, or a free room), each approved by a manager.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Room</th><th>Guest</th><th>Stayed from</th><th>Checked out</th><th>By</th><th>Approved by</th></tr></thead><tbody>
        ${r.noRent.map((x) => html`<tr><td>${x.room}</td><td>${x.guestName}</td><td>${dayName(x.checkIn)}</td><td>${dateTime(x.at)}</td><td>${x.byName ?? ''}</td><td>${x.approvedBy ?? ''}</td></tr>`)}</tbody></table></div></section>` : ''}
    ${r.noShowsKept.length ? html`<section class="panel" style="margin-top:16px"><h2>No-show charges kept</h2><div class="sums">${r.noShowsKept.map((n) => html`<div><span>${n.guestName} · ${n.receiptNo}</span><span>${rs(n.amountPaise)}</span></div>`)}</div></section>` : ''}`));
  ui.roomsRep = r;
  rerender();
}
/** Room revenue by day (25 Nov 2026): what each night earned, rooms and beds, with and without GST; not advances or payments. */
function roomRevenueTable(rv, invoicedTaxable) {
  const T = rv.totals;
  const tot = (k) => rs(T[k]);
  return html`<section class="panel" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2>Room revenue by day</h2><button class="btn" type="button" data-act="revCsv">Download (CSV)</button></div>
    <p class="small quiet">What each night earned: each stay's room rent split equally over its nights, guests in house counted up to ${dayName(rv.upTo)}. Advances and payments are not revenue and are not here. Extra charges and discounts count on the day they were added.</p>
    <div class="scroll"><table class="t"><thead><tr><th>Date</th><th class="num">Rooms</th><th class="num">Beds</th><th class="num">Rooms revenue</th><th class="num">Beds revenue</th><th class="num">Before GST</th><th class="num">GST</th><th class="num">With GST</th><th class="num">ADR</th><th class="num">Occupancy</th></tr></thead><tbody>
      ${rv.days.map((d) => html`<tr><td>${dayName(d.day)}${d.notInvoicedPaise ? html`<div class="small quiet">${rs(d.notInvoicedPaise)} not invoiced yet</div>` : ''}${d.unknownNights ? html`<div class="small" style="color:var(--warn)">${plural(d.unknownNights, 'night')} rent not known</div>` : ''}${d.noShowPaise ? html`<div class="small quiet">+ ${rs(d.noShowPaise)} no-show kept</div>` : ''}</td>
        <td class="num">${d.roomsSold}</td><td class="num">${d.bedsSold}</td><td class="num">${rs(d.roomsPaise)}</td><td class="num">${rs(d.bedsPaise)}</td>
        <td class="num">${rs(d.taxablePaise)}</td><td class="num">${rs(d.gstPaise)}</td><td class="num"><strong>${rs(d.grossPaise)}</strong></td><td class="num">${d.adrPaise == null ? '—' : rs(d.adrPaise)}</td><td class="num">${d.occupancyPct == null ? '—' : `${d.occupancyPct}%`}</td></tr>`)}
      <tr style="font-weight:700"><td>Total</td><td class="num">${T.roomsSold}</td><td class="num">${T.bedsSold}</td><td class="num">${tot('roomsPaise')}</td><td class="num">${tot('bedsPaise')}</td><td class="num">${tot('taxablePaise')}</td><td class="num">${tot('gstPaise')}</td><td class="num">${tot('grossPaise')}</td><td></td><td></td></tr>
    </tbody></table></div>
    <div class="small quiet" style="margin-top:6px">${T.notInvoicedPaise ? `${rs(T.notInvoicedPaise)} of it is from guests not checked out yet (invoiced at check-out). ` : ''}${T.unknownNights ? `${plural(T.unknownNights, 'night')} from before the POS have no known rent. ` : ''}${T.noShowPaise ? `No-show charges kept: ${rs(T.noShowPaise)}. ` : ''}Room invoices in these dates (made at check-out, before GST): ${rs(invoicedTaxable)}.</div></section>`;
}
actions.revCsv = () => downloadCsv(`room-revenue-${ui.roomsRep.from}-to-${ui.roomsRep.to}.csv`, [['Date', 'Rooms sold', 'Beds sold', 'Rooms revenue', 'Beds revenue', 'Before GST', 'GST', 'With GST', 'ADR', 'Occupancy %', 'Not invoiced yet', 'Nights rent not known', 'No-show kept'],
  ...ui.roomsRep.byDay.days.map((d) => [d.day, d.roomsSold, d.bedsSold, rupees(d.roomsPaise), rupees(d.bedsPaise), rupees(d.taxablePaise), rupees(d.gstPaise), rupees(d.grossPaise), d.adrPaise == null ? '' : rupees(d.adrPaise), d.occupancyPct ?? '', rupees(d.notInvoicedPaise), d.unknownNights, rupees(d.noShowPaise)])]);
actions.roomsCsv = () => downloadCsv(`room-invoices-${ui.roomsRep.from}-to-${ui.roomsRep.to}.csv`, [['Invoice', 'Shift day', 'Guest', 'Company', 'GSTIN', 'Room', 'Check-in', 'Check-out', 'Nights', 'GST rate', 'Value', 'CGST', 'SGST', 'Total'],
  ...ui.roomsRep.invoices.map((x) => [x.invoiceNo, x.day, x.guestName, x.billToName ?? '', x.billToGstin ?? '', x.room, x.checkIn, x.checkOut, x.nights, `${x.gstRateBp / 100}%`, rupees(x.taxablePaise), rupees(x.cgstPaise), rupees(x.sgstPaise), rupees(x.totalPaise)])]);
async function gstTab(head, month) {
  const r = await api('GET', `${B()}/reports/gstr1?month=${month}`);
  ui.gst = r;
  const money = (p) => rupees(p);
  rerender = () => paint(shell('#/reports', html`${head}
    <section class="panel"><div class="row" style="justify-content:space-between"><h2>GSTR-1 working · ${month}</h2>${r.entities.length ? html`<button class="btn" type="button" data-act="gstCsv">Download for CA (CSV)</button>` : ''}</div>
      <p class="quiet small">By bill date (when printed, India time), not shift. Food bills are B2C small (unregistered buyers). Room invoices made out to a company with a GSTIN are B2B; the rest are B2C. Credit notes are netted off in B2C. Check with your CA before filing.</p>
      ${r.entities.length || r.rooms?.length ? '' : html`<p class="quiet">No bills in this month.</p>`}</section>
    ${(r.rooms ?? []).map((e) => html`<section class="panel" style="margin-top:16px"><h2>Rooms · ${e.name}</h2><p class="small">GSTIN ${e.gstin ?? '—'} · SAC 996311 (accommodation)</p>
      ${e.b2b.length ? html`<h3>B2B (Table 4): room invoices to registered companies</h3><div class="scroll"><table class="t"><thead><tr><th>GSTIN</th><th>Company</th><th>Invoice</th><th>Date</th><th>Rate</th><th class="num">Taxable (₹)</th><th class="num">CGST (₹)</th><th class="num">SGST (₹)</th><th class="num">Invoice value (₹)</th></tr></thead><tbody>
        ${e.b2b.map((x) => html`<tr><td>${x.gstin}</td><td>${x.name ?? ''}</td><td>${x.invoiceNo}</td><td>${dateTime(x.at)}</td><td>${x.ratePct}%</td><td class="num">${money(x.taxablePaise)}</td><td class="num">${money(x.cgstPaise)}</td><td class="num">${money(x.sgstPaise)}</td><td class="num">${money(x.totalPaise)}</td></tr>`)}</tbody></table></div>` : ''}
      <h3>B2C small (Table 7) and SAC 996311</h3><div class="scroll"><table class="t"><thead><tr><th>Rate</th><th class="num">Nights</th><th class="num">Taxable value (₹)</th><th class="num">CGST (₹)</th><th class="num">SGST (₹)</th></tr></thead><tbody>
        ${e.b2cs.map((x) => html`<tr><td>${x.ratePct}%</td><td class="num">${x.nights}</td><td class="num">${money(x.taxablePaise)}</td><td class="num">${money(x.cgstPaise)}</td><td class="num">${money(x.sgstPaise)}</td></tr>`)}</tbody></table></div>
      <h3>Documents issued (Table 13)</h3><div class="scroll"><table class="t"><thead><tr><th>Document</th><th>From</th><th>To</th><th class="num">Total</th></tr></thead><tbody>
        ${[['Room invoices', e.invoices], ['Room credit notes', e.creditNotes]].filter(([, x]) => x).map(([name, x]) => html`<tr><td>${name}</td><td>${x.from}</td><td>${x.to}</td><td class="num">${x.total}</td></tr>`)}</tbody></table></div></section>`)}
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
  for (const e of r.rooms ?? []) {
    for (const x of e.b2b) rows.push([r.month, e.name, e.gstin ?? '', `Rooms B2B ${x.gstin} ${x.name ?? ''}`, `${x.invoiceNo} at ${x.ratePct}%`, '', rupees(x.taxablePaise), rupees(x.cgstPaise), rupees(x.sgstPaise)]);
    for (const x of e.b2cs) rows.push([r.month, e.name, e.gstin ?? '', 'Rooms B2C small (SAC 996311)', `${x.ratePct}%`, x.nights, rupees(x.taxablePaise), rupees(x.cgstPaise), rupees(x.sgstPaise)]);
    if (e.invoices) rows.push([r.month, e.name, e.gstin ?? '', 'Documents: room invoices', 'Room invoices', e.invoices.from, e.invoices.to, e.invoices.total, 0]);
    if (e.creditNotes) rows.push([r.month, e.name, e.gstin ?? '', 'Documents: room credit notes', 'Room credit notes', e.creditNotes.from, e.creditNotes.to, e.creditNotes.total, 0]);
  }
  downloadCsv(`gstr1-working-${r.month}.csv`, rows);
};
/** Saves rows as a CSV file (opens in Excel). */
function downloadCsv(name, rows) {
  const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const blob = new Blob([rows.map((row) => row.map(cell).join(',')).join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Reports by table section, and by hour for any time range (an evening past midnight), 21 Nov 2026
const dtLocal = (ms) => new Date(ms + 19_800_000).toISOString().slice(0, 16);      // India time, for a datetime-local box
async function sectionsTab(head, from, to) {
  const [r, o] = await Promise.all([api('GET', `${B()}/reports/sections?from=${from}&to=${to}`), api('GET', B() + '/orders')]);
  ui.secNames = (o.sections ?? []).map((x) => x.name);
  const start = Date.parse(`${from}T00:00:00Z`) - 19_800_000 + me.business.shift_start_hour * 3_600_000;
  ui.hFromT ??= dtLocal(start); ui.hToT ??= dtLocal(start + 86_400_000); ui.hSec ??= '';
  const loadHours = async () => { ui.hours = await api('GET', `${B()}/reports/hours?from=${encodeURIComponent(ui.hFromT)}&to=${encodeURIComponent(ui.hToT)}${ui.hSec ? `&section=${encodeURIComponent(ui.hSec)}` : ''}`); };
  await loadHours().catch((e) => { ui.error = e.message; });
  actions.hoursGo = async () => { ui.error = null; await loadHours(); rerender(); };
  rerender = () => {
    const charged = r.sections.filter((x) => x.kind !== 'comp');
    const comp = r.sections.filter((x) => x.kind === 'comp');
    const total = charged.reduce((t, x) => t + x.netPaise, 0);
    const h = ui.hours;
    const top = h ? Math.max(1, ...h.hours.map((x) => x.netPaise)) : 1;
    const hourName = (ms) => new Date(ms + 19_800_000).getUTCHours();
    const ampm = (n) => `${n % 12 || 12}${n < 12 ? ' am' : ' pm'}`;
    paint(shell('#/reports', html`${head}${errorBox()}
      <section class="panel"><h2>Sales by table section</h2>
        ${r.sections.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Section</th><th class="num">Bills</th><th class="num">Sales</th><th class="num">Average bill</th></tr></thead><tbody>
          ${charged.map((x) => html`<tr><td>${x.section}</td><td class="num">${x.bills}</td><td class="num">${rs(x.netPaise)}</td><td class="num">${rs(Math.round(x.netPaise / x.bills))}</td></tr>`)}
          ${comp.map((x) => html`<tr><td>${x.section} <span class="ncbadge">NC</span></td><td class="num">${x.bills}</td><td class="num quiet">${rs(x.netPaise)} at menu price</td><td></td></tr>`)}
          <tr><td><strong>Total charged</strong></td><td class="num"><strong>${charged.reduce((t, x) => t + x.bills, 0)}</strong></td><td class="num"><strong>${rs(total)}</strong></td><td></td></tr></tbody></table></div>
          <p class="small quiet">Sales are after bill discounts and before GST. NC and complimentary bills are shown at menu price, not counted in sales. Sections are as set in Settings, Rooms and tables.</p>`
        : html`<p class="quiet">No bills in these shifts.</p>`}</section>
      <section class="panel"><h2>By hour${ui.hSec ? ` · ${ui.hSec}` : ''}</h2>
        <form class="row" style="align-items:end"><label class="f">From<input class="in" type="datetime-local" data-model="hFromT" value="${ui.hFromT}"></label>
          <label class="f">To<input class="in" type="datetime-local" data-model="hToT" value="${ui.hToT}"></label>
          <label class="f">Section<select class="in" data-model="hSec"><option value="">All sections</option>${ui.secNames.map((n) => html`<option ${ui.hSec === n ? 'selected' : ''}>${n}</option>`)}</select></label>
          <button class="btn" type="submit" data-act="hoursGo" data-submit>Show</button></form>
        ${h ? html`<p class="small quiet" style="margin:8px 0">${plural(h.bills, 'bill')} · ${rs(h.totalPaise)}, by the hour each bill was printed</p>
          <div class="hbars">${h.hours.map((x) => html`<div class="hrow"><span>${ampm(hourName(x.from))}–${ampm((hourName(x.from) + 1) % 24)}</span><b><i style="width:${Math.round((x.netPaise / top) * 100)}%"></i></b><span class="num">${x.netPaise ? rs(x.netPaise) : '—'}</span></div>`)}</div>` : ''}</section>`));
  };
  rerender();
}

// ---------- Events: an organiser's night, its bills at the chosen tables, and their commission (21 Nov 2026)
async function eventsTab(head) {
  const [{ events }, o] = await Promise.all([api('GET', `${B()}/event-mode`), api('GET', B() + '/orders'), load('menu')]);
  ui.events = events;
  ui.secNames = (o.sections ?? []).map((x) => x.name);
  const outh = (o.sections ?? []).filter((x) => x.kind === 'outhouse').map((x) => x.name);
  const t0 = new Date(); const today7pm = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate(), 19) - 19_800_000;
  ui.evName ??= ''; ui.evOrg ??= ''; ui.evFrom ??= dtLocal(today7pm); ui.evTo ??= dtLocal(today7pm + 7 * 3_600_000); ui.evPct ??= '20';
  ui.evSecs ??= outh.length ? outh : ui.secNames.slice(0, 1); ui.evMenu ??= [];
  const cats = [...new Set(cache.menu.map((m) => m.category))].sort();
  ui.evMenu = ui.evMenu.length ? ui.evMenu : cats.filter((c) => /^event/i.test(c));
  rerender = () => {
    const nowMs = Date.now();
    const status = (e) => (e.cancelledAt ? 'Ended early' : e.endsAt <= nowMs ? 'Ended' : e.startsAt <= nowMs ? 'On now' : 'Coming');
    const card = (e) => html`<section class="panel"><h2>${e.name} <span class="pill ${status(e) === 'On now' ? 'on' : ''}">${status(e)}</span></h2>
      <div class="kv"><span class="quiet">Organiser</span><span>${e.organiser}</span>
        <span class="quiet">Time</span><span>${dateTime(e.startsAt)} → ${dateTime(e.cancelledAt && e.cancelledAt < e.endsAt ? e.cancelledAt : e.endsAt)}</span>
        <span class="quiet">Counts bills from</span><span>${e.sections.join(', ')}${e.menu ? ` · menu: ${e.menu.join(', ')}` : ''}</span>
        <span class="quiet">Bills</span><span>${e.bills}</span>
        <span class="quiet">Sales</span><span>${rs(e.netPaise)} <span class="small quiet">after discounts, before GST</span></span>
        <span class="quiet">Commission ${e.commissionBp / 100}%</span><span><strong>${rs(e.commissionPaise)}</strong> due to ${e.organiser}</span>
        <span class="quiet">Paid</span><span>${e.payments.length ? e.payments.map((p) => `${rs(p.amountPaise)} ${({ cash: 'cash', upi: 'UPI', bank: 'bank transfer' })[p.mode]} on ${dateTime(p.at)}`).join('; ') : 'Nothing yet'}${e.duePaise ? html` · <strong>${rs(e.duePaise)} still due</strong>` : e.commissionPaise ? ' · paid in full' : ''}</span></div>
      ${ui.payEv === e.id ? html`<form class="row rowform" style="align-items:end"><label class="f">Amount (₹)<input class="in" inputmode="decimal" data-model="pevAmt" value="${ui.pevAmt ?? (e.duePaise ? (e.duePaise / 100).toFixed(2) : '')}" autofocus></label>
          <label class="f">Paid by<select class="in" data-model="pevMode"><option value="cash">Cash from the drawer</option><option value="upi" ${ui.pevMode === 'upi' ? 'selected' : ''}>UPI</option><option value="bank" ${ui.pevMode === 'bank' ? 'selected' : ''}>Bank transfer</option></select></label>
          <label class="f">Note (optional)<input class="in" data-model="pevNote"></label>
          <button class="btn pri" type="submit" data-act="pevGo" data-id="${e.id}" data-submit>Record payment</button><button class="btn ghost" type="button" data-act="pevNo">Cancel</button></form>`
        : html`<div class="row" style="margin-top:10px">${e.duePaise ? html`<button class="btn" type="button" data-act="pevOpen" data-id="${e.id}">Record a payment</button>` : ''}
          ${status(e) === 'On now' || status(e) === 'Coming' ? html`<button class="btn ghost" type="button" data-act="evEnd" data-id="${e.id}">${status(e) === 'On now' ? 'End now' : 'Call off'}</button>` : ''}</div>`}
      <p class="small quiet">Cash and UPI payments go out of the drawer on this shift, so shift close counts them.</p></section>`;
    paint(shell('#/reports', html`${head}${errorBox()}
      <section class="panel eventcard"><h2>Start an event</h2>
        <div class="grid2"><label class="f">Event name<input class="in" data-model="evName" value="${ui.evName}" placeholder="e.g. Saturday Night"></label><label class="f">Organiser<input class="in" data-model="evOrg" value="${ui.evOrg}"></label>
          <label class="f">Starts<input class="in" type="datetime-local" data-model="evFrom" value="${ui.evFrom}"></label><label class="f">Ends<input class="in" type="datetime-local" data-model="evTo" value="${ui.evTo}"></label>
          <label class="f">Commission (%)<input class="in" inputmode="decimal" data-model="evPct" value="${ui.evPct}"></label></div>
        <div class="f" style="margin-top:8px">Counts bills from these table sections<div class="chips">${ui.secNames.map((n) => html`<button type="button" class="chip" aria-pressed="${ui.evSecs.includes(n)}" data-act="evSec" data-name="${n}">${n}</button>`)}</div>
          ${ui.secNames.length ? '' : html`<span class="small quiet">Set up table sections in Settings, Rooms and tables first.</span>`}</div>
        <div class="f" style="margin-top:8px">Menu at those tables during the event (none chosen: the full menu)<div class="chips">${cats.map((c) => html`<button type="button" class="chip" aria-pressed="${ui.evMenu.includes(c)}" data-act="evCat" data-name="${c}">${c}</button>`)}</div></div>
        <p class="small quiet">Commission is on the event's bills after discounts and before GST, liquor included; NC and complimentary bills do not count.</p>
        <div class="row"><button class="btn pri" type="button" data-act="evStart">Start event</button></div></section>
      ${ui.events.length ? ui.events.map(card) : html`<p class="quiet">No events yet.</p>`}`));
  };
  rerender();
}
const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
actions.evSec = (d) => { ui.evSecs = toggleIn(ui.evSecs, d.name); rerender(); };
actions.evCat = (d) => { ui.evMenu = toggleIn(ui.evMenu, d.name); rerender(); };
actions.evStart = async () => {
  await api('POST', `${B()}/event-mode`, { name: ui.evName, organiser: ui.evOrg, startsAt: ui.evFrom, endsAt: ui.evTo, commission: ui.evPct, sections: ui.evSecs, menu: ui.evMenu });
  flash = { kind: 'ok', text: `${ui.evName} set up. While it is on, the counter shows it.` }; route();
};
actions.evEnd = async (d) => { const e = ui.events.find((x) => x.id === d.id); if (!confirm(`End ${e.name} now? Bills from now on will not count towards it.`)) return; await api('POST', `${B()}/event-mode/${d.id}/end`); route(); };
actions.pevOpen = (d) => { ui.payEv = d.id; ui.pevAmt = undefined; ui.pevMode = 'cash'; ui.pevNote = ''; ui.error = null; rerender(); };
actions.pevNo = () => { ui.payEv = null; rerender(); };
actions.pevGo = async (d) => {
  await api('POST', `${B()}/event-mode/${d.id}/payments`, { amount: ui.pevAmt ?? (ui.events.find((x) => x.id === d.id).duePaise / 100).toFixed(2), mode: ui.pevMode || 'cash', note: ui.pevNote || undefined });
  flash = { kind: 'ok', text: 'Payment recorded.' }; route();
};

// ---------- Profit per dish and Losses (21 Nov 2026)
const GROUPS = {
  best: ['Best', 'Sells well, earns well', 'Keep it as it is. Guard the recipe and the price.', 'good'],
  popular: ['Popular, low profit', 'Sells well, earns little', 'Raise the price a little or make it cheaper to cook.', 'warn'],
  profitable: ['Profitable, slow', 'Earns well, sells little', 'Get staff to suggest it; show it better on the menu.', 'warn'],
  weak: ['Weak', 'Sells little, earns little', 'Change it or take it off the menu.', 'bad'],
};
async function profitTab(head, from, to) {
  const r = await api('GET', `${B()}/reports/profit?from=${from}&to=${to}`);
  const title = from === to ? dayName(from) : `${dayName(from)} to ${dayName(to)}`;
  ui.pfSt ??= 'kitchen'; ui.pfG ??= '';
  rerender = () => {
    const st = r.stations.find((x) => x.station === ui.pfSt);
    const list = r.dishes.filter((d) => d.station === ui.pfSt && (!ui.pfG || (ui.pfG === 'none' ? d.costPaise == null : d.group === ui.pfG)));
    const count = (g) => r.dishes.filter((d) => d.station === ui.pfSt && (g === 'none' ? d.costPaise == null : d.group === g)).length;
    const word = ui.pfSt === 'bar' ? 'Drink' : 'Food';
    paint(shell('#/reports', html`${head}
      <section class="panel"><h2>Profit · ${title}</h2>
        <p class="quiet small">Cost comes from each dish's recipe at the last price paid for its stock. Sales are paid bills, after item discounts, before bill discounts and GST. NC and complimentary bills are on Losses.</p>
        <div class="chips" role="group" aria-label="Kitchen or bar">${[['kitchen', 'Kitchen'], ['bar', 'Bar']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${ui.pfSt === k}" data-act="pfSt" data-k="${k}">${t}</button>`)}</div>
        ${st.salesPaise ? html`<div class="kpis" style="margin-top:12px">${kpi(`${word} cost`, st.costPct == null ? '—' : `${st.costPct}%`, st.costPct == null ? 'No recipes yet' : `${rs(st.costPaise)} on ${rs(st.costedSalesPaise)} of sales`)}
          ${kpi('Profit', rs(st.profitPaise), `Average ${rs(Math.round(st.avgProfitPaise / 100) * 100)} a plate, on dishes with a recipe`, 'good')}
          ${kpi('Sales', rs(st.salesPaise), 'Before bill discounts')}
          ${st.notCosted ? kpi('No recipe', String(st.notCosted), 'These dishes have no cost. Add recipes under Stock.', 'warn') : ''}</div>
          ${r.discountPaise ? html`<p class="small quiet">Bill discounts in these shifts: ${rs(r.discountPaise)} (kitchen and bar together), not taken off the dishes here.</p>` : ''}`
        : html`<p class="quiet">Nothing from the ${ui.pfSt} was sold in these shifts.</p>`}</section>
      ${st.salesPaise ? html`<section class="panel" style="margin-top:16px"><h2>Every dish</h2>
        <div class="chips" role="group" aria-label="Show">${[['', 'All'], ...Object.entries(GROUPS).map(([k, g]) => [k, g[0]]), ['none', 'No recipe']].map(([k, t]) => html`<button type="button" class="chip" aria-pressed="${ui.pfG === k}" data-act="pfG" data-k="${k}">${t}${k ? ` (${count(k)})` : ''}</button>`)}</div>
        ${ui.pfG && GROUPS[ui.pfG] ? html`<p class="small" style="margin:8px 0">${GROUPS[ui.pfG][1]}: ${GROUPS[ui.pfG][2]}</p>` : ''}
        <div class="scroll"><table class="t"><thead><tr><th>Dish</th><th class="num">Sold</th><th class="num">Sales</th><th class="num">Cost</th><th class="num">Cost %</th><th class="num">Profit a plate</th><th>Verdict</th></tr></thead><tbody>
          ${list.map((d) => html`<tr><td>${d.name}<div class="small quiet">${d.category}</div></td><td class="num">${d.qty}</td><td class="num">${rs(d.salesPaise)}</td>
            <td class="num">${d.costPaise == null ? '—' : rs(d.costPaise)}</td><td class="num">${d.costPct == null ? '' : `${d.costPct}%`}</td>
            <td class="num">${d.profitPaise == null ? '' : rs(Math.round(d.profitPaise / d.qty))}</td>
            <td>${d.group ? html`<span class="pill ${GROUPS[d.group][3]}" title="${GROUPS[d.group][2]}">${GROUPS[d.group][0]}</span>` : html`<span class="small quiet">No recipe</span>`}</td></tr>`)}
          ${list.length ? '' : html`<tr><td colspan="7" class="quiet">None.</td></tr>`}</tbody></table></div>
        <p class="small quiet">Sells well = at least 70% of an even share of the plates sold. Earns well = profit a plate at or above the average. Kitchen and bar are judged apart.</p></section>` : ''}`));
  };
  rerender();
}
actions.pfSt = (d) => { ui.pfSt = d.k; ui.pfG = ''; rerender(); };
actions.pfG = (d) => { ui.pfG = d.k; rerender(); };

const LOSS = { kot_cancel: 'Cancelled after KOT', void: 'Void bills', discount: 'Discounts', comp: 'NC and complimentary', credit_note: 'Refunds (credit notes)' };
async function lossesTab(head, from, to) {
  const r = await api('GET', `${B()}/reports/losses?from=${from}&to=${to}`);
  ui.lossR = r;
  const title = from === to ? dayName(from) : `${dayName(from)} to ${dayName(to)}`;
  const kinds = Object.keys(LOSS);
  const of = (k) => r.events.filter((e) => e.kind === k);
  const sumOf = (xs) => xs.reduce((t, e) => t + (e.amountPaise ?? 0), 0);
  const stockLost = r.stock.reduce((t, x) => t + x.valuePaise, 0);
  const short = r.cash.filter((x) => x.differencePaise < 0).reduce((t, x) => t - x.differencePaise, 0);
  const total = kinds.reduce((t, k) => t + sumOf(of(k)), 0) + stockLost + short;
  // By person: one row per staff, a column per kind.
  const people = [...new Set(r.events.map((e) => e.byName || 'Unknown'))].map((name) => {
    const mine = r.events.filter((e) => (e.byName || 'Unknown') === name);
    return { name, cells: kinds.map((k) => { const xs = mine.filter((e) => e.kind === k); return { n: xs.length, paise: sumOf(xs) }; }), paise: sumOf(mine) };
  }).sort((a, b) => b.paise - a.paise);
  const reasons = (k) => Object.values(of(k).reduce((acc, e) => { const key = e.reason || 'No reason'; const x = acc[key] ?? (acc[key] = { reason: key, n: 0, paise: 0 }); x.n += 1; x.paise += e.amountPaise ?? 0; return acc; }, {})).sort((a, b) => b.paise - a.paise);
  const guests = Object.values(of('comp').reduce((acc, e) => { const g = (e.detail ?? '').split(' · ')[0].replace(/^Guest:\s*/, '') || 'Not named'; const x = acc[g] ?? (acc[g] = { guest: g, n: 0, paise: 0 }); x.n += 1; x.paise += e.amountPaise ?? 0; return acc; }, {})).sort((a, b) => b.paise - a.paise);
  const unit = (x) => (x.unit === 'pcs' ? 'pcs' : x.unit);
  rerender = () => paint(shell('#/reports', html`${head}
    <div class="kpis">${kpi('All losses', rs(total), title, total ? 'bad' : 'good')}
      ${kinds.map((k) => { const xs = of(k); return xs.length ? kpi(LOSS[k], rs(sumOf(xs)), plural(xs.length, 'time'), 'warn') : ''; })}
      ${stockLost ? kpi('Stock broken or missing', rs(stockLost), 'At cost', 'warn') : ''}
      ${short ? kpi('Cash short at close', rs(short), plural(r.cash.filter((x) => x.differencePaise < 0).length, 'shift'), 'bad') : ''}</div>
    <p class="small quiet" style="margin:-4px 0 12px">Bills at their value with GST; discounts at the amount taken off; stock at the last price paid.</p>
    ${total || r.events.length ? '' : html`<section class="panel"><p>Nothing lost or given away in these shifts.</p></section>`}
    ${people.length ? html`<section class="panel"><div class="row" style="justify-content:space-between"><h2>By person</h2><button class="btn" type="button" data-act="csvLoss">Download for Excel</button></div>
      <div class="scroll"><table class="t"><thead><tr><th>Staff</th>${kinds.map((k) => html`<th class="num">${LOSS[k]}</th>`)}<th class="num">Total</th></tr></thead><tbody>
        ${people.map((p) => html`<tr><td>${p.name}</td>${p.cells.map((c) => html`<td class="num">${c.n ? html`${rs(c.paise)}<div class="small quiet">${c.n}×</div>` : ''}</td>`)}<td class="num"><strong>${rs(p.paise)}</strong></td></tr>`)}</tbody></table></div>
      <p class="small quiet">The person who did it at the till. Cancels after KOT also name who approved them, in the list below.</p></section>` : ''}
    <div class="grid2" style="margin-top:16px;align-items:start">
      ${kinds.filter((k) => of(k).length).map((k) => html`<section class="panel"><h2>${LOSS[k]}: why</h2>
        <div class="sums">${reasons(k).map((x) => html`<div><span>${x.reason} (${x.n})</span><span>${rs(x.paise)}</span></div>`)}</div>
        ${k === 'comp' ? html`<h3>By guest or table</h3><div class="sums">${guests.map((x) => html`<div><span>${x.guest} (${x.n})</span><span>${rs(x.paise)}</span></div>`)}</div>` : ''}</section>`)}
      ${r.stock.length ? html`<section class="panel"><h2>Stock broken or missing</h2>
        <div class="scroll"><table class="t"><thead><tr><th>Item</th><th>How</th><th class="num">Qty</th><th class="num">At cost</th></tr></thead><tbody>
          ${r.stock.map((x) => html`<tr><td>${x.name}</td><td>${x.kind === 'waste' ? 'Broken or wasted' : 'Missing at count'}</td><td class="num">${x.qty} ${unit(x)}</td><td class="num">${rs(x.valuePaise)}</td></tr>`)}</tbody></table></div></section>` : ''}
      ${r.cash.some((x) => x.differencePaise) ? html`<section class="panel"><h2>Cash at shift close</h2>
        <div class="sums">${r.cash.filter((x) => x.differencePaise).map((x) => html`<div><span>${dayName(x.day)} · ${x.reason ?? ''}${x.byName ? ` · ${x.byName}` : ''}</span><span style="color:var(${x.differencePaise < 0 ? '--bad' : '--warn'})">${x.differencePaise < 0 ? 'Short' : 'Over'} ${rs(Math.abs(x.differencePaise))}</span></div>`)}</div>
        <p class="small quiet">${plural(r.cash.length, 'shift')} closed in these dates; the rest matched.</p></section>` : ''}
    </div>
    ${r.events.length ? html`<details class="panel" style="margin-top:16px"><summary><strong>Every one, in order (${r.events.length})</strong></summary>
      <div class="scroll"><table class="t"><thead><tr><th>When</th><th>What</th><th>Bill or item</th><th class="num">Amount</th><th>By</th><th>Reason</th></tr></thead><tbody>
        ${r.events.map((e) => html`<tr><td>${dateTime(e.at)}</td><td>${LOSS[e.kind]}</td><td>${e.ref}</td><td class="num">${e.amountPaise == null ? '' : rs(e.amountPaise)}</td><td>${e.byName}</td><td>${e.reason ?? ''}${e.detail ? html`<div class="small quiet">${e.detail}</div>` : ''}</td></tr>`)}</tbody></table></div></details>` : ''}`));
  rerender();
}
actions.csvLoss = () => {
  const r = ui.lossR;
  downloadCsv(`losses-${r.from}_to_${r.to}.csv`, [['Shift', 'What', 'Bill or item', 'Amount (Rs)', 'By', 'Reason', 'Detail'],
    ...r.events.map((e) => [e.day, LOSS[e.kind], e.ref, e.amountPaise == null ? '' : rupees(e.amountPaise), e.byName, e.reason ?? '', e.detail ?? '']),
    ...r.stock.map((x) => [`${r.from} to ${r.to}`, x.kind === 'waste' ? 'Stock broken or wasted' : 'Stock missing at count', `${x.name} · ${x.qty} ${x.unit}`, rupees(x.valuePaise), '', '', '']),
    ...r.cash.filter((x) => x.differencePaise).map((x) => [x.day, x.differencePaise < 0 ? 'Cash short' : 'Cash over', 'Shift close', rupees(Math.abs(x.differencePaise)), x.byName, x.reason ?? '', ''])]);
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
    ${tabsNav('Reports', [['sales', 'Sales'], ['profit', 'Profit'], ['losses', 'Losses'], ['when', 'When and where'], ['sections', 'By section'], ['mix', 'Menu mix'], ['events', 'Events'], ['rooms', 'Rooms'], ['gst', 'GSTR-1'], ['owed', 'Who owes'], ['serving', 'Serving time']].map(([k, t]) => [`#/reports/${k}/${from}_${to}`, t, k]), tab)}
    ${tab === 'gst' ? html`<form class="row" style="align-items:end;margin-bottom:16px"><label class="f">Month<input class="in" type="month" data-model="gstMonth" value="${ui.gstMonth}"></label>
      <button class="btn" type="submit" data-act="gstGo" data-submit>Show</button></form>`
    : tab !== 'owed' && tab !== 'events' ? html`<div class="row" style="align-items:end;margin-bottom:16px;justify-content:space-between">
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
            <td>${e.receiptNo && e.amountPaise > 0 && ['receipt', 'advance'].includes(e.kind) ? html`<span class="quiet">${e.note ?? 'Receipt cancelled'}</span>` : html`${{ charge: 'Bill', receipt: 'Payment', advance: 'Advance paid', advance_used: 'Advance used on bill', refund: 'Advance refunded' }[e.kind]}${e.receiptNo ? ' ' + e.receiptNo : ''}${e.receiptNo && e.amountPaise < 0 ? html`${rcTag(e.cancelled)}${rcBtn(e.settlementId, e.cancelled)}` : ''}`}${e.billNo ? ' ' + e.billNo : ''}${e.mode ? ' · ' + e.mode : ''}</td>
            <td class="num">${e.amountPaise > 0 ? rs(e.amountPaise) : ''}</td><td class="num">${e.amountPaise < 0 ? rs(-e.amountPaise) : ''}</td><td class="num">${rs(bal)}</td></tr>`; }); })()}
        </tbody></table></div></section>` : ''}`));
    rerender();
    return;
  }
  if (tab === 'when' || tab === 'mix') { await insightsTab(tab, head, from, to); return; }
  if (tab === 'sections') { await sectionsTab(head, from, to); return; }
  if (tab === 'events') { await eventsTab(head); return; }
  if (tab === 'profit') { await profitTab(head, from, to); return; }
  if (tab === 'losses') { await lossesTab(head, from, to); return; }
  if (tab === 'gst') { await gstTab(head, ui.gstMonth); return; }
  if (tab === 'rooms') { await roomsReportTab(head, from, to); return; }
  if (tab === 'serving') { await servingTab(head, from, to); return; }
  const r = await api('GET', `${B()}/reports/sales?from=${from}&to=${to}`);
  const sum = (k) => r.byEntity.reduce((t, e) => t + e[k], 0);
  const cnTotal = r.creditNotes.reduce((t, n) => t + n.totalPaise, 0);
  const P = r.paid;
  const vs = (now, was, f = rs) => (was ? `${now >= was ? '+' : '−'}${Math.round((Math.abs(now - was) * 100) / was)}% vs ${f(was)}` : 'nothing to compare');
  const prevName = r.prev.from === r.prev.to ? `${dayName(r.prev.from)}` : `${dayName(r.prev.from)} to ${dayName(r.prev.to)}`;
  const up = (now, was) => (!was ? '' : now >= was ? 'good' : 'bad');
  const weekdays = r.days.length >= 7 ? Object.values(r.days.reduce((acc, d) => {
    const w = new Date(`${d.day}T00:00:00Z`).getUTCDay();
    const x = acc[w] ?? (acc[w] = { w, shifts: 0, netPaise: 0, bills: 0 }); x.shifts += 1; x.netPaise += d.netPaise; x.bills += d.bills; return acc;
  }, {})).sort((a, b) => ((a.w + 6) % 7) - ((b.w + 6) % 7)) : [];
  const wdName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const wdTop = Math.max(1, ...weekdays.map((x) => x.netPaise / x.shifts));
  ui.salesR = r;
  rerender = () => paint(shell('#/reports', html`${head}
    <div class="kpis">${kpi('Net sales', rs(P.netPaise), vs(P.netPaise, r.prev.netPaise), up(P.netPaise, r.prev.netPaise))}
      ${kpi('Bills', String(P.bills), P.bills ? `Average ${rs(Math.round(P.netPaise / P.bills))} · ${vs(P.bills, r.prev.bills, String)}` : '')}
      ${kpi('With GST', rs(P.totalPaise - cnTotal), cnTotal ? `After ${rs(cnTotal)} of credit notes` : 'What guests paid for')}
      ${kpi('Discounts', rs(P.discountPaise), P.grossPaise ? `${pct(P.discountPaise, P.grossPaise)} of items` : '', P.discountPaise ? 'warn' : '')}
      ${r.nc.bills ? kpi('NC and complimentary', String(r.nc.bills), `${rs(r.nc.menuPaise)} at menu price · not in sales`, 'warn') : ''}
      ${r.voids.length ? kpi('Void bills', String(r.voids.length), rs(r.voids.reduce((t, v) => t + v.totalPaise, 0)), 'bad') : ''}</div>
    <p class="small quiet" style="margin:-4px 0 12px">Net sales = after discounts, before GST, liquor included. NC and complimentary bills are not sales. Compared with ${prevName}.</p>
    <div class="row" style="margin-bottom:12px"><span class="small quiet">Download for Excel:</span>
      <button class="btn" type="button" data-act="csvSales" data-what="items">Items sold</button>
      <button class="btn" type="button" data-act="csvSales" data-what="pay">Payments</button>
      <button class="btn" type="button" data-act="csvSales" data-what="days">Sales by shift</button>
      <button class="btn" type="button" data-act="csvSales" data-what="gst">Sales by name on the bill</button></div>
    ${weekdays.length ? html`<section class="panel" style="margin-bottom:16px"><h2>By day of the week</h2>
      <div class="hours">${weekdays.map((x) => html`<div class="hrow"><span class="small">${wdName[x.w]}</span>${bar(x.netPaise / x.shifts, wdTop)}<span class="num small">${rs(Math.round(x.netPaise / x.shifts))} a day · ${x.shifts} shift${x.shifts === 1 ? '' : 's'}</span></div>`)}</div>
      <p class="small quiet">Average net sales per shift on each day of the week.</p></section>` : ''}
    <section class="panel"><h2>Sales by name on the bill</h2>
      <p class="small quiet">For GST: every bill printed, NC and complimentary included.</p>
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
        ${r.days.length > 1 ? html`<h2>By shift (net sales)</h2><div class="sums">${r.days.map((d) => html`<div><span>${dayName(d.day)} (${d.bills} bills)</span><span>${rs(d.netPaise)}</span></div>`)}</div>` : ''}</section>
      <section class="panel"><h2>Items sold</h2><p class="small quiet">Paid bills only, before bill discounts.</p><div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
        ${r.items.map((i) => html`<tr><td>${i.name}</td><td class="num">${i.qty}</td><td class="num">${rs(i.amountPaise)}</td></tr>`)}</tbody></table></div></section>
    </div>`));
  rerender();
}
actions.csvSales = (d) => {
  const r = ui.salesR; const m = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Posted to rooms', credit: 'On credit', comp: 'Complimentary', advance: 'Advances used' };
  const range = `${r.from}_to_${r.to}`;
  if (d.what === 'items') downloadCsv(`items-sold-${range}.csv`, [['Item', 'Qty', 'Amount (Rs)'], ...r.items.map((i) => [i.name, i.qty, rupees(i.amountPaise)])]);
  if (d.what === 'pay') downloadCsv(`payments-${range}.csv`, [['Payment', 'Count', 'Amount (Rs)'], ...r.byMode.map((x) => [m[x.mode] ?? x.mode, x.n, rupees(x.paise)])]);
  if (d.what === 'days') downloadCsv(`sales-by-shift-${range}.csv`, [['Shift', 'Bills', 'Net sales (Rs)', 'With GST (Rs)'], ...r.days.map((x) => [x.day, x.bills, rupees(x.netPaise), rupees(x.totalPaise)])]);
  if (d.what === 'gst') downloadCsv(`sales-by-billing-name-${range}.csv`, [['Name on bill', 'GSTIN', 'Bills', 'First bill', 'Last bill', 'Items (Rs)', 'Discount (Rs)', 'Taxable (Rs)', 'Liquor, no GST (Rs)', 'CGST (Rs)', 'SGST (Rs)', 'Round off (Rs)', 'Total (Rs)'],
    ...r.byEntity.map((e) => [e.name, e.gstin ?? '', e.bills, e.firstBill, e.lastBill, rupees(e.grossPaise), rupees(e.discountPaise), rupees(e.taxablePaise), rupees(e.nonGstPaise), rupees(e.cgstPaise), rupees(e.sgstPaise), rupees(e.roundOffPaise), rupees(e.totalPaise)]),
    ...r.creditNotes.map((n) => [`Less credit notes: ${n.name}`, '', n.n, n.first, n.last, '', '', rupees(-n.taxablePaise), rupees(-n.nonGstPaise), rupees(-n.cgstPaise), rupees(-n.sgstPaise), '', rupees(-n.totalPaise)])]);
};
actions.repGo = () => go(`#/reports/${ui.repTab ?? 'sales'}/${ui.from}_${ui.to}`);
actions.statement = async (d) => { ui.statement = await api('GET', `${B()}/debtors/${d.id}`); rerender(); };
actions.printStatement = () => {
  const st = ui.statement; let bal = 0;
  printJobs([{ kind: 'bill', html: asHtml(html`<div class="receipt"><div class="hd">${me.business.name}</div><div class="c">STATEMENT</div><div>${st.account.name}</div><hr>
    ${st.entries.map((e) => { bal += e.amountPaise; return html`<div class="rl"><span>${dateTime(e.at)} ${e.billNo ?? e.kind}</span><span>${rs(e.amountPaise)}</span></div>`; })}
    <hr><div class="rl" style="font-weight:700"><span>Balance</span><span>${rs(bal)}</span></div></div>`) }]);
};

// ---------- stock (Owner and manager)

// ---------- Stock: To buy (from how fast things go), Purchases (what was bought, by vendor, price rises), Consumption
// (what was used and by which dishes). 22 Nov 2026.
function buyTab(qtyText) {
  const b = ui.buy;
  const need = b.items.filter((i) => i.why);
  const shown = ui.buyAll ? b.items : need;
  const packs = (i) => (ui.buyQty[i.id] !== undefined ? ui.buyQty[i.id] : i.orderPacks);
  const vendors = [...new Set(shown.map((i) => i.lastVendor ?? 'No vendor yet'))].sort((x, y) => (x === 'No vendor yet') - (y === 'No vendor yet') || x.localeCompare(y));
  const fmt = (i) => ({ ...i, byStore: {}, packName: i.packName });
  return html`<section class="panel"><h2>To buy</h2>${errorBox()}
    <form class="row" style="align-items:end"><label class="f">Usage from the last (days)<input class="in" inputmode="numeric" data-model="byDays" value="${ui.byDays}" style="width:110px"></label>
      <label class="f">Order enough for (days)<input class="in" inputmode="numeric" data-model="byCover" value="${ui.byCover}" style="width:110px"></label>
      <button class="btn" type="submit" data-act="buyGo" data-submit>Work out again</button>
      <label class="tickline" style="margin-left:auto"><input type="checkbox" class="sel" data-model="buyAll" data-act-change="buyAllTick" ${ui.buyAll ? 'checked' : ''}> Show every item</label></form>
    <p class="small quiet">An item needs buying when it is at or below its reorder level, has under ${b.lead} days left at its recent rate of use, or the book shows below zero (count it). The order is enough for ${b.cover} days plus the reorder level; change any amount before copying.</p>
    ${shown.length ? vendors.map((v) => {
      const list = shown.filter((i) => (i.lastVendor ?? 'No vendor yet') === v);
      const est = list.reduce((t, i) => t + (Number(packs(i)) || 0) * i.costPerPackPaise, 0);
      return html`<div class="vendorblock"><div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">${v}</h3>
          <span class="small">${est ? `About ${rs(est)}` : ''} <button class="btn" type="button" data-act="buyCopy" data-v="${v}">Copy order</button></span></div>
        <div class="scroll"><table class="t cards"><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Used a day</th><th class="num">Days left</th><th>Why</th><th class="num">Order</th></tr></thead><tbody>
          ${list.map((i) => html`<tr><td data-label="Item"><strong>${i.name}</strong></td><td data-label="On hand" class="num" style="${i.onHand < 0 ? 'color:var(--bad)' : ''}">${qtyText(i.onHand, fmt(i))}</td>
            <td data-label="Used a day" class="num">${i.usedPerDay ? `${i.usedPerDay} ${i.unit}` : '—'}</td><td data-label="Days left" class="num">${i.daysLeft ?? '—'}</td>
            <td data-label="Why">${i.why ? html`<span class="tag-check">${i.why}</span>` : html`<span class="small quiet">enough</span>`}</td>
            <td data-label="Order" class="num"><input class="in mkqty" inputmode="numeric" data-act-change="buyQty" data-id="${i.id}" value="${packs(i)}" aria-label="${i.name}: ${i.packName}s to order"> <span class="small">${i.packName}s</span></td></tr>`)}</tbody></table></div></div>`;
    }) : html`<p class="quiet">${b.items.length ? 'Nothing needs buying right now.' : 'No stock items yet.'}</p>`}
    <p class="small quiet">Reorder levels are set on Stock items. Usage is sales by recipe, breakage and what counts found missing.</p></section>`;
}
actions.buyGo = () => route();
actions.buyAllTick = (_d, el) => { ui.buyAll = el.checked; rerender(); };
actions.buyQty = (d, el) => { ui.buyQty[d.id] = el.value.trim(); };
// An order for one vendor, ready to paste into WhatsApp or an email.
actions.buyCopy = async (d) => {
  const list = (ui.buyAll ? ui.buy.items : ui.buy.items.filter((i) => i.why)).filter((i) => (i.lastVendor ?? 'No vendor yet') === d.v);
  const lines = list.map((i) => [i, Number(ui.buyQty[i.id] ?? i.orderPacks)]).filter(([, n]) => n > 0).map(([i, n]) => `${i.name}: ${n} ${i.packName}${n === 1 ? '' : 's'}`);
  if (!lines.length) throw new Error('Nothing to order from this vendor: every amount is zero.');
  const text = `Order from ${me.business.name}${d.v === 'No vendor yet' ? '' : ` for ${d.v}`}:\n${lines.join('\n')}`;
  try { await navigator.clipboard.writeText(text); flash = { kind: 'ok', text: `Order copied (${plural(lines.length, 'line')}). Paste it into WhatsApp or an email.` }; }
  catch { flash = { kind: 'warn', text: `Copy this order: ${text.replace(/\n/g, ' · ')}` }; }
  rerender();
};
function purchasesTab() {
  const p = ui.pur;
  return html`<section class="panel"><h2>Purchases</h2>${errorBox()}
    <form class="row" style="align-items:end"><label class="f">From<input class="in" type="date" data-model="puFrom" value="${ui.puFrom}"></label><label class="f">To<input class="in" type="date" data-model="puTo" value="${ui.puTo}"></label>
      <button class="btn" type="submit" data-act="puGo" data-submit>Show</button></form>
    ${p.receipts.length ? html`<div class="grid2" style="align-items:start;margin-top:12px">
      <div><h3>By vendor</h3><div class="sums">${p.byVendor.map((v) => html`<div><span>${v.vendor} (${plural(v.receipts, 'bill')})</span><span>${rs(v.amountPaise)}</span></div>`)}
        <div><span><strong>Total bought</strong></span><span><strong>${rs(p.totalPaise)}</strong></span></div></div></div>
      <div><h3>Price rises</h3>${p.receipts.flatMap((r) => r.lines.filter((l) => l.risePct >= 5).map((l) => html`<div class="small"><strong>${l.item}</strong>: ${rs(l.prevCostPerPackPaise)} → ${rs(l.costPerPackPaise)} a ${l.packName} (+${l.risePct}%) · ${r.vendor}, ${dayName(r.day)}</div>`)).slice(0, 20)}
        ${p.receipts.some((r) => r.priceRises) ? '' : html`<p class="small quiet">No price rose 5% or more in these dates.</p>`}</div></div>
      <h3 style="margin-top:16px">Bills</h3>
      ${p.receipts.map((r) => html`<details class="receipt-row"><summary><span><strong>${r.opening ? 'Opening stock' : r.vendor}</strong>${r.invoice ? ` · ${r.invoice}` : ''} · ${dayName(r.day)} · ${r.store}${r.priceRises ? html` <span class="tag-check">${plural(r.priceRises, 'price rise')}</span>` : ''}</span><span>${rs(r.amountPaise)}</span></summary>
        <div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">Packs</th><th class="num">Price a pack</th><th class="num">Amount</th></tr></thead><tbody>
          ${r.lines.map((l) => html`<tr><td>${l.item}</td><td class="num">${l.packs} ${l.packName}${l.packs === 1 ? '' : 's'}</td><td class="num">${l.costPerPackPaise != null ? rs(l.costPerPackPaise) : '—'}${l.risePct ? html`<div class="small" style="color:${l.risePct > 0 ? 'var(--bad)' : 'var(--go-dark)'}">${l.risePct > 0 ? '+' : ''}${l.risePct}% on ${rs(l.prevCostPerPackPaise)}</div>` : ''}</td><td class="num">${rs(l.amountPaise)}</td></tr>`)}</tbody></table></div>
        <p class="small quiet">${r.by ? `Received by ${r.by}` : ''}${r.photo ? html` · <a href="/api${B()}/stock/bills/${r.billId}/photo" target="_blank" rel="noopener">See the bill photo</a>` : ''}</p></details>`)}`
      : html`<p class="quiet">Nothing received in these dates.</p>`}</section>`;
}
// The dates chosen on Purchases and Consumption stay when Show reloads the screen (26 Nov 2026: they went back to the
// default because a reload clears the screen's state).
const stockPicks = {};
actions.puGo = () => { Object.assign(stockPicks, { puFrom: ui.puFrom, puTo: ui.puTo }); route(); };
function useTab(storeSel) {
  const u = ui.use;
  const unitQty = (q, i) => (i.packSize > 1 && i.unit !== 'pcs' && Math.abs(q) >= i.packSize ? `${q} ${i.unit} (${(q / i.packSize).toFixed(1)})` : `${q} ${i.unit}`);
  return html`<section class="panel"><h2>Consumption</h2>${errorBox()}
    <form class="row" style="align-items:end"><label class="f">Store<select class="in" data-model="uStore"><option value="">All stores</option>${ui.st.stores.map((x) => html`<option value="${x.id}" ${ui.uStore === x.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>
      <label class="f">From<input class="in" type="date" data-model="uFrom" value="${ui.uFrom}"></label><label class="f">To<input class="in" type="date" data-model="uTo" value="${ui.uTo}"></label>
      <button class="btn" type="submit" data-act="useGo" data-submit>Show</button></form>
    ${u.items.length ? html`<div class="sums" style="max-width:520px;margin:12px 0"><div><span>Used in ${plural(u.days, 'day')}, at the last price paid</span><span><strong>${rs(u.totals.usedValuePaise)}</strong></span></div>
        <div><span>of which breakage</span><span>${rs(u.totals.wasteValuePaise)}</span></div><div><span>of which missing at counts</span><span style="${u.totals.missingValuePaise ? 'color:var(--bad)' : ''}">${rs(u.totals.missingValuePaise)}</span></div>
        <div><span>Sent to kitchen or bar, not on a bill</span><span style="${u.totals.notBilledValuePaise ? 'color:var(--warn)' : ''}">${rs(u.totals.notBilledValuePaise ?? 0)}</span></div></div>
      <div class="usewrap ${ui.useSel ? 'two' : ''}"><div class="scroll"><table class="t cards"><thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Breakage</th><th class="num">Missing</th><th class="num">Used</th><th class="num">A day</th><th class="num">Value</th><th>Used most by</th></tr></thead><tbody>
        ${u.items.map((i) => html`<tr class="userow ${ui.useSel === i.id ? 'on' : ''}" data-act="useRow" data-id="${i.id}" tabindex="0" title="Tap to see the bills, KOTs and breakage behind it"><td data-label="Item"><strong>${i.name}</strong>${i.extra ? html`<div class="small quiet">+${i.extra} ${i.unit} found extra at counts</div>` : ''}</td>
          <td data-label="Sold" class="num">${unitQty(i.sold, i)}${i.notBilled ? html`<div class="small" style="color:var(--warn)">${unitQty(i.notBilled, i)} not billed</div>` : ''}</td><td data-label="Breakage" class="num">${i.waste ? unitQty(i.waste, i) : '—'}</td>
          <td data-label="Missing" class="num" style="${i.missing ? 'color:var(--bad)' : ''}">${i.missing ? unitQty(i.missing, i) : '—'}</td><td data-label="Used" class="num"><strong>${unitQty(i.used, i)}</strong></td>
          <td data-label="A day" class="num">${i.perDay} ${i.unit}</td><td data-label="Value" class="num">${rs(i.usedValuePaise)}</td>
          <td data-label="Used most by" class="small">${i.topDishes.length ? i.topDishes.map((d) => `${d.dish} (${d.qty})`).join(', ') : html`<span class="quiet">—</span>`}</td></tr>`)}</tbody></table></div>
      ${useSide(unitQty)}</div>
      <p class="small quiet">Tap a row to see what is behind it. Sold is by each dish's recipe when it was sent to the kitchen or bar (orders before 25 Nov, 8 am: when the bill was paid). Not billed is what was sent but is on no bill: tables still open, walkouts, or food that left without a bill. A cancelled KOT puts its stock back, so food made and then cancelled shows as missing at the count. Missing is what counts found short of the book. Values are at the last price paid.</p>`
      : html`<p class="quiet">Nothing was used in these dates${ui.uStore ? ' from this store' : ''}.</p>`}</section>`;
}
// What is behind one Consumption row (26 Nov 2026), loaded when the row is tapped.
function useSide(unitQty) {
  const d = ui.useDet;
  if (!ui.useSel) return '';
  if (!d) return html`<section class="panel usedet"><p class="quiet">Loading…</p></section>`;
  const i = ui.use.items.find((x) => x.id === ui.useSel) ?? { unit: d.item.unit, packSize: 1 };
  const q = (n) => unitQty(n, i);
  const sec = (title, list, row, none) => html`<h3 class="usedh">${title}</h3>${list.length ? html`<div class="uselist">${list.map(row)}</div>` : html`<p class="small quiet">${none}</p>`}`;
  const state = (o) => (o.status === 'tab' ? 'on a tab' : o.status === 'open' ? 'table still open' : 'bill voided');
  return html`<section class="panel usedet" id="usedet"><div class="row" style="justify-content:space-between;align-items:center"><h2>${d.item.name}</h2>
      <button class="btn ghost sm" type="button" data-act="useClose">Close</button></div>
    <p class="small quiet" style="margin:0">${dayName(d.from)} to ${dayName(d.to)}${ui.uStore ? '' : ' · all stores'}</p>
    ${sec('Sold on bills', d.bills, (b) => html`<div class="useln"><a class="mono" href="#/done/${b.id}">${b.billNo}</a><span>${b.place} · ${dateTime(b.at)}<span class="small quiet"> · ${b.dishes}</span></span><span class="num">${q(b.units)}</span></div>`, 'None in these dates.')}
    ${sec('Sent to the kitchen or bar, not on a bill', d.unbilled, (o) => html`<div class="useln"><a href="#/order/${o.orderId}">${o.kots ? `KOT ${o.kots}` : o.place}</a><span>${o.place} · ${dateTime(o.at)}${o.by ? ` · ${o.by}` : ''} <span class="badge ${o.status === 'open' || o.status === 'tab' ? 'open' : 'void'}">${state(o)}</span><span class="small quiet"> · ${o.dishes}</span></span><span class="num">${q(o.units)}</span></div>`, 'Everything sent was billed.')}
    ${sec('Breakage and missing', d.losses, (m) => html`<div class="useln"><span>${dateTime(m.at)}</span><span>${m.kind === 'breakage' ? 'Breakage' : 'Missing at count'}${m.reason ? ` · ${m.reason}` : ''} · ${m.store}${m.by ? ` · ${m.by}` : ''}</span><span class="num">${q(m.qty)}</span></div>`, 'None.')}
  </section>`;
}
actions.useRow = async (d) => {
  if (ui.useSel === d.id) { ui.useSel = null; ui.useDet = null; rerender(); return; }
  ui.useSel = d.id; ui.useDet = null; rerender();
  const r = await api('GET', `${B()}/stock/consumption/item?itemId=${d.id}&from=${ui.uFrom}&to=${ui.uTo}${ui.uStore ? `&storeId=${ui.uStore}` : ''}`);
  if (ui.useSel !== d.id) return;
  ui.useDet = r; rerender();
  document.getElementById('usedet')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches?.('tr.userow')) { ev.preventDefault(); actions.useRow({ id: ev.target.dataset.id }); } });
actions.useClose = () => { ui.useSel = null; ui.useDet = null; rerender(); };
actions.useGo = () => { Object.assign(stockPicks, { uFrom: ui.uFrom, uTo: ui.uTo, uStore: ui.uStore }); route(); };

async function stockScreen(tab = 'hand') {
  // Bar staff count (27 Nov 2026): without the rest of Stock, they see only Count.
  const full = can('stock.edit');
  if (!full) tab = 'count';
  const st = full ? await api('GET', `${B()}/stock`) : { stores: [], items: [], recipes: [] };
  await load('menu');
  ui.st = st;
  const tabs = !full ? [['count', 'Count']] : [['hand', 'On hand'], ['buy', 'To buy'], ['receive', 'Receive'], ['purchases', 'Purchases'], ['transfer', 'Transfer'], ['waste', 'Breakage'], ['count', 'Count'],
    ['use', 'Consumption'], ['handover', 'Bar handover'], ['report', 'Report'], ['items', 'Stock items'], ['recipes', 'Recipes']];
  // The old Make recipes address opens Recipes with Make recipes showing.
  if (tab === 'auto') { tab = 'recipes'; ui.mkOpen = true; }
  const low = st.items.filter((i) => i.active && i.low).length;
  const head = html`${pageHead('Stock', `Bar and kitchen stores${low ? ` · ${plural(low, 'item')} below reorder level` : ''}`)}${tabsNav('Stock', tabs.map(([k, t]) => [`#/stock/${k}`, t, k]), tab)}`;
  const items = st.items.filter((i) => i.active);
  const storeSel = (model, label) => html`<label class="f">${label}<select class="in" data-model="${model}"><option value="">Choose</option>${st.stores.map((x) => html`<option value="${x.id}" ${ui[model] === x.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>`;
  const itemSel = (model) => html`<label class="f">Item<select class="in" data-model="${model}"><option value="">Choose</option>${items.map((i) => html`<option value="${i.id}" ${ui[model] === i.id ? 'selected' : ''}>${i.name} (${i.unit})</option>`)}</select></label>`;
  const qtyText = (q, i) => i.unit === 'ml' || i.unit === 'g' ? `${q} ${i.unit}${i.packSize > 1 && Math.abs(q) >= i.packSize ? ` (${(q / i.packSize).toFixed(1)} ${i.packName})` : ''}` : `${q} ${i.unit}`;
  if (tab === 'report') { ui.rFrom ??= me.business.shiftDay; ui.rTo ??= me.business.shiftDay; ui.rStore ??= st.stores.find((x) => x.kind === 'bar')?.id ?? st.stores[0]?.id; }
  if (tab === 'handover') { ui.hFrom ??= me.business.shiftDay; ui.hTo ??= me.business.shiftDay; ui.hStore ??= st.stores.find((x) => x.kind === 'bar')?.id ?? st.stores[0]?.id; }
  if (tab === 'count') await countLoad();
  if (tab === 'handover' && ui.hStore) ui.handovers = await api('GET', `${B()}/stock/handovers?from=${ui.hFrom}&to=${ui.hTo}&storeId=${ui.hStore}`);
  if (tab === 'recipes') {
    ui.mkSections = (await api('GET', `${B()}/stock/recipes/sections`)).sections;
    ui.mkCats ??= ui.mkSections.filter((x) => x.bar).map((x) => x.category);
    if (!st.recipes.length) ui.mkOpen = true;      // nothing yet: start with Make recipes
  }
  if (tab === 'report' && ui.rStore) ui.report = await api('GET', `${B()}/stock/report?from=${ui.rFrom}&to=${ui.rTo}&storeId=${ui.rStore}`);
  if (tab === 'buy') { ui.byDays ??= '14'; ui.byCover ??= '7'; ui.buy = await api('GET', `${B()}/stock/shortages?days=${int(ui.byDays) || 14}&cover=${int(ui.byCover) || 7}`); ui.buyQty = {}; }
  if (tab === 'purchases') { ui.puFrom ??= stockPicks.puFrom ?? addDays(me.business.shiftDay, -29); ui.puTo ??= stockPicks.puTo; ui.puTo ??= me.business.shiftDay; ui.pur = await api('GET', `${B()}/stock/purchases?from=${ui.puFrom}&to=${ui.puTo}`); }
  if (tab === 'use') { ui.uFrom ??= stockPicks.uFrom ?? addDays(me.business.shiftDay, -6); ui.uTo ??= stockPicks.uTo ?? me.business.shiftDay; ui.uStore ??= stockPicks.uStore ?? ''; ui.use = await api('GET', `${B()}/stock/consumption?from=${ui.uFrom}&to=${ui.uTo}${ui.uStore ? `&storeId=${ui.uStore}` : ''}`); }
  if (tab === 'receive') ui.drafts = (await api('GET', `${B()}/stock/bills`)).bills;
  rerender = () => {
    let body = '';
    if (tab === 'recipes') body = recipesTab();
    else if (tab === 'items') body = stockItemsTab();
    else if (!st.stores.length) body = html`<section class="panel"><p>No stores yet. Add a Bar (and a Kitchen or Main store) on <a href="#/stock/items">Stock items</a>, under Stores.</p></section>`;
    else if (tab === 'buy') body = buyTab(qtyText);
    else if (tab === 'purchases') body = purchasesTab();
    else if (tab === 'use') body = useTab(storeSel);
    else if (tab === 'hand') body = html`<section class="panel"><h2>Stock on hand</h2>${errorBox()}
      <div class="toolbar"><input class="in" type="search" data-model="ohQ" data-live value="${ui.ohQ ?? ''}" placeholder="Search stock items" aria-label="Search stock items">
        ${items.some((i) => i.total < 0) ? html`<span class="small" style="color:var(--bad)">${plural(items.filter((i) => i.total < 0).length, 'item')} below zero: count ${items.filter((i) => i.total < 0).length === 1 ? 'it' : 'them'}</span>` : ''}
        ${low ? html`<a class="small" href="#/stock/buy">${plural(low, 'item')} to buy →</a>` : ''}</div>
      <div class="scroll"><table class="t"><thead><tr><th>Item</th>${st.stores.map((x) => html`<th class="num">${x.name}</th>`)}<th class="num">Total</th><th class="num">Value</th></tr></thead><tbody>
      ${items.filter((i) => !ui.ohQ || i.name.toLowerCase().includes(ui.ohQ.toLowerCase())).map((i) => html`<tr><td>${i.name}${i.low ? html`<div class="small" style="color:var(--bad)">Below reorder level (${qtyText(i.reorderLevel, i)})</div>` : ''}</td>
        ${st.stores.map((x) => html`<td class="num" style="${i.byStore[x.id] < 0 ? 'color:var(--bad)' : ''}">${qtyText(i.byStore[x.id], i)}</td>`)}<td class="num"><strong>${qtyText(i.total, i)}</strong></td><td class="num">${rs(i.valuePaise)}</td></tr>`)}
      <tr><td><strong>Total value</strong></td>${st.stores.map(() => html`<td></td>`)}<td></td><td class="num"><strong>${rs(items.reduce((t, i) => t + i.valuePaise, 0))}</strong></td></tr></tbody></table></div>
      <p class="small quiet">Value is at the last price paid. Bar sales take stock from the bar store when a bill is settled, by each menu item's recipe.</p></section>`;
    else if (tab === 'receive') {
      ui.rcLines ??= [{ k: 1, desc: '' }];
      const lineTotal = ui.rcLines.reduce((t, l) => t + (int(ui[`rcl${l.k}packs`]) || 0) * (toPaise(ui[`rcl${l.k}cost`] ?? '') ?? 0), 0);
      const billTotal = ui.rcTotal != null ? Math.round(ui.rcTotal * 100) : null;
      const lastCost = (it) => it?.costPerPackPaise || 0;
      body = html`${ui.drafts?.length && !ui.rcBillId ? html`<section class="panel"><h2>Bills waiting to be received</h2>
          <p class="small quiet">Photographed but not received yet. Open one to check it and receive the goods, or discard it.</p>
          <div class="scroll"><table class="t"><tbody>${ui.drafts.map((d) => html`<tr><td><strong>${d.vendor ?? 'Unknown supplier'}</strong>${d.invoiceNo ? ` · ${d.invoiceNo}` : ''}<div class="small quiet">${dateTime(d.createdAt)}${d.by ? ` · ${d.by}` : ''}${d.read ? ` · ${plural(d.read.lines.length, 'line')} read` : d.error ? ' · not read' : ''}</div></td>
            <td class="act"><div class="row" style="justify-content:flex-end">${d.photo ? html`<a class="btn" href="/api${B()}/stock/bills/${d.id}/photo" target="_blank" rel="noopener">Photo</a>` : ''}<button class="btn pri" type="button" data-act="draftOpen" data-id="${d.id}">Open</button>${iconBtn('draftDel', d.id, 'trash', `Discard the bill from ${d.vendor ?? 'unknown supplier'}`, 'danger')}</div></td></tr>`)}</tbody></table></div></section>` : ''}
      ${ui.rcOpening ? '' : html`<section class="panel"><h2>Supplier bill</h2>
        <p class="small quiet">Take a photo of the bill, or choose one. Claude reads it into the lines below; you check every line before anything is received. You can also type the bill in without a photo.</p>
        <div class="row"><label class="btn pri" style="${ui.rcReading ? 'pointer-events:none;opacity:.6' : ''}">${ui.rcReading ? 'Reading the bill…' : ui.rcBillId ? 'Take another photo' : 'Take or choose photo'}<input type="file" accept="image/*" data-bill-photo class="vh"></label>
          ${ui.rcBillId ? html`<a class="btn" href="/api${B()}/stock/bills/${ui.rcBillId}/photo" target="_blank" rel="noopener">See the photo</a>` : ''}</div>
        ${ui.rcReading ? html`<p class="small quiet">This can take up to a minute.</p>` : ''}
        ${ui.rcError ? html`<div class="msg warn">${ui.rcError}</div>` : ''}
        ${ui.rcRead ? html`<div class="msg ok">Read ${ui.rcLines.length} line${ui.rcLines.length === 1 ? '' : 's'}${ui.rcUnmatched ? `; ${ui.rcUnmatched} need${ui.rcUnmatched === 1 ? 's' : ''} a stock item chosen` : ''}. Check quantities and prices against the photo.</div>` : ''}</section>`}
      <form class="panel" style="margin-top:16px"><h2>${ui.rcOpening ? 'Opening stock' : 'Check and receive'}</h2>${errorBox()}
        ${ui.rcBillId ? '' : html`<label class="tickline"><input type="checkbox" class="sel" data-model="rcOpening" data-act-change="rcOpenTick" ${ui.rcOpening ? 'checked' : ''}> Opening stock: what is on the shelf now, when you start keeping stock (not a purchase; not counted as spend)</label>`}
        <div class="grid3">${storeSel('rcStore', 'Into store')}${ui.rcOpening ? '' : html`<label class="f">Vendor<input class="in" data-model="rcVendor" value="${ui.rcVendor ?? ''}"></label>
          <label class="f">Invoice number<input class="in" data-model="rcInv" value="${ui.rcInv ?? ''}"></label>`}</div>
        <div class="scroll"><table class="t"><thead><tr><th>Stock item</th><th class="num">Packs</th><th class="num">Price paid per pack, tax included (₹)</th><th class="num">Amount</th><th></th></tr></thead><tbody>
          ${ui.rcLines.map((l) => {
            const it = items.find((i) => i.id === ui[`rcl${l.k}item`]);
            const amt = (int(ui[`rcl${l.k}packs`]) || 0) * (toPaise(ui[`rcl${l.k}cost`] ?? '') ?? 0);
            return html`<tr><td><select class="in" data-model="rcl${l.k}item" aria-label="Stock item" style="${it ? '' : 'border-color:var(--warn-line)'}"><option value="">Choose</option>${items.map((i) => html`<option value="${i.id}" ${it?.id === i.id ? 'selected' : ''}>${i.name} (${i.packName} of ${i.packSize} ${i.unit})</option>`)}</select>
                ${l.desc ? html`<div class="small quiet">On the bill: ${l.desc}</div>` : ''}</td>
              <td class="num"><input class="in" style="max-width:90px;min-width:60px" inputmode="numeric" data-live data-model="rcl${l.k}packs" value="${ui[`rcl${l.k}packs`] ?? ''}" aria-label="Packs">${it ? html`<div class="small quiet">${it.packName}s</div>` : ''}</td>
              <td class="num"><input class="in" style="max-width:120px" inputmode="decimal" data-live data-model="rcl${l.k}cost" value="${ui[`rcl${l.k}cost`] ?? ''}" aria-label="Price per pack">
                ${(() => { const c = toPaise(ui[`rcl${l.k}cost`] ?? ''); const was = lastCost(it); return it && c && was && c > was * 1.05 ? html`<div class="small" style="color:var(--bad)">${Math.round(((c - was) * 100) / was)}% more than last time (${rs(was)})</div>` : ''; })()}</td>
              <td class="num">${amt ? rs(amt) : ''}</td>
              <td><button class="ibtn danger" type="button" data-act="rcDrop" data-k="${l.k}" title="Remove this line" aria-label="Remove this line">${ICON.trash}</button></td></tr>`;
          })}</tbody></table></div>
        <div class="row" style="justify-content:space-between"><button class="btn" type="button" data-act="rcAdd">Add a line</button>
          <div class="sums" style="min-width:260px"><div><span>Lines total</span><span>${rs(lineTotal)}</span></div>
            ${billTotal != null ? html`<div><span>Bill total (read)</span><span>${rs(billTotal)}</span></div>
              ${Math.abs(billTotal - lineTotal) >= 100 ? html`<div style="color:var(--bad)"><span>Difference</span><span>${rs(billTotal - lineTotal)}</span></div>` : ''}` : ''}</div></div>
        <div><button class="btn pri" type="submit" data-act="stReceive" data-submit>${ui.rcOpening ? 'Save opening stock' : 'Receive'}</button></div></form>`;
    }
    else if (tab === 'transfer') body = html`<form class="panel"><h2>Move stock between stores</h2>${errorBox()}<div class="grid3">${storeSel('trFrom', 'From')}${storeSel('trTo', 'To')}${itemSel('trItem')}
        <label class="f">Quantity (${items.find((i) => i.id === ui.trItem)?.unit ?? 'units'})<input class="in" inputmode="numeric" data-model="trQty" value="${ui.trQty ?? ''}"></label></div>
      <p class="small quiet">A 750 ml bottle is 750; a case of 12 beers is 12.</p><div><button class="btn pri" type="submit" data-act="stTransfer" data-submit>Move</button></div></form>`;
    else if (tab === 'waste') body = html`<form class="panel"><h2>Breakage, spillage or loss</h2>${errorBox()}<div class="grid3">${storeSel('waStore', 'Store')}${itemSel('waItem')}
        <label class="f">Quantity (${items.find((i) => i.id === ui.waItem)?.unit ?? 'units'})<input class="in" inputmode="numeric" data-model="waQty" value="${ui.waQty ?? ''}"></label>
        <label class="f" style="grid-column:1/-1">Reason (required)<input class="in" data-model="waReason" value="${ui.waReason ?? ''}" placeholder="e.g. Bottle broken"></label></div>
      <div><button class="btn pri" type="submit" data-act="stWaste" data-submit>Record</button></div><p class="small quiet">Shown on the exceptions report with who recorded it.</p></form>`;
    else if (tab === 'count') {
      body = countView(st);
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
            <div class="big"><span>Actual cost · cost %</span><span>${r.cost.actualCostPaise < 0 ? 'Below zero: a count found more than was entered. Check that opening stock was entered.' : `${rs(r.cost.actualCostPaise)} · ${pct(r.cost.actualCostPaise, r.cost.salesPaise) || '–'}`}</span></div></div>
            <p class="small quiet">Costs are at the last price paid. The gap between expected and actual cost % is what leaked: breakage plus stock missing at the count. Count often (daily for the bar) so missing stock shows up the same week.</p>` : ''}
          <div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">Opening</th><th class="num">Received</th><th class="num">In</th><th class="num">Out</th><th class="num">Sold</th><th class="num">Breakage</th><th class="num">Variance</th><th class="num">Closing</th></tr></thead><tbody>
          ${r.items.map((i) => html`<tr><td>${i.name} <span class="small quiet">${i.unit}</span></td><td class="num">${i.opening}</td><td class="num">${i.received}</td><td class="num">${i.transferIn}</td><td class="num">${i.transferOut}</td><td class="num">${i.sold}</td>
            <td class="num">${i.waste}${i.waste ? html`<div class="small quiet">${rs(i.wasteValuePaise)}</div>` : ''}</td><td class="num" style="${i.variance ? 'color:var(--bad)' : ''}">${i.variance}${i.variance ? html`<div class="small">${rs(i.varianceValuePaise)}</div>` : ''}</td>
            <td class="num"><strong>${i.closing}</strong><div class="small quiet">${rs(i.closingValuePaise)}</div></td></tr>`)}</tbody></table></div>
          <p class="small quiet">Sold comes from bills by recipe. Variance is what counts found against the book: a minus means stock went missing.</p>` : ''}</section>`;
    }
    paint(shell('#/stock', html`${head}${body}`));
  };
  rerender();
}
const int = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(v) : NaN);

// ---------- Stock items (Stock): what is bought and counted, and the stores
function stockItemsTab() {
  const st = ui.st;
  ui.siQ ??= ''; ui.siU ??= '';
  const used = (id) => new Set(st.recipes.filter((r) => r.stockItemId === id).map((r) => r.menuItemId)).size;
  const words = ui.siQ.toLowerCase().split(/\s+/).filter(Boolean);
  const list = st.items.filter((i) => (!ui.siU || i.unit === ui.siU) && words.every((w) => i.name.toLowerCase().includes(w)));
  const unitName = { ml: 'ml', g: 'g', pcs: 'pcs' };
  const formOpen = ui.siOpen || ui.siEditId;
  return html`${st.stores.some((x) => x.kind === 'bar') ? '' : html`<div class="msg warn" role="status">No Bar store yet: bar sales take stock out of the Bar store, so add one under Stores below first.</div>`}
    <section class="panel"><h2>Stock items <span class="small quiet">· ${plural(st.items.filter((i) => i.active).length, 'item')}</span></h2>${errorBox()}
      <div class="toolbar"><input class="in" type="search" data-model="siQ" data-live value="${ui.siQ}" placeholder="Search stock items" aria-label="Search stock items">
        <select class="in" data-model="siU" aria-label="Counted in"><option value="">All units</option>${['ml', 'g', 'pcs'].map((u) => html`<option value="${u}" ${ui.siU === u ? 'selected' : ''}>Counted in ${u}</option>`)}</select>
        <button class="btn" type="button" data-act="siNew" style="margin-left:auto">+ Add stock item</button></div>
      ${formOpen ? html`<form class="grid3 rowform"><h2 style="grid-column:1/-1">${ui.siEditId ? 'Edit stock item' : 'Add stock item'}</h2>
        <label class="f">Name<input class="in" data-model="siName" value="${ui.siName ?? ''}" placeholder="e.g. Sample Whisky" autofocus></label>
        <label class="f">Counted in<select class="in" data-model="siUnit"><option value="ml">ml</option><option value="pcs" ${ui.siUnit === 'pcs' ? 'selected' : ''}>pieces</option><option value="g" ${ui.siUnit === 'g' ? 'selected' : ''}>g</option></select></label>
        <label class="f">Bought as<input class="in" data-model="siPack" value="${ui.siPack ?? ''}" placeholder="bottle, case, kg"></label>
        <label class="f">Units in one (e.g. 750)<input class="in" inputmode="numeric" data-model="siSize" value="${ui.siSize ?? ''}"></label>
        <label class="f">Price per pack (₹)<input class="in" inputmode="decimal" data-model="siCost" value="${ui.siCost ?? ''}"></label>
        <label class="f">Reorder when total is at or below (units)<input class="in" inputmode="numeric" data-model="siReorder" value="${ui.siReorder ?? ''}"></label>
        <label class="f">Category (for count sheets)<input class="in" data-model="siCat" list="siCats" value="${ui.siCat ?? ''}" placeholder="e.g. Whisky, Beer, Cigarettes"><datalist id="siCats">${[...new Set(ui.st.items.map((x) => x.category).filter(Boolean))].sort().map((x) => html`<option value="${x}"></option>`)}</datalist></label>
        <div class="row" style="grid-column:1/-1"><button class="btn pri" type="submit" data-act="stItem" data-submit>${ui.siEditId ? 'Save stock item' : 'Add stock item'}</button><button class="btn ghost" type="button" data-act="siCancel">Cancel</button></div></form>` : ''}
      ${list.length ? html`<div class="scroll"><table class="t cards"><thead><tr><th>Item</th><th>Counted in</th><th>Bought as</th><th class="num">Price per pack</th><th class="num">Reorder at</th><th>Used in</th><th></th></tr></thead><tbody>
        ${list.map((i) => html`<tr class="${i.active ? '' : 'mksaved'}"><td data-label="Item"><strong>${i.name}</strong>${i.active ? '' : html` <span class="small quiet">(not used)</span>`}</td><td data-label="Counted in">${unitName[i.unit]}</td>
          <td data-label="Bought as">${i.packName} of ${i.packSize.toLocaleString('en-IN')}${i.unit === 'pcs' ? '' : ` ${i.unit}`}</td>
          <td data-label="Price per pack" class="num">${i.costPerPackPaise ? rs(i.costPerPackPaise) : html`<span class="quiet">add price</span>`}</td>
          <td data-label="Reorder at" class="num">${i.reorderLevel ? `${i.reorderLevel.toLocaleString('en-IN')} ${i.unit}` : '—'}</td>
          <td data-label="Used in" class="small">${used(i.id) ? plural(used(i.id), 'recipe') : html`<span class="quiet">none</span>`}</td>
          <td class="act"><div class="irow">${iconBtn('siEdit', i.id, 'edit', `Edit ${i.name}`)}${i.active ? iconBtn('siDel', i.id, 'trash', `Remove ${i.name}`, 'danger') : ''}</div></td></tr>`)}</tbody></table></div>`
        : html`<p class="quiet">${st.items.length ? 'No stock item matches.' : 'No stock items yet. Add them here, or let Make recipes (on Recipes) propose them.'}</p>`}</section>
    <section class="panel"><h2>Stores</h2><p>${st.stores.map((x) => `${x.name} (${{ bar: 'bar', main: 'main store', kitchen: 'kitchen' }[x.kind]})`).join(', ') || 'None yet'}</p>
      <form class="row" style="align-items:end"><label class="f">Store name<input class="in" data-model="sStoreName" placeholder="e.g. Bar"></label>
        <label class="f">Kind<select class="in" data-model="sStoreKind"><option value="bar">Bar</option><option value="main" ${ui.sStoreKind === 'main' ? 'selected' : ''}>Main store</option><option value="kitchen" ${ui.sStoreKind === 'kitchen' ? 'selected' : ''}>Kitchen</option></select></label>
        <button class="btn" type="submit" data-act="stStore" data-submit>Add store</button></form></section>`;
}
const siFields = () => ['siName', 'siUnit', 'siPack', 'siSize', 'siCost', 'siReorder', 'siCat'];
actions.siNew = () => { ui.siOpen = true; ui.siEditId = null; for (const k of siFields()) ui[k] = ''; ui.siUnit = 'ml'; ui.error = null; rerender(); };
actions.siCancel = () => { ui.siOpen = false; ui.siEditId = null; ui.error = null; rerender(); };
actions.siEdit = (d) => {
  const i = ui.st.items.find((x) => x.id === d.id);
  Object.assign(ui, { siEditId: i.id, siOpen: true, siName: i.name, siUnit: i.unit, siPack: i.packName, siSize: String(i.packSize), siCost: i.costPerPackPaise ? rupeesShort(i.costPerPackPaise) : '', siReorder: i.reorderLevel ? String(i.reorderLevel) : '', siCat: i.category ?? '' });
  ui.error = null; rerender(); window.scrollTo({ top: 0, behavior: 'smooth' });
};
actions.siDel = async (d) => {
  const i = ui.st.items.find((x) => x.id === d.id);
  if (!confirm(`Remove ${i.name}? If it has stock history it is hidden instead, so past reports still show it.`)) return;
  const r = await api('DELETE', `${B()}/stock/items/${i.id}`);
  flash = { kind: 'ok', text: r.hidden ? `${i.name} hidden: it has stock history, so reports keep it.` : `${i.name} removed.` };
  route();
};

// ---------- Recipes (Stock): saved recipes with cost per serving, Add a recipe (with AI suggestion), and Make recipes
// for many at once. One line editor serves all three: a "row" is { menuItemId, menuItem, category, lines: [{ stockItemId |
// newKey, qty }] }; rows of Make recipes live in ui.mk.proposals, the one being added or edited is ui.rd (row id "rd").
// New stock items (not made yet) are one pool, ui.newPool, made when the first recipe using them is saved.
const POUR_KEY = 'pos-pours';
function savedPours() { try { return JSON.parse(localStorage.getItem(POUR_KEY) ?? 'null') ?? {}; } catch { return {}; } }
const DRINK_KIND = { peg: 'Peg', bottle: 'Bottle', beer: 'Beer', wine: 'Wine', mixer: 'Mixer', cocktail: 'Cocktail', kitchen: 'Kitchen', skip: 'Not a drink', unclear: 'Unclear' };
const rowOf = (id) => (id === 'rd' ? ui.rd : ui.mk?.proposals.find((x) => x.menuItemId === id));
const newOf = (key) => ui.newPool.find((n) => n.key === key);
const lineName = (l) => (l.newKey ? (ui.mkNew[l.newKey]?.name ?? newOf(l.newKey)?.name) : ui.st.items.find((i) => i.id === l.stockItemId)?.name) ?? '?';
const lineUnit = (l) => (l.newKey ? newOf(l.newKey)?.unit : ui.st.items.find((i) => i.id === l.stockItemId)?.unit) ?? '';
const currentPours = () => ({ peg: int(ui.pPeg), large: int(ui.pLarge), glass: int(ui.pGlass) });
/** What one serving costs at the last price paid, and which ingredients have no price yet. */
function servingCost(lines) {
  let paise = 0; const missing = [];
  for (const l of lines) {
    const i = l.stockItemId ? ui.st.items.find((x) => x.id === l.stockItemId) : null;
    if (!i || !i.costPerPackPaise) { missing.push(lineName(l)); continue; }
    paise += (l.qty * i.costPerPackPaise) / i.packSize;
  }
  return { paise: Math.round(paise), missing };
}
function costText(lines, pricePaise) {
  if (!lines.length) return html`<span class="quiet">—</span>`;
  const c = servingCost(lines);
  if (c.missing.length === lines.length) return html`<span class="quiet">add prices</span><div class="small quiet">No price yet for ${c.missing.join(', ')}</div>`;
  const share = pricePaise ? `${Math.round((c.paise * 100) / pricePaise)}% of price${c.missing.length ? ' so far' : ''}` : '';
  const why = [c.missing.length ? `${c.missing.join(', ')}: no price yet` : '', share].filter(Boolean).join(' · ');
  return html`<span class="cost">${rs(c.paise)}${c.missing.length ? '+' : ''}</span><div class="small ${c.missing.length ? 'quiet' : 'margin'}">${why}</div>`;
}
/** The ingredient lines of a row, editable: amounts, remove (×), and add an ingredient. */
function lineEditor(x, rowId) {
  const choices = [...ui.st.items.filter((i) => i.active).map((i) => [i.id, `${i.name} (${i.unit})`]), ...ui.newPool.map((n) => [n.key, `${ui.mkNew[n.key]?.name ?? n.name} (${n.unit}, new)`])];
  const addForm = html`<form class="mkadd"><select class="in" data-model="maChoice" aria-label="Ingredient to add to ${x.menuItem}"><option value="">Choose a stock item</option>${choices.map(([v, t]) => html`<option value="${v}" ${ui.maChoice === v ? 'selected' : ''}>${t}</option>`)}<option value="__new" ${ui.maChoice === '__new' ? 'selected' : ''}>New stock item…</option></select>
      ${ui.maChoice === '__new' ? html`<input class="in" data-model="maName" value="${ui.maName ?? ''}" placeholder="Name, e.g. Paneer" aria-label="New stock item name">
        <select class="in mkunit" data-model="maUnit" aria-label="Counted in">${['g', 'ml', 'pcs'].map((u) => html`<option ${ui.maUnit === u ? 'selected' : ''}>${u}</option>`)}</select>
        <input class="in mkqty" inputmode="numeric" data-model="maPackSize" value="${ui.maPackSize ?? ''}" placeholder="in one pack" aria-label="Units in one pack (1000 for 1 kg)">` : ''}
      <input class="in mkqty" inputmode="numeric" data-model="maQty" value="${ui.maQty ?? ''}" placeholder="amount" aria-label="Amount for one serving">
      <button class="btn pri" type="submit" data-act="mkAddGo" data-id="${rowId}" data-submit>Add</button><button class="btn ghost" type="button" data-act="mkAddCancel">Cancel</button></form>`;
  return html`${x.lines.map((l, i) => html`<div class="mkline"><input class="in mkqty" inputmode="numeric" data-act-change="mkQty" data-id="${rowId}" data-i="${i}" value="${l.qty}" aria-label="${x.menuItem}: amount of ${lineName(l)}"><span class="small">${lineUnit(l)}</span>
      <span>${lineName(l)}</span>${l.newKey ? html`<span class="tag-new">new</span>` : ''}<button class="lnx" type="button" data-act="mkLineX" data-id="${rowId}" data-i="${i}" title="Remove this ingredient" aria-label="Remove ${lineName(l)} from ${x.menuItem}">×</button></div>`)}
    ${x.lines.length ? '' : html`<p class="small quiet">No ingredients yet${rowId === 'rd' ? ': use AI suggestion, or add them yourself.' : ': add one, or skip this item.'}</p>`}
    ${ui.mkAdd === rowId ? addForm : html`<button class="btn ghost addln" type="button" data-act="mkAdd" data-id="${rowId}">+ Add ingredient</button>`}`;
}
/** The AI suggestion box for one item being added or edited: kitchen dishes choose major or all ingredients. */
function aiBox(x) {
  const m = cache.menu.find((y) => y.id === x.menuItemId);
  if (!m) return '';
  const kitchen = m.station !== 'bar';
  return x.ai
    ? html`<div class="ai"><span class="tag-check">please check</span><span class="small">AI suggestion for one ${kitchen ? 'plate' : 'serving'}${kitchen ? `, ${ui.mkDetail === 'all' ? 'all' : 'major'} ingredients` : `, pegs of ${ui.pPeg} / ${ui.pLarge} ml`}. Change anything before saving.${x.note ? ` ${x.note}` : ''}</span>
        <button class="btn" type="button" data-act="rdAsk" style="margin-left:auto">Suggest again</button></div>`
    : html`<div class="ai"><button class="btn pri" type="button" data-act="rdAsk">✨ AI suggestion</button>
        ${kitchen ? html`<div class="radio small"><label><input type="radio" name="rdDetail" data-act-change="mkDetail" value="major" ${ui.mkDetail !== 'all' ? 'checked' : ''}> Major ingredients</label><label><input type="radio" name="rdDetail" data-act-change="mkDetail" value="all" ${ui.mkDetail === 'all' ? 'checked' : ''}> All ingredients</label></div>`
          : html`<span class="small">Pegs of ${ui.pPeg} / ${ui.pLarge} ml, glass of wine ${ui.pGlass} ml</span>`}
        <span class="small quiet">A fraction of a rupee · always check it</span></div>`;
}
const newNote = (x) => {
  const n = [...new Set(x.lines.filter((l) => l.newKey).map((l) => l.newKey))].map(newOf).filter(Boolean);
  return n.length ? html`<p class="small quiet" style="margin-top:8px">“new” stock items are made when you save: ${n.map((y) => `${ui.mkNew[y.key]?.name ?? y.name} (${y.packName} of ${y.packSize}${y.unit === 'pcs' ? '' : ` ${y.unit}`})`).join(', ')}.</p>` : '';
};

function recipesTab() {
  const st = ui.st;
  const p = savedPours();
  ui.pPeg ??= String(p.peg ?? 30); ui.pLarge ??= String(p.large ?? 60); ui.pGlass ??= String(p.glass ?? 150); ui.pClaude ??= true;
  ui.mkDetail ??= 'major'; ui.newPool ??= []; ui.mkNew ??= {}; ui.mkSel ??= [];
  const withRecipe = [...new Set(st.recipes.map((r) => r.menuItemId))];
  const without = (ui.mkSections ?? []).reduce((t, x) => t + x.n, 0);
  const top = html`<section class="panel"><div class="counts"><span class="big">${withRecipe.length}</span><span>${withRecipe.length === 1 ? 'item has' : 'items have'} a recipe</span><span class="quiet">·</span><span class="big">${without}</span><span>${without === 1 ? "doesn't" : "don't"} yet</span>
      <span class="counts-act"><button class="btn ${ui.mkOpen ? '' : 'pri'}" type="button" data-act="rcMakeToggle" ${without ? '' : 'disabled'}>${ui.mkOpen ? 'Hide Make recipes' : `Make recipes for the ${without}…`}</button>
      <button class="btn" type="button" data-act="rdNew" ${without ? '' : 'disabled'}>+ Add a recipe</button></span></div>
    <p class="small quiet" style="margin-top:6px">Make recipes works out many at once: bar drinks from their names, cocktails and kitchen dishes by AI suggestion. Add a recipe does one item, by hand or with an AI suggestion. Only item and stock item names are sent to the AI (Claude).</p></section>`;
  // Add a recipe (one item, not yet with a recipe)
  let add = '';
  if (ui.rd && ui.rd.mode === 'add') {
    const x = ui.rd;
    const open = cache.menu.filter((m) => m.active && !withRecipe.includes(m.id)).sort((a, b) => (a.category === b.category ? (a.name < b.name ? -1 : 1) : a.category < b.category ? -1 : 1));
    const m = cache.menu.find((y) => y.id === x.menuItemId);
    add = html`<section class="panel addpanel"><h2>Add a recipe</h2>${errorBox()}
      <label class="f">Menu item<select class="in" data-act-change="rdPick" aria-label="Menu item"><option value="">Choose a menu item</option>${open.map((y) => html`<option value="${y.id}" ${x.menuItemId === y.id ? 'selected' : ''}>${y.name} — ${y.category}${y.openPrice ? '' : ` · sells at ${rs(y.pricePaise)}`}</option>`)}</select></label>
      <p class="small quiet" style="margin-top:4px">Only items without a recipe are listed. Type to jump to a name.</p>
      ${x.menuItemId ? html`${aiBox(x)}<div class="rdlines">${lineEditor(x, 'rd')}</div>${newNote(x)}
        <div class="costline"><span class="quiet">Cost per serving</span>${costText(x.lines, m?.openPrice ? 0 : m?.pricePaise)}</div>` : ''}
      <div class="row" style="margin-top:12px"><button class="btn pri" type="button" data-act="rdSave" ${x.menuItemId && x.lines.length ? '' : 'disabled'}>Save recipe</button><button class="btn ghost" type="button" data-act="rdCancel">Cancel</button></div></section>`;
  }
  // Saved recipes, by menu section, with cost per serving; one can be edited in its row.
  ui.rsQ ??= ''; ui.rsCat ??= '';
  const words = ui.rsQ.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = withRecipe.map((id) => {
    const m = cache.menu.find((y) => y.id === id);
    const lines = st.recipes.filter((r) => r.menuItemId === id).map((r) => ({ stockItemId: r.stockItemId, qty: r.qty }));
    return { id, name: m?.name ?? st.recipes.find((r) => r.menuItemId === id).menuItem, category: m?.category ?? 'Other', pricePaise: m && !m.openPrice ? m.pricePaise : 0, openPrice: !!m?.openPrice, lines };
  }).filter((r) => (!ui.rsCat || r.category === ui.rsCat) && words.every((w) => r.name.toLowerCase().includes(w) || r.lines.some((l) => lineName(l).toLowerCase().includes(w))))
    .sort((a, b) => (a.category === b.category ? (a.name < b.name ? -1 : 1) : a.category < b.category ? -1 : 1));
  const cats = [...new Set(withRecipe.map((id) => cache.menu.find((y) => y.id === id)?.category ?? 'Other'))].sort();
  let lastCat = null;
  const saved = html`<section class="panel"><h2>Saved recipes</h2>${ui.rd?.mode === 'edit' ? errorBox() : ''}
    ${withRecipe.length ? html`<div class="toolbar"><input class="in" type="search" data-model="rsQ" data-live value="${ui.rsQ}" placeholder="Search items or ingredients" aria-label="Search recipes">
      <select class="in" data-model="rsCat" aria-label="Section"><option value="">All sections</option>${cats.map((c) => html`<option ${ui.rsCat === c ? 'selected' : ''}>${c}</option>`)}</select></div>
    ${rows.length ? html`<div class="scroll"><table class="t cards"><thead><tr><th>Item</th><th>Takes from stock (one serving)</th><th class="num">Cost per serving</th><th></th></tr></thead><tbody>
      ${rows.map((r) => {
        const head = r.category !== lastCat ? html`<tr class="sechead"><td colspan="4">${r.category}</td></tr>` : '';
        lastCat = r.category;
        const sells = r.openPrice ? 'Priced at billing' : `Sells at ${rs(r.pricePaise)}`;
        if (ui.rd?.mode === 'edit' && ui.rd.menuItemId === r.id) {
          return html`${head}<tr class="editing"><td data-label="Item"><strong>${r.name}</strong><div class="small quiet">${sells} · editing</div></td>
            <td data-label="Takes from stock">${aiBox(ui.rd)}${lineEditor(ui.rd, 'rd')}${newNote(ui.rd)}</td>
            <td data-label="Cost per serving" class="num">${costText(ui.rd.lines, r.pricePaise)}</td>
            <td class="act"><div class="row" style="justify-content:flex-end"><button class="btn pri" type="button" data-act="rdSave" ${ui.rd.lines.length ? '' : 'disabled'}>Save</button><button class="btn ghost" type="button" data-act="rdCancel">Cancel</button></div></td></tr>`;
        }
        return html`${head}<tr><td data-label="Item"><strong>${r.name}</strong><div class="small quiet">${sells}</div></td>
          <td data-label="Takes from stock" class="ing">${r.lines.map((l) => html`<div>${l.qty} ${lineUnit(l)} ${lineName(l)}</div>`)}</td>
          <td data-label="Cost per serving" class="num">${costText(r.lines, r.pricePaise)}</td>
          <td class="act"><div class="irow">${iconBtn('rcEdit', r.id, 'edit', `Edit recipe for ${r.name}`)}${iconBtn('rcDel', r.id, 'trash', `Delete recipe for ${r.name}`, 'danger')}</div></td></tr>`;
      })}</tbody></table></div>
      <p class="small quiet">Cost is at the last price paid per pack. “+” means some ingredients have no price yet: it fills in when you receive them with a price.</p>`
      : html`<p class="quiet">No saved recipe matches.</p>`}` : html`<p class="quiet">No recipes yet. Use Make recipes above to start, or Add a recipe for one item.</p>`}</section>`;
  return html`${top}${add}${ui.mkOpen ? makePanel() : ''}${saved}`;
}
actions.rcMakeToggle = () => { ui.mkOpen = !ui.mkOpen; ui.error = null; rerender(); };
actions.rdNew = () => { ui.rd = { mode: 'add', menuItemId: '', menuItem: '', category: '', lines: [] }; ui.mkAdd = null; ui.error = null; rerender(); };
actions.rdPick = (_d, el) => {
  const m = cache.menu.find((y) => y.id === el.value);
  ui.rd = { mode: 'add', menuItemId: m?.id ?? '', menuItem: m?.name ?? '', category: m?.category ?? '', lines: [] };
  ui.mkAdd = null; ui.error = null; rerender();
};
actions.rdCancel = () => { ui.rd = null; ui.mkAdd = null; ui.error = null; rerender(); };
actions.rcEdit = (d) => {
  const m = cache.menu.find((y) => y.id === d.id);
  const lines = ui.st.recipes.filter((r) => r.menuItemId === d.id).map((r) => ({ stockItemId: r.stockItemId, qty: r.qty }));
  ui.rd = { mode: 'edit', menuItemId: d.id, menuItem: m?.name ?? '', category: m?.category ?? '', lines };
  ui.mkAdd = null; ui.error = null; rerender();
};
actions.rcDel = async (d) => {
  const name = cache.menu.find((y) => y.id === d.id)?.name ?? 'this item';
  if (!confirm(`Delete the recipe for ${name}? Its sales will no longer take stock out.`)) return;
  await api('PUT', `${B()}/stock/recipes/${d.id}`, { lines: [] });
  flash = { kind: 'ok', text: `Recipe for ${name} deleted.` };
  await refreshRecipes();
};
actions.rdAsk = async () => {
  const x = ui.rd;
  const r = await api('POST', `${B()}/stock/recipes/ask`, { menuItemId: x.menuItemId, ...currentPours(), detail: ui.mkDetail, newItems: ui.newPool });
  ui.newPool = [...ui.newPool, ...r.newItems.filter((n) => !ui.newPool.some((y) => y.key === n.key))];
  if (!r.proposal.lines.length) throw new Error(`${x.menuItem}: ${r.proposal.note || 'the AI had no suggestion for this one.'} Add the ingredients yourself.`);
  Object.assign(x, { lines: r.proposal.lines, ai: true, note: r.proposal.note });
  ui.mkAdd = null; ui.error = null; rerender();
};
actions.rdSave = async () => { await mkSave([ui.rd]); };
/** After saving or deleting a recipe: fresh recipes and counts, keeping what is open on the screen. */
async function refreshRecipes() {
  const [st, secs] = await Promise.all([api('GET', `${B()}/stock`), api('GET', `${B()}/stock/recipes/sections`)]);
  Object.assign(ui.st, st);
  ui.mkSections = secs.sections;
  rerender();
}

// ---------- Make recipes (inside Recipes): many items at once, by menu section
function makePanel() {
  const secs = ui.mkSections ?? [];
  const chosen = secs.filter((x) => ui.mkCats.includes(x.category));
  const anyKitchen = chosen.some((x) => !x.bar);
  const group = (bar) => {
    const list = secs.filter((x) => x.bar === bar);
    if (!list.length) return '';
    return html`<div class="grouphead"><h3>${bar ? 'Bar' : 'Kitchen'}</h3><div class="links"><button type="button" data-act="mkCatsAll" data-bar="${bar ? 1 : 0}">All</button><button type="button" data-act="mkCatsNone" data-bar="${bar ? 1 : 0}">None</button></div>
        <span class="small quiet">${bar ? 'Worked out from the names; cocktails by AI suggestion' : 'AI suggestion for every dish: each needs checking'}</span></div>
      <div class="catgrid">${list.map((x) => html`<label><input type="checkbox" class="sel" data-act-change="mkCat" data-cat="${x.category}" ${ui.mkCats.includes(x.category) ? 'checked' : ''}> ${x.category} <span class="n">(${x.n})</span></label>`)}</div>`;
  };
  const form = html`<section class="panel"><h2>Make recipes</h2>
    <p class="small quiet">Choose the menu sections to work out. Nothing is saved until you approve.</p>${ui.mk || ui.rd ? '' : errorBox()}
    ${secs.length ? html`${group(true)}${group(false)}` : html`<p class="quiet">Every menu item already has a recipe.</p>`}
    ${anyKitchen ? html`<div class="choice"><strong>For kitchen dishes, list</strong>
      <label><input type="radio" name="mkDetail" data-act-change="mkDetail" value="major" ${ui.mkDetail === 'major' ? 'checked' : ''}><span><strong>Major ingredients only</strong> (recommended): the 2 to 5 that cost the most or are worth counting, such as paneer, chicken, rice, oil, butter and cream. Leaves out salt, spices, garnish and water.</span></label>
      <label><input type="radio" name="mkDetail" data-act-change="mkDetail" value="all" ${ui.mkDetail === 'all' ? 'checked' : ''}><span><strong>All ingredients</strong>: every item down to masalas and garnish. Many more stock items to set up and count; the small amounts are rough guesses.</span></label></div>` : ''}
    <form class="grid3" style="margin-top:14px"><label class="f">Peg (ml)<input class="in" inputmode="numeric" data-model="pPeg" value="${ui.pPeg}"></label>
      <label class="f">Large peg (ml)<input class="in" inputmode="numeric" data-model="pLarge" value="${ui.pLarge}"></label>
      <label class="f">Glass of wine (ml)<input class="in" inputmode="numeric" data-model="pGlass" value="${ui.pGlass}"></label>
      <label class="tickline" style="grid-column:1/-1"><input type="checkbox" class="sel" data-model="pClaude" ${ui.pClaude ? 'checked' : ''}> Use AI suggestions for cocktails${anyKitchen ? ' and kitchen dishes' : ''} (a few rupees for up to 60 items; always check them)</label>
      <div><button class="btn pri" type="submit" data-act="mkRun" data-submit ${chosen.length ? '' : 'disabled'}>${chosen.length ? `Make recipes for ${plural(chosen.length, 'section')} (${plural(chosen.reduce((t, x) => t + x.n, 0), 'item')})` : 'Choose a section'}</button></div></form></section>`;
  if (!ui.mk) return form;
  const r = ui.mk;
  ui.mkShowCat ??= ''; ui.mkShowKind ??= '';
  const shown = (x) => (!ui.mkShowCat || x.category === ui.mkShowCat) && (!ui.mkShowKind || (ui.mkShowKind === 'check' ? x.check : !x.check));
  const live = r.proposals.filter((x) => !x.skipped);
  const inTable = (x) => x.lines.length || x.edited;
  const readyAll = live.filter(inTable);
  const ready = readyAll.filter(shown);
  const rest = live.filter((x) => !inTable(x) && shown(x));
  const cats = [...new Set(live.map((x) => x.category))].sort();
  const skipped = r.proposals.filter((x) => x.skipped);
  const open = ready.filter((x) => !x.saved);
  const ticked = open.filter((x) => ui.mkSel.includes(x.menuItemId));
  const usedNew = ui.newPool.filter((n) => open.some((x) => x.lines.some((l) => l.newKey === n.key)));
  const tickedNew = usedNew.filter((n) => ticked.some((x) => x.lines.some((l) => l.newKey === n.key)));
  const row = (x) => x.saved
    ? html`<tr class="mksaved"><td class="selcol"></td><td data-label="Item"><strong>${x.menuItem}</strong><div class="small quiet">${x.category}</div></td>
        <td data-label="Takes from stock">${x.lines.map((l) => html`<div>${l.qty} ${lineUnit(l)} ${lineName(l)}</div>`)}</td><td data-label="How"><span class="savedtag">Saved ✓</span></td><td class="act"></td></tr>`
    : html`<tr class="${ui.mkSel.includes(x.menuItemId) ? 'picked' : ''}"><td class="selcol"><input type="checkbox" class="sel" data-act-change="mkSel" data-id="${x.menuItemId}" aria-label="Tick ${x.menuItem}" ${ui.mkSel.includes(x.menuItemId) ? 'checked' : ''}></td>
        <td data-label="Item"><strong>${x.menuItem}</strong><div class="small quiet">${x.category}</div></td>
        <td data-label="Takes from stock">${lineEditor(x, x.menuItemId)}</td>
        <td data-label="How">${DRINK_KIND[x.kind]} · ${x.check ? html`<span class="tag-check">please check</span>` : html`<span class="small quiet">${x.source === 'claude' ? 'AI suggestion' : 'from the name'}</span>`}${x.note ? html`<div class="small quiet">${x.note}</div>` : ''}</td>
        <td class="act"><div class="irow">${x.lines.length ? iconBtn('mkSaveOne', x.menuItemId, 'check', `Save recipe for ${x.menuItem}`, 'ok') : ''}${iconBtn('mkSkip', x.menuItemId, 'skip', `Skip ${x.menuItem} for now`)}</div></td></tr>`;
  return html`${form}
    <section class="panel">${ui.rd ? '' : errorBox()}${r.claudeNote ? html`<div class="msg warn" role="status">${r.claudeNote}</div>` : ''}
      <h2>${plural(readyAll.length, 'item')} with a proposed recipe${readyAll.some((x) => x.saved) ? html` <span class="small quiet">· ${readyAll.filter((x) => x.saved).length} saved</span>` : ''}</h2>
      <div class="filterbar"><label class="f" style="flex-direction:row;align-items:center;gap:8px">Show <select class="in" data-model="mkShowCat" aria-label="Show section"><option value="">All sections</option>${cats.map((c) => html`<option ${ui.mkShowCat === c ? 'selected' : ''}>${c}</option>`)}</select></label>
        <select class="in" data-model="mkShowKind" aria-label="Show which"><option value="">Everything</option><option value="check" ${ui.mkShowKind === 'check' ? 'selected' : ''}>Please check only</option><option value="name" ${ui.mkShowKind === 'name' ? 'selected' : ''}>From the name only</option></select></div>
      ${ready.length ? html`<p class="small quiet">Change amounts, then save an item with its tick button, or tick several and approve them together. “Please check” means it is an AI suggestion, or the name was not clear enough to be sure.</p>
      <div class="bulkbar" style="position:static;box-shadow:none"><strong>${plural(ticked.length, 'item')} ticked</strong>
        <button class="btn pri" type="button" data-act="mkApply" ${ticked.length ? '' : 'disabled'}>Approve ticked recipes</button>
        ${tickedNew.length ? html`<span class="small quiet">Also makes ${plural(tickedNew.length, 'new stock item')} (below)</span>` : ''}</div>
      <div class="scroll"><table class="t cards"><thead><tr><th class="selcol"><input type="checkbox" class="sel" data-act-change="mkSelAll" aria-label="Tick every item not saved yet" ${open.length && ticked.length === open.length ? 'checked' : ''}></th><th>Item</th><th>Takes from stock (one serving)</th><th>How</th><th></th></tr></thead><tbody>
        ${ready.map(row)}</tbody></table></div>` : html`<p class="quiet">Nothing here${ui.mkShowCat || ui.mkShowKind ? ' with these filters' : ''} has a proposed recipe.</p>`}
      ${usedNew.length ? html`<h2>New stock items to make</h2><p class="small quiet">Each is made when the first item using it is saved. Check the name and how it is bought; the price is added when you receive it.</p>
        <div class="scroll"><table class="t"><thead><tr><th>Name</th><th>Counted in</th><th>Bought as</th><th class="num">Units in one</th></tr></thead><tbody>
          ${usedNew.map((n) => html`<tr><td><input class="in" data-act-change="mkNewName" data-key="${n.key}" value="${ui.mkNew[n.key]?.name ?? n.name}" aria-label="Name of new stock item ${n.name}"></td><td>${n.unit}</td><td>${n.packName}</td>
            <td class="num"><input class="in mkqty" inputmode="numeric" data-act-change="mkNewPack" data-key="${n.key}" value="${ui.mkNew[n.key]?.packSize ?? n.packSize}" aria-label="${n.name}: ${n.unit} in one ${n.packName}"></td></tr>`)}</tbody></table></div>` : ''}
      ${rest.length ? html`<h2 style="margin-top:16px">${plural(rest.length, 'item')} left for you</h2>
        <p class="small quiet">The name was not enough. Get an AI suggestion for one (a fraction of a rupee, always check it), skip it, or use Add a recipe above.</p>
        <div class="scroll"><table class="t cards"><thead><tr><th>Item</th><th>Why</th><th></th></tr></thead><tbody>
          ${rest.map((x) => html`<tr><td data-label="Item"><strong>${x.menuItem}</strong><div class="small quiet">${x.category}</div></td><td data-label="Why" class="small quiet">${x.note || DRINK_KIND[x.kind]}</td>
            <td class="act"><div class="row" style="justify-content:flex-end">${x.kind === 'skip' && x.note.startsWith('Not a drink') ? '' : html`<button class="btn" type="button" data-act="mkAsk" data-id="${x.menuItemId}">✨ AI suggestion</button>`}${iconBtn('mkSkip', x.menuItemId, 'skip', `Skip ${x.menuItem} for now`)}</div></td></tr>`)}</tbody></table></div>` : ''}
      ${skipped.length ? html`<p class="small quiet" style="margin-top:12px">${plural(skipped.length, 'item')} skipped for now: ${skipped.map((x) => x.menuItem).join(', ')}. <button class="btn ghost" type="button" data-act="mkUnskip">Show them again</button></p>` : ''}
    </section>`;
}
actions.mkRun = async () => {
  const pours = currentPours();
  try { localStorage.setItem(POUR_KEY, JSON.stringify(pours)); } catch { /* this visit only */ }
  ui.error = null;
  ui.mk = await api('POST', `${B()}/stock/recipes/suggest`, { ...pours, claude: !!ui.pClaude, categories: ui.mkCats, detail: ui.mkDetail });
  ui.newPool = [...ui.newPool.filter((n) => !ui.mk.newItems.some((y) => y.key === n.key)), ...ui.mk.newItems];
  ui.mkShowCat = ''; ui.mkShowKind = ''; ui.mkAdd = null;
  // Ticked to start: worked out from the name with nothing to check. AI suggestions and doubtful ones wait for a person.
  ui.mkSel = ui.mk.proposals.filter((x) => x.lines.length && !x.check).map((x) => x.menuItemId);
  rerender();
};
actions.mkSel = (d, el) => { const s = new Set(ui.mkSel); if (el.checked) s.add(d.id); else s.delete(d.id); ui.mkSel = [...s]; rerender(); };
actions.mkSelAll = (_d, el) => { ui.mkSel = el.checked ? ui.mk.proposals.filter((x) => x.lines.length && !x.saved && !x.skipped).map((x) => x.menuItemId) : []; rerender(); };
actions.mkQty = (d, el) => { rowOf(d.id).lines[Number(d.i)].qty = int(el.value); if (d.id === 'rd') rerender(); };
actions.mkNewName = (d, el) => { ui.mkNew[d.key] = { ...ui.mkNew[d.key], name: el.value.trim() }; };
actions.mkNewPack = (d, el) => { ui.mkNew[d.key] = { ...ui.mkNew[d.key], packSize: int(el.value) }; };
actions.mkCat = (d, el) => { const s = new Set(ui.mkCats); if (el.checked) s.add(d.cat); else s.delete(d.cat); ui.mkCats = [...s]; rerender(); };
actions.mkCatsAll = (d) => { const bar = d.bar === '1'; ui.mkCats = [...new Set([...ui.mkCats, ...ui.mkSections.filter((x) => x.bar === bar).map((x) => x.category)])]; rerender(); };
actions.mkCatsNone = (d) => { const bar = d.bar === '1'; const drop = new Set(ui.mkSections.filter((x) => x.bar === bar).map((x) => x.category)); ui.mkCats = ui.mkCats.filter((c) => !drop.has(c)); rerender(); };
actions.mkDetail = (_d, el) => { ui.mkDetail = el.value; rerender(); };
// Ingredient lines: remove one, or add a stock item (existing, proposed, or new) to a recipe before saving.
actions.mkLineX = (d) => { const p = rowOf(d.id); p.lines.splice(Number(d.i), 1); p.edited = true; if (!p.lines.length) ui.mkSel = ui.mkSel.filter((x) => x !== d.id); rerender(); };
actions.mkAdd = (d) => { Object.assign(ui, { mkAdd: d.id, maChoice: '', maQty: '', maName: '', maUnit: 'g', maPackSize: '' }); ui.error = null; rerender(); };
actions.mkAddCancel = () => { ui.mkAdd = null; rerender(); };
actions.mkAddGo = (d) => {
  const p = rowOf(d.id);
  const qty = int(ui.maQty);
  if (!ui.maChoice) throw new Error('Choose the stock item to add.');
  if (!(qty > 0)) throw new Error('Type the amount for one serving: a whole number above zero.');
  let line;
  if (ui.maChoice === '__new') {
    const name = (ui.maName ?? '').trim();
    const unit = ui.maUnit || 'g';
    const pack = int(ui.maPackSize);
    if (!name) throw new Error('Type the new stock item’s name.');
    if (!(pack > 0)) throw new Error(`Type how many ${unit} are in one pack (1000 for 1 kg or 1 litre, 1 for a single piece).`);
    const have = ui.st.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (have) line = { stockItemId: have.id };
    else {
      const key = ui.newPool.find((n) => n.name.toLowerCase() === name.toLowerCase() && n.unit === unit)?.key ?? `new:${unit}:${name.toLowerCase()}`;
      if (!ui.newPool.some((n) => n.key === key)) ui.newPool.push({ key, name, unit, packName: unit === 'pcs' ? 'piece' : unit === 'ml' ? 'litre' : 'kg', packSize: pack });
      line = { newKey: key };
    }
  } else line = ui.maChoice.startsWith('new:') ? { newKey: ui.maChoice } : { stockItemId: ui.maChoice };
  if (p.lines.some((l) => (line.newKey ? l.newKey === line.newKey : l.stockItemId === line.stockItemId))) throw new Error(`${p.menuItem} already has that ingredient: change its amount instead.`);
  p.lines.push({ ...line, qty, label: String(qty) });
  p.edited = true;
  ui.mkAdd = null; ui.error = null;
  rerender();
};
actions.mkSkip = (d) => { rowOf(d.id).skipped = true; ui.mkSel = ui.mkSel.filter((x) => x !== d.id); ui.error = null; rerender(); };
actions.mkUnskip = () => { for (const x of ui.mk.proposals) x.skipped = false; rerender(); };
/** Saves these rows' recipes (with any new stock items they need), without losing what else is open on the screen. */
async function mkSave(chosen) {
  const bad = chosen.find((x) => !x.lines.length || x.lines.some((l) => !(l.qty > 0)));
  if (bad) throw new Error(`${bad.menuItem}: ${bad.lines.length ? 'type a whole number above zero for each amount' : 'add at least one ingredient'}.`);
  const keys = new Set(chosen.flatMap((x) => x.lines.map((l) => l.newKey)).filter(Boolean));
  const newItems = ui.newPool.filter((n) => keys.has(n.key)).map((n) => ({ ...n, name: ui.mkNew[n.key]?.name || n.name, packSize: ui.mkNew[n.key]?.packSize ?? n.packSize }));
  const r = await api('POST', `${B()}/stock/recipes/apply`, { newItems, recipes: chosen.map((x) => ({ menuItemId: x.menuItemId, lines: x.lines.map(({ stockItemId, newKey, qty }) => ({ stockItemId, newKey, qty })) })) });
  // A new stock item now exists: every other recipe using it points at it, and it is no longer "new".
  const rows = [...(ui.mk?.proposals ?? []), ...(ui.rd ? [ui.rd] : [])];
  for (const n of newItems) {
    const id = r.made[n.key];
    if (!id) continue;
    for (const p of rows) for (const l of p.lines) if (l.newKey === n.key) { delete l.newKey; l.stockItemId = id; }
    ui.newPool = ui.newPool.filter((x) => x.key !== n.key);
  }
  for (const x of chosen) x.saved = true;
  if (ui.mk) for (const p of ui.mk.proposals) if (chosen.some((x) => x.menuItemId === p.menuItemId)) p.saved = true;
  ui.mkSel = ui.mkSel.filter((id) => !chosen.some((x) => x.menuItemId === id));
  if (ui.rd && chosen.includes(ui.rd)) ui.rd = null;
  ui.error = null;
  flash = { kind: 'ok', text: `${chosen.length === 1 ? `${chosen[0].menuItem}: recipe saved` : `${plural(r.recipes, 'recipe')} saved`}${r.stockItemsCreated ? `, with ${plural(r.stockItemsCreated, 'new stock item')}` : ''}. Add prices when you next receive stock, so costs show.` };
  await refreshRecipes();
}
actions.mkSaveOne = (d) => mkSave([rowOf(d.id)]);
actions.mkApply = () => mkSave(ui.mk.proposals.filter((x) => x.lines.length && !x.saved && !x.skipped && ui.mkSel.includes(x.menuItemId)));
actions.mkAsk = async (d) => {
  const r = await api('POST', `${B()}/stock/recipes/ask`, { menuItemId: d.id, ...currentPours(), detail: ui.mkDetail, newItems: ui.newPool });
  const i = ui.mk.proposals.findIndex((x) => x.menuItemId === d.id);
  ui.mk.proposals[i] = r.proposal;
  ui.newPool = [...ui.newPool, ...r.newItems.filter((n) => !ui.newPool.some((x) => x.key === n.key))];
  ui.error = null;
  flash = { kind: r.proposal.lines.length ? 'ok' : 'warn', text: r.proposal.lines.length ? `${r.proposal.menuItem}: AI suggestion ready. Check it in the list above, then save it.` : `${r.proposal.menuItem}: ${r.proposal.note || 'the AI had no suggestion for this one.'}` };
  rerender();
};
actions.stHandover = async () => { ui.handovers = await api('GET', `${B()}/stock/handovers?from=${ui.hFrom}&to=${ui.hTo}&storeId=${ui.hStore}`); rerender(); };
actions.stReceive = async () => {
  const lines = ui.rcLines.map((l) => ({ itemId: ui[`rcl${l.k}item`], packs: int(ui[`rcl${l.k}packs`]), costPerPack: (ui[`rcl${l.k}cost`] ?? '').trim() || undefined }));
  if (!lines.length) throw new Error('Add what was received.');
  if (lines.some((l) => !l.itemId)) throw new Error('Choose the stock item on every line, or remove the line.');
  if (lines.some((l) => !(l.packs > 0))) throw new Error('Type how many packs on every line.');
  await api('POST', `${B()}/stock/purchases`, ui.rcOpening ? { storeId: ui.rcStore, opening: true, lines } : { storeId: ui.rcStore, vendor: ui.rcVendor, invoiceNo: ui.rcInv, billId: ui.rcBillId ?? undefined, lines });
  flash = { kind: 'ok', text: ui.rcOpening ? `Opening stock saved: ${plural(lines.length, 'item')}.` : `Received ${lines.length} line${lines.length === 1 ? '' : 's'}${ui.rcVendor ? ' from ' + ui.rcVendor : ''}.` }; go('#/stock/hand');
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
    fillFromBill(r.billId, r.read, r.error);
  } catch (e) { if (!(e instanceof ApiError && e.code === 'signin')) ui.rcError = e.message; }
  ui.rcReading = false; rerender();
});
/** Puts a read supplier bill (just photographed, or one waiting) into the lines to check and receive. */
function fillFromBill(billId, read, error) {
    ui.rcBillId = billId; ui.rcError = error; ui.rcRead = !!read; ui.rcOpening = false;
    const r = { read };
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
}
actions.draftOpen = (d) => { const b = ui.drafts.find((x) => x.id === d.id); fillFromBill(b.id, b.read, b.error); if (!b.read) { ui.rcVendor = b.vendor ?? ''; ui.rcInv = b.invoiceNo ?? ''; } ui.error = null; rerender(); };
actions.draftDel = async (d) => { if (!confirm('Discard this bill photo? Nothing was received from it.')) return; await api('DELETE', `${B()}/stock/bills/${d.id}`); ui.drafts = ui.drafts.filter((x) => x.id !== d.id); rerender(); };
actions.rcOpenTick = (_d, el) => { ui.rcOpening = el.checked; ui.rcLines = ui.rcLines?.length ? ui.rcLines : [{ k: 1, desc: '' }]; rerender(); };
actions.stTransfer = async () => { await api('POST', `${B()}/stock/transfers`, { fromStoreId: ui.trFrom, toStoreId: ui.trTo, lines: [{ itemId: ui.trItem, qty: int(ui.trQty) }] }); flash = { kind: 'ok', text: 'Moved.' }; go('#/stock/hand'); };
actions.stWaste = async () => { await api('POST', `${B()}/stock/waste`, { storeId: ui.waStore, itemId: ui.waItem, qty: int(ui.waQty), reason: ui.waReason }); flash = { kind: 'ok', text: 'Recorded.' }; go('#/stock/hand'); };
actions.stCount = async () => {
  // Bottles are counted as full ones plus what is left in the open one(s): 2 full + 300 ml = 1,800 ml for a 750 ml bottle.
  const has = (k) => String(ui[k] ?? '').trim() !== '';
  const lines = ui.st.items.filter((i) => i.active && (has('ct_' + i.id) || has('ctp_' + i.id))).map((i) => ({ itemId: i.id, counted: (has('ctp_' + i.id) ? int(ui['ctp_' + i.id]) * i.packSize : 0) + (has('ct_' + i.id) ? int(ui['ct_' + i.id]) : 0) }));
  if (lines.some((l) => !Number.isInteger(l.counted) || l.counted < 0)) throw new Error('Counts are whole numbers: full packs, and what is left in an open one.');
  const r = await api('POST', `${B()}/stock/counts`, { storeId: ui.ctStore, lines });
  const keep = ui.ctStore; await stockScreen('count'); ui.ctStore = keep; ui.countResult = r.lines; rerender();
};
// ---------- Count (27 Nov 2026): count lists by category, a sheet to print with what is in hand, typing after the shift or
// live, and a manager's approval before stock changes.
async function countLoad() {
  const [cl, cs] = await Promise.all([api('GET', `${B()}/stock/count-lists`), api('GET', `${B()}/stock/count-sessions`)]);
  ui.cl = cl; ui.cs = cs.counts;
  if (!ui.ctList || !cl.lists.some((l) => l.id === ui.ctList)) ui.ctList = cl.lists[0]?.id ?? null;
  if (ui.ckId) ui.ck = await api('GET', `${B()}/stock/count-sessions/${ui.ckId}`).catch(() => null);
}
/** Units as packs + loose: 1,830 ml of a 750 ml bottle is "2 btl + 330 ml". */
function packText(q, i) {
  if (q == null) return '';
  const neg = q < 0; let n = Math.abs(q);
  const short = (x) => ({ bottle: 'btl', packet: 'pkt' }[x] ?? x);
  if (!(i.packSize > 1)) return `${neg ? '−' : ''}${n} ${i.unit}`;
  const f = Math.floor(n / i.packSize); const l = n - f * i.packSize;
  const t = [f ? `${f} ${short(i.packName)}` : '', l ? `${l} ${i.unit}` : ''].filter(Boolean).join(' + ') || '0';
  return `${neg ? '−' : ''}${t}`;
}
const ckKey = (p, k, id) => `ck${p}${k}_${id}`;
function countView(st) {
  const cl = ui.cl; const ck = ui.ck;
  if (!cl) return html`<section class="panel"><p class="quiet">Loading…</p></section>`;
  if (ui.clEdit) return countListEdit(st);
  if (ck) return countSheetView(ck);
  const list = cl.lists.find((l) => l.id === ui.ctList);
  const status = { draft: 'Not sent yet', waiting: 'Waiting for a manager', sent_back: 'Sent back to recount', approved: 'Approved', dropped: 'Dropped' };
  return html`<section class="panel"><div class="row" style="justify-content:space-between;align-items:center"><h2>Count</h2>
      ${isMgr() ? html`<div class="row"><button class="btn sm" type="button" data-act="clNew">New count list</button>${list ? html`<button class="btn sm" type="button" data-act="clOpen" data-id="${list.id}">Change ${list.name}</button>` : ''}</div>` : ''}</div>
    ${errorBox()}
    ${cl.lists.length ? html`<div class="chips">${cl.lists.map((l) => html`<button type="button" class="chip" aria-pressed="${l.id === ui.ctList}" data-act="pick" data-k="ctList" data-id="${l.id}">${l.name} · ${l.count}</button>`)}</div>
      ${list ? html`<div class="row"><button class="btn" type="button" data-act="ckSheet">Print sheet</button>
        <button class="btn pri" type="button" data-act="ckStart" data-m="after_shift">Type a count from paper</button><button class="btn" type="button" data-act="ckStart" data-m="live">Live count</button></div>
        <p class="small quiet">After the shift: print the sheet, count at the bar counter and in the store, then type it in with the time it was counted. Live: count now on this screen, row by row. Stock changes only when a manager approves.</p>` : ''}`
      : html`<p class="quiet">${isMgr() ? 'Make a count list first: pick the categories and items to count (New count list).' : 'A manager makes the count list first.'}</p>`}
    ${(ui.cs ?? []).length ? html`<h3 style="margin-top:12px">Counts</h3><div class="scroll"><table class="t"><thead><tr><th>Started</th><th>List</th><th>How</th><th>By</th><th class="num">Rows</th><th>Status</th></tr></thead><tbody>
      ${ui.cs.map((k) => html`<tr class="userow" tabindex="0" data-act="ckOpen" data-id="${k.id}" style="cursor:pointer"><td>${dateTime(k.createdAt)}</td><td>${k.list ?? k.store}</td><td>${k.mode === 'live' ? 'Live' : `From paper${k.countedAt ? ` · counted ${dateTime(k.countedAt)}` : ''}`}</td>
        <td>${k.byName ?? ''}</td><td class="num">${k.rows}</td><td><span class="status ${k.status === 'waiting' || k.status === 'sent_back' ? 'warn' : k.status === 'approved' ? 'ok' : 'mute'}">${status[k.status]}</span></td></tr>`)}</tbody></table></div>` : ''}
  </section>`;
}
function countSheetView(ck) {
  const k = ck.count;
  const typing = k.status === 'draft' || k.status === 'sent_back';
  const review = k.status === 'waiting' && isMgr();
  const rows = ck.groups.flatMap((g) => g.items);
  const done = rows.filter((r) => r.counted !== null);
  const diffCell = (r) => (r.diff == null ? '' : r.diff === 0 ? html`<span style="color:var(--go-dark);font-weight:700">matches</span>`
    : html`<span style="color:${r.diff < 0 ? 'var(--bad)' : 'var(--warn)'};font-weight:700">${r.diff < 0 ? 'short ' : 'more '}${packText(Math.abs(r.diff), r)}</span>`);
  const inp = (r, p) => {
    const two = r.packSize > 1;
    const pv = ui[ckKey(p, 'p', r.id)] ?? (r[`place${p}`] != null && r[`place${p}`] !== 0 ? String(two ? Math.floor(r[`place${p}`] / r.packSize) : r[`place${p}`]) : (r[`place${p}`] === 0 && p === 1 ? '0' : ''));
    const lv = ui[ckKey(p, 'l', r.id)] ?? (two && r[`place${p}`] ? String(r[`place${p}`] % r.packSize || '') : '');
    const short = ({ bottle: 'btl', packet: 'pkt' })[r.packName] ?? r.packName;
    return html`<div class="row" style="gap:4px;flex-wrap:nowrap;align-items:center"><input class="in" inputmode="numeric" style="width:58px" data-model="${ckKey(p, 'p', r.id)}" value="${pv}" aria-label="${r.name} ${two ? short : r.unit}, ${p === 1 ? 'bar counter' : 'other place'}"><span class="small">${two ? short : r.unit}</span>
      ${two ? html`<input class="in" inputmode="numeric" style="width:64px" data-model="${ckKey(p, 'l', r.id)}" value="${lv}" aria-label="${r.name} ${r.unit}, ${p === 1 ? 'bar counter' : 'other place'}"><span class="small">${r.unit}</span>` : ''}</div>`;
  };
  const head = html`<div class="row" style="justify-content:space-between;align-items:center"><h2>${k.list ?? k.store} · ${k.mode === 'live' ? 'live count' : 'count from paper'}</h2>
    <button class="btn ghost sm" type="button" data-act="ckClose">Back to counts</button></div>
    <p class="small quiet" style="margin:0">Started by ${k.by ?? ''} · ${dateTime(k.createdAt)}${k.sentAt ? ` · sent ${dateTime(k.sentAt)}` : ''}${k.decidedBy ? ` · ${k.status === 'approved' ? 'approved' : 'closed'} by ${k.decidedBy} ${dateTime(k.decidedAt)}` : ''}</p>
    ${k.status === 'sent_back' ? html`<div class="msg warn" style="display:block">Sent back to count again${k.note ? `: ${k.note}` : ''}. Rows marked "count again" are shown first in each group.</div>` : ''}
    ${k.status === 'waiting' && !isMgr() ? html`<div class="msg ok" style="display:block">With the manager. Stock changes when they approve.</div>` : ''}`;
  const when = k.mode === 'after_shift'
    ? html`<label class="f" style="max-width:260px">Counted at<input class="in" type="datetime-local" data-model="ckAt" value="${ui.ckAt ?? (k.countedAt ? localDT(k.countedAt) : '')}" ${typing ? '' : 'disabled'}></label>
      <p class="small quiet" style="margin:0">In hand is the stock as it was at this time, so sales after the count do not show as missing.</p>`
    : html`<p class="small quiet" style="margin:0">Live: in hand is the stock when each row is typed (now, for rows not typed yet).</p>`;
  const table = html`<div class="scroll"><table class="t"><thead><tr><th>Item</th><th class="num">In hand${k.mode === 'after_shift' && k.countedAt ? ` at ${time(k.countedAt)}` : ''}</th>${typing ? html`<th>Bar counter</th><th>Other place</th>` : html`<th class="num">Counted</th>`}<th class="num">Difference</th>${review ? html`<th></th>` : ''}</tr></thead><tbody>
    ${ck.groups.map((g) => html`<tr><td colspan="${typing ? 5 : review ? 5 : 4}" style="background:var(--soft);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.5px">${g.category}</td></tr>
      ${[...g.items].sort((a, b) => (typing ? Number(b.recount) - Number(a.recount) : 0)).map((r) => html`<tr><td>${r.name}${r.recount ? html` <span class="status warn">count again</span>` : ''}<div class="small quiet">${r.packSize > 1 ? `${r.packName} of ${r.packSize} ${r.unit}` : r.unit}</div></td>
        <td class="num">${packText(r.inHand, r)}</td>
        ${typing ? html`<td>${inp(r, 1)}</td><td>${inp(r, 2)}</td>` : html`<td class="num">${r.counted == null ? html`<span class="quiet">not counted</span>` : packText(r.counted, r)}</td>`}
        <td class="num">${diffCell(r)}${r.diff && !typing ? html`<div class="small quiet">${rs(Math.abs(r.valuePaise))}</div>` : ''}</td>
        ${review ? html`<td>${r.diff ? html`<label class="tickline"><input type="checkbox" data-model="ckb_${r.id}" ${ui['ckb_' + r.id] ? 'checked' : ''}> count again</label>` : ''}</td>` : ''}</tr>`)}`)}
  </tbody></table></div>`;
  const short = done.filter((r) => r.diff < 0); const more = done.filter((r) => r.diff > 0);
  const sums = html`<div class="kpis">${kpi('Counted', `${done.length} of ${rows.length}`)}${kpi('Short', String(short.length), short.length ? rs(-short.reduce((t, r) => t + r.valuePaise, 0)) : '', short.length ? 'warn' : '')}${kpi('More than in hand', String(more.length), more.length ? rs(more.reduce((t, r) => t + r.valuePaise, 0)) : '')}</div>`;
  const btns = typing ? html`<div class="row"><button class="btn" type="button" data-act="ckSave">Save, finish later</button><button class="btn pri" type="button" data-act="ckSend">Send to manager</button><button class="btn ghost" type="button" data-act="ckDrop">Drop this count</button></div>`
    : review ? html`<div class="row"><button class="btn pri" type="button" data-act="ckApprove">Approve: set stock to the count</button><button class="btn" type="button" data-act="ckBack">Send back to count again</button><button class="btn ghost" type="button" data-act="ckDrop">Drop this count</button></div>
      <label class="f" style="max-width:480px">Note for the counter (optional)<input class="in" data-model="ckNote" value="${ui.ckNote ?? ''}" placeholder="e.g. check the store room again"></label>` : '';
  return html`<section class="panel">${head}${errorBox()}${typing ? when : ''}${sums}${table}${btns}</section>`;
}
const localDT = (ms) => { const d = new Date(ms + 330 * 60_000); return d.toISOString().slice(0, 16); };
const fromLocalDT = (v) => (v ? Date.parse(`${v}:00+05:30`) : NaN);
function countListEdit(st) {
  const e = ui.clEdit; const cl = ui.cl;
  const cats = cl.categories;
  const itemsOf = (c) => cl.items.filter((i) => i.category === c);
  const onCat = (c) => e.categories.includes(c);
  const itemOn = (i) => (onCat(i.category) ? !e.offItems.includes(i.id) : e.onItems.includes(i.id));
  const n = cl.items.filter(itemOn).length;
  return html`<section class="panel"><div class="row" style="justify-content:space-between;align-items:center"><h2>${e.id ? `Change ${e.name}` : 'New count list'}</h2><button class="btn ghost sm" type="button" data-act="clClose">Cancel</button></div>
    ${errorBox()}<div class="grid3"><label class="f">Name<input class="in" data-model="clName" value="${ui.clName ?? e.name}" placeholder="e.g. Bar count"></label>
      <label class="f">Store<select class="in" data-model="clStore">${st.stores.map((x) => html`<option value="${x.id}" ${(ui.clStore ?? e.storeId) === x.id ? 'selected' : ''}>${x.name}</option>`)}</select></label></div>
    <p class="small quiet">${n} items on this list. Tap a category to put all of it on or off; tap an item to take it off or put it back. New items in a category that is on join the list by themselves. Set an item's category in Stock items.</p>
    ${cats.map((c) => html`<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:6px"><div class="row" style="justify-content:space-between;align-items:center"><strong>${c}</strong>
        <button type="button" class="chip" aria-pressed="${onCat(c)}" data-act="clCat" data-c="${c}">${onCat(c) ? 'On the list' : 'Put all on'}</button></div>
      <div class="chips" style="margin-top:6px">${itemsOf(c).map((i) => html`<button type="button" class="chip" aria-pressed="${itemOn(i)}" data-act="clItem" data-id="${i.id}">${itemOn(i) ? '✓ ' : '+ '}${i.name}</button>`)}</div></div>`)}
    <div class="row" style="margin-top:10px"><button class="btn pri" type="button" data-act="clSave">Save the list</button></div></section>`;
}
actions.clNew = () => { ui.clEdit = { id: null, name: 'Bar count', storeId: ui.st.stores.find((x) => x.kind === 'bar')?.id ?? ui.st.stores[0]?.id, categories: [], offItems: [], onItems: [] }; ui.clName = ui.clStore = undefined; ui.error = null; rerender(); };
actions.clOpen = (d) => { const l = ui.cl.lists.find((x) => x.id === d.id); ui.clEdit = { ...l, categories: [...l.categories], offItems: [...l.offItems], onItems: [...l.onItems] }; ui.clName = ui.clStore = undefined; ui.error = null; rerender(); };
actions.clClose = () => { ui.clEdit = null; ui.error = null; rerender(); };
actions.clCat = (d) => {
  const e = ui.clEdit; const ids = ui.cl.items.filter((i) => i.category === d.c).map((i) => i.id);
  if (e.categories.includes(d.c)) e.categories = e.categories.filter((x) => x !== d.c);
  else { e.categories.push(d.c); e.offItems = e.offItems.filter((x) => !ids.includes(x)); }
  e.onItems = e.onItems.filter((x) => !ids.includes(x)); rerender();
};
actions.clItem = (d) => {
  const e = ui.clEdit; const i = ui.cl.items.find((x) => x.id === d.id);
  const flip = (arr) => (arr.includes(i.id) ? arr.filter((x) => x !== i.id) : [...arr, i.id]);
  if (e.categories.includes(i.category)) e.offItems = flip(e.offItems); else e.onItems = flip(e.onItems);
  rerender();
};
actions.clSave = async () => {
  const e = ui.clEdit;
  const b = { name: ui.clName ?? e.name, storeId: ui.clStore ?? e.storeId, categories: e.categories, offItems: e.offItems, onItems: e.onItems };
  const r = e.id ? await api('PUT', `${B()}/stock/count-lists/${e.id}`, b) : await api('POST', `${B()}/stock/count-lists`, b);
  ui.clEdit = null; ui.ctList = e.id ?? r.id; flash = { kind: 'ok', text: `${b.name} saved.` }; await countLoad(); rerender();
};
actions.ckStart = async (d) => {
  const r = await api('POST', `${B()}/stock/count-sessions`, { listId: ui.ctList, mode: d.m });
  ui.ckId = r.id; ui.ckAt = d.m === 'after_shift' ? localDT(Date.now()) : undefined; await countLoad(); rerender();
};
actions.ckOpen = async (d) => { ui.ckId = d.id; ui.ckAt = undefined; for (const k of Object.keys(ui)) if (/^ck[12][pl]_|^ckb_/.test(k)) delete ui[k]; await countLoad(); rerender(); };
actions.ckClose = async () => { ui.ckId = null; ui.ck = null; await countLoad(); rerender(); };
/** What was typed, as units per place; a row cleared of both places is taken off the count. */
function ckLines() {
  const has = (k) => ui[k] !== undefined;
  const num = (k, label) => { const v = String(ui[k] ?? '').trim(); if (!v) return 0; const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`${label}: a whole number.`); return n; };
  const out = [];
  for (const r of ui.ck.groups.flatMap((g) => g.items)) {
    const touched = [1, 2].some((p) => has(ckKey(p, 'p', r.id)) || has(ckKey(p, 'l', r.id)));
    if (!touched) continue;
    const place = (p) => {
      const pk = has(ckKey(p, 'p', r.id)) ? ui[ckKey(p, 'p', r.id)] : null; const lk = has(ckKey(p, 'l', r.id)) ? ui[ckKey(p, 'l', r.id)] : null;
      if (pk === null && lk === null) return r[`place${p}`] ?? 0;
      return num(ckKey(p, 'p', r.id), r.name) * (r.packSize > 1 ? r.packSize : 1) + (r.packSize > 1 ? num(ckKey(p, 'l', r.id), r.name) : 0);
    };
    const blank = [1, 2].every((p) => ['p', 'l'].every((x) => !String(ui[ckKey(p, x, r.id)] ?? (r[`place${p}`] ? 'x' : '')).trim()));
    out.push(blank ? { itemId: r.id, clear: true } : { itemId: r.id, place1: place(1), place2: place(2) });
  }
  return out;
}
async function ckPut() {
  const at = ui.ck.count.mode === 'after_shift' && ui.ckAt ? fromLocalDT(ui.ckAt) : undefined;
  if (ui.ck.count.mode === 'after_shift' && ui.ckAt && !Number.isFinite(at)) throw new Error('Type the time it was counted.');
  ui.ck = await api('PUT', `${B()}/stock/count-sessions/${ui.ckId}`, { lines: ckLines(), countedAt: at });
  for (const k of Object.keys(ui)) if (/^ck[12][pl]_/.test(k)) delete ui[k];
}
actions.ckSave = async () => { await ckPut(); flash = { kind: 'ok', text: 'Saved. Open it from Counts to finish.' }; rerender(); };
actions.ckSend = async () => { await ckPut(); await api('POST', `${B()}/stock/count-sessions/${ui.ckId}/send`, {}); flash = { kind: 'ok', text: 'Sent to the manager. Stock changes when they approve.' }; await actions.ckClose(); };
actions.ckDrop = async () => { if (!confirm('Drop this count? Nothing in it changes stock.')) return; await api('POST', `${B()}/stock/count-sessions/${ui.ckId}/drop`, {}); flash = { kind: 'ok', text: 'Count dropped.' }; await actions.ckClose(); };
actions.ckApprove = async () => { const r = await api('POST', `${B()}/stock/count-sessions/${ui.ckId}/approve`, {}); flash = { kind: 'ok', text: `Approved: ${r.rows} counted, ${r.differ} changed. Shortages are on Bar handover.` }; await actions.ckClose(); };
actions.ckBack = async () => {
  const itemIds = ui.ck.groups.flatMap((g) => g.items).filter((r) => ui['ckb_' + r.id]).map((r) => r.id);
  if (!itemIds.length) throw new Error('Tick "count again" on the rows to count again.');
  await api('POST', `${B()}/stock/count-sessions/${ui.ckId}/back`, { itemIds, note: ui.ckNote ?? '' }); flash = { kind: 'ok', text: `Sent back: ${plural(itemIds.length, 'row')} to count again.` }; await actions.ckClose();
};
/** The sheet to count on: A4, by category, what is in hand now, blanks for the bar counter and the store, and a difference column. */
actions.ckSheet = async () => {
  const sh = await api('GET', `${B()}/stock/count-lists/${ui.ctList}/sheet`);
  const short = (i) => (({ bottle: 'btl', packet: 'pkt' })[i.packName] ?? i.packName);
  const blank = (i) => (i.packSize > 1 ? `<span class="bl"></span>${short(i)} <span class="bl"></span>${i.unit}` : `<span class="bl"></span>${i.unit}`);
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  printArea.innerHTML = `<div class="countsheet"><h1>${esc(sh.list.name)} · ${esc(sh.store.name)}</h1><p>Printed ${esc(dateTime(sh.at))} · in hand at that time · counted by ________________ · counted at ________</p>
    <table><colgroup><col style="width:27%"><col style="width:17%"><col style="width:20%"><col style="width:20%"><col style="width:16%"></colgroup>
    <thead><tr><th>Item</th><th>In hand</th><th>Bar counter</th><th>Store / other place</th><th>Difference</th></tr></thead><tbody>
    ${sh.groups.map((g) => `<tr class="cat"><td colspan="5">${esc(g.category)}</td></tr>${g.items.map((i) => `<tr><td>${esc(i.name)}<small>${i.packSize > 1 ? `${esc(i.packName)} of ${i.packSize} ${i.unit}` : i.unit}</small></td><td class="r">${esc(packText(i.inHand, i))}</td><td>${blank(i)}</td><td>${blank(i)}</td><td></td></tr>`).join('')}`).join('')}
    </tbody></table></div>`;
  // In the Windows app 1.0.5 and later (28 Nov 2026): straight to this PC's "Reports (A4)" printer, A4 upright, no print box
  // (Windows' print box from the app did not send the job on). Elsewhere, or if that fails, the print box as before.
  if (window.bookrDesktop?.print && appAtLeast('1.0.5')) {
    const r = await window.bookrDesktop.print({ kind: 'report', html: `<!doctype html><html><head><meta charset="utf-8"><style>${COUNT_SHEET_CSS}</style></head><body>${printArea.innerHTML}</body></html>` })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (r?.ok) { printArea.innerHTML = ''; flash = { kind: 'ok', text: `Count sheet sent to ${r.printer}.` }; rerender(); return; }
    flash = { kind: 'warn', text: `Not printed: ${r?.error ?? 'the printer did not answer'}. Choose an A4 printer under Reports (A4) in Printers (Ctrl+Shift+P). The print window opens instead.` };
    rerender();
  }
  window.print();
};
/** The Windows app's version is at least `v` (e.g. '1.0.5'). */
const appAtLeast = (v) => {
  const a = String(window.bookrDesktop?.version ?? '').split('.').map(Number);
  const b = v.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; }
  return true;
};
/** The count sheet's look on A4 for the Windows app (the same as its print styles in app.css). */
const COUNT_SHEET_CSS = `@page { size: A4 portrait; margin: 12mm; } body { margin: 0; background: #fff; color: #000; }
  .countsheet { font: 10.5pt/1.35 "Segoe UI", system-ui, sans-serif; color: #000; }
  .countsheet h1 { font-size: 15pt; margin: 0 0 2pt; } .countsheet p { margin: 0 0 8pt; font-size: 9.5pt; }
  .countsheet table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .countsheet th, .countsheet td { border: 0.6pt solid #888; padding: 4pt 6pt; text-align: left; vertical-align: bottom; }
  .countsheet th { font-size: 9pt; } .countsheet td small { display: block; font-size: 8pt; color: #444; }
  .countsheet td.r { text-align: right; font-weight: 700; white-space: nowrap; }
  .countsheet tr.cat td { background: #eee; font-weight: 700; font-size: 9pt; text-transform: uppercase; letter-spacing: .5pt; }
  .countsheet tr { page-break-inside: avoid; }
  .countsheet .bl { display: inline-block; width: 26pt; border-bottom: 0.8pt solid #000; height: 11pt; margin: 0 2pt 0 4pt; }`;
actions.stReport = async () => { ui.report = await api('GET', `${B()}/stock/report?from=${ui.rFrom}&to=${ui.rTo}&storeId=${ui.rStore}`); rerender(); };
actions.stItem = async () => {
  const body = { name: ui.siName, unit: ui.siUnit || 'ml', packName: ui.siPack, packSize: int(ui.siSize), costPerPack: ui.siCost, reorderLevel: int(ui.siReorder || '0'), category: ui.siCat || null };
  if (ui.siEditId) await api('PUT', `${B()}/stock/items/${ui.siEditId}`, { ...body, active: true });
  else await api('POST', `${B()}/stock/items`, body);
  flash = { kind: 'ok', text: `${ui.siName} ${ui.siEditId ? 'saved' : 'added'}.` };
  route();
};
actions.stStore = async () => { await api('POST', `${B()}/stock/stores`, { name: ui.sStoreName, kind: ui.sStoreKind ?? 'bar' }); route(); };

// ---------- exceptions

async function exceptionsScreen(day = me.business.shiftDay) {
  const [{ events }, d, prev] = await Promise.all([api('GET', `${B()}/events?day=${encodeURIComponent(day)}`), api('GET', `${B()}/reports/daily-check?day=${encodeURIComponent(day)}`),
    api('GET', `${B()}/reports/daily-check?day=${addDays(day, -7)}`).catch(() => null)]);
  ui.exPrev = prev;
  // Made with no internet (27 Nov 2026): kept with their printed numbers; anything that differs from its paper is listed.
  const off = await api('GET', `${B()}/offline/day?day=${encodeURIComponent(day)}`).catch(() => null);
  const kind = { void: 'Void', reprint: 'Reprint', kot_cancel: 'KOT line cancelled', discount: 'Discount', comp: 'Complimentary', limit_warning: 'Limit warning', credit_note: 'Credit note', stock_waste: 'Stock breakage or waste', stock_count: 'Stock count variance', pay_change: 'Payment type changed',
    serve_undo: 'Served mark undone', serve_manager: 'Marked served by a manager' };
  const modeName = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'Posted to rooms', credit: 'On credit', comp: 'Complimentary', advance: 'Advances used' };
  const ev = (k) => d.events[k] ?? { n: 0, paise: 0 };
  const df = (k) => d.differences[k] ?? { n: 0, paise: 0 };
  const flag = (n, text, money) => html`<div><span style="${n ? 'color:var(--warn)' : ''}">${text}</span><span>${n ? `${n}${money !== undefined ? ' · ' + rs(money) : ''}` : 'none'}</span></div>`;
  const broken = d.series.filter((x) => x.missing.length).concat(d.creditNoteSeries.filter((x) => x.missing.length));
  const statusName = { open: 'Open order', tab: 'Tab', billed: 'Bill printed, not paid' };
  const exCount = ['void', 'discount', 'comp', 'kot_cancel', 'reprint', 'credit_note', 'stock_waste', 'stock_count', 'limit_warning', 'pay_change'].reduce((t, k) => t + ev(k).n, 0) + df('discount').n;
  const oldUnpaid = d.unpaid.filter((o) => o.old).length;
  // The day in a few lines, to paste into WhatsApp for the owner.
  ui.exSummary = [
    `${me.business.name} · shift ${dayName(day)}`,
    `Net sales ${rs(d.sales.netPaise)} from ${plural(d.sales.bills, 'bill')} (${rs(d.sales.totalPaise)} with GST)`,
    d.byMode.filter((m) => m.mode !== 'comp').map((m) => `${modeName[m.mode] ?? m.mode} ${rs(m.paise)}`).join(' · '),
    d.sales.ncBills ? `NC and complimentary: ${plural(d.sales.ncBills, 'bill')}, ${rs(d.sales.ncMenuPaise)} at menu price` : '',
    `Voids ${ev('void').n} · Discounts ${rs(ev('discount').paise + df('discount').paise)} · Cancelled after KOT ${ev('kot_cancel').n}`,
    d.bar.counts ? `Bar count: ${d.bar.missingPaise ? `${rs(d.bar.missingPaise)} missing` : 'nothing missing'}` : 'Bar not counted',
    d.shiftClose ? `Cash close: ${d.shiftClose.differencePaise === 0 ? 'matched' : `${d.shiftClose.differencePaise > 0 ? 'over' : 'short'} ${rs(Math.abs(d.shiftClose.differencePaise))}`}` : 'Shift not closed yet',
    `Bill numbers: ${broken.length ? 'gaps found' : 'unbroken'}`,
    d.serving?.timed ? `Served late: ${d.serving.late} of ${d.serving.timed} items${d.serving.notMarked ? ` · ${d.serving.notMarked} not marked` : ''}` : '',
    d.unpaid.length ? `Sent to kitchen, not paid: ${d.unpaid.length}${oldUnpaid ? ` (${oldUnpaid} overdue)` : ''}` : '',
    (d.cancelledReceipts ?? []).length ? `Receipts cancelled: ${d.cancelledReceipts.map((x) => `${x.receiptNo} ${rs(x.totalPaise)} (${x.reason}, ${x.byName ?? ''})`).join(' · ')}` : '',
  ].filter(Boolean).join('\n');
  // ----- Sent to the kitchen or bar, not paid (25 Nov 2026): five ways food leaves with no money, and who.
  const placeOf = (ref) => String(ref ?? '').split(' · ')[0];
  const cancels = events.filter((e) => e.kind === 'kot_cancel' && !/\(whole order\)/.test(e.ref ?? ''));
  const wholeLines = events.filter((e) => e.kind === 'kot_cancel' && /\(whole order\)/.test(e.ref ?? ''));
  const wholeOrders = [...new Set(wholeLines.map((e) => placeOf(e.ref)))];
  const voidsLost = d.voidedNotRebilled ?? [];
  const comps = events.filter((e) => e.kind === 'comp');
  const unpaidOld = d.unpaid.filter((o) => o.old);
  const sum = (xs, f) => xs.reduce((t, x) => t + (f(x) ?? 0), 0);
  const np = [
    { k: 'cancel', label: 'Cancelled after KOT', color: '#b45309', n: cancels.length, unit: 'line', paise: sum(cancels, (e) => e.amountPaise),
      what: cancels.slice(0, 4).map((e) => String(e.ref ?? '').split(' · ').slice(1).join(' · ')).join(' · '), stock: 'back', filter: 'kot_cancel' },
    { k: 'whole', label: 'Whole order cancelled', color: '#d97706', n: wholeOrders.length, unit: 'order', paise: sum(wholeLines, (e) => e.amountPaise),
      what: wholeOrders.slice(0, 4).join(' · '), stock: 'back', filter: 'kot_cancel' },
    { k: 'void', label: 'Bill voided, not billed again', color: '#7c2d12', n: voidsLost.length, unit: 'bill', paise: sum(voidsLost, (b) => b.totalPaise),
      what: voidsLost.slice(0, 4).map((b) => `${b.billNo} · ${b.place}`).join(' · '), stock: 'used', filter: 'void' },
    { k: 'comp', label: 'Complimentary / NC', color: '#0f766e', n: comps.length, unit: 'bill', paise: sum(comps, (e) => e.amountPaise),
      what: comps.slice(0, 4).map((e) => e.reason ?? e.ref).join(' · '), stock: 'used', filter: 'other' },
    { k: 'unpaid', label: 'Not paid yet', color: '#b91c1c', n: unpaidOld.length, unit: 'table', paise: sum(unpaidOld, (o) => o.sentPaise),
      what: unpaidOld.slice(0, 4).map((o) => `${o.place} · open ${o.hours >= 24 ? `${Math.floor(o.hours / 24)} d` : `${o.hours} h`}`).join(' · '), stock: 'used' },
  ];
  const npTotal = sum(np, (x) => x.paise);
  const npItems = cancels.length + wholeLines.length + voidsLost.length + comps.length + unpaidOld.length;
  const people = new Map();
  const who = (name) => { const k = name || 'Unknown'; if (!people.has(k)) people.set(k, { name: k, cancels: 0, orders: new Set(), voids: 0, nc: 0, paise: 0 }); return people.get(k); };
  for (const e of cancels) { const p = who(e.byName); p.cancels++; p.paise += e.amountPaise ?? 0; }
  for (const e of wholeLines) { const p = who(e.byName); p.orders.add(placeOf(e.ref)); p.paise += e.amountPaise ?? 0; }
  const lostNos = new Set(voidsLost.map((b) => b.billNo));
  for (const e of events.filter((x) => x.kind === 'void' && lostNos.has(x.ref))) { const p = who(e.byName); p.voids++; p.paise += e.amountPaise ?? 0; }
  for (const e of comps) { const p = who(e.byName); p.nc++; p.paise += e.amountPaise ?? 0; }
  const byPerson = [...people.values()].sort((a, b2) => b2.paise - a.paise);
  const heavy = byPerson.filter((p) => p.cancels + p.orders.size >= 3);
  ui.npOpen ??= !!(unpaidOld.length || heavy.length);
  // ----- What to look at first.
  const look = [
    ...((d.shiftClose?.waitingRoom ?? []).length ? [`Closed automatically with guests still waiting for a room: ${d.shiftClose.waitingRoom.join(', ')}`] : []),
    ...((d.shiftClose?.noRent ?? []).length ? [`Closed automatically with no rent for: ${d.shiftClose.noRent.map((x) => `${x.room} · ${x.guestName} (rent till ${dayName(x.coveredTo)})`).join(', ')}`] : []),
    ...(d.shiftClose && !d.shiftClose.countedAt && !d.shiftClose.noCount ? ['Cash drawer not counted at day close'] : d.shiftClose && d.shiftClose.differencePaise ? [`Cash ${d.shiftClose.differencePaise > 0 ? 'over' : 'short'} ${rs(Math.abs(d.shiftClose.differencePaise))} at day close`] : []),
    ...(d.drawers ?? []).filter((x) => x.differencePaise).map((x) => `Cash ${x.differencePaise < 0 ? 'short' : 'over'} ${rs(Math.abs(x.differencePaise))} in ${x.holder}'s drawer`),
    ...unpaidOld.map((o) => `${o.place} not paid for ${o.hours >= 24 ? `${Math.floor(o.hours / 24)} d` : `${o.hours} h`}`),
    ...heavy.map((p) => `${p.name} cancelled ${plural(p.cancels + p.orders.size, 'KOT line')}`),
    ...(broken.length ? ['Bill numbers missing'] : []),
    ...(d.bar.missingPaise ? [`Bar count: ${rs(d.bar.missingPaise)} missing`] : []),
    ...((d.lateCheckIns ?? []).length ? [`${plural(d.lateCheckIns.length, 'guest')} checked in late`] : []),
    ...((d.noInvoice ?? []).filter((x) => !x.rentUnknown).length ? [`${plural(d.noInvoice.filter((x) => !x.rentUnknown).length, 'stay')} checked out with no room rent`] : []),
  ];
  const prevNet = ui.exPrev?.sales?.netPaise ?? null;
  const change = prevNet ? Math.round(((d.sales.netPaise - prevNet) / prevNet) * 100) : null;
  const modes = d.byMode.filter((m) => m.mode !== 'comp');
  const maxMode = Math.max(1, ...modes.map((m) => m.paise));
  const tile = (n, label, money, tone) => html`<div class="dc-tile ${n ? tone : 'none'}"><span class="k">${label}</span><span class="v">${n}</span><span class="n">${n ? (money !== undefined ? rs(money) : 'see the list') : 'none'}</span></div>`;
  const evKind = { void: 'void', kot_cancel: 'kot_cancel', discount: 'discount' };
  const exF = ui.exF ?? 'all';
  const shown = events.filter((e) => exF === 'all' || (exF === 'other' ? !evKind[e.kind] : e.kind === exF));
  const chip = (k, label, n) => html`<button type="button" class="chip" aria-pressed="${exF === k}" data-act="pick" data-k="exF" data-id="${k}">${label} ${n}</button>`;
  const tone = { void: 'bad', kot_cancel: 'warn', discount: 'mute', comp: 'ok', reprint: 'mute', credit_note: 'warn', stock_waste: 'warn', stock_count: 'warn', limit_warning: 'warn', pay_change: 'warn', serve_undo: 'warn', serve_manager: 'mute' };
  const hrs = (h) => (h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h`);
  rerender = () => paint(shell('#/exceptions', html`
    <div class="dc-head"><div class="grow"><h1>Daily check</h1><p class="quiet">Shift of ${dayName(day)} · ${me.business.shift_start_hour ?? 8} am to ${me.business.shift_start_hour ?? 8} am · the owner's morning page</p></div>
      <form class="row" style="align-items:end"><button class="btn" type="button" data-act="exStep" data-n="-1" aria-label="Previous shift">‹</button>
        <label class="f">Shift<input class="in" type="date" data-model="day" value="${ui.day ?? day}" style="width:auto"></label>
        <button class="btn" type="button" data-act="exStep" data-n="1" aria-label="Next shift">›</button><button class="btn" type="submit" data-act="exDay" data-submit>Show</button>
        <button class="btn pri" type="button" data-act="exCopy">Copy for WhatsApp</button></form></div>
    ${off?.problems?.length ? html`<div class="msg warn" role="alert" style="display:block;margin-bottom:12px"><b>Made offline: check ${plural(off.problems.length, 'bill')}.</b>${off.problems.map((x) => html`<div>${x.problem}</div>`)}</div>` : ''}
    ${off?.bills?.length || off?.receipts?.length ? html`<p class="small quiet" style="margin-bottom:12px">Made with no internet this shift: ${[...off.bills.map((x) => x.billNo), ...off.receipts.map((x) => x.receiptNo)].join(', ')}. They keep the numbers printed on their paper.</p>` : ''}
    ${(d.djuboCovered ?? []).length ? html`<div class="msg" style="display:block;margin-bottom:12px"><b>Taken in Djubo, covered by POS receipts: ${d.djuboCovered.length}</b>
      ${d.djuboCovered.map((x) => html`<div>${x.guestName ?? ''} · Djubo ${x.extRef} ${rs(x.deskPaidPaise)}${x.enteredBy ? ` by ${x.enteredBy}` : ''} · covered by ${x.coveredBy.join(', ')}</div>`)}
      <div class="small quiet">Anything still owed shows on the guest's bill and must be paid before check-out.</div></div>` : ''}
    ${(d.cancelledReceipts ?? []).length ? html`<div class="msg warn" style="display:block;margin-bottom:12px"><b>Receipts cancelled: ${d.cancelledReceipts.length}</b>
      ${d.cancelledReceipts.map((x) => html`<div>${x.receiptNo ?? 'Receipt'} · ${x.who ?? ''} · ${rs(x.totalPaise)} · ${x.reason}${x.note ? ` (${x.note})` : ''} · by ${x.byName ?? ''}, ${time(x.at)}</div>`)}</div>` : ''}
    ${look.length ? html`<div class="dc-look"><span class="badge-n">${plural(look.length, 'thing')} to look at</span><span>${look.join(' · ')}</span></div>`
      : html`<div class="dc-look ok"><span class="badge-n">All clear</span><span>Cash matched, nothing unpaid for long, no unusual cancels.</span></div>`}
    <div class="kpis dc-kpis">${kpi(`Net sales · ${plural(d.sales.bills, 'bill')}`, rs(d.sales.netPaise), change === null ? `${rs(d.sales.totalPaise)} with GST` : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}% on last ${new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })}`)}
      ${d.shiftClose?.noCount ? kpi('Cash close', 'Closed', 'No drawer count (turned off)')
        : d.shiftClose && !d.shiftClose.countedAt ? kpi('Cash close', 'Not counted', 'Count it on Day close', 'bad')
        : d.shiftClose ? kpi('Cash close', d.shiftClose.differencePaise === 0 ? 'Matched' : `${d.shiftClose.differencePaise > 0 ? 'Over' : 'Short'} ${rs(Math.abs(d.shiftClose.differencePaise))}`, d.shiftClose.reason ?? 'Shift closed', d.shiftClose.differencePaise === 0 ? 'good' : 'bad')
        : kpi('Cash close', 'Not closed', 'The shift is not closed yet', 'warn')}
      ${kpi('Bill numbers', broken.length ? 'Gaps found' : 'Unbroken', broken.length ? 'See below' : `${plural(d.series.length, 'series', 'series')} · FY ${d.fy}`, broken.length ? 'bad' : 'good')}
      ${kpi('Not paid for', rs(npTotal), npItems ? `${plural(npItems, 'item')} sent, no money` : 'Everything sent was paid', npTotal ? 'warn' : 'good')}
      ${kpi('Bar count', d.bar.counts ? (d.bar.missingPaise ? `${rs(d.bar.missingPaise)} missing` : 'Nothing missing') : 'Not counted', d.bar.counts ? plural(d.bar.counts, 'count') : 'Count the bar on Stock', d.bar.counts ? (d.bar.missingPaise ? 'bad' : 'good') : 'warn')}</div>
    ${ui.npOpen ? html`<section class="panel dc-np"><div class="line"><div class="grow"><h2 style="margin:0">Sent to kitchen or bar, not paid</h2>
        <p class="quiet small" style="margin:4px 0 0">Everything that went out on a KOT this shift and brought in no money, at menu price.</p>
        ${unpaidOld.length || heavy.length ? html`<p class="small" style="margin:6px 0 0;color:var(--warn);font-weight:650">Opened by itself: ${[unpaidOld.length ? `${plural(unpaidOld.length, 'table')} unpaid past 6 hours` : '', heavy.length ? `${heavy.map((p) => p.name).join(', ')} with 3 or more cancels` : ''].filter(Boolean).join(', ')}.</p>` : ''}</div>
        <div class="dc-total"><strong>${rs(npTotal)}</strong><span class="quiet small">${plural(npItems, 'item')}${d.sales.netPaise ? ` · ${((npTotal / d.sales.netPaise) * 100).toFixed(1)}% of sales` : ''}</span></div>
        <button class="btn" type="button" data-act="npTog" aria-expanded="true">Fold ▲</button></div>
      ${npBar(np, npTotal)}
      <div class="scroll"><table class="t"><thead><tr><th>How</th><th>Count</th><th class="num">Menu price</th><th>Stock</th><th></th></tr></thead><tbody>
        ${np.map((x) => html`<tr><td><span class="dc-dot" style="background:${x.color}"></span><strong>${x.label}</strong>${x.what ? html`<div class="small quiet dc-what">${x.what}</div>` : ''}</td>
          <td>${x.n ? plural(x.n, x.unit) : html`<span class="quiet">none</span>`}</td><td class="num"><strong style="${x.k === 'unpaid' && x.n ? 'color:var(--bad)' : ''}">${x.n ? rs(x.paise) : '—'}</strong></td>
          <td>${x.n ? (x.stock === 'back' ? html`<span class="status warn">put back · check at count</span>` : html`<span class="status mute">used</span>`) : ''}</td>
          <td class="act">${x.n && x.filter ? html`<button class="btn ghost sm" type="button" data-act="exSee" data-f="${x.filter}">See each</button>` : x.n && x.k === 'unpaid' ? html`<a class="btn ghost sm" href="#/order/${unpaidOld[0].id}">Open ${unpaidOld[0].place}</a>` : ''}</td></tr>`)}</tbody></table></div>
      <div class="grid2" style="align-items:start">
        <div class="dc-box"><h3>By person</h3>
          ${byPerson.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Who</th><th class="num">Cancels</th><th class="num">Voids</th><th class="num">NC</th><th class="num">Total</th></tr></thead><tbody>
            ${byPerson.map((p) => html`<tr class="${p.cancels + p.orders.size >= 3 ? 'dc-flag' : ''}"><td><strong>${p.name}</strong>${p.cancels + p.orders.size >= 3 ? html` <span class="small" style="color:var(--warn);font-weight:650">· ${p.cancels + p.orders.size} cancels this shift</span>` : ''}</td>
              <td class="num">${p.cancels + p.orders.size || '—'}</td><td class="num">${p.voids || '—'}</td><td class="num">${p.nc || '—'}</td><td class="num"><strong>${rs(p.paise)}</strong></td></tr>`)}</tbody></table></div>
            <p class="small quiet" style="margin:6px 0 0">Cancels count against who asked; each one names the manager who approved it in the list below.</p>` : html`<p class="quiet">Nobody cancelled, voided or gave anything free.</p>`}</div>
        <div class="dc-box"><h3>Check these at the stock count</h3>
          <p class="small quiet" style="margin:0 0 6px">Their KOT was cancelled, so the stock went back on the book. If the count finds them short, they were made and thrown away, or taken.</p>
          ${(d.cancelReturns ?? []).length ? html`<ul class="dc-list">${d.cancelReturns.map((x) => html`<li><span>${x.name}</span><strong>${x.qty} ${x.unit} · ${x.store}</strong></li>`)}</ul>
            <a href="#/stock">Open the stock count</a>` : html`<p class="quiet">Nothing put back this shift.</p>`}</div>
      </div></section>`
    : html`<section class="panel dc-np dc-np-fold"><div class="grow"><div class="line" style="gap:12px"><h2 style="margin:0">Sent to kitchen or bar, not paid</h2><span class="quiet">${rs(npTotal)} · ${plural(npItems, 'item')}</span></div>
        ${npBar(np, npTotal)}<div class="dc-legend">${np.filter((x) => x.n).map((x) => html`<span style="${x.k === 'unpaid' ? 'color:var(--bad);font-weight:650' : ''}">${x.label} ${rs(x.paise)}</span>`)}</div></div>
        <button class="btn" type="button" data-act="npTog" aria-expanded="false">Open ▼</button></section>`}
    <div class="grid2" style="align-items:start">
      <section class="panel"><h2>Money in</h2>
        ${modes.length ? html`<div class="dc-bars">${modes.map((m) => html`<div class="dc-barrow"><span>${modeName[m.mode] ?? m.mode} <span class="quiet">(${m.n})</span></span><span class="dc-track"><span style="width:${Math.max(2, Math.round((m.paise / maxMode) * 100))}%"></span></span><strong class="num">${rs(m.paise)}</strong></div>`)}</div>` : html`<p class="quiet">No payments this shift.</p>`}
        <div class="sums" style="margin-top:10px"><div class="big"><span>Net sales · ${plural(d.sales.bills, 'bill')}</span><span>${rs(d.sales.netPaise)}</span></div><div><span class="quiet">With GST</span><span>${rs(d.sales.totalPaise)}</span></div>
          ${d.sales.ncBills ? html`<div><span class="quiet">NC and complimentary (not in sales)</span><span>${plural(d.sales.ncBills, 'bill')} · ${rs(d.sales.ncMenuPaise)} at menu price</span></div>` : ''}</div></section>
      <section class="panel"><h2>Exceptions</h2>
        <div class="dc-tiles">${tile(ev('void').n, 'Void bills', ev('void').paise, 'warn')}${tile(ev('discount').n + df('discount').n, 'Discounts', ev('discount').paise + df('discount').paise, 'warn')}
          ${tile(ev('kot_cancel').n, 'Cancelled after KOT', ev('kot_cancel').paise, 'warn')}${tile(ev('comp').n, 'Complimentary', ev('comp').paise, 'warn')}
          ${tile(ev('reprint').n, 'Reprints', undefined, 'warn')}${tile(ev('credit_note').n, 'Credit notes', ev('credit_note').paise, 'warn')}
          ${tile(ev('pay_change').n, 'Payment type changed', ev('pay_change').paise, 'warn')}${tile(df('tip').n, 'Tips', df('tip').paise, 'good')}
          ${tile(ev('stock_waste').n, 'Breakage', ev('stock_waste').paise, 'warn')}${tile(ev('stock_count').n, 'Stock count differences', undefined, 'warn')}
          ${ev('limit_warning').n ? tile(ev('limit_warning').n, 'Billing name limit warnings', undefined, 'warn') : ''}</div>
        <p class="small quiet" style="margin:8px 0 0">Coloured: happened this shift, see the list below. Grey: none.</p></section>
      <section class="panel"><h2>Cash drawers</h2>
        ${d.drawers?.length ? html`<div class="dc-drawers">${d.drawers.map((x) => html`<div class="dc-drawer"><div class="grow"><strong>${x.holder}${x.acceptedBy ? ` → ${x.acceptedBy}` : ''}</strong>
            <div class="small quiet">${time(x.from)} – ${x.to ? time(x.to) : 'open'} · cash in ${rs(x.cashInPaise)} · out ${rs(x.cashOutPaise)}${x.closeKind === 'takeover' ? ` · ${x.holder} not present, confirmed by ${x.approvedBy ?? 'a manager'}` : ''}${x.reason ? ` · "${x.reason}"` : ''}</div></div>
            <span class="num">${x.countedPaise == null ? '—' : rs(x.countedPaise)}</span>
            ${x.countedPaise == null ? html`<span class="status mute">Not counted yet</span>` : x.differencePaise === 0 ? html`<span class="status ok">Agrees</span>` : html`<span class="status bad">${x.differencePaise < 0 ? 'Short' : 'Over'} ${rs(Math.abs(x.differencePaise))}</span>`}</div>`)}</div>`
          : html`<p class="quiet">No cash drawer this shift.</p>`}
        ${d.shiftClose && !d.shiftClose.countedAt ? html`<p style="color:var(--bad)">Closed by itself at the shift's hour; the drawer is not counted yet. <a href="#/shift">Count it on Day close</a>.</p>` : ''}</section>
      <section class="panel"><h2>Bill numbers · FY ${d.fy}</h2>
        ${broken.length ? html`<div class="msg bad">${broken.map((x) => html`<div>${x.name}: ${x.missing.join(', ')} missing</div>`)}</div>`
          : html`<div class="msg ok">${d.series.length ? 'Every series is unbroken: no number missing.' : 'No bills this year yet.'}</div>`}
        <div class="sums">${d.series.map((x) => html`<div><span>${x.name} · ${x.prefix}</span><span class="quiet">${x.count} bills, last ${x.lastNo ?? x.last}</span></div>`)}</div></section>
    </div>
    ${servingCard(d.serving, day)}
    ${(d.lateCheckIns ?? []).length ? html`<section class="panel" style="margin-top:16px"><h2>Checked in late</h2>
      <p class="quiet small">Bookings missed at the desk and checked in afterwards, with the booking's date. Many of these mean check-ins are being missed.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Room</th><th>Guest</th><th>Was due</th><th>Checked in</th><th>By</th></tr></thead><tbody>
        ${d.lateCheckIns.map((x) => html`<tr><td>${x.room}</td><td>${x.guestName}${x.checkedOutAt ? html` <span class="small quiet">· in and out together</span>` : ''}</td><td>${dayName(x.checkIn)}</td><td>${dateTime(x.at)}</td><td>${x.byName ?? ''}</td></tr>`)}</tbody></table></div></section>` : ''}
    ${(d.noInvoice ?? []).length ? html`<section class="panel" style="margin-top:16px"><h2>Checked out without a POS invoice</h2>
      <p class="quiet small">Stays that began before the POS (total rent not known: Djubo or the OTA has the invoice), and any stay with no room rent on its bill, which needs a look.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Room</th><th>Guest</th><th>Stayed from</th><th>Why</th><th>Checked out by</th></tr></thead><tbody>
        ${d.noInvoice.map((x) => html`<tr><td>${x.room}</td><td>${x.guestName}</td><td>${dayName(x.checkIn)}</td><td>${x.rentUnknown ? 'Rent not known · before the POS' : html`<span style="color:var(--bad)">No room rent on the bill</span>`}</td><td>${x.byName ?? ''}</td></tr>`)}</tbody></table></div></section>` : ''}
    ${(d.typedPrices ?? []).length ? html`<section class="panel" style="margin-top:16px"><h2>Prices typed at billing</h2>
      <p class="quiet small">Bottles and other price-at-billing items, with the price typed and who typed it.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Bill</th><th>Item</th><th class="num">Qty</th><th class="num">Price typed</th><th class="num">Lowest allowed</th><th>Typed by</th></tr></thead><tbody>
        ${d.typedPrices.map((x) => html`<tr><td>${x.billNo}</td><td>${x.name}</td><td class="num">${x.qty}</td><td class="num"><strong>${rs(x.pricePaise)}</strong></td><td class="num">${x.minPricePaise == null ? '—' : rs(x.minPricePaise)}</td><td>${x.byName ?? ''}</td></tr>`)}</tbody></table></div></section>` : ''}
    ${d.unpaid.length ? html`<section class="panel" style="margin-top:16px"><h2>Sent to kitchen, not paid (right now)</h2>
      <p class="small quiet">Every order holding food or drinks already sent to the kitchen or bar, with no paid bill. Old ones (tabs past ${me.business.tab_age_days ?? 3} days, others past 6 hours) are in red.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Where</th><th>State</th><th class="num">Sent</th><th class="num">Open for</th></tr></thead><tbody>
        ${d.unpaid.map((o) => html`<tr style="${o.old ? 'color:var(--bad)' : ''}"><td><a href="#/order/${o.id}">${o.place}</a>${o.guestName ? html`<div class="small quiet">${o.guestName}</div>` : ''}</td>
          <td>${statusName[o.status]}${o.billNo ? ' · ' + o.billNo : ''}${o.voided ? html`<div class="small">A bill was voided</div>` : ''}</td><td class="num">${rs(o.sentPaise)}</td><td class="num">${hrs(o.hours)}</td></tr>`)}</tbody></table></div></section>` : ''}
    <section class="panel" style="margin-top:16px" id="exlist"><div class="line" style="flex-wrap:wrap;gap:10px"><h2 class="grow" style="margin:0">Every exception, in order</h2>
      <div class="chips">${chip('all', 'All', events.length)}${chip('kot_cancel', 'Cancels', events.filter((e) => e.kind === 'kot_cancel').length)}${chip('discount', 'Discounts', events.filter((e) => e.kind === 'discount').length)}${chip('void', 'Voids', events.filter((e) => e.kind === 'void').length)}${chip('other', 'Other', events.filter((e) => !evKind[e.kind]).length)}</div></div>
    <p class="quiet small">Every void, reprint, cancelled KOT line, discount and complimentary bill, with who and why. Nothing here can be changed.</p>
    <div class="scroll"><table class="t"><thead><tr><th>Time</th><th>What</th><th>Bill or item</th><th class="num">Amount</th><th>By</th><th>Reason</th></tr></thead><tbody>
      ${shown.length ? shown.map((e) => html`<tr><td>${time(e.at)}</td><td><span class="status ${tone[e.kind] ?? 'mute'}">${kind[e.kind]}</span></td><td><strong>${String(e.ref ?? '').split(/,\s*/).map((x, i) => html`${i ? ', ' : ''}${/^[A-Z0-9]+\d{6,}$/.test(x.trim()) ? html`<a href="#/billno/${x.trim()}">${x.trim()}</a>` : x}`)}</strong></td><td class="num">${e.amountPaise === null ? '' : rs(e.amountPaise)}</td><td>${e.byName ?? ''}</td><td>${e.reason ?? ''}${e.detail ? html`<div class="small quiet">${e.detail}</div>` : ''}</td></tr>`)
        : html`<tr><td colspan="6" class="quiet">Nothing in this shift.</td></tr>`}</tbody></table></div></section>`));
  rerender();
}
/** The share of each way food left without money, as one bar. */
const npBar = (np, total) => html`<div class="dc-bar" role="img" aria-label="${np.filter((x) => x.n).map((x) => `${x.label} ${total ? Math.round((x.paise / total) * 100) : 0}%`).join(', ') || 'Nothing'}">${total ? np.filter((x) => x.paise).map((x) => html`<span style="width:${(x.paise / total) * 100}%;background:${x.color}"></span>`) : ''}</div>`;
actions.npTog = () => { ui.npOpen = !ui.npOpen; rerender(); };
actions.exSee = (d) => { ui.exF = d.f; rerender(); document.getElementById('exlist')?.scrollIntoView({ behavior: 'smooth' }); };
actions.exStep = (d) => { const cur = ui.day ?? location.hash.split('/')[2] ?? me.business.shiftDay; go(`#/exceptions/${addDays(cur, Number(d.n))}`); };
actions.exDay = () => go(`#/exceptions/${ui.day}`);
actions.exCopy = async () => {
  try { await navigator.clipboard.writeText(ui.exSummary); flash = { kind: 'ok', text: 'Day summary copied. Paste it into WhatsApp.' }; }
  catch { flash = { kind: 'warn', text: `Copy this summary: ${ui.exSummary.replace(/\n/g, ' · ')}` }; }
  rerender();
};

// ---------- settings (Owner and manager)

const splitTables = (text) => (text ?? '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
// ---------- Settings, Rooms and tables (21 Nov 2026). 1. Your rooms: one row per room type, a private room or a dorm sold
// per bed. 2. Restaurant tables: Out House, NC (free) and other groups. Every hotel's own names; nothing is built in.
// Stored as sections: a private room type keeps its rooms as tables; a dorm type keeps rooms with their beds.
const isRoomCat = (x) => x.kind === 'rooms' || x.kind === 'dorms';
const GROUP_KINDS = [['outhouse', 'Outside guests'], ['nc', 'Free (no charge)'], ['other', 'Tables']];
const freeName = (base) => { let n = base; let k = 2; while (ui.secs.some((x) => x.name.toLowerCase() === n.toLowerCase())) n = `${base} ${k++}`; return n; };
/** Every room, bed and table name in use (except in one row), to keep names unique. */
const allNames = (skip) => new Set(ui.secs.filter((x) => x !== skip).flatMap((x) => (x.kind === 'rooms' ? x.rooms : x.kind === 'dorms' ? x.dorms.map((d) => d.name) : splitTables(x.text))).map((t) => t.toLowerCase()));
/** Short code from a room type, for numbering its rooms: Quad Sharing → QS, Luxury → LUX. */
const roomCode = (name) => { const w = name.trim().split(/\s+/).filter(Boolean); return w.length > 1 ? w.map((x) => x[0].toUpperCase()).join('') : (w[0] ?? 'R').slice(0, 3).toUpperCase(); };
const bedsText = (x) => { const b = [...new Set(x.dorms.map((d) => Number(d.beds)))]; return b.length ? (b.length === 1 ? `${b[0]} beds` : `${Math.min(...b)}–${Math.max(...b)} beds`) : `${x.beds} beds`; };
/** "Q1, Q2, Q5:8": room names, each with its beds after a colon when it differs. */
function readRooms(text, beds) {
  return splitTables(text).map((t) => { const m = t.match(/^(.*?)\s*:\s*(\d+)$/); return m ? { name: m[1].trim(), beds: Number(m[2]) } : { name: t, beds }; });
}
const roomsText = (x) => (x.kind === 'dorms' ? x.dorms.map((d) => (Number(d.beds) === Number(x.beds) ? d.name : `${d.name}:${d.beds}`)).join(', ') : x.kind === 'rooms' ? x.rooms.join(', ') : x.text);
const roomList = (x) => (x.kind === 'dorms' ? x.dorms.map((d) => d.name) : x.kind === 'rooms' ? x.rooms : splitTables(x.text));

function tablesSettings() {
  const rows = ui.secs.map((x, i) => [x, i]);
  const cats = rows.filter(([x]) => isRoomCat(x));
  const groups = rows.filter(([x]) => !isRoomCat(x));
  const privateN = cats.filter(([x]) => x.kind === 'rooms').reduce((t, [x]) => t + x.rooms.length, 0);
  const dorms = cats.filter(([x]) => x.kind === 'dorms');
  const dormN = dorms.reduce((t, [x]) => t + x.dorms.length, 0);
  const bedN = dorms.reduce((t, [x]) => t + x.dorms.reduce((u, d) => u + (Number(d.beds) || 0), 0), 0);
  const tags = (x, i) => html`${roomList(x).map((t, j) => html`<span class="tag">${t}${x.kind === 'dorms' && Number(x.dorms[j].beds) !== Number(x.beds) ? html`<i> ${x.dorms[j].beds} beds</i>` : ''}<button class="lnx" type="button" data-act="roomDel" data-i="${i}" data-j="${j}" aria-label="Remove ${t}">×</button></span>`)}
    ${ui.addIn === i ? html`<form class="roomadd"><input class="in" data-model="addName" value="${ui.addName ?? ''}" placeholder="${isRoomCat(x) ? 'Room no.' : 'Table'}" aria-label="New name" autofocus maxlength="30"><button class="btn" type="submit" data-act="rowAddGo" data-i="${i}" data-submit>Add</button></form>`
      : html`<button class="addlink" type="button" data-act="rowAdd" data-i="${i}">+ Add</button>`}`;
  const editForm = (x, i) => html`<tr><td colspan="4"><form class="edit"><strong>${i === -1 ? (ui.editRow.room ? 'Add room type' : 'Add table group') : `Edit ${x.name}`}</strong>
    <div class="grid3" style="margin-top:10px"><label class="f">Name<input class="in" data-model="erName" value="${ui.erName ?? ''}" maxlength="30" autofocus></label>
      <label class="f">Kind<select class="in" data-model="erKind">${(ui.editRow.room ? [['rooms', 'Private room'], ['dorms', 'Dorm (sold per bed)']] : GROUP_KINDS).map(([k, t]) => html`<option value="${k}" ${ui.erKind === k ? 'selected' : ''}>${t}</option>`)}</select></label>
      ${ui.erKind === 'dorms' ? html`<div><label class="f">Beds in each room<input class="in" inputmode="numeric" data-model="erBeds" value="${ui.erBeds ?? '4'}"></label>
        <label class="chk small"><input type="checkbox" data-model="erLetters" ${ui.erLetters ? 'checked' : ''}> Beds named A, B, C (as in Djubo: "II B")</label></div>` : html`<span></span>`}
      <label class="f" style="grid-column:1/-1">${ui.editRow.room ? 'Room numbers' : 'Tables'} (comma between)${ui.erKind === 'dorms' ? html` <span class="note">· a room with other beds: Q5:8</span>` : ''}<input class="in" data-model="erList" value="${ui.erList ?? ''}"></label></div>
    <div class="row" style="margin-top:10px"><button class="btn pri" type="submit" data-act="editSave" data-submit>${i === -1 ? 'Add' : 'Done'}</button><button class="btn ghost" type="button" data-act="editNo">Cancel</button>
      ${i >= 0 ? html`<button class="btn danger" type="button" data-act="rowDel" data-i="${i}" style="margin-left:auto">Remove ${x.name}</button>` : ''}</div></form></td></tr>`;
  const row = ([x, i], kindBadge) => (ui.editRow?.i === i ? editForm(x, i)
    : html`<tr><td><strong>${x.name}</strong></td><td>${kindBadge(x)}</td><td>${tags(x, i)}</td><td class="act"><button class="btn" type="button" data-act="rowEdit" data-i="${i}">Edit</button></td></tr>`);
  const roomBadge = (x) => (x.kind === 'dorms' ? html`<span class="type d">Dorm · ${bedsText(x)}</span>` : html`<span class="type p">Private room</span>`);
  const groupBadge = (x) => html`<span class="type ${x.kind}">${(GROUP_KINDS.find(([k]) => k === x.kind) ?? GROUP_KINDS[2])[1]}</span>`;
  return html`${errorBox()}<section class="panel">
    <div class="step"><b>1</b><h2>Your rooms</h2></div>
    ${cats.length || ui.editRow?.room ? html`<div class="scroll"><table class="rt"><thead><tr><th style="width:20%">Room type</th><th style="width:16%">Kind</th><th>Room numbers</th><th style="width:110px"></th></tr></thead><tbody>
      ${cats.map((c) => row(c, roomBadge))}${ui.editRow?.i === -1 && ui.editRow.room ? editForm(null, -1) : ''}</tbody></table></div>` : html`<p class="quiet">No rooms yet. A restaurant without rooms can leave this empty.</p>`}
    ${cats.length ? html`<div class="total">Total: ${plural(privateN, 'private room')} + ${plural(dormN, 'dorm')} (${plural(bedN, 'bed')}) <span>· compare with your channel manager</span></div>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn pri" type="button" data-act="rowNew" data-room="1">+ Add room type</button><button class="btn" type="button" data-act="manyOpen">+ Add many at once</button></div>
    ${ui.many ? html`<div class="many"><strong>Add many at once</strong> <span class="note">· one room type per line: name, rooms, beds (beds only for dorms)</span>
      <textarea class="in" rows="4" data-model="quickList" placeholder="Luxury, 2&#10;Boutique Rooms, 5&#10;Hexa Neo, 2, 6" style="margin-top:6px">${ui.quickList ?? ''}</textarea>
      <div class="note">Rooms get numbers like LUX1, LUX2. Change them after.</div>
      <div class="row" style="margin-top:8px"><button class="btn" type="button" data-act="quickRooms">Add these</button><button class="btn ghost" type="button" data-act="manyOpen">Close</button></div></div>` : ''}
  </section>
  <section class="panel">
    <div class="step"><b>2</b><h2>Restaurant tables</h2></div>
    ${groups.length || (ui.editRow && !ui.editRow.room) ? html`<div class="scroll"><table class="rt"><thead><tr><th style="width:20%">Group</th><th style="width:16%">Kind</th><th>Tables</th><th style="width:110px"></th></tr></thead><tbody>
      ${groups.map((g) => row(g, groupBadge))}${ui.editRow?.i === -1 && !ui.editRow.room ? editForm(null, -1) : ''}</tbody></table></div>` : html`<p class="quiet">No tables yet.</p>`}
    <div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="rowNew" data-room="">+ Add table group</button></div>
  </section>
  <div class="row"><button class="btn pri big" type="button" data-act="tablesSave">Save</button>${ui.tableList.length ? html`<button class="btn ghost" type="button" data-act="tablesClear">Clear everything</button>` : ''}</div>`;
}
actions.manyOpen = () => { ui.many = !ui.many; ui.error = null; rerender(); };
actions.rowAdd = (d) => { ui.addIn = Number(d.i); ui.addName = ''; ui.error = null; rerender(); };
actions.rowAddGo = (d) => {
  const x = ui.secs[Number(d.i)]; const name = (ui.addName ?? '').trim();
  if (!name) throw new Error('Type the room number or table name.');
  if (allNames().has(name.toLowerCase())) throw new Error(`${name} is already used. Each room, bed and table needs its own name.`);
  if (x.kind === 'dorms') x.dorms.push({ name, beds: Number(x.beds) || 4 }); else if (x.kind === 'rooms') x.rooms.push(name); else x.text = [...splitTables(x.text), name].join(', ');
  ui.addIn = null; ui.addName = ''; ui.error = null; rerender();
};
actions.roomDel = (d) => {
  const x = ui.secs[Number(d.i)]; const j = Number(d.j);
  if (x.kind === 'dorms') x.dorms.splice(j, 1); else if (x.kind === 'rooms') x.rooms.splice(j, 1); else { const l = splitTables(x.text); l.splice(j, 1); x.text = l.join(', '); }
  rerender();
};
actions.rowNew = (d) => { ui.editRow = { i: -1, room: !!d.room }; Object.assign(ui, { erName: '', erKind: d.room ? 'rooms' : 'outhouse', erBeds: '4', erList: '', erLetters: false }); ui.error = null; rerender(); };
actions.rowEdit = (d) => {
  const x = ui.secs[Number(d.i)];
  ui.editRow = { i: Number(d.i), room: isRoomCat(x) };
  Object.assign(ui, { erName: x.name, erKind: x.kind, erBeds: String(x.beds ?? 4), erList: roomsText(x), erLetters: !!x.letters }); ui.error = null; rerender();
};
actions.editNo = () => { ui.editRow = null; ui.error = null; rerender(); };
actions.rowDel = (d) => { const x = ui.secs[Number(d.i)]; if (!confirm(`Remove ${x.name} and its ${isRoomCat(x) ? 'rooms' : 'tables'}? This happens when you press Save.`)) return; ui.secs.splice(Number(d.i), 1); ui.editRow = null; rerender(); };
actions.editSave = () => {
  const e = ui.editRow; const old = e.i >= 0 ? ui.secs[e.i] : null;
  const name = (ui.erName ?? '').trim();
  if (!name) throw new Error('Type a name.');
  if (ui.secs.some((x) => x !== old && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already used. Each room type and table group needs its own name.`);
  const beds = int(ui.erBeds || '4');
  if (ui.erKind === 'dorms' && !(beds >= 1 && beds <= 30)) throw new Error('Beds in each room: 1 to 30.');
  const list = ui.erKind === 'dorms' ? readRooms(ui.erList, beds) : splitTables(ui.erList).map((n) => ({ name: n }));
  const have = allNames(old);
  const seen = new Set();
  for (const r of list) {
    if (have.has(r.name.toLowerCase()) || seen.has(r.name.toLowerCase())) throw new Error(`${r.name} is already used. Each room, bed and table needs its own name.`);
    if (r.beds !== undefined && !(r.beds >= 1 && r.beds <= 30)) throw new Error(`${r.name}: beds must be 1 to 30.`);
    seen.add(r.name.toLowerCase());
  }
  const x = { name, kind: ui.erKind, beds: beds || 4, letters: ui.erKind === 'dorms' && !!ui.erLetters, rooms: ui.erKind === 'rooms' ? list.map((r) => r.name) : [], dorms: ui.erKind === 'dorms' ? list : [], text: isRoomCat({ kind: ui.erKind }) ? '' : list.map((r) => r.name).join(', ') };
  if (old) ui.secs[e.i] = x; else ui.secs.push(x);
  ui.editRow = null; ui.error = null; rerender();
};
// "Luxury, 2" / "Hexa Neo, 2, 6": room types with numbered rooms (LUX1, HN1…), to rename after.
actions.quickRooms = () => {
  const lines = String(ui.quickList ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Type one room type per line, e.g. Luxury, 2.');
  const made = [];
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    const name = parts[0];
    const rooms = Number(parts[1]?.match(/\d+/)?.[0]);
    const beds = Number(parts[2]?.match(/\d+/)?.[0]) || 0;
    if (!name || !(rooms > 0) || rooms > 150) throw new Error(`“${line}”: write it as name, number of rooms (and beds, for a dorm), e.g. Hexa Neo, 2, 6.`);
    if (beds > 30) throw new Error(`“${line}”: up to 30 beds in a room.`);
    if ([...ui.secs, ...made].some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already a room type.`);
    const code = roomCode(name);
    const have = new Set([...allNames(), ...made.flatMap((m) => (m.kind === 'dorms' ? m.dorms.map((r) => r.name) : m.rooms)).map((t) => t.toLowerCase())]);
    const names = []; for (let k = 1; names.length < rooms; k++) { const n = `${code}${k}`; if (!have.has(n.toLowerCase())) names.push(n); }
    made.push({ name, kind: beds ? 'dorms' : 'rooms', text: '', beds: beds || 4, rooms: beds ? [] : names, dorms: beds ? names.map((n) => ({ name: n, beds })) : [] });
  }
  ui.secs = [...ui.secs.filter(isRoomCat), ...made, ...ui.secs.filter((x) => !isRoomCat(x))];
  ui.quickList = ''; ui.many = false; ui.error = null; rerender();
};
actions.tablesSave = async () => {
  const sections = ui.secs.map((x) => (x.kind === 'dorms' ? { name: x.name, kind: x.kind, dorms: x.dorms.map((d) => ({ name: d.name, beds: Number(d.beds), ...(x.letters ? { letters: true } : {}) })) }
    : { name: x.name, kind: x.kind, tables: x.kind === 'rooms' ? x.rooms : splitTables(x.text) }));
  await api('PUT', B() + '/tables', { sections });
  flash = { kind: 'ok', text: 'Saved. The counter and check-in use these now.' }; route();
};
actions.tablesClear = async () => { if (!confirm('Clear all rooms and tables? The counter then shows the tables used lately.')) return; await api('PUT', B() + '/tables', { sections: [] }); flash = { kind: 'ok', text: 'Cleared.' }; route(); };
async function settingsScreen(tab = 'menu') {
  const tabs = [['menu', 'Menu', 'menu.edit'], ['categories', 'Categories', 'menu.edit'], ['addons', 'Add-ons', 'menu.edit'], ['stations', 'Stations', 'menu.edit'], ['tables', 'Rooms and tables', 'menu.edit'], ['reasons', 'Reasons', 'menu.edit'], ['entities', 'Billing names', 'entities.edit'], ['accounts', 'UPI accounts', 'entities.edit'],
    ['bookings', 'Rooms and bookings', 'menu.edit'], ['whatsapp', 'WhatsApp', 'whatsapp.edit'], ['staff', 'Staff and PINs', 'staff.manage'], ['device', 'This device', 'staff.manage']].filter((t) => can(t[2]));
  if (!tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
  for (const k of KEEP) delete cache[k];
  await load('menu', 'reasons', 'entities', 'payAccounts');
  if (tab === 'staff') { ui.staff = (await api('GET', B() + '/staff')).staff; ui.servers = (await api('GET', B() + '/servers')).servers; if (!me.support) ui.supportInfo = await api('GET', B() + '/support'); }
  if (tab === 'device') ui.devices = (await api('GET', B() + '/devices')).devices;
  if (tab === 'whatsapp') { ui.wa = await api('GET', B() + '/whatsapp'); ui.waAdding = null; }
  // Rooms and bookings (25 Nov 2026): mail approval, reception's Djubo users and room rates, moved here from Rooms.
  if (tab === 'bookings') {
    const today = me.business.shiftDay;
    [ui.bk, { types: ui.free, rates: ui.rates }] = await Promise.all([api('GET', B() + '/bookings'), api('GET', `${B()}/frontdesk/free?from=${today}&to=${addDays(today, 1)}`)]);
  }
  if (tab === 'menu' && can('menu.upload')) ui.uploads = (await api('GET', B() + '/menu/uploads')).uploads;
  if (tab === 'tables') {
    const t = await api('GET', B() + '/tables');
    ui.tableList = t.tables;
    // Editable copy: each section with its tables as text, or its dorms.
    ui.secs = t.sections.map((x) => ({ name: x.name, kind: x.kind, text: x.kind === 'dorms' || x.kind === 'rooms' ? '' : x.tables.join(', '),
      rooms: x.kind === 'rooms' ? [...x.tables] : [], dorms: (x.dorms ?? []).map((d) => ({ ...d })), beds: x.dorms?.[0]?.beds ?? 4, letters: !!x.dorms?.[0]?.letters }));
  }
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
      <div class="scroll"><table class="t cards"><thead><tr><th class="selcol"><input type="checkbox" class="sel" data-act-change="mSelAll" aria-label="Tick every item shown" ${menuShown.length && menuShown.every((m) => (ui.mSel ?? []).includes(m.id)) ? 'checked' : ''}></th><th>Item</th><th class="num">Price</th><th>Category</th><th>Station</th><th>Tax</th><th></th></tr></thead><tbody>
        ${menuShown.map((m) => html`<tr class="${(ui.mSel ?? []).includes(m.id) ? 'picked' : ''}"><td class="selcol"><input type="checkbox" class="sel" data-act-change="mSel" data-id="${m.id}" aria-label="Tick ${m.name}" ${(ui.mSel ?? []).includes(m.id) ? 'checked' : ''}></td><td data-label="Item"><strong>${m.name}</strong>${m.active ? '' : ' (off the menu)'}${groupsOf(m).some((g) => g.kind === 'one') ? html` <span class="tag-one">Choose</span>` : ''}${groupsOf(m).some((g) => g.kind === 'any') ? html` <span class="tag-any">+ add-ons</span>` : ''}
          ${groupsOf(m).length ? html`<div class="small quiet">${groupsOf(m).map((g) => g.name).join(', ')}</div>` : ''}</td>
          <td data-label="Price" class="num">${m.openPrice ? `Typed${m.minPricePaise != null ? `, at least ${rs(m.minPricePaise)}` : ''}` : `${groupsOf(m).some((g) => g.kind === 'one') ? 'from ' : ''}${rs(m.pricePaise)}`}</td><td data-label="Category">${m.category}</td><td data-label="Station">${routeOf(m)}<div class="small quiet">${serveText(m)}</div></td>
          <td data-label="Tax">${m.taxMode ? taxName(m) : html`<span class="quiet">${taxName(catOf(m) ?? { taxMode: 'billing' })} · from category</span>`}${taxMarks(m)}</td>
          <td class="act"><div class="irow">${iconBtn('itemEdit', m.id, 'edit', `Edit ${m.name}`)}${m.active ? iconBtn('itemToggle', m.id, 'off', `Take ${m.name} off the menu`) : iconBtn('itemToggle', m.id, 'on', `Put ${m.name} back on the menu`)}${iconBtn('itemDelete', m.id, 'trash', `Delete ${m.name}`, 'danger')}</div></td></tr>`)}</tbody></table></div>
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editItem ? 'Edit item' : 'Add item'}</h2><label class="f">Name<input class="in" data-model="iName" value="${ui.iName ?? ''}" ${ui.editItem ? 'autofocus' : ''}></label><label class="f">Category<input class="in" data-model="iCat" value="${ui.iCat ?? ''}"></label>
        <label class="f">Price at billing<select class="in" data-model="iOpen"><option value="no">No: fixed price</option><option value="yes" ${ui.iOpen === 'yes' ? 'selected' : ''}>Yes: typed when ordered (bottles, catch of the day)</option></select></label>
        ${ui.iOpen === 'yes' ? html`<label class="f">Lowest price allowed (₹, optional)<input class="in" inputmode="decimal" data-model="iMin" value="${ui.iMin ?? ''}"></label>`
          : choicePrice() !== null ? html`<label class="f">Price (₹)<input class="in" data-model="iPrice" value="${choicePrice()}" readonly aria-describedby="ip-n"><span class="small quiet" id="ip-n" style="font-weight:400">The first choice's price, set below.</span></label>`
          : html`<label class="f">Price (₹)<input class="in" inputmode="decimal" data-model="iPrice" value="${ui.iPrice ?? ''}"></label>`}
        ${itemKotFields()}
        ${itemServeField()}
        <label class="f">Tax<select class="in" data-model="iTax">${taxChoices(true).map(([v, t]) => html`<option value="${v}" ${(ui.iTax ?? 'category') === v ? 'selected' : ''}>${t}</option>`)}</select></label>
        ${followSelect('iSc', 'Service charge', 'serviceCharge')}${followSelect('iIncl', 'Price includes GST', 'priceIncl')}
        <div style="grid-column:1/-1">${itemAddons()}</div>
        <div class="f">&nbsp;<div class="row"><button class="btn pri" type="submit" data-act="addItem" data-submit>${ui.editItem ? 'Save item' : 'Add item'}</button>${ui.editItem ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></div></form></section>`;
    if (tab === 'categories') body = html`<section class="panel"><h2>Categories and GST</h2>
      <p class="quiet small">Each item takes its GST from its own setting if it has one, else from its category here, else from the billing name on the bill. A billing name not registered for GST charges none. Check rates with your CA.</p>${errorBox()}
      <p class="quiet small">KOT works the same way: each item follows its category unless the item says otherwise. "No KOT" items go on the order and the bill but never to a station (cigarettes, room charges).</p>
      <p class="quiet small">Serve in: the minutes from the KOT to the table, for every item of the category (an item can have its own). Empty: not timed. Servers mark food served on their phones; late items show on the tables screen and the Daily check.</p>
      <div class="scroll"><table class="t cards"><thead><tr><th>Category</th><th class="num">Items</th><th>GST</th><th>KOT</th><th>Station</th><th>Serve in (min)</th></tr></thead><tbody>
        ${cache.menuCats.map((c) => html`<tr><td data-label="Category"><strong>${c.name}</strong></td><td data-label="Items" class="num">${cache.menu.filter((m) => m.active && m.category.toLowerCase() === c.name.toLowerCase()).length}</td>
          <td data-label="GST"><select class="in" data-act-change="catTax" data-id="${c.id}" aria-label="GST for ${c.name}">${taxChoices(false).map(([v, t]) => html`<option value="${v}" ${taxValue(c) === v ? 'selected' : ''}>${t}</option>`)}</select></td>
          <td data-label="KOT"><select class="in" data-act-change="catKot" data-id="${c.id}" aria-label="KOT for ${c.name}"><option value="yes">Print KOT</option><option value="no" ${c.kot === 0 ? 'selected' : ''}>No KOT</option></select></td>
          <td data-label="Station">${c.kot === 0 ? html`<span class="quiet small">Not sent anywhere</span>` : html`<select class="in" data-act-change="catStation" data-id="${c.id}" aria-label="Station for ${c.name}">${activeStations().map((x) => html`<option value="${x.id}" ${c.stationId === x.id ? 'selected' : ''}>${x.name}</option>`)}</select>`}</td>
          <td data-label="Serve in (min)">${c.kot === 0 ? html`<span class="quiet small">No KOT</span>` : html`<input class="in" style="width:90px" inputmode="numeric" maxlength="3" data-act-change="catServe" data-id="${c.id}" value="${c.serveMins ?? ''}" placeholder="Not timed" aria-label="Serve in minutes for ${c.name}">`}</td></tr>`)}</tbody></table></div></section>`;
    if (tab === 'addons') body = addonsTab();
    if (tab === 'stations') body = stationsTab();
    if (tab === 'tables') body = tablesSettings();
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
        <div class="row"><button class="btn pri" type="submit" data-act="addEntity" data-submit>Save billing name</button>${ui.editEntity ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>
      ${catTaxSection()}`;
    if (tab === 'accounts') body = html`<section class="panel"><h2>UPI accounts</h2><p class="quiet small">Each QR's bank account belongs to one billing name. A bill paid into another name's account is asked about at the counter.</p>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Account</th><th>Belongs to</th><th>Bookr account id</th></tr></thead><tbody>
        ${cache.payAccounts.map((a) => html`<tr><td>${a.name}${a.active ? '' : ' (not used)'}</td><td>${a.entityName}</td><td class="small">${a.bookrAccountId ?? ''}</td>
          <td class="act">${iconBtn('acctEdit', a.id, 'edit', `Edit ${a.name}`)}</td></tr>`)}</tbody></table></div>
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editAcct ? 'Edit account' : 'Add account'}</h2><label class="f">Account name<input class="in" data-model="aName" value="${ui.aName ?? ''}" ${ui.editAcct ? 'autofocus' : ''}></label>
        <label class="f">Belongs to<select class="in" data-model="aEntity"><option value="">Choose</option>${cache.entities.map((e) => html`<option value="${e.id}" ${ui.aEntity === e.id ? 'selected' : ''}>${e.name}</option>`)}</select></label>
        <label class="f">Bookr account id (optional)<input class="in" data-model="aBookr" value="${ui.aBookr ?? ''}"></label>
        ${ui.editAcct ? html`<label class="f">Status<select class="in" data-model="aActive"><option value="yes">In use</option><option value="no" ${ui.aActive === 'no' ? 'selected' : ''}>Not used</option></select></label>` : ''}
        <div class="row"><button class="btn pri" type="submit" data-act="addAccount" data-submit>${ui.editAcct ? 'Save account' : 'Add account'}</button>${ui.editAcct ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>`;
    if (tab === 'staff') body = html`<section class="panel" style="margin-bottom:16px"><h2>What a cashier may do alone</h2>
      <form class="row" style="align-items:end"><label class="f">Discount a cashier may give alone (%)<input class="in" inputmode="numeric" data-model="discLimit" value="${ui.discLimit ?? (me.business.disc_limit_bp ?? 1000) / 100}" style="width:120px"></label>
        <button class="btn" type="submit" data-act="discLimitSave" data-submit>Save</button></form>
      <p class="small quiet">Above this, a manager's or owner's PIN is needed. A PIN is always needed to make an item free, give a complimentary bill, open a credit account, give money back, or change how a bill was paid.</p></section>
      <section class="panel" style="margin-bottom:16px"><h2>Count the drawer at Day close</h2>
      <div class="row"><button type="button" class="chip" aria-pressed="${(me.business.drawer_count ?? 1) === 1}" data-act="drawerCountSet" data-on="1">On: count the cash at closing</button>
        <button type="button" class="chip" aria-pressed="${(me.business.drawer_count ?? 1) === 0}" data-act="drawerCountSet" data-on="0">Off: takings and pending only</button></div>
      <p class="small quiet">Off: Day close shows the takings and what is pending, and closes the day without counting the drawer (no paid-out form). Turn it on again any time.</p></section>
      <section class="panel" style="margin-bottom:16px"><h2>Cash drawer float</h2>
      <form class="row" style="align-items:end"><label class="f">Float kept in the drawer (₹)<input class="in" inputmode="decimal" data-model="floatAmt" value="${ui.floatAmt ?? (me.business.float_paise ?? 0) / 100}" style="width:140px"></label>
        <button class="btn" type="submit" data-act="floatSave" data-submit>Save</button></form>
      <p class="small quiet">The day close keeps this much in the drawer for change; the rest goes to the safe. The first cash of a new drawer starts from it. 0 means the float is typed at each day close.</p></section>
      <section class="panel"><h2>Staff and PINs</h2>${errorBox()}
      <div class="scroll"><table class="t"><thead><tr><th>Name</th><th>Role</th><th>Sign-in</th></tr></thead><tbody>
        ${ui.staff.filter((s) => !s.support).map((s) => html`<tr><td>${s.name}${s.active ? '' : ' (inactive)'}</td><td>${s.role}</td><td>${s.email ?? ''}${s.hasPin ? ' · PIN set' : ''}</td>
          <td class="act">${iconBtn('staffEdit', s.id, 'edit', `Edit ${s.name}`)}</td></tr>`)}</tbody></table></div>
      ${ui.supportInfo ? supportPanel() : ''}
      <form class="grid3"><h2 style="grid-column:1/-1">${ui.editStaff ? 'Edit person (leave PIN and password empty to keep them)' : 'Add person'}</h2><label class="f">Name<input class="in" data-model="sName" value="${ui.sName ?? ''}" ${ui.editStaff ? 'autofocus' : ''}></label>
        <label class="f">Role<select class="in" data-model="sRole">${['cashier', 'captain', 'manager', 'owner'].map((r) => html`<option value="${r}" ${ui.sRole === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`)}</select></label>
        <label class="f">PIN (4–6 digits)<input class="in" inputmode="numeric" data-model="sPin" maxlength="6" autocomplete="off"></label>
        ${['manager', 'owner'].includes(ui.sRole) ? html`<label class="f">Email<input class="in" type="email" data-model="sEmail" value="${ui.sEmail ?? ''}"></label><label class="f">Password (12+ characters)<input class="in" type="password" data-model="sPassword" autocomplete="new-password"></label>` : ''}
        ${ui.editStaff ? html`<label class="f">Status<select class="in" data-model="sActive"><option value="yes">Active</option><option value="no" ${ui.sActive === 'no' ? 'selected' : ''}>Inactive (cannot sign in)</option></select></label>` : ''}
        <div class="row"><button class="btn pri" type="submit" data-act="addStaff" data-submit>${ui.editStaff ? 'Save person' : 'Add person'}</button>${ui.editStaff ? html`<button class="btn" type="button" data-act="editCancel">Cancel</button>` : ''}</div></form></section>
      ${serversPanel()}`;
    if (tab === 'bookings') body = html`<div class="stack" style="max-width:900px">${errorBox()}${bookingsPanel(ui.bk, 'settings')}${ratesForm(true)}</div>`;
    if (tab === 'whatsapp') body = whatsappSettings();
    if (tab === 'device') body = html`${window.bookrDesktop ? html`<section class="panel" style="margin-bottom:16px"><h2>Printers on this PC</h2>
      <p class="quiet small">This PC runs the Bookr POS Windows app (version ${window.bookrDesktop.version || '1'}): bills and each station's KOTs print straight to their own printers.</p>
      <button class="btn pri" type="button" data-act="deskPrinters">Choose printers</button></section>` : ''}<section class="panel"><h2>Counter devices</h2><p class="quiet small">Counter staff sign in with a PIN only on a device set up here. Set up the billing PC or tablet by signing in on it as the Owner and pressing the button below.</p>${errorBox()}
      <p class="quiet small">Works offline: a device turned on keeps taking orders, printing KOTs and bills, and taking payments when the internet is off, and sends them up when it is back. Its offline bills carry its letter (C261126A001). Turn it on for the billing PC only.</p>
      <div class="scroll"><table class="t"><thead><tr><th>Device</th><th>Added</th><th>Works offline</th><th></th></tr></thead><tbody>
        ${ui.devices.map((d) => html`<tr><td>${d.name}</td><td>${dateTime(d.createdAt)}</td>
          <td>${d.station ? html`<span class="quiet">Station screen</span>` : d.offlineLetter ? html`<b>Yes · letter ${d.offlineLetter}</b>` : d.revokedAt ? '' : html`<button class="btn" type="button" data-act="devOffline" data-id="${d.id}">Turn on</button>`}</td>
          <td>${d.revokedAt ? 'Removed' : iconBtn('revoke', d.id, 'trash', `Remove ${d.name}`, 'danger')}</td></tr>`)}</tbody></table></div>
      <form class="row"><label class="f grow">Name for this device<input class="in" data-model="dName" placeholder="Billing counter"></label><button class="btn pri" type="submit" data-act="addDevice" data-submit>Make this a counter device</button></form></section>`;
    paint(shell('#/settings', html`${head}${body}`));
  };
  rerender();
}
// ---------- Settings › WhatsApp (approved 27 Nov 2026). Bookr reads WhatsApp through the listener on the reception PC;
// this tab shows whether that works and chooses the groups. Owners and managers switch a group's reading or its bill
// proof; only the Owner starts reading a new group. The server checks the role; Bookr records who changed what.
const WA_STALE_MS = 10 * 60_000;
const waAgo = (ms) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : dateTime(ms); };
const waSwitch = (on, act, id, label, disabled = false) =>
  html`<button type="button" class="wa-sw" role="switch" aria-checked="${on}" data-act="${act}" data-id="${id}" ${disabled ? 'disabled' : ''}><i aria-hidden="true"></i>${label}</button>`;
function whatsappSettings() {
  const d = ui.wa ?? {};
  const never = html`<section class="panel"><h2>What reading never does</h2><ul class="small wa-never">
    <li>Send a message or a reaction</li><li>Show blue ticks (mark as read)</li><li>Show “online” or “typing”</li>
    <li>Read private chats</li><li>Keep text or voice notes</li><li>Change a group</li></ul>
    <p class="small quiet">The only thing it ever sends is the morning Daily check to the owner, if that is turned on.</p></section>`;
  if (!d.connected) return html`<div class="stack" style="max-width:900px">${errorBox()}<div class="msg warn">This POS is not connected to Bookr, so WhatsApp reading cannot be seen or changed here. Bookr reads WhatsApp; connect the POS to Bookr first.</div>${never}</div>`;
  if (d.error) return html`<div class="stack" style="max-width:900px">${errorBox()}<div class="msg warn">${d.error} Open this page again in a minute.</div>${never}</div>`;
  const L = d.listener ?? {};
  if (!L.lastSeenAt) return html`<div class="stack" style="max-width:900px">${errorBox()}<section class="panel"><h2>WhatsApp reading is not set up yet</h2>
    <p class="quiet" style="margin:6px 0 12px">When it is on, photos and PDF bills posted in the groups you choose (UPI screenshots, card slips, bill photos) come into Bookr by themselves, and the Payments screen shows each bill's proof.</p>
    <h3>What is needed, once</h3><ol class="small" style="margin:6px 0 0;padding-left:22px;line-height:1.6">
      <li><b>The reception PC</b> runs Bookr's small reading program, linked to the reception phone like WhatsApp Web (on the phone: WhatsApp › Linked devices › Link a device).</li>
      <li><b>A secret</b> the PC and Bookr share. It is set on the server only, never typed here.</li>
      <li><b>Come back here</b> and choose the groups to read.</li></ol>
    <p class="small quiet" style="margin-top:10px">Steps 1 and 2 are done once by whoever sets up the PC (the listener guide in Bookr). This page shows it working within a minute of the PC starting.</p></section>${never}</div>`;
  const off = Date.now() - L.lastSeenAt > WA_STALE_MS;
  const reading = d.groups.filter((g) => g.active);
  const today = reading.reduce((n, g) => n + g.today, 0);
  const owner = can('whatsapp.add');
  waPoll();
  // No number linked (the Owner unlinked it, or a switch is under way): nothing is read, whatever the groups say.
  const noNumber = !off && d.link && !d.link.last4;
  const head = off ? 'Not reading: the reception PC is off' : noNumber ? 'Not reading: no WhatsApp number linked'
    : reading.length ? `Reading ${plural(reading.length, 'group')}` : 'Set up, but no group is turned on';
  const group = (g) => html`<div class="wa-row"><div class="grow"><strong>${g.name}</strong>
      <div class="small quiet">${g.active ? (g.lastAt ? `Newest photo ${waAgo(g.lastAt)} · ${g.today} today` : 'No photos yet') : 'Off: not read'}</div>
      ${g.department ? html`<span class="status mute">${g.department}</span> ` : ''}${g.active && g.posProof ? html`<span class="status info">Payment proof at the counter</span>` : ''}</div>
    ${waSwitch(g.posProof, 'waProof', g.id, 'Proof for bills', !g.active)}${waSwitch(g.active, 'waRead', g.id, g.active ? 'Reading' : 'Off')}</div>`;
  const seen = (s) => html`<div class="wa-row"><div class="grow"><strong>${s.name}</strong><div class="small quiet">Seen ${waAgo(s.lastSeenAt)}</div></div>
      ${owner ? html`<button class="btn ${ui.waAdding === s.waGroupId ? '' : 'pri'}" type="button" data-act="waAddOpen" data-id="${s.waGroupId}">Start reading</button>` : html`<span class="small quiet">The Owner can start reading it</span>`}</div>
    ${ui.waAdding === s.waGroupId ? html`<form class="wa-add"><h3>Read “${s.name}”</h3>
      <label class="f">Department<input class="in" data-model="waDept" list="wa-depts" value="${ui.waDept ?? ''}" placeholder="Front desk" maxlength="80"></label>
      <datalist id="wa-depts">${d.departments.map((x) => html`<option value="${x}">`)}</datalist>
      <label class="tickline"><input type="checkbox" data-model="waProofNew" ${ui.waProofNew ? 'checked' : ''}> Use its photos as payment proof for bills at the counter</label>
      <p class="small quiet">Photos and PDF bills posted in it from now on are stored in Bookr.</p>
      <div class="row"><button class="btn pri" type="submit" data-act="waAddSave" data-submit>Start reading</button><button class="btn" type="button" data-act="waAddCancel">Cancel</button></div></form>` : ''}`;
  return html`<div class="stack" style="max-width:900px">${errorBox()}
    <section class="panel"><div class="row between"><h2>${head}</h2><span class="status ${off ? 'bad' : noNumber ? 'warn' : reading.length ? 'ok' : 'warn'}">${off ? 'Stopped' : noNumber ? 'No number' : reading.length ? 'Working' : 'Nothing read'}</span></div>
      <p class="quiet small" style="margin:4px 0 12px">${off ? 'Nothing is lost: photos posted while it is off come in when the PC is back on.' : noNumber ? 'Link the reception number below to start reading.' : 'New photos and PDF bills show in Bookr within a minute.'}</p>
      <div class="kpis" style="margin:0">${kpi('Reception PC', off ? 'Off' : 'Online', `last heard ${waAgo(L.lastSeenAt)}`, off ? 'bad' : '')}
        ${kpi('Newest photo', L.lastMessageAt ? time(L.lastMessageAt) : '—', L.lastMessageAt ? waAgo(L.lastMessageAt) : '')}${kpi('Photos today', String(today), 'in the groups read')}</div></section>
    ${off ? html`<div class="msg bad">Ask reception to switch on the PC and check it is online. If it stays off too long, WhatsApp unlinks it and the reception phone must link it again.</div>` : ''}
    ${waLinkBox(d.link)}
    <section class="panel"><h2>Groups read</h2><p class="quiet small">Turn a group off to stop reading it; its photos already in Bookr stay. “Proof for bills” puts its photos on the Payments screen.</p>
      ${d.groups.length ? d.groups.map(group) : html`<p class="quiet" style="margin-top:10px">No group yet.${owner ? ' Start reading one below.' : ''}</p>`}</section>
    <section class="panel"><h2>Other groups on the reception phone</h2><p class="quiet small">Seen by the PC, not read. Nothing from these is downloaded.</p>
      ${d.seen.length ? d.seen.map(seen) : html`<p class="quiet" style="margin-top:10px">None.</p>`}</section>
    ${never}</div>`;
}
// The WhatsApp number (27 Nov 2026): Owner only links, switches or unlinks it. While a link or unlink is open the screen
// asks every 3 seconds; the QR changes every 20 seconds and the link closes after 3 minutes.
let waLinkTimer = null;
function stopWaLink() { if (waLinkTimer) { clearInterval(waLinkTimer); waLinkTimer = null; } }
function waPoll() {
  if (!ui.wa?.link?.request) { stopWaLink(); return; }
  if (waLinkTimer) return;
  waLinkTimer = setInterval(async () => {
    if (!location.hash.startsWith('#/settings/whatsapp')) { stopWaLink(); return; }
    try {
      const was = ui.wa.link?.request;
      ui.wa = await api('GET', B() + '/whatsapp');
      const now = ui.wa.link;
      if (was && !now?.request) {
        stopWaLink();
        const r = now?.lastResult;
        flash = r === 'linked' ? { kind: 'ok', text: `Linked: phone ending ${now.last4}. Reading starts within a minute.` }
          : r === 'unlinked' ? { kind: 'ok', text: 'Unlinked. The reception PC has stopped reading WhatsApp.' }
          : r === 'expired' ? { kind: 'warn', text: 'Nobody scanned the code in 3 minutes, so no number is linked. Press Link to try again.' }
          : null;
      }
      rerender();
    } catch { /* tried again in 3 seconds */ }
  }, 3000);
}
/** The QR as a picture, drawn here from rows of 0 and 1 (nothing else is accepted), with the white border phones need. */
function waQr(rows) {
  if (!Array.isArray(rows) || !rows.length || !rows.every((r) => typeof r === 'string' && /^[01]+$/.test(r) && r.length === rows.length)) return '';
  const n = rows.length; const q = 4;
  let d = '';
  rows.forEach((r, y) => { for (let x = 0; x < n; x++) if (r[x] === '1') d += `M${x + q} ${y + q}h1v1h-1z`; });
  return { __html: `<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" role="img" aria-label="Code to scan with the phone" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>` };
}
function waLinkBox(k) {
  if (!k) return '';
  const owner = can('whatsapp.link');
  const req = k.request;
  const left = req ? Math.max(0, Math.round((req.endsAt - Date.now()) / 1000)) : 0;
  const tag = req ? html`<span class="status warn">${req.action === 'unlink' ? 'Unlinking' : k.qrRows ? 'Scan now' : 'Linking'}</span>`
    : k.last4 ? html`<span class="status ok">Linked</span>` : html`<span class="status mute">No number</span>`;
  let body;
  if (req && req.action === 'link' && k.qrRows && owner) {
    body = html`<div class="wa-qrwrap"><div class="wa-qr">${waQr(k.qrRows)}<p class="small" style="margin-top:6px;color:#4d5b59">Closes in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</p></div>
      <div class="grow"><h3>On the phone to link (the reception phone)</h3><ol class="small" style="margin:6px 0 0;padding-left:22px;line-height:1.7">
        <li>Open WhatsApp</li><li>Tap <b>Settings</b> (iPhone) or <b>⋮</b> (Android)</li><li>Tap <b>Linked devices</b> › <b>Link a device</b></li><li>Point the phone at this code</li></ol>
        <p class="small quiet" style="margin-top:8px">The code changes on its own every 20 seconds. It stops after 3 minutes if nobody scans; press Link again then.</p>
        <div class="row" style="margin-top:10px"><button class="btn" type="button" data-act="waLink" data-a="cancel">Cancel</button></div></div></div>`;
  } else if (req) {
    body = html`<div class="row" style="margin-top:10px"><span class="wa-spin" aria-hidden="true"></span><span>${req.action === 'unlink' ? 'Asking the reception PC to unlink' : `Asking the reception PC for a code${k.last4 ? ` (it stops reading phone ending ${k.last4} first)` : ''}`}. This takes up to a minute.</span></div>
      ${owner && req.action === 'link' ? html`<div class="row" style="margin-top:10px"><button class="btn" type="button" data-act="waLink" data-a="cancel">Cancel</button></div>` : ''}`;
  } else if (k.last4) {
    body = html`<div class="wa-phone"><div class="small quiet">The reception PC reads WhatsApp as</div><div class="wa-big">Phone ending ${k.last4}</div>
        ${k.linkedAt ? html`<div class="small quiet">Linked ${dateTime(k.linkedAt)}${k.linkedBy ? ` by ${k.linkedBy.replace(/^POS · /, '')}` : ' on the PC'}</div>` : ''}</div>
      ${owner ? html`<div class="row" style="margin-top:12px"><button class="btn" type="button" data-act="waLink" data-a="link" ${k.pcOn ? '' : 'disabled'}>Switch to another number</button>
        <button class="btn danger" type="button" data-act="waLink" data-a="unlink" ${k.pcOn ? '' : 'disabled'}>Unlink</button></div>
        <p class="small quiet" style="margin-top:8px">${k.pcOn ? 'After switching or unlinking, remove the PC on the old phone too: WhatsApp › Linked devices.' : 'The reception PC is off, so the number cannot be changed from here now. Switch the PC on first.'}</p>`
        : html`<p class="small quiet" style="margin-top:10px">Only the Owner can link, switch or unlink the number.</p>`}`;
  } else {
    body = html`<p class="quiet" style="margin-top:8px">No WhatsApp number is linked, so nothing is read.</p>
      ${owner ? html`<div class="row" style="margin-top:12px"><button class="btn pri" type="button" data-act="waLink" data-a="link" ${k.pcOn ? '' : 'disabled'}>Link a WhatsApp number</button></div>
        ${k.pcOn ? '' : html`<p class="small quiet" style="margin-top:8px">The reception PC is off. Switch it on first.</p>`}` : html`<p class="small quiet" style="margin-top:10px">Ask the Owner to link the reception number.</p>`}`;
  }
  return html`<section class="panel"><div class="row between"><h2>WhatsApp number</h2>${tag}</div>${body}</section>`;
}
actions.waLink = async (d) => {
  const k = ui.wa?.link;
  if (d.a === 'unlink' && !confirm(`Unlink phone ending ${k?.last4}? The reception PC stops reading WhatsApp until a number is linked again.`)) return;
  if (d.a === 'link' && k?.last4 && !confirm(`Switch from phone ending ${k.last4}? The reception PC stops reading it, then shows a code here to scan with the other phone.`)) return;
  ui.wa = await api('POST', B() + '/whatsapp/link', { action: d.a });
  if (d.a === 'cancel') flash = { kind: 'ok', text: 'Linking cancelled.' };
  rerender();
};

const waChange = async (id, change) => { ui.wa = await api('PATCH', `${B()}/whatsapp/groups/${id}`, change); };
actions.waRead = async (d) => {
  const g = ui.wa.groups.find((x) => x.id === d.id);
  if (g.active && !confirm(`Stop reading “${g.name}”? New photos in it will not come into Bookr. Photos already in stay.`)) return;
  await waChange(d.id, { active: !g.active });
  flash = { kind: 'ok', text: g.active ? `Stopped reading ${g.name}.` : `Reading ${g.name} again. The reception PC picks this up within a minute.` };
  rerender();
};
actions.waProof = async (d) => {
  const g = ui.wa.groups.find((x) => x.id === d.id);
  await waChange(d.id, { posProof: !g.posProof });
  flash = { kind: 'ok', text: g.posProof ? `${g.name}'s photos no longer show as payment proof.` : `${g.name}'s photos now show as payment proof on the Payments screen.` };
  rerender();
};
actions.waAddOpen = (d) => { ui.waAdding = ui.waAdding === d.id ? null : d.id; ui.waDept = ''; ui.waProofNew = false; rerender(); };
actions.waAddCancel = () => { ui.waAdding = null; rerender(); };
actions.waAddSave = async () => {
  const s = ui.wa.seen.find((x) => x.waGroupId === ui.waAdding);
  ui.wa = await api('POST', `${B()}/whatsapp/groups`, { waGroupId: ui.waAdding, department: ui.waDept || null, posProof: !!ui.waProofNew });
  ui.waAdding = null;
  flash = { kind: 'ok', text: `Reading ${s?.name ?? 'the group'} now. The reception PC picks this up within a minute.` };
  rerender();
};

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
const TAX_TEXT = (t) => (t.mode === 'billing' ? 'Food GST of the business on the bill' : t.mode === 'rate' ? `GST ${t.bp / 100}%` : t.mode === 'liquor' ? 'Liquor, outside GST' : 'No GST');
const TAX_PICK = [['', 'Choose GST'], ['Billing name', 'Food GST of the business on the bill'], ['GST 5%', 'GST 5%'], ['GST 12%', 'GST 12%'], ['GST 18%', 'GST 18%'], ['GST 28%', 'GST 28%'], ['GST 40%', 'GST 40%'], ['No GST (liquor)', 'Liquor: outside GST'], ['No GST', 'No GST (exempt)']];
const COLUMN_HELP = [
  ['Item', 'The name as on the bill. Needed.'],
  ['Category', 'The menu section (Starters, Bar…). GST is set per category; items that differ keep their own.'],
  ['Price (₹)', 'Before GST: 250, 250.50, ₹1,250. Leave empty, or write MRP or Market price, for price at billing.'],
  ['Price at billing', 'Yes for bottles and other items whose price is typed when ordered. Otherwise empty.'],
  ['Lowest price (₹)', 'For price at billing only: the least that can be typed. Optional.'],
  ['Tax', 'Billing name: the food GST of the business on the bill (5% when it is GST-registered, none when not). Or GST 5% / 12% / 18% / 28% / 40%, No GST (liquor), or No GST. Left empty: asked per category.'],
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
        <ul>${k.lines.map((l) => html`<li class="${l.cancelled ? 'cx' : ''}">${l.cancelled ? `Cancel ${Math.abs(l.qty)}` : l.qty} × ${l.name}${(l.options ?? []).map((o) => html`<small>+ ${o}</small>`)}${l.remark ? html`<small style="font-weight:700;color:var(--warn)">» ${l.remark}</small>` : ''}</li>`)}</ul>
        ${k.note ? html`<div class="small" style="font-weight:700;border:2px solid var(--warn);border-radius:6px;padding:3px 6px;margin-top:4px">Note: ${k.note}</div>` : ''}
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
const taxChoices = (forItem) => [...(forItem ? [['category', 'From its category']] : []), ['billing', 'Food GST of the business on the bill'],
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
    : { off: `${n} taken off the menu.`, on: `${n} put back on the menu.`, category: `${n} moved to ${value}.`, station: `${n}: station changed.`, tax: `${n}: tax changed.`,
      serviceCharge: `${n}: service charge ${value === 'category' ? 'as category' : value}.`, priceIncl: `${n}: price includes GST ${value === 'category' ? 'as category' : value}.` }[action] };
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
    ${['serviceCharge', 'priceIncl'].map((k) => html`<select class="in" data-act-change="mBulkPick" data-do="${k}" aria-label="${k === 'serviceCharge' ? 'Service charge' : 'Price includes GST'} for ticked items">
      <option value="">${k === 'serviceCharge' ? 'Service charge…' : 'Price includes GST…'}</option><option value="category">As its category</option><option value="yes">Yes</option><option value="no">No</option></select>`)}
    <button class="btn danger" type="button" data-act="mBulk" data-do="delete">Delete</button>
    <button class="btn ghost" type="button" data-act="mSelClear">Clear ticks</button></div>`;
}
actions.catTax = async (d, el) => {
  await api('PUT', `${B()}/menu-categories/${d.id}`, taxBody(el.value));
  const c = cache.menuCats.find((x) => x.id === d.id); Object.assign(c, el.value.startsWith('rate:') ? { taxMode: 'rate', gstBp: Number(el.value.slice(5)) * 100 } : { taxMode: el.value, gstBp: null });
  flash = { kind: 'ok', text: `${c.name}: ${taxName(c)}.` }; route();
};
/** What an item carries besides its GST (26 Nov 2026): service charge, a price with GST in it, and "own" when it does not follow its category. */
function taxMarks(m) {
  const c = catOf(m);
  const sc = m.serviceCharge ?? c?.serviceCharge ?? 0;
  const mode = m.taxMode ?? c?.taxMode ?? 'billing';
  const incl = (m.priceIncl ?? c?.priceIncl ?? 0) && mode !== 'none' && mode !== 'liquor';
  const own = m.serviceCharge != null || m.priceIncl != null;
  if (!sc && !incl && !own) return '';
  return html`<div class="row" style="gap:4px;margin-top:4px">${sc ? html`<span class="badge open">+ service charge</span>` : ''}${incl ? html`<span class="badge new">price incl. GST</span>` : ''}${own ? html`<span class="badge">own setting</span>` : ''}</div>`;
}
/** An item's own choice or its category's (26 Nov 2026), for the item form; "As its category" says what that is. */
function followSelect(model, label, field) {
  const c = catOf({ category: ui.iCat ?? '' });
  const v = ui[model] ?? 'category';
  return html`<label class="f">${label}<select class="in" data-model="${model}">
    <option value="category" ${v === 'category' ? 'selected' : ''}>As its category${c ? ` (${c[field] ? 'yes' : 'no'})` : ''}</option>
    <option value="yes" ${v === 'yes' ? 'selected' : ''}>Yes, for this item</option><option value="no" ${v === 'no' ? 'selected' : ''}>No, for this item</option></select></label>`;
}
/**
 * GST and service charge by category (26 Nov 2026), under Billing names: the service charge rate, then each category's
 * GST, service charge and price-includes-GST as ticks, and how many of its items are set on their own (in Menu).
 */
function catTaxSection() {
  if (!can('menu.edit')) return '';
  const cats = cache.menuCats ?? [];
  const rate = ui.scRate ?? String((me.business.service_charge_bp ?? 0) / 100);
  const own = (c) => cache.menu.filter((m) => m.category.toLowerCase() === c.name.toLowerCase() && (m.taxMode != null || m.serviceCharge != null || m.priceIncl != null)).length;
  const gstOn = (c) => c.taxMode !== 'none' && c.taxMode !== 'liquor';
  return html`<section class="panel"><h2>GST and service charge by category</h2>
    <p class="quiet small">Tick what each category carries. An item follows its category unless it is set on its own in Menu. GST is charged only on bills under a GST-registered billing name. Service charge is optional for the guest: the bill screen has a button to take it off.</p>
    <form class="row"><label class="f" style="max-width:220px">Service charge (%)<input class="in" inputmode="decimal" data-model="scRate" value="${rate}"></label>
      <div class="f">&nbsp;<button class="btn" type="submit" data-act="scSave" data-submit>Save rate</button></div>
      <p class="small quiet" style="align-self:center">On the value before GST; GST is charged on it too. 0 = no service charge.</p></form>
    ${cats.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Category</th><th>GST</th><th>Service charge</th><th>Price includes GST</th><th>Items set on their own</th></tr></thead><tbody>
      ${cats.map((c) => html`<tr><td><strong>${c.name}</strong>${c.taxMode === 'liquor' ? html`<div class="small quiet">Liquor · outside GST</div>` : c.taxMode === 'rate' ? html`<div class="small quiet">GST ${c.gstBp / 100}%</div>` : ''}</td>
        <td><input type="checkbox" aria-label="GST on ${c.name}" data-act-change="catFlag" data-id="${c.id}" data-f="gst" ${gstOn(c) ? 'checked' : ''} ${c.taxMode === 'liquor' ? 'disabled' : ''}></td>
        <td><input type="checkbox" aria-label="Service charge on ${c.name}" data-act-change="catFlag" data-id="${c.id}" data-f="sc" ${c.serviceCharge ? 'checked' : ''}></td>
        <td><input type="checkbox" aria-label="Price includes GST for ${c.name}" data-act-change="catFlag" data-id="${c.id}" data-f="incl" ${c.priceIncl ? 'checked' : ''} ${gstOn(c) ? '' : 'disabled'}></td>
        <td>${own(c) ? html`<span class="badge new">${plural(own(c), 'item')}</span>` : html`<span class="small quiet">None</span>`}</td></tr>`)}</tbody></table></div>`
    : html`<p class="empty">No categories yet: add items in Menu first.</p>`}</section>`;
}
actions.scSave = async () => {
  const pct = Number(String(ui.scRate ?? '').trim() || '0');
  const r = await api('PUT', `${B()}/service-charge`, { pct });
  me.business.service_charge_bp = r.serviceChargeBp; ui.scRate = undefined;
  flash = { kind: 'ok', text: r.serviceChargeBp ? `Service charge ${r.serviceChargeBp / 100}% saved.` : 'Service charge off.' }; route();
};
actions.catFlag = async (d, el) => {
  const c = cache.menuCats.find((x) => x.id === d.id);
  // GST on keeps a category's own rate, else the billing name's; off = no GST (and so no price-includes-GST).
  const body = d.f === 'gst' ? (el.checked ? (c.taxMode === 'rate' ? { taxMode: 'rate', gstRate: c.gstBp / 100 } : { taxMode: 'billing' }) : { taxMode: 'none', priceIncl: false })
    : d.f === 'sc' ? { serviceCharge: el.checked } : { priceIncl: el.checked };
  await api('PUT', `${B()}/menu-categories/${c.id}`, body);
  flash = { kind: 'ok', text: `${c.name}: ${{ gst: 'GST', sc: 'service charge', incl: 'price includes GST' }[d.f]} ${el.checked ? 'on' : 'off'}.` }; route();
};
actions.addItem = async () => {
  const open = ui.iOpen === 'yes';
  const body = { name: ui.iName, category: ui.iCat, price: open ? '' : ui.iPrice ?? '', stationId: ui.iStationId ?? '', kot: ui.iKot ?? 'category', ...taxBody(ui.iTax ?? 'category'),
    serviceCharge: ui.iSc ?? 'category', priceIncl: ui.iIncl ?? 'category', serveMins: String(ui.iServe ?? '').trim(),
    openPrice: open, minPrice: open ? ui.iMin ?? '' : '', addonGroups: (ui.iGroups ?? []).map((id) => ({ id, prices: itemPricesOut(id) })) };
  const fromChoice = !open && choicePrice();
  if (fromChoice) body.price = fromChoice;
  let lowered = '';
  if (ui.editItem) {
    const m = cache.menu.find((x) => x.id === ui.editItem);
    const r = await api('PUT', `${B()}/menu/${m.id}`, { ...body, sac: m.sac, active: !!m.active });
    // A lower price (26 Nov 2026): offer it on open orders still at the old price.
    if (r.openHigher && confirm(`${m.name} is cheaper now. Lower it on ${plural(r.openHigher, 'open order')} that still ${r.openHigher === 1 ? 'has' : 'have'} the old price? (Bills already printed stay as they are.)`)) {
      const x = await api('POST', `${B()}/menu/${m.id}/reprice-open`, {});
      lowered = x.places.length ? ` Lowered on ${x.places.join(', ')}.` : '';
    }
  }
  else await api('POST', B() + '/menu', body);
  flash = { kind: 'ok', text: `${ui.iName} ${ui.editItem ? 'saved' : 'added'}.${lowered}` }; route();
};
/** Items the Menu tab shows: matching the search (name or category, any word order) and the chosen category. */
function menuFilter() {
  const words = String(ui.mQ ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return cache.menu.filter((m) => (!ui.mCat || m.category === ui.mCat) && words.every((w) => m.name.toLowerCase().includes(w) || m.category.toLowerCase().includes(w)));
}
const toItemForm = () => setTimeout(() => root.querySelector('form.grid3')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
actions.mNew = () => { Object.assign(ui, { editItem: null, iServe: '', iName: '', iCat: ui.mCat ?? '', iPrice: '', iStationId: '', iKot: 'category', iTax: 'category', iSc: 'category', iIncl: 'category', iOpen: 'no', iMin: '', iGroups: [], iPrices: {} }); rerender(); toItemForm(); root.querySelector('[data-model="iName"]')?.focus({ preventScroll: true }); };
actions.itemEdit = (d) => { const m = cache.menu.find((x) => x.id === d.id); Object.assign(ui, { editItem: m.id, iServe: m.serveMins == null ? '' : String(m.serveMins), iName: m.name, iCat: m.category, iPrice: rupees(m.pricePaise), iStationId: m.stationId ?? '', iKot: m.kot == null ? 'category' : m.kot ? 'yes' : 'no', iTax: taxValue(m),
  iSc: m.serviceCharge == null ? 'category' : m.serviceCharge ? 'yes' : 'no', iIncl: m.priceIncl == null ? 'category' : m.priceIncl ? 'yes' : 'no',
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
actions.devOffline = async (d) => {
  const dev = ui.devices.find((x) => x.id === d.id);
  if (!confirm(`Turn on offline for ${dev.name}? It can then print bills with no internet, numbered with its own letter. This cannot be turned off; remove the device instead.`)) return;
  const r = await api('POST', `${B()}/devices/${d.id}/offline`);
  flash = { kind: 'ok', text: `${dev.name} works offline now, with letter ${r.letter}. It saves what it needs while the POS is open on it with the internet on.` };
  offlineAsked = false;
  route();
};
actions.addDevice = async () => { await api('POST', B() + '/devices', { name: ui.dName || 'Billing counter' }); flash = { kind: 'ok', text: 'This browser is now a counter device. Staff can sign in here with their PIN.' }; route(); };
actions.revoke = async (d) => {
  const dev = ui.devices.find((x) => x.id === d.id);
  if (!confirm(`Remove ${dev?.name ?? 'this device'}? Staff can no longer sign in with a PIN on it until an Owner sets it up again.`)) return;
  await api('POST', `${B()}/devices/${d.id}/revoke`); route();
};

// ---------- serving time (mock and data model approved 28 Nov 2026)
// Each dish has a serve time (its own, else its category's). Servers sign in on their own phones on the Serve page and
// mark items served with a photo; the tables screen counts down; managers see, mark and undo on Tables › Serving.
const SERVE_REASONS = ['Tapped by mistake', 'Wrong table', 'Food sent back', 'Other'];
/** A waiting or served line's chip: "12 min left", "Soon · 3 min", "Late 4 min", "Served", "Served 2 min late". */
function svChip(l) {
  if (l.state === 'late') return html`<span class="svc late">Late ${-l.leftMins} min</span>`;
  if (l.state === 'soon') return html`<span class="svc soon">Soon · ${l.leftMins} min</span>`;
  if (l.state === 'ok') return html`<span class="svc">${l.leftMins} min left</span>`;
  if (l.state === 'served_late') return html`<span class="svc late">Served ${l.lateMins} min late</span>`;
  return html`<span class="svc done">Served on time</span>`;
}
const SV_RANK = { late: 3, soon: 2, ok: 1 };
/** The most urgent waiting line of an order, for its table tile (null: nothing timed is waiting). */
function svWorst(orderId) {
  const w = (ui.svLive ?? []).filter((l) => l.orderId === orderId && l.servedAt === null);
  if (!w.length) return (ui.svLive ?? []).some((l) => l.orderId === orderId) ? { state: 'all' } : null;
  return w.sort((a, b) => SV_RANK[b.state] - SV_RANK[a.state] || a.leftMins - b.leftMins)[0];
}
const svTile = (o) => { const w = svWorst(o.id); return !w ? '' : w.state === 'all' ? html`<span class="svc done">All served</span>` : svChip(w); };
let liveTimer = null;
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
/** Every 30 seconds on the tables and serving screens: the timers move, unless someone is typing. */
function startLive(refresh) {
  stopLive();
  liveTimer = setInterval(async () => {
    if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    try { await refresh(); flash = shownFlash; rerender(); } catch { /* the next tick tries again */ }
  }, 30_000);
}

// ----- the server's phone: #/serve/<business id>
let serveTimer = null;
function stopServe() { if (serveTimer) { clearInterval(serveTimer); serveTimer = null; } }
async function serveCall(method, path, body, type = 'application/json') {
  const r = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': type } : {},
    body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(data?.error ?? 'Could not reach the server. Check the Wi-Fi.', r.status);
  return data;
}
/**
 * A photo from the camera, made small enough to send quickly (longest side 1280 px, JPEG), with a preview. Read as a
 * data: address, which the page's security policy allows for images (blob: addresses are not allowed).
 */
async function shrinkPhoto(file) {
  const src = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.72));
  if (!blob) throw new Error('no photo');
  return { blob, preview: c.toDataURL('image/jpeg', 0.5) };
}
// The camera input lives outside the screen, so a refresh of the list never loses a photo being taken.
const svCamera = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
document.body.appendChild(svCamera);
svCamera.addEventListener('change', async () => {
  const f = svCamera.files?.[0];
  svCamera.value = '';
  if (!f || !ui.sv) return;
  try { const p = await shrinkPhoto(f); ui.sv.shot = p.blob; ui.sv.shotUrl = p.preview; ui.sv.err = null; }
  catch { ui.sv.err = 'That photo could not be read. Take it again.'; }
  paintServe();
});
async function serveScreen(bid) {
  document.title = 'Serve';
  // Added to the home screen from here, the icon opens this Serve page (28 Nov 2026), not the staff sign-in.
  if (/^[0-9a-f-]{36}$/i.test(bid)) {
    const mf = document.querySelector('link[rel="manifest"]');
    if (mf) mf.setAttribute('href', `/api/serve-manifest/${bid}`);
    let t = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (!t) { t = document.createElement('meta'); t.setAttribute('name', 'apple-mobile-web-app-title'); document.head.append(t); }
    t.setAttribute('content', 'Serve');
  }
  document.body.classList.remove('desk');
  ui.sv = { bid, pin: '', screen: 'loading', data: null, open: null, whole: true, ticks: {}, shot: null, shotUrl: null, err: null, pending: [] };
  rerender = paintServe;
  const tick = async () => {
    try {
      ui.sv.data = await serveCall('GET', '/serve/kots');
      if (ui.sv.screen === 'loading' || ui.sv.screen === 'pin') ui.sv.screen = 'list';
      ui.sv.offline = false;
    } catch (e) {
      if (e.status === 401) { ui.sv.screen = 'pin'; ui.sv.data = null; } else ui.sv.offline = true;
    }
    // Only the list redraws by itself; a KOT being served stays as it is until the server is done.
    if (location.hash.startsWith('#/serve/') && ui.sv.screen !== 'kot') paintServe();
  };
  ui.sv.tick = tick;
  paintServe();
  await tick();
  stopServe();
  serveTimer = setInterval(tick, 10_000);
}
function paintServe() {
  const sv = ui.sv;
  const top = (title, out) => html`<header class="sv-top"><span>${title}</span>${out ? html`<button type="button" data-act="svOut">Sign out</button>` : ''}</header>`;
  if (sv.screen === 'loading') { root.innerHTML = asHtml(html`<main class="sv">${top('Serve')}<p class="sv-body quiet">Loading…</p></main>`); return; }
  if (sv.screen === 'pin') {
    root.innerHTML = asHtml(html`<main class="sv">${top('Serve · sign in')}<div class="sv-body sv-pin">
      <p>Type your 6-digit PIN</p>
      <div class="sv-dots" aria-label="${sv.pin.length} of 6 digits typed">${[0, 1, 2, 3, 4, 5].map((i) => html`<i class="${i < sv.pin.length ? 'on' : ''}"></i>`)}</div>
      ${sv.err ? html`<p class="sv-err" role="alert">${sv.err}</p>` : ''}
      <div class="sv-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((d) => (d ? html`<button type="button" data-act="svKey" data-k="${d}" aria-label="${d === '⌫' ? 'Delete' : d}">${d}</button>` : html`<span></span>`))}</div>
      <p class="small quiet">Only server PINs work here. Ask the manager if you have none.</p></div></main>`);
    return;
  }
  const d = sv.data;
  if (sv.screen === 'kot') {
    const k = d?.kots.find((x) => x.kotId === sv.open);
    if (!k) { sv.screen = 'list'; return paintServe(); }
    const waiting = k.items.filter((i) => i.servedAt === null);
    const ticked = (i) => sv.whole || sv.ticks[i.lineNo] !== false;
    root.innerHTML = asHtml(html`<main class="sv">${top(`${k.place} · KOT ${k.kotNo}`, true)}<div class="sv-body">
      <button class="btn ghost" type="button" data-act="svBack" style="justify-self:start">‹ Back</button>
      <p class="small quiet" style="margin:0">${sv.whole ? 'Every item below is marked served.' : 'Tick what is going out now. The rest stay on the list.'}</p>
      ${k.items.map((i) => (i.servedAt !== null
        ? html`<div class="sv-check done"><span class="sv-tick" aria-hidden="true">✓</span><span class="grow">${i.qty} × ${i.name}</span><span class="small">served ${time(i.servedAt)}</span></div>`
        : sv.whole ? html`<div class="sv-check"><span class="grow">${i.qty} × ${i.name}${i.remark ? html` <span class="small quiet">» ${i.remark}</span>` : ''}</span>${svChip(i)}</div>`
        : html`<label class="sv-check"><input type="checkbox" data-act-change="svTick" data-n="${i.lineNo}" ${ticked(i) ? 'checked' : ''}><span class="grow">${i.qty} × ${i.name}</span>${svChip(i)}</label>`))}
      ${sv.shotUrl ? html`<img class="sv-photo" src="${sv.shotUrl}" alt="Photo of the KOT and the food">` : html`<div class="sv-photo none">No photo yet. Take the KOT and the food together.</div>`}
      ${sv.err ? html`<p class="sv-err" role="alert">${sv.err}</p>` : ''}
      ${sv.shot ? html`<button class="btn pri big wide" type="button" data-act="svDone">Mark served</button><button class="btn wide" type="button" data-act="svShoot">Take again</button>`
        : html`<button class="btn pri big wide" type="button" data-act="svShoot">Take photo</button>`}
      ${waiting.length ? '' : html`<p class="quiet">Everything here is served.</p>`}</div></main>`);
    return;
  }
  const recent = (d?.recent ?? []).filter((r) => r.undoUntil > Date.now());
  root.innerHTML = asHtml(html`<main class="sv">${top(`Serve · ${d?.server.name ?? ''}`, true)}<div class="sv-body">
    <div class="row between"><b>Running KOTs</b><span class="small quiet">${sv.offline ? 'Not connected: trying again' : `${d.business} · ${time(d.now)}`}</span></div>
    ${sv.pending.length ? html`<div class="msg warn"><div class="row between"><span>${plural(sv.pending.length, 'photo')} not sent.</span><button class="btn" type="button" data-act="svRetry">Retry</button></div></div>` : ''}
    ${recent.map((r) => html`<div class="msg ok"><div class="row between"><span>${r.place}: ${plural(r.items, 'item')} served at ${time(r.at)}</span><button class="btn" type="button" data-act="svUndo" data-b="${r.batch}">Undo</button></div>
      <span class="small">Undo is here for 2 minutes. After that, ask a manager.</span></div>`)}
    ${d.kots.length ? d.kots.map((k) => { const left = k.items.filter((i) => i.servedAt === null); return html`<div class="sv-kot ${k.state}">
      <div class="row between"><b>${k.place} · KOT ${k.kotNo}</b>${svChip(left.sort((a, b) => a.leftMins - b.leftMins)[0])}</div>
      <ul class="sv-items">${k.items.map((i) => (i.servedAt !== null ? html`<li class="done"><span><span class="sv-tick" aria-hidden="true">✓</span> ${i.qty} × ${i.name}</span><span class="small">served ${time(i.servedAt)}</span></li>`
        : html`<li><span>${i.qty} × ${i.name}</span></li>`))}</ul>
      <div class="sv-btns"><button class="btn pri" type="button" data-act="svOpen" data-id="${k.kotId}" data-whole="1">${left.length > 1 ? 'Complete' : 'Served'}</button>${left.length > 1 ? html`<button class="btn" type="button" data-act="svOpen" data-id="${k.kotId}" data-whole="0">Part</button>` : ''}</div></div>`; })
      : html`<p class="quiet">Nothing waiting.</p>`}</div></main>`);
}
actions.svKey = async (d) => {
  const sv = ui.sv; sv.err = null;
  if (d.k === '⌫') sv.pin = sv.pin.slice(0, -1); else if (sv.pin.length < 6) sv.pin += d.k;
  paintServe();
  if (sv.pin.length < 6) return;
  const pin = sv.pin; sv.pin = '';
  try { await serveCall('POST', '/serve/signin', { businessId: sv.bid, pin }); sv.screen = 'loading'; await sv.tick(); }
  catch (e) { sv.err = e.message; paintServe(); }
};
actions.svOut = async () => { await serveCall('POST', '/serve/signout', {}).catch(() => {}); Object.assign(ui.sv, { screen: 'pin', data: null, pin: '' }); paintServe(); };
actions.svOpen = (d) => { Object.assign(ui.sv, { screen: 'kot', open: d.id, whole: d.whole === '1', ticks: {}, shot: null, shotUrl: null, err: null }); paintServe(); };
actions.svBack = () => { ui.sv.screen = 'list'; paintServe(); ui.sv.tick(); };
actions.svTick = (d, el) => { ui.sv.ticks[d.n] = el.checked; };
actions.svShoot = () => svCamera.click();
async function svSend(p) {
  await serveCall('POST', `/serve/photo/${p.batch}`, p.blob, 'image/jpeg');
  ui.sv.pending = ui.sv.pending.filter((x) => x !== p);
}
actions.svDone = async () => {
  const sv = ui.sv;
  const k = sv.data.kots.find((x) => x.kotId === sv.open);
  const lines = k.items.filter((i) => i.servedAt === null && (sv.whole || sv.ticks[i.lineNo] !== false)).map((i) => i.lineNo);
  if (!lines.length) { sv.err = 'Tick at least one item.'; paintServe(); return; }
  try {
    const r = await serveCall('POST', `/serve/kots/${k.kotId}/served`, { lines });
    // Served now (the time of the tap); the photo follows, and is retried if the Wi-Fi drops.
    const p = { batch: r.batch, blob: sv.shot };
    sv.pending.push(p);
    Object.assign(sv, { screen: 'list', shot: null, shotUrl: null, err: null });
    await svSend(p).catch(() => {});
    await sv.tick();
  } catch (e) { sv.err = e.message; paintServe(); }
};
actions.svRetry = async () => { for (const p of [...ui.sv.pending]) await svSend(p).catch(() => {}); paintServe(); };
actions.svUndo = async (d) => {
  try { await serveCall('POST', `/serve/undo/${d.b}`, {}); ui.sv.pending = ui.sv.pending.filter((x) => x.batch !== d.b); await ui.sv.tick(); }
  catch (e) { ui.sv.err = e.message; await ui.sv.tick(); }
};

// ----- Tables › Serving, for managers on the billing PC
async function servingScreen() {
  const refresh = async () => {
    [ui.svm, ui.svBlocks] = await Promise.all([api('GET', `${B()}/serving`), api('GET', `${B()}/serving/blocks`).then((r) => r.blocks).catch(() => [])]);
  };
  await refresh();
  const photo = (batch) => html`<a href="/api${B()}/serving/photo/${batch}" target="_blank" rel="noopener">Photo</a>`;
  rerender = () => {
    const m = ui.svm;
    paint(shell('#/', html`${pageHead('Serving', `Shift of ${dayName(m.shiftDay)} · timers move every 30 seconds`, html`<a class="btn" href="#/">Back to tables</a>`)}${errorBox()}
      <div class="msg">A server can undo their own tap for 2 minutes. After that, only a manager can, here, with a reason. Every undo and every item marked here shows on the Daily check.
        Servers sign in at <b>${location.origin}/#/serve/${me.business.id}</b></div>
      ${(ui.svBlocks ?? []).length ? html`<section class="panel"><h2>Blocked by wrong server PINs</h2>${ui.svBlocks.map((b) => html`<div class="row between"><span>A connection${b.known ? ' servers use (likely the hotel Wi-Fi)' : ''}: ${b.wrong} wrong PINs, last at ${time(b.last)}. Free again at ${time(b.until)}.</span>
        <button class="btn" type="button" data-act="svUnblock" data-c="${b.conn}">Unlock</button></div>`)}</section>` : ''}
      <section class="panel"><h2>Waiting to be served</h2>
        ${m.waiting.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Table</th><th>Item</th><th>Sent</th><th>Due</th><th>State</th><th></th></tr></thead><tbody>
          ${m.waiting.map((l) => html`<tr><td>${l.place}</td><td>${l.qty} × ${l.name}</td><td>${time(l.sentAt)}</td><td>${time(l.dueAt)}</td><td>${svChip(l)}</td>
            <td><button class="btn" type="button" data-act="svMark" data-k="${l.kotId}" data-n="${l.lineNo}">Mark served</button></td></tr>`)}</tbody></table></div>
          <p class="small quiet">"Mark served" here is for when a server forgot. It is saved as by a manager, with no photo, and counted apart.</p>` : html`<p class="quiet">Nothing waiting.</p>`}</section>
      ${ui.svUndo ? html`<form class="panel"><h2>Undo served · ${ui.svUndo.label}</h2>
        <div class="row" style="align-items:end"><label class="f">Reason<select class="in" data-model="svReason">${SERVE_REASONS.map((r) => html`<option ${ui.svReason === r ? 'selected' : ''}>${r}</option>`)}</select></label>
          <button class="btn pri" type="submit" data-act="svUndoGo" data-submit>Undo</button><button class="btn ghost" type="button" data-act="svUndoNo">Cancel</button></div>
        <p class="small quiet">The item goes back on the servers' list. Late is still worked out from the first time it was marked.</p></form>` : ''}
      <section class="panel"><h2>Served this shift</h2>
        ${m.served.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Table</th><th>Item</th><th>Served</th><th>By</th><th>Photo</th><th>Result</th><th></th></tr></thead><tbody>
          ${m.served.map((l) => html`<tr><td>${l.place}</td><td>${l.qty} × ${l.name}</td><td>${l.servedAt ? time(l.servedAt) : html`<span class="quiet">undone</span>`}</td>
            <td>${l.by ?? ''}${l.byManager ? ' (manager, no photo)' : ''}</td><td>${l.photo && l.batch ? photo(l.batch) : html`<span class="quiet">none</span>`}</td>
            <td>${l.lateMins ? html`<span class="svc late">${l.lateMins} min late</span>` : html`<span class="svc done">On time</span>`}</td>
            <td>${l.servedAt ? html`<button class="btn" type="button" data-act="svUndoAsk" data-k="${l.kotId}" data-n="${l.lineNo}" data-l="${l.place} · ${l.qty} × ${l.name}">Undo</button>` : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="quiet">Nothing served yet this shift.</p>`}</section>
      <section class="panel"><h2>Undone and marked by a manager today</h2>
        ${m.log.length ? html`<ul class="small">${m.log.map((e) => html`<li>${time(e.at)} · ${e.ref} · ${e.kind === 'serve_manager' ? 'marked served by' : 'undone by'} ${e.by ?? ''}${e.reason ? ` · ${e.reason}` : ''}</li>`)}</ul>` : html`<p class="quiet">None.</p>`}</section>`));
  };
  rerender();
  startLive(refresh);
}
actions.svMark = async (d) => { await api('POST', `${B()}/serving/mark`, { kotId: d.k, lineNo: Number(d.n) }); flash = { kind: 'ok', text: 'Marked served (by a manager, no photo).' }; route(); };
actions.svUndoAsk = (d) => { ui.svUndo = { kotId: d.k, lineNo: Number(d.n), label: d.l }; ui.svReason = SERVE_REASONS[0]; rerender(); };
actions.svUndoNo = () => { ui.svUndo = null; rerender(); };
actions.svUndoGo = async () => { await api('POST', `${B()}/serving/undo`, { ...ui.svUndo, label: undefined, reason: ui.svReason ?? SERVE_REASONS[0] }); flash = { kind: 'ok', text: `Undone: ${ui.svUndo.label}. It is back on the servers' list.` }; route(); };
actions.svUnblock = async (d) => { await api('POST', `${B()}/serving/unblock`, { conn: d.c }); flash = { kind: 'ok', text: 'Unlocked: servers on that connection can sign in again.' }; route(); };

// ----- Settings › Staff and PINs: servers (Owner)
function serversPanel() {
  const link = `${location.origin}/#/serve/${me.business.id}`;
  const quiet14 = (s) => s.active && Date.now() - (s.lastSeenAt ?? s.createdAt) > 14 * 86_400_000;
  return html`<section class="panel" style="margin-top:16px"><h2>Servers</h2>
    <p class="quiet small">Servers mark food served on their own phones. Send them this address; they sign in with a 6-digit PIN that works only there and opens only the Serve screen. Remove a server and their PIN stops at once, even on an open phone. Sign-ins end at day close.</p>
    <div class="row"><code class="tag-any">${link}</code><button class="btn" type="button" data-act="svCopyLink" data-l="${link}">Copy</button></div>
    ${ui.servers.length ? html`<div class="scroll"><table class="t"><thead><tr><th>Name</th><th>Last signed in</th><th></th></tr></thead><tbody>
      ${ui.servers.map((s) => html`<tr><td>${s.name}${s.active ? '' : ' (removed)'}</td><td>${s.lastSeenAt ? dateTime(s.lastSeenAt) : 'Not yet'}${quiet14(s) ? html` <span class="badge new">Not seen 14+ days</span>` : ''}</td>
        <td class="act"><div class="row">${s.active ? html`<a class="btn" href="${`https://wa.me/?text=${encodeURIComponent(serveInvite(s.name, link))}`}" target="_blank" rel="noopener">Send on WhatsApp</a><button class="btn" type="button" data-act="svCopyMsg" data-id="${s.id}">Copy message</button><button class="btn" type="button" data-act="svNewPin" data-id="${s.id}">New PIN</button><button class="btn danger" type="button" data-act="svRemove" data-id="${s.id}">Remove</button>`
          : html`<button class="btn" type="button" data-act="svNewPin" data-id="${s.id}">Bring back</button>`}</div></td></tr>`)}</tbody></table></div>` : html`<p class="quiet">No servers yet.</p>`}
    <form class="grid3"><h3 style="grid-column:1/-1;margin:0">${ui.svEdit ? `New PIN for ${ui.servers.find((s) => s.id === ui.svEdit)?.name}` : 'Add a server'}</h3>
      ${ui.svEdit ? '' : html`<label class="f">Name<input class="in" data-model="svName" value="${ui.svName ?? ''}"></label>`}
      <label class="f">PIN (6 digits)<input class="in" inputmode="numeric" maxlength="6" autocomplete="off" data-model="svPin" value="${ui.svPin ?? ''}"></label>
      <div class="row"><button class="btn pri" type="submit" data-act="svSave" data-submit>${ui.svEdit ? 'Save PIN' : 'Add server'}</button>${ui.svEdit ? html`<button class="btn" type="button" data-act="svEditNo">Cancel</button>` : ''}</div></form></section>`;
}
/** The invite a server gets on WhatsApp (28 Nov 2026), as Bookr's cashier invite: the link, how to put it on the phone, the PIN
 *  given separately (never in the message, so a forwarded message can't be used). */
const serveInvite = (name, link) => `Hi ${name}, join *${me.business.name}* as a server on Bookr POS, to mark food served.

1. Open this link on your phone: ${link}
2. Put it on your phone:
• Android: open the link in Chrome, then tap *Install* (or ⋮ › Add to Home screen)
• iPhone: open the link in Safari, tap Share ⬆︎ › *Add to Home Screen*
3. From then on, open *Serve* from its icon and sign in with the 6-digit PIN the manager gives you.`;
actions.svCopyMsg = async (d) => {
  const s = ui.servers.find((x) => x.id === d.id);
  const msg = serveInvite(s.name, `${location.origin}/#/serve/${me.business.id}`);
  try { await navigator.clipboard.writeText(msg); flash = { kind: 'ok', text: `Message for ${s.name} copied. Paste it in WhatsApp or SMS; tell them the PIN separately.` }; }
  catch { flash = { kind: 'warn', text: msg }; }
  rerender();
};
actions.svCopyLink = async (d) => { await navigator.clipboard?.writeText(d.l).catch(() => {}); flash = { kind: 'ok', text: 'Serve address copied.' }; rerender(); };
actions.svNewPin = (d) => { ui.svEdit = d.id; ui.svPin = ''; rerender(); };
actions.svEditNo = () => { ui.svEdit = null; ui.svPin = ''; rerender(); };
actions.svSave = async () => {
  if (ui.svEdit) { const s = ui.servers.find((x) => x.id === ui.svEdit); await api('PUT', `${B()}/servers/${s.id}`, { pin: ui.svPin ?? '', active: true }); flash = { kind: 'ok', text: `New PIN saved for ${s.name}. Their old sign-in has ended.` }; }
  else { await api('POST', `${B()}/servers`, { name: ui.svName ?? '', pin: ui.svPin ?? '' }); flash = { kind: 'ok', text: `${ui.svName} added. Press Send on WhatsApp next to their name, and tell them the PIN yourself.` }; }
  route();
};
actions.svRemove = async (d) => {
  const s = ui.servers.find((x) => x.id === d.id);
  if (!confirm(`Remove ${s.name}? Their PIN stops at once, even on a phone that is open now.`)) return;
  await api('PUT', `${B()}/servers/${s.id}`, { active: false }); flash = { kind: 'ok', text: `${s.name} removed.` }; route();
};

// ----- Settings › Categories and the item form: the serve time
actions.catServe = async (d, el) => {
  const v = el.value.trim();
  await api('PUT', `${B()}/menu-categories/${d.id}`, { serveMins: v === '' ? null : v });
  const c = cache.menuCats.find((x) => x.id === d.id); c.serveMins = v === '' ? null : Number(v);
  flash = { kind: 'ok', text: `${c.name}: ${v === '' ? 'not timed' : `serve in ${v} min`}.` }; rerender();
};
/** An item's serve time for the menu list: its own, its category's, or not timed. */
function serveText(m) {
  const cat = catOf(m)?.serveMins ?? null;
  if (m.serveMins === 0) return 'Not timed · own';
  if (m.serveMins != null) return `Serve ${m.serveMins} min · own`;
  return cat ? `Serve ${cat} min · category` : 'Not timed';
}
const itemServeField = () => {
  const cat = (cache.menuCats ?? []).find((c) => c.name.toLowerCase() === String(ui.iCat ?? '').toLowerCase())?.serveMins ?? null;
  return html`<label class="f">Serve in (minutes)<input class="in" inputmode="numeric" data-model="iServe" value="${ui.iServe ?? ''}" placeholder="${cat ? `${cat}: its category` : 'Not timed'}" aria-describedby="isv-n">
    <span class="small quiet" id="isv-n" style="font-weight:400">Empty: as its category (${cat ? `${cat} min` : 'not timed'}). 0: never timed.</span></label>`;
};

// ----- Daily check and Reports
function servingCard(sv, day) {
  if (!sv) return '';
  const photo = (w) => (w.batch && can('serve.manage') ? html` · <a href="/api${B()}/serving/photo/${w.batch}" target="_blank" rel="noopener">photo</a>` : '');
  return html`<section class="panel" style="margin-top:16px"><div class="row between"><h2 style="margin:0">Serving time</h2><a class="small" href="#/reports/serving/${day}_${day}">Report</a></div>
    <div class="dc-tiles">
      <div class="dc-tile none"><span class="k">Items timed</span><span class="v">${sv.timed}</span><span class="n">${sv.marked ? `${Math.round((sv.onTime / sv.marked) * 100)}% of served on time` : 'none served yet'}</span></div>
      <div class="dc-tile ${sv.late ? 'bad' : 'none'}"><span class="k">Late</span><span class="v">${sv.late}</span><span class="n">${sv.late ? `average ${sv.avgLateMins} min late` : 'none'}</span></div>
      <div class="dc-tile ${sv.notMarked ? 'warn' : 'none'}"><span class="k">Not marked served</span><span class="v">${sv.notMarked}</span><span class="n">bill closed, never marked</span></div>
      ${sv.waiting ? html`<div class="dc-tile none"><span class="k">Still waiting</span><span class="v">${sv.waiting}</span><span class="n">orders still open</span></div>` : ''}
      <div class="dc-tile ${sv.undoneByManager ? 'warn' : 'none'}"><span class="k">Undone by manager</span><span class="v">${sv.undoneByManager}</span><span class="n">${sv.undoneByManager ? 'see below' : 'none'}</span></div>
      <div class="dc-tile ${sv.undoneByServer ? 'warn' : 'none'}"><span class="k">Undone by server (2 min)</span><span class="v">${sv.undoneByServer}</span><span class="n">${sv.serverUndos.map((x) => `${x.name} ${x.n}`).join(' · ') || 'none'}</span></div>
      <div class="dc-tile ${sv.undoneNotServed.length ? 'bad' : 'none'}"><span class="k">Undone, not served again</span><span class="v">${sv.undoneNotServed.length}</span><span class="n">${sv.undoneNotServed.length ? 'check' : 'none'}</span></div>
      <div class="dc-tile ${sv.managerMarks ? 'warn' : 'none'}"><span class="k">Served by manager, no photo</span><span class="v">${sv.managerMarks}</span><span class="n">${sv.managerMarks ? 'see below' : 'none'}</span></div>
      <div class="dc-tile ${sv.wrongPins ? 'warn' : 'none'}"><span class="k">Wrong server PINs</span><span class="v">${sv.wrongPins}</span><span class="n">${sv.wrongPins ? 'someone may be guessing' : 'none'}</span></div></div>
    ${sv.worst.length ? html`<h3 style="margin:0">Most late</h3><ul class="dc-list">${sv.worst.map((w) => html`<li><span>${w.place} · ${w.qty} × ${w.name}</span><strong>${w.lateMins} min late · ${time(w.servedAt)} · ${w.by ?? ''}${photo(w)}</strong></li>`)}</ul>` : ''}
    ${sv.log.length ? html`<h3 style="margin:0">Undos and manager taps</h3><div class="scroll"><table class="t"><thead><tr><th>Time</th><th>Table · item</th><th>What</th><th>Who</th><th>Reason</th></tr></thead><tbody>
      ${sv.log.map((e) => html`<tr><td>${time(e.at)}</td><td>${e.ref}</td><td>${e.kind === 'serve_manager' ? 'Served by manager, no photo' : e.server ? 'Undone by server within 2 min' : 'Undone by manager'}</td><td>${e.by ?? ''}</td><td>${e.reason ?? ''}</td></tr>`)}
      ${sv.undoneNotServed.map((x) => html`<tr><td>${time(x.at)}</td><td>${x.place} · ${x.qty} × ${x.name}</td><td><span class="badge bad">Undone, not served again</span></td><td>${x.by ?? ''}</td><td>${x.reason ?? ''}</td></tr>`)}</tbody></table></div>` : ''}
    <p class="small quiet" style="margin:0">Late is worked out from the first time an item was marked served, so an undo never makes a late item look on time. Times can't be typed or changed.</p></section>`;
}
async function servingTab(head, from, to) {
  const r = await api('GET', `${B()}/reports/serving?from=${from}&to=${to}`);
  const pctLate = (x) => (x.marked ? `${Math.round((x.late / x.marked) * 100)}%` : '');
  const table = (title, rows, label, extra = false) => html`<section class="panel"><h2>${title}</h2>${rows.length ? html`<div class="scroll"><table class="t"><thead><tr><th>${label}</th><th class="num">Timed</th><th class="num">Late</th><th class="num">Share late</th><th class="num">Not marked</th><th class="num">Avg time (min)</th>${extra ? html`<th class="num">Set (min)</th>` : ''}</tr></thead><tbody>
    ${rows.map((x) => html`<tr><td>${x.label ?? x.key}</td><td class="num">${x.timed}</td><td class="num">${x.late}</td><td class="num">${pctLate(x)}</td><td class="num">${x.notMarked || ''}</td><td class="num">${x.avgMins ?? ''}</td>${extra ? html`<td class="num">${x.setMins}</td>` : ''}</tr>`)}</tbody></table></div>` : html`<p class="quiet">Nothing timed.</p>`}</section>`;
  rerender = () => paint(shell('#/reports', html`${head}
    <div class="kpis">${kpi('Items timed', String(r.timed), r.marked ? `${Math.round((r.onTime / r.marked) * 100)}% of served on time` : '')}${kpi('Late', String(r.late), r.late ? `average ${r.avgLateMins} min late` : '', r.late ? 'bad' : '')}
      ${kpi('Not marked served', String(r.notMarked), 'bill closed, never marked: not counted as late or on time', r.notMarked ? 'warn' : '')}${r.waiting ? kpi('Still waiting', String(r.waiting), 'orders still open') : ''}</div>
    <p class="small quiet" style="margin:-4px 0 12px">Time is from the KOT to when the item was first marked served. "Set" is the serve time the KOT was sent with. An item often late may have its time set too low.</p>
    <div class="stack">${table('By item', r.byItem, 'Item', true)}${table('By hour the KOT was sent', r.byHour.map((x) => ({ ...x, label: `${x.key}:00` })), 'Hour')}
      ${table('By day', r.byDay.map((x) => ({ ...x, label: dayName(x.key) })), 'Shift')}${table('By server', r.byServer, 'Server')}</div>`));
  rerender();
}

route();


// ---------- offline mode (27 Nov 2026): the counter keeps working with no internet and sends it all up later

offline.useHooks({ previewTotals, dishTax, dishFlags });
const OFFLINE_PATHS = ['', 'order', 'bill', 'settle', 'done', 'rooms', 'counter', 'offline', 'signin'];
let offlineAsked = false;
let lastKeep = 0;
/** Starts offline mode for this person, and (online, a device turned on) saves what the counter needs, every 10 minutes. */
function offlineReady() {
  offline.start(me);
  if (!offline.isOnline()) return;
  if (!offlineAsked) {
    offlineAsked = true;
    api('GET', `${B()}/offline/device`).then((d) => { offline.setDevice(d); keepForOffline(); offline.sync(); }).catch(() => { offlineAsked = false; });
  } else keepForOffline();
}
function keepForOffline() {
  if (!offline.letter() || !offline.isOnline() || Date.now() - lastKeep < 10 * 60_000) return;
  lastKeep = Date.now();
  for (const p of ['/menu', '/reasons', '/entities', '/pay-accounts', '/credit-accounts', '/orders']) api('GET', B() + p).catch(() => {});
  // Each guest staying, with their room bill, so a payment can be taken offline.
  api('GET', B() + '/stays').then((r) => { for (const st of r.stays ?? []) api('GET', `${B()}/stays/${st.id}/bill`).catch(() => {}); }).catch(() => {});
}
const offSince = () => (offline.offlineSince() ? time(offline.offlineSince()) : 'a moment ago');
const shown = (list) => list.filter((x) => !x.quiet);
function netChip() {
  if (!offline.ready()) return '';
  const n = shown(offline.waiting()).length;
  if (!offline.isOnline()) return html`<a id="netchip" class="netpill off" href="#/offline" title="No internet. Tap to see what is not sent yet."><span class="dot"></span>OFFLINE${n ? ` · ${n} not sent` : ''}</a>`;
  if (offline.isSyncing()) return html`<a id="netchip" class="netpill sync" href="#/offline"><span class="dot"></span>SENDING · ${n} left</a>`;
  if (offline.problems().length) return html`<a id="netchip" class="netpill look" href="#/offline"><span class="dot"></span>${plural(shown(offline.problems()).length || 1, 'needs a look', 'need a look')}</a>`;
  return html`<span id="netchip" hidden></span>`;
}
function netBand(active) {
  if (!offline.ready()) return html`<div id="netband" hidden></div>`;
  const n = shown(offline.waiting()).length;
  const rooms = active === '#/rooms' ? offline.roomSteps() : [];
  const roomLine = rooms.length ? html`<div>Not sent yet: ${rooms.map((x) => `Room ${x.room.room} ${x.room.amountPaise > 0 ? 'food' : 'payment'} ${rs(Math.abs(x.room.amountPaise))}`).join(' · ')}.</div>` : '';
  if (!offline.isOnline()) {
    return html`<div id="netband" class="netband off" role="status"><div><b>No internet since ${offSince()}.</b> ${offline.letter()
      ? (active === '#/rooms' ? 'Rooms shows who is staying as saved when the internet went off. Food can still go to a room, and payments from guests staying can be taken. Check-ins, check-outs and refunds wait.'
        : 'Keep taking orders: KOTs and bills print on this PC and go up when the internet is back.')
      : 'This device is not turned on for offline, so it can only show what it saved. The owner turns it on in Settings, Counter devices.'}
      ${n ? html` <a href="#/offline">See the ${n} not sent</a>` : ''}</div>${roomLine}</div>`;
  }
  if (offline.isSyncing()) return html`<div id="netband" class="netband sync" role="status"><b>Internet is back.</b> Sending what was done offline: ${n} left. You can keep working.</div>`;
  if (offline.problems().length) return html`<div id="netband" class="netband look" role="alert"><b>${plural(shown(offline.problems()).length || 1, 'step', 'steps')} made offline could not be sent.</b> A manager checks them. <a href="#/offline">See what and why</a>${active === '#/shift' ? html`<div>Close the day only after this PC shows everything sent.</div>` : ''}</div>`;
  return html`<div id="netband" hidden></div>`;
}
let hadWork = false;
offline.onChange(() => {
  const chip = document.getElementById('netchip');
  const band = document.getElementById('netband');
  const active = (location.hash.match(/^#\/[a-z]*/) ?? ['#/'])[0];
  if (chip) chip.outerHTML = asHtml(netChip());
  if (band) band.outerHTML = asHtml(netBand(active === '#/' ? '#/' : active));
  const n = offline.waiting().length;
  if (n) hadWork = true;
  // Everything sent: back to the server's own copies.
  if (hadWork && !n && offline.isOnline() && !offline.isSyncing()) {
    hadWork = false;
    flash = { kind: 'ok', text: 'Internet is back. Everything done offline is sent.' };
    if (/^#\/(order|bill|settle|done)\//.test(location.hash) || location.hash === '#/offline') go('#/'); else if (OFFLINE_PATHS.includes(location.hash.replace(/^#\/?/, '').split('/')[0])) route();
  }
  else if (location.hash === '#/offline' && typeof rerender === 'function') rerender();
});
function offlineOnly() {
  paint(shell(location.hash.match(/^#\/[a-z]*/)?.[0] ?? '#/', html`<section class="panel" style="max-width:640px"><h2>This needs the internet</h2>
    <p class="quiet">With no internet the counter keeps working for tables, takeaway, KOTs, bills, payments, and rooms (see who is staying, food to a room, payments). This page opens again when the internet is back.</p>
    <p style="margin-top:12px"><a class="btn pri" href="#/">Back to tables</a></p></section>`));
}
const STEP_STATE = { wait: ['wait', 'Waiting'], sent: ['ok', 'Sent'], look: ['look', 'Needs a look'], blocked: ['look', 'Waiting for the one above'] };
function offlineScreen() {
  rerender = () => {
    const steps = shown(offline.allSteps()).slice().reverse();
    const waiting = steps.filter((x) => x.status !== 'sent');
    const sent = steps.filter((x) => x.status === 'sent');
    const row = (x) => html`<tr><td>${time(x.at)}</td><td>${x.what}${x.note ? html`<div class="small quiet">${x.note}</div>` : ''}${x.error ? html`<div class="small" style="color:var(--warn)">${x.error}</div>` : ''}</td>
      <td>${x.place ?? ''}</td><td class="num">${x.amountPaise ? rs(Math.abs(x.amountPaise)) : ''}</td><td>${x.staff ?? ''}</td>
      <td><span class="stp ${STEP_STATE[x.status][0]}">${offline.isSyncing() && x.status === 'wait' ? 'Sending' : STEP_STATE[x.status][1]}</span></td></tr>`;
    const table = (list) => html`<div class="scroll"><table class="t"><thead><tr><th>Time</th><th>What</th><th>Where</th><th class="num">Amount</th><th>By</th><th>Status</th></tr></thead><tbody>${list.map(row)}</tbody></table></div>`;
    paint(shell('#/offline', html`${pageHead(waiting.length ? 'Not sent yet · this PC' : 'Everything is sent', offline.isOnline()
      ? (waiting.length ? 'These go up by themselves. Bills keep the numbers they printed with.' : 'Nothing made on this PC is waiting.')
      : 'Kept safely on this PC. Keep it on, and do not clear the browser or remove the app: these go up by themselves when the internet is back.',
      offline.isOnline() && waiting.length && !offline.isSyncing() ? html`<button class="btn pri" type="button" data-act="offSend">${offline.problems().length ? 'Try again' : 'Send now'}</button>` : '')}
      ${errorBox()}
      ${offline.problems().length ? html`<div class="msg warn" style="display:block;margin-bottom:12px"><b>Needs a look:</b> the server did not take these, for the reason shown. Fix what it says (for example, hand over the cash drawer), then press Try again. Nothing is lost: they stay here until they are sent.</div>` : ''}
      ${waiting.length ? html`<section class="panel">${table(waiting)}</section>` : html`<p class="empty">Nothing waiting.</p>`}
      ${sent.length ? html`<section class="panel" style="margin-top:16px"><h2>Sent in the last day</h2>${table(sent)}</section>` : ''}`));
  };
  rerender();
}
actions.offSend = async () => { await offline.retry(); rerender(); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* the counter works online without it */ });
