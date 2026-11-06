/**
 * What the Settings page and the main process share about the MCP server.
 *
 * Permissions are device settings, separate from a project's settings and from
 * `settings:update`: nothing an MCP client can call is able to change them.
 */

/** How dangerous a tool is, which decides whether it runs at all. */
export type McpTier = 'read' | 'write' | 'critical' | 'secret' | 'shell' | 'local';

/** `ask` opens an approval dialog in CloudForge for every call. */
export type McpCriticalMode = 'ask' | 'allow' | 'off';

export interface McpSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly tiers: {
    readonly read: boolean;
    readonly write: boolean;
    readonly critical: McpCriticalMode;
    readonly secret: boolean;
    readonly shell: boolean;
    readonly local: boolean;
  };
  /** Toolsets switched off; their tools disappear from the client's list. */
  readonly disabledToolsets: readonly string[];
  /** Opening or switching a project sends its passkey through the AI. */
  readonly allowProjectSwitch: boolean;
  readonly approvalTimeoutSeconds: number;
}

export interface McpSettingsPatch {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly tiers?: Partial<McpSettings['tiers']>;
  readonly disabledToolsets?: readonly string[];
  readonly allowProjectSwitch?: boolean;
  readonly approvalTimeoutSeconds?: number;
}

export const DEFAULT_MCP_PORT = 47821;

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  port: DEFAULT_MCP_PORT,
  tiers: {
    read: true,
    write: true,
    critical: 'ask',
    secret: false,
    shell: false,
    local: true,
  },
  disabledToolsets: [],
  allowProjectSwitch: false,
  approvalTimeoutSeconds: 120,
};

export interface McpClientInfo {
  readonly sessionId: string;
  readonly name: string;
  readonly version: string;
  readonly connectedAt: string;
}

export interface McpToolsetInfo {
  readonly id: string;
  readonly label: string;
  readonly tools: number;
}

export interface McpStatus {
  readonly settings: McpSettings;
  readonly running: boolean;
  readonly url: string | null;
  readonly error: string | null;
  readonly clients: readonly McpClientInfo[];
  readonly toolsets: readonly McpToolsetInfo[];
  readonly toolCount: number;
}

/** Ready-to-paste connection settings for common MCP clients. */
export interface McpClientConfig {
  readonly url: string;
  readonly claudeCodeCommand: string;
  readonly claudeDesktopJson: string;
  readonly bridgePath: string;
}

/** A critical tool call waiting for a person to decide. */
export interface McpApprovalRequest {
  readonly id: string;
  readonly client: string;
  readonly tool: string;
  readonly title: string;
  /** What the call would do, in words, with secret values masked. */
  readonly summary: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}
