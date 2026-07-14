import { app } from 'electron';
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';
import { emitEvent } from '../ipc/emit.js';
import { log } from '../logging/logger.js';
import type { UpdateState } from '@shared/ipc/contract.js';

const { autoUpdater } = electronUpdater;
let state: UpdateState = { status: 'idle', current: '0.0.0', latest: null };
let initialized = false;

export function initUpdateManager(): void {
  if (initialized) return;
  initialized = true;
  state = { status: 'idle', current: app.getVersion(), latest: null };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = log();
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    setState({ status: 'available', latest: info.version }),
  );
  autoUpdater.on('update-not-available', (info: UpdateInfo) =>
    setState({ status: 'not-available', latest: info.version }),
  );
  autoUpdater.on('download-progress', (progress: ProgressInfo) =>
    setState({ status: 'downloading', progress: Math.round(progress.percent * 10) / 10 }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    setState({ status: 'downloaded', latest: info.version, progress: 100 }),
  );
  autoUpdater.on('error', (error) => {
    log().error({ err: error, event: 'updates.error' }, 'Application update failed');
    setState({ status: 'error', message: updateErrorMessage(error) });
  });
}

/** Apply persisted updater preferences without starting a network request. */
export function configureUpdateManager(autoDownload: boolean): void {
  initUpdateManager();
  autoUpdater.autoDownload = autoDownload;
}

export async function checkForUpdates(): Promise<UpdateState> {
  initUpdateManager();
  if (!app.isPackaged) {
    setState({
      status: 'not-available',
      latest: app.getVersion(),
      message: 'Update checks are available in signed packaged builds.',
    });
    return state;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // electron-updater also emits the error event above. Return the resulting
    // state so IPC does not expose internal HTTP headers and stack traces.
    if (state.status !== 'error') {
      const normalized = error instanceof Error ? error : new Error(String(error));
      log().error({ err: normalized, event: 'updates.check.error' }, 'Update check failed');
      setState({ status: 'error', message: updateErrorMessage(normalized) });
    }
  }
  return state;
}

export async function downloadUpdate(): Promise<UpdateState> {
  initUpdateManager();
  if (state.status !== 'available') throw new Error('No update is available to download');
  await autoUpdater.downloadUpdate();
  return state;
}

export function installUpdate(): void {
  if (state.status !== 'downloaded') throw new Error('No downloaded update is ready to install');
  autoUpdater.quitAndInstall(false, true);
}

export function currentUpdateState(): UpdateState {
  return state;
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, current: app.getVersion() };
  emitEvent('updates:state', state);
}

export function updateErrorMessage(error: Error): string {
  if (/latest\.yml|404|Cannot find latest/i.test(error.message)) {
    return 'This GitHub release is missing Windows update metadata. Install the newest CloudForge release manually, then try again.';
  }
  return 'CloudForge could not check GitHub Releases. Check your internet connection and try again.';
}
