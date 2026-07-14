import type { AppInfo } from '@shared/ipc/contract.js';

/** Stable, secret-free text suitable for issue reports. */
export function formatDiagnostics(info: AppInfo): string {
  return [
    `${info.name} ${info.version}`,
    `Build: ${info.build.number}`,
    `Commit: ${info.build.commit}`,
    `Built: ${info.build.builtAt}`,
    `Mode: ${info.packaged ? 'packaged' : 'development'}`,
    `Electron: ${info.versions.electron}`,
    `Node: ${info.versions.node}`,
    `Chrome: ${info.versions.chrome}`,
    `OS: ${info.os.type} ${info.os.release} (${info.platform})`,
    `Architecture: ${info.arch}`,
    `Locale: ${info.locale}`,
  ].join('\n');
}
