// Forge desktop app: runs the Forge server inside Electron and shows it in a native window.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Tests run with their own profile so they never touch the real app's window size or local storage.
if (process.env.FORGE_PROFILE) app.setPath('userData', process.env.FORGE_PROFILE);

// One Forge at a time: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
const loadBounds = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return { width: 1440, height: 900 }; } };

async function start() {
  // Per-user data folder (threads, briefs, worktrees), e.g. %APPDATA%\Forge\data
  process.env.FORGE_DATA ??= path.join(app.getPath('userData'), 'data'); // tests can point this elsewhere

  // Hidden game preview: lets Claude check a game even when its Play tab is not open in the window.
  // The server calls this; the page's probe then connects back like the visible preview does.
  const hidden = new Map(); // url -> { win, timer }
  globalThis.forgeEnsurePreview = (gameUrl, { fresh = false } = {}) => {
    let h = hidden.get(gameUrl);
    if (fresh && h && !h.win.isDestroyed()) h.win.webContents.reload();
    if (!h || h.win.isDestroyed()) {
      // Offscreen rendering keeps drawing frames even though the window is never shown.
      const w = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true } });
      w.webContents.setFrameRate(30);
      w.loadURL(gameUrl);
      h = { win: w, timer: null };
      hidden.set(gameUrl, h);
    }
    clearTimeout(h.timer); // close it after 10 idle minutes
    h.timer = setTimeout(() => { if (!h.win.isDestroyed()) h.win.destroy(); hidden.delete(gameUrl); }, 10 * 60_000);
  };
  let url;
  try {
    ({ url } = await (await import('../server/index.mjs')).ready);
  } catch (e) {
    dialog.showErrorBox('Forge could not start', e.code === 'EADDRINUSE'
      ? 'Port 4317 or 4318 is already in use. Is Forge (or `npm start`) already running?'
      : String(e?.stack ?? e));
    app.quit();
    return;
  }

  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds, minWidth: 900, minHeight: 600, title: 'Forge', backgroundColor: '#000000',
    autoHideMenuBar: true, show: false,
    // Frameless look: the page draws its own top bar; Windows keeps its min/max/close buttons on top.
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#000000', symbolColor: '#a3a3a3', height: 44 },
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => app.quit()); // hidden preview windows must not keep the app alive
  win.on('close', () => fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })));

  // Links that leave Forge (e.g. "Open in tab" for the game) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => { shell.openExternal(target); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, target) => { if (!target.startsWith(url)) { e.preventDefault(); shell.openExternal(target); } });

  win.loadURL(url);

  // Debug aid: FORGE_SNAPSHOT=<file.png> saves a screenshot of the window after load.
  if (process.env.FORGE_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      fs.writeFileSync(process.env.FORGE_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
    }, 2500));
  }
}

ipcMain.handle('forge:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a game project folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('forge:openPath', (_e, p) => (typeof p === 'string' && fs.existsSync(p) ? shell.openPath(p) : 'not found'));

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
