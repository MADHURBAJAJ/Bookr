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

async function api(method, path, body) {
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
const rupeesForInput = (p) => { const r = rupeeParts(p); return `${r.neg ? '-' : ''}${r.rupees}.${r.paise}`; };
const home = (b) => `#/b/${b.id}/${b.actions.includes('reports.view') ? 'dashboard' : b.actions.includes('rows.upload') ? 'upload' : 'accounts'}`;
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
  { key: 'upload', label: 'Upload', needs: 'rows.upload' },
  { key: 'review', label: 'Review', needs: 'rows.edit' },
  { key: 'compare', label: 'Compare sales', needs: 'sales.view' },
  { key: 'bank', label: 'Bank sync', phase: 3 },
  { key: 'upi', label: 'UPI matching', phase: 3 },
  { key: 'accounts', label: 'Accounts' },
  { key: 'heads', label: 'Heads and rules' },
  { key: 'reports', label: 'Reports', phase: 4, needs: 'reports.view' },
  { key: 'export', label: 'Export', phase: 5 },
  { key: 'users', label: 'Users and roles', owner: true },
];

function shell(biz, current, title, subtitle, body) {
  const nav = NAV.filter((n) => (!n.owner || biz.role === 'owner') && (!n.needs || biz.actions.includes(n.needs))).map((n) => html`
    <a class="nav ${n.key === current ? 'on' : ''}" href="#/b/${biz.id}/${n.key}">
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
      ${biz.isDemo ? html`<div class="demo-band">Demo business. Sample data only.</div>` : ''}
      <div class="head">
        <div style="display:flex;flex-direction:column;gap:4px">
          <h1>${title}</h1>
          ${subtitle ? html`<div class="sub">${subtitle}</div>` : ''}
        </div>
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
  const { accounts, heads } = await api('GET', `/businesses/${biz.id}/dashboard`);
  const total = accounts.reduce((s, a) => s + a.openingBalancePaise, 0);
  render(shell(biz, 'dashboard', 'Dashboard', 'Totals, the weekly chart and items needing attention arrive in Phase 4.', html`
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
  const [{ heads }, { billTypeHeads }] = await Promise.all([
    api('GET', `/businesses/${biz.id}/heads`),
    api('GET', `/businesses/${biz.id}/bill-type-heads`),
  ]);
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
    </div>`);
  const addBtn = (type, label) => canEdit ? html`<a class="btn ghost" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/heads/new-${type}">${label}</a>` : '';
  const newType = editId === 'new-income' ? 'income' : editId === 'new-expense' ? 'expense' : null;
  const showForm = canEdit && (editing || newType);
  render(shell(biz, 'heads', 'Heads and rules', 'Only Owner and Accountant can change these.', html`
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
            <a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/heads">Cancel</a>
          </div>
        </form>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <h2>Auto-tag rules</h2><span class="note">Checked top to bottom. First match wins.</span>
        </div>
        <div class="note">Rules arrive in Phase 3, with bank sync and tagging.</div>
        <div class="note">Rules are kept per business. You can copy them to another business later.</div>
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
      </section>
    </div>`));
  wireShell();
  app.querySelectorAll('[data-billtype]').forEach((sel) => sel.addEventListener('change', async () => {
    const msg = document.getElementById('btmsg');
    try { await api('PUT', `/businesses/${biz.id}/bill-type-heads/${sel.dataset.billtype}`, { headId: sel.value }); msg.innerHTML = '<div class="ok-msg">Saved.</div>'; }
    catch (e) { msg.innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  }));
  const form = document.getElementById('head');
  form && onSubmit(form, async (d) => {
    if (editing) await api('PATCH', `/businesses/${biz.id}/heads/${editing.id}`, d);
    else await api('POST', `/businesses/${biz.id}/heads`, { ...d, type: newType });
    go(`#/b/${biz.id}/heads`);
  });
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
const DECISION_LABELS = { use_software: 'Use software', use_register: 'Use register', leave_out: 'Leave out' };
const STATUS_CHIPS = {
  uploaded: ['Uploaded', 'wait'], reading: ['Reading', 'wait'], ready: ['Ready to review', 'info'], retake: ['Retake needed', 'bad'],
  approved: ['Approved', 'ok'], failed: ['Failed', 'bad'],
};
const chip = (status) => { const [t, k] = STATUS_CHIPS[status] ?? [status, '']; return html`<span class="chip ${k}">${t}</span>`; };

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
  const res = await fetch(`/api${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error ?? 'Something went wrong.'); e.problems = data?.problems; throw e; }
  return data;
}

// ---------- Upload

async function uploadView(biz) {
  const { uploads } = await api('GET', `/businesses/${biz.id}/uploads`);
  render(shell(biz, 'upload', 'Upload', 'Each file is sent straight to the server. You check every row before it counts.', html`
    <section class="card">
      <form id="up" class="form-row" style="align-items:flex-end">
        <div class="field"><label for="ud">Day</label><input id="ud" name="day" type="date" value="${todayIst()}" required></div>
        <div class="field"><label for="uk">What is it?</label><select id="uk" name="kind">
          ${Object.entries(KIND_LABELS).map(([k, l]) => html`<option value="${k}">${l}${k === 'software_sales_csv' ? ' (CSV)' : ''}</option>`)}</select></div>
        <div class="field" style="flex:2 1 260px"><label for="uf">File</label><input id="uf" name="file" type="file" accept=".csv,text/csv" required></div>
        <button class="btn" type="submit">Upload</button>
      </form>
      <div class="note" id="uhint">A CSV from the hotel software is checked against its own footer before anything is saved.</div>
      <div id="umsg"></div>
      <div id="preview"></div>
    </section>
    <section class="card" style="gap:4px">
      <h2 style="margin-bottom:8px">Recent uploads</h2>
      ${uploads.length ? uploads.map((u) => html`
        <div class="list-row">
          <span><strong>${KIND_LABELS[u.kind]}</strong> · ${dayLabel(u.day)}${u.rows != null ? ` · ${u.rows} row${u.rows === 1 ? '' : 's'}` : ''}</span>
          <span style="display:flex;gap:10px;align-items:center">${chip(u.status)}
            ${u.kind === 'software_sales_csv' ? html`<a href="#/b/${biz.id}/compare">Compare sales</a>` : html`<a href="#/b/${biz.id}/review/${u.id}">Review</a>`}</span>
        </div>`) : html`<div class="note">Nothing uploaded yet.</div>`}
    </section>`));
  wireShell();
  const form = document.getElementById('up');
  const kind = document.getElementById('uk');
  const file = document.getElementById('uf');
  const msg = document.getElementById('umsg');
  kind.addEventListener('change', () => {
    const csv = kind.value === 'software_sales_csv';
    file.accept = csv ? '.csv,text/csv' : 'image/jpeg,image/png,application/pdf';
    document.getElementById('uhint').textContent = csv
      ? 'A CSV from the hotel software is checked against its own footer before anything is saved.'
      : 'JPG, PNG or PDF. Reading pages automatically (OCR) is not connected yet, so you type the rows in on Review, beside the photo.';
    document.getElementById('preview').innerHTML = '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.innerHTML = '';
    const f = file.files[0];
    const day = document.getElementById('ud').value;
    if (!f) return;
    try {
      if (kind.value === 'software_sales_csv') return csvPreview(biz, day, await f.text());
      const { id } = await apiUpload(`/businesses/${biz.id}/uploads?kind=${kind.value}&day=${day}`, f);
      go(`#/b/${biz.id}/review/${id}`);
    } catch (err) { showError(msg, err); }
  });
}

async function csvPreview(biz, day, csv, replaces) {
  const box = document.getElementById('preview');
  const msg = document.getElementById('umsg');
  let p;
  try { p = await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv, dryRun: true, replaces }); }
  catch (err) { box.innerHTML = ''; return showError(msg, err); }
  const f = p.footer;
  box.innerHTML = html`
    <form class="inset" id="imp">
      <div style="font-size:15px;font-weight:600">Check before importing</div>
      <div class="note">${p.bills} bills (${p.complimentary} complimentary), ${when(p.firstPaidAt)} to ${when(p.lastPaidAt)}. The footer matches: UPI ₹ ${money(f.upiPaise)}, Card ₹ ${money(f.cardPaise)}, Cash ₹ ${money(f.cashPaise)}, total ₹ ${money(f.totalPaise)}.</div>
      <div class="note">Shifts touched: ${p.shifts.map(dayLabel).join(', ')}. New bills: ${p.add}. Already imported with the same values (skipped): ${p.skip}. Already imported with different values (flagged for you to decide): ${p.flag}.</div>
      ${p.confirmedShifts.length ? html`<div class="error">This file would change a confirmed shift (${p.confirmedShifts.map(dayLabel).join(', ')}). An Owner must reopen it first.</div>` : ''}
      <div class="form-row">
        <div class="field"><label for="cf">Covers from (India time)</label><input id="cf" type="datetime-local" step="1" value="${toLocalInput(p.coversFrom)}" required></div>
        <div class="field"><label for="ct">Covers to</label><input id="ct" type="datetime-local" step="1" value="${toLocalInput(p.coversTo)}" required></div>
        <button class="btn plain" type="button" id="whole">Whole day${p.shifts.length > 1 ? 's' : ''}</button>
      </div>
      <div class="note">These start at the first and last bill. If the report covers the whole day, set it from 00:00:00 to 23:59:59, or the shift will show missing hours.</div>
      <div class="form-msg"></div>
      <button class="btn" type="submit" ${p.confirmedShifts.length ? 'disabled' : ''}>Import ${p.add} bill${p.add === 1 ? '' : 's'}</button>
    </form>`.__html;
  document.getElementById('whole').addEventListener('click', () => {
    document.getElementById('cf').value = `${toLocalInput(p.firstPaidAt).slice(0, 10)}T00:00:00`;
    document.getElementById('ct').value = `${toLocalInput(p.lastPaidAt).slice(0, 10)}T23:59:59`;
  });
  onSubmit(document.getElementById('imp'), async () => {
    const coversFrom = fromLocalInput(document.getElementById('cf').value);
    const coversTo = fromLocalInput(document.getElementById('ct').value);
    try {
      await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv, coversFrom, coversTo, replaces });
    } catch (err) { const e = new Error([err.message, ...(err.problems ?? [])].join(' ')); throw e; }
    go(`#/b/${biz.id}/compare/${p.shifts[p.shifts.length - 1]}`);
  });
}

// ---------- Review

async function reviewView(biz, uploadId) {
  if (!uploadId) return reviewListView(biz);
  const u = await api('GET', `/businesses/${biz.id}/uploads/${uploadId}`);
  const { heads } = await api('GET', `/businesses/${biz.id}/heads`);
  const fileUrl = `/api/businesses/${biz.id}/uploads/${u.id}/file`;
  const photo = html`
    <section class="card" style="flex:2 1 420px;max-width:100%;padding:16px;gap:10px">
      <div style="display:flex;justify-content:space-between" class="note"><span>Original page</span><a href="${fileUrl}" target="_blank" rel="noopener">Open full size</a></div>
      <img src="${fileUrl}" alt="Uploaded page" style="width:100%;border:1px solid var(--field);border-radius:6px;background:#FBFAF6" id="pimg">
      <div class="note">${u.ocrEngine === 'sample' ? 'Invented sample page. Rows were entered for the demo.' : 'Reading pages automatically is not connected yet. Type the rows in from the page.'}</div>
    </section>`;
  let right;
  if (u.kind === 'bill_register') right = registerPanel(biz, u);
  else if (u.kind === 'expense_list') right = expensePanel(biz, u, heads);
  else if (u.kind === 'cash_summary') right = summaryPanel(biz, u);
  else right = html`<section class="card grow3"><div class="note">Single printed bills are kept for reference. Nothing is read from them yet.</div></section>`;
  render(shell(biz, 'review', `Review: ${KIND_LABELS[u.kind]}`, `${dayLabel(u.day)} · uploaded ${when(u.createdAt)}`, html`
    <div id="rmsg"></div>
    <div class="row">${photo}${right}</div>`));
  wireShell();
  document.getElementById('pimg')?.addEventListener('error', (e) => { e.target.replaceWith(Object.assign(document.createElement('div'), { className: 'note', textContent: 'This file is a PDF. Use Open full size.' })); });
  if (u.kind === 'bill_register') wireRegister(biz, u);
  if (u.kind === 'expense_list') wireExpense(biz, u);
  if (u.kind === 'cash_summary') wireSummary(biz, u);
}

async function reviewListView(biz) {
  const { uploads, notices } = await api('GET', `/businesses/${biz.id}/uploads`);
  const pages = uploads.filter((u) => u.kind !== 'software_sales_csv');
  render(shell(biz, 'review', 'Review', 'Pick a page to check its rows beside the photo.', html`
    ${notices.map((n) => html`<div class="demo-band">${n.text.replace(n.day, dayLabel(n.day))}</div>`)}
    <section class="card" style="gap:4px">
      ${pages.length ? pages.map((u) => html`
        <a class="list-row" href="#/b/${biz.id}/review/${u.id}" style="color:inherit">
          <span><strong>${KIND_LABELS[u.kind]}</strong> · ${dayLabel(u.day)}${u.rows != null ? ` · ${u.rows} row${u.rows === 1 ? '' : 's'}` : ''}${u.open ? ` · ${u.open} to check` : ''}</span>
          ${chip(u.status)}
        </a>`) : html`<div class="note">No pages yet. <a href="#/b/${biz.id}/upload">Upload one</a>.</div>`}
    </section>`));
  wireShell();
}

function payText(pays) {
  return pays.length ? pays.map((p) => `${p.columnLabel || MODE_LABELS[p.mode]} ${money(p.amountPaise)}`).join(' + ') : 'none written';
}

function registerPanel(biz, u) {
  const locked = u.shiftStatus === 'confirmed';
  const sum = u.rows.reduce((s, r) => s + r.amountPaise, 0);
  const written = u.pageWrittenTotalPaise;
  return html`
    <section class="card grow3" style="gap:12px">
      ${locked ? html`<div class="demo-band">The shift for ${dayLabel(u.day)} is confirmed, so this page is locked. An Owner can reopen it on Compare sales.</div>` : ''}
      <div class="scroll"><table style="min-width:720px">
        <thead><tr><th>#</th><th>Bill</th><th>Type</th><th style="text-align:right">Amount</th><th>Paid as</th><th>Remarks</th><th>Status</th><th></th></tr></thead>
        <tbody>${u.rows.map((r) => html`
          <tr data-row="${r.id}">
            <td class="note">${r.lineNo}</td><td class="mono">${r.billNo}</td><td>${TYPE_LABELS[r.billType] ?? html`<span class="error">Choose</span>`}</td>
            <td class="amount">${money(r.amountPaise)}</td><td>${payText(r.payments)}</td><td class="note">${r.remarks ?? ''}</td>
            <td>${r.status === 'checked' ? html`<span class="chip ok">Checked</span>` : html`<span class="chip wait">Check</span>`}</td>
            <td style="text-align:right">${locked ? '' : html`<button class="btn plain" type="button" data-edit="${r.id}">Edit</button>`}</td>
          </tr>`)}</tbody>
      </table></div>
      <div class="form-row" style="justify-content:space-between">
        <div class="note">Rows add up to ₹ ${money(sum)}. ${written == null ? 'Enter the total written on the page to check it.' : written === sum ? html`<span class="ok-msg">Matches the written total.</span>` : html`<span class="error">The page says ₹ ${money(written)}.</span>`}</div>
        ${locked ? '' : html`<form id="ptotal" class="form-row" style="align-items:flex-end"><div class="field"><label for="pt">Total written on the page (₹)</label><input id="pt" name="pageWrittenTotal" class="mono" value="${written == null ? '' : rupeesForInput(written)}"></div><button class="btn plain" type="submit">Save total</button></form>`}
      </div>
      ${locked ? '' : html`<form class="inset" id="rform"></form>`}
    </section>`;
}

function rowForm(r) {
  const pays = r?.payments?.length ? r.payments : [{ mode: 'cash', columnLabel: '', amountPaise: null }];
  return html`
    <div style="font-size:15px;font-weight:600">${r ? `Edit bill ${r.billNo}` : 'Add a bill from the page'}</div>
    <div class="form-row">
      <div class="field"><label>Bill number</label><input name="billNo" class="mono" value="${r?.billNo ?? ''}" required></div>
      <div class="field"><label>Type</label><select name="billType"><option value="">Choose</option>
        ${Object.entries(TYPE_LABELS).map(([k, l]) => html`<option value="${k}" ${r?.billType === k ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label>Bill amount (₹)</label><input name="amount" class="mono" value="${r ? rupeesForInput(r.amountPaise) : ''}" required></div>
    </div>
    <div class="note">Payments as written on the page. A bill paid partly in cash and partly by UPI has two lines.</div>
    <div id="pays">${pays.map((p) => payLine(p))}</div>
    <button class="btn plain" type="button" id="addpay" style="align-self:flex-start">Add payment line</button>
    <div class="form-row">
      <div class="field" style="flex:3 1 240px"><label>Remarks</label><input name="remarks" value="${r?.remarks ?? ''}"></div>
      <label style="display:flex;gap:8px;align-items:center;min-height:44px"><input type="checkbox" name="checked" style="width:auto;min-height:0" ${r?.status === 'checked' ? 'checked' : ''}> Checked against the page</label>
    </div>
    <div class="form-msg"></div>
    <div class="form-row">
      <button class="btn" type="submit">${r ? 'Save row' : 'Add row'}</button>
      ${r ? html`<button class="btn plain" type="button" id="cancel">Cancel</button><button class="btn danger" type="button" id="delrow">Delete row</button>` : ''}
    </div>`;
}

function payLine(p) {
  return html`<div class="form-row payline">
    <div class="field"><select name="pmode">${['cash', 'upi', 'card'].map((m) => html`<option value="${m}" ${p.mode === m ? 'selected' : ''}>${MODE_LABELS[m]}</option>`)}</select></div>
    <div class="field"><input name="plabel" placeholder="Column, e.g. UPI XOXO" value="${p.columnLabel ?? ''}"></div>
    <div class="field"><input name="pamount" class="mono" placeholder="Amount" value="${p.amountPaise == null ? '' : rupeesForInput(p.amountPaise)}"></div>
    <button class="btn plain" type="button" data-rmpay>Remove</button>
  </div>`;
}

function wireRegister(biz, u) {
  const form = document.getElementById('rform');
  const total = document.getElementById('ptotal');
  total && onSubmit(total, async (d) => { await api('PATCH', `/businesses/${biz.id}/uploads/${u.id}`, { pageWrittenTotal: d.pageWrittenTotal || null }); reviewView(biz, u.id); });
  if (!form) return;
  const show = (r) => {
    form.innerHTML = rowForm(r).__html;
    const pays = form.querySelector('#pays');
    form.querySelector('#addpay').addEventListener('click', () => pays.insertAdjacentHTML('beforeend', payLine({ mode: 'upi', columnLabel: '', amountPaise: null }).__html));
    pays.addEventListener('click', (e) => { if (e.target.matches('[data-rmpay]')) e.target.closest('.payline').remove(); });
    form.querySelector('#cancel')?.addEventListener('click', () => show(null));
    form.querySelector('#delrow')?.addEventListener('click', async () => {
      if (!confirm(`Delete bill ${r.billNo} from this page?`)) return;
      try { await api('DELETE', `/businesses/${biz.id}/register-rows/${r.id}`, {}); reviewView(biz, u.id); } catch (err) { showError(form.querySelector('.form-msg'), err); }
    });
    if (r) form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  onSubmit(form, async (d) => {
    const payments = [...form.querySelectorAll('.payline')].map((line) => ({
      mode: line.querySelector('[name=pmode]').value, columnLabel: line.querySelector('[name=plabel]').value || null, amount: line.querySelector('[name=pamount]').value,
    })).filter((p) => p.amount !== '');
    const editing = form.dataset.editing;
    const payload = { billNo: d.billNo, billType: d.billType || null, amount: d.amount, remarks: d.remarks || null, payments, status: d.checked ? 'checked' : 'draft' };
    if (editing) await api('PUT', `/businesses/${biz.id}/register-rows/${editing}`, payload);
    else await api('POST', `/businesses/${biz.id}/uploads/${u.id}/register-rows`, payload);
    reviewView(biz, u.id);
  });
  app.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const r = u.rows.find((x) => x.id === b.dataset.edit);
    form.dataset.editing = r.id;
    show(r);
  }));
  form.dataset.editing = '';
  show(null);
}

function expensePanel(biz, u, heads) {
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
        <thead><tr><th>#</th><th>Item</th><th style="text-align:right">Amount</th><th>Head</th><th>Status</th><th></th></tr></thead>
        <tbody>${u.rows.map((r) => html`<tr>
          <td class="note">${r.lineNo}</td><td>${r.narration}</td><td class="amount">${money(r.amountPaise)}</td>
          <td>${name(r.headId) ?? html`<span class="chip bad">Needs input</span>`}</td>
          <td>${r.status === 'approved' ? html`<span class="chip ok">Approved</span>` : html`<span class="chip wait">Draft</span>`}</td>
          <td style="text-align:right">${r.status === 'draft' ? html`<button class="btn plain" type="button" data-eedit="${r.id}">Edit</button>` : ''}</td>
        </tr>`)}</tbody>
      </table></div>
      <div class="note">Rows add up to ₹ ${money(sum)}.</div>
      <form class="inset" id="eform">
        <div style="font-size:15px;font-weight:600" id="etitle">Add a line from the page</div>
        <div class="form-row">
          <div class="field" style="flex:2 1 200px"><label>Item</label><input name="narration" required></div>
          <div class="field"><label>Amount (₹)</label><input name="amount" class="mono" required></div>
          <div class="field"><label>Head</label><select name="headId"><option value="">Choose later</option>${exp.map((h) => html`<option value="${h.id}">${h.name}</option>`)}</select></div>
        </div>
        <div class="form-msg"></div>
        <div class="form-row"><button class="btn" type="submit">Save line</button><button class="btn danger" type="button" id="edel" hidden>Delete line</button></div>
      </form>
      ${drafts.length ? html`<div class="form-row" style="justify-content:space-between;border-top:1px solid var(--line-soft);padding-top:12px">
        <div class="note">${drafts.length - ready.length ? `${drafts.length - ready.length} line${drafts.length - ready.length > 1 ? 's need' : ' needs'} a head before approval.` : 'All draft lines have a head.'}</div>
        ${canApprove ? html`<button class="btn" type="button" id="eapprove" ${ready.length ? '' : 'disabled'}>Approve ${ready.length} ready line${ready.length === 1 ? '' : 's'}</button>` : html`<span class="note">An Owner or Accountant approves these.</span>`}
      </div>` : ''}
    </section>`;
}

function wireExpense(biz, u) {
  const form = document.getElementById('eform');
  let editing = null;
  onSubmit(form, async (d) => {
    const body = { narration: d.narration, amount: d.amount, headId: d.headId || null };
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
    document.getElementById('etitle').textContent = `Edit line ${r.lineNo}`;
    document.getElementById('edel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
          ${[['opening', 'Opening balance', s.openingPaise], ['received', 'Received total', s.receivedPaise], ['balance', 'Balance', s.balancePaise], ['expenses', 'Expenses total', s.expensesPaise], ['cashInHand', 'Cash in hand', s.cashInHandPaise]]
            .map(([k, l, p]) => html`<div class="field"><label>${l}</label><input name="${k}" class="mono" value="${v(p)}" ${approved ? 'disabled' : ''}></div>`)}
        </div>
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

// ---------- Compare sales

async function compareView(biz, day) {
  const { shifts } = await api('GET', `/businesses/${biz.id}/shifts`);
  if (!day) day = shifts.find((s) => s.status !== 'confirmed')?.day ?? shifts[0]?.day;
  if (!day) {
    render(shell(biz, 'compare', 'Compare sales', 'Software report against the handwritten register, bill by bill. You decide every difference.', html`
      <section class="card"><div class="note">No sales yet. <a href="#/b/${biz.id}/upload">Upload a software sales report</a>.</div></section>`));
    return wireShell();
  }
  const v = await api('GET', `/businesses/${biz.id}/shifts/${day}`);
  const canDecide = biz.actions.includes('sales.decide');
  const confirmed = v.status === 'confirmed';
  const toDecide = v.comparisons.filter((c) => ['amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software'].includes(c.difference));
  const decided = toDecide.filter((c) => c.decision).length;
  const comps = v.comparisons.filter((c) => c.difference === 'complimentary');
  const matches = v.comparisons.filter((c) => c.difference === 'match').length;
  const missingHours = Math.round(v.gaps.reduce((s, g) => s + g.to - g.from, 0) / 3600000 * 10) / 10;
  const side = (s) => (s ? html`<div class="mono">${money(s.amountPaise)}</div><div class="note">${MODE_LABELS[s.mode] ?? 'No payment written'}${s.billType ? ` · ${TYPE_LABELS[s.billType]}` : ''}</div>` : html`<div class="note">Not found</div>`);
  const shiftOptions = [...new Set([day, ...shifts.map((s) => s.day)])].sort().reverse();
  const totalsRow = (label, sw, rg, bold) => html`<tr style="${bold ? 'font-weight:600' : ''}"><td>${label}</td><td class="amount">${money(sw)}</td><td class="amount">${money(rg)}</td><td class="amount" style="color:${sw === rg ? 'var(--muted)' : '#B45309'}">${rg - sw === 0 ? '0' : `${rg - sw > 0 ? '+' : ''}${money(rg - sw)}`}</td></tr>`;
  const swTotal = v.totals.reduce((s, t) => s + t.softwarePaise, 0) + v.unknownModePaise;
  const rgTotal = v.totals.reduce((s, t) => s + t.registerPaise, 0);
  render(shell(biz, 'compare', 'Compare sales', 'Software report against the handwritten register, bill by bill. You decide every difference.', html`
    <div class="form-row" style="justify-content:space-between;align-items:flex-end">
      <div class="field" style="flex:0 1 320px"><label for="sh">Shift (8 am to 8 am)</label>
        <select id="sh">${shiftOptions.map((d) => html`<option value="${d}" ${d === day ? 'selected' : ''}>${when(Date.parse(`${d}T08:00:00+05:30`))} to ${when(Date.parse(`${d}T08:00:00+05:30`) + 86400000)}</option>`)}</select></div>
      ${confirmed ? html`<span class="chip ok" style="font-size:14px;padding:6px 14px">Confirmed</span>` : ''}
    </div>
    <div id="cmsg"></div>
    <div class="row">
      <section class="card grow1" style="gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2>Software report</h2>${v.gaps.length ? html`<span class="chip wait">Hours missing</span>` : html`<span class="chip ok">Shift covered</span>`}</div>
        <div class="note">${v.softwareBills} bill${v.softwareBills === 1 ? '' : 's'} in this shift from ${v.reports.length} report${v.reports.length === 1 ? '' : 's'}.</div>
        ${v.reports.map((r) => html`<div class="note">Report covering ${when(r.coversFrom)} to ${when(r.coversTo)}${confirmed || !biz.actions.includes('sales.import') ? '' : html` · <a href="#" data-cover="${r.id}" data-from="${r.coversFrom}" data-to="${r.coversTo}">Change</a>`}</div>`)}
        ${v.gaps.map((g) => html`<div class="demo-band">Missing ${when(g.from)} to ${when(g.to)}. Upload the report for those hours, or correct a report's covered period.</div>`)}
        <div id="coveredit"></div>
        ${biz.actions.includes('sales.import') ? html`<a href="#/b/${biz.id}/upload">Upload a report</a>` : ''}
      </section>
      <section class="card grow1" style="gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2>Handwritten register</h2>${v.registerRows ? html`<span class="chip ok">Pages entered</span>` : html`<span class="chip wait">No pages</span>`}</div>
        <div class="note">${v.registerPages} page${v.registerPages === 1 ? '' : 's'}, ${v.registerRows} bill${v.registerRows === 1 ? '' : 's'}. Bills appear in the register only after they are settled.</div>
        ${biz.actions.includes('rows.edit') ? html`<a href="#/b/${biz.id}/review">Open register pages</a>` : ''}
      </section>
    </div>
    <div class="row">
      ${[['Bills match', matches, 'var(--teal-ink)'], ['Differences', toDecide.length, '#B45309'], ['Decided', decided, 'var(--ink)'], ['Complimentary', comps.length, 'var(--ink)'], ['Hours missing', missingHours, missingHours ? '#B45309' : 'var(--ink)']]
        .map(([l, n, col]) => html`<div class="card" style="flex:1 1 150px;padding:16px 20px;gap:2px"><div class="note" style="font-size:14px">${l}</div><div class="mono" style="font-size:26px;font-weight:600;color:${col}">${n}</div></div>`)}
    </div>
    ${v.conflicts.length ? html`<section class="card">
      <h2>Bills that differ between two software reports</h2>
      <div class="note">The same bill came in twice with different values. Nothing was overwritten. Choose which to keep.</div>
      <div class="scroll"><table style="min-width:640px"><thead><tr><th>Bill</th><th>Already imported</th><th>New file</th><th></th></tr></thead><tbody>
        ${v.conflicts.map((k) => html`<tr><td class="mono">${k.billNo}</td>
          <td><div class="mono">${money(k.existing.amountPaise)}</div><div class="note">${MODE_LABELS[k.existing.mode]} · ${when(k.existing.paidAt)}</div></td>
          <td><div class="mono">${money(k.incoming.amountPaise)}</div><div class="note">${MODE_LABELS[k.incoming.mode]} · ${when(k.incoming.paidAt)}</div></td>
          <td>${canDecide ? html`<div class="form-row"><button class="btn plain" data-conflict="${k.id}" data-d="keep_existing">Keep imported</button><button class="btn plain" data-conflict="${k.id}" data-d="use_incoming">Use new file</button></div>` : ''}</td></tr>`)}
      </tbody></table></div></section>` : ''}
    <section class="card">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px"><h2>Differences to decide</h2><span class="note">${decided} of ${toDecide.length} decided</span></div>
      ${toDecide.length ? html`<div class="scroll"><table style="min-width:860px">
        <thead><tr><th>Bill</th><th>Paid at</th><th>Software</th><th>Register</th><th>What differs</th><th>Your decision</th></tr></thead>
        <tbody>${toDecide.map((c) => html`<tr style="background:${c.decision ? 'transparent' : '#FFF7ED'}">
          <td class="mono">${c.billNo}</td><td style="white-space:nowrap">${c.paidAt ? when(c.paidAt) : 'Not in report'}</td>
          <td>${side(c.software)}</td><td>${side(c.register)}</td>
          <td><span class="chip ${c.difference.startsWith('missing') ? 'bad' : 'wait'}">${DIFF_LABELS[c.difference]}</span></td>
          <td>${canDecide && !confirmed ? html`<div style="display:flex;flex-wrap:wrap;gap:6px">${Object.entries(DECISION_LABELS).map(([k, l]) => html`
              <button class="btn ${c.decision === k ? 'ghost' : 'plain'}" style="${c.decision === k ? 'font-weight:600;background:#E3F1EF' : ''}" data-cmp="${c.id}" data-d="${k}">${l}</button>`)}</div>`
            : html`<span class="note">${c.decision ? DECISION_LABELS[c.decision] : 'Not decided'}</span>`}</td>
        </tr>`)}</tbody></table></div>` : html`<div class="note">No differences in this shift.</div>`}
    </section>
    <div class="row">
      <section class="card" style="flex:3 1 420px;gap:10px">
        <h2>Totals by payment mode</h2>
        <div class="scroll"><table style="min-width:380px"><thead><tr><th>Mode</th><th style="text-align:right">Software</th><th style="text-align:right">Register</th><th style="text-align:right">Difference</th></tr></thead><tbody>
          ${v.totals.map((t) => totalsRow(MODE_LABELS[t.mode], t.softwarePaise, t.registerPaise))}
          ${v.unknownModePaise ? totalsRow('U/N (not given)', v.unknownModePaise, 0) : ''}
          ${totalsRow('Total', swTotal, rgTotal, true)}
        </tbody></table></div>
        <div class="note">Complimentary bills (amount 0) are listed apart and never counted as sales${comps.length ? `: ${comps.map((c) => c.billNo).join(', ')}` : ''}.</div>
      </section>
      <section class="card" style="flex:2 1 320px;gap:10px">
        <h2>Next step</h2>
        ${confirmed ? html`
          <div class="ok-msg">Confirmed ${when(v.confirmedAt)}. The confirmed sales are income rows; UPI and card sales wait for matching in Phase 3.</div>
          ${biz.role === 'owner' ? html`<form id="reopen" class="inset"><div class="field"><label for="rr">Reopen this shift: reason</label><input id="rr" name="reason" required></div><div class="form-msg"></div><button class="btn danger" type="submit" style="align-self:flex-start">Reopen shift</button></form>` : html`<div class="note">Only an Owner can reopen a confirmed shift.</div>`}`
        : html`
          ${v.reopenedAt ? html`<div class="note">Reopened ${when(v.reopenedAt)}: ${v.reopenReason}</div>` : ''}
          ${v.blockers.length ? html`<ul class="note" style="margin:0;padding-left:18px">${v.blockers.map((b) => html`<li>${b}</li>`)}</ul>` : html`<div class="note">Everything is decided. Confirming turns the sales into approved income rows.</div>`}
          ${canDecide ? html`<button class="btn big" id="confirm" ${v.canConfirm ? '' : 'disabled'}>Confirm sales for this shift</button>` : ''}
          <div class="note">Only Owner and Accountant can decide differences and confirm.</div>`}
      </section>
    </div>`));
  wireShell();
  const msg = document.getElementById('cmsg');
  document.getElementById('sh').addEventListener('change', (e) => go(`#/b/${biz.id}/compare/${e.target.value}`));
  const act = async (fn) => { try { await fn(); compareView(biz, day); } catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  app.querySelectorAll('[data-cmp]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('PUT', `/businesses/${biz.id}/comparisons/${b.dataset.cmp}`, { decision: b.dataset.d }))));
  app.querySelectorAll('[data-conflict]').forEach((b) => b.addEventListener('click', () => act(() => apiFull('PUT', `/businesses/${biz.id}/conflicts/${b.dataset.conflict}`, { decision: b.dataset.d }))));
  document.getElementById('confirm')?.addEventListener('click', () => act(() => apiFull('POST', `/businesses/${biz.id}/shifts/${day}/confirm`, {})));
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

// ---------- router

async function route() {
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
      const screen = parts[2] || 'dashboard';
      if (screen === 'accounts') return accountsView(biz, parts[3]);
      if (screen === 'heads') return headsView(biz, parts[3]);
      if (screen === 'users' && biz.role === 'owner') return usersView(biz, parts[3]);
      const item = NAV.find((n) => n.key === screen);
      if (item?.needs && !biz.actions.includes(item.needs)) return go(home(biz));
      if (screen === 'upload') return uploadView(biz);
      if (screen === 'review') return reviewView(biz, parts[3]);
      if (screen === 'compare') return compareView(biz, parts[3]);
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
