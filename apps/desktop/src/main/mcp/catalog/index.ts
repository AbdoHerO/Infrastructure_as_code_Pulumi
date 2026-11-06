import type { McpToolsetInfo } from '../../../shared/mcp/types.js';
import type { McpTool } from '../types.js';
import { CLOUD_TOOLS, INFRASTRUCTURE_TOOLS } from './cloud.js';
import { EXTRA_TOOLS, OPERATION_TOOLS } from './extras.js';
import {
  ANSIBLE_TOOLS,
  CONTAINER_TOOLS,
  DEPLOYMENT_TOOLS,
  HOST_TOOLS,
  RUNTIME_TOOLS,
  TERMINAL_TOOLS,
} from './servers.js';
import {
  APP_TOOLS,
  BACKUP_TOOLS,
  CREDENTIAL_TOOLS,
  PROJECT_TOOLS,
  SETTINGS_TOOLS,
  SSH_KEY_TOOLS,
  SYSTEM_TOOLS,
} from './system.js';
import {
  CLOUDFLARE_TOOLS,
  DOMAIN_TOOLS,
  JENKINS_TOOLS,
  NGINX_TOOLS,
  SSL_TOOLS,
  STACK_TOOLS,
  WORDPRESS_TOOLS,
} from './web.js';

/** Every tool the MCP server can offer. */
export const MCP_TOOLS: readonly McpTool[] = [
  ...OPERATION_TOOLS,
  ...APP_TOOLS,
  ...PROJECT_TOOLS,
  ...CREDENTIAL_TOOLS,
  ...SETTINGS_TOOLS,
  ...BACKUP_TOOLS,
  ...SSH_KEY_TOOLS,
  ...CLOUD_TOOLS,
  ...INFRASTRUCTURE_TOOLS,
  ...DEPLOYMENT_TOOLS,
  ...ANSIBLE_TOOLS,
  ...CONTAINER_TOOLS,
  ...RUNTIME_TOOLS,
  ...HOST_TOOLS,
  ...TERMINAL_TOOLS,
  ...NGINX_TOOLS,
  ...SSL_TOOLS,
  ...CLOUDFLARE_TOOLS,
  ...DOMAIN_TOOLS,
  ...WORDPRESS_TOOLS,
  ...STACK_TOOLS,
  ...JENKINS_TOOLS,
  ...SYSTEM_TOOLS,
  ...EXTRA_TOOLS,
];

/** The always-on toolset: without it a client cannot follow its own operations. */
export const CORE_TOOLSET = 'core';

const TOOLSET_LABELS: Readonly<Record<string, string>> = {
  app: 'Application',
  projects: 'Projects',
  credentials: 'Credentials',
  settings: 'Settings',
  backup: 'Backup',
  sshKeys: 'SSH keys',
  cloud: 'Cloud providers and firewall',
  infrastructure: 'Infrastructure',
  deployments: 'Deployments',
  ansible: 'VPS targets and Ansible',
  containers: 'Containers',
  runtime: 'VPS runtime',
  host: 'Server firewall and SSH access',
  terminal: 'SSH terminal',
  nginx: 'Nginx',
  ssl: 'SSL certificates',
  cloudflare: 'Cloudflare',
  domains: 'Domains',
  wordpress: 'WordPress',
  stacks: 'Docker stacks',
  jenkins: 'Jenkins',
  system: 'Activity, logs, updates, plugins',
  extras: 'Documentation and window control',
};

/** The toolsets a user can switch on and off, with how many tools each holds. */
export function mcpToolsets(): McpToolsetInfo[] {
  return Object.entries(TOOLSET_LABELS).map(([id, label]) => ({
    id,
    label,
    tools: MCP_TOOLS.filter((tool) => tool.toolset === id).length,
  }));
}
