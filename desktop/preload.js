// What the POS page may ask of the Windows app: print a slip on its printer, open the Printers settings, the version.
// Nothing else of Windows is reachable from the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bookrDesktop', {
  version: (process.argv.find((a) => a.startsWith('--bookr-version=')) || '').split('=')[1] || '',
  /** job: { kind: 'bill' | 'kot', station?: string, html: string, copies?: number } → { ok, error?, printer? } */
  print: (job) => ipcRenderer.invoke('print', job),
  openPrinters: () => ipcRenderer.invoke('printers:open'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  /** Gives the keyboard back to the page (Windows lost it after print windows and OK/Cancel boxes, 26 Nov 2026). */
  refocus: () => ipcRenderer.invoke('window:refocus'),
  toggleFullScreen: () => ipcRenderer.invoke('window:fullscreen'),
});
