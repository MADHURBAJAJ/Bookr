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
/** Rupee text → paise without floats, or null. Same rule as the server. */
function parsePaiseText(text) {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(text).replace(/,/g, '').trim());
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -v : v;
}
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
  { key: 'bank', label: 'Bank sync', needs: 'bank.link' },
  { key: 'upi', label: 'UPI matching', needs: 'bank.link' },
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
const deleteButton = (biz, u) => (canDeleteUpload(biz, u) ? html`<button class="btn danger" type="button" data-delupload="${u.id}" data-what="${KIND_LABELS[u.kind]} for ${dayLabel(u.day)}">Delete</button>` : '');
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
        <div class="field" style="flex:2 1 260px"><label for="uf">Files (up to 10)</label><input id="uf" name="file" type="file" accept=".csv,text/csv" multiple required></div>
        <button class="btn" type="submit">Upload</button>
      </form>
      <div class="note" id="uhint">CSVs from the hotel software, up to 10 at a time. Each is checked against its own footer before anything is saved.</div>
      <div id="umsg"></div>
      <div id="preview"></div>
    </section>
    <section class="card" style="gap:4px">
      <h2 style="margin-bottom:8px">Recent uploads</h2>
      ${uploads.length ? uploads.map((u) => html`
        <div class="list-row">
          <span><strong>${KIND_LABELS[u.kind]}</strong> · ${dayLabel(u.day)}${u.rows != null ? ` · ${u.rows} row${u.rows === 1 ? '' : 's'}` : ''}</span>
          <span style="display:flex;gap:10px;align-items:center">${chip(u.status)}
            ${u.kind === 'software_sales_csv' ? html`<a href="#/b/${biz.id}/compare">Compare sales</a>` : html`<a href="#/b/${biz.id}/review/${u.id}">Review</a>`}
            ${deleteButton(biz, u)}</span>
        </div>`) : html`<div class="note">Nothing uploaded yet.</div>`}
    </section>`));
  wireShell();
  wireDeletes(biz, () => document.getElementById('umsg'), () => uploadView(biz));
  const form = document.getElementById('up');
  const kind = document.getElementById('uk');
  const file = document.getElementById('uf');
  const msg = document.getElementById('umsg');
  kind.addEventListener('change', () => {
    const csv = kind.value === 'software_sales_csv';
    file.accept = csv ? '.csv,text/csv' : 'image/jpeg,image/png,application/pdf';
    document.getElementById('uhint').textContent = csv
      ? 'CSVs from the hotel software, up to 10 at a time. Each is checked against its own footer before anything is saved.'
      : 'JPG, PNG or PDF, up to 10 at a time, all for the day and page type chosen. Read them with Claude afterwards, or type the rows in on Review.';
    document.getElementById('preview').innerHTML = '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.innerHTML = '';
    const files = [...file.files];
    const day = document.getElementById('ud').value;
    if (!files.length) return;
    if (files.length > MAX_FILES) return showError(msg, new Error(`Choose at most ${MAX_FILES} files at a time.`));
    const box = document.getElementById('preview');
    box.innerHTML = '';
    if (kind.value === 'software_sales_csv') {
      // One preview card per CSV, each with its own covered period and Import button.
      for (const f of files) {
        const card = document.createElement('div');
        box.appendChild(card);
        await csvPreview(biz, day, await f.text(), undefined, card, f.name, files.length > 1);
      }
      return;
    }
    if (files.length === 1) {
      try {
        const { id } = await apiUpload(`/businesses/${biz.id}/uploads?kind=${kind.value}&day=${day}`, files[0]);
        return go(`#/b/${biz.id}/review/${id}`);
      } catch (err) { return showError(msg, err); }
    }
    await uploadMany(biz, day, kind.value, files, box);
  });
}

const MAX_FILES = 10;

/** Uploads photos one after another with a status line each, then offers to read them all. */
async function uploadMany(biz, day, kind, files, box) {
  const lines = files.map((f) => ({ name: f.name, state: 'Waiting', id: null, error: null }));
  const draw = () => {
    box.innerHTML = html`<div class="inset" style="gap:6px">
      <div style="font-size:15px;font-weight:600">${KIND_LABELS[kind]} · ${dayLabel(day)}</div>
      ${lines.map((l) => html`<div class="list-row" style="padding:6px 0"><span class="mono" style="font-size:13px">${l.name}</span>
        <span style="display:flex;gap:10px;align-items:center">${l.error ? html`<span class="error">${l.error}</span>`
          : l.id ? html`<span class="chip ok">${l.state}</span><a href="#/b/${biz.id}/review/${l.id}">Review</a>`
          : html`<span class="chip wait">${l.state}</span>`}</span></div>`)}
      <div id="manyactions"></div>
    </div>`.__html;
  };
  draw();
  for (const l of lines) {
    l.state = 'Uploading…';
    draw();
    try {
      const { id } = await apiUpload(`/businesses/${biz.id}/uploads?kind=${kind}&day=${day}`, files[lines.indexOf(l)]);
      l.id = id;
      l.state = 'Uploaded';
    } catch (err) { l.error = err.message; }
    draw();
  }
  const done = lines.filter((l) => l.id);
  if (!done.length || !READABLE.includes(kind) || !biz.actions.includes('rows.upload')) return;
  const status = await api('GET', `/businesses/${biz.id}/ocr`).catch(() => null);
  if (!status?.configured) return;
  const actions = document.getElementById('manyactions');
  actions.innerHTML = html`<div class="form-row" style="align-items:center;margin-top:6px">
    <button class="btn" type="button" id="readall">Read all ${done.length} with Claude</button>
    <span class="note">Reads one page after another. Uses ${done.length} of today's page reads (${status.usedToday} of ${status.dailyLimit} used).</span></div>`.__html;
  document.getElementById('readall').addEventListener('click', async () => {
    for (const l of done) {
      l.state = 'Reading…';
      draw();
      try {
        const r = await apiFull('POST', `/businesses/${biz.id}/uploads/${l.id}/read`, {});
        l.state = kind === 'cash_summary' ? 'Read' : `Read: ${r.rows} row${r.rows === 1 ? '' : 's'}${r.unclearCells ? `, ${r.unclearCells} to check` : ''}${r.totalMatches === false ? ', total differs' : ''}`;
      } catch (err) { l.state = 'Uploaded'; l.error = `Not read: ${err.message}`; }
      draw();
    }
  });
}

async function csvPreview(biz, day, csv, replaces, box = document.getElementById('preview'), name = '', many = false) {
  let p;
  try { p = await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv, dryRun: true, replaces }); }
  catch (err) {
    box.innerHTML = html`<div class="inset">${name ? html`<div class="mono" style="font-size:13px">${name}</div>` : ''}<div class="form-msg"></div></div>`.__html;
    return showError(box.querySelector('.form-msg'), err);
  }
  const f = p.footer;
  box.innerHTML = html`
    <form class="inset" data-imp>
      <div style="font-size:15px;font-weight:600">Check before importing${name ? html` <span class="mono" style="font-weight:400;font-size:13px">${name}</span>` : ''}</div>
      <div class="note">${p.bills} bills (${p.complimentary} complimentary), ${when(p.firstPaidAt)} to ${when(p.lastPaidAt)}. The footer matches: UPI ₹ ${money(f.upiPaise)}, Card ₹ ${money(f.cardPaise)}, Cash ₹ ${money(f.cashPaise)}, total ₹ ${money(f.totalPaise)}.</div>
      <div class="note">Shifts touched: ${p.shifts.map(dayLabel).join(', ')}. New bills: ${p.add}. Already imported with the same values (skipped): ${p.skip}. Already imported with different values (flagged for you to decide): ${p.flag}.</div>
      ${p.confirmedShifts.length ? html`<div class="error">This file would change a confirmed shift (${p.confirmedShifts.map(dayLabel).join(', ')}). An Owner must reopen it first.</div>` : ''}
      <div class="form-row">
        <div class="field"><label>Covers from (India time)</label><input data-cf type="datetime-local" step="1" value="${toLocalInput(p.coversFrom)}" required></div>
        <div class="field"><label>Covers to</label><input data-ct type="datetime-local" step="1" value="${toLocalInput(p.coversTo)}" required></div>
        <button class="btn plain" type="button" data-whole>Whole day${p.shifts.length > 1 ? 's' : ''}</button>
      </div>
      <div class="note">These start at the first and last bill. If the report covers the whole day, set it from 00:00:00 to 23:59:59, or the shift will show missing hours.</div>
      <div class="form-msg"></div>
      <button class="btn" type="submit" ${p.confirmedShifts.length ? 'disabled' : ''}>Import ${p.add} bill${p.add === 1 ? '' : 's'}</button>
    </form>`.__html;
  const cf = box.querySelector('[data-cf]');
  const ct = box.querySelector('[data-ct]');
  box.querySelector('[data-whole]').addEventListener('click', () => {
    cf.value = `${toLocalInput(p.firstPaidAt).slice(0, 10)}T00:00:00`;
    ct.value = `${toLocalInput(p.lastPaidAt).slice(0, 10)}T23:59:59`;
  });
  onSubmit(box.querySelector('[data-imp]'), async () => {
    try {
      await apiFull('POST', `/businesses/${biz.id}/sales-reports`, { day, csv, coversFrom: fromLocalInput(cf.value), coversTo: fromLocalInput(ct.value), replaces });
    } catch (err) { const e = new Error([err.message, ...(err.problems ?? [])].join(' ')); throw e; }
    const last = p.shifts[p.shifts.length - 1];
    if (!many) return go(`#/b/${biz.id}/compare/${last}`);
    box.innerHTML = html`<div class="inset"><span><span class="chip ok">Imported</span> ${name}: ${p.add} bill${p.add === 1 ? '' : 's'} · <a href="#/b/${biz.id}/compare/${last}">Compare ${dayLabel(last)} shift</a></span></div>`.__html;
  });
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
  // Pages of the same type in day order, then upload order: for Previous and Next.
  const same = list.uploads.filter((x) => x.kind === u.kind).sort((a, b) => a.day.localeCompare(b.day) || a.createdAt - b.createdAt);
  const at = same.findIndex((x) => x.id === u.id);
  const prev = at > 0 ? same[at - 1] : null;
  const next = at >= 0 && at < same.length - 1 ? same[at + 1] : null;
  const fileUrl = `/api/businesses/${biz.id}/uploads/${u.id}/file`;
  const photo = html`
    <section class="card" id="photocard" style="flex:2 1 420px;max-width:100%;padding:16px;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px" class="note"><span>Original page</span><span style="display:flex;gap:10px;align-items:center"><a href="${fileUrl}" target="_blank" rel="noopener">Open full size</a>${deleteButton(biz, u)}</span></div>
      <div style="overflow:hidden;display:flex;justify-content:center"><img src="${fileUrl}" alt="Uploaded page" style="width:100%;border:1px solid var(--field);border-radius:6px;background:#FBFAF6;transition:transform .2s" id="pimg"></div>
      <div class="form-row" style="align-items:center">
        ${READABLE.includes(u.kind) && biz.actions.includes('rows.upload') ? html`<button class="btn" type="button" id="readpage">Read page</button>` : ''}
        <button class="btn plain" type="button" id="rotate">Rotate view</button>
      </div>
      <div class="note" id="ocrnote">${u.ocrEngine === 'claude_vision' ? 'Read by Claude. Every row is a draft: check each one against the photo.' : u.ocrEngine === 'manual' ? 'Rows typed in by hand.' : 'Press Read page to fill the rows from the photo, or type them in.'}</div>
    </section>`;
  let right;
  if (u.kind === 'bill_register') right = registerPanel(biz, u);
  else if (u.kind === 'expense_list') right = expensePanel(biz, u, heads, parties);
  else if (u.kind === 'cash_summary') right = summaryPanel(biz, u);
  else right = html`<section class="card grow3"><div class="note">Single printed bills are kept for reference. Nothing is read from them yet.</div></section>`;
  render(shell(biz, 'review', `Review: ${KIND_LABELS[u.kind]}`, `${dayLabel(u.day)} · uploaded ${when(u.createdAt)}`, html`
    <div class="form-row" style="justify-content:space-between;align-items:center;margin-bottom:-8px">
      <div class="form-row" style="align-items:center">
        ${backButton()}
        ${prev ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/review/${prev.id}" title="${KIND_LABELS[prev.kind]} · ${dayLabel(prev.day)}">← Previous page</a>` : html`<span class="btn plain" style="display:inline-flex;align-items:center;opacity:.45">← Previous page</span>`}
        <span class="note">${at >= 0 ? `Page ${at + 1} of ${same.length}` : ''}</span>
        ${next ? html`<a class="btn plain" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/review/${next.id}" title="${KIND_LABELS[next.kind]} · ${dayLabel(next.day)}">Next page →</a>` : html`<span class="btn plain" style="display:inline-flex;align-items:center;opacity:.45">Next page →</span>`}
      </div>
      <div class="form-row" style="align-items:center">
        ${(u.kind === 'expense_list' || u.kind === 'cash_summary') && biz.actions.includes('rows.edit') ? html`<form id="dayform" class="form-row" style="align-items:center;gap:6px" title="The shift this page belongs to"><label for="pday" class="note">Page is for</label><input id="pday" name="day" type="date" class="compact" value="${u.day}" max="${todayIst()}"><button class="btn plain" type="submit" hidden id="daysave">Move page</button></form>` : ''}
        ${u.kind === 'bill_register' ? findBillBox() : ''}
        <button class="btn plain" type="button" id="expand" title="Hide the photo and the menu to give the entries the full width, e.g. when checking against a printout"></button>
      </div>
    </div>
    <div id="findresults"></div>
    <div id="rmsg"></div>
    <div class="row">${photo}${right}</div>`));
  wireShell();
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
    btn.textContent = on ? 'Show photo' : 'Expand ⤢';
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
const findBillBox = () => html`<form id="findbill" class="form-row" style="align-items:center;gap:6px" role="search">
  <input name="bill" class="cell mono" placeholder="Find bill, e.g. 3154" style="width:190px" aria-label="Find a bill number on register pages" autocomplete="off">
  <button class="btn plain" type="submit" style="min-height:36px">Find</button></form>`;

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
          <a href="#/b/${biz.id}/review/${u.id}" style="color:inherit"><strong>${KIND_LABELS[u.kind]}</strong> · ${dayLabel(u.day)}${u.rows != null ? ` · ${u.rows} row${u.rows === 1 ? '' : 's'}` : ''}${u.open ? ` · ${u.open} to check` : ''}</a>
          <span style="display:flex;gap:10px;align-items:center">${u.totalDiffers ? html`<span class="chip bad">Total differs</span>` : ''}${chip(u.status)}<a href="#/b/${biz.id}/review/${u.id}">Review</a>${deleteButton(biz, u)}</span>
        </div>`) : html`<div class="note">No pages yet. <a href="#/b/${biz.id}/upload">Upload one</a>.</div>`}
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

/** Bill number box. Red when the number is not exactly in the shift's software report; then a
 *  dropdown offers the software bills it probably means (short number, typo, or same amount). */
function billCell(r, needsClass) {
  const bm = r.billMatch;
  const off = bm && !bm.exact;
  const why = { short: 'last digits', typo: 'one digit off', short_typo: 'last digits, one off', amount: 'same amount only' };
  return html`<input class="cell mono ${needsClass || (off ? 'needs' : '')}" data-f="billNo" value="${r.billNo}" style="width:104px" aria-label="Bill number"
      title="${off ? 'Not found in the software report for this shift' : ''}">
    ${off ? (bm.options.length ? html`<select class="cell pick" data-f="pickBill" aria-label="Pick the bill from the software report" style="display:block;margin-top:4px;max-width:220px">
        <option value="">Did you mean…</option>
        ${bm.options.map((o) => html`<option value="${o.billNo}">${o.billNo} · ₹ ${money(o.amountPaise)} ${o.amountMatches ? '✓ same amount' : ''} (${why[o.why]})</option>`)}
      </select>` : html`<div class="tiny" style="color:#7F1D1D;margin-top:2px">Not in software report</div>`) : ''}`;
}

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

/** One register row. Editable in place unless the shift is confirmed; Edit opens the full form. */
function regRowHtml(r, locked) {
  const q = unclearOf(r.ocrOriginal, r.status === 'draft');
  const nd = (f) => (q.has(f) ? 'needs' : '');
  if (locked) {
    return html`<tr data-row="${r.id}">
      <td class="note">${r.lineNo}</td><td>${r.status === 'checked' ? '✓' : ''}</td><td class="mono">${r.billNo}</td><td>${TYPE_LABELS[r.billType] ?? ''}</td>
      <td class="amount">${money(r.amountPaise)}</td><td class="amount">${r.discountPaise ? money(r.discountPaise) : ''}</td><td>${r.paidWithRowId ? `Paid with ${headOf(r) ? rowLabel(headOf(r)) : 'another row'}` : payText(r.payments)}${groupNote(r)}</td><td class="note">${r.remarks ?? ''}</td><td></td></tr>`;
  }
  const single = r.payments.length <= 1;
  const p = r.payments[0];
  const opts = [...PAY_OPTIONS];
  if (p && !opts.some(([m, l]) => `${m}|${l}` === payKey(p))) opts.push([p.mode, p.columnLabel ?? MODE_LABELS[p.mode]]);
  return html`<tr data-row="${r.id}" class="${r.status === 'checked' ? 'row-checked' : ''}">
    <td class="note">${r.lineNo}</td>
    <td style="text-align:center"><input type="checkbox" data-f="checked" ${r.status === 'checked' ? 'checked' : ''} aria-label="Checked against the page" title="Checked against the page" style="width:20px;height:20px;min-height:0"></td>
    <td>${billCell(r, nd('bill_no'))}</td>
    <td><select class="cell ${nd('bill_type')}" data-f="billType" aria-label="Type">
      <option value="">Choose</option>${Object.entries(TYPE_LABELS).map(([k, l]) => html`<option value="${k}" ${r.billType === k ? 'selected' : ''}>${l}</option>`)}</select></td>
    <td><input class="cell mono ${nd('amount') || (payDiffers(r) ? 'needs' : '')}" data-f="amount" value="${rupeesForInput(r.amountPaise)}" style="width:88px;text-align:right" inputmode="decimal" aria-label="Bill amount" title="${payDiffers(r) ? `Payments add up to ${money(paidOf(r))}` : ''}"></td>
    <td><input class="cell mono ${nd('discount') || (largePct(r) ? 'needs' : inferredOf(r.ocrOriginal).has('discount') ? 'auto' : '')}" data-f="discount" value="${r.discountPaise ? rupeesForInput(r.discountPaise) : ''}" placeholder="0" style="width:72px;text-align:right" inputmode="decimal" aria-label="Discount"
      title="${largePct(r) ? `Discount of ${largePct(r)}%${r.paidWithRowId || membersOf(r).length ? ' on the bills paid together' : ''}: check that no payment was missed. Compare sales asks for a decision.` : inferredOf(r.ocrOriginal).has('discount') ? 'Filled in automatically: bill amount minus payments (negative = tip). Check it against the page.' : 'Discount; a tip is negative'}">
      ${largePct(r) ? html`<div class="tiny" style="white-space:nowrap;color:var(--danger)">Disc ${largePct(r)}%</div>` : ''}</td>
    <td>${single ? html`<div style="display:flex;gap:6px">
        <select class="cell ${nd('payments') || (inferredOf(r.ocrOriginal).has('payments') && r.paidWithRowId ? 'auto' : '')}" data-f="pay" aria-label="Paid as"><option value="">None written</option>
          ${opts.map(([m, l]) => html`<option value="${m}|${l}" ${!r.paidWithRowId && p && payKey(p) === `${m}|${l}` ? 'selected' : ''}>${l}</option>`)}
          ${!membersOf(r).length ? regRows.filter((x) => x.id !== r.id && !x.paidWithRowId).map((x) => html`<option value="with|${x.id}" ${r.paidWithRowId === x.id ? 'selected' : ''}>Paid with ${rowLabel(x)}${x.elsewhere ? ` (${x.billNo || 'no number'})` : ''}</option>`) : ''}</select>
        <input class="cell mono ${nd('payments') || (payDiffers(r) && p ? 'needs' : '')}" data-f="payAmount" value="${p ? rupeesForInput(p.amountPaise) : ''}" style="width:84px;text-align:right" inputmode="decimal" aria-label="Payment amount" ${p && !r.paidWithRowId ? '' : 'hidden'}>
      </div>${groupNote(r)}` : html`<span class="${nd('payments') || payDiffers(r) ? 'error' : ''}">${payText(r.payments)}</span>${groupNote(r)}`}</td>
    <td><input class="cell ${nd('remarks')}" data-f="remarks" value="${r.remarks ?? ''}" style="width:130px" aria-label="Remarks"></td>
    <td style="text-align:right"><button class="btn plain" type="button" data-edit="${r.id}" style="min-height:36px">Edit</button></td>
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
  const off = u.rows.filter(payDiffers);
  const vsPage = written == null ? 'Enter the total written on the page to check it.'
    : written === bills && written === paid ? html`<span class="ok-msg">Both match the written total.</span>`
    : written === bills ? html`<span class="ok-msg">Bill amounts match the written total.</span>`
    : (disc || tips) && written === bills - disc + tips ? html`<span class="ok-msg">Bill amounts after discounts and tips match the written total.</span>`
    : written === paid ? html`<span class="ok-msg">Payments match the written total</span> (₹ ${money(written)}).`
    : html`<span class="error">The page says ₹ ${money(written)}.</span>`;
  return html`Bill amounts add up to <strong>₹ ${money(bills)}</strong>${disc || tips ? html`${disc ? html`, less discounts <strong>₹ ${money(disc)}</strong>` : ''}${tips ? html`, plus tips <strong>₹ ${money(tips)}</strong>` : ''} = <strong>₹ ${money(bills - disc + tips)}</strong>` : ''}. Payments add up to <strong>₹ ${money(paid)}</strong>. ${vsPage}
    ${off.length ? html`<br><span class="error">${off.length} row${off.length > 1 ? 's have' : ' has'} payments that differ from the bill amount after discount or tip (marked red): ${off.map((r) => r.lineNo).join(', ')}. Compare sales cannot confirm the shift until each row's payments equal its amount less discount.</span>` : ''}`;
}

/** Fill button and the amber note: redrawn after every inline save. */
function regToolsHtml(u, locked) {
  return html`
    ${!locked && [...new Set(u.rows.map((r) => headOf(r) ?? r))].some((r) => !r.paidWithRowId && r.payments.length && paidOf(r) > 0 && payDiffers(r)
        && [r, ...membersOf(r)].every((m) => (!m.discountPaise && !m.tipPaise) || inferredOf(m.ocrOriginal).has('discount')))
        ? html`<div class="form-row" style="align-items:center"><button class="btn plain" type="button" id="filldisc">Fill discounts and tips</button>
            <span class="note">Sets Disc = bill amount − payments where nobody has typed one: a discount when less was paid, a tip (negative) when more was paid. For bills paid together, the discount is shared across the bills by amount.</span></div>` : ''}
      ${u.rows.some((r) => inferredOf(r.ocrOriginal).has('discount')) ? html`<div class="note"><span class="auto-key">Amber</span> discounts and tips were filled in automatically (bill amount − payments; negative = tip). Check them against the page.</div>` : ''}
  `;
}

function registerPanel(biz, u) {
  regRows = shiftRowsOf(u);
  const locked = u.shiftStatus === 'confirmed';
  const written = u.pageWrittenTotalPaise;
  const anyUnclear = u.rows.some((r) => unclearOf(r.ocrOriginal, r.status === 'draft').size);
  return html`
    <section class="card grow3" style="gap:12px">
      ${locked ? html`<div class="demo-band">The shift for ${dayLabel(u.day)} is confirmed, so this page is locked. An Owner can reopen it on Compare sales.</div>`
        : html`<div class="note">Change any cell and it saves when you leave it. Tick a row once it matches the page; the tick is saved at once. When every row is ticked and the payments match, an Owner or Accountant confirms the shift on <a href="#/b/${biz.id}/compare/${u.day}">Compare sales</a>, which locks this page. Use Edit for a bill paid in more than one way.${anyUnclear || u.rows.some((r) => r.billMatch && !r.billMatch.exact) ? html` <span class="needs-key">Red boxes</span> need a look: Claude could not read the cell, or the bill number is not in the software report for this shift (pick the right one from "Did you mean…").` : ''}</div>`}
      <div class="scroll"><table style="min-width:860px" id="regtable">
        <thead><tr><th>#</th><th title="Checked against the page">✓</th><th>Bill</th><th>Type</th><th style="text-align:right">Amount</th><th style="text-align:right" title="Discount. Enter a tip as a negative number.">Disc / tip</th><th>Paid as</th><th>Remarks</th><th></th></tr></thead>
        <tbody>${u.rows.map((r) => regRowHtml(r, locked))}</tbody>
      </table></div>
      <div id="regtools">${regToolsHtml(u, locked)}</div>
      <div class="form-row" style="justify-content:space-between">
        <div class="note" id="regsum">${regSumHtml(u)}</div>
        ${locked ? '' : html`<form id="ptotal" class="form-row" style="align-items:flex-end"><div class="field"><label for="pt">Total written on the page (₹)</label><input id="pt" name="pageWrittenTotal" class="mono" value="${written == null ? '' : rupeesForInput(written)}"></div><button class="btn plain" type="submit">Save total</button></form>`}
      </div>
      ${locked ? '' : html`<form class="inset" id="rform"></form>`}
    </section>`;
}

/** Saves a row from its inline cells. One save at a time per row; the row is redrawn from the server. */
function wireInlineRows(biz, u) {
  const table = document.getElementById('regtable');
  if (!table) return;
  const queues = new Map();
  const payloadOf = (tr, r) => {
    const val = (f) => tr.querySelector(`[data-f="${f}"]`);
    let payments;
    if (r.payments.length > 1) {
      payments = r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: rupeesForInput(p.amountPaise) }));
    } else {
      const sel = val('pay').value;
      if (!sel || sel.startsWith('with|')) payments = [];
      else {
        const [mode, label] = sel.split('|');
        payments = [{ mode, columnLabel: label || null, amount: val('payAmount').value || val('amount').value }];
      }
    }
    const sel = val('pay')?.value ?? '';
    return {
      paidWithRowId: sel.startsWith('with|') ? sel.slice(5) : null,
      billNo: val('billNo').value.trim(), billType: val('billType').value || null, amount: val('amount').value, discount: val('discount').value || '0',
      remarks: val('remarks').value.trim() || null, payments, status: val('checked').checked ? 'checked' : 'draft',
    };
  };
  const save = (tr, changed) => {
    const id = tr.dataset.row;
    const r = u.rows.find((x) => x.id === id);
    // Keep a single payment in step with the bill amount when they were equal.
    const pa = tr.querySelector('[data-f="payAmount"]');
    if (changed.dataset.f === 'pay' && pa) {
      pa.hidden = !changed.value || changed.value.startsWith('with|');
      if (changed.value.startsWith('with|')) pa.value = '';
      if (changed.value && !pa.value) {
        const a = parsePaiseText(tr.querySelector('[data-f="amount"]').value);
        const d = parsePaiseText(tr.querySelector('[data-f="discount"]').value || '0');
        pa.value = a !== null && d !== null ? rupeesForInput(a - d) : tr.querySelector('[data-f="amount"]').value;
      }
    }
    if (changed.dataset.f === 'pay' && pa && !changed.value) {
      pa.value = '';
    }
    // Discount follows the payment: amount - payments. Negative when more was paid: a tip.
    if (['amount', 'payAmount', 'pay'].includes(changed.dataset.f) && r.payments.length <= 1 && !r.paidWithRowId && !membersOf(r).length && !String(tr.querySelector('[data-f="pay"]')?.value).startsWith('with|')) {
      const a = parsePaiseText(tr.querySelector('[data-f="amount"]').value);
      const sel = tr.querySelector('[data-f="pay"]');
      const paid = pa && sel?.value ? parsePaiseText(pa.value) : null;
      if (a !== null && paid !== null && paid > 0) tr.querySelector('[data-f="discount"]').value = paid !== a ? rupeesForInput(a - paid) : '';
    }
    if (changed.dataset.f === 'pickBill') {
      if (!changed.value) return;
      tr.querySelector('[data-f="billNo"]').value = changed.value;
    }
    const body = payloadOf(tr, r);
    const run = (queues.get(id) ?? Promise.resolve()).then(async () => {
      const focus = document.activeElement?.closest?.('tr')?.dataset.row === id ? document.activeElement.dataset.f : null;
      try {
        await apiFull('PUT', `/businesses/${biz.id}/register-rows/${id}`, body);
        document.getElementById('rmsg').innerHTML = '';
      } catch (err) {
        showError(document.getElementById('rmsg'), err);
      }
      const fresh = await api('GET', `/businesses/${biz.id}/uploads/${u.id}`);
      u.rows = fresh.rows;
      u.otherPageRows = fresh.otherPageRows;
      regRows = shiftRowsOf(u);
      // Redraw every row: fixing one bill number changes what the others are offered.
      const active = document.activeElement;
      const keep = active?.closest?.('tr')?.dataset.row ? { row: active.closest('tr').dataset.row, f: active.dataset.f } : null;
      const body2 = table.querySelector('tbody');
      body2.innerHTML = u.rows.map((x) => regRowHtml(x, false).__html).join('');
      body2.querySelectorAll('tr').forEach(bind);
      if (keep?.f) body2.querySelector(`tr[data-row="${keep.row}"] [data-f="${keep.f}"]`)?.focus();
      else if (focus) body2.querySelector(`tr[data-row="${id}"] [data-f="${focus}"]`)?.focus();
      document.getElementById('regsum').innerHTML = regSumHtml(u).__html;
      document.getElementById('regtools').innerHTML = regToolsHtml(u, false).__html;
      wireFill();
    });
    queues.set(id, run);
  };
  const bind = (tr) => {
    tr.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => save(tr, el)));
    tr.querySelector('[data-edit]')?.addEventListener('click', () => openRowForm(tr.dataset.row));
  };
  let openRowForm = () => {};
  table.querySelectorAll('tbody tr').forEach(bind);
  return (fn) => { openRowForm = fn; };
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
      <div class="field"><label>Discount (₹, a tip as negative)</label><input name="discount" class="mono" value="${r?.discountPaise ? rupeesForInput(r.discountPaise) : ''}" placeholder="0"></div>
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

let wireFill = () => {};
function wireRegister(biz, u) {
  wireFill = () => document.getElementById('filldisc')?.addEventListener('click', async () => {
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
    reviewView(biz, u.id);
  });
  const setEdit = wireInlineRows(biz, u);
  setEdit?.((rowId) => {
    const r = u.rows.find((x) => x.id === rowId);
    form.dataset.editing = r.id;
    show(r);
  });
  form.dataset.editing = '';
  show(null);
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
  if (c.largeDiscount && c.software) return [['use_register', 'Accept discount'], ['use_software', 'Payment missing · use software'], ['leave_out', 'Leave out']];
  if (!c.register) return [['use_software', 'Use software · F&B', 'fnb'], ['use_software', 'Use software · Room', 'room'], ['leave_out', 'Leave out'], ...carry];
  if (!c.software) return [['use_register', 'Use register'], ['leave_out', 'Leave out'], ...carry];
  return Object.entries(DECISION_LABELS).filter(([k]) => k !== 'carry_forward');
}

/** A "Next step" line with each bill number on this shift turned into a link to its row. */
function blockerHtml(text, v) {
  const bills = new Set(v.comparisons.map((c) => c.billNo));
  const parts = String(text).split(/(\b[0-9A-Za-z/-]{2,}\b)/);
  return { __html: parts.map((p) => (bills.has(p) ? `<a href="#" data-gobill="${esc(p)}" class="mono">${esc(p)}</a>` : esc(p))).join('') };
}

/** A register-only bill that can be counted from the register in bulk (not matched to another day's software bill). */
const bulkOk = (c) => c.difference === 'missing_in_software' && !(c.otherDay && (c.otherDay.decision === 'use_software' || c.otherDay.decision === 'use_register')) && !c.largeDiscount;

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
      ${row('Counted', 'cash in hand on this day\'s cash summary page', k.countedPaise, k.summaryUploadId ? html`<a href="#/b/${biz.id}/review/${k.summaryUploadId}">Open page</a>` : html`<a href="#/b/${biz.id}/upload">Upload it</a>`)}
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
  return b ? html`<a class="btn" style="display:inline-flex;align-items:center" href="${b.hash}" id="backto">← Back to differences (${b.label})</a>` : '';
};

// ---------- Compare sales

async function compareView(biz, day) {
  const { shifts } = await api('GET', `/businesses/${biz.id}/shifts`);
  if (!day) day = shifts.find((s) => s.status !== 'confirmed')?.day ?? shifts[0]?.day;
  if (!day) {
    render(shell(biz, 'compare', 'Compare sales', 'Software report against the handwritten register, bill by bill. You decide every difference.', html`
      <section class="card"><div class="note">No sales yet. <a href="#/b/${biz.id}/upload">Upload a software sales report</a>.</div></section>`));
    return wireShell();
  }
  const [v, cash, waiting] = await Promise.all([api('GET', `/businesses/${biz.id}/shifts/${day}`), api('GET', `/businesses/${biz.id}/shifts/${day}/cash`),
    api('GET', `/businesses/${biz.id}/waiting-bills`)]);
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
      ${v.matchedAfterAdjustment?.length ? html`<div class="note">${v.matchedAfterAdjustment.length} bill${v.matchedAfterAdjustment.length > 1 ? 's match' : ' matches'} after a discount or tip, so ${v.matchedAfterAdjustment.length > 1 ? 'they need' : 'it needs'} no decision. The register amount (what was received) is used, and is what bank matching will look for:
        ${v.matchedAfterAdjustment.map((m) => `${m.billNo} (software ${money(m.softwarePaise)}, received ${money(m.registerPaise)})`).join(', ')}.</div>` : ''}
      ${canDecide && !confirmed && toDecide.filter(bulkOk).length > 1 ? html`<form id="bulkreg" class="inset" style="gap:8px">
        <div class="note"><strong>${toDecide.filter(bulkOk).length} bills are only in the register.</strong> For bills that will never be in a software report (e.g. pending bills of an old POS), tick them and count them from the register at once. They are then not watched for a software bill.</div>
        <div class="form-row" style="align-items:flex-end">
          <button class="btn plain" type="button" id="bulkall">Select all ${toDecide.filter(bulkOk).length}</button>
          <div class="field"><label for="bulknote">Reason</label><input id="bulknote" name="note" value="Old POS bill" required></div>
          <button class="btn" type="submit" id="bulkgo" disabled>Use register for 0 selected</button>
        </div>
        <div class="form-msg"></div>
      </form>` : ''}
      ${toDecide.length ? html`<div class="scroll"><table style="min-width:860px">
        <thead><tr><th>Bill</th><th>Paid at</th><th>Software</th><th>Register</th><th>What differs</th><th>Your decision</th></tr></thead>
        <tbody>${toDecide.map((c) => html`<tr data-bill="${c.billNo}" data-open="${c.register?.uploadId ? `#/b/${biz.id}/review/${c.register.uploadId}/${c.register.rowId}` : `#/b/${biz.id}/review?find=${c.billNo.slice(-4)}`}"
            class="clickrow" style="background:${c.decision ? 'transparent' : '#FFF7ED'}" title="${c.register ? 'Open this bill in its register page' : 'Look for this bill on the register pages'}">
          <td class="mono">${bulkOk(c) ? html`<input type="checkbox" data-bulk="${c.id}" aria-label="Select bill ${c.billNo}" style="width:18px;height:18px;min-height:0;margin-right:6px;vertical-align:middle">` : ''}<a href="#" data-openlink>${c.billNo}</a>${otherDayNote(c)}</td><td style="white-space:nowrap">${c.paidAt ? when(c.paidAt) : 'Not in report'}</td>
          <td>${side(c.software)}</td><td>${side(c.register)}</td>
          <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
            ${!c.largeDiscount || c.difference.startsWith('missing') || c.difference === 'mode' ? html`<span class="chip ${c.difference.startsWith('missing') ? 'bad' : 'wait'}">${DIFF_LABELS[c.difference]}</span>` : ''}
            ${c.largeDiscount ? html`<span class="chip bad" title="Discount of ₹ ${money(c.largeDiscount.discountPaise)} on ₹ ${money(c.largeDiscount.grossPaise)} of bills${c.largeDiscount.grossPaise !== (c.register?.amountPaise ?? 0) + Math.max(c.register?.discountPaise ?? 0, 0) ? ' (bills paid together)' : ''}. Check that no payment was missed in the register.">Large discount ${c.largeDiscount.pct}%</span>${c.difference === 'amount_and_mode' ? html`<span class="chip wait">Mode differs</span>` : ''}` : ''}
          </div></td>
          <td>${canDecide && !confirmed ? html`<div style="display:flex;flex-wrap:wrap;gap:6px">${decisionChoices(c).map(([k, l, type, link]) => {
              const on = c.decision === k && (!type || c.billType === type) && (link ?? null) === (c.linkedToId ?? null);
              if (k === 'leave_out' && !link && !c.register && c.software?.mode === 'cash') {
                return html`<select class="cell ${on ? 'auto' : ''}" data-leaveout="${c.id}" aria-label="Leave out because" style="min-height:44px">
                  <option value="">${on ? `Left out: ${c.note ?? ''}` : 'Leave out because…'}</option>
                  ${(v.reasons ?? []).map((r) => html`<option value="${r}">${r}</option>`)}<option value="__other">Another reason…</option></select>`;
              }
              return html`<button class="btn ${on ? 'ghost' : 'plain'}" style="${on ? 'font-weight:600;background:#E3F1EF' : ''}" data-cmp="${c.id}" data-d="${k}" data-type="${type ?? ''}" data-link="${link ?? ''}">${l}</button>`;
            })}</div>`
            : html`<span class="note">${c.decision ? `${DECISION_LABELS[c.decision]}${c.billType ? ` · ${TYPE_LABELS[c.billType]}` : ''}${c.note ? `: ${c.note}` : ''}` : 'Not decided'}</span>`}</td>
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
          ${v.blockers.length ? html`<ul class="note" style="margin:0;padding-left:18px">${v.blockers.map((b) => html`<li>${blockerHtml(b, v)}</li>`)}</ul>` : html`<div class="note">Everything is decided. Confirming turns the sales into approved income rows.</div>`}
          ${canDecide ? html`<button class="btn big" id="confirm" ${v.canConfirm ? '' : 'disabled'}>Confirm sales for this shift</button>` : ''}
          <div class="note">Only Owner and Accountant can decide differences and confirm.</div>`}
      </section>
    </div>
    ${waitingHtml(biz, waiting, canDecide)}
    ${cashPanelHtml(biz, cash)}`));
  wireShell();
  const msg = document.getElementById('cmsg');
  document.getElementById('sh').addEventListener('change', (e) => go(`#/b/${biz.id}/compare/${e.target.value}`));
  const act = async (fn) => { try { await fn(); compareView(biz, day); } catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
  app.querySelectorAll('[data-cmp]').forEach((b) => b.addEventListener('click', () => {
    const c = v.comparisons.find((x) => x.id === b.dataset.cmp);
    let note = null;
    if (c?.largeDiscount && b.dataset.d === 'use_register') {
      note = (prompt(`Why is the ${c.largeDiscount.pct}% discount on bill ${c.billNo} accepted? (e.g. owner's guest, group rate)`) ?? '').trim();
      if (!note) return;
    }
    if (!note && b.dataset.d === 'leave_out' && b.dataset.link && c?.otherDay?.decision === 'leave_out') {
      note = (prompt(`Bill ${c.billNo} was left out on ${dayLabel(c.otherDay.day)}${c.otherDay.note ? ` (${c.otherDay.note})` : ''} and now appears here. Why leave it out again?`) ?? '').trim();
      if (!note) return;
    }
    act(() => apiFull('PUT', `/businesses/${biz.id}/comparisons/${b.dataset.cmp}`, { decision: b.dataset.d, billType: b.dataset.type || null, note, linkedToId: b.dataset.link || null }));
  }));
  // A difference opens its bill in Review; Review offers a way back to this bill here.
  app.querySelectorAll('tr.clickrow').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button, select, input')) return;
    e.preventDefault();
    setBackTo({ hash: `#/b/${biz.id}/compare/${day}`, bill: tr.dataset.bill, label: `${dayLabel(day)} shift` });
    location.hash = tr.dataset.open;
  }));
  const back = getBackTo();
  if (back?.bill && back.hash === `#/b/${biz.id}/compare/${day}`) {
    clearBackTo();
    const row = app.querySelector(`tr[data-bill="${CSS.escape(back.bill)}"]`);
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
    };
    boxes().forEach((x) => x.addEventListener('change', count));
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
  app.querySelectorAll('[data-gobill]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const row = app.querySelector(`tr[data-bill="${CSS.escape(a.dataset.gobill)}"]`);
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
  app.querySelectorAll('[data-closebill]').forEach((b) => b.addEventListener('click', () => {
    const note = (prompt(`Close bill ${b.dataset.bill}: why did its other side never turn up?`) ?? '').trim();
    if (note) act(() => apiFull('POST', `/businesses/${biz.id}/comparisons/${b.dataset.closebill}/close`, { note }));
  }));
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

// ---------- Bank sync: accounts, their sheets, and statement lines with what Bookr suggests

const BANK_KIND = { upi_in: 'UPI in', upi_out: 'UPI out', upi_fee: 'UPI card fee', reversal: 'Reversal', card_settlement: 'Card settlement', card_purchase: 'Card purchase', other: 'Other' };
const hhmm = (ms) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));

async function bankView(biz, query = '') {
  const q = new URLSearchParams(query);
  const to = q.get('to') || todayIst();
  const from = q.get('from') || to;
  const account = q.get('account') || '';
  const status = q.get('status') ?? 'unmatched';
  const [b, lines, { heads }, { rules }] = await Promise.all([
    api('GET', `/businesses/${biz.id}/bank`),
    api('GET', `/businesses/${biz.id}/bank-rows?from=${from}&to=${to}${account ? `&account=${account}` : ''}${status ? `&status=${status}` : ''}`),
    api('GET', `/businesses/${biz.id}/heads`),
    api('GET', `/businesses/${biz.id}/rules`),
  ]);
  const canRules = biz.actions.includes('rules.edit');
  const headsOf = (dir) => heads.filter((h) => h.type === (dir === 'CR' ? 'income' : 'expense'));
  const rows = lines.rows;
  const clear = rows.filter((r) => r.clear);
  const byRule = rows.filter((r) => r.rule);
  const reversals = rows.filter((r) => r.kind === 'reversal' && r.status === 'unmatched' && r.pairRowId).length;
  const link = (over) => { const p = new URLSearchParams({ from, to, account, status, ...over }); return `#/b/${biz.id}/bank?${p}`; };
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
    if (r.status === 'matched') return html`<span class="chip ok">Matched</span> <span class="note">Bill ${r.bills ?? ''}</span> <button class="btn plain" type="button" data-unmatch="${r.id}">Unmatch</button>`;
    if (r.status === 'booked') return html`<span class="chip ok">Booked</span> <span class="note">${r.headName ?? ''}${r.note ? ` · ${r.note}` : ''}</span> <button class="btn plain" type="button" data-reopen="${r.id}">Undo</button>`;
    if (r.status === 'ignored') return html`<span class="chip">Left out</span> <span class="note">${r.note ?? ''}</span> <button class="btn plain" type="button" data-reopen="${r.id}">Undo</button>`;
    const parts = [];
    if (r.kind === 'upi_in') {
      parts.push(r.candidates.length ? html`<div style="display:flex;flex-direction:column;gap:4px">${r.candidates.map((k, i) => html`<div class="form-row" style="gap:6px;align-items:center">
          ${r.clear && i === 0 ? html`<input type="checkbox" data-clear="${r.id}" checked aria-label="Confirm this match" style="width:18px;height:18px;min-height:0">` : ''}
          <span class="${k.strong ? '' : 'note'}">Bill ${k.billNos.join(' + ')} · ₹ ${money(k.amountPaise)}${k.minutes != null ? ` · ${k.minutes} min apart` : ` · ${dayLabel(k.shiftDay)} shift`}</span>
          <button class="btn plain" type="button" data-match="${r.id}" data-tx="${k.transactionIds.join(',')}">Match</button></div>`)}</div>`
        : html`<span class="note">No UPI sale of this amount near this time.</span>`);
    }
    if (r.kind === 'upi_fee') parts.push(html`<div class="note">Fee on a credit card paid through UPI${r.pairRowId ? '' : ' (its credit is not in Bookr yet)'}.</div>`);
    if (r.kind === 'reversal') parts.push(html`<div class="note">${r.pairRowId ? 'Gives back a failed payment: both cancel out.' : 'A reversal; its payment is not in Bookr yet.'}</div>`);
    if (r.rule) parts.push(html`<div class="form-row" style="gap:6px;align-items:center"><input type="checkbox" data-byrule="${r.id}" checked aria-label="Book by this rule" style="width:18px;height:18px;min-height:0">
      <span>Rule <strong>${r.rule.name}</strong> → ${heads.find((h) => h.id === r.rule.headId)?.name ?? ''}</span></div>`);
    parts.push(html`<div class="form-row" style="gap:6px"><button class="btn plain" type="button" data-book="${r.id}">Book…</button>
      <button class="btn plain" type="button" data-ignore="${r.id}">Leave out</button>
      ${canRules && r.kind !== 'upi_in' ? html`<button class="btn plain" type="button" data-mkrule="${r.id}">Make a rule</button>` : ''}</div>
      <form class="inset" hidden data-bookform="${r.id}"><div class="form-row">
        <div class="field"><label>Head</label><select name="headId" required><option value="">Choose</option>${headsOf(r.direction).map((h) => html`<option value="${h.id}">${h.name}</option>`)}</select></div>
        <div class="field"><label>Party</label><input name="party" placeholder="optional"></div>
        <div class="field"><label>Note</label><input name="note" placeholder="optional"></div>
        <button class="btn" type="submit" style="align-self:flex-end">Book</button></div><div class="form-msg"></div></form>`);
    return parts;
  };

  render(shell(biz, 'bank', 'Bank sync', 'Statement lines from each bank account, matched to sales or booked under a head. Nothing is booked until a person confirms it.', html`
    <div id="bmsg"></div>
    <section class="card" style="gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2>Bank accounts</h2><a href="#/b/${biz.id}/accounts" class="note">Add a bank account on Accounts</a></div>
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
        <div class="field"><label>From</label><input type="date" name="from" value="${from}"></div>
        <div class="field"><label>To</label><input type="date" name="to" value="${to}"></div>
        <div class="field"><label>Account</label><select name="account"><option value="">All</option>${b.accounts.map((a) => html`<option value="${a.id}" ${a.id === account ? 'selected' : ''}>${a.name}</option>`)}</select></div>
        <div class="field"><label>Show</label><select name="status">${[['unmatched', 'Open'], ['', 'All'], ['matched', 'Matched'], ['booked', 'Booked'], ['ignored', 'Left out']].map(([v, l]) => html`<option value="${v}" ${v === status ? 'selected' : ''}>${l}</option>`)}</select></div>
        <button class="btn plain" type="submit">Show</button>
      </form>
      <div class="form-row" style="gap:8px">
        ${clear.length ? html`<button class="btn" type="button" id="goclear">Confirm ${clear.length} clear UPI match${clear.length > 1 ? 'es' : ''}</button>` : ''}
        ${byRule.length ? html`<button class="btn" type="button" id="gorules">Book ${byRule.length} by rules</button>` : ''}
        ${reversals ? html`<button class="btn plain" type="button" id="gorev">Leave out ${reversals} reversed payment${reversals > 1 ? 's' : ''}</button>` : ''}
        <span class="note">${clear.length ? 'Clear: one UPI sale of the same amount paid within 20 minutes. ' : ''}Untick any you are not sure of.</span>
      </div>
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
      ${rows.length ? html`<div class="scroll"><table style="min-width:980px">
        <thead><tr><th>When</th><th>Account</th><th>Description</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th>Bookr suggests / done</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr data-row="${r.id}">
          <td style="white-space:nowrap">${dayLabel(r.day)}<div class="note">${hhmm(r.postedAt)}</div></td>
          <td class="note">${r.accountName}</td>
          <td style="max-width:340px"><span class="chip">${BANK_KIND[r.kind]}</span> ${r.remark && !/^(UPI|UPI Pay|NA|NO REMARKS?)$/i.test(r.remark) ? html`<strong>${r.remark}</strong>` : ''}
            <div class="tiny mono" style="word-break:break-all">${r.vpa ? `${r.vpa} · ` : ''}${r.tranId}</div></td>
          <td class="amount">${r.direction === 'CR' ? money(r.amountPaise) : ''}</td><td class="amount">${r.direction === 'DR' ? money(r.amountPaise) : ''}</td>
          <td>${suggestion(r)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="note">No ${({ unmatched: 'open', matched: 'matched', booked: 'booked', ignored: 'left-out' })[status] ?? ''} lines for these dates${account ? ' in this account' : ''}.${status ? ' Choose "All" under Show to see every line.' : ''}</div>`}
    </section>`));
  wireShell();
  const msg = document.getElementById('bmsg');
  const run = async (fn, okText) => {
    try { const r = await fn(); await bankView(biz, query); if (okText) document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">${okText(r)}</div>`.__html; }
    catch (err) { showError(msg, err); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  onSubmit(document.getElementById('bfilter'), async (d) => go(link({ from: d.from, to: d.to, account: d.account, status: d.status })));
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
    const note = (prompt('Why is this line left out? (e.g. transfer between own accounts, personal)') ?? '').trim();
    if (note) run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/${x.dataset.ignore}/ignore`, { note }));
  }));
  app.querySelectorAll('[data-book]').forEach((x) => x.addEventListener('click', () => { const f = app.querySelector(`[data-bookform="${x.dataset.book}"]`); f.hidden = !f.hidden; }));
  app.querySelectorAll('[data-bookform]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await apiFull('POST', `/businesses/${biz.id}/bank-rows/${f.dataset.bookform}/book`, { headId: f.headId.value, party: f.party.value || null, note: f.note.value || null }); bankView(biz, query); }
    catch (err) { showError(f.querySelector('.form-msg'), err); }
  }));
  document.getElementById('goclear')?.addEventListener('click', () => {
    const ids = [...app.querySelectorAll('[data-clear]')].filter((c) => c.checked).map((c) => c.dataset.clear);
    if (ids.length) run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/match-clear`, { ids }), (r) => `${r.matched} UPI credit${r.matched === 1 ? '' : 's'} matched.`);
  });
  document.getElementById('gorules')?.addEventListener('click', () => {
    const ids = [...app.querySelectorAll('[data-byrule]')].filter((c) => c.checked).map((c) => c.dataset.byrule);
    if (ids.length) run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/book-by-rules`, { ids }), (r) => `${r.booked} line${r.booked === 1 ? '' : 's'} booked by rules.`);
  });
  document.getElementById('gorev')?.addEventListener('click', () => run(() => apiFull('POST', `/businesses/${biz.id}/bank-rows/ignore-reversals`, {}), (r) => `${r.pairs} reversed payment${r.pairs === 1 ? '' : 's'} left out with ${r.pairs === 1 ? 'its' : 'their'} reversal.`));
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
      document.getElementById('bmsg').innerHTML = html`<div class="ok-msg">Rule saved. Lines it fits now show it; tick them and use "Book by rules".</div>`.__html;
    } catch (err) { showError(rf.querySelector('.form-msg'), err); }
  });
  void rules;
}

// ---------- UPI matching: each confirmed shift's UPI sales and the credit that paid each

async function upiView(biz, day) {
  const v = await api('GET', `/businesses/${biz.id}/upi${day ? `?day=${day}` : ''}`);
  const sum = (xs) => xs.reduce((t, x) => t + x.amountPaise, 0);
  const matched = v.sales.filter((s) => s.bankRowId);
  const waiting = v.sales.filter((s) => !s.bankRowId);
  const days = [...new Set([v.day, ...v.confirmedShifts])].sort().reverse();
  render(shell(biz, 'upi', 'UPI matching', 'Each UPI sale of a confirmed shift, and the bank credit that paid it.', html`
    <div class="form-row" style="align-items:flex-end;margin-bottom:12px"><div class="field"><label for="upiday">Shift</label>
      <select id="upiday">${days.map((d) => html`<option value="${d}" ${d === v.day ? 'selected' : ''}>${dayLabel(d)}${v.confirmedShifts.includes(d) ? '' : ' (not confirmed)'}</option>`)}</select></div>
      <a class="btn" style="display:inline-flex;align-items:center" href="#/b/${biz.id}/bank?from=${v.day}&to=${addDaysIso(v.day, 1)}&status=unmatched">Match on Bank sync</a></div>
    <div class="row">
      <section class="card grow1"><h2>UPI sales</h2><div class="amount" style="font-size:24px">₹ ${money(sum(v.sales))}</div><div class="note">${v.sales.length} sale${v.sales.length === 1 ? '' : 's'}</div></section>
      <section class="card grow1"><h2>In the bank</h2><div class="amount" style="font-size:24px;color:var(--teal)">₹ ${money(sum(matched))}</div><div class="note">${matched.length} matched</div></section>
      <section class="card grow1"><h2>Not found yet</h2><div class="amount" style="font-size:24px;color:${waiting.length ? 'var(--danger)' : 'inherit'}">₹ ${money(sum(waiting))}</div><div class="note">${waiting.length} waiting</div></section>
    </div>
    <section class="card" style="margin-top:16px">
      ${v.sales.length ? html`<div class="scroll"><table style="min-width:720px"><thead><tr><th>Bill</th><th>Paid at</th><th>Register column</th><th style="text-align:right">Amount</th><th>Bank credit</th></tr></thead>
        <tbody>${v.sales.map((s) => html`<tr>
          <td class="mono">${s.billNo ?? ''}</td><td>${s.paidAt ? when(s.paidAt) : html`<span class="note">register only</span>`}</td><td class="note">${s.labels ?? ''}</td>
          <td class="amount">${money(s.amountPaise)}</td>
          <td>${s.bankRowId ? html`<span class="chip ok">${s.accountName}</span> <span class="note">${when(s.creditAt)}${s.paidAt ? ` · ${Math.round(Math.abs(s.creditAt - s.paidAt) / 60000)} min` : ''}</span>` : html`<span class="chip bad">Not found yet</span>`}</td></tr>`)}</tbody></table></div>`
        : html`<div class="note">No UPI sales in this shift${v.confirmedShifts.includes(v.day) ? '' : ' yet: sales count once the shift is confirmed on Compare sales'}.</div>`}
    </section>`));
  wireShell();
  document.getElementById('upiday').addEventListener('change', (e) => go(`#/b/${biz.id}/upi/${e.target.value}`));
}
const addDaysIso = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// ---------- router

async function route() {
  document.body.classList.remove('review-expanded');
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
      if (screen === 'upload') return uploadView(biz);
      if (screen === 'review') return parts[3] ? reviewView(biz, parts[3], parts[4]) : reviewListView(biz, new URLSearchParams(query).get('find'));
      if (screen === 'compare') return compareView(biz, parts[3]);
      if (screen === 'bank') return bankView(biz, query);
      if (screen === 'upi') return upiView(biz, parts[3]);
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
