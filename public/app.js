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

// A change always goes as JSON (the server refuses anything else, see app.ts), so one with no body sends {}.
const bodyFor = (method, body) => (body === undefined && method !== 'GET' ? {} : body);
async function api(method, path, body) {
  body = bodyFor(method, body);
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && path !== '/me' && !path.startsWith('/auth/') && !path.startsWith('/invites/')) {
    me = null;
    go('#/login');
    throw new Error('Please sign in.');
  }
  if (!res.ok) throw new Error(data?.error ?? 'Something went wrong.');
  return data;
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
const home = (b) => `#/b/${b.id}/${b.actions.includes('reports.view') ? 'dashboard' : b.actions.includes('rows.upload') ? 'bringin' : 'accounts'}`;
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
}

// ---------- shell: sidebar + header with business switcher

const NAV = [
  { key: 'dashboard', label: 'Dashboard', needs: 'reports.view' },
  { key: 'bringin', label: 'Bring in', needs: 'rows.upload' },
  // Review, Compare sales and Reconcile are tabs of one shift (the shift bar at the top of each).
  { key: 'shifts', label: 'Shifts', needs: 'sales.view', screens: ['review', 'compare', 'reconcile'] },
  { key: 'bank', label: 'Bank sync', needs: 'bank.link' },
  { key: 'money-out', label: 'Money out', needs: 'bank.link' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'heads', label: 'Heads and rules' },
  { key: 'reports', label: 'Reports', needs: 'reports.view' },
  { key: 'export', label: 'Export', phase: 5 },
  { key: 'users', label: 'Users and roles', owner: true },
];

// The shift being worked on (7 Nov 2026): Review, Compare sales and Reconcile open on the day last worked on anywhere,
// on this device. Their menu links carry it; the day changes when a page of another day is opened.
const dayKey = (bizId) => `bookr.day.${bizId}`;
const lastDay = (bizId) => { try { const d = localStorage.getItem(dayKey(bizId)); return isDay(d) ? d : null; } catch { return null; } };
const rememberDay = (bizId, day) => { if (!isDay(day)) return; try { localStorage.setItem(dayKey(bizId), day); } catch { /* storage unavailable */ } };
const sheetKey = (bizId) => `bookr.sheet.${bizId}`;
const lastSheet = (bizId) => { try { return JSON.parse(localStorage.getItem(sheetKey(bizId)) ?? 'null'); } catch { return null; } };
const rememberSheet = (bizId, u) => { try { localStorage.setItem(sheetKey(bizId), JSON.stringify({ id: u.id, day: u.day })); } catch { /* storage unavailable */ } };
const screenKey = (bizId) => `bookr.screen.${bizId}`;
const SHIFT_SCREENS = [['review', 'Register', 'rows.edit'], ['compare', 'Compare sales', 'sales.view'], ['reconcile', 'Reconcile', 'bank.link']];
/** Where a shift screen opens for a day. Review: the sheet last opened, if it is of that day; else the day's first page. */
function screenHref(biz, key, day) {
  if (!day) return `#/b/${biz.id}/${key}`;
  if (key !== 'review') return `#/b/${biz.id}/${key}/${day}`;
  const sh = lastSheet(biz.id);
  return sh?.day === day ? `#/b/${biz.id}/review/${sh.id}` : `#/b/${biz.id}/review?day=${day}`;
}
function navHref(biz, key) {
  if (key === 'shifts') {
    let last = null;
    try { last = localStorage.getItem(screenKey(biz.id)); } catch { /* storage unavailable */ }
    const allowed = SHIFT_SCREENS.filter(([, , need]) => biz.actions.includes(need)).map(([k]) => k);
    const k = allowed.includes(last) ? last : allowed.includes('compare') ? 'compare' : allowed[0] ?? 'compare';
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
      <label class="cmp-pick"><span class="sr-only">Shift</span><select data-sbpick><option value="${day}" selected>${dayLabel(day)} shift</option></select></label>
      <a class="btn plain" data-sbstep="1" href="#" aria-label="Next shift">›</a></div>
    <div class="sb-tabs" role="tablist">${tabs.map(([k, label], i) => html`<a role="tab" class="${k === screen ? 'on' : ''}" aria-selected="${k === screen}" href="${screenHref(biz, k, day)}">
      <span class="sb-i">${i + 1}</span>${label}<span class="sb-n" data-sbn="${k}"></span></a>`)}</div>
  </nav>`;
}
async function wireShiftBar(biz, days = null) {
  const bar = document.querySelector('.shiftbar');
  if (!bar) return;
  const day = bar.dataset.day;
  const screen = bar.dataset.screen;
  const [list, p] = await Promise.all([days ? { shifts: days.map((d) => ({ day: d })) } : api('GET', `/businesses/${biz.id}/shifts`).catch(() => ({ shifts: [] })),
    api('GET', `/businesses/${biz.id}/shifts/${day}/progress`).catch(() => null)]);
  if (!bar.isConnected) return;
  const all = [...new Set([day, ...list.shifts.map((x) => x.day)])].sort();
  const pick = bar.querySelector('[data-sbpick]');
  pick.innerHTML = html`${[...all].reverse().map((d) => html`<option value="${d}" ${d === day ? 'selected' : ''}>${dayLabel(d)} shift</option>`)}`.__html;
  const to = (d) => go(screenHref(biz, screen, d));
  pick.addEventListener('change', () => to(pick.value));
  bar.querySelectorAll('[data-sbstep]').forEach((a) => {
    const d = all[all.indexOf(day) + Number(a.dataset.sbstep)];
    if (!d) { a.classList.add('off'); a.removeAttribute('href'); return; }
    a.title = dayLabel(d);
    a.addEventListener('click', (e) => { e.preventDefault(); to(d); });
  });
  if (!p) return;
  const set = (k, text, cls) => { const el = bar.querySelector(`[data-sbn="${k}"]`); if (el) { el.textContent = text; el.className = `sb-n ${cls}`; } };
  set('review', !p.rows ? 'no page' : p.toCheck ? `${p.toCheck} to check` : '✓', p.rows && !p.toCheck ? 'ok' : p.toCheck ? 'wait' : '');
  set('compare', p.status === 'confirmed' ? 'confirmed ✓' : p.toDecide ? `${p.toDecide} to decide` : 'ready to confirm', p.status === 'confirmed' ? 'ok' : p.toDecide ? 'wait' : '');
  if (p.bank) {
    const left = p.bank.billsLeft + p.bank.creditsLeft;
    set('reconcile', p.status !== 'confirmed' ? 'after confirming' : left ? `${left} left` : '✓', p.status !== 'confirmed' ? '' : left ? 'wait' : 'ok');
  }
}

function shell(biz, current, title, subtitle, body, opts = {}) {
  const nav = NAV.filter((n) => (!n.owner || biz.role === 'owner') && (!n.needs || biz.actions.includes(n.needs))).map((n) => html`
    <a class="nav ${(n.screens ?? [n.key]).includes(current) ? 'on' : ''}" href="${navHref(biz, n.key)}">
      <span>${n.label}</span>${n.phase ? html`<span class="soon">Phase ${n.phase}</span>` : ''}
    </a>`);
  const others = me.businesses.map((b) => html`
    <a href="#/b/${b.id}/${current}" class="${b.id === biz.id ? 'on' : ''}"><span>${b.name}</span><span class="chip">${ROLE_LABELS[b.role]}</span></a>`);
  return html`
  <div class="shell">
    <aside class="side">
      <div class="brand">Bookr</div>
      ${nav}
      <div class="side-foot">Signed in as<br>${ROLE_LABELS[biz.role]} · ${biz.name}<br>
        <span class="tiny">${me.user.email}</span><br>
        <button id="signout" type="button">Sign out</button>
      </div>
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
          </div>
        </div>
      </div>
      ${body}
    </main>
  </div>`;
}

function wireShell() {
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
      <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" autocomplete="username" placeholder="name@example.com" required></div>
      <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <span class="note">Forgot password? Ask the Owner of your business to send a new invite.</span>
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

async function dashboardView(biz) {
  const [{ accounts, heads }, waiting] = await Promise.all([api('GET', `/businesses/${biz.id}/dashboard`),
    biz.actions.includes('sales.view') ? api('GET', `/businesses/${biz.id}/waiting-bills`).catch(() => null) : null]);
  const late = waiting?.bills.filter((b) => b.unresolved).length ?? 0;
  const total = accounts.reduce((s, a) => s + a.openingBalancePaise, 0);
  render(shell(biz, 'dashboard', 'Dashboard', 'Totals, the weekly chart and items needing attention arrive in Phase 4.', html`
    ${waiting?.bills.length ? html`<section class="card" style="margin-bottom:16px;gap:6px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <h2>Bills waiting for their other side</h2>${late ? html`<span class="chip bad">${late} over ${waiting.watchDays} days</span>` : ''}</div>
      <div class="note">${waiting.bills.length} bill${waiting.bills.length === 1 ? ' was' : 's were'} found only in the software report or only in the register. <a href="#/b/${biz.id}/compare/${waiting.bills[0].day}">See them on Compare sales</a>.</div></section>` : ''}
    <div class="row">
      <section class="card grow1">
        <h2>Opening balances</h2>
        ${accounts.map((a) => html`<div class="list-row"><span>${a.name}</span><span class="amount">₹ ${money(a.openingBalancePaise)}</span></div>`)}
        <div class="list-row" style="font-weight:600"><span>Combined</span><span class="amount">₹ ${money(total)}</span></div>
      </section>
      <section class="card grow1">
        <h2>Set up</h2>
        <div class="list-row"><span>Accounts</span><span>${accounts.length}</span></div>
        <div class="list-row"><span>Income heads</span><span>${heads.income}</span></div>
        <div class="list-row"><span>Expense heads</span><span>${heads.expense}</span></div>
        <div class="note"><a href="#/b/${biz.id}/accounts">Accounts</a> · <a href="#/b/${biz.id}/heads">Heads and rules</a></div>
      </section>
    </div>`));
  wireShell();
}

async function accountsView(biz, editId) {
  const { accounts } = await api('GET', `/businesses/${biz.id}/accounts`);
  const canEdit = biz.actions.includes('accounts.edit');
  const editing = accounts.find((a) => a.id === editId);
  const rows = accounts.map((a) => html`
    <tr>
      <td><div style="font-weight:500">${a.name}</div>${a.accountNumber ? html`<div class="note mono">${a.accountNumber}</div>` : ''}</td>
      <td>${a.kind === 'cash' ? 'Cash' : 'Bank'}</td>
      <td class="mono">${a.openingDate}</td>
      <td class="amount">₹ ${money(a.openingBalancePaise)}</td>
      <td style="text-align:right">${canEdit ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/accounts/${a.id}">Edit</a>` : ''}</td>
    </tr>`);
  const f = editing ? { ...editing, openingBalance: rupeesForInput(editing.openingBalancePaise) } : { name: '', kind: 'bank', accountNumber: '', openingBalance: '0.00', openingDate: biz.fyStart };
  render(shell(biz, 'accounts', 'Accounts', canEdit ? 'Cash and each bank account, with the balance on the opening date.' : 'Only Owner and Accountant can change these.', html`
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
          <div class="field"><label for="ad">Opening date</label><input id="ad" name="openingDate" type="date" value="${f.openingDate}" required></div>
        </div>
        <div class="form-msg"></div>
        <div class="form-row">
          <button class="btn" type="submit">${editing ? 'Save account' : 'Add account'}</button>
          ${editing ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/accounts">Cancel</a>` : ''}
        </div>
      </form>` : ''}
    </div>`));
  wireShell();
  const form = document.getElementById('acct');
  form && onSubmit(form, async (d) => {
    if (editing) await api('PATCH', `/businesses/${biz.id}/accounts/${editing.id}`, d);
    else await api('POST', `/businesses/${biz.id}/accounts`, d);
    go(`#/b/${biz.id}/accounts`);
  });
}

async function headsView(biz, editId) {
  const [{ heads }, { billTypeHeads }, { parties }, { rules }] = await Promise.all([
    api('GET', `/businesses/${biz.id}/heads`),
    api('GET', `/businesses/${biz.id}/bill-type-heads`),
    api('GET', `/businesses/${biz.id}/parties`),
    api('GET', `/businesses/${biz.id}/rules`),
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
        <div class="note">Rules suggest a head for bank lines on Bank sync; a person books them. Make one from any bank line with "Make a rule".</div>
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
        <div style="border-top:1px solid var(--line-soft);padding-top:14px;display:flex;flex-direction:column;gap:8px">
          <h2>Parties</h2>
          <div class="note">Each party is remembered under the heads it is booked to, e.g. Blinkit under Kitchen purchases and Housekeeping. Its first head is its main head. With several heads, a line gets the head its item had before, or a one-click choice.${canEdit ? ' Change the main head or rename a party here.' : ''}</div>
          ${parties.length ? parties.map((p) => html`<div class="form-row" style="align-items:center;border-top:1px solid var(--line-soft);padding-top:8px">
            ${canEdit ? html`<input class="cell" data-vname="${p.id}" value="${p.name}" style="width:180px" aria-label="Party name">` : html`<span style="width:180px">${p.name}</span>`}
            ${canEdit ? html`<select class="compact" data-vhead="${p.id}" aria-label="Main head for ${p.name}" title="Main head: used when the party has only one, and offered first"><option value="">No head yet</option>
              ${heads.filter((h) => h.type === 'expense').map((h) => html`<option value="${h.id}" ${p.defaultHeadId === h.id ? 'selected' : ''}>${h.name}</option>`)}</select>`
              : html`<span>${heads.find((h) => h.id === p.defaultHeadId)?.name ?? 'No head yet'}</span>`}
            <span class="note">${p.lines} line${p.lines === 1 ? '' : 's'}${(p.heads ?? []).length > 1 ? ` · used under ${p.heads.map((x) => `${heads.find((h) => h.id === x.headId)?.name ?? '?'} (${x.lines})`).join(', ')}` : ''}</span>
          </div>`) : html`<div class="note">No parties yet. Add one by naming the party on an expense line.</div>`}
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

/** Reports: discounts over the limit, for a person to look through. They need no decision on Compare sales. */
async function reportsView(biz, query) {
  const q = new URLSearchParams(query);
  const range = new URLSearchParams({ from: q.get('from') ?? '', to: q.get('to') ?? '' });
  const [r, m] = await Promise.all([api('GET', `/businesses/${biz.id}/reports/large-discounts?${range}`), api('GET', `/businesses/${biz.id}/reports/missed?${range}`)]);
  const total = r.lines.reduce((t, l) => t + l.discountPaise, 0);
  render(shell(biz, 'reports', 'Reports', '', html`
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
    </section>`));
  wireShell();
  // Both reports share one range: either form sets it.
  document.querySelectorAll('#repdates, #missed .repdates').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = new FormData(e.target);
    location.hash = `#/b/${biz.id}/reports?${new URLSearchParams({ from: d.get('from'), to: d.get('to') })}`;
  }));
}

/**
 * Money out: every payment from a bank account or from Cash in one list, read-only. Each line links to where it is
 * handled (Bank sync for the shift, the expense-list page on Review, Compare sales for a cash shortage).
 */
const MONEY_OUT_STATUS = {
  not_booked: ['wait', 'Not booked yet'], booked: ['ok', 'Booked'], matched: ['ok', 'Matched'], left_out: ['', 'Left out'],
  draft: ['wait', 'Draft, not approved'], approved: ['ok', 'Approved'],
};
async function moneyOutView(biz, query) {
  const q = new URLSearchParams(query);
  const pick = (k) => q.get(k) ?? '';
  const r = await api('GET', `/businesses/${biz.id}/money-out?${new URLSearchParams({ from: pick('from'), to: pick('to'), account: pick('account'), head: pick('head'), party: pick('party'), waiting: pick('waiting') })}`);
  const f = r.filters;
  const link = (over) => `#/b/${biz.id}/money-out?${new URLSearchParams({ from: r.from, to: r.to, account: f.account ?? '', head: f.head ?? '', party: f.party ?? '', waiting: f.waiting ? '1' : '', ...over })}`;
  const where = (l) => {
    if (l.source === 'bank') return `#/b/${biz.id}/bank?${new URLSearchParams({ from: l.day, to: l.day, account: l.accountId, tab: l.status === 'not_booked' ? 'out' : 'done' })}`;
    if (l.source === 'cash_photo' && l.uploadId) return `#/b/${biz.id}/review/${l.uploadId}`;
    return `#/b/${biz.id}/compare/${l.day}`;
  };
  const whereLabel = (l) => (l.source === 'bank' ? (l.status === 'not_booked' ? 'Book on Bank sync' : 'Bank sync') : l.source === 'cash_photo' ? 'Expense page' : 'Cash for the shift');
  const opt = (v, label, cur) => html`<option value="${v}" ${v === (cur ?? '') ? 'selected' : ''}>${label}</option>`;
  const subtotal = (title, groups, key) => html`<div style="flex:1 1 280px;min-width:0">
    <h3 style="margin:0 0 6px;font-size:15px">${title}</h3>
    <table><tbody>${groups.map((g) => html`<tr>
      <td><a href="${link({ [key]: g.id })}">${g.name}</a> <span class="tiny">${g.count}</span></td><td class="amount">${money(g.paise)}</td></tr>`)}</tbody></table></div>`;
  const filtered = f.account || f.head || f.party || f.waiting;
  render(shell(biz, 'money-out', 'Money out', '', html`
    <section class="card" style="gap:10px">
      <h2>All payments</h2>
      <div class="note">Every payment from a bank account or from Cash, by shift (8 am to 8 am). A bank line booked to a head is one payment, shown once. Booking stays on Bank sync and Review.</div>
      <form id="moform" class="form-row" style="align-items:flex-end">
        <div class="field"><label for="mofrom">From shift</label><input id="mofrom" type="date" name="from" value="${r.from}" required></div>
        <div class="field"><label for="moto">To shift</label><input id="moto" type="date" name="to" value="${r.to}" required></div>
        <div class="field"><label for="moacc">Paid from</label><select id="moacc" name="account">${opt('', 'All accounts', f.account)}${r.options.accounts.map((a) => opt(a.id, a.name, f.account))}</select></div>
        <div class="field"><label for="mohead">Head</label><select id="mohead" name="head">${opt('', 'All heads', f.head)}${opt('none', 'No head yet', f.head)}${r.options.heads.map((h) => opt(h.id, h.name, f.head))}</select></div>
        <div class="field"><label for="moparty">Party</label><select id="moparty" name="party">${opt('', 'All parties', f.party)}${opt('none', 'No party', f.party)}${r.options.parties.map((p) => opt(p.id, p.name, f.party))}</select></div>
        <label style="display:flex;gap:6px;align-items:center;min-height:44px;white-space:nowrap"><input type="checkbox" name="waiting" value="1" style="width:18px;height:18px;min-height:0" ${f.waiting ? 'checked' : ''}> Not booked yet</label>
        <button class="btn plain" type="submit">Show</button>
      </form>
      <div class="note"><strong>${r.total.count} payment${r.total.count === 1 ? '' : 's'} · ₹ ${money(r.total.paise)}</strong>
        ${r.waiting.count && !f.waiting ? html` · <a href="${link({ waiting: '1' })}">${r.waiting.count} not booked or approved yet</a> (₹ ${money(r.waiting.paise)})` : ''}
        ${r.leftOut.count ? html` · ${r.leftOut.count} bank line${r.leftOut.count === 1 ? '' : 's'} left out, not counted (₹ ${money(r.leftOut.paise)})` : ''}
        ${filtered ? html` · <a href="${`#/b/${biz.id}/money-out?${new URLSearchParams({ from: r.from, to: r.to })}`}">Clear filters</a>` : ''}</div>
      ${r.total.count ? html`<div style="display:flex;flex-wrap:wrap;gap:16px 28px">
        ${subtotal('By head', r.byHead, 'head')}${subtotal('By paid from', r.byAccount, 'account')}</div>` : ''}
    </section>
    <section class="card" style="gap:10px">
      ${r.lines.length ? html`<ul class="mo-list">${r.lines.map((l) => {
        const [cls, label] = MONEY_OUT_STATUS[l.status] ?? ['', l.status];
        return html`<li class="${l.status === 'left_out' ? 'off' : ''}">
          <div class="mo-top"><span>${dayLabel(l.day)}${l.at ? html` <span class="tiny">${when(l.at).replace(/^.*?,\s*/, '')}</span>` : ''}</span><strong class="amount">₹ ${money(l.amountPaise)}</strong></div>
          <div>${l.narration || html`<span class="note">No item written</span>`}</div>
          <div class="tiny">${[l.accountName, l.head ?? 'No head yet', l.party].filter(Boolean).join(' · ')}</div>
          <div class="mo-top"><span><span class="chip ${cls}">${label}</span>${l.note ? html` <span class="tiny">${l.note}</span>` : ''}</span><span class="tiny"><a href="${where(l)}">${whereLabel(l)}</a></span></div></li>`;
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
            <div class="tiny"><a href="${where(l)}">${whereLabel(l)}</a></div></td></tr>`;
        })}</tbody>
      </table></div>` : html`<div class="ok-msg">No money out in these shifts${filtered ? ' with these filters' : ''}.</div>`}
    </section>`));
  wireShell();
  const form = document.getElementById('moform');
  const show = () => {
    const d = new FormData(form);
    location.hash = link({ from: d.get('from'), to: d.get('to'), account: d.get('account'), head: d.get('head'), party: d.get('party'), waiting: d.get('waiting') ? '1' : '' });
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); show(); });
  form.querySelectorAll('select, input[type=checkbox]').forEach((el) => el.addEventListener('change', show));
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
      <div class="sub">You have been invited as <strong>${ROLE_LABELS[info.role]}</strong> using ${info.email}.</div>
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
    go('#/choose');
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
async function apiFull(method, path, body) {
  body = bodyFor(method, body);
  const res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error ?? 'Something went wrong.'); e.problems = data?.problems; throw e; }
  return data;
}

const MAX_FILES = 10;

/**
 * Reads uploaded pages with Claude, a few at a time (the server's limit), waiting and trying again when it is busy.
 * Runs in this browser: a page closed before its turn stays "not read" and can be read later.
 */
async function readPages(biz, items) {
  const status = await api('GET', `/businesses/${biz.id}/ocr`).catch(() => null);
  if (!status?.configured) { items.forEach((x) => x.set('Uploaded', 'Not read: reading is not set up. Type the rows in on Review.')); return; }
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
          if (/being read already|already being read/.test(err.message) && attempt < 5) { x.set('Waiting to read…'); await new Promise((res) => setTimeout(res, 15000)); continue; }
          x.set('Uploaded', `Not read: ${err.message}`);
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
      wireCashPanel(biz, u.day, () => reviewView(biz, u.id), document.getElementById('rmsg'));
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
    ${notices.map((n) => html`<div class="demo-band">${n.text.replace(n.day, dayLabel(n.day))}</div>`)}
    <section class="card" style="gap:4px">
      <h2 style="margin-bottom:8px">Software sales reports</h2>
      ${csvs.length ? csvs.map((u) => { const r = u.report; return html`
        <div class="list-row">
          <span><strong>${when(r.coversFrom)} to ${when(r.coversTo)}</strong> · ${u.rows} bill${u.rows === 1 ? '' : 's'}
            <br><span class="note">${r.added} new, ${r.skipped} already imported (skipped), ${r.flagged} with different values${r.openConflicts ? html` · <span class="error">${r.openConflicts} still to decide</span>` : ''}${r.replacedBy ? ' · replaced by a corrected file' : ''}</span></span>
          <span style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${r.shiftDays.map((d) => html`<a href="#/b/${biz.id}/compare/${d}">Compare ${dayLabel(d)} shift</a>`)}${deleteButton(biz, u)}</span>
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
  if (bm && !bm.exact && isOldPos(r.billNo)) info.push('Old POS bill');
  else if (!bm?.exact && isOddBill(r.billNo) && r.numberSettled) info.push(r.numberSettled); // a person settled it on Compare
  else if (!bm && isOddBill(r.billNo)) {
    flags.bill_no = 'red';
    red.push(html`Number is neither new POS (date and running number) nor old POS (6 digits)`);
  } else if (bm && !bm.exact) {
    flags.bill_no = 'red';
    red.push(html`${isOddBill(r.billNo) ? 'Number is neither new POS (date and running number) nor old POS (6 digits)' : 'Not in software report'}${bm.options.length ? html`<span class="chips">${bm.options.slice(0, 4).map((x) => html`<button type="button" class="pickchip ${x.taken ? 'taken' : ''}" data-pick="${x.billNo}" title="${why[x.why] ?? ''}${x.taken ? ' · already on another register line: one of the two may be wrong, or the bill was written twice' : ''}">${x.billNo} · ${rs(x.amountPaise)}${x.amountMatches ? ' ✓' : ''}${x.taken ? ' · on register' : ''}</button>`)}</span>` : ''}`);
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
  if (!member && largePct(r)) { flags.discount = 'red'; red.push(`Discount ${largePct(r)}%${ms.length ? ' on these bills' : ''}: was a payment missed?`); }
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
  if (inf.has('discount') && !largePct(r)) flags.discount ??= 'amber'; // a worked-out discount is only tinted, not spelled out
  if (inf.has('payments') && !r.paidWithRowId && o.movedFromRow) { flags.payments ??= 'amber'; amber.push('Payment moved from the next line'); }
  if (r.bankAdjusted) info.push('Adjusted from bank on Reconcile');
  return { red, amber, info, flags, needsYou: red.length > 0 && r.status !== 'checked' };
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
  const total = grp.length > 1 && grp[grp.length - 1].id === r.id ? groupTotalHtml(lead) : '';
  return html`${regLineHtml(r, locked, x, cols, head, cls)}${total}`;
}

/** Under the last row of a group paid together: what the bills come to against what was paid. */
function groupTotalHtml(lead) {
  const all = [lead, ...membersOf(lead)];
  const bills = groupNet(lead);
  const paid = paidOf(lead);
  const diff = paid - bills;
  const ok = diff === 0;
  return html`<tr class="grptotal ${ok ? 'ok' : 'bad'}" aria-label="Group total"><td class="ln"></td><td colspan="12">Group of ${all.length} bills: ₹ ${rs(bills)} · paid ₹ ${rs(paid)} ·
    ${ok ? '✓ matches' : `₹ ${rs(Math.abs(diff))} ${diff > 0 ? 'over' : 'short'}`}</td></tr>`;
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

/** Bills of the old POS: 6-digit numbers, never in the software report. Shown as such, not as missing. */
const startsWithDate = (b) => {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(b);
  if (!m || +m[1] < 24) return false;
  const d = new Date(Date.UTC(2000 + +m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const isOldPos = (b) => /^\d{6}$/.test(b ?? '') && !startsWithDate(b); // mirrors src/sales.ts
const isNewPos = (b) => /^\d{7,9}$/.test(b ?? '') && startsWithDate(b);
/** A number of neither format, new POS (YYMMDD and a running number) nor old POS. It can never meet a software bill. */
const isOddBill = (b) => !!b && !isNewPos(b) && !isOldPos(b);
const SHORT_OLD_POS_NOTE = 'Old POS bill, short number';
const OLD_POS_NOTE = 'Old POS bill';
/** Why a register number may be a typo. Bookr changes nothing: a person checks it against the photo. */
function numberFlagText(f) {
  const where = () => (f.sameShift ? "in this shift's report" : `waiting on ${dayLabel(f.day)}`);
  if (f.kind === 'pending') return `Could be ${f.billNo}: ${where()}, same amount ₹ ${rs(f.amountPaise)}.`;
  if (f.kind === 'pending_typo') return `One digit off ${f.billNo}: ${where()}, same amount ₹ ${rs(f.amountPaise)}.`;
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
      cards.push({ key: `rv:two:${no}`, kind: 'two', title: `Bill ${no} has two amounts`, reason: 'Same number, different amounts', rows, software,
        note: 'Bookr cannot tell which is right. Open each row and compare it with the photo.' });
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
        <colgroup><col style="width:34px"><col style="width:112px"><col style="width:88px"><col style="width:76px"><col style="width:78px"><col style="width:78px"><col style="width:78px"><col style="width:70px"><col style="width:70px"><col style="width:130px"><col><col style="width:44px"><col style="width:84px"></colgroup>
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
  const compare = html`<a href="#/b/${biz.id}/compare/${u.day}">Compare sales →</a>`;
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
  const save = (tr, changed, extra = {}) => {
    const id = tr.dataset.row;
    const r = u.rows.find((x) => x.id === id);
    // Discount follows the payments: amount − payments, negative when more was paid (a tip). Not for bills paid together.
    if (/^(amount|pay\d)$/.test(changed.dataset.f) && !r.paidWithRowId && !membersOf(r).length) {
      const a = parsePaiseText(val(tr, 'amount').value);
      const paid = PAY_COLS.reduce((t, _, i) => t + (val(tr, `pay${i}`)?.value ?? '').split('+').reduce((t2, v) => t2 + (parsePaiseText(v.trim() || '0') ?? 0), 0), 0);
      if (a !== null && paid > 0) val(tr, 'discount').value = paid !== a ? rupeesForInput(a - paid) : '';
    }
    const body = { ...payloadOf(tr, r), ...extra };
    // Saves go one at a time, in the order made. The rows are fetched again only after the last one, so an
    // earlier save's answer never redraws a row whose later change (a tick, a number) is still on its way.
    pending += 1;
    const run = chain.then(async () => {
      try {
        await apiFull('PUT', `/businesses/${biz.id}/register-rows/${id}`, body);
        document.getElementById('rmsg').innerHTML = '';
      } catch (err) {
        // Not saved: what was typed stays on screen with the reason, to be fixed, rather than snapping back.
        showError(document.getElementById('rmsg'), err);
        tr.classList.add('save-failed');
        // A tick that was refused comes off, so the row does not look checked.
        if (changed.dataset.f === 'checked') changed.checked = false;
        const cell = tr.querySelector('.c-is');
        if (cell) cell.innerHTML = html`<div class="error">Not saved: ${err.message}</div>`.__html + cell.innerHTML;
        return;
      }
      if (pending > 1) return;
      const fresh = await api('GET', `/businesses/${biz.id}/uploads/${u.id}`).catch(() => null);
      if (!fresh || pending > 1) return; // another save started meanwhile: it fetches and redraws
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
    tr.querySelector('[data-addbelow]')?.addEventListener('click', async () => {
      try {
        const { id } = await api('POST', `/businesses/${biz.id}/register-rows/${tr.dataset.row}/insert-below`, {});
        await reviewView(biz, u.id, id);
      } catch (err) { showError(document.getElementById('rmsg'), err); }
    });
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
        <thead><tr><th>#</th><th>Item</th><th>Party</th><th style="text-align:right">Amount</th><th>Head</th><th>Status</th><th></th></tr></thead>
        <tbody>${u.rows.map((r) => { const q = unclearOf(r.ocrOriginal, r.status === 'draft' && !r.headId); const read = readVendor(r); return html`<tr>
          <td class="note">${r.lineNo}</td><td>${needs(q, 'item', r.narration || '—')}</td>
          <td>${r.vendor ?? (read ? html`<span class="chip wait" title="Read from the page; not a known party yet. Edit the line to keep it.">${read}?</span>` : html`<span class="note">—</span>`)}</td>
          <td class="amount">${needs(q, 'amount', money(r.amountPaise))}</td>
          <td>${name(r.headId) ? html`${name(r.headId)}${r.status === 'draft' && inferredOf(r.ocrOriginal).has('head') ? html` <span class="chip wait" title="Filled in from how this party was booked before">Learned</span>` : ''}`
            : headChoices(r).length > 1 && r.status === 'draft' ? html`<div style="display:flex;flex-wrap:wrap;gap:4px">${headChoices(r).map((hid) => html`<button class="btn plain" type="button" style="min-height:32px;font-size:13px;padding:0 8px" data-quickhead="${r.id}" data-head="${hid}" title="${r.vendor} is used under this head">${name(hid)}</button>`)}</div>`
            : html`<span class="chip bad">Needs input</span>`}</td>
          <td>${r.status === 'approved' ? html`<span class="chip ok">Approved</span>` : html`<span class="chip wait">Draft</span>`}</td>
          <td style="text-align:right">${r.status === 'draft' ? html`<button class="btn plain" type="button" data-eedit="${r.id}">Edit</button>` : ''}</td>
        </tr>`; })}</tbody>
      </table></div>
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
        <div class="form-row"><button class="btn" type="submit">Save line</button><button class="btn danger" type="button" id="edel" hidden>Delete line</button></div>
      </form>
      ${drafts.length ? html`<div class="form-row" style="justify-content:space-between;border-top:1px solid var(--line-soft);padding-top:12px">
        <div class="note">${drafts.length - ready.length ? `${drafts.length - ready.length} line${drafts.length - ready.length > 1 ? 's need' : ' needs'} a head before approval.` : 'All draft lines have a head.'}</div>
        ${canApprove ? html`<button class="btn" type="button" id="eapprove" ${ready.length ? '' : 'disabled'}>Approve ${ready.length} ready line${ready.length === 1 ? '' : 's'}</button>` : html`<span class="note">An Owner or Accountant approves these.</span>`}
      </div>` : ''}
    </section>`;
}

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
    if (editing) { document.getElementById('etitle').textContent = `Edit line ${u.rows.find((x) => x.id === editing)?.lineNo ?? ''}`; document.getElementById('edel').hidden = false; }
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
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
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

function summaryPanel(biz, u) {
  const s = u.summary;
  const v = (p) => (p == null ? '' : rupeesForInput(p));
  const failing = u.checks.filter((c) => c.state === 'fail');
  const waiting = u.checks.filter((c) => c.state === 'waiting');
  const approved = s.status === 'approved';
  return html`
    <section class="card grow3" style="gap:14px">
      <form id="sform" class="inset">
        <div style="font-size:15px;font-weight:600">Figures written on the page (₹)</div>
        <div class="form-row">
          ${[['opening', 'Opening balance', s.openingPaise, 'opening'], ['received', 'Received total', s.receivedPaise, 'received'], ['balance', 'Balance', s.balancePaise, 'balance'], ['expenses', 'Expenses total', s.expensesPaise, 'expenses'], ['cashInHand', 'Cash in hand', s.cashInHandPaise, 'cash_in_hand']]
            .map(([k, l, p, f]) => html`<div class="field"><label>${needs(unclearOf(s.ocrOriginal, s.status === 'draft'), f, l)}</label><input name="${k}" class="mono" value="${v(p)}" ${approved ? 'disabled' : ''}></div>`)}
        </div>
        ${s.status === 'draft' && s.openingPaise != null ? html`<div class="note">Check each figure against the photo, then press Save figures. Approval needs a person to have saved them.</div>` : ''}
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
  form && onSubmit(form, async (d) => { await api('PUT', `/businesses/${biz.id}/cash-summaries/${u.summary.id}`, d); reviewView(biz, u.id); });
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
  return html`<div class="tiny" style="color:${warn ? 'var(--danger)' : 'var(--teal)'};white-space:normal">${o.billNo !== c.billNo ? `Bill ${o.billNo} ` : ''}in the ${dayLabel(o.day)} ${o.side === 'software' ? 'software report' : 'register'}: ₹ ${money(o.amountPaise ?? 0)}${o.mode ? ` ${MODE_LABELS[o.mode] ?? o.mode}` : ''} · ${what}</div>`;
}

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
        <td class="mono">${b.billNo}</td><td><a href="#/b/${biz.id}/compare/${b.day}">${dayLabel(b.day)}</a>${b.confirmed ? html` <span class="note">confirmed</span>` : ''}</td>
        <td class="amount">${money(b.amountPaise ?? 0)}${b.mode ? html` <span class="note">${MODE_LABELS[b.mode] ?? b.mode}</span>` : ''}</td>
        <td class="note">${b.note ?? ''}</td>
        <td>${canDecide ? html`<button class="btn plain" type="button" data-oddclose="${b.id}">${SHORT_OLD_POS_NOTE}</button>` : ''}</td>
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}

function waitingHtml(biz, w, canDecide) {
  if (!w?.bills?.length) return '';
  const what = (b) => ({ use_software: 'Counted (Use software)', use_register: 'Counted (Use register)', carry_forward: 'Carried forward, not counted', leave_out: `Left out${b.note ? `: ${b.note}` : ''}` })[b.decision];
  const late = w.bills.filter((b) => b.unresolved).length;
  return html`<section class="card" id="waiting" style="gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2>Bills waiting for their other side</h2>
      ${late ? html`<span class="chip bad">${late} over ${w.watchDays} days</span>` : html`<span class="note">Watched for ${w.watchDays} days</span>`}</div>
    <div class="note">Each bill was found only in the software report or only in the register. When it turns up on another day, that day's Compare sales offers to match it, and a bill is never counted twice.</div>
    <div class="scroll"><table style="min-width:640px">
      <thead><tr><th>Bill</th><th>Shift</th><th>Found in</th><th style="text-align:right">Amount</th><th>Decided</th><th>Waiting</th><th></th></tr></thead>
      <tbody>${w.bills.map((b) => html`<tr>
        <td class="mono">${b.billNo}</td><td><a href="#/b/${biz.id}/compare/${b.day}">${dayLabel(b.day)}</a></td>
        <td>${b.side === 'software' ? 'Software only' : 'Register only'}</td><td class="amount">${money(b.amountPaise ?? 0)}${b.mode ? html` <span class="note">${MODE_LABELS[b.mode] ?? b.mode}</span>` : ''}</td>
        <td class="note">${what(b)}</td>
        <td>${b.unresolved ? html`<span class="chip bad">${b.daysWaiting} days</span>` : html`<span class="note">${b.daysWaiting} day${b.daysWaiting === 1 ? '' : 's'}</span>`}</td>
        <td>${b.unresolved && canDecide ? html`<button class="btn plain" type="button" data-closebill="${b.id}" data-bill="${b.billNo}">Close with a reason</button>` : ''}</td>
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}

// ---------- Cash for a shift: should be in hand against counted

function cashPanelHtml(biz, k) {
  const row = (label, sub, paise, extra = '', strong = false) => html`<tr style="${strong ? 'font-weight:600' : ''}">
    <td>${label}</td><td class="note">${sub}</td><td class="amount">${paise == null ? '—' : money(paise)}</td><td>${extra}</td></tr>`;
  const diff = k.differencePaise;
  const state = diff === null ? null : diff === 0 ? 'ok' : k.settled ? 'accepted' : diff < 0 ? 'short' : 'over';
  const chipFor = { ok: html`<span class="chip ok">Cash agrees</span>`, accepted: html`<span class="chip ok">Difference accepted</span>`,
    short: html`<span class="chip bad">Short</span>`, over: html`<span class="chip wait">More than expected</span>` };
  return html`<section class="card" id="cashpanel" style="gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2>Cash for the ${dayLabel(k.day)} shift</h2>${state ? chipFor[state] : ''}</div>
    ${!k.confirmed ? html`<div class="note">Cash sales are not final until the shift is confirmed above. The check below completes after that.</div>` : ''}
    <div class="scroll"><table style="min-width:560px">
      ${row('Opening cash', k.openingFrom === 'previous' ? 'previous day\'s cash in hand' : k.openingFrom === 'page' ? 'opening written on this day\'s cash page' : 'no cash summary for the previous day', k.openingPaise)}
      ${row('+ Cash sales', 'confirmed for this shift', k.cashSalesPaise)}
      ${k.notInRegisterBookedPaise ? row('', `of which not in the register (Use software)`, k.notInRegisterBookedPaise, html`<span class="chip bad">${k.notInRegister.filter((x) => x.decision === 'use_software').length} bill${k.notInRegister.filter((x) => x.decision === 'use_software').length > 1 ? 's' : ''}</span>`) : ''}
      ${row('− Cash expenses', `approved lines${k.expensesWaiting ? `; ${k.expensesWaiting} still waiting for approval` : ''}`, k.expensesPaise, k.expensesWaiting ? html`<a href="#/b/${biz.id}/review">Review</a>` : '')}
      ${k.shortagePaise ? row('− Cash shortage', 'booked by an Owner', k.shortagePaise) : ''}
      ${row('= Should be in hand', '', k.shouldBePaise, '', true)}
      ${row('Counted', 'cash in hand on this day\'s cash summary page', k.countedPaise, k.summaryUploadId ? html`<a href="#/b/${biz.id}/review/${k.summaryUploadId}">Open page</a>` : html`<a href="#/b/${biz.id}/bringin">Bring it in</a>`)}
      ${diff !== null ? row('Difference', diff < 0 ? 'short: less cash than there should be' : diff > 0 ? 'more cash than there should be' : '', diff, '', true) : ''}
    </table></div>
    ${k.accepted ? html`<div class="note">Accepted with a note: ${k.accepted}</div>` : ''}
    ${diff !== null && diff !== 0 && !k.settled ? html`<form id="cashact" class="inset">
      <div class="field"><label for="cashnote">Note (what happened)</label><input id="cashnote" name="note" required placeholder="e.g. Bill 26103136 cash received, not written in the register"></div>
      <div class="form-msg"></div>
      <div class="form-row">
        ${biz.actions.includes('sales.decide') ? html`<button class="btn plain" type="submit" data-cashact="accept">Accept with a note</button>` : ''}
        ${diff < 0 && biz.actions.includes('cash.writeoff') ? html`<button class="btn danger" type="submit" data-cashact="shortage">Book ₹ ${money(-diff)} as cash shortage</button>` : ''}
      </div>
      <div class="note">Accept when the cash is there and only the writing is wrong. Book a shortage (Owner only) when cash is missing: it becomes an approved expense from Cash under "Cash shortage".</div>
    </form>` : ''}
    ${k.notInRegister.length ? html`<h2 style="font-size:16px;margin-top:6px">Cash bills not in the register</h2>
      ${k.notInRegister.map((x) => html`<div class="list-row"><span class="mono">${x.billNo}</span><span class="amount">₹ ${money(x.amountPaise)}</span>
        <span class="note">${x.decision === 'use_software' ? `Use software${x.billType ? ` · ${TYPE_LABELS[x.billType]}` : ''}` : x.decision === 'leave_out' ? `Left out: ${x.note ?? ''}` : 'Not decided'}</span></div>`)}` : ''}
  </section>`;
}

function wireCashPanel(biz, day, reload, msg) {
  const form = document.getElementById('cashact');
  if (!form) return;
  let which = 'accept';
  form.querySelectorAll('[data-cashact]').forEach((b) => b.addEventListener('click', () => { which = b.dataset.cashact; }));
  onSubmit(form, async (d) => {
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

async function compareView(biz, day) {
  const { shifts } = await api('GET', `/businesses/${biz.id}/shifts`);
  if (!day) day = shifts.find((s) => s.day === lastDay(biz.id))?.day ?? shifts.find((s) => s.status !== 'confirmed')?.day ?? shifts[0]?.day;
  rememberDay(biz.id, day);
  if (!day) {
    render(shell(biz, 'compare', 'Compare sales', 'Software report against the handwritten register, bill by bill. You decide every difference.', html`
      <section class="card"><div class="note">No sales yet. <a href="#/b/${biz.id}/bringin">Bring in a software sales report</a>.</div></section>`));
    return wireShell();
  }
  drawerReload = () => compareView(biz, day);
  const [v, cash, waiting, awaiting] = await Promise.all([api('GET', `/businesses/${biz.id}/shifts/${day}`), api('GET', `/businesses/${biz.id}/shifts/${day}/cash`),
    api('GET', `/businesses/${biz.id}/waiting-bills`), api('GET', `/businesses/${biz.id}/awaiting-credit`).catch(() => null)]);
  v.reasons = cash.reasons;
  const canDecide = biz.actions.includes('sales.decide');
  const confirmed = v.status === 'confirmed';
  const toDecide = v.comparisons.filter((c) => ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'].includes(c.difference));
  const decided = toDecide.filter((c) => c.decision).length;
  const comps = v.comparisons.filter((c) => c.difference === 'complimentary');
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
    const told = new Set([...(v.slips ?? []).flatMap(slipCredits), ...(v.columnHints ?? []).map((h) => h.creditId), ...(v.warnings ?? []).filter((w) => w.byUpi).map((w) => w.byUpi.creditId)]);
    const noBill = new Set(v.bank.noBill.map((x) => x.id));
    const explained = v.bank.open.filter((x) => told.has(x.id));
    return { all: v.bank.open, explained, noBill: v.bank.noBill, unpaired: v.bank.open.filter((x) => !told.has(x.id) && !noBill.has(x.id)) };
  })();
  const isUpi = (c) => c.software?.mode === 'upi' || c.register?.mode === 'upi';
  // Wrong UPI column (Owner and Accountant only: the server sends no hints to anyone else).
  const colHintOf = (rowIds) => (v.columnHints ?? []).find((h) => rowIds.includes(h.rowId)) ?? null;
  const colChip = (h) => html`<span class="chip wait" style="white-space:normal" title="${colHintText(h)}">Came into ${h.accountName} · ${hhmm(h.postedAt)}</span>
    <button class="btn plain dchip" type="button" data-setcol="${h.paymentId}" title="${colHintText(h)}">Change column to ${h.toLabel}</button>`;
  const slipChip = (x) => html`<span class="chip wait" style="white-space:normal" title="${slipCard(x, false, day).evidence.slice(0, 2).join(' ')}">${x.partner ? `Bank ₹ ${rs(x.creditPaise)} + ₹ ${rs(x.partner.creditPaise)} fits bills ${x.billNo} + ${x.partner.billNo}` : `Bank ${[x.creditPaise, ...x.others.map((o) => o.amountPaise)].map(rs).join(' + ')} fits if ${slipShort(x)}`}</span>
    <button class="btn plain dchip" type="button" data-slip="${x.key}" title="Changes the register row. Check it against the photo.">Correct the register</button>`;
  // No UPI credit for the side that says UPI (Owner and Accountant only): the other side's mode, unless a wrong column or a slip explains it.
  const noneOf = (c) => (!c.bank && c.bankNone && !colHintOf([c.register?.rowId]) && !(v.slips ?? []).some((x) => slipRows(x).includes(c.register?.rowId)) ? c.bankNone : null);
  const sideName = (d) => (d === 'use_software' ? 'the software' : 'the register');
  // What the bank says about a mode or amount difference, in one line, while it is undecided or decided the other way.
  const bankSays = (c) => {
    const n = noneOf(c);
    const suggest = c.bank?.suggest ?? n?.suggest;
    if (!suggest || c.decision === suggest) return '';
    const text = c.bank?.suggest ? `The bank got ₹ ${rs(c.bank.amountPaise)} by UPI at ${hhmm(c.bank.postedAt)}: ${sideName(suggest)} is right.`
      : `No UPI credit of ₹ ${rs(n.upiPaise)} near this bill${n.takenBy ? ` (the one at ${hhmm(n.takenBy.postedAt)} went to bill ${n.takenBy.billNo})` : ''}: it was most likely paid by ${MODE_LABELS[n.mode]?.toLowerCase() ?? n.mode}, as ${sideName(suggest)} says.`;
    return html`<div class="tiny" style="white-space:normal;max-width:260px;color:${c.decision ? 'var(--warn-ink, #8a5a00)' : 'var(--teal-ink)'}">${c.decision ? '⚠ Decided the other way. ' : ''}${text}</div>`;
  };
  const bankChip = (c) => {
    if (!v.bank || (!isUpi(c) && !c.bank)) return '';
    if (c.bank?.parts) {
      return html`<span class="chip ok" title="One unmatched UPI credit for each UPI payment written for this bill: ${c.bank.parts.map((p) => `₹ ${money(p.amountPaise)} at ${when(p.postedAt)}`).join(', ')}. Confirming matches each to its payment.">Bank ${c.bank.parts.map((p) => `₹ ${rs(p.amountPaise)}`).join(' + ')} · ${hhmm(c.bank.parts[0].postedAt)}–${hhmm(c.bank.parts[c.bank.parts.length - 1].postedAt)}</span>`;
    }
    if (c.bank) {
      const fits = c.bank.fits === 'both' ? 'both sides' : c.bank.fits === 'software' ? 'the software' : 'the register';
      return html`<span class="chip ok" title="An unmatched UPI credit of ₹ ${money(c.bank.amountPaise)} came in at ${when(c.bank.postedAt)}. It equals ${fits}.${c.bank.minutes > 60 ? ' It came in well before the bill was closed, and it is the only credit of this amount in the two hours before.' : ''} Confirming matches it to this bill.">Bank ₹ ${rs(c.bank.amountPaise)} · ${hhmm(c.bank.postedAt)}${c.bank.minutes != null ? ` · ${c.bank.minutes} min` : ''}</span>`;
    }
    const h = colHintOf([c.register?.rowId]);
    if (h) return colChip(h);
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
  const credit = awaiting?.sales ?? [];
  const tab = (() => { try { return localStorage.getItem('bookr.compare.tab') || 'shift'; } catch { return 'shift'; } })();
  const rowHtml = (c, inGroup = '', closed = false) => html`<tr ${inGroup ? html`data-group="${inGroup}"` : ''} ${closed ? 'hidden' : ''} data-bill="${c.billNo}" data-open="${c.register?.uploadId ? `#/b/${biz.id}/review/${c.register.uploadId}/${c.register.rowId}` : `#/b/${biz.id}/review?find=${c.billNo.slice(-4)}`}"
      class="clickrow ${c.decision || c.difference === 'match' ? '' : 'undecided'} ${inGroup ? 'grp-bill' : ''}" data-kind="${c.difference === 'match' ? 'match' : c.difference === 'missing_in_register' ? 'sw' : c.difference === 'missing_in_software' ? 'rg' : 'diff'}" title="${c.register ? 'Open this bill in its register page' : 'Look for this bill on the register pages'}">
    <td class="mono">${bulkOk(c) && !c.decision ? html`<input type="checkbox" data-bulk="${c.id}" aria-label="Select bill ${c.billNo}" style="width:18px;height:18px;min-height:0;margin-right:6px;vertical-align:middle">` : ''}<a href="#" data-openlink>${c.billNo}</a>${drawerBtn(c.billNo, day)}
      <div class="tiny">${c.paidAt ? when(c.paidAt) : 'Not in report'}</div>${otherDayNote(c)}
      ${(c.numberFlags ?? []).map((f) => html`<div class="tiny error">${numberFlagText(f)}</div>`)}
      ${!c.software && isOddBill(c.billNo) ? html`<div class="tiny error">Number fits neither format, so it can never match. Open the row to correct it.</div>` : ''}
      ${!c.software && !c.decision && isOldPos(c.billNo) ? html`<div class="tiny">Old POS bill. ${c.register?.reviewed ? 'Row reviewed: you can use the register.' : 'Review its row, then use the register.'}</div>` : ''}</td>
    <td>${side(c.software)}</td><td>${side(c.register)}</td>
    <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
      ${c.difference === 'match' ? (c.software?.amountPaise !== c.register?.amountPaise ? html`<span class="chip wait" title="The group matches on its total. This bill's own figures differ.">This bill differs by ₹ ${rs(Math.abs((c.software?.amountPaise ?? 0) - (c.register?.amountPaise ?? 0)))}</span>` : html`<span class="chip ok">Same</span>`)
        : html`<span class="chip ${c.difference.startsWith('missing') ? 'bad' : 'wait'}">${DIFF_LABELS[c.difference]}</span>`}
      ${c.auto ? html`<span class="tiny" style="color:var(--teal-ink)">Decided by Bookr${c.note ? `: ${c.note}` : ''}</span>` : ''}
      ${confirmed ? '' : html`${bankChip(c)}${bankSays(c)}`}
    </div></td>
    <td>${c.difference === 'match' ? html`<span class="note">No decision needed</span>` : canDecide && !confirmed ? html`<div style="display:flex;flex-wrap:wrap;gap:6px">${decisionChoices(c).map(([k, l, type, link]) => {
        const on = c.decision === k && (!type || c.billType === type) && (link ?? null) === (c.linkedToId ?? null);
        if (k === 'leave_out' && !link && !c.register && c.software?.mode === 'cash') {
          return html`<select class="cell ${on ? 'auto' : ''}" data-leaveout="${c.id}" aria-label="Leave out because" style="min-height:40px">
            <option value="">${on ? `Left out: ${c.note ?? ''}` : 'Leave out because…'}</option>
            ${(v.reasons ?? []).map((r) => html`<option value="${r}">${r}</option>`)}<option value="__other">Another reason…</option></select>`;
        }
        const none = noneOf(c);
        const sugg = !c.decision && (c.bank?.suggest ?? none?.suggest) === k && !type && !link;
        const why = !sugg ? '' : c.bank?.suggest ? `The bank backs this: ₹ ${money(c.bank.amountPaise)} came in at ${hhmm(c.bank.postedAt)}` : `The bank backs this: no UPI credit of ₹ ${money(none.upiPaise)} came in near this bill`;
        return html`<button class="btn ${on ? 'ghost' : 'plain'} dchip ${sugg ? 'sugg' : ''}" style="${on ? 'font-weight:600;background:#E3F1EF' : ''}" data-cmp="${c.id}" data-d="${k}" data-type="${type ?? ''}" data-link="${link ?? ''}" ${sugg ? `title="${why}"` : ''}>${on ? '✓ ' : ''}${l}${sugg ? html` <span class="bank-tag">bank</span>` : ''}</button>`;
      })}</div>`
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
        : colHintOf([g.id]) ? colChip(colHintOf([g.id]))
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
  render(shell(biz, 'compare', 'Compare sales', '', html`
    ${shiftBar(biz, day, 'compare')}
    <section class="card cmp-bar">
      <div class="cmp-top">
        <div class="cmp-day">
          ${status}
        </div>
        ${canDecide && !confirmed ? html`<button class="btn" id="confirm" ${v.canConfirm ? '' : 'aria-disabled="true"'} title="${v.canConfirm ? 'Turn this shift\'s sales into approved income' : 'Show what is left'}">${v.canConfirm ? 'Confirm shift' : `Confirm shift · ${open.length ? `${open.length} to decide` : `${v.blockers.length} left`}`}</button>` : ''}
      </div>
      <div class="cmp-inputs">
        <span class="tchip ${v.gaps.length ? 'warn' : 'ok'}">Software · ${v.softwareBills} bills${v.gaps.length ? ` · ${missingHours} h missing` : ' · 8 am to 8 am'}</span>
        <span class="tchip ${v.registerRows ? 'ok' : 'warn'}">Register · ${v.registerPages} page${v.registerPages === 1 ? '' : 's'}, ${v.registerRows} bills</span>
        ${comps.length ? html`<span class="tchip">${comps.length} complimentary</span>` : ''}
        ${v.bank ? html`<span class="tchip ${v.bank.covered ? 'ok' : 'warn'}" title="${v.bank.lastBankAt ? `Latest UPI line in Bookr: ${when(v.bank.lastBankAt)}` : 'No UPI bank lines in Bookr yet'}">${v.bank.covered ? 'Bank in' : v.bank.lastBankAt ? `Bank up to ${when(v.bank.lastBankAt)}` : 'Bank not in yet'}</span>` : ''}
        <details class="menu"><summary class="linkbtn">Details</summary><div class="menu-pop" style="min-width:300px">
          ${v.reports.map((r) => html`<div class="note">Report ${when(r.coversFrom)} to ${when(r.coversTo)}${confirmed || !biz.actions.includes('sales.import') ? '' : html` · <a href="#" data-cover="${r.id}" data-from="${r.coversFrom}" data-to="${r.coversTo}">Change</a>`}</div>`)}
          ${biz.actions.includes('sales.import') ? html`<a href="#/b/${biz.id}/bringin/${day}">Bring in a report</a>` : ''}
          ${biz.actions.includes('rows.edit') ? html`<a href="#/b/${biz.id}/review">Open register pages</a>` : ''}
        </div></details>
      </div>
      <div class="cmp-progress" aria-label="Bills of this shift">
        <div class="pgbar">${seg(matches, 'm', 'Match')}${seg(auto.length, 'a', 'Decided by Bookr')}${seg(byPerson.length, 'd', 'Decided')}${seg(open.length, 'o', 'To decide')}</div>
        <div class="tiny">${matches} match · ${auto.length} by Bookr · ${byPerson.length} decided · <strong>${open.length} to decide</strong>${onCredit.length ? ` · ${onCredit.length} UPI on one side (₹ ${rs(onCreditPaise)}) counted when the bank credit arrives` : ''}</div>
      </div>
      <div id="coveredit"></div>
    </section>
    <div id="cmsg"></div>
    ${v.gaps.map((g) => html`<div class="demo-band">Missing ${when(g.from)} to ${when(g.to)}. Upload the report for those hours, or correct a report's covered period.</div>`)}
    ${(v.warnings ?? []).map((w) => cashWarnHtml(w, v, confirmed || !canDecide))}
    ${auto.some((c) => c.numberFlags?.length) ? html`<div class="cmp-warn">⚠ ${blockerHtml(`Bookr counted these before their numbers looked wrong. Check them under Decided by Bookr: ${auto.filter((c) => c.numberFlags?.length).map((c) => c.billNo).join(', ')}.`, v)}</div>` : ''}
    ${notMatched ? notMatchedHtml(notMatched, `#/b/${biz.id}/reconcile/${day}`) : ''}
    ${oddNumbersHtml(biz, waiting, canDecide)}
    <div class="seg cmp-tabs" role="tablist">
      <button type="button" role="tab" data-tab="shift" class="${tab === 'shift' ? 'on' : ''}">This shift</button>
      <button type="button" role="tab" data-tab="other" class="${tab === 'other' ? 'on' : ''}">Waiting for other side (${waiting?.bills?.length ?? 0})</button>
      <button type="button" role="tab" data-tab="credit" class="${tab === 'credit' ? 'on' : ''}">Waiting for bank credit (${credit.length})</button>
    </div>
    <div data-pane="shift" ${tab === 'shift' ? '' : 'hidden'}>
      ${v.conflicts.length ? html`<section class="card">
        <h2>Bills that differ between two software reports</h2>
        <div class="note">The same bill came in twice with different values. Nothing was overwritten. Choose which to keep.</div>
        <div class="scroll"><table style="min-width:640px"><thead><tr><th>Bill</th><th>Already imported</th><th>New file</th><th></th></tr></thead><tbody>
          ${v.conflicts.map((k) => html`<tr><td class="mono">${k.billNo}</td>
            <td><div class="mono">${money(k.existing.amountPaise)}</div><div class="note">${MODE_LABELS[k.existing.mode]} · ${when(k.existing.paidAt)}</div></td>
            <td><div class="mono">${money(k.incoming.amountPaise)}</div><div class="note">${MODE_LABELS[k.incoming.mode]} · ${when(k.incoming.paidAt)}</div></td>
            <td>${canDecide ? html`<div class="form-row"><button class="btn plain" data-conflict="${k.id}" data-d="keep_existing">Keep imported</button><button class="btn plain" data-conflict="${k.id}" data-d="use_incoming">Use new file</button></div>` : ''}</td></tr>`)}
        </tbody></table></div></section>` : ''}
      <section class="card" style="gap:10px">
        <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px"><h2 id="decidehead">To decide (${open.length})</h2>
          ${backed.length ? html`<button class="btn" type="button" id="acceptbank" title="Each choice marked 'bank' is the side the bank credit agrees with">Accept ${backed.length} bank-backed choice${backed.length > 1 ? 's' : ''}</button>` : ''}
          ${open.length || matched.length ? html`<span class="seg" role="group" aria-label="Show">${kinds.map(([k, l, list]) => list.length || k === 'all' ? html`<button type="button" data-kind="${k}" class="${k === 'all' ? 'on' : ''}">${l} (${list.length})</button>` : '')}</span>` : ''}</div>
        ${v.matchedAfterAdjustment?.length ? html`<div class="note">${v.matchedAfterAdjustment.length} bill${v.matchedAfterAdjustment.length > 1 ? 's match' : ' matches'} after a discount or tip, so no decision is needed: ${v.matchedAfterAdjustment.map((m) => m.billNo).join(', ')}.</div>` : ''}
        ${canDecide && !confirmed && open.filter(bulkOk).length > 1 ? html`<form id="bulkreg" class="inset" style="gap:8px">
          <div class="note"><strong>${open.filter(bulkOk).length} bills are only in the register.</strong> Tick bills that will never be in a software report and count them from the register at once.</div>
          <div class="form-row" style="align-items:flex-end">
            <button class="btn plain" type="button" id="bulkall">Select all ${open.filter(bulkOk).length}</button>
            ${open.some((c) => bulkOk(c) && isOldPos(c.billNo)) ? html`<button class="btn plain" type="button" id="bulkold">Select ${open.filter((c) => bulkOk(c) && isOldPos(c.billNo)).length} reviewed old POS</button>` : ''}
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
          <h2>${confirmed ? 'Confirmed' : 'Before confirming'}</h2>
          ${confirmed ? html`
            <div class="ok-msg">Confirmed ${when(v.confirmedAt)}. UPI sales now wait for their bank credit${onCredit.length ? '; bills found on one side only count on the day their credit arrives' : ''}.</div>
            ${biz.role === 'owner' ? html`<form id="reopen" class="inset"><div class="field"><label for="rr">Reopen this shift: reason</label><input id="rr" name="reason" required></div><div class="form-msg"></div><button class="btn danger" type="submit" style="align-self:flex-start">Reopen shift</button></form>` : html`<div class="note">Only an Owner can reopen a confirmed shift.</div>`}`
          : html`
            ${v.reopenedAt ? html`<div class="note">Reopened ${when(v.reopenedAt)}: ${v.reopenReason}</div>` : ''}
            ${v.blockers.length ? html`<ul class="note" style="margin:0;padding-left:18px">${v.blockers.map((b) => html`<li>${blockerHtml(b, v)}</li>`)}</ul>` : html`<div class="ok-msg">Everything is decided. Confirm the shift at the top.</div>`}
            ${v.assumedTypes?.length ? html`<div class="note" style="background:#FFFBEB;padding:8px 10px;border-radius:6px">${v.assumedTypes.length} bill${v.assumedTypes.length > 1 ? 's were' : ' was'} taken as <strong>F&amp;B</strong> because the register's type could not be read: ${blockerHtml(v.assumedTypes.join(', '), v)}.</div>` : ''}
            ${v.bank && countedUpi.length ? html`<div class="note"><strong>On confirming:</strong> ${matchNow.length} of ${countedUpi.length} UPI bill${countedUpi.length > 1 ? 's' : ''} ${matchNow.length === 1 ? 'is' : 'are'} matched to ${matchNow.length === 1 ? 'its' : 'their'} bank credit at once${countedUpi.length - matchNow.length ? `; ${countedUpi.length - matchNow.length} wait${countedUpi.length - matchNow.length === 1 ? 's' : ''} for ${countedUpi.length - matchNow.length === 1 ? 'its' : 'their'} credit on Reconcile` : ''}. Unmatch undoes any of them.</div>` : ''}
            ${v.bank && biz.actions.includes('bank.link') ? html`<div class="note" id="trialwarn"></div>` : ''}
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
      </div>
      ${cashPanelHtml(biz, cash)}
    </div>
    <div data-pane="other" ${tab === 'other' ? '' : 'hidden'}>${waitingHtml(biz, waiting, canDecide) || html`<section class="card"><div class="note">No bill is waiting for its other side.</div></section>`}</div>
    <div data-pane="credit" ${tab === 'credit' ? '' : 'hidden'}><section class="card" style="gap:10px">
      <h2>Waiting for bank credit</h2>
      <div class="note">Confirmed UPI sales whose credit has not been matched on Reconcile yet. A bill found on one side only is <strong>not counted</strong> until its credit is matched; it is then counted on the day the credit arrived.</div>
      ${credit.length ? html`<div class="scroll"><table style="min-width:560px"><thead><tr><th>Bill</th><th>Shift</th><th style="text-align:right">Amount</th><th>Counted</th><th>Waiting</th></tr></thead><tbody>
        ${credit.map((x) => html`<tr><td class="mono">${x.billNo}${drawerBtn(x.billNo, x.day)}</td><td><a href="#/b/${biz.id}/compare/${x.day}">${dayLabel(x.day)}</a></td><td class="amount">${money(x.amountPaise)}</td>
          <td>${x.onCredit ? html`<span class="chip wait">When the credit arrives</span>` : html`<span class="note">On ${dayLabel(x.day)}</span>`}</td>
          <td>${x.daysWaiting > 2 ? html`<span class="chip bad">${x.daysWaiting} days</span>` : html`<span class="note">${x.daysWaiting} day${x.daysWaiting === 1 ? '' : 's'}</span>`}</td></tr>`)}
      </tbody></table></div>${biz.actions.includes('bank.link') ? html`<a href="#/b/${biz.id}/reconcile">Open Reconcile</a>` : ''}` : html`<div class="ok-msg">Every confirmed UPI sale has its bank credit.</div>`}
    </section></div>`));
  wireShell();
  const msg = document.getElementById('cmsg');
  wireShiftBar(biz, shiftOptions);
  const act = async (fn) => { try { await fn(); compareView(biz, day); } catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  app.querySelectorAll('[data-cmp]').forEach((b) => b.addEventListener('click', () => {
    const c = v.comparisons.find((x) => x.id === b.dataset.cmp);
    if (b.dataset.d === '__review') {
      const tr = b.closest('tr');
      setBackTo({ hash: `#/b/${biz.id}/compare/${day}`, bill: tr.dataset.bill, label: `${dayLabel(day)} shift` });
      location.hash = tr.dataset.open;
      return;
    }
    if (b.dataset.d === '__oldpos') {
      act(async () => {
        const r = await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/register-only`, { ids: [c.id], note: isOldPos(c.billNo) ? OLD_POS_NOTE : SHORT_OLD_POS_NOTE });
        if (r.skipped?.length) throw new Error(`Bill ${c.billNo} was not changed: ${r.skipped[0].reason}.`);
      });
      return;
    }
    let note = null;
    if (!note && b.dataset.d === 'leave_out' && b.dataset.link && c?.otherDay?.decision === 'leave_out') {
      note = (prompt(`Bill ${c.billNo} was left out on ${dayLabel(c.otherDay.day)}${c.otherDay.note ? ` (${c.otherDay.note})` : ''} and now appears here. Why leave it out again?`) ?? '').trim();
      if (!note) return;
    }
    act(() => apiFull('PUT', `/businesses/${biz.id}/comparisons/${b.dataset.cmp}`, { decision: b.dataset.d, billType: b.dataset.type || null, note, linkedToId: b.dataset.link || null }));
  }));
  app.querySelectorAll('[data-groupreg]').forEach((b) => b.addEventListener('click', (e) => {
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
  app.querySelectorAll('[data-slip]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const x = v.slips.find((y) => y.key === b.dataset.slip);
    try {
      const undo = await applySlip(biz, { slip: x, confirmed: false, day });
      await compareView(biz, day);
      doneToast(`Bill ${x.billNo}${x.partner ? ` and ${x.partner.billNo}` : ''}: register corrected (${slipShort(x)}).`, undo, () => compareView(biz, day));
    } catch (err) { b.disabled = false; showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }));
  app.querySelectorAll('[data-setcol]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const h = v.columnHints.find((x) => x.paymentId === b.dataset.setcol);
    try {
      const undo = await setColumn(biz, { hint: h, match: false });
      await compareView(biz, day);
      doneToast(`Bill ${h.billNo ?? ''}: column changed to ${h.toLabel}.`, undo, () => compareView(biz, day));
    } catch (err) { b.disabled = false; showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }));
  // A difference opens its bill in Review; Review offers a way back to this bill here.
  app.querySelectorAll('tr.clickrow').forEach((tr) => tr.addEventListener('click', (e) => {
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
  app.querySelectorAll('tr[data-grouphead]').forEach((head) => {
    const flip = () => { head.classList.toggle('open'); showGroups(head.closest('section, details')); };
    head.addEventListener('click', flip);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  });
  // A matched bill is shown on the Matched tab.
  const reveal = (row) => {
    if (row.dataset.kind === 'match' && decideList?.contains(row)) document.querySelector('button[data-kind="match"]')?.click();
    openGroupOf(row);
  };
  const back = getBackTo();
  if (back?.bill && back.hash === `#/b/${biz.id}/compare/${day}`) {
    clearBackTo();
    const row = app.querySelector(`tr[data-bill="${CSS.escape(back.bill)}"]`);
    if (row) reveal(row);
    if (row) { row.classList.add('row-found'); row.scrollIntoView({ block: 'center' }); }
  }
  app.querySelectorAll('[data-leaveout]').forEach((sel) => sel.addEventListener('change', () => {
    let note = sel.value;
    if (!note) return;
    if (note === '__other') note = (prompt('Why is this cash bill left out?') ?? '').trim();
    if (!note) { sel.value = ''; return; }
    act(() => apiFull('PUT', `/businesses/${biz.id}/comparisons/${sel.dataset.leaveout}`, { decision: 'leave_out', note }));
  }));
  wireCashPanel(biz, day, () => compareView(biz, day), msg);
  const bulk = document.getElementById('bulkreg');
  if (bulk) {
    const boxes = () => [...app.querySelectorAll('[data-bulk]')];
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
      const old = new Set(v.comparisons.filter((c) => isOldPos(c.billNo)).map((c) => c.id));
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
        await compareView(biz, day);
        document.getElementById('cmsg').innerHTML = html`<div class="${r.skipped.length ? 'error' : 'ok-msg'}">${r.decided} bill${r.decided === 1 ? '' : 's'} counted from the register.${r.skipped.length ? ` Not changed: ${r.skipped.map((x) => `${x.billNo} (${x.reason})`).join('; ')}.` : ''}</div>`.__html;
      } catch (err) { showError(bulk.querySelector('.form-msg'), err); }
    });
  }
  app.querySelectorAll('[data-cashupigo]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.cashupigo}/paid-by-upi`, { creditId: b.dataset.credit, billType: b.dataset.type });
      compareView(biz, day);
    } catch (err) { b.disabled = false; showError(b.closest('[data-cashupi]').querySelector('.form-msg'), err); }
  }));
  app.querySelectorAll('[data-gobill]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const row = app.querySelector(`tr[data-bill="${CSS.escape(a.dataset.gobill)}"]`);
    if (row) reveal(row);
    if (!row) {
      // Not a difference (e.g. a matched bill with no type): open it in its register page.
      const c = v.comparisons.find((x) => x.billNo === a.dataset.gobill);
      if (c?.register?.uploadId) { setBackTo({ hash: `#/b/${biz.id}/compare/${day}`, bill: c.billNo, label: `${dayLabel(day)} shift` }); location.hash = `#/b/${biz.id}/review/${c.register.uploadId}/${c.register.rowId}`; }
      return;
    }
    app.querySelectorAll('tr.row-found').forEach((x) => x.classList.remove('row-found'));
    row.classList.add('row-found');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  app.querySelectorAll('[data-oddclose]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.oddclose}/close`, { note: SHORT_OLD_POS_NOTE }))));
  app.querySelectorAll('[data-closebill]').forEach((b) => b.addEventListener('click', () => {
    const note = (prompt(`Close bill ${b.dataset.bill}: why did its other side never turn up?`) ?? '').trim();
    if (note) act(() => apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.closebill}/close`, { note }));
  }));
  app.querySelectorAll('[data-conflict]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('PUT', `/businesses/${biz.id}/conflicts/${b.dataset.conflict}`, { decision: b.dataset.d }))));
  document.getElementById('acceptbank')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    act(async () => {
      for (const c of backed) {
        await apiFull('PUT', `/businesses/${biz.id}/comparisons/${c.id}`, { decision: c.bank.suggest, billType: null, linkedToId: null,
          note: `Bank: ₹ ${rs(c.bank.amountPaise)} came in at ${hhmm(c.bank.postedAt)}` });
      }
    });
  });
  document.getElementById('confirm')?.addEventListener('click', () => {
    if (!v.canConfirm) { // not yet: show what is left
      app.querySelector('[data-tab="shift"]')?.click();
      document.getElementById('nextstep')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    act(() => apiFull('POST', `/businesses/${biz.id}/shifts/${day}/confirm`, {}));
  });
  app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('bookr.compare.tab', b.dataset.tab); } catch { /* storage unavailable */ }
    app.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    app.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  }));
  app.querySelectorAll('button[data-kind]').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('button[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
    showKind(b.closest('section'), b.dataset.kind);
  }));
  // A warning from the trial reconcile; it never stops a confirm.
  const trialWarn = document.getElementById('trialwarn');
  if (trialWarn) api('GET', `/businesses/${biz.id}/shifts/${day}/reconcile`).then((t) => {
    const link = html`<a href="#/b/${biz.id}/reconcile/${day}">Try reconcile</a>`;
    const twice = t.fixes.filter((c) => c.kind === 'same_sale' && c.actions[0]?.label === 'Same sale').length;
    trialWarn.innerHTML = (twice ? html`<strong>Before you confirm:</strong> ${twice} bill${twice === 1 ? '' : 's'} may be a credit already booked directly, which would count the sale twice. You can still confirm. ${link}` : !t.coverage.covered ? html`The bank is not in for this whole shift yet. You can confirm, and reconcile later. ${link}`
      : !t.strip.billsLeft && !t.strip.creditsLeft ? html`<strong>UPI reconciled:</strong> every bill and credit of this shift is explained.`
      : html`<strong>Before you confirm:</strong> ${t.strip.billsLeft} UPI bill${t.strip.billsLeft === 1 ? '' : 's'} not in the bank yet, ${t.strip.creditsLeft} UPI credit${t.strip.creditsLeft === 1 ? '' : 's'} not matched yet${t.strip.creditsNoBill ? ` (${t.strip.creditsNoBill} with no bill of that amount)` : ''}. You can still confirm. ${link}`).__html;
  }).catch(() => { /* only a hint */ });
  const reopen = document.getElementById('reopen');
  reopen && onSubmit(reopen, async (d) => { await apiFull('POST', `/businesses/${biz.id}/shifts/${day}/reopen`, { reason: d.reason }); compareView(biz, day); });
  app.querySelectorAll('[data-cover]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const box = document.getElementById('coveredit');
    box.innerHTML = html`<form class="inset" id="covf"><div class="form-row">
      <div class="field"><label>Covers from (India time)</label><input name="from" type="datetime-local" step="1" value="${toLocalInput(+a.dataset.from)}"></div>
      <div class="field"><label>Covers to</label><input name="to" type="datetime-local" step="1" value="${toLocalInput(+a.dataset.to)}"></div></div>
      <div class="form-msg"></div><button class="btn plain" type="submit" style="align-self:flex-start">Save covered period</button></form>`.__html;
    onSubmit(document.getElementById('covf'), async (d) => {
      await api('PATCH', `/businesses/${biz.id}/sales-reports/${a.dataset.cover}`, { coversFrom: fromLocalInput(d.from), coversTo: fromLocalInput(d.to) });
      compareView(biz, day);
    });
  }));
}

// ---------- Bank sync: accounts, their sheets, and statement lines with what Bookr suggests

const BANK_KIND = { upi_in: 'UPI in', upi_out: 'UPI out', upi_fee: 'UPI card fee', reversal: 'Reversal', card_settlement: 'Card settlement', card_purchase: 'Card purchase', other: 'Other' };
const hhmm = (ms) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));

async function bankView(biz, query = '') {
  const q = new URLSearchParams(query);
  const to = q.get('to') || addDaysIso(todayIst(), -1);
  const from = q.get('from') || addDaysIso(to, -6);
  const account = q.get('account') || '';
  const tab = ['in', 'out', 'done'].includes(q.get('tab')) ? q.get('tab') : 'in';
  // A shift runs 8 am to 8 am, so the last shift's lines run into the next calendar day.
  const [b, lines, { heads }, { rules }, { parties }] = await Promise.all([
    api('GET', `/businesses/${biz.id}/bank`),
    api('GET', `/businesses/${biz.id}/bank-rows?from=${from}&to=${addDaysIso(to, 1)}${account ? `&account=${account}` : ''}`),
    api('GET', `/businesses/${biz.id}/heads`),
    api('GET', `/businesses/${biz.id}/rules`),
    api('GET', `/businesses/${biz.id}/parties`),
  ]);
  const canRules = biz.actions.includes('rules.edit');
  const headsOf = (dir) => heads.filter((h) => h.type === (dir === 'CR' ? 'income' : 'expense'));
  const shiftOf = (ms) => new Date(ms + IST_MS - 8 * 3600e3).toISOString().slice(0, 10);
  const all = lines.rows.map((r) => ({ ...r, shift: shiftOf(r.postedAt) })).filter((r) => r.shift >= from && r.shift <= to);
  const inTab = (r) => (tab === 'done' ? r.status !== 'unmatched' : r.status === 'unmatched' && r.direction === (tab === 'in' ? 'CR' : 'DR'));
  const rows = all.filter(inTab);
  const count = (t) => all.filter((r) => (t === 'done' ? r.status !== 'unmatched' : r.status === 'unmatched' && r.direction === (t === 'in' ? 'CR' : 'DR'))).length;
  const shifts = [...new Set(rows.map((r) => r.shift))].sort().reverse();
  const reversals = all.filter((r) => r.kind === 'reversal' && r.status === 'unmatched' && r.pairRowId).length;
  const link = (over) => { const p = new URLSearchParams({ from, to, account, tab, ...over }); return `#/b/${biz.id}/bank?${p}`; };
  const OPEN_KEY = 'bookr.bankOpen';
  let openShifts;
  try { openShifts = new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY) || '[]')); } catch { openShifts = new Set(); }
  const accountRow = (a) => html`<tr>
    <td><strong>${a.name}</strong>${a.accountNumber ? html`<div class="note mono">${a.accountNumber}</div>` : ''}</td>
    <td>${[a.receivesUpiLabel ? `UPI: ${a.receivesUpiLabel}` : '', a.receivesCard ? 'Card settlements' : ''].filter(Boolean).join(' · ') || html`<span class="note">Nothing set</span>`}</td>
    <td>${a.sheetId ? html`<a href="https://docs.google.com/spreadsheets/d/${a.sheetId}" target="_blank" rel="noopener">Google Sheet</a> · ${a.tab ?? 'every tab'}` : html`<span class="note">Pasted</span>`}
      ${a.lastSyncNote ? html`<div class="tiny">${a.lastSyncedAt ? `${when(a.lastSyncedAt)}: ` : ''}${a.lastSyncNote}</div>` : ''}</td>
    <td class="amount">${a.rows}${a.open ? html` <span class="chip wait">${a.open} open</span>` : ''}${a.lastDay ? html`<div class="tiny">to ${dayLabel(a.lastDay)}</div>` : ''}</td>
    <td style="text-align:right;white-space:nowrap">
      ${a.sheetId ? html`<button class="btn" type="button" data-sync="${a.id}">Sync</button>` : ''}
      <button class="btn plain" type="button" data-paste="${a.id}" data-name="${a.name}">Paste rows</button>
      <button class="btn plain" type="button" data-setup="${a.id}">Set up</button></td></tr>
    <tr hidden data-setupform="${a.id}"><td colspan="5"><form class="inset" data-src="${a.id}">
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
    if (r.kind === 'reversal') parts.push(html`<div class="note">${r.pairRowId ? 'Gives back a failed payment: both cancel out.' : 'A reversal; its payment is not in Bookr yet.'}</div>`);
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
      ${headSelect(r, sg.headId)}${sg.learned ? html`<span class="chip wait" title="Filled in from how this party was booked before">Learned</span>` : r.rule ? html`<span class="tiny">rule: ${r.rule.name}</span>` : ''}
      ${r.kind === 'upi_fee' ? html`<span class="tiny">Fee on a credit card paid through UPI</span>` : r.kind === 'reversal' ? html`<span class="tiny">Gives back a failed payment</span>` : ''}</div>`;
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
  const skipLink = (r) => html`<button class="btn plain" type="button" style="${SMALL}" data-ignore="${r.id}" title="Not business money, e.g. a transfer between your own accounts">Skip</button>`;
  const rulePill = (r) => canRules && r.kind !== 'upi_in' ? html`<button class="btn plain" type="button" style="${SMALL}" data-mkrule="${r.id}" title="Remember this payee's head">Rule</button>` : '';
  const shiftBody = (list) => {
    if (tab === 'done') {
      return html`<div style="border:1px solid var(--line-soft);border-radius:8px">${list.map((r) => html`<div style="display:grid;grid-template-columns:minmax(180px,1.4fr) 120px minmax(200px,2fr);gap:10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line-soft)">${payer(r)}${amt(r)}<div>${suggestion(r)}</div></div>`)}</div>`;
    }
    if (tab === 'in') {
      const found = list.filter((r) => r.candidates.length);
      const rest = list.filter((r) => !r.candidates.length);
      return html`${section('found', 'Bill found', 'Same amount as a confirmed UPI bill', found, (r) => html`
          <div>${r.candidates.length === 1 ? html`<span class="${r.candidates[0].strong ? '' : 'note'}">${candText(r.candidates[0])}</span><input type="hidden" data-cand="${r.id}" value="${candValue(r.candidates[0])}">`
            : html`<select class="compact" data-cand="${r.id}" aria-label="Which bill">${r.candidates.map((k) => html`<option value="${candValue(k)}">${candText(k)}</option>`)}</select>`}
            ${r.candidates[0].adjust ? adjustNote(r.candidates[0]) : ''}</div>
          <div style="display:flex;gap:4px"><button class="btn plain" type="button" style="${SMALL}" data-fixbill="${r.id}" title="Correct the bill (number, amount, discount) to what the bank shows, and match">Fix bill</button>${skipLink(r)}</div>`, 'match')}
        ${section('nobill', 'No bill found', 'A sale nobody billed (e.g. drinks in a rush), or other money received', rest, (r) => html`
          ${lineFields(r)}<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn plain" type="button" style="${SMALL}" data-unbilled="${r.id}" data-type="fnb" title="A sale nobody billed: booked as F&B income">Unbilled F&amp;B</button>
            <button class="btn plain" type="button" style="${SMALL}" data-unbilled="${r.id}" data-type="room" title="A sale nobody billed: booked as Room income">Unbilled Room</button>
            ${skipLink(r)}</div>`, 'book')}`;
    }
    const known = list.filter((r) => r.suggest?.headId);
    const rest = list.filter((r) => !r.suggest?.headId);
    return html`${section('ruled', 'Head suggested', 'From the party\'s past lines or a rule; change anything that is wrong', known, (r) => html`
        ${lineFields(r)}<div style="display:flex;gap:4px">${rulePill(r)}${skipLink(r)}</div>`, 'book')}
      ${section('needs', 'Needs a head', 'Give the item, party and head once: next time the party fills in its head', rest, (r) => html`
        ${lineFields(r)}<div style="display:flex;gap:4px">${rulePill(r)}${skipLink(r)}</div>`, 'book')}`;
  };

  render(shell(biz, 'bank', 'Bank sync', 'Statement lines from each bank account, matched to sales or booked under a head. Nothing is booked until a person confirms it.', html`
    <div id="bmsg"></div>
    <section class="card" style="gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2>Bank accounts</h2>
        <span style="display:flex;gap:10px;align-items:center">${b.accounts.some((a) => a.sheetId) ? html`<button class="btn" type="button" id="banksyncall">Sync all bank accounts</button>` : ''}<a href="#/b/${biz.id}/accounts" class="note">Add a bank account on Accounts</a></span></div>
      ${b.googleEmail ? html`<div class="note">To sync a Google Sheet, share it with <strong class="mono">${b.googleEmail}</strong> as a Viewer.</div>`
        : html`<div class="note">Google Sheets access is not set up yet. Until it is, copy rows from the sheet (Ctrl+A, Ctrl+C) and use <strong>Paste rows</strong>. Lines already in Bookr are skipped.</div>`}
      ${b.accounts.length ? html`<div class="scroll"><table style="min-width:760px"><thead><tr><th>Account</th><th>Receives</th><th>Statement from</th><th style="text-align:right">Lines</th><th></th></tr></thead>
        <tbody>${b.accounts.map(accountRow)}</tbody></table></div>` : html`<div class="note">No bank accounts yet.</div>`}
      <form class="inset" id="pasteform" hidden><div style="font-weight:600" id="pastetitle">Paste rows</div>
        <textarea name="text" rows="6" style="width:100%;font-family:var(--mono, monospace);font-size:13px" placeholder="Copy the rows from the Google Sheet and paste them here. Title and header lines are fine."></textarea>
        <div class="form-row"><button class="btn" type="submit">Add lines</button><button class="btn plain" type="button" id="pastecancel">Cancel</button></div><div class="form-msg"></div></form>
    </section>
    <section class="card" style="gap:10px">
      <form class="form-row" id="bfilter" style="align-items:flex-end">
        <div class="field"><label>Shifts from</label><input type="date" name="from" value="${from}"></div>
        <div class="field"><label>to</label><input type="date" name="to" value="${to}"></div>
        <div class="field"><label>Account</label><select name="account"><option value="">All</option>${b.accounts.map((a) => html`<option value="${a.id}" ${a.id === account ? 'selected' : ''}>${a.name}</option>`)}</select></div>
        <button class="btn plain" type="submit">Show</button>
      </form>
      <div class="form-row" role="tablist" style="gap:6px;border-bottom:1px solid var(--line-soft);padding-bottom:8px">
        ${[['in', 'Money in'], ['out', 'Money out'], ['done', 'Done']].map(([k, l]) => html`<a role="tab" aria-selected="${k === tab}" class="btn ${k === tab ? '' : 'plain'}" style="display:inline-flex;align-items:center" href="${link({ tab: k })}">${l} <span class="chip" style="margin-left:6px;${k === tab ? 'background:rgba(255,255,255,.22);color:#fff' : ''}">${count(k)}</span></a>`)}
      </div>
      ${tab === 'in' ? html`<div class="note">UPI money in is reconciled shift by shift on <a href="#/b/${biz.id}/reconcile/${from}">Reconcile</a>. Use this list for other money received, or to book a credit under any head.</div>` : ''}
      <div class="note">${tab === 'in' ? html`<strong>Match to bill</strong>: the credit is the payment for a bill already counted in sales (nothing new is booked). <strong>Book under a head</strong>: money received that is not a bill, e.g. hostel rent. <strong>Skip</strong>: not business money, e.g. a transfer between your own accounts.`
        : tab === 'out' ? html`<strong>Book under a head</strong>: a payment for the business, e.g. vegetables, salary. <strong>Make a rule</strong> once and the same supplier is suggested every time. <strong>Skip</strong>: not business money, e.g. a transfer between your own accounts.`
        : 'Lines already matched, booked or skipped. Undo puts a line back.'}</div>
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
      }) : html`<div class="note">${tab === 'in' ? 'No money received is waiting' : tab === 'out' ? 'No payments are waiting' : 'Nothing done yet'} for shifts ${dayLabel(from)} to ${dayLabel(to)}${account ? ' in this account' : ''}.</div>`}
    </section>`));
  wireShell();
  const msg = document.getElementById('bmsg');
  const run = async (fn, okText) => {
    try { const r = await fn(); await bankView(biz, query); if (okText) document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">${okText(r)}</div>`.__html; }
    catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  onSubmit(document.getElementById('bfilter'), async (d) => go(link({ from: d.from, to: d.to, account: d.account })));
  document.getElementById('banksyncall')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try { const r = await apiFull('POST', `/businesses/${biz.id}/bank/sync-all`, {}); await bankView(biz, query); document.getElementById('bmsg').innerHTML = syncResultHtml(r).__html; }
    catch (err) { e.target.disabled = false; e.target.textContent = 'Sync all bank accounts'; showError(msg, err); }
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
  document.getElementById('pastecancel').addEventListener('click', () => { pf.hidden = true; });
  pf.addEventListener('submit', async (e) => {
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
  document.getElementById('rulecancel').addEventListener('click', () => { rf.hidden = true; });
  rf.addEventListener('submit', async (e) => {
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

const CARD_TAGS = { wrong_column: 'Wrong UPI column', register_slip: 'Register slip', number_typo: 'Bill number typo', payment_written_wrong: 'Written wrong', paid_in_parts: 'Paid in parts', one_credit_many_bills: 'One table',
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
// A register slip a credit with no bill explains (7 Nov 2026): a payment written as a discount, or one payment's
// amount written wrong. Before confirming the button edits the register row; after, it is a recorded correction
// with the match, undone by Unmatch.
/**
 * Compare's warning for credits not matched yet: one number, the same as Reconcile's, and what each part means. Only
 * the ones with no bill of that amount are listed; the rest are told on their bill's row or found on Reconcile.
 */
function notMatchedHtml(n, href) {
  const amounts = (xs) => xs.slice(0, 6).map((x) => `₹ ${rs(x.amountPaise)} at ${hhmm(x.postedAt)}`).join(', ') + (xs.length > 6 ? ' …' : '');
  const parts = [
    n.noBill.length ? `${n.noBill.length} ${n.noBill.length === 1 ? 'has' : 'have'} no bill of that amount (${amounts(n.noBill)}): a sale not written down, a table paid at once, or money that is not a sale` : '',
    n.unpaired.length ? `${n.unpaired.length} ${n.unpaired.length === 1 ? 'has' : 'have'} a bill of that amount that did not pair: too far in time, or more than one bill fits` : '',
    n.explained.length ? `${n.explained.length} ${n.explained.length === 1 ? 'is' : 'are'} explained on this page, with a button on the bill` : '',
  ].filter(Boolean);
  return html`<div class="cmp-warn">⚠ <strong>${n.all.length} UPI credit${n.all.length === 1 ? '' : 's'} not matched yet</strong>: ${parts.join('; ')}. <a href="${href}">See them on Reconcile</a>. It does not stop confirming.</div>`;
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
async function writeBankOnRow(biz, b, credits) {
  const base = `/businesses/${biz.id}`;
  const u = await api('GET', `${base}/uploads/${b.uploadId}`);
  const r = u.rows.find((x) => x.id === b.rowId);
  if (!r) throw new Error(`Bill ${b.billNo}'s row was not found. Reload the page.`);
  if (r.paidWithRowId) throw new Error(`Bill ${b.billNo} is paid together with another row: correct the payment there.`);
  const norm = (x) => (x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const upi = r.payments.filter((p) => p.mode === 'upi');
  const others = r.payments.filter((p) => p.mode !== 'upi');
  const labelFor = (c) => { const had = upi.find((p) => !c.label || norm(p.columnLabel) === norm(c.label) || norm(p.columnLabel) === 'upi'); return had ? had.columnLabel : c.label ?? upi[0]?.columnLabel ?? 'UPI'; };
  const paid = others.reduce((t, p) => t + p.amountPaise, 0) + credits.reduce((t, c) => t + c.amountPaise, 0);
  const payload = { paidWithRowId: null, billNo: r.billNo, billType: r.billType, amount: rupeesForInput(r.amountPaise), discount: rupeesForInput(r.discountPaise - r.tipPaise), remarks: r.remarks, status: r.status,
    payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })) };
  const put = (x) => apiFull('PUT', `${base}/register-rows/${r.id}`, x);
  await put({ ...payload, discount: rupeesForInput(r.amountPaise - paid),
    payments: [...others.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })),
      ...credits.map((c) => ({ mode: 'upi', columnLabel: labelFor(c), amount: rupeesForInput(c.amountPaise) }))] });
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
const recTabs = (biz, day, tab) => html`<div class="seg rec-tabs" role="tablist" aria-label="Reconcile">
  <a role="tab" class="${tab === 'shift' ? 'on' : ''}" href="#/b/${biz.id}/reconcile${day ? `/${day}` : ''}">This shift</a>
  <a role="tab" class="${tab === 'all' ? 'on' : ''}" href="#/b/${biz.id}/reconcile/all">All unmatched</a></div>`;
const RECONCILE_VIEW_KEY = 'bookr.reconcile.view';
const reconcileViewPref = () => { try { return localStorage.getItem(RECONCILE_VIEW_KEY) === 'open' ? 'open' : 'cards'; } catch { return 'cards'; } };

async function reconcileView(biz, dayArg) {
  const [dayPart, qs = ''] = String(dayArg ?? '').split('?');
  if (dayPart === 'all') return unmatchedView(biz);
  const more = Number(new URLSearchParams(qs).get('more')) || 1;
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
  const [r, v, { heads }] = await Promise.all([api('GET', `/businesses/${biz.id}/shifts/${day}/reconcile`),
    api('GET', `/businesses/${biz.id}/upi?more=${more}&day=${day}`), api('GET', `/businesses/${biz.id}/heads`)]);
  const reload = () => reconcileView(biz, `${day}?more=${v.moreHours}`);
  drawerReload = reload;
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
  const noCredit = r.noCredit.filter((c) => !gone.has(c.key) && !explained(c));
  const noBillLeft = r.noBill.filter((x) => !hinted.some((h) => h.credits.includes(x.creditId)));
  const view = reconcileViewPref();
  const creditCell = (x) => html`${when(x.postedAt)}<div class="tiny">${x.accountName}${x.minutes != null ? ` · ${x.minutes} min from the bill` : ' · register only, no bill time'}</div>`;
  const billsCell = (x) => html`<span class="mono">${x.billNos.join(' + ')}</span>${x.part ? html`<div class="tiny">${x.part}</div>` : ''}`;
  const pairTable = (rows, attr, ticked) => html`<div class="scroll"><table style="min-width:560px"><thead><tr>${attr ? html`<th style="width:36px"></th>` : ''}<th>Bill</th><th style="text-align:right">Amount</th><th>Credit</th></tr></thead><tbody>
    ${rows.map((x) => html`<tr>${attr ? html`<td><input type="checkbox" ${attr}="${x.creditId}" ${ticked ? 'checked' : ''} aria-label="Match bill ${x.billNos.join(' + ')}" style="width:18px;height:18px;min-height:0"></td>` : ''}
      <td>${billsCell(x)}${x.others ? html`<div class="tiny" style="color:#92400E">${x.others} other possible match${x.others > 1 ? 'es' : ''}: check before ticking</div>` : ''}</td><td class="amount">${money(x.amountPaise)}</td><td>${creditCell(x)}</td></tr>`)}
  </tbody></table></div>`;
  const waiting = v.sales.filter((x) => !x.bankRowId);
  const clearCard = r.clear.length ? html`<div class="rv-card" id="laneclear">
    <div class="lane-h"><strong>${r.clear.length} bill${r.clear.length === 1 ? '' : 's'} match the bank exactly</strong><span class="tchip ok">${CARD_TAGS.clear_matches}</span></div>
    <div class="note">Same amount, closest in time, within an hour; each bill and credit used once.${r.confirmed ? '' : ' They are matched when you confirm the shift.'}</div>
    ${r.confirmed ? html`<div class="form-row" style="gap:6px"><button class="btn" type="button" id="matchclear" style="min-height:36px">Match all ${r.clear.length}</button></div>` : ''}
    <details class="cmp-fold"><summary>See the list</summary>${pairTable(r.clear, r.confirmed ? 'data-clear' : '', true)}</details>
    <div class="form-msg" id="clearmsg"></div></div>` : '';
  const likelyCard = r.likely.length ? html`<div class="rv-card">
    <div class="lane-h"><strong>${r.likely.length} likely match${r.likely.length === 1 ? '' : 'es'} for you to check</strong><span class="tchip warn">Likely, not certain</span></div>
    <div class="note">The same amount, but further apart in time or with another possible match. Tick the ones you agree with.</div>
    <details class="cmp-fold"><summary>See the list</summary>${pairTable(r.likely, 'data-likely', false)}</details>
    <div class="form-row" style="gap:6px"><button class="btn" type="button" id="matchlikely" disabled style="min-height:36px">Match 0 ticked</button></div><div class="form-msg" id="likelymsg"></div></div>` : '';
  const noBillCards = noBillLeft.map((x) => html`<div class="rv-card">
    <div class="lane-h"><strong>₹ ${money(x.amountPaise)} came in at ${when(x.postedAt)} with no bill</strong><span class="tchip warn">${CARD_TAGS.no_bill}</span></div>
    <div class="tiny">${x.accountName}${x.remark && !/^(UPI|NA|NO REMARKS?)$/i.test(x.remark) ? ` · ${x.remark}` : ''}</div>
    <div class="note">No bill of this amount: a sale not written down, or money that is not a sale.</div>
    <div class="form-row" style="gap:6px">${r.unbilledHeads.map((h) => html`<button class="btn plain" type="button" style="min-height:36px" data-book="${x.creditId}" data-head="${h.headId}" data-label="${h.billType === 'room' ? 'Room' : 'F&B'}">Unbilled ${h.billType === 'room' ? 'Room' : 'F&B'}</button>`)}
      <a class="btn plain" style="display:inline-flex;align-items:center;min-height:36px" href="#/b/${biz.id}/bank?from=${day}&to=${addDaysIso(day, 1)}">Another head…</a></div></div>`);
  const nothing = !r.clear.length && !cols.length && !fixes.length && !r.likely.length && !noCredit.length && !noBillLeft.length;
  const suggestions = html`<section class="card lane" style="gap:10px">
    <div class="rv-cards">${clearCard}${cols.map((c) => suggestionCard(c, day))}${fixes.map((c) => suggestionCard(c, day))}${likelyCard}${noCredit.map((c) => suggestionCard(c, day))}${noBillCards}</div>
    ${nothing ? html`<div class="note">${done ? 'No suggestions: nothing is left to explain.' : 'No suggestions for what is left. Open the entries to compare them yourself.'}</div>` : ''}
  </section>`;
  // A register slip or wrong column the bank shows, with its button, under the entries it explains (7 Nov 2026).
  const fixLine = (k) => (k ? html`<div data-card="${k.key}" style="padding:0 10px 8px 40px"><div class="tiny" style="color:#92400E">${k.title}</div>
    <button class="btn plain dchip" type="button" data-cardact="${k.key}" data-i="0" style="margin-top:4px">${k.actions[0].label}</button><div class="form-msg"></div></div>` : '');
  const trialLists = r.open ? html`<section class="card" style="gap:10px" id="trialopen">
    <div class="note">To correct a bill, open its row: it opens beside the list with its photo. Where the bank shows a slip, the fix is under the entry. Tick entries to compare their totals; matching by hand starts after confirming.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">
      <div><strong>Credits not matched yet</strong> <span class="chip">${r.open.credits.length}</span>${covered && r.open.credits.length ? html`<div class="tiny">${r.open.credits.filter((c) => c.noBill).length} with no bill of that amount (marked); the rest have a bill of that amount that did not pair.</div>` : ''}
        ${r.open.credits.map((c) => html`<label class="um-line"><input type="checkbox" data-tside="cr" data-amt="${c.amountPaise}" data-id="${c.id}"><span style="flex:1">${when(c.postedAt)}<span class="tiny" style="display:block">${c.accountName ?? ''}${c.noBill && covered ? html` · <span style="color:var(--danger)">no bill of this amount</span>` : ''}</span></span><strong class="amount">₹ ${money(c.amountPaise)}</strong></label>${fixLine(cols.find((k) => k.actions[0].op === 'slip' ? slipCredits(k.actions[0].slip).includes(c.id) : k.actions[0].hint?.creditId === c.id))}`)}</div>
      <div><strong>UPI bills not in the bank yet</strong> <span class="chip">${r.open.bills.length}</span>
        ${r.open.bills.map((b) => html`<label class="um-line"><input type="checkbox" data-tside="bl" data-amt="${b.amountPaise}" data-id="${b.id}"><span style="flex:1"><span class="mono">${b.billNo}</span>${b.grouped ? html` <span class="chip">paid together</span>` : ''}${b.billNo ? html` <button type="button" class="linkbtn tiny" data-bill-drawer="${b.billNo}|${day}">Open row</button>` : ''}<span class="tiny" style="display:block">${b.paidAt ? when(b.paidAt) : 'register only'}</span></span><strong class="amount">₹ ${money(b.amountPaise)}</strong></label>${fixLine(cols.find((k) => k.billNos.includes(b.billNo)))}`)}</div>
    </div>
    <div id="trialsum" class="note">Tick entries to compare them.</div><div id="trialfix"></div></section>` : '';
  const doneFold = r.done.length || r.booked.length ? html`<details class="card cmp-fold"><summary><h2>Done (${r.done.length + r.booked.length})</h2></summary>
      <div class="scroll"><table style="min-width:620px"><thead><tr><th>Bill</th><th style="text-align:right">Amount</th><th>Credit</th><th></th></tr></thead><tbody>
        ${r.done.map((x) => html`<tr><td class="mono">${x.bills.join(' + ')}</td><td class="amount">${money(x.creditPaise ?? x.billsPaise)}</td><td>${when(x.postedAt)}<div class="tiny">${x.accountName}</div></td>
          <td><button class="btn plain dchip" type="button" data-unmatch="${x.rowId}">Unmatch</button></td></tr>`)}
        ${r.booked.map((x) => html`<tr><td>${x.headName ?? 'Booked'}${x.note ? html`<div class="tiny">${x.note}</div>` : ''}</td><td class="amount">${money(x.amountPaise)}</td><td>${when(x.postedAt)}</td>
          <td><button class="btn plain dchip" type="button" data-putback="${x.id}">Put back</button></td></tr>`)}
      </tbody></table></div></details>` : '';
  render(shell(biz, 'reconcile', 'Reconcile', '', html`
    ${shiftBar(biz, day, 'reconcile')}
    ${recTabs(biz, day, 'shift')}
    <section class="card cmp-bar">
      <div class="cmp-top">
        <div class="cmp-day">
          ${done ? html`<span class="chip ok">UPI reconciled</span>` : html`<span class="chip wait">Left to explain: ${s.billsLeft} bill${s.billsLeft === 1 ? '' : 's'}, ${s.creditsLeft} credit${s.creditsLeft === 1 ? '' : 's'} not matched</span>`}
          ${r.confirmed ? '' : html`<span class="chip">Not confirmed</span>`}
        </div>
        <a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/bank?from=${day}&to=${day}">Bank sync</a>
      </div>
      <div class="rec-strip">
        <div><div class="tiny">UPI ${r.confirmed ? 'counted' : 'on this shift'}</div><div class="amount rec-n">₹ ${money(s.upiSalesPaise)}</div><div class="tiny">${s.bills} bill${s.bills === 1 ? '' : 's'}</div></div>
        <div><div class="tiny">${r.confirmed ? 'Matched to the bank' : 'Would match the bank'}</div><div class="amount rec-n" style="color:var(--teal)">₹ ${money(s.matchedPaise)}</div></div>
        <div><div class="tiny">Bills not in the bank yet</div><div class="amount rec-n" style="color:${s.billsLeft ? 'var(--danger)' : 'inherit'}">₹ ${money(s.billsLeftPaise)}</div><div class="tiny">${s.billsLeft} bill${s.billsLeft === 1 ? '' : 's'}</div></div>
        <div><div class="tiny">Credits not matched yet</div><div class="amount rec-n" style="color:${s.creditsLeft ? 'var(--danger)' : 'inherit'}">₹ ${money(s.creditsLeftPaise)}</div><div class="tiny">${s.creditsLeft} credit${s.creditsLeft === 1 ? '' : 's'}${s.creditsLeft && covered ? ` · ${s.creditsNoBill ?? 0} with no bill of that amount` : ''}</div></div>
      </div>
    </section>
    <div id="recmsg"></div>
    ${r.confirmed ? html`<div class="note">Confirmed shift: each fix here is a recorded correction, and can be undone.</div>`
      : html`<div class="note" style="background:#FFFBEB;padding:8px 10px;border-radius:6px"><strong>Trial reconcile.</strong> Nothing is saved until you <a href="#/b/${biz.id}/compare/${day}">confirm the shift on Compare sales</a>. Corrections here change the register row, and only Owner and Accountant decide differences. It is optional, and never stops a confirm.</div>`}
    ${covered ? '' : html`<div class="cmp-warn">⚠ Bank data is not in for the whole shift: the latest line is ${r.coverage.lastBankAt ? when(r.coverage.lastBankAt) : 'missing'}, the shift ends ${when(r.coverage.shiftEnd)}. Sync the bank first; until then, bills with no credit are not flagged.</div>`}
    <div class="lane-h"><div class="seg" id="recview"><button type="button" data-view="cards" class="${view === 'cards' ? 'on' : ''}">Suggestions</button><button type="button" data-view="open" class="${view === 'open' ? 'on' : ''}">All open entries</button></div></div>
    ${view === 'cards' ? suggestions : r.confirmed ? pairPanel(v, waiting) : trialLists}
    ${doneFold}`));
  wireShell();
  const msg = document.getElementById('recmsg');
  wireShiftBar(biz, days);
  document.querySelectorAll('#recview [data-view]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem(RECONCILE_VIEW_KEY, b.dataset.view); } catch { /* storage unavailable */ }
    reload();
  }));
  // Fixes and open entries work on both sides of confirming; the matching below needs a confirmed shift.
  wireExplain({ cards: [...cols, ...fixes, ...noCredit] }, reload, biz);
  const trialBox = document.getElementById('trialopen');
  trialBox?.querySelectorAll('[data-tside]').forEach((x) => x.addEventListener('change', () => {
    const sum = (side) => [...trialBox.querySelectorAll(`[data-tside="${side}"]`)].filter((c) => c.checked).reduce((t, c) => t + Number(c.dataset.amt), 0);
    const bank = sum('cr'); const bills = sum('bl'); const diff = bank - bills;
    document.getElementById('trialsum').innerHTML = html`Bank <strong>₹ ${money(bank)}</strong> · Bills <strong>₹ ${money(bills)}</strong> · Difference <strong style="color:${diff ? 'var(--danger)' : 'var(--teal)'}">₹ ${money(Math.abs(diff))}</strong>`.__html;
    drawTrialFix();
  }));
  // Ticked credit(s) and one bill, before confirming: write what the bank got on the bill's register row (its UPI
  // payments become the credits, the difference a tip or a discount), so they pair (approved 8 Nov 2026).
  const pickedTrial = () => {
    const ids = (side) => [...trialBox.querySelectorAll(`[data-tside="${side}"]`)].filter((c) => c.checked).map((c) => c.dataset.id);
    return { credits: ids('cr').map((id) => r.open.credits.find((c) => c.id === id)), bills: ids('bl').map((id) => r.open.bills.find((b) => b.id === id)) };
  };
  const drawTrialFix = () => {
    const box = document.getElementById('trialfix');
    if (!box) return;
    const { credits, bills } = pickedTrial();
    if (!credits.length || !bills.length) { box.innerHTML = ''; return; }
    const b = bills[0];
    const why = bills.length > 1 ? 'Tick one bill: several bills paid by one credit are bills paid together, written on the row with the payment.'
      : b.grouped ? 'This bill is paid together with others: correct the payment on the row that holds it (Open row).'
      : !b.rowId ? `Bill ${b.billNo} is only in the software report, so there is no register row to write on. Confirm the shift, then match them on this page: Match by hand takes the difference as a discount or tip.` : null;
    if (why) { box.innerHTML = html`<div class="note">${why}</div>`.__html; return; }
    const bank = credits.reduce((t, c) => t + c.amountPaise, 0);
    const diff = bank - b.amountPaise;
    const label = `Write ${credits.map((c) => `₹ ${money(c.amountPaise)}`).join(' + ')} by UPI on bill ${b.billNo}${diff > 0 ? `, ₹ ${money(diff)} as tip` : diff < 0 ? `, ₹ ${money(-diff)} as discount` : ''}`;
    box.innerHTML = html`<div class="form-row" style="gap:8px;align-items:center;margin-top:6px"><button class="btn" type="button" id="trialfixgo" style="min-height:36px">${label}</button>
      <span class="note">Changes the register row as Open row would. Check the photo first.</span></div><div class="form-msg"></div>`.__html;
    document.getElementById('trialfixgo').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const undo = await writeBankOnRow(biz, b, credits);
        await reload();
        doneToast(`Bill ${b.billNo}: the bank's payment is written on the register.`, undo, reload);
      } catch (err) { btn.disabled = false; showError(box.querySelector('.form-msg'), err); }
    });
  };
  if (!r.confirmed) return;
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
      { text: `Matched ${ids.length} bill${ids.length === 1 ? '' : 's'} to the bank.`, undo: async () => { for (const id of ids) await unmatch(id); } });
  });
  const likelyBtn = document.getElementById('matchlikely');
  app.querySelectorAll('[data-likely]').forEach((x) => x.addEventListener('change', () => {
    const n = ticked('data-likely').length;
    likelyBtn.textContent = `Match ${n} ticked`; likelyBtn.disabled = !n;
  }));
  likelyBtn?.addEventListener('click', () => {
    likelyBtn.disabled = true;
    const pairs = ticked('data-likely').map((x) => r.likely.find((l) => l.creditId === x.dataset.likely));
    act(async () => { for (const p of pairs) await apiFull('POST', `/businesses/${biz.id}/bank-rows/${p.creditId}/match`, { transactionIds: p.transactionIds }); },
      { text: `Matched ${pairs.length} bill${pairs.length === 1 ? '' : 's'} to the bank.`, undo: async () => { for (const p of pairs) await unmatch(p.creditId); } });
  });
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
  const u = await api('GET', `/businesses/${biz.id}/unmatched`);
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
        <div class="seg" id="umseg">${[['all', 'All'], ['bill', 'Bills'], ['credit', 'Credits'], ['closed', `Closed (${u.closed.length})`]].map(([k, l]) => html`<button type="button" data-seg="${k}" class="${unmatchedState.seg === k ? 'on' : ''}">${l}</button>`)}</div>
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
  body.className = 'um-body';
  body.innerHTML = html`<div class="note">${why}</div>
    <div class="tiny">${x.side === 'bill' ? html`${x.paidAt ? `Paid at ${when(x.paidAt)}` : 'Register only, no bill time'}${x.labels ? ` · written under ${x.labels}` : ''}`
      : html`${x.accountName ?? ''}${x.vpa ? ` · ${x.vpa}` : ''}${x.remark && !/^(UPI|NA|NO REMARKS?)$/i.test(x.remark) ? ` · ${x.remark}` : ''}`}</div>
    ${cards.length ? html`<div class="rv-cards">${cards.map((c) => suggestionCard(c, x.day))}</div>` : ''}
    ${others.length ? html`<div><strong>Closest possible</strong>${others.map((o) => html`<div class="um-line" style="cursor:default"><span style="flex:1">${o.side === 'bill' ? html`Bill <span class="mono">${o.billNo ?? ''}</span>` : `Credit at ${when(o.postedAt)}`}
      <span class="tiny" style="display:block">${dayLabel(o.day)} shift${o.amountPaise !== x.amountPaise ? ` · ₹ ${money(Math.abs(o.amountPaise - x.amountPaise))} ${o.amountPaise > x.amountPaise ? 'more' : 'less'}` : ' · same amount'}</span></span><span class="amount">₹ ${money(o.amountPaise)}</span></div>`)}</div>` : html`<div class="tiny">Nothing open comes close to this amount.</div>`}
    <div class="form-row" style="gap:6px">
      ${x.side === 'credit' ? html`${r.confirmed ? r.unbilledHeads.map((h) => html`<button class="btn plain" type="button" style="min-height:36px" data-umbook="${h.headId}" data-label="${h.billType === 'room' ? 'Room' : 'F&B'}">Unbilled ${h.billType === 'room' ? 'Room' : 'F&B'}</button>`) : ''}
        <a class="btn plain" style="display:inline-flex;align-items:center;min-height:36px" href="#/b/${biz.id}/bank?from=${x.day}&to=${addDaysIso(x.day, 1)}">Another head…</a>
        <button class="btn plain" type="button" style="min-height:36px" data-umignore="1">Not a sale, close</button>`
      : html`<button class="btn plain" type="button" style="min-height:36px" data-umrepay="cash">Was cash</button><button class="btn plain" type="button" style="min-height:36px" data-umrepay="card">Was card</button>
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
  const changed = a.op === 'fixNumber' ? { ...payload, billNo: a.billNo }
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
  return async () => {
    for (const id of ids) {
      await apiFull('DELETE', `${base}/bank-rows/${id}/match`, {}).catch((e) => { if (ids.length === 1) throw e; });
    }
  };
}
function wireExplain(ex, reload, biz, root = document) {
  if (!ex) return;
  root.querySelectorAll('[data-cardact]').forEach((b) => b.addEventListener('click', async () => {
    const c = ex.cards.find((x) => x.key === b.dataset.cardact);
    const a = c.actions[Number(b.dataset.i)];
    b.disabled = true;
    try {
      let undo = null;
      if (a.op === 'setColumn') undo = await setColumn(biz, a);
      else if (a.op === 'slip') undo = await applySlip(biz, a);
      else if (a.op) undo = await changeRegisterRow(biz, a);
      else undo = undoFor(biz, a, await apiFull(a.method, `${a.path}`, a.body));
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
function pairPanel(v, waiting) {
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
    ${v.repaid?.length ? html`<div style="border-top:1px solid var(--line-soft);padding-top:10px;display:flex;flex-direction:column;gap:6px">
      <strong>Changed here from UPI to cash or card</strong>
      ${v.repaid.map((x) => html`<div class="form-row" style="align-items:center;gap:10px">
        <span class="mono">${(x.bills ?? []).join(' + ')}</span><span>₹ ${money(x.amountPaise)} → <strong>${x.mode === 'cash' ? 'Cash' : 'Card'}</strong></span>
        <span class="note">${x.note ?? ''} · ${when(x.at)}</span><button class="btn plain" type="button" data-repayundo="${x.id}" style="min-height:32px">Put back</button></div>`)}
    </div>` : ''}
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
  box.querySelectorAll('[data-repayundo]').forEach((b) => b.addEventListener('click', async () => {
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
  const v = await api('GET', `/businesses/${biz.id}/shifts/${day}/inputs`);
  const pagesOf = (k) => v.pages.filter((p) => p.kind === k);
  const regs = pagesOf('bill_register');
  const softwareOk = v.software.reports > 0 && !v.software.gaps.length;
  const bankOk = !v.bank || v.bank.covered;
  const pagesOk = regs.length > 0 && regs.every((p) => ['ready', 'approved'].includes(p.status)) && pagesOf('cash_summary').length > 0;
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
  const pageState = (p, n) => ['ready', 'approved'].includes(p.status) ? html`<span class="okdot" style="${p.unclear ? 'background:#F59E0B' : ''}"></span><span class="nm">Page ${n} · ${what(p)}</span>`
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
  render(shell(biz, 'bringin', 'Bring in', `Everything for one shift, in order. ${dayLabel(day)} 8 am → ${dayLabel(addDaysIso(day, 1))} 8 am.`, html`
    <div class="form-row" style="align-items:center;gap:10px"><label for="bid" class="note">Shift</label>
      <input id="bid" type="date" value="${day}" class="compact" style="max-width:180px">
      <button class="linkbtn" type="button" data-shift="${addDaysIso(day, -1)}">← Day before</button>
      <button class="linkbtn" type="button" data-shift="${addDaysIso(day, 1)}">Day after →</button>
      ${v.shiftStatus === 'confirmed' ? html`<span class="chip ok">Confirmed</span>` : ''}</div>
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
        <span class="tiny">${a.lastAt ? `up to ${when(a.lastAt)}` : 'nothing yet'}${a.sheet ? '' : ' · pasted'}</span></div>`)}</div>
      <div class="form-row" style="align-items:center"><button class="btn" type="button" id="syncall">Sync all bank accounts</button>
        <span class="tiny">Pasted accounts: <a href="#/b/${biz.id}/bank">Bank sync</a></span></div>
      <div id="syncbox"></div>
    </section>` : ''}

    <section class="card step-card" id="step-pages">
      ${head('📷', pagesOk, regs.length > 0, 'Pages', 'Drop each photo on its tile. Claude starts reading at once; you tick the rows on Review.')}
      <div class="tiles">${tile('bill_register', '🧾', 'Bill register', 'Register pages')}${tile('expense_list', '🛒', 'Expense list', 'Cash expenses')}${tile('cash_summary', '💰', 'Cash summary', "The day's cash page")}</div>
    </section>

    <section class="card step-card" id="step-ready" style="${allOk ? 'border-color:#86EFAC;background:#F0FDF4' : ''}">
      ${head('✨', allOk, false, allOk ? 'Everything is in' : 'Then', allOk ? 'Go and match the shift.' : `Still to come: ${[!softwareOk && 'software report', v.bank && !bankOk && 'bank up to 8 am', !pagesOk && (regs.length ? 'pages read and a cash summary' : 'register pages')].filter(Boolean).join(' · ')}`)}
      <div class="form-row"><a class="btn" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/compare/${day}">Compare sales →</a>
        ${v.bank ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/reconcile/${day}">Reconcile</a>` : ''}</div>
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
  document.getElementById('bid').addEventListener('change', (e) => go(`#/b/${biz.id}/bringin/${e.target.value}`));
  app.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => go(`#/b/${biz.id}/bringin/${b.dataset.shift}`)));
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
    catch (err) { b.disabled = false; b.textContent = 'Sync all bank accounts'; showError(document.getElementById('syncbox'), err); }
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

/** A short check of a software CSV before importing it: what matters at a glance, the rest one tap away. */
async function csvCard(biz, day, csv, name, card, done, cancel) {
  let p;
  try { p = await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv, dryRun: true }); }
  catch (err) { card.innerHTML = html`<div class="fileline"><span class="greydot" style="background:#F59E0B"></span><span class="nm">${name}</span></div><div class="form-msg"></div>`.__html; return showError(card.querySelector('.form-msg'), err); }
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
    : html`<div class="note">No account has a Google Sheet set up. Use Set up on Bank sync.</div>`}</div>`;
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
  d.innerHTML = '<div class="note">Loading…</div>';
  let b;
  try { b = await api('GET', `/businesses/${biz.id}/bills/${encodeURIComponent(billNo)}${day ? `?day=${day}` : ''}`); }
  catch (err) { showError(d, err); return; }
  const section = (title, body) => html`<section style="border-top:1px solid var(--line-soft);padding-top:10px;display:flex;flex-direction:column;gap:4px"><strong>${title}</strong>${body}</section>`;
  const c0 = b.comparisons[0];
  d.innerHTML = html`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 class="mono" style="margin:0">Bill ${b.billNo}</h2>
      <button class="btn plain" type="button" id="drawerclose" aria-label="Close">Close ✕</button></div>
    ${section('Software', b.comparisons.some((c) => c.sw_amount_paise != null) ? b.comparisons.filter((c) => c.sw_amount_paise != null).map((c) => html`<div>₹ ${money(c.sw_amount_paise)} · ${MODE_LABELS[c.sw_mode] ?? c.sw_mode}${c.paid_at ? ` · paid ${when(c.paid_at)}` : ''} · ${dayLabel(c.shift_day)} shift</div>`) : html`<div class="note">Not in the software report.</div>`)}
    ${section('Register', b.register.length ? b.register.map((r) => html`<div>₹ ${money(r.amount_paise)}${r.discount_paise ? ` · discount ₹ ${money(r.discount_paise)}` : ''}${r.tip_paise ? ` · tip ₹ ${money(r.tip_paise)}` : ''} · ${TYPE_LABELS[r.bill_type] ?? 'no type'}
        ${r.adjusted ? html` <span class="chip" style="background:#E3F1EF">Adjusted from bank</span>` : ''}
        <div class="note">Paid ${r.payments.map((p) => `${p.label || MODE_LABELS[p.mode]} ₹ ${money(p.amountPaise)}`).join(' + ') || 'none written'}${r.paid_with_row_id ? ' (paid together with another bill)' : ''}${r.remarks ? ` · ${r.remarks}` : ''} · line ${r.line_no}</div>
        <a href="#/b/${biz.id}/review/${r.upload_id}/${r.id}">Open on its register page (with the photo)</a></div>`) : html`<div class="note">Not in the register.</div>`)}
    ${section('Comparison', b.comparisons.length ? b.comparisons.map((c) => html`<div>${dayLabel(c.shift_day)} shift: <span class="chip ${c.difference === 'match' ? 'ok' : 'wait'}">${DIFF_LABELS[c.difference]}</span>
        ${c.decision ? ` · ${DECISION_LABELS[c.decision]}${c.note ? `: ${c.note}` : ''}` : ''}${c.shift_status === 'confirmed' ? ' · confirmed' : ''}
        <div><a href="#/b/${biz.id}/compare/${c.shift_day}">Open on Compare sales</a></div></div>`) : html`<div class="note">No comparison.</div>`)}
    ${section('Money', b.sales.length ? b.sales.map((x) => {
      const paid = b.money.filter((m) => m.saleId === x.id);
      return html`<div>Sale ₹ ${money(x.amount_paise)} · ${MODE_LABELS[x.payment_mode] ?? x.payment_mode}${x.head ? ` · ${x.head}` : ''}
        <div class="note">${paid.length ? paid.map((m) => `In the bank: ₹ ${money(m.appliedPaise)} of ₹ ${money(m.amountPaise)} at ${when(m.postedAt)} · ${m.accountName}${m.vpa ? ` · ${m.vpa}` : ''}`).join('; ')
          : x.payment_mode === 'cash' ? 'Cash: counted in the shift\'s cash check.' : x.match_status === 'awaiting_card_settlement' ? 'Waiting for the card settlement.' : x.match_status === 'awaiting_bank_match' ? 'Not found in the bank yet.' : ''}</div></div>`;
    }) : html`<div class="note">${c0?.shift_status === 'confirmed' ? 'Not counted as a sale.' : 'Counted once the shift is confirmed.'}</div>`)}
    ${section('History', b.history.length ? b.history.map((h) => html`<div class="tiny">${when(h.at)} · ${h.user ?? 'Bookr'} · ${HISTORY_LABELS[h.action] ?? h.action}</div>`) : html`<div class="note">Nothing yet.</div>`)}
    ${c0 && b.sales.some((x) => x.match_status === 'awaiting_bank_match') ? html`<div><a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/reconcile/${c0.shift_day}">Match or fix on Reconcile</a></div>` : ''}`.__html;
  document.getElementById('drawerclose').addEventListener('click', () => d.remove());
  // The register line, editable here with its photo, so a slip is corrected without leaving the page (7 Nov 2026).
  const lines = b.register.filter((r) => r.upload_id);
  for (const r of lines.slice(0, 2).reverse()) await drawerEditor(biz, d, r, billNo, day);
}
/** What the page under the drawer reloads after a change (set by Compare sales and Reconcile). */
let drawerReload = null;
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
  box.innerHTML = html`<strong>Register line · page ${u.pageNo ?? 1}, row ${r.lineNo}</strong>
    ${u.fromSoftware ? '' : html`<div class="strip" style="height:110px"><canvas></canvas><span class="band"></span>
      <span class="strip-tools"><span class="tiny"></span><button type="button" class="iconbtn" title="Turn the photo" aria-label="Turn the photo">⟳</button></span></div>`}
    ${locked ? html`<div class="note">The shift is confirmed, so this line is locked. Corrections from the bank are made on Reconcile.</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px">
      ${field('billNo', 'Bill no.', r.billNo ?? '')}${field('amount', 'Amount', rsIn(r.amountPaise))}${field('discount', 'Discount (− tip)', rsIn(r.discountPaise))}
      ${member ? '' : PAY_COLS.map(([, label], i) => field(`pay${i}`, label, cols[i].map((p) => rsIn(p.amountPaise)).join(' + '), 'placeholder="0" title="1000 + 500 is two payments"'))}
    </div>
    ${member ? html`<div class="note">Paid with another bill's payment: change the payment on that bill.</div>` : ''}
    ${locked ? '' : html`<div class="form-row" style="gap:6px"><button class="btn" type="button" data-dsave>Save the row</button>
      <a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/review/${u.id}/${r.id}">Open on Review</a></div>`}
    <div class="form-msg"></div>`.__html;
  d.children[0].after(box);
  if (!u.fromSoftware) wireStrip(u, `/api/businesses/${biz.id}/uploads/${u.id}/file`, box).show(r);
  const before = { paidWithRowId: r.paidWithRowId, billNo: r.billNo, billType: r.billType, amount: rupeesForInput(r.amountPaise), discount: rupeesForInput(r.discountPaise), remarks: r.remarks, status: r.status,
    payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) })) };
  box.querySelector('[data-dsave]')?.addEventListener('click', async (e) => {
    const v = (f) => box.querySelector(`[data-df="${f}"]`)?.value.trim() ?? '';
    const payments = member ? before.payments : PAY_COLS.flatMap(([mode, label], i) => v(`pay${i}`).split('+').map((x) => x.trim()).filter(Boolean)
      .map((amount) => ({ mode, columnLabel: cols[i][0]?.columnLabel ?? label, amount })));
    const after = { ...before, billNo: v('billNo'), amount: v('amount') || '0', discount: v('discount') || '0', payments };
    const put = (x) => apiFull('PUT', `/businesses/${biz.id}/register-rows/${r.id}`, x);
    const reload = async () => { await (drawerReload ?? route)(); };
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await put(after);
      await reload();
      await openBillDrawer(biz, after.billNo || billNo, day);
      doneToast(`Bill ${after.billNo || billNo}: register row saved.`, async () => { await put(before); }, async () => { await reload(); if (document.getElementById('billdrawer')) await openBillDrawer(biz, billNo, day); });
    } catch (err) { btn.disabled = false; showError(box.querySelector('.form-msg'), err); }
  });
}
const HISTORY_LABELS = {
  'comparison.decide': 'Decided', 'comparison.decision_cleared': 'Decision cleared (data changed)', 'register.added_from_software': 'Added to the register from the software report',
  'bank.match': 'Matched to a bank credit', 'bank.match_set': 'Matched by hand', 'bank.match_adjust_bills': 'Matched; register corrected to the bank amount', 'bank.fix_bill': 'Bill fixed from the bank',
  'bank.unmatch': 'Unmatched (changes put back)', 'sale.repaid': 'Changed to cash or card', 'sale.repay_undone': 'Put back to UPI', 'shift.confirm': 'Shift confirmed', 'shift.reopen': 'Shift reopened',
  'transaction.approve': 'Approved', 'register.fill_discounts': 'Discounts filled in',
};
// Any element with data-bill-drawer="billNo|day" opens the drawer.
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-bill-drawer]');
  if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const [no, day] = el.dataset.billDrawer.split('|');
  const biz = { id: currentBizId() };
  openBillDrawer(biz, no, day || null);
}, true);
const drawerBtn = (billNo, day) => html`<button type="button" class="btn plain" data-bill-drawer="${billNo}|${day ?? ''}" title="Everything about this bill" style="min-height:26px;padding:0 6px;font-size:12px;margin-left:4px">Details</button>`;

// ---------- router

async function route() {
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
      const detail = await api('GET', `/businesses/${summary.id}`);
      const biz = { ...summary, ...detail, actions: summary.actions };
      const [screen, query = ''] = (parts[2] || 'dashboard').split('?');
      if (screen === 'accounts') return accountsView(biz, parts[3]);
      if (screen === 'heads') return headsView(biz, parts[3]);
      if (screen === 'users' && biz.role === 'owner') return usersView(biz, parts[3]);
      const item = NAV.find((n) => n.key === screen);
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
      if (screen === 'compare') return compareView(biz, parts[3]);
      if (screen === 'bank') return bankView(biz, query);
      if (screen === 'bringin') return bringInView(biz, parts[3]);
      if (screen === 'reconcile' || screen === 'upi') return reconcileView(biz, parts[3]);
      if (screen === 'reports') return reportsView(biz, query);
      if (screen === 'money-out') return moneyOutView(biz, query);
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

window.addEventListener('hashchange', route);
route();
