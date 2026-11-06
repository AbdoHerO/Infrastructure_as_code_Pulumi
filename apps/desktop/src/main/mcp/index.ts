import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type {
  McpApprovalRequest,
  McpClientConfig,
  McpSettings,
  McpSettingsPatch,
  McpStatus,
} from '@shared/mcp/types.js';
import { DEFAULT_MCP_SETTINGS } from '@shared/mcp/types.js';
import { DOCUMENTATION } from '@shared/docs/documentation-catalog.js';
import { unwrap, ValidationError } from '@cloudforge/shared';
import { getContainer } from '../container.js';
import { emitEvent } from '../ipc/emit.js';
import { onMainEvent } from '../ipc/event-bus.js';
import { dispatch } from '../ipc/registry.js';
import { log } from '../logging/logger.js';
import { McpApprovals } from './approvals.js';
import { MCP_TOOLS, mcpToolsets } from './catalog/index.js';
import { McpHost } from './host.js';
import {
  applyMcpSettingsPatch,
  createMcpToken,
  mcpTokenMatches,
  normalizeMcpSettings,
} from './settings.js';

const SETTINGS_KEY = 'mcp.settings';
const TOKEN_KEY = 'mcp.token';

let settings: McpSettings = DEFAULT_MCP_SETTINGS;
let token: string | null = null;
let lastError: string | null = null;
let host: McpHost | null = null;

const approvals = new McpApprovals({
  timeoutSeconds: () => settings.approvalTimeoutSeconds,
  onChanged: (pending) => {
    emitEvent('mcp:approvalsChanged', { pending });
    if (pending.length > 0) bringWindowForward();
  },
});

/** A decision is waiting, so the window has to be where the person can see it. */
function bringWindowForward(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.flashFrame(true);
}

function createHost(): McpHost {
  return new McpHost({
    call: (channel, payload) => dispatch(channel, payload, 'mcp'),
    activeProjectId: () => getContainer().projectContext.current()?.projectId ?? null,
    settings: () => settings,
    verifyToken: (candidate) => token !== null && mcpTokenMatches(token, candidate),
    approvals,
    subscribe: onMainEvent,
    emit: (channel, payload) => emitEvent(channel, payload),
    audit: ({ client, tool, outcome }) => {
      const container = getContainer();
      if (!container.projectContext.current()) return;
      container.activityService.recordSafe({
        type: 'mcp.tool.called',
        message: `${client} ran ${tool}${outcome === 'failed' ? ' (failed)' : ''}`,
        metadata: { client, tool, outcome },
      });
    },
    documentation: () => DOCUMENTATION,
    onClientsChanged: () => emitEvent('mcp:statusChanged', mcpStatus()),
    log: log(),
  });
}

async function loadToken(): Promise<string> {
  const container = getContainer();
  const stored = unwrap(await container.deviceSettings.get(TOKEN_KEY));
  if (stored) {
    const decrypted = container.secretCipher.decrypt(stored);
    if (decrypted.ok) return decrypted.value;
    log().warn({ event: 'mcp.token.unreadable' }, 'Replacing an unreadable MCP token');
  }
  return saveNewToken();
}

async function saveNewToken(): Promise<string> {
  const container = getContainer();
  const created = createMcpToken();
  const encrypted = unwrap(container.secretCipher.encrypt(created));
  unwrap(await container.deviceSettings.set(TOKEN_KEY, encrypted));
  token = created;
  return created;
}

async function ensureRunning(): Promise<void> {
  lastError = null;
  host ??= createHost();
  if (!settings.enabled) {
    approvals.refuseAll();
    await host.stop();
    return;
  }
  token ??= await loadToken();
  try {
    await host.start(settings.port);
  } catch (error) {
    lastError =
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${String(settings.port)} is already in use. Choose another one.`
        : `The MCP server could not start: ${error instanceof Error ? error.message : String(error)}`;
    log().error({ event: 'mcp.start.failed', err: error }, 'MCP server could not start');
  }
}

/** Load the device's MCP settings and start the server if the user turned it on. */
export async function initMcp(): Promise<void> {
  const stored = unwrap(await getContainer().deviceSettings.get(SETTINGS_KEY));
  settings = normalizeMcpSettings(stored ? (JSON.parse(stored) as unknown) : {});
  await ensureRunning();
}

export async function shutdownMcp(): Promise<void> {
  approvals.refuseAll();
  await host?.stop();
}

export function mcpStatus(): McpStatus {
  return {
    settings,
    running: host?.running ?? false,
    url: host?.url ?? null,
    error: lastError,
    clients: host?.clients() ?? [],
    toolsets: mcpToolsets(),
    toolCount: MCP_TOOLS.length,
  };
}

function publishStatus(): McpStatus {
  const status = mcpStatus();
  emitEvent('mcp:statusChanged', status);
  return status;
}

export async function updateMcpSettings(patch: McpSettingsPatch): Promise<McpStatus> {
  const previous = settings;
  const next = applyMcpSettingsPatch(previous, patch);
  if (patch.port !== undefined && next.port !== patch.port) {
    throw new ValidationError('The port must be a whole number from 1024 to 65535');
  }
  unwrap(await getContainer().deviceSettings.set(SETTINGS_KEY, JSON.stringify(next)));
  settings = next;
  if (previous.enabled !== next.enabled || previous.port !== next.port) await ensureRunning();
  host?.notifyToolsChanged();
  return publishStatus();
}

/** Replace the token. Connected clients are dropped and must use the new one. */
export async function regenerateMcpToken(): Promise<McpStatus> {
  await saveNewToken();
  if (settings.enabled) await ensureRunning();
  return publishStatus();
}

export async function revealMcpToken(): Promise<string> {
  token ??= await loadToken();
  return token;
}

function bridgePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp', 'cloudforge-mcp.cjs')
    : join(app.getAppPath(), 'resources', 'mcp', 'cloudforge-mcp.cjs');
}

export async function mcpClientConfig(): Promise<McpClientConfig> {
  const secret = await revealMcpToken();
  const url = `http://127.0.0.1:${String(settings.port)}/mcp`;
  const bridge = bridgePath();
  return {
    url,
    bridgePath: bridge,
    claudeCodeCommand: `claude mcp add --transport http cloudforge ${url} --header "Authorization: Bearer ${secret}"`,
    claudeDesktopJson: JSON.stringify(
      {
        mcpServers: {
          cloudforge: {
            command: process.execPath,
            args: [bridge],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              CLOUDFORGE_MCP_URL: url,
              CLOUDFORGE_MCP_TOKEN: secret,
            },
          },
        },
      },
      null,
      2,
    ),
  };
}

export function pendingMcpApprovals(): McpApprovalRequest[] {
  return approvals.pending();
}

export function resolveMcpApproval(id: string, approved: boolean): void {
  approvals.resolve(id, approved);
}
