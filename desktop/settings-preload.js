// The Printers settings window's own bridge: the printers on this PC, the saved choices, and a test print.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bookrSettings', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (s) => ipcRenderer.invoke('settings:save', s),
  test: (printer, label) => ipcRenderer.invoke('settings:test', printer, label),
  close: () => ipcRenderer.invoke('settings:close'),
});
