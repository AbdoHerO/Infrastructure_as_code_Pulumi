import { app, BrowserWindow, session } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { APP } from '@cloudforge/shared';
import { createMainWindow } from './window.js';
import { registerIpcHandlers } from './ipc/index.js';
import { initContainer } from './container.js';

/**
 * Apply a strict Content-Security-Policy to every response. In production the
 * renderer is fully self-contained, so only same-origin `self` resources and
 * inline styles (required by the CSS-in-JS layer) are permitted.
 */
function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; " +
            "font-src 'self' data:; " +
            "connect-src 'self' ws:;",
        ],
      },
    });
  });
}

async function bootstrap(): Promise<void> {
  electronApp.setAppUserModelId(APP.id);

  // Harden: refuse creation of additional web contents from untrusted sources.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  applyContentSecurityPolicy();

  // Initialise persistence and services before any IPC handler can be invoked.
  await initContainer();
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
