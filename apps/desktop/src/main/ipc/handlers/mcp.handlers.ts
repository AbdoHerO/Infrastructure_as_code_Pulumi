import {
  mcpClientConfig,
  mcpStatus,
  pendingMcpApprovals,
  regenerateMcpToken,
  resolveMcpApproval,
  revealMcpToken,
  updateMcpSettings,
} from '../../mcp/index.js';
import { registerHandler } from '../registry.js';

/**
 * The MCP server's own controls, for the Settings page and the approval dialog.
 * `mcp/coverage.ts` keeps these out of the tool list: a client must never be able
 * to widen its own permissions or approve its own requests.
 */
export function registerMcpHandlers(): void {
  registerHandler('mcp:status', () => mcpStatus());
  registerHandler('mcp:updateSettings', (patch) => updateMcpSettings(patch));
  registerHandler('mcp:regenerateToken', () => regenerateMcpToken());
  registerHandler('mcp:revealToken', async () => ({ token: await revealMcpToken() }));
  registerHandler('mcp:clientConfig', () => mcpClientConfig());
  registerHandler('mcp:pendingApprovals', () => pendingMcpApprovals());
  registerHandler('mcp:resolveApproval', ({ id, approved }) => resolveMcpApproval(id, approved));
}
