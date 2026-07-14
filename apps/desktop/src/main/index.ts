import { app, BrowserWindow, session } from 'electron';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { APP } from '@cloudforge/shared';
import { createMainWindow } from './window.js';
import { registerIpcHandlers } from './ipc/index.js';
import { initContainer } from './container.js';
import { initLogger, log } from './logging/logger.js';
import { checkForUpdates, configureUpdateManager } from './updates/update-manager.js';

/**
 * Apply a Content-Security-Policy to every response.
 *
 * In production the renderer is fully self-contained, so a strict policy allows
 * only same-origin resources (plus inline styles for the CSS layer). In
 * development the policy is relaxed to permit Vite's HMR / React-refresh inline
 * and eval'd scripts and the dev-server websocket — otherwise React never mounts
 * and the window renders black.
 */
function applyContentSecurityPolicy(): void {
  const policy = is.dev
    ? "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' ws: wss: http://localhost:*;"
    : "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' ws:;";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

/**
 * Deny every renderer permission request (camera, microphone, geolocation, …).
 * CloudForge's renderer needs none of them, so the safest default is to refuse.
 */
function hardenPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
}

async function bootstrap(): Promise<void> {
  initLogger();
  log().info(
    { event: 'app.start', version: app.getVersion(), platform: process.platform },
    'Starting CloudForge',
  );
  electronApp.setAppUserModelId(APP.id);

  // Harden: refuse creation of additional web contents from untrusted sources.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  applyContentSecurityPolicy();
  hardenPermissions();

  // Initialise persistence and services before any IPC handler can be invoked.
  try {
    const container = await initContainer();
    const settings = await container.settingsService.get();
    if (settings.ok) {
      configureUpdateManager(settings.value.updates.autoDownload);
      if (settings.value.updates.checkOnStartup && app.isPackaged) {
        void checkForUpdates().catch((error: unknown) =>
          log().warn(
            { err: error, event: 'updates.startup-check-failed' },
            'Startup update check failed',
          ),
        );
      }
    }
  } catch (err) {
    log().fatal({ err, event: 'app.init-failed' }, 'Failed to initialise application');
    throw err;
  }
  registerIpcHandlers();
  createMainWindow();
  log().info({ event: 'app.ready' }, 'CloudForge ready');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  log().info({ event: 'app.window-all-closed' }, 'All windows closed');
  if (process.platform !== 'darwin') app.quit();
});
