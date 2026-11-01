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
const home = (b) => `#/b/${b.id}/${b.actions.includes('reports.view') ? 'dashboard' : 'accounts'}`;
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
  { key: 'upload', label: 'Upload', phase: 2 },
  { key: 'review', label: 'Review', phase: 2 },
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
  const { heads } = await api('GET', `/businesses/${biz.id}/heads`);
  const canEdit = biz.actions.includes('heads.edit');
  const editing = heads.find((h) => h.id === editId);
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
      </section>
    </div>`));
  wireShell();
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
