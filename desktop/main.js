// Bookr POS for Windows (22 Nov 2026): the POS website in its own full-screen window, starting with Windows, printing each
// slip straight to its own printer with no print window: bills to the bill printer, each station's KOTs to that station's
// printer, chosen per PC under Printers (Ctrl+Shift+P). No password or key is kept here: sign-in works as in a browser.
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { printSlip, printPage } = require('./print');

const POS_URL = process.env.BOOKR_POS_URL || 'https://pos.thebajajgroup.co/';
const POS_ORIGIN = new URL(POS_URL).origin;
const ICON = path.join(__dirname, 'icon.png');

let main = null;
let printersWin = null;

// ---------- the printer choices, saved on this PC only

const DEFAULTS = { bill: '', report: '', stations: {}, otherKot: '', paperMm: 80, startWithWindows: true, seenStations: ['Kitchen', 'Bar'] };
const settingsFile = () => path.join(app.getPath('userData'), 'printers.json');
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  const clean = {
    bill: str(s.bill), report: str(s.report), otherKot: str(s.otherKot), paperMm: s.paperMm === 58 ? 58 : 80, startWithWindows: s.startWithWindows !== false,
    stations: Object.fromEntries(Object.entries(s.stations ?? {}).filter(([k]) => str(k)).map(([k, v]) => [str(k), str(v)])),
    // One of each station whatever its capitals: the first spelling seen stays.
    seenStations: (s.seenStations ?? []).map(str).filter(Boolean).filter((x, i, all) => all.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 30),
  };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(clean, null, 2));
  app.setLoginItemSettings({ openAtLogin: clean.startWithWindows });
  return clean;
}
const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');

// ---------- printing, asked for by the POS page

const fromPos = (event) => { try { return new URL(event.senderFrame.url).origin === POS_ORIGIN; } catch { return false; } };

ipcMain.handle('print', async (event, job) => {
  if (!fromPos(event)) return { ok: false, error: 'Not from the POS.' };
  // An A4 page (28 Nov 2026): the stock count sheet, to the "Reports (A4)" printer, portrait.
  if (job?.kind === 'report') {
    const doc = typeof job.html === 'string' ? job.html : '';
    if (!doc || doc.length > 2_000_000) return { ok: false, error: 'Nothing to print.' };
    const s = loadSettings();
    if (!s.report) return { ok: false, error: 'No A4 printer is chosen for reports on this PC.' };
    const installed = await main.webContents.getPrintersAsync();
    if (!installed.some((p) => p.name === s.report)) return { ok: false, error: `The A4 printer "${s.report}" is not found on this PC.` };
    try { await printPage(doc, s.report); return { ok: true, printer: s.report }; }
    catch (e) { return { ok: false, error: `${s.report}: ${e.message}` }; }
    finally { refocus(); }
  }
  const kind = job?.kind === 'kot' ? 'kot' : 'bill';
  const station = str(job?.station);
  const html = typeof job?.html === 'string' ? job.html : '';
  if (!html || html.length > 300_000) return { ok: false, error: 'Nothing to print.' };
  const copies = Number.isInteger(job?.copies) && job.copies >= 1 && job.copies <= 5 ? job.copies : 1;
  const s = loadSettings();
  // Station names match whatever their capitals (28 Nov 2026): the POS sends "bar", the Printers window showed "Bar", and
  // a printer chosen for "Bar" was never found for "bar" KOTs.
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (kind === 'kot' && station && !s.seenStations.some((x) => same(x, station))) saveSettings({ ...s, seenStations: [...s.seenStations, station] });
  const stationPrinter = Object.entries(s.stations).find(([k, v]) => v && same(k, station))?.[1];
  const printer = kind === 'kot' ? stationPrinter || s.otherKot : s.bill;
  const what = kind === 'kot' ? `${station || 'KOT'} KOTs` : 'bills';
  if (!printer) return { ok: false, error: `No printer is chosen for ${what} on this PC.` };
  const installed = await main.webContents.getPrintersAsync();
  if (!installed.some((p) => p.name === printer)) return { ok: false, error: `The printer "${printer}" for ${what} is not found on this PC.` };
  try {
    await printSlip(html, printer, { paperMm: s.paperMm, copies });
    return { ok: true, printer };
  } catch (e) {
    return { ok: false, error: `${printer}: ${e.message}` };
  } finally {
    refocus();
  }
});
// The keyboard back to the POS page (26 Nov 2026): on Windows, after a print window or an OK/Cancel box, text boxes stopped
// taking typing until the app lost and regained focus. Doing that here brings typing back.
function refocus() {
  if (!main || main.isDestroyed() || main.isMinimized()) return;
  if (main.isFocused()) { main.blur(); main.focus(); }
  main.webContents.focus();
}
ipcMain.handle('window:refocus', (event) => { if (fromPos(event)) refocus(); });
ipcMain.handle('printers:open', (event) => { if (fromPos(event)) openPrinters(); });
ipcMain.handle('window:minimize', (event) => { if (fromPos(event)) main?.minimize(); });
ipcMain.handle('window:fullscreen', (event) => { if (fromPos(event) && main) main.setFullScreen(!main.isFullScreen()); });

// ---------- the Printers settings window

const fromPrinters = (event) => printersWin && event.sender === printersWin.webContents;
ipcMain.handle('settings:load', async (event) => {
  if (!fromPrinters(event)) return null;
  const printers = (await printersWin.webContents.getPrintersAsync()).map((p) => ({ name: p.name, isDefault: !!p.isDefault }));
  return { settings: loadSettings(), printers, version: app.getVersion() };
});
ipcMain.handle('settings:save', (event, s) => {
  if (!fromPrinters(event)) return null;
  try { return { ok: true, settings: saveSettings(s) }; } catch (e) { return { ok: false, error: `Could not save on this PC: ${e.message}. If an antivirus is blocking Bookr POS, add it to its trusted list.` }; }
});
ipcMain.handle('settings:close', (event) => { if (fromPrinters(event)) printersWin?.close(); });
ipcMain.handle('settings:test', async (event, printer, label) => {
  if (!fromPrinters(event)) return { ok: false };
  const p = str(printer);
  if (!p) return { ok: false, error: 'Choose a printer first.' };
  if (str(label) === 'Reports (A4)') {
    const when = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14pt "Segoe UI",sans-serif;margin:0}h1{font-size:20pt}</style></head>
      <body><h1>Bookr POS · A4 test page</h1><p>Printer: ${escape(p)}</p><p>When: ${escape(when)}</p><p>If this page printed upright on A4, the stock count sheet will too.</p></body></html>`;
    try { await printPage(doc, p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  }
  const when = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const body = `<div class="receipt"><div class="hd">TEST PRINT</div><div class="c">${escape(str(label))}</div><hr>
    <div class="rl"><span>Printer</span><span>${escape(p)}</span></div><div class="rl"><span>When</span><span>${escape(when)}</span></div><hr>
    <div class="rl"><span>|1234567890</span><span>1234567890|</span></div>
    <div class="c">If both | marks print, nothing is cut off.</div></div>`;
  try { await printSlip(body, p, { paperMm: loadSettings().paperMm }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
const escape = (t) => t.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function openPrinters() {
  if (printersWin) { printersWin.focus(); return; }
  printersWin = new BrowserWindow({
    width: 720, height: 760, parent: main ?? undefined, title: 'Bookr POS · Printers', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  printersWin.loadFile(path.join(__dirname, 'printers.html'));
  printersWin.on('closed', () => { printersWin = null; });
}

// ---------- the main window: the POS, full screen, only the POS's own address inside it

function createMain() {
  main = new BrowserWindow({
    width: 1366, height: 768, show: false, icon: ICON, title: 'Bookr POS', autoHideMenuBar: true, backgroundColor: '#f2efea',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: [`--bookr-version=${app.getVersion()}`],
    },
  });
  main.once('ready-to-show', () => { main.show(); main.setFullScreen(true); });
  main.on('focus', () => main?.webContents.focus());
  // The page's OK/Cancel and message boxes leave Windows text boxes deaf to typing: after each one, give the keyboard back.
  main.webContents.on('did-finish-load', () => {
    main?.webContents.executeJavaScript(`(() => { if (window.__bookrBoxes || !window.bookrDesktop?.refocus) return; window.__bookrBoxes = true;
      for (const k of ['alert', 'confirm', 'prompt']) { const f = window[k].bind(window); window[k] = (...a) => { try { return f(...a); } finally { setTimeout(() => window.bookrDesktop.refocus(), 0); } }; } })()`).catch(() => {});
  });
  main.loadURL(POS_URL);
  // Links to anywhere else open in the normal browser, never inside the POS window.
  main.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  main.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== POS_ORIGIN) { e.preventDefault(); openOutside(url); } });
  // No internet: a page that says so and tries again.
  main.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3) main.loadFile(path.join(__dirname, 'offline.html'), { query: { to: url || POS_URL } });
  });
  main.on('closed', () => { main = null; });
}
const openOutside = (url) => { try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch { /* not a link */ } };

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Bookr POS',
    submenu: [
      { label: 'Printers…', accelerator: 'Ctrl+Shift+P', click: openPrinters },
      { label: 'Full screen on or off', accelerator: 'F11', click: () => main?.setFullScreen(!main.isFullScreen()) },
      { label: 'Reload', accelerator: 'Ctrl+R', click: () => main?.loadURL(POS_URL) },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() },
    ],
  }]));
}

// ---------- start: one window only, starts with Windows, updates itself

// Windows groups a window with its pinned taskbar shortcut only when both carry the same app id: the installer's
// shortcut has the appId of package.json, so the window takes it too (25 Nov 2026: a second taskbar icon appeared).
if (process.platform === 'win32') app.setAppUserModelId('co.thebajajgroup.bookrpos');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (main) { if (main.isMinimized()) main.restore(); main.focus(); } });
  app.whenReady().then(() => {
    // The POS page may copy to the clipboard (orders for suppliers, the day summary); nothing else is allowed.
    session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) =>
      done(permission === 'clipboard-sanitized-write' && new URL(details.requestingUrl || wc.getURL()).origin === POS_ORIGIN));
    const s = loadSettings();
    app.setLoginItemSettings({ openAtLogin: s.startWithWindows });
    buildMenu();
    createMain();
    if (!s.bill && !Object.keys(s.stations).length) setTimeout(openPrinters, 2500);   // first run: choose the printers
    if (app.isPackaged) startUpdates();
  });
  app.on('window-all-closed', () => app.quit());
}

function startUpdates() {
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(main, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 1, title: 'Bookr POS',
      message: `Version ${info.version} is ready. Restart now, or it installs when Bookr POS is next closed.` })
      .then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', () => { /* no internet or no update: try again later */ });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}
