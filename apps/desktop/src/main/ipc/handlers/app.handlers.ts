import { app, clipboard } from 'electron';
import { release, type } from 'node:os';
import { APP } from '@cloudforge/shared';
import type { AppInfo } from '@shared/ipc/contract.js';
import { registerHandler } from '../registry.js';
import { BUILD_INFO } from '../../build-info.js';
import { openProductExternalLink } from '../../security/external-links.js';
import { formatDiagnostics } from '../../app-diagnostics.js';

/** Register application/runtime information handlers. */
export function registerAppHandlers(): void {
  registerHandler('app:getInfo', (): AppInfo => appInfo());

  registerHandler('app:ping', (payload: string): string => `pong: ${payload}`);
  registerHandler('app:openExternal', async ({ link }) => openProductExternalLink(link));
  registerHandler('app:copyDiagnostics', () => clipboard.writeText(formatDiagnostics(appInfo())));
}

function appInfo(): AppInfo {
  return {
    name: APP.name,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    packaged: app.isPackaged,
    build: {
      number: BUILD_INFO.buildNumber,
      commit: BUILD_INFO.gitCommit,
      builtAt: BUILD_INFO.builtAt,
    },
    os: { type: type(), release: release() },
    versions: {
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'unknown',
    },
  };
}
