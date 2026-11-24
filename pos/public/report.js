// The Daily check for the owner (report.html): one shift, read-only, from a one-time link. See pos/src/routes/owner-report.ts.
(() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const rs = (p) => `₹${Math.round((p ?? 0) / 100).toLocaleString('en-IN')}`;
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const hrs = (h) => (h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h`);
  const page = document.getElementById('page');
  const [bid, day, exp, sig] = decodeURIComponent(location.hash.slice(1)).split('.');
  const fail = (m) => { page.innerHTML = `<div class="err">${esc(m)}</div>`; document.body.dataset.ready = 'error'; };
  if (!bid || !day || !exp || !sig) return fail('This link is not complete.');
  fetch(`/api/report/data?b=${encodeURIComponent(bid)}&d=${encodeURIComponent(day)}&e=${encodeURIComponent(exp)}&s=${encodeURIComponent(sig)}`)
    .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || 'Could not load it.')))))
    .then(render).catch((e) => fail(e.message));

  function render({ business, shiftStartHour, tabAgeDays, d, events }) {
    const ev = (k) => d.events[k] ?? { n: 0, paise: 0 };
    const df = (k) => d.differences[k] ?? { n: 0, paise: 0 };
    const sum = (xs, f) => xs.reduce((t, x) => t + (f(x) ?? 0), 0);
    const placeOf = (ref) => String(ref ?? '').split(' · ')[0];
    const broken = d.series.filter((x) => x.missing.length).concat(d.creditNoteSeries.filter((x) => x.missing.length));
    // Sent to the kitchen or bar, not paid: as the Daily check tab.
    const cancels = events.filter((e) => e.kind === 'kot_cancel' && !/\(whole order\)/.test(e.ref ?? ''));
    const wholeLines = events.filter((e) => e.kind === 'kot_cancel' && /\(whole order\)/.test(e.ref ?? ''));
    const wholeOrders = [...new Set(wholeLines.map((e) => placeOf(e.ref)))];
    const voids = d.voidedNotRebilled ?? [];
    const comps = events.filter((e) => e.kind === 'comp');
    const unpaidOld = d.unpaid.filter((o) => o.old);
    const np = [
      { label: 'Cancelled after KOT', color: '#b45309', n: cancels.length, unit: 'line', paise: sum(cancels, (e) => e.amountPaise), back: true },
      { label: 'Whole order cancelled', color: '#d97706', n: wholeOrders.length, unit: 'order', paise: sum(wholeLines, (e) => e.amountPaise), back: true },
      { label: 'Bill voided, not billed again', color: '#7c2d12', n: voids.length, unit: 'bill', paise: sum(voids, (b) => b.totalPaise) },
      { label: 'Complimentary / NC', color: '#0f766e', n: comps.length, unit: 'bill', paise: sum(comps, (e) => e.amountPaise) },
      { label: 'Not paid yet', color: '#b91c1c', n: unpaidOld.length, unit: 'table', paise: sum(unpaidOld, (o) => o.sentPaise), red: true },
    ];
    const npTotal = sum(np, (x) => x.paise);
    const people = new Map();
    const who = (n) => { const k = n || 'Unknown'; if (!people.has(k)) people.set(k, { name: k, cancels: 0, voids: 0, nc: 0, paise: 0 }); return people.get(k); };
    for (const e of [...cancels, ...wholeLines]) { const p = who(e.byName); p.cancels++; p.paise += e.amountPaise ?? 0; }
    const lostNos = new Set(voids.map((b) => b.billNo));
    for (const e of events.filter((x) => x.kind === 'void' && lostNos.has(x.ref))) { const p = who(e.byName); p.voids++; p.paise += e.amountPaise ?? 0; }
    for (const e of comps) { const p = who(e.byName); p.nc++; p.paise += e.amountPaise ?? 0; }
    const byPerson = [...people.values()].sort((a, b) => b.paise - a.paise);
    const heavy = byPerson.filter((p) => p.cancels >= 3);
    const look = [
      ...(!d.shiftClose ? ['Shift not closed yet'] : []),
      ...(d.shiftClose && !d.shiftClose.countedAt ? ['Cash drawer not counted at day close'] : d.shiftClose && d.shiftClose.differencePaise ? [`Cash ${d.shiftClose.differencePaise > 0 ? 'over' : 'short'} ${rs(Math.abs(d.shiftClose.differencePaise))} at day close`] : []),
      ...(d.drawers ?? []).filter((x) => x.differencePaise).map((x) => `Cash ${x.differencePaise < 0 ? 'short' : 'over'} ${rs(Math.abs(x.differencePaise))} in ${x.holder}'s drawer`),
      ...unpaidOld.map((o) => `${o.place} not paid for ${hrs(o.hours)}`),
      ...heavy.map((p) => `${p.name} cancelled ${plural(p.cancels, 'KOT line')}`),
      ...(broken.length ? ['Bill numbers missing'] : []),
      ...(d.bar.missingPaise ? [`Bar count: ${rs(d.bar.missingPaise)} missing`] : []),
    ];
    const modeName = { cash: 'Cash', upi: 'UPI', card: 'Card', room: 'To rooms', credit: 'On credit', advance: 'Advances used' };
    const modes = d.byMode.filter((m) => m.mode !== 'comp');
    const maxMode = Math.max(1, ...modes.map((m) => m.paise));
    const tile = (k, v, n, tone = '', wide = false) => `<div class="tile ${tone} ${wide ? 'wide' : ''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n)}</div></div>`;
    const exT = (n, k, money) => `<div class="ex ${n ? 'on' : ''}"><div class="k">${esc(k)}</div><div class="v">${n}</div><div class="n">${n ? (money !== undefined ? rs(money) : '') : 'none'}</div></div>`;
    const cashTile = d.shiftClose && !d.shiftClose.countedAt ? tile('Cash close', 'Not counted', 'Count it on Day close', 'bad')
      : d.shiftClose ? tile('Cash close', d.shiftClose.differencePaise === 0 ? 'Matched' : `${d.shiftClose.differencePaise > 0 ? 'Over' : 'Short'} ${rs(Math.abs(d.shiftClose.differencePaise))}`, d.shiftClose.reason ?? 'Shift closed', d.shiftClose.differencePaise === 0 ? 'good' : 'bad')
      : tile('Cash close', 'Not closed', 'The shift is not closed yet', 'warn');
    const h = shiftStartHour ?? 8;
    page.innerHTML = `
      <header><small>BOOKR POS</small><h1>Daily check · ${esc(dayName(day))}</h1><p>${esc(business)} · shift ${h} am to ${h} am</p></header>
      <main>
        ${look.length ? `<div class="look"><b>${plural(look.length, 'thing')} to look at</b><ul>${look.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
          : '<div class="look ok"><b>All clear</b><div>Cash matched, nothing unpaid for long, no unusual cancels.</div></div>'}
        <div class="tiles">
          ${tile(`Net sales · ${plural(d.sales.bills, 'bill')}`, rs(d.sales.netPaise), `${rs(d.sales.totalPaise)} with GST`, '', true)}
          ${cashTile}
          ${tile('Bill numbers', broken.length ? 'Gaps found' : 'Unbroken', broken.length ? 'See below' : `FY ${d.fy}`, broken.length ? 'bad' : 'good')}
          ${tile('Not paid for', rs(npTotal), npTotal ? 'sent, no money' : 'everything paid', npTotal ? 'warn' : 'good')}
          ${tile('Bar count', d.bar.counts ? (d.bar.missingPaise ? `${rs(d.bar.missingPaise)} missing` : 'Nothing missing') : 'Not counted', d.bar.counts ? plural(d.bar.counts, 'count') : '', d.bar.counts ? (d.bar.missingPaise ? 'bad' : 'good') : 'warn')}
        </div>
        <section class="np"><h2>Sent to kitchen or bar, not paid · ${rs(npTotal)}</h2>
          <div class="bar">${npTotal ? np.filter((x) => x.paise).map((x) => `<span style="width:${(x.paise / npTotal) * 100}%;background:${x.color}"></span>`).join('') : ''}</div>
          ${np.map((x) => `<div class="row"><span><span class="dot" style="background:${x.color}"></span>${esc(x.label)}<div class="q" style="margin-left:15px">${x.n ? plural(x.n, x.unit) : 'none'}${x.n && x.back ? ' · stock put back, check at count' : ''}</div></span><strong style="${x.red && x.n ? 'color:var(--bad)' : ''}">${x.n ? rs(x.paise) : '—'}</strong></div>`).join('')}
          ${byPerson.length ? `<h3>By person</h3>${byPerson.map((p) => `<div class="row ${p.cancels >= 3 ? 'flag' : ''}"><span><strong>${esc(p.name)}</strong><div class="q">${[p.cancels ? plural(p.cancels, 'cancel') : '', p.voids ? plural(p.voids, 'void') : '', p.nc ? `${p.nc} NC` : ''].filter(Boolean).join(' · ')}</div></span><strong>${rs(p.paise)}</strong></div>`).join('')}` : ''}
          ${(d.cancelReturns ?? []).length ? `<h3>Check these at the stock count</h3>${d.cancelReturns.map((x) => `<div class="row"><span>${esc(x.name)}</span><strong>${esc(`${x.qty} ${x.unit} · ${x.store}`)}</strong></div>`).join('')}` : ''}
        </section>
        <section><h2>Money in</h2>
          ${modes.length ? modes.map((m) => `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between"><span>${esc(modeName[m.mode] ?? m.mode)} <span class="q">(${m.n})</span></span><strong>${rs(m.paise)}</strong></div><div class="track"><i style="width:${Math.max(2, Math.round((m.paise / maxMode) * 100))}%"></i></div></div>`).join('') : '<p class="q">No payments this shift.</p>'}
          ${d.sales.ncBills ? `<div class="row"><span class="q">NC and complimentary (not in sales)</span><span>${plural(d.sales.ncBills, 'bill')} · ${rs(d.sales.ncMenuPaise)}</span></div>` : ''}
        </section>
        <section><h2>Exceptions</h2><div class="grid">
          ${exT(ev('void').n, 'Void bills', ev('void').paise)}${exT(ev('discount').n + df('discount').n, 'Discounts', ev('discount').paise + df('discount').paise)}${exT(ev('kot_cancel').n, 'Cancelled after KOT', ev('kot_cancel').paise)}
          ${exT(ev('comp').n, 'Complimentary', ev('comp').paise)}${exT(ev('reprint').n, 'Reprints')}${exT(ev('credit_note').n, 'Credit notes', ev('credit_note').paise)}
          ${exT(ev('pay_change').n, 'Payment type changed', ev('pay_change').paise)}${exT(df('tip').n, 'Tips', df('tip').paise)}${exT(ev('stock_waste').n, 'Breakage', ev('stock_waste').paise)}
        </div></section>
        ${(d.drawers ?? []).length ? `<section><h2>Cash drawers</h2>${d.drawers.map((x) => `<div class="row"><span><strong>${esc(x.holder)}${x.acceptedBy ? ` → ${esc(x.acceptedBy)}` : ''}</strong><div class="q">${esc(time(x.from))} – ${x.to ? esc(time(x.to)) : 'open'} · in ${rs(x.cashInPaise)}${x.reason ? ` · "${esc(x.reason)}"` : ''}</div></span>${x.countedPaise == null ? '<span class="pill mute">Not counted</span>' : x.differencePaise === 0 ? '<span class="pill ok">Agrees</span>' : `<span class="pill bad">${x.differencePaise < 0 ? 'Short' : 'Over'} ${rs(Math.abs(x.differencePaise))}</span>`}</div>`).join('')}</section>` : ''}
        <section><h2>Bill numbers · FY ${esc(d.fy)}</h2>
          ${broken.length ? broken.map((x) => `<div class="row" style="color:var(--bad)"><span>${esc(x.name)}</span><span>${esc(x.missing.join(', '))} missing</span></div>`).join('') : '<div class="q">Every series is unbroken: no number missing.</div>'}
        </section>
        ${d.unpaid.length ? `<section><h2>Sent to kitchen, not paid (when this was made)</h2>${d.unpaid.map((o) => `<div class="row" style="${o.old ? 'color:var(--bad)' : ''}"><span>${esc(o.place)}${o.guestName ? ` · ${esc(o.guestName)}` : ''}</span><span>${rs(o.sentPaise)} · ${hrs(o.hours)}</span></div>`).join('')}</section>` : ''}
        ${events.length ? `<section><h2>Every exception</h2>${events.slice(0, 25).map((e) => `<div class="row"><span><span class="q">${esc(time(e.at))}</span> ${esc(e.ref)}<div class="q">${esc(e.kind.replace(/_/g, ' '))}${e.byName ? ` · ${esc(e.byName)}` : ''}${e.reason ? ` · ${esc(e.reason)}` : ''}</div></span><span>${e.amountPaise == null ? '' : rs(e.amountPaise)}</span></div>`).join('')}${events.length > 25 ? `<div class="q">and ${events.length - 25} more in the POS.</div>` : ''}</section>` : ''}
      </main>
      <footer>Made by Bookr POS · open the Daily check in the POS for details</footer>`;
    document.title = `Daily check ${day}`;
    document.body.dataset.ready = 'yes';
  }
})();
