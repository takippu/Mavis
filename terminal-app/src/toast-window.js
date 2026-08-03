'use strict';

// A self-owned, always-on-top toast window for request-complete / needs-input alerts that fire
// while the user is in ANOTHER app. Native Windows toasts (`new Notification`) are unreliable —
// they need a registered AppUserModelID + a Start-Menu shortcut (the portable .exe has none), and
// Focus Assist can suppress them. This frameless transparent window depends on none of that: it
// shows over other apps via showInactive() (no focus steal) and is fully under our control.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const W = 384, H = 104, MARGIN = 16, SHOW_MS = 6500;

let toastWin = null;
let hideTimer = null;
let lastId = null;
let lastTheme = null; // last theme palette received; reused for toasts fired without one (e.g. attention)
let handlers = { onActivate: null };

function build() {
  toastWin = new BrowserWindow({
    width: W, height: H,
    frame: false, transparent: true, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'toast-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  // float above fullscreen apps too
  try { toastWin.setAlwaysOnTop(true, 'screen-saver'); } catch { /* noop */ }
  toastWin.loadFile(path.join(__dirname, 'renderer', 'toast-window.html'));
  toastWin.on('closed', () => { toastWin = null; });
  return toastWin;
}

function position() {
  if (!toastWin || toastWin.isDestroyed()) return;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    toastWin.setBounds({ x: wa.x + wa.width - W - MARGIN, y: wa.y + MARGIN, width: W, height: H });
  } catch { /* noop */ }
}

function show({ title, body, id, theme } = {}) {
  if (!toastWin || toastWin.isDestroyed()) build();
  lastId = id || null;
  if (theme && typeof theme === 'object') lastTheme = theme;
  position();
  const payload = { title: String(title || 'Mavis'), body: String(body || ''), theme: lastTheme };
  const send = () => { try { if (toastWin && !toastWin.isDestroyed()) toastWin.webContents.send('toast:data', payload); } catch { /* noop */ } };
  if (toastWin.webContents.isLoading()) toastWin.webContents.once('did-finish-load', send);
  else send();
  try { toastWin.showInactive(); } catch { /* noop */ } // appear without stealing focus from his current app
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, SHOW_MS);
}

function hide() {
  clearTimeout(hideTimer); hideTimer = null;
  if (toastWin && !toastWin.isDestroyed()) { try { toastWin.hide(); } catch { /* noop */ } }
}

function destroy() {
  clearTimeout(hideTimer); hideTimer = null;
  if (toastWin && !toastWin.isDestroyed()) { try { toastWin.destroy(); } catch { /* noop */ } }
  toastWin = null;
}

ipcMain.on('toast:click', () => { const id = lastId; hide(); if (handlers.onActivate) { try { handlers.onActivate(id); } catch { /* noop */ } } });
ipcMain.on('toast:dismiss', () => hide());

module.exports = { show, hide, destroy, setHandlers(h) { handlers = Object.assign(handlers, h || {}); } };
