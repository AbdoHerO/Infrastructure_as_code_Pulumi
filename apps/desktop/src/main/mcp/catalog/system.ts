import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { CREDENTIAL_KINDS } from '@cloudforge/core';
import { formatDiagnostics } from '../../app-diagnostics.js';
import { requireLocalPath } from '../../security/local-paths.js';
import { compact, type McpTool, McpToolError, toolset } from '../types.js';
import { credentialId, id } from './common.js';

const app = toolset('app');
const projects = toolset('projects');
const credentials = toolset('credentials');
const settings = toolset('settings');
const backup = toolset('backup');
const sshKeys = toolset('sshKeys');
const system = toolset('system');

const passkey = z.string().min(1).describe('The project passkey');
const backupPassphrase = z
  .string()
  .min(12)
  .describe('At least 12 characters; needed again to restore or import this backup');
const folder = (what: string): z.ZodString =>
  z.string().min(1).describe(`Complete path of a folder on this computer: ${what}`);
const MAX_PRIVATE_KEY_FILE_LENGTH = 64 * 1024;

export const APP_TOOLS: readonly McpTool[] = [
  app.call(
    'app_get_info',
    'app:getInfo',
    'read',
    'Version, build, platform and runtime versions of CloudForge.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  app.call(
    'app_ping',
    'app:ping',
    'read',
    'Check that CloudForge answers.',
    { message: z.string().default('ping') },
    (input) => input.message,
    { openWorld: false },
  ),
  app.call(
    'app_open_link',
    'app:openExternal',
    'local',
    "Open CloudForge's GitHub repository or its releases page in the browser.",
    { link: z.enum(['github', 'releases']) },
    (input) => input,
    { openWorld: false },
  ),
  app.custom(
    'app_get_diagnostics',
    ['app:getInfo', 'app:copyDiagnostics'],
    'read',
    'Build and system details for an issue report. Contains no secrets.',
    { copyToClipboard: z.boolean().default(false).describe('Also copy them to the clipboard') },
    async (input, context) => {
      const diagnostics = formatDiagnostics(await context.call('app:getInfo', undefined));
      if (input.copyToClipboard) await context.call('app:copyDiagnostics', undefined);
      return { diagnostics };
    },
    { openWorld: false },
  ),
  app.call(
    'app_copy_to_clipboard',
    'app:copyText',
    'local',
    "Put text on this computer's clipboard.",
    { text: z.string() },
    (input) => input,
    { openWorld: false },
  ),
  app.call(
    'app_synchronize',
    'app:synchronize',
    'write',
    'Reconcile saved VPS targets with the cloud stack and refresh Cloudflare data, then report any warnings. Same as the Refresh button.',
    {},
    () => undefined,
    { idempotent: true },
  ),
  app.call(
    'app_background_jobs',
    'app:backgroundJobs',
    'read',
    'When the automatic jobs (certificate renewal, Cloudflare sync, deployment recovery, log pruning) last ran and when they run next.',
    {},
    () => undefined,
    { openWorld: false },
  ),
];

export const PROJECT_TOOLS: readonly McpTool[] = [
  projects.call(
    'projects_list',
    'projects:picker',
    'read',
    'Every project on this computer, locked or not, with counts of targets, pipelines and deployments.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  projects.call(
    'projects_list_open',
    'projects:list',
    'read',
    'The project currently open in CloudForge, with its full details.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  projects.call(
    'projects_get',
    'projects:get',
    'read',
    'Details of the open project.',
    { id: id('Project id; must be the open project') },
    (input) => input,
    { openWorld: false },
  ),
  projects.call(
    'projects_count',
    'projects:count',
    'read',
    'How many projects exist on this computer.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  projects.custom(
    'projects_get_session',
    ['projects:session'],
    'read',
    'Which project is open now. Also confirms a change of project: after the user switches, other tools refuse until this is called.',
    {},
    async (_input, context) => {
      const session = await context.call('projects:session', undefined);
      context.session.pinnedProjectId = session?.project.id ?? null;
      return session;
    },
    { openWorld: false, needsProject: false },
  ),
  projects.custom(
    'projects_create',
    ['projects:create', 'settings:newProjectDefaults'],
    'write',
    'Create a project. It stays locked until someone opens it.',
    {
      name: z.string().min(1).max(100),
      passkey: z.string().min(8).describe('At least 8 characters; opens the project later'),
      environment: z.enum(['development', 'staging', 'production']).default('development'),
      region: z
        .string()
        .min(1)
        .optional()
        .describe('Defaults to the "Default region" setting when one is set'),
      description: z.string().optional(),
      icon: z.string().max(8).optional(),
      color: z.string().optional(),
    },
    async (input, context) => {
      const region =
        input.region ?? (await context.call('settings:newProjectDefaults', undefined)).region;
      if (!region) {
        throw new McpToolError('Give a region: no default region is set in CloudForge.');
      }
      return context.call('projects:create', compact({ ...input, region }));
    },
    { openWorld: false, needsProject: false },
  ),
  projects.custom(
    'projects_unlock',
    ['projects:unlock'],
    'write',
    'Open a project, closing whichever one is open. The window follows.',
    { id: id('Project id, from projects_list'), passkey: z.string().default('') },
    async (input, context) => {
      const session = await context.call('projects:unlock', input);
      context.session.pinnedProjectId = session.project.id;
      context.emit('projects:sessionChanged', { projectId: session.project.id });
      return session;
    },
    { openWorld: false, needsProject: false, needsProjectSwitch: true },
  ),
  projects.custom(
    'projects_lock',
    ['projects:lock'],
    'write',
    'Lock the open project. Closes its SSH terminals; refused while work that cannot be stopped is running.',
    {},
    async (_input, context) => {
      await context.call('projects:lock', undefined);
      context.session.pinnedProjectId = null;
      context.emit('projects:sessionChanged', { projectId: null });
      return { locked: true };
    },
    { openWorld: false },
  ),
  projects.call(
    'projects_duplicate',
    'projects:duplicate',
    'write',
    "Copy the open project's configuration into a new locked project.",
    {
      name: z.string().min(1).max(100),
      passkey: z.string().min(8).describe('Passkey of the new project'),
      description: z.string().optional(),
    },
    (input) => compact(input),
    { openWorld: false },
  ),
  projects.custom(
    'projects_update',
    ['projects:update'],
    'write',
    "Change the open project's settings. Only the fields given change.",
    {
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional(),
      environment: z.enum(['development', 'staging', 'production']).optional(),
      region: z.string().min(1).optional(),
      providerId: z
        .string()
        .nullable()
        .optional()
        .describe('Id of an oracle or aws credential to provision with; null to unlink'),
      tags: z.array(z.string()).optional(),
      variables: z.record(z.string(), z.string()).optional(),
      notes: z.string().optional(),
      icon: z.string().max(8).optional(),
      color: z.string().optional(),
    },
    async (input, context) =>
      context.call('projects:update', { id: context.projectId(), changes: compact(input) }),
    { openWorld: false },
  ),
  projects.call(
    'projects_change_passkey',
    'projects:changePasskey',
    'critical',
    "Change the open project's passkey.",
    {
      currentPasskey: z.string().describe('Empty when the project has none yet'),
      newPasskey: z.string().min(8),
    },
    (input) => input,
    { openWorld: false, destructive: false },
  ),
  projects.call(
    'projects_remove_passkey',
    'projects:removePasskey',
    'critical',
    'Remove the passkey, so anyone at this computer can open the project.',
    {
      currentPasskey: passkey,
      confirmationName: z.string().describe("The project's exact name"),
    },
    (input) => input,
    { openWorld: false },
  ),
  projects.custom(
    'projects_delete',
    ['projects:delete'],
    'critical',
    'Delete the open project and everything saved in it. Refused while it still has cloud resources: destroy those first.',
    {
      confirmationName: z.string().describe("The project's exact name"),
      passkey: z.string().default(''),
    },
    async (input, context) => {
      await context.call('projects:delete', { id: context.projectId(), ...input });
      context.session.pinnedProjectId = null;
      context.emit('projects:sessionChanged', { projectId: null });
      return { deleted: true };
    },
    { openWorld: false },
  ),
];

export const CREDENTIAL_TOOLS: readonly McpTool[] = [
  credentials.call(
    'credentials_list',
    'credentials:list',
    'read',
    'Saved credentials: names, kinds and field names. Never their values.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  credentials.call(
    'credentials_list_kinds',
    'credentials:kinds',
    'read',
    'Every kind of credential and the fields each one needs.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  credentials.call(
    'credentials_create',
    'credentials:create',
    'write',
    'Save a credential, encrypted. The values pass through this conversation; for an environment file prefer credentials_import_environment_file.',
    {
      kind: z.enum(CREDENTIAL_KINDS),
      name: z.string().min(1),
      data: z.record(z.string(), z.string()).describe('Fields from credentials_list_kinds'),
    },
    (input) => input,
    { openWorld: false },
  ),
  credentials.custom(
    'credentials_update',
    ['credentials:reveal', 'credentials:update'],
    'write',
    'Change a saved credential. Fields not given keep their stored value, so a rename needs no secret.',
    {
      id: credentialId,
      name: z.string().min(1).optional(),
      data: z.record(z.string(), z.string()).optional().describe('Only the fields to change'),
    },
    async (input, context) => {
      const current = await context.call('credentials:reveal', { id: input.id });
      const updated = await context.call('credentials:update', {
        id: input.id,
        kind: current.kind,
        name: input.name ?? current.name,
        data: { ...current.data, ...input.data },
      });
      return updated;
    },
    { openWorld: false },
  ),
  credentials.custom(
    'credentials_import_environment_file',
    ['credentials:importEnvironmentFile', 'credentials:create'],
    'write',
    'Save an .env file as an encrypted credential. CloudForge reads the file itself, so its content never passes through this conversation.',
    {
      path: z.string().min(1).describe('Complete path of the file, up to 1 MB'),
      name: z.string().min(1).describe('Name for the credential'),
    },
    async (input, context) => {
      const file = await context.call('credentials:importEnvironmentFile', { path: input.path });
      if (!file) throw new McpToolError('The environment file could not be read.');
      return context.call('credentials:create', {
        kind: 'environment-file',
        name: input.name,
        data: { filename: file.filename, content: file.content },
      });
    },
    { openWorld: false },
  ),
  credentials.call(
    'credentials_reveal',
    'credentials:reveal',
    'secret',
    'Show the decrypted values of a credential.',
    { id: credentialId },
    (input) => input,
    { openWorld: false },
  ),
  credentials.call(
    'credentials_delete',
    'credentials:delete',
    'critical',
    'Delete a saved credential.',
    { id: credentialId },
    (input) => input,
    { openWorld: false },
  ),
  credentials.call(
    'security_get_status',
    'security:status',
    'read',
    'Whether secrets are protected by the OS keychain or a local key.',
    {},
    () => undefined,
    { openWorld: false },
  ),
];

const settingsPatch = {
  appearance: z.object({ reducedMotion: z.boolean() }).partial().optional(),
  deployment: z.object({ defaultRegion: z.string() }).partial().optional(),
  logs: z
    .object({ retentionDays: z.number().int().min(1).max(365) })
    .partial()
    .optional(),
  updates: z
    .object({ checkOnStartup: z.boolean(), autoDownload: z.boolean() })
    .partial()
    .optional(),
  ssl: z
    .object({
      autoRenew: z.boolean(),
      renewBeforeDays: z.number().int().min(1).max(90),
      checkIntervalHours: z.number().int().min(1).max(168),
    })
    .partial()
    .optional(),
  cloudflare: z
    .object({
      defaultCredentialId: z.string(),
      defaultZoneId: z.string(),
      defaultTtl: z.number().int(),
      defaultProxy: z.boolean(),
      waitForPropagation: z.boolean(),
      propagationTimeoutSeconds: z.number().int().min(30).max(3600),
      autoRefreshMinutes: z.number().int().min(1).max(1440),
      autoSync: z.boolean(),
      automaticDnsCreation: z.boolean(),
      automaticSsl: z.boolean(),
      automaticHttpsRedirect: z.boolean(),
      cacheTtl: z.number().int().min(0),
      preferredSslMode: z.enum(['off', 'flexible', 'full', 'strict']),
      developmentMode: z.boolean(),
      activityLogging: z.boolean(),
    })
    .partial()
    .optional(),
};

export const SETTINGS_TOOLS: readonly McpTool[] = [
  settings.call(
    'settings_get',
    'settings:get',
    'read',
    "The open project's settings.",
    {},
    () => undefined,
    { openWorld: false },
  ),
  settings.custom(
    'settings_update',
    ['settings:update'],
    'write',
    "Change the open project's settings; only the fields given change. MCP permissions are not settings and cannot be changed here.",
    settingsPatch,
    async (input, context) =>
      context.call(
        'settings:update',
        Object.fromEntries(
          Object.entries(input)
            .filter(([, section]) => section !== undefined)
            .map(([key, section]) => [key, compact(section as object)]),
        ),
      ),
    { openWorld: false, idempotent: true },
  ),
];

export const BACKUP_TOOLS: readonly McpTool[] = [
  backup.call(
    'backup_create_project',
    'backup:create',
    'write',
    'Write an encrypted, portable backup of the open project into a new folder.',
    {
      destinationDir: folder('where the backup folder is created'),
      passphrase: backupPassphrase,
      projectPasskey: passkey,
    },
    (input) => input,
    { openWorld: false, operation: { logChannel: null } },
  ),
  backup.call(
    'backup_restore_project',
    'backup:restore',
    'critical',
    "Replace the open project's data with one of its own backups. CloudForge restarts afterwards, which ends this connection: reconnect, then unlock the project.",
    { sourceDir: folder('the backup folder'), passphrase: z.string().min(1) },
    (input) => input,
    { openWorld: false, operation: { logChannel: null } },
  ),
  backup.call(
    'backup_import_project',
    'backup:importProject',
    'write',
    'Add a project from a backup. Needs no project open. CloudForge restarts afterwards, which ends this connection.',
    {
      sourceDir: folder('the backup folder'),
      passphrase: z.string().min(1),
      projectPasskey: z.string().min(8).describe('New passkey for the imported project'),
    },
    (input) => input,
    { openWorld: false, operation: { logChannel: null } },
  ),
];

export const SSH_KEY_TOOLS: readonly McpTool[] = [
  sshKeys.call(
    'ssh_keys_list',
    'sshKeys:list',
    'read',
    'Saved SSH keys with their public keys and fingerprints.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  sshKeys.call(
    'ssh_keys_generate',
    'sshKeys:generate',
    'write',
    'Generate a new SSH key pair, stored encrypted.',
    {
      name: z.string().min(1),
      algorithm: z.enum(['ed25519', 'rsa']).default('ed25519'),
      passphrase: z.string().optional(),
    },
    (input) => compact(input),
    { openWorld: false },
  ),
  sshKeys.custom(
    'ssh_keys_import',
    ['sshKeys:import'],
    'write',
    'Save an existing private key. Prefer privateKeyPath: CloudForge then reads the file itself and the key never passes through this conversation.',
    {
      name: z.string().min(1),
      privateKeyPath: z.string().min(1).optional().describe('Complete path of the key file'),
      privateKey: z.string().min(1).optional().describe('The key itself, when there is no file'),
      passphrase: z.string().optional(),
    },
    async (input, context) => {
      const privateKey = input.privateKeyPath
        ? await readFile(requireLocalPath(input.privateKeyPath), 'utf8')
        : input.privateKey;
      if (!privateKey) throw new McpToolError('Give privateKeyPath or privateKey.');
      if (privateKey.length > MAX_PRIVATE_KEY_FILE_LENGTH) {
        throw new McpToolError('That file is too large to be an SSH private key.');
      }
      return context.call(
        'sshKeys:import',
        compact({ name: input.name, privateKey, passphrase: input.passphrase }),
      );
    },
    { openWorld: false },
  ),
  sshKeys.call(
    'ssh_keys_reveal_private',
    'sshKeys:revealPrivate',
    'secret',
    'Show a private key.',
    { id: id('SSH key id, from ssh_keys_list') },
    (input) => input,
    { openWorld: false },
  ),
  sshKeys.call(
    'ssh_keys_export_private',
    'sshKeys:exportPrivate',
    'secret',
    'Write a private key to a new file only this user can read. Never replaces an existing file.',
    {
      id: id('SSH key id, from ssh_keys_list'),
      path: z.string().min(1).describe('Complete path of the file to create'),
    },
    (input) => ({ id: input.id, suggestedName: 'private-key', path: input.path }),
    { openWorld: false },
  ),
  sshKeys.call(
    'ssh_keys_materialize_private',
    'sshKeys:materializePrivate',
    'secret',
    "Write a private key into the project's temporary key folder and return the path, for use with ssh -i. Deleted when the project is locked.",
    {
      id: id('SSH key id, from ssh_keys_list'),
      name: z.string().min(1).default('key').describe('Base name for the file'),
    },
    (input) => ({ id: input.id, suggestedName: input.name }),
    { openWorld: false },
  ),
  sshKeys.call(
    'ssh_keys_delete',
    'sshKeys:delete',
    'critical',
    'Delete a saved SSH key. Servers still holding its public key are not changed.',
    { id: id('SSH key id, from ssh_keys_list') },
    (input) => input,
    { openWorld: false },
  ),
];

export const SYSTEM_TOOLS: readonly McpTool[] = [
  system.call(
    'activity_list',
    'activity:list',
    'read',
    'The activity feed, newest first: what was done in this project, by the user or an MCP client.',
    {
      limit: z.number().int().min(1).max(1000).default(100),
      typePrefix: z
        .string()
        .optional()
        .describe('Start of the event type, e.g. firewall. or infrastructure.applied'),
      search: z.string().optional().describe('Text found in the message or type'),
      since: z.string().optional().describe('ISO date: only events at or after it'),
    },
    (input) => compact(input),
    { openWorld: false },
  ),
  system.call(
    'logs_get_info',
    'logs:info',
    'read',
    'Where the application log file is.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  system.call(
    'logs_tail',
    'logs:tail',
    'read',
    'The last lines of the application log.',
    { lines: z.number().int().min(1).max(5000).default(300) },
    (input) => input,
    { openWorld: false },
  ),
  system.call(
    'logs_open_folder',
    'logs:openFolder',
    'local',
    'Open the log folder in the file explorer.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  system.call(
    'logs_prune',
    'logs:prune',
    'write',
    'Delete rotated log files older than the retention setting.',
    {},
    () => undefined,
    { openWorld: false, idempotent: true },
  ),
  system.call(
    'updates_get_state',
    'updates:state',
    'read',
    'Current version and update state.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  system.call(
    'updates_check',
    'updates:check',
    'read',
    'Check GitHub for a newer version.',
    {},
    () => undefined,
  ),
  system.call(
    'updates_download',
    'updates:download',
    'write',
    'Download the available update without installing it.',
    {},
    () => undefined,
    { operation: { logChannel: null } },
  ),
  system.call(
    'updates_install',
    'updates:install',
    'critical',
    'Restart CloudForge and install the downloaded update. This ends the connection.',
    {},
    () => undefined,
    { openWorld: false, destructive: false },
  ),
  system.call(
    'plugins_list',
    'plugins:list',
    'read',
    'Built-in extensions and whether each is installed and enabled.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  system.call(
    'plugins_list_active',
    'plugins:active',
    'read',
    'Extensions in effect right now.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  system.call(
    'plugins_install',
    'plugins:install',
    'write',
    'Install a built-in extension.',
    { id: id('Extension id, from plugins_list') },
    (input) => input,
    { openWorld: false },
  ),
  system.call(
    'plugins_set_enabled',
    'plugins:setEnabled',
    'write',
    'Enable or disable an installed extension.',
    { id: id('Extension id, from plugins_list'), enabled: z.boolean() },
    (input) => input,
    { openWorld: false, idempotent: true },
  ),
  system.call(
    'plugins_uninstall',
    'plugins:uninstall',
    'write',
    'Uninstall an extension.',
    { id: id('Extension id, from plugins_list') },
    (input) => input,
    { openWorld: false },
  ),
];
