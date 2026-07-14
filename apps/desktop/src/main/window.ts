import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';
import { is } from '@electron-toolkit/utils';

/**
 * Create the main application window with a hardened security posture:
 * context isolation on, Node integration off, remote module disabled and
 * external links delegated to the OS browser.
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0a0b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.on('ready-to-show', () => window.show());

  // Open target=_blank / external navigations in the user's default browser,
  // never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block in-app navigation away from the renderer origin.
  window.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl && url.startsWith(rendererUrl)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (is.dev && rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}
