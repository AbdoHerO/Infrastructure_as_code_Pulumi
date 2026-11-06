import type { IpcChannel } from '../../shared/ipc/contract.js';

/** Channels that work with no project open; everything else needs an unlocked one. */
const WITHOUT_PROJECT_SESSION: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  'app:getInfo',
  'app:ping',
  'app:openExternal',
  'app:copyDiagnostics',
  'app:copyText',
  'logs:report',
  'projects:picker',
  'projects:count',
  'projects:session',
  'projects:unlock',
  'projects:create',
  'backup:importProject',
  'updates:state',
  'updates:check',
  'updates:download',
  'updates:install',
  'settings:newProjectDefaults',
  'credentials:kinds',
  'mcp:status',
  'mcp:updateSettings',
  'mcp:regenerateToken',
  'mcp:revealToken',
  'mcp:clientConfig',
  'mcp:pendingApprovals',
  'mcp:resolveApproval',
]);

export function worksWithoutProjectSession(channel: IpcChannel): boolean {
  return WITHOUT_PROJECT_SESSION.has(channel);
}
