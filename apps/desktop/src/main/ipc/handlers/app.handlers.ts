import { app } from 'electron';
import { APP } from '@cloudforge/shared';
import type { AppInfo } from '@shared/ipc/contract.js';
import { registerHandler } from '../registry.js';

/** Register application/runtime information handlers. */
export function registerAppHandlers(): void {
  registerHandler('app:getInfo', (): AppInfo => {
    return {
      name: APP.name,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      locale: app.getLocale(),
      versions: {
        electron: process.versions.electron ?? 'unknown',
        node: process.versions.node,
        chrome: process.versions.chrome ?? 'unknown',
      },
    };
  });

  registerHandler('app:ping', (payload: string): string => `pong: ${payload}`);
}
