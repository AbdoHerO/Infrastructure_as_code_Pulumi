import {
  checkForUpdates,
  currentUpdateState,
  downloadUpdate,
  installUpdate,
} from '../../updates/update-manager.js';
import { registerHandler } from '../registry.js';

export function registerUpdateHandlers(): void {
  registerHandler('updates:state', () => currentUpdateState());
  registerHandler('updates:check', () => checkForUpdates());
  registerHandler('updates:download', () => downloadUpdate());
  registerHandler('updates:install', () => installUpdate());
}
