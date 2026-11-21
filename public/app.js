// Bookr front end. Talks only to /api on the same origin; the server decides every permission.
// The role-based hiding here is for tidiness only.

const app = document.getElementById('app');
const ROLE_LABELS = { owner: 'Owner', accountant: 'Accountant', entry_staff: 'Entry staff', viewer: 'Viewer' };
const ROLE_ORDER = ['entry_staff', 'accountant', 'viewer', 'owner']; // invite form order, as designed

let me = null; // { user, businesses, canCreateBusiness }

// ---------- helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Tagged template that escapes every interpolation unless it is already marked safe.
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += (Array.isArray(v) ? v.map(asHtml).join('') : asHtml(v)) + strings[i + 1];
  });
  return { __html: out };
}
const asHtml = (v) => (v && typeof v === 'object' && '__html' in v ? v.__html : esc(v));

/**
 * Runs fn over a list a few at a time (the requests go together, not one after another). Every item is tried; the first
 * error is thrown once all have finished.
 */
async function eachAtOnce(list, fn, n = 6) {
  const errors = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const x = list[i++]; try { await fn(x); } catch (e) { errors.push(e); } }
  }));
  if (errors.length) throw errors[0];
}

// What rarely changes (the business, its heads and accounts) is kept for two minutes, so moving between pages does not
// ask again. A change to any of them, or a sign-in, clears it. The server still checks the role on every request.
const GET_CACHE = new Map();
const CACHEABLE = /^\/businesses\/[0-9a-f-]{36}(\/heads|\/accounts)?$/;
const CACHE_MS = 120000;
const clearsCache = (path) => /\/(heads|accounts|bill-type-heads|learned-items|rules|members|cash\/shortage|shortage)(\/|$|\?)|^\/businesses\/[0-9a-f-]{36}$|^\/businesses$|^\/auth\//.test(path);
function cacheAfter(method, path, data) {
  if (method === 'GET') { if (CACHEABLE.test(path)) GET_CACHE.set(path, { at: Date.now(), data }); }
  else { CAL_CACHE.clear(); if (clearsCache(path)) GET_CACHE.clear(); }
}

const BIZ_KEEP = new Map();
async function bizDetail(id) {
  const path = `/businesses/${id}`;
  const kept = BIZ_KEEP.get(id);
  if (kept && GET_CACHE.has(path)) {
    if (Date.now() - GET_CACHE.get(path).at >= CACHE_MS) api('GET', path).then((d) => BIZ_KEEP.set(id, d)).catch(() => {});
    return structuredClone(kept);
  }
  const d = await api('GET', path);
  BIZ_KEEP.set(id, d);
  return d;
}

// A change always goes as JSON (the server refuses anything else, see app.ts), so one with no body sends {}.
const bodyFor = (method, body) => (body === undefined && method !== 'GET' ? {} : body);
async function api(method, path, body) {
  body = bodyFor(method, body);
  const hit = method === 'GET' ? GET_CACHE.get(path) : null;
  if (hit && Date.now() - hit.at < CACHE_MS) return structuredClone(hit.data);
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && path !== '/me' && !path.startsWith('/auth/') && !path.startsWith('/invites/')) {
    me = null;
    GET_CACHE.clear();
    go('#/login');
    throw new Error('Please sign in.');
  }
  if (!res.ok && data?.code === 'amount_unread' && method === 'PUT' && body && !(body.confirm ?? []).includes('amount')) {
    // An amount the reader could not read (13 Nov 2026): ticking it at ₹0 needs a person to say it really is ₹0.
    if (window.confirm(`${data.error}\n\nOK = the bill really is ₹0 (complimentary). Cancel = type the amount first.`)) return api(method, path, { ...body, confirm: [...(body.confirm ?? []), 'amount'] });
  }
  if (!res.ok) throw new Error(data?.error ?? 'Something went wrong.');
  cacheAfter(method, path, data);
  return data;
}

/**
 * Several GETs in one trip (19 Nov 2026): the server answers them together and asks the database a shared question once.
 * Returns one promise per path, each resolving or failing like api('GET', path) would.
 */
function apiMany(paths) {
  const fresh = paths.map((p) => { const hit = GET_CACHE.get(p); return hit && Date.now() - hit.at < CACHE_MS ? null : p; });
  const ask = fresh.filter(Boolean);
  const trip = ask.length ? fetch(`/api/many?${ask.map((p) => `p=${encodeURIComponent(p)}`).join('&')}`, { credentials: 'same-origin' })
    .then(async (res) => {
      const data = await res.json().catch(() => null);
      if (res.status === 401) { me = null; GET_CACHE.clear(); go('#/login'); throw new Error('Please sign in.'); }
      if (!res.ok) throw new Error(data?.error ?? 'Something went wrong.');
      return data.results;
    }) : Promise.resolve([]);
  trip.catch(() => {});
  return paths.map((p, i) => {
    if (!fresh[i]) return api('GET', p);
    return trip.then((results) => {
      const x = results[ask.indexOf(p)];
      if (x.status === 401) { me = null; GET_CACHE.clear(); go('#/login'); throw new Error('Please sign in.'); }
      if (x.status >= 400) throw new Error(x.body?.error ?? 'Something went wrong.');
      cacheAfter('GET', p, x.body);
      return x.body;
    });
  });
}

// Amounts arrive as integer paise and are only turned into rupees here, for display.
// Integer arithmetic only: rupees and paise are split, never divided into a float.
const inrWhole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
function rupeeParts(p) {
  const neg = p < 0;
  const abs = Math.abs(p);
  return { neg, rupees: Math.trunc(abs / 100), paise: String(abs % 100).padStart(2, '0') };
}
const money = (p) => { const r = rupeeParts(p); return `${r.neg ? '−' : ''}${inrWhole.format(r.rupees)}.${r.paise}`; };
/** Rupee text → paise without floats, or null. Same rule as the server. */
function parsePaiseText(text) {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(text).replace(/,/g, '').trim());
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -v : v;
}
const rupeesForInput = (p) => { const r = rupeeParts(p); return `${r.neg ? '-' : ''}${r.rupees}.${r.paise}`; };
/** Whole rupees without ".00" (paise shown only when there are any): for the register review. */
const rs = (p) => { const r = rupeeParts(p); return r.paise === '00' ? `${r.neg ? '−' : ''}${inrWhole.format(r.rupees)}` : money(p); };
const rsIn = (p) => { const r = rupeeParts(p); return r.paise === '00' ? `${r.neg ? '-' : ''}${r.rupees}` : rupeesForInput(p); };
// A school (it keeps cash books) opens on them: the books page, or a cashier's own book (see routeInner).
const home = (b) => (b.cashBooks ? `#/b/${b.id}` : `#/b/${b.id}/${b.actions.includes('reports.view') ? 'dashboard' : b.actions.includes('rows.upload') ? 'bringin' : 'accounts'}`);
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };

function relative(ts) {
  if (!ts) return 'Not signed in yet';
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Wires a form: disables the button while saving and shows the server's message on failure.
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const msg = form.querySelector('.form-msg');
    if (msg) { msg.textContent = ''; msg.className = 'form-msg'; }
    btn && (btn.disabled = true);
    try {
      await handler(formData(form));
    } catch (err) {
      if (msg) { msg.textContent = err.message; msg.className = 'form-msg error'; }
    } finally {
      btn && (btn.disabled = false);
    }
  });
}

function render(view) {
  app.innerHTML = view.__html;
  navShown();
}

// Loading feedback (approved 19 Nov 2026). A press on the menu, a link, or ‹ › shows at once: the menu marks the new
// item, the old page fades and cannot be pressed, the new page's heading (Shift: its day, with a spinner) shows, and a
// thin bar runs along the top while the page loads. Quick pages show none of it (the fade waits 0.1 s, the bar 0.2 s).
let navSeq = 0;
let navEnd = null;
const topBar = document.createElement('div');
topBar.id = 'topbar';
topBar.setAttribute('aria-hidden', 'true');
document.body.appendChild(topBar);
const SHIFT_PAGE = ['bringin', 'review', 'compare', 'reconcile', 'upi'];
function navStart(parts) {
  const seq = ++navSeq;
  const main = app.querySelector('.main');
  const [screen, query = ''] = (parts[2] || 'dashboard').split('?');
  const item = parts[0] === 'b' ? NAV.find((n) => n.key === screen || n.screens?.includes(screen)) : null;
  if (main && item) app.querySelectorAll('.side a.nav').forEach((a) => a.classList.toggle('on', a.dataset.navkey === item.key));
  const undo = [];
  const fade = setTimeout(() => {
    if (seq !== navSeq || !main?.isConnected) return;
    main.classList.add('is-loading');
    const spin = '<span class="nav-spin" aria-hidden="true"></span>';
    const tail = (parts[3] ?? '').split('?')[0];
    const day = isDay(tail) ? tail : isDay(new URLSearchParams(query).get('day')) ? new URLSearchParams(query).get('day') : parts[1] ? lastDay(parts[1]) : null;
    const bar = main.querySelector(':scope > .shiftbar');
    if (SHIFT_PAGE.includes(screen) && day) {
      const pick = bar?.querySelector('.sb-pick');
      if (pick) {
        const before = pick.innerHTML;
        pick.innerHTML = `${esc(dayLabel(day))} shift ${spin}`;
        bar.classList.add('nav-keep');
        undo.push(() => { pick.innerHTML = before; bar.classList.remove('nav-keep'); });
      } else {
        const tmp = document.createElement('div');
        tmp.className = 'nav-pending nav-keep';
        tmp.innerHTML = `<span class="btn plain">${esc(dayLabel(day))} shift ${spin}</span>`;
        main.querySelector(':scope > .head')?.after(tmp);
        undo.push(() => tmp.remove());
      }
    } else if (item) {
      const h1 = main.querySelector(':scope > .head h1');
      if (h1) { const before = h1.innerHTML; h1.innerHTML = `${esc(item.label)} ${spin}`; undo.push(() => { h1.innerHTML = before; }); }
    }
    undo.push(() => main.classList.remove('is-loading'));
  }, 100);
  const run = setTimeout(() => { if (seq === navSeq) { topBar.className = ''; void topBar.offsetWidth; topBar.className = 'run'; } }, 200);
  navEnd = () => {
    clearTimeout(fade); clearTimeout(run);
    navEnd = null;
    if (topBar.className === 'run') { topBar.className = 'done'; setTimeout(() => { if (topBar.className === 'done') topBar.className = ''; }, 600); }
    // Nothing new was drawn (an error, or the page stayed): the old page comes back as it was.
    if (main?.isConnected) undo.reverse().forEach((f) => f());
  };
  return seq;
}
/** The new page is drawn (or the load ended): the bar fills and fades. */
function navShown() { if (navEnd) navEnd(); }

// ---------- shell: sidebar + header with business switcher

// The menu in three groups (approved 14 Nov 2026): daily work, books, and settings folded at the foot.
// A count beside an item says what is waiting there (from the Today figures).
const NAV = [
  { key: 'dashboard', label: 'Today', needs: 'reports.view', badge: 'today' },
  // Cash books (approved 20 Nov 2026): shown once the business has a branch (a school); a cashier sees their own book.
  { key: 'cashbooks', label: 'Cash books', group: 'Daily work', screens: ['cashbooks', 'cashbook'], when: (b) => b.cashBooks && (b.role !== 'entry_staff' || b.myBooks > 0) },
  { key: 'fees', label: 'Fee check', needs: 'sales.view', group: 'Daily work', when: (b) => b.cashBooks && b.role !== 'entry_staff' },
  // Bring in, Register and Reconcile are the three steps of one shift (the shift bar at the top of each).
  { key: 'shifts', label: 'Shift', group: 'Daily work', screens: ['bringin', 'review', 'compare', 'compare-old', 'reconcile'], badge: 'shifts', when: (b) => !b.cashBooks },
  // Bank (approved 10 Nov 2026): statements, money in and out, all payments, card settlements, done, as tabs of one page.
  { key: 'bank', label: 'Bank', needs: 'bank.link', screens: ['bank', 'cards', 'money-out'], badge: 'bank' },
  { key: 'reports', label: 'Reports', needs: 'reports.view', group: 'Books', screens: ['reports', 'funds', 'pending', 'statement', 'bills'] },
  { key: 'parties', label: 'Parties', needs: 'heads.view', group: 'Books' },
  { key: 'accounts', label: 'Accounts', group: 'Settings' },
  { key: 'heads', label: 'Heads and rules', group: 'Settings' },
  { key: 'users', label: 'Users and roles', owner: true, group: 'Settings' },
  // Schools and cashiers (21 Nov 2026): set up of a school business, also how a new business becomes one.
  { key: 'schools', label: 'Schools and cashiers', needs: 'accounts.edit', group: 'Settings' },
];
// The menu counts: the Today figures, kept a minute so moving between pages does not ask again.
let navCounts = { bizId: null, at: 0, n: null };
async function fillNavCounts(biz) {
  // A school's Today has its own list; the hotel's counts are not shown beside it.
  if (!biz.actions.includes('reports.view') || biz.cashBooks) return;
  const show = () => {
    if (navCounts.bizId !== biz.id) return;
    for (const [k, v] of Object.entries(navCounts.n ?? {})) {
      const el = document.querySelector(`[data-navn="${k}"]`);
      if (el) { el.textContent = v ? String(v) : ''; el.hidden = !v; }
    }
  };
  // The counts last known show at once; older than five minutes (19 Nov 2026; was one), asked for again in the background.
  show();
  if (navCounts.bizId !== biz.id || Date.now() - navCounts.at > 300000) {
    try { navCounts = { bizId: biz.id, at: Date.now(), n: todayCounts(await api('GET', `/businesses/${biz.id}/home`), biz) }; } catch { return; }
    show();
  }
}
/** What each menu count shows, from the Today figures. */
function todayCounts(h, biz) {
  const bank = (h.bookExpenses?.count ?? 0) + (h.upi?.credits.count ?? 0) + (h.cards?.days ?? 0);
  return { shifts: h.shifts?.count ?? 0, bank, today: todayItems(h, biz).length };
}

// The shift being worked on (7 Nov 2026): Review, Compare sales and Reconcile open on the day last worked on anywhere,
// on this device. Their menu links carry it; the day changes when a page of another day is opened.
const dayKey = (bizId) => `bookr.day.${bizId}`;
const lastDay = (bizId) => { try { const d = localStorage.getItem(dayKey(bizId)); return isDay(d) ? d : null; } catch { return null; } };
const rememberDay = (bizId, day) => { if (!isDay(day)) return; try { localStorage.setItem(dayKey(bizId), day); } catch { /* storage unavailable */ } };
const sheetKey = (bizId) => `bookr.sheet.${bizId}`;
const lastSheet = (bizId) => { try { return JSON.parse(localStorage.getItem(sheetKey(bizId)) ?? 'null'); } catch { return null; } };
const rememberSheet = (bizId, u) => { try { localStorage.setItem(sheetKey(bizId), JSON.stringify({ id: u.id, day: u.day })); } catch { /* storage unavailable */ } };
const screenKey = (bizId) => `bookr.screen.${bizId}`;
// Compare sales is Reconcile's All bills tab now (approved 10 Nov 2026): the shift has two steps.
// Bring in is the first step of a shift (approved 14 Nov 2026).
const SHIFT_SCREENS = [['bringin', 'Bring in', 'rows.upload'], ['review', 'Register', 'rows.edit'], ['reconcile', 'Reconcile', 'sales.view']];
/** Where a shift screen opens for a day. Review: the sheet last opened, if it is of that day; else the day's first page. */
function screenHref(biz, key, day) {
  if (!day) return `#/b/${biz.id}/${key}`;
  if (key === 'bringin') return `#/b/${biz.id}/bringin/${day}`;
  if (key !== 'review') return `#/b/${biz.id}/${key}/${day}`;
  const sh = lastSheet(biz.id);
  return sh?.day === day ? `#/b/${biz.id}/review/${sh.id}` : `#/b/${biz.id}/review?day=${day}`;
}
function navHref(biz, key) {
  if (key === 'shifts') {
    let last = null;
    try { last = localStorage.getItem(screenKey(biz.id)); } catch { /* storage unavailable */ }
    const allowed = SHIFT_SCREENS.filter(([, , need]) => biz.actions.includes(need)).map(([k]) => k);
    const k = allowed.includes(last) ? last : allowed.includes('reconcile') ? 'reconcile' : allowed[0] ?? 'reconcile';
    // Review with no day yet: the sheet last opened, else the list.
    if (k === 'review' && !lastDay(biz.id)) { const sh = lastSheet(biz.id); return sh ? `#/b/${biz.id}/review/${sh.id}` : `#/b/${biz.id}/review`; }
    return screenHref(biz, k, lastDay(biz.id));
  }
  return `#/b/${biz.id}/${key}`;
}

/**
 * The shift bar (7 Nov 2026): one day for Register, Compare sales and Reconcile, and a tab for each with what is left.
 * The days and the counts load after the page shows.
 */
function shiftBar(biz, day, screen) {
  try { localStorage.setItem(screenKey(biz.id), screen); } catch { /* storage unavailable */ }
  const tabs = SHIFT_SCREENS.filter(([, , need]) => biz.actions.includes(need));
  return html`<nav class="shiftbar" aria-label="Shift" data-day="${day}" data-screen="${screen}">
    <div class="sb-day"><a class="btn plain" data-sbstep="-1" href="#" aria-label="Previous shift">‹</a>
      <span class="sb-cal"><button class="btn plain sb-pick" type="button" data-sbpick aria-haspopup="dialog" aria-expanded="false">${dayLabel(day)} shift <span aria-hidden="true">▾</span></button></span>
      <a class="btn plain" data-sbstep="1" href="#" aria-label="Next shift">›</a></div>
    <div class="sb-tabs" role="tablist">${tabs.map(([k, label], i) => html`<a role="tab" class="${k === screen ? 'on' : ''}" aria-selected="${k === screen}" href="${screenHref(biz, k, day)}">
      <span class="sb-i">${i + 1}</span>${label}<span class="sb-n" data-sbn="${k}"></span></a>`)}</div>
  </nav>`;
}
async function wireShiftBar(biz) {
  const bar = document.querySelector('.shiftbar');
  if (!bar) return;
  const day = bar.dataset.day;
  const screen = bar.dataset.screen;
  const to = (d) => go(screenHref(biz, screen, d));
  const [cal, p] = await Promise.all([shiftCalendar(biz, day.slice(0, 7)), api('GET', `/businesses/${biz.id}/shifts/${day}/progress`).catch(() => null)]);
  if (!bar.isConnected) return;
  // ‹ and › go one day at a time, from the books start up to the shift running now (15 Nov 2026).
  const first = cal?.booksStart ?? '0000-00-00';
  const last = cal?.today ?? currentShiftDay();
  bar.querySelectorAll('[data-sbstep]').forEach((a) => {
    const d = addDaysIso(day, Number(a.dataset.sbstep));
    if (d < first || d > last) { a.classList.add('off'); a.removeAttribute('href'); return; }
    a.title = dayLabel(d);
    a.addEventListener('click', (e) => { e.preventDefault(); to(d); });
  });
  wireShiftCalendar(biz, bar.querySelector('.sb-cal'), day, cal, to);
  if (!p) return;
  const set = (k, text, cls) => { const el = bar.querySelector(`[data-sbn="${k}"]`); if (el) { el.textContent = text; el.className = `sb-n ${cls}`; } };
  set('bringin', !p.software && !p.rows ? 'to bring in' : !p.software ? 'no sales report' : !p.rows ? 'no register' : '✓', p.software && p.rows ? 'ok' : 'wait');
  set('review', !p.rows ? 'no page' : p.toCheck ? `${p.toCheck} to check` : '✓', p.rows && !p.toCheck ? 'ok' : p.toCheck ? 'wait' : '');
  const left = p.bank ? p.bank.billsLeft + p.bank.creditsLeft + (p.bank.cardsLeft ?? 0) : 0;
  set('reconcile', p.status !== 'confirmed' ? (p.toDecide ? `${p.toDecide} to decide · not saved` : 'not saved') : left ? `${left} left` : '✓',
    p.status !== 'confirmed' ? (p.toDecide ? 'wait' : '') : left ? 'wait' : 'ok');
}

/**
 * The shift calendar (approved 15 Nov 2026): the shift name opens a month; each day shows a tick (saved), an amber dot
 * (in progress) or a hollow dot (not started), and a small number when something is still open on it. Days before the
 * books start and after today cannot be opened. "Oldest to do" opens the oldest shift not saved.
 */
const CAL_CACHE = new Map();
async function shiftCalendar(biz, month) {
  const k = `${biz.id}|${month}`;
  const hit = CAL_CACHE.get(k);
  if (hit && Date.now() - hit.at < 30e3) return hit.data;
  const data = await api('GET', `/businesses/${biz.id}/shifts/calendar?month=${month}`).catch(() => null);
  if (data) CAL_CACHE.set(k, { at: Date.now(), data });
  return data;
}
function wireShiftCalendar(biz, box, day, cal, to) {
  if (!box) return;
  const btn = box.querySelector('[data-sbpick]');
  let pop = null;
  const close = () => { pop?.remove(); pop = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const draw = async (month, data) => {
    if (!pop) return;
    if (!data) data = await shiftCalendar(biz, month);
    if (!pop) return;
    if (!data) { pop.innerHTML = '<div class="tiny error">Could not load the calendar.</div>'; return; }
    const [y, m] = month.split('-').map(Number);
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    const prevM = addDaysIso(`${month}-01`, -1).slice(0, 7);
    const nextM = addDaysIso(`${month}-28`, 7).slice(0, 7);
    const canPrev = `${month}-01` > data.booksStart;
    const canNext = nextM <= data.today.slice(0, 7);
    const mark = (s) => (s === 'saved' ? '<span class="cal-ok">✓</span>' : s === 'started' ? '<span class="cal-dot wip"></span>' : s === 'not_started' ? '<span class="cal-dot todo"></span>' : '');
    const words = { saved: 'saved', started: 'in progress', not_started: 'not started' };
    const cells = data.days.map((x) => {
      const n = Number(x.day.slice(8));
      const label = `${dayLabel(x.day)}${x.state ? `, ${words[x.state]}` : ''}${x.open ? `, ${x.open} still open` : ''}`;
      return html`<button type="button" class="cal-d ${x.day === day ? 'sel' : ''} ${x.day === data.today ? 'today' : ''}" data-calday="${x.day}" ${x.off ? 'disabled' : ''} aria-label="${label}" title="${label}">
        <span class="cal-n">${n}</span><span class="cal-m">${{ __html: mark(x.state) }}</span>${x.open ? html`<span class="cal-c">${x.open}</span>` : ''}</button>`;
    });
    pop.innerHTML = html`<div class="cal-head"><button type="button" class="cal-nav" data-calm="${prevM}" ${canPrev ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <strong>${MONTHS[m - 1]} ${y}</strong><button type="button" class="cal-nav" data-calm="${nextM}" ${canNext ? '' : 'disabled'} aria-label="Next month">›</button></div>
      <div class="cal-g">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w) => html`<span class="cal-w">${w}</span>`)}${Array.from({ length: lead }, () => html`<span></span>`)}${cells}</div>
      <div class="cal-leg"><span><span class="cal-ok">✓</span>Saved</span><span><span class="cal-dot wip"></span>In progress</span><span><span class="cal-dot todo"></span>Not started</span></div>
      <div class="cal-foot">${data.oldestToDo ? html`<button type="button" class="linkbtn" data-calgo="${data.oldestToDo}">Oldest to do: ${dayLabel(data.oldestToDo)}</button>` : html`<span class="tiny">All shifts saved</span>`}
        <button type="button" class="linkbtn" data-calgo="${data.today}">Today</button></div>`.__html;
    pop.querySelectorAll('[data-calm]').forEach((b) => b.addEventListener('click', () => draw(b.dataset.calm)));
    pop.querySelectorAll('[data-calday],[data-calgo]').forEach((b) => b.addEventListener('click', () => { const d = b.dataset.calday ?? b.dataset.calgo; close(); if (d !== day) to(d); }));
  };
  btn.addEventListener('click', () => {
    if (pop) return close();
    pop = document.createElement('div');
    pop.className = 'cal-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose a shift');
    box.appendChild(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    draw(day.slice(0, 7), cal && cal.month === day.slice(0, 7) ? cal : null);
  });
}

function shell(biz, current, title, subtitle, body, opts = {}) {
  const shown = NAV.filter((n) => (!n.owner || biz.role === 'owner') && (!n.needs || biz.actions.includes(n.needs)) && (!n.when || n.when(biz))
    && (n.key !== 'shifts' || SHIFT_SCREENS.some(([, , need]) => biz.actions.includes(need))));
  const link = (n) => html`<a class="nav ${(n.screens ?? [n.key]).includes(current) ? 'on' : ''}" data-navkey="${n.key}" href="${navHref(biz, n.key)}">
      <span>${n.label}</span>${n.badge ? html`<span class="nav-n" data-navn="${n.badge}" hidden></span>` : ''}</a>`;
  const settings = shown.filter((n) => n.group === 'Settings');
  const inSettings = settings.some((n) => (n.screens ?? [n.key]).includes(current));
  let lastGroup = null;
  const nav = [...shown.filter((n) => n.group !== 'Settings').map((n) => {
    const head = n.group && n.group !== lastGroup ? html`<div class="nav-g">${n.group}</div>` : '';
    lastGroup = n.group ?? lastGroup;
    return html`${head}${link(n)}`;
  }), settings.length ? html`<details class="nav-set" ${inSettings ? 'open' : ''}><summary class="nav-g">Settings</summary>${settings.map(link)}</details>` : ''];
  const others = me.businesses.map((b) => html`
    <a href="#/b/${b.id}/${current}" class="${b.id === biz.id ? 'on' : ''}"><span>${b.name}</span><span class="chip">${ROLE_LABELS[b.role]}</span></a>`);
  return html`
  <div class="shell">
    <aside class="side">
      <div class="brand">Bookr</div>
      ${nav}
    </aside>
    <main class="main">
      ${biz.isDemo && !opts.tools ? html`<div class="demo-band">Demo business. Sample data only.</div>` : ''}
      <div class="head ${opts.tools ? 'compact' : ''}">
        <div style="display:flex;flex-direction:column;gap:4px">
          <h1>${biz.isDemo && opts.tools ? html`<span class="chip wait demo-tag" title="Demo business. Sample data only.">Demo</span>` : ''}${title}</h1>
          ${subtitle ? html`<div class="sub">${subtitle}</div>` : ''}
        </div>
        ${opts.tools ?? ''}
        <div class="switcher">
          <button class="btn plain" id="switch" type="button" aria-haspopup="true" aria-expanded="false">${biz.name} ▾</button>
          <div class="menu" id="switch-menu" hidden>
            ${others}
            <a href="#/choose"><span>All businesses</span></a>
            ${installButton('btn plain menu-install')}
            <div class="tiny" style="padding:8px 12px;border-top:1px solid var(--line-soft)">${ROLE_LABELS[biz.role]} · ${me.user.email}
              <div><button id="signout" type="button" class="btn plain" style="margin-top:6px;min-height:32px">Sign out</button></div></div>
          </div>
        </div>
      </div>
      ${body}
    </main>
  </div>`;
}

function wireShell() {
  const sb = me?.businesses?.find((b) => b.id === currentBizId());
  if (sb) fillNavCounts(sb);
  document.getElementById('signout')?.addEventListener('click', async () => {
    await api('POST', '/auth/logout', {}).catch(() => {});
    me = null;
    go('#/login');
  });
  const btn = document.getElementById('switch');
  const menu = document.getElementById('switch-menu');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', () => { if (menu) menu.hidden = true; }, { once: true });
}

// ---------- screens

function loginView() {
  render(html`
  <div class="center">
    <form class="card" id="login" style="flex:0 1 400px">
      <div style="font-size:22px;font-weight:600">Bookr</div>
      <h1 style="margin:0;font-size:28px;font-weight:600">Sign in</h1>
      <div class="field"><label for="e">Email or mobile number</label><input id="e" name="email" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="name@example.com or 94120 55555" required></div>
      <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <span class="note">Forgot your password? Ask the Owner of your business.</span>
      <div class="form-msg"></div>
      <button class="btn big" type="submit">Sign in</button>
      <div class="note">You can only see businesses you have been invited to. Ask the Owner for an invite.</div>
    </form>
  </div>`);
  onSubmit(document.getElementById('login'), async (d) => {
    await api('POST', '/auth/login', { email: d.email, password: d.password });
    me = await api('GET', '/me');
    go(me.businesses.length === 1 ? home(me.businesses[0]) : '#/choose');
  });
}

function chooseView() {
  const list = me.businesses.map((b) => html`
    <a class="biz" href="${home(b)}">
      <div><div class="name">${b.name}</div><div class="note">${b.isDemo ? 'Demo business' : ''}</div></div>
      <span class="chip" style="font-size:13px;padding:4px 12px">${ROLE_LABELS[b.role]}</span>
    </a>`);
  render(html`
  <div class="center">
    <section class="card" style="flex:0 1 480px">
      <h2 style="font-size:22px">Choose a business</h2>
      <div class="sub">You can switch any time from the top of each screen.</div>
      ${list.length ? list : html`<div class="note">You are not in any business yet. Ask an Owner for an invite.</div>`}
      ${me.canCreateBusiness ? html`
      <form class="inset" id="newbiz">
        <div style="font-size:15px;font-weight:600">New business</div>
        <div class="form-row">
          <div class="field"><label for="bn">Business name</label><input id="bn" name="name" required></div>
          <div class="field"><label for="fy">Financial year start</label><input id="fy" name="fyStart" type="date" value="${fyDefault()}" required></div>
        </div>
        <div class="note">You will be its Owner. It starts with a Cash account and the standard heads.</div>
        <div class="form-msg"></div>
        <button class="btn" type="submit">Create business</button>
      </form>` : ''}
      <button class="btn plain" id="signout" type="button">Sign out</button>
    </section>
  </div>`);
  wireShell();
  const form = document.getElementById('newbiz');
  form && onSubmit(form, async (d) => {
    const { id } = await api('POST', '/businesses', d);
    me = await api('GET', '/me');
    go(`#/b/${id}/accounts`);
  });
}

function fyDefault() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

// Today (approved 14 Nov 2026; was the dashboard of 9 Nov): one line for each thing waiting, oldest first, each opening
// where it is done. What is done folds to one line. Bank and card parts only for Owner and Accountant, as before.
function todayItems(h, biz) {
  const can = (a) => biz.actions.includes(a);
  const n = (x, one, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  const rs = (p) => `₹ ${money(p)}`;
  const items = [];
  const add = (day, text, href, label, late = '') => items.push({ day, text, href, label, late });
  if (h.bringIn && can('rows.upload')) {
    const b = h.bringIn;
    const miss = [!b.software && 'sales report', !b.registerPages && 'register photos'].filter(Boolean).join(' and ');
    add(b.day, html`<strong>${dayLabel(b.day)} shift</strong> · ${miss} not in yet`, screenHref(biz, 'bringin', b.day), 'Bring in');
  }
  for (const s of h.shifts?.list ?? []) {
    const parts = [s.toCheck && n(s.toCheck, 'row') + ' to check', s.toDecide && n(s.toDecide, 'bill') + ' to decide',
      s.bank?.billsLeft && `${s.bank.billsLeft} UPI bill${s.bank.billsLeft === 1 ? '' : 's'} not in the bank`, s.bank?.creditsLeft && n(s.bank.creditsLeft, 'UPI credit') + ' not matched',
      s.bank?.cardsLeft && `${s.bank.cardsLeft} card`].filter(Boolean);
    const step = s.toCheck && can('rows.edit') ? ['review', 'Register'] : ['reconcile', 'Reconcile'];
    add(s.day, html`<strong>${dayLabel(s.day)} shift</strong> · ${s.status !== 'confirmed' ? 'not saved' : 'saved'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`, screenHref(biz, step[0], s.day), step[1]);
  }
  if (h.photos?.count) add(h.photos.pages[0]?.day ?? null, `${n(h.photos.count, 'expense line')} to approve · ${rs(h.photos.paise)}`, `#/b/${biz.id}/review/${h.photos.pages[0]?.uploadId ?? ''}`, 'Approve');
  if (h.bookExpenses?.count) {
    const b = h.bookExpenses;
    add(b.oldestDay, `${n(b.count, 'bank payment')} to book · ${rs(b.paise)}`, `#/b/${biz.id}/bank?${new URLSearchParams({ tab: 'out', from: b.oldestDay ?? h.today, to: h.today })}`, 'Book');
  }
  if (h.upi?.credits.count) add(h.upi.credits.oldestDay, `${n(h.upi.credits.count, 'UPI credit')} with no bill · ${rs(h.upi.credits.paise)}`, `#/b/${biz.id}/bank?tab=in`, 'Match',
    h.upi.credits.late ? `${h.upi.credits.late} over ${h.watchDays} days` : '');
  if (h.cards?.days) add(h.cards.oldestDay, `${n(h.cards.days, 'card day')} to settle · ${rs(h.cards.netPaise)} net`, `#/b/${biz.id}/cards`, 'Settle');
  for (const k of h.cash ?? []) add(k.day, html`<strong>${dayLabel(k.day)} cash</strong> · ${!k.counted ? 'cash in hand not entered' : k.differencePaise < 0 ? `${rs(-k.differencePaise)} short` : `${rs(k.differencePaise)} over`}`,
    `#/b/${biz.id}/reconcile/${k.day}?tab=cash`, 'Cash');
  if (h.waitingBills?.count) add(h.waitingBills.firstDay, `${n(h.waitingBills.count, 'waiting bill')} need a look`, `#/b/${biz.id}/reconcile/${h.waitingBills.firstDay}?top=wait`, 'Open',
    h.waitingBills.late ? `${h.waitingBills.late} over ${h.watchDays} days` : '');
  return items.sort((x, y) => (x.day ?? '9999').localeCompare(y.day ?? '9999'));
}

async function dashboardView(biz) {
  const [h, { accounts, heads }] = await Promise.all([api('GET', `/businesses/${biz.id}/home`), api('GET', `/businesses/${biz.id}/dashboard`)]);
  navCounts = { bizId: biz.id, at: Date.now(), n: todayCounts(h, biz) };
  const items = todayItems(h, biz);
  const STALE = 36 * 3600000;
  const stale = (ms) => ms == null || Date.now() - ms > STALE;
  const done = [!h.shifts.count && 'every shift saved', h.bookExpenses && !h.bookExpenses.count && 'every bank payment booked',
    h.upi && !h.upi.credits.count && 'every UPI credit matched', h.cards && !h.cards.days && 'card days settled',
    h.cash && !h.cash.length && 'cash checks out', h.photos && !h.photos.count && 'expense photos approved'].filter(Boolean);
  const f = h.fresh;
  const bit = (label, text, old) => html`<span style="${old ? 'color:#92400E' : ''}">${label} ${text}</span>`;
  const fresh = [...(f.bank ?? []).filter((a) => a.linked || a.lastAt).map((a) => bit(a.name, a.lastAt ? `up to ${when(a.lastAt)}` : 'no lines yet', stale(a.lastAt))),
    ...(f.cards?.folder ? [bit('Card', f.cards.lastAt ? `up to ${when(f.cards.lastAt)}` : 'no report yet', stale(f.cards.lastAt))] : [])];
  const total = accounts.reduce((t, a) => t + a.openingBalancePaise, 0);
  // Today (redesigned 18 Nov 2026): how far each file goes, the one next step, the shifts as a strip of days, money as
  // tiles, then approvals. Every count is the server's; nothing here is worked out twice.
  const can = (a) => biz.actions.includes(a);
  const istDayOf = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);
  const short = (d) => (d ? new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '–');
  const lastShift = addDaysIso(h.today, -1);
  const behind = (d) => !d || d < addDaysIso(lastShift, -1);
  const bankAt = (f.bank ?? []).map((a) => a.lastAt).filter(Boolean).sort((x, y) => x - y)[0] ?? null;
  const upto = [
    f.bank ? html`<span>Bank <b class="${stale(bankAt) ? 'td-amber' : ''}">${bankAt ? short(istDayOf(bankAt)) : 'none'}</b></span>` : '',
    html`<span>Register <b class="${behind(f.registerDay) ? 'td-amber' : ''}">${short(f.registerDay)}</b></span>`,
    html`<span>Sales report <b class="${behind(f.reportDay) ? 'td-amber' : ''}">${short(f.reportDay)}</b></span>`,
    f.cards?.folder ? html`<span>Card <b class="${stale(f.cards.lastAt) ? 'td-amber' : ''}">${f.cards.lastAt ? short(istDayOf(f.cards.lastAt)) : 'none'}</b></span>` : ''];
  // What each shift needs, in the order it is done.
  // A shift with no register pages, or pages not read yet, is never ready to save (18 Nov 2026).
  const stage = (s) => (s.status === 'confirmed' ? 'saved'
    : f.reportDay && s.day > f.reportDay ? 'report' : !s.register?.pages ? 'register' : s.register.unread ? 'unread'
    : s.toCheck || s.toDecide ? 'work' : 'ready');
  const list = (h.shifts?.list ?? []).map((s) => ({ ...s, stage: stage(s) }));
  if (h.bringIn && !list.some((s) => s.day === h.bringIn.day)) list.push({ day: h.bringIn.day, stage: 'none', toCheck: 0, toDecide: 0 });
  list.sort((x, y) => x.day.localeCompare(y.day));
  const STAGES = { ready: ['td-g', 'Ready to save'], work: ['td-a', 'To check or decide'], unread: ['td-a', 'Register photos not read yet'], report: ['td-n', 'Waiting for the sales report'], register: ['td-n', 'No register photos'],
    none: ['td-u', 'Nothing brought in yet'], saved: ['td-s', 'Saved, money still to match'] };
  const daysText = (xs) => {
    // Runs of days in a row are told as one range: 3–8 Nov.
    const out = []; let run = [];
    const flush = () => { if (run.length) out.push(run.length > 2 ? `${short(run[0]).split(' ')[0]}–${short(run.at(-1))}` : run.map(short).join(', ')); run = []; };
    for (const d of xs) { if (run.length && addDaysIso(run.at(-1), 1) !== d) flush(); run.push(d); }
    flush(); return out.join(', ');
  };
  const legend = Object.entries(STAGES).map(([k, [cls, label]]) => {
    const xs = list.filter((s) => s.stage === k);
    if (!xs.length) return '';
    const detail = k === 'unread' ? xs.map((s) => `${short(s.day)} (${s.register.unread} page${s.register.unread === 1 ? '' : 's'}${s.register.failed ? `, ${s.register.failed} failed` : ''})`).join(', ')
      : k === 'work' ? xs.map((s) => `${short(s.day)}${s.toCheck ? ` · ${s.toCheck} row${s.toCheck === 1 ? '' : 's'} to check` : ''}${s.toDecide ? ` · ${s.toDecide} to decide` : ''}`).join('; ') : daysText(xs.map((s) => s.day));
    const act = (k === 'none' || k === 'register') && can('rows.upload') ? html`<a href="${screenHref(biz, 'bringin', xs[0].day)}">Bring in ›</a>`
      : k === 'unread' && can('rows.edit') ? html`<a href="${screenHref(biz, 'review', xs[0].day)}">Read on Register ›</a>` : '';
    return html`<div class="td-lg"><span class="td-dot ${cls}"></span><span style="flex:1">${label} · ${detail}</span>${act || html`<span class="note">${xs.length} shift${xs.length === 1 ? '' : 's'}</span>`}</div>`;
  });
  const hrefOf = (s) => (s.stage === 'none' || s.stage === 'register' ? screenHref(biz, 'bringin', s.day) : s.stage === 'unread' ? screenHref(biz, 'review', s.day) : s.toCheck && can('rows.edit') ? screenHref(biz, 'review', s.day) : screenHref(biz, 'reconcile', s.day));
  // The one next step: Bring in for the last shift, else the oldest shift ready to save, else the oldest with work.
  const firstReady = list.find((s) => s.stage === 'ready');
  const firstUnread = list.find((s) => s.stage === 'unread');
  const firstWork = list.find((s) => s.stage === 'work');
  const next = h.bringIn && can('rows.upload') ? { title: `Bring in the ${dayLabel(h.bringIn.day)} shift`, why: [!h.bringIn.software && 'sales report', !h.bringIn.registerPages && 'register photos'].filter(Boolean).join(' and ') + ' not in yet', href: screenHref(biz, 'bringin', h.bringIn.day), label: 'Bring in' }
    : firstUnread && can('rows.edit') && (!firstReady || firstUnread.day < firstReady.day) ? { title: `Read the ${dayLabel(firstUnread.day)} register`, why: `${firstUnread.register.unread} page${firstUnread.register.unread === 1 ? '' : 's'} uploaded, not read yet${list.filter((s) => s.stage === 'unread').length > 1 ? ` · ${list.filter((s) => s.stage === 'unread').length} shifts like this` : ''}`, href: screenHref(biz, 'review', firstUnread.day), label: 'Open Register' }
    : firstReady && can('sales.decide') ? { title: `Save the ${dayLabel(firstReady.day)} shift`, why: 'Every row checked, nothing to decide', href: screenHref(biz, 'reconcile', firstReady.day), label: `Open ${short(firstReady.day)}` }
    : firstWork ? { title: `Finish the ${dayLabel(firstWork.day)} shift`, why: [firstWork.toCheck && `${firstWork.toCheck} rows to check`, firstWork.toDecide && `${firstWork.toDecide} bills to decide`].filter(Boolean).join(' · '), href: hrefOf(firstWork), label: `Open ${short(firstWork.day)}` }
    : items[0] ? { title: items[0].text, why: '', href: items[0].href, label: items[0].label } : null;
  // Money: the Waiting groups over saved shifts (the same as each shift's To do), then the bank's own jobs.
  const kd = h.waitingBills?.kinds ?? {};
  // Each opens Reports → Pending bills at its group (19 Nov 2026), every shift together.
  const waitHref = (k) => (kd[k]?.n ? `#/b/${biz.id}/pending?group=${k}` : null);
  const tile = (cls, label, big, small, href) => html`<a class="td-tile ${cls}" ${href ? `href="${href}"` : ''}><div class="td-tl">${label}</div><div class="td-tv">${big}</div><div class="td-ts">${small}</div></a>`;
  const nOf = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const tiles = [
    can('sales.view') ? tile('td-red', 'Payment not received', kd.not_received?.n ? `₹ ${rs(kd.not_received.paise)}` : '–',
      kd.not_received?.n ? `${nOf(kd.not_received.n, 'bill')} · ${daysText(kd.not_received.days)}` : h.shifts.list.some((s) => s.status !== 'confirmed') ? 'shows as shifts are saved' : 'none', waitHref('not_received')) : '',
    kd.cash_wait?.n ? tile('td-amb', 'Cash bills not in the register', `₹ ${rs(kd.cash_wait.paise)}`, `${nOf(kd.cash_wait.n, 'bill')} · usually written next day`, waitHref('cash_wait')) : '',
    kd.found?.n ? tile('td-teal', 'Payment found, to match', `₹ ${rs(kd.found.paise)}`, `${nOf(kd.found.n, 'bill')} · ${daysText(kd.found.days)}`, waitHref('found')) : '',
    h.upi ? tile('', 'UPI credits with no bill', h.upi.credits.count ? `₹ ${rs(h.upi.credits.paise)}` : '–',
      h.upi.credits.count ? html`${h.upi.credits.count.toLocaleString('en-IN')}${h.upi.credits.late ? html` · <span class="td-redtext">${h.upi.credits.late} over ${h.watchDays} days</span>` : ''}` : 'all matched', `#/b/${biz.id}/bank?tab=in`) : '',
    h.bookExpenses ? tile('', 'Bank payments to book', h.bookExpenses.count ? `₹ ${rs(h.bookExpenses.paise)}` : '–', h.bookExpenses.count ? `${h.bookExpenses.count} · since ${short(h.bookExpenses.oldestDay)}` : 'all booked',
      `#/b/${biz.id}/bank?${new URLSearchParams({ tab: 'out', from: h.bookExpenses.oldestDay ?? h.today, to: h.today })}`) : '',
    h.cards ? tile('', 'Card days to settle', h.cards.days ? `₹ ${rs(h.cards.netPaise)}` : '–', h.cards.days ? `${h.cards.days} days net` : 'all settled', `#/b/${biz.id}/cards`) : '',
  ].filter(Boolean);
  render(shell(biz, 'dashboard', 'Today', '', html`
    <div class="td-upto">${upto}${f.bank ? html`<button class="btn plain" id="dashsync" type="button" style="min-height:32px">Sync</button>` : ''}</div><div id="dashmsg"></div>
    ${next ? html`<section class="card td-next"><div><div class="note">Next</div><div class="td-nt">${next.title}</div>${next.why ? html`<div class="note">${next.why}</div>` : ''}</div>
      <a class="btn" href="${next.href}">${next.label} ›</a></section>` : html`<div class="ok-msg">Nothing waiting.</div>`}
    ${list.length ? html`<section class="card" style="gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h2>Shifts · ${nOf(list.filter((s) => s.stage !== 'saved').length, 'shift')} not saved</h2><span class="note">Press a day to open it</span></div>
      <div class="td-strip">${list.map((s, i) => html`<a class="td-day ${STAGES[s.stage][0]}" href="${hrefOf(s)}" title="${dayLabel(s.day)} · ${STAGES[s.stage][1]}">${short(s.day).split(' ')[0]}${i === 0 || s.day.slice(5, 7) !== list[i - 1].day.slice(5, 7) ? html`<small>${short(s.day).split(' ')[1]}</small>` : ''}</a>`)}</div>
      ${legend}
    </section>` : ''}
    ${tiles.length ? html`<section class="card" style="gap:10px"><h2>Money</h2><div class="td-tiles">${tiles}</div></section>` : ''}
    ${h.photos?.count ? html`<section class="card td-row"><div><h2 style="margin:0">Approve · ${nOf(h.photos.count, 'expense line')} · ₹ ${rs(h.photos.paise)}</h2>
      <div class="note">${nOf(h.photos.pages.length, 'cash page')}: ${daysText([...new Set(h.photos.pages.map((p) => p.day))].sort())}</div></div>
      <a class="btn plain" href="#/b/${biz.id}/review/${h.photos.pages[0]?.uploadId ?? ''}">Approve ›</a></section>` : ''}
    ${(h.cash ?? []).length ? (() => {
      // Open cash shorts (18 Nov 2026): each saved day still short or over, what explains it, and the shorts' total. A day
      // leaves when its bill turns up, a shortage is booked or the difference is accepted.
      const shortSum = h.cash.filter((k) => k.differencePaise < 0).reduce((t, k) => t - k.differencePaise, 0);
      return html`<section class="card" style="gap:4px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h2>${shortSum ? 'Open cash shorts' : 'Cash'}</h2>
        ${shortSum ? html`<strong class="amount" style="color:#991B1B">₹ ${rs(shortSum)}</strong>` : ''}</div>
      ${h.cash.map((k) => html`<a class="today-row" href="#/b/${biz.id}/reconcile/${k.day}?tab=cash">
      <span><strong>${dayLabel(k.day)}</strong> · ${!k.counted ? 'cash in hand not entered' : k.differencePaise < 0 ? `₹ ${rs(-k.differencePaise)} short` : `₹ ${rs(k.differencePaise)} over`}
        ${k.differencePaise < 0 && k.bills?.length ? html`<span class="tiny note"> · ${k.bills.map((b) => `${b.billNo} ₹ ${rs(b.amountPaise)}`).join(', ')} not in the register as cash${k.unexplainedPaise ? `, ₹ ${rs(k.unexplainedPaise)} unexplained` : ''}</span>` : ''}</span><span class="btn plain dchip">Cash ›</span></a>`)}
      ${shortSum ? html`<div class="tiny note">A day leaves this list when its bill turns up, a shortage is booked or the difference is accepted.</div>` : ''}</section>`; })() : ''}
    ${done.length ? html`<div class="note">✓ ${done.join(' · ')}</div>` : ''}
    <details class="card cmp-fold"><summary><h2>Opening balances and set-up</h2></summary>
      ${accounts.map((a) => html`<div class="list-row"><span>${a.name}</span><span class="amount">₹ ${money(a.openingBalancePaise)}</span></div>`)}
      <div class="list-row" style="font-weight:600"><span>Combined</span><span class="amount">₹ ${money(total)}</span></div>
      <div class="note">${accounts.length} accounts · ${heads.income} income heads · ${heads.expense} expense heads ·
        <a href="#/b/${biz.id}/accounts">Accounts</a> · <a href="#/b/${biz.id}/heads">Heads and rules</a></div>
    </details>`));
  wireShell();
  document.getElementById('dashsync')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try { const r = await apiFull('POST', `/businesses/${biz.id}/bank/sync-all`, {}); navCounts.at = 0; await dashboardView(biz); document.getElementById('dashmsg').innerHTML = syncResultHtml(r).__html; }
    catch (err) { e.target.disabled = false; e.target.textContent = 'Sync'; showError(document.getElementById('dashmsg'), err); }
  });
}

async function accountsView(biz, editId) {
  const { accounts } = await api('GET', `/businesses/${biz.id}/accounts`);
  const canEdit = biz.actions.includes('accounts.edit');
  const editing = accounts.find((a) => a.id === editId);
  const rows = accounts.map((a) => html`
    <tr>
      <td><div style="font-weight:500">${a.name}</div>${a.accountNumber ? html`<div class="note mono">${a.accountNumber}</div>` : ''}
        ${a.kind === 'bank' ? html`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;align-items:center" title="How this account appears on your other statements: a line naming one of these is shown as a transfer between your accounts">
          ${(a.identifiers ?? []).map((w) => html`<span class="chip" style="display:inline-flex;gap:4px;align-items:center">${w}${canEdit ? html`<button type="button" class="linkbtn tiny" data-idrm="${a.id}" data-w="${w}" aria-label="Remove ${w}">✕</button>` : ''}</span>`)}
          ${canEdit ? html`<button type="button" class="linkbtn tiny" data-idadd="${a.id}" data-name="${a.name}">+ How it appears on other statements</button>` : ''}</div>` : ''}</td>
      <td>${a.kind === 'cash' ? 'Cash' : 'Bank'}</td>
      <td class="mono">${a.openingDate}</td>
      <td class="amount">₹ ${money(a.openingBalancePaise)}</td>
      <td style="text-align:right">${canEdit ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/accounts/${a.id}">Edit</a>` : ''}</td>
    </tr>`);
  const f = editing ? { ...editing, openingBalance: rupeesForInput(editing.openingBalancePaise) } : { name: '', kind: 'bank', accountNumber: '', openingBalance: '0.00', openingDate: biz.fyStart };
  render(shell(biz, 'accounts', 'Accounts', canEdit ? 'Every account here is the business\'s own: money moved between them is a transfer. The opening date is the day its books start: earlier lines are not waiting.' : 'Only Owner and Accountant can change these.', html`
    <div class="row">
      <section class="card grow3">
        <h2>Accounts in ${biz.name}</h2>
        <div class="scroll"><table style="min-width:560px">
          <thead><tr><th>Account</th><th>Kind</th><th>Opening date</th><th style="text-align:right">Opening balance</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>
      ${canEdit ? html`
      <form class="card grow2" id="acct">
        <h2>${editing ? `Edit ${editing.name}` : 'Add account'}</h2>
        <div class="field"><label for="an">Account name</label><input id="an" name="name" value="${f.name}" placeholder="for example HDFC Current" required></div>
        <div class="form-row">
          <div class="field"><label for="ak">Kind</label><select id="ak" name="kind">
            <option value="bank" ${f.kind === 'bank' ? 'selected' : ''}>Bank</option>
            <option value="cash" ${f.kind === 'cash' ? 'selected' : ''}>Cash</option></select></div>
          <div class="field"><label for="anum">Account number</label><input id="anum" name="accountNumber" value="${f.accountNumber ?? ''}" placeholder="optional"></div>
        </div>
        <div class="form-row">
          <div class="field"><label for="ab">Opening balance (₹)</label><input id="ab" name="openingBalance" class="mono" inputmode="decimal" value="${f.openingBalance}" required></div>
          <div class="field"><label for="ad">Opening date</label><input id="ad" name="openingDate" type="date" value="${f.openingDate}" required
            title="The day this account's books start: its bank lines before it are kept but not waiting"></div>
        </div>
        <div class="tiny" style="margin-top:-4px">Opening balance: the balance at 8 am on the opening date, when its first shift starts. For a bank, the balance on the last statement line before that time; for cash, the cash counted at the 8 am handover.</div>
        <div class="form-msg"></div>
        <div class="form-row">
          <button class="btn" type="submit">${editing ? 'Save account' : 'Add account'}</button>
          ${editing ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/accounts">Cancel</a>` : ''}
        </div>
      </form>` : ''}
    </div>`));
  wireShell();
  // How an account appears on the business's other statements (approved 14 Nov 2026).
  const saveIds = async (id, list) => { await api('PUT', `/businesses/${biz.id}/accounts/${id}/identifiers`, { identifiers: list }); await accountsView(biz, editId); };
  app.querySelectorAll('[data-idadd]').forEach((x) => x.addEventListener('click', async () => {
    const w = (prompt(`A UPI ID, name or words that ${x.dataset.name} shows as on your other bank statements (for example huf.madhur@okicici, BIS HOSTEL):`, '') ?? '').trim();
    if (w.length < 3) return;
    const a = accounts.find((y) => y.id === x.dataset.idadd);
    try { await saveIds(a.id, [...(a.identifiers ?? []), w]); } catch (err) { alert(err.message); }
  }));
  app.querySelectorAll('[data-idrm]').forEach((x) => x.addEventListener('click', async () => {
    const a = accounts.find((y) => y.id === x.dataset.idrm);
    try { await saveIds(a.id, (a.identifiers ?? []).filter((w) => w !== x.dataset.w)); } catch (err) { alert(err.message); }
  }));
  const form = document.getElementById('acct');
  form && onSubmit(form, async (d) => {
    if (editing) await api('PATCH', `/businesses/${biz.id}/accounts/${editing.id}`, d);
    else await api('POST', `/businesses/${biz.id}/accounts`, d);
    go(`#/b/${biz.id}/accounts`);
  });
}

async function headsView(biz, editId) {
  const [{ heads }, { billTypeHeads }, { parties }, { rules }, { terminals }] = await Promise.all([
    api('GET', `/businesses/${biz.id}/heads`),
    api('GET', `/businesses/${biz.id}/bill-type-heads`),
    api('GET', `/businesses/${biz.id}/parties`),
    api('GET', `/businesses/${biz.id}/rules`),
    api('GET', `/businesses/${biz.id}/cards/rules`).catch(() => ({ terminals: [] })),
    api('GET', `/businesses/${biz.id}/parties`),
  ]);
  const canRules = biz.actions.includes('rules.edit');
  const vendorsOf = (headId) => parties.filter((p) => p.defaultHeadId === headId || (p.heads ?? []).some((x) => x.headId === headId));
  const canEdit = biz.actions.includes('heads.edit');
  const editing = heads.find((h) => h.id === editId);
  const mapped = (t) => billTypeHeads.find((m) => m.billType === t)?.headId ?? '';
  const incomeHeads = heads.filter((h) => h.type === 'income');
  const list = (type) => heads.filter((h) => h.type === type).map((h) => html`
    <div class="list-row">
      <span>${h.name}${h.isCustom ? html` <span class="chip">Custom</span>` : ''}</span>
      <span style="display:flex;gap:10px;align-items:center">
        <span class="note">Tally ledger: ${h.tallyLedger || 'not set'}</span>
        ${canEdit ? html`<a href="#/b/${biz.id}/heads/${h.id}" class="note" style="color:var(--teal)">Edit</a>` : ''}
      </span>
      ${h.type === 'expense' && vendorsOf(h.id).length ? html`<div class="tiny" style="flex-basis:100%;color:var(--muted)">Vendors: ${vendorsOf(h.id).map((p) => p.name).join(', ')}</div>` : ''}
    </div>`);
  const addBtn = (type, label) => canEdit ? html`<a class="btn ghost" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/heads/new-${type}">${label}</a>` : '';
  const newType = editId === 'new-income' ? 'income' : editId === 'new-expense' ? 'expense' : null;
  const showForm = canEdit && (editing || newType);
  const ret = getNewHeadReturn();
  const backToLine = ret && ret.done === undefined ? html`<div class="form-row" style="margin-bottom:12px"><a class="btn plain" style="display:inline-flex;align-items:center" href="${ret.hash}" id="backline">← Back to the expense line${ret.narration ? ` (${ret.narration})` : ''}</a>
    <span class="note">Add the head below; you go straight back with it chosen.</span></div>` : '';
  render(shell(biz, 'heads', 'Heads and rules', 'Only Owner and Accountant can change these.', html`
    ${backToLine}
    <div class="row">
      <section class="card grow1" style="gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2>Income heads</h2>${addBtn('income', 'Add income head')}</div>
        ${list('income')}
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><h2>Expense heads</h2>${addBtn('expense', 'Add expense head')}</div>
        ${list('expense')}
      </section>
      <section class="card" style="flex:2 1 480px;gap:14px">
        ${showForm ? html`
        <form class="inset" id="head">
          <div style="font-size:15px;font-weight:600">${editing ? `Edit ${editing.name}` : newType === 'income' ? 'New income head' : 'New expense head'}</div>
          <div class="form-row">
            <div class="field"><label for="hn">Head name</label><input id="hn" name="name" value="${editing?.name ?? ''}" required></div>
            <div class="field"><label for="ht">Tally ledger name</label><input id="ht" name="tallyLedger" value="${editing?.tallyLedger ?? ''}" placeholder="as it appears in Tally Prime"></div>
          </div>
          <div class="form-msg"></div>
          <div class="form-row">
            <button class="btn" type="submit">${editing ? 'Save head' : 'Add head'}</button>
            <a class="btn plain" style="display:inline-flex;align-items:center" href="${ret && ret.done === undefined && newType ? ret.hash : `#/b/${biz.id}/heads`}" id="headcancel">Cancel</a>
          </div>
        </form>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <h2>Auto-tag rules</h2><span class="note">Checked top to bottom. First match wins.</span>
        </div>
        <div class="note">Rules suggest a head for bank lines on Bank; a person books them. Make one from any bank line with "Make a rule".</div>
        ${rules.length ? rules.map((r, i) => html`<div class="list-row">
          <span><span class="note">${i + 1}.</span> <strong>${r.name}</strong>
            <span class="note">${r.direction === 'CR' ? 'received' : r.direction === 'DR' ? 'paid out' : 'any'}${r.contains ? ` · contains "${r.contains}"` : ''}${r.vpa ? ` · UPI ID ${r.vpa}` : ''}</span></span>
          <span style="display:flex;gap:8px;align-items:center"><span>→ ${r.headName}${r.partyName ? ` · ${r.partyName}` : ''}</span>
            ${canRules ? html`${i > 0 ? html`<button class="btn plain" type="button" data-ruleup="${r.id}" title="Check this rule earlier">↑</button>` : ''}<button class="btn plain" type="button" data-ruledel="${r.id}">Delete</button>` : ''}</span></div>`)
          : html`<div class="note">No rules yet.</div>`}
        <div id="rulemsg"></div>
        <div style="border-top:1px solid var(--line-soft);padding-top:14px;display:flex;flex-direction:column;gap:10px">
          <h2>Income head for each bill type</h2>
          <div class="note">The register marks each bill F&amp;B or Room. Confirmed sales are booked under these heads.</div>
          ${['fnb', 'room'].map((t) => html`<div class="form-row" style="align-items:center">
            <span style="flex:0 0 80px;font-weight:500">${t === 'fnb' ? 'F&B' : 'Room'}</span>
            ${canEdit ? html`<select class="compact" data-billtype="${t}" style="min-width:220px"><option value="">Choose a head</option>
              ${incomeHeads.map((h) => html`<option value="${h.id}" ${mapped(t) === h.id ? 'selected' : ''}>${h.name}</option>`)}</select>`
              : html`<span>${incomeHeads.find((h) => h.id === mapped(t))?.name ?? 'Not set'}</span>`}
          </div>`)}
          <div id="btmsg"></div>
        </div>
        <div style="border-top:1px solid var(--line-soft);padding-top:14px;display:flex;flex-direction:column;gap:10px">
          <h2>Card settlement rule</h2>
          <div class="note">For each card machine: where the card company's fee (MDR) and the GST on it are booked when a settlement reaches the bank. With a rule set, Bookr settles a day on its own when the bank credit carries its date and exactly its net amount, and books the fee and the GST as two expense rows. Every settlement can be undone on Reconcile.</div>
          ${terminals.length ? terminals.map((t) => {
            const exp = heads.filter((h) => h.type === 'expense');
            const sel = (k, cur) => canEdit ? html`<select class="compact" data-cr${k}="${t.terminalId}" style="min-width:200px"><option value="">Choose a head</option>
              ${exp.map((h) => html`<option value="${h.id}" ${cur === h.id ? 'selected' : ''}>${h.name}</option>`)}</select>` : html`<span>${exp.find((h) => h.id === cur)?.name ?? 'Not set'}</span>`;
            return html`<div class="form-row" style="align-items:center;border-top:1px solid var(--line-soft);padding-top:8px">
              <span style="flex:0 0 150px"><strong class="mono">${t.terminalId}</strong><span class="tiny" style="display:block">${t.payments} payment${t.payments === 1 ? '' : 's'}${t.merchantId ? ` · merchant ${t.merchantId}` : ''}</span></span>
              <span class="field" style="margin:0"><label class="tiny">Fee (MDR)</label>${sel('fee', t.rule?.feeHeadId)}</span>
              <span class="field" style="margin:0"><label class="tiny">GST on the fee</label>${sel('gst', t.rule?.gstHeadId)}</span>
              ${t.rule ? html`<span class="chip ok">Set</span>` : html`<span class="chip wait">Not set</span>`}</div>`;
          }) : html`<div class="note">No card machine yet: the rule is set once the first card settlement report is in (Card settlements).</div>`}
          ${canEdit && terminals.length ? html`<div class="note">Suggested: an expense head "Card machine charges" (Tally ledger: Bank Charges) for the fee, and "GST on card charges" for the GST.</div>` : ''}
          <div id="crmsg"></div>
        </div>
        <div style="border-top:1px solid var(--line-soft);padding-top:14px;display:flex;flex-direction:column;gap:8px">
          <h2>What Bookr has learned from items</h2>
          <div class="note">The head each item word went to, from the lines booked so far. A new line with the same word gets this head (shown as "From item"). Parties are on <a href="#/b/${biz.id}/parties">Parties</a>.</div>
          <div data-learned><div class="note">Loading…</div></div>
          <div id="vmsg"></div>
        </div>
      </section>
    </div>`));
  wireShell();
  const saveVendor = async (id) => {
    const msg = document.getElementById('vmsg');
    const name = app.querySelector(`[data-vname="${id}"]`).value.trim();
    const defaultHeadId = app.querySelector(`[data-vhead="${id}"]`).value || null;
    try { await api('PATCH', `/businesses/${biz.id}/parties/${id}`, { name, defaultHeadId }); msg.innerHTML = '<div class="ok-msg">Saved.</div>'; }
    catch (e) { msg.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  };
  app.querySelectorAll('[data-vhead]').forEach((el) => el.addEventListener('change', () => saveVendor(el.dataset.vhead)));
  app.querySelectorAll('[data-vname]').forEach((el) => el.addEventListener('change', () => saveVendor(el.dataset.vname)));
  // What Bookr has learned from items (approved 14 Nov 2026): Change sends the word to another head, Forget starts it again.
  const learnedBox = app.querySelector('[data-learned]');
  const showLearned = async () => {
    let items;
    try { ({ items } = await api('GET', `/businesses/${biz.id}/learned-items`)); } catch (e) { showError(learnedBox, e); return; }
    if (!learnedBox.isConnected) return;
    const exp = heads.filter((h) => h.type === 'expense');
    const row = (x) => html`<tr><td>${x.word}${x.mixed ? html` <span class="tiny" title="Booked under more than one head; the latest is used">· mixed</span>` : ''}</td>
      <td>${canEdit ? html`<select class="compact" data-litem="${x.word}" aria-label="Head for ${x.word}">${exp.map((h) => html`<option value="${h.id}" ${h.id === x.headId ? 'selected' : ''}>${h.name}</option>`)}</select>` : x.head ?? ''}</td>
      <td class="amount">${x.set ? 'set' : x.lines}</td><td style="text-align:right">${canEdit ? html`<button type="button" class="btn plain dchip" data-lforget="${x.word}">Forget</button>` : ''}</td></tr>`;
    learnedBox.innerHTML = (items.length ? html`<div class="scroll"><table style="min-width:420px"><thead><tr><th>Item word</th><th>Head</th><th style="text-align:right">Lines</th><th></th></tr></thead>
      <tbody>${items.slice(0, 15).map(row)}</tbody></table></div>
      ${items.length > 15 ? html`<details><summary class="note">Show ${items.length - 15} more</summary><div class="scroll"><table style="min-width:420px"><tbody>${items.slice(15).map(row)}</tbody></table></div></details>` : ''}`
      : html`<div class="note">Nothing yet: it fills as expense lines are booked with an item.</div>`).__html;
    const put = async (word, headId, text) => {
      try { await api('PUT', `/businesses/${biz.id}/learned-items`, { word, headId }); await showLearned(); doneToast(text, null, null); }
      catch (e) { showError(learnedBox, e); }
    };
    learnedBox.querySelectorAll('[data-litem]').forEach((el) => el.addEventListener('change', () => put(el.dataset.litem, el.value, `"${el.dataset.litem}" goes to ${exp.find((h) => h.id === el.value)?.name} from now on.`)));
    learnedBox.querySelectorAll('[data-lforget]').forEach((el) => el.addEventListener('click', () => {
      if (confirm(`Forget "${el.dataset.lforget}"? Its earlier lines stay as booked; Bookr stops using them to fill the head.`)) put(el.dataset.lforget, null, `"${el.dataset.lforget}" forgotten.`);
    }));
  };
  if (learnedBox) showLearned();
  const saveCardRule = async (tid) => {
    const msg = document.getElementById('crmsg');
    const feeHeadId = app.querySelector(`[data-crfee="${tid}"]`).value;
    const gstHeadId = app.querySelector(`[data-crgst="${tid}"]`).value;
    if (!feeHeadId || !gstHeadId) { msg.innerHTML = '<div class="note">Choose both heads to save the rule.</div>'; return; }
    try {
      const r = await apiFull('PUT', `/businesses/${biz.id}/cards/rules/${encodeURIComponent(tid)}`, { feeHeadId, gstHeadId });
      await headsView(biz, editId);
      document.getElementById('crmsg').innerHTML = html`<div class="ok-msg">Saved.${r.autoSettled ? ` Bookr settled ${r.autoSettled} day${r.autoSettled === 1 ? '' : 's'} waiting on this rule.` : ''}</div>`.__html;
    } catch (e) { showError(msg, e); }
  };
  app.querySelectorAll('[data-crfee],[data-crgst]').forEach((el) => el.addEventListener('change', () => saveCardRule(el.dataset.crfee ?? el.dataset.crgst)));
  app.querySelectorAll('[data-billtype]').forEach((sel) => sel.addEventListener('change', async () => {
    const msg = document.getElementById('btmsg');
    try { await api('PUT', `/businesses/${biz.id}/bill-type-heads/${sel.dataset.billtype}`, { headId: sel.value }); msg.innerHTML = '<div class="ok-msg">Saved.</div>'; }
    catch (e) { msg.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  }));
  app.querySelectorAll('[data-ruledel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this rule? Lines already booked by it stay as they are.')) return;
    try { await apiFull('DELETE', `/businesses/${biz.id}/rules/${b.dataset.ruledel}`, {}); headsView(biz, editId); } catch (err) { showError(document.getElementById('rulemsg'), err); }
  }));
  app.querySelectorAll('[data-ruleup]').forEach((b) => b.addEventListener('click', async () => {
    const i = rules.findIndex((r) => r.id === b.dataset.ruleup);
    const r = rules[i]; const prev = rules[i - 1];
    const put = (x, position) => apiFull('PUT', `/businesses/${biz.id}/rules/${x.id}`, { name: x.name, direction: x.direction, accountId: x.accountId, contains: x.contains, vpa: x.vpa,
      min: x.minPaise == null ? null : rupeesForInput(x.minPaise), max: x.maxPaise == null ? null : rupeesForInput(x.maxPaise), headId: x.headId, partyId: x.partyId, position });
    try { await put(r, prev.position); await put(prev, r.position === prev.position ? prev.position + 1 : r.position); headsView(biz, editId); }
    catch (err) { showError(document.getElementById('rulemsg'), err); }
  }));
  const form = document.getElementById('head');
  form && onSubmit(form, async (d) => {
    if (editing) await api('PATCH', `/businesses/${biz.id}/heads/${editing.id}`, d);
    else {
      const { id } = await api('POST', `/businesses/${biz.id}/heads`, { ...d, type: newType });
      if (ret && ret.done === undefined && newType === 'expense') { setNewHeadReturn({ ...ret, done: id }); return go(ret.hash); }
    }
    go(`#/b/${biz.id}/heads`);
  });
  // Going back without adding a head still restores the line.
  ['backline', 'headcancel'].forEach((id) => document.getElementById(id)?.addEventListener('click', () => { if (ret && ret.done === undefined) setNewHeadReturn({ ...ret, done: null }); }));
}

const PERM_ROWS = [
  ['Upload photos', 'rows.upload'],
  ['Tag and edit draft rows', 'rows.edit'],
  ['Approve rows', 'rows.approve'],
  ['Link bank sheets and match UPI', 'bank.link'],
  ['Edit heads and rules', 'heads.edit'],
  ['Export to Excel and Tally', 'export.run'],
  ['See reports and dashboard', 'reports.view'],
  ['Manage users and businesses', 'members.manage'],
];
// Mirrors src/permissions.ts for display only.
const MATRIX = {
  owner: PERM_ROWS.map(() => true),
  accountant: [true, true, true, true, true, true, true, false],
  entry_staff: [true, true, false, false, false, false, false, false],
  viewer: [false, false, false, false, false, false, true, false],
};

async function usersView(biz, selectedId) {
  const { members, invites } = await api('GET', `/businesses/${biz.id}/members`);
  const selected = members.find((m) => m.id === selectedId) ?? members.find((m) => m.id !== me.user.id) ?? members[0];
  const memberships = selected ? (await api('GET', `/businesses/${biz.id}/members/${selected.id}/memberships`)).memberships : [];
  const roleSelect = (m) => html`
    <select class="compact" aria-label="Role" data-role="${m.id}">
      ${['owner', 'accountant', 'entry_staff', 'viewer'].map((r) => html`<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)}
    </select>`;
  const people = [
    ...members.map((m) => html`
      <tr style="${selected && m.id === selected.id ? 'background:#F4F8F8' : ''}">
        <td><a href="#/b/${biz.id}/users/${m.id}" style="color:inherit"><div style="font-weight:500">${m.name}${m.id === me.user.id ? ' (you)' : ''}</div><div class="note">${m.email}</div></a></td>
        <td>${roleSelect(m)}</td>
        <td><span class="chip ok">Active</span></td>
        <td class="note">${relative(m.lastActiveAt)}</td>
        <td style="text-align:right">${m.id !== me.user.id ? html`<button class="btn danger" type="button" data-remove="${m.id}" data-name="${m.name}">Remove</button>` : ''}</td>
      </tr>`),
    ...invites.map((i) => html`
      <tr>
        <td><div style="font-weight:500">${i.email}</div><div class="note">Invite expires ${new Date(i.expiresAt).toLocaleDateString('en-IN')}</div></td>
        <td>${ROLE_LABELS[i.role]}</td>
        <td><span class="chip wait">Invited</span></td>
        <td class="note">Not signed in yet</td>
        <td style="text-align:right"><button class="btn danger" type="button" data-revoke="${i.id}">Cancel invite</button></td>
      </tr>`),
  ];
  render(shell(biz, 'users', 'Users and roles', 'Roles are set per business. Only an Owner can change them.', html`
    <div id="users-msg"></div>
    <div class="row">
      <section class="card grow3">
        <h2>People in ${biz.name}</h2>
        <div class="scroll"><table style="min-width:600px">
          <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last active</th><th></th></tr></thead>
          <tbody>${people}</tbody>
        </table></div>
      </section>
      <div class="grow2" style="display:flex;flex-direction:column;gap:16px;min-width:0">
        <form class="card" id="invite">
          <h2>Invite someone</h2>
          <div class="field"><label for="em">Email</label><input id="em" name="email" type="email" placeholder="name@example.com" required></div>
          <div class="field"><label for="rl">Role in ${biz.name}</label><select id="rl" name="role">
            ${ROLE_ORDER.map((r) => html`<option value="${r}">${ROLE_LABELS[r]}</option>`)}</select></div>
          <div class="form-msg"></div>
          <button class="btn" type="submit">Send invite</button>
          <div id="invite-link"></div>
        </form>
        ${selected ? html`
        <section class="card" style="gap:6px">
          <h2 style="margin-bottom:4px">${selected.name}, all businesses</h2>
          ${memberships.map((m) => html`<div class="list-row"><span>${m.name}</span><span style="font-weight:500">${ROLE_LABELS[m.role]}</span></div>`)}
          <div class="note">The same person can hold a different role in each business. Only businesses you own are shown.</div>
        </section>` : ''}
      </div>
    </div>
    <section class="card">
      <h2>What each role can do</h2>
      <div class="scroll"><table style="min-width:560px">
        <thead><tr><th>Action</th>${['owner', 'accountant', 'entry_staff', 'viewer'].map((r) => html`<th style="text-align:center">${ROLE_LABELS[r]}</th>`)}</tr></thead>
        <tbody>${PERM_ROWS.map(([label], i) => html`<tr><td style="padding:10px 6px">${label}</td>${['owner', 'accountant', 'entry_staff', 'viewer'].map((r) => MATRIX[r][i] ? html`<td class="yes">Yes</td>` : html`<td class="no">No</td>`)}</tr>`)}</tbody>
      </table></div>
    </section>`));
  wireShell();

  const flash = (text, ok) => {
    document.getElementById('users-msg').innerHTML = `<div class="${ok ? 'ok-msg' : 'error'}">${esc(text)}</div>`;
  };
  const reload = () => usersView(biz, selected?.id).catch((e) => flash(e.message));

  app.querySelectorAll('[data-role]').forEach((sel) => sel.addEventListener('change', async () => {
    try {
      await api('PATCH', `/businesses/${biz.id}/members/${sel.dataset.role}`, { role: sel.value });
      if (sel.dataset.role === me.user.id) { me = await api('GET', '/me'); return route(); }
      reload();
    } catch (e) { flash(e.message); reload(); }
  }));
  app.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Remove ${b.dataset.name} from ${biz.name}?`)) return;
    try { await api('DELETE', `/businesses/${biz.id}/members/${b.dataset.remove}`, {}); reload(); } catch (e) { flash(e.message); }
  }));
  app.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('DELETE', `/businesses/${biz.id}/invites/${b.dataset.revoke}`, {}); reload(); } catch (e) { flash(e.message); }
  }));
  onSubmit(document.getElementById('invite'), async (d) => {
    const { link } = await api('POST', `/businesses/${biz.id}/invites`, d);
    await usersView(biz, selected?.id);
    document.getElementById('invite-link').innerHTML = html`
      <div class="inset" style="margin-top:4px">
        <div class="note">Invite created for ${d.email}. Email is not sent yet, so share this link with them. It works once and expires in 7 days.</div>
        <div class="copy"><input id="link" readonly value="${link}"><button class="btn plain" type="button" id="copy">Copy</button></div>
      </div>`.__html;
    document.getElementById('copy').addEventListener('click', () => {
      const input = document.getElementById('link');
      input.select();
      navigator.clipboard?.writeText(input.value);
    });
  });
}

const MISSED_STATUS = {
  open: ['wait', 'Not decided'], added: ['ok', 'Added from the software report'], counted: ['ok', 'Counted'],
  left_out: ['', 'Left out'], other_day: ['', 'Written on another day'], carried: ['', 'Carried forward'],
};

/**
 * Missed entries (approved 7 Nov 2026): bills the register missed, bills the software missed, and money in the bank
 * with neither. Totals per shift, then each line with a link to where it is handled.
 */
function missedReport(biz, m) {
  const sum = (xs) => xs.reduce((t, x) => t + (x.amountPaise ?? 0), 0);
  const days = [...new Set([...m.notInRegister, ...m.notInSoftware, ...m.inNeither].map((x) => x.day))].sort();
  const per = (xs, d) => xs.filter((x) => x.day === d);
  const cell = (xs) => (xs.length ? html`${xs.length} · ₹ ${money(sum(xs))}` : html`<span class="tiny">–</span>`);
  const shiftLink = (d) => html`<a href="#/b/${biz.id}/compare/${d}">${dayLabel(d)}</a>`;
  const status = (x) => { const [k, l] = MISSED_STATUS[x.status] ?? ['', x.status]; return html`<span class="chip ${k}">${l}${x.otherDay ? ` (${dayLabel(x.otherDay)})` : ''}</span>`; };
  const billTable = (xs, timed) => (xs.length ? html`<div class="scroll"><table style="min-width:640px">
    <thead><tr><th>Shift</th><th>Bill</th>${timed ? html`<th>Time</th>` : ''}<th style="text-align:right">Amount ₹</th><th>Mode</th><th>What was decided</th><th>Note</th></tr></thead>
    <tbody>${xs.map((x) => html`<tr><td>${shiftLink(x.day)}</td><td class="mono">${x.billNo}</td>${timed ? html`<td>${x.paidAt ? when(x.paidAt) : ''}</td>` : ''}
      <td class="amount">${money(x.amountPaise ?? 0)}</td><td>${MODE_LABELS[x.mode] ?? x.mode ?? ''}</td><td>${status(x)}</td><td class="note">${x.note ?? ''}</td></tr>`)}</tbody>
  </table></div>` : html`<div class="ok-msg">None in these shifts.</div>`);
  const canBank = biz.actions.includes('bank.link');
  const part = (title, why, xs, body) => html`<div style="display:flex;flex-direction:column;gap:6px">
    <h3 style="margin:6px 0 0">${title} <span class="chip">${xs.length}</span> <span class="note">₹ ${money(sum(xs))}</span></h3><div class="note">${why}</div>${body}</div>`;
  return html`<section class="card" style="gap:12px" id="missed">
    <h2>Missed entries</h2>
    <div class="note">What one record left out: a bill missed in the register, a bill missed in the software report, or money in the bank with no bill in either.</div>
    <form class="form-row repdates" style="align-items:flex-end">
      <div class="field"><label for="misfrom">From shift</label><input id="misfrom" type="date" name="from" value="${m.from}" required></div>
      <div class="field"><label for="misto">To shift</label><input id="misto" type="date" name="to" value="${m.to}" required></div>
      <button class="btn plain" type="submit">Show</button>
    </form>
    ${days.length ? html`<div class="scroll"><table style="min-width:560px">
      <thead><tr><th>Shift</th><th>Missed in register</th><th>Missed in software</th><th>Missed in both</th></tr></thead>
      <tbody>${days.map((d) => html`<tr><td>${shiftLink(d)}</td><td>${cell(per(m.notInRegister, d))}</td><td>${cell(per(m.notInSoftware, d))}</td><td>${cell(per(m.inNeither, d))}</td></tr>`)}
        <tr><td><strong>All</strong></td><td><strong>${cell(m.notInRegister)}</strong></td><td><strong>${cell(m.notInSoftware)}</strong></td><td><strong>${cell(m.inNeither)}</strong></td></tr></tbody>
    </table></div>` : ''}
    ${part('Missed in the register', 'In the software report, but nobody wrote it in the register.', m.notInRegister, billTable(m.notInRegister, true))}
    ${part('Missed in the software', html`Written in the register, but not in the software report.${m.oldPos?.count ? html` Old POS bills are left out: they are never in the software report (${m.oldPos.count} · ₹ ${money(m.oldPos.paise)}).` : ''}`, m.notInSoftware, billTable(m.notInSoftware, false))}
    ${part('Missed in both', 'Money that came into the bank by UPI with no bill in the register or the software: booked under a head, or still not matched after its shift was confirmed.', m.inNeither,
      m.inNeither.length ? html`<div class="scroll"><table style="min-width:700px">
        <thead><tr><th>Shift</th><th>Received</th><th style="text-align:right">Amount ₹</th><th>Account</th><th>From / remark</th><th>Now</th></tr></thead>
        <tbody>${m.inNeither.map((x) => html`<tr><td>${canBank ? html`<a href="#/b/${biz.id}/reconcile/${x.day}">${dayLabel(x.day)}</a>` : dayLabel(x.day)}</td><td>${when(x.postedAt)}</td>
          <td class="amount">${money(x.amountPaise)}</td><td>${x.accountName ?? ''}</td>
          <td class="note">${[x.vpa, x.remark && !/^(UPI|NA|NO REMARKS?)$/i.test(x.remark) ? x.remark : null].filter(Boolean).join(' · ')}</td>
          <td>${x.status === 'booked' ? html`<span class="chip ok">Booked</span> <span class="note">${x.headName ?? ''}${x.note ? ` · ${x.note}` : ''}</span>` : html`<span class="chip wait">Not matched</span>`}</td></tr>`)}</tbody>
      </table></div>` : html`<div class="ok-msg">None in these shifts.</div>`)}
  </section>`;
}

/**
 * Complimentary bills (approved 13 Nov 2026): ₹0 bills with no money paid, with the guest's name from the software report
 * and the register's remarks, and the value given free over the shifts chosen (a subtotal per month when there are several).
 */
function complimentaryReport(biz, cp) {
  const months = [...new Set(cp.lines.map((l) => l.day.slice(0, 7)))];
  const monthName = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const IN = { both: 'Software and register', software: 'Software only', register: 'Register only' };
  const row = (l) => html`<tr>
    <td><a href="#/b/${biz.id}/compare/${l.day}">${dayLabel(l.day)}</a></td>
    <td class="mono">${l.rowId && biz.actions.includes('rows.edit') ? html`<a href="#/b/${biz.id}/review/${l.uploadId}/${l.rowId}">${l.billNo}</a>` : l.billNo}</td>
    <td>${l.billType === 'room' ? 'Room' : l.billType === 'fnb' ? 'F&B' : ''}</td>
    <td>${l.name ?? html`<span class="note">No name</span>`}${l.why === 'prepaid' ? html` <span class="tiny">PREPAID</span>` : l.why === 'marked' ? html` <span class="tiny">made complimentary</span>` : ''}</td>
    <td class="note">${l.remarks ?? ''}</td>
    <td class="amount">${l.valuePaise != null ? money(l.valuePaise) : html`<span class="note">Not shown</span>`}</td>
    <td class="note">${IN[l.in]}</td></tr>`;
  const sub = (ym) => { const ls = cp.lines.filter((l) => l.day.startsWith(ym)); return html`<tr><td colspan="5"><strong>${monthName(ym)}</strong> · ${ls.length} bill${ls.length > 1 ? 's' : ''}</td>
    <td class="amount"><strong>${money(ls.reduce((t, l) => t + (l.valuePaise ?? 0), 0))}</strong></td><td></td></tr>`; };
  return html`<section class="card" id="comps" style="gap:10px">
    <h2>Complimentary bills</h2>
    <div class="note">Bills never counted as sales: PREPAID in the software, made complimentary by a person (with the guest's name), or ₹0 with no money paid. The name is the guest a person gave, else the software report's; the remarks come from the register. Value is the software's amount, or the bill before it came to ₹0. A row that comes to ₹0 under its group's discount is paid with its group and is not listed.</div>
    <form class="repdates form-row" style="align-items:flex-end">
      <div class="field"><label for="cpfrom">From shift</label><input id="cpfrom" type="date" name="from" value="${cp.from}" required></div>
      <div class="field"><label for="cpto">To shift</label><input id="cpto" type="date" name="to" value="${cp.to}" required></div>
      <button class="btn plain" type="submit">Show</button>
    </form>
    ${cp.lines.length ? html`<div class="note"><strong>${cp.count} complimentary bill${cp.count > 1 ? 's' : ''}</strong> · ₹ ${money(cp.valuePaise)} given free${cp.noName ? ` · ${cp.noName} with no name or remark` : ''}</div>
    <div class="scroll"><table style="min-width:760px">
      <thead><tr><th>Shift</th><th>Bill</th><th>Type</th><th>Name</th><th>Remarks</th><th style="text-align:right">Value ₹</th><th>Found in</th></tr></thead>
      <tbody>${months.length > 1 ? months.map((ym) => html`${cp.lines.filter((l) => l.day.startsWith(ym)).map(row)}${sub(ym)}`) : cp.lines.map(row)}</tbody>
    </table></div>
    ${cp.noName ? html`<div class="note">Bills with no name may be from reports imported before 12 Nov: upload the same software report again and press <strong>Add names</strong>.</div>` : ''}` : html`<div class="ok-msg">No complimentary bills in these shifts.</div>`}
  </section>`;
}

/** Reports: discounts over the limit, for a person to look through. They need no decision on Compare sales. */
async function reportsView(biz, query) {
  const q = new URLSearchParams(query);
  // One day by default (17 Nov 2026); a range when From and To are given.
  if (!q.get('from') && !q.get('to')) return reportDayView(biz, q.get('day'));
  const range = new URLSearchParams({ from: q.get('from') ?? '', to: q.get('to') ?? '' });
  const [r, m, cp] = await Promise.all([api('GET', `/businesses/${biz.id}/reports/large-discounts?${range}`), api('GET', `/businesses/${biz.id}/reports/missed?${range}`),
    api('GET', `/businesses/${biz.id}/reports/complimentary?${range}`)]);
  const total = r.lines.reduce((t, l) => t + l.discountPaise, 0);
  render(shell(biz, 'reports', 'Reports', '', html`
    ${reportTabs(biz, 'checks')}
    ${reportModeHtml(biz, 'range', r.to)}
    ${missedReport(biz, m)}
    <section class="card" style="gap:10px">
      <h2>Large discounts</h2>
      <div class="note">Discounts over ${r.limitPct}% of the bills, one line per payment. Look for a payment that was missed in the register. Nothing here stops a shift being confirmed.</div>
      <form id="repdates" class="form-row" style="align-items:flex-end">
        <div class="field"><label for="repfrom">From shift</label><input id="repfrom" type="date" name="from" value="${r.from}" required></div>
        <div class="field"><label for="repto">To shift</label><input id="repto" type="date" name="to" value="${r.to}" required></div>
        <button class="btn plain" type="submit">Show</button>
      </form>
      ${r.lines.length ? html`<div class="note"><strong>${r.lines.length} large discount${r.lines.length > 1 ? 's' : ''}</strong> · ₹ ${money(total)} in all</div>
      <div class="scroll"><table style="min-width:760px">
        <thead><tr><th>Shift</th><th>Bills</th><th style="text-align:right">Bills ₹</th><th style="text-align:right">Discount ₹</th><th style="text-align:right">%</th><th style="text-align:right">Paid ₹</th><th>Mode</th><th style="text-align:right">Software ₹</th><th>Remarks</th></tr></thead>
        <tbody>${r.lines.map((l) => html`<tr>
          <td><a href="#/b/${biz.id}/compare/${l.day}">${dayLabel(l.day)}</a></td>
          <td class="mono" style="white-space:normal">${biz.actions.includes('rows.edit') ? html`<a href="#/b/${biz.id}/review/${l.uploadId}/${l.rowId}">${l.billNos.join(' + ')}</a>` : l.billNos.join(' + ')}</td>
          <td class="amount">${money(l.billsPaise)}</td><td class="amount">${money(l.discountPaise)}</td><td class="amount">${l.pct}</td><td class="amount">${money(l.paidPaise)}</td>
          <td>${l.modes.map((m) => MODE_LABELS[m] ?? m).join(', ') || 'None written'}</td><td class="amount">${money(l.softwarePaise)}</td><td class="note">${l.remarks ?? ''}</td></tr>`)}</tbody>
      </table></div>` : html`<div class="ok-msg">No large discounts in these shifts.</div>`}
    </section>
    ${complimentaryReport(biz, cp)}`));
  wireShell();
  // The reports share one range: any form sets it.
  document.querySelectorAll('#repdates, #missed .repdates, #comps .repdates').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = new FormData(e.target);
    location.hash = `#/b/${biz.id}/reports?${new URLSearchParams({ from: d.get('from'), to: d.get('to') })}`;
  }));
}

/** Day or Range, for the bills to look at. */
function reportModeHtml(biz, mode, day) {
  const d = day ?? currentShiftDay();
  return html`<div class="seg" role="tablist" aria-label="Day or range" style="margin:0 0 10px;width:max-content;display:inline-flex">
    <a role="tab" href="#/b/${biz.id}/reports?day=${d}" class="${mode === 'day' ? 'on' : ''}" aria-selected="${mode === 'day'}">Day</a>
    <a role="tab" href="#/b/${biz.id}/reports?${new URLSearchParams({ from: addDaysIso(d, -30), to: d })}" class="${mode === 'range' ? 'on' : ''}" aria-selected="${mode === 'range'}">Range</a></div>`;
}
const timeOf = (ms) => (ms == null ? '' : new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms)).toLowerCase());

/**
 * Bills to look at for one day (approved 17 Nov 2026): bills missed in the register or the software, money with no bill,
 * and payments not received in red. Paid or not is Reconcile's own picture (bank credits, the card machine and matches
 * made by hand), so it says the same as Reconcile. Bills in both that match are left out, except one whose money is
 * not in: it is listed at the top.
 */
const reportLastDay = new Map();
async function reportDayView(biz, dayIn) {
  let day = /^\d{4}-\d{2}-\d{2}$/.test(dayIn ?? '') ? dayIn : null;
  // The last shift with bills, asked once per session (19 Nov 2026): it used to work out a month of missed bills first.
  if (!day) day = reportLastDay.get(biz.id);
  if (!day) {
    day = (await api('GET', `/businesses/${biz.id}/reports/missed?${new URLSearchParams({ to: currentShiftDay(), lastOnly: '1' })}`)).lastDay ?? currentShiftDay();
    reportLastDay.set(biz.id, day);
    setTimeout(() => reportLastDay.delete(biz.id), 10 * 60 * 1000);
  }
  const range = new URLSearchParams({ from: day, to: day });
  const canBank = biz.actions.includes('bank.link');
  // In one trip (19 Nov 2026), like the Shift page.
  const parts = apiMany([`/businesses/${biz.id}/reports/missed?${range}`, `/businesses/${biz.id}/reports/large-discounts?${range}`,
    `/businesses/${biz.id}/reports/complimentary?${range}`, `/businesses/${biz.id}/shifts/${day}/cash`, ...(canBank ? [`/businesses/${biz.id}/shifts/${day}/reconcile`] : [])]);
  const [m, d, cp, cash, rc] = await Promise.all([parts[0], parts[1], parts[2], parts[3].catch(() => null), canBank ? parts[4].catch(() => null) : null]);
  const bankIn = !!rc?.coverage?.covered;
  const cardsIn = !!rc?.cards?.covered;
  // Payments not received, the same rule as To do's Waiting card (18 Nov 2026): UPI bills with no credit, card bills with
  // no machine payment, and cash bills not in the register more than 2 days with the cash short.
  const oneSided = [...m.notInRegister.map((x) => ({ ...x, side: 'software' })), ...m.notInSoftware.map((x) => ({ ...x, side: 'register' }))]
    .filter((x) => x.status !== 'left_out' && x.status !== 'added')
    .map((x) => ({ comparisonId: x.comparisonId, billNo: x.billNo, amountPaise: x.amountPaise ?? 0, mode: x.mode, side: x.side, paidAt: x.paidAt,
      otherDay: x.lateDay ? { day: x.lateDay } : x.otherDay ? { day: x.otherDay } : null, oldPos: false }));
  const split = waitSplit({ day, rc: canBank ? rc : null, cash, oneSided });
  const unpaid = split.notReceived;
  const unpaidNos = new Set(unpaid.flatMap((x) => x.billNo.split(' + ')));
  const sum = (xs) => xs.reduce((t, x) => t + (x.amountPaise ?? 0), 0);
  // A missed bill added to the register since now matches: left out here.
  const inReg = m.notInRegister.filter((x) => x.status !== 'added');
  const payCell = (x) => {
    if (unpaidNos.has(x.billNo)) return html`<td class="rd-bad">Not received</td>`;
    if (x.status === 'left_out') return html`<td class="note">Not expected</td>`;
    if (x.mode === 'cash') { const w = split.cashWait.find((y) => y.billNo === x.billNo); const lt = split.paperwork.find((y) => y.billNo === x.billNo && y.late); const nr = split.notReceived.find((y) => y.billNo === x.billNo);
      return w ? html`<td class="rd-wait">Waiting, day ${Math.max(1, w.age)} of ${CASH_WATCH_DAYS}</td>` : lt ? html`<td class="note">Written late: ${dayLabel(lt.late.day)} register${lt.late.amountPaise != null ? ` · ₹ ${rs(lt.late.amountPaise)}` : ''}</td>` : nr ? html`<td class="rd-bad">Not received</td>` : html`<td class="note">In the cash count</td>`; }
    if (x.mode === 'upi') return bankIn ? html`<td class="rd-ok">✓ Received</td>` : html`<td class="note">Bank not in yet</td>`;
    if (x.mode === 'mixed') return bankIn ? html`<td class="rd-ok">✓ UPI part received</td>` : html`<td class="note">Bank not in yet</td>`;
    if (x.mode === 'card') return cardsIn ? html`<td class="rd-ok">✓ Received</td>` : html`<td class="note">Card report not in yet</td>`;
    return html`<td class="note">Not known</td>`;
  };
  const decided = (x) => { const [, l] = MISSED_STATUS[x.status] ?? ['', x.status]; return html`${l}${x.otherDay ? ` (${dayLabel(x.otherDay)})` : ''}${x.note ? html` · <span class="note">${x.note}</span>` : ''}`; };
  const rows = (xs, timed) => xs.map((x) => html`<tr class="${unpaidNos.has(x.billNo) ? 'rd-red' : ''}"><td class="mono">${x.billNo}</td>${timed ? html`<td>${timeOf(x.paidAt)}</td>` : ''}
    <td class="amount">${rs(x.amountPaise ?? 0)}</td><td>${MODE_LABELS[x.mode] ?? x.mode ?? 'Not known'}</td>${payCell(x)}<td>${decided(x)}</td></tr>`);
  const head = (timed) => html`<thead><tr><th>Bill</th>${timed ? html`<th>Time</th>` : ''}<th style="text-align:right">₹</th><th>Mode</th><th>Payment</th><th>Decided</th></tr></thead>`;
  const tile = (label, big, small, red) => html`<div class="rd-tile ${red ? 'red' : ''}"><div class="rd-l">${label}</div><div class="rd-big">${big}</div><div class="rd-s">${small}</div></div>`;
  const status = rc ? (rc.confirmed ? 'Shift saved' : 'Shift not saved yet') : '';
  const largeTotal = d.lines.reduce((t, l) => t + l.discountPaise, 0);
  render(shell(biz, 'reports', 'Reports', '', html`
    ${reportTabs(biz, 'checks')}
    ${reportModeHtml(biz, 'day', day)}
    <section class="card" style="gap:12px" id="dayreport">
      <div class="form-row" style="align-items:center;gap:8px;flex-wrap:wrap">
        <a class="btn plain" href="#/b/${biz.id}/reports?day=${addDaysIso(day, -1)}" aria-label="Previous day">‹</a>
        <h2 style="margin:0">${dayLabel(day)}</h2>
        <a class="btn plain" href="#/b/${biz.id}/reports?day=${addDaysIso(day, 1)}" aria-label="Next day">›</a>
        <input type="date" id="rdday" value="${day}" aria-label="Choose a day" style="max-width:160px">
        ${status ? html`<span class="chip">${status}</span>` : ''}
        <span style="flex:1"></span>
        <a href="#/b/${biz.id}/compare/${day}">Compare sales</a>${canBank ? html` · <a href="#/b/${biz.id}/reconcile/${day}">Reconcile</a>` : ''}
      </div>
      <div class="rd-tiles">
        ${tile('Missed in the register', inReg.length ? `${inReg.length} bill${inReg.length > 1 ? 's' : ''}` : 'None', inReg.length ? `₹ ${rs(sum(inReg))}` : '', false)}
        ${tile('Missed in the software', m.notInSoftware.length ? `${m.notInSoftware.length} bill${m.notInSoftware.length > 1 ? 's' : ''}` : 'None',
          m.notInSoftware.length ? `₹ ${rs(sum(m.notInSoftware))}` : m.oldPos?.count ? `${m.oldPos.count} old POS bills not counted` : '', false)}
        ${canBank ? tile('Payment not received', unpaid.length ? `₹ ${rs(sum(unpaid))}` : bankIn ? 'None' : '–',
          unpaid.length ? `${unpaid.length} bill${unpaid.length > 1 ? 's' : ''}` : bankIn ? 'all received' : 'bank not in yet', unpaid.length > 0) : ''}
        ${tile('Money with no bill', m.inNeither.length ? `${m.inNeither.length} credit${m.inNeither.length > 1 ? 's' : ''}` : 'None', m.inNeither.length ? `₹ ${rs(sum(m.inNeither))}` : '', false)}
      </div>
      ${unpaid.length ? html`<div class="rd-box red">
        <h3>Payment not received</h3>
        <div class="scroll"><table style="min-width:560px"><thead><tr><th>Bill</th><th>Time</th><th style="text-align:right">₹</th><th>Mode</th><th>What was looked at</th></tr></thead>
          <tbody>${unpaid.map((x) => html`<tr class="rd-red"><td class="mono">${x.billNo}</td><td>${timeOf(x.paidAt)}</td><td class="amount">${x.amountPaise == null ? '' : rs(x.amountPaise)}</td>
            <td>${MODE_LABELS[x.mode] ?? x.mode}</td><td class="rd-bad">${x.why}</td></tr>`)}</tbody></table></div>
        <div class="note">Paid or not is as on Reconcile: bank credits, the card machine and matches made there.</div></div>` : ''}
      ${(rc?.columnHints ?? []).length ? html`<div class="rd-box"><h3>Paid into another account than written <span class="note">· ${rc.columnHints.length} bill${rc.columnHints.length > 1 ? 's' : ''}</span></h3>
        ${rc.columnHints.map((h) => html`<div class="list-row"><span><span class="mono">${h.billNo ?? ''}</span> · ₹ ${money(h.amountPaise)} written under ${h.fromLabel}, came into ${h.accountName} at ${timeOf(h.postedAt)}</span></div>`)}
        <div class="note">Change the column or match as written on <a href="#/b/${biz.id}/reconcile/${day}">Reconcile</a>, UPI tab.</div></div>` : ''}
      ${split.found.length ? html`<div class="rd-box"><h3>Payment found, to match <span class="note">· money of about its amount came in, not matched yet</span></h3>
        ${split.found.map((x) => html`<div class="list-row"><span><span class="mono">${x.billNo}</span> · ${MODE_LABELS[x.mode] ?? x.mode} ${timeOf(x.paidAt)} · ₹ ${money(x.offer.amountPaise)} at ${timeOf(x.offer.at)}</span><span class="amount">${rs(x.amountPaise)}</span></div>`)}</div>` : ''}
      <div class="rd-box">
        <h3>Missed in the register <span class="note">· in the software, not written in the register</span></h3>
        ${inReg.length ? html`<div class="scroll"><table style="min-width:600px">${head(true)}<tbody>${rows(inReg, true)}</tbody></table></div>` : html`<div class="ok-msg">None on this day.</div>`}
      </div>
      <div class="rd-box">
        <h3>Missed in the software <span class="note">· written in the register, not in the software</span></h3>
        ${m.notInSoftware.length ? html`<div class="scroll"><table style="min-width:560px">${head(false)}<tbody>${rows(m.notInSoftware, false)}</tbody></table></div>` : html`<div class="ok-msg">None on this day.</div>`}
        ${m.oldPos?.count ? html`<div class="note">${m.oldPos.count > 1 ? `${m.oldPos.count} old POS bills (₹ ${rs(m.oldPos.paise)}) are` : `1 old POS bill (₹ ${rs(m.oldPos.paise)}) is`} never in the software report, so not counted here.${unpaid.length ? ' Any whose money is not in is listed above.' : ''}</div>` : ''}
      </div>
      <div class="rd-box">
        <h3>Money with no bill <span class="note">· not in the software or the register</span></h3>
        ${m.inNeither.length ? html`<div class="scroll"><table style="min-width:560px"><thead><tr><th>Time</th><th style="text-align:right">₹</th><th>From</th><th>Now</th></tr></thead>
          <tbody>${m.inNeither.map((x) => html`<tr><td>${timeOf(x.postedAt)}</td><td class="amount">${rs(x.amountPaise)}</td>
            <td class="note">${[x.vpa, x.remark && !/^(UPI|NA|NO REMARKS?)$/i.test(x.remark) ? x.remark : null].filter(Boolean).join(' · ')}</td>
            <td>${x.status === 'booked' ? html`Booked <span class="note">${x.headName ?? ''}${x.note ? ` · ${x.note}` : ''}</span>` : 'Not matched'}</td></tr>`)}</tbody></table></div>`
          : html`<div class="ok-msg">None on this day.</div>`}
      </div>
      ${(m.shortages ?? []).map((x) => html`<div class="note"><span class="chip bad">Cash shortage booked</span> ₹ ${money(x.amountPaise)}${x.billNo ? ` · bill ${x.billNo} not received` : ''}${x.note ? ` · ${x.note}` : ''}</div>`)}
      ${(m.cashRevised ?? []).map((x) => html`<div class="note">Cash sheet figures changed from the photo: <strong>${({ revised: 'sheet revised, the new one not uploaded', misread: 'the photo was misread', other: 'other' })[x.reason] ?? x.reason}</strong>${x.note ? ` · ${x.note}` : ''}.
        ${biz.actions.includes('rows.edit') ? html`<a href="#/b/${biz.id}/review/${x.uploadId}">Open the cash sheet</a>` : ''}</div>`)}
      <details class="rd-more"><summary>Large discounts · ${d.lines.length ? `${d.lines.length} · ₹ ${rs(largeTotal)}` : 'none'}</summary>
        ${d.lines.length ? html`<div class="scroll"><table style="min-width:640px"><thead><tr><th>Bills</th><th style="text-align:right">Bills ₹</th><th style="text-align:right">Discount ₹</th><th style="text-align:right">%</th><th style="text-align:right">Paid ₹</th><th>Remarks</th></tr></thead>
          <tbody>${d.lines.map((l) => html`<tr><td class="mono" style="white-space:normal">${biz.actions.includes('rows.edit') ? html`<a href="#/b/${biz.id}/review/${l.uploadId}/${l.rowId}">${l.billNos.join(' + ')}</a>` : l.billNos.join(' + ')}</td>
            <td class="amount">${rs(l.billsPaise)}</td><td class="amount">${rs(l.discountPaise)}</td><td class="amount">${l.pct}</td><td class="amount">${rs(l.paidPaise)}</td><td class="note">${l.remarks ?? ''}</td></tr>`)}</tbody></table></div>` : ''}
      </details>
      <details class="rd-more"><summary>Complimentary · ${cp.count ? `${cp.count} · ₹ ${rs(cp.valuePaise)}` : 'none'}</summary>${cp.count ? complimentaryReport(biz, cp) : ''}</details>
    </section>`));
  wireShell();
  document.getElementById('rdday')?.addEventListener('change', (e) => { if (e.target.value) location.hash = `#/b/${biz.id}/reports?day=${e.target.value}`; });
  document.querySelectorAll('#comps .repdates').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    location.hash = `#/b/${biz.id}/reports?${new URLSearchParams({ from: fd.get('from'), to: fd.get('to') })}`;
  }));
}

/** Reports tabs: the checks (missed, discounts, complimentary) and Funds flow (bank data: Owner and Accountant). */
function reportTabs(biz, active) {
  // Pending bills and Bank statement (approved 19 Nov 2026) sit between the checks and Funds flow, each for those allowed.
  const can = (a) => biz.actions.includes(a);
  const tabs = [can('reports.view') && ['checks', 'Bills to look at', `#/b/${biz.id}/reports`], can('sales.view') && ['bills', 'All bills', `#/b/${biz.id}/bills`],
    can('sales.view') && ['pending', 'Pending bills', `#/b/${biz.id}/pending`],
    can('bank.link') && ['statement', 'Bank statement', `#/b/${biz.id}/statement`], can('bank.link') && ['funds', 'Funds flow', `#/b/${biz.id}/funds`]].filter(Boolean);
  if (tabs.length < 2) return '';
  return html`<div class="seg mode-tabs" role="tablist" aria-label="Reports" style="margin:4px 0 10px">${tabs.map(([k, l, href]) => html`<a role="tab" href="${href}" class="${k === active ? 'on' : ''}" aria-selected="${k === active}">${l}</a>`)}</div>`;
}

/** A CSV file saved from the page (opens in Excel). */
function saveCsv(name, rows) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const rupeesCsv = (p) => (p == null ? '' : (p / 100).toFixed(2));

// Reports → Pending bills (approved 19 Nov 2026): the groups of a shift's To do, over every shift in the range.
const PENDING_GROUPS = [
  ['not_received', 'Payment not received', 'bad'],
  ['cash_short', 'Short in the cash count', 'wait'],
  ['cash_wait', 'Cash bills not in the register', 'wait'],
  ['found', 'Payment found, to match', 'info'],
  ['paperwork', 'Money in, the paperwork differs', ''],
  ['other', 'Other', ''],
];
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card' };
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

async function pendingView(biz, query) {
  const q = new URLSearchParams(query);
  const view = q.get('view') === 'received' ? 'received' : 'due';
  const mode = MODE_LABEL[q.get('mode')] ? q.get('mode') : '';
  const group = PENDING_GROUPS.some(([k]) => k === q.get('group')) ? q.get('group') : '';
  const range = new URLSearchParams();
  if (q.get('from')) range.set('from', q.get('from'));
  if (q.get('to')) range.set('to', q.get('to'));
  const r = await api('GET', `/businesses/${biz.id}/reports/pending?${range}`);
  const link = (over) => { const o = { from: r.from, to: r.to, view, mode, group, ...over }; for (const k of Object.keys(o)) if (!o[k] || (k === 'view' && o[k] === 'due')) delete o[k]; return `#/b/${biz.id}/pending?${new URLSearchParams(o)}`; };
  const byMode = (x) => !mode || x.mode === mode;
  const due = r.toReceive.filter(byMode);
  const got = r.received.filter(byMode);
  const sum = (xs) => xs.reduce((t, x) => t + x.amountPaise, 0);
  const open = (x) => `#/b/${biz.id}/reconcile/${x.day}?top=wait`;
  const dueRow = (x) => html`<tr><td>${shortDay(x.day)}</td><td class="mono">${x.billNo}</td><td class="amount">${rs(x.amountPaise)}</td>
    <td>${x.reason.startsWith(MODE_LABEL[x.mode] ?? '\u0000') ? '' : `${MODE_LABEL[x.mode] ?? 'No mode'} · `}${x.reason} <a href="${open(x)}">Open ›</a></td>
    <td class="amount">${x.daysWaiting} day${x.daysWaiting === 1 ? '' : 's'}</td></tr>`;
  const groups = PENDING_GROUPS.filter(([k]) => !group || k === group).map(([k, label, cls]) => {
    const xs = due.filter((x) => x.group === k);
    if (!xs.length) return '';
    return html`<section class="card" style="gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap"><h2>${label}</h2><span class="chip ${cls}">${xs.length} bill${xs.length === 1 ? '' : 's'} · ₹ ${rs(sum(xs))}</span></div>
      <div class="scroll"><table style="min-width:620px"><thead><tr><th>Shift</th><th>Bill</th><th style="text-align:right">Amount ₹</th><th>Why</th><th style="text-align:right">Waiting</th></tr></thead>
      <tbody>${xs.map(dueRow)}</tbody></table></div></section>`;
  });
  const how = { changed: 'Changed after saving', late_credit: 'UPI credit came later', late_register: 'Written in a later register' };
  const gotRow = (x) => html`<tr><td>${shortDay(x.day)}</td><td class="mono">${x.billNo}</td><td class="amount">${rs(x.amountPaise)}</td>
    <td>${x.detail}${x.shortage ? ` · short on ${shortDay(x.day)} ₹ ${rs(x.shortage.fromPaise)} → ₹ ${rs(x.shortage.toPaise)}` : ''}${x.by ? ` · by ${x.by}${x.at ? `, ${shortDay(new Date(x.at + IST_MS).toISOString().slice(0, 10))}` : ''}` : ''}
      <a href="${open(x)}">Open ›</a><div class="tiny">${how[x.how]}</div></td>
    <td class="amount">${x.lateDays == null ? '' : `${x.lateDays} day${x.lateDays === 1 ? '' : 's'}`}</td></tr>`;
  const csv = () => saveCsv(`pending-bills-${view === 'due' ? 'to-receive' : 'received'}-${r.from}-to-${r.to}.csv`, view === 'due'
    ? [['Shift', 'Bill', 'Amount', 'Mode', 'Group', 'Why', 'Days waiting'], ...due.filter((x) => !group || x.group === group).map((x) => [x.day, x.billNo, rupeesCsv(x.amountPaise), MODE_LABEL[x.mode] ?? '', PENDING_GROUPS.find(([k]) => k === x.group)?.[1] ?? x.group, x.reason, x.daysWaiting])]
    : [['Shift', 'Bill', 'Amount', 'Was', 'Came as', 'Paid on', 'How', 'Detail', 'By', 'Days late'], ...got.map((x) => [x.day, x.billNo, rupeesCsv(x.amountPaise), x.from ?? '', MODE_LABEL[x.mode] ?? x.mode, x.paidOn ?? '', how[x.how], x.detail, x.by ?? '', x.lateDays ?? ''])]);
  render(shell(biz, 'reports', 'Reports', '', html`
    ${reportTabs(biz, 'pending')}
    <section class="card" style="gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="seg" role="tablist" aria-label="Pending bills">
          <a role="tab" href="${link({ view: 'due' })}" class="${view === 'due' ? 'on' : ''}" aria-selected="${view === 'due'}">To be received · ₹ ${rs(sum(due))}</a>
          <a role="tab" href="${link({ view: 'received', group: '' })}" class="${view === 'received' ? 'on' : ''}" aria-selected="${view === 'received'}">Already received · ₹ ${rs(sum(got))}</a></div>
        <button class="btn plain" type="button" id="pbcsv">Download CSV</button>
      </div>
      <form id="pbdates" class="form-row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
        <div class="field"><label for="pbfrom">From shift</label><input id="pbfrom" type="date" name="from" value="${r.from}" required></div>
        <div class="field"><label for="pbto">To shift</label><input id="pbto" type="date" name="to" value="${r.to}" required></div>
        <div class="field"><label for="pbmode">Mode</label><select id="pbmode" name="mode"><option value="">All modes</option>${Object.entries(MODE_LABEL).map(([k, l]) => html`<option value="${k}" ${k === mode ? 'selected' : ''}>${l}</option>`)}</select></div>
        <button class="btn plain" type="submit">Show</button>
      </form>
      ${view === 'due' && group ? html`<div class="note">Showing ${PENDING_GROUPS.find(([k]) => k === group)[1].toLowerCase()} only · <a href="${link({ group: '' })}">Show all groups</a></div>` : ''}
      <div class="note">${view === 'due' ? 'Bills whose money has not come. Open a bill to fix it on its own shift.' : 'Bills whose money came on a later day: changed after saving, a UPI credit that came after the shift, or a cash bill written in a later register.'}</div>
    </section>
    ${view === 'due' ? html`${groups.some((g) => g) ? groups : html`<div class="ok-msg">Nothing to be received in these shifts.</div>`}
      ${r.waitingForFiles ? html`<div class="note" style="padding:0 4px">Not listed: ${r.waitingForFiles} bill${r.waitingForFiles === 1 ? '' : 's'} waiting for a register page, a file or their shift to be saved. They join this list once they are overdue.</div>` : ''}`
    : got.length ? html`<section class="card" style="gap:8px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h2>Received on a later day</h2><span class="chip ok">${got.length} bill${got.length === 1 ? '' : 's'} · ₹ ${rs(sum(got))}</span></div>
      <div class="scroll"><table style="min-width:620px"><thead><tr><th>Shift</th><th>Bill</th><th style="text-align:right">Amount ₹</th><th>How it came</th><th style="text-align:right">Late by</th></tr></thead>
      <tbody>${got.map(gotRow)}</tbody></table></div></section>` : html`<div class="ok-msg">No bill in these shifts was paid on a later day.</div>`}
  `));
  document.getElementById('pbcsv').addEventListener('click', csv);
  document.getElementById('pbdates').addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; go(link({ from: f.from.value, to: f.to.value, mode: f.mode.value })); });
}

// Reports → Bank statement (approved 19 Nov 2026): the bank's lines as it wrote them, a tag in front saying how each was booked.
const TAG_CLASS = { bill: 'ok', card: 'info', transfer: 'info', fee: '', head: '', reversed: 'mute', ignored: 'mute', open: 'bad' };
const TAG_GROUP = { bill: 'UPI bills', card: 'Card settlements', transfer: 'Transfers', fee: 'UPI card fees', head: 'Booked to a head', reversed: 'Reversed pairs', ignored: 'Left out', open: 'Not booked' };
let stmtPrefs = { fees: true, reversed: true };
try { stmtPrefs = { ...stmtPrefs, ...JSON.parse(localStorage.getItem('bookr.stmtPrefs') || '{}') }; } catch { /* defaults */ }

async function statementView(biz, query) {
  const q = new URLSearchParams(query);
  const p = new URLSearchParams();
  for (const k of ['account', 'from', 'to']) if (q.get(k)) p.set(k, q.get(k));
  const { accounts, statement: s } = await api('GET', `/businesses/${biz.id}/reports/bank-statement?${p}`);
  if (!s) {
    render(shell(biz, 'reports', 'Reports', '', html`${reportTabs(biz, 'statement')}<section class="card"><h2>Bank statement</h2><div class="note">No bank statement lines yet. Bring them in on Bank → Statements.</div></section>`));
    return;
  }
  const tagFilter = TAG_GROUP[q.get('tag')] ? q.get('tag') : '';
  const isFee = (l) => l.kind === 'upi_fee';
  const isRev = (l) => l.tag.kind === 'reversed';
  const groupOf = (l) => (isFee(l) ? 'fee' : l.tag.kind);
  const link = (over) => { const o = { account: s.account.id, from: s.from, to: s.to, tag: tagFilter, ...over }; for (const k of Object.keys(o)) if (!o[k]) delete o[k]; return `#/b/${biz.id}/statement?${new URLSearchParams(o)}`; };
  const draw = () => {
    const shown = s.lines.filter((l) => (!tagFilter || groupOf(l) === tagFilter) && (stmtPrefs.fees || !isFee(l) || tagFilter === 'fee') && (stmtPrefs.reversed || !isRev(l) || tagFilter === 'reversed'));
    const counts = {};
    for (const l of s.lines) { const c = (counts[groupOf(l)] ??= { n: 0, in: 0, out: 0 }); c.n++; c[l.direction === 'CR' ? 'in' : 'out'] += l.amountPaise; }
    const chip = (k) => { const c = counts[k]; if (!c) return ''; const amt = [c.in ? `in ₹ ${rs(c.in)}` : '', c.out ? `out ₹ ${rs(c.out)}` : ''].filter(Boolean).join(' · ');
      return html`<a class="chip ${TAG_CLASS[k]}" style="text-decoration:none${tagFilter === k ? ';outline:2px solid currentColor' : ''}" href="${link({ tag: tagFilter === k ? '' : k })}">${TAG_GROUP[k]} ${c.n} · ${amt}</a>`; };
    const days = [...new Set(shown.map((l) => l.day))];
    const lastOf = (d) => [...s.lines].reverse().find((l) => l.day === d && l.balancePaise != null);
    const tagCls = (l) => (l.tag.kind === 'open' && isFee(l) ? 'wait' : TAG_CLASS[l.tag.kind]);
    const tag = (l) => html`<span class="chip ${tagCls(l)}" style="white-space:normal">${l.tag.label}</span>${l.tag.hint ? html`<div class="tiny">${l.tag.hint}</div>` : ''}`;
    const goTo = (l) => (l.tag.kind === 'open' ? `#/b/${biz.id}/bank?${new URLSearchParams({ tab: l.direction === 'CR' ? 'in' : 'out', from: l.shiftDay, to: l.shiftDay, account: s.account.id })}`
      : l.tag.kind === 'bill' ? `#/b/${biz.id}/reconcile/${l.shiftDay}` : l.tag.kind === 'card' ? `#/b/${biz.id}/cards` : null);
    const quiet = (l) => isFee(l) || isRev(l) || l.tag.kind === 'ignored';
    const row = (l) => html`<tr style="${quiet(l) ? 'color:var(--muted);font-size:12px' : ''}">
      <td>${goTo(l) ? html`<a href="${goTo(l)}" style="text-decoration:none">${tag(l)}</a>` : tag(l)}</td>
      <td style="white-space:nowrap">${timeOf(l.postedAt)}</td>
      <td style="word-break:break-word">${l.description}<div class="tiny mono">${l.tranId}</div></td>
      <td class="amount">${l.direction === 'DR' ? money(l.amountPaise) : ''}</td><td class="amount">${l.direction === 'CR' ? money(l.amountPaise) : ''}</td>
      <td class="amount">${l.balancePaise == null ? '' : money(l.balancePaise)}${l.balanceOk === false ? html`<div class="tiny" style="color:var(--danger)">doesn't follow: a line may be missing</div>` : ''}</td></tr>`;
    const body = days.map((d) => { const last = lastOf(d); return html`<tr><td colspan="6" style="background:var(--chip)"><strong>${dayLabel(d)}</strong>${last ? html`<span class="tiny" style="float:right">closing ₹ ${money(last.balancePaise)}</span>` : ''}</td></tr>${shown.filter((l) => l.day === d).map(row)}`; });
    const nIn = s.lines.filter((l) => l.direction === 'CR').length;
    const tile = (label, value, sub = '') => html`<div class="card" style="gap:2px;padding:10px 12px;flex:1 1 150px;box-shadow:none"><div class="tiny">${label}</div><div style="font-size:17px;font-weight:600">${value}</div>${sub}</div>`;
    render(shell(biz, 'reports', 'Reports', '', html`
      ${reportTabs(biz, 'statement')}
      <section class="card" style="gap:10px">
        <form id="stform" class="form-row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
          <div class="field"><label for="stacc">Account</label><select id="stacc" name="account">${accounts.map((a) => html`<option value="${a.id}" ${a.id === s.account.id ? 'selected' : ''}>${a.name}</option>`)}</select></div>
          <div class="field"><label for="stfrom">From</label><input id="stfrom" type="date" name="from" value="${s.from}" required></div>
          <div class="field"><label for="stto">To</label><input id="stto" type="date" name="to" value="${s.to}" required></div>
          <button class="btn plain" type="submit">Show</button>
          <span style="flex:1"></span>
          <button class="btn plain" type="button" id="stcsv">Download CSV</button>
        </form>
        <div class="note">${s.account.name}${s.account.accountNumber ? ` · ${s.account.accountNumber}` : ''} · ${s.lines.length} line${s.lines.length === 1 ? '' : 's'} as the bank wrote them, with how each was booked. Book open lines on Bank → Money in / Money out.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${tile('Opening balance', s.openingPaise == null ? '–' : `₹ ${money(s.openingPaise)}`)}
          ${tile(`In · ${nIn} line${nIn === 1 ? '' : 's'}`, `₹ ${money(s.inPaise)}`)}
          ${tile(`Out · ${s.lines.length - nIn} line${s.lines.length - nIn === 1 ? '' : 's'}`, `₹ ${money(s.outPaise)}`)}
          ${tile('Closing balance', s.closingPaise == null ? '–' : `₹ ${money(s.closingPaise)}`, html`<div class="tiny" style="color:var(${s.breaks ? '--danger' : '--ok'})">${s.openingPaise == null ? 'no balance on the statement' : s.breaks ? `${s.breaks} line${s.breaks === 1 ? '' : 's'} where the balance doesn't follow` : '✓ follows the bank on every line'}</div>`)}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${['bill', 'card', 'transfer', 'head', 'fee', 'reversed', 'ignored', 'open'].map(chip)}${tagFilter ? html`<a class="chip" style="text-decoration:none" href="${link({ tag: '' })}">Show all</a>` : ''}</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap" class="note">
          <label><input type="checkbox" id="sthidefees" ${stmtPrefs.fees ? '' : 'checked'}> Hide UPI card fees</label>
          <label><input type="checkbox" id="sthiderev" ${stmtPrefs.reversed ? '' : 'checked'}> Hide reversed pairs</label></div>
        ${s.truncated ? html`<div class="note" style="color:var(--danger)">Only the first 5,000 lines are shown: choose fewer days.</div>` : ''}
      </section>
      <section class="card" style="padding:8px 10px">
        ${shown.length ? html`<div class="scroll"><table style="min-width:760px;table-layout:fixed">
          <colgroup><col style="width:170px"><col style="width:70px"><col><col style="width:96px"><col style="width:96px"><col style="width:110px"></colgroup>
          <thead><tr><th>How it was booked</th><th>Time</th><th>Description, as the bank wrote it</th><th style="text-align:right">Debit ₹</th><th style="text-align:right">Credit ₹</th><th style="text-align:right">Balance ₹</th></tr></thead>
          <tbody>${body}</tbody></table></div>` : html`<div class="note">No lines${tagFilter ? ' with this tag' : ''} in these days.</div>`}
      </section>`));
    document.getElementById('stform').addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; go(link({ account: f.account.value, from: f.from.value, to: f.to.value, tag: '' })); });
    document.getElementById('stcsv').addEventListener('click', () => saveCsv(`${s.account.name.replace(/[^\w]+/g, '-')}-${s.from}-to-${s.to}.csv`, [
      ['Date', 'Time', 'Description', 'Reference', 'Debit', 'Credit', 'Balance', 'How it was booked', 'Detail'],
      ...s.lines.map((l) => [l.day, timeOf(l.postedAt), l.description, l.tranId, l.direction === 'DR' ? rupeesCsv(l.amountPaise) : '', l.direction === 'CR' ? rupeesCsv(l.amountPaise) : '', rupeesCsv(l.balancePaise), l.tag.label, l.tag.hint ?? ''])]));
    const pref = (id, key) => document.getElementById(id).addEventListener('change', (e) => { stmtPrefs[key] = !e.target.checked; try { localStorage.setItem('bookr.stmtPrefs', JSON.stringify(stmtPrefs)); } catch { /* fine */ } draw(); });
    pref('sthidefees', 'fees');
    pref('sthiderev', 'reversed');
  };
  draw();
}

// Reports → All bills (approved 19 Nov 2026): every bill with a tag, what was counted and how its payment came.
const BILL_TAGS = [['both', 'Both', 'ok'], ['differ', 'Both, amounts differ', 'wait'], ['register', 'Only register', 'info'], ['software', 'Only software', 'bad'], ['comp', 'Complimentary', 'mute']];
const MODE_SHORT = { cash: 'cash', upi: 'UPI', card: 'card', mixed: 'mixed', unknown: '–' };
let billsOpenOld = new Set();

async function allBillsView(biz, query) {
  const q = new URLSearchParams(query);
  const p = new URLSearchParams();
  for (const k of ['day', 'from', 'to']) if (q.get(k)) p.set(k, q.get(k));
  const r = await api('GET', `/businesses/${biz.id}/reports/bills?${p}`);
  const tagF = BILL_TAGS.some(([k]) => k === q.get('tag')) || q.get('tag') === 'notcome' ? q.get('tag') : '';
  const mode = MODE_LABEL[q.get('mode')] ? q.get('mode') : '';
  const find = (q.get('q') ?? '').trim();
  const oneDay = r.from === r.to;
  const link = (over) => { const o = { ...(oneDay ? { day: r.from } : { from: r.from, to: r.to }), tag: tagF, mode, q: find, ...over }; for (const k of Object.keys(o)) if (!o[k]) delete o[k]; return `#/b/${biz.id}/bills?${new URLSearchParams(o)}`; };
  const pass = (l) => (!tagF || (tagF === 'notcome' ? l.notCome : l.tag === tagF)) && (!mode || (l.counted?.mode ?? l.software?.mode ?? l.register?.mode) === mode) && (!find || l.billNo.includes(find));
  const draw = () => {
    const lines = r.lines.filter(pass);
    const n = (k) => r.lines.filter((l) => (k === 'notcome' ? l.notCome : l.tag === k)).length;
    const amt = (x) => (x?.amountPaise == null ? html`<span class="tiny">–</span>` : html`${rs(x.amountPaise)} <span class="tiny">${MODE_SHORT[x.mode] ?? x.mode ?? ''}</span>`);
    const tagHtml = (l) => { const [, label, cls] = BILL_TAGS.find(([k]) => k === l.tag);
      return html`<span class="chip ${cls}" style="white-space:normal">${label}</span>${l.tag === 'both' && l.apartPaise ? html`<div class="tiny">₹ ${rs(l.apartPaise)} apart</div>` : ''}${l.oldPos ? html`<div class="tiny">old POS</div>` : ''}${l.decision === 'leave_out' ? html`<div class="tiny">left out</div>` : ''}`; };
    const payHtml = (l) => (l.payment.length ? l.payment.map((x) => html`<div style="${x.bad ? 'color:var(--danger)' : x.kind === 'unsaved' ? 'color:var(--muted)' : ''}">${x.text}</div>`) : html`<span class="tiny">–</span>`);
    const row = (l) => html`<tr>
      <td>${tagHtml(l)}</td>
      <td class="mono"><a href="#/b/${biz.id}/compare/${l.day}">${l.billNo}</a>${l.paidAt ? html`<div class="tiny">${timeOf(l.paidAt)}</div>` : ''}</td>
      <td class="amount">${amt(l.software)}</td><td class="amount">${amt(l.register)}</td>
      <td>${l.counted ? html`₹ ${rs(l.counted.amountPaise)} ${MODE_SHORT[l.counted.mode] ?? ''}` : html`<span class="tiny">Not counted</span>`}${l.note && (l.tag !== 'register' || !l.oldPos) ? html`<div class="tiny">${l.note}</div>` : ''}</td>
      <td>${payHtml(l)}</td></tr>`;
    const days = [...new Set(lines.map((l) => l.day))];
    const body = days.map((d) => {
      const xs = lines.filter((l) => l.day === d);
      const old = xs.filter((l) => l.oldPos);
      const key = d;
      const openOld = billsOpenOld.has(key) || !!find;
      const byMode = {};
      for (const l of old) { const m = l.counted?.mode ?? l.register?.mode ?? '?'; byMode[m] = (byMode[m] ?? 0) + (l.counted?.amountPaise ?? l.register?.amountPaise ?? 0); }
      const oldTotal = Object.values(byMode).reduce((t, v) => t + v, 0);
      const oldBad = old.filter((l) => l.notCome).length;
      const foldRow = old.length ? html`<tr style="background:var(--chip)"><td><span class="chip info">Only register</span><div class="tiny">old POS</div></td>
        <td colspan="3"><strong>${old.length} old POS bill${old.length === 1 ? '' : 's'}</strong> <button class="linkbtn" type="button" data-oldpos="${key}">${openOld ? 'Hide' : 'Show'} ›</button></td>
        <td>₹ ${rs(oldTotal)}<div class="tiny">${Object.entries(byMode).sort((a, b) => b[1] - a[1]).map(([m, v]) => `${MODE_SHORT[m] ?? m} ${rs(v)}`).join(' · ')}</div></td>
        <td>${oldBad ? html`<span style="color:var(--danger)">${oldBad} with money not come</span>` : 'UPI credits and card payments, matched in groups'}</td></tr>` : '';
      return html`${days.length > 1 || !oneDay ? html`<tr><td colspan="6" style="background:var(--chip)"><strong>${dayLabel(d)}</strong> <span class="tiny">${xs.length} bill${xs.length === 1 ? '' : 's'}${r.savedDays.includes(d) ? ' · saved' : ' · not saved'}</span></td></tr>` : ''}
        ${foldRow}${openOld ? old.map(row) : ''}${xs.filter((l) => !l.oldPos).map(row)}`;
    });
    const sumOf = (xs, f) => xs.reduce((t, l) => t + (f(l) ?? 0), 0);
    const countedBy = {};
    for (const l of lines) if (l.counted) countedBy[l.counted.mode ?? '?'] = (countedBy[l.counted.mode ?? '?'] ?? 0) + l.counted.amountPaise;
    const notComeSum = sumOf(lines.filter((l) => l.notCome), (l) => l.counted?.amountPaise);
    const chip = (k, label, cls) => html`<a class="chip ${cls}" style="text-decoration:none${tagF === k ? ';outline:2px solid currentColor' : ''}" href="${link({ tag: tagF === k ? '' : k })}">${label} ${n(k)}</a>`;
    render(shell(biz, 'reports', 'Reports', '', html`
      ${reportTabs(biz, 'bills')}
      <section class="card" style="gap:10px">
        <form id="blform" class="form-row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
          ${oneDay ? html`<a class="btn plain" href="${link({ day: addDaysIso(r.from, -1) })}" aria-label="Day before">‹</a>` : ''}
          <div class="field"><label for="blfrom">${oneDay ? 'Shift' : 'From shift'}</label><input id="blfrom" type="date" name="from" value="${r.from}" required></div>
          <div class="field"><label for="blto">To shift</label><input id="blto" type="date" name="to" value="${r.to}" required></div>
          ${oneDay ? html`<a class="btn plain" href="${link({ day: addDaysIso(r.from, 1) })}" aria-label="Day after">›</a>` : ''}
          <div class="field"><label for="blmode">Mode</label><select id="blmode" name="mode"><option value="">All modes</option>${Object.entries(MODE_LABEL).map(([k, l]) => html`<option value="${k}" ${k === mode ? 'selected' : ''}>${l}</option>`)}</select></div>
          <div class="field"><label for="blq">Bill no.</label><input id="blq" name="q" value="${find}" inputmode="numeric" style="width:120px"></div>
          <button class="btn plain" type="submit">Show</button>
          <span style="flex:1"></span>
          <button class="btn plain" type="button" id="blcsv">Download CSV</button>
        </form>
        <div class="note">${r.lines.length} bill${r.lines.length === 1 ? '' : 's'} from the register and the software report${oneDay ? '' : ` over ${dayLabel(r.from)} to ${dayLabel(r.to)} (up to 31 shifts)`}. Old POS bills are folded into one line per shift. Press a bill to open its shift.</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${BILL_TAGS.map(([k, l, c]) => (n(k) ? chip(k, l, c) : ''))}${n('notcome') ? chip('notcome', 'Money not come', 'bad') : ''}${tagF ? html`<a class="chip" style="text-decoration:none" href="${link({ tag: '' })}">Show all</a>` : ''}</div>
        ${r.truncated ? html`<div class="note" style="color:var(--danger)">Only the first 6,000 bills are shown: choose fewer shifts.</div>` : ''}
      </section>
      <section class="card" style="padding:8px 10px">
        ${lines.length ? html`<div class="scroll"><table style="min-width:820px;table-layout:fixed">
          <colgroup><col style="width:130px"><col style="width:96px"><col style="width:96px"><col style="width:96px"><col style="width:130px"><col></colgroup>
          <thead><tr><th>Tag</th><th>Bill</th><th style="text-align:right">Software ₹</th><th style="text-align:right">Register ₹</th><th>Counted as</th><th>How the payment came</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td colspan="2"><strong>Total</strong></td><td class="amount">${rs(sumOf(lines, (l) => l.software?.amountPaise))}</td><td class="amount">${rs(sumOf(lines, (l) => l.register?.amountPaise))}</td>
            <td>₹ ${rs(Object.values(countedBy).reduce((t, v) => t + v, 0))}<div class="tiny">${Object.entries(countedBy).sort((a, b) => b[1] - a[1]).map(([m, v]) => `${MODE_SHORT[m] ?? m} ${rs(v)}`).join(' · ')}</div></td>
            <td>${notComeSum ? html`<span style="color:var(--danger)">Not come ₹ ${rs(notComeSum)}</span>` : ''}</td></tr></tfoot>
        </table></div>` : html`<div class="note">No bills${tagF || mode || find ? ' match' : ' in these shifts'}.</div>`}
      </section>`));
    app.querySelectorAll('[data-oldpos]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.oldpos; if (billsOpenOld.has(k)) billsOpenOld.delete(k); else billsOpenOld.add(k); draw(); }));
    document.getElementById('blform').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const same = f.from.value === f.to.value;
      go(link({ day: same ? f.from.value : '', from: same ? '' : f.from.value, to: same ? '' : f.to.value, mode: f.mode.value, q: f.q.value.trim() }));
    });
    document.getElementById('blcsv').addEventListener('click', () => saveCsv(`all-bills-${r.from}-to-${r.to}.csv`, [
      ['Shift', 'Bill', 'Time', 'Tag', 'Old POS', 'Software', 'Software mode', 'Register', 'Register mode', 'Counted', 'Counted mode', 'Note', 'How the payment came', 'Money not come'],
      ...lines.map((l) => [l.day, l.billNo, l.paidAt ? timeOf(l.paidAt) : '', BILL_TAGS.find(([k]) => k === l.tag)[1], l.oldPos ? 'yes' : '', rupeesCsv(l.software?.amountPaise), l.software?.mode ?? '',
        rupeesCsv(l.register?.amountPaise), l.register?.mode ?? '', rupeesCsv(l.counted?.amountPaise), l.counted?.mode ?? '', l.note ?? '', l.payment.map((x) => x.text).join(' | '), l.notCome ? 'yes' : ''])]));
  };
  draw();
}

/**
 * Funds flow (approved 14 Nov 2026): money that actually moved between two shifts, one column per account and a
 * total. Transfers between own accounts move money between columns only. Each figure opens the lines behind it.
 * The end of each account is checked against its statement balance (bank) or the cash counted (cash).
 */
async function fundsView(biz, query) {
  const q = new URLSearchParams(query);
  const today = currentShiftDay();
  const range = { from: q.get('from') ?? '', to: q.get('to') ?? '' };
  const r = await api('GET', `/businesses/${biz.id}/reports/funds-flow?${new URLSearchParams(range)}`);
  const totalOnly = q.get('cols') === 'total';
  const accs = totalOnly ? [] : r.accounts;
  const sumOf = (o) => Object.values(o ?? {}).reduce((s, x) => s + x, 0);
  const fig = (p, key, acc) => (p ? html`<a href="#" class="ff-fig" data-fk="${key}" data-acc="${acc ?? ''}">${rs(p)}</a>` : html`<span class="tiny">–</span>`);
  const cells = (amounts, key, plain) => html`${accs.map((a) => html`<td class="amount">${plain ? rs(amounts[a.id] ?? 0) : fig(amounts[a.id] ?? 0, key, a.id)}</td>`)}<td class="amount" style="font-weight:600">${plain ? rs(sumOf(amounts)) : fig(sumOf(amounts), key, '')}</td>`;
  const addUp = (rows) => { const o = {}; for (const x of rows) for (const [k, v] of Object.entries(x.amounts)) o[k] = (o[k] ?? 0) + v; return o; };
  const line = (x, indent) => html`<tr data-row="${x.key}" class="${x.warn ? 'ff-warn' : ''}"><td style="padding-left:${indent}px">${x.label}</td>${cells(x.amounts, x.key)}</tr>`;
  const head = (label, amounts) => html`<tr class="ff-h"><td>${label}</td>${cells(amounts, null, true)}</tr>`;
  const sub = (label, amounts) => html`<tr class="ff-sub"><td style="padding-left:18px">${label}</td>${cells(amounts, null, true)}</tr>`;
  const ins = r.rows.filter((x) => x.group === 'in');
  const outs = r.rows.filter((x) => x.group === 'out');
  const trs = r.rows.filter((x) => x.group === 'tr');
  const block = (rows, section, label) => {
    const list = rows.filter((x) => x.section === section);
    if (!list.length) return '';
    return label ? html`${sub(label, addUp(list))}${list.map((x) => line(x, 34))}` : list.map((x) => line(x, 18));
  };
  const checkCell = (a) => {
    const k = r.checks[a.id];
    if (!k) return html`<td class="amount tiny">${a.kind === 'cash' ? 'not counted yet' : 'no statement yet'}</td>`;
    const on = k.day === r.to ? '' : html` <span class="tiny">(${k.what === 'counted' ? 'counted' : 'statement'} ${dayLabel(k.day)})</span>`;
    if (k.differencePaise === null) return html`<td class="amount tiny">no balance on the statement</td>`;
    return k.differencePaise === 0 ? html`<td class="amount" style="color:var(--ok)">✓ matches${on}</td>`
      : html`<td class="amount" style="color:var(--danger)" title="${k.what === 'counted' ? 'Cash counted' : 'Statement balance'} ₹ ${money(k.paise)}">differs ${rs(k.differencePaise)}${on}</td>`;
  };
  const known = (k) => r.checks[k.id]?.paise;
  const checkedTotal = r.accounts.every((a) => r.checks[a.id]?.differencePaise != null) ? r.accounts.reduce((s, a) => s + r.checks[a.id].differencePaise, 0) : null;
  const picks = (() => {
    const monday = (() => { const d = new Date(`${today}T12:00:00Z`); const back = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); })();
    return [['Today', today, today], ['This week', monday, today], ['This month', `${today.slice(0, 8)}01`, today]];
  })();
  const link = (from, to, cols = q.get('cols') ?? '') => `#/b/${biz.id}/funds?${new URLSearchParams({ from, to, ...(cols ? { cols } : {}) })}`;
  const m = r.memo;
  render(shell(biz, 'reports', 'Reports', '', html`
    ${reportTabs(biz, 'funds')}
    <section class="card" style="gap:10px">
      <h2>Funds flow</h2>
      <div class="note">Money that actually moved, shift to shift (8 am to 8 am). Click a figure to see its lines. The books start on ${dayLabel(r.booksStart)}.</div>
      <div class="form-row" style="align-items:flex-end;gap:8px;flex-wrap:wrap">
        ${picks.map(([l, f, t]) => html`<a class="btn ${f === r.from && t === r.to ? '' : 'plain'}" href="${link(f, t)}">${l}</a>`)}
        <form id="ffdates" class="form-row" style="align-items:flex-end;gap:8px">
          <div class="field"><label for="fffrom">From shift</label><input id="fffrom" type="date" name="from" value="${r.from}" min="${r.booksStart}" required></div>
          <div class="field"><label for="ffto">To shift</label><input id="ffto" type="date" name="to" value="${r.to}" required></div>
          <button class="btn plain" type="submit">Show</button>
        </form>
        <span style="flex:1"></span>
        <div class="seg"><a href="${link(r.from, r.to, '')}" class="${totalOnly ? '' : 'on'}">Per account</a><a href="${link(r.from, r.to, 'total')}" class="${totalOnly ? 'on' : ''}">Total only</a></div>
      </div>
      <div class="scroll"><table class="ff" style="min-width:${totalOnly ? 420 : 300 + 120 * (accs.length + 1)}px">
        <thead><tr><th>₹</th>${accs.map((a) => html`<th class="amount">${a.name}</th>`)}<th class="amount">Total</th></tr></thead>
        <tbody>
          ${head(`Funds at start · ${dayLabel(r.from)}`, r.start)}
          ${head('+ Money in', addUp(ins))}
          ${block(ins, 'sales', 'Sales received')}${block(ins, 'advance')}${block(ins, 'income')}${block(ins, 'left_out')}${block(ins, 'open')}
          ${head('− Money out', addUp(outs))}
          ${block(outs, 'expenses', 'Expenses by head')}${block(outs, 'card_fees')}${block(outs, 'not_approved')}${block(outs, 'left_out')}${block(outs, 'open')}
          ${trs.length ? html`${head('± Transfers between own accounts', addUp(trs))}${trs.map((x) => line(x, 18))}` : ''}
          ${head(`= Funds at end · ${dayLabel(r.to)}`, r.end)}
          ${totalOnly ? '' : html`<tr><td class="tiny">Statement balance / cash counted</td>${accs.map((a) => html`<td class="amount tiny">${known(a) == null ? '–' : rs(known(a))}</td>`)}<td></td></tr>
          <tr><td class="tiny">Check</td>${accs.map(checkCell)}<td class="amount ${checkedTotal ? '' : 'tiny'}" style="${checkedTotal ? 'color:var(--danger)' : ''}">${checkedTotal == null ? '' : checkedTotal ? `differs ${rs(checkedTotal)}` : '✓'}</td></tr>`}
        </tbody>
      </table></div>
      ${(() => {
        // Why the cash may differ (17 Nov 2026): shifts not saved yet have no cash sales in the books; a count from a
        // sheet changed by hand is said with its reason.
        const n = r.cashNotes ?? {};
        const cashOff = r.accounts.some((a) => a.kind === 'cash' && r.checks[a.id]?.differencePaise);
        return html`${cashOff && n.unsaved?.length ? html`<div class="note">Cash: ${n.unsaved.length === 1 ? `the ${dayLabel(n.unsaved[0])} shift is` : `${n.unsaved.length} shifts (${n.unsaved.map(dayLabel).join(', ')}) are`} not saved yet, so ${n.unsaved.length === 1 ? 'its' : 'their'} cash sales are not in the books. Save ${n.unsaved.length === 1 ? 'it' : 'them'} on <a href="#/b/${biz.id}/reconcile/${n.unsaved[0]}">Reconcile</a>.</div>` : ''}
          ${n.revised ? html`<div class="note">Cash counted ${dayLabel(n.revised.day)} is from a sheet changed by hand: ${({ revised: 'sheet revised, the new one not uploaded', misread: 'the photo was misread', other: 'other' })[n.revised.reason] ?? n.revised.reason}${n.revised.note ? ` (${n.revised.note})` : ''}.</div>` : ''}`;
      })()}
      <div class="ff-memo">
        <div style="font-weight:600;margin-bottom:4px">Sales made but not received yet <span class="tiny">(not in the flow above)</span></div>
        <div class="list-row"><span>Sales billed in these shifts (${m.billed.n} bill${m.billed.n === 1 ? '' : 's'})</span><span class="amount">${rs(m.billed.paise)}</span></div>
        <div class="list-row"><span>UPI bills not in the bank yet (${m.upiWaiting.n})</span><span class="amount">${m.upiWaiting.n ? html`<a href="#/b/${biz.id}/bank?tab=in">${rs(m.upiWaiting.paise)}</a>` : '–'}</span></div>
        <div class="list-row"><span>Card sales waiting for settlement (${m.cardWaiting.n})</span><span class="amount">${m.cardWaiting.n ? html`<a href="#/b/${biz.id}/cards">${rs(m.cardWaiting.paise)}</a>` : '–'}</span></div>
        <div class="note">Card settlements above are the card payments in full; the card company's fees and GST are under Money out, so the two together are what reached the bank.</div>
      </div>
    </section>`));
  wireShell();
  document.getElementById('ffdates').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = new FormData(e.target);
    location.hash = link(d.get('from'), d.get('to')).slice(1);
  });
  const names = Object.fromEntries(r.accounts.map((a) => [a.id, a.name]));
  document.querySelectorAll('.ff-fig').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    const tr = a.closest('tr');
    const open = tr.nextElementSibling?.classList.contains('ff-lines') ? tr.nextElementSibling : null;
    const same = open && open.dataset.for === `${a.dataset.fk}|${a.dataset.acc}`;
    open?.remove();
    if (same) return;
    try {
      const d = await api('GET', `/businesses/${biz.id}/reports/funds-flow?${new URLSearchParams({ from: r.from, to: r.to, key: a.dataset.fk })}`);
      const ls = d.lines.filter((l) => !a.dataset.acc || l.accountId === a.dataset.acc);
      const shown = ls.slice(0, 200);
      const row = document.createElement('tr');
      row.className = 'ff-lines';
      row.dataset.for = `${a.dataset.fk}|${a.dataset.acc}`;
      row.innerHTML = html`<td colspan="${accs.length + 2}"><div class="ff-detail">${shown.map((l) => html`<div class="list-row"><span><span class="tiny">${dayLabel(l.day)} · ${names[l.accountId] ?? ''}</span> ${l.text}</span><span class="amount">${rs(l.paise)}</span></div>`)}
        ${ls.length > shown.length ? html`<div class="tiny">and ${ls.length - shown.length} more</div>` : ''}${ls.length ? '' : html`<div class="tiny">No lines.</div>`}</div></td>`.__html;
      tr.after(row);
    } catch (err) { window.alert(err.message); }
  }));
}

/**
 * Money out: every payment from a bank account or from Cash in one list. Each line links to where it is handled
 * (Bank sync for the shift, the expense-list page on Review, Compare sales for a cash shortage). A bank payment not
 * booked yet can be booked to an expense head here (Book), and a booked one put back (Undo), as on Bank sync.
 */
const MONEY_OUT_STATUS = {
  not_booked: ['wait', 'Not booked yet'], booked: ['ok', 'Booked'], matched: ['ok', 'Matched'], left_out: ['', 'Left out'],
  draft: ['wait', 'Draft, not approved'], approved: ['ok', 'Approved'], transfer: ['', 'Transfer'],
};
async function moneyOutView(biz, query) {
  const q = new URLSearchParams(query);
  const pick = (k) => q.get(k) ?? '';
  const r = await api('GET', `/businesses/${biz.id}/money-out?${new URLSearchParams({ from: pick('from'), to: pick('to'), account: pick('account'), head: pick('head'), party: pick('party'), waiting: pick('waiting'), item: pick('item') })}`);
  const f = r.filters;
  // Group the totals by head, party or item (approved 14 Nov 2026); kept in the link.
  const group = ['head', 'party', 'item'].includes(q.get('group')) ? q.get('group') : 'head';
  const link = (over) => `#/b/${biz.id}/money-out?${new URLSearchParams({ from: r.from, to: r.to, account: f.account ?? '', head: f.head ?? '', party: f.party ?? '', item: f.item ?? '', waiting: f.waiting ? '1' : '', group, ...over })}`;
  const where = (l) => {
    if (l.source === 'bank') return `#/b/${biz.id}/bank?${new URLSearchParams({ from: l.day, to: l.day, account: l.accountId, tab: l.status === 'not_booked' ? 'out' : 'done' })}`;
    if (l.source === 'cash_photo' && l.uploadId) return `#/b/${biz.id}/review/${l.uploadId}`;
    return `#/b/${biz.id}/compare/${l.day}`;
  };
  const whereLabel = (l) => (l.source === 'bank' ? 'Bank' : l.source === 'cash_photo' ? 'Expense page' : 'Cash for the shift');
  const opt = (v, label, cur) => html`<option value="${v}" ${v === (cur ?? '') ? 'selected' : ''}>${label}</option>`;
  const subtotal = (title, groups, key) => html`<div style="flex:1 1 280px;min-width:0">
    <h3 style="margin:0 0 6px;font-size:15px">${title}</h3>
    <table><tbody>${groups.map((g) => html`<tr>
      <td>${g.id === 'none' && key === 'item' ? g.name : html`<a href="${link({ [key]: g.id })}">${g.name}</a>`} <span class="tiny">${g.count}</span></td><td class="amount">${money(g.paise)}</td></tr>`)}</tbody></table></div>`;
  const filtered = f.account || f.head || f.party || f.waiting || f.item;
  const SMALL = 'min-height:34px;padding:0 12px;font-size:14px';
  // A list to read (approved 14 Nov 2026): bank payments are booked on Bank › Money out, so a line not booked opens there.
  const act = (l) => (l.source === 'bank' && l.status === 'not_booked' ? html`<a class="btn plain" style="${SMALL};display:inline-flex;align-items:center" href="${where(l)}">Open to book ›</a>` : '');
  const groups = { head: ['By head', r.byHead, 'head'], party: ['By party', r.byParty, 'party'], item: ['By item', r.byItem, 'item'] }[group];
  render(shell(biz, 'money-out', 'Bank', '', html`
    ${bankTabs(biz, null, 'payments')}
    <section class="card" style="gap:10px">
      <h2>All payments</h2>
      <div class="note">Every payment from every account and Cash, by shift (8 am to 8 am). Transfers between your accounts are listed but not counted.</div>
      <datalist id="moparties">${r.options.parties.map((p) => html`<option value="${p.name}">`)}</datalist>
      <form id="moform" class="form-row" style="align-items:flex-end">
        <div class="field"><label for="mofrom">From shift</label><input id="mofrom" type="date" name="from" value="${r.from}" required></div>
        <div class="field"><label for="moto">To shift</label><input id="moto" type="date" name="to" value="${r.to}" required></div>
        <div class="field"><label for="moacc">Paid from</label><select id="moacc" name="account">${opt('', 'All accounts', f.account)}${r.options.accounts.map((a) => opt(a.id, a.name, f.account))}</select></div>
        <div class="field"><label for="mohead">Head</label><select id="mohead" name="head">${opt('', 'All heads', f.head)}${opt('none', 'No head yet', f.head)}${r.options.heads.map((h) => opt(h.id, h.name, f.head))}</select></div>
        <div class="field"><label for="moparty">Party</label><select id="moparty" name="party">${opt('', 'All parties', f.party)}${opt('none', 'No party', f.party)}${r.options.parties.map((p) => opt(p.id, p.name, f.party))}</select></div>
        ${f.item ? html`<input type="hidden" name="item" value="${f.item}"><span class="chip">Item: ${f.item}</span>` : ''}
        <label style="display:flex;gap:6px;align-items:center;min-height:44px;white-space:nowrap"><input type="checkbox" name="waiting" value="1" style="width:18px;height:18px;min-height:0" ${f.waiting ? 'checked' : ''}> Not booked yet</label>
        <button class="btn plain" type="submit">Show</button>
      </form>
      <div class="note"><strong>${r.total.count} payment${r.total.count === 1 ? '' : 's'} · ₹ ${money(r.total.paise)}</strong>
        ${r.waiting.count && !f.waiting ? html` · <a href="${link({ waiting: '1' })}">${r.waiting.count} not booked or approved yet</a> (₹ ${money(r.waiting.paise)})` : ''}
        ${r.leftOut.count ? html` · ${r.leftOut.count} bank line${r.leftOut.count === 1 ? '' : 's'} left out, not counted (₹ ${money(r.leftOut.paise)})` : ''}
        ${r.transfers?.count ? html` · ${r.transfers.count} transfer${r.transfers.count === 1 ? '' : 's'} between your accounts, not counted (₹ ${money(r.transfers.paise)})` : ''}
        ${filtered ? html` · <a href="${`#/b/${biz.id}/money-out?${new URLSearchParams({ from: r.from, to: r.to, group })}`}">Clear filters</a>` : ''}</div>
      ${r.total.count ? html`<div class="seg" role="group" aria-label="Group by" style="align-self:flex-start">${[['head', 'Head'], ['party', 'Party'], ['item', 'Item']].map(([k, l]) => html`<a href="${link({ group: k })}" class="${k === group ? 'on' : ''}" style="padding:4px 12px">${l}</a>`)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:16px 28px">
        ${subtotal(groups[0], groups[1], groups[2])}${subtotal('By paid from', r.byAccount, 'account')}</div>` : ''}
    </section>
    <section class="card" style="gap:10px">
      ${r.lines.length ? html`<ul class="mo-list">${r.lines.map((l) => {
        const [cls, label] = MONEY_OUT_STATUS[l.status] ?? ['', l.status];
        return html`<li class="${l.status === 'left_out' ? 'off' : ''}">
          <div class="mo-top"><span>${dayLabel(l.day)}${l.at ? html` <span class="tiny">${when(l.at).replace(/^.*?,\s*/, '')}</span>` : ''}</span><strong class="amount">₹ ${money(l.amountPaise)}</strong></div>
          <div>${l.narration || html`<span class="note">No item written</span>`}</div>
          <div class="tiny">${[l.accountName, l.head ?? 'No head yet', l.party].filter(Boolean).join(' · ')}</div>
          <div class="mo-top"><span><span class="chip ${cls}">${label}</span>${l.note ? html` <span class="tiny">${l.note}</span>` : ''}</span><span class="tiny" style="display:flex;gap:8px;align-items:center">${act(l)}<a href="${where(l)}">${whereLabel(l)}</a></span></div></li>`;
      })}</ul>
      <div class="scroll mo-table"><table style="min-width:900px">
        <thead><tr><th>Shift · time</th><th>Paid from</th><th>Party</th><th>Head</th><th>Narration</th><th style="text-align:right">₹</th><th>Status</th></tr></thead>
        <tbody>${r.lines.map((l) => {
          const [cls, label] = MONEY_OUT_STATUS[l.status] ?? ['', l.status];
          return html`<tr style="${l.status === 'left_out' ? 'color:var(--muted)' : ''}">
          <td style="white-space:nowrap">${dayLabel(l.day)}${l.at ? html`<div class="tiny">${when(l.at)}</div>` : ''}</td>
          <td>${l.accountName}</td>
          <td>${l.party ?? html`<span class="note">—</span>`}</td>
          <td>${l.head ?? html`<span class="note">No head yet</span>`}</td>
          <td style="white-space:normal;min-width:220px">${l.narration || html`<span class="note">No item written</span>`}${l.detail && l.detail !== l.narration ? html`<div class="tiny mono" style="word-break:break-all">${l.detail}</div>` : ''}${l.source === 'cash_shortage' ? html`<div class="tiny">Cash shortage booked by an Owner</div>` : ''}</td>
          <td class="amount" style="${l.status === 'left_out' ? 'text-decoration:line-through' : ''}">${money(l.amountPaise)}</td>
          <td style="white-space:nowrap"><span class="chip ${cls}">${label}</span>${l.note ? html`<div class="tiny" style="white-space:normal">${l.note}</div>` : ''}
            <div class="tiny"><a href="${where(l)}">${whereLabel(l)}</a></div>${act(l) ? html`<div style="margin-top:4px">${act(l)}</div>` : ''}</td></tr>`;
        })}</tbody>
      </table></div>` : html`<div class="ok-msg">No money out in these shifts${filtered ? ' with these filters' : ''}.</div>`}
    </section>`));
  wireShell();
  const form = document.getElementById('moform');
  const show = () => {
    const d = new FormData(form);
    location.hash = link({ from: d.get('from'), to: d.get('to'), account: d.get('account'), head: d.get('head'), party: d.get('party'), item: d.get('item') ?? '', waiting: d.get('waiting') ? '1' : '' });
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); show(); });
  form.querySelectorAll('select, input[type=checkbox]').forEach((el) => el.addEventListener('change', show));
}

// Parties (approved 14 Nov 2026): who was paid, under which heads, how much this month, and likely duplicates to merge.
async function partiesView(biz, query = '') {
  const q = new URLSearchParams(query);
  const month = /^\d{4}-\d{2}$/.test(q.get('month') ?? '') ? q.get('month') : null;
  const [r, { heads }] = await Promise.all([api('GET', `/businesses/${biz.id}/parties-summary${month ? `?month=${month}` : ''}`), api('GET', `/businesses/${biz.id}/heads`)]);
  const canEdit = biz.actions.includes('heads.edit');
  const canBank = biz.actions.includes('bank.link');
  const exp = heads.filter((h) => h.type === 'expense');
  const [y, m] = r.month.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const total = r.parties.reduce((t, p) => t + p.monthPaise, 0);
  const row = (p) => html`<details class="party-row" data-pname="${p.name.toLowerCase()} ${(p.aliases ?? []).join(' ').toLowerCase()}">
    <summary style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1.2fr) 110px 90px;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft);cursor:pointer">
      <span>${p.name}${p.aliases?.length ? html` <span class="tiny">· ${p.aliases.length} other name${p.aliases.length === 1 ? '' : 's'}</span>` : ''}
        ${p.sameAs ? html` <span class="chip wait" title="The names look alike. Open to merge.">Same as ${p.sameAs.name}?</span>` : ''}</span>
      <span>${p.defaultHead ?? html`<span class="note">No head yet</span>`}${p.heads.length > 1 ? html` <span class="tiny">+${p.heads.length - 1}</span>` : ''}</span>
      <span class="amount">${p.monthPaise ? `₹ ${money(p.monthPaise)}` : '—'}</span><span class="tiny" style="text-align:right">${p.lastDay ? dayLabel(p.lastDay) : ''}</span></summary>
    <div class="inset" style="display:flex;flex-direction:column;gap:8px;margin:6px 0 10px" data-party="${p.id}">
      <div class="form-row" style="align-items:flex-end">
        <div class="field"><label>Name</label><input data-pn value="${p.name}" ${canEdit ? '' : 'disabled'}></div>
        <div class="field"><label>Usual head</label><select data-ph ${canEdit ? '' : 'disabled'}><option value="">No head yet</option>${exp.map((h) => html`<option value="${h.id}" ${h.id === p.defaultHeadId ? 'selected' : ''}>${h.name}</option>`)}</select></div>
        ${canEdit ? html`<button class="btn plain" type="button" data-psave>Save</button>` : ''}</div>
      ${p.heads.length ? html`<div class="tiny">Booked under: ${p.heads.map((h) => `${h.name} (${h.lines})`).join(', ')}</div>` : ''}
      ${p.aliases?.length ? html`<div class="tiny">Other names and UPI IDs: ${p.aliases.join(', ')}</div>` : ''}
      <div class="form-row" style="gap:8px;align-items:center">
        ${canBank ? html`<a class="btn plain dchip" href="#/b/${biz.id}/money-out?${new URLSearchParams({ from: `${r.month}-01`, to: monthEnd, party: p.id })}">Payments this month ›</a>` : ''}
        ${canEdit ? html`<select class="compact" data-pmerge aria-label="Merge ${p.name} into"><option value="">Merge into…</option>${r.parties.filter((o) => o.id !== p.id).map((o) => html`<option value="${o.id}" ${o.id === p.sameAs?.id ? 'selected' : ''}>${o.name}</option>`)}</select>
          <button class="btn plain dchip" type="button" data-pmergego>Merge</button>` : ''}</div>
      <div class="form-msg"></div></div></details>`;
  render(shell(biz, 'parties', 'Parties', '', html`
    <section class="card" style="gap:10px">
      <div class="form-row" style="align-items:center;gap:10px"><input id="psearch" placeholder="Search party" style="flex:1;min-width:180px" autocomplete="off">
        <input id="pmonth" type="month" value="${r.month}" class="compact" style="max-width:170px"></div>
      <div class="note">${r.parties.length} parties · ₹ ${money(total)} paid in ${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</div>
      <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1.2fr) 110px 90px;gap:10px" class="tiny"><span>Party</span><span>Usual head</span><span style="text-align:right">This month</span><span style="text-align:right">Last paid</span></div>
      ${r.parties.length ? r.parties.map(row) : html`<div class="note">No parties yet. A party is added when it is named on an expense line.</div>`}
      <div id="pmsg"></div>
    </section>`));
  wireShell();
  document.getElementById('pmonth').addEventListener('change', (e) => go(`#/b/${biz.id}/parties?month=${e.target.value}`));
  document.getElementById('psearch').addEventListener('input', (e) => {
    const t = e.target.value.trim().toLowerCase();
    app.querySelectorAll('[data-pname]').forEach((d) => { d.hidden = !!t && !d.dataset.pname.includes(t); });
  });
  app.querySelectorAll('[data-party]').forEach((box) => {
    const id = box.dataset.party;
    const msg = box.querySelector('.form-msg');
    box.querySelector('[data-psave]')?.addEventListener('click', async () => {
      try { await api('PATCH', `/businesses/${biz.id}/parties/${id}`, { name: box.querySelector('[data-pn]').value.trim(), defaultHeadId: box.querySelector('[data-ph]').value || null }); await partiesView(biz, query); doneToast('Party saved.', null, null); }
      catch (e) { showError(msg, e); }
    });
    box.querySelector('[data-pmergego]')?.addEventListener('click', async () => {
      const into = box.querySelector('[data-pmerge]').value;
      if (!into) { msg.innerHTML = '<div class="note">Choose the party to merge into.</div>'; return; }
      const from = r.parties.find((p) => p.id === id);
      const to = r.parties.find((p) => p.id === into);
      if (!confirm(`Merge ${from.name} into ${to.name}? Its ${from.lines} line${from.lines === 1 ? '' : 's'} and other names move to ${to.name}, and ${from.name} goes. This cannot be undone here.`)) return;
      try { const res = await apiFull('POST', `/businesses/${biz.id}/parties/${id}/merge`, { into }); await partiesView(biz, query); doneToast(`${from.name} merged into ${to.name}: ${res.moved} line${res.moved === 1 ? '' : 's'} moved.`, null, null); }
      catch (e) { showError(msg, e); }
    });
  });
}

function laterView(biz, key) {
  const n = NAV.find((x) => x.key === key);
  render(shell(biz, key, n.label, '', html`
    <section class="card"><div class="note">${n.label} arrives in Phase ${n.phase}.</div></section>`));
  wireShell();
}

async function inviteView(token) {
  let info;
  try {
    info = await api('GET', `/invites/${encodeURIComponent(token)}`);
  } catch (e) {
    render(html`<div class="center"><section class="card" style="flex:0 1 440px"><h1 style="margin:0;font-size:24px">Invite</h1><div class="error">${e.message}</div><a href="#/login">Go to sign in</a></section></div>`);
    return;
  }
  render(html`
  <div class="center">
    <form class="card" id="accept" style="flex:0 1 440px">
      <div style="font-size:22px;font-weight:600">Bookr</div>
      <h1 style="margin:0;font-size:26px;font-weight:600">Join ${info.businessName}</h1>
      <div class="sub">You have been invited as <strong>${ROLE_LABELS[info.role]}</strong>${info.phone ? html`. You'll sign in with your mobile number, <strong>${info.phone.slice(3, 8)} ${info.phone.slice(8)}</strong>.` : html` using ${info.email}.`}</div>
      ${info.hasAccount ? html`
        <div class="field"><label for="p">Your Bookr password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      ` : html`
        <div class="field"><label for="n">Your name</label><input id="n" name="name" autocomplete="name" required></div>
        <div class="field"><label for="p">Choose a password</label><input id="p" name="password" type="password" autocomplete="new-password" minlength="10" required>
          <span class="note">At least 10 characters.</span></div>
      `}
      <div class="form-msg"></div>
      <button class="btn big" type="submit">Accept invite</button>
    </form>
  </div>`);
  onSubmit(document.getElementById('accept'), async (d) => {
    await api('POST', `/invites/${encodeURIComponent(token)}/accept`, d);
    me = await api('GET', '/me');
    // A cashier with one business opens straight on their book (21 Nov 2026).
    go(me.businesses.length === 1 ? home(me.businesses[0]) : '#/choose');
  });
}

// ---------- Phase 2: Upload, Review, Compare sales

const IST_MS = 330 * 60 * 1000;
const istFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const istDayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const when = (ms) => (ms == null ? '' : istFmt.format(new Date(ms)).replace(/\s?(am|pm)$/i, (m) => m.toLowerCase()));
const dayLabel = (day) => istDayFmt.format(new Date(Date.parse(`${day}T12:00:00+05:30`)));
const todayIst = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
/** epoch ms ↔ the value of an <input type="datetime-local" step="1">, in India time. */
const toLocalInput = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 19);
const fromLocalInput = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - IST_MS : null;
};
const MODE_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', unknown: 'U/N (not given)', mixed: 'Part cash, part UPI' };
const TYPE_LABELS = { fnb: 'F&B', room: 'Room' };
const KIND_LABELS = { software_sales_csv: 'Software sales report', bill_register: 'Bill register', expense_list: 'Expense list', cash_summary: 'Cash account summary', single_bill: 'Single printed bill' };
const DIFF_LABELS = {
  match: 'Match', amount: 'Amount differs', mode: 'Payment mode differs', amount_and_mode: 'Amount and mode differ',
  missing_in_register: 'Missing in register', missing_in_software: 'Missing in software', complimentary: 'Complimentary',
};
/** A row brought to ₹0 by its group's discount (it pays for the group): not complimentary (10 Nov 2026). */
const groupZero = (c, v) => c.difference === 'complimentary' && !c.software && (v.paidGroups ?? []).find((g) => g.id === c.groupId && g.grossPaise > g.paidPaise);
const DECISION_LABELS = { use_software: 'Use software', use_register: 'Use register', leave_out: 'Leave out', carry_forward: 'Carry forward' };
const STATUS_CHIPS = {
  uploaded: ['Uploaded', 'wait'], reading: ['Reading', 'wait'], ready: ['Ready to review', 'info'], retake: ['Retake needed', 'bad'],
  approved: ['Approved', 'ok'], failed: ['Failed', 'bad'],
};
const chip = (status) => { const [t, k] = STATUS_CHIPS[status] ?? [status, '']; return html`<span class="chip ${k}">${t}</span>`; };

const canDeleteUpload = (biz, u) => ['owner', 'accountant'].includes(biz.role) || u.uploadedBy === me.user.id;
const kindLabel = (u) => (u.fromSoftware ? 'Bill register: added from software report' : KIND_LABELS[u.kind]);
const deleteButton = (biz, u) => (canDeleteUpload(biz, u) ? html`<button class="btn danger" type="button" data-delupload="${u.id}" data-what="${kindLabel(u)} for ${dayLabel(u.day)}">Delete</button>` : '');
/** Wires every Delete button on the screen. Asks first; then runs after(). */
function wireDeletes(biz, msgEl, after) {
  app.querySelectorAll('[data-delupload]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete the ${b.dataset.what}? Everything read from it goes too. This cannot be undone.`)) return;
    try { await apiFull('DELETE', `/businesses/${biz.id}/uploads/${b.dataset.delupload}`, {}); after(); }
    catch (err) { showError(msgEl(), err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }));
}

async function apiUpload(path, file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const type = file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' })[ext] || 'application/octet-stream';
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': type }, body: file, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? 'Upload failed.');
  return data;
}

/** Shows an error with its list of reasons, as the server sends them. */
function showError(el, err) {
  el.innerHTML = html`<div class="error">${err.message}</div>${err.problems?.length ? html`<ul class="error">${err.problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}`.__html;
}
// Saving only what changed (17 Nov 2026): a register row is sent as the fields this screen changed plus what they were
// when it opened, so an older screen never undoes a save made elsewhere (the server refuses a field changed meanwhile).
const ROW_FIELDS = ['billNo', 'billType', 'amount', 'discount', 'payments', 'paidWithRowId', 'remarks', 'status'];
const rowInputOf = (r) => ({ paidWithRowId: r.paidWithRowId ?? null, billNo: r.billNo ?? '', billType: r.billType ?? null, amount: rupeesForInput(r.amountPaise ?? 0),
  discount: rupeesForInput(r.discountPaise ?? 0), remarks: r.remarks ?? null, status: r.status,
  payments: (r.payments ?? []).map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })) });
function sameRowField(f, a, b) {
  const m = (v) => parsePaiseText(String(v ?? '').trim() || '0');
  const str = (v) => (v == null ? '' : String(v).trim());
  if (f === 'amount' || f === 'discount') return m(a) === m(b);
  if (f === 'payments') {
    const k = (v) => JSON.stringify((v ?? []).map((p) => [p.mode, m(p.amount), str(p.columnLabel)]).filter((x) => x[1] !== 0).sort());
    return k(a) === k(b);
  }
  if (f === 'billNo') return str(a).replace(/\s+/g, '') === str(b).replace(/\s+/g, '');
  if (f === 'status') return (a === 'checked') === (b === 'checked');
  return str(a) === str(b);
}
/** "Discount ₹ 2", "Tip ₹ 6" or "No discount", for saying how a discount changed. */
const discWord = (p) => (p > 0 ? `Discount ₹ ${rs(p)}` : p < 0 ? `Tip ₹ ${rs(-p)}` : 'No discount');
const rowEditBody = (was, now, extra = {}) => ({ ...now, ...extra, only: ROW_FIELDS.filter((f) => !sameRowField(f, was[f], now[f])), was });
async function apiFull(method, path, body) {
  body = bodyFor(method, body);
  const res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok && data?.code === 'amount_unread' && method === 'PUT' && body && !(body.confirm ?? []).includes('amount')) {
    if (window.confirm(`${data.error}\n\nOK = the bill really is ₹0 (complimentary). Cancel = type the amount first.`)) return apiFull(method, path, { ...body, confirm: [...(body.confirm ?? []), 'amount'] });
  }
  if (!res.ok) { const e = new Error(data?.error ?? 'Something went wrong.'); e.problems = data?.problems; e.code = data?.code; throw e; }
  cacheAfter(method, path, data);
  return data;
}

const MAX_FILES = 10;

/**
 * Reads uploaded pages with Claude, a few at a time (the server's limit), waiting and trying again when it is busy.
 * The pages are first put in the server's reading queue (18 Nov 2026): whatever this browser does not finish (the page
 * closed, the phone asleep, the server busy) is read on the server within a few minutes.
 */
async function readPages(biz, items) {
  const status = await api('GET', `/businesses/${biz.id}/ocr`).catch(() => null);
  if (!status?.configured) { items.forEach((x) => x.set('Uploaded', 'Not read: reading is not set up. Type the rows in on Review.')); return; }
  const queued = await api('POST', `/businesses/${biz.id}/ocr/queue`, { uploadIds: items.map((x) => x.id) }).then(() => true).catch(() => false);
  const later = 'Waiting: the server will read it in a few minutes';
  const queue = [...items];
  const worker = async () => {
    for (let x = queue.shift(); x; x = queue.shift()) {
      x.set('Reading…');
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const r = await apiFull('POST', `/businesses/${biz.id}/uploads/${x.id}/read`, {});
          x.set(x.kind === 'cash_summary' ? 'Read' : `Read: ${r.rows} row${r.rows === 1 ? '' : 's'}${r.unclearCells ? `, ${r.unclearCells} to check` : ''}${r.totalMatches === false ? ', total differs' : ''}`);
          break;
        } catch (err) {
          const busy = /being read already|already being read|Claude is busy|Try again|reach Claude/.test(err.message);
          if (/being read already|already being read/.test(err.message) && attempt < 5) { x.set('Waiting to read…'); await new Promise((res) => setTimeout(res, 15000)); continue; }
          if (busy && queued) x.set(later);
          else x.set('Uploaded', `Not read: ${err.message}`);
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(status.maxParallel ?? 2, 3)) }, worker));
}

// ---------- Review

async function reviewView(biz, uploadId, highlightRow) {
  if (!uploadId) return reviewListView(biz);
  const [u, { heads }, list, { parties }] = await Promise.all([
    api('GET', `/businesses/${biz.id}/uploads/${uploadId}`),
    api('GET', `/businesses/${biz.id}/heads`),
    api('GET', `/businesses/${biz.id}/uploads`),
    api('GET', `/businesses/${biz.id}/parties`),
  ]);
  rememberDay(biz.id, u.day);
  // Pages of the same type in day order, then upload order: for Previous and Next.
  const same = list.uploads.filter((x) => x.kind === u.kind).sort((a, b) => a.day.localeCompare(b.day) || a.createdAt - b.createdAt);
  const at = same.findIndex((x) => x.id === u.id);
  const prev = at > 0 ? same[at - 1] : null;
  const next = at >= 0 && at < same.length - 1 ? same[at + 1] : null;
  // Numbered within the day; Previous and Next carry on into the days before and after.
  const sameDay = same.filter((x) => x.day === u.day).map((x) => x.id);
  const fileUrl = `/api/businesses/${biz.id}/uploads/${u.id}/file`;
  const isReg = u.kind === 'bill_register';
  const ocrNote = html`<div class="note" id="ocrnote">${u.ocrEngine === 'claude_vision' ? 'Read by Claude. Every row is a draft: check each one against the photo.' : u.ocrEngine === 'manual' ? 'Rows typed in by hand.' : 'Press Read page to fill the rows from the photo, or type them in.'}</div>`;
  const photo = u.fromSoftware ? html`
    <section class="card" id="photocard" style="flex:2 1 420px;max-width:100%;gap:10px">
      <h2>Added from software report</h2>
      <div class="note">No photo: these bills were in the software report but not written in the handwritten register. They were added here when "Add to register" was chosen on Compare sales, with the amount and payment mode from the software. Delete a line here to undo.</div>
      <div style="display:flex;justify-content:flex-end">${deleteButton(biz, u)}</div>
    </section>` : html`
    <section class="card ${isReg ? 'regphoto' : ''}" id="photocard" style="flex:2 1 420px;max-width:100%;padding:16px;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px" class="note"><span>Original page</span><span style="display:flex;gap:10px;align-items:center">${isReg ? html`<button type="button" class="btn plain" id="photoside2" style="min-height:30px">Back to strip</button>` : html`<a href="${fileUrl}" target="_blank" rel="noopener">Open full size</a>${deleteButton(biz, u)}`}</span></div>
      <div style="overflow:hidden;display:flex;justify-content:center"><img src="${fileUrl}" alt="Uploaded page" style="width:100%;border:1px solid var(--field);border-radius:6px;background:#FBFAF6;transition:transform .2s" id="pimg"></div>
      <div class="form-row" style="align-items:center">
        ${!isReg && READABLE.includes(u.kind) && biz.actions.includes('rows.upload') ? html`<button class="btn" type="button" id="readpage">Read page</button>` : ''}
        <button class="btn plain" type="button" id="rotate">Rotate view</button>
      </div>
      ${isReg ? '' : ocrNote}
    </section>`;
  // Register pages: page actions sit in a ⋯ menu, out of the way of the rows.
  const pageMenu = isReg && !u.fromSoftware ? html`<details class="menu"><summary class="btn plain" aria-label="Page actions">⋯</summary><div class="menu-pop">
      ${biz.actions.includes('rows.upload') ? html`<button class="btn plain" type="button" id="readpage">Read page again</button>` : ''}
      <a class="btn plain" href="${fileUrl}" target="_blank" rel="noopener">Open photo full size</a>
      ${deleteButton(biz, u)}
      ${ocrNote}</div></details>` : '';
  let right;
  if (u.kind === 'bill_register') right = registerPanel(biz, u);
  else if (u.kind === 'expense_list') right = expensePanel(biz, u, heads, parties);
  else if (u.kind === 'cash_summary') right = summaryPanel(biz, u);
  else right = html`<section class="card grow3"><div class="note">Single printed bills are kept for reference. Nothing is read from them yet.</div></section>`;
  const pageLink = (x, label, text) => x ? html`<a class="btn plain" href="#/b/${biz.id}/review/${x.id}" title="${label} page: ${KIND_LABELS[x.kind]} · ${dayLabel(x.day)}${x.day !== u.day ? ' (another day)' : ''}" aria-label="${label} page">${text}</a>`
    : html`<span class="btn plain off" aria-hidden="true">${text}</span>`;
  // One bar: title and date, the page pager, then find and page actions; the hotel switcher stays at the end.
  const tools = html`
    <div class="pager">${pageLink(prev, 'Previous', '‹')}<span class="note">${at >= 0 ? `Page ${sameDay.indexOf(u.id) + 1} of ${sameDay.length}` : ''}</span>${pageLink(next, 'Next', '›')}</div>
    <div class="head-tools">
      ${backButton()}
      ${(u.kind === 'expense_list' || u.kind === 'cash_summary') && biz.actions.includes('rows.edit') ? html`<form id="dayform" class="form-row" style="align-items:center;gap:6px" title="The shift this page belongs to"><label for="pday" class="note">Page is for</label><input id="pday" name="day" type="date" class="compact" value="${u.day}" max="${todayIst()}"><button class="btn plain" type="submit" hidden id="daysave">Move page</button></form>` : ''}
      ${u.kind === 'bill_register' ? findBillBox(true) : ''}
      ${pageMenu}
      <button class="btn plain" type="button" id="expand" title="Hide the photo and the menu to give the entries the full width, e.g. when checking against a printout"></button>
    </div>`;
  rememberSheet(biz.id, u);
  render(shell(biz, 'review', `${kindLabel(u)} · ${dayLabel(u.day)}`, `uploaded ${when(u.createdAt)}`, html`
    ${shiftBar(biz, u.day, 'review')}
    ${isReg ? html`<div id="waiting"></div>` : ''}
    <div id="findresults"></div>
    <div id="rmsg"></div>
    <div class="row ${isReg ? 'regrow' : ''}">${photo}${right}</div>`, { tools }));
  wireShell();
  wireShiftBar(biz);
  wireDeletes(biz, () => document.getElementById('rmsg'), () => go(`#/b/${biz.id}/review`));
  document.getElementById('pimg')?.addEventListener('error', (e) => { e.target.replaceWith(Object.assign(document.createElement('div'), { className: 'note', textContent: 'This file is a PDF. Use Open full size.' })); });
  wireReadPage(biz, u);
  const dayForm = document.getElementById('dayform');
  if (dayForm) {
    dayForm.day.addEventListener('input', () => { document.getElementById('daysave').hidden = dayForm.day.value === u.day; });
    dayForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const day = dayForm.day.value;
      if (!day || !confirm(`Move this page${u.kind === 'expense_list' ? ' and its lines' : ''} from ${dayLabel(u.day)} to ${dayLabel(day)}?`)) return;
      try { await api('PATCH', `/businesses/${biz.id}/uploads/${u.id}`, { day }); reviewView(biz, u.id); }
      catch (err) { showError(document.getElementById('rmsg'), err); }
    });
  }
  wireExpand();
  wireFindBill(biz);
  if (isReg) drawWaiting(biz, u);
  if (highlightRow) {
    const tr = document.querySelector(`#regtable tr[data-row="${CSS.escape(highlightRow)}"]`);
    if (tr) { tr.classList.add('row-found'); tr.scrollIntoView({ block: 'center' }); tr.querySelector('[data-f="billNo"]')?.focus(); }
  }
  if (u.kind === 'bill_register') wireRegister(biz, u);
  if (u.kind === 'expense_list') wireExpense(biz, u, parties);
  if (u.kind === 'cash_summary') {
    wireSummary(biz, u);
    api('GET', `/businesses/${biz.id}/shifts/${u.day}/cash`).then((k) => {
      const host = document.getElementById('sform')?.closest('section');
      if (!host) return;
      host.insertAdjacentHTML('beforeend', cashPanelHtml(biz, k).__html);
      wireCashPanel(biz, u.day, () => reviewView(biz, u.id), document.getElementById('rmsg'), k);
    }).catch(() => {});
  }
}

// Expanded review: the entries take the full width (photo and menu hidden). Remembered per browser.
const EXPAND_KEY = 'bookr.reviewExpanded';
function wireExpand() {
  const btn = document.getElementById('expand');
  if (!btn) return;
  let on = false;
  try { on = localStorage.getItem(EXPAND_KEY) === '1'; } catch { /* storage unavailable */ }
  const apply = () => {
    document.body.classList.toggle('review-expanded', on);
    btn.textContent = on ? 'Show photo' : '⤢';
    btn.setAttribute('aria-label', on ? 'Show photo' : 'Expand');
  };
  apply();
  btn.addEventListener('click', () => {
    on = !on;
    try { localStorage.setItem(EXPAND_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
    apply();
  });
}

function wireReadPage(biz, u) {
  let turn = 0;
  document.getElementById('rotate')?.addEventListener('click', () => {
    turn = (turn + 90) % 360;
    document.getElementById('pimg').style.transform = `rotate(${turn}deg)`;
  });
  const btn = document.getElementById('readpage');
  if (!btn) return;
  api('GET', `/businesses/${biz.id}/ocr`).then((s) => {
    const note = document.getElementById('ocrnote');
    if (!s.configured) { btn.disabled = true; note.textContent = 'Reading pages is not set up on the server yet. Type the rows in.'; return; }
    note.textContent += ` Reads today: ${s.usedToday} of ${s.dailyLimit}.`;
    btn.dataset.model = s.model;
  }).catch(() => {});
  btn.addEventListener('click', async () => {
    const hasRows = (u.rows?.length ?? 0) > 0 || (u.kind === 'cash_summary' && u.summary.openingPaise != null);
    if (!confirm(`Read this page with Claude${btn.dataset.model ? ` (${btn.dataset.model})` : ''}?${hasRows ? ' Unchecked rows on this page will be replaced.' : ''} This uses one of today's page reads.`)) return;
    btn.disabled = true;
    btn.textContent = 'Reading… this can take a minute';
    const msg = document.getElementById('rmsg');
    try {
      const r = await apiFull('POST', `/businesses/${biz.id}/uploads/${u.id}/read`, {});
      await reviewView(biz, u.id);
      const parts = [u.kind === 'cash_summary' ? 'Figures read.' : `${r.rows} row${r.rows === 1 ? '' : 's'} read.`];
      if (r.unclearCells) parts.push(`${r.unclearCells} cell${r.unclearCells === 1 ? '' : 's'} could not be read with confidence and show "Needs input".`);
      if (r.totalMatches === false) parts.push(`The rows add up to ₹ ${money(r.rowsTotalPaise)} but the page total says ₹ ${money(r.writtenTotalPaise)}.`);
      if (r.orientation && r.orientation !== 'upright') parts.push('The photo was turned; it was read the right way up.');
      parts.push('Check every row against the photo before it counts.');
      document.getElementById('rmsg').innerHTML = html`<div class="${r.totalMatches === false || r.unclearCells ? 'demo-band' : 'ok-msg'}">${parts.join(' ')}</div>`.__html;
    } catch (err) {
      showError(msg, err);
      btn.disabled = false;
      btn.textContent = 'Read page';
    }
  });
}

/** Search box: register rows by bill number, or its last few digits, across every page. */
const findBillBox = (compact) => html`<form id="findbill" class="form-row" style="align-items:center;gap:6px" role="search">
  <input name="bill" class="cell mono" placeholder="Find bill, e.g. 3154" style="width:190px" aria-label="Find a bill number on register pages" autocomplete="off">
  ${compact ? '' : html`<button class="btn plain" type="submit" style="min-height:36px">Find</button>`}</form>`;

function wireFindBill(biz, initial) {
  const form = document.getElementById('findbill');
  const out = document.getElementById('findresults');
  if (!form || !out) return;
  if (initial) setTimeout(() => { form.bill.value = initial; form.bill.dispatchEvent(new Event('input')); }, 0);
  let timer;
  const run = async () => {
    const q = form.bill.value.trim();
    if (q.length < 2) { out.innerHTML = ''; return; }
    const { rows } = await api('GET', `/businesses/${biz.id}/register-rows?bill=${encodeURIComponent(q)}`);
    out.innerHTML = html`<section class="card" style="padding:12px 16px;gap:2px">
      ${rows.length ? rows.map((r) => html`<a class="list-row" style="padding:6px 0;color:inherit" href="#/b/${biz.id}/review/${r.uploadId}/${r.id}">
          <span><span class="mono">${r.billNo}</span> · ₹ ${money(r.amountPaise)}</span>
          <span class="note">${dayLabel(r.day)} · line ${r.lineNo}${r.status === 'checked' ? ' · ✓' : ''}</span></a>`)
        : html`<div class="note">No register row has "${q}" in its bill number.</div>`}
      ${rows.length === 30 ? html`<div class="tiny">Showing the first 30. Type more digits to narrow it down.</div>` : ''}
    </section>`.__html;
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  form.bill.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
}

async function reviewListView(biz, find) {
  const { uploads, notices } = await api('GET', `/businesses/${biz.id}/uploads`);
  const pages = uploads.filter((u) => u.kind !== 'software_sales_csv');
  const csvs = uploads.filter((u) => u.kind === 'software_sales_csv' && u.report);
  render(shell(biz, 'review', 'Review', 'Pick a page to check its rows beside the photo. Software reports are checked on Compare sales.', html`
    <div id="rlmsg"></div>
    <div class="form-row" style="align-items:center">${backButton()}${findBillBox()}</div>
    <div id="findresults"></div>
    ${notices.length > 2 ? html`<div class="demo-band">Cash summaries that cannot be checked until their expense rows are approved: ${notices.map((n, i) => {
      const page = uploads.find((u) => u.kind === 'expense_list' && u.day === n.day && u.open);
      const label = `${dayLabel(n.day)} (${n.text.match(/: (\d+) expense/)?.[1] ?? '?'})`;
      return html`${i ? ', ' : ''}${page ? html`<a href="#/b/${biz.id}/review/${page.id}">${label}</a>` : label}`; })}</div>`
      : notices.map((n) => html`<div class="demo-band">${n.text.replace(n.day, dayLabel(n.day))}</div>`)}
    <section class="card" style="gap:4px">
      <h2 style="margin-bottom:8px">Software sales reports</h2>
      ${csvs.length ? csvs.map((u) => { const r = u.report; return html`
        <div class="list-row">
          <span><strong>${when(r.coversFrom)} to ${when(r.coversTo)}</strong> · ${u.rows} bill${u.rows === 1 ? '' : 's'}
            <br><span class="note">${r.added} new, ${r.skipped} already imported (skipped), ${r.flagged} with different values${r.openConflicts ? html` · <span class="error">${r.openConflicts} still to decide</span>` : ''}${r.replacedBy ? ' · replaced by a corrected file' : ''}</span></span>
          <span style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${r.shiftDays.map((d) => html`<a href="#/b/${biz.id}/compare/${d}">Open the ${dayLabel(d)} shift</a>`)}${deleteButton(biz, u)}</span>
        </div>`; }) : html`<div class="note">No software reports yet.</div>`}
    </section>
    <h2 style="margin:4px 0 0">Pages</h2>
    <section class="card" style="gap:4px">
      ${pages.length ? pages.map((u) => html`
        <div class="list-row">
          <a href="#/b/${biz.id}/review/${u.id}" style="color:inherit"><strong>${kindLabel(u)}</strong> · ${dayLabel(u.day)}${u.rows != null ? ` · ${u.rows} row${u.rows === 1 ? '' : 's'}` : ''}${u.open ? ` · ${u.open} to check` : ''}</a>
          <span style="display:flex;gap:10px;align-items:center">${u.totalDiffers ? html`<span class="chip bad">Total differs</span>` : ''}${chip(u.status)}<a href="#/b/${biz.id}/review/${u.id}">Review</a>${deleteButton(biz, u)}</span>
        </div>`) : html`<div class="note">No pages yet. <a href="#/b/${biz.id}/bringin">Bring one in</a>.</div>`}
    </section>`));
  wireShell();
  wireDeletes(biz, () => document.getElementById('rlmsg'), () => reviewListView(biz));
  wireFindBill(biz, find);
}

/** Fields Claude could not read with confidence, while nobody has checked the row yet. */
function unclearOf(ocrOriginal, stillUnchecked) {
  if (!ocrOriginal || !stillUnchecked) return new Set();
  try {
    const o = JSON.parse(ocrOriginal);
    const resolved = new Set(o.resolved ?? []);
    return new Set((o.unclear ?? []).filter((f) => !resolved.has(f)));
  } catch { return new Set(); }
}
/** Fields the app worked out (e.g. discount = amount - payments) that nobody has changed since. */
function inferredOf(ocrOriginal) {
  if (!ocrOriginal) return new Set();
  try {
    const o = JSON.parse(ocrOriginal);
    const resolved = new Set(o.resolved ?? []);
    return new Set((o.inferred ?? []).filter((f) => !resolved.has(f)));
  } catch { return new Set(); }
}
const needs = (set, field, content) => (set.has(field) ? html`${content} <span class="chip bad">Needs input</span>` : content);
const READABLE = ['bill_register', 'expense_list', 'cash_summary'];

function payText(pays) {
  return pays.length ? pays.map((p) => `${p.columnLabel || MODE_LABELS[p.mode]} ${money(p.amountPaise)}`).join(' + ') : 'none written';
}

const PAY_OPTIONS = [['cash', 'Cash'], ['upi', 'UPI XOXO'], ['upi', 'UPI Bank 2'], ['card', 'Card']];
const payKey = (p) => `${p.mode}|${p.columnLabel ?? ''}`;

/** Under "Paid as": which bills one payment covers, and whether it adds up. */
function groupNote(r) {
  const ms = membersOf(r);
  const head = headOf(r);
  if (!ms.length && !head) return '';
  const h = head ?? r;
  const all = [h, ...membersOf(h)];
  const ok = paidOf(h) === groupNet(h);
  const other = all.find((x) => x.elsewhere);
  return html`<div class="tiny" style="margin-top:3px;color:${ok ? 'var(--teal-ink)' : '#7F1D1D'}">${head ? `Paid with ${rowLabel(h)}` : `Also pays ${ms.map(rowLabel).join(', ')}`}:
    ₹ ${money(paidOf(h))} for bills of ₹ ${money(groupNet(h))} (${all.map(rowLabel).join(', ')})${ok ? '' : ' — does not add up'}${other ? html` · <a href="#/b/${currentBizId()}/review/${other.uploadId}/${other.id}">open page ${other.pageNo}</a>` : ''}</div>`;
}

// Review of a register page: the table runs in the same column order as the paper, one line per bill, with one
// plain "Issue" per row. Red = needs you, amber = Bookr filled it in (check it), nothing = looks fine.
const PAY_COLS = PAY_OPTIONS; // Cash · UPI XOXO · UPI Bank 2 · Card
/** Which payment column a payment sits in: by mode, and for UPI by its column heading. */
const colOf = (p) => (p.mode === 'cash' ? 0 : p.mode === 'card' ? 3 : /bank|\b2\b/i.test(p.columnLabel ?? '') ? 2 : 1);
const FIELD_WORDS = { bill_no: 'bill no', amount: 'amount', bill_type: 'type', discount: 'discount', payments: 'payment', remarks: 'remarks' };

/** What is wrong with a row, in words, and which cells to mark. */
function rowIssues(r) {
  // Remarks are free text, and an unread type is taken as F&B: neither is raised as an issue.
  const q = unclearOf(r.ocrOriginal, r.status === 'draft');
  q.delete('remarks');
  q.delete('bill_type');
  const inf = inferredOf(r.ocrOriginal);
  let o = {};
  try { o = r.ocrOriginal ? JSON.parse(r.ocrOriginal) : {}; } catch { /* not JSON */ }
  const red = [], amber = [], info = [], flags = {};
  if (q.size) { red.push(html`Couldn't read ${[...q].map((f) => FIELD_WORDS[f] ?? f).join(', ')}`); q.forEach((f) => { flags[f] = 'red'; }); }
  // The same bill number on another line of the shift (this page or another): written twice, or one is wrong.
  const twins = r.billNo ? regRows.filter((y) => y.id !== r.id && y.billNo === r.billNo) : [];
  if (twins.length) {
    flags.bill_no = 'red';
    red.push(html`Bill ${r.billNo} is also on ${twins.map((y) => (y.elsewhere ? html`<a href="#/b/${currentBizId()}/review/${y.uploadId}/${y.id}">${rowLabel(y)}</a>` : rowLabel(y)))}: written twice, or one number is wrong`);
  }
  const bm = r.billMatch;
  if (bm && !bm.exact && q.has('bill_no')) { // said once, as "Not in software report"
    red.splice(0, red.length); q.delete('bill_no');
    if (q.size) red.push(html`Couldn't read ${[...q].map((f) => FIELD_WORDS[f] ?? f).join(', ')}`);
  }
  const why = { short: 'last digits', typo: 'one digit off', short_typo: 'last digits, one off', amount: 'same amount' };
  const od = r.otherDayBill;
  const odMode = (m) => (m === 'upi' ? 'UPI' : m ?? '');
  const rowMode = r.payments.length === 1 ? r.payments[0].mode : null;
  const cp = r.copyOf;
  if (cp && !od && bm && !bm.exact) {
    // Already on another day (approved 21 Nov 2026): in that day's software report and register, most likely written twice.
    const d = dayLabel(cp.day).replace(/\s\d{4}$/, '');
    const where = html`Bill <span class="mono">${r.billNo}</span> is a ${d} bill: ₹ ${rs(cp.amountPaise)} ${odMode(cp.mode)} in the ${d} software report and on line ${cp.line.lineNo} of the ${d} register`;
    if (r.status === 'checked') info.push(html`Kept as a second payment. ${where}; this one needs its own bill in the software.`);
    else {
      flags.bill_no = 'red';
      red.push(html`<span class="chip" style="background:#DBEAFE;color:#1E3A8A">Already on ${d}</span><div class="tiny" style="color:var(--ink);margin-top:4px">${where}.</div>
        <div class="form-row" style="gap:6px;margin-top:6px"><button type="button" class="btn plain dchip" data-copydel>Written twice: remove this line</button>
        <button type="button" class="btn plain dchip" data-copykeep>A second payment: keep it</button>
        <a class="btn plain dchip" href="#/b/${currentBizId()}/review/${cp.line.uploadId}/${cp.line.rowId}">Open ${d} line ${cp.line.lineNo} ›</a></div>`);
    }
  } else if (od && bm && !bm.exact) {
    // Settled on another day (11 Nov 2026): the bill is in that day's software report, counted there.
    info.push(`${dayLabel(od.day)} bill: in that day's software report${od.amount != null ? ` as ${odMode(od.mode)} ₹ ${rs(od.amount)}` : ''}, counted there${rowMode && od.mode && rowMode !== od.mode ? `. Paid here by ${odMode(rowMode)}: change it on Reconcile` : ''}.`);
  } else if (bm && !bm.exact && isOldPos(r.billNo)) info.push('Old POS bill');
  else if (!bm?.exact && isOddBill(r.billNo) && r.numberSettled) info.push(r.numberSettled); // a person settled it on Compare
  // Ticked (17 Nov 2026): a person has checked the number against the photo, so its format is not raised again here;
  // Compare and Reconcile still decide what the bill is.
  else if (r.status === 'checked' && isOddBill(r.billNo)) { /* checked as written */ }
  else if (!bm && isOddBill(r.billNo)) {
    flags.bill_no = 'red';
    red.push(html`Number is neither new POS (date and running number) nor old POS (14xxxx–15xxxx)`);
  } else if (bm && !bm.exact) {
    flags.bill_no = 'red';
    red.push(html`${isOddBill(r.billNo) ? 'Number is neither new POS (date and running number) nor old POS (14xxxx–15xxxx)' : 'Not in software report'}${bm.options.length ? html`<span class="chips">${bm.options.slice(0, 4).map((x) => html`<button type="button" class="pickchip ${x.taken ? 'taken' : ''}" data-pick="${x.billNo}" title="${why[x.why] ?? ''}${x.taken ? ' · already on another register line: one of the two may be wrong, or the bill was written twice' : ''}">${x.billNo} · ${rs(x.amountPaise)}${x.amountMatches ? ' ✓' : ''}${x.taken ? ' · on register' : ''}</button>`)}</span>` : ''}`);
  }
  // Bills paid together: the group is told once, on the row where the payment is written. Its other rows say nothing about it.
  const member = !!r.paidWithRowId;
  const ms = membersOf(r);
  const together = ms.length ? `Paid together with ${ms.map(rowLabel).join(', ')}` : '';
  if (!member && payDiffers(r)) {
    const gap = paidOf(r) - groupNet(r);
    flags.payments = 'red';
    red.push(paidOf(r) ? `${together ? `${together}: ` : ''}paid ₹ ${rs(paidOf(r))} for ₹ ${rs(groupNet(r))} (${gap < 0 ? `${rs(-gap)} short` : `${rs(gap)} over`})`.replace(/^p/, 'P') : 'No payment written');
  } else if (together) info.push(`${together} · ₹ ${rs(paidOf(r))} ✓`);
  // A discount bigger than the bill (approved 10 Nov 2026): the bill would come to ₹0 and count as complimentary. The row
  // that pays for a group may carry the group's whole discount; a large one is told below as a percentage.
  const overDiscount = !member && !ms.length && r.amountPaise > 0 && (r.discountPaise ?? 0) > r.amountPaise;
  if (overDiscount) { flags.discount = 'red'; red.push(`Discount ₹ ${rs(r.discountPaise)} is more than the bill ₹ ${rs(r.amountPaise)}: check the photo.`); }
  // A large discount is reported, not something to approve (10 Nov 2026).
  if (!member && !overDiscount && largePct(r)) { flags.discount = 'amber'; info.push(`Large discount: ${largePct(r)}%${ms.length ? ' on these bills' : ''}`); }
  const other = [r, ...ms].find((m) => m.elsewhere);
  if (!member && other) info.push(html`<a href="#/b/${currentBizId()}/review/${other.uploadId}/${other.id}">Open page ${other.pageNo}</a>`);
  if (r.numberFlags?.length) {
    flags.bill_no = 'red';
    for (const f of r.numberFlags) red.push(html`${numberFlagText(f)}${f.billNo ? html`<span class="chips"><button type="button" class="pickchip" data-pick="${f.billNo}" title="Writes this number on the row. Check it against the photo first.">Use ${f.billNo}</button></span>` : ''}`);
  }
  const h = r.hint;
  if (h && h.amountPaise !== r.amountPaise) {
    red.push(html`<button type="button" class="pickchip" data-usehint="${r.id}" data-amt="${rsIn(h.amountPaise)}" data-mode="${h.mode}" data-pay="${h.fields.includes('payments') ? '1' : ''}"
      title="The software report says ${rs(h.amountPaise)}${h.bankAt ? `, and the bank received it at ${when(h.bankAt)}` : ''}.">Use ${rs(h.amountPaise)}? (${h.bankAt ? 'software + bank' : 'software'})</button>`);
  }
  const ch = r.columnHint;
  if (ch) {
    flags.payments ??= 'amber';
    amber.push(html`${colHintText(ch)} <span class="chips"><button type="button" class="pickchip" data-setcol="${ch.paymentId}" title="Moves this payment to the ${ch.toLabel} column. Nothing else changes.">Change to ${ch.toLabel}</button></span>`);
  }
  if (inf.has('bill_no') && o.completedFrom) { flags.bill_no ??= 'amber'; amber.push(`Completed from "${o.completedFrom}" on the page`); }
  if (inf.has('bill_type')) flags.bill_type ??= 'amber'; // assumed F&B: only tinted
  // A group's discount filled by itself (13 Nov 2026): said in words, with Undo (a person's 0 then stays).
  if (o.autoGroupDiscount && r.discountPaise && !member) {
    flags.discount = 'amber';
    const gross = r.amountPaise + ms.reduce((t, m) => t + m.amountPaise, 0);
    amber.push(html`Discount filled: ₹ ${rs(r.discountPaise)} (${gross ? (Math.round(r.discountPaise * 1000 / gross) / 10) : 0}% of ₹ ${rs(gross)} of bills)
      <span class="chips"><button type="button" class="pickchip" data-undodisc="${r.id}" title="Takes the discount off. It is not filled again for this group.">Undo</button></span>`);
  } else if (inf.has('discount') && !largePct(r)) flags.discount ??= 'amber'; // a worked-out discount is only tinted, not spelled out
  if (inf.has('payments') && !r.paidWithRowId && o.movedFromRow) { flags.payments ??= 'amber'; amber.push('Payment moved from the next line'); }
  if (r.bankAdjusted) info.push('Adjusted from bank on Reconcile');
  const sp = splitOffer(r, o);
  if (sp) red.unshift(html`Two bills on this line: ${sp.bills[0]} ₹ ${rs(sp.amounts[0])} and ${sp.bills[1]} ₹ ${rs(sp.amounts[1])}
    <span class="chips"><button type="button" class="pickchip" data-split="${r.id}" title="This line keeps ${sp.bills[0]} and its payment; a new line below takes ${sp.bills[1]}, paid together with it. Check both against the photo.">Split into 2 rows</button></span>`);
  return { red, amber, info, flags, needsYou: red.length > 0 && r.status !== 'checked' };
}

/** A line the reader found two bills on, with two amounts, not split yet (same rule as the server's splitOfReading). */
function splitOffer(r, o) {
  if (!o?.read || o.splitInto || regRows.some((y) => { try { return JSON.parse(y.ocrOriginal ?? '{}').addedBelow === r.id; } catch { return false; } })) return null;
  const parts = (v) => String(v ?? '').trim().split(/[\s,/&+]+/).filter(Boolean);
  const bills = parts(o.read.bill_no);
  const amounts = parts(o.read.amount).map((a) => (/^\d{1,12}(\.\d{1,2})?$/.test(a.replace(/,/g, '')) ? parsePaiseText(a) : null));
  return bills.length === 2 && amounts.length === 2 && amounts.every((a) => a > 0) ? { bills, amounts } : null;
}
const flagClass = (f) => (f === 'red' ? 'flag' : f === 'amber' ? 'flag-auto' : '');
const issueHtml = (x, r) => html`${x.red.map((t) => html`<div class="iss red">${t}</div>`)}${x.amber.map((t) => html`<div class="iss amber">${t}</div>`)}${x.info.map((t) => html`<div class="iss info">${t}</div>`)}`;

/** One register row: one line, cells in the paper's order. Read-only when the shift is confirmed. */
function regRowHtml(r, locked) {
  const x = rowIssues(r);
  const cols = PAY_COLS.map((_, i) => r.payments.filter((p) => colOf(p) === i));
  const head = headOf(r);
  // Rows of a group paid together are joined by a bracket on the left.
  const lead = head ?? (membersOf(r).length ? r : null);
  const grp = lead ? [lead, ...membersOf(lead)].filter((m) => !m.elsewhere).sort((p1, p2) => p1.lineNo - p2.lineNo) : [];
  const gpos = grp.length > 1 ? `grp ${grp[0].id === r.id ? 'grp-first' : ''} ${grp[grp.length - 1].id === r.id ? 'grp-last' : ''}` : '';
  const cls = `${r.status === 'checked' ? 'row-checked' : ''} ${x.needsYou ? 'needs-you' : ''} ${gpos}`;
  const total = grp.length > 1 && grp[grp.length - 1].id === r.id ? groupTotalHtml(lead, locked) : '';
  return html`${regLineHtml(r, locked, x, cols, head, cls)}${total}`;
}

/** Under the last row of a group paid together: what the bills come to against what was paid. */
function groupTotalHtml(lead, locked) {
  const all = [lead, ...membersOf(lead)];
  const bills = groupNet(lead);
  const paid = paidOf(lead);
  const diff = paid - bills;
  const ok = diff === 0;
  // The discount (or tip) on the paying row that makes the group agree: one click (17 Nov 2026).
  const to = (lead.discountPaise ?? 0) - diff;
  const fix = !ok && !locked && !lead.elsewhere && paid > 0 && to <= all.reduce((t, m) => t + m.amountPaise, 0)
    ? html` <button type="button" class="linkbtn" data-grpfix="${lead.id}" data-to="${to}">${to > 0 ? `Write ₹ ${rs(to)} discount` : to < 0 ? `Write ₹ ${rs(-to)} tip` : 'Take the discount off'} on ${rowLabel(lead)}</button>` : '';
  return html`<tr class="grptotal ${ok ? 'ok' : 'bad'}" aria-label="Group total"><td class="ln"></td><td colspan="12">Group of ${all.length} bills: ₹ ${rs(bills)} · paid ₹ ${rs(paid)} ·
    ${ok ? '✓ matches' : `₹ ${rs(Math.abs(diff))} ${diff > 0 ? 'over' : 'short'}`}${fix}</td></tr>`;
}

function regLineHtml(r, locked, x, cols, head, cls) {
  if (locked) {
    return html`<tr data-row="${r.id}" class="${cls}"><td class="ln">${r.lineNo}</td><td class="mono">${r.billNo}</td><td class="amount">${rs(r.amountPaise)}</td><td>${TYPE_LABELS[r.billType] ?? ''}</td>
      ${r.paidWithRowId ? html`<td colspan="4" class="note">Paid with ${head ? rowLabel(head) : 'another row'}</td>` : cols.map((c) => html`<td class="amount">${c.length ? rs(c.reduce((t, p) => t + p.amountPaise, 0)) : ''}</td>`)}
      <td class="amount">${r.discountPaise ? rs(r.discountPaise) : ''}</td><td class="note">${r.remarks ?? ''}</td><td class="issue">${issueHtml(x, r)}</td><td style="text-align:center">${r.status === 'checked' ? '✓' : ''}</td><td></td></tr>`;
  }
  return html`<tr data-row="${r.id}" class="${cls}">
    <td class="ln">${r.lineNo}</td>
    <td class="c-bn"><input class="cell mono ${flagClass(x.flags.bill_no)}" data-f="billNo" value="${r.billNo}" aria-label="Bill number" style="width:100%" autocomplete="off"></td>
    <td class="c-am"><input class="cell mono ${flagClass(x.flags.amount)}" data-f="amount" value="${r.amountPaise || r.billNo ? rsIn(r.amountPaise) : ''}" style="width:100%;text-align:right" inputmode="decimal" aria-label="Bill amount"></td>
    <td class="c-ty"><select class="cell ${flagClass(x.flags.bill_type)}" data-f="billType" aria-label="Type" style="width:100%"><option value="">–</option>${Object.entries(TYPE_LABELS).map(([k, l]) => html`<option value="${k}" ${r.billType === k ? 'selected' : ''}>${l}</option>`)}</select></td>
    ${r.paidWithRowId ? html`<td colspan="4" class="paidwith c-pw" data-l="Paid">↳ paid with ${head ? rowLabel(head) : 'another row'} <button type="button" class="linkbtn" data-unlink title="This bill has its own payment">Own payment</button></td>`
      : cols.map((c, i) => html`<td data-l="${PAY_COLS[i][1]}" class="c-p${i}"><input class="cell mono ${c.length ? flagClass(x.flags.payments) : ''}" data-f="pay${i}" value="${c.map((p) => rsIn(p.amountPaise)).join('+')}" style="width:100%;text-align:right"
          aria-label="${PAY_COLS[i][1]}" title="Two payments in this column? Type them with a plus, e.g. 1000+500"></td>`)}
    <td data-l="Disc" class="c-dc"><input class="cell mono ${flagClass(x.flags.discount)}" data-f="discount" value="${r.discountPaise ? rsIn(r.discountPaise) : ''}" placeholder="0" style="width:100%;text-align:right" inputmode="decimal" aria-label="Discount; a tip is negative" title="Discount; a tip is negative"></td>
    <td data-l="Remarks" class="c-rm"><input class="cell ${flagClass(x.flags.remarks)}" data-f="remarks" value="${r.remarks ?? ''}" style="width:100%" aria-label="Remarks"></td>
    <td class="issue c-is">${issueHtml(x, r)}</td>
    <td class="tick c-tk"><input type="checkbox" data-f="checked" ${r.status === 'checked' ? 'checked' : ''} aria-label="Looks right" title="Looks right (Enter)"></td>
    <td class="c-ed" style="white-space:nowrap"><button class="iconbtn" type="button" data-edit="${r.id}" title="More: paid together with another bill" aria-label="Edit row">✎</button><button class="iconbtn" type="button" data-addbelow="${r.id}" title="Add a line below: two bills written on one line" aria-label="Add a line below">＋</button><button class="iconbtn" type="button" data-delrow="${r.id}" title="Delete this line" aria-label="Delete this line">🗑</button></td>
  </tr>`;
}

const paidOf = (r) => r.payments.reduce((t, p) => t + p.amountPaise, 0);
const netOf = (r) => r.amountPaise - (r.discountPaise ?? 0);
/** A bill whose written payments do not equal its amount after discount (complimentary bills with none are fine). */
// Rows of the register page on screen, for bills paid together (a group = head row + rows paid with it).
let regRows = [];
/** This page's rows plus the shift's rows on its other pages (bills paid together can run across sheets). */
const shiftRowsOf = (u) => [...u.rows, ...(u.otherPageRows ?? []).map((x) => ({ ...x, elsewhere: true }))];
/** "row 4", or "page 2 · row 4" for a row on another page of the shift. */
const currentBizId = () => location.hash.split('/')[2] ?? '';
const rowLabel = (x) => (x.elsewhere ? `page ${x.pageNo ?? '?'} · row ${x.lineNo}` : `row ${x.lineNo}`);
const membersOf = (r) => regRows.filter((x) => x.paidWithRowId === r.id);
const headOf = (r) => (r.paidWithRowId ? regRows.find((x) => x.id === r.paidWithRowId) : null);
/** The bills a row's payment has to cover: itself, plus the bills paid with it. */
const groupNet = (head) => netOf(head) + membersOf(head).reduce((t, m) => t + netOf(m), 0);
/** A bill whose payments do not cover it after discount or tip. For bills paid together the whole group is checked. */
const LARGE_DISCOUNT_PCT = 20; // mirrors src/sales.ts
/** The discount of a row's bills (the whole group when paid together) as a % of the bills, when over the limit; else 0. */
const largePct = (r) => {
  const head = headOf(r) ?? r;
  const group = [head, ...membersOf(head)];
  const disc = group.reduce((t, x) => t + Math.max(x.discountPaise ?? 0, 0), 0);
  const gross = group.reduce((t, x) => t + x.amountPaise, 0);
  return disc > 0 && gross > 0 && disc * 100 > LARGE_DISCOUNT_PCT * gross ? Math.round((disc * 100) / gross) : 0;
};
const payDiffers = (r) => {
  const head = headOf(r);
  if (head) return paidOf(head) !== groupNet(head);
  if (membersOf(r).length) return paidOf(r) !== groupNet(r);
  return !(netOf(r) === 0 && r.payments.length === 0) && paidOf(r) !== netOf(r);
};

function regSumHtml(u) {
  const bills = u.rows.reduce((s, r) => s + r.amountPaise, 0);
  const disc = u.rows.reduce((s, r) => s + Math.max(r.discountPaise ?? 0, 0), 0);
  const tips = u.rows.reduce((s, r) => s + Math.max(-(r.discountPaise ?? 0), 0), 0);
  const paid = u.rows.reduce((s, r) => s + paidOf(r), 0);
  const written = u.pageWrittenTotalPaise;
  const off = u.rows.filter((r) => !r.paidWithRowId && payDiffers(r)); // a group paid together counts once, on its payment row
  const vsPage = written == null ? 'Enter the total written on the page to check it.'
    : written === bills && written === paid ? html`<span class="ok-msg">Both match the written total.</span>`
    : written === bills ? html`<span class="ok-msg">Bill amounts match the written total.</span>`
    : (disc || tips) && written === bills - disc + tips ? html`<span class="ok-msg">Bill amounts after discounts and tips match the written total.</span>`
    : written === paid ? html`<span class="ok-msg">Payments match the written total</span> (₹ ${rs(written)}).`
    : html`<span class="error">The page says ₹ ${rs(written)}.</span>`;
  return html`Bill amounts add up to <strong>₹ ${rs(bills)}</strong>${disc || tips ? html`${disc ? html`, less discounts <strong>₹ ${rs(disc)}</strong>` : ''}${tips ? html`, plus tips <strong>₹ ${rs(tips)}</strong>` : ''} = <strong>₹ ${rs(bills - disc + tips)}</strong>` : ''}. Payments add up to <strong>₹ ${rs(paid)}</strong>. ${vsPage}
    ${off.length ? html`<br><span class="error">${off.length} bill${off.length > 1 ? 's have' : ' has'} payments that differ from the bill amount after discount or tip (marked red): ${off.map((r) => r.lineNo).join(', ')}. Compare sales cannot confirm the shift until each row's payments equal its amount less discount.</span>` : ''}`;
}

/** Bills of the old POS: 140000 to 159999 (or their last 3 digits), never in the software report. Shown as such, not as missing. */
const startsWithDate = (b) => {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(b);
  if (!m || +m[1] < 24) return false;
  const d = new Date(Date.UTC(2000 + +m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const isOldPos = (b) => /^1[45]\d{4}$/.test(b ?? ''); // 140000 to 159999; mirrors src/sales.ts
const isNewPos = (b) => /^\d{7,9}$/.test(b ?? '') && startsWithDate(b);
/** A number of neither format, new POS (YYMMDD and a running number) nor old POS. It can never meet a software bill. */
const isOddBill = (b) => !!b && !isNewPos(b) && !isOldPos(b);
const SHORT_OLD_POS_NOTE = 'Old POS bill, short number';
/** Whether 3-digit numbers can still be old POS bills: the old POS fades out once no full number is written for a week. */
const oldPosState = (o) => (!o?.lastSeen ? '' : o.inUse
  ? ` Old POS last seen ${dayLabel(o.lastSeen)}: a 3-digit number no new POS bill fits is taken as an old POS bill.`
  : ` Old POS not seen since ${dayLabel(o.lastSeen)} (over ${o.fadeDays} days): 3-digit numbers are no longer taken as old POS bills.`);
const OLD_POS_NOTE = 'Old POS bill';
/** Why a register number may be a typo. Bookr changes nothing: a person checks it against the photo. */
function numberFlagText(f) {
  const where = () => (f.sameShift ? "in this shift's report" : `in the ${dayLabel(f.day)} software report`);
  if (f.kind === 'pending') return `Could be ${f.billNo}: ${where()}, same amount ₹ ${rs(f.amountPaise)}.`;
  if (f.kind === 'pending_typo') return `Same bill as ${f.billNo}? A digit or two off, ${where()}, same amount ₹ ${rs(f.amountPaise)}.`;
  if (f.kind === 'in_range') return `Could be ${f.billNo}: fits ${dayLabel(f.date)}'s running numbers, 1 to ${f.max}.`;
  return `Running number ${f.seq} is past ${dayLabel(f.date)}'s last bill, ${f.max}: probably a typo.`;
}
/** An old POS or odd number uses the register only after a person has reviewed its row: nothing else can check it. */
const needsReview = (c) => !c.software && c.register && !c.register.reviewed && (isOldPos(c.billNo) || isOddBill(c.billNo));

const DELETE_REASONS = [['written_twice', 'Written twice on the page'], ['misread', 'Not on the page (read by mistake)'], ['not_a_bill', 'Not a bill (a note or total line)'], ['cancelled', 'Bill cancelled'], ['other', 'Other']];
const deleteReasonLabel = (k) => (DELETE_REASONS.find(([x]) => x === k)?.[1] ?? 'Other').toLowerCase();

/** Asks why a line is deleted; the page's totals may still include it, and Review explains them with it. */
function askDeleteReason(r) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'rowdlg';
    dlg.innerHTML = html`<form class="inset" method="dialog" style="display:grid;gap:10px">
      <h3 style="margin:0">Delete line ${r.lineNo}${r.billNo ? ` · bill ${r.billNo}` : ''}${r.amountPaise ? ` · ₹ ${rs(r.amountPaise)}` : ''}?</h3>
      <div class="note">Why? It is kept on record so the page totals can be explained.</div>
      ${DELETE_REASONS.map(([k, l], i) => html`<label style="display:flex;gap:8px;align-items:center"><input type="radio" name="reason" value="${k}" ${i === 0 ? 'checked' : ''}> ${l}</label>`)}
      <input name="note" placeholder="Note (optional)" maxlength="200">
      <div class="form-row" style="justify-content:flex-end"><button class="btn plain" value="cancel" type="submit">Cancel</button><button class="btn danger" value="ok" type="submit">Delete line</button></div>
    </form>`.__html;
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      const f = dlg.querySelector('form');
      resolve(dlg.returnValue === 'ok' ? { reason: f.reason.value, note: f.note.value.trim() || null } : null);
      dlg.remove();
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
    dlg.showModal();
  });
}

/** What the deleted lines of a page held, by column, as the paper still shows them. */
function deletedSums(u) {
  const d = u.deletedRows ?? [];
  const pay = (i) => d.reduce((t, r) => t + (r.payments ?? []).filter((p) => colOf(p) === i).reduce((a, p) => a + p.amountPaise, 0), 0);
  return { amount: pay(0) + pay(1) + pay(2) + pay(3), cash: pay(0), upi: pay(1), upi2: pay(2), card: pay(3), discount: d.reduce((t, r) => t + (r.discountPaise ?? 0), 0) };
}

// The bottom line of the page: what each column adds up to here, against the total written under it on the paper.
const TOTAL_COLS = [['amount', 'c-am', 'Total paid'], ['cash', 'c-p0', 'Cash'], ['upi', 'c-p1', PAY_COLS[1][1]], ['upi2', 'c-p2', PAY_COLS[2][1]], ['card', 'c-p3', 'Card'], ['discount', 'c-dc', 'Disc']];
function columnSums(u) {
  const pay = (i) => u.rows.reduce((t, r) => t + r.payments.filter((p) => colOf(p) === i).reduce((a, p) => a + p.amountPaise, 0), 0);
  // The total written under Bill Amt is what was paid in all modes, not the bill amounts added up.
  return { amount: pay(0) + pay(1) + pay(2) + pay(3), cash: pay(0), upi: pay(1), upi2: pay(2), card: pay(3), discount: u.rows.reduce((t, r) => t + (r.discountPaise ?? 0), 0) };
}
function regFootHtml(u, locked) {
  const sums = columnSums(u);
  const del = deletedSums(u);
  const w = u.columnTotals ?? {};
  const cell = ([k, c, l]) => {
    const has = w[k] != null;
    const diff = has ? sums[k] - w[k] : 0;
    // A difference made only by lines deleted here (the paper still has them) is explained, not wrong.
    const explained = has && diff !== 0 && del[k] !== 0 && sums[k] + del[k] === w[k];
    const st = !has ? '' : diff === 0 ? 'tot-ok' : explained ? 'tot-why' : 'tot-bad';
    return { k, c, l, has, diff, st, explained };
  };
  const cells = TOTAL_COLS.map(cell);
  const byKey = Object.fromEntries(cells.map((x) => [x.k, x]));
  const checked = cells.filter((x) => x.has);
  const bad = checked.filter((x) => x.diff !== 0 && !x.explained);
  const why = checked.filter((x) => x.explained);
  const gone = (u.deletedRows ?? []).filter((r) => r.amountPaise || (r.payments ?? []).length);
  const goneText = gone.map((r) => `row ${r.lineNo}${r.billNo ? ` (bill ${r.billNo})` : ''} deleted: ${deleteReasonLabel(r.reason)}${r.note ? `, ${r.note}` : ''}`).join(' · ');
  const verdict = u.readingTotals ? html`<span class="tiny">Reading the total line from the photo…</span>`
    : !checked.length ? html`<span class="tiny">${u.columnTotals ? 'No totals found on the photo. Type the totals from the last line of the page to check each column.' : 'Type the totals written on the last line of the page to check each column.'}</span>`
    : !bad.length && !why.length ? html`<span class="ok-msg">✓ ${checked.length === cells.length ? 'Every column' : `${checked.length} column${checked.length > 1 ? 's' : ''}`} match${checked.length === 1 ? 'es' : ''} the page</span>`
    : html`${bad.length ? html`<span class="error">${bad.map((x) => `${x.l} ₹ ${rs(Math.abs(x.diff))} ${x.diff > 0 ? 'more' : 'less'} than written`).join(' · ')}</span>` : ''}
      ${why.length ? html`<span class="tot-whymsg">${bad.length ? html`<br>` : ''}${why.map((x) => `${x.l} ₹ ${rs(Math.abs(x.diff))} ${x.diff > 0 ? 'more' : 'less'}`).join(', ')} than written, explained: ${goneText}</span>` : ''}`;
  const billsTotal = u.rows.reduce((t, r) => t + r.amountPaise, 0);
  const sumTd = (k) => { const x = byKey[k]; return html`<td class="amount ${x.c} ${x.st}" data-l="${x.l}" title="${x.has && x.diff ? `Written ₹ ${rs(w[k])}: rows are ₹ ${rs(Math.abs(x.diff))} ${x.diff > 0 ? 'more' : 'less'}${x.explained ? ` because of deleted lines: ${goneText}` : ''}` : ''}">${rs(sums[k])}${x.has && x.diff ? html`<span class="tot-diff">${x.diff > 0 ? '+' : '−'}${rs(Math.abs(x.diff))}</span>` : ''}${k === 'amount' ? html`<span class="tot-sub" title="Bill amounts added up">bills ${rs(billsTotal)}</span>` : ''}</td>`; };
  const inTd = (k) => { const x = byKey[k]; return html`<td class="${x.c}" data-l="${x.l}">${locked ? html`<span class="amount mono" style="display:block">${x.has ? rs(w[k]) : ''}</span>`
    : html`<input class="cell mono ${x.st}" data-tot="${k}" value="${x.has ? rsIn(w[k]) : ''}" placeholder="–" style="width:100%;text-align:right" inputmode="decimal" aria-label="${x.l} total written on the page">`}</td>`; };
  return html`<tr class="tot-rows"><td class="ln"></td><td class="c-bn"><strong>Rows add up to</strong><span class="tot-sub">paid in all modes</span></td>${sumTd('amount')}<td class="c-ty"></td>${sumTd('cash')}${sumTd('upi')}${sumTd('upi2')}${sumTd('card')}${sumTd('discount')}<td class="c-rm tot-verdict" colspan="4">${verdict}</td></tr>
    <tr class="tot-written"><td class="ln"></td><td class="c-bn">Written on the page</td>${inTd('amount')}<td class="c-ty"></td>${inTd('cash')}${inTd('upi')}${inTd('upi2')}${inTd('card')}${inTd('discount')}<td class="c-rm" colspan="4"></td></tr>
    ${(u.deletedRows ?? []).length ? html`<tr class="tot-deleted"><td class="ln"></td><td class="c-bn" colspan="12"><span class="tiny">Deleted from this page:
      ${(u.deletedRows).map((r, i) => html`${i ? ' · ' : ''}row ${r.lineNo}${r.billNo ? ` bill ${r.billNo}` : ''}${r.amountPaise ? ` ₹ ${rs(r.amountPaise)}` : ''}, ${deleteReasonLabel(r.reason)}${r.note ? ` (${r.note})` : ''}${r.by ? ` by ${r.by}` : ''}`)}</span></td></tr>` : ''}`;
}

/** Saves the column totals typed on the bottom line; each saves when you leave it. A page read before totals were
 * read with the rest has none yet (null): its total line is read from the photo once, on the first open. */
function wireFoot(biz, u) {
  if (u.columnTotals === null && !u.fromSoftware && !u.readingTotals && !u.totalsTried) {
    u.readingTotals = true; u.totalsTried = true;
    const redraw = () => { const f = document.getElementById('regfoot'); if (f) { f.innerHTML = regFootHtml(u, false).__html; wireFoot(biz, u); } };
    redraw();
    api('POST', `/businesses/${biz.id}/uploads/${u.id}/read-totals`, {})
      .then((res) => { u.columnTotals = res.columnTotals; })
      .catch(() => { /* the boxes stay open for typing */ })
      .finally(() => { u.readingTotals = false; redraw(); });
    return;
  }
  document.querySelectorAll('#regfoot [data-tot]').forEach((inp) => inp.addEventListener('change', async () => {
    const columnTotals = Object.fromEntries([...document.querySelectorAll('#regfoot [data-tot]')].map((x) => [x.dataset.tot, x.value.replace(/,/g, '').trim()]));
    try {
      const res = await api('PATCH', `/businesses/${biz.id}/uploads/${u.id}`, { columnTotals });
      u.columnTotals = res.columnTotals;
      const at = inp.dataset.tot;
      document.getElementById('regfoot').innerHTML = regFootHtml(u, false).__html;
      wireFoot(biz, u);
      document.querySelector(`#regfoot [data-tot="${at}"]`)?.closest('td')?.nextElementSibling?.querySelector('input')?.focus();
    } catch (err) { showError(document.getElementById('rmsg'), err); }
  }));
}

/** Fill button and the amber note: redrawn after every inline save. */
function regToolsHtml(u, locked) {
  const slip = !locked && u.slip;
  return html`
    ${slip ? html`<div class="demo-band" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <span><strong>Payments look shifted by one line</strong> on lines ${slip.lines.join(', ')}: each payment equals the bill amount of the line ${slip.direction === 'up' ? 'below' : 'above'} it.
        Move them back? Line ${slip.receiver} gets the odd one out and stays red for you to check.</span>
        <button class="btn" type="button" id="unslip" data-dir="${slip.direction}">Shift them back</button></div>` : ''}
    ${!locked && [...new Set(u.rows.map((r) => headOf(r) ?? r))].some((r) => !r.paidWithRowId && r.payments.length && paidOf(r) > 0 && payDiffers(r)
        && [r, ...membersOf(r)].every((m) => (!m.discountPaise && !m.tipPaise) || inferredOf(m.ocrOriginal).has('discount')))
        ? html`<div class="form-row" style="align-items:center;gap:8px"><button class="btn plain" type="button" id="filldisc" style="min-height:32px;font-size:13px"
            title="Sets Disc = bill amount − payments where nobody has typed one: a discount when less was paid, a tip (negative) when more was paid. For bills paid together, it goes on the row with the payment.">Fill discounts and tips</button>
            <span class="tiny">where the payment differs from the bill and no discount is typed</span></div>` : ''}
  `;
}

/** Edits between two bill numbers (a wrong, extra or missing digit counts one), for suggestions. */
function digitDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Software bills of the shift the typed number probably means: exactly it, its last digits, a digit wrong, extra or
 *  missing, or containing it. An exact number first, then the same amount as the line; bills already on the register last. */
function billCandidates(typed, row, list) {
  const w = typed.replace(/\D/g, '');
  if (!w) return list.filter((b) => b.amountPaise === row?.amountPaise && !b.used).slice(0, 6).map((b) => ({ ...b, why: 'same amount' }));
  const out = [];
  for (const b of list) {
    const s2 = b.billNo.replace(/\D/g, '');
    let why = null, score = 0;
    if (b.billNo === typed.trim()) { why = 'exact number'; score = -100; }
    else if (s2 === w) why = 'same digits';
    else if (w.length >= 2 && s2.endsWith(w)) why = 'last digits';
    else if (w.length >= 4 && digitDistance(w, s2) === 1) { why = w.length > s2.length ? 'extra digit' : w.length < s2.length ? 'missing digit' : 'one digit off'; score = 1; }
    else if (w.length >= 3 && s2.includes(w)) { why = 'contains'; score = 2; }
    else if (w.length >= 6 && digitDistance(w, s2) === 2) { why = 'two digits off'; score = 3; }
    if (!why) continue;
    out.push({ ...b, why, rank: (row && b.amountPaise === row.amountPaise ? 0 : 20) + (b.used ? 8 : 0) + score });
  }
  return out.sort((x, y) => x.rank - y.rank || x.billNo.localeCompare(y.billNo)).slice(0, 7);
}

/** A suggestion list under the bill box: while typing, and on entering a red bill box. ↑ ↓ choose, Enter picks, Esc closes. */
function billSuggest(input, u, rowOf, pick) {
  if (!input || !(u.softwareList ?? []).length) return;
  let pop = null, at = -1, items = [];
  const close = () => { pop?.remove(); pop = null; at = -1; };
  const show = () => {
    const row = rowOf();
    items = billCandidates(input.value, row, u.softwareList);
    close();
    if (!items.length) return;
    pop = document.createElement('div');
    pop.className = 'billpop';
    pop.innerHTML = items.map((b, i) => html`<button type="button" data-i="${i}" class="${b.used && b.billNo !== row?.billNo ? 'taken' : ''}">
      <span class="mono">${b.billNo}</span><span>₹ ${rs(b.amountPaise)}${row && b.amountPaise === row.amountPaise ? ' ✓' : ''}</span>
      <span class="tiny">${MODE_LABELS[b.mode] ?? ''} · ${when(b.paidAt)} · ${b.why}${b.used && b.billNo !== row?.billNo ? ' · on register' : ''}</span></button>`.__html).join('');
    const r = input.getBoundingClientRect();
    Object.assign(pop.style, { left: `${r.left + window.scrollX}px`, top: `${r.bottom + window.scrollY + 2}px` });
    document.body.appendChild(pop);
    // The exact number is already chosen, so Enter takes it.
    if (items[0].why === 'exact number') { at = 0; mark(); }
    pop.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-i]'); if (!b) return; e.preventDefault(); const v = items[+b.dataset.i]; close(); pick(v.billNo, v); });
  };
  const mark = () => pop?.querySelectorAll('[data-i]').forEach((b, i) => b.classList.toggle('on', i === at));
  input.addEventListener('input', show);
  input.addEventListener('focus', () => { if (input.classList.contains('flag')) show(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (!pop) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; mark(); }
    else if (e.key === 'Enter' && at >= 0) { e.preventDefault(); const v = items[at]; close(); pick(v.billNo, v); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
}

/** The top bar: how far checking has got, and whether the page adds up. */
function regBarHtml(u) {
  const done = u.rows.filter((r) => r.status === 'checked').length;
  const needs = u.rows.filter((r) => rowIssues(r).needsYou).length;
  const bills = u.rows.reduce((s2, r) => s2 + r.amountPaise, 0);
  const net = u.rows.reduce((s2, r) => s2 + r.amountPaise - (r.discountPaise ?? 0), 0);
  const paid = u.rows.reduce((s2, r) => s2 + paidOf(r), 0);
  const w = u.pageWrittenTotalPaise;
  const pct = u.rows.length ? Math.round((100 * done) / u.rows.length) : 0;
  const chip = (ok, text, title = '') => html`<span class="tchip ${ok ? 'ok' : 'bad'}" title="${title}">${text}</span>`;
  return html`
    <div class="rv-prog"><span class="bar"><span style="width:${pct}%"></span></span><span><strong>${done} of ${u.rows.length}</strong> checked${needs ? html` · <strong style="color:#B91C1C">${needs} need${needs === 1 ? 's' : ''} you</strong>` : ''}</span></div>
    <span class="rv-chips">
      ${w == null ? html`<span class="tchip" title="Type the total written at the foot of the page, below the table">No page total</span>`
        : chip(w === bills || w === net || w === paid, w === bills || w === net ? `Bills ₹ ${rs(bills)} = page total ✓` : w === paid ? `Paid = page total ✓` : `Page says ₹ ${rs(w)} · bills ₹ ${rs(bills)}`)}
      ${chip(paid === net, paid === net ? `Paid ₹ ${rs(paid)} ✓` : `Paid ₹ ${rs(paid)} · ${paid < net ? `${rs(net - paid)} short` : `${rs(paid - net)} over`}`, 'Payments against the bills after discounts and tips')}
    </span>
    <span class="seg" role="group" aria-label="Show"><button type="button" data-filter="needs" class="${regFilter === 'needs' ? 'on' : ''}">Needs you (${needs})</button><button type="button" data-filter="all" class="${regFilter === 'all' ? 'on' : ''}">All</button></span>
    <button class="btn plain" type="button" id="nextissue" ${needs ? '' : 'disabled'}>Next issue ↓</button>`;
}
let regFilter = 'all';

// Issue cards: what Bookr can see clearly on a shift's rows but a person must agree to (5 Nov 2026). Nothing happens
// until a button is pressed. "As on the register" hides them and leaves the page laid out as the paper is.
const REG_VIEW_KEY = 'bookr.review.view';
let regView = (() => { try { return localStorage.getItem(REG_VIEW_KEY) === 'register' ? 'register' : 'cards'; } catch { return 'cards'; } })();
const pageRowLabel = (u, x) => `Page ${x.pageNo ?? u.pageNo ?? '?'}, row ${x.lineNo}`;

/** The cards for rows on this page. A row holding a group's payment is never offered for deleting: its bills would lose it. */
function reviewCards(u) {
  const gone = dismissed();
  const here = (xs) => xs.some((x) => !x.elsewhere);
  const at = (x) => (x.pageNo ?? u.pageNo ?? 0) * 10000 + x.lineNo;
  const cards = [];
  const byNo = new Map();
  for (const r of regRows) if (r.billNo) byNo.set(r.billNo, [...(byNo.get(r.billNo) ?? []), r]);
  for (const [no, list] of byNo) {
    if (list.length < 2 || !here(list)) continue;
    const rows = [...list].sort((a, b) => at(a) - at(b));
    const software = (u.softwareList ?? []).find((b) => b.billNo === no) ?? null;
    if (new Set(rows.map((r) => r.amountPaise)).size > 1) {
      // A row whose amount is exactly another bill's, one digit away and not in the register (11 Nov 2026): its number is
      // probably a slip for that bill. Offered only when one bill fits; a person changes it.
      const fixes = rows.filter((x) => !x.elsewhere).flatMap((x) => {
        const f = (x.numberFlags ?? []).filter((y) => y.kind === 'pending_typo' || y.kind === 'pending');
        return f.length === 1 ? [{ row: x, billNo: f[0].billNo, amountPaise: f[0].amountPaise, sw: (u.softwareList ?? []).find((b) => b.billNo === f[0].billNo), bank: x.slipBank }] : [];
      });
      cards.push({ key: `rv:two:${no}`, kind: 'two', title: `Bill ${no} has two amounts`, reason: fixes.length ? 'A number written wrong?' : 'Same number, different amounts', rows, software, fixes,
        note: fixes.length ? fixes.map((f) => `${pageRowLabel(u, f.row)} is probably bill ${f.billNo}: the software has ${f.billNo} for ₹ ${rs(f.amountPaise)}${f.sw?.paidAt ? ` at ${when(f.sw.paidAt)}` : ''}, not in the register. Same amount, one digit apart.${f.bank ? ` The bank got ₹ ${rs(f.bank.amountPaise)} at ${when(f.bank.at)}${f.bank.amountPaise > f.amountPaise ? `, which is ₹ ${rs(f.amountPaise)} plus the ₹ ${rs(f.bank.amountPaise - f.amountPaise)} tip on this row` : ''}.` : ''}`).join(' ')
          : 'Bookr cannot tell which is right. Open each row and compare it with the photo.' });
      continue;
    }
    // The later line is taken as the repeat, unless the earlier one has less on it (no payment, no group).
    const weight = (x) => (membersOf(x).length ? 2 : x.paidWithRowId || x.payments.length ? 1 : 0);
    for (const later of rows.slice(1)) {
      const [keep, odd] = weight(later) > weight(rows[0]) ? [later, rows[0]] : [rows[0], later];
      if (!here([keep, odd])) continue;
      cards.push({ key: `rv:dup:${[keep.id, odd.id].sort().join(':')}`, kind: 'dup', title: `Bill ${no} is written twice`, reason: 'Same number, same amount', rows: [keep, odd], odd, software });
    }
  }
  for (const head of regRows) {
    const ms = membersOf(head);
    const short = groupNet(head) - paidOf(head);
    if (!ms.length || short <= 0 || !here([head, ...ms])) continue;
    const fits = ms.filter((m) => netOf(m) === short);
    if (!fits.length) continue;
    cards.push({ key: `rv:grp:${head.id}:${short}`, kind: 'group', title: `Bills paid together are ₹ ${rs(short)} short`, reason: `${fits.length > 1 ? 'Bills' : 'A bill'} of exactly that amount`,
      rows: [head, ...fits], fits, note: 'Taking a bill out does not delete it: it then needs its own payment, or deleting if it was written twice.' });
  }
  return cards.filter((c) => !gone.has(c.key));
}

function cardRowHtml(u, x, odd) {
  const label = pageRowLabel(u, x);
  const pays = x.paidWithRowId ? `Paid with ${rowLabel(headOf(x) ?? { lineNo: '?' })}`
    : x.payments.length ? x.payments.map((p) => `${MODE_LABELS[p.mode] ?? p.mode} ${rs(p.amountPaise)}`).join(' + ') : 'No payment';
  return html`<div class="wit ${odd ? 'odd' : ''}">
    <div class="wit-l">${x.elsewhere ? html`<a href="#/b/${currentBizId()}/review/${x.uploadId}/${x.id}">${label}</a>` : html`<button type="button" class="linkbtn" data-cardrow="${x.id}" title="Show this row on the photo">${label} · photo</button>`}</div>
    <div class="wit-v"><span class="mono">${x.billNo || 'No number'}</span> · ₹ ${rs(x.amountPaise)}</div>
    <div class="tiny">${pays}${membersOf(x).length ? ` · pays for ${membersOf(x).length + 1} bills` : ''}</div>
  </div>`;
}

function cardActionsHtml(u, c) {
  const del = (x, other, cls, text) => html`<button class="btn ${cls}" type="button" data-carddel="${x.id}" data-note="${`same as ${pageRowLabel(u, other).toLowerCase()}`}">${text}</button>`;
  const not = html`<button class="btn plain" type="button" data-rvnot="${c.key}">Not this</button>`;
  if (c.kind === 'dup') {
    const keep = c.rows.find((x) => x !== c.odd);
    return html`${membersOf(c.odd).length ? '' : del(c.odd, keep, '', `Delete ${pageRowLabel(u, c.odd).toLowerCase()} (written twice)`)}
      ${membersOf(keep).length ? '' : del(keep, c.odd, 'plain', `Delete ${pageRowLabel(u, keep).toLowerCase()} instead`)}${not}`;
  }
  if (c.kind === 'two' && c.fixes?.length) {
    return html`${c.fixes.map((f) => html`<button class="btn" type="button" data-cardpick="${f.row.id}" data-no="${f.billNo}" title="Writes ${f.billNo} on ${pageRowLabel(u, f.row).toLowerCase()}. Check it against the photo first.">Change ${pageRowLabel(u, f.row).toLowerCase()} to ${f.billNo}</button>`)}${not}`;
  }
  if (c.kind === 'group') {
    return html`${c.fits.map((x) => html`<button class="btn ${c.fits.length > 1 ? 'plain' : ''}" type="button" data-cardout="${x.id}">Take ${pageRowLabel(u, x).toLowerCase()} out of the group</button>`)}${not}`;
  }
  return not;
}

function reviewCardHtml(u, c) {
  return html`<div class="rv-card" data-rvcard="${c.key}">
    <div class="lane-h"><strong>${c.title}</strong><span class="tchip ok">${c.reason}</span></div>
    <div class="wit3">${c.rows.map((x) => cardRowHtml(u, x, x === c.odd))}
      ${c.software ? html`<div class="wit"><div class="wit-l">Software report</div><div class="wit-v"><span class="mono">${c.software.billNo}</span> · ₹ ${rs(c.software.amountPaise)}</div><div class="tiny">${MODE_LABELS[c.software.mode] ?? ''}</div></div>` : ''}
    </div>
    ${c.note ? html`<div class="note">${c.note}</div>` : ''}
    <div class="form-row">${cardActionsHtml(u, c)}</div>
    <div class="form-msg"></div>
  </div>`;
}

/** The toggle, then the cards when they are on. */
function regCardsHtml(u) {
  const cards = reviewCards(u);
  return html`<div class="lane-h">
      <strong>${regView === 'register' ? 'As on the register' : cards.length ? `${cards.length} issue${cards.length === 1 ? '' : 's'} for you to decide` : 'No major issues found'}</strong>
      <span class="seg" role="group" aria-label="View"><button type="button" data-regview="cards" class="${regView === 'cards' ? 'on' : ''}">Issue cards (${cards.length})</button><button type="button" data-regview="register" class="${regView === 'register' ? 'on' : ''}">As on the register</button></span>
    </div>
    ${regView === 'cards' ? cards.map((c) => reviewCardHtml(u, c)) : ''}`;
}

/** Unticked rows of this page with nothing red or amber on them, and not in a group that does not add up (told only on its payment row). */
const cleanRows = (u) => u.rows.filter((r) => { if (r.status === 'checked' || payDiffers(r)) return false; const i = rowIssues(r); return !i.red.length && !i.amber.length; });
function regRowsHeadHtml(u) {
  if (regView !== 'cards') return '';
  const n = cleanRows(u).length;
  return html`<div class="lane-h"><strong>Rows</strong>${n ? html`<button class="btn plain" type="button" id="tickclean" style="min-height:32px;font-size:13px" title="Rows with nothing red or amber. Ticking says they match the photo.">Tick the ${n} clean row${n === 1 ? '' : 's'}</button>` : ''}</div>`;
}

function registerPanel(biz, u) {
  regRows = shiftRowsOf(u);
  const locked = u.shiftStatus === 'confirmed';
  const written = u.pageWrittenTotalPaise;
  return html`
    <section class="card grow3 regpanel" style="gap:10px">
      ${locked ? html`<div class="demo-band">The shift for ${dayLabel(u.day)} is confirmed, so this page is locked. An Owner can reopen it on Compare sales.</div>`
        : html`<div class="note">Fix anything that differs from the photo, then tick.
          <details class="howto"><summary>How this works</summary><kbd>Enter</kbd> ticks the row and moves on, <kbd>↑</kbd><kbd>↓</kbd> move between rows. Every change saves when you leave the cell. Red means it needs you: Claude could not read the cell, the bill number is not in the software report, or the payments do not add up. Amber was filled in by Bookr; check it against the photo. When every row is ticked and the payments match, an Owner or Accountant confirms the shift on <a href="#/b/${biz.id}/compare/${u.day}">Compare sales</a>, which locks this page. Use ✎ for a bill paid together with another, or paid in two ways in one column.</details></div>`}
      <div class="rv-bar" id="rvbar">${regBarHtml(u)}</div>
      <div id="regtools">${regToolsHtml(u, locked)}</div>
      ${locked ? '' : html`<div class="rv-cards" id="regcards"></div><div id="rowshead"></div>`}
      ${u.fromSoftware ? '' : html`<div class="strip" id="strip"><canvas></canvas><span class="band"></span>
        <span class="strip-tools"><span class="tiny" id="striphint"></span><button type="button" class="iconbtn" id="striprot" title="Turn the photo" aria-label="Turn the photo">⟳</button><button type="button" class="btn plain" id="photoside" style="min-height:28px;padding:0 10px;font-size:12px">Whole page</button></span></div>`}
      <div class="scroll"><table id="regtable" class="regtable ${regFilter === 'needs' ? 'only-needs' : ''}">
        <colgroup><col style="width:34px"><col style="width:112px"><col style="width:88px"><col style="width:76px"><col style="width:78px"><col style="width:78px"><col style="width:78px"><col style="width:70px"><col style="width:70px"><col style="width:130px"><col><col style="width:44px"><col style="width:104px"></colgroup>
        <thead><tr><th>#</th><th>Bill no</th><th style="text-align:right">Amount</th><th>Type</th>${PAY_COLS.map(([, l]) => html`<th style="text-align:right">${l}</th>`)}<th style="text-align:right" title="Discount. A tip is negative.">Disc</th><th>Remarks</th><th>Issue</th><th title="Looks right">✓</th><th></th></tr></thead>
        <tbody>${u.rows.map((r) => regRowHtml(r, locked))}</tbody>
        <tfoot id="regfoot">${regFootHtml(u, locked)}</tfoot>
      </table></div>
      <div class="form-row" style="justify-content:space-between;align-items:flex-end">
        <div class="note" id="regsum" style="flex:1 1 320px">${regSumHtml(u)}</div>
        ${locked ? '' : html`<button class="btn plain" type="button" id="addbill" title="A bill written on the page that has no line here yet">＋ Add a bill</button>`}
        ${locked ? '' : html`<form id="ptotal" class="form-row" style="align-items:flex-end"><div class="field"><label for="pt">Total written on the page (₹)</label><input id="pt" name="pageWrittenTotal" class="mono" value="${written == null ? '' : rsIn(written)}"></div><button class="btn plain" type="submit">Save total</button></form>`}
      </div>
      ${locked ? '' : html`<dialog class="rowdlg" id="rdialog" aria-label="Bill from the page"><form class="inset" id="rform"></form></dialog>`}
    </section>`;
}

/** Bills of this shift on one side only: in the software report but on no register page, or on a page but not in
 *  the report. A notice above the page; each count opens its list. Nothing when both sides agree. */
function drawWaiting(biz, u) {
  const host = document.getElementById('waiting');
  if (!host) return;
  const sw = u.softwareList ?? [];
  const compare = html`<a href="#/b/${biz.id}/compare/${u.day}">All bills of the shift →</a>`;
  if (!sw.length) {
    host.innerHTML = html`<div class="waiting"><span>No software report for ${dayLabel(u.day)} yet, so bill numbers cannot be matched.</span>${compare}</div>`.__html;
    return;
  }
  const inSw = new Set(sw.map((b) => b.billNo));
  const swOnly = sw.filter((b) => !b.used);
  const pageOnly = [...u.rows.map((r) => ({ ...r, uploadId: u.id, pageNo: u.pageNo })), ...(u.otherPageRows ?? [])]
    .filter((r) => r.billNo && !inSw.has(r.billNo) && !isOldPos(r.billNo)); // old POS bills are never in the report
  const n = swOnly.length + pageOnly.length;
  if (!n) { host.innerHTML = ''; return; }
  const open = host.dataset.open ?? '';
  const part = (key, count, text) => count ? html`<button type="button" class="linkbtn" data-wait="${key}" aria-expanded="${open === key}">${count} ${text} ${open === key ? '▾' : '▸'}</button>` : '';
  const list = open === 'sw' ? swOnly.map((b) => html`<div class="list-row"><span class="mono">${b.billNo}</span><span>₹ ${rs(b.amountPaise)}</span><span class="note">${MODE_LABELS[b.mode] ?? ''} · ${when(b.paidAt)}</span></div>`)
    : open === 'page' ? pageOnly.map((r) => html`<a class="list-row" style="color:inherit" href="#/b/${biz.id}/review/${r.uploadId}/${r.id}"><span class="mono">${r.billNo}</span><span>₹ ${rs(r.amountPaise)}</span><span class="note">${r.pageNo ? `Page ${r.pageNo} · ` : ''}line ${r.lineNo}</span></a>`)
    : null;
  host.innerHTML = html`<div class="waiting"><strong>⚠ ${n} bill${n === 1 ? '' : 's'} waiting:</strong>
    ${part('sw', swOnly.length, 'in software, not on any page')}${swOnly.length && pageOnly.length ? html`<span class="note">·</span>` : ''}${part('page', pageOnly.length, 'on the pages, not in software')}
    ${compare}</div>
    ${list ? html`<div class="waitlist">${list}</div>` : ''}`.__html;
  host.querySelectorAll('[data-wait]').forEach((b) => b.addEventListener('click', () => {
    host.dataset.open = open === b.dataset.wait ? '' : b.dataset.wait;
    drawWaiting(biz, u);
  }));
}

/** Where a row's line sits on the photo, as % of the upright page height: from the reading, else estimated. */
function rowY(r) {
  let o = {};
  try { o = r.ocrOriginal ? JSON.parse(r.ocrOriginal) : {}; } catch { /* not JSON */ }
  if (typeof o.y === 'number') return { y: o.y, exact: true };
  const line = o.line ?? r.lineNo;
  return { y: 21 + ((line - 0.5) * (80 - 21)) / 20, exact: false }; // a 20-line register page, ruled lines from about 21% to 80%
}
const ROT = { rotated_90_clockwise: 270, rotated_180: 180, rotated_90_counterclockwise: 90 };

/** The photo strip above the table: the page turned upright, zoomed to the line of the row you are on.
 *  Scroll over the strip to line it up when the place is estimated; the nudge is remembered for the page. */
function wireStrip(u, fileUrl, root = document) {
  const box = root.querySelector('.strip');
  const none = { show() {} };
  if (!box) return none;
  const cv = box.querySelector('canvas');
  const band = box.querySelector('.band');
  const hint = box.querySelector('.strip-tools .tiny');
  const key = `bookr.strip.${u.id}`;
  let orient = 'upright';
  for (const r of u.rows) { try { orient = JSON.parse(r.ocrOriginal ?? '{}').orientation ?? orient; } catch { /* not JSON */ } if (orient !== 'upright') break; }
  let rot = ROT[orient] ?? 0;
  let nudge = 0;
  try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); if (v) { nudge = v.nudge ?? 0; rot = v.rot ?? rot; } } catch { /* storage unavailable */ }
  const remember = () => { try { localStorage.setItem(key, JSON.stringify({ nudge, rot })); } catch { /* storage unavailable */ } };
  let up = null, cur = null;
  const img = new Image();
  const build = () => {
    const deg = ((rot % 360) + 360) % 360;
    const sw = deg % 180 ? img.naturalHeight : img.naturalWidth, sh = deg % 180 ? img.naturalWidth : img.naturalHeight;
    const k = Math.min(1, 1800 / sw);
    up = document.createElement('canvas');
    up.width = Math.round(sw * k); up.height = Math.round(sh * k);
    const g = up.getContext('2d');
    g.translate(up.width / 2, up.height / 2);
    g.rotate((deg * Math.PI) / 180);
    g.drawImage(img, (-img.naturalWidth * k) / 2, (-img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
    draw();
  };
  const draw = () => {
    if (!up || !cur) return;
    const W = box.clientWidth, H = box.clientHeight, dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const srcH = Math.min(up.height, (up.width * H) / W);
    const cy = ((cur.y + (cur.exact ? 0 : nudge)) / 100) * up.height;
    const sy = Math.max(0, Math.min(up.height - srcH, cy - srcH / 2));
    cv.getContext('2d').drawImage(up, 0, sy, up.width, srcH, 0, 0, cv.width, cv.height);
    const lineH = Math.max(14, ((0.03 * up.height) / srcH) * H);
    band.style.top = `${((cy - sy) / srcH) * H - lineH / 2}px`;
    band.style.height = `${lineH}px`;
    hint.textContent = cur.exact ? '' : 'Place estimated: scroll here to line it up';
  };
  img.onload = build;
  img.onerror = () => box.remove();
  img.src = fileUrl;
  box.addEventListener('wheel', (e) => {
    if (!cur || cur.exact) return;
    e.preventDefault();
    nudge += e.deltaY > 0 ? 0.6 : -0.6;
    remember(); draw();
  }, { passive: false });
  box.querySelector('.strip-tools .iconbtn')?.addEventListener('click', () => { rot = (rot + 90) % 360; remember(); if (img.complete) build(); });
  window.addEventListener('resize', draw);
  return { show(r) { cur = rowY(r); draw(); } };
}

/** Saves a row from its inline cells. One save at a time per row; the table is redrawn from the server.
 *  Keyboard: Enter ticks the row and moves to the next unticked one; ↑ and ↓ move to the same cell above or below. */
function wireInlineRows(biz, u, strip) {
  const table = document.getElementById('regtable');
  if (!table) return;
  let chain = Promise.resolve();
  let pending = 0;
  const val = (tr, f) => tr.querySelector(`[data-f="${f}"]`);
  const payloadOf = (tr, r) => {
    const unlinked = tr.dataset.unlinked === '1';
    let payments = [];
    if (!r.paidWithRowId || unlinked) {
      PAY_COLS.forEach(([mode, label], i) => {
        const had = r.payments.filter((p) => colOf(p) === i);
        // "1000+500" is two payments in this column.
        for (const v of (val(tr, `pay${i}`)?.value ?? '').split('+').map((x) => x.trim()).filter(Boolean)) {
          payments.push({ mode, columnLabel: had[0]?.columnLabel ?? label, amount: v });
        }
      });
    }
    return {
      paidWithRowId: unlinked ? null : r.paidWithRowId,
      billNo: val(tr, 'billNo').value.trim(), billType: val(tr, 'billType').value || null, amount: val(tr, 'amount').value.trim() || '0', discount: val(tr, 'discount').value || '0',
      remarks: val(tr, 'remarks').value.trim() || null, payments, status: val(tr, 'checked').checked ? 'checked' : 'draft',
    };
  };
  const redraw = () => {
    // The box being typed in keeps what was typed (not saved until you leave it) and where the cursor was.
    const active = document.activeElement;
    const keep = active?.closest?.('tr')?.dataset.row && active.dataset.f ? {
      row: active.closest('tr').dataset.row, f: active.dataset.f, value: active.type === 'checkbox' ? null : active.value,
      checked: active.type === 'checkbox' ? active.checked : null, start: active.selectionStart ?? null, end: active.selectionEnd ?? null,
    } : null;
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = u.rows.map((x) => regRowHtml(x, false).__html).join('');
    tbody.querySelectorAll('tr[data-row]').forEach(bind);
    const back = keep && tbody.querySelector(`tr[data-row="${keep.row}"] [data-f="${keep.f}"]`);
    if (back) {
      if (keep.value !== null && back.value !== keep.value) back.value = keep.value;
      back.focus();
      if (keep.start !== null && back.setSelectionRange) { try { back.setSelectionRange(keep.start, keep.end); } catch { /* not a text box */ } }
    }
    document.getElementById('regsum').innerHTML = regSumHtml(u).__html;
    document.getElementById('regfoot').innerHTML = regFootHtml(u, false).__html; wireFoot(biz, u);
    document.getElementById('rvbar').innerHTML = regBarHtml(u).__html;
    document.getElementById('regtools').innerHTML = regToolsHtml(u, false).__html;
    wireBar(); wireFill(); drawWaiting(biz, u); drawCards();
  };
  // A save's answer carries the rows of the groups it touched (17 Nov 2026): the screen takes them at once instead of
  // waiting to load the whole page again; the page is still loaded after the last save, for the number checks.
  const patchRows = (rows) => {
    for (const n of rows ?? []) {
      const x = u.rows.find((y) => y.id === n.id) ?? (u.otherPageRows ?? []).find((y) => y.id === n.id);
      if (x) Object.assign(x, n);
    }
    regRows = shiftRowsOf(u);
  };
  const discCell = (rowId) => table.querySelector(`tr[data-row="${rowId}"] [data-f="discount"]`);
  const ocrOf = (r) => { try { return JSON.parse(r.ocrOriginal ?? '{}') ?? {}; } catch { return {}; } };
  // What the group's discount will be, shown on the row with the payment while the save is on its way: the same rule
  // as the server (a filled discount, or one that was exactly the gap, follows the gap when it is up to the limit).
  const previewGroup = (tr, r) => {
    const head = r.paidWithRowId ? headOf(r) : membersOf(r).length ? r : null;
    if (!head || head.elsewhere) return;
    const group = [head, ...membersOf(head)];
    if (group.some((m) => m.id !== head.id && m.discountPaise)) return;
    const amt = (m) => (m.id === r.id ? parsePaiseText(val(tr, 'amount').value.trim() || '0') : m.amountPaise);
    const paidNow = head.id === r.id ? PAY_COLS.reduce((t, _, i) => t + (val(tr, `pay${i}`)?.value ?? '').split('+').reduce((t2, v) => t2 + (parsePaiseText(v.trim() || '0') ?? 0), 0), 0) : paidOf(head);
    const grossWas = group.reduce((t, m) => t + m.amountPaise, 0);
    const gapWas = grossWas - paidOf(head);
    const gross = group.reduce((t, m) => t + (amt(m) ?? 0), 0);
    const gap = gross - paidNow;
    const follows = ocrOf(head).autoGroupDiscount || (gapWas > 0 && head.discountPaise === gapWas);
    if (!follows || group.some((m) => !(amt(m) > 0)) || paidNow <= 0 || gap <= 0 || gap * 100 > LARGE_DISCOUNT_PCT * gross || gap === head.discountPaise) return;
    const cell = discCell(head.id);
    if (!cell) return;
    cell.value = rsIn(gap);
    cell.closest('td')?.insertAdjacentHTML('beforeend', html`<div class="tiny note disc-saving">→ ₹ ${rs(gap)} · saving…</div>`.__html);
  };
  const save = (tr, changed, extra = {}) => {
    const id = tr.dataset.row;
    const r = u.rows.find((x) => x.id === id);
    const unlinked = tr.dataset.unlinked === '1';
    // Discount follows the payments: amount − payments, negative when more was paid (a tip). Not for bills paid
    // together; a row just given its own payment ("Own payment") is on its own again.
    let discNote = '';
    if (/^(amount|pay\d)$/.test(changed.dataset.f) && (!r.paidWithRowId || unlinked) && !membersOf(r).length) {
      const a = parsePaiseText(val(tr, 'amount').value);
      const paid = PAY_COLS.reduce((t, _, i) => t + (val(tr, `pay${i}`)?.value ?? '').split('+').reduce((t2, v) => t2 + (parsePaiseText(v.trim() || '0') ?? 0), 0), 0);
      if (a !== null && paid > 0) {
        const was = parsePaiseText(val(tr, 'discount').value.trim() || '0') ?? 0;
        val(tr, 'discount').value = paid !== a ? rupeesForInput(a - paid) : '';
        // A discount someone wrote that is now replaced is said, so it is not lost unseen.
        if (was && was !== a - paid) discNote = `Bill ${r.billNo || `on row ${r.lineNo}`}: ${discWord(was)} → ${discWord(a - paid)} (amount less paid).`;
      }
    } else if (/^(amount|pay\d)$/.test(changed.dataset.f)) previewGroup(tr, r);
    const body = rowEditBody(rowInputOf(r), payloadOf(tr, r), extra);
    // Saves go one at a time, in the order made.
    pending += 1;
    const run = chain.then(async () => {
      let res;
      try {
        res = await apiFull('PUT', `/businesses/${biz.id}/register-rows/${id}`, body);
        document.getElementById('rmsg').innerHTML = '';
      } catch (err) {
        if (err.code === 'stale_row') {
          // Changed on another screen: show the row as it is saved now, with the reason.
          const fresh = await api('GET', `/businesses/${biz.id}/uploads/${u.id}`).catch(() => null);
          if (fresh) { Object.assign(u, { rows: fresh.rows, otherPageRows: fresh.otherPageRows, slip: fresh.slip, softwareList: fresh.softwareList }); regRows = shiftRowsOf(u); redraw(); }
          showError(document.getElementById('rmsg'), err);
          return;
        }
        // Not saved: what was typed stays on screen with the reason, to be fixed, rather than snapping back.
        showError(document.getElementById('rmsg'), err);
        tr.classList.add('save-failed');
        table.querySelectorAll('.disc-saving').forEach((x) => x.remove());
        // A tick that was refused comes off, so the row does not look checked.
        if (changed.dataset.f === 'checked') changed.checked = false;
        const cell = tr.querySelector('.c-is');
        if (cell) cell.innerHTML = html`<div class="error">Not saved: ${err.message}</div>`.__html + cell.innerHTML;
        return;
      }
      patchRows(res?.rows);
      const notes = [discNote, ...(res?.notes ?? []).map((n) => {
        const h = u.rows.find((x) => x.id === n.rowId) ?? regRows.find((x) => x.id === n.rowId);
        return `Bill ${h?.billNo ?? ''} (${h ? rowLabel(h) : 'paying row'}): ${n.words}.`;
      })].filter(Boolean);
      if (notes.length) doneToast(notes.join(' '));
      if (pending > 1) {
        // Another save is waiting: only the discounts the server changed are put on screen now.
        for (const n of res?.rows ?? []) { const c = discCell(n.id); if (c && c !== document.activeElement) c.value = n.discountPaise ? rsIn(n.discountPaise) : ''; }
        table.querySelectorAll('.disc-saving').forEach((x) => x.remove());
        return;
      }
      redraw();
      const fresh = await api('GET', `/businesses/${biz.id}/uploads/${u.id}`).catch(() => null);
      if (!fresh || pending > 1) return; // another save started meanwhile: it redraws
      u.rows = fresh.rows;
      u.otherPageRows = fresh.otherPageRows;
      u.slip = fresh.slip;
      u.softwareList = fresh.softwareList;
      u.pageWrittenTotalPaise = fresh.pageWrittenTotalPaise; u.columnTotals = fresh.columnTotals; u.deletedRows = fresh.deletedRows;
      regRows = shiftRowsOf(u);
      // Redraw every row: fixing one bill number changes what the others are offered.
      redraw();
    }).finally(() => { pending -= 1; });
    chain = run.catch(() => {});
    return run;
  };
  // A group whose bills and payment do not agree: one click writes the difference as the discount (or tip) on the row
  // with the payment (17 Nov 2026), for gaps the screen does not fill by itself (over the limit, or more paid).
  if (!table.dataset.grpwired) {
    table.dataset.grpwired = '1';
    table.addEventListener('click', (e) => {
      const b = e.target.closest?.('[data-grpfix]');
      if (!b) return;
      const tr = table.querySelector(`tr[data-row="${b.dataset.grpfix}"]`);
      const d = tr && val(tr, 'discount');
      if (!d) return;
      d.value = rupeesForInput(Number(b.dataset.to));
      b.disabled = true;
      save(tr, d);
    });
  }
  const rowsShown = () => [...table.querySelectorAll('tbody tr[data-row]')].filter((x) => x.offsetParent !== null);
  const focusRow = (tr, f = 'billNo') => { const el = tr?.querySelector(`[data-f="${f}"]`) ?? tr?.querySelector('[data-f]'); el?.focus(); el?.select?.(); };
  const bind = (tr) => {
    tr.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => save(tr, el)));
    tr.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { const bn = val(tr, 'billNo'); bn.value = b.dataset.pick; save(tr, bn); }));
    tr.querySelector('[data-unlink]')?.addEventListener('click', () => { tr.dataset.unlinked = '1'; save(tr, val(tr, 'amount')); });
    tr.querySelector('[data-usehint]')?.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const amount = val(tr, 'amount');
      amount.value = b.dataset.amt;
      if (b.dataset.pay) {
        const filled = PAY_COLS.map((_, i) => val(tr, `pay${i}`)).filter((x) => x && x.value.trim());
        const target = filled.length === 1 ? filled[0] : !filled.length ? val(tr, `pay${{ cash: 0, upi: 1, card: 3 }[b.dataset.mode] ?? 1}`) : null;
        if (target && !target.readOnly) target.value = b.dataset.amt;
      }
      save(tr, amount);
    });
    tr.querySelector('[data-setcol]')?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      const h = u.rows.find((x) => x.id === tr.dataset.row)?.columnHint;
      if (!h) return;
      b.disabled = true;
      try {
        await chain;
        const undo = await setColumn(biz, { hint: h, match: false });
        await reviewView(biz, u.id, tr.dataset.row);
        doneToast(`Bill ${h.billNo ?? ''}: moved to ${h.toLabel}.`, undo, () => reviewView(biz, u.id, tr.dataset.row));
      } catch (err) { b.disabled = false; showError(document.getElementById('rmsg'), err); }
    });
    tr.querySelector('[data-edit]')?.addEventListener('click', () => openRowForm(tr.dataset.row));
    tr.querySelector('[data-undodisc]')?.addEventListener('click', () => { const d = val(tr, 'discount'); d.value = '0'; save(tr, d); });
    tr.querySelector('[data-split]')?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await chain;
        const { id, bills } = await api('POST', `/businesses/${biz.id}/register-rows/${tr.dataset.row}/split`, {});
        await reviewView(biz, u.id, id);
        doneToast(`Split into ${bills[0]} and ${bills[1]}. Check both lines against the photo and tick them.`);
      } catch (err) { b.disabled = false; showError(document.getElementById('rmsg'), err); }
    });
    tr.querySelector('[data-addbelow]')?.addEventListener('click', async () => {
      try {
        const { id } = await api('POST', `/businesses/${biz.id}/register-rows/${tr.dataset.row}/insert-below`, {});
        await reviewView(biz, u.id, id);
      } catch (err) { showError(document.getElementById('rmsg'), err); }
    });
    tr.querySelector('[data-copydel]')?.addEventListener('click', () => tr.querySelector('[data-delrow]')?.click());
    tr.querySelector('[data-copykeep]')?.addEventListener('click', () => { const cb = tr.querySelector('[data-f="checked"]'); if (cb && !cb.checked) cb.click(); });
    tr.querySelector('[data-delrow]')?.addEventListener('click', async () => {
      const r = u.rows.find((x) => x.id === tr.dataset.row);
      const why = await askDeleteReason(r);
      if (!why) return;
      try { await api('DELETE', `/businesses/${biz.id}/register-rows/${r.id}`, why); reviewView(biz, u.id); }
      catch (err) { showError(document.getElementById('rmsg'), err); }
    });
    billSuggest(val(tr, 'billNo'), u, () => u.rows.find((x) => x.id === tr.dataset.row), (b, bill) => {
      val(tr, 'billNo').value = b;
      // An empty amount takes the software's for the bill picked. A person still checks and ticks the row.
      const amt = val(tr, 'amount');
      const blank = !parsePaiseText(amt.value.trim() || '0');
      if (blank && bill?.amountPaise) amt.value = rsIn(bill.amountPaise);
      // Picked from the software's list: the number is confirmed even when it is the one already read.
      save(tr, blank && bill?.amountPaise ? amt : val(tr, 'billNo'), { confirm: ['bill_no'] });
    });
    tr.addEventListener('focusin', () => {
      table.querySelectorAll('tr.current').forEach((x) => x.classList.remove('current'));
      tr.classList.add('current');
      const r = u.rows.find((x) => x.id === tr.dataset.row);
      if (r) strip.show(r);
    });
    tr.addEventListener('keydown', (e) => {
      const el = e.target;
      if (!el.dataset?.f || el.tagName === 'BUTTON' || e.defaultPrevented) return;
      const shown = rowsShown();
      const at = shown.indexOf(tr);
      if (e.key === 'Enter') {
        e.preventDefault();
        const box = val(tr, 'checked');
        if (!box.checked) { box.checked = true; save(tr, box); }
        const next = shown.slice(at + 1).find((x) => !val(x, 'checked')?.checked) ?? shown[at + 1];
        if (next) focusRow(next); else el.blur();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && el.tagName === 'INPUT' && el.type !== 'checkbox') {
        const to = shown[at + (e.key === 'ArrowDown' ? 1 : -1)];
        if (to) { e.preventDefault(); focusRow(to, el.dataset.f); }
      }
    });
  };
  const wireBar = () => {
    document.querySelectorAll('#rvbar [data-filter]').forEach((b) => b.addEventListener('click', () => {
      regFilter = b.dataset.filter;
      table.classList.toggle('only-needs', regFilter === 'needs');
      document.querySelectorAll('#rvbar [data-filter]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    document.getElementById('nextissue')?.addEventListener('click', () => {
      const shown = rowsShown();
      const cur = shown.findIndex((x) => x.classList.contains('current'));
      const needy = shown.filter((x) => x.classList.contains('needs-you'));
      const next = needy.find((x) => shown.indexOf(x) > cur) ?? needy[0];
      if (next) { next.scrollIntoView({ block: 'center', behavior: 'smooth' }); focusRow(next, next.querySelector('.flag')?.dataset.f ?? 'billNo'); }
    });
  };
  // Issue cards, and the toggle back to the page as the register has it.
  const drawCards = () => {
    const host = document.getElementById('regcards');
    if (!host) return;
    host.innerHTML = regCardsHtml(u).__html;
    document.getElementById('rowshead').innerHTML = regRowsHeadHtml(u).__html;
    host.querySelectorAll('[data-regview]').forEach((b) => b.addEventListener('click', () => {
      regView = b.dataset.regview;
      try { localStorage.setItem(REG_VIEW_KEY, regView); } catch { /* storage unavailable */ }
      drawCards();
    }));
    host.querySelectorAll('[data-cardrow]').forEach((b) => b.addEventListener('click', () => {
      const tr = table.querySelector(`tr[data-row="${b.dataset.cardrow}"]`);
      if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); focusRow(tr); }
    }));
    host.querySelectorAll('[data-rvnot]').forEach((b) => b.addEventListener('click', () => {
      const gone = dismissed(); gone.add(b.dataset.rvnot);
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...gone].slice(-500))); } catch { /* storage unavailable */ }
      drawCards();
    }));
    const act = (b, run, done) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await run();
        await reviewView(biz, u.id);
        document.getElementById('rmsg').innerHTML = html`<div class="ok-msg">${done}</div>`.__html;
      } catch (err) { b.disabled = false; showError(b.closest('[data-rvcard]').querySelector('.form-msg'), err); }
    });
    host.querySelectorAll('[data-carddel]').forEach((b) => {
      const x = regRows.find((y) => y.id === b.dataset.carddel);
      act(b, () => api('DELETE', `/businesses/${biz.id}/register-rows/${x.id}`, { reason: 'written_twice', note: b.dataset.note }), `${pageRowLabel(u, x)} deleted as written twice. It stays on record.`);
    });
    host.querySelectorAll('[data-cardout]').forEach((b) => {
      const x = regRows.find((y) => y.id === b.dataset.cardout);
      act(b, () => api('PUT', `/businesses/${biz.id}/register-rows/${x.id}`, { paidWithRowId: null, payments: [], status: 'draft', billNo: x.billNo ?? '', billType: x.billType ?? null,
        amount: rupeesForInput(x.amountPaise), discount: rupeesForInput(x.discountPaise ?? 0), remarks: x.remarks ?? null }), `${pageRowLabel(u, x)} taken out of the group. It now needs its own payment, or deleting if it was written twice.`);
    });
    host.querySelectorAll('[data-cardpick]').forEach((b) => b.addEventListener('click', () => {
      const tr = table.querySelector(`tr[data-row="${b.dataset.cardpick}"]`);
      const bn = tr && val(tr, 'billNo');
      if (!bn) return;
      b.disabled = true;
      bn.value = b.dataset.no;
      save(tr, bn);
    }));
    document.getElementById('tickclean')?.addEventListener('click', () => {
      for (const r of cleanRows(u)) {
        const tr = table.querySelector(`tr[data-row="${r.id}"]`);
        const box = tr && val(tr, 'checked');
        if (box && !box.checked) { box.checked = true; save(tr, box); }
      }
    });
  };
  let openRowForm = () => {};
  table.querySelectorAll('tbody tr[data-row]').forEach(bind);
  wireFoot(biz, u);
  wireBar();
  drawCards();
  // Start on the first row that needs you, so the strip shows its line.
  const first = table.querySelector('tbody tr.needs-you') ?? table.querySelector('tbody tr[data-row]');
  if (first) { const r = u.rows.find((x) => x.id === first.dataset.row); if (r) { first.classList.add('current'); strip.show(r); } }
  return (fn) => { openRowForm = fn; };
}

function rowForm(r) {
  const pays = r?.payments?.length ? r.payments : [{ mode: 'cash', columnLabel: '', amountPaise: null }];
  return html`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-size:15px;font-weight:600">${r ? `Edit bill ${r.billNo}` : 'Add a bill from the page'}</div>
      <button class="iconbtn" type="button" data-close title="Close" aria-label="Close">✕</button></div>
    <div class="form-row">
      <div class="field"><label>Bill number</label><input name="billNo" class="mono" value="${r?.billNo ?? ''}" required></div>
      <div class="field"><label>Type</label><select name="billType"><option value="">Choose</option>
        ${Object.entries(TYPE_LABELS).map(([k, l]) => html`<option value="${k}" ${r?.billType === k ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label>Bill amount (₹)</label><input name="amount" class="mono" value="${r ? rsIn(r.amountPaise) : ''}" required></div>
      <div class="field"><label>Discount (₹, a tip as negative)</label><input name="discount" class="mono" value="${r?.discountPaise ? rsIn(r.discountPaise) : ''}" placeholder="0"></div>
    </div>
    <div class="field" style="max-width:320px"><label>Paid together with another bill</label><select name="paidWithRowId"><option value="">No: this bill has its own payment</option>
      ${(r && membersOf(r).length ? [] : regRows.filter((x) => !x.paidWithRowId && (!r || x.id !== r.id))).map((x) => html`<option value="${x.id}" ${r?.paidWithRowId === x.id ? 'selected' : ''}>Paid with ${rowLabel(x)} (${x.billNo || 'no number'})</option>`)}</select></div>
    <div class="note">Payments as written on the page. A bill paid partly in cash and partly by UPI has two lines. A bill paid together with another row has no payment lines of its own.</div>
    <div id="pays">${pays.map((p) => payLine(p))}</div>
    <button class="btn plain" type="button" id="addpay" style="align-self:flex-start">Add payment line</button>
    <div class="form-row">
      <div class="field" style="flex:3 1 240px"><label>Remarks</label><input name="remarks" value="${r?.remarks ?? ''}"></div>
      <label style="display:flex;gap:8px;align-items:center;min-height:44px"><input type="checkbox" name="checked" style="width:auto;min-height:0" ${r?.status === 'checked' ? 'checked' : ''}> Checked against the page</label>
    </div>
    <div class="form-msg"></div>
    <div class="form-row">
      <button class="btn" type="submit">${r ? 'Save row' : 'Add row'}</button>
      <button class="btn plain" type="button" data-close>Cancel</button>
      ${r ? html`<button class="btn danger" type="button" id="delrow">Delete row</button>` : ''}
    </div>`;
}

function payLine(p) {
  return html`<div class="form-row payline">
    <div class="field"><select name="pmode">${['cash', 'upi', 'card'].map((m) => html`<option value="${m}" ${p.mode === m ? 'selected' : ''}>${MODE_LABELS[m]}</option>`)}</select></div>
    <div class="field"><input name="plabel" placeholder="Column, e.g. UPI XOXO" value="${p.columnLabel ?? ''}"></div>
    <div class="field"><input name="pamount" class="mono" placeholder="Amount" value="${p.amountPaise == null ? '' : rsIn(p.amountPaise)}"></div>
    <button class="btn plain" type="button" data-rmpay>Remove</button>
  </div>`;
}

const SIDE_KEY = 'bookr.reviewPhotoSide';
let wireFill = () => {};
function wireRegister(biz, u) {
  const strip = wireStrip(u, `/api/businesses/${biz.id}/uploads/${u.id}/file`);
  // "Whole page": the full photo beside the table instead of the strip. Remembered per browser.
  const side = () => { let on = false; try { on = localStorage.getItem(SIDE_KEY) === '1'; } catch { /* storage unavailable */ } return on; };
  const applySide = (on) => { document.body.classList.toggle('photo-side', on); const b = document.getElementById('photoside'); if (b) b.textContent = on ? 'Strip' : 'Whole page'; };
  applySide(side());
  document.getElementById('photoside')?.addEventListener('click', () => { const on = !side(); try { localStorage.setItem(SIDE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ } applySide(on); });
  document.getElementById('photoside2')?.addEventListener('click', () => { try { localStorage.setItem(SIDE_KEY, '0'); } catch { /* storage unavailable */ } applySide(false); });
  if (u.shiftStatus === 'confirmed') {
    const first = document.querySelector('#regtable tbody tr[data-row]');
    const r = first && u.rows.find((x) => x.id === first.dataset.row);
    if (r) strip.show(r);
    document.querySelectorAll('#regtable tbody tr[data-row]').forEach((tr) => tr.addEventListener('click', () => { const x = u.rows.find((y) => y.id === tr.dataset.row); if (x) strip.show(x); }));
  }
  wireFill = () => { wireUnslip(); wireFillBtn(); };
  const wireUnslip = () => document.getElementById('unslip')?.addEventListener('click', async (e) => {
    try {
      const r = await apiFull('POST', `/businesses/${biz.id}/uploads/${u.id}/shift-payments`, { direction: e.currentTarget.dataset.dir });
      await reviewView(biz, u.id);
      document.getElementById('rmsg').innerHTML = html`<div class="ok-msg">Payments moved back on ${r.moved} lines. Check line ${r.checkLine} against the photo.</div>`.__html;
    } catch (err) { showError(document.getElementById('rmsg'), err); }
  });
  const wireFillBtn = () => document.getElementById('filldisc')?.addEventListener('click', async () => {
    try {
      const r = await apiFull('POST', `/businesses/${biz.id}/uploads/${u.id}/fill-discounts`, {});
      await reviewView(biz, u.id);
      document.getElementById('rmsg').innerHTML = html`<div class="ok-msg">Discount or tip filled in on ${r.filled} row${r.filled === 1 ? '' : 's'}. They are shown in amber: check them against the page.</div>`.__html;
    } catch (err) { showError(document.getElementById('rmsg'), err); }
  });
  wireFill();
  const form = document.getElementById('rform');
  const total = document.getElementById('ptotal');
  total && onSubmit(total, async (d) => { await api('PATCH', `/businesses/${biz.id}/uploads/${u.id}`, { pageWrittenTotal: d.pageWrittenTotal || null }); reviewView(biz, u.id); });
  if (!form) return;
  // The bill form opens as a modal: from ✎ on a row, or ＋ Add a bill. Esc and a click outside close it too.
  const dlg = document.getElementById('rdialog');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  const show = (r) => {
    form.dataset.editing = r?.id ?? '';
    form.innerHTML = rowForm(r).__html;
    const pays = form.querySelector('#pays');
    form.querySelector('#addpay').addEventListener('click', () => pays.insertAdjacentHTML('beforeend', payLine({ mode: 'upi', columnLabel: '', amountPaise: null }).__html));
    pays.addEventListener('click', (e) => { if (e.target.matches('[data-rmpay]')) e.target.closest('.payline').remove(); });
    form.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
    form.querySelector('#delrow')?.addEventListener('click', async () => {
      if (!confirm(`Delete bill ${r.billNo} from this page?`)) return;
      try { await api('DELETE', `/businesses/${biz.id}/register-rows/${r.id}`, {}); reviewView(biz, u.id); } catch (err) { showError(form.querySelector('.form-msg'), err); }
    });
    if (!dlg.open) dlg.showModal();
    form.querySelector('[name=billNo]')?.focus();
  };
  onSubmit(form, async (d) => {
    const payments = [...form.querySelectorAll('.payline')].map((line) => ({
      mode: line.querySelector('[name=pmode]').value, columnLabel: line.querySelector('[name=plabel]').value || null, amount: line.querySelector('[name=pamount]').value,
    })).filter((p) => p.amount !== '');
    const editing = form.dataset.editing;
    let discount = d.discount || '0';
    if (!d.discount) {
      const a = parsePaiseText(d.amount);
      const paid = payments.reduce((t, p) => t + (parsePaiseText(p.amount) ?? 0), 0);
      if (a !== null && paid > 0 && paid !== a) discount = rupeesForInput(a - paid);
    }
    const payload = { billNo: d.billNo, billType: d.billType || null, amount: d.amount, discount, remarks: d.remarks || null,
      paidWithRowId: d.paidWithRowId || null, payments: d.paidWithRowId ? [] : payments, status: d.checked ? 'checked' : 'draft' };
    if (editing) await api('PUT', `/businesses/${biz.id}/register-rows/${editing}`, payload);
    else await api('POST', `/businesses/${biz.id}/uploads/${u.id}/register-rows`, payload);
    dlg.close();
    reviewView(biz, u.id);
  });
  const setEdit = wireInlineRows(biz, u, strip);
  setEdit?.((rowId) => show(u.rows.find((x) => x.id === rowId)));
  document.getElementById('addbill')?.addEventListener('click', () => show(null));
}

function expensePanel(biz, u, heads, parties = []) {
  const exp = heads.filter((h) => h.type === 'expense');
  const name = (id) => exp.find((h) => h.id === id)?.name;
  const canApprove = biz.actions.includes('rows.approve');
  const drafts = u.rows.filter((r) => r.status === 'draft');
  const ready = drafts.filter((r) => r.headId);
  const sum = u.rows.reduce((s, r) => s + r.amountPaise, 0);
  return html`
    <section class="card grow3" style="gap:12px">
      <div class="note">Each line is an expense paid from Cash. It counts only after an Owner or Accountant approves it.</div>
      <div class="scroll"><table style="min-width:560px">
        <thead><tr><th>#</th><th>Party</th><th>Item</th><th style="text-align:right">₹</th><th>Head</th><th>Status</th><th></th></tr></thead>
        <tbody>${u.rows.map((r) => { const q = unclearOf(r.ocrOriginal, r.status === 'draft' && !r.headId); const read = readVendor(r); return html`<tr>
          <td class="note">${r.lineNo}</td>
          <td>${r.vendor ?? (read ? html`<span class="chip wait" title="Read from the page; not a known party yet. Edit the line to keep it.">${read}?</span>` : html`<span class="note">—</span>`)}</td>
          <td>${needs(q, 'item', r.narration || '—')}</td>
          <td class="amount">${needs(q, 'amount', money(r.amountPaise))}</td>
          <td>${name(r.headId) ? html`${name(r.headId)}${r.status === 'draft' && inferredOf(r.ocrOriginal).has('head') ? (headFromOf(r.ocrOriginal) === 'item'
              ? html` <span class="chip wait" title="The same item was booked under this head before">From item</span>`
              : html` <span class="chip wait" title="From party ${r.vendor ?? ''}: booked under this head before">Learned</span>`) : ''}`
            : r.suggestHead && name(r.suggestHead.headId) && r.status === 'draft' && headChoices(r).length <= 1 ? html`<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
                <button class="btn plain" type="button" style="min-height:32px;font-size:13px;padding:0 8px;border-style:dashed" data-quickhead="${r.id}" data-head="${r.suggestHead.headId}"
                  title="${r.suggestHead.from === 'item' ? 'The same item was booked under this head before' : `Usual head for "${r.suggestHead.word}"`}">${name(r.suggestHead.headId)}?</button>
                <span class="tiny note">${r.suggestHead.from === 'item' ? 'as before' : 'suggested'}</span></div>`
            : headChoices(r).length > 1 && r.status === 'draft' ? html`<div style="display:flex;flex-wrap:wrap;gap:4px">${headChoices(r).map((hid) => html`<button class="btn plain" type="button" style="min-height:32px;font-size:13px;padding:0 8px" data-quickhead="${r.id}" data-head="${hid}" title="${r.vendor} is used under this head">${name(hid)}</button>`)}</div>`
            : html`<span class="chip bad">Needs input</span>`}</td>
          <td>${r.status === 'approved' ? html`<span class="chip ok">Approved</span>` : html`<span class="chip wait">Draft</span>`}</td>
          <td style="text-align:right">${r.status === 'draft' ? html`<button class="btn plain" type="button" data-eedit="${r.id}">Edit</button>` : ''}</td>
        </tr>`; })}</tbody>
      </table></div>
      <div><button class="btn plain" type="button" id="eaddline">+ Add a line</button></div>
      <div class="form-row" style="justify-content:space-between">
        <div class="note">Rows add up to ₹ ${money(sum)}. ${u.pageWrittenTotalPaise == null ? 'Enter the total written on the page to check it.' : u.pageWrittenTotalPaise === sum ? html`<span class="ok-msg">Matches the written total.</span>` : html`<span class="error">The page says ₹ ${money(u.pageWrittenTotalPaise)}.</span>`}</div>
        <form id="ptotal" class="form-row" style="align-items:flex-end"><div class="field"><label for="pt">Total written on the page (₹)</label><input id="pt" name="pageWrittenTotal" class="mono" value="${u.pageWrittenTotalPaise == null ? '' : rupeesForInput(u.pageWrittenTotalPaise)}"></div><button class="btn plain" type="submit">Save total</button></form>
      </div>
      <form class="inset" id="eform">
        <div style="font-size:15px;font-weight:600" id="etitle">Add a line from the page</div>
        <div class="form-row">
          <div class="field" style="flex:2 1 200px"><label>Item</label><input name="narration" required></div>
          <div class="field"><label>Party</label><input name="vendor" list="vendorlist" placeholder="e.g. Blinkit, Ramesh (salary)" autocomplete="off"></div>
          <div class="field"><label>Amount (₹)</label><input name="amount" class="mono" required></div>
          <div class="field"><label>Head</label><select name="headId"><option value="">Choose later</option>${exp.map((h) => html`<option value="${h.id}">${h.name}</option>`)}${biz.actions.includes('heads.edit') ? html`<option value="__new">+ New head…</option>` : ''}</select></div>
        </div>
        <datalist id="vendorlist">${parties.map((p) => html`<option value="${p.name}">`)}</datalist>
        <div class="note" id="vendorhint">Name the party and its head once; next time the head fills in by itself.</div>
        <div class="form-msg"></div>
        <div class="form-row"><button class="btn" type="submit">Save line</button><button class="btn plain" type="button" id="enew" hidden>Cancel, add a new line</button><button class="btn danger" type="button" id="edel" hidden>Delete line</button></div>
      </form>
      ${drafts.length ? html`<div class="form-row" style="justify-content:space-between;border-top:1px solid var(--line-soft);padding-top:12px">
        <div class="note">${drafts.length - ready.length ? `${drafts.length - ready.length} line${drafts.length - ready.length > 1 ? 's need' : ' needs'} a head before approval.` : 'All draft lines have a head.'}</div>
        ${canApprove ? html`<button class="btn" type="button" id="eapprove" ${ready.length ? '' : 'disabled'}>Approve ${ready.length} ready line${ready.length === 1 ? '' : 's'}</button>` : html`<span class="note">An Owner or Accountant approves these.</span>`}
      </div>` : ''}
    </section>`;
}

/** Where a filled-in head came from: 'item' when from an earlier line with the same item. */
function headFromOf(ocrOriginal) { try { return JSON.parse(ocrOriginal ?? 'null')?.headFrom ?? null; } catch { return null; } }

/** The heads a line's party has been booked under, offered as one-click choices when there are several. */
function headChoices(r) {
  try { return (JSON.parse(r.vendorHeads ?? '[]') ?? []).filter(Boolean); } catch { return []; }
}

/** The party Claude read on a line, when it is not a known party yet. */
function readVendor(r) {
  if (r.vendor || !r.ocrOriginal) return null;
  try { return JSON.parse(r.ocrOriginal).read?.vendor ?? null; } catch { return null; }
}

function wireExpense(biz, u, parties = []) {
  const total = document.getElementById('ptotal');
  total && onSubmit(total, async (d) => { await api('PATCH', `/businesses/${biz.id}/uploads/${u.id}`, { pageWrittenTotal: d.pageWrittenTotal || null }); reviewView(biz, u.id); });
  const form = document.getElementById('eform');
  let editing = null;
  // A known party fills in its remembered head; a new one is remembered under the head chosen now.
  const hint = document.getElementById('vendorhint');
  const findParty = (name) => parties.find((p) => [p.name, ...(p.aliases ?? [])].some((n) => n.toLowerCase().trim() === name.toLowerCase().trim()));
  const onVendor = () => {
    const name = form.vendor.value.trim();
    const p = name ? findParty(name) : null;
    if (!name) hint.textContent = 'Name the party and its head once; next time the head fills in by itself.';
    else if (p && (p.heads?.length ?? 0) > 1) {
      const names = p.heads.map((x) => [...form.headId.options].find((o) => o.value === x.headId)?.textContent).filter(Boolean);
      hint.textContent = `${p.name} is used under ${names.join(' and ')}. Choose one, or leave it empty: an item booked before fills its head in.`;
    } else if (p?.defaultHeadId) {
      if (!form.headId.value) form.headId.value = p.defaultHeadId;
      hint.textContent = `${p.name} is remembered under ${form.headId.selectedOptions[0]?.textContent ?? 'its head'}. A party can be under more than one head: choose another if this line belongs elsewhere.`;
    } else if (p) hint.textContent = `${p.name} has no head yet: the head you choose now will be remembered.`;
    else hint.textContent = `New party: the head you choose now will be remembered for ${name}.`;
  };
  form.vendor.addEventListener('change', onVendor);
  form.vendor.addEventListener('input', onVendor);
  let lastHead = form.headId.value;
  form.headId.addEventListener('change', () => {
    if (form.headId.value !== '__new') { lastHead = form.headId.value; return; }
    form.headId.value = lastHead;
    setNewHeadReturn({ hash: `#/b/${biz.id}/review/${u.id}`, uploadId: u.id, editing, narration: form.narration.value, vendor: form.vendor.value, amount: form.amount.value });
    go(`#/b/${biz.id}/heads/new-expense`);
  });
  // Back from adding a head: put the line back as it was, with the new head chosen.
  const back = getNewHeadReturn();
  if (back?.uploadId === u.id && back.done !== undefined) {
    clearNewHeadReturn();
    editing = back.editing ?? null;
    form.narration.value = back.narration ?? '';
    form.vendor.value = back.vendor ?? '';
    form.amount.value = back.amount ?? '';
    if (back.done) form.headId.value = back.done;
    lastHead = form.headId.value;
    onVendor();
    if (editing) { document.getElementById('etitle').textContent = `Edit line ${u.rows.find((x) => x.id === editing)?.lineNo ?? ''}`; document.getElementById('edel').hidden = false; document.getElementById('enew').hidden = false; }
    form.scrollIntoView({ block: 'center' });
    (back.done ? form.querySelector('button[type=submit]') : form.headId).focus();
  }
  onSubmit(form, async (d) => {
    const body = { narration: d.narration, vendor: d.vendor || null, amount: d.amount, headId: d.headId || null };
    if (editing) await api('PUT', `/businesses/${biz.id}/expense-rows/${editing}`, body);
    else await api('POST', `/businesses/${biz.id}/uploads/${u.id}/expense-rows`, body);
    reviewView(biz, u.id);
  });
  app.querySelectorAll('[data-eedit]').forEach((b) => b.addEventListener('click', () => {
    const r = u.rows.find((x) => x.id === b.dataset.eedit);
    editing = r.id;
    form.narration.value = r.narration;
    form.amount.value = rupeesForInput(r.amountPaise);
    form.headId.value = r.headId ?? '';
    form.vendor.value = r.vendor ?? readVendor(r) ?? '';
    onVendor();
    document.getElementById('etitle').textContent = `Edit line ${r.lineNo}`;
    document.getElementById('edel').hidden = false;
    document.getElementById('enew').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
  // Add a line (20 Nov 2026): back to an empty form at any time, also after pressing Edit on a line.
  const newLine = () => {
    editing = null;
    form.reset();
    onVendor();
    document.getElementById('etitle').textContent = 'Add a line from the page';
    document.getElementById('edel').hidden = true;
    document.getElementById('enew').hidden = true;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    form.narration.focus();
  };
  document.getElementById('eaddline')?.addEventListener('click', newLine);
  document.getElementById('enew')?.addEventListener('click', newLine);
  app.querySelectorAll('[data-quickhead]').forEach((b) => b.addEventListener('click', async () => {
    const r = u.rows.find((x) => x.id === b.dataset.quickhead);
    try {
      await api('PUT', `/businesses/${biz.id}/expense-rows/${r.id}`, { narration: r.narration, vendor: r.vendor, amount: rupeesForInput(r.amountPaise), headId: b.dataset.head });
      reviewView(biz, u.id);
    } catch (err) { showError(document.getElementById('rmsg'), err); }
  }));
  document.getElementById('edel').addEventListener('click', async () => {
    await api('DELETE', `/businesses/${biz.id}/expense-rows/${editing}`, {});
    reviewView(biz, u.id);
  });
  document.getElementById('eapprove')?.addEventListener('click', async () => {
    try { await api('POST', `/businesses/${biz.id}/uploads/${u.id}/expense-rows/approve`, {}); reviewView(biz, u.id); }
    catch (err) { showError(document.getElementById('rmsg'), err); }
  });
}

const CHECK_CHIPS = { pass: ['Matches', 'ok'], fail: ['Does not match', 'bad'], waiting: ['Waiting', 'wait'], unavailable: ['Not available', ''] };

/** What the photo of a cash summary was read as, per figure (paise), and the reason saved when figures differ from it. */
const summaryOcr = (s) => { try { return JSON.parse(s.ocrOriginal ?? '{}') ?? {}; } catch { return {}; } };
const SUMMARY_KEYS = [['opening', 'Opening balance', 'openingPaise', 'opening'], ['received', 'Received total', 'receivedPaise', 'received'], ['balance', 'Balance', 'balancePaise', 'balance'],
  ['expenses', 'Expenses total', 'expensesPaise', 'expenses'], ['cashInHand', 'Cash in hand', 'cashInHandPaise', 'cash_in_hand']];
const summaryRead = (s) => { const r = summaryOcr(s).read ?? {}; return Object.fromEntries(SUMMARY_KEYS.map(([k, , , f]) => [k, r[f] == null || r[f] === '' ? null : parsePaiseText(String(r[f]).trim())])); };

function summaryPanel(biz, u) {
  const s = u.summary;
  const v = (p) => (p == null ? '' : rupeesForInput(p));
  const failing = u.checks.filter((c) => c.state === 'fail');
  const waiting = u.checks.filter((c) => c.state === 'waiting');
  const approved = s.status === 'approved';
  const o = summaryOcr(s);
  const read = summaryRead(s);
  const rev = o.revision ?? null;
  const reasons = u.reasons ?? {};
  // Other pages of the same day: this one may be the revised sheet, or be replaced by it.
  const pages = u.samePages ?? [];
  const replacedBy = o.replacedBy ? pages.find((p) => p.uploadId === o.replacedBy) : null;
  const canReplace = !approved && !o.replaces && !o.replacedBy ? pages.filter((p) => !p.replacedBy && p.status !== 'approved' && p.createdAt < u.createdAt) : [];
  const differs = SUMMARY_KEYS.some(([k, , pk]) => read[k] != null && s[pk] != null && read[k] !== s[pk]);
  return html`
    <section class="card grow3" style="gap:14px">
      ${replacedBy ? html`<div class="note" style="background:var(--wait-bg);color:var(--wait);padding:8px 10px;border-radius:8px">Replaced by the revised sheet uploaded ${when(replacedBy.createdAt)}: this page is kept with its photo, and is no longer counted.
        <a href="#/b/${biz.id}/review/${replacedBy.uploadId}">Open the revised sheet</a> · <button type="button" class="linkbtn" data-unreplace="${replacedBy.id}">Undo</button></div>` : ''}
      ${o.replaces ? html`<div class="note">This is the revised sheet: it replaces the page uploaded earlier for this day. <button type="button" class="linkbtn" data-unreplace2="${pages.find((p) => p.uploadId === o.replaces)?.id ?? ''}">Undo</button></div>` : ''}
      ${rev && differs ? html`<div class="sum-rev">Figures changed from the photo · <strong>${reasons[rev.reason] ?? rev.reason}</strong>${rev.note ? ` · ${rev.note}` : ''}</div>` : differs ? html`<div class="sum-rev">Figures differ from the photo, with no reason given yet.</div>` : ''}
      <form id="sform" class="inset">
        <div style="font-size:15px;font-weight:600">Figures written on the page (₹)</div>
        <div class="form-row">
          ${SUMMARY_KEYS.map(([k, l, pk, f]) => html`<div class="field"><label>${needs(unclearOf(s.ocrOriginal, s.status === 'draft'), f, l)}</label><input name="${k}" class="mono" value="${v(s[pk])}" ${approved ? 'disabled' : ''} data-read="${read[k] ?? ''}">
            <span class="tiny sum-photo" data-photo="${k}" ${read[k] != null && s[pk] != null && read[k] !== s[pk] ? '' : 'hidden'}>Photo: ${read[k] == null ? '' : rs(read[k])}</span></div>`)}
        </div>
        ${approved ? '' : html`<div class="sum-why" ${differs ? '' : 'hidden'}>
          <div class="field"><label for="sreason">These figures differ from the photo. Why?</label>
            <select id="sreason" name="reason"><option value="">Choose…</option>${Object.entries(reasons).map(([k2, l2]) => html`<option value="${k2}" ${rev?.reason === k2 ? 'selected' : ''}>${l2}</option>`)}</select></div>
          <div class="field"><label for="sreasonnote">Note</label><input id="sreasonnote" name="reasonNote" value="${rev?.note ?? ''}" placeholder="Revised after a difference of ₹ 2,620"></div>
        </div>`}
        ${s.status === 'draft' && s.openingPaise != null ? html`<div class="note">Check each figure against the photo, then press Save figures. Approval needs a person to have saved them.</div>` : ''}
        ${canReplace.length ? html`<div class="note">Another cash page was uploaded earlier for this day. If this is its revised sheet:
          ${canReplace.map((p) => html`<button type="button" class="btn plain dchip" data-replaces="${p.id}">This replaces the page uploaded ${when(p.createdAt)}</button>`)}</div>`
          : !pages.length && differs && !approved ? html`<div class="note">Have the revised sheet? Upload it on Bring in as another cash page for this day, then mark it there as the revised sheet.</div>` : ''}
        <div class="form-msg"></div>
        ${approved ? '' : html`<button class="btn plain" type="submit" style="align-self:flex-start">Save figures</button>`}
      </form>
      <h2>Checks</h2>
      ${u.checks.map((c) => { const [t, k] = CHECK_CHIPS[c.state]; return html`<div class="list-row"><span><strong>${c.label}</strong><br><span class="note">${c.detail}</span></span><span class="chip ${k}">${t}</span></div>`; })}
      ${approved ? html`<div class="ok-msg">Approved${s.mismatchNote ? `, with a note: ${s.mismatchNote}` : ''}.</div>` : biz.actions.includes('rows.approve') ? html`
        <form id="sapprove" class="inset">
          ${waiting.length ? html`<div class="note">Approval is possible once no check is waiting.</div>` : ''}
          ${failing.length ? html`<div class="field"><label for="snote">A check does not match. Note why, to approve anyway</label><input id="snote" name="note"></div>` : ''}
          <div class="form-msg"></div>
          <button class="btn" type="submit" ${waiting.length ? 'disabled' : ''} style="align-self:flex-start">Approve cash summary</button>
        </form>` : html`<div class="note">An Owner or Accountant approves the cash summary.</div>`}
    </section>`;
}

function wireSummary(biz, u) {
  const form = document.getElementById('sform');
  // The photo's figure shows beside a box changed from it, and the reason is asked for while any figure differs.
  const why = form?.querySelector('.sum-why');
  const showDiff = () => {
    let any = false;
    form.querySelectorAll('input[data-read]').forEach((inp) => {
      const r = inp.dataset.read === '' ? null : Number(inp.dataset.read);
      const now = parsePaiseText(inp.value.trim());
      const off = r != null && now != null && now !== r;
      form.querySelector(`[data-photo="${inp.name}"]`)?.toggleAttribute('hidden', !off);
      any ||= off;
    });
    if (why) why.hidden = !any;
  };
  form?.querySelectorAll('input[data-read]').forEach((inp) => inp.addEventListener('input', showDiff));
  form && onSubmit(form, async (d) => {
    try { await apiFull('PUT', `/businesses/${biz.id}/cash-summaries/${u.summary.id}`, { ...d, reason: d.reason || null, reasonNote: d.reasonNote || null }); }
    catch (err) { if (err.code === 'summary_reason' && why) { why.hidden = false; document.getElementById('sreason')?.focus(); } throw err; }
    reviewView(biz, u.id);
  });
  const link = async (summaryId, newId, undo) => {
    try { await api('POST', `/businesses/${biz.id}/cash-summaries/${newId}/replaces`, { summaryId, undo }); reviewView(biz, u.id); }
    catch (err) { showError(document.getElementById('rmsg') ?? form.querySelector('.form-msg'), err); }
  };
  document.querySelectorAll('[data-replaces]').forEach((b) => b.addEventListener('click', () => link(b.dataset.replaces, u.summary.id, false)));
  document.querySelector('[data-unreplace]')?.addEventListener('click', (e) => link(u.summary.id, e.currentTarget.dataset.unreplace, true));
  document.querySelector('[data-unreplace2]')?.addEventListener('click', (e) => e.currentTarget.dataset.unreplace2 && link(e.currentTarget.dataset.unreplace2, u.summary.id, true));
  const ap = document.getElementById('sapprove');
  ap && onSubmit(ap, async (d) => {
    try { await apiFull('POST', `/businesses/${biz.id}/cash-summaries/${u.summary.id}/approve`, { note: d.note || null }); }
    catch (err) { throw new Error([err.message, ...(err.problems ?? [])].join(' ')); }
    reviewView(biz, u.id);
  });
}

/** Decision buttons for one difference. A bill missing in the register takes its type with "Use software". */
/** [decision, label, billType, linkedToId] choices for a bill; a bill on one side only can match another day's entry. */
function decisionChoices(c) {
  const list = choicesOf(c);
  // A flagged number offers the check first, so counting it is never the only obvious path.
  return c.numberFlags?.length && !list.some(([k]) => k === '__review') ? [['__review', 'Check the number'], ...list] : list;
}
function choicesOf(c) {
  const o = c.otherDay;
  if (o && !o.closed) {
    const here = c.register ? 'use_register' : 'use_software';
    const countedThere = o.decision === 'use_software' || o.decision === 'use_register';
    if (countedThere) return [['leave_out', `Already counted on ${dayLabel(o.day)}`, '', o.id], ['leave_out', 'Leave out (another reason)']];
    if (!(o.linksHere && o.decision === 'leave_out')) {
      const types = !c.register && o.side !== 'register' ? [['fnb', ' · F&B'], ['room', ' · Room']] : [['', '']];
      return [...types.map(([t, l]) => [here, `Count here · matched with ${dayLabel(o.day)}${l}`, t, o.id]), ...baseChoices(c)];
    }
  }
  return baseChoices(c);
}
function baseChoices(c) {
  const carry = !c.register || !c.software ? [['carry_forward', 'Carry forward']] : [];
  if (!c.register) return [['use_software', 'Add to register · F&B', 'fnb'], ['use_software', 'Add to register · Room', 'room'], ['leave_out', 'Leave out'], ...carry];
  if (needsReview(c)) return [['__review', 'Review the row first'], ['leave_out', 'Leave out']];
  if (!c.software && c.oldPos?.kind === 'short') return [['__oldpos', 'Use register (old POS)'], ['leave_out', 'Leave out']];
  if (!c.software && isOddBill(c.billNo)) return [['__oldpos', SHORT_OLD_POS_NOTE], ['leave_out', 'Leave out']];
  if (!c.software && isOldPos(c.billNo)) return [['__oldpos', 'Use register'], ['leave_out', 'Leave out']];
  if (!c.software) return [['use_register', 'Use register'], ['leave_out', 'Leave out'], ...carry];
  return Object.entries(DECISION_LABELS).filter(([k]) => k !== 'carry_forward');
}

/** A "Next step" line with each bill number on this shift turned into a link to its row. */
/**
 * A cash bill missing in the register. With a UPI credit of its amount near its time (Owner and Accountant only), it
 * was probably paid by UPI: one button writes it into the register as UPI (approved 8 Nov 2026).
 */
function cashWarnHtml(w, v, readOnly) {
  if (!w.byUpi) return html`<div class="cmp-warn">⚠ ${blockerHtml(w.text, v)}</div>`;
  const cmp = v.comparisons.find((c) => c.id === w.comparisonId);
  const types = cmp?.billType ? [cmp.billType] : ['fnb', 'room'];
  return html`<div class="cmp-warn" data-cashupi="${w.comparisonId}">⚠ ${blockerHtml(`Cash bill ${w.billNo} (₹ ${rs(w.amountPaise)}) is in the software report but not in the register, and the bank got a UPI credit of ₹ ${rs(w.byUpi.amountPaise)}`, v)} at ${when(w.byUpi.postedAt)}${w.byUpi.label ? ` (${w.byUpi.label})` : ''}: it was probably paid by UPI, not cash.
    ${readOnly ? '' : html`<div class="form-row" style="gap:8px;margin-top:6px">${types.map((t) => html`<button class="btn" type="button" data-cashupigo="${w.comparisonId}" data-credit="${w.byUpi.creditId}" data-type="${t}" style="min-height:36px">Add to the register as UPI${types.length > 1 ? ` · ${t === 'room' ? 'Room' : 'F&B'}` : ''}</button>`)}
      <span class="note">Written on the "Added from software report" page and counted from the register. Delete that line to undo.</span></div><div class="form-msg"></div>`}</div>`;
}
function blockerHtml(text, v) {
  const bills = new Set(v.comparisons.map((c) => c.billNo));
  const parts = String(text).split(/(\b[0-9A-Za-z/-]{2,}\b)/);
  return { __html: parts.map((p) => (bills.has(p) ? `<a href="#" data-gobill="${esc(p)}" class="mono">${esc(p)}</a>` : esc(p))).join('') };
}

/** A register-only bill that can be counted from the register in bulk (not matched to another day's software bill). A new POS number is expected in a report, so it is never in the bulk choice. */
const bulkOk = (c) => c.difference === 'missing_in_software' && !isNewPos(c.billNo) && !needsReview(c) && !c.numberFlags?.length && !(c.otherDay && (c.otherDay.decision === 'use_software' || c.otherDay.decision === 'use_register')) && !c.largeDiscount;

/** One line under a one-sided bill: the same bill on the other side, on another day. */
function otherDayNote(c) {
  const o = c.otherDay;
  if (!o) return '';
  const what = o.decision === 'use_software' || o.decision === 'use_register' ? 'counted there'
    : o.decision === 'carry_forward' ? 'carried forward there' : o.decision === 'leave_out' ? `left out there${o.note ? `: ${o.note}` : ''}` : 'not decided there yet';
  const warn = o.decision === 'leave_out' && !o.linksHere;
  return html`<div class="tiny" style="color:${warn ? 'var(--danger)' : 'var(--teal)'};white-space:normal">${o.billNo !== c.billNo ? `Bill ${o.billNo} ` : ''}in the ${dayLabel(o.day)} ${o.side === 'software' ? 'software report' : 'register'}: ₹ ${money(o.amountPaise ?? 0)}${o.mode ? ` ${MODE_LABELS[o.mode] ?? o.mode}` : ''} · ${what}</div>${lateLineDiff(c, o)}`;
}
/**
 * A late register line against the bill counted on its sale day (Stage 3, approved 10 Nov 2026): counted once there.
 * A small amount difference is shown (the payment stands); a large one or another mode is flagged.
 */
function lateLineDiff(c, o) {
  const here = c.register ?? c.software;
  if (!here || o.amountPaise == null) return '';
  const gap = Math.abs((here.amountPaise ?? 0) - o.amountPaise);
  const out = [];
  if (gap && gap <= 1000) out.push(`₹ ${money(gap)} different: the bill is counted once, at the amount already counted; the payment decides.`);
  if (gap > 1000) out.push(`₹ ${money(gap)} apart: the same bill, or a different bill with the same number? Open the row to check.`);
  if (here.mode && o.mode && here.mode !== o.mode) out.push(`Paid ${MODE_LABELS[o.mode] ?? o.mode} there, ${MODE_LABELS[here.mode] ?? here.mode} here: check which; it is not added to this day's ${here.mode === 'cash' ? 'cash' : 'money'} expected.`);
  return out.map((t) => html`<div class="tiny error" style="white-space:normal">${t}</div>`);
}
/** On a bill counted here: its register line turned up on a later day and is linked to this one. */
function confirmedByNote(c) {
  const k = c.confirmedBy;
  if (!k) return '';
  const here = c.software ?? c.register;
  const gap = here && k.amountPaise != null ? Math.abs((here.amountPaise ?? 0) - k.amountPaise) : 0;
  return html`<div class="tiny" style="color:var(--teal);white-space:normal">Confirmed by the ${dayLabel(k.day)} register${gap ? html` <span class="error">(written ₹ ${money(k.amountPaise)}, ₹ ${money(gap)} different)</span>` : ''}${k.mode && here?.mode && k.mode !== here.mode ? html` <span class="error">(written as ${MODE_LABELS[k.mode] ?? k.mode})</span>` : ''}</div>`;
}

/** The shift (8 am to 8 am, India time) a moment falls in, as YYYY-MM-DD. */
const shiftOfMs = (ms) => new Date(ms + (5.5 - 8) * 3600e3).toISOString().slice(0, 10);

// ---------- Bills on one side only, waiting for the other side on another day

/** Bills counted before the number rule (6 Nov 2026) whose number can never match: not waiting, but not settled either. */
function oddNumbersHtml(biz, w, canDecide) {
  const list = w?.oddNumbers ?? [];
  if (!list.length) return '';
  return html`<section class="card" id="oddnumbers" style="gap:10px">
    <h2>Bill numbers that can never match (${list.length})</h2>
    <div class="note">These are only in the register, and each number fits neither the new POS format nor the old one, so no software bill will ever match it. They are counted from the register until you settle them. To correct a number or leave a bill out, open its shift, if it is not confirmed.</div>
    <div class="scroll"><table style="min-width:520px">
      <thead><tr><th>Bill</th><th>Shift</th><th style="text-align:right">Amount</th><th>Note</th><th></th></tr></thead>
      <tbody>${list.map((b) => html`<tr>
        <td class="mono">${b.billNo}</td><td><a href="#/b/${biz.id}/reconcile/${b.day}">${dayLabel(b.day)}</a>${b.confirmed ? html` <span class="note">confirmed</span>` : ''}</td>
        <td class="amount">${money(b.amountPaise ?? 0)}${b.mode ? html` <span class="note">${MODE_LABELS[b.mode] ?? b.mode}</span>` : ''}</td>
        <td class="note">${b.note ?? ''}</td>
        <td>${canDecide ? html`<button class="btn plain" type="button" data-oddclose="${b.id}">${SHORT_OLD_POS_NOTE}</button>` : ''}</td>
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}




/** Days from a shift to the shift being worked today (8 am to 8 am). */
const shiftAge = (day) => Math.round((Date.parse(currentShiftDay()) - Date.parse(day)) / 86400000);
const CASH_WATCH_DAYS = 2;

/**
 * One shift's waiting bills in four groups (18 Nov 2026), before and after saving; the same rule on To do and in the day
 * report. Payment not received: no UPI credit or machine payment of its amount, or a cash bill not in the register more
 * than 2 days with the count short. Payment found, to match: money within ₹10 near it, not matched. Paid, bill missing:
 * the money is in, only the paperwork differs. Cash bill not in the register: inside its 2 days, usually written next day.
 * oneSided: { comparisonId, billNo, amountPaise, mode, side: 'software'|'register', otherDay, oldPos }.
 */
function waitSplit({ day, rc, cash, oneSided }) {
  const out = { notReceived: [], found: [], paperwork: [], cashWait: [], closed: [], planned: [] };
  // Planned on a later shift (approved 20 Nov 2026): its money is chosen there, matched when that shift is saved.
  const planWhy = (p) => `${p.withBills?.length ? `with ${p.withBills.join(', ')} on ` : 'on '}the ${p.label} ₹ ${rs(p.amountPaise)} ${p.kind === 'card' ? 'swipe' : 'credit'}, ${dayLabel(p.day)} ${timeOf(p.at)}`;
  for (const k of (rc?.fixes ?? []).filter((x) => x.kind === 'planned_later' && x.planned)) {
    out.planned.push({ billNo: k.billNos.join(' + '), amountPaise: k.amountPaise ?? 0, paidAt: k.paidAt ?? null, mode: 'upi', why: planWhy(k.planned), planned: k.planned });
  }
  for (const c of rc?.cards?.planned ?? []) {
    out.planned.push({ billNo: c.billNo ?? '', amountPaise: c.amountPaise ?? 0, paidAt: c.paidAt ?? null, mode: 'card', why: planWhy(c.planned), planned: c.planned });
  }
  const bankIn = !!rc?.coverage?.covered;
  const cardsIn = !!rc?.cards?.covered;
  const credits = (rc?.noBill ?? []).filter((c) => c.amountPaise != null);
  const nearCredit = (amount, at) => credits.filter((c) => Math.abs(c.amountPaise - amount) <= 1000 && (at == null || Math.abs(c.postedAt - at) <= 3 * 3600e3))
    .sort((a, b) => Math.abs(a.amountPaise - amount) - Math.abs(b.amountPaise - amount) || (at == null ? 0 : Math.abs(a.postedAt - at) - Math.abs(b.postedAt - at)))[0] ?? null;
  for (const k of (rc?.noCredit ?? []).filter((x) => x.kind === 'no_upi_credit')) {
    const x = { billNo: k.billNos.join(' + '), amountPaise: k.amountPaise ?? 0, paidAt: k.paidAt ?? null, mode: 'upi', why: k.evidence?.[0] ?? k.title };
    const o = nearCredit(x.amountPaise, x.paidAt);
    if (o) out.found.push({ ...x, offer: { amountPaise: o.amountPaise, at: o.postedAt, label: o.accountName ?? null } });
    else out.notReceived.push(x);
  }
  if (cardsIn) for (const c of rc?.cards?.noSwipe ?? []) {
    const x = { billNo: c.billNo ?? (c.billNos ?? []).join(' + '), amountPaise: c.amountPaise ?? 0, paidAt: c.paidAt ?? null, mode: 'card', why: 'No card machine payment of this amount' };
    if (c.near) out.found.push({ ...x, offer: { amountPaise: c.near.amountPaise, at: c.near.paidAt, label: c.near.label } });
    else out.notReceived.push(x);
  }
  const listed = new Set([...out.notReceived, ...out.found, ...out.planned].flatMap((x) => x.billNo.split(' + ')));
  // Cash bills the register does not have: the short count is explained by them, oldest first.
  const diff = cash ? (cash.confirmed ? (cash.settled ? 0 : cash.differencePaise) : cash.draft?.differencePaise ?? null) : null;
  const late = new Map(oneSided.filter((o) => o.otherDay && !o.otherDay.closed).map((o) => [o.comparisonId, o.otherDay]));
  const cashBills = [...(cash?.notInRegister ?? []).filter((x) => x.decision === 'use_software' && !/^Added to the register/.test(x.note ?? '')),
    // Counted as cash but the register wrote UPI or card (18 Nov 2026): to the drawer the same as not in the register.
    ...(cash?.registerNotCash ?? []).map((x) => ({ ...x, decision: 'use_software', paidAt: null }))];
  let left = diff != null && diff < 0 ? -diff : 0;
  for (const b of [...cashBills].sort((a, b2) => (a.paidAt ?? 0) - (b2.paidAt ?? 0))) {
    const x = { comparisonId: b.id, billNo: b.billNo, amountPaise: b.amountPaise, paidAt: b.paidAt ?? null, mode: 'cash' };
    listed.add(b.billNo);
    if (b.closeNote) { out.closed.push({ ...x, why: b.closeNote }); continue; }
    // Written late (18 Nov 2026): the server links the later day's line; the comparisons' own link counts too.
    const o = b.late ?? late.get(b.id);
    // Written late as card or UPI (18 Nov 2026): left short on its own day, as on a daily reconcile the next day is not in
    // yet. It waits like any cash bill; the later day's Card (UPI) tab changes it once this shift is saved.
    const paidLaterNote = o && (o.mode === 'card' || o.mode === 'upi') ? `; written in the ${dayLabel(o.day)} register as ${o.mode === 'card' ? 'card' : 'UPI'}: change it on ${dayLabel(o.day)}'s ${o.mode === 'card' ? 'Card' : 'UPI'} tab once this shift is saved` : '';
    if (o && !paidLaterNote) { out.paperwork.push({ ...x, late: o, why: `Written late in the ${dayLabel(o.day)} register${o.amountPaise != null && o.amountPaise !== b.amountPaise ? ` as ₹ ${rs(o.amountPaise)}` : ''}${cash?.pair ? `; the ${dayLabel(cash.pair.day)} cash is ${cash.pair.differencePaise > 0 ? 'over' : 'short'} by ₹ ${rs(Math.abs(cash.pair.differencePaise))}: settle them together on the Cash tab` : ''}` }); continue; }
    if (diff == null) { out.cashWait.push({ ...x, why: 'Not in the register; the cash count is not in yet', age: shiftAge(day) }); continue; }
    if (left <= 0) { out.paperwork.push({ ...x, why: 'Paid in cash: the cash count backs it, only the register line is missing' }); continue; }
    const part = Math.min(left, b.amountPaise);
    left -= part;
    const why = `${b.rgMode ? `The register wrote ${MODE_LABELS[b.rgMode] ?? b.rgMode}${b.rgPaise != null ? ` ₹ ${rs(b.rgPaise)}` : ''}, counted as cash` : 'Not in the register'}, and the cash is short by ₹ ${rs(-diff)}${part < b.amountPaise ? ` (explains ₹ ${rs(part)})` : ''}${paidLaterNote}`;
    if (shiftAge(day) > CASH_WATCH_DAYS && !paidLaterNote) out.notReceived.push({ ...x, why: b.rgMode ? why : `${why}: not written in any register since` });
    else out.cashWait.push({ ...x, why, age: shiftAge(day) });
  }
  // The rest on one side only: money in, only the paperwork differs.
  for (const o of oneSided) {
    if (listed.has(o.billNo) || o.mode === 'cash' || o.oldPos) continue;
    if (o.side === 'register') out.paperwork.push({ ...o, why: o.otherDay ? `In the register; billed in the software on ${dayLabel(o.otherDay.day)}` : 'In the register, not in the software report' });
    else if ((o.mode === 'upi' && bankIn) || (o.mode === 'card' && cardsIn)) out.paperwork.push({ ...o, why: `${o.mode === 'upi' ? 'UPI credit' : 'Machine payment'} matched; ${o.otherDay ? `written in the ${dayLabel(o.otherDay.day)} register` : 'not in the register'}` });
  }
  const byTime = (a, b) => (a.paidAt ?? 0) - (b.paidAt ?? 0);
  for (const k of Object.keys(out)) out[k].sort(byTime);
  return out;
}

/** The Waiting card of one shift's To do (18 Nov 2026): the four groups, each line with its fix in place. */
function waitCardHtml(biz, day, sp, waitPic, opts) {
  const sum = (xs) => xs.reduce((t, x) => t + (x.amountPaise ?? 0), 0);
  const n = sp.notReceived.length + sp.found.length + sp.paperwork.length + sp.cashWait.length + (sp.planned?.length ?? 0);
  const pic = new Map((waitPic?.look ?? []).filter((x) => x.day === day).map((x) => [x.billNo, x]));
  const canDecide = opts.canDecide;
  const line = (x, extra) => html`<div class="wc-row"><span class="mono">${x.billNo}${drawerBtn(x.billNo.split(' + ')[0], day)}</span><span class="amount">${money(x.amountPaise)}</span>
    <span class="wc-why">${MODE_LABELS[x.mode] ?? x.mode ?? ''}${x.paidAt ? `, ${timeOf(x.paidAt)}` : ''} · ${x.why}${extra ?? ''}</span></div>`;
  const savedActs = (x) => {
    const w = pic.get(x.billNo);
    if (!w || !canDecide) return '';
    // Counted twice (approved 20 Nov 2026): one payment written in two columns; this half never comes.
    const tw = w.twice;
    const twiceBox = tw ? html`<div class="cmp-warn" style="margin:4px 0 0"><strong>Probably counted twice.</strong> The register line has ₹ ${money(w.amountPaise)} ${MODE_LABELS[tw.otherMode] ?? tw.otherMode} and ₹ ${money(w.amountPaise)} ${MODE_LABELS[w.mode] ?? w.mode} (₹ ${money(w.amountPaise * 2)}) for a ₹ ${money(tw.billPaise)} bill. The ${MODE_LABELS[tw.otherMode] ?? tw.otherMode} ₹ ${money(w.amountPaise)} came; the software says ${MODE_LABELS[tw.otherMode] ?? tw.otherMode} only.
      <div class="form-row" style="gap:6px;margin-top:6px"><button class="btn plain dchip" type="button" data-twice="${w.key.slice(2)}" data-bill="${w.billNo}" data-day="${w.day}" data-amt="${w.amountPaise}"
        data-mode="${MODE_LABELS[w.mode] ?? w.mode}" data-other="${MODE_LABELS[tw.otherMode] ?? tw.otherMode}" data-bp="${tw.billPaise}" data-nd="${tw.newDiscountPaise}" data-nt="${tw.newTipPaise}">Remove the ${MODE_LABELS[w.mode] ?? w.mode} ₹ ${money(w.amountPaise)} (counted twice)</button></div></div>` : '';
    return html`${twiceBox}<div class="wc-acts">
      ${w.reversalId ? html`<button class="btn plain dchip" type="button" data-reversed="${w.reversalId}" data-bill="${w.billNo}">Bill unpaid again</button>` : ''}
      ${w.side === 'both' && w.mode === 'upi' && w.key.startsWith('t:') ? html`<button class="btn plain dchip" type="button" data-owedtx="${w.key.slice(2)}" data-bill="${w.billNo}">Owed by guest/company</button>` : ''}
      ${w.comparisonId && w.side !== 'both' ? html`<button class="btn plain dchip" type="button" data-closebill="${w.comparisonId}" data-bill="${w.billNo}">Close with a reason</button>
        <button class="btn plain dchip" type="button" data-keepwait="${w.comparisonId}" data-bill="${w.billNo}">Keep waiting</button>` : ''}</div>`;
  };
  const cashActs = (x, red) => (canDecide ? html`<div class="wc-acts">${red ? '' : html`<span class="note">Already know?</span>`}
    <button type="button" class="btn plain dchip" data-leaveunk="${x.comparisonId}" data-bill="${x.billNo}">Not paid: leave it out</button>
    <button type="button" class="btn plain dchip" data-bill-drawer="${x.billNo}|${day}">Paid, add to the register</button>
    ${opts.confirmed && opts.canWriteoff ? html`<button type="button" class="btn plain dchip" data-shortbill="${x.comparisonId}" data-bill="${x.billNo}" data-amt="${x.amountPaise}">Book as shortage</button>` : ''}</div>` : '');
  const group = (cls, title, xs, body) => (xs.length ? html`<div class="wc-g ${cls}"><div class="wc-gh">${title} · ${xs.length} bill${xs.length === 1 ? '' : 's'} · ₹ ${rs(sum(xs))}</div>${body}</div>` : '');
  const empty = [!sp.found.length && 'payment found, to match', !sp.cashWait.length && 'cash bills not in the register'].filter(Boolean);
  return html`<section class="card wc" style="gap:6px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap"><h2 style="margin:0">Waiting · ${n ? `${n} bill${n === 1 ? '' : 's'}` : 'nothing'}</h2>
      <span class="note">${opts.confirmed ? 'Saved' : 'Before saving: what will wait when saved'}</span></div>
    ${group('red', 'Payment not received', sp.notReceived, sp.notReceived.map((x) => html`${line(x)}${x.mode === 'cash' ? cashActs(x, true) : opts.readOnly ? '' : x.mode === 'upi' && !opts.confirmed ? html`<div class="wc-acts"><button type="button" class="btn plain dchip" data-goto="pay:upi">Fix on the UPI tab ›</button></div>` : savedActs(x)}`))}
    ${group('blue', 'Planned on a later shift', sp.planned ?? [], (sp.planned ?? []).map((x) => html`${line(x, html` <span class="chip plan">matched when ${dayLabel(x.planned.day)} is saved</span>`)}
      ${opts.readOnly ? '' : html`<div class="wc-acts"><a class="btn plain dchip" href="#/b/${biz.id}/reconcile/${x.planned.day}?tab=${x.mode === 'card' ? 'card' : 'upi'}">Open ${dayLabel(x.planned.day)} ${x.mode === 'card' ? 'Card' : 'UPI'} tab ›</a></div>`}`))}
    ${group('teal', 'Payment found, to match', sp.found, sp.found.map((x) => html`${line(x, x.offer ? html`<div class="tiny" style="color:var(--teal-ink)">${x.mode === 'card' ? 'Machine payment' : 'Credit'} ₹ ${money(x.offer.amountPaise)} at ${timeOf(x.offer.at)}${x.offer.amountPaise !== x.amountPaise ? ` · ₹ ${money(Math.abs(x.offer.amountPaise - x.amountPaise))} ${x.offer.amountPaise > x.amountPaise ? 'more' : 'less'}` : ''}</div>` : '')}
      ${opts.readOnly ? '' : html`<div class="wc-acts"><button type="button" class="btn plain dchip" data-goto="pay:${x.mode === 'card' ? 'card' : 'upi'}">Match on the ${x.mode === 'card' ? 'Card' : 'UPI'} tab ›</button></div>`}`))}
    ${group('amb', 'Cash bill not in the register', sp.cashWait, sp.cashWait.map((x) => html`${line(x, html` <span class="chip wait">day ${Math.max(1, x.age)} of ${CASH_WATCH_DAYS}</span><div class="tiny">Counted as a ${dayLabel(day)} sale. Closes by itself when a later register writes it.</div>`)}${cashActs(x, false)}`))}
    ${group('', 'Paid, bill missing', sp.paperwork, sp.paperwork.map((x) => line(x)))}
    ${sp.closed.length ? html`<div class="wc-g"><div class="wc-gh note">Closed</div>${sp.closed.map((x) => line(x))}</div>` : ''}
    ${n && empty.length ? html`<div class="note">None: ${empty.join(' · ')}.</div>` : ''}
    ${opts.others ? html`<div class="note">${opts.others} more bill${opts.others === 1 ? '' : 's'} wait${opts.others === 1 ? 's' : ''} on other saved shifts${biz.actions.includes('reports.view') ? html`: <a href="#/b/${biz.id}/dashboard">Today ›</a>` : '.'}</div>` : ''}
  </section>`;
}

function wireWaiting(biz, root, act) {
  root.querySelectorAll('[data-oddclose]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.oddclose}/close`, { note: SHORT_OLD_POS_NOTE }))));
  root.querySelectorAll('[data-closebill]').forEach((b) => b.addEventListener('click', () => {
    const note = (prompt(`Close bill ${b.dataset.bill}: why did its other side never turn up?`) ?? '').trim();
    if (note) act(() => apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.closebill}/close`, { note }));
  }));
  root.querySelectorAll('[data-closeas]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.closeas}/close`, { note: b.dataset.note }))));
  root.querySelectorAll('[data-reversed]').forEach((b) => b.addEventListener('click', () => {
    if (confirm(`Bill ${b.dataset.bill}: its payment was reversed. Undo the match, so the bill waits for its money again?`)) act(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.reversed}/reversed-unpaid`, {}));
  }));
  root.querySelectorAll('[data-owedtx]').forEach((b) => b.addEventListener('click', () => {
    const who = (prompt(`Bill ${b.dataset.bill}: owed by which guest or company? Its payment is matched to it when it comes.`) ?? '').trim();
    if (who) act(() => apiFull('POST', `/businesses/${biz.id}/sales/${b.dataset.owedtx}/close`, { note: `Owed by ${who}` }));
  }));
  root.querySelectorAll('[data-twice]').forEach((b) => b.addEventListener('click', async () => {
    const d = b.dataset;
    const amt = Number(d.amt);
    const left = Number(d.nd) ? `discount ₹ ${money(Number(d.nd))}` : Number(d.nt) ? `tip ₹ ${money(Number(d.nt))}` : 'no discount';
    if (!confirm(`Remove ${d.mode} ₹ ${money(amt)} from bill ${d.bill} (${dayLabel(d.day)}, saved)?\n\nRegister line: ${d.other} ₹ ${money(amt)} + ${d.mode} ₹ ${money(amt)} → ${d.other} ₹ ${money(amt)}\nBill ₹ ${money(Number(d.bp))}: ${left}\n${dayLabel(d.day)} income: − ₹ ${money(amt)}\nThe ${d.other} ₹ ${money(amt)} and its match stay. The shift stays saved.`)) return;
    const note = (prompt('Reason', `Paid once by ${d.other.toLowerCase()} (₹ ${money(amt)}); the ${d.mode} entry was the same payment`) ?? '').trim();
    if (!note) return;
    let res = null;
    await act(async () => { res = await apiFull('POST', `/businesses/${biz.id}/sales/${d.twice}/counted-twice`, { note }); });
    if (res) doneToast(`${d.mode} ₹ ${money(amt)} removed from bill ${d.bill}. ${dayLabel(d.day)} income is ₹ ${money(amt)} less.`,
      () => apiFull('POST', `/businesses/${biz.id}/counted-twice/${res.auditId}/undo`, {}), () => (drawerReload ?? route)());
  }));
  root.querySelectorAll('[data-keepwait]').forEach((b) => b.addEventListener('click', () => {
    const note = (prompt(`Keep bill ${b.dataset.bill} waiting: what are you waiting for?`) ?? '').trim();
    if (note) act(() => apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.keepwait}/keep-waiting`, { note }));
  }));
}


// ---------- Cash for a shift: should be in hand against counted

/**
 * The Cash tab (approved 14 Nov 2026): one sum, live before saving. Before Save its sales line is what Save would book
 * now (Draft); after Save it is the booked figure (Final). On top: should be in hand, counted, and the difference in
 * colour; then what could explain it, worked out from the bills that touch cash; then the bills, those that differ first.
 * Each bill opens its register line with the photo (Edit). Accept and shortage act on the final figure only.
 */
const cmpTypeOf = (v, id) => v.comparisons.find((c) => c.id === id)?.billType ?? null;
/** A cash bill in the software, not in the register, with a UPI credit of its amount near it: one button writes it in
 *  the register as UPI, the credit matched on save (on the Cash tab too, approved 17 Nov 2026). */
function cashUpiFix(b, w, canAct) {
  if (!w || !canAct) return '';
  const types = w.billType ? [w.billType] : ['fnb', 'room'];
  return html`<div data-cashupibox style="margin-top:4px"><div class="tiny" style="color:var(--teal-ink);white-space:normal">The bank got a UPI credit of ₹ ${money(w.byUpi.amountPaise)} at ${when(w.byUpi.postedAt)}${w.byUpi.label ? ` (${w.byUpi.label})` : ''}: probably paid by UPI, not cash.</div>
    <div class="form-row" style="gap:6px;margin-top:4px">${types.map((t) => html`<button type="button" class="btn plain dchip" data-cashupi2="${w.comparisonId}" data-credit="${w.byUpi.creditId}" data-type="${t}" data-bill="${b.billNo}">Paid by UPI: add to the register as UPI${types.length > 1 ? ` · ${t === 'room' ? 'Room' : 'F&B'}` : ''}</button>`)}</div><div class="form-msg"></div></div>`;
}
/** Bills of an earlier saved shift written here as card or UPI (18 Nov 2026): told on Cash and To do, changed on the
 *  Card (UPI) tab, where the payment and the earlier day's short are shown. */
function paidHereNotice(list, go = true) {
  if (!list?.length) return '';
  const byMode = ['card', 'upi'].map((m) => [m, list.filter((x) => x.mode === m)]).filter(([, xs]) => xs.length);
  return html`${byMode.map(([m, xs]) => { const days = [...new Set(xs.map((x) => x.fromDay))];
    return html`<div class="ent-line" style="border:1px solid #FCD34D;background:#FFF6E0;border-radius:8px;padding:10px 12px">
      <strong>${xs.length} bill${xs.length === 1 ? '' : 's'} from ${days.map(dayLabel).join(', ')} paid here by ${MODE_WORD[m]}: check</strong>
      <div class="tiny">${xs.map((x) => `${x.billNo} · ₹ ${money(x.amountPaise)} · counted as cash on ${dayLabel(x.fromDay)} (short there). The register here says ${MODE_WORD[m]}.`).join(' ')}</div>
      ${go ? html`<div class="form-row" style="gap:6px;margin-top:4px"><button type="button" class="btn plain dchip" data-goto="pay:${m}">Open on the ${m === 'card' ? 'Card' : 'UPI'} tab ›</button></div>` : ''}</div>`; })}`;
}
function cashPanelHtml(biz, k, opts = {}) {
  const draft = !k.confirmed;
  const shouldBe = draft ? k.draft?.shouldBePaise ?? null : k.shouldBePaise;
  const sales = draft ? k.draft?.cashSalesPaise ?? null : k.cashSalesPaise;
  const diff = draft ? k.draft?.differencePaise ?? null : k.differencePaise;
  const state = diff === null ? null : diff === 0 ? 'ok' : !draft && k.settled ? 'accepted' : diff < 0 ? 'short' : 'over';
  const tone = { ok: 'ok-msg', accepted: 'ok-msg', short: 'cash-bad', over: 'cash-warn' }[state] ?? '';
  const stateWord = { ok: 'Cash agrees', accepted: 'Difference accepted', short: 'Short', over: 'More than expected' }[state] ?? 'Difference';
  const tag = (final) => (final ? html`<span class="chip ok">Final</span>` : html`<span class="chip wait">Draft</span>`);
  const row = (label, sub, paise, extra = '', strong = false, cls = '') => html`<tr class="${cls}" style="${strong ? 'font-weight:600' : ''}">
    <td>${label}</td><td class="note">${sub}</td><td class="amount">${paise == null ? '—' : money(paise)}</td><td>${extra}</td></tr>`;
  const bills = k.bills ?? [];
  const differ = bills.filter((b) => b.differs);
  const edit = (b) => html`<button type="button" class="btn plain dchip" data-bill-drawer="${b.billNo}|${k.day}">Edit</button>${draft && b.state !== 'complimentary' && biz.actions.includes('sales.decide') ? html`<button type="button" class="btn plain dchip" data-makecomp="${b.comparisonId}" data-bill="${b.billNo}">Make complimentary</button>` : ''}`;
  const decide = opts.decide ? html`<button type="button" class="btn plain dchip" data-goto="all">Decide on All bills</button>` : '';
  const other = (b) => b.rgOther.map((p) => `${MODE_LABELS[p.mode] ?? p.mode} ${money(p.amountPaise)}`).join(' + ');
  // Plain words on the cash bills (approved 21 Nov 2026): ₹839, not ₹ 839.00.
  const rr = (p) => `₹${money(p).replace(/\.00$/, '')}`;
  const otherRs = (b) => b.rgOther.map((p) => `${MODE_LABELS[p.mode] ?? p.mode} ${rr(p.amountPaise)}`).join(' + ');
  // What could explain the difference: each bill that differs, with what each choice would add to the cash.
  const gap = diff === null ? null : Math.abs(diff);
  const items = [];
  const lateIds = new Set([...(k.lateOffers ?? []), ...(k.lateIn ?? [])].map((x) => x.comparisonId));
  for (const b of differ) {
    if (lateIds.has(b.comparisonId)) continue;
    const sw = b.swCashPaise ?? 0, rg = b.rgCashPaise ?? 0;
    let text, effects = [];
    // Paid in cash on a later day (20 Nov 2026): its cash went into that day's drawer; told with Undo.
    const cl = (k.notInRegister ?? []).find((x) => x.id === b.comparisonId)?.cashLate;
    if (cl) {
      items.push({ same: false, top: true, html: html`<div class="ent-line" style="border-left:3px solid var(--teal);padding-left:10px"><div><span class="mono">${b.billNo}</span> · ₹ ${money(b.swCashPaise ?? 0)} · paid in cash on ${dayLabel(cl.day)} (₹ ${money(cl.amountPaise)}): its cash is counted in ${dayLabel(cl.day)}'s drawer.${(b.swCashPaise ?? 0) > cl.amountPaise ? ` ₹ ${money((b.swCashPaise ?? 0) - cl.amountPaise)} less than billed: that is the short left here.` : ''}
        <div class="tiny note">${cl.by ? `${cl.by}, ` : ''}${when(cl.at)} · <a href="#/b/${biz.id}/reconcile/${cl.day}?tab=cash">Open ${dayLabel(cl.day)}</a></div></div>
        ${biz.actions.includes('sales.decide') ? html`<button type="button" class="btn plain dchip" data-cashlateundo="${cl.auditId}" data-bill="${b.billNo}">Undo</button>` : ''}</div>` });
      continue;
    }
    if ((b.state === 'complimentary' || b.state === 'left_out') && rg !== (b.countedPaise ?? 0)) {
      text = html`${b.state === 'complimentary' ? 'complimentary' : 'left out'}, but the register has Cash ₹ ${money(rg)} received: not counted`;
    } else if (b.rgCashPaise === null) {
      text = html`software Cash ₹ ${money(sw)}, not in the register`;
      effects = b.state === 'undecided' ? [['Use software', sw], ['Left out', 0]] : [];
      if (b.decision === 'use_software') text = html`${rr(sw)} cash in the software, not in the register<div class="tiny note">Bookr counts it in the drawer. Was it?</div>`;
    } else if (b.swCashPaise === null) {
      text = html`register Cash ₹ ${money(rg)}, software ${b.swMode ? `${MODE_LABELS[b.swMode] ?? b.swMode} ₹ ${money(b.swAmountPaise ?? 0)}` : 'nothing'}`;
      effects = b.state === 'undecided' ? [['Use register', rg], ['Use software', 0]] : [];
    } else if (b.rgOther.length && !rg) {
      text = html`software says cash ${rr(sw)}, register says ${otherRs(b)}`;
      effects = b.state === 'undecided' ? [['Use software', sw], ['Use register', 0]] : [];
    } else {
      text = html`Cash ₹ ${money(sw)} software, ₹ ${money(rg)} register${b.rgOther.length ? ` (+ ${other(b)})` : ''}`;
      effects = b.state === 'undecided' ? [['Use software', sw], ['Use register', rg]] : [];
    }
    // Each side as a choice with what it does to the difference (14 Nov 2026): a person can switch the side here.
    const both = b.swAmountPaise != null && b.rgCashPaise !== null && b.state !== 'complimentary' && !b.groupSize && draft && biz.actions.includes('sales.decide');
    const after = (v) => (diff == null ? null : diff - (v - (b.countedPaise ?? 0)));
    const word = (d) => (d == null ? '' : d === 0 ? 'cash agrees' : d < 0 ? `short ${rr(-d)}` : `${rr(d)} over`);
    const sideName = (which) => (which === 'use_software' ? `${MODE_LABELS[b.swMode] ?? b.swMode ?? 'no mode'} ₹ ${money(b.swAmountPaise ?? 0)}`
      : [...(b.rgCashPaise ? [`Cash ${money(b.rgCashPaise)}`] : []), ...b.rgOther.map((p) => `${MODE_LABELS[p.mode] ?? p.mode} ${money(p.amountPaise)}`)].join(' + ') || 'no payment');
    // Cash in the software, UPI or card in the register with no payment of its own (18 Nov 2026): the cashier says which.
    // "Cashier says cash" keeps it counted as cash, so the short stands and is named; "It was UPI" counts the register.
    const otherOnly = b.swCashPaise != null && b.rgOther.length && !rg;
    const asked = otherOnly && !b.witness?.found;
    const otherWord = otherOnly ? (MODE_LABELS[b.rgOther[0].mode] ?? b.rgOther[0].mode) : '';
    const switches = both ? [['use_software', sw], ['use_register', rg]].map(([d, v]) => ({ d, v, on: b.decision === d,
      text: asked ? (d === 'use_software' ? 'It was cash' : `It was ${otherWord}`) : `${d === 'use_software' ? 'Use software' : 'Use register'} (${sideName(d)})`,
      label: asked ? (d === 'use_software' ? `It was cash ${rr(sw)}` : `It was ${b.rgOther.length === 1 ? `${otherWord} ${rr(b.rgOther[0].amountPaise)}` : otherRs(b)}`) : null,
      note: asked && d === 'use_software' ? `Cashier says cash; the register wrote ${other(b)}` : '', then: word(after(v)) })) : [];
    if (otherOnly && b.decision === 'use_software') text = html`software says cash ${rr(sw)}, register says ${otherRs(b)}: counted as cash`;
    const wit = b.witness ? (b.witness.found ? html`<div class="tiny" style="color:var(--teal)">✓ ${b.witness.found}: ${MODE_LABELS[b.witness.mode] ?? b.witness.mode} ₹ ${money(b.witness.amountPaise)} was received</div>`
      : b.witness.takenBy ? html`<div class="tiny" style="color:#92400E">No UPI credit of its own. The ₹ ${money(b.witness.amountPaise)} credit at ${when(b.witness.takenBy.at)} is bill <span class="mono">${b.witness.takenBy.billNo}</span>'s.</div>`
      : html`<div class="tiny" style="color:#92400E">${b.witness.mode === 'upi' ? `No ${rr(b.witness.amountPaise)} UPI in the bank or card machine` : `No ${rr(b.witness.amountPaise)} card payment on the machine`}</div>`) : '';
    // Counted as UPI or card with its payment found (2610302, 18 Nov 2026): settled, told quietly, not a choice.
    if (otherOnly && b.decision === 'use_register' && b.witness?.found && !(b.countedPaise ?? 0)) {
      items.push({ same: false, quiet: true, html: html`<div class="ent-line" style="color:var(--muted)"><div><span class="mono">${b.billNo}</span> · software Cash ₹ ${money(sw)}, register ${other(b)} · ${b.witness.found}</div>
        <div class="tiny">Counted as ${otherWord}, not in the cash sum.</div></div>` });
      continue;
    }
    const same = gap ? (b.rgCashPaise === null && b.decision === 'use_software' && sw === gap) || effects.some(([, v]) => v === gap) || Math.abs(sw - rg) === gap : false;
    // Only in the register and counted from it (an old POS bill, or Use register): already in the sum, so it does not
    // explain the difference (17 Nov 2026). Old POS bills are decided in To do's old POS block.
    if (!same && b.swAmountPaise == null && b.rgCashPaise != null && b.state !== 'complimentary' && b.state !== 'left_out'
      && (opts.oldPos?.has(b.comparisonId) || b.decision === 'use_register')) continue;
    // Cash in the software, not in the register, of the difference's amount: it waits (18 Nov 2026). It is counted as a
    // sale of its day and usually written in the next day's register; nothing is asked at saving. After 2 days with no
    // late line it is not received, and its choices show.
    // Written late in a later day's register (18 Nov 2026): paid, only the paperwork was late. The cash most likely went
    // into that day's count, so the two days are settled together (the pair line below) rather than chased.
    const nirRow = (k.notInRegister ?? []).find((x) => x.id === b.comparisonId);
    const lt = nirRow?.late;
    // Written late as card or UPI (18 Nov 2026): left short here, as on a daily reconcile the next day is not in yet. It
    // waits like any cash bill below; the later day's Card (UPI) tab changes it once this shift is saved.
    const ltPay = lt && (lt.mode === 'card' || lt.mode === 'upi') ? lt : null;
    if (same && b.rgCashPaise === null && lt && !ltPay) {
      const gapTxt = lt.amountPaise != null && lt.amountPaise !== sw ? ` as ₹ ${money(lt.amountPaise)} (₹ ${money(Math.abs(sw - lt.amountPaise))} less than billed)` : '';
      items.push({ same, top: true, html: html`<div class="ent-line" style="border:1px solid #CBD5E1;border-radius:8px;padding:10px 12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>Written late · paid</strong>
          <span class="chip">${dayLabel(lt.day)} register</span></div>
        <div>Bill <span class="mono">${b.billNo}</span> · ₹ ${money(sw)} cash in the software, written in the ${dayLabel(lt.day)} register${gapTxt}.</div>
        <div class="tiny note">${k.pair ? `The ${dayLabel(k.pair.day)} cash is ${k.pair.differencePaise > 0 ? 'over' : 'short'} by ₹ ${money(Math.abs(k.pair.differencePaise))}: settle the two days together below.`
          : `The cash most likely went into the ${dayLabel(lt.day)} count. Once both days are saved and counted, they can be settled together here.`}</div></div>` });
      continue;
    }
    if (same && b.rgCashPaise === null && (b.decision === 'use_software' || b.state === 'undecided')) {
      const age = shiftAge(k.day);
      const red = age > CASH_WATCH_DAYS && !ltPay;
      const decideIt = biz.actions.includes('sales.decide');
      const writeoff = !draft && biz.actions.includes('cash.writeoff') && diff < 0;
      const acts = html`<button type="button" class="btn plain dchip" data-leaveunk="${b.comparisonId}" data-bill="${b.billNo}" title="Asks why. The bill is not counted, so the cash agrees.">Not paid: leave it out</button>
          <button type="button" class="btn plain dchip" data-bill-drawer="${b.billNo}|${k.day}" title="Opens the bill: write the cash on its register line">Paid, add to the register</button>
          ${writeoff ? html`<button type="button" class="btn plain dchip" data-shortbill="${b.comparisonId}" data-bill="${b.billNo}" data-amt="${sw}" title="An expense under Cash shortage for this bill's amount">Book as shortage</button>` : ''}`;
      items.push({ same, top: true, html: html`<div class="ent-line" style="border:1px solid ${red ? '#F3B4B4' : '#FCD34D'};border-radius:8px;padding:10px 12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>${red ? 'Payment not received' : 'Explained by a bill not in the register · waiting'}</strong>
          <span class="chip ${red ? 'bad' : 'wait'}">${red ? `${age} days` : `day ${Math.max(1, age)} of ${CASH_WATCH_DAYS}`}</span></div>
        <div>Bill <span class="mono">${b.billNo}</span> · ₹ ${money(sw)} cash in the software, not in the register.</div>
        ${ltPay ? html`<div class="tiny" style="color:var(--teal-ink)">Written in the ${dayLabel(ltPay.day)} register as ${ltPay.mode === 'card' ? 'card' : 'UPI'}. Once this shift is saved, change it on ${dayLabel(ltPay.day)}'s ${ltPay.mode === 'card' ? 'Card' : 'UPI'} tab: this day's short then drops by ₹ ${money(sw)}.</div>` : ''}
        ${cashUpiFix(b, opts.byUpi?.get(b.comparisonId), true)}
        <div class="tiny note">${red ? `Not written in any register in ${CASH_WATCH_DAYS} days, and the cash is short by the same.` : `Counted as a ${dayLabel(k.day)} sale. Usually written in the next day's register: it closes by itself then. Saving is not blocked.`}</div>
        ${decideIt ? html`<div class="form-row" style="gap:6px;margin-top:4px;align-items:center">${red ? '' : html`<span class="note">Already know?</span>`}${acts}</div>` : ''}</div>` });
      continue;
    }
    // One line per bill (approved 14 Nov 2026): what differs, then the two sides as choices with the cash after each;
    // Edit and Make complimentary under ⋯.
    const more = html`<details class="menu"><summary class="btn plain dchip" aria-label="More for bill ${b.billNo}">⋯</summary><div class="menu-pop" style="min-width:200px;gap:6px">
      <button type="button" class="btn plain dchip" data-bill-drawer="${b.billNo}|${k.day}">Edit</button>
      ${draft && b.state !== 'complimentary' && biz.actions.includes('sales.decide') ? html`<button type="button" class="btn plain dchip" data-makecomp="${b.comparisonId}" data-bill="${b.billNo}">Make complimentary</button>` : ''}</div></details>`;
    items.push({ same, html: html`<div class="ent-line" style="${same ? 'border:1px solid #F3B4B4;border-radius:8px;padding:8px 10px' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>${same ? html`<span class="chip bad">Same amount</span> ` : ''}<span class="mono">${b.billNo}</span> · ${text}</span>${more}</div>
      ${wit}
      ${b.rgCashPaise === null && draft && biz.actions.includes('sales.decide') ? cashUpiFix(b, opts.byUpi?.get(b.comparisonId), true) : ''}
      ${switches.length ? html`<div class="form-row" style="gap:6px;margin-top:4px">${switches.map((x) => html`<button type="button" class="btn ${x.on ? 'ghost' : 'plain'} dchip" ${x.on ? 'disabled style="font-weight:600;background:#E3F1EF"' : ''}
          data-cashswitch="${b.comparisonId}" data-d="${x.d}" data-was="${b.decision ?? ''}" data-bill="${b.billNo}" data-label="${x.text}" data-note="${x.note}" title="${x.text}">${x.on ? '✓ ' : ''}${x.label ?? sideName(x.d)} · ${x.on ? word(diff) : x.then}</button>`)}</div>`
        : effects.length ? html`<div class="tiny note">${effects.map(([l, v]) => `${l}: ${v ? `+₹ ${money(v)}` : '₹ 0'}`).join(' · ')}</div>` : ''}
      ${b.state === 'undecided' && !switches.length ? html`<div class="form-row" style="gap:6px;margin-top:4px">${decide}</div>` : ''}</div>` });
  }
  // Bills paid a rounded amount: already counted as paid, told on one quiet line (14 Nov 2026).
  const rounded = bills.filter((b) => b.roundedPaise);
  const off = rounded.filter((b) => b.roundedPaise > 0).reduce((t, b) => t + b.roundedPaise, 0);
  const extra = -rounded.filter((b) => b.roundedPaise < 0).reduce((t, b) => t + b.roundedPaise, 0);
  // The bills behind a line of the working, on a click (17 Nov 2026).
  const counting = bills.filter((b) => b.countedPaise);
  // Counted as cash but the register doesn't show it as cash (18 Nov 2026): not in the register, or written as UPI or card.
  const notInReg = counting.filter((b) => b.rgCashPaise === null || (!b.rgCashPaise && b.rgOther.length));
  const lateOf = (b) => (k.notInRegister ?? []).find((x) => x.id === b.comparisonId)?.late ?? null;
  const notCashWhy = (b) => { if (b.rgCashPaise !== null) return `register wrote ${other(b)}`;
    const lt = lateOf(b); return `not in the ${dayLabel(k.day)} register${lt ? ` (${dayLabel(lt.day)}: ${MODE_LABELS[lt.mode] ?? lt.mode ?? 'written'})` : ''}`; };
  const notCashOpen = html`<details><summary style="cursor:pointer">of which the register doesn't show as cash · <u>${notInReg.length} bill${notInReg.length === 1 ? '' : 's'}</u></summary>
    ${notInReg.map((b) => html`<div class="tiny"><button type="button" class="linkbtn tiny mono" data-bill-drawer="${b.billNo}|${k.day}">${b.billNo}</button> · ₹ ${money(b.countedPaise)} · ${notCashWhy(b)}</div>`)}</details>`;
  const notCashPaise = notInReg.reduce((t, b) => t + b.countedPaise, 0);
  // Changed after saving (18 Nov 2026): a cash bill of this day paid by card or UPI on a later day.
  const later = k.changedLater ?? [];
  const wasDiff = diff == null || !later.length ? null
    : diff - later.filter((x) => x.from === 'cash').reduce((t, x) => t + x.amountPaise, 0) + later.reduce((t, x) => t + (x.shortage ? x.shortage.fromPaise - x.shortage.toPaise : 0), 0);
  const billsOpen = (label, list) => (list.length ? html`<details><summary style="cursor:pointer">${label} · <u>${list.length} bill${list.length === 1 ? '' : 's'}</u></summary>
    ${list.map((b) => html`<div class="tiny"><button type="button" class="linkbtn tiny mono" data-bill-drawer="${b.billNo}|${k.day}">${b.billNo}</button> · ₹ ${money(b.countedPaise)}${b.groupSize > 1 ? ` · group of ${b.groupSize}` : ''}${b.state === 'decided' ? ` · ${b.decision === 'use_software' ? 'Use software' : b.decision === 'use_register' ? 'Use register' : DECISION_LABELS[b.decision] ?? ''}` : b.state === 'undecided' ? ' · not decided' : ''}</div>`)}</details>` : label);
  // Discount at the till (17 Nov 2026): one line in the working, its bills listed on a click.
  const tillLine = (list, word, paise) => (list.length ? html`<tr><td></td><td class="note" colspan="3"><details><summary style="cursor:pointer">${word} on <u>${list.length} bill${list.length === 1 ? '' : 's'}</u> · ₹ ${money(paise)}</summary>
    ${list.map((b) => html`<div class="tiny"><span class="mono">${b.billNo}</span> · software ₹ ${money(b.swCashPaise)} · paid ₹ ${money(b.rgCashPaise)} · ${b.roundedPaise > 0 ? 'discount' : 'extra'} ₹ ${money(Math.abs(b.roundedPaise))}</div>`)}</details></td></tr>` : '');
  const roundedRows = html`${tillLine(rounded.filter((b) => b.roundedPaise > 0), 'Discount at the till', off)}${tillLine(rounded.filter((b) => b.roundedPaise < 0), 'Paid more than the bill', extra)}`;
  if (k.expensesWaiting) items.push({ same: gap === k.expensesWaitingPaise, html: html`<div class="ent-line"><div><span class="chip wait">Waiting approval</span> ${k.expensesWaiting} cash expense${k.expensesWaiting === 1 ? '' : 's'}, ₹${money(k.expensesWaitingPaise).replace(/\.00$/, '')}: counted once approved</div>
    <div class="form-row" style="gap:6px;margin-top:4px"><a class="btn plain dchip" href="#/b/${biz.id}/review${k.expensesWaitingUploadId ? `/${k.expensesWaitingUploadId}` : `?day=${k.day}`}">Review</a></div></div>` });
  items.sort((a, b) => Number(!!b.top) - Number(!!a.top) || Number(b.same) - Number(a.same));
  const tops = items.filter((x) => x.top), rest = items.filter((x) => !x.top);
  const tint = (b) => (b.rgCashPaise === null || (b.state === 'undecided' && b.swCashPaise !== null && b.rgCashPaise !== null && !b.rgCashPaise) ? 'cash-bad' : b.differs ? 'cash-warn' : '');
  const counted = (b) => (b.state === 'match' ? 'Matches' : b.state === 'left_out' ? 'Left out' : b.state === 'complimentary' ? 'Complimentary' : b.state === 'undecided' ? 'Not decided'
    : b.decision === 'use_software' ? 'Use software' : b.decision === 'use_register' ? 'Use register' : DECISION_LABELS[b.decision] ?? '');
  return html`<section class="card" id="cashpanel" style="gap:12px">
    <style>#cashpanel .cash-bad{background:#FDECEC;color:#7F1D1D}#cashpanel .cash-warn{background:#FFF6E0;color:#6B4A00}#cashpanel tr.cash-bad td,#cashpanel tr.cash-warn td{color:inherit}
      #cashpanel .cash-strip{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
      #cashpanel .cash-strip>div{padding:8px 12px;border-radius:8px;flex:1 1 140px}#cashpanel .cash-strip>.cash-op{flex:0 0 auto;padding:0;font-size:22px;color:var(--muted)}#cashpanel .cash-big{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}</style>
    <div class="cash-strip">
      <div><div class="note">Cash counted</div><div class="cash-big">${k.countedPaise == null ? '—' : `₹ ${money(k.countedPaise)}`}</div>
        ${k.countedPaise == null ? html`<a class="tiny" href="#/b/${biz.id}/bringin">Not in yet: bring it in</a>` : html`<div class="tiny note">from the cash page</div>`}</div>
      <div><div class="note">Should be there</div><div class="cash-big">${shouldBe == null ? '—' : `₹ ${money(shouldBe)}`}</div><div class="tiny note">${k.openingPaise == null ? 'No opening cash yet' : 'worked out below'}</div></div>
      <div class="${tone}" title="${draft ? 'Changes as you decide and correct bills, final after Save' : 'Final: booked when the shift was saved'}"><div style="font-size:13px">${{ ok: 'Cash agrees', accepted: 'Difference accepted', short: 'Cash short', over: 'Extra cash' }[state] ?? 'Difference'}</div><div class="cash-big">${diff == null ? '—' : diff === 0 ? '₹ 0' : `₹ ${money(Math.abs(diff))}`}</div><div class="tiny">${draft ? 'can change until you save' : 'saved'}</div></div>
    </div>
    ${diff ? html`<div class="note">₹ ${money(k.countedPaise)} counted − ₹ ${money(shouldBe)} expected = ₹ ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than expected.</div>` : ''}
    ${pageVsBookr(biz, k, { draft, sales, shouldBe, diff, bills })}
    ${paidHereNotice(k.paidHere, !!opts.decide)}
    <details><summary class="note">How ${shouldBe == null ? 'it' : `₹ ${money(shouldBe)}`} is worked out</summary><div class="scroll"><table style="min-width:560px">
      ${row('Cash at the start', k.openingFrom === 'previous' ? `counted at the end of ${dayLabel(addDaysIso(k.day, -1))}` : k.openingFrom === 'page' ? 'written on this day\'s cash page' : 'no cash page for the day before', k.openingPaise)}
      ${k.previous ? html`<tr style="color:var(--muted)"><td></td><td colspan="3">${dayLabel(k.previous.day)} was short ₹ ${money(-k.previous.differencePaise)}${k.previous.bills.length ? ` (${k.previous.bills.join(', ')} waiting)` : ''}. Not carried in: this day starts from the counted ₹ ${money(k.openingPaise ?? 0)}.</td></tr>` : ''}
      ${row('+ Cash sales', billsOpen(draft ? 'as they stand now' : 'booked for this shift', counting), sales)}
      ${(k.lateIn ?? []).map((x) => row('+ Earlier bill paid here', html`<span class="mono">${x.billNo}</span>, a ${dayLabel(x.fromDay)} bill paid in cash today`, x.amountPaise))}
      ${(k.lateOut ?? []).map((x) => row('− Paid on a later day', html`<span class="mono">${x.billNo}</span>, paid in cash on ${dayLabel(x.day)}: counted in that drawer`, x.amountPaise))}
      ${notCashPaise ? row('', notCashOpen, notCashPaise, '', false, 'cash-warn') : ''}
      ${later.map((x) => html`<tr style="color:var(--muted)"><td></td><td>Changed after saving: ${x.bills.join(', ')} ₹ ${money(x.amountPaise)} ${MODE_WORD[x.from] ?? x.from} → ${MODE_WORD[x.mode] ?? x.mode}${x.paidOn ? html`, paid on ${dayLabel(x.paidOn)}` : ''} (${x.by ?? 'someone'}, ${when(x.at)})${x.paidOn ? html` · <a href="#/b/${biz.id}/reconcile/${x.paidOn}?tab=card">Open ${dayLabel(x.paidOn)}</a>` : ''}${x.shortage ? ` · shortage ₹ ${money(x.shortage.fromPaise)} → ₹ ${money(x.shortage.toPaise)}` : ''}</td><td class="amount">${x.from === 'cash' ? `−${money(x.amountPaise)}` : ''}</td><td></td></tr>`)}
      ${roundedRows}
      ${row('− Cash spent', 'expense page, approved lines', k.expensesPaise)}
      ${k.expensesWaiting ? html`<tr style="color:var(--muted)"><td></td><td>${k.expensesWaiting} line${k.expensesWaiting === 1 ? '' : 's'} waiting approval (not taken off)</td><td class="amount">${money(k.expensesWaitingPaise ?? 0)}</td><td><a href="#/b/${biz.id}/review${k.expensesWaitingUploadId ? `/${k.expensesWaitingUploadId}` : `?day=${k.day}`}">Review</a></td></tr>` : ''}
      ${k.shortagePaise ? row('− Cash shortage', 'booked by an Owner', k.shortagePaise) : ''}
      ${k.excessPaise ? row('+ Cash excess', 'extra cash booked as income', k.excessPaise) : ''}
      ${k.depositedPaise ? row('− Cash deposited to bank', 'from the bank statement', k.depositedPaise) : ''}
      ${k.drawnPaise ? row('+ Cash from bank', 'taken out for the drawer', k.drawnPaise) : ''}
      ${row('= Should be there', '', shouldBe, '', true)}
      ${row('Counted', 'cash in hand on this day\'s cash page', k.countedPaise, k.summaryUploadId ? html`<a href="#/b/${biz.id}/review/${k.summaryUploadId}">Open page</a>` : html`<a href="#/b/${biz.id}/bringin">Bring it in</a>`)}
      ${diff !== null ? row('Difference', `${diff < 0 ? 'short' : diff > 0 ? 'over' : ''}${wasDiff != null && wasDiff !== diff ? ` · was ${wasDiff < 0 ? `₹ ${money(-wasDiff)} short` : wasDiff > 0 ? `₹ ${money(wasDiff)} over` : '₹ 0'} when saved` : ''}`, diff, '', true, diff < 0 ? 'cash-bad' : diff > 0 ? 'cash-warn' : '') : ''}
    </table></div></details>
    ${diff ? html`<div style="display:flex;flex-direction:column;gap:6px">${tops.map((x) => x.html)}
      ${rest.filter((x) => !x.quiet).length ? html`<strong>Bills that change the cash</strong><div class="tiny note">Each button shows what the shortage becomes. ✓ is how it stands now.</div>${rest.filter((x) => !x.quiet).map((x) => x.html)}` : ''}
      ${rest.filter((x) => x.quiet).length ? html`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px"><strong>Not in the drawer: paid another way</strong><span class="chip ok">${rest.filter((x) => x.quiet).length} · nothing to do</span></div>${rest.filter((x) => x.quiet).map((x) => x.html)}` : ''}
      ${k.reverse ? html`<div class="ent-line"><span class="chip">Came late?</span> Over by ₹ ${money(k.reverse.amountPaise)}: a shortage of the same was booked on ${dayLabel(k.reverse.day)}${k.reverse.billNo ? ` for bill ${k.reverse.billNo}` : ''}.
        ${biz.actions.includes('cash.writeoff') ? html`<button class="btn plain dchip" type="button" id="cashreverse" data-tx="${k.reverse.id}" data-day="${k.reverse.day}">Reverse that shortage</button>` : ''}
        <div class="tiny note">Takes the shortage out of the books; then settle the two days together as paid late.</div></div>` : ''}
      ${k.pair ? html`<div class="ent-line"><span class="chip">Paid late?</span> ${k.pair.gapPaise
        ? `₹ ${money(k.pair.shortDay === k.day ? k.pair.amountPaise : Math.abs(k.pair.differencePaise))} short on ${dayLabel(k.pair.shortDay)}, ₹ ${money(k.pair.overDay === k.day ? k.pair.amountPaise : Math.abs(k.pair.differencePaise))} over on ${dayLabel(k.pair.overDay)}: ₹ ${money(k.pair.gapPaise)} differs, accepted with them.`
        : `₹ ${money(k.pair.amountPaise)} short on ${dayLabel(k.pair.shortDay)}, over on ${dayLabel(k.pair.overDay)}.`}
        ${!draft && biz.actions.includes('sales.decide') ? html`<button class="btn plain dchip" type="button" id="cashpair" data-other="${k.pair.day}">Settle both as paid late</button>` : html`<a class="btn plain dchip" href="#/b/${biz.id}/reconcile/${k.pair.day}">Open ${dayLabel(k.pair.day)}</a>`}</div>` : ''}
    </div>` : ''}
    ${bills.length ? html`<details><summary style="display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>Cash bills · ${counting.length} · ₹ ${money(bills.reduce((t, b) => t + (b.countedPaise ?? 0), 0))}</strong><span class="note">${bills.length > counting.length ? `the list has ${bills.length}: ${bills.length - counting.length} not counted as cash · ` : ''}${differ.length ? `${differ.length} differ` : 'all agree'}</span></summary>
      ${differ.length ? html`<label class="note" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cashonly" checked> Only those that differ</label>` : ''}
    <div class="scroll"><table style="min-width:600px" id="cashbills">
      <thead><tr><th>Bill</th><th style="text-align:right">Software cash</th><th style="text-align:right">Register cash</th><th>Counted as</th><th style="text-align:right">Counted ₹</th><th></th></tr></thead>
      <tbody>${bills.map((b) => html`<tr class="${tint(b)}" data-differs="${b.differs ? '1' : ''}" ${differ.length && !b.differs ? 'hidden' : ''}>
        <td class="mono">${b.billNo}${b.groupSize > 1 ? html` <span class="tiny">group of ${b.groupSize}</span>` : ''}${opts.oldPos?.has(b.comparisonId) ? html` <span class="chip">old POS</span>` : ''}</td>
        <td class="amount">${b.swCashPaise == null ? (b.swMode ? `${MODE_LABELS[b.swMode] ?? b.swMode} ${money(b.swAmountPaise ?? 0)}` : '—') : money(b.swCashPaise)}</td>
        <td class="amount">${b.rgCashPaise == null ? '—' : b.rgCashPaise ? money(b.rgCashPaise) : other(b) || '0.00'}</td>
        <td>${counted(b)}</td><td class="amount">${b.countedPaise ? money(b.countedPaise) : ''}</td><td>${edit(b)}</td></tr>`)}</tbody>
    </table></div></details>` : ''}
    ${draft && diff < 0 && notCashPaise ? html`<div class="note" style="color:var(--ink)">Short ₹ ${money(-diff)}: the register doesn't show ${notInReg.length} bill${notInReg.length === 1 ? '' : 's'} as cash: ${notInReg.map((b) => `${b.billNo} ₹ ${money(b.countedPaise)}`).join(', ')}. ${-diff > notCashPaise ? html`<strong>Unexplained ₹ ${money(-diff - notCashPaise)}</strong>.` : 'Unexplained ₹ 0.'}</div>` : ''}
    ${!draft && k.explained ? html`<div class="note" style="color:var(--ink)">Short ₹ ${money(-diff)}${k.explained.bills.length ? html`, explained by ${k.explained.bills.length} bill${k.explained.bills.length === 1 ? '' : 's'} the register doesn't show as cash: ${k.explained.bills.map((b) => `${b.billNo} ₹ ${money(b.partPaise)}${b.partPaise < b.amountPaise ? ` of ₹ ${money(b.amountPaise)}` : ''}`).join(', ')}` : ''}${k.explained.unexplainedPaise ? html`${k.explained.bills.length ? ' / ' : ': '}<strong>unexplained ₹ ${money(k.explained.unexplainedPaise)}</strong>` : ''}.</div>` : ''}
    ${k.accepted ? html`<div class="note">Accepted with a note: ${k.accepted}</div>` : ''}
    ${!draft && diff !== null && diff !== 0 && !k.settled ? html`<form id="cashact" class="inset">
      <div class="field"><label for="cashnote">Note (what happened)</label><input id="cashnote" name="note" required placeholder="e.g. Bill 26103136 cash received, not written in the register"></div>
      <div class="form-msg"></div>
      <div class="form-row">
        ${biz.actions.includes('sales.decide') ? html`<button class="btn plain" type="submit" data-cashact="accept" title="The cash is there; only the writing is wrong">Accept with a note</button>` : ''}
        ${diff > 0 && biz.actions.includes('cash.writeoff') ? html`<button class="btn plain" type="submit" data-cashact="excess" title="The extra cash is really there: booked as approved income in Cash under Cash excess">Book ₹ ${money(diff)} as cash excess</button>` : ''}
        ${diff < 0 && biz.actions.includes('cash.writeoff') ? html`<button class="btn danger" type="submit" data-cashact="shortage" title="Cash is missing: booked as an approved expense from Cash under Cash shortage (Owner only)">Book ₹ ${money(-diff)} as cash shortage</button>` : ''}
      </div>
    </form>` : ''}
  </section>`;
}

/**
 * The cash page next to Bookr, line by line (approved 20 Nov 2026): the page's cash in hand is its own sum, so a
 * difference is the page and Bookr adding up differently. Each gap is told with what Bookr found for it.
 */
function pageVsBookr(biz, k, { draft, sales, shouldBe, diff, bills }) {
  const pg = k.page;
  const excessP = k.excessPaise ?? 0;
  if (!pg || pg.receivedPaise == null || pg.expensesPaise == null || sales == null || shouldBe == null || (!diff && !excessP)) return '';
  const lateInP = k.lateInPaise ?? 0, lateOutP = k.lateOutPaise ?? 0;
  const bkRec = sales + lateInP - lateOutP + excessP;
  const bkExp = k.expensesPaise + (k.shortagePaise ?? 0) + (k.depositedPaise ?? 0) - (k.drawnPaise ?? 0);
  const recGap = pg.receivedPaise - bkRec, expGap = pg.expensesPaise - bkExp;
  const ownSum = pg.openingPaise != null && pg.cashInHandPaise != null && pg.openingPaise + pg.receivedPaise - pg.expensesPaise === pg.cashInHandPaise;
  const signed = (v) => (v === 0 ? html`<span style="color:var(--teal)">same</span>` : html`<span style="color:#92400E">${v > 0 ? '+' : '−'}${money(Math.abs(v))}</span>`);
  const can = biz.actions.includes('sales.decide');
  const box = (amt, head, body, acts = '') => html`<div class="ent-line" style="border-left:3px solid #F59E0B;padding:8px 10px;background:#FFFBEB;border-radius:0">
    <div style="flex:1"><div style="display:flex;justify-content:space-between;gap:8px"><span>${head}</span><span class="amount" style="color:#92400E">${money(amt)}</span></div>
    <div class="tiny note" style="margin-top:2px">${body}</div>${acts ? html`<div class="form-row" style="gap:6px;margin-top:6px">${acts}</div>` : ''}<div class="form-msg"></div></div></div>`;
  // Not a mistake (21 Nov 2026): the extra cash is really there, booked as income under Cash excess.
  const excessForm = !draft && diff > 0 && k.confirmed && biz.actions.includes('cash.writeoff')
    ? html`<div style="flex-basis:100%;border-top:1px solid #FDE68A;padding-top:8px;margin-top:4px"><div class="tiny">Not a mistake? The cash is really there:</div>
      <div class="form-row" style="gap:6px;margin-top:4px"><input class="compact" data-excessnote placeholder="Note, e.g. guest left change" style="flex:1;min-width:180px">
      <button type="button" class="btn plain dchip" data-excess="${diff}">Book ₹ ${money(diff)} as Cash excess</button></div></div>` : '';
  // Received: earlier bills paid here, then what the page has beyond the register.
  const offers = k.lateOffers ?? [];
  const offered = offers.reduce((t, x) => t + x.amountPaise, 0);
  const pageOverReg = pg.receivedPaise - (k.registerCashPaise ?? 0);
  const rest = recGap - offered;
  const likely = rest ? bills.filter((b) => b.rgOther?.some((p) => p.amountPaise === Math.abs(rest))) : [];
  const recItems = [
    ...offers.map((x) => box(x.amountPaise, html`<span class="mono">${x.billNo}</span> · ₹ ${money(x.amountPaise)} · a ${dayLabel(x.fromDay)} bill paid here in cash`,
      html`Counted as cash on ${dayLabel(x.fromDay)} (software ₹ ${money(x.swAmountPaise)}), but not in that day's register. The ${dayLabel(k.day)} register writes it as ₹ ${money(x.amountPaise)} cash received: the money is in this drawer. Counting it here also explains ${dayLabel(x.fromDay)}'s cash by ₹ ${money(x.amountPaise)}; the sale stays on ${dayLabel(x.fromDay)}.`,
      can ? html`<button type="button" class="btn plain dchip" data-cashlate="${x.comparisonId}" data-bill="${x.billNo}" data-amt="${x.amountPaise}" data-from="${x.fromDay}">Paid here in cash: count ₹ ${money(x.amountPaise)}</button>` : '')),
    ...(k.lateIn ?? []).map((x) => html`<div class="ent-line" style="border-left:3px solid var(--teal);padding-left:10px"><div><span class="mono">${x.billNo}</span> · ₹ ${money(x.amountPaise)} · a ${dayLabel(x.fromDay)} bill paid here in cash: counted<div class="tiny note">${x.by ? `${x.by}, ` : ''}${when(x.at)}</div></div>
      ${can ? html`<button type="button" class="btn plain dchip" data-cashlateundo="${x.auditId}" data-bill="${x.billNo}">Undo</button>` : ''}</div>`),
    ...(k.excesses ?? []).map((x) => html`<div class="ent-line" style="border-left:3px solid var(--teal);padding-left:10px"><div>₹ ${money(x.amountPaise)} booked as Cash excess${x.note ? html` · "${x.note}"` : ''}<div class="tiny note">${x.by ? `${x.by}, ` : ''}${when(x.at)}</div></div>
      ${biz.actions.includes('cash.writeoff') ? html`<button type="button" class="btn plain dchip" data-excessundo="${x.id}" data-amt="${x.amountPaise}">Undo</button>` : ''}</div>`),
    ...(rest ? [box(Math.abs(rest), rest > 0 ? (pageOverReg === rest ? `₹ ${money(rest)} on the page, not in the register` : `₹ ${money(rest)} more on the page than Bookr counts`) : `₹ ${money(-rest)} less on the page than Bookr counts`,
      html`The register's cash column adds up to ₹ ${money(k.registerCashPaise ?? 0)}; the page says ₹ ${money(pg.receivedPaise)}.${likely.length ? html` Likely: ${likely.map((b, i) => html`${i ? ', ' : ''}<span class="mono">${b.billNo}</span> ₹ ${money(Math.abs(rest))}, written as ${b.rgOther.map((p) => MODE_LABELS[p.mode] ?? p.mode).join(' + ').toLowerCase()} in the register`)}, added into cash on the page by mistake.` : ' A slip on the page, or a bill written as cash on the page only.'}`,
      html`${k.summaryUploadId ? html`<a class="btn plain dchip" href="#/b/${biz.id}/review/${k.summaryUploadId}">Open the cash page</a>` : ''}${excessForm}`)] : []),
  ];
  const expItems = expGap ? [box(Math.abs(expGap), expGap > 0 ? `₹ ${money(expGap)} more on the page than the approved lines` : `₹ ${money(-expGap)} less on the page than the approved lines`,
    k.expensesWaiting ? `${k.expensesWaiting} line${k.expensesWaiting === 1 ? '' : 's'} of ₹ ${money(k.expensesWaitingPaise)} still waiting approval.` : `The page says ₹ ${money(pg.expensesPaise)}; Bookr's approved lines add up to ₹ ${money(bkExp)}. A line on the photo may be missing or read wrong: check the photo, and add the line, or note the page total is wrong.`,
    (k.expensesWaitingUploadId || k.expensesUploadId) ? html`<a class="btn plain dchip" href="#/b/${biz.id}/review/${k.expensesWaitingUploadId || k.expensesUploadId}">Open the expense page</a>` : '')] : [];
  return html`<div class="inset" style="display:flex;flex-direction:column;gap:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><strong>Cash page vs Bookr</strong>${diff ? html`<span class="chip wait">₹ ${money(Math.abs(diff))} apart</span>` : html`<span class="chip ok">same</span>`}</div>
    <div class="scroll"><table style="min-width:420px"><colgroup><col><col style="width:110px"><col style="width:110px"><col style="width:90px"></colgroup>
      <thead><tr><th>Line</th><th style="text-align:right">Cash page</th><th style="text-align:right">Bookr</th><th style="text-align:right">Gap</th></tr></thead>
      <tbody><tr><td>Cash at the start</td><td class="amount">${pg.openingPaise == null ? '—' : money(pg.openingPaise)}</td><td class="amount">${money(k.openingPaise ?? 0)}</td><td class="amount">${pg.openingPaise == null ? '' : signed(pg.openingPaise - (k.openingPaise ?? 0))}</td></tr>
      <tr><td>+ Received</td><td class="amount">${money(pg.receivedPaise)}</td><td class="amount">${money(bkRec)}</td><td class="amount">${signed(recGap)}</td></tr>
      <tr><td>− Expenses</td><td class="amount">${money(pg.expensesPaise)}</td><td class="amount">${money(bkExp)}</td><td class="amount">${signed(-expGap)}</td></tr>
      <tr style="font-weight:600"><td>= Cash in hand</td><td class="amount">${money(pg.cashInHandPaise ?? k.countedPaise)}</td><td class="amount">${money(shouldBe)}</td><td class="amount">${signed(diff)}</td></tr></tbody></table></div>
    ${ownSum ? html`<div class="tiny note">The cash page's ₹ ${money(pg.cashInHandPaise)} is its own sum (start + received − expenses), not a separate count: the gap is the page and Bookr adding up differently.</div>` : ''}
    ${recItems.length ? html`<strong style="font-size:14px">Why Received is ₹ ${money(Math.abs(recGap))} apart</strong>${recItems}` : ''}
    ${expItems.length ? html`<strong style="font-size:14px">Why Expenses are ₹ ${money(Math.abs(expGap))} apart</strong>${expItems}` : ''}
  </div>`;
}

/**
 * Payments › Complimentary (approved 14 Nov 2026): the shift's complimentary bills (PREPAID in the software, ₹0, or made
 * complimentary by a person with the guest's name), and PREPAID bills that need a look because the register shows money.
 * Each: Complimentary ✓ (asks the guest's name) or Paid by Cash / UPI / Card. Never counted as sales; value on Reports.
 */
function compPanelHtml(biz, comp, canAct) {
  const WHY = { prepaid: 'PREPAID in the software', zero: '₹0 bill', marked: 'Made complimentary', unknown: 'Mode U/N in the software · not in the register' };
  const looks = comp.lines.filter((l) => l.status === 'look');
  const oks = comp.lines.filter((l) => l.status === 'ok');
  const line = (l) => html`<div class="ent-line" style="${l.status === 'look' ? 'border-left:3px solid #F59E0B;padding-left:10px' : ''}">
    <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><span class="mono"><strong>${l.billNo}</strong></span>
      <span class="amount">${l.valuePaise ? `₹ ${money(l.valuePaise)}` : '₹ 0'}</span>
      <span class="chip ${l.status === 'ok' ? 'ok' : 'wait'}">${l.status === 'ok' ? 'Complimentary' : 'Needs a look'}</span>
      <span class="tiny note">${WHY[l.why]}</span>
      <button type="button" class="linkbtn tiny" data-bill-drawer="${l.billNo}|${comp.day}">Details</button></div>
    <div class="tiny">${l.guestName ? html`Guest: <strong>${l.guestName}</strong>${l.markedBy ? ` · by ${l.markedBy}` : ''}` : l.name ? `Software name: ${l.name}` : html`<span class="note">No guest name yet</span>`}${l.remarks ? ` · Register: ${l.remarks}` : ''}</div>
    ${l.look ? html`<div class="tiny error">${l.look}</div>` : ''}
    ${l.hint ? html`<div class="tiny" style="color:var(--teal-ink)">Maybe: ${l.hint.text}</div>` : ''}
    ${canAct ? html`<div class="form-row" style="gap:6px;margin-top:4px;align-items:center">
      ${l.why === 'unknown' ? html`${paidByChips(l, l.hint?.mode)}
        <button type="button" class="btn plain dchip" data-makecomp="${l.comparisonId}" data-bill="${l.billNo}" data-name="${l.name ?? ''}">Complimentary</button>
        <button type="button" class="btn plain dchip" data-leaveunk="${l.comparisonId}" data-bill="${l.billNo}">Leave out…</button>`
      : html`<button type="button" class="btn ${l.status === 'look' ? '' : 'plain'} dchip" data-makecomp="${l.comparisonId}" data-bill="${l.billNo}" data-name="${l.guestName ?? l.name ?? ''}" ${l.guestName ? 'data-had="1"' : ''}>${l.guestName ? 'Change guest name' : 'Complimentary ✓'}</button>
      ${paidByChips(l)}`}</div>` : ''}
  </div>`;
  return html`<section class="card" style="gap:10px">
    <div class="lane-h"><strong>Complimentary bills</strong><span class="tchip">${oks.length} · ₹ ${money(comp.valuePaise)} given free</span></div>
    <div class="note">Not counted as sales. Bills the software calls U/N that the register does not have wait here too, until you say how they were paid. PREPAID bills in the software and ₹0 bills come here by themselves; any other bill can be made complimentary from All bills, Cash or its details. A bill that was paid after all: choose how under "Paid by", and it moves to that tab.</div>
    ${looks.length ? html`<strong style="font-size:15px">Needs a look (${looks.length})</strong>${looks.map(line)}` : ''}
    ${oks.length ? html`${looks.length ? html`<strong style="font-size:15px">Complimentary (${oks.length})</strong>` : ''}${oks.map(line)}` : html`<div class="note">None in this shift yet.</div>`}
  </section>`;
}

/** Set by the Cash panel: the drawer's register editor shows what a change does to the cash (approved 14 Nov 2026). */
let drawerCash = null;

function wireCashPanel(biz, day, reload, msg, k = null) {
  if (k) drawerCash = { day, shouldBePaise: k.confirmed ? k.shouldBePaise : k.draft?.shouldBePaise ?? null, countedPaise: k.countedPaise };
  document.getElementById('cashonly')?.addEventListener('change', (e) => {
    document.querySelectorAll('#cashbills tbody tr').forEach((tr) => { tr.hidden = e.target.checked && !tr.dataset.differs; });
  });
  document.getElementById('cashreverse')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!confirm(`Reverse the cash shortage booked on ${dayLabel(b.dataset.day)}? The cash came in late.`)) return;
    try { await apiFull('POST', `/businesses/${biz.id}/cash-shortages/${b.dataset.tx}/reverse`, { note: `Cash came in on ${dayLabel(day)}` }); reload(); } catch (err) { showError(msg, err); }
  });
  // An earlier day's bill paid here in cash (20 Nov 2026), and its Undo.
  document.querySelectorAll('#cashpanel [data-cashlate]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/cash/paid-late`, { comparisonId: b.dataset.cashlate });
      await reload();
      doneToast(`Bill ${b.dataset.bill}: ₹ ${money(Number(b.dataset.amt))} counted in ${dayLabel(day)}'s cash; ${dayLabel(b.dataset.from)}'s cash is explained by it.`,
        () => apiFull('POST', `/businesses/${biz.id}/cash/paid-late/${r.auditId}/undo`, {}), reload);
    } catch (err) { b.disabled = false; showError(b.closest('.ent-line')?.querySelector('.form-msg') ?? msg, err); }
  }));
  document.querySelectorAll('#cashpanel [data-cashlateundo]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Undo: bill ${b.dataset.bill} is not counted as paid in cash on the later day any more?`)) return;
    b.disabled = true;
    try { await apiFull('POST', `/businesses/${biz.id}/cash/paid-late/${b.dataset.cashlateundo}/undo`, {}); reload(); } catch (err) { b.disabled = false; showError(msg, err); }
  }));
  const bookExcess = async (amt, note, b) => {
    if (!note) { alert('Write a note: what is the extra cash?'); return; }
    if (!confirm(`Book ₹ ${money(amt)} as Cash excess? It becomes approved income in Cash.`)) return;
    if (b) b.disabled = true;
    try {
      const r = await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/cash/excess`, { note });
      await reload();
      doneToast(`₹ ${money(r.amountPaise)} booked as Cash excess.`, () => apiFull('POST', `/businesses/${biz.id}/cash-excess/${r.id}/undo`, {}), reload);
    } catch (err) { if (b) b.disabled = false; showError(msg, err); }
  };
  document.querySelectorAll('#cashpanel [data-excess]').forEach((b) => b.addEventListener('click', () =>
    bookExcess(Number(b.dataset.excess), b.closest('.form-row')?.querySelector('[data-excessnote]')?.value.trim(), b)));
  document.querySelectorAll('#cashpanel [data-excessundo]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Undo: take the ₹ ${money(Number(b.dataset.amt))} Cash excess out of the books?`)) return;
    b.disabled = true;
    try { await apiFull('POST', `/businesses/${biz.id}/cash-excess/${b.dataset.excessundo}/undo`, {}); reload(); } catch (err) { b.disabled = false; showError(msg, err); }
  }));
  document.getElementById('cashpair')?.addEventListener('click', async (e) => {
    try { await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/cash/pair`, { otherDay: e.currentTarget.dataset.other }); reload(); } catch (err) { showError(msg, err); }
  });
  const form = document.getElementById('cashact');
  if (!form) return;
  let which = 'accept';
  form.querySelectorAll('[data-cashact]').forEach((b) => b.addEventListener('click', () => { which = b.dataset.cashact; }));
  onSubmit(form, async (d) => {
    if (which === 'excess') { await bookExcess(Number(k?.differencePaise ?? 0), d.note.trim(), null); return; }
    if (which === 'shortage' && !confirm('Book this as a cash shortage? It becomes an approved expense from Cash.')) return;
    await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/cash/${which === 'shortage' ? 'shortage' : 'accept'}`, { note: d.note });
    reload();
  });
}

// ---------- Way back from Heads to the expense line that asked for a new head (per browser tab)
const NEW_HEAD_KEY = 'bookr.newHeadFor';
function setNewHeadReturn(v) { try { sessionStorage.setItem(NEW_HEAD_KEY, JSON.stringify({ ...v, at: v.at ?? Date.now() })); } catch { /* storage unavailable */ } }
// A trip left unfinished for more than 30 minutes is forgotten.
function getNewHeadReturn() {
  try { const v = JSON.parse(sessionStorage.getItem(NEW_HEAD_KEY) || 'null'); return v && Date.now() - v.at < 30 * 60e3 ? v : null; } catch { return null; }
}
function clearNewHeadReturn() { try { sessionStorage.removeItem(NEW_HEAD_KEY); } catch { /* storage unavailable */ } }

// ---------- Way back from Review to the difference that opened it (per browser tab)
const BACK_KEY = 'bookr.backTo';
function setBackTo(v) { try { sessionStorage.setItem(BACK_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } }
function getBackTo() { try { return JSON.parse(sessionStorage.getItem(BACK_KEY) || 'null'); } catch { return null; } }
function clearBackTo() { try { sessionStorage.removeItem(BACK_KEY); } catch { /* storage unavailable */ } }
const backButton = () => {
  const b = getBackTo();
  return b ? html`<a class="btn" style="display:inline-flex;align-items:center" href="${b.hash}" id="backto">← Back to ${b.to ?? 'differences'} (${b.label})</a>` : '';
};

// ---------- Compare sales

/** No UPI credit for the side that says UPI, unless a wrong column or a slip explains it. */
const bankNoneOf = (v, c) => (!c.bank && c.bankNone && !(v.columnHints ?? []).some((h) => h.rowId === c.register?.rowId)
  && !(v.slips ?? []).some((x) => slipRows(x).includes(c.register?.rowId)) ? c.bankNone : null);

/** What the bank or the card machine says a bill's decision should be (the same words on All bills and To do):
 *  { suggest, text, toCard } or null. */
function suggestionOf(v, c) {
  const n = bankNoneOf(v, c);
  const m = !c.bank?.suggest && !n ? c.machine : null;
  const suggest = c.bank?.suggest ?? n?.suggest ?? m?.suggest;
  if (!suggest) return null;
  const side = (d) => (d === 'use_software' ? 'the software' : 'the register');
  const text = c.bank?.suggest ? `${c.bank.machine ? 'The card machine' : 'The bank'} got ₹ ${rs(c.bank.amountPaise)} by UPI at ${hhmm(c.bank.postedAt)}: ${side(suggest)} is right.`
    : m?.toCard ? `The card machine got ₹ ${rs(m.amountPaise)} (${m.label}) at ${hhmm(m.paidAt)}, the register's amount: paid by card at the register's amount.`
    : m ? `The card machine got ₹ ${rs(m.amountPaise)} (${m.label}) at ${hhmm(m.paidAt)}: ${side(suggest)} is right.`
    : `No UPI credit of ₹ ${rs(n.upiPaise)} near this bill${n.takenBy ? ` (the one at ${hhmm(n.takenBy.postedAt)} went to bill ${n.takenBy.billNo})` : ''}: it was most likely paid by ${MODE_LABELS[n.mode]?.toLowerCase() ?? n.mode}, as ${side(suggest)} says.`;
  return { suggest, text, toCard: m?.toCard && c.register?.uploadId ? m : null };
}
/** The decision menu of one bill: the same choices on Compare sales and on Reconcile (approved 9 Nov 2026). */
function decideMenuHtml(c, v) {
  // U/N in the software and not in the register (approved 14 Nov 2026): nobody knows how it was paid, so the person says
  // how (a register line is written), or makes it complimentary, or leaves it out with a reason, or carries it forward.
  if (c.difference === 'missing_in_register' && c.software?.mode === 'unknown' && !(c.otherDay && !c.otherDay.closed)) {
    const on = c.decision === 'carry_forward';
    // Paid by ▾, Complimentary, and the rarer two under ⋯ (approved 14 Nov 2026).
    return html`<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${paidByMenu({ comparisonId: c.id, billNo: c.billNo })}
      <button class="btn plain dchip" type="button" data-makecomp="${c.id}" data-bill="${c.billNo}" data-name="${c.software?.name ?? ''}" title="Given free: not counted as a sale. Asks the guest's name.">Complimentary</button>
      <details class="menu"><summary class="btn ${on ? 'ghost' : 'plain'} dchip" aria-label="More for bill ${c.billNo}">${on ? '✓ Carried forward' : '⋯'}</summary><div class="menu-pop" style="min-width:180px;gap:6px">
      <button class="btn plain dchip" type="button" data-leaveunk="${c.id}" data-bill="${c.billNo}">Leave out…</button>
      <button class="btn ${on ? 'ghost' : 'plain'} dchip" data-cmp="${c.id}" data-d="carry_forward" data-type="" data-link="">${on ? '✓ ' : ''}Carry forward</button></div></details></div>`;
  }
  return html`<div style="display:flex;flex-wrap:wrap;gap:6px">${decisionChoices(c).map(([k, l, type, link]) => {
    const on = c.decision === k && (!type || c.billType === type) && (link ?? null) === (c.linkedToId ?? null);
    if (k === 'leave_out' && !link && !c.register && c.software?.mode === 'cash') {
      return html`<select class="cell ${on ? 'auto' : ''}" data-leaveout="${c.id}" aria-label="Leave out because" style="min-height:40px">
        <option value="">${on ? `Left out: ${c.note ?? ''}` : 'Leave out because…'}</option>
        ${(v.reasons ?? []).map((r) => html`<option value="${r}">${r}</option>`)}<option value="__other">Another reason…</option></select>`;
    }
    const none = bankNoneOf(v, c);
    const sugg = !c.decision && (c.bank?.suggest ?? none?.suggest) === k && !type && !link;
    const why = !sugg ? '' : c.bank?.suggest ? `The bank backs this: ₹ ${money(c.bank.amountPaise)} came in at ${hhmm(c.bank.postedAt)}` : `The bank backs this: no UPI credit of ₹ ${money(none.upiPaise)} came in near this bill`;
    return html`<button class="btn ${on ? 'ghost' : 'plain'} dchip ${sugg ? 'sugg' : ''}" style="${on ? 'font-weight:600;background:#E3F1EF' : ''}" data-cmp="${c.id}" data-d="${k}" data-type="${type ?? ''}" data-link="${link ?? ''}" ${sugg ? `title="${why}"` : ''}>${on ? '✓ ' : ''}${l}${sugg ? html` <span class="bank-tag">bank</span>` : ''}</button>`;
  })}<button class="btn plain dchip" type="button" data-makecomp="${c.id}" data-bill="${c.billNo}" data-name="${c.software?.name ?? ''}" title="Given free: not counted as a sale. Asks the guest's name.">Make complimentary</button></div>`;
}

/** Wires every decision menu under root. act(fn) runs a change and reloads; back is where "Check the row" returns to. */
function wireDecideMenu(biz, day, v, root, act, back) {
  root.querySelectorAll('[data-cmp][data-d]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = v.comparisons.find((x) => x.id === b.dataset.cmp);
    if (!c) return;
    if (b.dataset.d === '__review') {
      setBackTo({ hash: back, bill: c.billNo, label: `${dayLabel(day)} shift` });
      location.hash = c.register?.uploadId ? `#/b/${biz.id}/review/${c.register.uploadId}/${c.register.rowId}` : `#/b/${biz.id}/review?day=${day}`;
      return;
    }
    if (b.dataset.d === '__oldpos') {
      act(async () => {
        const r = await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/register-only`, { ids: [c.id], note: c.oldPos?.kind === 'full' || isOldPos(c.billNo) ? OLD_POS_NOTE : SHORT_OLD_POS_NOTE });
        if (r.skipped?.length) throw new Error(`Bill ${c.billNo} was not changed: ${r.skipped[0].reason}.`);
      });
      return;
    }
    let note = null;
    if (b.dataset.d === 'leave_out' && b.dataset.link && c.otherDay?.decision === 'leave_out') {
      note = (prompt(`Bill ${c.billNo} was left out on ${dayLabel(c.otherDay.day)}${c.otherDay.note ? ` (${c.otherDay.note})` : ''} and now appears here. Why leave it out again?`) ?? '').trim();
      if (!note) return;
    } else if (b.dataset.d === 'leave_out' && !b.dataset.link) {
      note = (prompt(`Leave bill ${c.billNo} out of the shift. Why? (e.g. cancelled in POS)`) ?? '').trim();
      if (!note) return;
    }
    act(() => apiFull('PUT', `/businesses/${biz.id}/comparisons/${c.id}`, { decision: b.dataset.d, billType: b.dataset.type || null, note, linkedToId: b.dataset.link || null }));
  }));
  root.querySelectorAll('[data-leaveout]').forEach((sel) => sel.addEventListener('change', () => {
    let note = sel.value;
    if (!note) return;
    if (note === '__other') note = (prompt('Why is this cash bill left out?') ?? '').trim();
    if (!note) { sel.value = ''; return; }
    act(() => apiFull('PUT', `/businesses/${biz.id}/comparisons/${sel.dataset.leaveout}`, { decision: 'leave_out', note }));
  }));
}

/** Compare sales of one shift as parts (approved 10 Nov 2026): the bar, the banners and the bill table with its wiring,
 *  shown on Compare sales and in Reconcile's All bills tab. */
function compareParts(biz, day, v, shifts, { reload, back, onReconcile = false }) {
  const canDecide = biz.actions.includes('sales.decide');
  const confirmed = v.status === 'confirmed';
  const toDecide = v.comparisons.filter((c) => ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'].includes(c.difference));
  const decided = toDecide.filter((c) => c.decision).length;
  // A row that comes to ₹0 under its group's discount is paid with its group, not given free (17 Nov 2026): not counted here.
  const comps = v.comparisons.filter((c) => c.difference === 'complimentary' && !groupZero(c, v));
  const matches = v.comparisons.filter((c) => c.difference === 'match').length;
  const missingHours = Math.round(v.gaps.reduce((s, g) => s + g.to - g.from, 0) / 3600000 * 10) / 10;
  const side = (s) => (s ? html`<div class="mono">${money(s.amountPaise)}</div><div class="note">${MODE_LABELS[s.mode] ?? 'No payment written'}${s.billType ? ` · ${TYPE_LABELS[s.billType]}` : ''}${s.discountPaise > 0 ? ` · after ₹ ${money(s.discountPaise)} discount` : s.discountPaise < 0 ? ` · incl. ₹ ${money(-s.discountPaise)} tip` : ''}</div>` : html`<div class="note">Not found</div>`);
  const shiftOptions = [...new Set([day, ...shifts.map((s) => s.day)])].sort().reverse();
  // Difference: only bills still to decide, so it reads 0 once every difference is decided.
  const totalsRow = (label, sw, rg, open, bold) => html`<tr style="${bold ? 'font-weight:600' : ''}"><td>${label}</td><td class="amount">${money(sw)}</td><td class="amount">${money(rg)}</td><td class="amount" style="color:${open ? '#B45309' : 'var(--muted)'}">${open === 0 ? '0' : `${open > 0 ? '+' : ''}${money(open)}`}</td></tr>`;
  const openTotal = v.totals.reduce((s, t) => s + t.openPaise, 0) + (v.unknownOpenPaise ?? 0);
  const swTotal = v.totals.reduce((s, t) => s + t.softwarePaise, 0) + v.unknownModePaise;
  const rgTotal = v.totals.reduce((s, t) => s + t.registerPaise, 0);
  // Shift order for ‹ and ›: older to the left.
  const asc = [...shiftOptions].reverse();
  const at = asc.indexOf(day);
  const prevDay = at > 0 ? asc[at - 1] : null;
  const nextDay = at >= 0 && at < asc.length - 1 ? asc[at + 1] : null;
  const auto = toDecide.filter((c) => c.decision && c.auto);
  const byPerson = toDecide.filter((c) => c.decision && !c.auto);
  // Bank-backed first, then bills with a credit, then the rest: the puzzles come last.
  const rank = (c) => (c.bank?.suggest ? 0 : c.bank || c.bankNone ? 1 : 2);
  const open = toDecide.filter((c) => !c.decision).sort((a, b) => rank(a) - rank(b));
  const backed = canDecide && !confirmed ? open.filter((c) => c.bank?.suggest) : [];
  // Credits a register slip or a wrong column explains are told on their bill's row, not as money with no bill.
  if (v.bank) v.bank.noBill = v.bank.noBill.filter((x) => !(v.slips ?? []).some((y) => slipCredits(y).includes(x.id))
    && !(v.columnHints ?? []).some((h) => h.creditId === x.id));
  // Credits not matched yet (8 Nov 2026), the count Reconcile shows too: those explained on this page (a slip, a wrong
  // column, a "cash" bill paid by UPI), those with no bill of that amount, and those whose bill of that amount did not pair.
  const notMatched = (() => {
    if (!v.bank?.covered || !v.bank.open?.length) return null;
    const told = new Set([...(v.slips ?? []).flatMap(slipCredits), ...(v.columnHints ?? []).map((h) => h.creditId), ...v.comparisons.filter((c) => c.bankNear).map((c) => c.bankNear.creditId), ...(v.warnings ?? []).filter((w) => w.byUpi).map((w) => w.byUpi.creditId)]);
    const left = v.bank.open.filter((x) => !told.has(x.id));
    return { all: v.bank.open, explained: v.bank.open.filter((x) => told.has(x.id)), noBill: left.filter((x) => x.why === 'no_bill'),
      extra: left.filter((x) => x.why === 'extra'), unpaired: left.filter((x) => x.why === 'unpaired') };
  })();
  const isUpi = (c) => c.software?.mode === 'upi' || c.register?.mode === 'upi';
  // Wrong UPI column (Owner and Accountant only: the server sends no hints to anyone else).
  const colHintOf = (rowIds) => (v.columnHints ?? []).find((h) => rowIds.includes(h.rowId)) ?? null;
  const colChip = (h, cids) => html`<span class="chip wait" style="white-space:normal" title="${colHintText(h)}">Came into ${h.accountName} · ${hhmm(h.postedAt)}</span>
    <button class="btn plain dchip" type="button" data-setcol="${h.paymentId}" title="${colHintText(h)}">Change column to ${h.toLabel}</button>
    ${(confirmed ? h.transactionIds?.length : cids?.length) ? html`<button class="btn plain dchip" type="button" data-asis="${h.paymentId}" data-cids="${(cids ?? []).join(',')}" title="Matches the bill to this credit and keeps the register column as written (${h.fromLabel}), for a guest who paid into the other account.">Match as written</button>` : ''}`;
  const slipChip = (x) => html`<span class="chip wait" style="white-space:normal" title="${slipCard(x, false, day).evidence.slice(0, 2).join(' ')}">${x.partner ? `Bank ₹ ${rs(x.creditPaise)} + ₹ ${rs(x.partner.creditPaise)} fits bills ${x.billNo} + ${x.partner.billNo}` : `Bank ${[x.creditPaise, ...x.others.map((o) => o.amountPaise)].map(rs).join(' + ')} fits if ${slipShort(x)}`}</span>
    <button class="btn plain dchip" type="button" data-slip="${x.key}" title="Changes the register row. Check it against the photo.">Correct the register</button>`;
  // No UPI credit for the side that says UPI (Owner and Accountant only): the other side's mode, unless a wrong column or a slip explains it.
  const noneOf = (c) => (!c.bank && c.bankNone && !colHintOf([c.register?.rowId]) && !(v.slips ?? []).some((x) => slipRows(x).includes(c.register?.rowId)) ? c.bankNone : null);
  const sideName = (d) => (d === 'use_software' ? 'the software' : 'the register');
  // What the bank says about a mode or amount difference, in one line, while it is undecided or decided the other way.
  const bankSays = (c) => {
    const n = noneOf(c);
    const m = !c.bank?.suggest && !n ? c.machine : null;
    const suggest = c.bank?.suggest ?? n?.suggest ?? m?.suggest;
    if (!suggest || c.decision === suggest) return '';
    const text = c.bank?.suggest ? `${c.bank.machine ? 'The card machine' : 'The bank'} got ₹ ${rs(c.bank.amountPaise)} by UPI at ${hhmm(c.bank.postedAt)}: ${sideName(suggest)} is right.`
      : m?.toCard ? `The card machine got ₹ ${rs(m.amountPaise)} (${m.label}) at ${hhmm(m.paidAt)}, the register's amount: paid by card at the register's amount.`
      : m ? `The card machine got ₹ ${rs(m.amountPaise)} (${m.label}) at ${hhmm(m.paidAt)}: ${sideName(suggest)} is right.`
      : `No UPI credit of ₹ ${rs(n.upiPaise)} near this bill${n.takenBy ? ` (the one at ${hhmm(n.takenBy.postedAt)} went to bill ${n.takenBy.billNo})` : ''}: it was most likely paid by ${MODE_LABELS[n.mode]?.toLowerCase() ?? n.mode}, as ${sideName(suggest)} says.`;
    return html`<div class="tiny" style="white-space:normal;max-width:260px;color:${c.decision ? 'var(--warn-ink, #8a5a00)' : 'var(--teal-ink)'}">${c.decision ? '⚠ Decided the other way. ' : ''}${text}</div>${m?.toCard && c.register?.uploadId && biz.actions.includes('sales.decide')
      ? html`<button class="btn plain dchip" type="button" data-machinetocard="${c.id}" title="Changes the register's payment to Card, uses the register, and matches the machine payment when you save. One Undo.">Paid by card ₹ ${rs(m.amountPaise)}: change the register to Card and use it</button>` : ''}`;
  };
  const bankChip = (c) => {
    // The card machine's payment, for a card-or-not difference (approved 9 Nov 2026).
    if (c.machine && !c.bank) return html`<span class="chip ok" title="The card report has a payment of ₹ ${money(c.machine.amountPaise)} (${c.machine.label}) at ${when(c.machine.paidAt)}, ${c.machine.minutes} min from the bill. It is matched to the card sale after confirming.">Machine ₹ ${rs(c.machine.amountPaise)} · ${hhmm(c.machine.paidAt)}${c.machine.upi ? ' · UPI' : ''}</span>`;
    if (!v.bank || (!isUpi(c) && !c.bank)) return '';
    if (c.bank?.parts) {
      return html`<span class="chip ok" title="${c.bank.split ? `One payment of ₹ ${money(c.bank.amountPaise)}, paid in ${c.bank.parts.length} goes (e.g. a UPI app limit)` : 'One unmatched UPI credit for each UPI payment written for this bill'}: ${c.bank.parts.map((p) => `₹ ${money(p.amountPaise)} at ${when(p.postedAt)}`).join(', ')}. Confirming matches ${c.bank.split ? 'them to the payment' : 'each to its payment'}.">Bank ${c.bank.parts.map((p) => `₹ ${rs(p.amountPaise)}`).join(' + ')} · ${hhmm(c.bank.parts[0].postedAt)}–${hhmm(c.bank.parts[c.bank.parts.length - 1].postedAt)}</span>`;
    }
    // UPI paid on the card machine (approved 9 Nov 2026): it comes in the machine's settlement, not as its own credit.
    if (c.bank?.machine && !c.bank.parts) {
      return html`<span class="chip ok" title="The card report has a UPI payment of ₹ ${money(c.bank.amountPaise)} on the card machine (${c.bank.machine.label}) at ${when(c.bank.postedAt)}${c.bank.minutes != null ? `, ${c.bank.minutes} min from the bill` : ''}. It reaches the bank in the machine's settlement of ${dayLabel(c.bank.machine.settledOn)}. Saving matches it to this bill, which stays UPI.">UPI on machine ₹ ${rs(c.bank.amountPaise)} · ${hhmm(c.bank.postedAt)} · settles ${dayLabel(c.bank.machine.settledOn)}</span>`;
    }
    if (c.bank) {
      const fits = c.bank.fits === 'both' ? 'both sides' : c.bank.fits === 'software' ? 'the software' : 'the register';
      return html`<span class="chip ok" title="An unmatched UPI credit of ₹ ${money(c.bank.amountPaise)} came in at ${when(c.bank.postedAt)}. It equals ${fits}.${c.bank.byNote ? ' Its UPI note names this bill.' : ''}${c.bank.minutes > 60 ? ' It came in well before the bill was closed, and it is the only credit of this amount in the two hours before.' : ''} Confirming matches it to this bill.">Bank ₹ ${rs(c.bank.amountPaise)} · ${hhmm(c.bank.postedAt)}${c.bank.minutes != null ? ` · ${c.bank.minutes} min` : ''}${c.bank.byNote ? ' · note names the bill' : ''}</span>`;
    }
    // Within ₹10 of one side (Stage 6, 10 Nov 2026): a tip or a discount, the person chooses which side.
    if (c.bankNear && !confirmed) {
      const n = c.bankNear;
      const off = (d) => (d > 0 ? `+ ₹ ${money(d)} tip` : `− ₹ ${money(-d)} discount`);
      const dr = n.amountPaise - (c.register.paidPaise || c.register.amountPaise);
      const ds = n.amountPaise - c.software.amountPaise;
      return html`<span class="chip wait" style="white-space:normal" title="₹ ${money(n.amountPaise)} came in at ${when(n.postedAt)}, ${n.minutes} min from the bill: equal to neither side, within ₹ 10 of one.">Bank ₹ ${money(n.amountPaise)} · ${hhmm(n.postedAt)}</span>
        ${canDecide ? html`<button class="btn plain dchip" type="button" data-near="${c.id}" data-side="use_register" title="The register's bill stands; the guest paid ₹ ${money(n.amountPaise)}. The register's UPI payment becomes the credit, and the credit is matched on save.">Use register ${off(dr)}</button>
        <button class="btn plain dchip" type="button" data-near="${c.id}" data-side="use_software" title="The software's bill stands; the guest paid ₹ ${money(n.amountPaise)}. The register row takes the software amount and the credit, and the credit is matched on save.">Use software ${off(ds)}</button>` : ''}`;
    }
    const h = colHintOf([c.register?.rowId]);
    if (h) return colChip(h, [c.id]);
    const sl = (v.slips ?? []).find((x) => slipRows(x).includes(c.register?.rowId));
    if (sl) return slipChip(sl);
    const n = noneOf(c);
    if (n) return html`<span class="chip" title="The bank is in for this shift and no unmatched UPI credit of ₹ ${money(n.upiPaise)} came in within an hour of this bill${n.takenBy ? `; the one at ${when(n.takenBy.postedAt)} went to bill ${n.takenBy.billNo}` : ''}.">No UPI ₹ ${rs(n.upiPaise)} in the bank</span>`;
    return v.bank.covered ? html`<span class="chip" title="No unmatched UPI credit of this amount near the bill.">No bank credit</span>`
      : html`<span class="chip" title="The bank statement does not reach the end of this shift yet.">Bank not in yet</span>`;
  };
  // What confirming will do with the bank.
  const counted = v.comparisons.filter((c) => c.difference === 'match' || c.decision === 'use_software' || c.decision === 'use_register');
  const upiSide = (c) => (c.decision === 'use_software' ? c.software : c.decision === 'use_register' || c.difference === 'match' ? c.register : null);
  const countedUpi = counted.filter((c) => upiSide(c)?.mode === 'upi');
  // A bill paid together is matched with its group when the group's one credit came in, as on Reconcile.
  const groupPaid = new Set((v.paidGroups ?? []).filter((g) => g.bank).flatMap((g) => g.billNos));
  const matchNow = countedUpi.filter((c) => groupPaid.has(c.billNo) || (c.bank && (c.bank.fits === 'both' || (c.bank.fits === 'software') === (c.decision === 'use_software'))));
  const kinds = [['all', 'All', open], ['sw', 'Only in software', open.filter((c) => c.difference === 'missing_in_register')],
    ['rg', 'Only in register', open.filter((c) => c.difference === 'missing_in_software')], ['diff', 'Amount or mode', open.filter((c) => !c.difference.startsWith('missing'))],
    ['match', 'Matched', v.comparisons.filter((c) => c.difference === 'match')]];
  const matched = kinds[4][2];
  const onCredit = toDecide.filter((c) => c.difference.startsWith('missing') && (c.decision === 'use_software' || c.decision === 'use_register') && !c.linkedToId
    && (c.software?.mode ?? c.register?.mode) === 'upi');
  const onCreditPaise = onCredit.reduce((t, c) => t + ((c.software ?? c.register)?.amountPaise ?? 0), 0);
  const total = Math.max(1, matches + toDecide.length);
  const seg = (n, cls, label) => (n ? html`<span class="pg ${cls}" style="flex:${n}" title="${label}: ${n}"></span>` : '');
  const status = confirmed ? html`<span class="chip ok">Confirmed</span>` : v.status === 'comparing' ? html`<span class="chip wait">Comparing</span>` : html`<span class="chip">Open</span>`;
  const rowHtml = (c, inGroup = '', closed = false) => html`<tr ${inGroup ? html`data-group="${inGroup}"` : ''} ${closed ? 'hidden' : ''} data-bill="${c.billNo}" data-open="${c.register?.uploadId ? `#/b/${biz.id}/review/${c.register.uploadId}/${c.register.rowId}` : `#/b/${biz.id}/review?find=${c.billNo.slice(-4)}`}"
      class="clickrow ${c.decision || c.difference === 'match' ? '' : 'undecided'} ${inGroup ? 'grp-bill' : ''}" data-kind="${c.difference === 'match' ? 'match' : c.difference === 'missing_in_register' ? 'sw' : c.difference === 'missing_in_software' ? 'rg' : 'diff'}" title="${c.register ? 'Open this bill in its register page' : 'Look for this bill on the register pages'}">
    <td class="mono">${bulkOk(c) && !c.decision ? html`<input type="checkbox" data-bulk="${c.id}" aria-label="Select bill ${c.billNo}" style="width:18px;height:18px;min-height:0;margin-right:6px;vertical-align:middle">` : ''}<a href="#" data-openlink>${c.billNo}</a>${drawerBtn(c.billNo, day)}
      <div class="tiny">${c.paidAt ? when(c.paidAt) : 'Not in report'}</div>${otherDayNote(c)}${confirmedByNote(c)}
      ${(c.numberFlags ?? []).map((f) => html`<div class="tiny error">${numberFlagText(f)}</div>`)}
      ${(v.numberSlips ?? []).filter((x) => x.billNo === c.billNo && !c.register).map((x) => html`<div class="tiny error">Probably the register line written as ${x.writtenAs} (₹ ${rs(x.amountPaise)}): same amount, one digit apart. Correct its number on the row.</div>`)}
      ${!c.software && c.oldPos?.kind === 'short' ? html`<div class="tiny">Old POS bill, last 3 digits${c.oldPos.fullNo ? html`: probably <span class="mono">${c.oldPos.fullNo}</span>` : ''}. No new POS bill with running number ${c.billNo} is waiting in the software report.</div>`
        : !c.software && isOddBill(c.billNo) ? html`<div class="tiny error">Number fits neither format, so it can never match. Open the row to correct it.</div>` : ''}
      ${!c.software && !c.decision && isOldPos(c.billNo) ? html`<div class="tiny">Old POS bill. ${c.register?.reviewed ? 'Row reviewed: you can use the register.' : 'Review its row, then use the register.'}</div>` : ''}</td>
    <td>${side(c.software)}</td><td>${side(c.register)}</td>
    <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
      ${c.difference === 'match' ? (c.software?.amountPaise !== c.register?.amountPaise ? html`<span class="chip wait" title="The group matches on its total. This bill's own figures differ.">This bill differs by ₹ ${rs(Math.abs((c.software?.amountPaise ?? 0) - (c.register?.amountPaise ?? 0)))}</span>` : html`<span class="chip ok">Same</span>`)
        : groupZero(c, v) ? html`<span class="chip" title="This row pays for bills ${groupZero(c, v).billNos.join(', ')}, and the group's discount brings it to ₹0. It is paid with its group, not complimentary.">₹0 after the group's discount</span>`
        : html`<span class="chip ${c.difference.startsWith('missing') ? 'bad' : 'wait'}">${DIFF_LABELS[c.difference]}</span>`}
      ${c.auto ? html`<span class="tiny" style="color:var(--teal-ink)">Decided by Bookr${c.note ? `: ${c.note}` : ''}</span>` : ''}
      ${confirmed ? '' : html`${bankChip(c)}${bankSays(c)}`}${c.reissuedAs && !c.decision ? html`<div class="tiny" style="white-space:normal;max-width:260px;color:var(--teal-ink)">Looks issued again as bill ${c.reissuedAs} (same amount, minutes later, in the register). If so, leave this one out.</div>` : ''}
    </div></td>
    <td>${c.difference === 'match' ? html`<span class="note">No decision needed</span>` : canDecide && !confirmed ? decideMenuHtml(c, v)
      : html`<span class="note">${c.decision ? `${DECISION_LABELS[c.decision]}${c.billType ? ` · ${TYPE_LABELS[c.billType]}` : ''}${c.note ? `: ${c.note}` : ''}` : 'Not decided'}</span>`}</td>
  </tr>`;
  // Bills paid together: one line with the totals, each bill underneath when opened.
  const groupOf = (c) => v.paidGroups.find((g) => g.id === c.groupId);
  const groupRow = (g, members) => html`<tr class="grp-head" data-grouphead="${g.id}" tabindex="0" aria-expanded="false">
    <td><strong>Group of ${g.billNos.length} bills</strong><div class="tiny mono" style="white-space:normal">${g.billNos.join(' + ')}</div>${members.length < g.billNos.length ? html`<div class="tiny">${members.length} of them in this list</div>` : ''}</td>
    <td><div class="mono">${money(g.softwarePaise)}</div></td>
    <td><div class="mono">${money(g.paidPaise)}</div><div class="note">${g.modes.map((m) => MODE_LABELS[m] ?? m).join(' + ') || 'No payment written'}${g.grossPaise > g.paidPaise ? ` · after ₹ ${money(g.grossPaise - g.paidPaise)} discount` : g.grossPaise < g.paidPaise ? ` · incl. ₹ ${money(g.paidPaise - g.grossPaise)} tip` : ''}</div></td>
    <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">${g.matched ? html`<span class="chip ok">Total matches</span>`
        : members.every((x) => x.decision) ? html`<span class="chip ok">Decided</span><span class="tiny" style="white-space:normal">${g.why}</span>`
        : html`<span class="chip wait" style="white-space:normal">${g.why}</span>`}
      ${confirmed || !v.bank || !g.upiPaise ? '' : g.bank ? html`<span class="chip ok" title="An unmatched UPI credit of ₹ ${money(g.bank.amountPaise)} came in at ${when(g.bank.postedAt)}. It equals this group's UPI total. Confirming the shift matches it to the group's bills.">Bank ₹ ${rs(g.bank.amountPaise)} · ${hhmm(g.bank.postedAt)}</span>`
        : colHintOf([g.id]) ? colChip(colHintOf([g.id]), members.map((x) => x.id))
        : v.bank.covered ? html`<span class="chip" title="No unmatched UPI credit in this shift equals this group's UPI total.">No bank credit</span>`
        : html`<span class="chip" title="The bank statement does not reach the end of this shift yet.">Bank not in yet</span>`}</div></td>
    <td class="note">${g.matched ? 'No decision needed. Open to see each bill.' : members.every((x) => x.decision) ? (() => {
      // What was decided for the bills on this line, e.g. "Use register: Old POS bill (4)".
      const said = new Map();
      for (const x of members) { const k = `${DECISION_LABELS[x.decision]}${x.note ? `: ${x.note}` : ''}`; said.set(k, (said.get(k) ?? 0) + 1); }
      return `${[...said].map(([k, n]) => `${k} (${n})`).join(' · ')}. Open to see each bill.`;
    })() : (() => {
      // Bills no software report will ever have: one button for the group. New POS numbers and rows not reviewed stay with the person.
      const can = canDecide && !confirmed ? members.filter((x) => bulkOk(x) && !x.decision) : [];
      const rest = members.filter((x) => !x.decision).length - can.length;
      return can.length ? html`<button class="btn plain dchip" type="button" data-groupreg="${g.id}">Use register for ${can.length} bill${can.length > 1 ? 's' : ''}</button>${rest ? html`<div class="tiny">${rest} more to decide inside</div>` : ''}` : 'Open to see each bill and decide.';
    })()}</td></tr>`;
  const table = (rows) => html`<div class="scroll"><table class="cmptable" style="min-width:820px">
    <colgroup><col style="width:190px"><col style="width:150px"><col style="width:150px"><col style="width:150px"><col></colgroup>
    <thead><tr><th>Bill</th><th>Software</th><th>Register</th><th>What differs</th><th>Decision</th></tr></thead>
    <tbody>${rows.flatMap((c, i) => {
      if (!c.groupId) return [rowHtml(c)];
      if (rows.findIndex((x) => x.groupId === c.groupId) !== i) return [];
      const members = rows.filter((x) => x.groupId === c.groupId);
      return [groupRow(groupOf(c), members), ...members.map((x) => rowHtml(x, c.groupId, true))];
    })}</tbody></table></div>`;
  const reportsHtml = html`          ${v.reports.map((r) => html`<div class="note">Report ${when(r.coversFrom)} to ${when(r.coversTo)}${confirmed || !biz.actions.includes('sales.import') ? '' : html` · <a href="#" data-cover="${r.id}" data-from="${r.coversFrom}" data-to="${r.coversTo}">Change</a>`}</div>`)}
          ${biz.actions.includes('sales.import') ? html`<a href="#/b/${biz.id}/bringin/${day}">Bring in a report</a>` : ''}
          ${biz.actions.includes('rows.edit') ? html`<a href="#/b/${biz.id}/review">Open register pages</a>` : ''}`;
  const warningsHtml = html`${(v.warnings ?? []).map((w) => cashWarnHtml(w, v, confirmed || !canDecide))}`;
  const conflictsHtml = html`${v.conflicts.length ? html`<section class="card">
        <h2>Bills with two different lines in the software</h2>
        <div class="note">The same bill number came in twice with different values: in two reports, or twice in one file. Nothing was overwritten, and only one is counted. Choose which to keep.</div>
        <div class="scroll"><table style="min-width:640px"><thead><tr><th>Bill</th><th>Already imported (first line)</th><th>New file (second line)</th><th></th></tr></thead><tbody>
          ${v.conflicts.map((k) => html`<tr><td class="mono">${k.billNo}</td>
            <td><div class="mono">${money(k.existing.amountPaise)}</div><div class="note">${MODE_LABELS[k.existing.mode]} · ${when(k.existing.paidAt)}</div></td>
            <td><div class="mono">${money(k.incoming.amountPaise)}</div><div class="note">${MODE_LABELS[k.incoming.mode]} · ${when(k.incoming.paidAt)}</div></td>
            <td>${canDecide ? html`<div class="form-row"><button class="btn plain" data-conflict="${k.id}" data-d="keep_existing">${k.sameFile ? 'Keep first line' : 'Keep imported'}</button><button class="btn plain" data-conflict="${k.id}" data-d="use_incoming">${k.sameFile ? 'Keep second line' : 'Use new file'}</button></div>` : ''}</td></tr>`)}
        </tbody></table></div></section>` : ''}`;
  const reopenHtml = html`${biz.role === 'owner' ? html`<form id="reopen" class="inset"><div class="field"><label for="rr">Reopen this shift: reason</label><input id="rr" name="reason" required></div><div class="form-msg"></div><button class="btn danger" type="submit" style="align-self:flex-start">Reopen shift</button></form>` : html`<div class="note">Only an Owner can reopen a confirmed shift.</div>`}`;
  // The Shift menu on Reconcile: the report's covered times, and reopening a saved shift (Owner).
  const shiftMenu = html`<details class="menu" id="shiftmenu"><summary class="btn plain" style="display:inline-flex;align-items:center" aria-label="More for this shift">⋯</summary><div class="menu-pop" style="min-width:320px;gap:8px">
    ${onReconcile ? html`<a href="#/b/${biz.id}/reconcile/all">All unmatched, every shift ›</a>` : ''}
    ${reportsHtml}<div id="coveredit"></div>
    ${confirmed ? reopenHtml : v.reopenedAt ? html`<div class="note">Reopened ${when(v.reopenedAt)}: ${v.reopenReason}</div>` : ''}</div></details>`;
  const bar = html`    <section class="card cmp-bar">
      <div class="cmp-top">
        <div class="cmp-day">
          ${status}
        </div>
        ${canDecide && !confirmed && !onReconcile ? html`<a class="btn" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/reconcile/${day}" title="The shift is saved on Reconcile">Save on Reconcile ›</a>` : ''}
      </div>
      <div class="cmp-inputs">
        <span class="tchip ${v.gaps.length ? 'warn' : 'ok'}">Software · ${v.softwareBills} bills${v.gaps.length ? ` · ${missingHours} h missing` : ' · 8 am to 8 am'}</span>
        <span class="tchip ${v.registerRows ? 'ok' : 'warn'}">Register · ${v.registerPages} page${v.registerPages === 1 ? '' : 's'}, ${v.registerRows} bills</span>
        ${comps.length ? html`<span class="tchip">${comps.length} complimentary</span>` : ''}
        ${v.bank ? html`<span class="tchip ${v.bank.covered ? 'ok' : 'warn'}" title="${v.bank.lastBankAt ? `Latest UPI line in Bookr: ${when(v.bank.lastBankAt)}` : 'No UPI bank lines in Bookr yet'}">${v.bank.covered ? 'Bank in' : v.bank.lastBankAt ? `Bank up to ${when(v.bank.lastBankAt)}` : 'Bank not in yet'}</span>` : ''}
        ${onReconcile ? '' : html`<details class="menu"><summary class="linkbtn">Details</summary><div class="menu-pop" style="min-width:300px">${reportsHtml}</div></details>`}
      </div>
      <div class="cmp-progress" aria-label="Bills of this shift">
        <div class="pgbar">${seg(matches, 'm', 'Match')}${seg(auto.length, 'a', 'Decided by Bookr')}${seg(byPerson.length, 'd', 'Decided')}${seg(open.length, 'o', 'To decide')}</div>
        <div class="tiny">${matches} match · ${auto.length} by Bookr · ${byPerson.length} decided · <strong>${open.length} to decide</strong>${onCredit.length ? ` · ${onCredit.length} UPI on one side (₹ ${rs(onCreditPaise)}) counted when the bank credit arrives` : ''}</div>
      </div>
      ${onReconcile ? '' : html`<div id="coveredit"></div>`}
    </section>`;
  const banners = html`    ${v.gaps.map((g) => html`<div class="demo-band">Missing ${when(g.from)} to ${when(g.to)}. Upload the report for those hours, or correct a report's covered period.</div>`)}
    ${onReconcile ? '' : warningsHtml}
    ${auto.some((c) => c.numberFlags?.length) ? html`<div class="cmp-warn">⚠ ${blockerHtml(`Bookr counted these before their numbers looked wrong. Check them under Decided by Bookr: ${auto.filter((c) => c.numberFlags?.length).map((c) => c.billNo).join(', ')}.`, v)}</div>` : ''}`;
  const shiftPane = html`      ${onReconcile ? '' : conflictsHtml}
      <section class="card" style="gap:10px">
        <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px"><h2 id="decidehead">To decide (${open.length})</h2>
          ${backed.length ? html`<button class="btn" type="button" id="acceptbank" title="Each choice marked 'bank' is the side the bank credit agrees with">Accept ${backed.length} bank-backed choice${backed.length > 1 ? 's' : ''}</button>` : ''}
          ${open.length || matched.length ? html`<span class="seg" role="group" aria-label="Show">${kinds.map(([k, l, list]) => list.length || k === 'all' ? html`<button type="button" data-kind="${k}" class="${k === 'all' ? 'on' : ''}">${l} (${list.length})</button>` : '')}</span>` : ''}</div>
        ${v.matchedAfterAdjustment?.length ? html`<div class="note">${v.matchedAfterAdjustment.length} bill${v.matchedAfterAdjustment.length > 1 ? 's match' : ' matches'} after a discount or tip, so no decision is needed: ${v.matchedAfterAdjustment.map((m) => m.billNo).join(', ')}.</div>` : ''}
        ${canDecide && !confirmed && open.filter(bulkOk).length > 1 ? html`<form id="bulkreg" class="inset" style="gap:8px">
          <div class="note"><strong>${open.filter(bulkOk).length} bills are only in the register.</strong> Tick bills that will never be in a software report and count them from the register at once.${oldPosState(v.oldPos)}</div>
          <div class="form-row" style="align-items:flex-end">
            <button class="btn plain" type="button" id="bulkall">Select all ${open.filter(bulkOk).length}</button>
            ${open.some((c) => bulkOk(c) && c.oldPos) ? html`<button class="btn plain" type="button" id="bulkold">Select ${open.filter((c) => bulkOk(c) && c.oldPos).length} reviewed old POS</button>` : ''}
            <div class="field"><label for="bulknote">Reason</label><input id="bulknote" name="note" value="Old POS bill" required></div>
            <button class="btn" type="submit" id="bulkgo" disabled>Use register for 0 selected</button>
          </div>
          <div class="form-msg"></div>
        </form>` : ''}
        ${open.length ? '' : html`<div class="ok-msg" id="nonemsg">${toDecide.length ? 'Every difference is decided.' : 'No differences in this shift.'}</div>`}
        ${open.length || matched.length ? table([...open, ...matched]) : ''}
      </section>
      ${auto.length ? html`<details class="card cmp-fold"><summary><h2>Decided by Bookr (${auto.length})</h2><span class="note">Bills on one side only: counted and waiting for their other side, or already counted on another day. Change any of them below.</span></summary>${table(auto)}</details>` : ''}
      ${byPerson.length ? html`<details class="card cmp-fold"><summary><h2>Decided (${byPerson.length})</h2></summary>${table(byPerson)}</details>` : ''}
      <div class="row">
        <section class="card" style="flex:2 1 320px;gap:10px" id="nextstep">
          <h2>${confirmed ? 'Saved' : 'Before saving'}</h2>
          ${confirmed ? html`
            <div class="ok-msg">Confirmed ${when(v.confirmedAt)}. UPI sales now wait for their bank credit${onCredit.length ? '; bills found on one side only count on the day their credit arrives' : ''}.</div>
            ${onReconcile ? html`<div class="note">${biz.role === 'owner' ? 'To reopen it, use the Shift menu at the top.' : 'Only an Owner can reopen a saved shift.'}</div>` : reopenHtml}`
          : html`
            ${v.reopenedAt ? html`<div class="note">Reopened ${when(v.reopenedAt)}: ${v.reopenReason}</div>` : ''}
            ${v.blockers.length ? html`<ul class="note" style="margin:0;padding-left:18px">${v.blockers.map((b) => html`<li>${blockerHtml(b, v)}</li>`)}</ul>` : html`<div class="ok-msg">Everything is decided. Save the shift on Reconcile.</div>`}
            ${v.assumedTypes?.length ? html`<div class="note" style="background:#FFFBEB;padding:8px 10px;border-radius:6px">${v.assumedTypes.length} bill${v.assumedTypes.length > 1 ? 's were' : ' was'} taken as <strong>F&amp;B</strong> because the register's type could not be read: ${blockerHtml(v.assumedTypes.join(', '), v)}.</div>` : ''}
            ${v.bank && countedUpi.length ? html`<div class="note"><strong>On confirming:</strong> ${matchNow.length} of ${countedUpi.length} UPI bill${countedUpi.length > 1 ? 's' : ''} ${matchNow.length === 1 ? 'is' : 'are'} matched to ${matchNow.length === 1 ? 'its' : 'their'} bank credit at once${countedUpi.length - matchNow.length ? `; ${countedUpi.length - matchNow.length} wait${countedUpi.length - matchNow.length === 1 ? 's' : ''} for ${countedUpi.length - matchNow.length === 1 ? 'its' : 'their'} credit on Reconcile` : ''}. Unmatch undoes any of them.</div>` : ''}
            <div class="note">Only Owner and Accountant can decide differences and confirm. The bank credit does not have to arrive first.</div>`}
        </section>
        <section class="card" style="flex:3 1 420px;gap:10px">
          <h2>Totals by payment mode</h2>
          <div class="scroll"><table style="min-width:380px"><thead><tr><th>Mode</th><th style="text-align:right">Software</th><th style="text-align:right">Register</th><th style="text-align:right" title="Bills not decided yet">Difference</th></tr></thead><tbody>
            ${v.totals.map((t) => totalsRow(MODE_LABELS[t.mode], t.softwarePaise, t.registerPaise, t.openPaise))}
            ${v.unknownModePaise ? totalsRow('U/N (not given)', v.unknownModePaise, 0, v.unknownOpenPaise ?? 0) : ''}
            ${totalsRow('Total', swTotal, rgTotal, openTotal, true)}
          </tbody></table></div>
          <div class="note">Difference counts only bills not decided yet${openTotal ? '' : ': every difference is decided'}. Software and Register are the full reports as they stand.</div>
          <div class="note">Complimentary bills (amount 0) are never counted as sales${comps.length ? `: ${comps.map((c) => c.billNo).join(', ')}` : ''}.</div>
        </section>
      </div>`;
  const wire = (root, msg) => {
  const act = async (fn) => { try { await fn(); await reload(); } catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  wireDecideMenu(biz, day, v, root, act, back);
  root.querySelectorAll('[data-groupreg]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const bills = v.comparisons.filter((c) => c.groupId === b.dataset.groupreg && bulkOk(c) && !c.decision);
    if (!confirm(`Count ${bills.length} bill${bills.length > 1 ? 's' : ''} from the register: ${bills.map((c) => c.billNo).join(', ')}? No software bill will be expected for them.`)) return;
    act(async () => {
      const skipped = [];
      for (const [note, ids] of [[OLD_POS_NOTE, bills.filter((c) => isOldPos(c.billNo))], [SHORT_OLD_POS_NOTE, bills.filter((c) => !isOldPos(c.billNo))]]) {
        if (ids.length) skipped.push(...(await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/register-only`, { ids: ids.map((c) => c.id), note })).skipped);
      }
      if (skipped.length) throw new Error(`Not changed: ${skipped.map((x) => `bill ${x.billNo}, ${x.reason}`).join('; ')}.`);
    });
  }));
  // Paid by card at the register's amount (17 Nov 2026): the register's payment becomes Card and the register is used.
  root.querySelectorAll('[data-machinetocard]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = v.comparisons.find((x) => x.id === b.dataset.machinetocard);
    const m = c?.machine;
    if (!m?.toCard) return;
    paidOnCardClick(biz, day, { payment: { id: m.toCard.paymentId, amountPaise: m.amountPaise, paidAt: m.paidAt, upi: m.upi },
      written: { comparisonId: c.id, billNo: c.billNo, mode: c.register.mode, amountPaise: m.amountPaise, rowId: c.register.rowId, uploadId: c.register.uploadId } }, b, reload);
  }));
  root.querySelectorAll('[data-slip]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const x = v.slips.find((y) => y.key === b.dataset.slip);
    try {
      const undo = await applySlip(biz, { slip: x, confirmed: false, day });
      await reload();
      doneToast(`Bill ${x.billNo}${x.partner ? ` and ${x.partner.billNo}` : ''}: register corrected (${slipShort(x)}).`, undo, reload);
    } catch (err) { b.disabled = false; showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }));
  // A credit within ₹10 of one side: the register row is written with the credit (tip or discount), the side decided,
  // and the credit matched on save. One Undo puts all three back.
  root.querySelectorAll('[data-near]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const c = v.comparisons.find((x) => x.id === b.dataset.near);
    const n = c.bankNear;
    const side = b.dataset.side;
    const base = `/businesses/${biz.id}`;
    const undos = [];
    try {
      undos.push(await writeBankOnRow(biz, { uploadId: c.register.uploadId, rowId: c.register.rowId, billNo: c.billNo }, [{ id: n.creditId, amountPaise: n.amountPaise, label: n.label }],
        side === 'use_software' ? { amountPaise: c.software.amountPaise } : {}));
      const d = n.amountPaise - (side === 'use_software' ? c.software.amountPaise : (c.register.amountPaise));
      const note = `Bank ₹ ${money(n.amountPaise)} at ${hhmm(n.postedAt)}: ${d > 0 ? `₹ ${money(d)} tip` : d < 0 ? `₹ ${money(-d)} discount` : 'paid in full'}`;
      const now2 = (await api('GET', `${base}/shifts/${day}`)).comparisons.find((x) => x.id === c.id);
      if (now2 && now2.difference !== 'match') {
        await apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: side, note });
        undos.push(() => apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: null }));
      }
      const r = await apiFull('POST', `${base}/shifts/${day}/choices`, { bankRowId: n.creditId, comparisonIds: [c.id] });
      undos.push(() => apiFull('DELETE', `${base}/shifts/${day}/choices/${r.id}`, {}));
      await reload();
      doneToast(`Bill ${c.billNo}: ${note}; matched on save.`, async () => { for (const u of undos.reverse()) await u(); }, reload);
    } catch (err) {
      for (const u of undos.reverse()) await u().catch(() => {});
      b.disabled = false; showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }));
  // Match as written (approved 10 Nov 2026): the guest paid into the other account; the column stays as the register has it.
  root.querySelectorAll('[data-asis]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const h = v.columnHints.find((x) => x.paymentId === b.dataset.asis);
    const base = `/businesses/${biz.id}`;
    try {
      if (confirmed) {
        await apiFull('POST', `${base}/bank-rows/${h.creditId}/match`, { transactionIds: h.transactionIds });
        await reload();
        doneToast(`Bill ${h.billNo ?? ''}: matched to the ${h.accountName} credit, column kept as ${h.fromLabel}.`, async () => apiFull('DELETE', `${base}/bank-rows/${h.creditId}/match`, {}), reload);
      } else {
        const r = await apiFull('POST', `${base}/shifts/${day}/choices`, { bankRowId: h.creditId, comparisonIds: b.dataset.cids.split(',').filter(Boolean) });
        await reload();
        doneToast(`Bill ${h.billNo ?? ''}: matched on save to the ${h.accountName} credit, column kept as ${h.fromLabel}.`, async () => apiFull('DELETE', `${base}/shifts/${day}/choices/${r.id}`, {}), reload);
      }
    } catch (err) { b.disabled = false; showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }));
  root.querySelectorAll('[data-setcol]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const h = v.columnHints.find((x) => x.paymentId === b.dataset.setcol);
    try {
      const undo = await setColumn(biz, { hint: h, match: false });
      await reload();
      doneToast(`Bill ${h.billNo ?? ''}: column changed to ${h.toLabel}.`, undo, reload);
    } catch (err) { b.disabled = false; showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }));
  // A difference opens its bill in Review; Review offers a way back to this bill here.
  root.querySelectorAll('tr.clickrow').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button, select, input')) return;
    e.preventDefault();
    // The bill opens beside the list (its sides, the photo of its register line, and the row to correct), not on Review.
    openBillDrawer(biz, tr.dataset.bill, day);
  }));
  // A group line opens and closes its bills. The list's filter applies inside an open group too.
  const showGroups = (root) => root.querySelectorAll('tr[data-grouphead]').forEach((head) => {
    const bills = [...root.querySelectorAll(`tr[data-group="${head.dataset.grouphead}"]`)];
    const kind = root.querySelector('button[data-kind].on')?.dataset.kind ?? 'all';
    const fits = (tr) => (kind === 'all' ? tr.dataset.kind !== 'match' : tr.dataset.kind === kind);
    head.hidden = !bills.some(fits);
    for (const tr of bills) tr.hidden = !head.classList.contains('open') || !fits(tr);
    head.setAttribute('aria-expanded', head.classList.contains('open') ? 'true' : 'false');
  });
  // To decide lists every difference; Matched lists the bills that need nothing, in the same table.
  const showKind = (list, kind) => {
    list.querySelectorAll('tbody tr[data-kind]:not([data-group])').forEach((tr) => { tr.hidden = kind === 'all' ? tr.dataset.kind === 'match' : tr.dataset.kind !== kind; });
    showGroups(list);
    const head = document.getElementById('decidehead');
    if (head) head.textContent = kind === 'match' ? `Matched (${matched.length})` : `To decide (${open.length})`;
    const none = document.getElementById('nonemsg');
    if (none) none.hidden = kind === 'match';
  };
  const decideList = document.getElementById('decidehead')?.closest('section');
  if (decideList) showKind(decideList, 'all');
  const openGroupOf = (row) => {
    if (!row.dataset.group) return;
    row.closest('details')?.setAttribute('open', '');
    const root = row.closest('section, details');
    root.querySelector(`tr[data-grouphead="${row.dataset.group}"]`)?.classList.add('open');
    showGroups(root);
  };
  root.querySelectorAll('tr[data-grouphead]').forEach((head) => {
    const flip = () => { head.classList.toggle('open'); showGroups(head.closest('section, details')); };
    head.addEventListener('click', flip);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  });
  // A matched bill is shown on the Matched tab.
  const reveal = (row) => {
    if (row.dataset.kind === 'match' && decideList?.contains(row)) root.querySelector('button[data-kind="match"]')?.click();
    openGroupOf(row);
  };
  const backTo = getBackTo();
  if (backTo?.bill && backTo.hash === back) {
    clearBackTo();
    const row = root.querySelector(`tr[data-bill="${CSS.escape(backTo.bill)}"]`);
    if (row) reveal(row);
    if (row) { row.classList.add('row-found'); row.scrollIntoView({ block: 'center' }); }
  }
  const bulk = document.getElementById('bulkreg');
  if (bulk) {
    const boxes = () => [...root.querySelectorAll('[data-bulk]')];
    const count = () => {
      const n = boxes().filter((x) => x.checked).length;
      const go = document.getElementById('bulkgo');
      go.disabled = !n;
      go.textContent = `Use register for ${n} selected`;
      // Nothing ticked stays out of sight inside a closed group.
      boxes().filter((x) => x.checked).forEach((x) => openGroupOf(x.closest('tr')));
    };
    boxes().forEach((x) => x.addEventListener('change', count));
    document.getElementById('bulkold')?.addEventListener('click', () => {
      const old = new Set(v.comparisons.filter((c) => c.oldPos).map((c) => c.id));
      boxes().forEach((x) => { x.checked = old.has(x.dataset.bulk); });
      count();
    });
    document.getElementById('bulkall').addEventListener('click', () => { const all = boxes().every((x) => x.checked); boxes().forEach((x) => { x.checked = !all; }); count(); });
    bulk.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ids = boxes().filter((x) => x.checked).map((x) => x.dataset.bulk);
      const note = bulk.note.value.trim();
      if (!ids.length || !note || !confirm(`Count ${ids.length} bill${ids.length > 1 ? 's' : ''} from the register, with the reason "${note}"? No software bill will be expected for them.`)) return;
      try {
        const r = await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/register-only`, { ids, note });
        await reload();
        msg.innerHTML = html`<div class="${r.skipped.length ? 'error' : 'ok-msg'}">${r.decided} bill${r.decided === 1 ? '' : 's'} counted from the register.${r.skipped.length ? ` Not changed: ${r.skipped.map((x) => `${x.billNo} (${x.reason})`).join('; ')}.` : ''}</div>`.__html;
      } catch (err) { showError(bulk.querySelector('.form-msg'), err); }
    });
  }
  root.querySelectorAll('[data-gobill]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const row = root.querySelector(`tr[data-bill="${CSS.escape(a.dataset.gobill)}"]`);
    if (row) reveal(row);
    if (!row) {
      // Not a difference (e.g. a matched bill with no type): open it in its register page.
      const c = v.comparisons.find((x) => x.billNo === a.dataset.gobill);
      if (c?.register?.uploadId) { setBackTo({ hash: back, bill: c.billNo, label: `${dayLabel(day)} shift` }); location.hash = `#/b/${biz.id}/review/${c.register.uploadId}/${c.register.rowId}`; }
      return;
    }
    root.querySelectorAll('tr.row-found').forEach((x) => x.classList.remove('row-found'));
    row.classList.add('row-found');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  document.getElementById('acceptbank')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    act(async () => {
      for (const c of backed) {
        await apiFull('PUT', `/businesses/${biz.id}/comparisons/${c.id}`, { decision: c.bank.suggest, billType: null, linkedToId: null,
          note: `Bank: ₹ ${rs(c.bank.amountPaise)} came in at ${hhmm(c.bank.postedAt)}` });
      }
    });
  });
  root.querySelectorAll('button[data-kind]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('button[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
    showKind(b.closest('section'), b.dataset.kind);
  }));
  };
  // Conflicts, "cash bill paid by UPI", covered times and reopen: on Compare sales in the page, on Reconcile in To do and the Shift menu.
  const wireShift = (root, msg) => {
  const act = async (fn) => { try { await fn(); await reload(); } catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  root.querySelectorAll('[data-cashupigo]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.cashupigo}/paid-by-upi`, { creditId: b.dataset.credit, billType: b.dataset.type });
      reload();
    } catch (err) { b.disabled = false; showError(b.closest('[data-cashupi]').querySelector('.form-msg'), err); }
  }));
  root.querySelectorAll('[data-conflict]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('PUT', `/businesses/${biz.id}/conflicts/${b.dataset.conflict}`, { decision: b.dataset.d }))));
  const reopen = document.getElementById('reopen');
  reopen && onSubmit(reopen, async (d) => { await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/reopen`, { reason: d.reason }); reload(); });
  root.querySelectorAll('[data-cover]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const box = document.getElementById('coveredit');
    box.innerHTML = html`<form class="inset" id="covf"><div class="form-row">
      <div class="field"><label>Covers from (India time)</label><input name="from" type="datetime-local" step="1" value="${toLocalInput(+a.dataset.from)}"></div>
      <div class="field"><label>Covers to</label><input name="to" type="datetime-local" step="1" value="${toLocalInput(+a.dataset.to)}"></div></div>
      <div class="form-msg"></div><button class="btn plain" type="submit" style="align-self:flex-start">Save covered period</button></form>`.__html;
    onSubmit(document.getElementById('covf'), async (d) => {
      await api('PATCH', `/businesses/${biz.id}/sales-reports/${a.dataset.cover}`, { coversFrom: fromLocalInput(d.from), coversTo: fromLocalInput(d.to) });
      reload();
    });
  }));
  };
  return { bar, banners, shiftPane, notMatched, shiftOptions, wire, wireShift, warningsHtml, conflictsHtml, shiftMenu, open };
}

// ---------- Bank sync: accounts, their sheets, and statement lines with what Bookr suggests

const BANK_KIND = { upi_in: 'UPI in', upi_out: 'UPI out', upi_fee: 'UPI card fee', reversal: 'Reversal', card_settlement: 'Card settlement', card_purchase: 'Card purchase', other: 'Other' };
const hhmm = (ms) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));

// The Bank page's top (approved 10 Nov 2026): how far each source is in, what is left, and the tabs. All payments (the old Money out page) is a tab;
// the Money out tab is the bank's payments to book (14 Nov 2026).
const shiftStartNow = () => Date.parse(`${new Date(Date.now() + IST_MS - 8 * 3600e3).toISOString().slice(0, 10)}T08:00:00+05:30`);
const accountBehind = (a) => !!a.sheetId && (a.lastAt ?? 0) < shiftStartNow() - 3600e3;
const cardsBehind = (k) => !!k?.folder && (k.lastSettled ?? '') < addDaysIso(todayIst(), -1);
const bankBehind = (b) => b.accounts.some(accountBehind) || cardsBehind(b.cards);

/** The Bank tabs (approved 14 Nov 2026: All payments, the old Money out page, is a tab here). Counts when the bank figures are at hand. */
function bankTabs(biz, b, active) {
  const tabs = [['in', 'Money in', b ? b.open?.in ?? 0 : null, `#/b/${biz.id}/bank?tab=in`], ['out', 'Money out', b ? b.open?.out ?? 0 : null, `#/b/${biz.id}/bank?tab=out`],
    ['payments', 'All payments', null, `#/b/${biz.id}/money-out`],
    ['cards', 'Card settlements', b ? b.cards?.days ?? 0 : null, `#/b/${biz.id}/cards`],
    ['statements', 'Statements', b ? (bankBehind(b) ? b.accounts.filter(accountBehind).length + (cardsBehind(b.cards) ? 1 : 0) : 0) : null, `#/b/${biz.id}/bank?tab=statements`],
    ['done', 'Done', null, `#/b/${biz.id}/bank?tab=done`]];
  return html`<div class="seg mode-tabs bank-tabs" role="tablist" aria-label="Bank" style="margin:4px 0 10px">${tabs.map(([k, l, n, href]) => html`<a role="tab" href="${href}" class="${k === active ? 'on' : ''}" aria-selected="${k === active}">${l}${n == null ? '' : n ? html` <span class="chip wait">${n}</span>` : html` <span class="chip ok">✓</span>`}</a>`)}</div>`;
}
function bankTop(biz, b, active) {
  const lastBank = Math.max(0, ...b.accounts.map((a) => a.lastAt ?? 0));
  const tile = (label, value, warn) => html`<div class="bank-tile"><div class="tiny">${label}</div><div style="font-weight:600;${warn ? 'color:var(--danger)' : ''}">${value}</div></div>`;
  return html`<div class="bank-strip">
      ${tile('Bank in up to', lastBank ? when(lastBank) : 'nothing yet', b.accounts.some(accountBehind))}
      ${tile('Card report in up to', b.cards?.lastSettled ? `settled ${dayLabel(b.cards.lastSettled)}` : 'nothing yet', cardsBehind(b.cards))}
      ${tile('Money in left', `${b.open?.in ?? 0} line${b.open?.in === 1 ? '' : 's'}`)}
      ${tile('Money out left', `${b.open?.out ?? 0} line${b.open?.out === 1 ? '' : 's'}`)}
      ${tile('Card days to settle', b.cards?.days ? `${b.cards.days} · ₹ ${rs(b.cards.daysNetPaise)}` : 'none')}</div>
    ${bankTabs(biz, b, active)}`;
}

async function bankView(biz, query = '') {
  const q = new URLSearchParams(query);
  const to = q.get('to') || addDaysIso(todayIst(), -1);
  const from = q.get('from') || addDaysIso(to, -6);
  const account = q.get('account') || '';
  // Opens on Statements when a source is behind, else on Money in (approved 10 Nov 2026).
  let tab = ['statements', 'in', 'out', 'done'].includes(q.get('tab')) ? q.get('tab') : null;
  // A shift runs 8 am to 8 am, so the last shift's lines run into the next calendar day.
  const [b, lines, { heads }, { rules }, { parties }, cardSrc] = await Promise.all([
    api('GET', `/businesses/${biz.id}/bank`),
    api('GET', `/businesses/${biz.id}/bank-rows?from=${from}&to=${addDaysIso(to, 1)}${account ? `&account=${account}` : ''}`),
    api('GET', `/businesses/${biz.id}/heads`),
    api('GET', `/businesses/${biz.id}/rules`),
    api('GET', `/businesses/${biz.id}/parties`),
    tab === 'statements' || !tab ? api('GET', `/businesses/${biz.id}/cards`).catch(() => null) : Promise.resolve(null),
  ]);
  if (!tab) tab = bankBehind(b) ? 'statements' : 'in';
  const canRules = biz.actions.includes('rules.edit');
  const headsOf = (dir) => heads.filter((h) => h.type === (dir === 'CR' ? 'income' : 'expense'));
  const shiftOf = (ms) => new Date(ms + IST_MS - 8 * 3600e3).toISOString().slice(0, 10);
  const all = lines.rows.map((r) => ({ ...r, shift: shiftOf(r.postedAt) })).filter((r) => r.shift >= from && r.shift <= to);
  // A card settlement credit is settled on the Card settlements tab, not listed under Money in.
  const inTab = (r) => (tab === 'done' ? r.status !== 'unmatched' : r.status === 'unmatched' && r.kind !== 'card_settlement' && r.direction === (tab === 'in' ? 'CR' : 'DR'));
  const rows = all.filter(inTab);
  const count = (t) => all.filter((r) => (t === 'done' ? r.status !== 'unmatched' : r.status === 'unmatched' && r.direction === (t === 'in' ? 'CR' : 'DR'))).length;
  const shifts = [...new Set(rows.map((r) => r.shift))].sort().reverse();
  const reversals = all.filter((r) => r.kind === 'reversal' && r.status === 'unmatched' && r.pairRowId).length;
  // UPI card fees go to Bank charges (19 Nov 2026), booked by a person in one press.
  const fees = all.filter((r) => r.kind === 'upi_fee' && r.status === 'unmatched' && r.direction === 'DR');
  const feeHead = heads.find((h) => h.type === 'expense' && /^bank charges?$/i.test(h.name.trim())) ?? heads.find((h) => h.type === 'expense' && /bank charge/i.test(h.name));
  const link = (over) => { const p = new URLSearchParams({ from, to, account, tab, ...over }); return `#/b/${biz.id}/bank?${p}`; };
  const OPEN_KEY = 'bookr.bankOpen';
  let openShifts;
  try { openShifts = new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY) || '[]')); } catch { openShifts = new Set(); }
  // The card machine's reports, as a line beside the bank accounts (8 Nov 2026): Sync asks Gmail to save new report
  // mails into the Drive folder, then reads it.
  const cardRow = (k) => (!k ? '' : html`<tr>
    <td><strong>Card reports</strong><div class="note">ICICI card machine</div></td>
    <td>Card payments, fee and GST</td>
    <td>${k.folder ? html`<a href="https://drive.google.com/drive/folders/${k.folder}" target="_blank" rel="noopener">Drive folder</a>${k.gmail ? ' · from Gmail' : ''}` : html`<span class="note">No folder yet</span>`}</td>
    <td>${k.lastSettled ? `settled ${dayLabel(k.lastSettled)}` : html`<span class="note">No report yet</span>`}<div>${cardsBehind(k) ? html`<span class="chip wait">Behind: sync it</span>` : k.folder ? html`<span class="chip ok">Up to date</span>` : ''}</div></td>
    <td class="amount">${k.payments}</td>
    <td style="text-align:right;white-space:nowrap">${k.folder ? html`<button class="btn" type="button" id="cardsyncrow">Sync</button>` : ''}</td></tr>`);
  const accountRow = (a) => html`<tr>
    <td><strong>${a.name}</strong>${a.accountNumber ? html`<div class="note mono">${a.accountNumber}</div>` : ''}</td>
    <td>${[a.receivesUpiLabel ? `UPI: ${a.receivesUpiLabel}` : '', a.receivesCard ? 'Card settlements' : ''].filter(Boolean).join(' · ') || html`<span class="note">Nothing set</span>`}</td>
    <td>${a.sheetId ? html`<a href="https://docs.google.com/spreadsheets/d/${a.sheetId}" target="_blank" rel="noopener">Google Sheet</a> · ${a.tab ?? 'every tab'}` : html`<span class="note">Pasted</span>`}
      ${a.lastSyncNote ? html`<div class="tiny">${a.lastSyncedAt ? `${when(a.lastSyncedAt)}: ` : ''}${a.lastSyncNote}</div>` : ''}</td>
    <td>${a.lastAt ? when(a.lastAt) : html`<span class="note">No lines yet</span>`}<div>${accountBehind(a) ? html`<span class="chip wait">Behind: sync it</span>` : a.sheetId ? html`<span class="chip ok">Up to date</span>` : ''}</div></td>
    <td class="amount">${a.rows}${a.open ? html` <span class="chip wait">${a.open} open</span>` : ''}</td>
    <td style="text-align:right;white-space:nowrap">
      ${a.sheetId ? html`<button class="btn" type="button" data-sync="${a.id}">Sync</button>` : ''}
      <button class="btn plain" type="button" data-paste="${a.id}" data-name="${a.name}">Paste rows</button>
      <button class="btn plain" type="button" data-setup="${a.id}">Set up</button></td></tr>
    <tr hidden data-setupform="${a.id}"><td colspan="6"><form class="inset" data-src="${a.id}">
      <div class="form-row">
        <div class="field" style="flex:2 1 260px"><label>Google Sheet link</label><input name="sheet" value="${a.sheetId ? `https://docs.google.com/spreadsheets/d/${a.sheetId}` : ''}" placeholder="Leave empty to paste rows instead"></div>
        <div class="field"><label>Tab</label><input name="tab" value="${a.tab ?? ''}" placeholder="e.g. 2026-27"></div>
        <label class="note" style="display:flex;gap:6px;align-items:center;align-self:flex-end;min-height:44px"><input type="checkbox" name="allTabs" ${a.sheetId && !a.tab ? 'checked' : ''} style="width:18px;height:18px;min-height:0"> Every tab (monthly tabs)</label>
      </div>
      <div class="form-row">
        <div class="field"><label>UPI paid into it (register column)</label><input name="receivesUpiLabel" value="${a.receivesUpiLabel ?? ''}" placeholder="e.g. UPI Bank 2"></div>
        <label class="note" style="display:flex;gap:6px;align-items:center;align-self:flex-end;min-height:44px"><input type="checkbox" name="receivesCard" ${a.receivesCard ? 'checked' : ''} style="width:18px;height:18px;min-height:0"> Card machine settles into it</label>
        <button class="btn" type="submit" style="align-self:flex-end">Save</button>
      </div>
      <div class="note">Several accounts can share a UPI column, e.g. five accounts used in turn for "UPI Bank 2": Bookr looks in all of them.</div>
      <div class="form-msg"></div></form></td></tr>`;

  const suggestion = (r) => {
    if (r.status === 'matched') return html`<span class="chip ok">Matched to bill</span> <span class="note">${r.bills ?? ''}</span> <button class="btn plain" type="button" data-unmatch="${r.id}">Unmatch</button>`;
    if (r.status === 'booked') return html`<span class="chip ok">Booked</span> <span class="note">${r.headName ?? ''}${r.note ? ` · ${r.note}` : ''}</span> <button class="btn plain" type="button" data-reopen="${r.id}">Undo</button>`;
    if (r.status === 'ignored') return html`<span class="chip">Skipped</span> <span class="note">${r.note ?? ''}</span> <button class="btn plain" type="button" data-reopen="${r.id}">Undo</button>`;
    const parts = [];
    if (r.kind === 'upi_in') {
      parts.push(r.candidates.length ? html`<div style="display:flex;flex-direction:column;gap:4px">${r.candidates.map((k, i) => html`<div class="form-row" style="gap:6px;align-items:center">
          ${r.clear && i === 0 ? html`<input type="checkbox" data-clear="${r.id}" checked aria-label="Confirm this match" style="width:18px;height:18px;min-height:0">` : ''}
          <span class="${k.strong ? '' : 'note'}">Bill ${k.billNos.join(' + ')} · ₹ ${money(k.amountPaise)}${k.minutes != null ? ` · ${k.minutes} min apart` : ` · ${dayLabel(k.shiftDay)} shift`}</span>
          <button class="btn plain" type="button" data-match="${r.id}" data-tx="${k.transactionIds.join(',')}">Match to bill</button></div>`)}</div>`
        : html`<span class="note">No confirmed UPI bill of this amount near this time.</span>`);
    }
    if (r.kind === 'upi_fee') parts.push(html`<div class="note">Fee on a credit card paid through UPI${r.pairRowId ? '' : ' (its credit is not in Bookr yet)'}.</div>`);
    if (r.kind === 'card_settlement') parts.push(html`<div class="note">Money from the card machine. <a href="#/b/${biz.id}/cards">Settle it on the Card settlements tab</a>, which books the fee.</div>`);
    // A cancelled bill refunded (Stage 7): the money goes back to the UPI ID that paid it.
    if (r.refundOf) parts.push(html`<div class="note">Sent back to the UPI ID that paid bill <span class="mono">${r.refundOf.billNos}</span> on ${when(r.refundOf.postedAt)}: the bill was most likely cancelled and refunded. Book it as a refund; the sale stays, and the refund is its cost.</div>`);
    if (r.kind === 'reversal') parts.push(r.pairRowId && r.pairStatus === 'matched'
      ? html`<div class="note error">Gives back a payment already matched to a bill: that bill is not paid. <button class="btn plain dchip" type="button" data-revunpaid="${r.id}">Bill unpaid again</button></div>`
      : html`<div class="note">${r.pairRowId ? 'Gives back a failed payment: both cancel out.' : 'A reversal; its payment is not in Bookr yet.'}</div>`);
    if (r.rule) parts.push(html`<div class="form-row" style="gap:6px;align-items:center"><input type="checkbox" data-byrule="${r.id}" checked aria-label="Book by this rule" style="width:18px;height:18px;min-height:0">
      <span>Rule <strong>${r.rule.name}</strong> → ${heads.find((h) => h.id === r.rule.headId)?.name ?? ''}</span></div>`);
    parts.push(html`<div class="form-row" style="gap:6px"><button class="btn plain" type="button" data-book="${r.id}">Book under a head</button>
      <button class="btn plain" type="button" data-ignore="${r.id}">Skip (not business)</button>
      ${canRules && r.kind !== 'upi_in' ? html`<button class="btn plain" type="button" data-mkrule="${r.id}">Make a rule</button>` : ''}</div>
      <form class="inset" hidden data-bookform="${r.id}"><div class="form-row">
        <div class="field"><label>Head</label><select name="headId" required><option value="">Choose</option>${headsOf(r.direction).map((h) => html`<option value="${h.id}">${h.name}</option>`)}</select></div>
        <div class="field"><label>Party</label><input name="party" placeholder="optional"></div>
        <div class="field"><label>Note</label><input name="note" placeholder="optional"></div>
        <button class="btn" type="submit" style="align-self:flex-end">Book</button></div><div class="form-msg"></div></form>`);
    return parts;
  };

  // ---- One shift's lines, in sections with tick boxes. Every section works the same way: tick, then one button.
  const SMALL = 'min-height:34px;padding:0 12px;font-size:14px';
  const payer = (r) => {
    const note = r.remark && !/^(UPI|UPI Pay|NA|NO REMARKS?|Payment from Ph|Sent using Payt|Paid via SuperM|Paid via CRED|Scan and Pay)$/i.test(r.remark) ? r.remark : '';
    return html`<div style="min-width:0"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px">${note ? html`<strong>${note}</strong> ` : ''}<span class="mono note">${r.vpa ?? BANK_KIND[r.kind]}</span></div>
      <div class="tiny">${hhmm(r.postedAt)} · ${r.accountName}${r.kind !== 'upi_in' && r.kind !== 'upi_out' ? ` · ${BANK_KIND[r.kind]}` : ''}</div></div>`;
  };
  const amt = (r) => html`<div class="amount" style="white-space:nowrap;font-weight:600;color:${r.direction === 'CR' ? 'var(--teal)' : 'inherit'}">${r.direction === 'CR' ? '+' : '−'}₹ ${money(r.amountPaise)}</div>`;
  const headSelect = (r, chosen) => html`<select class="compact" data-head="${r.id}" aria-label="Head" style="max-width:190px"><option value="">Choose head</option>
    ${headsOf(r.direction).map((h) => html`<option value="${h.id}" ${h.id === chosen ? 'selected' : ''}>${h.name}</option>`)}</select>`;
  // Item, party and head on one line, as on cash expense lines; the party's remembered head fills in.
  const lineFields = (r) => {
    const sg = r.suggest ?? {};
    return html`<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
      <input class="compact" data-item="${r.id}" value="${sg.item ?? ''}" placeholder="Item" aria-label="Item" style="width:150px">
      <input class="compact" data-party="${r.id}" value="${sg.party ?? ''}" list="bankparties" placeholder="Party" aria-label="Party" style="width:150px" autocomplete="off">
      ${headSelect(r, sg.headId)}${headFromChip(sg, sg.party)}
      ${r.kind === 'upi_fee' ? html`<span class="tiny">Fee on a credit card paid through UPI</span>` : r.kind === 'reversal' ? (r.pairStatus === 'matched'
        ? html`<span class="tiny error">Gives back a payment already matched to a bill</span> <button class="btn plain dchip" type="button" data-revunpaid="${r.id}">Bill unpaid again</button>`
        : html`<span class="tiny">Gives back a failed payment</span>`) : ''}</div>`;
  };
  const candText = (k) => `Bill ${k.billNos.join(' + ')}${k.part ? ` (${k.part}, ₹ ${money(k.amountPaise)})` : ''}${k.minutes != null ? ` · ${k.minutes} min apart` : ' · in register'}${k.adjust ? ` · register says ₹ ${money(k.adjust.receivedPaise)} received` : ''}`;
  const candValue = (k) => `${k.adjust ? 'adj:' : ''}${k.transactionIds.join(',')}`;
  const adjustNote = (k) => {
    const d = k.adjust.receivedPaise - k.adjust.billPaise;
    return html`<div class="tiny" style="color:#92400E">Bank shows the full bill ₹ ${money(k.adjust.billPaise)}; the register says ₹ ${money(k.adjust.receivedPaise)} received (${d > 0 ? `a ₹ ${money(d)} tip` : `a ₹ ${money(-d)} discount`}). Matching corrects the register: the ${d > 0 ? 'tip' : 'discount'} is removed.</div>`;
  };
  const section = (id, title, help, items, rowHtml, action) => !items.length ? '' : html`
    <div data-sec="${id}" style="border:1px solid var(--line-soft);border-radius:8px;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;background:var(--surface-2, #F6F7F9)">
        <label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" data-selall="${id}" style="width:18px;height:18px;min-height:0"> ${title} <span class="chip">${items.length}</span></label>
        <span style="display:flex;gap:8px;align-items:center"><span class="tiny">${help}</span>
          <button class="btn" type="button" style="${SMALL}" data-bulk="${id}" data-action="${action}" disabled>${action === 'match' ? 'Match' : 'Book'} 0 selected</button></span>
      </div>
      ${items.map((r) => html`<div data-line="${r.id}" style="display:grid;grid-template-columns:28px minmax(170px,1.2fr) 110px minmax(240px,2.4fr) auto;gap:10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line-soft);${r.candidates?.[0]?.adjust ? 'background:#FFFBEB;box-shadow:inset 3px 0 0 #F59E0B' : ''}">
        <input type="checkbox" data-pick="${id}" value="${r.id}" ${r.clear || (r.suggest?.headId && action === 'book') ? 'checked' : ''} aria-label="Select this line" style="width:18px;height:18px;min-height:0">
        ${payer(r)}${amt(r)}${rowHtml(r)}</div>`)}
    </div>`;
  const skipLink = (r) => html`<button class="btn plain" type="button" style="${SMALL}" data-ignore="${r.id}" title="Not business money">Skip</button>`;
  // Money moved between the business's own accounts (approved 14 Nov 2026): Bookr's guess first, as one card; any
  // other line can be booked as a transfer from "Own account".
  const notTr = (() => { try { return new Set(JSON.parse(localStorage.getItem(`bookr.nottr.${biz.id}`) ?? '[]')); } catch { return new Set(); } })();
  const isTr = (r) => r.transfer && !notTr.has(r.id);
  const ownLink = (r) => r.kind === 'card_settlement' || b.accounts.length < 2 ? ''
    : html`<button class="btn plain" type="button" style="${SMALL}" data-owntrpick="${r.id}" data-dir="${r.direction}" title="Money moved to or from another account of this business: not an expense or income">Own account</button>`;
  const trWhy = (t) => (t.why === 'pair' ? 'both sides found' : t.why === 'leg' ? 'joins a transfer booked from the other side' : `names ${t.word}`);
  const transferCards = (list) => {
    const trs = list.filter(isTr);
    return trs.length ? html`<div style="display:flex;flex-direction:column;gap:8px">${trs.map((r) => html`<div class="rv-card" style="gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span><strong>Transfer ${r.direction === 'DR' ? `${r.accountName} → ${r.transfer.otherAccountName}` : `${r.transfer.otherAccountName} → ${r.accountName}`}</strong>
        · ₹ ${money(r.amountPaise)} · ${when(r.postedAt)}</span><span class="tchip ${r.transfer.why === 'words' ? 'warn' : 'ok'}">${trWhy(r.transfer)}</span></div>
      <div class="tiny mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.description}</div>
      <div style="display:flex;gap:6px;justify-content:flex-end"><button class="btn" type="button" style="${SMALL}" data-owntr="${r.id}" data-other="${r.transfer.otherAccountId}" data-pair="${r.transfer.pairRowId ?? ''}" data-leg="${r.transfer.legId ?? ''}">Book as transfer</button>
        <details class="menu"><summary class="btn plain" style="${SMALL}" aria-label="More">⋯</summary><div class="menu-pop" style="min-width:220px;gap:6px">
          <button class="btn plain dchip" type="button" data-nottr="${r.id}">Not a transfer: book as ${r.direction === 'DR' ? 'expense' : 'income'}</button></div></details></div></div>`)}</div>` : '';
  };
  // Cash moved between the drawer and the bank (Stage 6): offered first where the description says so.
  const cashLink = (r) => r.kind === 'upi_in' || r.kind === 'upi_out' || r.kind === 'card_settlement' ? ''
    : html`<button class="btn ${r.cashMove ? '' : 'plain'}" type="button" style="${SMALL}" data-cashmove="${r.id}" data-dir="${r.direction}" data-shift="${shiftOfMs(r.postedAt)}"
      title="${r.direction === 'CR' ? 'Cash from the drawer paid into the bank: not income' : 'Cash taken out of the bank for the drawer: not an expense'}">${r.direction === 'CR' ? 'Cash deposited' : 'Cash for the drawer'}</button>`;
  const rulePill = (r) => canRules && r.kind !== 'upi_in' ? html`<button class="btn plain" type="button" style="${SMALL}" data-mkrule="${r.id}" title="Remember this payee's head">Rule</button>` : '';
  const shiftBody = (list) => {
    if (tab === 'done') {
      return html`<div style="border:1px solid var(--line-soft);border-radius:8px">${list.map((r) => html`<div style="display:grid;grid-template-columns:minmax(180px,1.4fr) 120px minmax(200px,2fr);gap:10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line-soft)">${payer(r)}${amt(r)}<div>${suggestion(r)}</div></div>`)}</div>`;
    }
    if (tab === 'in') {
      const found = list.filter((r) => r.candidates.length && !isTr(r));
      const rest = list.filter((r) => !r.candidates.length && !isTr(r));
      return html`${transferCards(list)}${section('found', 'Bill found', 'Same amount as a confirmed UPI bill', found, (r) => html`
          <div>${r.candidates.length === 1 ? html`<span class="${r.candidates[0].strong ? '' : 'note'}">${candText(r.candidates[0])}</span><input type="hidden" data-cand="${r.id}" value="${candValue(r.candidates[0])}">`
            : html`<select class="compact" data-cand="${r.id}" aria-label="Which bill">${r.candidates.map((k) => html`<option value="${candValue(k)}">${candText(k)}</option>`)}</select>`}
            ${r.candidates[0].adjust ? adjustNote(r.candidates[0]) : ''}</div>
          <div style="display:flex;gap:4px"><button class="btn plain" type="button" style="${SMALL}" data-fixbill="${r.id}" title="Correct the bill (number, amount, discount) to what the bank shows, and match">Fix bill</button>${skipLink(r)}</div>`, 'match')}
        ${section('nobill', 'No bill found', 'A sale nobody billed (e.g. drinks in a rush), or other money received', rest, (r) => html`
          ${lineFields(r)}<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn plain" type="button" style="${SMALL}" data-unbilled="${r.id}" data-type="fnb" title="A sale nobody billed: booked as F&B income">Unbilled F&amp;B</button>
            <button class="btn plain" type="button" style="${SMALL}" data-unbilled="${r.id}" data-type="room" title="A sale nobody billed: booked as Room income">Unbilled Room</button>
            ${cashLink(r)}${ownLink(r)}${skipLink(r)}</div>`, 'book')}`;
    }
    const known = list.filter((r) => r.suggest?.headId && !isTr(r));
    const rest = list.filter((r) => !r.suggest?.headId && !isTr(r));
    return html`${transferCards(list)}${section('ruled', 'Head suggested', 'From the party\'s past lines or a rule; change anything that is wrong', known, (r) => html`
        ${lineFields(r)}<div style="display:flex;gap:4px">${cashLink(r)}${ownLink(r)}${rulePill(r)}${skipLink(r)}</div>`, 'book')}
      ${section('needs', 'Needs a head', 'Give the item, party and head once: next time the party fills in its head', rest, (r) => html`
        ${lineFields(r)}<div style="display:flex;gap:4px">${cashLink(r)}${ownLink(r)}${rulePill(r)}${skipLink(r)}</div>`, 'book')}`;
  };

  render(shell(biz, 'bank', 'Bank', '', html`
    ${bankTop(biz, b, tab)}
    <div id="bmsg"></div>
    ${tab === 'statements' ? html`<section class="card" style="gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2>Sources</h2>
        <span style="display:flex;gap:10px;align-items:center">${b.accounts.some((a) => a.sheetId) || b.cards?.folder ? html`<button class="btn" type="button" id="banksyncall">Sync all</button>` : ''}<a href="#/b/${biz.id}/accounts" class="note">Add or edit accounts on Accounts</a></span></div>
      ${b.googleEmail ? html`<div class="note">To sync a Google Sheet, share it with <strong class="mono">${b.googleEmail}</strong> as a Viewer.</div>`
        : html`<div class="note">Google Sheets access is not set up yet. Until it is, copy rows from the sheet (Ctrl+A, Ctrl+C) and use <strong>Paste rows</strong>. Lines already in Bookr are skipped.</div>`}
      ${b.accounts.length ? html`<div class="scroll"><table style="min-width:860px"><thead><tr><th>Source</th><th>Receives</th><th>Statement from</th><th>Last line in</th><th style="text-align:right">Lines</th><th></th></tr></thead>
        <tbody>${b.accounts.map(accountRow)}${cardRow(b.cards)}</tbody></table></div>` : html`<div class="note">No bank accounts yet.</div>`}
      <form class="inset" id="pasteform" hidden><div style="font-weight:600" id="pastetitle">Paste rows</div>
        <textarea name="text" rows="6" style="width:100%;font-family:var(--mono, monospace);font-size:13px" placeholder="Copy the rows from the Google Sheet and paste them here. Title and header lines are fine."></textarea>
        <div class="form-row"><button class="btn" type="submit">Add lines</button><button class="btn plain" type="button" id="pastecancel">Cancel</button></div><div class="form-msg"></div></form>
    </section>
    ${cardSrc ? html`<section class="card" style="gap:10px"><h2>Card machine reports</h2>${cardSourceHtml(cardSrc)}</section>` : ''}` : html`
    <section class="card" style="gap:10px">
      <form class="form-row" id="bfilter" style="align-items:flex-end">
        <div class="field"><label>Shifts from</label><input type="date" name="from" value="${from}"></div>
        <div class="field"><label>to</label><input type="date" name="to" value="${to}"></div>
        <div class="field"><label>Account</label><select name="account"><option value="">All</option>${b.accounts.map((a) => html`<option value="${a.id}" ${a.id === account ? 'selected' : ''}>${a.name}</option>`)}</select></div>
        <button class="btn plain" type="submit">Show</button>
      </form>
      ${tab === 'in' ? html`<div class="note">UPI money in is reconciled shift by shift on <a href="#/b/${biz.id}/reconcile/${from}">Reconcile</a>. Use this list for other money received, or to book a credit under any head.</div>` : ''}
      <div class="note">${tab === 'in' ? html`<strong>Match to bill</strong>: the credit is the payment for a bill already counted in sales (nothing new is booked). <strong>Book under a head</strong>: money received that is not a bill, e.g. hostel rent. <strong>Own account</strong>: money from another account of the business, not income.`
        : tab === 'out' ? html`<strong>Book under a head</strong>: a payment for the business, e.g. vegetables, salary. <strong>Own account</strong>: money moved to another account of the business, not an expense.`
        : 'Lines already matched, booked or skipped. Undo puts a line back.'}</div>
      ${tab === 'out' && fees.length ? html`<div>${feeHead ? html`<button class="btn plain" type="button" id="gofees">Book ${fees.length} UPI card fee${fees.length > 1 ? 's' : ''} to ${feeHead.name} · ₹ ${money(fees.reduce((t, r) => t + r.amountPaise, 0))}</button>`
        : html`<span class="note">${fees.length} UPI card fee${fees.length > 1 ? 's' : ''} to book: add a Bank charges expense head on Heads and rules to book them in one go.</span>`}</div>` : ''}
      ${tab === 'out' && reversals ? html`<div><button class="btn plain" type="button" id="gorev">Skip ${reversals} failed payment${reversals > 1 ? 's' : ''} and ${reversals > 1 ? 'their' : 'its'} reversal</button></div>` : ''}
      <datalist id="bankparties">${parties.map((p) => html`<option value="${p.name}">`)}</datalist>
      <form class="inset" id="ruleform" hidden>
        <div style="font-weight:600">New rule</div>
        <div class="form-row">
          <div class="field"><label>Name</label><input name="name" required></div>
          <div class="field"><label>Description contains</label><input name="contains"></div>
          <div class="field"><label>UPI ID is</label><input name="vpa" class="mono"></div>
          <div class="field"><label>Money</label><select name="direction"><option value="DR">Paid out</option><option value="CR">Received</option></select></div>
          <div class="field"><label>Head</label><select name="headId" required><option value="">Choose</option>${heads.map((h) => html`<option value="${h.id}" data-type="${h.type}">${h.name} (${h.type})</option>`)}</select></div>
          <button class="btn" type="submit" style="align-self:flex-end">Save rule</button><button class="btn plain" type="button" id="rulecancel" style="align-self:flex-end">Cancel</button>
        </div><div class="note">The same supplier always pays to or from the same UPI ID, even when the description only says "UPI Pay".</div><div class="form-msg"></div>
      </form>
      ${shifts.length ? shifts.map((sd) => {
        const list = rows.filter((r) => r.shift === sd);
        const total = list.reduce((t, r) => t + r.amountPaise, 0);
        const found = list.filter((r) => r.candidates.length).length;
        const ruled = list.filter((r) => r.rule).length;
        const matchedHere = all.filter((r) => r.shift === sd && r.status === 'matched');
        const unbilledHere = all.filter((r) => r.shift === sd && r.status === 'booked' && r.note === 'Unbilled sale');
        return html`<details class="shiftgroup" data-shift="${sd}" ${openShifts.has(sd) ? 'open' : ''} style="border:1px solid var(--line-soft);border-radius:8px">
          <summary style="cursor:pointer;padding:12px 14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
            <span><strong>${dayLabel(sd)} shift</strong> <span class="note">8 am to 8 am</span></span>
            <span class="note">${list.length} line${list.length === 1 ? '' : 's'} · ₹ ${money(total)}${tab === 'in' && matchedHere.length ? ` · ${matchedHere.length} already matched` : ''}</span>
            <span style="display:flex;gap:6px;flex-wrap:wrap">
              ${tab === 'in' && found ? html`<span class="chip ok">${found} bill${found > 1 ? 's' : ''} found</span>` : ''}
              ${unbilledHere.length ? html`<span class="chip" style="background:#FEF3C7;color:#92400E" title="UPI payments booked as sales nobody billed">${unbilledHere.length} unbilled sale${unbilledHere.length > 1 ? 's' : ''} ₹ ${money(unbilledHere.reduce((t, r) => t + r.amountPaise, 0))}</span>` : ''}
              ${tab === 'out' && ruled ? html`<span class="chip ok">${ruled} by rule</span>` : ''}
              ${tab !== 'done' && list.length - (tab === 'in' ? found : ruled) ? html`<span class="chip wait">${list.length - (tab === 'in' ? found : ruled)} need a head</span>` : ''}
            </span>
          </summary>
          <div style="padding:0 12px 12px;display:flex;flex-direction:column;gap:14px">${shiftBody(list, sd)}</div>
        </details>`;
      }) : html`<div class="note">${tab === 'in' ? 'No money received is waiting' : tab === 'out' ? 'No payments are waiting' : 'Nothing done yet'} for shifts ${dayLabel(from)} to ${dayLabel(to)}${account ? ' in this account' : ''}.${
        tab !== 'done' && !account && (b.open?.[tab] ?? 0) > 0 ? ` ${b.open[tab]} ${b.open[tab] === 1 ? 'line is' : 'lines are'} waiting on other dates: change the dates to see ${b.open[tab] === 1 ? 'it' : 'them'}.` : ''}</div>`}
    </section>`}`));
  wireShell();
  const msg = document.getElementById('bmsg');
  const run = async (fn, okText) => {
    try { const r = await fn(); await bankView(biz, query); if (okText) document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">${typeof okText === 'function' ? okText(r) : okText}</div>`.__html; }
    catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  if (document.getElementById('bfilter')) onSubmit(document.getElementById('bfilter'), async (d) => go(link({ from: d.from, to: d.to, account: d.account })));
  if (tab === 'statements') wireCardSource(biz, () => bankView(biz, query), msg);
  document.getElementById('banksyncall')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try { const r = await apiFull('POST', `/businesses/${biz.id}/bank/sync-all`, {}); await bankView(biz, query); document.getElementById('bmsg').innerHTML = syncResultHtml(r).__html; }
    catch (err) { e.target.disabled = false; e.target.textContent = 'Sync all'; showError(msg, err); }
  });
  document.getElementById('cardsyncrow')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try { const k = await apiFull('POST', `/businesses/${biz.id}/cards/sync`, {}); await bankView(biz, query); document.getElementById('bmsg').innerHTML = cardSyncHtml({ ok: true, ...k }).__html; }
    catch (err) { e.target.disabled = false; e.target.textContent = 'Sync'; showError(msg, err); }
  });
  app.querySelectorAll('details.shiftgroup').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) openShifts.add(d.dataset.shift); else openShifts.delete(d.dataset.shift);
    try { sessionStorage.setItem(OPEN_KEY, JSON.stringify([...openShifts])); } catch { /* storage unavailable */ }
  }));
  app.querySelectorAll('[data-setup]').forEach((x) => x.addEventListener('click', () => { const tr = app.querySelector(`[data-setupform="${x.dataset.setup}"]`); tr.hidden = !tr.hidden; }));
  app.querySelectorAll('[data-src]').forEach((f) => onSubmit(f, async (d) => {
    await api('PUT', `/businesses/${biz.id}/bank/${f.dataset.src}/source`, { sheet: d.sheet || null, tab: d.tab || null, allTabs: !!d.allTabs, receivesUpiLabel: d.receivesUpiLabel || null, receivesCard: !!d.receivesCard });
    bankView(biz, query);
  }));
  app.querySelectorAll('[data-sync]').forEach((x) => x.addEventListener('click', () => { x.disabled = true; x.textContent = 'Syncing…';
    run(() => apiFull('POST', `/businesses/${biz.id}/bank/${x.dataset.sync}/sync`, {}), (r) => `${r.added} new line${r.added === 1 ? '' : 's'} added; ${r.skipped} already in Bookr.${r.problems.length ? ` ${r.problems.length} could not be read.` : ''}`); }));
  const pf = document.getElementById('pasteform');
  let pasteFor = null;
  app.querySelectorAll('[data-paste]').forEach((x) => x.addEventListener('click', () => { pasteFor = x.dataset.paste; document.getElementById('pastetitle').textContent = `Paste rows for ${x.dataset.name}`; pf.hidden = false; pf.text.focus(); }));
  document.getElementById('pastecancel')?.addEventListener('click', () => { pf.hidden = true; });
  pf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await apiFull('POST', `/businesses/${biz.id}/bank/${pasteFor}/paste`, { text: pf.text.value });
      await bankView(biz, query);
      document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">${r.added} new line${r.added === 1 ? '' : 's'} added; ${r.skipped} already in Bookr.</div>${r.problems.length ? html`<ul class="error">${r.problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}`.__html;
    } catch (err) { showError(pf.querySelector('.form-msg'), err); }
  });
  app.querySelectorAll('[data-match]').forEach((x) => x.addEventListener('click', () => run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${x.dataset.match}/match`, { transactionIds: x.dataset.tx.split(',') }))));
  app.querySelectorAll('[data-unmatch]').forEach((x) => x.addEventListener('click', () => run(() => apiFull('DELETE', `/businesses/${biz.id}/bank-rows/${x.dataset.unmatch}/match`, {}))));
  app.querySelectorAll('[data-reopen]').forEach((x) => x.addEventListener('click', () => { if (confirm('Undo this? A booked line\'s entry is removed (it stays in the audit log).')) run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${x.dataset.reopen}/reopen`, {})); }));
  app.querySelectorAll('[data-ignore]').forEach((x) => x.addEventListener('click', () => {
    const note = (prompt('Why skip this line? (e.g. transfer between own accounts, personal)') ?? '').trim();
    if (note) run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${x.dataset.ignore}/ignore`, { note }));
  }));
  app.querySelectorAll('[data-book]').forEach((x) => x.addEventListener('click', () => { const f = app.querySelector(`[data-bookform="${x.dataset.book}"]`); f.hidden = !f.hidden; }));
  app.querySelectorAll('[data-bookform]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { if (await bookCredit(biz, f.dataset.bookform, { headId: f.headId.value, party: f.party.value || null, note: f.note.value || null })) bankView(biz, query); }
    catch (err) { showError(f.querySelector('.form-msg'), err); }
  }));
  // Fix the bill: a small editor under the line, for a register bill the bank shows differently (typo in number or amount).
  app.querySelectorAll('[data-fixbill]').forEach((b) => b.addEventListener('click', async () => {
    const line = app.querySelector(`[data-line="${b.dataset.fixbill}"]`);
    const old = line.nextElementSibling?.classList.contains('fixbox') ? line.nextElementSibling : null;
    if (old) { old.remove(); return; }
    const tx = (app.querySelector(`[data-cand="${b.dataset.fixbill}"]`)?.value ?? '').replace(/^adj:/, '').split(',')[0];
    const box = document.createElement('div');
    box.className = 'inset fixbox';
    box.style.margin = '0 12px 12px';
    line.after(box);
    box.innerHTML = '<div class="note">Loading…</div>';
    let o;
    try { o = await apiFull('GET', `/businesses/${biz.id}/bank-rows/${b.dataset.fixbill}/fix-options?tx=${tx}`); }
    catch (err) { showError(box, err); return; }
    const credit = o.credit.amountPaise;
    const reg = o.register;
    box.innerHTML = html`<form class="fixform" style="display:flex;flex-direction:column;gap:8px">
      <div style="font-weight:600">Fix bill ${reg.billNo} to what the bank shows (₹ ${money(credit)} received)</div>
      <div class="note">Register now: bill ${reg.billNo} · ₹ ${money(reg.amountPaise)}${reg.discountPaise > 0 ? ` · discount ₹ ${money(reg.discountPaise)}` : reg.discountPaise < 0 ? ` · tip ₹ ${money(-reg.discountPaise)}` : ''} · paid ${reg.payments.map((p) => `${p.label || MODE_LABELS[p.mode]} ₹ ${money(p.amountPaise)}`).join(' + ')}</div>
      <div class="form-row" style="align-items:flex-end">
        <div class="field"><label>Bill number</label><input name="billNo" value="${reg.billNo}" list="swbills-${b.dataset.fixbill}" class="mono" required></div>
        <datalist id="swbills-${b.dataset.fixbill}">${o.softwareOnly.map((x) => html`<option value="${x.billNo}">₹ ${money(x.amountPaise)} · ${MODE_LABELS[x.mode] ?? x.mode}${x.paidAt ? ` · ${when(x.paidAt)}` : ''} · only in software</option>`)}</datalist>
        <div class="field"><label>Bill amount (₹)</label><input name="amount" class="mono" value="${rupeesForInput(reg.amountPaise)}" required style="width:110px"></div>
        <div class="field"><label>Discount (₹, tip is −)</label><input name="discount" class="mono" value="${rupeesForInput(reg.discountPaise)}" style="width:110px"></div>
        <div class="field"><label>UPI payment</label><input value="${rupeesForInput(credit)}" class="mono" disabled style="width:110px"></div>
      </div>
      ${o.softwareOnly.length ? html`<div class="tiny">Bills only in the software report for this shift, closest number first: ${o.softwareOnly.slice(0, 6).map((x) => html`<a href="#" data-pickbill="${x.billNo}" data-amt="${x.amountPaise}" class="mono">${x.billNo} (₹ ${money(x.amountPaise)})</a>`)}. Choosing one joins the two halves into one bill and removes its duplicate sale.</div>` : ''}
      <div class="form-row" style="align-items:flex-end">
        <div class="field" style="flex:2 1 260px"><label>Reason</label><input name="note" required placeholder="e.g. register typo 2611114 for 26103114"></div>
        <span class="note fixcheck" style="align-self:center"></span>
        <button class="btn" type="submit">Fix and match</button><button class="btn plain" type="button" data-fixcancel>Cancel</button>
      </div><div class="form-msg"></div></form>`.__html;
    const f = box.querySelector('form');
    const toPaise = (v) => Math.round(parseFloat(String(v || '0').replace(/,/g, '')) * 100) || 0;
    const check = () => {
      const net = toPaise(f.amount.value) - toPaise(f.discount.value);
      box.querySelector('.fixcheck').innerHTML = net === credit ? html`<span class="ok-msg" style="font-size:14px">Bill less discount = ₹ ${money(net)} ✓</span>`.__html
        : html`<span class="error" style="font-size:14px">Bill less discount = ₹ ${money(net)}; must be ₹ ${money(credit)}</span>`.__html;
    };
    const fill = (no, amt) => { f.billNo.value = no; if (amt) { f.amount.value = rupeesForInput(amt); f.discount.value = rupeesForInput(amt - credit); } check(); };
    box.querySelectorAll('[data-pickbill]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); fill(a.dataset.pickbill, Number(a.dataset.amt)); }));
    f.billNo.addEventListener('change', () => { const x = o.softwareOnly.find((y) => y.billNo === f.billNo.value.trim()); if (x) fill(x.billNo, x.amountPaise); });
    f.amount.addEventListener('input', check); f.discount.addEventListener('input', check); check();
    box.querySelector('[data-fixcancel]').addEventListener('click', () => box.remove());
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.fixbill}/fix-bill`, { registerRowId: reg.id, billNo: f.billNo.value, amount: f.amount.value, discount: f.discount.value || '0', note: f.note.value });
        await bankView(biz, query);
        document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">Bill fixed and matched: ${r.changed.join(', ')}. Unmatch puts it back.</div>`.__html;
      } catch (err) { showError(box.querySelector('.form-msg'), err); }
    });
  }));
  // A UPI payment for a sale nobody billed: booked under the F&B or Room income head, with what it was.
  app.querySelectorAll('[data-revunpaid]').forEach((b) => b.addEventListener('click', () => run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.revunpaid}/reversed-unpaid`, {}),
    'Match undone: the bill waits for its money again.')));
  // Transfers between own accounts (approved 14 Nov 2026).
  const ownTransfer = async (rowId, payload) => {
    const r = await apiFull('POST', `/businesses/${biz.id}/bank-rows/${rowId}/own-transfer`, payload);
    return r;
  };
  app.querySelectorAll('[data-owntr]').forEach((x) => x.addEventListener('click', () => run(() => ownTransfer(x.dataset.owntr,
    { otherAccountId: x.dataset.other, pairRowId: x.dataset.pair || null, legId: x.dataset.leg || null }), 'Booked as a transfer between your accounts: not an expense or income. Undo is on Done.')));
  app.querySelectorAll('[data-nottr]').forEach((x) => x.addEventListener('click', async () => {
    try { const k = `bookr.nottr.${biz.id}`; const s0 = new Set(JSON.parse(localStorage.getItem(k) ?? '[]')); s0.add(x.dataset.nottr); localStorage.setItem(k, JSON.stringify([...s0].slice(-500))); } catch { /* storage unavailable */ }
    await bankView(biz, query);
  }));
  app.querySelectorAll('[data-owntrpick]').forEach((x) => x.addEventListener('click', () => {
    const line = lines.rows.find((r) => r.id === x.dataset.owntrpick);
    const others = b.accounts.filter((a) => a.id !== line?.accountId);
    if (!line || !others.length) return;
    const pick = others.length === 1 ? '1' : prompt(`${line.direction === 'DR' ? 'Moved to' : 'Moved from'} which account?\n${others.map((a, i) => `${i + 1}. ${a.name}`).join('\n')}`, '1');
    const other = others[Number(pick) - 1];
    if (!other) return;
    const guess = (line.remark && !/^(UPI|NA|NO REMARKS?)$/i.test(line.remark) ? line.remark : line.description.split(/[/-]/).filter((w) => /[A-Za-z]{3,}/.test(w) && !/^(UPI|NEFT|IMPS|RTGS|P2A|CR|DR)$/i.test(w.trim()))[0] ?? '').trim();
    const remember = prompt(`Booked as a transfer ${line.direction === 'DR' ? 'to' : 'from'} ${other.name}. Remember words of this line as ${other.name}, so the next one is known by itself? (leave empty to skip)`, guess);
    if (remember === null) return;
    run(() => ownTransfer(line.id, { otherAccountId: other.id, remember: remember.trim() || null }),
      (r) => `Booked as a transfer ${line.direction === 'DR' ? 'to' : 'from'} ${other.name}.${r.remembered ? ` "${r.remembered}" is remembered on ${other.name}.` : ''} Undo is on Done.`);
  }));
  app.querySelectorAll('[data-cashmove]').forEach((b) => b.addEventListener('click', () => {
    const dep = b.dataset.dir === 'CR';
    const def = b.dataset.shift ?? '';
    const day = prompt(`${dep ? 'Cash deposited into the bank' : 'Cash taken out for the drawer'}: which shift's cash ${dep ? 'did it come from' : 'did it go to'}? (YYYY-MM-DD)`, def);
    if (day === null) return;
    run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.cashmove}/cash-move`, { shiftDay: day.trim() || null }),
      dep ? 'Booked as cash deposited: not income. It comes off that shift\'s cash in hand.' : 'Booked as cash for the drawer: not an expense. It is added to that shift\'s cash in hand.');
  }));
  app.querySelectorAll('[data-unbilled]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.unbilled;
    const what = (prompt(`Sale not billed (${b.dataset.type === 'fnb' ? 'F&B' : 'Room'}). What was it? (e.g. 2 beers, water)`, app.querySelector(`[data-item="${id}"]`)?.value ?? '') ?? null);
    if (what === null) return;
    run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/book-many`, { items: [{ rowId: id, billType: b.dataset.type, item: what.trim() || null,
      party: app.querySelector(`[data-party="${id}"]`)?.value.trim() || null }] }), (r) => r.booked ? 'Booked as a sale not billed.' : `Not booked: ${r.skipped.join(' ')}`);
  }));
  // Sections: Select all, ticked count on the button, one button for the ticked lines of that section.
  app.querySelectorAll('[data-sec]').forEach((sec) => {
    const picks = () => [...sec.querySelectorAll('[data-pick]')];
    const btn = sec.querySelector('[data-bulk]');
    const all = sec.querySelector('[data-selall]');
    const verb = btn.dataset.action === 'match' ? 'Match' : 'Book';
    const refresh = () => {
      const n = picks().filter((c) => c.checked).length;
      btn.disabled = !n; btn.textContent = `${verb} ${n} selected`;
      all.checked = n > 0 && n === picks().length; all.indeterminate = n > 0 && n < picks().length;
    };
    picks().forEach((c) => c.addEventListener('change', refresh));
    sec.querySelectorAll('[data-head]').forEach((h) => h.addEventListener('change', () => { const c = sec.querySelector(`[data-pick][value="${h.dataset.head}"]`); if (h.value && c) { c.checked = true; refresh(); } }));
    sec.querySelectorAll('[data-party]').forEach((pi) => pi.addEventListener('change', () => {
      const p = parties.find((x) => x.name.toLowerCase() === pi.value.trim().toLowerCase());
      const h = sec.querySelector(`[data-head="${pi.dataset.party}"]`);
      const heads1 = p ? [...new Set([p.defaultHeadId, ...(p.heads ?? []).map((x) => x.headId)].filter(Boolean))] : [];
      if (h && !h.value && heads1.length === 1 && [...h.options].some((o) => o.value === heads1[0])) h.value = heads1[0];
      const c = sec.querySelector(`[data-pick][value="${pi.dataset.party}"]`);
      if (c && (h?.value || pi.value.trim())) { c.checked = true; refresh(); }
    }));
    all.addEventListener('change', () => { picks().forEach((c) => { c.checked = all.checked; }); refresh(); });
    refresh();
    btn.addEventListener('click', () => {
      const ids = picks().filter((c) => c.checked).map((c) => c.value);
      if (btn.dataset.action === 'match') {
        const pairs = ids.map((id) => {
          const v = sec.querySelector(`[data-cand="${id}"]`)?.value ?? '';
          return { rowId: id, adjust: v.startsWith('adj:'), transactionIds: v.replace(/^adj:/, '').split(',').filter(Boolean) };
        });
        run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/match-many`, { pairs }), (r) => `${r.matched} credit${r.matched === 1 ? '' : 's'} matched to bills.${r.skipped.length ? ` Not matched: ${r.skipped.join(' ')}` : ''}`);
      } else {
        const items = ids.map((id) => ({ rowId: id, headId: sec.querySelector(`[data-head="${id}"]`)?.value || null,
          party: sec.querySelector(`[data-party="${id}"]`)?.value.trim() || null, item: sec.querySelector(`[data-item="${id}"]`)?.value.trim() || null }));
        const missing = items.filter((x) => !x.headId && !x.party).length;
        if (missing) { showError(msg, new Error(`Choose a head (or a known party) for ${missing} ticked line${missing > 1 ? 's' : ''} first.`)); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
        run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/book-many`, { items }), (r) => `${r.booked} line${r.booked === 1 ? '' : 's'} booked.${r.skipped.length ? ` Not booked: ${r.skipped.join(' ')}` : ''}`);
      }
    });
  });
  document.getElementById('gofees')?.addEventListener('click', () => run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/book-many`, { items: fees.map((r) => ({ rowId: r.id, headId: feeHead.id, item: 'UPI card fee' })) }),
    (r) => `${r.booked} UPI card fee${r.booked === 1 ? '' : 's'} booked to ${feeHead.name}.${r.skipped.length ? ` Not booked: ${r.skipped.join(' ')}` : ''}`));
  document.getElementById('gorev')?.addEventListener('click', () => run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/ignore-reversals`, {}), (r) => `${r.pairs} failed payment${r.pairs === 1 ? '' : 's'} skipped with ${r.pairs === 1 ? 'its' : 'their'} reversal.`));
  const rf = document.getElementById('ruleform');
  app.querySelectorAll('[data-mkrule]').forEach((x) => x.addEventListener('click', () => {
    const r = rows.find((y) => y.id === x.dataset.mkrule);
    rf.hidden = false;
    rf.name.value = r.remark && !/^(UPI|UPI Pay|NA|NO REMARKS?)$/i.test(r.remark) ? r.remark : (r.vpa ?? '');
    rf.vpa.value = r.vpa ?? '';
    rf.contains.value = r.vpa ? '' : (r.kind === 'upi_fee' ? 'EZY/UPICCMDR' : r.remark ?? '');
    rf.direction.value = r.direction;
    rf.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  document.getElementById('rulecancel')?.addEventListener('click', () => { rf.hidden = true; });
  rf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFull('POST', `/businesses/${biz.id}/rules`, { name: rf.name.value, contains: rf.contains.value || null, vpa: rf.vpa.value || null, direction: rf.direction.value, headId: rf.headId.value });
      await bankView(biz, query);
      document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">Rule saved. Lines it fits now show it; use "Book N by rules" on their shift.</div>`.__html;
    } catch (err) { showError(rf.querySelector('.form-msg'), err); }
  });
  void rules;
}


// ---------- Reconcile: one screen per confirmed shift (approved 5 Nov 2026)

const CARD_TAGS = { discount_not_given: 'Discount not given?', change_in_cash: 'Change in cash', wrong_column: 'Wrong UPI column', register_slip: 'Register slip', number_typo: 'Bill number typo', payment_written_wrong: 'Written wrong', paid_in_parts: 'Paid in parts', one_credit_many_bills: 'One table',
  clear_matches: 'Same amount, close in time', same_sale: 'Booked directly', bank_backs: 'Bank agrees', no_upi_credit: 'No credit in the bank', no_bill: 'No bill' };
const witnessHtml = (label, value, odd) => html`<div class="wit ${odd ? 'odd' : ''}"><div class="wit-l">${label}</div><div class="wit-v">${value ?? 'Not found'}</div></div>`;
/** A suggestion: what Bookr saw, its reason as a tag, and one click to act. A person always makes the click. */
// A UPI payment written under another account's column (7 Nov 2026): the money came into a different account. Shown
// only to Owner and Accountant (the server sends hints to no one else). A person presses the button; nothing is automatic.
const colHintText = (h) => `₹ ${money(h.amountPaise)} came into ${h.accountName} at ${when(h.postedAt)}, but the register writes it under ${h.fromLabel}.`;
function columnCard(h, confirmed) {
  const match = confirmed && !!h.transactionIds?.length;
  return { key: `col:${h.paymentId}:${h.creditId}`, kind: 'wrong_column', title: `${h.billNo ? `Bill ${h.billNo}` : 'A payment'} is under the wrong UPI column`, score: 80,
    billNos: h.billNo ? [h.billNo] : [],
    evidence: [colHintText(h), `No credit of that amount came into the ${h.fromLabel} account${h.minutes != null ? ` near the bill (this one is ${h.minutes} min from it)` : ''}.`],
    actions: [{ label: match ? `Change to ${h.toLabel} and match` : `Change to ${h.toLabel}`, primary: true, op: 'setColumn', hint: h, match }] };
}
/** Changes the payment's column (and on a confirmed shift matches the credit too); returns the undo. */
async function setColumn(biz, a) {
  const h = a.hint;
  const base = `/businesses/${biz.id}`;
  await apiFull('POST', `${base}/register-payments/${h.paymentId}/column`, { columnLabel: h.toLabel, ...(a.match ? { creditId: h.creditId, transactionIds: h.transactionIds } : {}) });
  return async () => {
    if (a.match) await apiFull('DELETE', `${base}/bank-rows/${h.creditId}/match`, {});
    await apiFull('POST', `${base}/register-payments/${h.paymentId}/column`, { columnLabel: h.fromLabel });
  };
}
/** The bills a credit not matched yet could belong to, with how far each is from it in time. */
function creditBillsText(x) {
  const gap = (m) => (m == null ? 'no time' : m === 0 ? 'same minute' : `${Math.abs(m) >= 120 ? `${Math.round(Math.abs(m) / 6) / 10} h` : `${Math.abs(m)} min`} ${m > 0 ? 'later' : 'earlier'}`);
  return x.bills.map((b) => `bill ${b.billNo}${b.paidAt ? ` (${hhmm(b.paidAt)}, ${gap(b.minutes)})` : ''}`).join(', ') + (x.bills.length > 1 ? ': more than one fits' : '');
}
/** The reason tag for a credit not matched yet on Reconcile's open entries. */
function creditWhyHtml(c, bills = []) {
  if (c.why === 'no_bill') return html` · <span style="color:var(--danger)">no bill of this amount</span>`;
  // No bill of exactly this amount: say which open bill is near it, if one is (wording fixed 10 Nov 2026).
  if (c.why === 'extra' && !c.billsOfAmount) {
    const near = bills.filter((b) => b.amountPaise !== c.amountPaise && Math.abs(b.amountPaise - c.amountPaise) <= TRAY_GAP)
      .sort((a, b) => Math.abs(a.amountPaise - c.amountPaise) - Math.abs(b.amountPaise - c.amountPaise))[0];
    return html` · <span style="color:var(--danger)">no bill of exactly this amount${near ? `: bill ${near.billNo} (₹ ${money(near.amountPaise)}) is ₹ ${money(Math.abs(near.amountPaise - c.amountPaise))} apart` : ''}</span>`;
  }
  if (c.why === 'extra') return html` · <span style="color:var(--danger)">extra: all ${c.billsOfAmount} bill${c.billsOfAmount === 1 ? '' : 's'} of this amount have their credit</span>`;
  if (c.why === 'unpaired') return html` · <span style="color:#92400E">could be ${creditBillsText(c)}</span>`;
  return '';
}
/** Every credit and register row a slip uses: a swap's other bill and credit too. */
const slipCredits = (s) => [s.creditId, ...s.others.map((o) => o.creditId), ...(s.partner ? [s.partner.creditId] : [])];
const slipRows = (s) => [s.rowId, ...(s.partner ? [s.partner.rowId] : [])];
const paysText = (pays) => pays.map((p) => rs(p.amountPaise)).join(' + ') || 'nothing';
const offText = (x) => (x.discountPaise ? `, ₹ ${rs(x.discountPaise)} discount` : x.tipPaise ? `, ₹ ${rs(x.tipPaise)} tip` : '');
function slipTitle(s) {
  if (s.kind === 'swap') return `Bills ${s.billNo} and ${s.partner.billNo}: the bank got ₹ ${rs(s.creditPaise)} and ₹ ${rs(s.partner.creditPaise)}`;
  if (s.kind === 'change_payment') return `Bill ${s.billNo}: ₹ ${rs(s.fromPaise)} was probably ₹ ${rs(s.creditPaise)}`;
  return s.before.discountPaise === s.creditPaise ? `Bill ${s.billNo}: the ₹ ${rs(s.creditPaise)} discount was a payment` : `Bill ${s.billNo}: a ₹ ${rs(s.creditPaise)} UPI payment is missing`;
}
const slipShort = (s) => (s.kind === 'swap' ? `${rs(s.fromPaise)} → ${rs(s.creditPaise)}, ${rs(s.partner.fromPaise)} → ${rs(s.partner.creditPaise)}`
  : s.kind === 'change_payment' ? `${rs(s.fromPaise)} → ${rs(s.creditPaise)}` : `add ₹ ${rs(s.creditPaise)} UPI`)
  + (s.after.discountPaise !== s.before.discountPaise || s.after.tipPaise !== s.before.tipPaise ? (s.after.discountPaise || s.after.tipPaise ? offText(s.after).replace(/^, /, ', ') : ', no discount') : '');
function slipCard(s, confirmed, day) {
  if (s.kind === 'swap') {
    const p = s.partner;
    const end = (x) => (x.after.tipPaise ? `a ₹ ${rs(x.after.tipPaise)} tip` : x.after.discountPaise ? `₹ ${rs(x.after.discountPaise)} off` : 'nothing over');
    return { key: s.key, kind: 'register_slip', title: slipTitle(s), score: 85, billNos: [s.billNo, p.billNo],
      witnesses: { software: `Bills ₹ ${rs(s.softwarePaise)} + ₹ ${rs(p.softwarePaise)}`, register: `Paid ₹ ${rs(s.fromPaise)} + ₹ ${rs(p.fromPaise)}`,
        bank: `₹ ${rs(s.creditPaise)} at ${hhmm(s.postedAt)} + ₹ ${rs(p.creditPaise)} at ${hhmm(p.postedAt)}`, odd: 'register' },
      evidence: [
        `Bills ${s.billNo} (₹ ${rs(s.fromPaise)}) and ${p.billNo} (₹ ${rs(p.fromPaise)}) were paid by UPI and the bank has neither amount. It got ₹ ${rs(s.creditPaise)} at ${hhmm(s.postedAt)} and ₹ ${rs(p.creditPaise)} at ${hhmm(p.postedAt)}: the same ₹ ${rs(s.fromPaise + p.fromPaise)} in all, so a little money moved between the two payments.`,
        `${s.billNo} takes ₹ ${rs(s.creditPaise)} (${end(s)}); ${p.billNo} takes ₹ ${rs(p.creditPaise)} (${end(p)}).`,
        confirmed ? 'Correcting records both changes and matches both credits. Unmatching either puts both bills back.' : 'Correcting changes both register rows. Check them against the photos.',
      ],
      actions: [{ label: confirmed ? 'Correct both and match' : 'Correct both bills', primary: true, op: 'slip', slip: s, confirmed, day }] };
  }
  const bank = [`₹ ${rs(s.creditPaise)} at ${hhmm(s.postedAt)}`, ...s.others.map((o) => `₹ ${rs(o.amountPaise)} at ${hhmm(o.postedAt)}`)];
  return { key: s.key, kind: 'register_slip', title: slipTitle(s), score: 85, billNos: [s.billNo],
    witnesses: { software: `Bill ₹ ${rs(s.softwarePaise)}`, register: `Paid ${paysText(s.before.pays)}${offText(s.before)}`, bank: bank.join(' + '), odd: 'register' },
    evidence: [
      `₹ ${rs(s.creditPaise)} came in${s.accountName ? ` to ${s.accountName}` : ''} at ${when(s.postedAt)}, ${s.minutes} min from the bill, with no bill of its own.`,
      `The register says ${paysText(s.before.pays)}${offText(s.before)}. As ${paysText(s.after.pays)}${offText(s.after) || ', no discount'}, it equals the software's ₹ ${rs(s.softwarePaise)}${s.others.length ? ' and every payment has its credit' : ''}.`,
      confirmed ? 'Correcting records the change on the register and matches the credit. Unmatch puts it back.' : 'Correcting changes the register row. Check it against the photo.',
    ],
    actions: [{ label: confirmed ? `Correct (${slipShort(s)}) and match` : `Correct the register (${slipShort(s)})`, primary: true, op: 'slip', slip: s, confirmed, day }] };
}
/** Applies a slip correction; returns the undo. */
async function applySlip(biz, a) {
  const s = a.slip;
  const base = `/businesses/${biz.id}`;
  if (a.confirmed) {
    await apiFull('POST', `${base}/bank-rows/${s.creditId}/slip-fix`, { day: a.day, key: s.key, ...(s.partner ? { partnerCreditId: s.partner.creditId } : {}) });
    return () => apiFull('DELETE', `${base}/bank-rows/${s.creditId}/match`, {}); // a swap's two credits were matched in one step: undone together
  }
  // A swap: both rows, the second undone if the first fails, and both put back by the undo.
  if (s.partner) {
    const first = await applySlip(biz, { ...a, slip: { ...s, partner: undefined } });
    let second;
    try { second = await applySlip(biz, { ...a, slip: s.partner }); } catch (err) { await first(); throw err; }
    return async () => { await second(); await first(); };
  }
  const u = await api('GET', `${base}/uploads/${s.uploadId}`);
  const r = u.rows.find((x) => x.id === s.rowId);
  const sig = (ps) => ps.map((p) => `${p.mode}:${p.amountPaise}`).sort().join(',');
  const same = r && sig(r.payments) === sig(s.before.pays);
  if (!same) throw new Error(`Bill ${s.billNo}'s row has changed since this was worked out. Reload the page.`);
  const payload = { paidWithRowId: r.paidWithRowId, billNo: r.billNo, billType: r.billType, amount: rupeesForInput(r.amountPaise), discount: rupeesForInput(r.discountPaise), remarks: r.remarks, status: r.status,
    payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })) };
  const put = (b) => apiFull('PUT', `${base}/register-rows/${r.id}`, b);
  await put({ ...payload, discount: rupeesForInput(s.after.discountPaise - s.after.tipPaise),
    payments: s.after.pays.map((p) => ({ mode: p.mode, columnLabel: p.label, amount: rupeesForInput(p.amountPaise) })) });
  return () => put(payload);
}
/**
 * Before confirming: the bill's UPI payments become the ticked credits (column kept when it fits the credit's account,
 * else the account's), other payments stay, and amount − paid is the discount (negative: a tip). Returns the undo.
 */
// The tray (approved 10 Nov 2026; by tick order, Stage 1 of the reconcile plan): a person makes the pairs by the order
// they tick: a credit then its bill (or the bill first) is a pair, the next two the next pair. "+ Add to this pair"
// puts the next tick into that pair (several bills on one credit, or a bill paid in several goes). Bookr only checks
// each pair: the same amount, a gap of up to ₹10 (a tip or discount, for the person to choose), or too far apart.
const TRAY_GAP = 1000;
/** Exact pairs nothing else competes for: the amount is on one open credit and one open bill only. */
function lonePairs(open) {
  const n = (xs, a) => xs.filter((x) => x.amountPaise === a).length;
  return open.credits.filter((c) => n(open.credits, c.amountPaise) === 1 && n(open.bills, c.amountPaise) === 1)
    .map((c) => ({ credit: c, bill: open.bills.find((b) => b.amountPaise === c.amountPaise) }));
}
/**
 * Probably the same payment (approved 17 Nov 2026): a bill and a credit up to 30 minutes and 5% apart (each the only
 * one of its amount on its side), or a register-only bill and the one credit of exactly its amount. Each bill and
 * credit is used once, closest amount first. Nothing is matched until a person clicks.
 */
const NEAR_MIN = 30;
const NEAR_PCT = 5;
function nearPairs(open, skip = new Set()) {
  const out = [];
  const usedC = new Set();
  const usedB = new Set();
  const credits = open.credits.filter((c) => !skip.has(c.id) && c.postedAt != null);
  const bills = open.bills.filter((b) => !b.grouped && b.amountPaise > 0 && !skip.has(b.id));
  const nBills = (a) => open.bills.filter((x) => x.amountPaise === a).length;
  for (const b of bills.filter((x) => !x.paidAt && x.rowId)) {
    const cs = credits.filter((c) => c.amountPaise === b.amountPaise);
    if (cs.length === 1 && nBills(b.amountPaise) === 1) { out.push({ bill: b, credit: cs[0], diff: 0, kind: 'register' }); usedC.add(cs[0].id); usedB.add(b.id); }
  }
  const cand = [];
  for (const b of bills) {
    // A bill with a credit of exactly its amount, or a credit with a bill of exactly its amount, is matched the usual way.
    if (!b.paidAt || usedB.has(b.id) || open.credits.some((c) => c.amountPaise === b.amountPaise)) continue;
    for (const c of credits) {
      if (usedC.has(c.id) || nBills(c.amountPaise)) continue;
      const diff = c.amountPaise - b.amountPaise;
      const mins = Math.abs(c.postedAt - b.paidAt) / 60000;
      if (diff && mins <= NEAR_MIN && Math.abs(diff) * 100 <= b.amountPaise * NEAR_PCT) cand.push({ bill: b, credit: c, diff, mins, kind: 'near' });
    }
  }
  cand.sort((x, y) => Math.abs(x.diff) - Math.abs(y.diff) || x.mins - y.mins);
  for (const p of cand) if (!usedB.has(p.bill.id) && !usedC.has(p.credit.id)) { out.push(p); usedB.add(p.bill.id); usedC.add(p.credit.id); }
  return out;
}
const nearLabel = (p) => (p.kind === 'register' ? 'Use register and match' : `Match, ₹ ${money(Math.abs(p.diff))} ${p.diff > 0 ? 'tip' : 'discount'}`);
/** Writes the credit on the bill's row (the difference as discount or tip; a register-only bill decided as Use register),
 *  then holds the match for saving. Returns the undo. */
async function matchNearPair(biz, day, p) {
  const base = `/businesses/${biz.id}`;
  const undos = [];
  try {
    if (p.kind === 'register') {
      const c = (await api('GET', `${base}/shifts/${day}`)).comparisons.find((x) => x.id === p.bill.id);
      if (c && !c.decision && c.difference !== 'match' && c.difference !== 'complimentary') {
        await apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: 'use_register', note: `Bank ₹ ${money(p.credit.amountPaise)} at ${hhmm(p.credit.postedAt)}` });
        undos.push(() => apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: null }));
      }
    } else if (p.bill.rowId) undos.push(await writeBankOnRow(biz, p.bill, [p.credit], { mode: 'upi' }));
    else {
      const r = await apiFull('POST', `${base}/comparisons/${p.bill.id}/add-paid`, { mode: 'upi', sourceId: p.credit.id, allowGap: Math.abs(p.diff) > TRAY_GAP, fix: false });
      undos.push(() => apiFull('DELETE', `${base}/register-rows/${r.rowId}`, {}));
    }
    // Writing the payment changes the register row, which clears a decision on the bill (26110819, 21 Nov 2026): a bill
    // whose software and register still differ takes the register's side, which now holds this UPI payment.
    if (p.kind !== 'register') {
      const c = (await api('GET', `${base}/shifts/${day}`)).comparisons.find((x) => x.id === p.bill.id);
      if (c && !c.decision && c.register && c.difference !== 'match' && c.difference !== 'complimentary') {
        await apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: 'use_register', note: `Bank ₹ ${money(p.credit.amountPaise)} at ${hhmm(p.credit.postedAt)}` });
        undos.push(() => apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: null }));
      }
    }
    const res = await apiFull('POST', `${base}/shifts/${day}/choices`, { pairs: [{ bankRowId: p.credit.id, comparisonIds: [p.bill.id] }] });
    return async () => {
      await eachAtOnce(res.ids ?? [], (id) => apiFull('DELETE', `${base}/shifts/${day}/choices/${id}`, {}).catch(() => {}));
      for (const u of undos.reverse()) await u();
    };
  } catch (err) { for (const u of undos.reverse()) await u().catch(() => {}); throw err; }
}
/** What a pair is: waiting for its other side, ready (exact, group, parts), a gap to choose, or not matched. */
function trayPair(p, card) {
  const cr = p.credits.reduce((t, x) => t + x.amountPaise, 0);
  const bl = p.bills.reduce((t, x) => t + x.amountPaise, 0);
  const out = { diff: cr - bl, kind: 'exact', why: null };
  if (!p.credits.length || !p.bills.length) return { ...out, kind: 'waiting' };
  if (p.credits.length > 1 && p.bills.length > 1) return { ...out, kind: 'bad', why: 'Several on both sides: make one credit with its bills, or one bill with its credits.' };
  if (p.bills.length > 1) {
    const g = p.bills[0].group;
    if (!g || !p.bills.every((b) => b.group === g)) return { ...out, kind: 'loose', why: 'Not paid together on the register' };
    return out.diff ? { ...out, kind: 'bad', why: `₹ ${money(Math.abs(out.diff))} from the group's total: correct the payment on the row that holds it (Open row).` } : { ...out, kind: 'group' };
  }
  const b = p.bills[0];
  if (p.credits.length > 1) {
    if (card) return { ...out, kind: 'bad', why: 'A card bill paid in several goes is matched after saving.' };
    if (!b.rowId || b.grouped) return { ...out, kind: 'bad', why: `Bill ${b.billNo} has no register row of its own to write the payments on: open its row first.` };
    return Math.abs(out.diff) > TRAY_GAP ? { ...out, kind: 'off' } : { ...out, kind: 'parts' };
  }
  if (out.diff === 0) return out;
  if (b.grouped) return { ...out, kind: 'bad', why: 'Paid together with others: correct the payment on the row that holds it (Open row).' };
  // More than ₹10 apart (11 Nov 2026): never matched on its own; a person chooses a tip or discount, or the bill's amount.
  if (Math.abs(out.diff) > TRAY_GAP) return -out.diff >= bl ? { ...out, kind: 'off' } : { ...out, kind: 'big' };
  return { ...out, kind: 'gap' };
}
/** The tray, on the UPI tab (bank credits) and the Card tab (machine payments). root holds the [data-tside="cr"|"bl"]
 *  ticks and [data-tray] boxes: sum, fix, msg, and optionally exact (tick all exact pairs), nearOn + near (the shifts
 *  either side). open: { credits, bills }, credits with postedAt. post(matches) saves the matches; nearby() lists more. */
function wireTray({ biz, day, reload, root, open, lone = [], mode, post, nearby }) {
  const card = mode === 'card';
  const noun = card ? 'Payment' : 'Credit';
  const q = (k) => root.querySelector(`[data-tray="${k}"]`);
  const tickBox = (id) => root.querySelector(`[data-tside][data-id="${id}"]`);
  const known = new Map([...open.credits.map((c) => [c.id, c]), ...open.bills.map((b) => [b.id, b])]);
  let pairs = [];
  let addTo = null;
  let preview = false;
  const pick = new Map(); // pair → 'tip' | 'fix'
  const place = (side, item) => {
    if (addTo && pairs.includes(addTo)) { addTo[side].push(item); addTo = null; return; }
    const wait = pairs.find((p) => !p[side].length);
    if (wait) wait[side].push(item);
    else pairs.push({ credits: side === 'credits' ? [item] : [], bills: side === 'bills' ? [item] : [] });
  };
  const remove = (id) => {
    for (const p of pairs) { p.credits = p.credits.filter((x) => x.id !== id); p.bills = p.bills.filter((x) => x.id !== id); }
    pairs = pairs.filter((p) => p.credits.length || p.bills.length);
    if (addTo && !pairs.includes(addTo)) addTo = null;
  };
  const refresh = () => {
    const sum = (side) => pairs.flatMap((p) => p[side]).reduce((t, x) => t + x.amountPaise, 0);
    const a = sum('credits'); const b = sum('bills'); const diff = a - b;
    q('sum').innerHTML = html`${card ? 'Machine' : 'Bank'} <strong>₹ ${money(a)}</strong> · Bills <strong>₹ ${money(b)}</strong> · Difference <strong style="color:${diff ? 'var(--danger)' : 'var(--teal)'}">₹ ${money(Math.abs(diff))}</strong>`.__html;
    if (!pairs.length) preview = false;
    draw();
  };
  root.addEventListener('change', (e) => {
    const x = e.target.closest?.('[data-tside]');
    const item = x && known.get(x.dataset.id);
    if (!item) return;
    if (x.checked) place(x.dataset.tside === 'cr' ? 'credits' : 'bills', item); else remove(item.id);
    preview = false;
    refresh();
  });
  q('exact')?.addEventListener('click', () => {
    for (const p of lone) {
      if (tickBox(p.credit.id)?.checked || tickBox(p.bill.id)?.checked) continue;
      tickBox(p.credit.id).checked = true; tickBox(p.bill.id).checked = true;
      pairs.push({ credits: [p.credit], bills: [p.bill] });
    }
    refresh();
    q('sum').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  // The shifts either side: their open credits (or card payments), loaded when switched on.
  q('nearOn')?.addEventListener('change', async (e) => {
    const box = q('near');
    if (!e.target.checked) {
      box.querySelectorAll('[data-tside]').forEach((x) => { if (x.checked) remove(x.dataset.id); });
      box.innerHTML = ''; refresh(); return;
    }
    box.innerHTML = html`<div class="note">Loading…</div>`.__html;
    try {
      const list = await nearby();
      list.forEach((c) => known.set(c.id, c));
      box.innerHTML = list.length ? html`<div class="tiny" style="margin-top:8px"><strong>From the shifts either side</strong></div>${list.map((c) => html`<label class="um-line"><input type="checkbox" data-tside="cr" data-amt="${c.amountPaise}" data-id="${c.id}"><span style="flex:1">${when(c.postedAt)}<span class="tiny" style="display:block">${dayLabel(c.shiftDay)} shift${c.accountName ? ` · ${c.accountName}` : ''}</span></span><strong class="amount">₹ ${money(c.amountPaise)}</strong></label>`)}`.__html
        : html`<div class="note">Nothing open on the shifts either side.</div>`.__html;
    } catch (err) { box.innerHTML = ''; showError(box, err); }
  });
  const billLine = (b) => html`<div><span class="mono">${b.billNo ?? '—'}</span>${b.grouped ? html` <span class="chip">paid together</span>` : ''}<div class="tiny">₹ ${money(b.amountPaise)} · ${b.fromDay ? `${dayLabel(b.fromDay)} bill, paid later here` : b.paidAt ? when(b.paidAt) : 'register only'}${!b.rowId && !b.grouped ? ' · not in the register' : ''}</div></div>`;
  const crLine = (c) => html`<div>${noun} ${when(c.postedAt)}<div class="tiny">₹ ${money(c.amountPaise)}${c.shiftDay && c.shiftDay !== day ? ` · ${dayLabel(c.shiftDay)} shift` : ''}${c.accountName ? ` · ${c.accountName}` : ''}</div></div>`;
  // What saving a ready pair writes on the register first, in words; null when it only matches.
  const edit = (p, t) => {
    const b = p.bills[0];
    const word = card ? 'card' : 'UPI';
    const off = t.diff > 0 ? `, ₹ ${money(t.diff)} tip` : t.diff < 0 ? `, ₹ ${money(-t.diff)} discount` : '';
    if (t.kind === 'parts') return `Bill ${b.billNo}: write ${p.credits.map((c) => `₹ ${money(c.amountPaise)}`).join(' + ')} by UPI on its register row${off}`;
    if (t.kind !== 'exact' && t.kind !== 'gap' && t.kind !== 'big') return null;
    if (!b.rowId) return pick.get(p) === 'fix' ? `Bill ${b.billNo}: add it to the register (it is not there) at ₹ ${money(p.credits[0].amountPaise)}, paid by ${word}, and decide it as Use register`
      : `Bill ${b.billNo}: add it to the register (it is not there) as ${word} ₹ ${money(p.credits[0].amountPaise)}${off}`;
    if (t.kind === 'gap' || t.kind === 'big') return pick.get(p) === 'fix' ? `Bill ${b.billNo}: change its amount to ₹ ${money(p.credits[0].amountPaise)}, paid by ${word}` : `Bill ${b.billNo}: write ${word} ₹ ${money(p.credits[0].amountPaise)} on its register row${off}`;
    return null;
  };
  const isReady = (p, t) => ['exact', 'group', 'parts'].includes(t.kind) || ((t.kind === 'gap' || t.kind === 'big') && pick.has(p));
  const draw = () => {
    const box = q('fix');
    q('msg').textContent = '';
    if (!pairs.length) { box.innerHTML = ''; return; }
    // Several credits ticked and no bill yet (ticked to book together): one line, not a waiting pair each (17 Nov 2026).
    if (pairs.length > 1 && !pairs.some((p) => p.bills.length)) {
      box.innerHTML = html`<div class="tray"><div class="lane-h"><strong>${pairs.length} ${noun.toLowerCase()}s ticked · ₹ ${money(pairs.reduce((t, p) => t + p.credits.reduce((a, c) => a + c.amountPaise, 0), 0))}</strong>
        <button class="btn plain dchip" type="button" data-trayclear>Clear ticks</button></div>
        <div class="note">Tick a bill to pair it with the first one${card ? '' : ', or book the ticked credits with no bill with the buttons below'}.</div></div>`.__html;
      box.querySelector('[data-trayclear]').addEventListener('click', () => {
        root.querySelectorAll('[data-tside]').forEach((c) => { c.checked = false; });
        pairs = []; pick.clear(); addTo = null;
        refresh();
        root.dispatchEvent(new Event('change'));
      });
      return;
    }
    const ts = pairs.map((p) => trayPair(p, card));
    const ready = pairs.filter((p, i) => isReady(p, ts[i]));
    const tOf = (p) => ts[pairs.indexOf(p)];
    const chip = (p, t) => (t.kind === 'waiting' ? html`<span class="tchip">Waiting for its ${p.credits.length ? 'bill' : noun.toLowerCase()}</span>`
      : t.kind === 'exact' ? html`<span class="tchip ok">Same amount</span>`
      : t.kind === 'group' ? html`<span class="tchip ok">Paid together, same total</span>`
      : t.kind === 'parts' ? html`<span class="tchip ${t.diff ? 'warn' : 'ok'}">Paid in ${p.credits.length} goes${t.diff ? `, ₹ ${money(Math.abs(t.diff))} ${t.diff > 0 ? 'tip' : 'discount'}` : ''}</span>`
      : t.kind === 'gap' ? html`<span class="tchip warn">${t.diff > 0 ? `₹ ${money(t.diff)} more: tip?` : `₹ ${money(-t.diff)} less: discount?`}</span>`
      : t.kind === 'big' ? html`<span class="tchip bad">₹ ${money(Math.abs(t.diff))} ${t.diff > 0 ? 'more' : 'less'} than the bill: choose</span>`
      : t.kind === 'off' ? html`<span class="tchip bad">₹ ${money(Math.abs(t.diff))} apart: not matched</span>`
      : html`<span class="tchip bad">${t.kind === 'loose' ? t.why : 'Not matched'}</span>`);
    const menu = (p, t, i) => {
      const b = p.bills[0];
      const gap = t.kind === 'gap' ? html`<select data-traypick="${i}" style="width:auto;font-size:12px;min-height:0"><option value="">Choose…</option>
        <option value="tip" ${pick.get(p) === 'tip' ? 'selected' : ''}>Match, ₹ ${money(Math.abs(t.diff))} ${t.diff > 0 ? 'tip' : 'discount'}</option>
        ${b.rowId && !b.paidAt ? html`<option value="fix" ${pick.get(p) === 'fix' ? 'selected' : ''}>Match, fix bill to ₹ ${money(p.credits[0].amountPaise)}</option>` : ''}</select>`
        : t.kind === 'big' ? html`<button type="button" class="btn plain dchip${pick.get(p) === 'tip' ? ' on' : ''}" data-traybig="${i}" data-v="tip">₹ ${money(Math.abs(t.diff))} ${t.diff > 0 ? 'tip' : 'discount'}</button>
          <button type="button" class="btn plain dchip${pick.get(p) === 'fix' ? ' on' : ''}" data-traybig="${i}" data-v="fix">Bill was ₹ ${money(p.credits[0].amountPaise)}</button>` : '';
      return html`<div class="form-row" style="gap:6px;justify-content:flex-end;margin-top:4px">${gap}
        ${t.kind === 'loose' ? html`<button type="button" class="btn plain dchip" data-bill-drawer="${b.billNo}|${day}">Write as paid together</button>` : ''}
        ${t.kind === 'waiting' ? '' : html`<button type="button" class="btn plain dchip" data-trayadd="${i}">${addTo === p ? 'Tick to add… (cancel)' : '+ Add to this pair'}</button>`}
        <button type="button" class="btn plain dchip" data-trayout="${i}">Take out</button></div>`;
    };
    const row = (p, t, i) => html`<div class="tray-row${addTo === p ? ' tray-adding' : ''}"><div><span class="tiny">Pair ${i + 1}</span>${p.credits.length ? p.credits.map(crLine) : html`<div class="tiny">Tick its ${noun.toLowerCase()}…</div>`}</div>
      <span aria-hidden="true">↔</span><div>${p.bills.length ? p.bills.map(billLine) : html`<div class="tiny">Tick its bill…</div>`}</div>
      <div style="text-align:right">${chip(p, t)}${t.why && t.kind !== 'loose' ? html`<div class="tiny" style="white-space:normal">${t.why}</div>` : ''}${menu(p, t, i)}</div></div>`;
    const undecided = pairs.filter((p, i) => (ts[i].kind === 'gap' || ts[i].kind === 'big') && !pick.has(p)).length;
    const waiting = ts.filter((t) => t.kind === 'waiting').length;
    const notReady = pairs.length - ready.length - undecided - waiting;
    const notes = [undecided ? `${undecided} gap${undecided === 1 ? '' : 's'} to choose` : '', waiting ? `${waiting} waiting for a tick` : '', notReady ? `${notReady} not matched` : ''].filter(Boolean);
    const writes = ready.map((p) => edit(p, tOf(p))).filter(Boolean);
    const matchN = ready.filter((p) => tOf(p).kind !== 'parts').length;
    box.innerHTML = html`<div class="tray">
      <div class="lane-h"><strong>Pairs to match on save (${pairs.length})</strong><span class="tiny">Pairs follow the order you tick</span></div>
      ${pairs.map((p, i) => row(p, ts[i], i))}
      ${preview && ready.length ? html`<div class="tray-preview"><strong>Saving ${ready.length} pair${ready.length === 1 ? '' : 's'} will:</strong>
        <ul class="note" style="margin:6px 0 0;padding-left:18px">${writes.map((w) => html`<li>${w}</li>`)}${matchN ? html`<li>Match ${matchN} pair${matchN === 1 ? '' : 's'} when you save the shift</li>` : ''}${matchN < ready.length ? html`<li>A bill paid in several goes is matched to its credits on save</li>` : ''}</ul>
        <div class="form-row" style="gap:8px;margin-top:8px"><button class="btn" type="button" data-traygo style="min-height:36px">${writes.length ? `Write and match ${ready.length}` : `Match ${ready.length}`}</button><button class="btn plain" type="button" data-trayback style="min-height:36px">Back</button></div></div>`
      : html`<div class="tray-foot"><span class="tiny">Ready ₹ ${money(ready.reduce((a, p) => a + p.credits.reduce((t, c) => t + c.amountPaise, 0), 0))} in ${ready.length} pair${ready.length === 1 ? '' : 's'}${notes.length ? ` · ${notes.join(' · ')}` : ''}</span>
        <span class="form-row" style="gap:8px"><button class="btn plain" type="button" data-trayclear style="min-height:36px">Clear ticks</button>
        <button class="btn" type="button" data-traysee style="min-height:36px" ${ready.length ? '' : 'disabled'}>Match ${ready.length} pair${ready.length === 1 ? '' : 's'} on save…</button></span></div>`}
      <div class="note">Made when you save the shift; Undo until then.${addTo ? ' Tick a credit or bill to add it to the pair marked.' : ''}</div></div>`.__html;
    const at = (el, k) => pairs[Number(el.dataset[k])];
    box.querySelectorAll('[data-traypick]').forEach((sel) => sel.addEventListener('change', () => {
      const p = at(sel, 'traypick');
      if (sel.value) pick.set(p, sel.value); else pick.delete(p);
      draw();
    }));
    box.querySelectorAll('[data-traybig]').forEach((x) => x.addEventListener('click', () => {
      const p = at(x, 'traybig');
      if (pick.get(p) === x.dataset.v) pick.delete(p); else pick.set(p, x.dataset.v);
      draw();
    }));
    box.querySelectorAll('[data-trayadd]').forEach((x) => x.addEventListener('click', () => { const p = at(x, 'trayadd'); addTo = addTo === p ? null : p; draw(); }));
    box.querySelectorAll('[data-trayout]').forEach((x) => x.addEventListener('click', () => {
      const p = at(x, 'trayout');
      [...p.credits, ...p.bills].forEach((it) => { const t = tickBox(it.id); if (t) t.checked = false; });
      pairs = pairs.filter((y) => y !== p); pick.delete(p); if (addTo === p) addTo = null;
      refresh();
    }));
    box.querySelector('[data-trayclear]')?.addEventListener('click', () => {
      root.querySelectorAll('[data-tside]').forEach((c) => { c.checked = false; });
      pairs = []; pick.clear(); addTo = null;
      refresh();
      root.dispatchEvent(new Event('change'));
    });
    box.querySelector('[data-traysee]')?.addEventListener('click', () => { preview = true; draw(); });
    box.querySelector('[data-trayback]')?.addEventListener('click', () => { preview = false; draw(); });
    box.querySelector('[data-traygo]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const undos = [];
      try {
        // The register first (rows added or written), so each bill takes its payment; then every match at once.
        for (const p of ready) {
          const t = tOf(p);
          const b = p.bills[0];
          if (t.kind === 'parts') undos.push(await writeBankOnRow(biz, b, p.credits));
          else if ((t.kind === 'exact' || t.kind === 'gap' || t.kind === 'big') && !b.rowId) {
            const r = await apiFull('POST', `/businesses/${biz.id}/comparisons/${b.id}/add-paid`, { mode, sourceId: p.credits[0].id, allowGap: t.kind === 'big', fix: pick.get(p) === 'fix' });
            undos.push(() => apiFull('DELETE', `/businesses/${biz.id}/register-rows/${r.rowId}`, {}));
          } else if (t.kind === 'gap' || t.kind === 'big') undos.push(await writeBankOnRow(biz, b, [p.credits[0]], { fix: pick.get(p) === 'fix', mode }));
        }
        // "Bill was ₹ X" on a bill the software has at another amount: the payment proves the register (11 Nov 2026).
        // A tip or discount written on the row does the same when the software has the bill at what was paid
        // (18 Nov 2026): the register now differs from it, and the bill takes the payment only as Use register.
        const fixed = ready.filter((p) => p.bills[0].rowId && (pick.get(p) === 'fix' || ['gap', 'big', 'parts'].includes(tOf(p).kind)));
        if (fixed.length) {
          const cmps = (await api('GET', `/businesses/${biz.id}/shifts/${day}`)).comparisons;
          for (const p of fixed) {
            const c = cmps.find((x) => x.id === p.bills[0].id);
            if (!c || c.difference === 'match' || c.difference === 'complimentary' || c.decision === 'use_register') continue;
            const got = p.credits.reduce((a, x) => a + x.amountPaise, 0);
            const d = tOf(p).diff ?? 0;
            const why = pick.get(p) === 'fix' ? `the bill was ₹ ${money(got)}` : d > 0 ? `₹ ${money(d)} tip` : d < 0 ? `₹ ${money(-d)} discount` : 'paid in parts';
            await apiFull('PUT', `/businesses/${biz.id}/comparisons/${c.id}`, { decision: 'use_register', note: `${card ? 'Card machine' : 'Bank'} ₹ ${money(got)} at ${hhmm(p.credits[0].postedAt)}: ${why}` });
            undos.push(() => apiFull('PUT', `/businesses/${biz.id}/comparisons/${c.id}`, { decision: c.decision ?? null, note: c.note ?? undefined }));
          }
        }
        const matches = ready.filter((p) => tOf(p).kind !== 'parts').map((p) => ({ credit: p.credits[0], bills: p.bills }));
        const res = matches.length ? await post(matches) : { ids: [] };
        const undo = async () => {
          await eachAtOnce(res.ids ?? [], (id) => apiFull('DELETE', `/businesses/${biz.id}/shifts/${day}/choices/${id}`, {}).catch(() => {}));
          for (const u of undos.reverse()) await u();
        };
        await reload();
        doneToast(`${ready.length} pair${ready.length === 1 ? '' : 's'} ${writes.length ? 'written on the register and ' : ''}matched when you save the shift.`, undo, reload);
      } catch (err) {
        for (const u of undos.reverse()) await u().catch(() => {});
        btn.disabled = false; showError(q('msg'), err);
        q('msg').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  };
}
// fix: the bill's amount was misread, so the amount moves to what the bank got and the discount stays (tray, 10 Nov 2026).
async function writeBankOnRow(biz, b, credits, { fix = false, mode = 'upi', amountPaise = null } = {}) {
  const base = `/businesses/${biz.id}`;
  const u = await api('GET', `${base}/uploads/${b.uploadId}`);
  const r = u.rows.find((x) => x.id === b.rowId);
  if (!r) throw new Error(`Bill ${b.billNo}'s row was not found. Reload the page.`);
  if (r.paidWithRowId) throw new Error(`Bill ${b.billNo} is paid together with another row: correct the payment there.`);
  const norm = (x) => (x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // mode 'card': a machine payment written on the row the same way (card tray, 10 Nov 2026).
  const upi = r.payments.filter((p) => p.mode === mode);
  const others = r.payments.filter((p) => p.mode !== mode);
  const labelFor = (c) => { if (mode !== 'upi') return upi[0]?.columnLabel ?? 'Card'; const had = upi.find((p) => !c.label || norm(p.columnLabel) === norm(c.label) || norm(p.columnLabel) === 'upi'); return had ? had.columnLabel : c.label ?? upi[0]?.columnLabel ?? 'UPI'; };
  const paid = others.reduce((t, p) => t + p.amountPaise, 0) + credits.reduce((t, c) => t + c.amountPaise, 0);
  const payload = { paidWithRowId: null, billNo: r.billNo, billType: r.billType, amount: rupeesForInput(r.amountPaise), discount: rupeesForInput(r.discountPaise), remarks: r.remarks, status: r.status,
    payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })) };
  const put = (x) => apiFull('PUT', `${base}/register-rows/${r.id}`, x);
  const kept = r.discountPaise;
  // amountPaise: the software's bill stands (Stage 6): the row takes its amount, and amount − paid is the discount.
  await put({ ...payload, ...(amountPaise != null ? { amount: rupeesForInput(amountPaise), discount: rupeesForInput(amountPaise - paid) } : fix ? { amount: rupeesForInput(paid + kept), discount: rupeesForInput(kept) } : { discount: rupeesForInput(r.amountPaise - paid) }),
    payments: [...others.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })),
      ...credits.map((c) => ({ mode, columnLabel: labelFor(c), amount: rupeesForInput(c.amountPaise) }))] });
  return () => put(payload);
}
function suggestionCard(c, day) {
  return html`<div class="rv-card" data-card="${c.key}">
    <div class="lane-h"><span style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><strong>${c.title}</strong>${(c.billNos ?? []).filter(Boolean).map((b) => drawerBtn(b, day))}</span>
      <span class="tchip ${c.score >= 75 ? 'ok' : 'warn'}">${CARD_TAGS[c.kind] ?? 'Check'}</span></div>
    ${c.witnesses ? html`<div class="wit3">${witnessHtml('Software', c.witnesses.software, c.witnesses.odd === 'software')}${witnessHtml('Register', c.witnesses.register, c.witnesses.odd === 'register')}${witnessHtml('Bank', c.witnesses.bank, c.witnesses.odd === 'bank')}</div>` : ''}
    <ul class="note" style="margin:0;padding-left:18px">${c.evidence.map((e) => html`<li>${e}</li>`)}</ul>
    <div class="form-row" style="gap:6px">${c.actions.map((a, i) => a.href ? html`<a class="btn ${a.primary ? '' : 'plain'}" style="display:inline-flex;align-items:center;min-height:36px" href="${a.href}">${a.label}</a>`
      : html`<button class="btn ${a.primary ? '' : 'plain'}" type="button" data-cardact="${c.key}" data-i="${i}" style="min-height:36px">${a.label}</button>`)}
      <button class="btn plain" type="button" data-carddismiss="${c.key}" style="min-height:36px" title="Hide this suggestion on this device">Not this</button></div>
    <div class="form-msg"></div></div>`;
}
// Suggestions grouped by what you do (approved 20 Nov 2026): one heading and one reason per kind, one line per bill,
// the three sources as chips (the odd one struck), a button that names the result, and a quiet ✕.
const SG_GROUPS = [
  ['bank', 'The bank settles it', "the bank's credit shows which side is right", ['bank_backs']],
  ['number', 'Wrong bill number', 'check the number against the photo first', ['number_typo', 'register_slip']],
  ['written', 'Register written differently', 'the money came in another way than the register says', ['wrong_column', 'discount_not_given', 'change_in_cash', 'payment_written_wrong']],
  ['together', 'Paid together or in parts', 'one payment for several bills, or one bill in several payments', ['one_credit_many_bills', 'paid_in_parts', 'clear_matches']],
  ['same', 'Booked directly earlier', 'money booked before its bill came', ['same_sale']],
  ['nocredit', 'UPI bill, no credit in the bank', 'paid another way, or still on its way', ['no_upi_credit']],
  ['nobill', 'Money with no bill', 'a sale not written down, or money that is not a sale', ['no_bill']],
  ['planned', 'Planned on a later shift', 'its money is chosen there, matched when that shift is saved', ['planned_later']],
];
const sgParse = (v) => { const m = /₹\s?([\d,]+(?:\.\d+)?)(?:\s·\s(\w+))?/.exec(v ?? ''); return m ? { amt: m[1].replace(/\.00$/, ''), mode: m[2] ?? null } : null; };
/** A bank-backs button that says what pressing does: the amount counted, or the way it was paid. */
function sgLabel(c, a, i) {
  if (c.kind !== 'bank_backs' || i !== 0 || !c.witnesses) return a.label;
  const keep = c.witnesses.odd === 'software' ? c.witnesses.register : c.witnesses.software;
  const drop = c.witnesses.odd === 'software' ? c.witnesses.software : c.witnesses.register;
  const k = sgParse(keep); const d = sgParse(drop);
  if (!k || !d) return a.label;
  if (k.amt !== d.amt) return `Count ₹ ${k.amt}`;
  if (k.mode && k.mode !== d.mode) return `Make it ${MODE_LABELS[k.mode] ?? k.mode}`;
  return a.label;
}
function sgChips(c) {
  const w = c.witnesses;
  if (!w) return '';
  const chip = (label, v, odd) => (v == null ? '' : html`<span class="sg-src ${odd ? 'bad' : w.odd ? 'ok' : ''}">${label} ${v.replace(/\.00\b/g, '').replace(/ · (upi|card|cash|mixed)\b/g, (_, m) => ` · ${MODE_LABELS[m] ?? m}`)}</span>`);
  return html`${chip('Software', w.software, w.odd === 'software')}${chip('Register', w.register, w.odd === 'register')}${chip('Bank', w.bank, w.odd === 'bank')}`;
}
/** The middle of a line: the chips, else the amount and time, else the title; the reasons under Why. */
function sgMiddle(c) {
  const chips = sgChips(c);
  if (c.kind === 'no_upi_credit') {
    const amt = /\(₹\s?([\d,.]+)\)/.exec(c.title)?.[1]?.replace(/\.00$/, '');
    const at = /around ([^.]+)\./.exec(c.evidence?.[0] ?? '')?.[1];
    return html`<span>₹ ${amt ?? ''}${at ? ` · ${at}` : ''}</span>`;
  }
  const head = c.kind === 'no_bill' || (chips && (c.billNos ?? []).length) ? '' : html`<span class="sg-t">${c.title}</span>`;
  return html`${head}${chips ? html`<span class="sg-chips">${chips}</span>` : ''}${(c.evidence ?? []).length ? html`<details class="sg-why"><summary>Why</summary><ul>${c.evidence.map((e) => html`<li>${e}</li>`)}</ul></details>` : ''}`;
}
// Same sale (approved 21 Nov 2026): the money on one side, the bill on the other, what is wrong now and what the button does.
const ssDay = (d) => dayLabel(d).replace(/\s\d{4}$/, '');
const ssWhen = (ms) => `${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date(ms))}, ${hhmm(ms)}`;
const ssRs = (p) => `₹${money(p).replace(/\.00$/, '')}`;
function sameSaleRow(c, ctx) {
  const { credit: m, bill: b, counted, trial, others } = c.same;
  const a = c.actions.find((x) => x.primary) ?? c.actions[0];
  const ai = c.actions.indexOf(a);
  const bookedDay = ssDay(m.day);
  const left = ctx?.billsLeftPaise;
  if (c.same.chosen) return sameSaleChosen(c);
  const after = [`One sale, on ${bookedDay}, matched to this bill.`,
    ...(b.headName && m.headName && b.headName !== m.headName ? [`It moves from ${m.headName} to ${b.headName}.`] : []),
    ...(left != null && left >= b.amountPaise && b.day === ctx.day ? [`${ssDay(b.day)}: not in the bank yet ${ssRs(left)} → ${ssRs(left - b.amountPaise)}.`] : []),
    ...(trial ? ['Done when you save the shift.'] : [])].join(' ');
  const amounts = [b.rgPaise != null ? `Register ${ssRs(b.rgPaise)}` : '', b.swPaise != null ? `Software ${ssRs(b.swPaise)}` : ''].filter(Boolean).join(' · ');
  return html`<div class="ss-card" data-card="${c.key}">
    <div class="ss-pair">
      <div class="ss-side"><div class="tiny">${bookedDay} shift · ${m.advance ? 'advance came' : 'money came'}</div>
        <div class="ss-amt">${ssRs(m.amountPaise)}</div>
        <div class="tiny">Bank · ${ssWhen(m.postedAt)}</div>${m.accountName ? html`<div class="tiny">${m.accountName}</div>` : ''}
        <span class="ss-tag">${m.advance ? 'Booked as an advance' : `Booked as ${m.headName ?? 'a sale'}, no bill`}</span></div>
      <div class="ss-mid"><span>same money?</span><span class="ss-arrow" aria-hidden="true">⇄</span></div>
      <div class="ss-side"><div class="tiny">${ssDay(b.day)} shift · bill came</div>
        <div class="ss-amt">${ssRs(b.amountPaise)}</div>
        <div class="tiny">Bill <button type="button" class="linkbtn mono" data-bill-drawer="${b.billNo}|${b.day}" title="Everything about this bill">${b.billNo}</button>${b.paidAt ? ` · ${hhmm(b.paidAt)}` : ''}</div>
        ${amounts ? html`<div class="tiny">${amounts}</div>` : ''}
        <span class="ss-tag wait">Waiting for money</span></div>
    </div>
    <div class="ss-now">
      <div class="ss-bad"><strong>Now</strong>${counted ? `One ${ssRs(b.amountPaise)} sale shows twice. ` : ''}The bill waits for money that already came.</div>
      <div class="ss-good"><strong>After Same sale</strong>${after}</div>
    </div>
    ${others ? html`<div class="tiny error">${others} other bill${others === 1 ? '' : 's'} of this amount on this shift: check the number first.</div>` : ''}
    <div class="ss-acts"><button class="btn plain dchip" type="button" data-carddismiss="${c.key}" title="Not the same: hide it on this device">Not the same</button>
      ${a ? html`<button class="btn dchip" type="button" data-cardact="${c.key}" data-i="${ai}">${a.label}</button>` : ''}</div>
    <div class="form-msg"></div></div>`;
}
// The other suggestion cards side by side (approved 21 Nov 2026): the money on the left, the bill's two sides on the
// right, what is wrong now and what the blue button does; every button says what it does.
const ssMode = (s) => (s ? `${MODE_LABELS[s.mode] ?? s.mode} ${ssRs(s.amountPaise)}` : '—');
const ssBill = (no, day) => html`<button type="button" class="linkbtn mono" data-bill-drawer="${no}|${day ?? ''}" title="Everything about this bill">${no}</button>`;
const ssGap = (a, b) => { const m = Math.round(Math.abs(a - b) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const ssActs = (c, skip) => html`${c.actions.map((a, i) => (skip?.(a) ? '' : a.href ? html`<a class="btn plain dchip" href="${a.href}">${a.label}</a>`
  : html`<button class="btn ${a.primary ? '' : 'plain'} dchip" type="button" data-cardact="${c.key}" data-i="${i}">${a.label}</button>`))}`;
function sameSaleChosen(c) {
  const { credit: m, bill: b } = c.same;
  return html`<div class="ss-card" data-card="${c.key}">
    <div class="ss-pair">
      <div class="ss-side"><div class="tiny">${ssDay(m.day)} shift · money came</div><div class="ss-amt">${ssRs(m.amountPaise)}</div>
        <div class="tiny">UPI · ${ssWhen(m.postedAt)}</div>${m.accountName ? html`<div class="tiny">${m.accountName}</div>` : ''}
        <span class="ss-tag">${m.advance ? 'Booked as an advance' : `Booked as ${m.headName ?? 'a sale'}`}</span></div>
      <div class="ss-mid"><span>same sale</span><span class="ss-arrow" aria-hidden="true">⇄</span>${b.paidAt ? html`<span>${ssGap(m.postedAt, b.paidAt)} ${m.postedAt < b.paidAt ? 'before' : 'after'}</span>` : ''}</div>
      <div class="ss-side"><div class="tiny">${ssDay(b.day)} shift · bill ${ssBill(b.billNo, b.day)}${b.paidAt ? ` · ${hhmm(b.paidAt)}` : ''}</div>
        <div class="ss-amt">${ssRs(b.amountPaise)}</div>
        ${b.rgPaise != null ? html`<div class="tiny">Register ${ssRs(b.rgPaise)}${b.rgPaise === m.amountPaise ? ' ✓' : ''}</div>` : ''}
        ${b.swPaise != null ? html`<div class="tiny">Software ${ssRs(b.swPaise)}${b.swPaise === m.amountPaise ? ' ✓' : ''}</div>` : ''}
        <span class="ss-tag chosen">Chosen · done on save</span></div>
    </div>
    <div class="ss-now">
      <div class="ss-bad"><strong>Now</strong>${ssRs(m.amountPaise)} shows twice: in ${m.advance ? 'the advance' : m.headName ?? 'the booking'} and in the bill.</div>
      <div class="ss-good"><strong>On save</strong>The ${m.advance ? 'advance' : `${m.headName ?? ''} booking`} comes off. The bill counts ${ssRs(b.amountPaise)}, matched to the ${hhmm(m.postedAt)} credit.</div>
    </div>
    <div class="ss-acts">${ssActs(c)}</div><div class="form-msg"></div></div>`;
}
const SS_USE = { free: 'Not used', bill: 'matched to bill', pick: 'for bill', booked: 'booked as', ignored: 'set aside' };
function noCreditRow(c) {
  const L = c.look; const b = L.bill;
  const amt = ssRs(L.amountPaise);
  const at = b.paidAt;
  const useLine = (x) => (x.use === 'free' ? 'not used yet' : x.use === 'bill' ? html`matched to bill ${ssBill(x.bills ?? '', '')}`
    : x.use === 'pick' ? html`for bill ${ssBill(x.bills ?? '', b.day)} on save` : x.use === 'booked' ? `booked as ${x.headName ?? 'income'}${x.note ? ` · "${x.note}"` : ''}` : 'set aside, not a sale');
  const rel = (x) => (at ? ` · ${ssGap(x.postedAt, at)} ${x.postedAt < at ? 'before' : 'after'} the bill` : '');
  const free = L.credits.some((x) => x.use === 'free');
  const booked = L.credits.find((x) => x.use === 'booked');
  const prim = c.actions.find((a) => a.primary);
  const after = !prim ? '' : prim.method === 'POST' ? `The ${booked?.headName ?? ''} booking comes off. The ${amt} pays the bill's UPI${L.mixed ? ' part; the cash part stays in the drawer' : ''}. Done when you save the shift.`
    : prim.op === 'setMode' ? `The bill counts ${prim.label.replace(/^It was /, '')} instead of UPI. Nothing waits for the bank.`
    : `The bill counts ${prim.label.replace(/^It was /, '').replace(/ \(software\)$/, '')}, as the software says. Nothing waits for the bank.`;
  return html`<div class="ss-card" data-card="${c.key}">
    <div class="ss-pair">
      <div class="ss-side"><div class="tiny">${amt} UPI credits nearest the bill</div>
        ${L.credits.length ? html`<div class="ss-list">${L.credits.map((x) => html`<div><strong>${hhmm(x.postedAt)}</strong>${new Date(x.postedAt).toDateString() !== new Date(at ?? x.postedAt).toDateString() ? ` ${ssWhen(x.postedAt).split(',')[0]}` : ''} · <span class="tiny">${useLine(x)}${rel(x)}</span></div>`)}</div>` : ''}
        <span class="ss-tag">${free ? `A free ${amt} is in the bank` : `No free ${amt} from ${hhmm(L.from)} to ${hhmm(L.to)}`}</span></div>
      <div class="ss-mid"><span>${booked && !free ? 'booked' : 'no money'}</span><span class="ss-arrow" aria-hidden="true">⇢</span><span>for it</span></div>
      <div class="ss-side"><div class="tiny">${ssDay(b.day)} shift · bill ${ssBill(b.billNo, b.day)}${at ? ` · ${hhmm(at)}` : ''}</div>
        <div class="ss-rows"><span class="tiny">Register</span><strong>${ssMode(b.register)}</strong><span class="tiny">Software</span><strong>${ssMode(b.software)}</strong></div>
        <span class="ss-tag wait">Waiting for ${amt} UPI${L.mixed ? ' (its UPI part)' : ''}</span></div>
    </div>
    <div class="ss-now">
      <div class="ss-bad"><strong>Now</strong>Bookr counts UPI ${amt} that ${booked && !free ? 'is already booked elsewhere' : 'is not in the bank'}.${L.mixed ? '' : ' Cash is not counted for this bill.'}</div>
      ${after ? html`<div class="ss-good"><strong>After "${prim.label}"</strong>${after}</div>` : html`<div class="ss-good"><strong>Wait</strong>If the credit is still on its way, leave it: it pairs when the statement has it.</div>`}
    </div>
    <div class="ss-acts"><button class="btn plain dchip" type="button" data-carddismiss="${c.key}" title="Leave it for a later bank statement (hidden on this device)">Wait for the bank</button>${ssActs(c)}</div>
    <div class="form-msg"></div></div>`;
}
function bankBacksRow(c) {
  const L = c.look;
  const sw = L.software; const rg = L.register;
  const ok = (side) => (L.backs === side ? html` <span class="ss-ok">✓ same as bank</span>` : html` <span class="ss-no">✕</span>`);
  const said = (s) => ssMode(s);
  const backed = L.backs === 'software' ? sw : rg;
  const other = L.backs === 'software' ? rg : sw;
  const labels = c.actions.map((a) => (a.href ? a.label : a.body?.decision === `use_${L.backs}` ? `It was ${said(backed)}` : `It was ${said(other)}`));
  return html`<div class="ss-card" data-card="${c.key}">
    <div class="ss-pair">
      <div class="ss-side"><div class="tiny">Money came</div>
        <div class="ss-amt">${ssRs(L.credit.amountPaise)}</div><div class="tiny">UPI · ${hhmm(L.credit.postedAt)}${L.credit.accountName ? ` · ${L.credit.accountName}` : ''}</div>
        <span class="ss-tag">Not used yet</span></div>
      <div class="ss-mid">${L.paidAt ? html`<span>${ssGap(L.credit.postedAt, L.paidAt)}</span><span class="ss-arrow" aria-hidden="true">⇄</span><span>${L.credit.postedAt < L.paidAt ? 'before' : 'after'}</span>` : html`<span class="ss-arrow" aria-hidden="true">⇄</span>`}</div>
      <div class="ss-side"><div class="tiny">Bill ${ssBill(L.billNo, '')}${L.paidAt ? ` · ${hhmm(L.paidAt)}` : ''}</div>
        <div class="ss-rows"><span class="tiny">Software</span><span><strong>${said(sw)}</strong>${sw ? ok('software') : ''}</span><span class="tiny">Register</span><span><strong>${said(rg)}</strong>${rg ? ok('register') : ''}</span></div>
        ${(L.warn ?? []).map((w) => html`<div class="tiny ss-warn">${w}</div>`)}</div>
    </div>
    <div class="ss-now">
      <div class="ss-bad"><strong>Now</strong>Undecided. The ${ssRs(L.credit.amountPaise)} credit has no bill${other && other.mode === 'cash' ? `, and the cash drawer expects ${ssRs(other.amountPaise)} for this bill` : ''}.</div>
      <div class="ss-good"><strong>After "${labels[0]}"</strong>The bill counts ${said(backed)}, matched to the ${hhmm(L.credit.postedAt)} credit.${other && other.mode === 'cash' ? ` The drawer expects ${ssRs(other.amountPaise)} less.` : ''}</div>
    </div>
    <div class="ss-acts"><button class="btn plain dchip" type="button" data-carddismiss="${c.key}" title="Not this: hide it on this device">Not this</button>
      ${c.actions.map((a, i) => (a.href ? html`<a class="btn plain dchip" href="${a.href}">${a.label}</a>` : '')).filter(Boolean)}
      ${c.actions.map((a, i) => (a.href ? '' : html`<button class="btn ${a.primary ? '' : 'plain'} dchip" type="button" data-cardact="${c.key}" data-i="${i}">${labels[i]}</button>`)).reverse()}</div>
    <div class="form-msg"></div></div>`;
}
function sgRow(c, day, ctx) {
  if (c.kind === 'same_sale' && c.same) return sameSaleRow(c, ctx);
  if (c.kind === 'no_upi_credit' && c.look) return noCreditRow(c);
  if (c.kind === 'bank_backs' && c.look) return bankBacksRow(c);
  const bills = (c.billNos ?? []).filter(Boolean);
  const lead = bills.length ? bills.map((b) => html`<button type="button" class="linkbtn mono sg-bill" data-bill-drawer="${b}|${day ?? ''}" title="Everything about this bill">${b}</button>`) : c.kind === 'no_bill' ? html`<span class="sg-t">${c.title.replace(/ with no bill$/, '')}</span>` : '';
  const wait = c.kind === 'no_upi_credit';
  return html`<div class="sg-row" data-card="${c.key}"><div class="sg-lead">${lead}</div><div class="sg-mid">${sgMiddle(c)}</div>
    <div class="sg-acts">${c.actions.map((a, i) => a.href ? html`<a class="btn ${i === 0 ? '' : 'plain'} dchip" href="${a.href}">${a.label}</a>`
      : html`<button class="btn ${a.primary ? '' : 'plain'} dchip" type="button" data-cardact="${c.key}" data-i="${i}">${sgLabel(c, a, i)}</button>`)}
      <button class="btn plain dchip sg-x" type="button" data-carddismiss="${c.key}" title="${wait ? 'Leave it for a later bank statement (hidden on this device)' : 'Not this: hide it on this device'}" aria-label="${wait ? 'Wait' : 'Not this'}">${wait ? 'Wait' : '✕'}</button></div>
    <div class="form-msg"></div></div>`;
}
function suggestionList(cards, day, ctx) {
  if (!cards.length) return '';
  const known = new Set(SG_GROUPS.flatMap((g) => g[3]));
  const groups = [...SG_GROUPS, ['other', 'Other checks', '', []]].map(([id, title, sub, kinds]) => [id, title, sub,
    cards.filter((c) => (id === 'other' ? !known.has(c.kind) : kinds.includes(c.kind)))]).filter((g) => g[3].length);
  return html`${groups.map(([id, title, sub, list]) => {
    const all = id === 'bank' && list.length > 1 && list.every((c) => c.actions?.[0] && !c.actions[0].href && c.actions[0].op !== 'pick');
    return html`<section class="sg-group left-box" data-sg="${id}"><div class="sg-h"><strong>${title} (${list.length})</strong>${sub ? html`<span class="tiny">${sub}</span>` : ''}<span class="lo-fill"></span>
      ${all ? html`<button class="btn dchip" type="button" data-cardall="${list.map((c) => c.key).join('|')}">Accept all ${list.length}</button>` : ''}</div>
      ${list.map((c) => sgRow(c, day, ctx))}<div class="form-msg" data-sgmsg></div></section>`;
  })}`;
}
// Statement tab (approved 21 Nov 2026): every bank line of the shift, all accounts and modes, with what each is used for
// now, the draft included (matches made on save). An amount is also looked for a day either side.
const STMT_KIND = { upi_in: 'UPI in', upi_out: 'UPI out', upi_fee: 'UPI fee', reversal: 'Reversal', card_settlement: 'Card settlement', card_purchase: 'Card purchase', other: 'Other' };
const statementPanel = (open) => html`<div data-rtop="stmt" ${open ? '' : 'hidden'}><section class="card" style="gap:10px">
  <div class="st-bar"><select id="stacc" aria-label="Account"><option value="">All accounts</option></select>
    <select id="stmode" aria-label="Mode"><option value="">All modes</option></select>
    <input id="stamt" type="text" inputmode="decimal" placeholder="Amount, e.g. 550" aria-label="Find an amount" style="width:160px">
    <span class="lo-fill"></span><span class="tiny" id="stsum"></span></div>
  <div class="seg" id="stuse" role="group" aria-label="Show"><button type="button" data-u="" class="on">All</button><button type="button" data-u="free">Not used</button><button type="button" data-u="bill">For bills</button><button type="button" data-u="booked">Booked</button><button type="button" data-u="none">Not sales</button></div>
  <div class="scroll"><table class="st-t"><colgroup><col style="width:96px"><col style="width:150px"><col style="width:120px"><col></colgroup>
    <thead><tr><th>Time</th><th>Mode</th><th class="amount">Amount</th><th>Used for${''}</th></tr></thead><tbody id="strows"><tr><td colspan="4" class="tiny">Loading…</td></tr></tbody></table></div>
  <div class="tiny note">From 8 am to 8 am. Matches marked "on save" are made when the shift is saved. An amount you type is also looked for a day either side.</div>
</section></div>`;
function statementUses(r, cv, near) {
  const use = new Map();
  const set = (id, v) => { if (id && !use.has(id)) use.set(id, v); };
  for (const k of r.choices ?? []) set(k.bankRowId, { k: 'pick', t: `Bill ${k.billNos.join(' + ')} · you picked, on save` });
  for (const c of r.fixes ?? []) if (c.key?.startsWith('same-sale-plan:')) set(c.key.slice('same-sale-plan:'.length), { k: 'pick', t: `Same sale as bill ${c.billNos[0]} · on save` });
  for (const x of r.clear ?? []) set(x.creditId, { k: 'bill', t: `Bill ${x.billNos.join(' + ')}${x.part ? ` · ${x.part}` : ''}${r.confirmed ? '' : ' · on save'}` });
  for (const g of cv?.paidGroups ?? []) if (g.bank?.creditId) set(g.bank.creditId, { k: 'bill', t: `Bills ${g.billNos.join(' + ')} · paid together${r.confirmed ? '' : ' · on save'}` });
  for (const p of near ?? []) set(p.credit.id, { k: 'free', t: `Not used · near bill ${p.bill.billNo ?? ''} (₹${money(p.bill.amountPaise).replace(/\.00$/, '')})` });
  return use;
}
function wireStatement(biz, day, uses, goUpi) {
  let data = null;
  let U = '';
  const rr = (p) => `₹${money(p).replace(/\.00$/, '')}`;
  const useOf = (x) => {
    const d = x.status === 'unmatched' || x.status === 'booked' ? uses.get(x.id) : null;
    if (d) return d;
    if (x.status === 'matched') return { k: 'bill', t: x.bills ? `Bill ${x.bills}` : 'Matched' };
    if (x.status === 'booked') return { k: 'booked', t: `Booked as ${x.headName ?? 'booked'}${x.note ? ` · ${x.note}` : ''}` };
    if (x.status === 'ignored') return { k: 'none', t: 'Ignored' };
    if (x.kind === 'upi_in') return { k: 'free', t: 'Not used · book it' };
    if (x.kind === 'card_settlement') return { k: 'none', t: 'Card machine payout · Card tab' };
    if (x.kind === 'upi_fee') return { k: 'none', t: 'UPI fee' };
    return { k: x.direction === 'DR' ? 'none' : 'free', t: x.direction === 'DR' ? 'Money out · Bank page' : 'Not used' };
  };
  const draw = () => {
    const a = document.getElementById('stacc').value;
    const m = document.getElementById('stmode').value;
    const q = document.getElementById('stamt').value.replace(/[₹,\s]/g, '');
    const fits = (x) => { if (!q) return true; const v = x.amountPaise / 100; return q.includes('.') ? Math.abs(v - Number(q)) < 0.005 : String(Math.floor(v)).startsWith(q); };
    const rows = data.rows.filter((x) => (x.inShift || q) && (!a || x.accountId === a) && (!m || x.kind === m) && fits(x) && (!U || useOf(x).k === U));
    const sign = (x) => (x.direction === 'DR' ? -1 : 1);
    document.getElementById('strows').innerHTML = rows.length ? html`${rows.map((x) => { const u = useOf(x); return html`<tr class="${x.inShift ? '' : 'st-out'}">
      <td>${hhmm(x.postedAt)}${x.inShift ? '' : html`<div class="tiny">${dayLabel(x.shiftDay).replace(/\s\d{4}$/, '')} shift</div>`}</td>
      <td>${STMT_KIND[x.kind] ?? x.kind}${a ? '' : html`<div class="tiny">${x.accountName}</div>`}</td>
      <td class="amount mono">${sign(x) < 0 ? '−' : ''}${rr(x.amountPaise)}</td>
      <td>${u.k === 'free' && x.inShift && x.kind === 'upi_in' ? html`<button type="button" class="st-chip u-free" data-stbook="1">${u.t}</button>` : html`<span class="st-chip u-${u.k}">${u.t}</span>`}</td></tr>`; })}`.__html
      : html`<tr><td colspan="4" class="tiny">${q ? `No line of ${q} from a day before the shift to a day after.` : 'No lines.'}</td></tr>`.__html;
    const inn = rows.filter((x) => x.direction !== 'DR').reduce((t, x) => t + x.amountPaise, 0);
    const out = rows.filter((x) => x.direction === 'DR').reduce((t, x) => t + x.amountPaise, 0);
    document.getElementById('stsum').textContent = `${rows.length} line${rows.length === 1 ? '' : 's'} · in ${rr(inn)} · out ${rr(out)}`;
    document.querySelectorAll('#strows [data-stbook]').forEach((b) => b.addEventListener('click', goUpi));
  };
  return async () => {
    if (data) return;
    try {
      data = await api('GET', `/businesses/${biz.id}/shifts/${day}/statement`);
    } catch (err) { document.getElementById('strows').innerHTML = html`<tr><td colspan="4" class="error">${err.message}</td></tr>`.__html; return; }
    const accSel = document.getElementById('stacc');
    accSel.insertAdjacentHTML('beforeend', html`${data.accounts.map((x) => html`<option value="${x.id}">${x.name}</option>`)}`.__html);
    const kinds = [...new Set(data.rows.filter((x) => x.inShift).map((x) => x.kind))];
    document.getElementById('stmode').insertAdjacentHTML('beforeend', html`${Object.keys(STMT_KIND).filter((k) => kinds.includes(k)).map((k) => html`<option value="${k}">${STMT_KIND[k]}</option>`)}`.__html);
    accSel.addEventListener('change', draw);
    document.getElementById('stmode').addEventListener('change', draw);
    document.getElementById('stamt').addEventListener('input', draw);
    document.querySelectorAll('#stuse [data-u]').forEach((b) => b.addEventListener('click', () => {
      U = b.dataset.u;
      document.querySelectorAll('#stuse [data-u]').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    }));
    draw();
  };
}
// Changes tab (approved 21 Nov 2026): every change to the shift, newest first, with who and when. Undo puts back what
// was there before, through the route that undoes that change; only the latest change to a bill can be undone.
const CHG_KIND = { decision: ['Decision', 'k-dec'], register: ['Register', 'k-reg'], money: ['Money', 'k-money'], comp: ['Complimentary', 'k-comp'], cash: ['Cash', 'k-cash'], shift: ['Shift', 'k-shift'] };
const CHG_STATE = { later: 'Changed again later: undo that first', gone: 'Already put back or changed', saved: 'Shift saved: reopen it to undo', none: '' };
const changesPanel = (open) => html`<div data-rtop="chg" ${open ? '' : 'hidden'}><section class="card" style="gap:6px">
  <div class="st-bar"><select id="chkind" aria-label="Kind"><option value="">All changes</option><option value="decision">Decisions</option><option value="register">Register edits</option><option value="money">Money (bookings, picks)</option><option value="comp">Complimentary</option><option value="cash">Cash</option></select>
    <select id="chwho" aria-label="Person"><option value="">Everyone</option></select>
    <input id="chbill" type="text" placeholder="Bill no." aria-label="Bill number" style="width:130px">
    <span class="lo-fill"></span><label class="tiny"><input type="checkbox" id="chauto"> Show Bookr's own</label></div>
  <div id="chrows"><div class="tiny">Loading…</div></div><div class="form-msg" id="chmsg"></div>
  <div class="tiny note">Newest first. Undo puts back what was there before. Only the latest change to a bill can be undone; a later change to the same bill is undone first.</div>
</section></div>`;
function wireChanges(biz, day, reload) {
  let data = null;
  const shiftOf = (ms) => new Date(ms + (5.5 - 8) * 3600e3).toISOString().slice(0, 10);
  const when = (ms) => (shiftOf(ms) === day ? hhmm(ms) : `${dayLabel(shiftOf(ms)).replace(/\s\d{4}$/, '')} ${hhmm(ms)}`);
  const first = (n) => (n ?? 'Bookr').split(' ')[0];
  // The same change to several bills at once (e.g. rows ticked together) is one line with Undo ▾.
  const group = (list) => {
    const out = [];
    for (const x of list) {
      const g = out.at(-1);
      if (g && g.action === x.action && g.userId === x.userId && g.text === x.text && Math.abs(g.at - x.at) < 3000 && x.bill && !g.items.some((y) => y.bill === x.bill)) g.items.push(x);
      else out.push({ ...x, items: [x] });
    }
    return out;
  };
  const undoBtn = (x, label = 'Undo') => html`<button class="btn plain dchip" type="button" data-chundo="${x.id}">${label}</button>`;
  const right = (g) => {
    const can = g.items.filter((x) => x.state === 'undo');
    if (g.items.length > 1 && can.length) return html`<details class="ch-more"><summary class="btn plain dchip">Undo ▾</summary><div class="ch-menu">
      ${can.map((x) => undoBtn(x, `Undo ${x.bill}`))}${can.length > 1 ? html`<button class="btn dchip" type="button" data-chundoall="${can.map((x) => x.id).join(',')}">Undo all ${can.length}</button>` : ''}</div></details>`;
    if (can.length) return undoBtn(can[0]);
    const st = g.items[0].state;
    return html`<span class="tiny ch-st" title="${CHG_STATE[st] ?? ''}">${st === 'gone' ? 'gone' : st === 'none' ? '—' : st === 'saved' ? 'saved' : 'later'}</span>`;
  };
  const draw = () => {
    const k = document.getElementById('chkind').value;
    const who = document.getElementById('chwho').value;
    const q = document.getElementById('chbill').value.trim();
    const auto = document.getElementById('chauto').checked;
    const list = data.items.filter((x) => (auto || !x.auto) && (!k || x.kind === k) && (!who || (x.userId ?? '') === who) && (!q || (x.bill ?? '').includes(q)));
    const rows = group(list);
    document.getElementById('chrows').innerHTML = rows.length ? html`${rows.map((g) => {
      const [kw, kc] = CHG_KIND[g.kind] ?? ['Other', 'k-shift'];
      const bills = g.items.map((x) => x.bill).filter(Boolean);
      const st = g.items.length === 1 && g.state !== 'undo' ? CHG_STATE[g.state] : '';
      return html`<div class="ch-row ${g.auto ? 'ch-auto' : ''}"><div class="ch-t">${when(g.at)}<br>${g.auto ? 'Bookr' : first(g.user)}</div>
        <div><span class="ch-k ${kc}">${kw}</span>${g.items.length > 1 ? html`${g.items.length} lines: ${g.text} <span class="tiny">· ${bills.join(', ')}</span>`
          : html`${g.bill ? html`<button type="button" class="linkbtn mono" data-bill-drawer="${g.bill}|${day}" title="Everything about this bill">${g.bill}</button> · ` : ''}${g.text}${g.times > 1 ? ` · ${g.times} times` : ''}`}
          ${g.sub ? html`<div class="tiny">${g.sub}</div>` : ''}${st && g.state !== 'none' ? html`<div class="tiny note">${st}</div>` : ''}</div>
        <div>${right(g)}</div></div>`; })}`.__html
      : html`<div class="tiny">${data.items.length ? 'No change fits these filters.' : 'No changes on this shift yet.'}</div>`.__html;
  };
  const undo = async (ids) => {
    const msg = document.getElementById('chmsg');
    msg.textContent = '';
    try {
      for (const id of ids) {
        const x = data.items.find((y) => y.id === Number(id));
        if (!x?.undo) continue;
        await apiFull(x.undo.method, `/businesses/${biz.id}${x.undo.path}`, x.undo.body);
      }
      await reload();
    } catch (err) { showError(msg, err); }
  };
  return async () => {
    if (data) return;
    try {
      data = await apiFull('GET', `/businesses/${biz.id}/shifts/${day}/changes`);
    } catch (err) { document.getElementById('chrows').innerHTML = html`<div class="error">${err.message}</div>`.__html; return; }
    const people = new Map(data.items.filter((x) => x.userId && !x.auto).map((x) => [x.userId, x.user ?? 'Someone']));
    document.getElementById('chwho').insertAdjacentHTML('beforeend', html`${[...people].map(([id, n]) => html`<option value="${id}">${n}</option>`)}`.__html);
    ['chkind', 'chwho', 'chauto'].forEach((id) => document.getElementById(id).addEventListener('change', draw));
    document.getElementById('chbill').addEventListener('input', draw);
    document.getElementById('chrows').addEventListener('click', (e) => {
      const one = e.target.closest('[data-chundo]');
      const many = e.target.closest('[data-chundoall]');
      if (!one && !many) return;
      (one ?? many).disabled = true;
      undo(one ? [one.dataset.chundo] : many.dataset.chundoall.split(','));
    });
    draw();
  };
}
const recTabs = (biz, day, tab) => html`<div class="seg rec-tabs" role="tablist" aria-label="Reconcile">
  <a role="tab" class="${tab === 'shift' ? 'on' : ''}" href="#/b/${biz.id}/reconcile${day ? `/${day}` : ''}">This shift</a>
  <a role="tab" class="${tab === 'all' ? 'on' : ''}" href="#/b/${biz.id}/reconcile/all">All unmatched</a></div>`;
const RECONCILE_VIEW_KEY = 'bookr.reconcile.view';
// The shift page opens on To do (approved 10 Nov 2026); a reload after a change stays on the tab in use.
let recTopNow = 'todo';
let recKeep = null;
// Before saving the shift, the left-over list by time comes first (17 Nov 2026) unless the person chose Suggestions.
const reconcileViewPref = (confirmed = true) => { try { const v = localStorage.getItem(RECONCILE_VIEW_KEY); return v === 'open' || v === 'cards' ? v : confirmed ? 'cards' : 'open'; } catch { return confirmed ? 'cards' : 'open'; } };

/** Save reconcile (approved 9 Nov 2026): what still stops saving, and the button. Saving books the shift's income and makes every match. */
function saveBar(biz, r) {
  const s = r.save ?? { blockers: [], canSave: false };
  const can = biz.actions.includes('sales.decide');
  return html`<section class="card" style="gap:8px;border-color:var(--teal)">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <div><strong>Not saved yet.</strong> <span class="note">Matches and decisions here are drafts. Save books the shift's income and makes every match; bills still waiting for the bank or the card machine can be matched after.</span></div>
      ${can ? html`<button class="btn" type="button" id="savereconcile" ${s.canSave ? '' : 'disabled'}>Save reconcile</button>` : html`<span class="note">Owner or Accountant saves.</span>`}
    </div>
    ${s.blockers.length ? html`<div class="cmp-warn"><strong>Before saving:</strong><ul style="margin:4px 0 0 18px">${s.blockers.map((b) => html`<li>${b}</li>`)}</ul></div>` : ''}
    <div class="form-msg" id="savemsg"></div></section>`;
}

/** Old POS bills still to decide (approved 9 Nov 2026): ticked, counted from the register in one click. */
function oldPosHtml(biz, r) {
  const list = r.oldPos?.bills ?? [];
  if (!list.length || r.confirmed) return '';
  const can = biz.actions.includes('sales.decide');
  const ready = list.filter((b) => b.reviewed);
  return html`<section class="card" id="oldpos" style="gap:8px">
    <div class="lane-h"><strong>Old POS bills: ${list.length}</strong><span class="tchip ok">Use register</span></div>
    <div class="note">Never in the software report, so they are counted from the register.${oldPosState(r.oldPos)}</div>
    <div class="scroll"><table style="min-width:420px"><tbody>${list.map((b) => html`<tr>
      <td style="width:36px">${b.reviewed && can ? html`<input type="checkbox" data-oldpos="${b.comparisonId}" data-kind="${b.kind}" checked aria-label="Use register for bill ${b.billNo}" style="width:18px;height:18px;min-height:0">` : ''}</td>
      <td class="mono">${b.billNo}${b.kind === 'short' ? html` <span class="tiny">last 3 digits${b.fullNo ? html`, probably ${b.fullNo}` : ''}</span>` : ''}</td>
      <td class="amount">${b.amountPaise != null ? money(b.amountPaise) : ''}</td>
      <td>${b.reviewed ? '' : html`<a class="tiny" href="#/b/${biz.id}/review/${b.uploadId}/${b.rowId}">Review the row first</a>`}</td></tr>`)}</tbody></table></div>
    ${can && ready.length ? html`<div class="form-row" style="gap:6px"><button class="btn" type="button" id="oldposgo" style="min-height:36px">Use register for ${ready.length} old POS bill${ready.length === 1 ? '' : 's'}</button></div>` : ''}
    <div class="form-msg" id="oldposmsg"></div></section>`;
}

/** Matches chosen before saving: made on Save, or undone here. */
function choicesHtml(r) {
  if (!r.choices?.length) return '';
  return html`<section class="card" style="gap:6px"><div class="lane-h"><strong>Matched on save</strong> <span class="chip">${r.choices.length}</span></div>
    ${r.choices.map((k) => html`<div class="ent-line"><div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><span class="mono"><strong>${k.billNos.join(' + ')}</strong></span>
      <span class="tiny">Bank ₹ ${money(k.amountPaise)} at ${when(k.postedAt)}${k.accountName ? ` · ${k.accountName}` : ''}${k.by ? ` · chosen by ${k.by}` : ''}</span>
      ${k.open ? '' : html`<span class="chip bad">credit taken elsewhere</span>`}
      <button class="btn plain dchip" type="button" data-unchoose="${k.id}" style="margin-left:auto">Undo</button></div></div>`)}
    <div class="note">These are made when you save the shift.</div></section>`;
}

const RECONCILE_TAB_KEY = 'bookr.reconcile.tab';
const reconcileTabPref = () => { try { const t = localStorage.getItem(RECONCILE_TAB_KEY); return ['cash', 'upi', 'card', 'comp'].includes(t) ? t : 'upi'; } catch { return 'upi'; } };
const ENTRY_MODE = { cash: 'Cash', upi: 'UPI', card: 'Card', mixed: 'Mixed' };

/** Every bill of the shift paid this way (approved 9 Nov 2026): register and software, what backs it, and each change as before → after. */
/** A change on a bill, as a short chip; the whole text, who and when are on hover (approved 10 Nov 2026). */
function editChip(x) {
  const t = x.text;
  const low = (v) => String(v).trim().replace(/\b(Cash|Card)\b/g, (m) => m.toLowerCase());
  let m;
  const said = /^(?:Mode differs|Amount differs|Amount and mode differ)[^(]*\(register ([^·]+)· software ([^)]+)\) → used the (register|software)/.exec(t);
  const plain = (m = /^Bill no\. read (\S+) → (\S+)/.exec(t)) ? `Bill no. fixed: ${m[1]} → ${m[2]}`
    : (m = /^Amount read (.+) → (.+)$/.exec(t)) ? `Amount fixed: ${m[1]} → ${m[2]}`
    : (m = /^Paid by read (.+) → (.+)$/.exec(t)) ? `Register read as ${low(m[1])}, corrected to ${low(m[2])}`
    : said ? `Software said ${low(said[2])}, register said ${low(said[1])}: kept ${said[3] === 'register' ? low(said[1]) : low(said[2])}`
    : /^Missing in the register → used the software/.test(t) ? 'Not in the register: counted from the software'
    : (m = /^([A-Za-z ]+) → ([A-Za-z ]+)(?: \(.*\))?$/.exec(t)) ? `Changed later: ${low(m[1])} → ${low(m[2])}`
    : null;
  if (said && low(said[1]) === low(said[2])) return '';
  if (plain) return html`<span class="chip wait" style="font-size:11px" title="${t}${x.by ? ` · ${x.by}` : ''}${x.at ? ` · ${when(x.at)}` : ''}">${plain}</span>`;
  const [label, cls] = /: to decide$/.test(t) ? ['To decide', 'bad'] : /^Bill no\. read/.test(t) ? ['No. corrected', 'wait'] : /^Amount read/.test(t) ? ['Amount corrected', 'wait']
    : /^Paid by read/.test(t) ? ['Mode corrected', 'wait'] : /old pos/i.test(t) ? ['Old POS', ''] : /used the register/i.test(t) ? ['Register used', '']
    : /used the software/i.test(t) ? ['Software used', ''] : /group's discount/i.test(t) ? ['Group discount', ''] : /complimentary/i.test(t) ? ['Complimentary', ''] : /^[A-Za-z ]+ → [A-Za-z ]+/.test(t) ? ['Mode changed', 'wait'] : ['Changed', ''];
  return html`<span class="chip ${cls}" style="font-size:11px" title="${t}${x.by ? ` · ${x.by}` : ''}${x.at ? ` · ${when(x.at)}` : ''}">✎ ${label}</span>`;
}

/**
 * The bills of one payment mode as a table (approved 10 Nov 2026), like All bills: one line a bill, what backs its money,
 * changes as chips, bills paid together as one line that opens. It opens on what is left; Done is a filter.
 */
function entriesHtml(biz, day, t, mode, cv) {
  const canDecide = biz.actions.includes('sales.decide');
  const side = (x) => (x ? html`${x.mode ? ENTRY_MODE[x.mode] ?? MODE_LABELS[x.mode] ?? x.mode : 'no mode'}` : html`<em class="note">missing</em>`);
  const received = (e) => (e.noMode ? html`<span style="color:#92400E">Mode not known: say how it was paid</span>` : e.evidence ? evidenceHtml(e.evidence)
    : e.state === 'waiting' ? html`<span style="color:#92400E">⏳ ${mode === 'upi' ? 'No bank credit yet' : mode === 'card' ? 'No machine payment yet' : 'Waiting'}</span>`
    : e.state === 'decide' ? html`<span class="note">Decide first</span>` : html`<span class="note">—</span>`);
  const action = (e) => {
    // Only a bill still undecided itself: in a group, bills already decided show no menu.
    const c = e.state === 'decide' && canDecide ? cv?.comparisons.find((x) => x.id === e.comparisonId) : null;
    return c && !c.decision && c.difference !== 'match' && c.difference !== 'complimentary' ? decideMenuHtml(c, cv) : '';
  };
  const row = (e, inGroup = '') => html`<tr data-pstate="${e.state}" ${inGroup ? html`data-pgroup="${inGroup}" hidden` : ''} class="${e.state === 'decide' ? 'undecided' : ''} ${inGroup ? 'grp-bill' : ''}">
    <td class="mono"><strong>${e.billNo ?? '—'}</strong>${e.part ? html` <span class="chip" style="font-size:11px">${e.part}</span>` : ''}${e.fromDay ? html` <span class="chip plan" style="font-size:11px">${dayLabel(e.fromDay)}</span>` : ''}
      <div class="tiny">${e.fromDay ? `bill of ${dayLabel(e.fromDay)}` : e.paidAt ? hhmm(e.paidAt) : 'register only'}${e.billNo ? html` · <button type="button" class="linkbtn tiny" data-bill-drawer="${e.billNo}|${e.fromDay ?? day}">Open row</button>` : ''}</div></td>
    <td class="amount">${money(e.amountPaise)}</td>
    <td>${side(e.register)} · ${side(e.software)}${e.edits.length ? html`<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:2px">${e.edits.map(editChip)}</div>` : ''}</td>
    <td style="white-space:normal">${inGroup ? '' : received(e)}</td></tr>
    ${action(e) ? html`<tr data-pstate="${e.state}" ${inGroup ? html`data-pgroup="${inGroup}" hidden` : ''} class="undecided"><td colspan="4" style="padding-top:0">${action(e)}</td></tr>` : ''}`;
  const groupRow = (es) => {
    const g = es[0].group;
    // The whole payment counts, in every mode: cash paid beside the UPI part is not a discount.
    const diff = g.billsPaise - (g.paidPaise ?? g.paymentPaise);
    const st = es.some((e) => e.state === 'decide') ? 'decide' : es[0].state;
    return html`<tr class="grp-head" data-pstate="${st}" data-pghead="${g.id}" tabindex="0" aria-expanded="false">
      <td><span class="chip">Paid together</span><div class="tiny mono" style="white-space:normal">${g.billNos.join(' + ')}</div></td>
      <td class="amount">${money(g.paymentPaise)}</td>
      <td class="tiny" style="white-space:normal">${(g.otherModes ?? []).length ? `${ENTRY_MODE[mode]} part of one payment (+ ${g.otherModes.map((o) => `₹ ${money(o.paise)} ${ENTRY_MODE[o.mode] ?? o.mode}`).join(' + ')})` : 'One payment'} for ${g.billNos.length} bills of ₹ ${money(g.billsPaise)}${diff > 0 ? ` (₹ ${money(diff)} discount)` : diff < 0 ? ` (₹ ${money(-diff)} tip)` : ''}</td>
      <td style="white-space:normal">${received(es[0])}<div class="tiny">Open to see each bill</div></td></tr>`;
  };
  const seen = new Set();
  // Bills with no mode on either side come first, under their own heading: not cash until a person says so.
  const unknown = t.entries.filter((e) => e.noMode);
  const SHOW = 3;
  const rows = [...(unknown.length ? [html`<tr data-pstate="decide"><td colspan="4" style="background:#FEF3C7;white-space:normal"><strong>Mode not known (${unknown.length}) · ₹ ${money(t.noModePaise ?? 0)}</strong>
    <span class="tiny" title="The software says U/N and the register does not have them. Not counted as cash until you say how each was paid.">· not counted as cash</span></td></tr>`,
    ...unknown.slice(0, SHOW).map((e) => row(e)),
    ...(unknown.length > SHOW ? [html`<tr data-unkmore><td colspan="4"><button type="button" class="btn plain dchip" data-showunk>Show ${unknown.length - SHOW} more</button></td></tr>`,
      ...unknown.slice(SHOW).map((e) => row(e, 'unk'))] : [])] : []),
    ...t.entries.filter((e) => !e.noMode).flatMap((e) => {
    if (!e.group) return [row(e)];
    if (seen.has(e.group.id)) return [];
    seen.add(e.group.id);
    const es = t.entries.filter((x) => x.group?.id === e.group.id);
    return [groupRow(es), ...es.map((x) => row(x, e.group.id))];
  })];
  const units = t.entries.filter((e) => !e.group).map((e) => e.state);
  for (const id of seen) { const es = t.entries.filter((x) => x.group?.id === id); units.push(es.some((e) => e.state === 'decide') ? 'decide' : es[0].state); }
  const nLeft = units.filter((x) => x !== 'done').length;
  const nDone = units.length - nLeft;
  const sum = (f) => t.entries.filter((e) => !e.noMode && f(e)).reduce((a, e) => a + (e.amountPaise ?? 0), 0);
  const filter = nLeft ? 'left' : 'all';
  // On the UPI tab the full list is for checking (17 Nov 2026): closed, as the work is above it.
  return html`<details class="card cmp-fold" ${t.left && mode !== 'upi' ? 'open' : ''}><summary><h2>${ENTRY_MODE[mode]} bills (${t.entries.length}) · ₹ ${money(t.totalPaise)}</h2></summary>
    ${t.entries.length ? html`<div class="paytable" data-pfilter="${filter}" style="display:flex;flex-direction:column;gap:8px">
      <span class="seg" role="group" aria-label="Show" style="align-self:flex-end">
        <button type="button" data-pf="left" class="${filter === 'left' ? 'on' : ''}">Left (${nLeft})</button><button type="button" data-pf="done">Done (${nDone})</button><button type="button" data-pf="all" class="${filter === 'all' ? 'on' : ''}">All (${units.length})</button></span>
      ${nLeft ? '' : html`<div class="ok-msg">Nothing left: every ${ENTRY_MODE[mode]} bill is done.</div>`}
      <div class="scroll"><table class="cmptable" style="min-width:600px">
        <colgroup><col style="width:150px"><col style="width:100px"><col style="width:180px"><col></colgroup>
        <thead><tr><th>Bill</th><th style="text-align:right">Amount</th><th>Register · Software</th><th>Money received</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="font-weight:600"><td>Total</td><td class="amount">${money(t.totalPaise)}</td><td></td>
          <td class="tiny">Received ₹ ${money(sum((e) => e.state === 'done'))} · waiting ₹ ${money(sum((e) => e.state === 'waiting'))}${sum((e) => e.state === 'decide') ? ` · to decide ₹ ${money(sum((e) => e.state === 'decide'))}` : ''}${t.noModePaise ? ` · mode not known ₹ ${money(t.noModePaise)}` : ''}</td></tr></tfoot>
      </table></div></div>`
      : html`<div class="note">No ${ENTRY_MODE[mode]} bills in this shift.</div>`}
</details>`;
}

/** What backs a bill's money; who found it as a chip (20 Nov 2026): Bookr's exact match, or a person's pick. */
function evidenceHtml(ev) {
  const m = / · (Bookr matches on save|chosen, matched on save|found by Bookr|picked)$/.exec(ev);
  if (!m) return html`<span style="color:var(--teal)">✓ ${ev}</span>`;
  return html`<span style="color:var(--teal)">✓ ${ev.slice(0, m.index)}</span> <span class="chip ok" style="font-size:11px">${/Bookr/.test(m[1]) ? 'exact match' : 'you picked'}</span>`;
}
/** Filters and paid-together lines of the payment tables. */

// UPI: the bank against Bookr (approved 20 Nov 2026). Three figures, then every credit of the 8 am to 8 am window split
// into this shift's bills, other days' bills, sales booked with no bill and what is not booked yet.
function upiBookHtml(r) {
  const s = r.strip;
  const b = r.upiBook;
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  const rp = (p) => `₹ ${money(p).replace(/\.00$/, '')}`;
  if (!b) return '';
  const dl = (d) => dayLabel(d).replace(/\s\d{4}$/, '');
  const elsewhere = b.elsewhere.reduce((t, x) => t + x.amountPaise, 0);
  const gap = s.upiSalesPaise - b.forBillsPaise;
  const rest = gap - elsewhere - s.billsLeftPaise;
  const gapPills = gap === 0 ? [html`<span class="chip ok">${r.confirmed ? 'same' : 'same, on save'}</span>`]
    : [elsewhere ? html`<span class="chip">${rp(elsewhere)} paid on another day</span>` : '',
      s.billsLeftPaise ? html`<span class="chip wait">${rp(s.billsLeftPaise)} not in the bank yet</span>` : '',
      rest ? html`<span class="chip wait">${rp(Math.abs(rest))} apart</span>` : ''];
  const reconciled = !b.left && !s.billsLeft && !rest;
  const otherDays = [...new Set(b.other.map((x) => x.day))];
  const otherLabel = b.other.length === 1 ? html`Paid early for ${dl(b.other[0].day)} <span class="tiny">${b.other[0].bills}</span>`
    : otherDays.length === 1 ? `For ${dl(otherDays[0])}'s bills` : 'For other days\' bills';
  const leftAmounts = (() => {
    const m = new Map();
    for (const x of r.noBill ?? []) m.set(x.amountPaise, (m.get(x.amountPaise) ?? 0) + 1);
    return m.size && m.size <= 3 && [...m.values()].some((c) => c > 1) ? [...m].map(([a, c]) => (c > 1 ? `${c} × ${rp(a)}` : rp(a))).join(' + ') : '';
  })();
  const why = [
    b.elsewhere.length ? `Paid on another day: ${b.elsewhere.map((x) => `${x.bills} ${rp(x.amountPaise)} on ${dl(x.day)}`).join(' · ')}` : '',
    b.other.length > 1 ? `For other days: ${b.other.map((x) => `${x.bills} ${rp(x.amountPaise)} (${dl(x.day)})`).join(' · ')}` : '',
  ].filter(Boolean);
  // A row opens its list on a saved shift (21 Nov 2026): the payments with their bills and Unmatch, the sales booked
  // with no bill and their Put back, the payments for other days' bills.
  const lists = r.confirmed;
  const opener = (key, label, n) => (lists && n ? html`<button type="button" class="linkbtn ub-open" data-ubopen="${key}" aria-expanded="false"><span class="ub-arrow">▸</span> ${label}</button>` : label);
  const sub = (key, rows) => (lists && rows.length ? html`<tr data-ubsub="${key}" hidden><td colspan="4" class="ub-sub"><table>${rows}</table></td></tr>` : '');
  const billsSub = sub('bills', r.done.map((x) => html`<tr><td class="mono">${x.bills.join(' + ')}</td><td>₹ ${money(x.creditPaise ?? x.billsPaise)}</td><td class="tiny">${when(x.postedAt)}</td>
    <td><button class="btn plain dchip" type="button" data-unmatch="${x.rowId}">Unmatch</button></td></tr>`));
  const bookedSub = sub('booked', (r.booked ?? []).map((x) => html`<tr><td>${x.headName ?? 'Booked'}${x.note ? html` <span class="tiny">· ${x.note}</span>` : ''}</td><td>₹ ${money(x.amountPaise)}</td><td class="tiny">${when(x.postedAt)}</td>
    <td><button class="btn plain dchip" type="button" data-putback="${x.id}">Undo</button></td></tr>`));
  const otherSub = sub('other', b.other.map((x) => html`<tr><td class="mono">${x.bills}</td><td>₹ ${money(x.amountPaise)}</td><td class="tiny">${when(x.postedAt)}</td><td class="tiny">${dl(x.day)} shift</td></tr>`));
  return html`<div class="ub-mets">
      <div class="ub-met"><div class="tiny">Bank got by UPI</div><div class="amount rec-n">${rp(b.totalPaise)}</div><div class="tiny">${n(b.payments, 'payment', 'payments')}, 8 am to 8 am</div></div>
      <div class="ub-met"><div class="tiny">UPI bills</div><div class="amount rec-n">${rp(s.upiSalesPaise)}</div><div class="tiny">${n(s.bills, 'bill', 'bills')}${s.billsLeft ? `, ${s.billsLeft} not in the bank yet` : ', all paid'}</div></div>
      <div class="ub-met ${b.left ? 'warn' : 'ok'}"><div class="tiny">Not booked yet</div><div class="amount rec-n">${rp(b.leftPaise)}</div><div class="tiny">${b.left ? (leftAmounts || n(b.left, 'payment', 'payments')) : 'UPI reconciled'}</div></div>
    </div>
    <div class="scroll"><table class="ub-table"><thead><tr><th></th><th>Bank</th><th>Bookr</th><th></th></tr></thead><tbody>
      <tr><td>${opener('bills', html`UPI bills <span class="tiny">${s.bills}</span>`, r.done.length)}</td><td>${rp(b.forBillsPaise)}${lists && r.done.length ? html`<div class="tiny">${n(r.done.length, 'payment', 'payments')}</div>` : ''}</td><td>${rp(s.upiSalesPaise)}</td><td>${gapPills}</td></tr>
      ${billsSub}
      ${b.other.length ? html`<tr><td>${opener('other', otherLabel, b.other.length)}</td><td>${rp(b.other.reduce((t, x) => t + x.amountPaise, 0))}</td><td>on ${otherDays.map(dl).join(', ')}</td><td><span class="chip">ok</span></td></tr>${otherSub}` : ''}
      ${b.cardPaise ? html`<tr><td>Card machine money</td><td>${rp(b.cardPaise)}</td><td>Card tab</td><td><span class="chip">ok</span></td></tr>` : ''}
      ${b.booked ? html`<tr><td>${opener('booked', html`Sales with no bill <span class="tiny">${b.booked}</span>`, (r.booked ?? []).length)}</td><td>${rp(b.bookedPaise)}</td><td>${rp(b.bookedPaise)}</td><td><span class="chip ok">same</span></td></tr>${bookedSub}` : ''}
      ${b.left ? html`<tr><td>Not booked yet <span class="tiny">${leftAmounts || b.left}</span></td><td>${rp(b.leftPaise)}</td><td>—</td><td><button type="button" class="chip wait" style="border:0;cursor:pointer" data-jump="${r.open ? 'trialopen' : 'nobill'}">book below ↓</button></td></tr>` : ''}
      <tr class="ub-tot"><td>Total</td><td>${rp(b.totalPaise)}</td><td>${rp(s.upiSalesPaise + b.other.reduce((t, x) => t + x.amountPaise, 0) + b.cardPaise + b.bookedPaise)}</td><td>${reconciled ? html`<span class="chip ok">✓ ${r.confirmed ? 'reconciled' : 'on save'}</span>` : b.left ? rp(b.leftPaise) : ''}</td></tr>
    </tbody></table></div>
    ${why.map((x) => html`<div class="tiny" style="color:var(--muted);margin-top:6px">${x}</div>`)}`;
}

function wirePayTables(root) {
  root.querySelectorAll('.paytable').forEach((box) => {
    const show = () => {
      const f = box.dataset.pfilter;
      const fits = (tr) => f === 'all' || (f === 'done' ? tr.dataset.pstate === 'done' : tr.dataset.pstate !== 'done');
      box.querySelectorAll('tbody tr:not([data-pgroup])').forEach((tr) => { tr.hidden = !fits(tr); });
      box.querySelectorAll('tr[data-pghead]').forEach((head) => {
        head.setAttribute('aria-expanded', head.classList.contains('open') ? 'true' : 'false');
        box.querySelectorAll(`tr[data-pgroup="${head.dataset.pghead}"]`).forEach((tr) => { tr.hidden = head.hidden || !head.classList.contains('open'); });
      });
    };
    box.querySelectorAll('[data-pf]').forEach((b) => b.addEventListener('click', () => {
      box.dataset.pfilter = b.dataset.pf;
      box.querySelectorAll('[data-pf]').forEach((x) => x.classList.toggle('on', x === b));
      show();
    }));
    box.querySelectorAll('tr[data-pghead]').forEach((head) => {
      const flip = () => { head.classList.toggle('open'); show(); };
      head.addEventListener('click', flip);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    });
    show();
  });
}

/**
 * The shift page for Entry staff and Viewers (approved 10 Nov 2026): All bills and Waiting, to look at. The server sends
 * them no bank data, and only Owner and Accountant can decide or save.
 */
async function reconcileReadOnly(biz, day) {
  const [{ shifts }, cv, cash, waiting] = await Promise.all([api('GET', `/businesses/${biz.id}/shifts`),
    api('GET', `/businesses/${biz.id}/shifts/${day}`), api('GET', `/businesses/${biz.id}/shifts/${day}/cash`),
    api('GET', `/businesses/${biz.id}/waiting`).catch(() => null)]);
  cv.reasons = cash.reasons;
  const reload = () => reconcileView(biz, day);
  drawerReload = reload;
  const P = compareParts(biz, day, cv, shifts, { reload, back: `#/b/${biz.id}/reconcile/${day}`, onReconcile: true });
  const top = recKeep?.day === day && recKeep.top === 'wait' ? 'wait' : 'all';
  recKeep = null;
  // The same Waiting card as To do (18 Nov 2026), without buttons. These roles get no bank data: UPI and card bills not
  // received come from the saved shift's Waiting; before saving only the cash is told.
  const oneSided = cv.comparisons.filter((c) => ['missing_in_register', 'missing_in_software'].includes(c.difference) && c.decision !== 'leave_out')
    .map((c) => ({ comparisonId: c.id, billNo: c.billNo, amountPaise: c.software?.amountPaise ?? c.register?.amountPaise ?? 0, mode: c.software?.mode ?? c.register?.mode ?? null,
      side: c.difference === 'missing_in_register' ? 'software' : 'register', otherDay: c.otherDay, oldPos: !!c.oldPos || /^1[45]\d{4}$/.test(c.billNo ?? ''), paidAt: c.paidAt ?? null }));
  const split = waitSplit({ day, rc: null, cash, oneSided });
  const listed = new Set([...split.notReceived, ...split.cashWait, ...split.closed].map((x) => x.billNo));
  for (const w of (waiting?.look ?? []).filter((x) => x.day === day && !listed.has(x.billNo))) {
    const x = { billNo: w.billNo, amountPaise: w.amountPaise, paidAt: null, mode: w.mode, why: w.reason };
    if (w.kind === 'not_received') split.notReceived.push(x);
    else if (w.kind === 'found') split.found.push({ ...x, offer: null });
    else if (w.kind === 'paperwork' && !split.paperwork.some((y) => y.billNo === w.billNo)) split.paperwork.push(x);
  }
  const waitCard = waitCardHtml(biz, day, split, null, { canDecide: false, confirmed: cv.status === 'confirmed', canWriteoff: false,
    others: (waiting?.look ?? []).filter((x) => x.day !== day).length, readOnly: true });
  render(shell(biz, 'reconcile', 'Reconcile', '', html`
    ${shiftBar(biz, day, 'reconcile')}
    <div class="note">You can look at this shift's bills here. Only an Owner or Accountant can decide differences and save the shift.</div>
    <div class="seg mode-tabs" role="tablist" aria-label="Shift" style="margin:4px 0 10px">
      <button type="button" role="tab" data-rtopbtn="all" class="${top === 'all' ? 'on' : ''}">All bills</button><button type="button" role="tab" data-rtopbtn="wait" class="${top === 'wait' ? 'on' : ''}">Waiting</button></div>
    <div data-rtop="all" ${top === 'all' ? '' : 'hidden'}>${P.bar}<div id="allmsg"></div>${P.banners}${P.warningsHtml}${P.shiftPane}</div>
    <div data-rtop="wait" ${top === 'wait' ? '' : 'hidden'}>${waitCard}
      ${cv.status === 'confirmed' ? '' : html`<div class="note">Payments are checked against the bank by an Owner or Accountant; UPI and card bills show here once the shift is saved.</div>`}</div>`));
  wireShell();
  wireShiftBar(biz);
  P.wire(app.querySelector('[data-rtop="all"]'), document.getElementById('allmsg'));
  app.querySelectorAll('[data-rtopbtn]').forEach((b) => b.addEventListener('click', () => {
    recTopNow = b.dataset.rtopbtn;
    app.querySelectorAll('[data-rtopbtn]').forEach((x) => x.classList.toggle('on', x === b));
    app.querySelectorAll('[data-rtop]').forEach((x) => { x.hidden = x.dataset.rtop !== b.dataset.rtopbtn; });
  }));
}

async function reconcileView(biz, dayArg) {
  const [dayPart, qs = ''] = String(dayArg ?? '').split('?');
  if (dayPart === 'all' && biz.actions.includes('bank.link')) return unmatchedView(biz);
  const more = Number(new URLSearchParams(qs).get('more')) || 1;
  if (new URLSearchParams(qs).get('top') === 'wait' && isDay(dayPart)) recKeep = { day: dayPart, top: 'wait' };
  if (new URLSearchParams(qs).get('tab') === 'cash' && isDay(dayPart)) recKeep = { day: dayPart, top: 'pay', tab: 'cash' };
  let day = isDay(dayPart) ? dayPart : null;
  if (!day) {
    const { shifts } = await api('GET', `/businesses/${biz.id}/shifts`);
    day = shifts.find((s) => s.day === lastDay(biz.id))?.day ?? shifts.find((s) => s.status === 'confirmed')?.day ?? shifts[0]?.day;
  }
  rememberDay(biz.id, day);
  if (!day) {
    render(shell(biz, 'reconcile', 'Reconcile', '', html`<section class="card"><div class="note">No sales yet. <a href="#/b/${biz.id}/bringin">Bring in a software sales report</a>.</div></section>`));
    return wireShell();
  }
  if (!biz.actions.includes('bank.link')) return reconcileReadOnly(biz, day);
  // In one trip (19 Nov 2026): the parts share their database questions on the server.
  const parts = apiMany([`/businesses/${biz.id}/shifts/${day}/reconcile`,
    `/businesses/${biz.id}/upi?more=${more}&day=${day}`, `/businesses/${biz.id}/heads`,
    `/businesses/${biz.id}/shifts/${day}/entries`, `/businesses/${biz.id}/shifts/${day}/cash`,
    // The Compare sales view of the shift: every bill and its decision menu (approved 9 Nov 2026).
    `/businesses/${biz.id}/shifts/${day}`, `/businesses/${biz.id}/waiting`, `/businesses/${biz.id}/shifts/${day}/complimentary`]);
  parts[6] = parts[6].catch(() => null);
  parts[7] = parts[7].catch(() => ({ lines: [], valuePaise: 0 }));
  const [r, v, { heads }, ent, cash, cv, waitPic, comp] = await Promise.all(parts);
  const tab0 = recKeep?.day === day && recKeep.tab ? recKeep.tab : reconcileTabPref();
  const tab = tab0 === 'comp' ? 'cash' : tab0;
  const top0 = recKeep?.day === day ? recKeep.top : 'todo';
  const top = top0 === 'wait' || (top0 === 'comp' && !comp.lines.length) ? 'todo' : top0;
  recKeep = null;
  recTopNow = top;
  const reload = () => { recKeep = { day, top: recTopNow }; return reconcileView(biz, `${day}?more=${v.moreHours}`); };
  drawerReload = reload;
  if (r.cards?.trial) r.cards.byUpi = r.byUpi ?? [];
  const s = r.strip;
  const days = [...new Set([day, ...r.shifts.map((x) => x.day)])].sort();
  const at = days.indexOf(day);
  const prevDay = at > 0 ? days[at - 1] : null;
  const nextDay = at < days.length - 1 ? days[at + 1] : null;
  const covered = !r.coverage || r.coverage.covered;
  const done = !s.billsLeft && !s.creditsLeft && covered;
  const gone = dismissed();
  const slips = r.slips ?? [];
  const cols = [...slips.map((x) => slipCard(x, r.confirmed, day)), ...(r.columnHints ?? []).map((h) => columnCard(h, r.confirmed))].filter((c) => !gone.has(c.key));
  // A bill or credit a column or slip card explains is not also told as having no credit, or no bill.
  const hinted = [...(r.columnHints ?? []).map((h) => ({ billNo: h.billNo, credits: [h.creditId] })),
    ...slips.flatMap((x) => [{ billNo: x.billNo, credits: slipCredits(x) }, ...(x.partner ? [{ billNo: x.partner.billNo, credits: slipCredits(x) }] : [])])];
  const explained = (c) => (c.billNos ?? []).some((b) => hinted.some((h) => h.billNo === b)) || (c.uses ?? []).some((u) => hinted.some((h) => h.credits.some((id) => u === `cr:${id}`)));
  const fixes = r.fixes.filter((c) => !gone.has(c.key) && !(c.kind === 'paid_in_parts' && explained(c)));
  // Probably the same payment (17 Nov 2026), before saving: told once, so its bill and credit leave the lists below.
  const hintSkip = new Set([...hinted.flatMap((h) => h.credits), ...(r.open?.bills ?? []).filter((b) => hinted.some((h) => h.billNo === b.billNo)).map((b) => b.id)]);
  const near = !r.confirmed && r.open && biz.actions.includes('sales.decide')
    ? nearPairs(r.open, hintSkip).filter((p) => !gone.has(`near:${p.bill.id}:${p.credit.id}`)) : [];
  const nearBills = new Set(near.map((p) => p.bill.id));
  const nearBillNos = new Set(near.map((p) => p.bill.billNo));
  const nearCredits = new Set(near.map((p) => p.credit.id));
  // A UPI bill paid on the card machine is told on the Card machine side, once (approved 9 Nov 2026).
  const onMachine = new Set((r.cards?.explains?.bills ?? []).map((b) => b.billNo));
  const noCredit = r.noCredit.filter((c) => !gone.has(c.key) && !explained(c) && !(c.billNos ?? []).some((b) => onMachine.has(b) || nearBillNos.has(b)));
  const cardSide = (r.cards?.explains?.credits.length ?? 0) + (r.cards?.explains?.bills.length ?? 0);
  const noBillLeft = r.noBill.filter((x) => !hinted.some((h) => h.credits.includes(x.creditId)) && !nearCredits.has(x.creditId));
  // Money with no bill (approved 11 Nov 2026): on Payments → UPI, one row per credit, bookable before saving too.
  const plainRemark = (x) => (x.remark && !/^(UPI|NA|NO REMARKS?|UPI Pay|Payment from Ph)$/i.test(x.remark.trim()) ? x.remark.trim() : '');
  const roomHead = r.unbilledHeads.find((h) => h.billType === 'room');
  const nextOpen = r.nextShift && !r.nextShift.saved;
  // Said once in the head when every credit came into one account.
  const nbOneAccount = (() => { const a = [...new Set(noBillLeft.map((x) => x.accountName ?? ''))]; return a.length === 1 && a[0] ? a[0] : ''; })();
  // A credit's Book choices: in Money with no bill (a saved shift) and in its ⋯ on Not matched yet (17 Nov 2026).
  const nbActs = (x, hidden = true) => html`<div class="nb-acts"${hidden ? ' hidden' : ''}>
        ${nextOpen ? html`<div class="tiny nb-next">The ${dayLabel(r.nextShift.day)} shift is not saved yet. If a guest paid ahead (an advance at check-in), the bill may be made there at check-out: book it as an Advance, or leave it for now. If it is booked and the bill turns up, Reconcile offers to join them (Same sale).</div>` : ''}
        <input type="text" data-nbwhat="${x.creditId}" maxlength="120" placeholder="What was it? (optional)" value="${plainRemark(x)}" aria-label="What was ₹ ${money(x.amountPaise)}?">
        ${r.unbilledHeads.map((h) => html`<button class="btn plain" type="button" data-nbsale="${x.creditId}" data-type="${h.billType}">Unbilled ${h.billType === 'room' ? 'Room' : 'F&B'}</button>`)}
        ${roomHead ? html`<button class="btn plain" type="button" data-nbadvance="${x.creditId}">Advance…</button>` : ''}
        <details class="menu nb-more"><summary class="btn plain">More ▾</summary><div class="menu-pop">
          <button class="btn plain" type="button" data-nbhold="${x.creditId}" data-kind="refund">Refund due</button>
          <button class="btn plain" type="button" data-nbhold="${x.creditId}" data-kind="tip">Tip for staff</button>
          <div class="nb-sep"></div>
          <label class="tiny" for="nbh-${x.creditId}">Book under a head</label>
          <div class="nb-headpick"><select id="nbh-${x.creditId}" data-nbhead="${x.creditId}"><option value="">Choose a head…</option>
            ${[...new Set(heads.map((h) => h.type))].map((t) => html`<optgroup label="${t[0].toUpperCase()}${t.slice(1)}">${heads.filter((h) => h.type === t).map((h) => html`<option value="${h.id}">${h.name}</option>`)}</optgroup>`)}</select>
            <button class="btn" type="button" data-nbbook="${x.creditId}">Book</button></div>
          <div class="nb-sep"></div>
          <button class="btn plain" type="button" data-nbignore="${x.creditId}">Not business (skip)</button></div></details>
`;
  const nbRow = (x) => html`<div class="nb-row" data-nbrow="${x.creditId}">
      <div class="nb-line"><label class="nb-head"><input type="checkbox" data-nbtick="${x.creditId}" aria-label="Tick ₹ ${money(x.amountPaise)} at ${hhmm(x.postedAt)}">
        <strong class="nb-amt">₹ ${money(x.amountPaise)}</strong><span class="tiny nb-meta">${hhmm(x.postedAt)}${nbOneAccount ? '' : ` · ${x.accountName ?? ''}`}${x.vpa ? ` · ${x.vpa}` : ''}${plainRemark(x) ? html` · <em>"${plainRemark(x)}"</em>` : ''}</span></label>
        ${x.spare ? html`<span class="nb-chip">Extra · ${x.spare.credits} credits of this amount, ${x.spare.bills} bill${x.spare.bills === 1 ? '' : 's'}</span>`
          : x.extra ? html`<span class="nb-chip" title="${`${x.extra === 1 ? 'The 1 bill' : `All ${x.extra} bills`} of ₹ ${money(x.amountPaise)} already ${x.extra === 1 ? 'has its' : 'have their'} credit: a sale not written down, or paid twice?`}">Extra · ${x.extra} bill${x.extra === 1 ? '' : 's'} of this amount paid</span>` : html`<span class="nb-chip">No bill of this amount</span>`}
        <button class="btn plain nb-open" type="button" data-nbopen="${x.creditId}" aria-expanded="false">Book ▾</button></div>
      ${(x.otherSide ?? []).length ? html`<div class="cmp-warn" style="margin:0 0 0 28px"><strong>Check first:</strong> ${x.otherSide.map((o) => html`<div>The software said ₹ ${money(o.softwarePaise)} for bill <span class="mono">${o.billNo ?? ''}</span>, the register ₹ ${money(o.registerPaise)}; you chose the ${o.chose}'s ₹ ${money(o.chose === 'register' ? o.registerPaise : o.softwarePaise)}. If the ${o.chose === 'register' ? 'software' : 'register'} was right, this ₹ ${money(x.amountPaise)} is that bill's payment.</div>`)}</div>` : ''}
      ${byUpiOffer((r.byUpi ?? []).find((o) => o.creditId === x.creditId), true)}
      <div class="nb-check" data-nbcheck="${x.creditId}"></div>
      ${nbActs(x)}
      </div></div>`;
  // Grouped (approved 21 Nov 2026): one payer paying in parts minutes apart, small amounts booked together, then the rest.
  const nbPairs = [];
  const nbInPair = new Set();
  for (const x of [...noBillLeft].sort((a, b) => a.postedAt - b.postedAt)) {
    if (!x.vpa || nbInPair.has(x.creditId)) continue;
    const mates = noBillLeft.filter((y) => y.vpa === x.vpa && !nbInPair.has(y.creditId) && y.postedAt >= x.postedAt && y.postedAt - x.postedAt <= 10 * 60000);
    if (mates.length < 2) continue;
    mates.forEach((y) => nbInPair.add(y.creditId));
    nbPairs.push(mates);
  }
  const nbSmall = noBillLeft.filter((x) => !nbInPair.has(x.creditId) && x.amountPaise <= 5000);
  const nbRest = noBillLeft.filter((x) => !nbInPair.has(x.creditId) && x.amountPaise > 5000);
  const fnbHead = r.unbilledHeads.find((h) => h.billType === 'fnb');
  const nbSum = (l) => l.reduce((t, x) => t + x.amountPaise, 0);
  const nbGroupHtml = html`${nbPairs.length ? html`<div class="nb-grp"><strong>Same payer, minutes apart (${nbPairs.length})</strong><div class="tiny">Payments from one UPI id: one bill paid in parts, or a room advance.</div>
      ${nbPairs.map((g) => html`<div class="tiny nb-sum">${ssRs(nbSum(g))} = ${g.map((x) => ssRs(x.amountPaise)).join(' + ')} from <span class="mono">${g[0].vpa}</span>, ${hhmm(g[0].postedAt)}${g.length > 1 ? `–${hhmm(g.at(-1).postedAt)}` : ''}</div>${g.map(nbRow)}`)}</div>` : ''}
    ${nbSmall.length ? html`<div class="nb-grp"><strong>Small amounts, ₹50 or less (${nbSmall.length} · ${ssRs(nbSum(nbSmall))})</strong>
      ${fnbHead && nbSmall.length > 1 ? html`<div class="form-row" style="justify-content:flex-end"><button class="btn" type="button" data-nbsmall="${nbSmall.map((x) => x.creditId).join(',')}">Book all ${nbSmall.length} as Unbilled F&amp;B</button></div>` : ''}
      ${nbSmall.map(nbRow)}</div>` : ''}
    ${nbRest.length ? html`<div class="nb-grp">${nbPairs.length || nbSmall.length ? html`<strong>The rest (${nbRest.length} · ${ssRs(nbSum(nbRest))})</strong>` : ''}${nbRest.map(nbRow)}</div>` : ''}`;
  const noBillSection = noBillLeft.length ? html`<section class="card" id="nobill" style="gap:0">
    <div class="lane-h"><strong>Money with no bill (${noBillLeft.length})</strong>
      <label class="tiny" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="nbtickall" style="width:18px;height:18px;min-height:0"> Tick all</label></div>
    <div class="tiny" style="color:var(--muted);padding-bottom:6px">${nbOneAccount ? `Into ${nbOneAccount} · ` : ''}A sale not written down, or money that is not a sale.${r.confirmed ? '' : ' Book it now; if its bill turns up, Bookr joins them so it is counted once.'} Press Book on a row for its choices, or tick several.</div>
    ${nbGroupHtml}
    ${r.unbilledHeads.length ? html`<div class="form-row" id="nbbulk" hidden style="gap:6px;padding-top:10px;border-top:1px solid var(--line-soft)"><span class="tiny" id="nbcount"></span>
      ${r.unbilledHeads.map((h) => html`<button class="btn" type="button" style="min-height:36px" data-nbmany="${h.billType}">Book ticked as Unbilled ${h.billType === 'room' ? 'Room' : 'F&B'}</button>`)}</div>` : ''}
    ${r.unbilledHeads.length ? '' : html`<div class="note">Choose the income heads for F&amp;B and Room bills on <a href="#/b/${biz.id}/heads">Heads and rules</a> to book unbilled sales.</div>`}
    ${(r.upiBook?.waiting ?? []).length ? html`<div class="tiny" style="color:var(--muted);padding-top:8px;margin-top:6px;border-top:1px solid var(--line-soft)">Still waiting: ${r.upiBook.waiting.map((w, i) => html`${i ? ' · ' : ''}bill <span class="mono">${w.billNo ?? ''}</span>, ₹ ${money(w.amountPaise).replace(/\.00$/, '')} UPI, ${dayLabel(w.day).replace(/\s\d{4}$/, '')} <a href="#/b/${biz.id}/reconcile/${w.day}?tab=upi">Open ›</a>`)}</div>` : ''}
  </section>` : '';
  const upiDecide = r.confirmed ? 0 : (ent.upi?.entries ?? []).filter((e) => e.state === 'decide').length;
  const nearSection = () => (near.length || isSameCards.length ? html`<section class="card left-box" id="nearpairs" style="gap:8px">
    <div class="lane-h"><strong>Is this the same? (${near.length + isSameCards.length})</strong><span class="tchip warn">Check</span></div>
    <div class="tiny" style="color:var(--muted)">Bookr's guesses: a bill and a credit that look like one payment. Nothing is matched until you choose; it is matched when you save the shift.</div>
    ${near.length ? html`<section class="sg-group left-box"><div class="sg-h"><strong>Close, not exact (${near.length})</strong><span class="tiny">a bill and a credit near in time, a little apart in amount</span></div>
    ${near.map((p, i) => html`<div class="sg-row" data-card="near:${p.bill.id}:${p.credit.id}">
      <div class="sg-lead">${p.bill.billNo ? html`<button type="button" class="linkbtn mono sg-bill" data-bill-drawer="${p.bill.billNo}|${day}" title="Everything about this bill">${p.bill.billNo}</button>` : html`<span class="mono">—</span>`}</div>
      <div class="sg-mid"><span class="sg-chips"><span class="sg-src">Bill ₹ ${money(p.bill.amountPaise).replace(/\.00$/, '')} · ${p.bill.paidAt ? hhmm(p.bill.paidAt) : 'register only'}</span>
        <span class="sg-src">Bank ₹ ${money(p.credit.amountPaise).replace(/\.00$/, '')} · ${hhmm(p.credit.postedAt)}</span>
        <span class="sg-src ${p.kind === 'register' ? 'ok' : 'warn'}">${p.kind === 'register' ? 'same amount · bill only in the register' : `bank ₹ ${money(Math.abs(p.diff)).replace(/\.00$/, '')} ${p.diff > 0 ? 'more' : 'less'}`}</span></span></div>
      <div class="sg-acts"><button class="btn dchip" type="button" data-nearmatch="${i}">${nearLabel(p)}</button>
        <button class="btn plain dchip sg-x" type="button" data-carddismiss="near:${p.bill.id}:${p.credit.id}" title="Not these: keep them apart on this device" aria-label="Not these">✕</button></div>
      <div class="form-msg"></div></div>`)}</section>` : ''}
    ${isSameCards.length ? suggestionList(isSameCards, day, { day, billsLeftPaise: r.strip?.billsLeftPaise }) : ''}
  </section>` : '');
  const view = reconcileViewPref(r.confirmed);
  const creditCell = (x) => html`${when(x.postedAt)}<div class="tiny">${x.accountName}${x.minutes != null ? ` · ${x.minutes} min from the bill` : ' · register only, no bill time'}</div>`;
  const billsCell = (x) => html`<span class="mono">${x.billNos.join(' + ')}</span>${x.part ? html`<div class="tiny">${x.part}</div>` : ''}`;
  const farGap = (ms) => (ms >= 86400e3 ? `${Math.round(ms / 86400e3 * 10) / 10} days` : `${Math.round(ms / 3600e3)} h`);
  const pairTable = (rows, attr, ticked) => html`<div class="scroll"><table style="min-width:560px"><thead><tr>${attr ? html`<th style="width:36px"></th>` : ''}<th>Bill</th><th style="text-align:right">Amount</th><th>Credit</th></tr></thead><tbody>
    ${rows.map((x) => html`<tr>${attr ? html`<td><input type="checkbox" ${attr}="${x.creditId}" ${ticked ? 'checked' : ''} aria-label="Match bill ${x.billNos.join(' + ')}" style="width:18px;height:18px;min-height:0"></td>` : ''}
      <td>${billsCell(x)}${x.others ? html`<div class="tiny" style="color:#92400E">${x.others} other possible match${x.others > 1 ? 'es' : ''}: check before ticking</div>` : ''}${x.far ? html`<div class="tiny" style="color:#92400E">${x.postedAt < x.paidAt ? `Paid ${farGap(x.paidAt - x.postedAt)} before the bill: an advance?` : `Came ${farGap(x.postedAt - x.paidAt)} after the bill: posted late by the bank?`} The only credit of this amount in that time.</div>` : ''}</td><td class="amount">${money(x.amountPaise)}</td><td>${creditCell(x)}</td></tr>`)}
  </tbody></table></div>`;
  // A UPI sale matched to the card machine's UPI payment is received (14 Nov 2026).
  const waiting = v.sales.filter((x) => !x.bankRowId && x.machineAt == null);
  const clearCard = r.clear.length ? html`<div class="rv-card" id="laneclear">
    <div class="lane-h"><strong>${r.clear.length} bill${r.clear.length === 1 ? '' : 's'} match the bank exactly</strong><span class="tchip ok">${CARD_TAGS.clear_matches}</span></div>
    <div class="note">Same amount, closest in time, within an hour; each bill and credit used once.${r.confirmed ? '' : ' They are matched when you save.'}</div>
    ${r.confirmed ? html`<div class="form-row" style="gap:6px"><button class="btn" type="button" id="matchclear" style="min-height:36px">Match all ${r.clear.length}</button></div>` : ''}
    <details class="cmp-fold"><summary>See the list</summary>${pairTable(r.clear, r.confirmed ? 'data-clear' : '', true)}</details>
    <div class="form-msg" id="clearmsg"></div></div>` : '';
  const likelyCard = r.likely.length ? html`<div class="rv-card">
    <div class="lane-h"><strong>${r.likely.length} likely match${r.likely.length === 1 ? '' : 'es'} for you to check</strong><span class="tchip warn">Likely, not certain</span></div>
    <div class="note">The same amount, but further apart in time or with another possible match. Tick the ones you agree with.</div>
    <details class="cmp-fold"><summary>See the list</summary>${pairTable(r.likely, 'data-likely', false)}</details>
    <div class="form-row" style="gap:6px"><button class="btn" type="button" id="matchlikely" disabled style="min-height:36px">Match 0 ticked</button></div><div class="form-msg" id="likelymsg"></div></div>` : '';
  const nothing = !r.clear.length && !cols.length && !fixes.length && !r.likely.length && !noCredit.length;
  const suggestions = html`<section class="card lane" style="gap:10px">
    <div class="rv-cards">${clearCard}${likelyCard}</div>${suggestionList([...cols, ...fixes.filter((c) => !(c.kind === 'no_bill' && noBillLeft.length)), ...noCredit.filter((c) => !(c.kind === 'no_bill' && noBillLeft.length))], day)}
    ${nothing ? html`<div class="note">${done ? 'No suggestions: nothing is left to explain.' : 'No suggestions for what is left. Open the entries to compare them yourself.'}</div>` : ''}
    ${cardSide ? html`<div class="note">${cardSide} UPI entr${cardSide === 1 ? 'y is' : 'ies are'} explained by the card machine: see Card machine below.</div>` : ''}
  </section>`;
  // Paid on the card machine, from the UPI and Cash tabs too (approved 11 Nov 2026): the Card tab's own check, shown on
  // the bill where it is listed. One button, the same steps, so a fix on either tab clears both.
  const cardNeeds = (r.cards?.needs ?? []).filter((n) => n.why === 'written' && n.written);
  const onCardLine = (b) => {
    const m = (r.cards?.upiOnMachine ?? []).find((x) => x.comparisonId === b.id);
    if (m) return html`<div class="cmp-warn" style="margin:0">Paid by UPI on the card machine: ₹ ${money(m.amountPaise)} at ${hhmm(m.payAt)}, ${m.minutes} min from the bill. The money comes in the card settlement, not this bank account, so it is a card bill.
      ${m.rowId && m.uploadId ? html`<div class="form-row" style="gap:6px;margin-top:6px"><button class="btn" type="button" style="min-height:36px" data-upimachine="${m.paymentId}" data-cmp="${m.comparisonId}" data-bill="${m.billNo ?? ''}">Paid on the card machine</button></div>
      <div class="tiny" style="margin-top:4px">Changes the register's payment to Card and matches it on save. One Undo puts it back.</div>` : html`<div class="tiny" style="margin-top:4px">Change its payment to Card on its row.</div>`}<div class="form-msg"></div></div>`;
    const n = cardNeeds.find((x) => x.written.comparisonId === b.id && x.written.mode === 'upi');
    if (!n) return '';
    const wr = n.written, p = n.payment;
    const can = r.cards?.trial && wr.rowId && wr.uploadId && !wr.upiNear;
    return html`<div class="cmp-warn" style="margin:0">${wr.upiNear
      ? html`The card machine got ₹ ${money(p.amountPaise)} at ${hhmm(p.paidAt)}, ${wr.minutes} min from the bill, and a UPI credit of this amount is near too: paid twice? Check the bill on its row.`
      : html`The card machine got ₹ ${money(p.amountPaise)} at ${hhmm(p.paidAt)}, ${wr.minutes} min from the bill, and no UPI credit of this amount came in. It was most likely paid by card.`}
      ${can ? html`<div class="form-row" style="gap:6px;margin-top:6px"><button class="btn" type="button" style="min-height:36px" data-tpaidcard="${p.id}" data-cmp="${wr.comparisonId}">Paid on the card machine</button></div>`
        : !wr.upiNear ? html`<div class="tiny" style="margin-top:4px">Change it on the <button type="button" class="linkbtn tiny" data-goto="pay:card">Card tab</button>.</div>` : ''}<div class="form-msg"></div></div>`;
  };
  const cashOnCard = cardNeeds.filter((n) => n.written.mode === 'cash');
  const cashOnCardHtml = cashOnCard.length ? html`<section class="card" style="gap:8px"><div class="lane-h"><strong>Cash bills the card machine may have got: ${cashOnCard.length}</strong><span class="tchip warn">Check</span></div>
    ${cashOnCard.map((n) => html`<div class="ent-line"><div><span class="mono"><strong>${n.written.billNo ?? ''}</strong></span> <button type="button" class="linkbtn tiny" data-bill-drawer="${n.written.billNo}|${day}">Open row</button></div>
      <div class="tiny">₹ ${money(n.written.amountPaise)} at ${when(n.written.paidAt)}, written as cash. The card machine got ₹ ${money(n.payment.amountPaise)}${n.payment.upi ? ' (UPI on the machine)' : ''} at ${hhmm(n.payment.paidAt)}, ${n.written.minutes} min from the bill.</div></div>`)}
    <div class="tiny">If it was paid on the machine, change it on the <button type="button" class="linkbtn tiny" data-goto="pay:card">Card tab</button>.</div></section>` : '';
  // A register line written with a neighbour's number (11 Nov 2026): told under the bill it probably is, and under its credit.
  const slipOpen = (x) => html`<a href="#/b/${currentBizId()}/review/${x.uploadId}/${x.rowId}" class="tiny">Open the row</a>`;
  const slipFix = (x) => (!r.confirmed && biz.actions.includes('sales.decide') ? html` <button type="button" class="btn plain dchip" data-renumber="${x.rowId}" data-upload="${x.uploadId}" data-from="${x.writtenAs}" data-no="${x.billNo}">Change ${x.writtenAs} to ${x.billNo}</button>` : '');
  const slipBillLine = (b) => (r.numberSlips ?? []).filter((x) => x.billNo === b.billNo).map((x) => html`<div class="cmp-warn" style="margin:0">Probably the register line written as <span class="mono">${x.writtenAs}</span>: ₹ ${money(x.amountPaise)}, paid ₹ ${money(x.paidPaise)}. Same amount, one digit apart. Correct its number and this bill gets its credit. ${slipOpen(x)}${slipFix(x)}</div>`);
  const slipCreditLine = (c) => (r.numberSlips ?? []).filter((x) => x.paidPaise === c.amountPaise && (r.open.bills ?? []).some((b) => b.billNo === x.billNo)).map((x) => html`<div class="tiny" style="color:#92400E;white-space:normal">Probably bill ${x.billNo}, written in the register as ${x.writtenAs}. ${slipOpen(x)}${slipFix(x)}</div>`);
  const lone = r.open ? lonePairs(r.open) : [];
  // Not matched yet (approved 17 Nov 2026): one list, bills on the left and credits on the right, in time order, one line
  // each. A pair above is not listed again; register-only bills come last. Each line's note is short; its ⋯ holds the
  // full note and every fix for it (Book, Was cash, Was card, a number to correct, a pair to make), so nothing needs
  // another page. The pairs being made sit at the top.
  const loBills = (r.open?.bills ?? []).filter((b) => !nearBills.has(b.id));
  const loCredits = (r.open?.credits ?? []).filter((c) => !nearCredits.has(c.id));
  const loItems = [...loBills.map((b) => ({ t: b.paidAt ?? Infinity, b })), ...loCredits.map((c) => ({ t: c.postedAt ?? Infinity, c }))].sort((a, b) => a.t - b.t);
  const loBillIds = new Set(loBills.map((b) => b.id));
  const cmpById = new Map(cv.comparisons.map((c) => [c.id, c]));
  // A bill with no credit keeps its card's buttons (Was cash, Was card, Open the bill) in its ⋯.
  const actLine = (k) => (k ? html`<div data-card="${k.key}"><div class="tiny" style="white-space:normal">${k.title}</div><div class="form-row" style="gap:6px;margin-top:4px">${k.actions.map((a, i) => (a.href
    ? html`<a class="btn plain dchip" style="display:inline-flex;align-items:center" href="${a.href}">${a.label}</a>`
    : html`<button class="btn plain dchip" type="button" data-cardact="${k.key}" data-i="${i}">${a.label}</button>`))}</div><div class="form-msg"></div></div>` : '');
  const canFix = !r.confirmed && biz.actions.includes('sales.decide');
  // A register line whose number is probably this bill's (a digit or two off, the same amount): one click renames it.
  const typoFor = (b) => { for (const c of cv.comparisons) {
    if (c.id === b.id || c.decision || c.software || !c.register?.rowId || !c.register.uploadId) continue;
    const f = (c.numberFlags ?? []).find((x) => (x.kind === 'pending' || x.kind === 'pending_typo') && x.billNo === b.billNo);
    if (f) return { c, f };
  } return null; };
  // A register-only bill whose number is probably another: one click changes it.
  const ownFix = (b) => { const c = cmpById.get(b.id);
    if (!c || c.software || c.decision || !c.register?.rowId || !c.register.uploadId) return null;
    const f = (c.numberFlags ?? []).find((x) => x.billNo && x.billNo !== c.billNo);
    return f ? { c, f } : null; };
  const renumberBtn = (c, to, label) => (canFix ? html`<button type="button" class="btn plain dchip" data-renumber="${c.register.rowId}" data-upload="${c.register.uploadId}" data-from="${c.billNo}" data-no="${to}">${label}</button>` : '');
  // A cash bill in the software, not in the register, that this credit paid (approved 17 Nov 2026).
  const cashByUpi = new Map((cv.warnings ?? []).filter((w) => w.byUpi && w.comparisonId).map((w) => [w.byUpi.creditId, w]));
  const cashUpiBtns = (w) => { const cmp = cmpById.get(w.comparisonId); const types = cmp?.billType ? [cmp.billType] : ['fnb', 'room'];
    return canFix ? types.map((t) => html`<button type="button" class="btn plain dchip" data-cashupi2="${w.comparisonId}" data-credit="${w.byUpi.creditId}" data-type="${t}" data-bill="${w.billNo}">Bill ${w.billNo} was paid by UPI${types.length > 1 ? ` · ${t === 'room' ? 'Room' : 'F&B'}` : ''}</button>`) : ''; };
  const loMenu = (label, body) => html`<details class="menu lo-menu"><summary class="btn plain dchip lo-dots" aria-label="${label}">⋯</summary><div class="menu-pop lo-pop">${body}</div></details>`;
  const loHint = (t, tone = 'info') => (t ? html`<button type="button" class="linkbtn lo-hint lo-${tone}" data-loopen title="${t}">${t}</button>` : '');
  const nearBillOf = (c) => loBills.filter((b) => b.amountPaise !== c.amountPaise && Math.abs(b.amountPaise - c.amountPaise) <= TRAY_GAP)
    .sort((a, b) => Math.abs(a.amountPaise - c.amountPaise) - Math.abs(b.amountPaise - c.amountPaise))[0];
  const pairBtn = (c, b, extra = '') => html`<button type="button" class="btn plain dchip" data-lopair="${c.id}|${b.id}">Pair with bill ${b.billNo}${extra}</button>`;
  const loBillRow = (b) => {
    const c = cmpById.get(b.id);
    const typo = typoFor(b);
    const own = typo ? null : ownFix(b);
    const nc = noCredit.find((k) => (k.billNos ?? []).includes(b.billNo));
    const slips = (r.numberSlips ?? []).filter((x) => x.billNo === b.billNo);
    const card = onCardLine(b);
    const hint = typo ? loHint(`= register ${typo.c.billNo}?`) : own ? loHint(`→ ${own.f.billNo}?`) : slips.length ? loHint(`written as ${slips[0].writtenAs}?`, 'warn')
      : card ? loHint('card machine?', 'warn') : '';
    const tags = [b.grouped && 'paid together', b.fromDay ? `${dayLabel(b.fromDay)} bill` : !b.paidAt && 'register only'].filter(Boolean).map((t) => html`<span class="lo-tag">${t}</span>`);
    const body = html`<div class="tiny"><strong class="mono">${b.billNo ?? '—'}</strong> · ₹ ${money(b.amountPaise)} · ${b.paidAt ? when(b.paidAt) : 'register only, no bill time'}</div>
      ${typo ? html`<div class="lo-fix"><div class="tiny" style="white-space:normal">Register line <span class="mono">${typo.c.billNo}</span> (₹ ${money(typo.c.register.amountPaise ?? 0)}) is probably this bill: ${numberFlagText(typo.f)}</div>${renumberBtn(typo.c, b.billNo, `Same bill: change ${typo.c.billNo} to ${b.billNo}`)}</div>` : ''}
      ${own ? html`<div class="lo-fix"><div class="tiny" style="white-space:normal">${numberFlagText(own.f)}</div>${renumberBtn(own.c, own.f.billNo, `Change the number to ${own.f.billNo}`)}</div>` : ''}
      ${slipBillLine(b)}${card}${actLine(nc)}
      ${b.billNo ? html`<button type="button" class="btn plain dchip" data-bill-drawer="${b.billNo}|${day}">Open row</button>` : ''}`;
    return html`<div class="lo-grid lo-row" data-side="bl"><div class="lo-cell"><label class="lo-tick"><input type="checkbox" data-tside="bl" data-amt="${b.amountPaise}" data-id="${b.id}" aria-label="Tick bill ${b.billNo ?? ''}"><strong class="mono">${b.billNo ?? '—'}</strong></label>${tags}${hint}<span class="lo-fill"></span><strong class="amount">₹ ${money(b.amountPaise)}</strong>${loMenu(`Choices for bill ${b.billNo ?? ''}`, body)}</div>
      <div class="tiny lo-t">${b.paidAt ? hhmm(b.paidAt) : '—'}</div><div></div></div>`;
  };
  const loCreditRow = (x) => {
    const w = cashByUpi.get(x.id);
    const o = (r.byUpi ?? []).find((y) => y.creditId === x.id);
    const nb = noBillLeft.find((n) => n.creditId === x.id);
    const slip = (r.numberSlips ?? []).find((s) => s.paidPaise === x.amountPaise && (r.open.bills ?? []).some((b) => b.billNo === s.billNo));
    const near = x.why === 'extra' && !x.billsOfAmount ? nearBillOf(x) : null;
    const could = x.why === 'unpaired' ? (x.bills ?? []).map((cb) => loBills.find((b) => b.billNo === cb.billNo)).filter(Boolean) : [];
    const hint = w ? loHint(`cash bill ${w.billNo}?`) : o ? loHint(`${o.mode === 'card' ? 'card' : 'cash'} bill ${o.billNo ?? ''}?`) : slip ? loHint(`bill ${slip.billNo}?`, 'warn')
      : near ? loHint(`${near.billNo}? ₹ ${money(Math.abs(near.amountPaise - x.amountPaise))} apart`)
      : x.why === 'unpaired' ? loHint(`could be ${(x.bills ?? []).map((b) => b.billNo).join(', ')}`, 'warn')
      : x.why === 'no_bill' ? html`<span class="lo-tag">no bill</span>` : x.why === 'extra' && x.spare ? html`<span class="lo-tag" title="${`${x.spare.credits} credits of ₹ ${money(x.amountPaise)} and ${x.spare.bills} bill${x.spare.bills === 1 ? '' : 's'} they could be: the nearest keep Pair, the rest can be booked`}">extra · ${x.spare.credits} credits, ${x.spare.bills} bill${x.spare.bills === 1 ? '' : 's'}</span>`
      : x.why === 'extra' ? html`<span class="lo-tag" title="${`All ${x.billsOfAmount} bill${x.billsOfAmount === 1 ? '' : 's'} of this amount already have their credit`}">extra</span>` : '';
    const body = html`<div class="tiny" style="white-space:normal">₹ ${money(x.amountPaise)} at ${when(x.postedAt)}${x.accountName ? ` · ${x.accountName}` : ''}${nb && plainRemark(nb) ? html` · <em>"${plainRemark(nb)}"</em>` : ''}${covered ? creditWhyHtml(x, r.open.bills) : ''}</div>
      ${w ? html`<div class="lo-fix" data-cashupibox><div class="tiny" style="white-space:normal">Cash bill <span class="mono">${w.billNo}</span> (₹ ${money(w.amountPaise)}) is in the software report but not in the register: probably paid by UPI with this credit. Adds it to the register as UPI; it is matched on save.</div>${cashUpiBtns(w)}<div class="form-msg"></div></div>` : ''}
      ${near ? html`<div class="lo-fix">${pairBtn(x, near, `, ₹ ${money(Math.abs(near.amountPaise - x.amountPaise))} apart`)}</div>` : ''}
      ${could.length ? html`<div class="lo-fix">${could.map((b) => pairBtn(x, b))}</div>` : ''}
      ${slipCreditLine(x)}
      ${byUpiOffer(o, true)}
      ${(nb?.otherSide ?? []).length ? html`<div class="cmp-warn" style="margin:0"><strong>Check first:</strong> ${nb.otherSide.map((q) => html`<div>The software said ₹ ${money(q.softwarePaise)} for bill <span class="mono">${q.billNo ?? ''}</span>, the register ₹ ${money(q.registerPaise)}; you chose the ${q.chose}'s ₹ ${money(q.chose === 'register' ? q.registerPaise : q.softwarePaise)}. If the ${q.chose === 'register' ? 'software' : 'register'} was right, this ₹ ${money(x.amountPaise)} is that bill's payment.</div>`)}</div>` : ''}
      ${nb ? html`<div class="nb-check" data-nbcheck="${x.id}"></div><div class="tiny"><strong>Book it</strong>: a sale not written down, or money that is not a sale.</div>${nbActs(nb, false)}
        <div class="form-row" style="gap:6px;margin-top:4px"><a class="btn plain dchip" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/review?day=${day}">Add a bill on Review</a></div>` : ''}`;
    return html`<div class="lo-grid lo-row" data-side="cr"><div></div><div class="tiny lo-t">${hhmm(x.postedAt)}</div>
      <div class="lo-cell"><input type="checkbox" data-tside="cr" data-amt="${x.amountPaise}" data-id="${x.id}" aria-label="Tick credit ₹ ${money(x.amountPaise)} at ${hhmm(x.postedAt)}">${hint}<span class="lo-fill"></span>${nb && !r.confirmed ? html`<button type="button" class="btn plain dchip lo-book" data-loopen>Book ▾</button>` : ''}<strong class="amount">₹ ${money(x.amountPaise)}</strong>${loMenu(`Choices for the credit of ₹ ${money(x.amountPaise)}`, body)}</div></div>`;
  };
  const nbIds = new Set(noBillLeft.map((n) => n.creditId));
  const trialLists = r.open ? html`<section class="card left-box" style="gap:8px" id="trialopen">
    <div class="lane-h"><strong>Not matched yet · ${loBills.length} bill${loBills.length === 1 ? '' : 's'} · ${loCredits.length} credit${loCredits.length === 1 ? '' : 's'}</strong>${lone.length > 1 ? html`<button type="button" class="linkbtn tiny" data-tray="exact">Tick all exact pairs (${lone.length})</button>` : ''}</div>
    <div class="tiny" style="color:var(--muted)">Tick a bill and a credit to pair them; pairs are matched when you save. ⋯ on a line for its choices: Book, Was cash, Was card, or the fix its note suggests.</div>
    <div data-tray="fix"></div><div data-tray="sum" class="note" hidden></div><div class="form-msg" data-tray="msg"></div>
    <div class="lo-bar"><span class="seg lo-chips"><button type="button" class="on" data-lofilter="all">All ${loItems.length}</button><button type="button" data-lofilter="bl">Bills ${loBills.length}</button><button type="button" data-lofilter="cr">Credits ${loCredits.length}</button></span>
      <span class="lo-fill"></span>${nbIds.size > 1 && !r.confirmed ? html`<button type="button" class="btn plain dchip" data-lotickall>Tick all credits with no bill</button>` : ''}</div>
    ${r.unbilledHeads.length ? html`<div class="form-row" id="nbbulk" hidden style="gap:6px"><span class="tiny" id="nbcount"></span>
      ${r.unbilledHeads.map((h) => html`<button class="btn" type="button" style="min-height:36px" data-nbmany="${h.billType}">Book ticked as Unbilled ${h.billType === 'room' ? 'Room' : 'F&B'}</button>`)}</div>` : ''}
    <div class="lo-grid lo-head"><span class="tiny"><strong>Bill, no credit</strong></span><span class="tiny lo-t">Time</span><span class="tiny" style="text-align:right"><strong>Credit, no bill</strong></span></div>
    ${loItems.map((x) => (x.b ? loBillRow(x.b) : loCreditRow(x.c)))}
    <label class="tiny" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" data-tray="nearOn" style="width:16px;height:16px;min-height:0"> Show credits from the shifts either side</label><div data-tray="near"></div></section>` : '';
  // Is this the same? (approved 17 Nov 2026): Bookr's guesses, a bill and a credit that look like one payment, and the
  // register slips and Same sale cards, each told once here and not again on the list.
  const listedCredit = new Set([...loCredits, ...(r.open?.credits ?? [])].map((c) => `cr:${c.id}`));
  let isSameCards = r.confirmed || !r.open ? [] : [...cols, ...fixes.filter((c) => !(c.kind === 'no_bill' && noBillLeft.length)),
    ...noCredit.filter((k) => !(k.billNos ?? []).some((b) => loBills.some((x) => x.billNo === b)))]
    // A credit with no bill is a line of the list below, with its choices in its ⋯ (18 Nov 2026): not a card too.
    .filter((k) => !(k.kind === 'no_bill' && (k.uses ?? []).some((u) => listedCredit.has(u))));
  // Left on top, done below in green (approved 20 Nov 2026): a Same sale a person chose is not a question; it is told
  // under Done as On save, with Undo.
  const planCards = isSameCards.filter((k) => String(k.key ?? '').startsWith('same-sale-plan:'));
  isSameCards = isSameCards.filter((k) => !planCards.includes(k));
  const onSaveHtml = planCards.length ? html`<section class="card done-box" style="gap:6px"><div class="lane-h"><strong>✓ On save (${planCards.length})</strong><span class="tiny">your choices, done when the shift is saved</span></div>
    ${planCards.map((k, i) => html`<div class="done-line"><span>${k.title.replace(' will join the ', ' joins the ')}</span>${k.actions?.[0] ? html`<button class="btn plain dchip" type="button" data-plandel="${i}">Undo</button>` : ''}</div>`)}
    <div class="tiny">Each bill is counted once, on the day its money was booked.</div></section>` : '';
  const clearList = r.clear ?? [];
  const wouldMatch = !r.confirmed && r.open && s.bills - s.billsLeft > 0 ? html`<details class="card cmp-fold done-box"><summary><h2>✓ Would match the bank · ${s.bills - s.billsLeft} bill${s.bills - s.billsLeft === 1 ? '' : 's'} · ₹ ${money(s.matchedPaise)}</h2></summary>
    ${clearList.length ? html`<div class="scroll"><table style="min-width:520px"><thead><tr><th>Bill</th><th style="text-align:right">Amount</th><th>Credit</th></tr></thead><tbody>
      ${clearList.map((x) => html`<tr><td class="mono">${(x.billNos ?? []).join(' + ')}</td><td class="amount">${money(x.amountPaise)}</td><td>${when(x.postedAt)}${x.accountName ? html`<div class="tiny">${x.accountName}</div>` : ''}</td></tr>`)}
    </tbody></table></div>` : ''}<div class="tiny">Matched when you save the shift.</div></details>` : '';
  const doneFold = r.done.length || r.booked.length ? html`<details class="card cmp-fold done-box"><summary><h2>✓ Done (${r.done.length + r.booked.length})</h2></summary>
      <div class="scroll"><table style="min-width:620px"><thead><tr><th>Bill</th><th style="text-align:right">Amount</th><th>Credit</th><th></th></tr></thead><tbody>
        ${r.done.map((x) => html`<tr><td class="mono">${x.bills.join(' + ')}</td><td class="amount">${money(x.creditPaise ?? x.billsPaise)}</td><td>${when(x.postedAt)}<div class="tiny">${x.accountName}</div></td>
          <td><button class="btn plain dchip" type="button" data-unmatch="${x.rowId}">Unmatch</button></td></tr>`)}
        ${r.booked.map((x) => html`<tr><td>${x.headName ?? 'Booked'}${x.note ? html`<div class="tiny">${x.note}</div>` : ''}</td><td class="amount">${money(x.amountPaise)}</td><td>${when(x.postedAt)}</td>
          <td><button class="btn plain dchip" type="button" data-putback="${x.id}">Put back</button></td></tr>`)}
      </tbody></table></div></details>` : '';
  const cardLeft = r.cards ? r.cards.left : 0;
  // All bills: the Compare sales table of this shift, with its filters, bulk buttons and totals (approved 10 Nov 2026).
  cv.reasons = cash.reasons;
  const P = compareParts(biz, day, cv, r.shifts, { reload, back: `#/b/${biz.id}/reconcile/${day}`, onReconcile: true });
  const allLeft = cv.comparisons.filter((c) => !c.decision && ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'].includes(c.difference)).length;
  // To do (approved 10 Nov 2026): saving, old POS bills, import conflicts, cash bills paid by UPI, numbers to check, and
  // what is left on the other tabs.
  const canDecide = biz.actions.includes('sales.decide');
  const checks = r.confirmed ? [] : cv.comparisons.filter((c) => (!c.decision || c.auto) && c.difference !== 'match' && c.difference !== 'complimentary'
    && (c.numberFlags?.length || (!c.software && isOddBill(c.billNo) && !c.decision) || (c.reissuedAs && !c.decision)));
  // A ₹0 (complimentary) bill with money paid on its row (approved 10 Nov 2026): shown as a check, it does not stop saving.
  // The row paying for a group may come to ₹0 under the group's discount (approved 7 Nov 2026): told only when that
  // discount is large, as on Review.
  const paidZero = r.confirmed ? [] : cv.comparisons.filter((c) => c.difference === 'complimentary' && (c.register?.paidPaise ?? 0) > 0 && !groupZero(c, cv));
  // This shift's waiting bills in four groups (18 Nov 2026): the Waiting card of To do.
  const oneSided = cv.comparisons.filter((c) => ['missing_in_register', 'missing_in_software'].includes(c.difference) && c.decision !== 'leave_out')
    .map((c) => ({ comparisonId: c.id, billNo: c.billNo, amountPaise: c.software?.amountPaise ?? c.register?.amountPaise ?? 0, mode: c.software?.mode ?? c.register?.mode ?? null,
      side: c.difference === 'missing_in_register' ? 'software' : 'register', otherDay: c.otherDay, oldPos: !!c.oldPos || /^1[45]\d{4}$/.test(c.billNo ?? ''), paidAt: c.paidAt ?? null }));
  const noRegister = !cv.registerRows;
  const split = noRegister ? { notReceived: [], found: [], paperwork: [], cashWait: [], closed: [] } : waitSplit({ day, rc: r, cash, oneSided });
  const splitN = split.notReceived.length + split.found.length + split.cashWait.length;
  const othersN = (waitPic?.look ?? []).filter((x) => x.day !== day).length;
  const waitN = splitN + (waitPic?.oddNumbers?.length ?? 0);
  // Before saving, the draft difference counts too (14 Nov 2026), so the Cash tab never shows ✓ while the count is off.
  const cashDiff = cash.confirmed ? (cash.settled ? 0 : cash.differencePaise) : cash.draft?.differencePaise;
  const cashN = ent.cash.left + (cashDiff ? 1 : 0);
  const cardN = Math.max(ent.card.left, cardLeft);
  const compLook = comp.lines.filter((l) => l.status === 'look').length;
  const leftLines = [
    cashN && [`Cash: ${ent.cash.left ? `${ent.cash.left} bill${ent.cash.left === 1 ? '' : 's'} left` : ''}${ent.cash.left && cashDiff ? ', and ' : ''}${cashDiff ? `the cash count is ${cashDiff < 0 ? 'short' : 'over'} by ₹ ${money(Math.abs(cashDiff))}${cash.confirmed ? '' : ' (draft)'}` : ''}`, 'pay:cash'],
    ent.upi.left && [`UPI: ${s.billsLeft} bill${s.billsLeft === 1 ? '' : 's'} not in the bank yet, ${s.creditsLeft} credit${s.creditsLeft === 1 ? '' : 's'} not matched`, 'pay:upi'],
    cardN && [`Card: ${cardN} left${r.cards?.waitingReport ? `, ${r.cards.waitingReport} waiting for the card report` : ''}`, 'pay:card'],
    compLook && [`Complimentary: ${compLook} bill${compLook === 1 ? '' : 's'} need${compLook === 1 ? 's' : ''} a look`, 'comp'],

  ].filter(Boolean);
  // A saved shift with nothing waiting (approved 20 Nov 2026): one short card, a line for what waits on earlier days and a
  // line for each tab with something left, each with its way there. The details stay on their tab.
  const quietSaved = r.confirmed && !noRegister && !(split.notReceived.length + split.found.length + split.paperwork.length + split.cashWait.length + (split.planned?.length ?? 0));
  const othersList = (waitPic?.look ?? []).filter((x) => x.day !== day);
  const otherDays = [...new Set(othersList.map((x) => x.day))];
  const TAB_NAME = { 'pay:cash': 'Cash', 'pay:upi': 'UPI', 'pay:card': 'Card', comp: 'Complimentary' };
  const plainLeft = ([t, go]) => (go === 'pay:cash' && cashDiff && !ent.cash.left
    ? [`Cash is ₹ ${money(Math.abs(cashDiff))} ${cashDiff > 0 ? 'more' : 'less'} than expected`, 'The reason and what to do are on the Cash tab']
    : [t, '']);
  const quietSavedHtml = quietSaved ? html`<section class="card" style="gap:0;padding-top:4px;padding-bottom:4px">
    <div class="list-row" style="padding:10px 0;align-items:center"><span>✓ Nothing waiting on ${dayLabel(day)}${othersList.length ? html`<div class="tiny note">Still waiting from ${otherDays.length === 1 ? dayLabel(otherDays[0]) : 'earlier days'}: ${othersList.slice(0, 3).map((x, i) => html`${i ? ', ' : ''}<span class="mono">${x.billNo}</span> ₹ ${rs(x.amountPaise)} ${MODE_LABELS[x.mode] ?? x.mode ?? ''}${otherDays.length > 1 ? ` (${dayLabel(x.day)})` : ''}`)}${othersList.length > 3 ? ` and ${othersList.length - 3} more` : ''}</div>` : ''}</span>
      ${othersList.length ? (otherDays.length === 1 ? html`<a class="btn plain dchip" href="#/b/${biz.id}/reconcile/${otherDays[0]}">Open ${dayLabel(otherDays[0])} ›</a>` : biz.actions.includes('reports.view') ? html`<a class="btn plain dchip" href="#/b/${biz.id}/dashboard">Open Today ›</a>` : '') : ''}</div>
    ${leftLines.map((l) => { const [t, sub] = plainLeft(l); return html`<div class="list-row" style="padding:10px 0;align-items:center;border-top:1px solid var(--line)"><span><span style="color:#B45309">●</span> ${t}${sub ? html`<div class="tiny note">${sub}</div>` : ''}</span>
      <button type="button" class="btn plain dchip" data-goto="${l[1]}">Open ${TAB_NAME[l[1]] ?? 'tab'} ›</button></div>`; })}
  </section>` : '';
  // To do (approved 17 Nov 2026): Save at the top and the steps before it, numbered. Each step opens on a click and
  // stays shut otherwise; a step with nothing left is green and shut. Every line has its fix in place.
  const notSame = todoNotSame(day);
  const canFixRow = canDecide && !r.confirmed;
  // Step 3, Same bill?: a register number that is probably another bill's.
  const sameQs = checks.flatMap((c) => (c.register?.rowId && c.register.uploadId && (!c.decision || c.auto) && !notSame.has(c.id)
    ? (c.numberFlags ?? []).filter((f) => f.billNo && f.billNo !== c.billNo).slice(0, 1).map((f) => ({ c, f })) : []));
  const inSame = new Set(sameQs.map((q) => q.c.id));
  // Step 2, Correct register rows: a number to fix on the row, a bill written twice, payments that do not add up, ₹0
  // with money paid.
  const rowChecks = checks.filter((c) => !inSame.has(c.id) && !(notSame.has(c.id) && !isOddBill(c.billNo)));
  const repeatedLines = r.confirmed ? [] : cv.repeatedLines ?? [];
  const unbal = r.confirmed ? [] : (cv.unbalancedRows ?? []).filter((x) => !sameQs.some((q) => q.c.register?.rowId === x.rowId));
  const inRows = new Set(rowChecks.map((c) => c.id));
  // Step 4, the differences to decide, each with Bookr's suggestion.
  const oldPosIds = new Set((r.oldPos?.bills ?? []).map((b) => b.comparisonId));
  const toDecide = r.confirmed ? [] : cv.comparisons.filter((c) => !c.decision && ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'].includes(c.difference)
    && !inSame.has(c.id) && !inRows.has(c.id) && !oldPosIds.has(c.id));
  const blockers = r.save?.blockers ?? [];
  const told = [/differences? (is|are) not decided/, /register rows? (is|are) not checked/, /appears more than once/, /do not add up to the bill amount/];
  const otherBlockers = blockers.filter((t) => !told.some((re) => re.test(t)));
  const draftN = Number((blockers.find((t) => /register rows? (is|are) not checked/.test(t)) ?? '').match(/^(\d+)/)?.[1] ?? 0);
  const sideText = (x) => (x ? `${MODE_LABELS[x.mode] ?? 'no payment written'} ₹ ${rs(x.amountPaise ?? 0)}` : 'nothing');
  const moreMenu = (c) => (canDecide ? html`<details class="menu"><summary class="btn plain dchip" aria-label="Other choices for bill ${c.billNo}">⋯</summary><div class="menu-pop" style="min-width:240px">${decideMenuHtml(c, cv)}</div></details>` : '');
  const openRow = (billNo) => html`<button type="button" class="btn plain dchip" data-bill-drawer="${billNo}|${day}">Open row</button>`;
  const lineOf = (no, what, acts) => html`<div class="todo-ln"><span class="mono todo-no">${no}</span><span class="todo-what">${what}</span><span class="todo-acts">${acts}</span><div class="form-msg"></div></div>`;
  const where = (l) => `Page ${l.pageNo ?? '?'} · line ${l.lineNo}`;
  const offText = (gross, paid) => (paid < gross ? `₹ ${rs(gross - paid)} discount` : `₹ ${rs(paid - gross)} more than the bill`);
  const repeatedHtml = (x) => {
    const good = x.lines.filter((l) => l.sameAsSoftware);
    const sugg = good.length && good.length < x.lines.length ? new Set(x.lines.filter((l) => !l.sameAsSoftware).map((l) => l.rowId)) : new Set();
    return html`<div class="todo-ln"><span class="mono todo-no">${x.billNo}</span><span class="todo-what">written ${x.lines.length === 2 ? 'twice' : `${x.lines.length} times`} in the register <span class="note">· ${x.lines.map(where).join(', ')}</span></span>
      <span class="todo-acts">${canFixRow ? html`<button type="button" class="btn dchip" data-todoopen="dup:${x.billNo}">Delete one ▾</button>` : ''}</span>
      <div class="todo-dup" data-todobox="dup:${x.billNo}" hidden><div class="note">Which line is the extra? Bookr keeps the other.</div>
      ${x.lines.map((l) => { const paid = l.payments.reduce((t, p) => t + p.amountPaise, 0); return html`<div class="todo-copy${sugg.has(l.rowId) ? ' sugg' : ''}"><div>
        <strong>${where(l)}</strong>${sugg.has(l.rowId) ? html` <span class="tchip">Bookr suggests deleting this</span>` : ''}
        <div class="tiny">₹ ${rs(l.amountPaise)} · paid ${l.payments.map((p) => `${MODE_LABELS[p.mode] ?? p.mode} ₹ ${rs(p.amountPaise)}${p.label ? ` (${p.label})` : ''}`).join(' + ') || 'nothing'}${paid && paid !== l.amountPaise ? ` · ${offText(l.amountPaise, paid)}` : ''}${l.remarks ? html` · <em>“${l.remarks}”</em>` : ''}</div>
        ${l.sameAsSoftware === true ? html`<div class="tiny" style="color:var(--teal)">✓ The software's amount</div>` : l.sameAsSoftware === false ? html`<div class="tiny error">Not the software's amount</div>` : ''}</div>
        <div class="todo-copy-acts"><button type="button" class="btn ${sugg.has(l.rowId) ? '' : 'plain'} dchip" data-dupdel="${l.rowId}" data-upload="${l.uploadId}" data-bill="${x.billNo}" data-where="${where(l)}">Delete this one</button>
          <a class="tiny" href="#/b/${biz.id}/review/${l.uploadId}/${l.rowId}">View photo</a></div></div>`; })}</div><div class="form-msg"></div></div>`;
  };
  const steps = r.confirmed ? [] : [
    { key: 'review', title: 'Check the register rows', left: draftN, sub: draftN ? `${draftN} row${draftN === 1 ? '' : 's'} not checked against the photos` : 'every row checked',
      link: html`<a class="btn plain dchip" href="#/b/${biz.id}/review?day=${day}">Open Review ›</a>` },
    { key: 'rows', title: 'Correct register rows', left: rowChecks.length + repeatedLines.length + unbal.length + paidZero.length,
      body: html`${rowChecks.map((c) => lineOf(c.billNo, html`₹ ${rs((c.register ?? c.software)?.amountPaise ?? 0)} · ${!c.software && isOddBill(c.billNo) ? 'the number fits no format, so it can never match' : c.reissuedAs ? `looks issued again as bill ${c.reissuedAs}: if so, leave this one out` : (c.numberFlags ?? []).map(numberFlagText).join(' ')}`,
          html`${openRow(c.billNo)}${moreMenu(c)}`))}
        ${repeatedLines.map(repeatedHtml)}
        ${unbal.map((x) => lineOf(x.billNo, html`₹ ${rs(x.amountPaise)}, paid ₹ ${rs(x.paidPaise)} · ₹ ${rs(Math.abs(x.amountPaise - x.paidPaise))} not explained`,
          html`${canFixRow && x.paidPaise > 0 ? html`<button type="button" class="btn plain dchip" data-rowoff="${x.rowId}" data-upload="${x.uploadId}" data-bill="${x.billNo}" data-paid="${x.paidPaise}">${x.paidPaise < x.amountPaise ? `₹ ${rs(x.amountPaise - x.paidPaise)} discount` : `₹ ${rs(x.paidPaise - x.amountPaise)} tip`}</button>` : ''}${openRow(x.billNo)}`))}
        ${paidZero.map((c) => lineOf(c.billNo, html`₹ 0${c.register?.discountPaise > 0 ? ` after a ₹ ${rs(c.register.discountPaise)} discount` : ''}, but ₹ ${rs(c.register.paidPaise)} is paid on its row`, openRow(c.billNo)))}` },
    { key: 'same', title: 'Same bill?', left: sameQs.length,
      body: html`${sameQs.map(({ c, f }) => { const u = (cv.unbalancedRows ?? []).find((x) => x.rowId === c.register.rowId);
        return lineOf(c.billNo, html`₹ ${rs(c.register.amountPaise ?? 0)} · ${f.kind === 'in_range' ? html`= <strong>${f.billNo}</strong>? fits ${dayLabel(f.date)}'s running numbers, 1 to ${f.max}` : html`= <strong>${f.billNo}</strong>? ${numberFlagText(f).replace(/^Same bill as [^?]+\? |^Could be [^:]+: /, '')}`}${u ? ` · paid ₹ ${rs(u.paidPaise)}` : ''}`,
          html`${canFixRow ? html`<button type="button" class="btn dchip" data-renumber="${c.register.rowId}" data-upload="${c.register.uploadId}" data-from="${c.billNo}" data-no="${f.billNo}">Yes, change to ${f.billNo}</button>
            <button type="button" class="btn plain dchip" data-notsame="${c.id}" data-bill="${c.billNo}">No</button>` : ''}${openRow(c.billNo)}`); })}` },
    { key: 'decide', title: 'Decide the differences', left: toDecide.length + (r.oldPos?.bills?.length ?? 0),
      body: html`${oldPosHtml(biz, r)}
        ${toDecide.filter((c) => suggestionOf(cv, c) && !suggestionOf(cv, c).toCard).length > 1 && canDecide ? html`<div class="form-row" style="gap:6px;margin:4px 0"><button type="button" class="btn plain dchip" data-acceptall>Accept all ${toDecide.filter((c) => suggestionOf(cv, c) && !suggestionOf(cv, c).toCard).length} suggestions</button></div>` : ''}
        ${toDecide.map((c) => { const g = suggestionOf(cv, c);
          return lineOf(c.billNo, html`${c.software && c.register ? `software ${sideText(c.software)}, register ${sideText(c.register)}` : c.software ? `software ${sideText(c.software)}, not in the register` : `register ${sideText(c.register)}, not in the software`}
            ${g ? html`<div class="tiny" style="color:var(--teal-ink);white-space:normal">${g.text}</div>` : ''}`,
            html`${canDecide && g ? (g.toCard ? html`<button type="button" class="btn dchip" data-machinetocard="${c.id}">Accept: card ₹ ${rs(g.toCard.amountPaise)}</button>`
              : html`<button type="button" class="btn dchip" data-accept="${c.id}" data-d="${g.suggest}" data-bill="${c.billNo}">Accept: ${g.suggest === 'use_software' ? 'Use software' : 'Use register'}</button>`) : ''}${moreMenu(c)}`); })}` },
    ...(otherBlockers.length ? [{ key: 'other', title: 'Also before saving', left: otherBlockers.length, body: html`${otherBlockers.map((t) => html`<div class="todo-ln"><span class="todo-what">${t}</span></div>`)}` }] : []),
  ];
  const stepsLeft = steps.filter((x) => x.left).length;
  const openStep = todoOpenStep(day);
  const todoN = r.confirmed ? 0 : stepsLeft + 1;
  const todoHtml = html`
    ${r.confirmed ? html`<div class="note">Saved shift: each fix here is a recorded correction, and can be undone.</div>` : html`<section class="card todo-top">
      <div><strong>${dayLabel(day)} shift · not saved</strong><div class="note">${stepsLeft ? `Before you can save: ${stepsLeft} step${stepsLeft === 1 ? '' : 's'} left` : 'Ready to save ✓'} · matches and decisions are drafts until then.</div></div>
      ${canDecide ? html`<button class="btn" type="button" id="savereconcile" ${r.save?.canSave ? '' : 'disabled'}>Save reconcile</button>` : html`<span class="note">Owner or Accountant saves.</span>`}
      <div class="form-msg" id="savemsg" style="flex-basis:100%"></div></section>`}
    ${P.conflictsHtml}
    ${paidHereNotice((r.paidLater ?? []).map((x) => ({ billNo: x.billNo, amountPaise: x.amountPaise, fromDay: x.fromDay, mode: x.rowMode })))}
    ${steps.map((x, i) => html`<section class="card todo-step${x.left ? '' : ' done'}" data-step="${x.key}">
      <div class="todo-sh" ${x.body && x.left ? html`data-todostep="${x.key}" role="button" tabindex="0" aria-expanded="${openStep === x.key}"` : ''}>
        <span class="todo-n">${x.left ? i + 1 : '✓'}</span><span class="todo-t"><strong>${x.title}</strong> <span class="note">· ${x.left ? (x.sub ?? `${x.left} left`) : x.sub ?? 'done'}</span></span>
        ${x.link ?? (x.body && x.left ? html`<span class="todo-car">${openStep === x.key ? '▾' : '▸'}</span>` : '')}</div>
      ${x.body && x.left ? html`<div class="todo-body" ${openStep === x.key ? '' : 'hidden'}>${x.body}</div>` : ''}</section>`)}
    ${(r.columnHints ?? []).length >= 3 ? html`<section class="card"><div class="note"><strong>${r.columnHints.length} UPI payments are written under the wrong account's column</strong> this shift
      (the money came into another account). Staff may be using the wrong UPI column: worth a word. Each one is on the UPI tab to change.</div></section>` : ''}
    <div data-rsec="wait"><div id="waitmsg"></div>${quietSaved ? quietSavedHtml : noRegister ? html`<section class="card"><div class="note"><strong>No register rows for this shift.</strong> Read its photos on <a href="${screenHref(biz, 'review', day)}">Register</a>, or bring them in if they are not uploaded. Until then every bill looks missing in the register, so nothing is shown as waiting.</div></section>`
      : waitCardHtml(biz, day, split, waitPic, { canDecide, confirmed: r.confirmed, canWriteoff: biz.actions.includes('cash.writeoff'), others: othersN })}
      ${oddNumbersHtml(biz, waitPic, canDecide)}</div>
    ${quietSaved ? '' : html`<div class="todo-other"><span class="note">${leftLines.length ? 'On the other tabs:' : 'Nothing left on the other tabs.'}</span>
      ${leftLines.map(([t, go]) => html`<button type="button" class="btn plain dchip" data-goto="${go}">${t} ›</button>`)}</div>`}`;
  // One row of tabs (approved 14 Nov 2026): To do · Cash · UPI · Card · All bills. Waiting and Complimentary are sections of To do.
  const curTab = top === 'pay' ? (['cash', 'upi', 'card'].includes(tab) ? tab : 'cash') : top === 'all' ? 'all' : top === 'stmt' ? 'stmt' : top === 'chg' ? 'chg' : top === 'comp' && comp.lines.length ? 'comp' : 'todo';
  const oneTab = (key, label, n) => html`<button type="button" role="tab" data-rtab1="${key}" class="${curTab === key ? 'on' : ''}" aria-selected="${curTab === key}">${label}${n ? html` <span class="chip wait">${n}</span>` : ''}</button>`;
  const topBtn = (key, label, n) => html`<button type="button" role="tab" data-rtopbtn="${key}" class="${top === key ? 'on' : ''}" aria-selected="${top === key}">${label}${n ? html` <span class="chip wait">${n}</span>` : html` <span class="chip ok">✓</span>`}</button>`;
  const tabBtn = (key, label, n) => html`<button type="button" role="tab" data-rtab="${key}" class="${tab === key ? 'on' : ''}" aria-selected="${tab === key}">${label}${n ? html` <span class="chip wait">${n}</span>` : html` <span class="chip ok">✓</span>`}</button>`;
  render(shell(biz, 'reconcile', 'Reconcile', '', html`
    ${shiftBar(biz, day, 'reconcile')}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <span class="note">${r.confirmed ? 'Saved' : 'Not saved'}${todoN - (r.confirmed ? 0 : 1) > 0 ? ` · ${todoN - (r.confirmed ? 0 : 1)} to do` : ''}</span>
      <div style="display:flex;gap:8px;align-items:center">${!r.confirmed && biz.actions.includes('sales.decide') ? html`<button class="btn" type="button" id="savehead">Save shift</button>` : ''}${P.shiftMenu}</div></div>
    <div id="recmsg"></div>
    <div class="seg mode-tabs" role="tablist" aria-label="Shift" style="margin:4px 0 10px">
      ${oneTab('todo', 'To do', todoN + waitN)}${oneTab('cash', 'Cash', cashN)}${oneTab('upi', 'UPI', ent.upi.left)}${oneTab('card', 'Card', cardN)}${comp.lines.length ? oneTab('comp', 'Complimentary', compLook) : ''}${oneTab('all', 'All bills', allLeft)}${oneTab('stmt', 'Statement', 0)}${oneTab('chg', 'Changes', 0)}</div>
    <div data-rtop="todo" ${top === 'todo' ? '' : 'hidden'}>${todoHtml}
    </div>
    ${comp.lines.length ? html`<div data-rtop="comp" ${curTab === 'comp' ? '' : 'hidden'}><div data-rsec="comp">${compPanelHtml(biz, comp, !r.confirmed && biz.actions.includes('sales.decide'))}</div></div>` : ''}
    ${statementPanel(top === 'stmt')}
    ${changesPanel(top === 'chg')}
    <div data-rtop="all" ${top === 'all' ? '' : 'hidden'}>
      ${P.bar}
      <div id="allmsg"></div>
      ${P.banners}
      ${P.shiftPane}
    </div>
    <div data-rtop="pay" ${top === 'pay' ? '' : 'hidden'}>
    <div data-rpanel="cash" ${tab === 'cash' ? '' : 'hidden'}>
      ${cashOnCardHtml}
      ${cashPanelHtml(biz, cash, { decide: true, oldPos: new Set(cv.comparisons.filter((c) => c.oldPos).map((c) => c.id)), byUpi: new Map((cv.warnings ?? []).filter((w) => w.byUpi && w.comparisonId).map((w) => [w.comparisonId, { ...w, billType: cmpTypeOf(cv, w.comparisonId) }])) })}
    </div>
    <div data-rpanel="card" ${tab === 'card' ? '' : 'hidden'}>
      ${paidLaterHtml(biz, r, 'card')}
      ${r.cards?.trial ? trialCardSection(biz, r.cards, biz.actions.includes('bank.link') ? { unbilled: r.unbilledHeads ?? [], income: heads.filter((h) => h.type === 'income') } : null, { entries: ent.card, oldPos: r.oldPos, cv, earlier: earlierCard(r) }) : r.cards ? cardSection(biz, r.cards, heads) : ''}
      ${entriesHtml(biz, day, r.cards?.trial ? withEarlier(ent.card, r) : withSavedCards(ent.card, r.cards), 'card', cv)}
      ${machineUpiLine(r.cards)}
    </div>
    <div data-rpanel="upi" ${tab === 'upi' ? '' : 'hidden'}>
      ${paidLaterHtml(biz, r, 'upi')}
    <section class="card cmp-bar">
      <div class="cmp-top">
        <div class="cmp-day">
          ${done ? html`<span class="chip ok">✓ UPI reconciled</span>` : ''}
          ${!r.confirmed && r.open && (s.bills - s.billsLeft || planCards.length) ? html`<span class="chip ok">Done: ${s.bills - s.billsLeft} bill${s.bills - s.billsLeft === 1 ? '' : 's'}${planCards.length ? ` · ${planCards.length} on save` : ''}</span>` : ''}
          ${r.confirmed ? html`<span class="chip ok">Saved</span>` : html`<span class="chip">Not saved</span>`}
          ${near.length + isSameCards.length ? html`<button type="button" class="chip wait" style="border:0;cursor:pointer" data-jump="nearpairs">${near.length + isSameCards.length} to check ↓</button>` : ''}
        </div>
        <a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/bank?from=${day}&to=${day}&tab=in">Bank</a>
      </div>
      ${upiBookHtml(r)}
    </section>
    ${covered ? '' : html`<div class="cmp-warn">⚠ Bank data is not in for the whole shift: the latest line is ${r.coverage.lastBankAt ? when(r.coverage.lastBankAt) : 'missing'}, the shift ends ${when(r.coverage.shiftEnd)}. Sync the bank first; until then, bills with no credit are not flagged.</div>`}
    ${nearSection()}
    ${r.confirmed && done && nothing ? html`${repaidHtml(v)}
    <details class="ub-hand"><summary>Match by hand ›</summary>${pairPanel(v, waiting, { noRepaid: true })}</details>
    ${noBillSection}` : r.confirmed ? html`<div class="lane-h"><div class="seg" id="recview"><button type="button" data-view="cards" class="${view === 'cards' ? 'on' : ''}">Suggestions</button><button type="button" data-view="open" class="${view === 'open' ? 'on' : ''}">All open entries</button></div></div>
    ${view === 'cards' ? suggestions : pairPanel(v, waiting)}
    ${noBillSection}` : r.open ? trialLists : suggestions}
    ${upiDecide ? html`<section class="card left-box" style="flex-direction:row;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><span>${upiDecide} UPI bill${upiDecide === 1 ? '' : 's'} where the register and the software differ: decide on To do</span><button type="button" class="btn plain" data-gotodo>Open To do ›</button></section>` : ''}
    ${onSaveHtml || choicesHtml(r) || wouldMatch || (doneFold && !r.confirmed) ? html`<div class="grp-h ok">✓ Done</div>` : ''}
    ${onSaveHtml}
    ${choicesHtml(r)}
    ${wouldMatch}
    ${r.confirmed ? '' : doneFold}
    ${entriesHtml(biz, day, ent.upi, 'upi', cv)}
    </div>
    </div>`));
  wireShell();
  app.querySelectorAll('[data-rtab]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem(RECONCILE_TAB_KEY, b.dataset.rtab); } catch { /* storage unavailable */ }
    app.querySelectorAll('[data-rtab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    app.querySelectorAll('[data-rpanel]').forEach((x) => { x.hidden = x.dataset.rpanel !== b.dataset.rtab; });
  }));
  wireCashPanel(biz, day, reload, document.getElementById('recmsg'), cash);
  const saveMsg = document.getElementById('savemsg');
  document.getElementById('savereconcile')?.addEventListener('click', async (e) => {
    const n = (r.choices?.length ?? 0) + (r.clear?.length ?? 0);
    if (!confirm(`Save the ${dayLabel(day)} shift? Its sales are booked as income${n ? `, and ${n} match${n === 1 ? ' is' : 'es are'} made` : ''}. Only an Owner can reopen it.`)) return;
    e.currentTarget.disabled = true;
    try {
      const res = await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/confirm`, {});
      await reload();
      doneToast(`Saved: ${res.rows} sale${res.rows === 1 ? '' : 's'} booked, ${res.matched} matched to the bank${res.cardMatched ? `, ${res.cardMatched} to the card machine` : ''}.${res.skipped?.length ? ` Not matched (the credit no longer fits): ${res.skipped.join(', ')}.` : ''}`);
    } catch (err) { e.currentTarget.disabled = false; showError(saveMsg, err); }
  });
  const oldGo = document.getElementById('oldposgo');
  const oldBoxes = () => [...app.querySelectorAll('[data-oldpos]')].filter((x) => x.checked);
  app.querySelectorAll('[data-oldpos]').forEach((x) => x.addEventListener('change', () => {
    const n = oldBoxes().length;
    oldGo.disabled = !n;
    oldGo.textContent = `Use register for ${n} old POS bill${n === 1 ? '' : 's'}`;
  }));
  oldGo?.addEventListener('click', async () => {
    const ticked = oldBoxes();
    oldGo.disabled = true;
    try {
      const skipped = [];
      for (const [note, kind] of [[OLD_POS_NOTE, 'full'], [SHORT_OLD_POS_NOTE, 'short']]) {
        const ids = ticked.filter((x) => x.dataset.kind === kind).map((x) => x.dataset.oldpos);
        if (ids.length) skipped.push(...((await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/register-only`, { ids, note })).skipped ?? []));
      }
      await reload();
      doneToast(`${ticked.length - skipped.length} old POS bill${ticked.length - skipped.length === 1 ? '' : 's'} counted from the register.${skipped.length ? ` Not changed: ${skipped.map((x) => `${x.billNo} (${x.reason})`).join(', ')}.` : ''}`);
    } catch (err) { oldGo.disabled = false; showError(document.getElementById('oldposmsg'), err); }
  });
  app.querySelectorAll('[data-plandel]').forEach((b) => b.addEventListener('click', async () => {
    const a = planCards[Number(b.dataset.plandel)]?.actions?.[0];
    if (!a) return;
    b.disabled = true;
    try { await apiFull(a.method, a.path, a.body); await reload(); }
    catch (err) { b.disabled = false; showError(document.getElementById('recmsg'), err); }
  }));
  app.querySelectorAll('[data-unchoose]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await apiFull('DELETE', `/businesses/${biz.id}/shifts/${day}/choices/${b.dataset.unchoose}`, {}); await reload(); }
    catch (err) { b.disabled = false; showError(document.getElementById('recmsg'), err); }
  }));
  app.querySelectorAll('[data-rpanel], [data-rtop="todo"]').forEach((root) => wireDecideMenu(biz, day, cv, root, async (fn) => {
    try { await fn(); await reload(); } catch (err) { showError(document.getElementById('recmsg'), err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }, `#/b/${biz.id}/reconcile/${day}`));
  wirePayTables(app);
  app.querySelectorAll('[data-rtop="todo"], [data-rtop="pay"]').forEach((root) => wireOneClickFixes(biz, root, reload));
  if (!r.confirmed) wireTodo(biz, day, cv, app.querySelector('[data-rtop="todo"]'), reload);
  P.wire(app.querySelector('[data-rtop="all"]'), document.getElementById('allmsg'));
  P.wireShift(app.querySelector('[data-rtop="todo"]'), document.getElementById('recmsg'));
  P.wireShift(document.getElementById('shiftmenu'), document.getElementById('recmsg'));
  const showTop = (key) => {
    recTopNow = key;
    app.querySelectorAll('[data-rtopbtn]').forEach((x) => { x.classList.toggle('on', x.dataset.rtopbtn === key); x.setAttribute('aria-selected', String(x.dataset.rtopbtn === key)); });
    app.querySelectorAll('[data-rtop]').forEach((x) => { x.hidden = x.dataset.rtop !== key; });
  };
  app.querySelectorAll('[data-rtopbtn]').forEach((b) => b.addEventListener('click', () => showTop(b.dataset.rtopbtn)));
  const loadStatement = wireStatement(biz, day, statementUses(r, cv, near), () => go('upi'));
  const loadChanges = wireChanges(biz, day, reload);
  const go = (key) => {
    const pay = ['cash', 'upi', 'card'].includes(key);
    showTop(pay ? 'pay' : key);
    if (key === 'stmt') loadStatement();
    if (key === 'chg') loadChanges();
    if (pay) {
      try { localStorage.setItem(RECONCILE_TAB_KEY, key); } catch { /* storage unavailable */ }
      app.querySelectorAll('[data-rpanel]').forEach((x) => { x.hidden = x.dataset.rpanel !== key; });
    }
    app.querySelectorAll('[data-rtab1]').forEach((x) => { x.classList.toggle('on', x.dataset.rtab1 === key); x.setAttribute('aria-selected', String(x.dataset.rtab1 === key)); });
  };
  app.querySelectorAll('[data-rtab1]').forEach((b) => b.addEventListener('click', () => go(b.dataset.rtab1)));
  if (top === 'stmt') loadStatement();
  if (top === 'chg') loadChanges();
  document.getElementById('savehead')?.addEventListener('click', () => {
    go('todo');
    const btn = document.getElementById('savereconcile');
    if (btn && !btn.disabled) btn.click(); else btn?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  app.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    const [key, mode] = b.dataset.goto.split(':');
    if (key === 'wait') { go('todo'); app.querySelector('[data-rsec="wait"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    go(mode ?? (key === 'pay' ? 'cash' : key));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  const waitAct = async (fn) => {
    try { await fn(); await reload(); } catch (err) { showError(document.getElementById('waitmsg'), err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  if (app.querySelector('[data-rsec="wait"]')) wireWaiting(biz, app.querySelector('[data-rsec="wait"]'), waitAct);
  // Book a cash bill not received as a shortage (18 Nov 2026): only its amount, with a note.
  app.querySelectorAll('[data-shortbill]').forEach((b) => b.addEventListener('click', () => {
    const note = (prompt(`Bill ${b.dataset.bill}: ₹ ${money(Number(b.dataset.amt))} cash never reached the drawer. Book it as a cash shortage? Write why:`) ?? '').trim();
    if (note) waitAct(() => apiFull('POST', `/businesses/${biz.id}/shifts/${day}/cash/shortage`, { note, comparisonId: b.dataset.shortbill }));
  }));
  const msg = document.getElementById('recmsg');
  wireShiftBar(biz);
  document.querySelectorAll('#recview [data-view]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem(RECONCILE_VIEW_KEY, b.dataset.view); } catch { /* storage unavailable */ }
    reload();
  }));
  // Fixes and open entries work on both sides of confirming; the matching below needs a confirmed shift.
  wireExplain({ cards: [...cols, ...fixes, ...noCredit] }, reload, biz);
  app.querySelectorAll('[data-nearmatch]').forEach((b) => b.addEventListener('click', async () => {
    const p = near[Number(b.dataset.nearmatch)];
    b.disabled = true;
    try {
      const undo = await matchNearPair(biz, day, p);
      await reload();
      doneToast(`Bill ${p.bill.billNo}: ${p.kind === 'register' ? 'register used, and ' : p.diff ? `₹ ${money(Math.abs(p.diff))} ${p.diff > 0 ? 'tip' : 'discount'} written, and ` : ''}matched to ₹ ${money(p.credit.amountPaise)} when you save the shift.`, undo, reload);
    } catch (err) { b.disabled = false; showError(b.closest('[data-card]').querySelector('.form-msg'), err); }
  }));
  app.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  app.querySelectorAll('[data-ubopen]').forEach((b) => b.addEventListener('click', () => {
    const row = app.querySelector(`[data-ubsub="${b.dataset.ubopen}"]`);
    if (!row) return;
    row.hidden = !row.hidden;
    b.setAttribute('aria-expanded', String(!row.hidden));
    b.querySelector('.ub-arrow').textContent = row.hidden ? '▸' : '▾';
  }));
  app.querySelectorAll('[data-gotodo]').forEach((b) => b.addEventListener('click', () => { app.querySelector('[data-rtab1="todo"]')?.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  // Book ▾ on a credit in the left-over list opens that credit's choices in Money with no bill.
  app.querySelectorAll('[data-nbjump]').forEach((b) => b.addEventListener('click', () => {
    const row = app.querySelector(`[data-nbrow="${b.dataset.nbjump}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const open = row.querySelector('[data-nbopen]');
    if (open?.getAttribute('aria-expanded') !== 'true') open?.click();
  }));
  const trialBox = document.getElementById('trialopen');
  if (trialBox) wireTray({ biz, day, reload, root: trialBox, open: r.open, lone, mode: 'upi',
    nearby: async () => (await api('GET', `/businesses/${biz.id}/shifts/${day}/nearby`)).credits,
    post: (pairs) => apiFull('POST', `/businesses/${biz.id}/shifts/${day}/choices`, { pairs: pairs.map((p) => ({ bankRowId: p.credit.id, comparisonIds: p.bills.map((b) => b.id) })) }) });
  if (trialBox) wireNotMatched(trialBox, () => nbBulk());
  if (!r.confirmed) wireTrialCards(biz, day, r.cards, reload);
  wirePaidLater(biz, reload);
  app.querySelectorAll('#trialopen [data-upimachine]').forEach((b) => b.addEventListener('click', () => upiOnMachineClick(biz, day, b, reload, r.cards)));
  if (r.cards?.trial) app.querySelectorAll('#trialopen [data-tpaidcard]').forEach((b) => b.addEventListener('click', () => paidOnCardClick(biz, day, r.cards.needs.find((x) => x.payment.id === b.dataset.tpaidcard), b, reload)));
  app.querySelectorAll('[data-paidupi]').forEach((b) => b.addEventListener('click', () => paidByUpiClick(biz, day, (r.byUpi ?? []).find((o) => o.comparisonId === b.dataset.paidupi), b, reload)));
  const act = async (fn, toast) => {
    try {
      await fn(); await reload();
      if (toast) doneToast(toast.text, toast.undo, reload);
    } catch (err) { showError(document.getElementById('recmsg') ?? msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  const unmatch = (id) => apiFull('DELETE', `/businesses/${biz.id}/bank-rows/${id}/match`, {}).catch((e) => { if (!/not matched|nothing/i.test(e.message)) throw e; });
  const ticked = (attr) => [...app.querySelectorAll(`[${attr}]`)].filter((x) => x.checked);
  const clearBtn = document.getElementById('matchclear');
  app.querySelectorAll('[data-clear]').forEach((x) => x.addEventListener('change', () => {
    const n = ticked('data-clear').length;
    clearBtn.textContent = n === r.clear.length ? `Match all ${n}` : `Match ${n} ticked`; clearBtn.disabled = !n;
  }));
  clearBtn?.addEventListener('click', () => {
    clearBtn.disabled = true;
    const ids = ticked('data-clear').map((x) => x.dataset.clear);
    act(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/match-clear`, { ids }),
      { text: `Matched ${ids.length} bill${ids.length === 1 ? '' : 's'} to the bank.`, undo: () => eachAtOnce(ids, unmatch) });
  });
  const likelyBtn = document.getElementById('matchlikely');
  app.querySelectorAll('[data-likely]').forEach((x) => x.addEventListener('change', () => {
    const n = ticked('data-likely').length;
    likelyBtn.textContent = `Match ${n} ticked`; likelyBtn.disabled = !n;
  }));
  likelyBtn?.addEventListener('click', () => {
    likelyBtn.disabled = true;
    const pairs = ticked('data-likely').map((x) => r.likely.find((l) => l.creditId === x.dataset.likely));
    act(() => eachAtOnce(pairs, (p) => apiFull('POST', `/businesses/${biz.id}/bank-rows/${p.creditId}/match`, { transactionIds: p.transactionIds })),
      { text: `Matched ${pairs.length} bill${pairs.length === 1 ? '' : 's'} to the bank.`, undo: () => eachAtOnce(pairs, (p) => unmatch(p.creditId)) });
  });
  // Money with no bill: each row, and the ticked rows together. Every booking can be undone (Open again).
  const nbBase = `/businesses/${biz.id}/bank-rows`;
  const nbWhat = (id) => app.querySelector(`[data-nbwhat="${id}"]`)?.value.trim() || null;
  const nbReopen = (ids) => () => eachAtOnce(ids, (id) => apiFull('POST', `${nbBase}/${id}/reopen`, {}));
  const nbMany = async (items) => { const res = await apiFull('POST', `${nbBase}/book-many`, { items }); if (!res.booked) throw new Error(res.skipped.join(' ') || 'Not booked.'); return res; };
  // Ticked in Money with no bill (a saved shift), or credits with no bill ticked on Not matched yet with no bill ticked.
  const loTicked = (side) => [...app.querySelectorAll(`#trialopen [data-tside="${side}"]`)].filter((x) => x.checked);
  const nbTicks = () => [...[...app.querySelectorAll('[data-nbtick]')].filter((x) => x.checked).map((x) => x.dataset.nbtick),
    ...(loTicked('bl').length ? [] : loTicked('cr').map((x) => x.dataset.id).filter((id) => nbIds.has(id)))];
  const nbBulk = () => {
    const n = nbTicks().length;
    const bar = document.getElementById('nbbulk');
    if (bar) { bar.hidden = n < 1; document.getElementById('nbcount').textContent = `${n} credit${n === 1 ? '' : 's'} with no bill ticked:`; }
  };
  app.querySelectorAll('[data-nbtick]').forEach((x) => x.addEventListener('change', nbBulk));
  // One row's choices open at a time (11 Nov 2026): the list stays one line per credit.
  app.querySelectorAll('[data-nbopen]').forEach((b) => b.addEventListener('click', () => {
    const row = b.closest('.nb-row');
    const acts = row.querySelector('.nb-acts');
    const opening = acts.hidden;
    app.querySelectorAll('#nobill .nb-acts').forEach((a) => { a.hidden = true; });
    app.querySelectorAll('[data-nbopen]').forEach((x) => { x.setAttribute('aria-expanded', 'false'); x.classList.remove('on'); });
    acts.hidden = !opening;
    b.setAttribute('aria-expanded', String(opening));
    b.classList.toggle('on', opening);
    if (opening) acts.querySelector('input')?.focus();
  }));
  const nbMenus = [...app.querySelectorAll('details.nb-more')];
  nbMenus.forEach((d) => d.addEventListener('toggle', () => { if (d.open) nbMenus.forEach((o) => { if (o !== d) o.open = false; }); }));
  if (!window.nbMenuClose) { window.nbMenuClose = true; document.addEventListener('click', (e) => document.querySelectorAll('details.nb-more[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; })); }
  document.getElementById('nbtickall')?.addEventListener('change', (e) => { app.querySelectorAll('[data-nbtick]').forEach((x) => { x.checked = e.target.checked; }); nbBulk(); });
  app.querySelectorAll('[data-nbsale]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.nbsale;
    const label = b.dataset.type === 'room' ? 'Room' : 'F&B';
    b.disabled = true;
    act(() => nbMany([{ rowId: id, billType: b.dataset.type, item: nbWhat(id) }]), { text: `Booked as Unbilled ${label}.`, undo: nbReopen([id]) }).finally(() => { b.disabled = false; });
  }));
  app.querySelectorAll('[data-nbmany]').forEach((b) => b.addEventListener('click', () => {
    const ids = nbTicks();
    if (!ids.length) return;
    const label = b.dataset.nbmany === 'room' ? 'Room' : 'F&B';
    b.disabled = true;
    act(async () => { const res = await nbMany(ids.map((id) => ({ rowId: id, billType: b.dataset.nbmany, item: nbWhat(id) }))); if (res.skipped.length) alert(`Not booked: ${res.skipped.join(' ')}`); },
      { text: `${ids.length} booked as Unbilled ${label}.`, undo: nbReopen(ids) }).finally(() => { b.disabled = false; });
  }));
  app.querySelectorAll('[data-nbsmall]').forEach((b) => b.addEventListener('click', () => {
    const ids = b.dataset.nbsmall.split(',');
    b.disabled = true;
    act(async () => { const res = await nbMany(ids.map((id) => ({ rowId: id, billType: 'fnb', item: nbWhat(id) }))); if (res.skipped.length) alert(`Not booked: ${res.skipped.join(' ')}`); },
      { text: `${ids.length} small amounts booked as Unbilled F&B.`, undo: nbReopen(ids) }).finally(() => { b.disabled = false; });
  }));
  app.querySelectorAll('[data-nbadvance]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.nbadvance;
    const who = prompt('Advance received: from which guest (name, room or booking)?', nbWhat(id) ?? '');
    if (!who?.trim()) return;
    act(() => nbMany([{ rowId: id, billType: 'room', item: `Advance: ${who.trim()}` }]), { text: 'Booked as an advance. Its room bill joins it when it comes.', undo: nbReopen([id]) });
  }));
  app.querySelectorAll('[data-nbhold]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.nbhold;
    const refund = b.dataset.kind === 'refund';
    const note = prompt(refund ? 'Refund due: to whom, and why (e.g. Rahul K, paid twice)?' : 'Tip for staff: for whom, or a note?', nbWhat(id) ?? '');
    if (!note?.trim()) return;
    act(() => apiFull('POST', `${nbBase}/${id}/hold`, { kind: b.dataset.kind, note: note.trim() }),
      { text: refund ? 'Held as a refund due: not counted as income.' : 'Held as a tip for staff: not counted as income.', undo: nbReopen([id]) });
  }));
  app.querySelectorAll('[data-nbbook]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.nbbook;
    const headId = app.querySelector(`[data-nbhead="${id}"]`)?.value;
    if (!headId) { alert('Choose the head first.'); return; }
    act(() => nbMany([{ rowId: id, headId, item: nbWhat(id) }]), { text: `Booked under ${heads.find((h) => h.id === headId)?.name ?? 'the head'}.`, undo: nbReopen([id]) });
  }));
  app.querySelectorAll('[data-nbignore]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.nbignore;
    const note = prompt('Why is this money not business?', nbWhat(id) ?? '');
    if (!note?.trim()) return;
    act(() => apiFull('POST', `${nbBase}/${id}/ignore`, { note: note.trim() }), { text: 'Skipped: not business.', undo: nbReopen([id]) });
  }));
  // Check first (Stage 5): an owed bill, part of a bill still waiting, or a payment made twice, shown on the row.
  app.querySelectorAll('[data-nbcheck]').forEach(async (el) => {
    const id = el.dataset.nbcheck;
    const chk = await api('GET', `${nbBase}/${id}/checks`).catch(() => null);
    if (!chk || !(chk.owed.length || chk.parts.length || chk.paidTwice)) return;
    // Near a bill still waiting (21 Nov 2026): this payment, alone or with one or two others, is nearly that bill.
    const nearBill = chk.parts.map((o, i) => {
      const all = [noBillLeft.find((c) => c.creditId === id)?.amountPaise ?? 0, ...o.credits.map((x) => x.amountPaise)];
      const got = all.reduce((t, x) => t + x, 0);
      const d = got - o.amountPaise;
      return html`<div class="nb-near"><span>${o.credits.length ? `These ${all.length} payments (${all.map((x) => `₹ ${money(x).replace(/\.00$/, '')}`).join(' + ')}) make` : 'Near'} bill <span class="mono">${o.billNo ?? ''}</span> (₹ ${money(o.amountPaise).replace(/\.00$/, '')}, ${dayLabel(o.day)}, still waiting)${d ? ` · ₹ ${money(Math.abs(d)).replace(/\.00$/, '')} ${d < 0 ? 'less' : 'more'}` : ''}</span>
        ${o.exact ? html`<button class="btn dchip" type="button" data-nbpart="${i}">Match</button>` : html`<a class="btn plain dchip" href="#/b/${biz.id}/reconcile/${o.day}?tab=upi">Open ${dayLabel(o.day).replace(/\s\d{4}$/, '')} ›</a>`}</div>`;
    });
    if (!(chk.owed.length || chk.paidTwice)) {
      el.innerHTML = html`${nearBill}`.__html;
    } else el.innerHTML = html`${nearBill}<div class="cmp-warn" style="margin:0"><strong>Check first:</strong>
      ${chk.owed.map((o) => html`<div>Bill <span class="mono">${o.billNo ?? ''}</span> (₹ ${money(o.amountPaise)}, ${dayLabel(o.day)}) was closed as ${o.note.replace(/^Owed by /, 'owed by ')}
        <button class="btn plain dchip" type="button" data-nbowed="${o.txId}">Match to the owed bill</button></div>`)}
      ${chk.paidTwice ? html`<div>The same ₹ ${money(noBillLeft.find((c) => c.creditId === id)?.amountPaise ?? 0)} came in ${chk.paidTwice.minutes} minute${chk.paidTwice.minutes === 1 ? '' : 's'} apart${chk.paidTwice.samePayer ? ', from the same payer' : ''}: maybe paid twice (a refund due?).</div>` : ''}</div>`.__html;
    el.querySelectorAll('[data-nbpart]').forEach((b) => b.addEventListener('click', () => {
      const o = chk.parts[Number(b.dataset.nbpart)];
      act(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/match-set`, { rowIds: [id, ...o.credits.map((x) => x.id)], transactionIds: [o.txId] }),
        { text: `Matched to bill ${o.billNo ?? ''}.`, undo: () => Promise.all([id, ...o.credits.map((x) => x.id)].map((x) => apiFull('DELETE', `/businesses/${biz.id}/bank-rows/${x}/match`, {}))) });
    }));
    el.querySelectorAll('[data-nbowed]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('POST', `${nbBase}/${id}/owed-paid`, { txId: b.dataset.nbowed }),
      { text: 'Matched to the owed bill.', undo: () => apiFull('DELETE', `${nbBase}/${id}/match`, {}) })));
  });
  // The rest matches against a saved shift.
  if (!r.confirmed) return;
  app.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => {
    b.disabled = true;
    act(async () => { if (!await bookCredit(biz, b.dataset.book, { headId: b.dataset.head, note: `Unbilled ${b.dataset.label} (Reconcile)` })) throw new Error('Not booked.'); },
      { text: `Booked to Unbilled ${b.dataset.label}.`, undo: () => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.book}/reopen`, {}) });
  }));
  app.querySelectorAll('[data-unmatch]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Unmatch this credit? Its bills go back to waiting for a credit.')) return;
    act(() => apiFull('DELETE', `/businesses/${biz.id}/bank-rows/${b.dataset.unmatch}/match`, {}));
  }));
  app.querySelectorAll('[data-putback]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Put this credit back? What was booked from it is removed, and it stays on record in the history.')) return;
    act(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.putback}/reopen`, {}));
  }));
  wirePairPanel(biz, v, heads, reload);
  wireCardSection(biz, r.cards, act);
}

// ---- Card before saving (approved 10 Nov 2026): what Save would match, a match a person chooses now (made on Save),
// and what to fix before or after saving.

// ---- Paid by UPI, before saving (approved 11 Nov 2026): a card or cash bill that one UPI credit of its exact amount
// paid instead. One button: the register's payment becomes UPI (in the column of the account the money came into), the
// bill is decided Use register when the software says otherwise, and the credit is matched on save. All undone together.

/** Changes one register row (a fix done in place, approved 17 Nov 2026): change(row) gives the fields to change.
 *  Returns the undo. */
async function editRow(biz, uploadId, rowId, change) {
  const base = `/businesses/${biz.id}`;
  const u = await api('GET', `${base}/uploads/${uploadId}`);
  const r = u.rows.find((x) => x.id === rowId);
  if (!r) throw new Error('The register row was not found. Reload the page.');
  const payload = rowInputOf(r);
  const after = { ...payload, ...change(r) };
  const put = (b) => apiFull('PUT', `${base}/register-rows/${r.id}`, b);
  await put(rowEditBody(payload, after));
  return () => put(rowEditBody(after, payload));
}
const renumberRow = (biz, uploadId, rowId, billNo) => editRow(biz, uploadId, rowId, () => ({ billNo }));
// To do's state on this device (17 Nov 2026): which step is open, and the "Same bill?" questions answered No.
const TODO_OPEN_KEY = 'bookr.todo.open';
const TODO_NOTSAME_KEY = 'bookr.todo.notsame';
const todoOpenStep = (day) => { try { const o = JSON.parse(localStorage.getItem(TODO_OPEN_KEY) ?? '{}'); return o.day === day ? o.step : null; } catch { return null; } };
const todoNotSame = (day) => { try { return new Set(JSON.parse(localStorage.getItem(TODO_NOTSAME_KEY) ?? '{}')[day] ?? []); } catch { return new Set(); } };
/** To do's steps and their fixes: open a step, delete the extra line of a bill written twice, write the gap as a
 *  discount or tip, answer "Same bill?" No, accept Bookr's suggestion (one or all). Each change has one Undo. */
function wireTodo(biz, day, cv, root, reload) {
  const msgOf = (b) => b.closest('.todo-ln')?.querySelector(':scope > .form-msg') ?? document.getElementById('recmsg');
  const fail = (b, err) => { b.disabled = false; showError(msgOf(b), err); };
  root.querySelectorAll('[data-todostep]').forEach((h) => {
    const toggle = () => {
      const step = h.closest('.todo-step');
      const body = step.querySelector('.todo-body');
      const opening = body.hidden;
      root.querySelectorAll('.todo-body').forEach((x) => { x.hidden = true; });
      root.querySelectorAll('[data-todostep]').forEach((x) => { x.setAttribute('aria-expanded', 'false'); const c = x.querySelector('.todo-car'); if (c) c.textContent = '▸'; });
      body.hidden = !opening;
      h.setAttribute('aria-expanded', String(opening));
      const car = h.querySelector('.todo-car'); if (car) car.textContent = opening ? '▾' : '▸';
      try { localStorage.setItem(TODO_OPEN_KEY, JSON.stringify({ day, step: opening ? h.dataset.todostep : null })); } catch { /* storage unavailable */ }
    };
    h.addEventListener('click', (e) => { if (!e.target.closest('a, button')) toggle(); });
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  root.querySelectorAll('[data-todoopen]').forEach((b) => b.addEventListener('click', () => {
    const box = root.querySelector(`[data-todobox="${b.dataset.todoopen}"]`);
    if (box) box.hidden = !box.hidden;
  }));
  root.querySelectorAll('[data-dupdel]').forEach((b) => b.addEventListener('click', async () => {
    const base = `/businesses/${biz.id}`;
    try {
      const u = await api('GET', `${base}/uploads/${b.dataset.upload}`);
      const row = u.rows.find((x) => x.id === b.dataset.dupdel);
      if (!row) throw new Error('The line was not found. Reload the page.');
      const why = await askDeleteReason({ ...row, lineNo: b.dataset.where.replace(/^Page (\S+) · line (\S+)$/, '$2 of page $1') });
      if (!why) return;
      b.disabled = true;
      await apiFull('DELETE', `${base}/register-rows/${row.id}`, why);
      const back = { billNo: row.billNo, billType: row.billType, amount: rupeesForInput(row.amountPaise), discount: rupeesForInput(row.discountPaise ?? 0), remarks: row.remarks, status: row.status,
        paidWithRowId: row.paidWithRowId, payments: row.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })) };
      await reload();
      doneToast(`Bill ${b.dataset.bill}: ${b.dataset.where} deleted (${deleteReasonLabel(why.reason)}); the other line is kept.`,
        () => apiFull('POST', `${base}/uploads/${b.dataset.upload}/register-rows`, back), reload);
    } catch (err) { fail(b, err); }
  }));
  root.querySelectorAll('[data-rowoff]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const paid = Number(b.dataset.paid);
      const undo = await editRow(biz, b.dataset.upload, b.dataset.rowoff, (r) => ({ discount: rupeesForInput(r.amountPaise - paid) }));
      await reload();
      doneToast(`Bill ${b.dataset.bill}: ${b.textContent.trim()} written.`, undo, reload);
    } catch (err) { fail(b, err); }
  }));
  root.querySelectorAll('[data-notsame]').forEach((b) => b.addEventListener('click', () => {
    const save = (f) => { try { const o = JSON.parse(localStorage.getItem(TODO_NOTSAME_KEY) ?? '{}'); o[day] = f(new Set(o[day] ?? [])); localStorage.setItem(TODO_NOTSAME_KEY, JSON.stringify(o)); } catch { /* storage unavailable */ } };
    const id = b.dataset.notsame;
    save((set) => [...set.add(id)]);
    reload().then(() => doneToast(`Bill ${b.dataset.bill}: not the same bill. It is now with the differences to decide.`, async () => save((set) => { set.delete(id); return [...set]; }), reload));
  }));
  const decide = (id, d) => apiFull('PUT', `/businesses/${biz.id}/comparisons/${id}`, { decision: d, note: null });
  root.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await decide(b.dataset.accept, b.dataset.d);
      await reload();
      doneToast(`Bill ${b.dataset.bill}: ${b.dataset.d === 'use_software' ? 'Use software' : 'Use register'}.`, () => decide(b.dataset.accept, null), reload);
    } catch (err) { fail(b, err); }
  }));
  root.querySelector('[data-acceptall]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const list = [...root.querySelectorAll('[data-accept]')].map((b) => ({ id: b.dataset.accept, d: b.dataset.d }));
    btn.disabled = true;
    const done = [];
    try {
      for (const x of list) { await decide(x.id, x.d); done.push(x); }
      await reload();
      doneToast(`${done.length} suggestion${done.length === 1 ? '' : 's'} accepted.`, () => eachAtOnce(done, (x) => decide(x.id, null)), reload);
    } catch (err) { await eachAtOnce(done, (x) => decide(x.id, null)).catch(() => {}); btn.disabled = false; showError(document.getElementById('recmsg'), err); }
  });
  root.querySelectorAll('[data-machinetocard]').forEach((b) => b.addEventListener('click', () => {
    const c = cv.comparisons.find((x) => x.id === b.dataset.machinetocard);
    const m = c?.machine;
    if (!m?.toCard) return;
    paidOnCardClick(biz, day, { payment: { id: m.toCard.paymentId, amountPaise: m.amountPaise, paidAt: m.paidAt, upi: m.upi },
      written: { comparisonId: c.id, billNo: c.billNo, mode: c.register.mode, amountPaise: m.amountPaise, rowId: c.register.rowId, uploadId: c.register.uploadId } }, b, reload);
  }));
}
/**
 * The fix a hint names, done where the hint is (approved 17 Nov 2026), each with one Undo:
 * [data-renumber] changes a register line's bill number; [data-cashupi2] writes a cash bill missing in the register as
 * paid by UPI with its credit (matched on save).
 */
function wireOneClickFixes(biz, root, reload) {
  const msgOf = (b) => b.closest('[data-card], .lo-fix, [data-cashupibox], .ent-line')?.querySelector('.form-msg') ?? document.getElementById('recmsg');
  root.querySelectorAll('[data-renumber]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const undo = await renumberRow(biz, b.dataset.upload, b.dataset.renumber, b.dataset.no);
      await reload();
      doneToast(`Register line ${b.dataset.from} is now bill ${b.dataset.no}.`, undo, reload);
    } catch (err) { b.disabled = false; showError(msgOf(b), err); }
  }));
  root.querySelectorAll('[data-cashupi2]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.cashupi2}/paid-by-upi`, { creditId: b.dataset.credit, billType: b.dataset.type });
      await reload();
      doneToast(`Bill ${b.dataset.bill}: written in the register as UPI, matched to its credit on save.`, () => apiFull('DELETE', `/businesses/${biz.id}/register-rows/${res.rowId}`, {}), reload);
    } catch (err) { b.disabled = false; showError(msgOf(b), err); }
  }));
}
/** Not matched yet: the filter chips, ⋯ menus (one open at a time; a line's note opens its own), "Pair with" and
 *  ticking every credit with no bill. The tray (wireTray) does the pairing. */
function wireNotMatched(root, onTicks) {
  const menus = () => [...root.querySelectorAll('details.lo-menu')];
  menus().forEach((d) => d.addEventListener('toggle', () => { if (d.open) menus().forEach((o) => { if (o !== d) o.open = false; }); }));
  root.addEventListener('click', (e) => {
    if (!e.target.closest('details.lo-menu')) menus().forEach((d) => { d.open = false; });
    const hint = e.target.closest('[data-loopen]');
    if (hint) { const d = hint.closest('.lo-cell')?.querySelector('details.lo-menu'); if (d) d.open = true; }
  });
  const tick = (id) => {
    const x = root.querySelector(`[data-tside][data-id="${id}"]`);
    if (!x || x.checked) return;
    x.checked = true;
    x.dispatchEvent(new Event('change', { bubbles: true }));
  };
  root.querySelectorAll('[data-lopair]').forEach((b) => b.addEventListener('click', () => {
    const [credit, bill] = b.dataset.lopair.split('|');
    tick(credit); tick(bill);
    b.closest('details')?.removeAttribute('open');
    root.querySelector('[data-tray="fix"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  root.querySelector('[data-lotickall]')?.addEventListener('click', () => {
    root.querySelectorAll('.lo-row[data-side="cr"] [data-tside="cr"]').forEach((x) => { if (x.closest('.lo-row').querySelector('.nb-acts')) tick(x.dataset.id); });
  });
  root.querySelectorAll('[data-lofilter]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-lofilter]').forEach((x) => x.classList.toggle('on', x === b));
    root.querySelectorAll('.lo-row[data-side]').forEach((row) => { row.hidden = b.dataset.lofilter !== 'all' && row.dataset.side !== b.dataset.lofilter; });
  }));
  root.addEventListener('change', () => onTicks());
}

function byUpiOffer(o, fromCredit) {
  if (!o) return '';
  const mode = o.mode === 'card' ? 'card' : 'cash';
  const away = o.minutes != null ? `, ${o.minutes} min from the bill` : '';
  const text = fromCredit
    ? html`<strong>Check first:</strong> could be the payment for ${mode} bill <span class="mono">${o.billNo ?? ''}</span> (₹ ${money(o.amountPaise)}${o.paidAt ? `, ${hhmm(o.paidAt)}` : ''})${o.mode === 'card' ? ': the card machine has no payment for it' : ''}.`
    : html`A ₹ ${money(o.amountPaise)} UPI credit came into ${o.accountName ?? 'the bank'} at ${hhmm(o.creditAt)}${away}, and no other bill of that amount is waiting for it.`;
  return html`<div class="cmp-warn" style="margin:0">${text}
    <div class="form-row" style="gap:6px;margin-top:6px"><button class="btn" type="button" style="min-height:36px" data-paidupi="${o.comparisonId}">Paid by UPI</button></div><div class="form-msg"></div></div>`;
}

async function paidByUpiClick(biz, day, o, b, reload) {
  if (!o) return;
  const mode = o.mode === 'card' ? 'card' : 'cash';
  if (o.mode === 'cash' && !confirm(`Bill ${o.billNo ?? ''} is written as cash. Change it to UPI? The cash count for this shift is then ₹ ${money(o.amountPaise)} less than written.`)) return;
  b.disabled = true;
  const base = `/businesses/${biz.id}`;
  const undos = [];
  try {
    // 1. The register row: its one payment of the bill's amount becomes UPI.
    const u = await api('GET', `${base}/uploads/${o.uploadId}`);
    const row = u.rows.find((x) => x.id === o.rowId);
    if (!row) throw new Error(`Bill ${o.billNo}'s row was not found. Reload the page.`);
    const same = row.payments.filter((x) => x.mode === o.mode && x.amountPaise === o.amountPaise);
    if (row.paidWithRowId || row.payments.length !== 1 || same.length !== 1) throw new Error(`Bill ${o.billNo}'s row has changed or has more than one payment: correct it on its row.`);
    const payload = { paidWithRowId: row.paidWithRowId, billNo: row.billNo, billType: row.billType, amount: rupeesForInput(row.amountPaise), discount: rupeesForInput(row.discountPaise),
      remarks: row.remarks, status: row.status, payments: row.payments.map((x) => ({ mode: x.mode, columnLabel: x.columnLabel, amount: rupeesForInput(x.amountPaise) })) };
    const put = (x) => apiFull('PUT', `${base}/register-rows/${row.id}`, x);
    await put({ ...payload, payments: [{ mode: 'upi', columnLabel: o.label ?? 'UPI', amount: rupeesForInput(o.amountPaise) }] });
    undos.push(() => put(payload));
    // 2. The software still says otherwise: the credit proves the register (UPI).
    const note = `UPI credit ₹ ${money(o.amountPaise)} at ${hhmm(o.creditAt)} (changed from Reconcile)`;
    const c = (await api('GET', `${base}/shifts/${day}`)).comparisons.find((x) => x.id === o.comparisonId);
    if (c && c.difference !== 'match' && c.difference !== 'complimentary' && c.decision !== 'use_register') {
      await apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: 'use_register', note });
      undos.push(() => apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: c.decision ?? null, note: c.note ?? undefined }));
    }
    // 3. The credit, matched on save.
    const { id } = await apiFull('POST', `${base}/shifts/${day}/choices`, { bankRowId: o.creditId, comparisonIds: [o.comparisonId] });
    undos.push(() => apiFull('DELETE', `${base}/shifts/${day}/choices/${id}`, {}));
    await reload();
    doneToast(`Bill ${o.billNo}: changed from ${mode} to UPI, matched to the ₹ ${money(o.amountPaise)} credit when you save.`, async () => { for (const f of undos.reverse()) await f(); }, reload);
  } catch (err) {
    for (const f of undos.reverse()) await f().catch(() => {});
    b.disabled = false; showError(b.closest('.cmp-warn')?.querySelector('.form-msg'), err);
  }
}

// UPI bills paid on the card machine, under the Card bills table (11 Nov 2026): their machine money is accounted here too.
function machineUpiLine(k) {
  if (!k?.trial) return '';
  const xs = [...k.choices.filter((c) => c.open && c.upiBill).map((c) => ({ billNo: c.billNos.join(' + '), amountPaise: c.amountPaise, paidAt: c.paidAt, how: 'chosen, matched on save' })),
    ...(k.onUpiTab ?? []).map((p) => ({ billNo: p.billNo, amountPaise: p.amountPaise, paidAt: p.paidAt, how: p.offered ? 'match it on the UPI tab' : 'matched on save when the bank shows it' }))];
  if (!xs.length) return '';
  return html`<div class="note" style="margin-top:8px"><strong>Also on this machine, for UPI bills:</strong> ${xs.map((x, i) => html`${i ? ' · ' : ''}${x.billNo ? html`<span class="mono">${x.billNo}</span> ` : 'a UPI bill, '}₹ ${money(x.amountPaise)} at ${hhmm(x.paidAt)}, ${x.how}`)} · <button type="button" class="linkbtn" data-goto="pay:upi">see the UPI tab</button></div>`;
}

// Bills settled the next day (approved 11 Nov 2026): counted on an earlier saved shift in another mode than their register
// line here. One button changes that day's sale to this mode (its cash then drops), recorded with Undo.
const MODE_WORD = { cash: 'cash', card: 'card', upi: 'UPI' };
function paidLaterHtml(biz, r, mode) {
  const todo = (r.paidLater ?? []).filter((x) => x.rowMode === mode);
  const done = (r.paidLaterDone ?? []).filter((x) => x.rowMode === mode);
  if (!todo.length && !done.length) return '';
  const row = (x) => html`<a href="#/b/${biz.id}/review/${x.uploadId}/${x.rowId}" class="tiny">Open the line</a>`;
  return html`<section class="card" style="gap:8px">
    <div class="lane-h"><strong>${!todo.length && done.length === 1 ? `A ${dayLabel(done[0].fromDay)} bill paid here` : 'Bills of an earlier day paid here'}</strong>${todo.length ? html`<span class="tchip warn">${todo.length} to check</span>` : ''}</div>
    ${todo.map((x) => html`<div class="ent-line" data-plrow><div><span class="mono"><strong>${x.billNo}</strong></span> · ₹ ${money(x.amountPaise)} · ${dayLabel(x.fromDay)} bill ${row(x)}
      <div class="tiny">Counted as <strong>${MODE_WORD[x.txMode] ?? x.txMode}</strong> on ${dayLabel(x.fromDay)} (saved). The register here says it was paid by <strong>${MODE_WORD[x.rowMode]}</strong>.${x.txMode === 'cash' ? (x.fromCash?.differencePaise < 0 ? ` ${dayLabel(x.fromDay)}'s cash is short ₹ ${money(-x.fromCash.differencePaise)}: this takes ₹ ${money(x.amountPaise)} off it.` : ` If ${dayLabel(x.fromDay)}'s cash was short by ₹ ${money(x.amountPaise)}, this is why.`) : ''}</div>
      ${x.evidence ? html`<div class="tiny" style="color:var(--teal-ink)">✓ ${x.evidence.label} ₹ ${money(x.evidence.amountPaise)} at ${when(x.evidence.at)}${x.evidence.with.length ? html` = this bill + ${x.evidence.with.map((w) => `${w.billNo} ₹ ${money(w.amountPaise)}`).join(' + ')} (the line${x.evidence.with.length > 1 ? 's' : ''} beside it)` : ' = this bill'}</div>` : ''}
      ${x.txMode === 'cash' && x.fromCash?.shortagePaise > 0 && biz.actions.includes('cash.writeoff') ? html`<label class="tiny" style="display:flex;gap:6px;align-items:center;margin-top:4px;padding:6px 8px;border-radius:6px;background:#F1F5F9">
        <input type="checkbox" data-plshort checked> ${dayLabel(x.fromDay)} has a cash shortage of ₹ ${money(x.fromCash.shortagePaise)} booked: also reduce it by ₹ ${money(Math.min(x.amountPaise, x.fromCash.shortagePaise))}</label>` : ''}
      <div class="form-msg"></div></div>
      <button class="btn" type="button" style="min-height:36px" data-paidlater="${x.txId}" data-mode="${x.rowMode}" data-bill="${x.billNo}" data-day="${x.fromDay}" data-amt="${x.amountPaise}" data-short="${x.txMode === 'cash' && x.fromCash?.differencePaise < 0 ? -x.fromCash.differencePaise : ''}">Paid by ${MODE_WORD[x.rowMode]} here</button></div>`)}
    ${done.map((x) => {
      const ch = mode === 'card' ? (r.cards?.choices ?? []).find((c) => c.open && c.billNos.includes(x.billNo)) : null;
      const others = ch ? ch.billNos.filter((b) => b !== x.billNo) : [];
      return html`<div class="ent-line"><div><span class="mono"><strong>${x.billNo}</strong></span> · ₹ ${money(x.amountPaise)} was counted as ${MODE_WORD[x.from] ?? x.from} on ${dayLabel(x.fromDay)}. It was paid here by ${MODE_WORD[x.rowMode]}${ch ? html`${others.length ? html`, together with <span class="mono">${others.join(', ')}</span>, on one ${ch.upiBill ? 'payment' : 'swipe'}` : ''}: ${ch.label} ₹ ${money(ch.amountPaise)} at ${hhmm(ch.paidAt)}.` : '.'}
        ${ch ? html`<div style="margin-top:4px"><span class="chip ok">Picked, matched on save</span></div>` : mode === 'card' ? html`<div class="tiny" style="color:#92400E">Pick its card payment below.</div>` : ''}<div class="form-msg"></div></div>
      <button class="btn plain dchip" type="button" data-paidlaterundo="${x.auditId}">Put it back to ${MODE_WORD[x.from] ?? x.from}</button></div>`;
    })}
  </section>`;
}
// A saved shift's card bills (20 Nov 2026): a swipe of another day says its day and the bills beside it; each says who found it.
function withSavedCards(t, k) {
  if (!k || k.trial) return t;
  const away = new Map((k.elsewhere ?? []).map((x) => [x.billNo, x]));
  const found = new Map((k.done ?? []).flatMap((d) => d.bills.map((b) => [b, d.byBookr])));
  return { ...t, entries: t.entries.map((e) => {
    const a = away.get(e.billNo);
    if (a) return { ...e, evidence: `${a.payment.label} ₹${money(a.payment.amountPaise)} on ${dayLabel(a.day)}, ${hhmm(a.payment.paidAt)}${a.withBills.length ? `, with ${a.withBills.join(', ')}` : ''} · picked` };
    if (e.evidence && found.has(e.billNo)) return { ...e, evidence: `${e.evidence} · ${found.get(e.billNo) ? 'found by Bookr' : 'picked'}` };
    return e;
  }) };
}
// Earlier-day bills changed to card and paid here (20 Nov 2026): listed with this shift's card bills, tagged with their day.
const earlierCard = (r) => (r.paidLaterDone ?? []).filter((x) => x.rowMode === 'card');
function withEarlier(t, r) {
  const xs = earlierCard(r).filter((x) => !t.entries.some((e) => e.billNo === x.billNo));
  if (!xs.length) return t;
  const rows = xs.map((x) => {
    const ch = (r.cards?.choices ?? []).find((c) => c.open && c.billNos.includes(x.billNo));
    const others = ch ? ch.billNos.filter((b) => b !== x.billNo) : [];
    return { billNo: x.billNo, amountPaise: x.amountPaise, paidAt: null, fromDay: x.fromDay, register: { mode: 'card' }, software: { mode: 'card' }, edits: [],
      state: ch ? 'done' : 'waiting', evidence: ch ? `${ch.label} ₹${money(ch.amountPaise)} at ${hhmm(ch.paidAt)}${others.length ? ` with ${others.join(', ')}` : ''} · chosen, matched on save` : null, comparisonId: null, group: null };
  });
  return { ...t, entries: [...t.entries, ...rows], totalPaise: t.totalPaise + xs.reduce((a, x) => a + x.amountPaise, 0) };
}
function wirePaidLater(biz, reload) {
  app.querySelectorAll('[data-paidlater]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const cut = !!b.closest('[data-plrow]')?.querySelector('[data-plshort]')?.checked;
      const { auditId } = await apiFull('POST', `/businesses/${biz.id}/sales/repay`, { transactionIds: [b.dataset.paidlater], mode: b.dataset.mode,
        note: `Settled the next day: paid by ${MODE_WORD[b.dataset.mode]} (Reconcile)`, ...(cut ? { reduceShortage: true } : {}) });
      await reload();
      const sh = Number(b.dataset.short || 0), amt = Number(b.dataset.amt || 0);
      doneToast(`Bill ${b.dataset.bill}: ${dayLabel(b.dataset.day)} now counts it as ${MODE_WORD[b.dataset.mode]}, paid here.${sh && !cut ? ` ${dayLabel(b.dataset.day)} short ₹ ${money(sh)} → ₹ ${money(Math.max(0, sh - amt))}.` : ''}`, () => apiFull('POST', `/businesses/${biz.id}/sales/repay/${auditId}/undo`, {}), reload);
    } catch (err) { b.disabled = false; showError(b.closest('.ent-line').querySelector('.form-msg'), err); }
  }));
  app.querySelectorAll('[data-paidlaterundo]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await apiFull('POST', `/businesses/${biz.id}/sales/repay/${b.dataset.paidlaterundo}/undo`, {}); await reload(); }
    catch (err) { b.disabled = false; showError(b.closest('.ent-line').querySelector('.form-msg'), err); }
  }));
}

/**
 * A swipe that pays bills together with old POS bills (approved 20 Nov 2026): one swipe, a group of bills of exactly its
 * amount, held up only by old POS bills not decided yet. Shown as one box with one button; a person presses it.
 */
function oldPosGroups(k, entries, oldPos, cv) {
  const old = new Map((oldPos?.bills ?? []).filter((b) => b.reviewed).map((b) => [b.comparisonId, b]));
  if (!old.size || !entries?.entries) return [];
  const gone = dismissed();
  const ids = [...new Set(entries.entries.filter((e) => e.group).map((e) => e.group.id))];
  const out = [];
  for (const gid of ids) {
    const es = entries.entries.filter((e) => e.group?.id === gid);
    // A bill of the group still to decide itself (the group as a whole shows "decide" while any one is).
    const cmpOf = (e) => cv?.comparisons?.find((c) => c.id === e.comparisonId);
    const open = (e) => { const c = cmpOf(e); return !c || (!c.decision && c.difference !== 'match' && c.difference !== 'complimentary'); };
    const undecided = es.filter(open);
    if (!undecided.length || !undecided.every((e) => old.has(e.comparisonId))) continue;
    const g = es[0].group;
    const total = g.billsPaise;
    const pays = k.needs.filter((n) => !n.candidates.length && !['written', 'not_purchase', 'tip'].includes(n.why) && n.payment.amountPaise === total);
    if (pays.length !== 1 || gone.has(`oldgrp:${pays[0].payment.id}`)) continue;
    out.push({ payment: pays[0].payment, total, bills: es.map((e) => ({ billNo: e.billNo, comparisonId: e.comparisonId, amountPaise: e.amountPaise ?? old.get(e.comparisonId)?.amountPaise ?? 0,
      old: old.get(e.comparisonId) ?? null, decide: open(e) })) });
  }
  return out;
}
function oldGroupBox(x, day) {
  const olds = x.bills.filter((b) => b.decide);
  return html`<div class="rv-card left-box" data-card="oldgrp:${x.payment.id}" data-oldgrpbox="${x.payment.id}">
    <div class="lane-h"><strong>₹ ${money(x.total)} swipe = ${x.bills.length} bills paid together</strong><span class="tchip warn">${olds.length} old POS to decide</span></div>
    <div class="tiny">${x.payment.label} · machine ${x.payment.terminalId} · ${when(x.payment.paidAt)}. The ${x.bills.length} bills add up to exactly ₹ ${money(x.total)}.</div>
    <div class="og-list">${x.bills.map((b) => html`<div class="og-row"><span class="mono">${b.billNo ?? '—'}</span>
      <span>${b.decide ? html`<span class="chip">Old POS</span> <span class="tiny">register only</span>` : html`<span class="chip ok">ready</span>`}</span>
      <span class="amount">${money(b.amountPaise)}</span><button type="button" class="linkbtn tiny" data-bill-drawer="${b.billNo}|${day}">Open row</button></div>`)}
      <div class="og-row" style="font-weight:600"><span>Total</span><span></span><span class="amount">${money(x.total)}</span><span></span></div></div>
    <div class="form-row" style="gap:6px"><button class="btn" type="button" data-oldgrp="${x.payment.id}" data-old="${olds.map((b) => `${b.comparisonId}:${b.old?.kind ?? 'full'}:${b.billNo ?? ''}`).join(',')}" data-cmps="${x.bills.map((b) => b.comparisonId).join(',')}">Use register for the ${olds.length} old POS bill${olds.length === 1 ? '' : 's'} and match ₹ ${money(x.total)}</button>
      <button class="btn plain" type="button" data-carddismiss="oldgrp:${x.payment.id}" title="Show them apart again (on this device)">Not one payment</button></div>
    <div class="tiny" style="color:var(--muted)">Leave out or complimentary instead: open the old POS bill's row. Matched when you save the shift.</div><div class="form-msg"></div></div>`;
}
function trialCardSection(biz, k, book = null, ex = {}) {
  const st = k.strip;
  const groupsOld = oldPosGroups(k, ex.entries, ex.oldPos, ex.cv);
  const ogPay = new Set(groupsOld.map((x) => x.payment.id));
  const ogBill = new Set(groupsOld.flatMap((x) => x.bills.map((b) => b.comparisonId)));
  const at = (ms) => (ms ? when(ms) : 'register only');
  const openRow = (billNo) => html`<button type="button" class="linkbtn tiny" data-bill-drawer="${billNo}|${k.day}">Open row</button>`;
  const need = (n) => {
    const p = n.payment;
    const head = html`<div class="lane-h"><strong>₹ ${money(p.amountPaise)} on the card machine at ${when(p.paidAt)}</strong><span class="tchip warn">${
      n.why === 'several' ? 'More than one bill fits' : n.why === 'one' ? 'Check before matching' : n.why === 'tip' ? 'More than its bill' : n.why === 'not_purchase' ? 'Refund or void'
        : n.why === 'written' ? `Bill written as ${n.written.mode === 'upi' ? 'UPI' : 'cash'}` : 'No card bill of this amount'}</span></div>
      <div class="tiny">${p.label} · machine ${p.terminalId}</div>`;
    if (n.candidates.length) return html`<div class="rv-card">${head}
      <div class="note">${n.candidates.length > 1 ? 'Pick the bill this payment was for. It is matched when you save the shift.' : (n.candidates[0].minutes == null ? 'This bill has no time, and another bill or payment of this amount is near, so Bookr does not match it on its own. Match it if it is the one: it is matched when you save the shift.' : 'The bill of this amount is further away in time than Bookr matches on its own. Match it if it is the one: it is matched when you save the shift.')}</div>
      <div class="form-row" style="gap:6px">${n.candidates.map((x) => html`<button class="btn plain" type="button" style="min-height:36px" data-tcardpick="${p.id}" data-cmps="${x.comparisonIds.join(',')}">Bill ${x.billNos.join(' + ')}${x.minutes != null ? ` · ${x.minutes} min` : ' · no bill time'}</button>`)}</div>
      ${n.candidates.flatMap((x) => x.earlier ?? []).map((e) => html`<div class="tiny">${e.billNo} is a ${dayLabel(e.fromDay)} bill (₹ ${money(e.amountPaise)}) settled here: its line is on this shift's register.</div>`)}<div class="form-msg"></div></div>`;
    if (n.why === 'tip') return html`<div class="rv-card">${head}
      <div class="note">Bill <span class="mono">${n.tip.billNo}</span> ${openRow(n.tip.billNo)} is ₹ ${money(n.tip.amountPaise)}, ${at(n.tip.paidAt)}: the guest paid ₹ ${money(n.tip.tipPaise)} more on the card. Match it with the tip here after saving.</div></div>`;
    // Paid on the card machine (approved 11 Nov 2026): corrected here before saving, in one step with one Undo.
    if (n.why === 'written') {
      const wr = n.written;
      const can = wr.rowId && wr.uploadId && !wr.upiNear;
      return html`<div class="rv-card">${head}
      <div class="note">Bill <span class="mono">${wr.billNo}</span> ${openRow(wr.billNo)}, ₹ ${money(wr.amountPaise)} at ${when(wr.paidAt)}, is written as <strong>${wr.mode === 'upi' ? 'UPI' : 'cash'}</strong>. The card machine got ₹ ${money(p.amountPaise)} at ${hhmm(p.paidAt)}, ${wr.minutes} min from the bill${wr.mode === 'upi' && !wr.upiNear ? ', and no UPI credit of this amount came in near it' : ''}.</div>
      ${wr.upiNear ? html`<div class="cmp-warn" style="margin:0">Both a UPI credit and a card payment of ₹ ${money(wr.amountPaise)} are near this bill: paid twice? Check the bill on its row.</div>` : ''}
      ${can ? html`<div class="note">${p.upi ? 'Paid by UPI on the machine: the money comes in the card settlement, so it is a card bill. ' : ''}Changes the register's payment to Card${wr.swMode && wr.swMode !== 'card' ? ', decides the bill as Use register (card)' : ''}, and matches this payment on save. One Undo puts it all back.</div>
      <div class="form-row" style="gap:6px"><button class="btn" type="button" style="min-height:36px" data-tpaidcard="${p.id}" data-cmp="${wr.comparisonId}">Paid on the card machine</button></div>` : ''}
      <div class="form-msg"></div></div>`;
    }
    if (n.why === 'not_purchase') return html`<div class="rv-card">${head}<div class="note">A ${String(p.txnType).toLowerCase()} on the card machine, not a sale. Check it with the bill it reverses on <a href="#/b/${biz.id}/cards">Card settlements</a>.</div></div>`;
    // Book it now (approved 11 Nov 2026), as on the UPI tab: an unbilled sale, or under a head. Undo takes it back.
    return html`<div class="rv-card">${head}
      <div class="tiny" style="color:var(--muted)">No card bill of this amount. Several bills on one card? Tick them together in Match several at once below. A bill written as cash or UPI? Correct it on its row. Otherwise book it here.</div>
      ${book ? html`<div class="form-row" style="gap:6px;align-items:center">
        <input type="text" data-tcardwhat="${p.id}" maxlength="120" placeholder="What was it? (optional)" style="flex:1 1 180px;max-width:240px;min-height:36px" aria-label="What was ₹ ${money(p.amountPaise)}?">
        ${book.unbilled.map((h) => html`<button class="btn plain" type="button" style="min-height:36px" data-tcardsale="${p.id}" data-type="${h.billType}">Unbilled ${h.billType === 'room' ? 'Room' : 'F&B'}</button>`)}
        ${book.unbilled.some((h) => h.billType === 'room') ? html`<button class="btn plain" type="button" style="min-height:36px" data-tcardadv="${p.id}">Advance…</button>` : ''}
        <select data-tcardhead="${p.id}" style="min-height:36px;max-width:200px" aria-label="Book under a head"><option value="">Other income head…</option>${book.income.map((h) => html`<option value="${h.id}">${h.name}</option>`)}</select>
        <button class="btn plain" type="button" style="min-height:36px" data-tcardbook="${p.id}">Book</button></div>` : ''}<div class="form-msg"></div></div>`;
  };
  const noSwipe = (x) => html`<div class="rv-card">
    <div class="lane-h"><strong>Card bill <span class="mono">${x.billNo}</span>, ₹ ${money(x.amountPaise)}: no card payment</strong><span class="tchip warn">No swipe</span></div>
    <div class="tiny">${x.paidAt ? at(x.paidAt) : 'No bill time'} · ${openRow(x.billNo)} · <span style="color:var(--muted)">the card report has no payment for it: check how it was paid on its row.</span></div>
    ${x.near ? html`<div class="cmp-warn" style="margin:0"><strong>Check:</strong> ${x.near.label} ₹ ${money(x.near.amountPaise)} at ${hhmm(x.near.paidAt)}, ${x.near.minutes} min from the bill, ₹ ${money(Math.abs(x.near.amountPaise - x.amountPaise))} ${x.near.amountPaise > x.amountPaise ? 'more' : 'less'}: a misread amount, or a ${x.near.amountPaise > x.amountPaise ? 'tip' : 'discount'}? Tick both in Match several at once below to choose.</div>` : ''}
    ${(x.advances ?? []).map((a) => html`<div class="cmp-warn" style="margin:0"><strong>Advance?</strong> ₹ ${money(a.amountPaise)} on the card machine at ${when(a.paidAt)}, booked as ${a.what}. If this bill uses it, it is matched on save and the sale stays on ${dayLabel(a.txDay)}.
      <div style="margin-top:4px"><button class="btn plain dchip" type="button" data-tcarduseadv="${a.paymentId}" data-cmp="${x.comparisonId}" data-bill="${x.billNo}">Uses this advance</button></div><div class="form-msg"></div></div>`)}
    ${byUpiOffer((k.byUpi ?? []).find((o) => o.comparisonId === x.comparisonId))}</div>`;
  const chosen = k.choices.filter((c) => c.open);
  // Plain words (approved 20 Nov 2026): where the machine's money went, as one sum; the bills it pays, earlier days told.
  const earlier = new Map((ex.earlier ?? []).map((x) => [x.billNo, x]));
  const amtOf = new Map([...(ex.entries?.entries ?? []).map((e) => [e.billNo, e.amountPaise]), ...[...earlier.values()].map((x) => [x.billNo, x.amountPaise])]);
  const nEarlier = [...earlier.keys()].filter((b) => chosen.some((c) => c.billNos.includes(b))).length;
  const got = st.machineCardPaise + st.machineUpiPaise;
  const nBooked = (k.booked ?? []).length;
  const parts = st.machine ? [[st.machine.cardPaise, 'for card bills'], [st.machine.upiPaise, 'for UPI bills'], [st.machine.bookedPaise, 'with no bill'], [st.machine.leftPaise, 'not matched yet']].filter(([v]) => v) : [];
  const adds = st.machine && parts.reduce((a, [v]) => a + v, 0) === got;
  const allOk = k.covered && !k.left && !st.noBill;
  const met = (label, v, sub, color = 'inherit') => html`<div><div class="tiny">${label}</div><div class="amount rec-n" style="color:${color}">₹ ${money(v)}</div>${sub ? html`<div class="tiny">${sub}</div>` : ''}</div>`;
  const nBills = (c) => c.billNos.length;
  const pickBills = chosen.reduce((a, c) => a + nBills(c), 0);
  const bookedSame = nBooked > 1 && k.booked.every((x) => (x.what || '') === (k.booked[0].what || '') && (x.headName || '') === (k.booked[0].headName || ''));
  const bookedAs = (x) => [x.what, x.headName].filter(Boolean).join(', ') || 'Booked';
  return html`<section class="card" style="gap:10px" id="tcardsec">
    <div class="lane-h"><h2 style="margin:0">Card machine</h2><span style="display:flex;gap:6px;flex-wrap:wrap">${!k.covered ? html`<span class="chip">Card report not in for this shift yet</span>` : ''}
      ${k.left ? html`<span class="chip wait">${k.left} left</span>` : allOk ? html`<span class="chip ok">✓ All card money explained</span>` : ''}</span></div>
    <div class="rec-strip">
      ${met('Machine got', got, '')}
      ${met('For bills', st.machine ? st.machine.cardPaise : st.wouldPaise, `${st.would} of ${st.bills} card bill${st.bills === 1 ? '' : 's'}${nEarlier ? ` (${nEarlier} from ${nEarlier === 1 ? dayLabel([...earlier.values()][0].fromDay) : 'earlier days'})` : ''}${st.machine?.upiPaise ? ` · + ₹ ${rs(st.machine.upiPaise)} for UPI bills` : ''}`, 'var(--teal)')}
      ${st.machine ? met('No bill, booked', st.machine.bookedPaise, `${nBooked} payment${nBooked === 1 ? '' : 's'}`) : ''}
      ${st.noBill ? met('Not matched yet', st.noBillPaise, `${st.noBill} payment${st.noBill === 1 ? '' : 's'}: see below`, 'var(--danger)') : ''}
      ${st.noSwipe || !k.covered ? met('Card bills with no payment', st.noSwipePaise, k.covered ? `${st.noSwipe} bill${st.noSwipe === 1 ? '' : 's'}` : `${k.waitingReport} waiting for the report`, st.noSwipe ? 'var(--danger)' : 'inherit') : ''}
    </div>
    <div class="tiny" style="color:var(--muted)" title="Bookr matches a payment on its own only when it is the one card bill of its amount within 20 minutes and no other payment wants it, or, for a bill with no time, the only card bill and the only payment of its amount in the shift.">${adds && parts.length > 1 ? `${parts.map(([v, w]) => `₹ ${rs(v)} ${w}`).join(' + ')} = ₹ ${rs(got)}. ` : ''}${k.left ? `${k.left} left to match below. ` : k.covered ? 'Nothing is left to match. ' : ''}Nothing is saved until you press Save shift.</div>
    ${chosen.length ? html`<details class="cmp-fold" open><summary><strong>Payments you picked</strong> <span class="tiny">· ${chosen.length} payment${chosen.length === 1 ? '' : 's'}${pickBills !== chosen.length ? ` for ${pickBills} bills` : ''}</span></summary>${chosen.map((c) => html`<div class="list-row" style="padding:6px 0"><span class="tiny">${c.billNos.map((b, i) => html`${i ? ' + ' : ''}<span class="mono">${b}</span>${amtOf.has(b) ? ` ₹ ${money(amtOf.get(b))}` : ''}${earlier.has(b) ? html` <span class="chip plan" style="font-size:11px">${dayLabel(earlier.get(b).fromDay)}</span>` : ''}`)}${c.upiBill ? html` <span class="upitag">UPI bill</span>` : ''} ← ${c.label} ₹ ${money(c.amountPaise)}, ${hhmm(c.paidAt)}
      <div style="color:var(--muted)">${nBills(c) > 1 ? `${nBills(c)} bills on one ${c.upiBill ? 'payment' : 'swipe'} · ` : ''}${c.by ? `picked by ${c.by}` : 'picked'}${c.upiBill ? html` · <button type="button" class="linkbtn tiny" data-goto="pay:upi">on the UPI tab</button>` : ''}</div></span>
      <span style="display:flex;gap:6px">${c.upiBill && c.bill?.uploadId ? html`<button class="btn plain dchip" type="button" data-choicetocard="${c.id}" title="Card machine money is a card bill: changes the register's payment to Card, matched on save">Change to card</button>` : ''}
      <button class="btn plain dchip" type="button" data-unchoose="${c.id}">Undo</button></span><div class="form-msg" style="flex-basis:100%"></div></div>`)}</details>` : ''}
    ${(k.advancePlans ?? []).length ? html`<details class="cmp-fold" open><summary><strong>Advances used by a bill, matched on save (${k.advancePlans.length})</strong></summary>${k.advancePlans.map((a) => html`<div class="list-row" style="padding:4px 0"><span class="tiny"><span class="mono">${a.billNo}</span> · ${a.label} ₹ ${money(a.amountPaise)} at ${when(a.paidAt)} · ${a.what}</span>
      <button class="btn plain dchip" type="button" data-tcardunadv="${a.paymentId}">Undo</button><div class="form-msg" style="flex-basis:100%"></div></div>`)}</details>` : ''}
    ${nBooked ? html`<details class="cmp-fold" open><summary><strong>Money with no bill</strong> <span class="tiny">· ${nBooked} payment${nBooked === 1 ? '' : 's'} · ₹ ${money(k.booked.reduce((a, x) => a + x.amountPaise, 0))}${bookedSame ? ` · booked as ${bookedAs(k.booked[0])}` : ''}</span></summary>${k.booked.map((x) => html`<div class="list-row" style="padding:4px 0"><span class="tiny">₹ ${money(x.amountPaise)} · ${x.label}, ${hhmm(x.paidAt)}${bookedSame ? '' : ` · ${bookedAs(x)}`}</span>
      <button class="btn plain dchip" type="button" data-tcardunbook="${x.paymentId}">Undo</button><div class="form-msg" style="flex-basis:100%"></div></div>`)}</details>` : ''}
    ${groupsOld.length ? html`<div class="rv-cards">${groupsOld.map((x) => oldGroupBox(x, k.day))}</div>` : ''}
    ${k.needs.length || k.noSwipe.length ? html`<div class="rv-cards">${k.needs.filter((n) => !ogPay.has(n.payment.id)).map(need)}${k.noSwipe.filter((x) => !ogBill.has(x.comparisonId)).map(noSwipe)}</div>` : ''}
    ${trialCardOpen(k, ogPay, ogBill)}
  </section>`;
}
// Card payments as the tray's left side: its time is the swipe, its name the card.
const cardTrayOpen = (k, skipPay = new Set(), skipBill = new Set()) => ({ credits: (k.open?.payments ?? []).filter((p) => !skipPay.has(p.id)).map((p) => ({ ...p, postedAt: p.paidAt, accountName: p.label })),
  bills: (k.open?.bills ?? []).filter((b) => !skipBill.has(b.id)) });
// The Card tab's open entries (card tray, approved 10 Nov 2026): tick payments and card bills, match the pairs on save.
function trialCardOpen(k, skipPay, skipBill) {
  const o = cardTrayOpen(k, skipPay, skipBill);
  if (!o.bills.length) return '';
  const lone = lonePairs(o);
  return html`<details class="cmp-fold" id="tcardopen" ${o.credits.length + o.bills.length <= 30 ? 'open' : ''}><summary><strong>Match several at once</strong> <span class="tiny">· ${o.credits.length} payment${o.credits.length === 1 ? '' : 's'} · ${o.bills.length} bill${o.bills.length === 1 ? '' : 's'}</span></summary>
    <div class="note">Tick a payment, then its bill (or the bill first): each two ticks make a pair, in the order you tick. "+ Add to this pair" adds more to a pair. You match all the pairs on save in one go.${lone.length > 1 ? html` <button type="button" class="linkbtn" data-tray="exact">Tick all exact pairs (${lone.length})</button>` : ''}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">
      <div><strong>Machine payments not matched yet</strong> <span class="chip">${o.credits.length}</span>
        ${o.credits.map((c) => html`<label class="um-line"><input type="checkbox" data-tside="cr" data-amt="${c.amountPaise}" data-id="${c.id}"><span style="flex:1">${when(c.paidAt)}<span class="tiny" style="display:block">${c.label} · machine ${c.terminalId}</span></span><strong class="amount">₹ ${money(c.amountPaise)}</strong></label>`)}
        <label class="tiny" style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" data-tray="nearOn" style="width:16px;height:16px;min-height:0"> Show payments from the shifts either side</label><div data-tray="near"></div></div>
      <div><strong>Card bills with no payment yet</strong> <span class="chip">${o.bills.length}</span>
        ${o.bills.map((b) => html`<label class="um-line"><input type="checkbox" data-tside="bl" data-amt="${b.amountPaise}" data-id="${b.id}"><span style="flex:1"><span class="mono">${b.billNo}</span>${b.grouped ? html` <span class="chip">paid together</span>` : ''}${b.billNo ? html` <button type="button" class="linkbtn tiny" data-bill-drawer="${b.billNo}|${k.day}">Open row</button>` : ''}<span class="tiny" style="display:block">${b.fromDay ? `${dayLabel(b.fromDay)} bill, settled here` : b.paidAt ? when(b.paidAt) : 'register only'}</span></span><strong class="amount">₹ ${money(b.amountPaise)}</strong></label>`)}</div>
    </div>
    <div data-tray="sum" class="note">Tick entries to compare them.</div><div data-tray="fix"></div><div class="form-msg" data-tray="msg"></div></details>`;
}

// Paid on the card machine (approved 11 Nov 2026), from the Card tab or under the bill on the UPI tab: the register's
// payment becomes Card, the bill is decided Use register (card) when the software says otherwise, and the machine
// payment is matched on save. All undone together.
// A UPI bill paid by UPI on the card machine (11 Nov 2026), matched to the machine's report on save; from the UPI or Card tab.
// UPI on the card machine (card since 11 Nov 2026): the bill becomes a card bill, the same steps as Paid on the card machine.
async function upiOnMachineClick(biz, day, b, reload, k) {
  const m = (k?.upiOnMachine ?? []).find((x) => x.paymentId === b.dataset.upimachine && x.comparisonId === b.dataset.cmp);
  const n = (k?.needs ?? []).find((x) => x.payment.id === b.dataset.upimachine && x.written?.comparisonId === b.dataset.cmp);
  const wr = n?.written ?? (m && { comparisonId: m.comparisonId, billNo: m.billNo, mode: 'upi', amountPaise: m.amountPaise, rowId: m.rowId, uploadId: m.uploadId, swMode: m.swMode });
  if (!wr) { showError(b.closest('.cmp-warn, .rv-card')?.querySelector('.form-msg'), new Error('Reload the page: this payment has changed.')); return; }
  return paidOnCardClick(biz, day, { payment: n?.payment ?? { id: m.paymentId, amountPaise: m.amountPaise, paidAt: m.payAt, upi: true }, written: wr }, b, reload);
}

async function paidOnCardClick(biz, day, n, b, reload) {
  const wr = n?.written;
  if (!wr) return;
  b.disabled = true;
  const base = `/businesses/${biz.id}`;
  const undos = [];
  try {
    // 1. The register row: its one payment of the bill's amount becomes Card.
    const u = await api('GET', `${base}/uploads/${wr.uploadId}`);
    const r = u.rows.find((x) => x.id === wr.rowId);
    if (!r) throw new Error(`Bill ${wr.billNo}'s row was not found. Reload the page.`);
    const same = r.payments.filter((x) => x.mode === wr.mode && x.amountPaise === wr.amountPaise);
    if (r.paidWithRowId || r.payments.length !== 1 || same.length !== 1) throw new Error(`Bill ${wr.billNo}'s row has changed or has more than one payment: correct it on its row.`);
    const payload = { paidWithRowId: r.paidWithRowId, billNo: r.billNo, billType: r.billType, amount: rupeesForInput(r.amountPaise), discount: rupeesForInput(r.discountPaise), remarks: r.remarks, status: r.status,
      payments: r.payments.map((x) => ({ mode: x.mode, columnLabel: x.columnLabel, amount: rupeesForInput(x.amountPaise) })) };
    const put = (x) => apiFull('PUT', `${base}/register-rows/${r.id}`, x);
    await put({ ...payload, payments: [{ mode: 'card', columnLabel: 'Card', amount: rupeesForInput(wr.amountPaise) }] });
    undos.push(() => put(payload));
    // 2. The software still says otherwise: the machine proves the register (card).
    const note = `Card machine ₹ ${money(n.payment.amountPaise)} at ${hhmm(n.payment.paidAt)} (changed from Reconcile)`;
    const c = (await api('GET', `${base}/shifts/${day}`)).comparisons.find((x) => x.id === wr.comparisonId);
    if (c && c.difference !== 'match' && c.difference !== 'complimentary' && c.decision !== 'use_register') {
      await apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: 'use_register', note });
      undos.push(() => apiFull('PUT', `${base}/comparisons/${c.id}`, { decision: c.decision ?? null, note: c.note ?? undefined }));
    }
    // 3. The machine payment, matched on save.
    const { id } = await apiFull('POST', `${base}/shifts/${day}/card-choices`, { paymentId: n.payment.id, comparisonIds: [wr.comparisonId] });
    undos.push(() => apiFull('DELETE', `${base}/shifts/${day}/choices/${id}`, {}));
    await reload();
    doneToast(`Bill ${wr.billNo}: changed to card, matched to the machine payment when you save.`, async () => { for (const f of undos.reverse()) await f(); }, reload);
  } catch (err) {
    for (const f of undos.reverse()) await f().catch(() => {});
    b.disabled = false; showError(b.closest('.rv-card, .cmp-warn')?.querySelector('.form-msg'), err);
  }
}

function wireTrialCards(biz, day, k, reload) {
  const box = document.getElementById('tcardsec');
  if (!box || !k?.trial) return;
  const trayRoot = document.getElementById('tcardopen');
  if (trayRoot) {
    const open = cardTrayOpen(k);
    wireTray({ biz, day, reload, root: trayRoot, open, lone: lonePairs(open), mode: 'card',
      nearby: async () => (await api('GET', `/businesses/${biz.id}/shifts/${day}/nearby`)).payments.map((p) => ({ ...p, postedAt: p.paidAt, accountName: p.label })),
      post: (pairs) => apiFull('POST', `/businesses/${biz.id}/shifts/${day}/card-choices`, { pairs: pairs.map((p) => ({ paymentId: p.credit.id, comparisonIds: p.bills.map((b) => b.id) })) }) });
  }
  box.querySelectorAll('[data-upimachine]').forEach((b) => b.addEventListener('click', () => upiOnMachineClick(biz, day, b, reload, k)));
  // Machine money with no bill, booked before saving (11 Nov 2026): matched to its payment at once; Undo unmatches it,
  // which removes the booking.
  const B = `/businesses/${biz.id}/cards`;
  const msgOf = (b) => b.closest('.rv-card, .list-row')?.querySelector('.form-msg');
  const bookCard = async (b, pid, payload, text) => {
    b.disabled = true;
    try {
      await apiFull('POST', `${B}/${pid}/book`, payload);
      await reload();
      doneToast(text, () => apiFull('POST', `${B}/${pid}/unmatch`, {}), reload);
    } catch (err) { b.disabled = false; showError(msgOf(b), err); }
  };
  const what = (pid) => box.querySelector(`[data-tcardwhat="${pid}"]`)?.value.trim() || undefined;
  box.querySelectorAll('[data-tcardsale]').forEach((b) => b.addEventListener('click', () => {
    const pid = b.dataset.tcardsale;
    bookCard(b, pid, { billType: b.dataset.type, item: what(pid) }, `Card payment booked as Unbilled ${b.dataset.type === 'room' ? 'Room' : 'F&B'}.`);
  }));
  box.querySelectorAll('[data-tcardbook]').forEach((b) => b.addEventListener('click', () => {
    const pid = b.dataset.tcardbook;
    const sel = box.querySelector(`[data-tcardhead="${pid}"]`);
    if (!sel?.value) { showError(msgOf(b), new Error('Choose the head first.')); return; }
    bookCard(b, pid, { headId: sel.value, note: what(pid) }, `Card payment booked under ${sel.selectedOptions[0].textContent}.`);
  }));
  box.querySelectorAll('[data-tcardadv]').forEach((b) => b.addEventListener('click', () => {
    const pid = b.dataset.tcardadv;
    const who = prompt('Advance received on the card machine: from which guest (name, room or booking)?', what(pid) ?? '');
    if (!who?.trim()) return;
    bookCard(b, pid, { billType: 'room', item: `Advance: ${who.trim()}` }, 'Booked as an advance. Its room bill can use it when it comes.');
  }));
  const advPath = `/businesses/${biz.id}/shifts/${day}/card-advance`;
  box.querySelectorAll('[data-tcarduseadv]').forEach((b) => b.addEventListener('click', async () => {
    const pid = b.dataset.tcarduseadv;
    b.disabled = true;
    try {
      await apiFull('POST', advPath, { paymentId: pid, comparisonId: b.dataset.cmp });
      await reload();
      doneToast(`Bill ${b.dataset.bill} uses the advance: matched when you save.`, () => apiFull('DELETE', advPath, { paymentId: pid }), reload);
    } catch (err) { b.disabled = false; showError(b.closest('.cmp-warn').querySelector('.form-msg'), err); }
  }));
  box.querySelectorAll('[data-tcardunadv]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await apiFull('DELETE', advPath, { paymentId: b.dataset.tcardunadv }); await reload(); }
    catch (err) { b.disabled = false; showError(msgOf(b), err); }
  }));
  box.querySelectorAll('[data-tcardunbook]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await apiFull('POST', `${B}/${b.dataset.tcardunbook}/unmatch`, {}); await reload(); }
    catch (err) { b.disabled = false; showError(msgOf(b), err); }
  }));
  // A UPI bill already chosen for UPI on the machine (before 11 Nov 2026): changed to card, the choice made again.
  box.querySelectorAll('[data-choicetocard]').forEach((b) => b.addEventListener('click', async () => {
    const c = k.choices.find((x) => x.id === b.dataset.choicetocard);
    if (!c?.bill) return;
    b.disabled = true;
    try { await apiFull('DELETE', `/businesses/${biz.id}/shifts/${day}/choices/${c.id}`, {}); }
    catch (err) { b.disabled = false; showError(b.closest('.list-row').querySelector('.form-msg'), err); return; }
    await paidOnCardClick(biz, day, { payment: { id: c.paymentId, amountPaise: c.amountPaise, paidAt: c.paidAt, upi: true }, written: c.bill }, b, reload);
  }));
  box.querySelectorAll('[data-tpaidcard]').forEach((b) => b.addEventListener('click', () => paidOnCardClick(biz, day, k.needs.find((x) => x.payment.id === b.dataset.tpaidcard), b, reload)));
  box.querySelectorAll('[data-carddismiss^="oldgrp:"]').forEach((b) => b.addEventListener('click', () => setTimeout(reload, 0)));
  box.querySelectorAll('[data-oldgrp]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const base = `/businesses/${biz.id}`;
    const olds = b.dataset.old.split(',').map((x) => x.split(':'));
    const decided = [];
    try {
      for (const [note, kind] of [[OLD_POS_NOTE, 'full'], [SHORT_OLD_POS_NOTE, 'short']]) {
        const ids = olds.filter(([, k2]) => k2 === kind).map(([id]) => id);
        if (!ids.length) continue;
        const res = await apiFull('POST', `${base}/shifts/${day}/register-only`, { ids, note });
        const skipped = res.skipped ?? [];
        decided.push(...olds.filter(([id, k2, no]) => k2 === kind && !skipped.some((x) => x.billNo === no)).map(([id]) => id));
        if (skipped.length) throw new Error(`Not counted from the register: ${skipped.map((x) => `${x.billNo} (${x.reason})`).join(', ')}.`);
      }
      const { id } = await apiFull('POST', `${base}/shifts/${day}/card-choices`, { paymentId: b.dataset.oldgrp, comparisonIds: b.dataset.cmps.split(',') });
      await reload();
      doneToast(`${olds.length} old POS bill${olds.length === 1 ? '' : 's'} counted from the register; the ₹ ${b.textContent.match(/₹\s?([\d,.]+)/)?.[1] ?? ''} swipe is matched to the ${b.dataset.cmps.split(',').length} bills when you save.`, async () => {
        await apiFull('DELETE', `${base}/shifts/${day}/choices/${id}`, {});
        for (const cid of decided) await apiFull('PUT', `${base}/comparisons/${cid}`, { decision: null });
      }, reload);
    } catch (err) {
      b.disabled = false;
      showError(b.closest('.rv-card').querySelector('.form-msg'), err);
      if (decided.length) await reload();
    }
  }));
  box.querySelectorAll('[data-tcardpick]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const { id } = await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/card-choices`, { paymentId: b.dataset.tcardpick, comparisonIds: b.dataset.cmps.split(',') });
      await reload();
      doneToast(`${b.textContent.split(' · ')[0]}: matched to its card payment when you save.`, () => apiFull('DELETE', `/businesses/${biz.id}/shifts/${day}/choices/${id}`, {}), reload);
    } catch (err) { b.disabled = false; showError(b.closest('.rv-card').querySelector('.form-msg'), err); }
  }));
}

// ---- Card, on Reconcile (approved 8 Nov 2026): a confirmed shift's card bills against the card company's payments,
// next to UPI. Bookr matches the safe pairs and settles by the Card settlement rule; the rest waits here for a person.

/** A card bill of this saved shift paid on a later shift's swipe (approved 20 Nov 2026): matched when that shift is saved. */
function plannedCardBox(biz, x, day) {
  const p = x.planned;
  return html`<div class="rv-card plan-box">
    <div class="lane-h"><strong>Card bill <span class="mono">${x.billNo}</span>, ₹ ${money(x.amountPaise)}: paid ${p.day === addDaysIso(day, 1) ? 'next day' : `on ${dayLabel(p.day)}`}</strong><span class="chip plan">Matched when ${dayLabel(p.day)} is saved</span></div>
    <div class="tiny">${p.withBills.length ? html`Paid with bill${p.withBills.length === 1 ? '' : 's'} <span class="mono">${p.withBills.join(', ')}</span> on one swipe: ` : ''}${p.label} ₹ ${money(p.amountPaise)} · ${when(p.at)}${p.by ? ` · chosen by ${p.by}` : ''}</div>
    <div class="form-row" style="gap:6px"><a class="btn plain dchip" href="#/b/${biz.id}/reconcile/${p.day}?tab=card">Open ${dayLabel(p.day)} Card tab ›</a>
      <button class="btn plain dchip" type="button" data-unplan="${p.choiceId}" data-day="${p.day}">Undo the choice</button></div><div class="form-msg"></div></div>`;
}
function cardSection(biz, k, heads) {
  const st = k.strip;
  const at = (ms) => (ms ? when(ms) : 'register only');
  const card = (p) => p.label ?? `${p.cardType ?? 'Card'}${p.cardLast4 ? ` ··${p.cardLast4}` : ''}`;
  const income = heads.filter((h) => h.type === 'income');
  const left = k.left;
  const need = (n) => {
    const p = n.payment;
    const head = html`<div class="lane-h"><strong>₹ ${money(p.amountPaise)} on the card machine at ${when(p.paidAt)}</strong><span class="tchip warn">${
      n.why === 'several' ? 'More than one bill fits' : n.why === 'one' ? 'Check before matching' : n.why === 'tip' ? 'More than its bill' : n.why === 'not_purchase' ? 'Refund or void'
        : n.why === 'written' ? `Bill written as ${n.written.mode === 'upi' ? 'UPI' : 'cash'}` : 'No card bill of this amount'}</span></div>
      <div class="tiny">${card(p)} · machine ${p.terminalId}</div>`;
    if (n.why === 'written') return html`<div class="rv-card">${head}
      <div class="note">Bill <span class="mono">${n.written.billNo}</span>, ₹ ${money(n.written.amountPaise)} at ${when(n.written.paidAt)}${n.written.shiftDay !== k.day ? ` (${dayLabel(n.written.shiftDay)} shift)` : ''}, is written as <strong>${n.written.mode === 'upi' ? 'UPI' : 'cash'}</strong>, ${n.written.minutes} min from this payment.${n.written.mode === 'upi' ? ' No UPI credit has paid it: it was most likely paid on the machine.' : ''}${p.upi ? ' Paid by UPI on the machine: the bill stays UPI and is received in the machine\'s settlement.' : ''}</div>
      <div class="form-row" style="gap:6px">${p.upi ? html`<button class="btn" type="button" style="min-height:36px" data-cardupi="${p.id}" data-tx="${n.written.transactionId}" data-bill="${n.written.billNo}">Change to card and match</button>`
        : html`<button class="btn" type="button" style="min-height:36px" data-cardwascard="${p.id}" data-tx="${n.written.transactionId}" data-bill="${n.written.billNo}">Change to card and match</button>`}</div><div class="form-msg"></div></div>`;
    if (n.why === 'not_purchase') return html`<div class="rv-card">${head}<div class="note">A ${String(p.txnType).toLowerCase()} on the card machine, not a sale. Check it with the bill it reverses on <a href="#/b/${biz.id}/cards">Card settlements</a>.</div></div>`;
    if (n.why === 'tip') return html`<div class="rv-card">${head}
      <div class="note">Bill <span class="mono">${n.tip.billNo}</span> is ₹ ${money(n.tip.amountPaise)}, ${at(n.tip.paidAt)}: the guest paid ₹ ${money(n.tip.tipPaise)} more on the card.</div>
      <div class="form-row" style="gap:6px"><button class="btn" type="button" style="min-height:36px" data-cardtip="${p.id}" data-tx="${n.tip.transactionId}">Match, ₹ ${money(n.tip.tipPaise)} tip</button></div><div class="form-msg"></div></div>`;
    if (n.candidates.length) return html`<div class="rv-card">${head}
      <div class="note">${n.candidates.length > 1 ? 'Pick the bill this payment was for.' : 'The bill of this amount is further away in time than Bookr matches on its own.'}</div>
      <div class="form-row" style="gap:6px">${n.candidates.map((x) => html`<button class="btn plain" type="button" style="min-height:36px" data-cardpick="${p.id}" data-tx="${x.transactionIds.join(',')}">Bill ${x.billNos.join(' + ')}${x.minutes != null ? ` · ${x.minutes} min` : ' · no bill time'}${x.shiftDay !== k.day && x.shiftDay ? ` · ${dayLabel(x.shiftDay)}` : ''}</button>`)}</div><div class="form-msg"></div></div>`;
    return html`<div class="rv-card">${head}
      <div class="note">No card bill of this amount is waiting: a bill written as cash or UPI, or money that is not a bill (an advance, a room).</div>
      <div class="form-row" style="gap:6px;align-items:center"><select data-cardhead="${p.id}" style="min-height:36px;max-width:220px"><option value="">Book to a head…</option>${income.map((h) => html`<option value="${h.id}">${h.name}</option>`)}</select>
        <button class="btn plain" type="button" style="min-height:36px" data-cardbook="${p.id}">Book</button>
        <a class="btn plain" style="display:inline-flex;align-items:center;min-height:36px" href="#/b/${biz.id}/compare/${k.day}">Find the bill</a></div><div class="form-msg"></div></div>`;
  };
  const noSwipe = (x) => x.upi ? html`<div class="rv-card" style="border-color:var(--teal)">
    <div class="lane-h"><strong>Card bill <span class="mono">${x.billNo}</span>, ₹ ${money(x.amountPaise)}: paid by UPI, not on the machine</strong><span class="tchip ok">Bank shows it</span></div>
    <div class="tiny">${at(x.paidAt)}</div>
    <div class="note">No machine payment for this bill, and ₹ ${money(x.upi.amountPaise)} came in by UPI at ${when(x.upi.postedAt)}${x.upi.accountName ? ` on ${x.upi.accountName}` : ''}${x.upi.minutes != null ? `, ${x.upi.minutes} min from the bill` : ''}. No other bill has taken that credit.</div>
    <div class="form-row" style="gap:6px"><button class="btn" type="button" style="min-height:36px" data-cardwasupi="${x.transactionId}" data-row="${x.upi.creditId}" data-group="${x.groupHead ?? ''}" data-bill="${x.billNo}">Change to UPI and match</button>
      <button class="btn plain" type="button" style="min-height:36px" data-cardwas="cash" data-tx="${x.transactionId}" data-group="${x.groupHead ?? ''}">Was cash</button></div><div class="form-msg"></div></div>`
    : x.parts && !x.parts.credit ? html`<div class="rv-card" style="border-color:var(--teal)">
    <div class="lane-h"><strong>Card bill <span class="mono">${x.billNo}</span>, ₹ ${money(x.amountPaise)}: paid in two goes on the machine</strong><span class="tchip ok">Card report shows it</span></div>
    <div class="tiny">${at(x.paidAt)}</div>
    <div class="note">${x.parts.payments.map((p) => `₹ ${money(p.amountPaise)} (${card(p)}) at ${when(p.paidAt)}`).join(' + ')} = ₹ ${money(x.amountPaise)}.</div>
    <div class="form-row" style="gap:6px"><button class="btn" type="button" style="min-height:36px" data-cardparts="${x.parts.paymentIds.join(',')}" data-tx="${x.transactionId}" data-bill="${x.billNo}">Match both</button></div><div class="form-msg"></div></div>`
    : html`<div class="rv-card" ${x.cashFits ? 'style="border-color:var(--teal)"' : ''}>
    <div class="lane-h"><strong>Card bill <span class="mono">${x.billNo}</span>, ₹ ${money(x.amountPaise)}: no card payment</strong><span class="tchip warn">No swipe</span></div>
    <div class="tiny">${at(x.paidAt)}</div>
    ${x.parts?.credit ? html`<div class="note">It may have been paid in two ways: ₹ ${money(x.parts.payments[0].amountPaise)} (${card(x.parts.payments[0])}) on the machine at ${when(x.parts.payments[0].paidAt)} and ₹ ${money(x.parts.credit.amountPaise)} by UPI at ${when(x.parts.credit.postedAt)}${x.parts.credit.accountName ? ` on ${x.parts.credit.accountName}` : ''}. Splitting a bill over the machine and the bank is not in Bookr yet: note it, and use Was cash / Was UPI only if it fits.</div>` : ''}
    ${!x.bankCovered ? html`<div class="tiny">The bank is not in for the whole shift yet: once it is, Bookr also looks for a UPI credit of this amount.</div>` : ''}
    <div class="note">The card report is in for this shift and has no payment for this bill.${x.cashFits ? html` <strong>The shift's cash is over by exactly ₹ ${money(x.amountPaise)}</strong>: it was most likely paid in cash.` : ' Was it paid another way?'}</div>
    <div class="form-row" style="gap:6px"><button class="btn ${x.cashFits ? '' : 'plain'}" type="button" style="min-height:36px" data-cardwas="cash" data-tx="${x.transactionId}" data-group="${x.groupHead ?? ''}">Was cash</button>
      <button class="btn plain" type="button" style="min-height:36px" data-cardwas="upi" data-tx="${x.transactionId}" data-group="${x.groupHead ?? ''}">Was UPI</button></div><div class="form-msg"></div></div>`;
  const settle = (x) => html`<tr><td>${dayLabel(x.settledOn)}<div class="tiny">${x.payments} swipe${x.payments === 1 ? '' : 's'} · merchant ${x.merchantId}</div></td>
    <td class="amount">${money(x.amountPaise)}</td><td class="amount">${money(x.feePaise)}</td><td class="amount">${money(x.gstPaise)}</td><td class="amount"><strong>${money(x.netPaise)}</strong></td>
    <td>${x.bank ? html`<span class="chip ok">${x.bank.byBookr ? 'Settled by Bookr' : 'Settled'}</span><div class="tiny">${when(x.bank.postedAt)} · ${x.bank.accountName}</div>
      <button class="btn plain dchip" type="button" data-cardunsettle="${x.bank.id}">Undo</button>`
      : !x.ruleSet ? html`<span class="chip wait">Can't check yet</span>`
      : html`<span class="chip">Waiting for the bank</span><div class="tiny"><a href="#/b/${biz.id}/cards">Card settlements</a></div>`}</td></tr>`;
  return html`<section class="card" style="gap:10px" id="cardsec">
    <div class="lane-h"><h2 style="margin:0">Card machine</h2>${!k.covered ? html`<span class="chip">Card report not in for this shift yet</span>`
      : left ? html`<span class="chip wait">${left} left</span>` : (k.planned ?? []).length ? html`<span class="chip plan">${k.planned.length} planned on a later shift</span>` : html`<span class="chip ok">Card reconciled</span>`}</div>
    ${savedStrip(k)}
    ${(k.planned ?? []).length ? html`<div class="rv-cards">${k.planned.map((x) => plannedCardBox(biz, x, k.day))}</div>` : ''}
    ${k.needs.length || k.noSwipe.length ? html`<div class="rv-cards">${k.needs.map(need)}${k.noSwipe.map(noSwipe)}</div>` : ''}
    ${k.done.length ? html`<details class="cmp-fold"><summary><strong>Swipes matched · ${k.done.length}</strong> <span class="note">· ${[k.done.filter((d) => d.byBookr).length && `${k.done.filter((d) => d.byBookr).length} found by Bookr`, k.done.filter((d) => !d.byBookr).length && `${k.done.filter((d) => !d.byBookr).length} picked`].filter(Boolean).join(', ')}</span></summary><div class="scroll"><table style="min-width:560px"><thead><tr><th>Card payment</th><th style="text-align:right">Amount</th><th>Bill</th><th></th></tr></thead><tbody>
      ${k.done.map((d) => html`<tr><td>${when(d.payment.paidAt)}<div class="tiny">${card(d.payment)}</div></td><td class="amount">${money(d.payment.amountPaise)}</td>
        <td>${d.booked ? 'Booked to a head' : html`<span class="mono">${d.bills.join(' + ')}</span>`}${d.tipPaise ? html`<div class="tiny">₹ ${money(d.tipPaise)} tip</div>` : ''}${d.byBookr ? html` <span class="chip">by Bookr</span>` : ''}</td>
        <td><button class="btn plain dchip" type="button" data-cardunmatch="${d.payment.id}">Undo</button></td></tr>`)}</tbody></table></div></details>` : ''}
    ${k.settlements.length ? html`<div><strong>Paid into the bank</strong> <span class="note">· each day the card company pays that day's swipes, less fee and GST</span><div class="scroll"><table style="min-width:620px"><thead><tr><th>Settled</th><th style="text-align:right">Gross</th><th style="text-align:right">Fee</th><th style="text-align:right">GST</th><th style="text-align:right">Net</th><th>Bank</th></tr></thead>
      <tbody>${k.settlements.map(settle)}</tbody></table></div>
      ${k.settlements.some((x) => !x.bank && !x.ruleSet) ? html`<div class="tiny note" style="margin-top:4px">Bookr doesn't know which bank account card payouts arrive in, so it can't tick these off or book the fee. Set it once and it works for every day. <a href="#/b/${biz.id}/heads">Set where card payouts arrive ›</a></div>` : ''}</div>` : ''}
    <div id="cardmsg" class="form-msg"></div>
  </section>`;
}

/** A saved shift's card money in plain words (approved 20 Nov 2026): swiped here, and bills paid on another day's swipe. */
function savedStrip(k) {
  const st = k.strip;
  const got = st.machineCardPaise + st.machineUpiPaise;
  const away = k.elsewhere ?? [];
  const awayP = away.reduce((t, x) => t + x.amountPaise, 0);
  const awayDays = [...new Set(away.map((x) => x.day))];
  const awayLabel = awayDays.length === 1 ? `Paid on ${dayLabel(awayDays[0])}'s swipe` : 'Paid on other days\' swipes';
  const met = (label, v, sub, color = 'inherit') => html`<div><div class="tiny">${label}</div><div class="amount rec-n" style="color:${color}">₹ ${money(v)}</div>${sub ? html`<div class="tiny">${sub}</div>` : ''}</div>`;
  const nSw = k.done.length + (k.needs ?? []).length;
  const allPaid = !st.noSwipe && st.matched === st.bills;
  return html`<div class="rec-strip">
    ${met('Card bills', st.billsPaise, `${st.bills} bill${st.bills === 1 ? '' : 's'}${allPaid ? ', all paid' : ''}`)}
    ${met('Swiped this shift', got, `${nSw} swipe${nSw === 1 ? '' : 's'}${st.machineUpiPaise ? ` · ₹ ${rs(st.machineUpiPaise)} UPI on the machine` : ''}`)}
    ${away.length ? met(awayLabel, awayP, html`${away.map((x, i) => html`${i ? ', ' : ''}<span class="mono">${x.billNo}</span>`)}`) : ''}
    ${st.noSwipe ? met('Card bills with no swipe', st.noSwipePaise, `${st.noSwipe} bill${st.noSwipe === 1 ? '' : 's'}`, 'var(--danger)') : ''}
    ${st.noBill ? met('Swipes with no bill', st.noBillPaise, `${st.noBill} swipe${st.noBill === 1 ? '' : 's'}`, 'var(--danger)') : ''}
  </div>
  ${away.length ? html`<div class="tiny note">₹ ${rs(got)} swiped this shift${st.noBillPaise ? ` (₹ ${rs(st.noBillPaise)} with no bill)` : ''} + ₹ ${rs(awayP)} paid on ${awayDays.length === 1 ? dayLabel(awayDays[0]) : 'other days'} = ₹ ${rs(got - (st.noBillPaise ?? 0) + awayP)}${got - (st.noBillPaise ?? 0) + awayP === st.billsPaise ? ', every card bill' : ''}.</div>` : ''}`;
}
function wireCardSection(biz, k, act) {
  const box = document.getElementById('cardsec');
  if (!box || !k) return;
  // Undo a later shift's choice (20 Nov 2026): the swipe goes back to its shift's list, this bill waits again.
  box.querySelectorAll('[data-unplan]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm(`Undo the choice made on ${dayLabel(b.dataset.day)}? The swipe goes back to that shift's list, and this bill waits for a card payment again.`)) return;
    act(() => apiFull('DELETE', `/businesses/${biz.id}/shifts/${b.dataset.day}/choices/${b.dataset.unplan}`, {}));
  }));
  const B = `/businesses/${biz.id}/cards`;
  const unmatch = (pid) => apiFull('POST', `${B}/${pid}/unmatch`, {});
  box.querySelectorAll('[data-cardpick]').forEach((b) => b.addEventListener('click', () => {
    b.disabled = true;
    const pid = b.dataset.cardpick;
    act(() => apiFull('POST', `${B}/match`, { sets: [{ paymentIds: [pid], transactionIds: b.dataset.tx.split(',') }] }),
      { text: `Matched ${b.textContent.split(' · ')[0]} to its card payment.`, undo: () => unmatch(pid) });
  }));
  box.querySelectorAll('[data-cardtip]').forEach((b) => b.addEventListener('click', () => {
    b.disabled = true;
    const pid = b.dataset.cardtip;
    act(() => apiFull('POST', `${B}/${pid}/tip`, { transactionId: b.dataset.tx }), { text: 'Matched, with the tip booked.', undo: () => unmatch(pid) });
  }));
  box.querySelectorAll('[data-cardbook]').forEach((b) => b.addEventListener('click', () => {
    const pid = b.dataset.cardbook;
    const headId = box.querySelector(`[data-cardhead="${pid}"]`)?.value;
    if (!headId) { showError(b.closest('.rv-card').querySelector('.form-msg'), new Error('Choose the head first.')); return; }
    b.disabled = true;
    act(() => apiFull('POST', `${B}/${pid}/book`, { headId }), { text: 'Card payment booked.', undo: () => unmatch(pid) });
  }));
  box.querySelectorAll('[data-cardwas]').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.cardwas;
    const ids = b.dataset.group ? k.noSwipe.filter((x) => x.groupHead === b.dataset.group).map((x) => x.transactionId) : [b.dataset.tx];
    b.disabled = true;
    let auditId = null;
    act(async () => { auditId = (await apiFull('POST', `/businesses/${biz.id}/sales/repay`, { transactionIds: ids, mode, note: 'No card payment in the card report (Reconcile)' })).auditId; },
      { text: `Changed to ${mode === 'upi' ? 'UPI' : 'cash'}.`, undo: () => apiFull('POST', `/businesses/${biz.id}/sales/repay/${auditId}/undo`, {}) });
  }));
  // Paid another way than written (approved 9 Nov 2026): the mode change and the match in one step; Undo puts back both.
  const repayUndo = (id) => apiFull('POST', `/businesses/${biz.id}/sales/repay/${id}/undo`, {});
  box.querySelectorAll('[data-cardwasupi]').forEach((b) => b.addEventListener('click', () => {
    const ids = b.dataset.group ? k.noSwipe.filter((x) => x.groupHead === b.dataset.group).map((x) => x.transactionId) : [b.dataset.cardwasupi];
    const rowId = b.dataset.row;
    b.disabled = true;
    let auditId = null;
    act(async () => { auditId = (await apiFull('POST', `${B}/was-upi`, { transactionIds: ids, bankRowId: rowId })).auditId; },
      { text: `Bill ${b.dataset.bill} changed to UPI and matched to its credit.`, undo: async () => { await apiFull('DELETE', `/businesses/${biz.id}/bank-rows/${rowId}/match`, {}); await repayUndo(auditId); } });
  }));
  box.querySelectorAll('[data-cardwascard]').forEach((b) => b.addEventListener('click', () => {
    const pid = b.dataset.cardwascard;
    b.disabled = true;
    let auditId = null;
    act(async () => { auditId = (await apiFull('POST', `${B}/${pid}/was-card`, { transactionIds: [b.dataset.tx] })).auditId; },
      { text: `Bill ${b.dataset.bill} changed to card and matched to the machine payment.`, undo: async () => { await unmatch(pid); await repayUndo(auditId); } });
  }));
  box.querySelectorAll('[data-cardupi]').forEach((b) => b.addEventListener('click', () => {
    const pid = b.dataset.cardupi;
    b.disabled = true;
    let auditId = null;
    act(async () => { auditId = (await apiFull('POST', `${B}/${pid}/upi-on-machine`, { transactionIds: [b.dataset.tx] })).auditId; },
      { text: `Bill ${b.dataset.bill} changed to card (UPI on the machine) and matched to the machine payment.`, undo: async () => { await unmatch(pid); if (auditId) await repayUndo(auditId); } });
  }));
  box.querySelectorAll('[data-cardparts]').forEach((b) => b.addEventListener('click', () => {
    const pids = b.dataset.cardparts.split(',');
    b.disabled = true;
    act(() => apiFull('POST', `${B}/match`, { sets: [{ paymentIds: pids, transactionIds: [b.dataset.tx] }] }),
      { text: `Bill ${b.dataset.bill} matched to its two machine payments.`, undo: () => unmatch(pids[0]) });
  }));
  box.querySelectorAll('[data-cardunmatch]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Undo this match? The bill waits for its card payment again; a tip or booking added with it is removed.')) return;
    act(() => unmatch(b.dataset.cardunmatch));
  }));
  box.querySelectorAll('[data-cardunsettle]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Undo this settlement? The bank credit is open again and the fee and GST rows are removed.')) return;
    act(() => apiFull('POST', `${B}/unsettle`, { bankRowId: b.dataset.cardunsettle }));
  }));
}

/** Books a credit, asking first if a bill of its amount is waiting: both would count one sale twice. False if the person stops. */
async function bookCredit(biz, rowId, payload) {
  const path = `/businesses/${biz.id}/bank-rows/${rowId}/book`;
  const first = await apiFull('POST', path, { ...payload, checkBills: true });
  if (first.ok) return true;
  const list = first.waitingBills.map((b) => `${b.billNo} (${dayLabel(b.day)} shift)`).join(', ');
  if (!confirm(`A bill of this amount is waiting: ${list}.\n\nIf this credit pays it, match them instead, or this sale is counted twice. Book it anyway?`)) return false;
  await apiFull('POST', path, payload);
  return true;
}

/** Tab 2: what is still open on every shift, oldest first. Closing a bill takes Owner or Accountant, and a reason. */
const unmatchedState = { seg: 'all', q: '' };
async function unmatchedView(biz) {
  const [u, heldRes] = await Promise.all([api('GET', `/businesses/${biz.id}/unmatched`), api('GET', `/businesses/${biz.id}/held`).catch(() => ({ held: [] }))]);
  const held = heldRes.held ?? [];
  const reload = () => unmatchedView(biz);
  const canClose = biz.actions.includes('sales.decide');
  const sum = (xs) => xs.reduce((t, x) => t + x.amountPaise, 0);
  const bills = u.bills.map((x) => ({ ...x, side: 'bill' }));
  const credits = u.credits.map((x) => ({ ...x, side: 'credit' }));
  const entries = [...bills, ...credits].sort((a, b) => a.day.localeCompare(b.day) || a.amountPaise - b.amountPaise);
  const old = entries.filter((x) => x.age > u.watchDays);
  const matches = (x) => {
    const q = unmatchedState.q.trim().replace(/[₹,\s]/g, '');
    if (!q) return true;
    return (x.billNo ?? '').includes(q) || String(x.amountPaise / 100).startsWith(q) || (x.remark ?? '').toLowerCase().includes(q.toLowerCase());
  };
  const shown = () => entries.filter((x) => (unmatchedState.seg === 'all' || unmatchedState.seg === x.side) && matches(x));
  const rowHtml = (x) => html`<details class="um-row" data-um="${x.id}"><summary>
      <span style="flex:1;min-width:0">${x.side === 'bill' ? html`Bill <span class="mono">${x.billNo ?? ''}</span>` : html`Credit at ${when(x.postedAt)}`}
        <span class="tiny" style="display:block">${dayLabel(x.day)} shift · ${x.age === 0 ? 'today' : x.age === 1 ? 'yesterday' : `${x.age} days ago`}${x.accountName ? ` · ${x.accountName}` : ''}${x.labels ? ` · ${x.labels}` : ''}</span></span>
      <strong class="amount">₹ ${money(x.amountPaise)}</strong></summary><div class="um-body note">Loading…</div></details>`;
  const groupHtml = (title, cls, xs) => xs.length ? html`<section class="card" style="gap:6px"><div class="lane-h"><h2>${title}</h2><span class="tchip ${cls}">${xs.length} · ₹ ${money(sum(xs))}</span></div>${xs.map(rowHtml)}</section>` : '';
  const listHtml = () => {
    if (unmatchedState.seg === 'held') {
      // Refunds due and tips for staff (Stage 5): not income; done when the money goes back or out.
      return held.length ? html`<section class="card" style="gap:6px"><div class="note">Money received that is not income. A refund due is done when its payment back is matched; a tip when it is paid out to staff.</div>
        ${held.map((h) => html`<div class="um-line" style="flex-wrap:wrap;gap:6px"><span style="flex:1;min-width:220px">${h.kind === 'refund' ? 'Refund due' : 'Tip for staff'} · credit at ${when(h.postedAt)}
          <span class="tiny" style="display:block">${dayLabel(h.day)} shift${h.accountName ? ` · ${h.accountName}` : ''} · ${h.note.replace(/^Held: (refund due|tip for staff) · /, '')}</span>
          ${h.outs.map((o) => html`<span class="tiny" style="display:block">Paid back on ${when(o.postedAt)}${o.vpa ? ` to ${o.vpa}` : ''}? <button class="linkbtn tiny" type="button" data-heldout="${h.id}" data-out="${o.id}">Match the refund</button></span>`)}</span>
          <strong class="amount">₹ ${money(h.amountPaise)}</strong>
          ${h.done ? html`<span class="chip ok">${h.kind === 'refund' ? 'Paid back' : 'Paid out'}</span>` : h.kind === 'tip' ? html`<button class="btn plain dchip" type="button" data-heldtip="${h.id}">Paid out to staff</button>` : html`<span class="chip wait">Not paid back</span>`}
          <button class="btn plain dchip" type="button" data-heldreopen="${h.id}">Open again</button></div>`)}</section>`
        : html`<section class="card"><div class="note">Nothing is held as a refund due or a tip.</div></section>`;
    }
    if (unmatchedState.seg === 'closed') {
      return u.closed.length ? html`<section class="card" style="gap:6px">${u.closed.map((x) => html`<div class="um-line" style="flex-wrap:wrap"><span style="flex:1;min-width:220px">Bill <span class="mono">${x.billNo ?? ''}</span>
        <span class="tiny" style="display:block">${dayLabel(x.day)} shift · closed ${when(x.closedAt)}${x.closedBy ? ` by ${x.closedBy}` : ''}: ${x.note}</span></span><strong class="amount">₹ ${money(x.amountPaise)}</strong>
        ${canClose ? html`<button class="btn plain dchip" type="button" data-umreopen="${x.id}">Reopen</button>` : ''}</div>`)}</section>` : html`<section class="card"><div class="note">No bills have been closed.</div></section>`;
    }
    const xs = shown();
    if (!xs.length) return html`<section class="card"><div class="note">${entries.length ? 'Nothing matches this search.' : 'Every UPI bill and credit is explained.'}</div></section>`;
    return html`${groupHtml(`Over ${u.watchDays} days: needs closing`, 'bad', xs.filter((x) => x.age > u.watchDays))}
      ${groupHtml(`2 to ${u.watchDays} days`, 'warn', xs.filter((x) => x.age >= 2 && x.age <= u.watchDays))}
      ${groupHtml('Today and yesterday', '', xs.filter((x) => x.age < 2))}`;
  };
  render(shell(biz, 'reconcile', 'Reconcile', '', html`
    ${recTabs(biz, null, 'all')}
    <section class="card" style="gap:10px">
      <div class="rec-strip">
        <div><div class="tiny">Bills not in the bank yet</div><div class="amount rec-n">₹ ${money(sum(bills))}</div><div class="tiny">${bills.length} bill${bills.length === 1 ? '' : 's'}</div></div>
        <div><div class="tiny">Credits not matched yet</div><div class="amount rec-n">₹ ${money(sum(credits))}</div><div class="tiny">${credits.length} credit${credits.length === 1 ? '' : 's'}</div></div>
        <div><div class="tiny">Over ${u.watchDays} days</div><div class="amount rec-n" style="color:${old.length ? 'var(--danger)' : 'inherit'}">₹ ${money(sum(old))}</div><div class="tiny">${old.length} entr${old.length === 1 ? 'y' : 'ies'}</div></div>
      </div>
      <div class="form-row" style="align-items:center;gap:10px">
        <div class="seg" id="umseg">${[['all', 'All'], ['bill', 'Bills'], ['credit', 'Credits'], ['closed', `Closed (${u.closed.length})`], ['held', `Held (${held.filter((h) => !h.done).length})`]].map(([k, l]) => html`<button type="button" data-seg="${k}" class="${unmatchedState.seg === k ? 'on' : ''}">${l}</button>`)}</div>
        <input id="umq" class="compact" type="search" placeholder="Search amount or bill number" value="${unmatchedState.q}" style="min-width:220px" aria-label="Search amount or bill number">
      </div>
    </section>
    <div id="recmsg"></div>
    <div id="umlist" style="display:contents">${listHtml()}</div>`));
  wireShell();
  const list = document.getElementById('umlist');
  const wireList = () => {
    list.querySelectorAll('[data-um]').forEach((d) => d.addEventListener('toggle', () => {
      if (d.open && !d.dataset.loaded) { d.dataset.loaded = '1'; loadUnmatchedRow(biz, entries.find((x) => x.id === d.dataset.um), d, entries, canClose, u, reload); }
    }));
    const act = async (b, fn) => { b.disabled = true; try { await fn(); await reload(); } catch (err) { b.disabled = false; showError(document.getElementById('recmsg'), err); } };
    list.querySelectorAll('[data-heldout]').forEach((b) => b.addEventListener('click', () => act(b, () => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.heldout}/held-done`, { outRowId: b.dataset.out }))));
    list.querySelectorAll('[data-heldtip]').forEach((b) => b.addEventListener('click', () => act(b, () => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.heldtip}/held-done`, {}))));
    list.querySelectorAll('[data-heldreopen]').forEach((b) => b.addEventListener('click', () => act(b, () => apiFull('POST', `/businesses/${biz.id}/bank-rows/${b.dataset.heldreopen}/reopen`, {}))));
    list.querySelectorAll('[data-umreopen]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await apiFull('POST', `/businesses/${biz.id}/sales/${b.dataset.umreopen}/reopen`, {}); await reload(); }
      catch (err) { b.disabled = false; showError(document.getElementById('recmsg'), err); }
    }));
  };
  const redraw = () => { list.innerHTML = listHtml().__html; wireList(); };
  wireList();
  document.querySelectorAll('#umseg [data-seg]').forEach((b) => b.addEventListener('click', () => {
    unmatchedState.seg = b.dataset.seg;
    document.querySelectorAll('#umseg [data-seg]').forEach((x) => x.classList.toggle('on', x === b));
    redraw();
  }));
  document.getElementById('umq').addEventListener('input', (e) => { unmatchedState.q = e.target.value; redraw(); });
}

/** A row opened: why it is open, where it came from, what it could be, and what a person can do about it. */
async function loadUnmatchedRow(biz, x, box, entries, canClose, u, reload) {
  const body = box.querySelector('.um-body');
  const base = `/businesses/${biz.id}`;
  let r = null;
  try { r = await api('GET', `${base}/shifts/${x.day}/reconcile`); } catch (err) { showError(body, err); return; }
  const tag = x.side === 'bill' ? `tx:${x.id}` : `cr:${x.id}`;
  const gone = dismissed();
  const cards = [...r.fixes, ...r.noCredit].filter((c) => c.uses?.includes(tag) && !gone.has(c.key) && c.kind !== 'no_bill');
  const pair = [...r.clear, ...r.likely].find((p) => (x.side === 'bill' ? p.transactionIds?.includes(x.id) : p.creditId === x.id));
  if (pair && r.confirmed) {
    cards.unshift({ key: `um-pair:${x.id}`, kind: 'clear_matches', title: `Bill ${pair.billNos.join(' + ')} and the credit at ${when(pair.postedAt)}`, score: 80, billNos: [],
      evidence: [`Both are ₹ ${money(pair.amountPaise)}${pair.minutes != null ? `, ${pair.minutes} minutes apart` : ''}.`], uses: [],
      actions: [{ label: 'Match', primary: true, method: 'POST', path: `${base}/bank-rows/${pair.creditId}/match`, body: { transactionIds: pair.transactionIds } }] });
  }
  const others = entries.filter((o) => o.side !== x.side && Math.abs(o.amountPaise - x.amountPaise) <= 2000)
    .sort((a, b) => Math.abs(a.amountPaise - x.amountPaise) - Math.abs(b.amountPaise - x.amountPaise) || Math.abs(a.age - x.age) - Math.abs(b.age - x.age)).slice(0, 3);
  const why = x.side === 'bill'
    ? (x.bankIn ? 'No credit of this amount has been matched to this bill.' : 'The bank is not in up to the end of this shift, so its credit may simply not be here yet.')
    : 'No bill has been matched to this money. It may be a sale not written down, or money that is not a sale.';
  const closeHint = x.side === 'bill' && !x.canClose ? `Watched for ${u.watchDays} days; it can be closed with a reason after that.` : '';
  // Before calling it extra (Stage 5): an owed bill, part of a bill, a payment made twice.
  const chk = x.side === 'credit' ? await api('GET', `${base}/bank-rows/${x.id}/checks`).catch(() => null) : null;
  const roomHead = (r.unbilledHeads ?? []).find((h) => h.billType === 'room');
  const checksHtml = chk && (chk.owed.length || chk.parts.length || chk.paidTwice) ? html`<div class="rv-card" style="gap:6px"><strong>Check first</strong>
    ${chk.owed.map((o) => html`<div class="list-row"><span>Bill <span class="mono">${o.billNo ?? ''}</span> (₹ ${money(o.amountPaise)}, ${dayLabel(o.day)}) was closed as ${o.note.replace(/^Owed by /, 'owed by ')}</span>
      <button class="btn plain dchip" type="button" data-umowed="${o.txId}">Match to the owed bill</button></div>`)}
    ${chk.parts.map((o) => html`<div class="tiny">Could be part of bill <span class="mono">${o.billNo ?? ''}</span> (₹ ${money(o.amountPaise)}, ${dayLabel(o.day)} shift): <a href="#/b/${biz.id}/reconcile/${o.day}">add it to that bill's pair on Reconcile ›</a></div>`)}
    ${chk.paidTwice ? html`<div class="tiny error">The same ₹ ${money(x.amountPaise)} came in ${chk.paidTwice.minutes} minute${chk.paidTwice.minutes === 1 ? '' : 's'} apart${chk.paidTwice.samePayer ? ', from the same payer' : ''}: paid twice? If so, hold one as a refund due.</div>` : ''}
  </div>` : '';
  body.className = 'um-body';
  body.innerHTML = html`<div class="note">${why}</div>
    <div class="tiny">${x.side === 'bill' ? html`${x.paidAt ? `Paid at ${when(x.paidAt)}` : 'Register only, no bill time'}${x.labels ? ` · written under ${x.labels}` : ''}`
      : html`${x.accountName ?? ''}${x.vpa ? ` · ${x.vpa}` : ''}${x.remark && !/^(UPI|NA|NO REMARKS?)$/i.test(x.remark) ? ` · ${x.remark}` : ''}`}</div>
    ${checksHtml}
    ${cards.length ? suggestionList(cards, x.day) : ''}
    ${others.length ? html`<div><strong>Closest possible</strong>${others.map((o) => html`<div class="um-line" style="cursor:default"><span style="flex:1">${o.side === 'bill' ? html`Bill <span class="mono">${o.billNo ?? ''}</span>` : `Credit at ${when(o.postedAt)}`}
      <span class="tiny" style="display:block">${dayLabel(o.day)} shift${o.amountPaise !== x.amountPaise ? ` · ₹ ${money(Math.abs(o.amountPaise - x.amountPaise))} ${o.amountPaise > x.amountPaise ? 'more' : 'less'}` : ' · same amount'}</span></span><span class="amount">₹ ${money(o.amountPaise)}</span></div>`)}</div>` : html`<div class="tiny">Nothing open comes close to this amount.</div>`}
    <div class="form-row" style="gap:6px">
      ${x.side === 'credit' ? html`${r.confirmed ? r.unbilledHeads.map((h) => html`<button class="btn plain" type="button" style="min-height:36px" data-umbook="${h.headId}" data-label="${h.billType === 'room' ? 'Room' : 'F&B'}">Unbilled ${h.billType === 'room' ? 'Room' : 'F&B'}</button>`) : ''}
        <a class="btn plain" style="display:inline-flex;align-items:center;min-height:36px" href="#/b/${biz.id}/bank?from=${x.day}&to=${addDaysIso(x.day, 1)}">Another head…</a>
        ${r.confirmed && roomHead ? html`<button class="btn plain" type="button" style="min-height:36px" data-umadvance="1">Advance received</button>` : ''}
        <button class="btn plain" type="button" style="min-height:36px" data-umhold="refund">Refund due</button>
        <button class="btn plain" type="button" style="min-height:36px" data-umhold="tip">Tip for staff</button>
        <button class="btn plain" type="button" style="min-height:36px" data-umignore="1">Not a sale, close</button>`
      : html`<button class="btn plain" type="button" style="min-height:36px" data-umrepay="cash">Was cash</button><button class="btn plain" type="button" style="min-height:36px" data-umrepay="card">Was card</button>
        ${canClose ? html`<button class="btn plain" type="button" style="min-height:36px" data-umowe="1">Owed by guest/company</button>` : ''}
        ${canClose && x.canClose ? html`<button class="btn plain" type="button" style="min-height:36px" data-umclose="1">Close with a reason</button>` : ''}`}
      <a class="btn plain" style="display:inline-flex;align-items:center;min-height:36px" href="#/b/${biz.id}/reconcile/${x.day}">Open the shift</a>
    </div>${closeHint ? html`<div class="tiny">${closeHint}</div>` : ''}<div class="form-msg"></div>`.__html;
  wireExplain({ cards }, reload, biz, body);
  const fail = (err) => showError(body.querySelector('.form-msg'), err);
  const run = async (fn, text, undo) => { try { await fn(); await reload(); doneToast(text, undo, reload); } catch (err) { fail(err); } };
  const reason = (q) => (prompt(q) ?? '').trim();
  body.querySelectorAll('[data-umbook]').forEach((b) => b.addEventListener('click', () => run(
    async () => { if (!await bookCredit(biz, x.id, { headId: b.dataset.umbook, note: `Unbilled ${b.dataset.label} (All unmatched)` })) throw new Error('Not booked.'); },
    `Booked to Unbilled ${b.dataset.label}.`, () => apiFull('POST', `${base}/bank-rows/${x.id}/reopen`, {}))));
  body.querySelector('[data-umignore]')?.addEventListener('click', () => {
    const note = reason('Why is this money not a sale?');
    if (note) run(() => apiFull('POST', `${base}/bank-rows/${x.id}/ignore`, { note }), 'Closed: not a sale.', () => apiFull('POST', `${base}/bank-rows/${x.id}/reopen`, {}));
  });
  body.querySelectorAll('[data-umrepay]').forEach((b) => b.addEventListener('click', async () => {
    const mode = b.dataset.umrepay;
    const note = reason(`This bill was paid by ${mode} (the register said UPI). Reason?`);
    if (!note) return;
    let audit = null;
    await run(async () => { audit = (await apiFull('POST', `${base}/sales/repay`, { transactionIds: [x.id], mode, note })).auditId; },
      `Bill ${x.billNo ?? ''} is now ${mode}.`, () => apiFull('POST', `${base}/sales/repay/${audit}/undo`, {}));
  }));
  body.querySelectorAll('[data-umowed]').forEach((b) => b.addEventListener('click', () => run(() => apiFull('POST', `${base}/bank-rows/${x.id}/owed-paid`, { txId: b.dataset.umowed }),
    'Matched to the owed bill.', () => apiFull('DELETE', `${base}/bank-rows/${x.id}/match`, {}))));
  body.querySelector('[data-umadvance]')?.addEventListener('click', () => {
    const who = reason('Advance received: from which guest (name, room or booking)?');
    if (who) run(async () => { const res = await apiFull('POST', `${base}/bank-rows/book-many`, { items: [{ rowId: x.id, billType: 'room', item: `Advance: ${who}` }] }); if (!res.booked) throw new Error(res.skipped.join(' ')); },
      'Booked as an advance. Its room bill joins it when it comes.', () => apiFull('POST', `${base}/bank-rows/${x.id}/reopen`, {}));
  });
  body.querySelectorAll('[data-umhold]').forEach((b) => b.addEventListener('click', () => {
    const refund = b.dataset.umhold === 'refund';
    const note = reason(refund ? 'Refund due: to whom, and why (e.g. Rahul K, paid twice)?' : 'Tip for staff: for whom, or a note?');
    if (note) run(() => apiFull('POST', `${base}/bank-rows/${x.id}/hold`, { kind: b.dataset.umhold, note }),
      refund ? 'Held as a refund due: not counted as income.' : 'Held as a tip for staff: not counted as income.', () => apiFull('POST', `${base}/bank-rows/${x.id}/reopen`, {}));
  }));
  body.querySelector('[data-umowe]')?.addEventListener('click', () => {
    const who = reason('Owed by which guest or company? The sale stays in income; its payment is matched to it when it comes.');
    if (who) run(() => apiFull('POST', `${base}/sales/${x.id}/close`, { note: `Owed by ${who}` }), `Bill ${x.billNo ?? ''} closed as owed by ${who}.`, () => apiFull('POST', `${base}/sales/${x.id}/reopen`, {}));
  });
  body.querySelector('[data-umclose]')?.addEventListener('click', () => {
    const note = reason('Why will this credit never come? The sale stays in income; closing only stops the chase.');
    if (note) run(() => apiFull('POST', `${base}/sales/${x.id}/close`, { note }), `Bill ${x.billNo ?? ''} closed.`, () => apiFull('POST', `${base}/sales/${x.id}/reopen`, {}));
  });
}

/**
 * One row per bill as the register has it: a bill paid in several UPI goes is one row with its payments inside;
 * bills paid together with one payment are one row. Matching underneath stays per payment.
 */
function billUnits(waiting) {
  const key = (x) => x.groupHead ? `g:${x.groupHead}` : x.parts > 1 ? `b:${x.comparisonId}` : `t:${x.id}`;
  const by = new Map();
  for (const x of waiting) by.set(key(x), [...(by.get(key(x)) ?? []), x]);
  return [...by.values()].map((xs) => {
    const amount = xs.reduce((t, x) => t + x.amountPaise, 0);
    const first = xs[0];
    const at = first.paidAt ? when(first.paidAt) : 'register only';
    const label = first.labels ? ` · ${first.labels}` : '';
    let body;
    if (first.groupHead && xs.length > 1) {
      const bills = xs.reduce((t, x) => t + (x.billPaise ?? x.amountPaise), 0);
      body = html`<span class="mono">${xs.map((x) => x.billNo).join(' + ')}</span> <span class="chip">paid together</span>
        <span class="tiny" style="display:block">${xs.length} bills of ₹ ${money(bills)} · one payment${amount !== bills ? ` of ₹ ${money(amount)}` : ''} · ${at}${label}</span>`;
    } else if (xs.length > 1) {
      body = html`<span class="mono">${first.billNo}</span> <span class="chip wait">${xs.length} UPI payments</span>
        <span class="tiny" style="display:block">bill ₹ ${money(first.billPaise ?? amount)}${first.discountPaise > 0 ? ` · discount ₹ ${money(first.discountPaise)}` : first.discountPaise < 0 ? ` · tip ₹ ${money(-first.discountPaise)}` : ''} · paid ${xs.map((x) => `₹ ${money(x.amountPaise)}`).join(' + ')} · ${at}${label}</span>`;
    } else {
      body = html`<span class="mono">${first.billNo ?? ''}</span>${first.billPaise != null && first.billPaise !== amount ? html` <span class="tiny">bill ₹ ${money(first.billPaise)}</span>` : ''}
        <span class="tiny" style="display:block">${at}${label}</span>`;
    }
    return { ids: xs.map((x) => x.id), amount, html: html`${body}${drawerBtn(first.billNo ?? '', first.shiftDay ?? '')}` };
  });
}

// ---- Bookr's explanations for what is left (one click each; each fix is recorded and can be undone)
const DISMISS_KEY = 'bookr.dismissedCards';
const dismissed = () => { try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch { return new Set(); } };
/** A done message with Undo, at the top of the screen. */
function doneToast(text, undo, reload) {
  let box = document.getElementById('recmsg');
  const floating = !box;
  // Pages without a message line (Compare sales, Review, the bill drawer) get a toast at the bottom for a while.
  if (floating) {
    document.getElementById('floattoast')?.remove();
    box = document.createElement('div');
    box.id = 'floattoast';
    box.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;width:min(560px,calc(100vw - 32px));box-shadow:0 6px 24px rgba(0,0,0,.18);border-radius:8px';
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 15000);
  }
  box.innerHTML = html`<div class="ok-msg" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span>${text}</span>${undo ? html`<button class="btn plain dchip" type="button" id="recundo">Undo</button>` : ''}</div>`.__html;
  document.getElementById('recundo')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await undo(); await reload(); if (floating) box.remove(); } catch (err) { showError(box, err); }
  });
  if (!floating) window.scrollTo({ top: 0, behavior: 'smooth' });
}
/** Changes a register row in one click (trial reconcile), and hands back how to put it as it was. */
async function changeRegisterRow(biz, a) {
  const u = await api('GET', `/businesses/${biz.id}/uploads/${a.uploadId}`);
  const r = u.rows.find((x) => x.id === a.rowId);
  if (!r) throw new Error('This row is no longer there. Open Review to check it.');
  const payload = { paidWithRowId: r.paidWithRowId, billNo: r.billNo, billType: r.billType, amount: rupeesForInput(r.amountPaise), discount: rupeesForInput(r.discountPaise), remarks: r.remarks, status: r.status,
    payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })) };
  const put = (b) => apiFull('PUT', `/businesses/${biz.id}/register-rows/${r.id}`, b);
  // Paid in full (14 Nov 2026): the discount goes, and the one payment is the bill's whole amount.
  const changed = a.op === 'noDiscount' ? { ...payload, discount: '0', payments: payload.payments.map((p) => ({ ...p, amount: rupeesForInput(r.amountPaise) })) }
    : a.op === 'fixNumber' ? { ...payload, billNo: a.billNo }
    : { ...payload, payments: payload.payments.map((p) => ({ ...p, mode: a.mode, columnLabel: PAY_COLS.find(([m]) => m === a.mode)?.[1] ?? null })) };
  await put(changed);
  return () => put(payload);
}
/** How to take back what an action did, where there is a simple way. Decisions are changed on Compare instead. */
function undoFor(biz, a, res) {
  const base = `/businesses/${biz.id}`;
  const path = a.path ?? '';
  if (path.endsWith('/same-sale')) {
    if (a.method === 'DELETE') return null;
    return path.includes('/comparisons/') ? () => apiFull('DELETE', path, a.body) : () => apiFull('DELETE', `${base}/bank-rows/${a.body.rowId}/match`, {});
  }
  if (path.endsWith('/sales/repay')) return res?.auditId ? () => apiFull('POST', `${base}/sales/repay/${res.auditId}/undo`, {}) : null;
  if (!path.includes('/bank-rows/')) return null;
  const inPath = path.match(/\/bank-rows\/([0-9a-f-]{36})\//)?.[1];
  const ids = [...(a.body?.ids ?? []), ...(a.body?.rowIds ?? []), ...(a.body?.rowId ? [a.body.rowId] : []), ...(inPath ? [inPath] : [])];
  if (!ids.length) return null;
  return () => eachAtOnce(ids, (id) => apiFull('DELETE', `${base}/bank-rows/${id}/match`, {}).catch((e) => { if (ids.length === 1) throw e; }));
}
function wireExplain(ex, reload, biz, root = document) {
  if (!ex) return;
  // One action, and how to take it back.
  const runCard = async (a) => {
    if (a.op === 'setColumn') return setColumn(biz, a);
    if (a.op === 'slip') return applySlip(biz, a);
    if (a.op) return changeRegisterRow(biz, a);
    return undoFor(biz, a, await apiFull(a.method, `${a.path}`, a.body));
  };
  root.querySelectorAll('[data-cardall]').forEach((b) => b.addEventListener('click', async () => {
    const list = b.dataset.cardall.split('|').map((k) => ex.cards.find((x) => x.key === k)).filter(Boolean);
    b.disabled = true;
    const undos = [];
    try {
      for (const c of list) { const u = await runCard(c.actions[0]); if (u) undos.push(u); }
      await reload();
      doneToast(`Done for ${list.length} bills: ${list.flatMap((c) => c.billNos ?? []).join(', ')}.`, undos.length ? async () => { for (const u of undos.reverse()) await u(); } : null, reload);
    } catch (err) {
      b.disabled = false;
      showError(b.closest('[data-sg]')?.querySelector('[data-sgmsg]'), err);
      if (undos.length) await reload();
    }
  }));
  root.querySelectorAll('[data-cardact]').forEach((b) => b.addEventListener('click', async () => {
    const c = ex.cards.find((x) => x.key === b.dataset.cardact);
    const a = c.actions[Number(b.dataset.i)];
    // Tick these in Match by hand (below on Reconcile), where the person chooses how to book a difference.
    if (a.op === 'pick') {
      const box = document.getElementById('pair');
      if (!box) return showError(root.querySelector(`[data-card="${CSS.escape(c.key)}"] .form-msg`), new Error('Open this shift on Reconcile to match by hand.'));
      box.querySelectorAll('[data-pcr]').forEach((x) => { x.checked = a.credits.includes(x.dataset.pcr); x.dispatchEvent(new Event('change')); });
      box.querySelectorAll('[data-pbl]').forEach((x) => { x.checked = x.dataset.pbl.split(',').some((id) => a.sales.includes(id)); x.dispatchEvent(new Event('change')); });
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    b.disabled = true;
    try {
      const undo = await runCard(a);
      await reload();
      doneToast(c.billNos?.length ? `${a.label}: bill ${c.billNos.join(' + ')}.` : `Done: ${c.title}.`, undo, reload);
    } catch (err) { b.disabled = false; showError(root.querySelector(`[data-card="${CSS.escape(c.key)}"] .form-msg`), err); }
  }));
  root.querySelectorAll('[data-carddismiss]').forEach((b) => b.addEventListener('click', () => {
    const gone = dismissed(); gone.add(b.dataset.carddismiss);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...gone].slice(-500))); } catch { /* storage unavailable */ }
    b.closest('[data-card]').remove();
  }));
}

/** Side by side: bank credits not matched (left) and UPI bills not found (right). Tick, compare totals, match. */
function pairPanel(v, waiting, opts = {}) {
  v.bizId = currentBizId();
  if (!v.credits.length && !waiting.length && !v.repaid?.length) return '';
  const units = billUnits(waiting);
  const pick = 'width:18px;height:18px;min-height:0';
  const line = 'display:flex;gap:10px;align-items:center;padding:8px 10px;border-top:1px solid var(--line-soft);cursor:pointer';
  return html`<section class="card" id="pair" style="margin-top:16px;gap:10px">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline"><h2>Match by hand</h2>
      <span class="note">For what the suggestions missed: a typo in the register, or a guest who paid in two goes. Tick the credit(s) and the bill(s) they pay.</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">
      <div style="border:1px solid var(--line-soft);border-radius:8px;overflow:hidden">
        <div style="padding:8px 10px;font-weight:600;background:var(--surface-2,#F6F7F9)">Bank credits not matched <span class="chip">${v.credits.length}</span></div>
        <div style="max-height:420px;overflow:auto">${v.credits.length ? v.credits.map((c) => html`<label style="${line}">
          <input type="checkbox" data-pcr="${c.id}" data-amt="${c.amountPaise}" style="${pick}">
          <span style="flex:1;min-width:0"><span class="mono note" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.remark && !/^(UPI|NA|NO REMARKS?)$/i.test(c.remark) ? `${c.remark} · ` : ''}${c.vpa ?? ''}</span>
            <span class="tiny">${when(c.postedAt)} · ${c.accountName}${c.label ? ` · ${c.label}` : ''}${c.outside ? html` <span class="chip" style="background:#EEF0F3;color:#5B6472" title="Received outside this shift's 8 am to 8 am">outside shift</span>` : ''}</span></span>
          <strong class="amount" style="color:${c.outside ? '#5B6472' : 'var(--teal)'}">₹ ${money(c.amountPaise)}</strong></label>`) : html`<div class="note" style="padding:10px">None around this shift.</div>`}
          <div style="padding:8px 10px;border-top:1px solid var(--line-soft)"><a class="btn plain" style="display:inline-flex;align-items:center;min-height:34px" href="#/b/${v.bizId}/reconcile/${v.day}?more=${v.moreHours + 3}">Show 3 more hours after the shift</a>
            <span class="tiny">Showing to ${v.moreHours} hour${v.moreHours === 1 ? '' : 's'} after 8 am.</span></div></div>
      </div>
      <div style="border:1px solid var(--line-soft);border-radius:8px;overflow:hidden">
        <div style="padding:8px 10px;font-weight:600;background:var(--surface-2,#F6F7F9)">UPI bills not found in the bank <span class="chip">${units.length}</span></div>
        <div style="max-height:420px;overflow:auto">${units.length ? units.map((u) => html`<label style="${line}">
          <input type="checkbox" data-pbl="${u.ids.join(',')}" data-amt="${u.amount}" style="${pick}">
          <span style="flex:1;min-width:0">${u.html}</span>
          <span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><strong class="amount">₹ ${money(u.amount)}</strong>
            <select class="compact" data-repay="${u.ids.join(',')}" aria-label="Paid another way" title="The register said UPI, but it was paid by cash or card" style="font-size:13px;min-height:30px">
              <option value="">Paid another way…</option><option value="cash">Was cash</option><option value="card">Was card</option></select></span></label>`) : html`<div class="note" style="padding:10px">Every UPI bill of this shift is found.</div>`}</div>
      </div>
    </div>
    <div id="pairbar" class="inset" style="position:sticky;bottom:8px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between">
      <span id="pairsum" class="note">Tick the credit(s) on the left and the bill(s) they pay on the right.</span>
      <span style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span id="pairdiff" hidden style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select class="compact" id="pairtreat" aria-label="What the difference is">
            <option value="bills">Change the bills: discount / tip</option>
            <option value="head">Book it under a head</option>
          </select>
          <select class="compact" id="pairhead" aria-label="Head for the difference" hidden></select>
          <input class="compact" id="pairnote" placeholder="Reason, e.g. register typo 2189 for 2139" style="min-width:240px">
        </span>
        <button class="btn" type="button" id="pairgo" disabled>Match</button>
      </span>
    </div>
    <div id="pairmsg"></div>
    ${v.repaid?.length && !opts.noRepaid ? html`<div style="border-top:1px solid var(--line-soft);padding-top:10px;display:flex;flex-direction:column;gap:6px">
      <strong>Changed here from UPI to cash or card</strong>
      ${v.repaid.map((x) => html`<div class="form-row" style="align-items:center;gap:10px">
        <span class="mono">${(x.bills ?? []).join(' + ')}</span><span>₹ ${money(x.amountPaise)} → <strong>${x.mode === 'cash' ? 'Cash' : 'Card'}</strong></span>
        <span class="note">${x.note ?? ''} · ${when(x.at)}</span><button class="btn plain" type="button" data-repayundo="${x.id}" style="min-height:32px">Put back</button></div>`)}
    </div>` : ''}
  </section>`;
}

// Changed from UPI (21 Nov 2026): on a reconciled saved shift, told on its own with Put back.
function repaidHtml(v) {
  if (!v.repaid?.length) return '';
  return html`<section class="card" style="gap:6px"><strong>Changed from UPI · ${v.repaid.length} bill${v.repaid.length === 1 ? '' : 's'}</strong>
    ${v.repaid.map((x) => html`<div class="form-row" style="align-items:center;gap:10px;justify-content:space-between">
      <span><span class="mono">${(x.bills ?? []).join(' + ')}</span> ₹ ${money(x.amountPaise)} → <strong>${x.mode === 'cash' ? 'Cash' : 'Card'}</strong> <span class="tiny">${x.note ? `· ${x.note} ` : ''}· ${when(x.at)}</span></span>
      <button class="btn plain" type="button" data-repayundo="${x.id}" style="min-height:32px">Put back to UPI</button></div>`)}
  </section>`;
}

function wirePairPanel(biz, v, heads, reload) {
  const box = document.getElementById('pair');
  if (!box) return;
  const crs = () => [...box.querySelectorAll('[data-pcr]')].filter((x) => x.checked);
  const bls = () => [...box.querySelectorAll('[data-pbl]')].filter((x) => x.checked);
  const sum = (xs) => xs.reduce((t, x) => t + Number(x.dataset.amt), 0);
  const go = document.getElementById('pairgo');
  const diffBox = document.getElementById('pairdiff');
  const headSel = document.getElementById('pairhead');
  const refresh = () => {
    const c = crs(); const b = bls();
    const bank = sum(c); const bills = sum(b); const diff = bank - bills;
    document.getElementById('pairsum').innerHTML = c.length || b.length
      ? html`Bank <strong>₹ ${money(bank)}</strong> · Bills <strong>₹ ${money(bills)}</strong> · Difference <strong style="color:${diff ? 'var(--danger)' : 'var(--teal)'}">${diff > 0 ? '+' : diff < 0 ? '−' : ''}₹ ${money(Math.abs(diff))}</strong>${diff < 0 ? ' (less came in)' : diff > 0 ? ' (more came in)' : ''}`.__html
      : 'Tick the credit(s) on the left and the bill(s) they pay on the right.';
    const ready = c.length > 0 && b.length > 0;
    diffBox.hidden = !(ready && diff !== 0);
    const treat = document.getElementById('pairtreat');
    const onBills = treat.value === 'bills';
    treat.options[0].textContent = diff < 0 ? 'Change the bills: discount' : 'Change the bills: tip';
    headSel.hidden = onBills;
    if (ready && diff !== 0) {
      const type = diff < 0 ? 'expense' : 'income';
      const keep = headSel.value;
      headSel.innerHTML = `<option value="">Head for the difference</option>${heads.filter((h) => h.type === type).map((h) => `<option value="${h.id}" ${h.id === keep ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}`;
    }
    go.disabled = !ready;
    go.textContent = ready && diff !== 0 ? (onBills ? `Match and ${diff < 0 ? 'add the discount' : 'add the tip'}` : 'Match and book the difference') : 'Match';
  };
  document.getElementById('pairtreat').addEventListener('change', () => refresh());
  box.querySelectorAll('[data-pcr]').forEach((x) => x.addEventListener('change', refresh));
  // Bills paid together are paid by one amount: ticking one ticks the whole group.
  box.querySelectorAll('[data-pbl]').forEach((x) => x.addEventListener('change', refresh));
  box.querySelectorAll('[data-repay]').forEach((sel) => sel.addEventListener('change', async () => {
    const mode = sel.value;
    if (!mode) return;
    const note = (prompt(`This bill was paid by ${mode} (the register said UPI). Reason?${mode === 'cash' ? ' The shift\'s cash check will count it as cash.' : ' It will wait for the card settlement.'}`) ?? '').trim();
    if (!note) { sel.value = ''; return; }
    try {
      const r = await apiFull('POST', `/businesses/${biz.id}/sales/repay`, { transactionIds: sel.dataset.repay.split(','), mode, note });
      await reload();
      document.getElementById('pairmsg')?.insertAdjacentHTML('afterbegin', html`<div class="ok-msg">Bill ${r.bills.join(' + ')} (₹ ${money(r.amountPaise)}) is now ${mode}. ${mode === 'cash' ? 'It counts in the cash check for this shift.' : 'It waits for the card settlement.'}</div>`.__html);
    } catch (err) { sel.value = ''; showError(document.getElementById('pairmsg'), err); }
  }));
  document.querySelectorAll('[data-repayundo]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Put this bill back to UPI as the register had it?')) return;
    try { await apiFull('POST', `/businesses/${biz.id}/sales/repay/${b.dataset.repayundo}/undo`, {}); await reload(); }
    catch (err) { showError(document.getElementById('pairmsg'), err); }
  }));
  go.addEventListener('click', async () => {
    const c = crs(); const b = bls();
    const diff = sum(c) - sum(b);
    const body = { rowIds: c.map((x) => x.dataset.pcr), transactionIds: b.flatMap((x) => x.dataset.pbl.split(',')) };
    try {
      let r;
      if (diff !== 0) {
        const note = document.getElementById('pairnote').value.trim();
        const treat = document.getElementById('pairtreat').value;
        if (!note || (treat === 'head' && !headSel.value)) throw new Error(treat === 'head' ? 'Choose a head for the difference and write the reason.' : 'Write the reason, e.g. register typo.');
        Object.assign(body, treat === 'head' ? { headId: headSel.value, note } : { treat: 'bills', note });
        if (treat === 'bills' && !confirm(`The register and sales for these bills will be changed to what the bank received (${diff < 0 ? 'a discount' : 'a tip'} of ₹ ${money(Math.abs(diff))}). Unmatch puts them back. Go ahead?`)) return;
      }
      r = await apiFull('POST', `/businesses/${biz.id}/bank-rows/match-set`, body);
      await reload();
      document.getElementById('pairmsg')?.insertAdjacentHTML('afterbegin', html`<div class="ok-msg">Matched${r.changed?.length ? `. Bills changed to what the bank received: ${r.changed.map((x) => `${x.billNo} ₹ ${money(x.beforePaise)} → ₹ ${money(x.afterPaise)}`).join(', ')}` : diff ? `, with a difference of ₹ ${money(Math.abs(diff))} booked` : ''}.</div>`.__html);
    } catch (err) { showError(document.getElementById('pairmsg'), err); }
  });
  refresh();
}

const addDaysIso = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// ---------- Bring in: everything a shift needs, in the morning, on one screen (approved 3 Nov 2026)

const currentShiftDay = () => new Date(Date.now() + IST_MS - 8 * 3600e3).toISOString().slice(0, 10);

/** Owner: re-reads checked register pages and shows how often each field was right, first reading vs now. */
async function checkAccuracy(biz, btn) {
  const out = document.getElementById('accout');
  const n = Math.min(15, Math.max(1, Number(document.getElementById('accn').value) || 10));
  btn.disabled = true;
  try {
    const { pages } = await api('GET', `/businesses/${biz.id}/ocr/accuracy-pages`);
    const pick = pages.slice(0, n);
    if (!pick.length) { out.innerHTML = html`<p class="note">No register page has all its rows checked yet.</p>`.__html; return; }
    const results = [], errors = [];
    let next = 0;
    const show = () => { out.innerHTML = html`<p class="note"><span class="spinner"></span> Reading ${results.length + errors.length} of ${pick.length} pages…</p>`.__html; };
    show();
    const worker = async () => {
      while (next < pick.length) {
        const p = pick[next++];
        try { results.push(await api('POST', `/businesses/${biz.id}/ocr/accuracy/${p.id}`, {})); } catch (err) { errors.push(`${p.day}: ${err.message}`); }
        show();
      }
    };
    await Promise.all([worker(), worker()]);
    const fields = [['bill_no', 'Bill number'], ['amount', 'Amount'], ['bill_type', 'Type'], ['payments', 'Payments']];
    const sum = (k, f) => results.reduce((t, r) => { const x = r[k][f]; return { right: t.right + x.right, red: t.red + x.wrongRed, amber: t.amber + x.wrongAmber, silent: t.silent + x.wrongUnmarked }; }, { right: 0, red: 0, amber: 0, silent: 0 });
    const pct = (x) => { const all = x.right + x.red + x.amber + x.silent; return all ? `${Math.round((100 * x.right) / all)}%` : '–'; };
    const rows = results.reduce((t, r) => t + r.rows, 0);
    out.innerHTML = html`<p class="note">${results.length} page${results.length === 1 ? '' : 's'}, ${rows} checked rows.${results.some((r) => r.missing) ? ` ${results.reduce((t, r) => t + r.missing, 0)} rows had no line at the same place in the new reading.` : ''}${results.some((r) => r.bankChanged) ? ` ${results.reduce((t, r) => t + (r.bankChanged ?? 0), 0)} rows changed on Reconcile are left out of Amount and Payments.` : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Field</th><th>Right, first reading</th><th>Right, now</th><th title="Wrong and not marked red or amber: the ones a person could miss">Wrong unmarked, first → now</th><th>Wrong but marked, first → now</th></tr></thead>
      <tbody>${fields.map(([f, label]) => { const b = sum('before', f), a = sum('after', f); return html`<tr><td>${label}</td><td>${pct(b)}</td><td><strong>${pct(a)}</strong></td><td>${b.silent} → <strong>${a.silent}</strong></td><td>${b.red + b.amber} → ${a.red + a.amber}</td></tr>`; })}</tbody></table></div>
      ${errors.length ? html`<p class="error">${errors.join(' · ')}</p>` : ''}`.__html;
  } catch (err) { showError(out, err); } finally { btn.disabled = false; }
}

// The shift last open on Bring in, per business, so coming back shows the same day.
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const lastBringInDay = (bizId) => { try { const d = localStorage.getItem(`bookr.bringin.${bizId}`); return isDay(d) ? d : null; } catch { return null; } };
const rememberBringInDay = (bizId, day) => { try { localStorage.setItem(`bookr.bringin.${bizId}`, day); } catch { /* private window: nothing remembered */ } };

async function bringInView(biz, dayArg) {
  const day = isDay(dayArg) ? dayArg : lastBringInDay(biz.id) ?? addDaysIso(currentShiftDay(), -1);
  rememberBringInDay(biz.id, day);
  rememberDay(biz.id, day);
  const v = await api('GET', `/businesses/${biz.id}/shifts/${day}/inputs`);
  const pagesOf = (k) => v.pages.filter((p) => p.kind === k);
  const regs = pagesOf('bill_register');
  const softwareOk = v.software.reports > 0 && !v.software.gaps.length;
  const bankOk = !v.bank || v.bank.covered;
  // A page is saved as 'ready' when it arrives, so 'not read' is told by no reading and nothing typed in (18 Nov 2026).
  const notRead = (p) => p.status === 'failed' || p.status === 'uploaded' || (p.status === 'ready' && !p.ocrEngine && !(p.kind === 'cash_summary' ? p.reviewed : p.rows));
  const pagesOk = regs.length > 0 && regs.every((p) => ['ready', 'approved'].includes(p.status) && !notRead(p)) && pagesOf('cash_summary').length > 0;
  const allOk = softwareOk && bankOk && pagesOk;
  const nowStep = !softwareOk ? 'sales' : !bankOk ? 'bank' : !pagesOk ? 'pages' : 'ready';
  const steps = [['sales', 'Sales report', softwareOk, v.software.reports > 0], ...(v.bank ? [['bank', 'Bank', bankOk, false]] : []), ['pages', 'Pages', pagesOk, regs.length > 0], ['ready', 'Ready', allOk, false]];
  const stepper = html`<div class="stepper">${steps.map(([k, l, ok, warn], i) => html`${i ? html`<span class="bar ${steps[i - 1][2] ? 'done' : ''}"></span>` : ''}
    <span class="st ${ok ? 'done' : k === nowStep ? 'now' : warn ? 'warn' : ''}" data-goto="${k}"><span class="dot">${ok ? '✓' : i + 1}</span>${l}</span>`)}</div>`;
  const head = (icon, ok, warn, title, sub, extra = '') => html`<div class="step-head"><span class="icon ${ok ? 'ok' : warn ? 'warn' : ''}">${ok ? '✓' : icon}</span>
    <span class="t"><strong>${title}</strong><span>${sub}</span></span>${extra}</div>`;
  const drop = (id, icon, title, sub, accept, small = false) => html`<label class="drop ${small ? 'small' : ''}" data-drop="${id}">
    <span class="big">${icon}</span><strong>${title}</strong><span class="tiny">${sub}</span>
    <input type="file" data-dropinput="${id}" accept="${accept}" multiple hidden></label>`;
  const what = (p) => p.kind === 'cash_summary' ? 'Figures read' : `${p.rows ?? 0} ${p.kind === 'expense_list' ? 'line' : 'row'}${p.rows === 1 ? '' : 's'}`;
  const pageState = (p, n) => p.status === 'reading' ? html`<span class="spinner"></span><span class="nm">Page ${n} · reading…</span>`
    : notRead(p) && p.queued ? html`<span class="greydot"></span><span class="nm">Page ${n} · waiting to be read${p.status === 'failed' ? ' (trying again)' : ''}</span><button class="linkbtn" type="button" data-readnow="${p.id}" data-kind="${p.kind}">Read now</button>`
    : notRead(p) ? html`<span class="greydot" style="${p.status === 'failed' ? 'background:#F59E0B' : ''}"></span><span class="nm">Page ${n} · ${p.status === 'failed' ? 'reading failed' : 'not read yet'}</span><button class="linkbtn" type="button" data-readnow="${p.id}" data-kind="${p.kind}">Read now</button>`
    : ['ready', 'approved'].includes(p.status) ? html`<span class="okdot" style="${p.unclear ? 'background:#F59E0B' : ''}"></span><span class="nm">Page ${n} · ${what(p)}</span>`
    : p.status === 'reading' ? html`<span class="spinner"></span><span class="nm">Page ${n} · reading…</span>`
    : p.status === 'retake' ? html`<span class="greydot" style="background:#F59E0B"></span><span class="nm">Page ${n} · photo unclear: retake</span>`
    : html`<span class="greydot"></span><span class="nm">Page ${n} · not read yet</span><button class="linkbtn" type="button" data-readnow="${p.id}" data-kind="${p.kind}">Read now</button>`;
  // Where the page stands on Review: what is left to tick, or ticked off. Either way it opens the page.
  const reviewLink = (p) => {
    const href = `#/b/${biz.id}/review/${p.id}`;
    if (!['ready', 'approved'].includes(p.status)) return html`<a href="${href}" class="rvw">Open</a>`;
    const total = (p.reviewed ?? 0) + (p.unclear ?? 0);
    // A ring that fills as rows are ticked; full and green with a tick when nothing is left.
    const ring = (frac, done) => html`<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="track" cx="10" cy="10" r="8"/>
      <circle class="fill" cx="10" cy="10" r="8" pathLength="100" stroke-dasharray="${Math.round(frac * 100)} 100" transform="rotate(-90 10 10)"/>
      ${done ? html`<path class="tick" d="M6 10.5l2.6 2.6L14 7.6"/>` : ''}</svg>`;
    if (p.unclear) return html`<a href="${href}" class="rvw todo" title="${p.reviewed ?? 0} of ${total} reviewed. Open the page and tick the rest">${ring(total ? (p.reviewed ?? 0) / total : 0, false)}${p.unclear} left</a>`;
    return html`<a href="${href}" class="rvw done" title="Every row is checked. Open the page">${ring(1, true)}Reviewed</a>`;
  };
  const canDel = (p) => v.shiftStatus !== 'confirmed' && canDeleteUpload(biz, p);
  const delBtn = (p) => canDel(p) ? html`<button type="button" class="iconbtn" data-delpage="${p.id}" data-reviewed="${p.reviewed}" title="Delete this page" aria-label="Delete this page">🗑</button>` : '';
  const tile = (kind, icon, title, hint) => {
    const ps = pagesOf(kind);
    return html`<div class="tile" data-tile="${kind}"><div class="th"><span style="font-size:20px">${icon}</span><strong>${title}</strong>
      ${ps.length ? html`<span class="chip ${ps.every((p) => ['ready', 'approved'].includes(p.status) && !p.unclear) ? 'ok' : 'wait'}" title="${ps.filter((p) => !p.unclear && ['ready', 'approved'].includes(p.status)).length} of ${ps.length} reviewed">${ps.filter((p) => !p.unclear && ['ready', 'approved'].includes(p.status)).length}/${ps.length}</span>` : ''}</div>
      ${ps.map((p, i) => html`<div class="fileline">${pageState(p, i + 1)}${reviewLink(p)}${delBtn(p)}</div>`)}
      <div data-tilelist="${kind}"></div>
      ${drop(kind, '📷', ps.length ? 'Add more' : 'Drop photos here', hint, 'image/jpeg,image/png,application/pdf', true)}</div>`;
  };
  // Step 1 of the shift (approved 14 Nov 2026): the same shift bar and day as Register and Reconcile.
  render(shell(biz, 'bringin', 'Bring in', '', html`
    ${shiftBar(biz, day, 'bringin')}
    <div class="note">${dayLabel(day)} 8 am → ${dayLabel(addDaysIso(day, 1))} 8 am${v.shiftStatus === 'confirmed' ? html` · <span class="chip ok">Saved</span>` : ''}</div>
    ${stepper}
    <div id="bmsg"></div>

    <section class="card step-card" id="step-sales">
      ${head('📄', softwareOk, v.software.reports > 0, 'Software sales report',
        v.software.reports ? `${v.software.bills} bills${v.software.gaps.length ? ' · some hours of the shift not covered yet' : ' · the whole shift is covered'}` : 'The CSV from the hotel software')}
      ${(v.software.files ?? []).map((f) => html`<div class="fileline"><span class="nm">${when(f.coversFrom)} → ${when(f.coversTo)} · ${f.billCount} bill${f.billCount === 1 ? '' : 's'}${f.days.length > 1 ? html` <span class="tiny">· shifts ${f.days.map(dayLabel).join(', ')}</span>` : ''}</span>
        ${v.shiftStatus !== 'confirmed' && !f.replaces && canDeleteUpload(biz, { uploadedBy: f.uploadedBy }) ? html`<button type="button" class="iconbtn" data-delreport="${f.uploadId}" data-bills="${f.billCount}" data-days="${f.days.map(dayLabel).join(', ')}" title="Delete this report file" aria-label="Delete this report file">🗑</button>` : ''}</div>`)}
      <div data-csvbox></div>
      ${softwareOk ? html`<div><button class="linkbtn" type="button" data-reveal="csv">+ Add another file</button></div><div data-revealed="csv" hidden>${drop('csv', '📄', 'Drop the CSV here', 'or tap to choose · up to 10 files', '.csv,text/csv')}</div>`
        : drop('csv', '📄', 'Drop the CSV here', 'or tap to choose · up to 10 files', '.csv,text/csv')}
    </section>

    ${v.bank ? html`<section class="card step-card" id="step-bank">
      ${head('🏦', bankOk, false, 'Bank statements', bankOk ? 'In up to the end of the shift (8 am)' : 'Sync once the statements are in the Google Sheets')}
      <div style="display:flex;flex-direction:column;gap:2px">${v.bank.accounts.map((a) => html`<div class="fileline">
        <span class="${a.lastAt && a.lastAt >= v.bank.shiftEnd - 30 * 60000 ? 'okdot' : 'greydot'}"></span><span class="nm">${a.name}${a.label ? html` <span class="tiny">· ${a.label}</span>` : ''}</span>
        <span class="tiny">${a.lastAt ? `up to ${when(a.lastAt)}` : 'nothing yet'}${a.sheet ? '' : ' · pasted'}</span></div>`)}
        ${v.bank.cards ? html`<div class="fileline"><span class="${v.bank.cards.covered ? 'okdot' : 'greydot'}"></span><span class="nm"><a href="#/b/${biz.id}/cards">Card reports</a> <span class="tiny">· ${v.bank.cards.folder ? 'Drive folder' : 'no folder yet'}</span></span>
          <span class="tiny">${v.bank.cards.lastAt ? `up to ${when(v.bank.cards.lastAt)}` : 'nothing yet'}</span></div>` : ''}</div>
      <div class="form-row" style="align-items:center"><button class="btn" type="button" id="syncall">Sync bank and card</button>
        <span class="tiny">Pasted accounts: <a href="#/b/${biz.id}/bank?tab=statements">Bank › Statements</a></span></div>
      <div id="syncbox"></div>
    </section>` : ''}

    <section class="card step-card" id="step-pages">
      ${head('📷', pagesOk, regs.length > 0, 'Pages', 'Drop each photo on its tile. Claude starts reading at once; you tick the rows on Review.')}
      <div class="tiles">${tile('bill_register', '🧾', 'Bill register', 'Register pages')}${tile('expense_list', '🛒', 'Expense list', 'Cash expenses')}${tile('cash_summary', '💰', 'Cash summary', "The day's cash page")}</div>
    </section>

    <section class="card step-card" id="step-ready" style="${allOk ? 'border-color:#86EFAC;background:#F0FDF4' : ''}">
      ${head('✨', allOk, false, allOk ? 'Everything is in' : 'Then', allOk ? '' : `Still to come: ${[!softwareOk && 'software report', v.bank && !bankOk && 'bank up to 8 am', !pagesOk && (regs.length ? 'pages read and a cash summary' : 'register pages')].filter(Boolean).join(' · ')}`)}
      <div class="form-row">${biz.actions.includes('rows.edit') ? html`<a class="btn ${allOk ? '' : 'plain'}" style="display:inline-flex;align-items:center" href="${screenHref(biz, 'review', day)}">Next: Register ›</a>` : ''}
        ${biz.actions.includes('sales.view') ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="${screenHref(biz, 'reconcile', day)}">Reconcile ›</a>` : ''}</div>
    </section>
    ${biz.role === 'owner' ? html`<details class="card" style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">Check reading accuracy</summary>
      <p class="note">Reads register pages whose rows have all been checked again, the way pages are read now, and compares the first reading and the new one with what was ticked.
        Nothing on the pages changes. Each page uses one of today's reads.</p>
      <div class="form-row" style="align-items:center"><label class="tiny">Pages <input id="accn" type="number" min="1" max="15" value="10" class="compact" style="width:70px"></label>
        <button class="btn" type="button" id="accgo">Check</button></div>
      <div id="accout"></div></details>` : ''}`));
  wireShell();
  const reload = () => bringInView(biz, day);
  document.getElementById('accgo')?.addEventListener('click', (e) => checkAccuracy(biz, e.currentTarget));
  app.querySelectorAll('[data-delreport]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete this software report file? Its ${b.dataset.bills} bills are removed from shift ${b.dataset.days}, and their comparisons are worked out again. This cannot be undone; you can bring the file in again.`)) return;
    b.disabled = true;
    try { await api('DELETE', `/businesses/${biz.id}/uploads/${b.dataset.delreport}`, {}); reload(); }
    catch (err) { b.disabled = false; showError(msg, err); msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }));
  app.querySelectorAll('[data-delpage]').forEach((b) => b.addEventListener('click', async () => {
    const n = Number(b.dataset.reviewed);
    if (!confirm(n ? `Delete this page? ${n} row${n === 1 ? ' you have' : 's you have'} already checked on it will be removed too. This cannot be undone.` : 'Delete this page and its draft rows? This cannot be undone.')) return;
    b.disabled = true;
    try { await api('DELETE', `/businesses/${biz.id}/uploads/${b.dataset.delpage}`, {}); reload(); }
    catch (err) { b.disabled = false; showError(msg, err); msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }));
  const msg = document.getElementById('bmsg');
  wireShiftBar(biz);
  app.querySelectorAll('[data-goto]').forEach((s) => s.addEventListener('click', () => document.getElementById(`step-${s.dataset.goto}`)?.scrollIntoView({ behavior: 'smooth' })));
  app.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => { app.querySelector(`[data-revealed="${b.dataset.reveal}"]`).hidden = false; b.remove(); }));
  // Drop zones: tap or drop.
  const onFiles = {};
  app.querySelectorAll('[data-drop]').forEach((z) => {
    const id = z.dataset.drop;
    const input = z.querySelector('input');
    input.addEventListener('change', () => { if (input.files.length) onFiles[id]?.([...input.files]); input.value = ''; });
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); const f = [...e.dataTransfer.files]; if (f.length) onFiles[id]?.(f); });
  });

  // 1. CSV: a short card per file; covered period set to whole days (change if the report was cut short).
  const csvBox = app.querySelector('[data-csvbox]');
  onFiles.csv = async (files) => {
    // While files wait to be imported, the drop area steps aside; Cancel on a card brings it back.
    const zone = app.querySelector('[data-drop="csv"]');
    zone.hidden = true;
    const showZone = () => { if (!csvBox.querySelector('[data-imp]')) zone.hidden = false; };
    if (files.length > 1) return csvBatch(biz, files.slice(0, MAX_FILES), csvBox, reload, showZone);
    for (const f of files.slice(0, MAX_FILES)) {
      const card = document.createElement('div');
      card.className = 'inset';
      card.innerHTML = html`<div class="fileline"><span class="spinner"></span><span class="nm">${f.name}</span><span class="tiny">Checking…</span></div>`.__html;
      csvBox.appendChild(card);
      await csvCard(biz, day, await f.text(), f.name, card, reload, () => { card.remove(); showZone(); });
    }
    showZone();
  };

  // 2. Bank
  document.getElementById('syncall')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.innerHTML = '<span class="spinner"></span>Syncing…';
    try { const r = await apiFull('POST', `/businesses/${biz.id}/bank/sync-all`, {}); await reload(); document.getElementById('bmsg').innerHTML = syncResultHtml(r).__html; }
    catch (err) { b.disabled = false; b.textContent = 'Sync bank and card'; showError(document.getElementById('syncbox'), err); }
  });

  // 3. Pages: each tile uploads its own kind; a line per file with a spinner while uploading and reading.
  for (const kind of ['bill_register', 'expense_list', 'cash_summary']) {
    onFiles[kind] = async (files) => {
      const list = app.querySelector(`[data-tilelist="${kind}"]`);
      const items = files.slice(0, MAX_FILES).map((f) => {
        const el = document.createElement('div');
        el.className = 'fileline';
        list.appendChild(el);
        const item = { file: f, id: null, kind, set: (state, error) => {
          const busy = /…$/.test(state) && !error;
          el.innerHTML = html`${busy ? html`<span class="spinner"></span>` : error ? html`<span class="greydot" style="background:#F59E0B"></span>` : html`<span class="okdot"></span>`}
            <span class="nm">${f.name}</span><span class="tiny ${error ? 'error' : ''}">${error ?? state}</span>`.__html;
        } };
        item.set('Uploading…');
        return item;
      });
      for (const x of items) {
        try { x.id = (await apiUpload(`/businesses/${biz.id}/uploads?kind=${kind}&day=${day}`, x.file)).id; x.set('Waiting to read…'); }
        catch (err) { x.set('', err.message); }
      }
      await readPages(biz, items.filter((x) => x.id));
      await reload();
    };
  }
  app.querySelectorAll('[data-readnow]').forEach((b) => b.addEventListener('click', async () => {
    b.outerHTML = '<span class="spinner"></span>';
    await readPages(biz, [{ id: b.dataset.readnow, kind: b.dataset.kind, set: (state, error) => { if (error) showError(msg, new Error(error)); } }]);
    reload();
  }));
}

/**
 * Several daily CSVs dropped together (15 Nov 2026): each is checked, then shown as one line under the shift its bills
 * fall in, and one button imports every file that is ready. A file already in Bookr, or for a saved shift, is left out
 * and says why. The bills are filed by their own times, as with one file.
 */
async function csvBatch(biz, files, box, reload, showZone) {
  const card = document.createElement('div');
  card.className = 'inset';
  card.innerHTML = html`<div class="fileline"><span class="spinner"></span><span class="nm">Checking ${files.length} files…</span></div>`.__html;
  box.appendChild(card);
  const rows = await Promise.all(files.map(async (f) => {
    const csv = await f.text();
    try {
      const p = await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day: currentShiftDay(), csv, dryRun: true });
      const days = p.shifts ?? [];
      const why = p.namesOnly ? 'Already in Bookr. Drop it alone to add names.' : p.confirmedShifts?.length ? `Shift ${p.confirmedShifts.map(dayLabel).join(', ')} is saved. An Owner must reopen it first.`
        : !p.add ? 'Already in Bookr' : null;
      return { f, csv, p, days, why, sort: days[0] ?? '9999' };
    } catch (err) { return { f, csv, p: null, days: [], why: [err.message, ...(err.problems ?? [])].join(' '), sort: '9999' }; }
  }));
  rows.sort((a, b) => a.sort.localeCompare(b.sort) || a.f.name.localeCompare(b.f.name));
  const ready = rows.filter((r) => !r.why);
  const shiftOf = (r) => (!r.days.length ? r.f.name : r.days.length === 1 ? `${dayLabel(r.days[0])} shift` : `${dayLabel(r.days[0])} – ${dayLabel(r.days[r.days.length - 1])}`);
  card.innerHTML = html`<div style="display:flex;flex-direction:column;gap:8px">
    <div class="fileline" style="font-size:14px"><span>📄</span><span class="nm"><strong>${files.length} files read</strong> <span class="tiny">each filed by its bill times</span></span></div>
    <div>${rows.map((r) => html`<div class="list-row" style="padding:6px 0"><span>${shiftOf(r)} <span class="tiny">${r.days.length ? r.f.name : ''}</span></span>
      ${r.why ? html`<span class="tiny" style="color:var(--wait)">${r.why}</span>`
        : html`<span class="tiny">${r.p.add} new bill${r.p.add === 1 ? '' : 's'}${r.p.flag ? ` · ${r.p.flag} differ: you will decide` : ''} <span class="chip ok" title="The bills add up to the totals at the bottom of the file">✓</span></span>`}</div>`)}</div>
    <div class="form-msg"></div>
    <div class="form-row" style="align-items:center">${ready.length ? html`<button class="btn" type="button" data-all>Import ${ready.length} file${ready.length === 1 ? '' : 's'}</button>` : ''}
      <button class="linkbtn" type="button" data-cancel>${ready.length ? 'Cancel' : 'Close'}</button></div></div>`.__html;
  card.querySelector('[data-cancel]').addEventListener('click', () => { card.remove(); showZone(); });
  card.querySelector('[data-all]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Importing…';
    // One after another: two files can hold the same bill, and the second must see the first.
    const failed = [];
    let bills = 0;
    for (const r of ready) {
      const d = r.days[0];
      try {
        await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day: d, csv: r.csv, coversFrom: fromLocalInput(`${toLocalInput(r.p.firstPaidAt).slice(0, 10)}T00:00:00`), coversTo: fromLocalInput(`${toLocalInput(r.p.lastPaidAt).slice(0, 10)}T23:59:59`) });
        bills += r.p.add;
      } catch (err) { failed.push(`${r.f.name}: ${err.message}`); }
    }
    await reload();
    const m = document.getElementById('bmsg');
    if (m) m.innerHTML = html`<div class="${failed.length ? 'error' : 'ok-msg'}">Imported ${bills} bill${bills === 1 ? '' : 's'} from ${ready.length - failed.length} file${ready.length - failed.length === 1 ? '' : 's'}.${failed.length ? ` Not imported: ${failed.join(' ')}` : ''}</div>`.__html;
  });
}

/** A short check of a software CSV before importing it: what matters at a glance, the rest one tap away. */
async function csvCard(biz, day, csv, name, card, done, cancel) {
  let p;
  try { p = await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv, dryRun: true }); }
  catch (err) { card.innerHTML = html`<div class="fileline"><span class="greydot" style="background:#F59E0B"></span><span class="nm">${name}</span></div><div class="form-msg"></div>`.__html; return showError(card.querySelector('.form-msg'), err); }
  // Already in Bookr, but imported before names were kept (12 Nov 2026): this file can add its bills' names.
  if (p.namesOnly) {
    card.innerHTML = html`<div style="display:flex;flex-direction:column;gap:8px"><div class="fileline" style="font-size:14px"><span>📄</span><span class="nm"><strong>Already imported</strong> <span class="tiny">${name}</span></span></div>
      <div class="tiny">${[p.names ? `${p.names} bill${p.names === 1 ? '' : 's'} in it ${p.names === 1 ? 'has' : 'have'} a guest or company name` : '', p.modes ? `${p.modes} bill${p.modes === 1 ? '' : 's'} ${p.modes === 1 ? 'has its' : 'have their'} mode as the software wrote it (e.g. PREPAID)` : ''].filter(Boolean).join(', and ')} that Bookr does not have yet (bills imported before these were kept). A PREPAID bill then counts as complimentary on an unsaved shift. Nothing else changes.</div>
      <div class="form-msg"></div><div class="form-row" style="align-items:center"><button class="btn" type="button" data-names>Add ${p.names && p.modes ? 'names and modes' : p.names ? `${p.names} name${p.names === 1 ? '' : 's'}` : `${p.modes} mode${p.modes === 1 ? '' : 's'}`}</button><button class="linkbtn" type="button" data-cancel>Cancel</button></div></div>`.__html;
    card.querySelector('[data-cancel]').addEventListener('click', () => cancel?.());
    card.querySelector('[data-names]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv });
        await done();
        document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">Added ${r.names} name${r.names === 1 ? '' : 's'} from ${name}.</div>`.__html;
      } catch (err) { e.target.disabled = false; showError(card.querySelector('.form-msg'), err); }
    });
    return;
  }
  const f = p.footer;
  const whole = { from: `${toLocalInput(p.firstPaidAt).slice(0, 10)}T00:00:00`, to: `${toLocalInput(p.lastPaidAt).slice(0, 10)}T23:59:59` };
  const span = whole.from.slice(0, 10) === whole.to.slice(0, 10) ? `${dayLabel(whole.from.slice(0, 10))}, whole day` : `${dayLabel(whole.from.slice(0, 10))} to ${dayLabel(whole.to.slice(0, 10))}, whole days`;
  card.innerHTML = html`<form data-imp style="display:flex;flex-direction:column;gap:10px">
    <div class="fileline" style="font-size:14px"><span>📄</span><span class="nm"><strong>${p.add} new bill${p.add === 1 ? '' : 's'}</strong> <span class="tiny">${name}</span></span>
      <span class="chip ok" title="The bills add up to the totals at the bottom of the file">✓ Totals match</span></div>
    <div class="pills"><span class="pill">UPI <b>₹ ${money(f.upiPaise)}</b></span><span class="pill">Card <b>₹ ${money(f.cardPaise)}</b></span><span class="pill">Cash <b>₹ ${money(f.cashPaise)}</b></span><span class="pill" style="background:var(--ok-bg)">Total <b>₹ ${money(f.totalPaise)}</b></span></div>
    <div class="tiny">${when(p.firstPaidAt)} → ${when(p.lastPaidAt)} · covers <strong data-span>${span}</strong> <button class="linkbtn tiny" type="button" data-change>change</button>
      ${p.skip || p.flag ? html`<br>${p.skip ? `${p.skip} already in Bookr (skipped)` : ''}${p.skip && p.flag ? ' · ' : ''}${p.flag ? `${p.flag} differ from before: you will decide` : ''}` : ''}</div>
    <div class="form-row" data-period hidden><div class="field"><label>Covers from</label><input data-cf type="datetime-local" step="1" value="${whole.from}" class="compact"></div>
      <div class="field"><label>Covers to</label><input data-ct type="datetime-local" step="1" value="${whole.to}" class="compact"></div>
      <span class="tiny" style="align-self:center">Use the first and last bill (${when(p.firstPaidAt)} → ${when(p.lastPaidAt)}) if the report was taken before the day ended.</span></div>
    ${p.confirmedShifts.length ? html`<div class="error">This would change a confirmed shift (${p.confirmedShifts.map(dayLabel).join(', ')}). An Owner must reopen it first.</div>` : ''}
    <div class="form-msg"></div>
    <div class="form-row" style="align-items:center"><button class="btn" type="submit" ${p.confirmedShifts.length || !p.add ? 'disabled' : ''}>${p.add ? `Import ${p.add} bill${p.add === 1 ? '' : 's'}` : 'Nothing new to import'}</button>
      <button class="linkbtn" type="button" data-cancel>Cancel</button></div></form>`.__html;
  card.querySelector('[data-cancel]').addEventListener('click', () => cancel?.());
  card.querySelector('[data-change]').addEventListener('click', (e) => { card.querySelector('[data-period]').hidden = false; e.target.remove(); });
  const form = card.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Importing…';
    try {
      await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv, coversFrom: fromLocalInput(form.querySelector('[data-cf]').value), coversTo: fromLocalInput(form.querySelector('[data-ct]').value) });
      await done();
      document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">Imported ${p.add} bill${p.add === 1 ? '' : 's'} from ${name}.</div>`.__html;
    } catch (err) { btn.disabled = false; btn.textContent = `Import ${p.add} bills`; showError(form.querySelector('.form-msg'), new Error([err.message, ...(err.problems ?? [])].join(' '))); }
  });
}

function syncResultHtml(r) {
  return html`<div class="inset" style="gap:4px">${r.results.length ? r.results.map((x) => html`<div class="list-row" style="padding:4px 0"><span>${x.name}</span>
    ${x.ok ? html`<span class="ok-msg" style="font-size:14px">✓ ${x.added} new line${x.added === 1 ? '' : 's'}${x.lastAt ? ` · up to ${when(x.lastAt)}` : ''}</span>` : html`<span class="error" style="font-size:14px">${x.error}</span>`}</div>`)
    : html`<div class="note">No account has a Google Sheet set up. Use Set up on Bank › Statements.</div>`}${cardSyncHtml(r.cards)}</div>`;
}
/** The card reports read from the Drive folder by the same Sync (nothing when no folder is set). */
/** What the Gmail script did on this Sync (empty when it is not set up). */
const scriptText = (x) => (!x ? '' : 'error' in x ? `${x.error} ` : `Gmail: ${x.saved ? `${x.saved} new report mail${x.saved === 1 ? '' : 's'} saved to Drive` : 'no new report mails'}. `);

function cardSyncHtml(k) {
  if (!k) return '';
  const biz = currentBizId();
  return html`<div class="list-row" style="padding:4px 0"><span><a href="#/b/${biz}/cards">Card reports</a> <span class="tiny">· Drive folder</span></span>
    ${k.ok ? html`<span class="${k.problems.length || k.script?.error ? 'error' : 'ok-msg'}" style="font-size:14px">${k.problems.length || k.script?.error ? '' : '✓ '}${scriptText(k.script)}${k.files ? `${k.files} new file${k.files === 1 ? '' : 's'}, ${k.added} payment${k.added === 1 ? '' : 's'}` : 'no new files'}${k.more ? ` (${k.more} more next Sync)` : ''}${k.problems.length ? ` · ${k.problems.join(' ')}` : ''}</span>`
      : html`<span class="error" style="font-size:14px">${k.error}</span>`}</div>`;
}

// ---------- The bill drawer: everything about one bill, from anywhere (approved 3 Nov 2026)

async function openBillDrawer(biz, billNo, day) {
  let d = document.getElementById('billdrawer');
  if (!d) {
    d = document.createElement('aside');
    d.id = 'billdrawer';
    d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:min(520px,100vw);background:var(--surface,#fff);box-shadow:-8px 0 30px rgba(0,0,0,.15);z-index:50;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:12px';
    document.body.appendChild(d);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('billdrawer')?.remove(); });
  }
  drawerReopen = () => openBillDrawer(biz, billNo, day);
  d.innerHTML = '<div class="note">Loading…</div>';
  let b;
  try { b = await api('GET', `/businesses/${biz.id}/bills/${encodeURIComponent(billNo)}${day ? `?day=${day}` : ''}`); }
  catch (err) { showError(d, err); return; }
  // Three boxes side by side, one row of actions, photo and history folded (approved 14 Nov 2026).
  const box = (title, body) => html`<div style="border:1px solid var(--line-soft);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;min-width:0"><span class="tiny note">${title}</span>${body}</div>`;
  const c0 = b.comparisons[0];
  const open = b.comparisons.find((c) => c.shift_status !== 'confirmed') ?? null;
  const decide = open && biz.actions?.includes('sales.decide');
  const sw = b.comparisons.filter((c) => c.sw_amount_paise != null);
  const paidFor = (x) => b.money.filter((m) => m.saleId === x.id);
  const bankBody = b.sales.length ? b.sales.map((x) => {
    const paid = paidFor(x);
    return html`<div>${paid.length ? paid.map((m) => html`<div><strong>₹ ${money(m.appliedPaise)}</strong> ${hhmm(m.postedAt)}<div class="tiny note">${m.accountName}${m.vpa ? ` · ${m.vpa}` : ''}</div></div>`)
      : html`<span class="note">${x.payment_mode === 'cash' ? 'Cash: in the cash count' : x.match_status === 'awaiting_card_settlement' ? 'Waiting for the card settlement' : x.match_status === 'awaiting_bank_match' ? 'Not found yet' : MODE_LABELS[x.payment_mode] ?? ''}</span>`}</div>`;
  }) : html`<span class="note">${c0?.shift_status === 'confirmed' ? 'Not a sale' : 'After Save'}</span>`;
  const both = open && open.difference !== 'match' && open.sw_amount_paise != null && b.register.length;
  const choice = (dd, label) => html`<button type="button" class="btn ${open.decision === dd ? 'ghost' : 'plain'} dchip" ${open.decision === dd ? 'disabled style="font-weight:600;background:#E3F1EF"' : ''} data-cashswitch="${open.id}" data-d="${dd}" data-was="${open.decision ?? ''}" data-bill="${b.billNo}" data-label="${label.toLowerCase()}">${open.decision === dd ? '✓ ' : ''}${label}</button>`;
  d.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 class="mono" style="margin:0">Bill ${b.billNo}</h2>
      <span style="display:flex;gap:6px;align-items:center">${b.comparisons.map((c) => html`<span class="chip ${c.difference === 'match' ? 'ok' : 'wait'}" title="${dayLabel(c.shift_day)} shift${c.decision ? ` · ${DECISION_LABELS[c.decision]}${c.note ? `: ${c.note}` : ''}` : ''}">${c.decision ? DECISION_LABELS[c.decision] : DIFF_LABELS[c.difference]}</span>`)}
      <button class="btn plain" type="button" id="drawerclose" aria-label="Close">✕</button></span></div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
      ${box('Software', sw.length ? sw.map((c) => html`<div><strong>₹ ${money(c.sw_amount_paise)}</strong> ${MODE_LABELS[c.sw_mode] ?? c.sw_mode}<div class="tiny note">${c.paid_at ? hhmm(c.paid_at) : ''}${b.comparisons.length > 1 ? ` · ${dayLabel(c.shift_day)}` : ''}</div></div>`) : html`<span class="note">Not there</span>`)}
      ${box('Register', b.register.length ? b.register.map((r) => html`<div><strong>₹ ${money(r.amount_paise)}</strong> ${r.payments.map((p) => p.label || MODE_LABELS[p.mode]).join(' + ') || 'not paid'}
        <div class="tiny note">${r.discount_paise ? `disc ₹ ${money(r.discount_paise)} · ` : ''}${r.tip_paise ? `tip ₹ ${money(r.tip_paise)} · ` : ''}line ${r.line_no}${r.paid_with_row_id ? ' · paid with another bill' : ''}${r.adjusted ? ' · adjusted from bank' : ''}</div></div>`) : html`<span class="note">Not there</span>`)}
      ${box('Bank', bankBody)}
    </div>
    <div class="form-row" style="gap:6px;align-items:center" data-dactions>
      ${both && decide ? html`${choice('use_software', 'Use software')}${choice('use_register', 'Use register')}` : ''}
      ${b.register.some((r) => r.upload_id) ? html`<button type="button" class="btn plain dchip" data-dgoedit>Edit line</button>` : ''}
      <details class="menu"><summary class="btn plain dchip" aria-label="More">⋯</summary><div class="menu-pop" style="min-width:210px;gap:6px">
        ${decide ? (open.difference === 'complimentary'
          ? html`<button type="button" class="btn plain dchip" data-makecomp="${open.id}" data-bill="${open.bill_no}">Guest name</button>${paidByChips({ comparisonId: open.id, billNo: open.bill_no })}`
          : html`<button type="button" class="btn plain dchip" data-makecomp="${open.id}" data-bill="${open.bill_no}">Make complimentary</button>`) : ''}
        ${c0 ? html`<a class="btn plain dchip" href="#/b/${biz.id}/compare/${c0.shift_day}">Open in All bills</a>` : ''}
        ${b.register.filter((r) => r.upload_id).slice(0, 1).map((r) => html`<a class="btn plain dchip" href="#/b/${biz.id}/review/${r.upload_id}/${r.id}">Open on its register page</a>`)}
        ${c0 && b.sales.some((x) => x.match_status === 'awaiting_bank_match') ? html`<a class="btn plain dchip" href="#/b/${biz.id}/reconcile/${c0.shift_day}">Match or fix on Reconcile</a>` : ''}
      </div></details>
    </div>
    <details><summary class="note">History (${b.history.length})</summary>${b.history.length ? b.history.map((h) => html`<div class="tiny">${when(h.at)} · ${h.user ?? 'Bookr'} · ${HISTORY_LABELS[h.action] ?? h.action}${historyWords(h)}</div>`) : html`<div class="note">Nothing yet.</div>`}</details>`.__html;
  d.querySelector('[data-dgoedit]')?.addEventListener('click', () => { const ed = d.querySelector('[data-deditor]'); ed?.scrollIntoView({ behavior: 'smooth', block: 'start' }); ed?.querySelector('input:not([disabled])')?.focus(); });
  document.getElementById('drawerclose').addEventListener('click', () => d.remove());
  // The register line, editable here with its photo, so a slip is corrected without leaving the page (7 Nov 2026).
  const lines = b.register.filter((r) => r.upload_id);
  for (const r of lines.slice(0, 2).reverse()) await drawerEditor(biz, d, r, billNo, day);
}
/** What the page under the drawer reloads after a change (set by Compare sales and Reconcile). */
let drawerReload = null;
/** Opens the drawer again on the same bill after a change made from inside it. */
let drawerReopen = null;
async function drawerEditor(biz, d, r0, billNo, day) {
  let u;
  try { u = await api('GET', `/businesses/${biz.id}/uploads/${r0.upload_id}`); } catch { return; } // no rows.edit: the drawer only shows
  const r = u.rows.find((x) => x.id === r0.id);
  if (!r || !d.isConnected) return;
  const locked = u.shiftStatus === 'confirmed';
  const member = !!r.paidWithRowId;
  const cols = PAY_COLS.map((_, i) => r.payments.filter((p) => colOf(p) === i));
  const field = (f, label, value, extra = '') => html`<label style="display:flex;flex-direction:column;gap:2px;font-size:12px">${label}
    <input class="cell mono" data-df="${f}" value="${value}" ${locked ? 'disabled' : ''} ${extra} style="min-height:34px"></label>`;
  const box = document.createElement('section');
  box.style.cssText = 'border-top:1px solid var(--line-soft);padding-top:10px;display:flex;flex-direction:column;gap:8px';
  box.dataset.deditor = '1';
  box.innerHTML = html`<strong>Register line · page ${u.pageNo ?? 1}, row ${r.lineNo}</strong>
    ${u.fromSoftware ? '' : html`<details data-dphoto><summary class="note">Photo</summary><div class="strip" style="height:110px"><canvas></canvas><span class="band"></span>
      <span class="strip-tools"><span class="tiny"></span><button type="button" class="iconbtn" title="Turn the photo" aria-label="Turn the photo">⟳</button></span></div></details>`}
    ${locked ? html`<div class="note">The shift is saved, so this line is locked. Corrections from the bank are made on Reconcile.</div>
      ${biz.actions.includes('shift.reopen') ? html`<div class="form-row" style="gap:6px"><button class="btn plain" type="button" data-dreopen>Reopen the shift to edit</button></div>` : html`<div class="note">Ask an Owner to reopen this shift to change it.</div>`}` : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px">
      ${field('billNo', 'Bill no.', r.billNo ?? '')}${field('amount', 'Amount', rsIn(r.amountPaise))}${field('discount', 'Discount (− tip)', rsIn(r.discountPaise))}
      ${member ? '' : PAY_COLS.map(([, label], i) => field(`pay${i}`, label, cols[i].map((p) => rsIn(p.amountPaise)).join(' + '), 'placeholder="0" title="1000 + 500 is two payments"'))}
    </div>
    ${member ? html`<div class="note">Paid with another bill's payment: change the payment on that bill.</div>` : ''}
    ${!locked && !member && drawerCash?.day === u.day ? html`<div class="tiny note" data-dcash></div>` : ''}
    ${locked ? '' : html`<div class="form-row" style="gap:6px"><button class="btn" type="button" data-dsave>Save the row</button>
      <a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/review/${u.id}/${r.id}">Open on Review</a>
      <span style="flex:1"></span><button class="btn plain danger" type="button" data-ddel>Delete row</button></div>`}
    <div class="form-msg"></div>`.__html;
  (d.querySelector('[data-dactions]') ?? d.children[0]).after(box);
  // The photo draws when it is first opened (a folded canvas has no size).
  const ph = box.querySelector('[data-dphoto]');
  if (ph) ph.addEventListener('toggle', () => { if (ph.open && !ph.dataset.drawn) { ph.dataset.drawn = '1'; wireStrip(u, `/api/businesses/${biz.id}/uploads/${u.id}/file`, box).show(r); } });
  // What this change does to the cash, before it is saved (14 Nov 2026): if the bill is counted from the register.
  const cashLine = box.querySelector('[data-dcash]');
  if (cashLine) {
    const was = cols[0].reduce((t, p) => t + p.amountPaise, 0);
    const show = () => {
      const now = (box.querySelector('[data-df="pay0"]')?.value ?? '').split('+').reduce((t, x) => t + (parsePaiseText(x.trim() || '0') ?? 0), 0);
      const k = drawerCash;
      const should = k.shouldBePaise == null ? null : k.shouldBePaise + now - was;
      const diff = should == null || k.countedPaise == null ? null : k.countedPaise - should;
      cashLine.innerHTML = html`Cash on this line ₹ ${money(was)}${now !== was ? html` → <strong>₹ ${money(now)}</strong>` : ''}.
        ${should != null ? html`If counted from the register: should be in hand ₹ ${money(should)}${diff != null ? html`, <strong style="color:${diff < 0 ? '#B42318' : diff > 0 ? '#8A5A00' : 'var(--teal-ink)'}">${diff === 0 ? 'cash agrees' : `${diff < 0 ? 'short' : 'over'} ₹ ${money(Math.abs(diff))}`}</strong>` : ''}.` : ''}`.__html;
    };
    box.querySelectorAll('[data-df]').forEach((el) => el.addEventListener('input', show));
    show();
  }
  box.querySelector('[data-dreopen]')?.addEventListener('click', async (e) => {
    const reason = (prompt(`Reopen the ${dayLabel(u.day)} shift to correct bill ${r.billNo}? Its sales come off until it is saved again. Why?`) ?? '').trim();
    if (!reason) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await apiFull('POST', `/businesses/${biz.id}/shifts/${u.day}/reopen`, { reason });
      await (drawerReload ?? route)();
      await openBillDrawer(biz, billNo, day);
    } catch (err) { btn.disabled = false; showError(box.querySelector('.form-msg'), err); }
  });
  // Delete the line from here too (18 Nov 2026), with its reason and one Undo, as on Review.
  box.querySelector('[data-ddel]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      const why = await askDeleteReason(r);
      if (!why) return;
      btn.disabled = true;
      const back = rowInputOf(r);
      await apiFull('DELETE', `/businesses/${biz.id}/register-rows/${r.id}`, why);
      await (drawerReload ?? route)();
      document.getElementById('billdrawer')?.remove();
      doneToast(`Bill ${r.billNo}: register line deleted (${deleteReasonLabel(why.reason)}).`,
        () => apiFull('POST', `/businesses/${biz.id}/uploads/${u.id}/register-rows`, back), async () => { await (drawerReload ?? route)(); });
    } catch (err) { btn.disabled = false; showError(box.querySelector('.form-msg'), err); }
  });
  const before = rowInputOf(r);
  const hasMembers = [...u.rows, ...(u.otherPageRows ?? [])].some((x) => x.paidWithRowId === r.id);
  box.querySelector('[data-dsave]')?.addEventListener('click', async (e) => {
    const v = (f) => box.querySelector(`[data-df="${f}"]`)?.value.trim() ?? '';
    const payments = member ? before.payments : PAY_COLS.flatMap(([mode, label], i) => v(`pay${i}`).split('+').map((x) => x.trim()).filter(Boolean)
      .map((amount) => ({ mode, columnLabel: cols[i][0]?.columnLabel ?? label, amount })));
    const after = { ...before, billNo: v('billNo'), amount: v('amount') || '0', discount: v('discount') || '0', payments };
    // The discount follows the amount and payments here too (17 Nov 2026), as on Review: amount − paid, negative for a
    // tip. Only for a bill paid on its own, and not when the discount itself was changed in the drawer.
    let discNote = '';
    if (!member && !hasMembers && sameRowField('discount', before.discount, after.discount)
      && (!sameRowField('amount', before.amount, after.amount) || !sameRowField('payments', before.payments, after.payments))) {
      const a = parsePaiseText(after.amount);
      const paid = payments.reduce((t, p) => t + (parsePaiseText(p.amount) ?? 0), 0);
      if (a !== null && paid > 0) {
        const want = a - paid;
        if (want !== (parsePaiseText(before.discount) ?? 0)) {
          after.discount = rupeesForInput(want);
          discNote = ` ${discWord(parsePaiseText(before.discount) ?? 0)} → ${discWord(want)} (amount less paid).`;
        }
      }
    }
    const put = (x) => apiFull('PUT', `/businesses/${biz.id}/register-rows/${r.id}`, x);
    const reload = async () => { await (drawerReload ?? route)(); };
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await put(rowEditBody(before, after));
      await reload();
      await openBillDrawer(biz, after.billNo || billNo, day);
      const notes = (res?.notes ?? []).map((n) => ` ${n.words}.`).join('');
      doneToast(`Bill ${after.billNo || billNo}: register row saved.${discNote}${notes}`, async () => { await put(rowEditBody(after, before)); }, async () => { await reload(); if (document.getElementById('billdrawer')) await openBillDrawer(biz, billNo, day); });
    } catch (err) { btn.disabled = false; showError(box.querySelector('.form-msg'), err); }
  });
}
const HISTORY_LABELS = {
  'comparison.decide': 'Decided', 'comparison.decision_cleared': 'Decision cleared (data changed)', 'register.added_from_software': 'Added to the register from the software report',
  'bank.match': 'Matched to a bank credit', 'bank.match_set': 'Matched by hand', 'bank.match_adjust_bills': 'Matched; register corrected to the bank amount', 'bank.fix_bill': 'Bill fixed from the bank',
  'bank.unmatch': 'Unmatched (changes put back)', 'sale.repaid': 'Changed to cash or card', 'sale.repay_undone': 'Put back to UPI', 'shift.confirm': 'Shift confirmed', 'shift.reopen': 'Shift reopened', 'transaction.remove_on_reopen': 'Sale taken off (shift reopened)',
  'transaction.approve': 'Approved', 'register.fill_discounts': 'Discounts filled in',
  'register.edit': 'Register line changed', 'cash.shortage_reduced': 'Cash shortage reduced (bill paid on a later day)', 'cash.shortage_restored': 'Cash shortage put back', 'register.paid_later': 'Paid later by card or UPI', 'register.paid_later_undone': 'Paid later undone', 'register.auto_discount': 'Group discount', 'register.split': 'Register line split', 'register.insert_below': 'Line added below',
};
const historyWords = (h) => { try { const c = JSON.parse(h.after ?? '{}').changes; return c ? `: ${c}` : ''; } catch { return ''; } };
// Complimentary (approved 14 Nov 2026), from any page: data-makecomp="comparisonId" asks the guest's name;
// data-paidby="comparisonId" with data-mode turns a complimentary or PREPAID bill into a Cash, UPI or Card sale. Both undo.
document.addEventListener('click', async (e) => {
  const mk = e.target.closest?.('[data-makecomp]');
  const pb = e.target.closest?.('[data-paidby]');
  const lo = e.target.closest?.('[data-leaveunk]');
  const sw = e.target.closest?.('[data-cashswitch]');
  const pl = e.target.closest?.('[data-paidlater2]');
  if (!mk && !pb && !lo && !sw && !pl) return;
  e.preventDefault(); e.stopPropagation();
  // One click at a time (17 Nov 2026): the button stays off until the change is saved, so it is never sent twice.
  const btn = mk ?? pb ?? lo ?? sw ?? pl;
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1'; btn.disabled = true;
  const bizId = currentBizId();
  const reload = async () => { await (drawerReload ?? route)(); if (document.getElementById('billdrawer') && drawerReopen) await drawerReopen(); };
  const where = document.getElementById('recmsg') ?? document.getElementById('rmsg') ?? document.getElementById('allmsg');
  try {
    if (pl) {
      const id = pl.dataset.paidlater2;
      await apiFull('POST', `/businesses/${bizId}/comparisons/${id}/paid-later`, {});
      await reload();
      doneToast(`Bill ${pl.dataset.bill}: paid later by ${pl.dataset.word}, counted as a ${pl.dataset.word} sale, not cash.`, async () => { await apiFull('POST', `/businesses/${bizId}/comparisons/${id}/paid-later/undo`, {}); }, reload);
    } else if (sw) {
      const id = sw.dataset.cashswitch;
      await apiFull('PUT', `/businesses/${bizId}/comparisons/${id}`, { decision: sw.dataset.d, ...(sw.dataset.note ? { note: sw.dataset.note } : {}) });
      await reload();
      doneToast(`Bill ${sw.dataset.bill}: ${sw.dataset.label}.`, async () => { await apiFull('PUT', `/businesses/${bizId}/comparisons/${id}`, { decision: sw.dataset.was || null }); }, reload);
    } else if (lo) {
      const why = (prompt(`Leave bill ${lo.dataset.bill} out of the sales? Say why (e.g. cancelled, test bill):`, '') ?? '').trim();
      if (!why) return;
      await apiFull('PUT', `/businesses/${bizId}/comparisons/${lo.dataset.leaveunk}`, { decision: 'leave_out', note: why });
      await reload();
      doneToast(`Bill ${lo.dataset.bill}: left out (${why}).`, async () => { await apiFull('PUT', `/businesses/${bizId}/comparisons/${lo.dataset.leaveunk}`, { decision: null }); }, reload);
    } else if (mk) {
      const guest = (prompt(`Make bill ${mk.dataset.bill} complimentary. Guest name:`, mk.dataset.name ?? '') ?? '').trim();
      if (!guest) return;
      await apiFull('POST', `/businesses/${bizId}/comparisons/${mk.dataset.makecomp}/complimentary`, { guestName: guest });
      await reload();
      doneToast(`Bill ${mk.dataset.bill}: complimentary, ${guest}. Not counted as a sale.`, mk.dataset.had ? null : async () => { await apiFull('DELETE', `/businesses/${bizId}/comparisons/${mk.dataset.makecomp}/complimentary`, {}); }, reload);
    } else {
      const word = { cash: 'Cash', upi: 'UPI', card: 'Card' }[pb.dataset.mode];
      await apiFull('POST', `/businesses/${bizId}/comparisons/${pb.dataset.paidby}/paid-by`, { mode: pb.dataset.mode });
      await reload();
      doneToast(`Bill ${pb.dataset.bill}: paid by ${word}, counted as a sale${pb.dataset.mode === 'cash' ? '' : ` and matched on the ${word} tab`}.`, async () => { await apiFull('POST', `/businesses/${bizId}/comparisons/${pb.dataset.paidby}/paid-by/undo`, {}); }, reload);
    }
  } catch (err) { if (where) showError(where, err); else alert(err.message); }
  finally { delete btn.dataset.busy; btn.disabled = false; }
}, true);
// Where a head came from, on a bank or cash expense line (approved 14 Nov 2026); hover says exactly.
const headFromChip = (sg, party) => (sg.from === 'party' || (!sg.from && sg.learned) ? html`<span class="chip wait" title="From party ${party ?? ''}: booked under this head before">Learned</span>`
  : sg.from === 'rule' ? html`<span class="chip wait" title="Rule: ${sg.ruleName ?? ''}">Rule</span>`
  : sg.from === 'item' ? html`<span class="chip wait" title="The same item was booked under this head before">From item</span>` : '');
// Paid by ▾: the three modes in a small menu, the hinted one first and marked (approved 14 Nov 2026).
const paidByMenu = (c, pick = null) => html`<details class="menu"><summary class="btn plain dchip">Paid by ▾</summary><div class="menu-pop" style="min-width:140px;gap:6px">${[...(pick ? [pick] : []), ...['cash', 'upi', 'card'].filter((m) => m !== pick)].map((m) => html`<button type="button" class="btn ${m === pick ? '' : 'plain'} dchip" data-paidby="${c.comparisonId}" data-bill="${c.billNo}" data-mode="${m}">${{ cash: 'Cash', upi: 'UPI', card: 'Card' }[m]}</button>`)}</div></details>`;
const paidByChips = (c, pick = null) => html`<span class="tiny note">Paid by</span>${['cash', 'upi', 'card'].map((m) => html`<button type="button" class="btn ${m === pick ? '' : 'plain'} dchip" data-paidby="${c.comparisonId}" data-bill="${c.billNo}" data-mode="${m}">${{ cash: 'Cash', upi: 'UPI', card: 'Card' }[m]}</button>`)}`;
// "Show n more" under Mode not known: shows the rest of the list.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-showunk]');
  if (!b) return;
  const table = b.closest('table');
  table?.querySelectorAll('tr[data-pgroup="unk"]').forEach((tr) => { tr.hidden = false; tr.classList.remove('grp-bill'); });
  b.closest('tr')?.remove();
});
// Any element with data-bill-drawer="billNo|day" opens the drawer.
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-bill-drawer]');
  if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const [no, day] = el.dataset.billDrawer.split('|');
  const id = currentBizId();
  const biz = { id, actions: me?.businesses?.find((x) => x.id === id)?.actions ?? [] };
  openBillDrawer(biz, no, day || null);
}, true);
const drawerBtn = (billNo, day) => html`<button type="button" class="btn plain" data-bill-drawer="${billNo}|${day ?? ''}" title="Everything about this bill" style="min-height:26px;padding:0 6px;font-size:12px;margin-left:4px">Details</button>`;

// ---------- router

// ---------- Card settlements: the card machine's daily report (by mail or dropped in), each payment to its bill,
// each settlement day's net amount to the bank's ICICIPOS_SET credit with the fee booked. A person confirms each step.

const CARD_MAIL_STATUS = { read: ['ok', 'Read'], failed: ['bad', 'Not read'], ignored: ['', 'Nothing to read'] };
const fileBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(new Error('The file could not be read.'));
  r.readAsDataURL(file);
});

// The card machine's reports as a source, on the Bank page's Statements tab: the Drive folder, a report dropped in, and
// the report mails received.
const cardMailNote = (m) => {
  const link = /https:\/\/\S+/.exec(m.note ?? '')?.[0];
  return link ? html`${m.note.replace(link, '').replace(/\s*Open\s*/, ' ')} <a href="${link}" target="_blank" rel="noopener">Confirm forwarding</a>` : m.note;
};

function cardSourceHtml(r) {
  const SMALL = 'min-height:34px;padding:0 12px;font-size:14px';
  return html`<label class="drop small" data-drop="cards"><span class="big">💳</span><strong>Drop the card company's report</strong>
      <span class="tiny">The ICICI POS Excel file (…_ICICI_POS_CD.xlsx), for a report not in the Drive folder.</span>
      <input type="file" accept=".xlsx" multiple hidden></label>
    <form id="cdfolder" class="form-row" style="align-items:flex-end">
      <div class="field" style="flex:2 1 300px"><label for="cdfold">Google Drive folder of the card reports</label>
        <input id="cdfold" name="folder" value="${r.driveFolder ? `https://drive.google.com/drive/folders/${r.driveFolder}` : ''}" placeholder="Paste the folder's link"></div>
      <button class="btn plain" type="submit">Save</button></form>
    <div class="tiny">${r.driveFolder ? 'Sync asks Gmail to save new report mails into the folder, then reads them.' : 'A script in Gmail saves each report there; Bookr reads new files whenever you Sync.'}${r.googleEmail ? html` Share the folder with <span class="mono">${r.googleEmail}</span> as Viewer.` : ' Google access is not set up yet.'}</div>
    ${r.mails.length ? html`<details><summary>Reports received (${r.mails.length})</summary>
      <table><tbody>${r.mails.map((m) => {
        const [cls, label] = CARD_MAIL_STATUS[m.status] ?? ['', m.status];
        return html`<tr><td style="white-space:nowrap">${when(m.receivedAt)}<div class="tiny">${m.from}</div></td>
          <td style="white-space:normal">${m.subject || html`<span class="note">No subject</span>`}<div class="tiny">${cardMailNote(m)}</div></td>
          <td style="white-space:nowrap;text-align:right"><span class="chip ${cls}">${label}</span>
            ${m.status !== 'ignored' ? html` <button class="btn plain" type="button" data-cread="${m.id}" style="${SMALL}">Read again</button>` : ''}</td></tr>`;
      })}</tbody></table></details>` : ''}`;
}

function wireCardSource(biz, reload, msg) {
  const act = async (btn, fn) => {
    btn.disabled = true;
    try { await fn(); } catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); btn.disabled = false; }
  };
  document.getElementById('cdfolder')?.addEventListener('submit', (e) => {
    e.preventDefault();
    act(e.target.querySelector('button[type=submit]'), async () => {
      await api('PUT', `/businesses/${biz.id}/cards/folder`, { folder: new FormData(e.target).get('folder') });
      await reload();
      doneToast('Folder saved.', null, reload);
    });
  });
  // The report file: tap or drop. Payments already in Bookr are not added twice.
  const zone = app.querySelector('[data-drop="cards"]');
  if (zone) {
    const input = zone.querySelector('input');
    const bringIn = async (files) => {
      msg.innerHTML = html`<div class="note"><span class="spinner"></span> Reading ${files.length} file${files.length === 1 ? '' : 's'}…</div>`.__html;
      const said = [];
      let ok = 0;
      for (const f of files) {
        try {
          const res = await api('POST', `/businesses/${biz.id}/cards/file`, { name: f.name, data: await fileBase64(f) });
          ok += 1;
          said.push(`${f.name}: ${res.added} new payment${res.added === 1 ? '' : 's'}${res.skipped ? `, ${res.skipped} already in Bookr` : ''}${res.problems.length ? `. ${res.problems.join(' ')}` : ''}`);
        } catch (err) { said.push(`${f.name}: ${err.message}`); }
      }
      if (ok) await reload();
      const box = document.getElementById('bmsg') ?? msg;
      box.innerHTML = html`<div class="${ok === files.length ? 'ok-msg' : 'error'}">${said.map((x) => html`<div>${x}</div>`)}</div>`.__html;
    };
    input.addEventListener('change', () => { if (input.files.length) bringIn([...input.files]); input.value = ''; });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const f = [...e.dataTransfer.files]; if (f.length) bringIn(f); });
  }
  app.querySelectorAll('[data-cread]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    const res = await api('POST', `/businesses/${biz.id}/inbound-mails/${b.dataset.cread}/read`);
    await reload();
    doneToast(res.note, null, reload);
  })));
}

async function cardsView(biz, query = '') {
  const q = new URLSearchParams(query);
  const to = isDay(q.get('to')) ? q.get('to') : todayIst();
  const from = isDay(q.get('from')) ? q.get('from') : addDaysIso(to, -13);
  const [r, b] = await Promise.all([api('GET', `/businesses/${biz.id}/cards?from=${from}&to=${to}`), api('GET', `/businesses/${biz.id}/bank`)]);
  const reload = () => cardsView(biz, query);
  const SMALL = 'min-height:34px;padding:0 12px;font-size:14px';
  // Matching is done on the shift's Reconcile (approved 10 Nov 2026): here the bill is told, with a link to it.
  const shiftLink = (d, text) => html`<a href="#/b/${biz.id}/reconcile/${d}" data-cardshift="${d}">${text}</a>`;
  const billCell = (p) => {
    if (p.matched) return html`<span class="chip ok">✓ Bill ${p.matched.bills.join(' + ')}</span>${p.matched.payments > 1 ? html` <span class="tiny">with ${p.matched.payments - 1} other payment${p.matched.payments > 2 ? 's' : ''}</span>` : ''}
      <div class="tiny">${(p.matched.shiftDays?.length ? p.matched.shiftDays : [p.shiftDay]).map((d) => shiftLink(d, `${dayLabel(d)} shift`))}</div>`;
    if (p.charge) return html`<span class="note">Card company charge: booked as a fee when this day is settled</span>`;
    if (p.txnType !== 'PURCHASE') return html`<span class="note">${p.txnType.toLowerCase()}: not a sale</span><div class="tiny">${shiftLink(p.shiftDay, `Check it on the ${dayLabel(p.shiftDay)} shift →`)}</div>`;
    return html`<span class="note">Not matched yet</span> · ${shiftLink(p.shiftDay, `Open the ${dayLabel(p.shiftDay)} shift →`)}`;
  };
  const ruleOf = (s) => { const k = s.terminals.map((t) => (r.rules ?? []).find((x) => x.terminalId === t)); return k.every(Boolean) ? k[0] : null; };
  const headName = (id) => r.feeHeads.find((h) => h.id === id)?.name ?? 'its head';
  const bankBlock = (s) => {
    if (s.bank) {
      return html`<div class="form-row" style="gap:8px;align-items:center"><span class="chip ok">In the bank</span>
        <span>₹ ${money(s.bank.amountPaise)} on ${dayLabel(s.bank.day)} ${hhmm(s.bank.postedAt)} · ${s.bank.accountName}${s.bank.feeHead ? ` · fee booked under ${s.bank.feeHead}` : ''}</span>
        <button class="btn plain" type="button" data-cunsettle="${s.bank.id}" style="${SMALL}">Undo</button></div>
        ${s.partlySettled ? html`<div class="error">Some payments of this day came in after it was settled. Undo and settle it again.</div>` : ''}`;
    }
    const tog = (r.together ?? []).findIndex((x) => x.merchantId === s.merchantId && x.days.includes(s.settledOn));
    if (!s.credits.length && tog >= 0) {
      const x = r.together[tog];
      return html`<div class="form-row" style="gap:8px;align-items:center"><span class="note">The card company paid ${x.days.map(dayLabel).join(' + ')} in one bank credit of <strong>₹ ${money(x.netPaise)}</strong>.</span>
        <button class="btn" type="button" data-ctogether="${tog}" style="${SMALL}">Settle these days together</button></div>`;
    }
    if (!s.credits.length) {
      return html`<div class="note">The bank's card credit of <strong>₹ ${money(s.netPaise)}</strong> (EZY/ICICIPOS_SET…) is not in Bookr yet.
        <a href="#/b/${biz.id}/bank?${new URLSearchParams({ from: addDaysIso(s.settledOn, -1), to: addDaysIso(s.settledOn, 3), tab: 'statements' })}">Sync or paste the statement on Bank › Statements</a>.</div>`;
    }
    const fee = s.feePaise + s.gstPaise;
    return html`<form class="form-row" data-csettle="${s.settledOn}|${s.merchantId}" style="gap:8px;align-items:flex-end">
      <div class="field" style="flex:2 1 260px"><label>Bank credit</label><select name="bankRowId" class="compact">${s.credits.map((c) => html`<option value="${c.id}">₹ ${money(c.amountPaise)} · ${dayLabel(c.day)} ${hhmm(c.postedAt)} · ${c.accountName}</option>`)}</select></div>
      ${fee && !ruleOf(s) ? html`<div class="note">Set the <a href="#/b/${biz.id}/heads">Card settlement rule on Heads and rules</a> first: it says where the fee and the GST are booked.</div>`
        : html`${fee ? html`<div class="note" style="flex:1 1 200px">Fee ₹ ${money(s.feePaise)} → ${headName(ruleOf(s).feeHeadId)}${s.gstPaise ? html`, GST ₹ ${money(s.gstPaise)} → ${headName(ruleOf(s).gstHeadId)}` : ''}</div>` : ''}
      <button class="btn" type="submit" style="${SMALL}">Settle with the bank</button>`}</form>`;
  };
  const dayCard = (s) => {
    const open = s.payments.filter((p) => !p.matched && p.txnType === 'PURCHASE');
    const matched = s.payments.length - open.length;
    return html`<section class="card" style="gap:10px" data-cday="${s.settledOn}|${s.merchantId}">
      <div class="form-row" style="justify-content:space-between;align-items:baseline">
        <h2>Settled ${dayLabel(s.settledOn)}</h2>
        <span class="chip ${s.bank && !open.length ? 'ok' : 'wait'}">${matched} of ${s.payments.length} matched to bills${s.bank ? ' · in the bank' : ''}</span></div>
      <div class="note">${s.payments.filter((p) => !p.charge).length} payment${s.payments.filter((p) => !p.charge).length === 1 ? '' : 's'}: ₹ ${money(s.amountPaise)} less fee ₹ ${money(s.feePaise)}${s.chargesPaise ? ` (with ₹ ${money(s.chargesPaise)} card company charges)` : ''}${s.gstPaise ? html` and GST ₹ ${money(s.gstPaise)}` : ''}
        = <strong>₹ ${money(s.netPaise)} to the bank</strong> · terminal ${s.terminals.join(', ')}</div>
      <div class="scroll"><table style="min-width:760px">
        <thead><tr><th>Paid</th><th>Card</th><th style="text-align:right">₹</th><th style="text-align:right">Fee + GST</th><th>Bill</th></tr></thead>
        <tbody>${s.payments.map((p) => html`<tr>
          <td style="white-space:nowrap">${hhmm(p.paidAt)}<div class="tiny">${dayLabel(p.shiftDay)} shift</div></td>
          <td style="white-space:nowrap">${p.scheme ?? ''} ${p.cardLast4 ? `•••• ${p.cardLast4}` : ''}<div class="tiny mono">RRN ${p.rrn ?? '—'}</div></td>
          <td class="amount">${p.charge ? '—' : money(p.amountPaise)}</td>
          <td class="amount">${money(p.feePaise + p.gstPaise - (p.charge ? p.amountPaise : 0))}</td>
          <td style="white-space:normal">${billCell(p)}</td></tr>`)}</tbody></table></div>
      <div class="inset" style="gap:8px"><strong>Bank</strong>${bankBlock(s)}</div>
    </section>`;
  };
  render(shell(biz, 'bank', 'Bank', '', html`
    ${bankTop(biz, b, 'cards')}
    <section class="card" style="gap:12px">
      <div id="recmsg"></div>
      <div class="note">Each settlement day's payments, and its money to the bank. Card payments are matched to their bills on each shift's Reconcile. Reports come in on <a href="#/b/${biz.id}/bank?tab=statements">Statements</a>.</div>
      <form id="cdrange" class="form-row" style="align-items:flex-end">
        <div class="field"><label for="cdfrom">Settled from</label><input id="cdfrom" type="date" name="from" value="${r.from}" required></div>
        <div class="field"><label for="cdto">To</label><input id="cdto" type="date" name="to" value="${r.to}" required></div>
        <button class="btn plain" type="submit">Show</button></form>
    </section>
    ${r.settlements.length ? r.settlements.map(dayCard) : html`<section class="card"><div class="note">No card payments settled between ${dayLabel(r.from)} and ${dayLabel(r.to)}.</div></section>`}`));
  wireShell();
  const msg = document.getElementById('recmsg');
  const act = async (btn, fn) => {
    btn.disabled = true;
    try { await fn(); } catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); btn.disabled = false; }
  };
  document.getElementById('cdrange').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = new FormData(e.target);
    location.hash = `#/b/${biz.id}/cards?${new URLSearchParams({ from: d.get('from'), to: d.get('to') })}`;
  });
  // A shift link opens its Reconcile on the Card tab.
  app.querySelectorAll('[data-cardshift]').forEach((l) => l.addEventListener('click', () => { recKeep = { day: l.dataset.cardshift, top: 'pay', tab: 'card' }; }));
  app.querySelectorAll('[data-csettle]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    act(btn, async () => {
      const [settledOn, merchantId] = f.dataset.csettle.split('|');
      const d = new FormData(f);
      const res = await api('POST', `/businesses/${biz.id}/cards/settle`, { settledOn, merchantId, bankRowId: d.get('bankRowId') });
      const rowId = d.get('bankRowId');
      await reload();
      doneToast(`Settled with the bank${res.feePaise ? `; fee ₹ ${money(res.feePaise)}${res.gstPaise ? ` and GST ₹ ${money(res.gstPaise)}` : ''} booked` : ''}.`,
        () => api('POST', `/businesses/${biz.id}/cards/unsettle`, { bankRowId: rowId }), reload);
    });
  }));
  app.querySelectorAll('[data-ctogether]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    const x = r.together[Number(b.dataset.ctogether)];
    await api('POST', `/businesses/${biz.id}/cards/settle`, { days: x.days, merchantId: x.merchantId, bankRowId: x.creditId });
    await reload();
    doneToast(`${x.days.length} days settled with one bank credit.`, () => api('POST', `/businesses/${biz.id}/cards/unsettle`, { bankRowId: x.creditId }), reload);
  })));
  app.querySelectorAll('[data-cunsettle]').forEach((b) => b.addEventListener('click', () => act(b, async () => {
    await api('POST', `/businesses/${biz.id}/cards/unsettle`, { bankRowId: b.dataset.cunsettle });
    await reload();
    doneToast('Taken apart from the bank credit; the fee and GST rows are removed.', null, reload);
  })));
}

// ---------- School cash book (approved 20 Nov 2026): each cashier keeps their own book on the phone.

const CB_IN = ['fee', 'other_in', 'handover_in'];
const CB_KIND = { fee: 'Fee received', other_in: 'Other money in', handover_in: 'Cash received', expense: 'Expense', other_out: 'Other money out', handover_out: 'Handed over' };
const cbStatus = (h) => (h.status === 'sent'
  ? html`<span class="chip wait">${h.toKind === 'bank' ? 'waiting for the deposit' : h.toKind === 'person' ? `waiting for ${h.toName} to confirm` : `waiting for ${h.toName} to accept`}</span>`
  : html`<span class="chip ok">${h.status === 'deposited' ? 'deposited' : 'received'}</span>`);
const cbWhere = (h) => (h.toKind === 'bank' ? `Bank: ${h.toName}` : h.toName);

/** All the books: cash with each cashier by branch, cash handed over not yet shown on the other side, and set up. */
// School screens on the PC (approved 21 Nov 2026): Cash books shows money only; set up and inviting cashiers live on
// Settings → Schools and cashiers; Today is the school's day (fees, cash with cashiers, and what needs a look).
const cbCountChip = (b) => (!b.lastCount ? html`<span class="tiny">not counted yet</span>`
  : b.lastCount.gapPaise === 0 ? html`<span class="chip ok" title="Counted on ${dayLabel(b.lastCount.day)}">count matches · ${shortDay(b.lastCount.day)}</span>`
    : html`<span class="chip bad" title="Counted on ${dayLabel(b.lastCount.day)}">${b.lastCount.gapPaise < 0 ? 'short' : 'extra'} ₹ ${rs(Math.abs(b.lastCount.gapPaise))} · ${shortDay(b.lastCount.day)}</span>`);
const cbPhone = (p) => (p ? `${p.slice(3, 8)} ${p.slice(8)}` : '');

/** Cash handed over that waits on the other side, with the Owner's actions; shared by Today and Cash books. */
function cbOpenRows(biz, d) {
  return d.handovers.map((h) => html`<div class="list-row" style="align-items:flex-start">
    <span><span style="font-weight:500">${h.fromBookName} → ${cbWhere(h)}</span> <span class="tiny">· ${shortDay(h.day)}</span>
      ${h.narration ? html`<div class="tiny">${h.narration}</div>` : ''}<div>${cbStatus(h)}</div>
      ${h.toKind === 'bank' && d.can.approve ? (h.deposits.length
        ? h.deposits.map((r) => html`<div class="tiny" style="margin-top:4px">${shortDay(r.day)} · ${r.description}
            <button type="button" class="btn ghost" style="min-height:32px" data-cbdeposit="${h.id}" data-row="${r.id}">Match this deposit</button></div>`)
        : html`<div class="tiny">No deposit of ₹ ${rs(h.amountPaise)} in ${h.toName} within a week yet. Sync the bank on the Bank page.</div>`) : ''}
      ${h.toKind === 'person' && d.can.approve ? html`<div style="margin-top:4px"><button type="button" class="btn ghost" style="min-height:32px" data-cbreceive="${h.id}">${h.toName} got it</button></div>` : ''}</span>
    <span class="amount">₹ ${rs(h.amountPaise)}</span></div>`);
}
function cbWireActions(biz, again) {
  const act = (sel, f) => app.querySelectorAll(sel).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await f(b); await again(); } catch (err) { alert(err.message); b.disabled = false; }
  }));
  act('[data-cbreceive]', (b) => api('POST', `/businesses/${biz.id}/handovers/${b.dataset.cbreceive}/receive`, {}));
  act('[data-cbdeposit]', (b) => api('POST', `/businesses/${biz.id}/handovers/${b.dataset.cbdeposit}/deposit`, { bankRowId: b.dataset.row }));
  act('[data-cbundo]', (b) => api('POST', `/businesses/${biz.id}/handovers/${b.dataset.cbundo}/undo`, {}));
}

async function cashBooksView(biz, oldEditId) {
  // The old "change a book" address now opens it on Schools and cashiers.
  if (oldEditId) return location.replace(`#/b/${biz.id}/schools/${oldEditId}`);
  const d = await api('GET', `/businesses/${biz.id}/cashbooks`);
  const total = d.books.reduce((t, b) => t + b.inHandPaise, 0);
  const books = d.books.map((b) => html`<a class="list-row cb-book" href="#/b/${biz.id}/cashbook/${b.id}/${d.today}">
      <span><span style="font-weight:500">${b.name}</span>${b.branchName ? html` <span class="tiny">· ${b.branchName}</span>` : ''}
        <div>${b.cashierUserId || !d.can.setup ? cbCountChip(b) : html`<span class="tiny">${b.invite ? 'invite sent, not joined yet' : 'no cashier yet'}</span> ${cbCountChip(b)}`}</div></span>
      <span class="amount" style="font-weight:500">₹ ${rs(b.inHandPaise)}</span></a>`);
  const done = d.done.map((h) => html`<div class="list-row">
    <span>${h.fromBookName} → ${cbWhere(h)} <span class="tiny">· ${shortDay(h.day)}${h.settledByName ? ` · ${h.status === 'deposited' ? 'matched' : 'confirmed'} by ${h.settledByName}` : ''}</span> ${cbStatus(h)}
      ${(h.toKind !== 'book' && d.can.approve) ? html`<button type="button" class="linkbtn tiny" data-cbundo="${h.id}">Undo</button>` : ''}</span>
    <span class="amount">₹ ${rs(h.amountPaise)}</span></div>`);
  const open = cbOpenRows(biz, d);
  render(shell(biz, 'cashbooks', 'Cash books', 'Cash with each cashier, and cash handed over until the other side shows it.', html`
    <div class="row">
      <section class="card grow3">
        <h2>Cash with cashiers <span class="amount" style="float:right">₹ ${rs(total)}</span></h2>
        ${d.books.length ? books : html`<div class="note">No cashiers yet.${d.can.setup ? html` Add your schools and their cashiers on <a href="#/b/${biz.id}/schools">Schools and cashiers</a>.` : ''}</div>`}
        ${d.can.setup && d.books.length ? html`<div class="tiny" style="margin-top:8px">Add a cashier, invite one, or change opening cash on <a href="#/b/${biz.id}/schools">Schools and cashiers</a>.</div>` : ''}
      </section>
      <section class="card grow2">
        <h2>Needs a look${d.handovers.length ? html` <span class="chip wait">${d.handovers.length}</span>` : ''}</h2>
        ${open.length ? open : html`<div class="note">All cash handed over is shown on the other side.</div>`}
        ${done.length ? html`<h2 style="margin-top:8px;font-size:15px">Done this week</h2>${done}` : ''}
      </section>
    </div>`));
  wireShell();
  cbWireActions(biz, () => cashBooksView(biz));
}

/** Settings → Schools and cashiers: each school with its receipt codes and its cashiers; add, change, invite by phone. */
async function schoolsView(biz, editId) {
  const d = await api('GET', `/businesses/${biz.id}/cashbooks`);
  const editing = d.books.find((b) => b.id === editId) ?? null;
  const codesOf = (branchId) => d.codes.filter((c) => c.branchId === branchId).map((c) => c.code);
  const otherCodes = d.codes.filter((c) => !c.branchId).map((c) => c.code);
  const who = (b) => (b.cashierUserId
    ? html`<span class="chip ok">${b.cashierName && b.cashierName !== b.name ? `${b.cashierName} signed in` : 'signed in'}</span>${b.cashierLastActive ? html` <span class="tiny">last seen ${when(b.cashierLastActive)}</span>` : ''}`
    : b.invite ? html`<span class="chip wait">invite sent</span> <span class="tiny">to ${cbPhone(b.invite.phone)} on ${shortDay(new Date(b.invite.createdAt + IST_MS).toISOString().slice(0, 10))}, not joined yet</span>
        ${d.can.invite ? html` <button type="button" class="linkbtn tiny" data-cbinvite="${b.id}" data-phone="${cbPhone(b.invite.phone)}">Send again</button>` : ''}`
      : d.can.invite ? html`<button type="button" class="btn plain" style="min-height:32px" data-cbinvite="${b.id}">Invite by phone</button>`
        : html`<span class="tiny">no cashier yet</span>`);
  const cashierRow = (b) => html`<div class="list-row" style="align-items:flex-start">
      <span style="min-width:0"><span style="font-weight:500">${b.name}</span>
        <span class="tiny">· opening ₹ ${rs(b.openingBalancePaise)} on ${shortDay(b.openingDate)}</span>
        <div data-cbwho="${b.id}" style="margin-top:4px">${who(b)}</div></span>
      <a class="btn plain" style="min-height:32px;display:inline-flex;align-items:center" href="#/b/${biz.id}/schools/${b.id}">Change</a></div>`;
  const schools = d.branches.map((br) => {
    const list = d.books.filter((b) => b.branchId === br.id);
    const codes = codesOf(br.id);
    return html`<section class="card">
      <h2 style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">${br.name}
        <span class="tiny" style="font-weight:400">${codes.length ? `Fee report code ${codes.join(', ')}` : 'No fee report code yet'}</span></h2>
      ${list.length ? list.map(cashierRow) : html`<div class="note">No cashier yet.</div>`}
      <details data-addcashier="${br.id}" style="margin-top:6px"><summary class="linkbtn" style="cursor:pointer">+ Add cashier to ${br.name}</summary>
        <form class="cb-add" data-branch="${br.id}" style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
          <div class="form-row">
            <div class="field"><label>Cashier's name</label><input name="name" placeholder="Rajesh Kumar" required></div>
            <div class="field"><label>Cash they hold now (₹)</label><input name="openingBalance" class="mono" inputmode="decimal" value="0" required></div>
            <div class="field"><label>From</label><input name="openingDate" type="date" value="${d.today}" required></div>
          </div>
          <div class="tiny">Their cash book is named after them, so the fee report's cashier name finds it. Invite them by phone after adding.</div>
          <div class="form-msg"></div>
          <div><button class="btn" type="submit">Add cashier</button></div>
        </form></details>
    </section>`;
  });
  const edit = editing ? html`<section class="card" id="cb-edit">
      <h2>Change ${editing.name}</h2>
      <form id="cb-book" style="display:flex;flex-direction:column;gap:12px">
        <div class="form-row">
          <div class="field"><label for="cbn">Cashier's name</label><input id="cbn" name="name" value="${editing.name}" required></div>
          <div class="field"><label for="cbbr">School</label><select id="cbbr" name="branchId" required>${d.branches.map((b) => html`<option value="${b.id}" ${editing.branchId === b.id ? 'selected' : ''}>${b.name}</option>`)}</select></div>
        </div>
        <div class="form-row">
          <div class="field"><label for="cbo">Cash they held at the start (₹)</label><input id="cbo" name="openingBalance" class="mono" inputmode="decimal" value="${rsIn(editing.openingBalancePaise)}" required></div>
          <div class="field"><label for="cbd">On</label><input id="cbd" name="openingDate" type="date" value="${editing.openingDate}" required></div>
          <div class="field"><label for="cbc">Signs in as</label><select id="cbc" name="cashierUserId"><option value="">Nobody yet</option>
            ${d.members.map((m) => html`<option value="${m.id}" ${editing.cashierUserId === m.id ? 'selected' : ''}>${m.name} (${ROLE_LABELS[m.role]})</option>`)}</select></div>
        </div>
        <div class="tiny">Start: the cash in their hand that morning (for a Khatabook book, its balance that day). Fee report days from then on fill the book.</div>
        <div class="form-msg"></div>
        <div class="form-row"><button class="btn" type="submit">Save</button>
          <a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/schools">Cancel</a></div>
      </form></section>` : '';
  render(shell(biz, 'schools', 'Schools and cashiers', 'Each school, its fee report code and its cashiers. Cashiers sign in with their mobile number.', html`
    ${edit}
    ${d.branches.length ? schools : html`<section class="card"><div class="note">Start with your first school, then add its cashiers.</div></section>`}
    <section class="card">
      <form id="cb-branch" class="form-row" style="align-items:flex-end">
        <div class="field"><label for="cbb">${d.branches.length ? 'Add a school' : 'Your first school'}</label><input id="cbb" name="name" placeholder="Chilkana Road" required></div>
        <button class="btn plain" type="submit">Add school</button><div class="form-msg"></div></form>
      ${otherCodes.length ? html`<div class="tiny" style="margin-top:8px">Fee report codes of your other business, left out here: ${otherCodes.join(', ')}. Codes are linked on Fee check the first time a report brings them.</div>` : ''}
    </section>`));
  wireShell();
  if (editing) document.getElementById('cb-edit').scrollIntoView({ block: 'start' });
  const again = () => schoolsView(biz, editId);
  // Invite a cashier by phone: the link opens WhatsApp to that number; joining makes them this book's cashier.
  app.querySelectorAll('[data-cbinvite]').forEach((btn) => btn.addEventListener('click', () => {
    const book = d.books.find((b) => b.id === btn.dataset.cbinvite);
    const box = app.querySelector(`[data-cbwho="${book.id}"]`);
    box.innerHTML = html`<form style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
        <div class="field" style="margin:0"><label for="cbph-${book.id}">${book.name}'s mobile number</label>
          <input id="cbph-${book.id}" name="phone" type="tel" inputmode="numeric" autocomplete="off" placeholder="94120 55555" value="${btn.dataset.phone ?? ''}" required style="max-width:170px"></div>
        <button class="btn" type="submit">Send on WhatsApp</button>
        <button class="btn plain" type="button" data-copy>Copy invite</button>
        <button class="btn plain" type="button" data-cancel>Cancel</button>
        <div class="tiny" style="flex-basis:100%">They join as Entry staff, sign in with this number and see only their own book.</div>
        <div class="form-msg" style="flex-basis:100%"></div></form>`.__html;
    const f = box.querySelector('form');
    const msg = f.querySelector('.form-msg');
    f.querySelector('input').focus();
    const make = async () => {
      const res = await api('POST', `/businesses/${biz.id}/invites`, { phone: f.elements.phone.value, role: 'entry_staff', accountId: book.id });
      return { res, text: `Join ${biz.name} on Bookr to keep your cash book. Open this link, choose a password, then sign in with your mobile number: ${res.link}` };
    };
    f.querySelector('[data-cancel]').addEventListener('click', again);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Opened at once (a tap is needed to open WhatsApp), then pointed at the chat once the link is made.
      const w = window.open('about:blank', '_blank');
      msg.textContent = 'Making the link…'; msg.className = 'form-msg';
      try {
        const { res, text } = await make();
        const wa = `https://wa.me/${res.phone.slice(1)}?text=${encodeURIComponent(text)}`;
        if (w) w.location.href = wa; else location.href = wa;
        await again();
      } catch (err) { w?.close(); msg.textContent = err.message; msg.className = 'form-msg error'; }
    });
    f.querySelector('[data-copy]').addEventListener('click', async () => {
      if (!f.reportValidity()) return;
      try {
        const { text } = await make();
        try { await navigator.clipboard.writeText(text); msg.textContent = 'Invite copied. Paste it to them in any chat.'; }
        catch { msg.textContent = text; }
        msg.className = 'form-msg';
      } catch (err) { msg.textContent = err.message; msg.className = 'form-msg error'; }
    });
  }));
  app.querySelectorAll('form.cb-add').forEach((f) => onSubmit(f, async (x) => {
    await api('POST', `/businesses/${biz.id}/cashbooks`, { ...x, branchId: f.dataset.branch });
    BIZ_KEEP.delete(biz.id); GET_CACHE.clear();
    await again();
  }));
  const bf = document.getElementById('cb-branch');
  onSubmit(bf, async (x) => {
    await api('POST', `/businesses/${biz.id}/branches`, x); BIZ_KEEP.delete(biz.id); GET_CACHE.clear();
    // The first school makes it a school business: route again so the menu changes over.
    if (biz.cashBooks) await again(); else await route();
  });
  const kf = document.getElementById('cb-book');
  kf && onSubmit(kf, async (x) => {
    await api('PATCH', `/businesses/${biz.id}/cashbooks/${editing.id}`, x);
    BIZ_KEEP.delete(biz.id); GET_CACHE.clear();
    go(`#/b/${biz.id}/schools`);
  });
}

/** Today for a school: the latest fee report, cash with cashiers, and everything that waits on someone. */
async function schoolTodayView(biz) {
  const d = await api('GET', `/businesses/${biz.id}/cashbooks`);
  const first = biz.actions.includes('sales.view') ? await api('GET', `/businesses/${biz.id}/fees/${d.today}`) : null;
  const lastDay = first?.days?.[0] ?? null;
  const fees = first && lastDay && lastDay !== d.today ? await api('GET', `/businesses/${biz.id}/fees/${lastDay}`) : first;
  const rep = fees?.report ? fees : null;
  const total = d.books.reduce((t, b) => t + b.inHandPaise, 0);
  const notCounted = d.books.filter((b) => b.cashierUserId && b.lastCount?.day !== d.today);
  const gaps = d.books.filter((b) => b.lastCount && b.lastCount.gapPaise !== 0 && b.lastCount.day >= lastDay7(d.today));
  const noCashier = d.books.filter((b) => !b.cashierUserId);
  const tile = (label, value, sub, href) => html`<a class="tile" href="${href}" style="padding:12px;color:inherit;text-decoration:none">
      <div class="tiny">${label}</div><div class="amount" style="text-align:left;font-size:22px;font-weight:500">${value}</div>${sub ? html`<div class="tiny">${sub}</div>` : ''}</a>`;
  const look = [
    ...cbOpenRows(biz, d),
    ...gaps.map((b) => html`<a class="list-row" href="#/b/${biz.id}/cashbook/${b.id}/${b.lastCount.day}" style="color:inherit">
      <span>${b.name} counted ₹ ${rs(Math.abs(b.lastCount.gapPaise))} ${b.lastCount.gapPaise < 0 ? 'short' : 'extra'} <span class="tiny">· ${b.branchName ?? ''} · ${shortDay(b.lastCount.day)}</span></span>
      <span class="chip bad">${b.lastCount.gapPaise < 0 ? 'short' : 'extra'}</span></a>`),
    ...notCounted.map((b) => html`<a class="list-row" href="#/b/${biz.id}/cashbook/${b.id}/${d.today}" style="color:inherit">
      <span>${b.name} has not counted today <span class="tiny">· ${b.branchName ?? ''}</span></span><span class="chip wait">count</span></a>`),
    ...(rep ? [] : [html`<a class="list-row" href="#/b/${biz.id}/fees/${d.today}" style="color:inherit"><span>Bring in today's fee report</span><span class="chip wait">Fee check ›</span></a>`]),
    ...(noCashier.length && d.can.setup ? [html`<a class="list-row" href="#/b/${biz.id}/schools" style="color:inherit">
      <span>${noCashier.length === 1 ? `${noCashier[0].name} has not joined` : `${noCashier.length} cashiers have not joined`} <span class="tiny">· invite them by phone</span></span><span class="chip wait">Schools and cashiers ›</span></a>`] : []),
  ];
  const cashiers = d.books.map((b) => html`<a class="list-row" href="#/b/${biz.id}/cashbook/${b.id}/${d.today}" style="color:inherit">
      <span><span style="font-weight:500">${b.name}</span> <span class="tiny">· ${b.branchName ?? ''}</span><div>${cbCountChip(b)}</div></span>
      <span class="amount" style="font-weight:500">₹ ${rs(b.inHandPaise)}</span></a>`);
  render(shell(biz, 'dashboard', 'Today', '', html`
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
      ${rep ? tile(`Fees, ${lastDay === d.today ? 'today' : shortDay(lastDay)}`, `₹ ${rs(rep.totalPaise)}`, `${rep.report.receipts} receipts · cash ₹ ${rs(rep.totals.cash)}`, `#/b/${biz.id}/fees/${lastDay}`)
        : tile('Fees, today', '—', 'fee report not brought in', `#/b/${biz.id}/fees/${d.today}`)}
      ${tile('Cash with cashiers', `₹ ${rs(total)}`, `${d.books.length} cashier${d.books.length === 1 ? '' : 's'}`, `#/b/${biz.id}/cashbooks`)}
      ${rep ? tile('UPI and card to match', `₹ ${rs((rep.totals.upi ?? 0) + (rep.totals.card ?? 0))}`, 'with the bank, once its accounts are added', `#/b/${biz.id}/fees/${lastDay}`) : ''}
    </div>
    <div class="row" style="margin-top:12px">
      <section class="card grow3">
        <h2>Needs a look${look.length ? html` <span class="chip wait">${look.length}</span>` : ''}</h2>
        ${look.length ? look : html`<div class="note">Nothing waits on anyone.</div>`}
      </section>
      <section class="card grow2">
        <h2>Cash with cashiers <span class="amount" style="float:right">₹ ${rs(total)}</span></h2>
        ${cashiers.length ? cashiers : html`<div class="note">No cashiers yet.</div>`}
      </section>
    </div>`));
  wireShell();
  cbWireActions(biz, () => schoolTodayView(biz));
}
const lastDay7 = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);

/** One day of a cashier's book, made for the phone: what came in, what went out, what should be in hand, and the count. */
// Cashier phone app (approved 21 Nov 2026): a cashier (Entry staff) sees their book with a bar at the bottom: Today,
// Days, Handed over, More. The day's fee cash is one total entered at the end of the day; once the fee day sheet is in,
// the book uses the sheet and shows any difference to sort out. Owner and Accountant open the same day in the side menu.
const cbIsCashier = (biz) => biz.role === 'entry_staff';
const cbRupees = (v) => { const n = Number(String(v ?? '').replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const cbDayName = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const CB_WHAT_IN = ['Admission form', 'TC / certificate', 'Fine'];

function cbFrame(biz, b, tab, body) {
  if (!cbIsCashier(biz)) return shell(biz, 'cashbook', b.name, `${b.branchName ?? ''}${b.cashierName && b.cashierName !== b.name ? ` · ${b.cashierName}` : ''}`, body);
  const t = (key, label, href) => html`<a class="cbt ${tab === key ? 'on' : ''}" href="${href}" ${tab === key ? html`aria-current="page"` : ''}>${label}</a>`;
  return html`<div class="cbapp">
    <header class="cbapp-head"><span><b>${b.cashierName ?? b.name}</b> <span class="tiny">· ${b.branchName ?? ''}</span></span>
      ${me.businesses.length > 1 ? html`<a class="tiny" href="#/choose">${biz.name} ▾</a>` : html`<span class="tiny">${biz.name}</span>`}</header>
    <main class="cbapp-main">${body}</main>
    <nav class="cbbar" aria-label="Cash book">
      ${t('today', 'Today', `#/b/${biz.id}/cashbook/${b.id}/${todayIst()}`)}${t('days', 'Days', `#/b/${biz.id}/cbdays/${b.id}`)}
      ${t('handed', 'Handed over', `#/b/${biz.id}/cbhanded/${b.id}`)}${t('more', 'More', `#/b/${biz.id}/cbmore/${b.id}`)}</nav>
  </div>`;
}

const cbReviewChip = (e) => (e.kind === 'other_in'
  ? html`<span class="chip info">extra</span>${e.headName ? html` <span class="tiny">${e.headName}</span>` : ''}`
  : e.reviewStatus === 'approved' ? html`<span class="chip ok">approved</span>`
    : e.reviewStatus === 'rejected' ? html`<span class="chip bad">rejected</span>`
      : !e.headId ? html`<span class="chip wait">head to set</span>` : html`<span class="chip info">to approve</span>`);

/** The fee check of a day, as the cashier sees it, with what they can do about a difference. */
function cbFeeBox(f, canWrite, seeSheet) {
  if (!f || !f.sheetIn || f.typedPaise == null) return '';
  const diff = Math.abs(f.diffPaise);
  if (f.state === 'agrees') return html`<div class="cb-box ok">Fee sheet agrees with your total ✓</div>`;
  if (f.state === 'cleared') return html`<div class="cb-box ok">${f.missing.join(', ')} found in a later sheet ✓ The ₹ ${rs(diff)} counts on that day now.</div>`;
  if (f.state === 'kept') return html`<div class="cb-box info"><span>You kept ₹ ${rs(diff)} that is not in the sheet${f.missing.length ? ` (${f.missing.join(', ')})` : ''}. It clears when a later sheet has it. The owner sees it.</span>
    ${canWrite ? html`<span><button type="button" class="linkbtn" data-cbsettle="sheet">The sheet is right after all</button></span>` : ''}</div>`;
  if (f.state === 'sheet') return html`<div class="cb-box info"><span>${f.diffPaise > 0 ? `You said you added wrong: the sheet's ₹ ${rs(f.sheetPaise)} is used.` : `You said the sheet is right: ₹ ${rs(diff)} more than you entered.`}</span>
    ${canWrite ? html`<span><button type="button" class="linkbtn" data-cbsettle="">Undo</button></span>` : ''}</div>`;
  if (f.state === 'less') return html`<div class="cb-box wait"><b>You entered ₹ ${rs(diff)} more than the sheet.</b>
    <span>${f.missing.length ? `${f.missing.join(', ')} ${f.missing.length === 1 ? 'is' : 'are'} not in the sheet.` : 'Your total ₹ ' + rs(f.typedPaise) + ', sheet ₹ ' + rs(f.sheetPaise) + '.'}</span>
    ${canWrite ? html`<div class="cb-opts">
      <a class="btn" href="${seeSheet.bring}"><span><b>Receipt made after the sheet was taken out</b><br><span class="tiny">Bring in the sheet again</span></span></a>
      <button type="button" class="btn plain" data-cbsettle="kept"><span><b>Keep my ₹ ${rs(diff)}, the office will fix it</b><br><span class="tiny">Stays as "fee not in sheet" until a later sheet has it</span></span></button>
      <button type="button" class="btn plain" data-cbsettle="sheet"><span><b>I added wrong, the sheet is right</b></span></button></div>` : ''}</div>`;
  return html`<div class="cb-box wait"><b>The sheet has ₹ ${rs(diff)} more than you entered.</b>
    <span>Your book uses the sheet. If that cash is not in your hand, the count shows it short.</span>
    ${canWrite ? html`<div class="cb-opts"><button type="button" class="btn" data-cbsettle="sheet">I missed it, the sheet is right</button>
      <a class="btn plain" href="${seeSheet.view}">See the sheet's receipts</a></div>` : ''}</div>`;
}

async function cashBookDayView(biz, accountId, dayIn) {
  if (!accountId) return go(`#/b/${biz.id}/cashbooks`);
  const day = isDay(dayIn) ? dayIn : todayIst();
  const d = await api('GET', `/businesses/${biz.id}/cashbooks/${accountId}/day/${day}`);
  const b = d.book;
  const f = d.fee;
  const w = d.can.write && !d.before;
  const prev = addDaysIso(day, -1);
  const next = addDaysIso(day, 1);
  const del = (e) => (w && !e.feeReportId && !e.reviewStatus && !(e.kind === 'fee') && !(e.kind === 'handover_out' && e.handover?.status !== 'sent')
    ? html`<button type="button" class="linkbtn tiny" data-cbdel="${e.id}" aria-label="Remove this line">✕</button>` : '');
  const row = (label, sub, amt, sign, cls = '', extra = '') => html`<div class="list-row cb-line ${cls}"><span>${label}${sub ? html`<div class="tiny">${sub}</div>` : ''}</span>
    <span class="cb-amt ${sign === '+' ? 'in' : sign === '−' ? 'out' : ''}">${sign}${amt}${extra}</span></div>`;
  const typed = d.entries.filter((e) => e.kind === 'fee' && !e.feeReportId);
  const sheetLines = d.entries.filter((e) => e.feeReportId);
  const feeRows = [
    ...sheetLines.map((e) => row(html`Fee sheet <span class="tiny">· ${e.narration?.match(/\d+ receipts?/)?.[0] ?? ''} in cash</span>`, '', `₹ ${rs(e.amountPaise)}`, '+')),
    ...(f?.sheetIn && !sheetLines.length ? [row('Fee sheet', 'no cash receipts for you', '₹ 0', '')] : []),
    ...typed.map((e) => (f?.sheetIn
      ? row(html`<span class="cb-strike">Your fee total</span>`, f.receipts ? `${f.receipts} receipts${f.first ? ` · ${f.first}–${f.last}` : ''}` : '', html`<span class="cb-strike">₹ ${rs(e.amountPaise)}</span>`, '')
      : row(html`Fee cash, your total ${f?.state === 'waiting' ? html`<span class="chip wait">sheet not in yet</span>` : ''}`,
        f?.receipts ? `${f.receipts} receipts${f.first ? ` · ${f.first}–${f.last}` : ''}` : '', `₹ ${rs(e.amountPaise)}`, '+'))),
    ...(f?.state === 'kept' ? [row(html`Fee not in sheet <span class="chip bad">kept</span>`, f.missing.join(', '), `₹ ${rs(f.diffPaise)}`, '+')] : []),
  ];
  const others = d.entries.filter((e) => e.kind !== 'fee').map((e) => {
    const inn = CB_IN.includes(e.kind);
    const label = e.kind === 'handover_out' ? html`To ${e.handover ? cbWhere(e.handover) : 'someone'} ${e.handover ? cbStatus(e.handover) : ''}`
      : e.kind === 'handover_in' ? html`${e.narration || 'Cash received'}`
        : html`${e.narration || e.headName || CB_KIND[e.kind]} ${e.kind === 'expense' || e.kind === 'other_in' ? cbReviewChip(e) : ''}`;
    const sub = e.kind === 'handover_out' ? e.narration : e.reviewStatus === 'rejected' && e.reviewNote ? `Owner: ${e.reviewNote}` : e.kind === 'expense' && e.headName ? e.headName : '';
    return row(label, sub, `₹ ${rs(e.amountPaise)}`, inn ? '+' : '−', '', del(e));
  });
  const gap = d.count?.gapPaise ?? null;
  const waiting = d.waiting.map((h) => html`<div class="cb-box wait cb-wait"><span><b>${h.fromBookName}</b> sent you ₹ ${rs(h.amountPaise)}
      <span class="tiny">· ${shortDay(h.day)}${h.narration ? ` · ${h.narration}` : ''}</span></span>
    ${d.can.write && h.day <= day ? html`<button type="button" class="btn" style="min-height:36px" data-cbaccept="${h.id}">Got it</button>` : ''}</div>`);
  const feeLabel = f?.sheetIn ? '' : typed.length ? 'Change today\'s fee cash' : 'Enter today\'s fee cash';
  const needCount = !d.count && (typed.length || f?.sheetIn);
  const opts = (list) => list.map((x) => html`<option value="${x}">${x}</option>`);
  const forms = w ? html`
    <div class="cb-btns">
      ${feeLabel ? html`<button type="button" class="btn wide ${typed.length ? 'plain' : ''}" data-cbopen="fee">${feeLabel}</button>` : ''}
      <button type="button" class="btn plain" data-cbopen="receipt">+ Receipt</button>
      <button type="button" class="btn plain" data-cbopen="expense">+ Expense</button>
      <button type="button" class="btn plain" data-cbopen="handover">Hand over</button>
      <button type="button" class="btn ${needCount ? '' : 'plain'}" data-cbopen="count">${d.count ? 'Count again' : 'Count cash'}</button>
    </div>
    <form class="card cb-form" data-cbform="fee" hidden>
      <div style="font-weight:500">Today's fee cash · ${shortDay(day)}</div>
      <div class="field"><label for="cbf-a">Total cash fees collected today (₹)</label><input id="cbf-a" name="amount" class="mono" inputmode="decimal" required value="${typed.length ? rsIn(typed.reduce((t, e) => t + e.amountPaise, 0)) : ''}" placeholder="25,000"></div>
      <div class="field"><label for="cbf-r">Receipts (optional)</label><input id="cbf-r" name="receipts" class="mono" inputmode="numeric" value="${f?.receipts ?? ''}" placeholder="8"></div>
      <div class="field"><label>Receipt nos (optional)</label><span style="display:flex;gap:8px">
        <input name="first" class="mono" aria-label="First receipt no." value="${f?.first ?? ''}" placeholder="from 0401" style="flex:1;min-width:0">
        <input name="last" class="mono" aria-label="Last receipt no." value="${f?.last ?? ''}" placeholder="to 0408" style="flex:1;min-width:0"></span></div>
      <div class="tiny">Only cash. UPI and card fees come from the sheet and the bank. You can change this until the sheet comes in.</div>
      <div class="form-msg"></div><div class="form-row"><button class="btn" type="submit">Save</button><button class="btn plain" type="button" data-cbclose>Cancel</button></div>
    </form>
    <form class="card cb-form" data-cbform="receipt" hidden>
      <div style="font-weight:500">+ Receipt <span class="tiny">· cash not in the fee software</span></div>
      <div class="field"><label for="cbr-a">Amount (₹)</label><input id="cbr-a" name="amount" class="mono" inputmode="decimal" required placeholder="600"></div>
      <div class="field"><label for="cbr-w">What for</label><select id="cbr-w" name="what">${opts(CB_WHAT_IN)}<option value="">Something else…</option></select></div>
      <div class="field" data-cbelse hidden><label for="cbr-o">What was it?</label><input id="cbr-o" name="other" placeholder="Book sale"></div>
      <div class="field"><label for="cbr-s">Slip no. (manual book, optional)</label><input id="cbr-s" name="slip" class="mono" placeholder="M-118"></div>
      <div class="tiny">The fee sheet never replaces it. The accountant sets its head.</div>
      <div class="form-msg"></div><div class="form-row"><button class="btn" type="submit">Save receipt</button><button class="btn plain" type="button" data-cbclose>Cancel</button></div>
    </form>
    <form class="card cb-form" data-cbform="expense" hidden>
      <div style="font-weight:500">+ Expense</div>
      <div class="field"><label for="cbe-a">Amount (₹)</label><input id="cbe-a" name="amount" class="mono" inputmode="decimal" required placeholder="450"></div>
      <div class="field"><label for="cbe-w">What for</label><input id="cbe-w" name="what" required placeholder="Registers and chalk"></div>
      <div class="field"><label for="cbe-p">Paid to (optional)</label><input id="cbe-p" name="paidTo" placeholder="Gupta Stationers"></div>
      <div class="tiny">The cash leaves your book now. The accountant sets the head and the owner approves.</div>
      <div class="form-msg"></div><div class="form-row"><button class="btn" type="submit">Save expense</button><button class="btn plain" type="button" data-cbclose>Cancel</button></div>
    </form>
    <form class="card cb-form" data-cbform="handover" hidden>
      <div style="font-weight:500">Hand over cash</div>
      <div class="field"><label for="cbh-a">Amount (₹)</label><input id="cbh-a" name="amount" class="mono" inputmode="decimal" required placeholder="20,000"></div>
      <div class="field"><label for="cbh-t">To</label><select id="cbh-t" name="to">
        ${d.banks.length ? html`<optgroup label="Bank">${d.banks.map((x) => html`<option value="bank:${x.id}">Bank: ${x.name}</option>`)}</optgroup>` : ''}
        ${d.targets.length ? html`<optgroup label="Another cashier">${d.targets.map((t) => html`<option value="book:${t.id}">${t.cashierName ?? t.name}${t.branchName ? ` · ${t.branchName}` : ''}</option>`)}</optgroup>` : ''}
        <optgroup label="A person">${d.people.map((p) => html`<option value="person:${p}">${p}</option>`)}<option value="person:">Someone else…</option></optgroup></select></div>
      <div class="field" data-cbperson hidden><label for="cbh-p">Person's name</label><input id="cbh-p" name="person" placeholder="Anoop"></div>
      <div class="field"><label for="cbh-n">Note (optional)</label><input id="cbh-n" name="narration" placeholder="Deposit slip 4471"></div>
      <div class="tiny">Leaves your book now; waits until the other side shows it.</div>
      <div class="form-msg"></div><div class="form-row"><button class="btn" type="submit">Hand over</button><button class="btn plain" type="button" data-cbclose>Cancel</button></div>
    </form>
    <form class="card cb-form" data-cbform="count" hidden>
      <div style="font-weight:500">Count cash · ${shortDay(day)}</div>
      <div class="field"><label for="cbc-a">Notes and coins counted (₹)</label><input id="cbc-a" name="counted" class="mono" inputmode="decimal" required value="${d.count ? rsIn(d.count.countedPaise) : ''}" placeholder="24,950"></div>
      <div class="list-row"><span>Should be</span><span class="amount">₹ ${rs(d.shouldPaise)}</span></div>
      <div data-cbgap></div>
      <div class="field" data-cbnote hidden><label for="cbc-n">Why? (needed when short or extra)</label><textarea id="cbc-n" name="note" rows="2" placeholder="Gave ₹ 300 to the peon for the gas cylinder, bill tomorrow">${d.count?.note ?? ''}</textarea>
        <span class="tiny">The owner sees this note.</span></div>
      <div class="form-msg"></div><div class="form-row"><button class="btn" type="submit">Save count</button><button class="btn plain" type="button" data-cbclose>Cancel</button></div>
    </form>` : '';
  const body = html`
    <div class="cb">
      <nav class="cb-day" aria-label="Day">
        ${day > b.openingDate ? html`<a class="btn plain" href="#/b/${biz.id}/cashbook/${b.id}/${prev}" aria-label="Previous day">‹</a>` : html`<span class="btn plain off">‹</span>`}
        <label class="cb-pick">${cbDayName(day)}<input type="date" id="cb-date" value="${day}" min="${b.openingDate}" max="${d.today}" aria-label="Choose a day"></label>
        ${day < d.today ? html`<a class="btn plain" href="#/b/${biz.id}/cashbook/${b.id}/${next}" aria-label="Next day">›</a>` : html`<span class="btn plain off">›</span>`}
      </nav>
      ${d.before ? html`<div class="note">This book starts on ${dayLabel(b.openingDate)}.</div>` : html`
      <div><div class="cb-big">₹ ${rs(d.shouldPaise)}</div><div class="tiny">should be in hand${f?.sheetIn ? html` · <span class="chip ok">sheet in</span>` : typed.length ? html` · <span class="chip wait">sheet not in yet</span>` : ''}</div></div>`}
      ${waiting}
      ${cbFeeBox(f, d.can.write, { bring: `#/b/${biz.id}/cbmore/${b.id}`, view: `#/b/${biz.id}/fees/${day}` })}
      <section class="card cb-card">
        ${row('Opening', '', `₹ ${rs(d.openingPaise)}`, '')}
        ${feeRows.length ? feeRows : !d.before ? row(html`Today's fee cash <span class="chip wait">not entered</span>`, '', '—', '') : ''}
        ${others}
        <div class="list-row cb-total"><span>Should be in hand</span><span class="amount">₹ ${rs(d.shouldPaise)}</span></div>
        ${d.count ? html`<div class="list-row"><span>Counted${d.count.countedByName ? html` <span class="tiny">by ${d.count.countedByName}</span>` : ''}</span><span class="amount">₹ ${rs(d.count.countedPaise)}</span></div>
          <div class="cb-gap ${gap === 0 ? 'ok' : 'bad'}">${gap === 0 ? 'Count matches ✓' : `Cash ${gap < 0 ? 'short' : 'extra'} ₹ ${rs(Math.abs(gap))}`}
            ${d.count.note ? html`<div class="tiny">"${d.count.note}"</div>` : ''}</div>` : ''}
      </section>
      ${forms}
      ${!cbIsCashier(biz) && biz.role !== 'entry_staff' ? html`<a class="tiny" href="#/b/${biz.id}/cashbooks">All cash books</a>` : ''}
    </div>`;
  render(cbFrame(biz, b, day === d.today ? 'today' : 'days', body));
  wireShell();
  const reload = () => cashBookDayView(biz, accountId, day);
  const base = `/businesses/${biz.id}/cashbooks/${b.id}`;
  document.getElementById('cb-date')?.addEventListener('change', (e) => { if (isDay(e.target.value)) go(`#/b/${biz.id}/cashbook/${b.id}/${e.target.value}`); });
  const act = (sel, fn) => app.querySelectorAll(sel).forEach((x) => x.addEventListener('click', async () => {
    x.disabled = true;
    try { await fn(x); await reload(); } catch (err) { alert(err.message); x.disabled = false; }
  }));
  act('[data-cbdel]', async (x) => { if (confirm('Remove this line from the book?')) await api('DELETE', `${base}/entries/${x.dataset.cbdel}`); });
  act('[data-cbaccept]', (x) => api('POST', `/businesses/${biz.id}/handovers/${x.dataset.cbaccept}/receive`, { day }));
  act('[data-cbsettle]', (x) => api('PUT', `${base}/fee/${day}/settle`, { how: x.dataset.cbsettle || null }));
  const forms$ = [...app.querySelectorAll('[data-cbform]')];
  const open = (k) => {
    forms$.forEach((fm) => { fm.hidden = fm.dataset.cbform !== k; });
    const fm = forms$.find((x) => x.dataset.cbform === k);
    fm?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    fm?.querySelector('input,select')?.focus({ preventScroll: true });
  };
  app.querySelectorAll('[data-cbopen]').forEach((x) => x.addEventListener('click', () => open(x.dataset.cbopen)));
  app.querySelectorAll('[data-cbclose]').forEach((x) => x.addEventListener('click', () => { forms$.forEach((fm) => { fm.hidden = true; }); }));
  const fm = (k) => forms$.find((x) => x.dataset.cbform === k);
  if (!forms$.length) return;
  onSubmit(fm('fee'), async (x) => {
    await api('PUT', `${base}/fee/${day}`, { amount: x.amount, receipts: x.receipts || null, first: x.first, last: x.last });
    await reload();
  });
  const what = fm('receipt').querySelector('[name=what]');
  what.addEventListener('change', () => { fm('receipt').querySelector('[data-cbelse]').hidden = !!what.value; });
  onSubmit(fm('receipt'), async (x) => {
    const w2 = x.what || x.other?.trim();
    if (!w2) throw new Error('Write what this receipt was for.');
    await api('POST', `${base}/entries`, { day, kind: 'other_in', amount: x.amount, narration: `${w2}${x.slip?.trim() ? ` · slip ${x.slip.trim()}` : ''}` });
    await reload();
  });
  onSubmit(fm('expense'), async (x) => {
    await api('POST', `${base}/entries`, { day, kind: 'expense', amount: x.amount, narration: `${x.what.trim()}${x.paidTo?.trim() ? ` · paid to ${x.paidTo.trim()}` : ''}` });
    await reload();
  });
  const to = fm('handover').querySelector('[name=to]');
  const person = () => { fm('handover').querySelector('[data-cbperson]').hidden = to.value !== 'person:'; };
  to.addEventListener('change', person);
  person();
  onSubmit(fm('handover'), async (x) => {
    const k = x.to.slice(0, x.to.indexOf(':'));
    const v = x.to.slice(x.to.indexOf(':') + 1);
    const body2 = { day, kind: 'handover_out', amount: x.amount, narration: x.narration, to: k === 'person' ? { kind: 'person', name: v || x.person } : { kind: k, accountId: v } };
    await api('POST', `${base}/entries`, body2);
    await reload();
  });
  const cf = fm('count');
  const showGap = () => {
    const p = cbRupees(cf.querySelector('[name=counted]').value);
    const g = Number.isNaN(p) || cf.querySelector('[name=counted]').value.trim() === '' ? null : p - d.shouldPaise;
    cf.querySelector('[data-cbgap]').innerHTML = g == null ? '' : g === 0 ? '<div class="cb-gap ok">Matches ✓</div>'
      : `<div class="cb-gap bad">Cash ${g < 0 ? 'short' : 'extra'} ₹ ${rs(Math.abs(g))}</div>`;
    cf.querySelector('[data-cbnote]').hidden = !g;
  };
  cf.querySelector('[name=counted]').addEventListener('input', showGap);
  showGap();
  onSubmit(cf, async (x) => { await api('PUT', `${base}/count/${day}`, { counted: x.counted, note: x.note }); await reload(); });
}

/** Days: each day of the book, newest first, with its count and whether the fee sheet agrees. */
async function cbDaysView(biz, accountId) {
  const d = await api('GET', `/businesses/${biz.id}/cashbooks/${accountId}/days`);
  const b = d.book;
  const feeNote = (f) => (!f ? '' : f.state === 'waiting' ? 'sheet not in' : f.state === 'less' || f.state === 'more' ? 'sheet differs' : f.state === 'kept' ? 'fee not in sheet' : '');
  const rows = d.days.map((x) => {
    const k = x.count;
    const chip = !k ? html`<span class="chip wait">not counted</span>` : k.gapPaise === 0 ? html`<span class="chip ok">matches</span>`
      : html`<span class="chip bad">${k.gapPaise < 0 ? 'short' : 'extra'} ${rs(Math.abs(k.gapPaise))}</span>`;
    const note = feeNote(x.fee);
    return html`<a class="list-row cb-book" href="#/b/${biz.id}/cashbook/${b.id}/${x.day}">
      <span><span style="font-weight:500">${cbDayName(x.day)}</span>${x.day === d.today ? html` <span class="tiny">today</span>` : ''}
        ${note ? html`<div class="tiny">${note}</div>` : ''}</span>
      <span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${chip}<span class="amount tiny">₹ ${rs(x.shouldPaise)}</span></span></a>`;
  });
  render(cbFrame(biz, b, 'days', html`<div class="cb"><h2 style="margin:0;font-size:16px">Your days</h2>
    <section class="card cb-card">${rows.length ? rows : html`<div class="note">This book starts on ${dayLabel(b.openingDate)}.</div>`}</section>
    <div class="tiny">The amount is what should have been in hand at the end of the day. Tap a day to open it.</div></div>`));
  wireShell();
}

/** Handed over: cash this book sent (waiting, done) and cash sent to it. */
async function cbHandedView(biz, accountId) {
  const d = await api('GET', `/businesses/${biz.id}/cashbooks`);
  const b = d.books.find((x) => x.id === accountId);
  if (!b) return go(home(biz));
  const mineOut = (h) => h.fromAccountId === b.id;
  const toMe = (h) => h.toKind === 'book' && h.toAccountId === b.id;
  const line = (h, right) => html`<div class="list-row" style="align-items:flex-start"><span>${mineOut(h) ? html`To ${cbWhere(h)}` : html`From ${h.fromBookName}`}
      <span class="tiny">· ${shortDay(h.day)}</span>${h.narration ? html`<div class="tiny">${h.narration}</div>` : ''}<div>${right}</div></span>
    <span class="amount">₹ ${rs(h.amountPaise)}</span></div>`;
  const waiting = d.handovers.filter(mineOut).map((h) => line(h, cbStatus(h)));
  const sent = d.handovers.filter(toMe).map((h) => line(h, html`<button type="button" class="btn" style="min-height:36px;margin-top:4px" data-cbaccept="${h.id}">Got it</button>`));
  const done = d.done.filter((h) => mineOut(h) || toMe(h)).map((h) => line(h, html`<span class="chip ok">${h.status === 'deposited' ? 'in the bank' : `${mineOut(h) ? h.toName : 'you'} got it`}</span>`));
  render(cbFrame(biz, b, 'handed', html`<div class="cb">
    ${sent.length ? html`<section class="card cb-card"><div class="cb-hd" style="margin-top:0">Sent to you</div>${sent}</section>` : ''}
    <section class="card cb-card"><div class="cb-hd" style="margin-top:0">Waiting</div>${waiting.length ? waiting : html`<div class="list-row"><span class="tiny">Nothing waiting.</span><span></span></div>`}</section>
    <section class="card cb-card"><div class="cb-hd" style="margin-top:0">Done this week</div>${done.length ? done : html`<div class="list-row"><span class="tiny">None yet.</span><span></span></div>`}</section>
    </div>`));
  wireShell();
  app.querySelectorAll('[data-cbaccept]').forEach((x) => x.addEventListener('click', async () => {
    x.disabled = true;
    try { await api('POST', `/businesses/${biz.id}/handovers/${x.dataset.cbaccept}/receive`, { day: todayIst() }); await cbHandedView(biz, accountId); } catch (err) { alert(err.message); x.disabled = false; }
  }));
}

/** More: bring in the fee sheet, my expenses and receipts, install, sign out. */
async function cbMoreView(biz, accountId) {
  const t = todayIst();
  const [d, l] = await Promise.all([
    api('GET', `/businesses/${biz.id}/cashbooks/${accountId}/day/${t}`),
    api('GET', `/businesses/${biz.id}/cashbooks/${accountId}/lines`),
  ]);
  const b = d.book;
  const canImport = biz.actions.includes('sales.import');
  const toSet = l.lines.filter((x) => x.kind === 'expense' && !x.reviewStatus).length;
  const lines = l.lines.map((x) => html`<div class="list-row" style="align-items:flex-start"><span>${x.narration || x.headName}
      <div>${cbReviewChip(x)} <span class="tiny">· ${shortDay(x.day)}${x.headName && x.kind === 'expense' ? ` · ${x.headName}` : ''}</span></div>
      ${x.reviewStatus === 'rejected' && x.reviewNote ? html`<div class="tiny">Owner: "${x.reviewNote}"</div>` : ''}</span>
    <span class="cb-amt ${x.kind === 'other_in' ? 'in' : 'out'}">${x.kind === 'other_in' ? '+' : '−'}₹ ${rs(x.amountPaise)}</span></div>`);
  render(cbFrame(biz, b, 'more', html`<div class="cb">
    ${canImport ? html`<section class="card" style="gap:8px">
      <label class="btn" for="cb-sheet" style="justify-content:center">Bring in today's fee sheet</label>
      <input type="file" id="cb-sheet" accept=".xls,.xlsx,.html,.htm,text/html,application/vnd.ms-excel" hidden>
      <div class="tiny">${b.branchName ?? 'Your school'}, ${shortDay(t)}: ${d.fee?.sheetIn ? 'brought in ✓' : 'not brought in yet'}. The FeeDaySheet from the fee software; it replaces only the schools in the file.</div>
      <div class="form-msg" id="cb-sheet-msg"></div></section>` : ''}
    <section class="card cb-card"><div class="cb-hd" style="margin-top:0">My expenses and receipts ${toSet ? html`<span class="chip info">${toSet} waiting</span>` : ''}</div>
      ${lines.length ? lines : html`<div class="list-row"><span class="tiny">None in the last 60 days.</span><span></span></div>`}</section>
    <section class="card" style="gap:8px">
      ${installButton()}
      <button type="button" class="btn plain" id="signout">Sign out</button>
      <div class="tiny">Signed in as ${me.user.name} · ${me.user.email}</div>
    </section></div>`));
  wireShell();
  document.getElementById('cb-sheet')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const msg = document.getElementById('cb-sheet-msg');
    if (!file) return;
    msg.textContent = 'Reading…'; msg.className = 'form-msg';
    try {
      const res = await api('POST', `/businesses/${biz.id}/fees/import`, { fileName: file.name, text: await file.text() });
      go(`#/b/${biz.id}/cashbook/${b.id}/${res.day}`);
      doneToast(`Fee sheet for ${shortDay(res.day)} brought in.${res.also?.length ? ` Also into ${res.also.map((a) => a.name).join(', ')}.` : ''}`, null, null);
    } catch (err) { msg.textContent = err.message; msg.className = 'form-msg error'; e.target.value = ''; }
  });
}

// ---------- Fee check (approved 20 Nov 2026): a day's fee report against where its money should be.

const FEE_MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank', 'Bank transfer'], ['cheque', 'Cheque'], ['other', 'Other']];
async function feesView(biz, dayIn) {
  // From the menu: the latest day brought in.
  if (!isDay(dayIn)) {
    const { days } = await api('GET', `/businesses/${biz.id}/fees/${todayIst()}`);
    return location.replace(`#/b/${biz.id}/fees/${days[0] ?? todayIst()}`);
  }
  const day = dayIn;
  const d = await api('GET', `/businesses/${biz.id}/fees/${day}`);
  const r = d.report;
  const upload = d.can.import ? html`<label class="btn ${r ? 'plain' : ''}" style="display:inline-flex;align-items:center;cursor:pointer">${r ? 'Bring in again' : 'Bring in the fee report'}
      <input type="file" id="fee-file" accept=".xls,.html,.htm,text/html,application/vnd.ms-excel" hidden></label>` : '';
  const dayNav = html`<nav class="cb-day" aria-label="Day" style="max-width:560px">
    <a class="btn plain" href="#/b/${biz.id}/fees/${addDaysIso(day, -1)}" aria-label="Previous day">‹</a>
    <label class="cb-pick">${dayLabel(day)}<input type="date" id="fee-date" value="${day}" max="${todayIst()}" aria-label="Choose a day"></label>
    ${day < todayIst() ? html`<a class="btn plain" href="#/b/${biz.id}/fees/${addDaysIso(day, 1)}" aria-label="Next day">›</a>` : html`<span class="btn plain off">›</span>`}</nav>`;
  let body;
  if (!r) {
    body = html`${dayNav}<section class="card"><div class="note">No fee report for ${dayLabel(day)} yet.${d.can.import ? ' Bring in the FeeDaySheet file from the fee software.' : ''}</div>
      <div>${upload}</div><div class="form-msg" id="fee-msg"></div>
      ${d.days.length ? html`<div class="tiny">Days brought in: ${d.days.slice(0, 10).map((x, i) => html`${i ? ' · ' : ''}<a href="#/b/${biz.id}/fees/${x}">${shortDay(x)}</a>`)}</div>` : ''}</section>`;
  } else {
    const branchOpts = (sel) => html`<option value="">Not this business</option>${d.branches.map((b) => html`<option value="${b.id}" ${sel === b.id ? 'selected' : ''}>${b.name}</option>`)}`;
    const unknown = d.codes.filter((c) => c.state === 'unknown');
    const codesCard = d.codes.length ? html`<section class="card">
      <h2>Schools in this file${unknown.length ? html` <span class="chip wait">${unknown.length} to set</span>` : ''}</h2>
      <div class="tiny">The receipt number says which school it is. Link each code once; codes of your other business are left out here.</div>
      ${d.codes.map((c) => html`<div class="list-row"><span><span class="mono">${c.code}</span> <span class="tiny">· ₹ ${rs(c.paise)}</span></span>
        ${d.can.setup ? html`<select data-feecode="${c.code}" style="max-width:200px">${c.state === 'unknown' ? html`<option value="" selected disabled>Which school?</option>` : ''}${branchOpts(c.branchId)}</select>`
          : html`<span>${c.state === 'ours' ? c.branchName : c.state === 'other' ? 'Not this business' : html`<span class="chip wait">not set</span>`}</span>`}</div>`)}
    </section>` : '';
    const tiles = FEE_MODES.filter(([m]) => d.totals[m]).map(([m, label]) => html`<div class="tile" style="padding:10px"><div class="tiny">${label}</div><div class="amount" style="text-align:left;font-weight:500">₹ ${rs(d.totals[m])}</div></div>`);
    const schools = d.schools.map((s) => html`<div class="list-row"><span>${s.name} <span class="tiny">${FEE_MODES.filter(([m]) => s.byMode[m]).map(([m, l]) => `${l.toLowerCase()} ${rs(s.byMode[m])}`).join(' · ')}</span></span>
      <span class="amount">₹ ${rs(s.totalPaise)}</span></div>`);
    const bookOpts = (sel) => html`<option value="">No book (not a cashier)</option>${d.books.map((b) => html`<option value="${b.id}" ${sel === b.id ? 'selected' : ''}>${b.name}${b.cashierName && b.cashierName !== b.name ? ` (${b.cashierName})` : ''}</option>`)}`;
    const cashiers = d.cashiers.map((x) => {
      const state = !x.cashPaise ? html`<span class="tiny">no cash</span>`
        : x.book ? (x.beforeBook ? html`<span class="chip wait">before ${x.book.name} starts</span>` : html`<a class="chip ok" href="#/b/${biz.id}/cashbook/${x.book.id}/${day}">in ${x.book.name}</a>${x.book.how === 'branch' ? html`<div class="tiny">the branch's book</div>` : ''}`)
          : x.noBook ? html`<span class="chip mute">no book</span>` : html`<span class="chip bad">whose book?</span>`;
      const pick = d.can.setup && x.cashPaise && x.nameKey && (!x.book || x.book.how === 'chosen' || x.book.how === 'branch' || x.noBook)
        ? html`<select data-feecashier="${x.name}" style="max-width:190px;margin-top:4px">${!x.book && !x.noBook ? html`<option value="" selected disabled>Whose book?</option>` : ''}${bookOpts(x.book?.id)}</select>` : '';
      return html`<div class="list-row" style="align-items:flex-start"><span><span style="font-weight:500">${x.name}</span> <span class="tiny">· ${x.schools.join(', ')}</span>
          ${x.otherPaise ? html`<div class="tiny">UPI, card and bank ₹ ${rs(x.otherPaise)}: checked against the bank, not the cash count</div>` : ''}<div>${pick}</div></span>
        <span style="text-align:right"><div class="amount">₹ ${rs(x.cashPaise)}</div>${state}</span></div>`;
    });
    const bank = d.bank.map((x) => html`<div class="list-row" style="align-items:flex-start"><span><span class="mono">${x.receiptNo}</span> <span class="tiny">· ${x.modeText} · ${x.school ?? ''} · ${x.student ?? ''}</span>
        ${x.match ? html`<div class="tiny">${x.match.accountName} · ${shortDay(x.match.day)} · ${x.match.description}${d.can.approve ? html` <button type="button" class="linkbtn tiny" data-feeunmatch="${x.receiptNo}">Undo</button>` : ''}</div>`
          : x.candidates.length ? x.candidates.map((c) => html`<div class="tiny" style="margin-top:4px">${c.accountName} · ${shortDay(c.day)} · ${c.description}
              ${d.can.approve ? html`<button type="button" class="btn ghost" style="min-height:30px" data-feematch="${x.receiptNo}" data-row="${c.id}">Match</button>` : ''}</div>`)
            : html`<div class="tiny">No credit of ₹ ${rs(x.amountPaise)} near ${shortDay(day)} yet. Bring in the bank statement on the Bank page.</div>`}</span>
      <span style="text-align:right"><div class="amount">₹ ${rs(x.amountPaise)}</div>${x.match ? html`<span class="chip ok">in the bank</span>` : html`<span class="chip wait">to match</span>`}</span></div>`);
    const footer = r.footer.filter((f) => f.amountPaise || /total|net/i.test(f.label));
    body = html`${dayNav}
      <div class="row">
        <section class="card grow3">
          <h2>Fees of ${biz.name} <span class="amount" style="float:right">₹ ${rs(d.totalPaise)}</span></h2>
          <div class="tiny">${r.receipts} receipts · ${r.oursLines} of ${r.lines} lines in the file${r.fileName ? ` · ${r.fileName}` : ''}${r.importedByName ? ` · brought in by ${r.importedByName}` : ''}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">${tiles}</div>
          ${schools.length ? html`<div class="cb-hd">By school</div>${schools}` : ''}
          <div class="cb-hd">Cash → cashier books</div>
          ${cashiers.length ? cashiers : html`<div class="note">No receipts of this business's schools yet. Link the codes under Schools in this file.</div>`}
          ${bank.length ? html`<div class="cb-hd">Bank transfer and cheque → bank credit</div>${bank}` : ''}
          ${d.totals.upi || d.totals.card ? html`<div class="cb-hd">UPI and card</div><div class="note">UPI ₹ ${rs(d.totals.upi)} and card ₹ ${rs(d.totals.card)} are matched to the apps' and machines' payouts once their bank accounts are added.</div>` : ''}
          <div>${upload}</div><div class="form-msg" id="fee-msg"></div>
        </section>
        <div class="grow2" style="display:flex;flex-direction:column;gap:16px">
          ${codesCard}
          <section class="card"><h2>The report's own totals</h2><div class="tiny">Whole file, every school in it.</div>
            ${footer.map((f) => html`<div class="list-row" style="align-items:flex-start"><span>${f.label}${f.detail ? html`<div class="tiny">${f.detail}</div>` : ''}</span><span class="amount">₹ ${rs(f.amountPaise)}</span></div>`)}</section>
        </div>
      </div>`;
  }
  render(shell(biz, 'fees', 'Fee check', 'The fee software\'s day against the cashier books and the bank.', body));
  wireShell();
  const reload = () => feesView(biz, day);
  document.getElementById('fee-date')?.addEventListener('change', (e) => { if (isDay(e.target.value)) go(`#/b/${biz.id}/fees/${e.target.value}`); });
  document.getElementById('fee-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    const msg = document.getElementById('fee-msg');
    if (!f) return;
    msg.textContent = 'Reading…'; msg.className = 'form-msg';
    try {
      const res = await api('POST', `/businesses/${biz.id}/fees/import`, { fileName: f.name, text: await f.text() });
      go(`#/b/${biz.id}/fees/${res.day}`);
      if (res.day === day) await reload();
      // The same file is also brought into your other school businesses (21 Nov 2026).
      if (res.also?.length) doneToast(`Also brought into ${res.also.map((a) => `${a.name}: ${a.receipts} receipt${a.receipts === 1 ? '' : 's'}, ₹ ${rs(a.paise)}`).join('; ')}.`, null, null);
    } catch (err) { msg.textContent = err.message; msg.className = 'form-msg error'; }
  });
  const act = (sel, ev, f) => app.querySelectorAll(sel).forEach((x) => x.addEventListener(ev, async () => {
    x.disabled = true;
    try { await f(x); await reload(); } catch (err) { alert(err.message); x.disabled = false; }
  }));
  act('[data-feecode]', 'change', (x) => api('PUT', `/businesses/${biz.id}/fees/codes/${x.dataset.feecode}`, { branchId: x.value || null }));
  act('[data-feecashier]', 'change', (x) => api('PUT', `/businesses/${biz.id}/fees/cashiers`, { name: x.dataset.feecashier, accountId: x.value || null }));
  act('[data-feematch]', 'click', (x) => api('POST', `/businesses/${biz.id}/fees/receipts/${encodeURIComponent(x.dataset.feematch)}/match`, { bankRowId: x.dataset.row }));
  act('[data-feeunmatch]', 'click', (x) => api('DELETE', `/businesses/${biz.id}/fees/receipts/${encodeURIComponent(x.dataset.feeunmatch)}/match`));
}

async function route() {
  const seq = navStart((location.hash || '#/').slice(2).split('/'));
  try { await routeInner(); } finally { if (seq === navSeq) navShown(); }
}

async function routeInner() {
  document.body.classList.remove('review-expanded');
  drawerReload = null;
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/');
  try {
    if (parts[0] === 'invite' && parts[1]) return inviteView(parts[1]);
    if (!me) {
      try { me = await api('GET', '/me'); } catch { me = null; }
    }
    if (!me) return loginView();
    if (parts[0] === 'login') return go('#/choose');
    if (parts[0] === 'b' && parts[1]) {
      const summary = me.businesses.find((b) => b.id === parts[1]);
      if (!summary) return go('#/choose');
      // The business details kept for the session (19 Nov 2026): shown from memory and refreshed in the background
      // after two minutes, so changing pages or dates does not wait on them. The server checks the role on every request.
      const detail = await bizDetail(summary.id);
      const biz = { ...summary, ...detail, actions: summary.actions };
      const [screen, query = ''] = (parts[2] || 'dashboard').split('?');
      // A school (it has cash books) opens on them; a cashier with one book opens straight on today's page of it.
      if (!parts[2] && biz.cashBooks) {
        if (biz.role === 'entry_staff' && biz.myBooks === 1) {
          const { books } = await api('GET', `/businesses/${biz.id}/cashbooks`);
          if (books[0]) return location.replace(`#/b/${biz.id}/cashbook/${books[0].id}/${todayIst()}`);
        }
        // Owner and Accountant open on the school's Today (21 Nov 2026).
        return location.replace(`#/b/${biz.id}/${biz.actions.includes('reports.view') ? 'dashboard' : 'cashbooks'}`);
      }
      if (screen === 'dashboard' && biz.cashBooks && biz.actions.includes('reports.view')) return schoolTodayView(biz);
      if (screen === 'schools' && biz.actions.includes('accounts.edit')) return schoolsView(biz, parts[3]);
      if (screen === 'cashbooks') return cashBooksView(biz, parts[3]);
      if (screen === 'cashbook') return cashBookDayView(biz, parts[3], parts[4]);
      // The cashier's phone bar (21 Nov 2026): Days, Handed over, More.
      if (screen === 'cbdays' && parts[3]) return cbDaysView(biz, parts[3]);
      if (screen === 'cbhanded' && parts[3]) return cbHandedView(biz, parts[3]);
      if (screen === 'cbmore' && parts[3]) return cbMoreView(biz, parts[3]);
      if (screen === 'fees') return feesView(biz, parts[3]);
      if (screen === 'accounts') return accountsView(biz, parts[3]);
      if (screen === 'heads') return headsView(biz, parts[3]);
      if (screen === 'users' && biz.role === 'owner') return usersView(biz, parts[3]);
      const item = NAV.find((n) => n.key === screen || n.screens?.includes(screen));
      if (item?.needs && !biz.actions.includes(item.needs)) return go(home(biz));
      // The old Upload page is gone: Bring in takes every file now.
      if (screen === 'upload') { history.replaceState(null, '', `#/b/${biz.id}/bringin`); return route(); }
      if (screen === 'review') {
        if (parts[3]) return reviewView(biz, parts[3], parts[4]);
        const q = new URLSearchParams(query);
        // From the menu: the day's first register page, if it has one; else the list.
        if (isDay(q.get('day'))) {
          const { uploads } = await api('GET', `/businesses/${biz.id}/uploads`);
          const ofDay = uploads.filter((x) => x.kind !== 'software_sales_csv' && x.day === q.get('day')).sort((a, b) => (a.kind !== 'bill_register') - (b.kind !== 'bill_register') || a.createdAt - b.createdAt);
          const sh = lastSheet(biz.id);
          // The day's register page; with no page that day, the sheet last opened. Replace, so Back does not land here again.
          const target = ofDay[0]?.id ?? (uploads.some((x) => x.id === sh?.id) ? sh.id : null);
          if (target) return location.replace(`#/b/${biz.id}/review/${target}`);
        }
        return reviewListView(biz, q.get('find'));
      }
      // Compare sales moved into Reconcile (approved 10 Nov 2026): its links open the All bills tab. The old page
      // (compare-old) was removed in Stage 6; its links open the same tab.
      if (screen === 'compare' || screen === 'compare-old') {
        const d = isDay(parts[3]) ? parts[3] : lastDay(biz.id);
        if (d) recKeep = { day: d, top: 'all' };
        return location.replace(`#/b/${biz.id}/reconcile${d ? `/${d}` : ''}`);
      }
      if (screen === 'bank') return bankView(biz, query);
      if (screen === 'cards') return cardsView(biz, query);
      if (screen === 'bringin') return bringInView(biz, parts[3]);
      if (screen === 'reconcile' || screen === 'upi') return reconcileView(biz, parts[3]);
      if (screen === 'reports') return reportsView(biz, query);
      if (screen === 'funds') return biz.actions.includes('bank.link') ? fundsView(biz, query) : go(`#/b/${biz.id}/reports`);
      if (screen === 'pending') return biz.actions.includes('sales.view') ? pendingView(biz, query) : go(`#/b/${biz.id}/reports`);
      if (screen === 'bills') return biz.actions.includes('sales.view') ? allBillsView(biz, query) : go(`#/b/${biz.id}/reports`);
      if (screen === 'statement') return biz.actions.includes('bank.link') ? statementView(biz, query) : go(`#/b/${biz.id}/reports`);
      if (screen === 'money-out') return moneyOutView(biz, query);
      if (screen === 'parties') return partiesView(biz, query);
      if (item?.phase) return laterView(biz, screen);
      if (!biz.actions.includes('reports.view')) return go(home(biz));
      return dashboardView(biz);
    }
    if (me.businesses.length === 1 && parts[0] !== 'choose') return go(home(me.businesses[0]));
    return chooseView();
  } catch (e) {
    if (me) render(html`<div class="center"><section class="card"><div class="error">${e.message}</div><a href="#/choose">Back</a></section></div>`);
  }
}

// Bookr on the phone (approved 20 Nov 2026): installable as an app. The service worker keeps only an offline page.
// When the phone offers to install, "Install Bookr on this phone" shows in the business menu and on the cash book.
let installPrompt = null;
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = false; }); });
window.addEventListener('appinstalled', () => { installPrompt = null; document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = true; }); });
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-install]');
  if (!b || !installPrompt) return;
  const p = installPrompt;
  installPrompt = null;
  await p.prompt();
  document.querySelectorAll('[data-install]').forEach((x) => { x.hidden = true; });
});
const installButton = (cls = 'btn plain') => html`<button type="button" class="${cls}" data-install ${installPrompt ? '' : 'hidden'}>Install Bookr on this phone</button>`;

window.addEventListener('hashchange', route);
route();
