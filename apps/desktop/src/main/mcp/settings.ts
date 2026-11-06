import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_MCP_SETTINGS,
  type McpCriticalMode,
  type McpSettings,
  type McpSettingsPatch,
} from '../../shared/mcp/types.js';

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MIN_APPROVAL_SECONDS = 15;
const MAX_APPROVAL_SECONDS = 600;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function whole(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function criticalMode(value: unknown): McpCriticalMode {
  return value === 'allow' || value === 'off' || value === 'ask'
    ? value
    : DEFAULT_MCP_SETTINGS.tiers.critical;
}

/**
 * Stored settings made safe to use. Anything missing or unreadable falls back to
 * the default, and the defaults are the cautious choice for every permission.
 */
export function normalizeMcpSettings(raw: unknown): McpSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tiers = (source.tiers && typeof source.tiers === 'object' ? source.tiers : {}) as Record<
    string,
    unknown
  >;
  const fallback = DEFAULT_MCP_SETTINGS;
  return {
    enabled: bool(source.enabled, fallback.enabled),
    port: whole(source.port, MIN_PORT, MAX_PORT, fallback.port),
    tiers: {
      read: bool(tiers.read, fallback.tiers.read),
      write: bool(tiers.write, fallback.tiers.write),
      critical: criticalMode(tiers.critical),
      secret: bool(tiers.secret, fallback.tiers.secret),
      shell: bool(tiers.shell, fallback.tiers.shell),
      local: bool(tiers.local, fallback.tiers.local),
    },
    disabledToolsets: Array.isArray(source.disabledToolsets)
      ? source.disabledToolsets.filter((item): item is string => typeof item === 'string')
      : fallback.disabledToolsets,
    allowProjectSwitch: bool(source.allowProjectSwitch, fallback.allowProjectSwitch),
    approvalTimeoutSeconds: whole(
      source.approvalTimeoutSeconds,
      MIN_APPROVAL_SECONDS,
      MAX_APPROVAL_SECONDS,
      fallback.approvalTimeoutSeconds,
    ),
  };
}

export function applyMcpSettingsPatch(current: McpSettings, patch: McpSettingsPatch): McpSettings {
  return normalizeMcpSettings({
    ...current,
    ...patch,
    tiers: { ...current.tiers, ...patch.tiers },
  });
}

/** A new access token: 256 random bits. */
export function createMcpToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Compare tokens in constant time, whatever their lengths. */
export function mcpTokenMatches(expected: string, candidate: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(candidate));
}
