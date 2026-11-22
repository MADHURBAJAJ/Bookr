// Silent printing for the Bookr POS Windows app: one slip (a bill or a KOT) rendered in a hidden window at the roll's
// width, then sent straight to a named Windows printer, the page as long as the slip so no paper is wasted.
const { BrowserWindow } = require('electron');

/** The slip's look on the roll: the same as the POS's own receipt, sized for 80 mm (72 mm printed) or 58 mm (48 mm). */
function slipDocument(body, paperMm) {
  const printMm = paperMm === 58 ? 48 : 72;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  .receipt { width: ${printMm}mm; padding: 2mm ${(paperMm - printMm) / 2}mm 4mm; font-family: Consolas, "Courier New", monospace; font-size: 12px;
    display: flex; flex-direction: column; gap: 3px; box-sizing: content-box; }
  .receipt .c { text-align: center; }
  .receipt .hd { font-weight: 700; font-size: 15px; text-align: center; }
  .receipt .rl { display: flex; justify-content: space-between; gap: 8px; }
  .receipt hr { border: 0; border-top: 1px dashed #000; margin: 3px 0; width: 100%; }
</style></head><body>${body}</body></html>`;
}

/** Prints `body` (the POS's slip HTML) on `printer`; resolves when Windows has it, rejects with the reason if not. */
async function printSlip(body, printer, { paperMm = 80, copies = 1 } = {}) {
  const w = new BrowserWindow({
    show: false, width: Math.round((paperMm / 25.4) * 96), height: 200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(slipDocument(body, paperMm))}`);
    // The slip's own height (not the window's), so the page ends where the slip does.
    const px = await w.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
    const heightMicrons = Math.max(40_000, Math.ceil((px * 25_400) / 96) + 8_000);
    await new Promise((resolve, reject) => {
      w.webContents.print({
        silent: true, deviceName: printer, copies, printBackground: false, margins: { marginType: 'none' },
        pageSize: { width: paperMm * 1000, height: heightMicrons },
      }, (ok, why) => (ok ? resolve() : reject(new Error(why || 'The printer did not take it.'))));
    });
  } finally {
    w.destroy();
  }
}

module.exports = { printSlip, slipDocument };
