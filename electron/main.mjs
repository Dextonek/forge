// Forge desktop app: runs the Forge server inside Electron and shows it in a native window.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// One Forge at a time: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
const loadBounds = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return { width: 1440, height: 900 }; } };

async function start() {
  // Per-user data folder (threads, briefs, worktrees), e.g. %APPDATA%\Forge\data
  process.env.FORGE_DATA = path.join(app.getPath('userData'), 'data');
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
