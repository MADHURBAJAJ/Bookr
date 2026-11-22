// The Printers window: one row each for bills, every station seen (Kitchen, Bar, …) and "any other station".
let data = null;

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, attrs); for (const k of kids) e.append(k); return e; };

function printerSelect(value) {
  const s = el('select');
  s.append(el('option', { value: '', textContent: '— Not chosen —' }));
  for (const p of data.printers) s.append(el('option', { value: p.name, textContent: p.name + (p.isDefault ? ' (Windows default)' : ''), selected: p.name === value }));
  if (value && !data.printers.some((p) => p.name === value)) s.append(el('option', { value, textContent: `${value} (not found on this PC)`, selected: true }));
  return s;
}

function row(title, note, value, onChange, testLabel) {
  const sel = printerSelect(value);
  sel.addEventListener('change', () => onChange(sel.value));
  const msg = el('div', { className: 'msg' });
  const test = el('button', { type: 'button', textContent: 'Test print' });
  test.addEventListener('click', async () => {
    msg.className = 'msg'; msg.textContent = 'Printing…';
    const r = await window.bookrSettings.test(sel.value, testLabel);
    msg.className = `msg ${r.ok ? 'ok' : 'bad'}`; msg.textContent = r.ok ? 'Sent. Check the slip.' : r.error || 'Could not print.';
  });
  const left = el('div', {}, el('b', { textContent: title }), el('small', { textContent: note }));
  const mid = el('div', {}, sel, msg);
  return el('div', { className: 'row' }, left, mid, test);
}

function paint() {
  const s = data.settings;
  $('bill').replaceChildren(row('Bills', 'Bills, credit notes, statements', s.bill, (v) => { s.bill = v; }, 'Bills'));
  const names = [...new Set([...s.seenStations, ...Object.keys(s.stations)])];
  $('stations').replaceChildren(
    ...names.map((n) => row(n, `KOTs for ${n}`, s.stations[n] ?? '', (v) => { s.stations[n] = v; }, `${n} KOTs`)),
    row('Any other station', 'A station not listed above', s.otherKot, (v) => { s.otherKot = v; }, 'Other KOTs'));
  for (const r of document.querySelectorAll('input[name=paper]')) r.checked = Number(r.value) === s.paperMm;
  $('startWin').checked = s.startWithWindows;
  $('ver').textContent = `Bookr POS ${data.version}`;
}

$('addStation').addEventListener('click', () => {
  const n = $('newStation').value.trim();
  if (!n) return;
  if (!data.settings.seenStations.includes(n)) data.settings.seenStations.push(n);
  $('newStation').value = ''; paint();
});
$('save').addEventListener('click', async () => {
  const s = data.settings;
  s.paperMm = Number(document.querySelector('input[name=paper]:checked')?.value ?? 80);
  s.startWithWindows = $('startWin').checked;
  data.settings = await window.bookrSettings.save(s);
  $('msg').className = 'msg ok'; $('msg').textContent = 'Saved. Bills and KOTs now print on these printers.';
  paint();
});

window.bookrSettings.load().then((d) => { data = d; paint(); });
