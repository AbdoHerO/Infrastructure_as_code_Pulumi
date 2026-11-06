import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { compact, type McpTool, McpToolError, toolset } from '../types.js';
import { asRuntimePlan } from './cloud.js';
import {
  credentialId,
  id,
  port,
  portsList,
  rememberHostKey,
  requireInspectedHostKey,
  savedTarget,
  targetId,
} from './common.js';

const deployments = toolset('deployments');
const ansible = toolset('ansible');
const containers = toolset('containers');
const runtime = toolset('runtime');
const host = toolset('host');
const terminal = toolset('terminal');

const ansibleLog = { logChannel: 'ansible:log', cancelChannel: 'ansible:cancel' } as const;
const profileId = z.enum(['docker', 'dockhand', 'portainer', 'jenkins', 'nginx', 'postgres']);
const variables = z
  .record(z.string(), z.unknown())
  .default({})
  .describe('Profile variables from ansible_list_profiles; missing ones use their defaults');
const containerId = id('Container id or name, from runtime_inspect');
const resourceKind = z.enum(['container', 'network', 'volume']);
const dockerName = z.string().min(1).describe('The Docker name of the resource');
const sessionId = id('Terminal session id, from terminal_open');

/** Defaults a person sees in the form, applied when a client leaves a variable out. */
async function withProfileDefaults(
  context: Parameters<McpTool['run']>[1],
  profile: string,
  given: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const profiles = await context.call('ansible:profiles', undefined);
  const spec = profiles.find((item) => item.id === profile);
  const defaults = Object.fromEntries(
    (spec?.variables ?? [])
      .filter((variable) => variable.defaultValue !== undefined)
      .map((variable) => [variable.key, variable.defaultValue]),
  );
  return { ...defaults, ...given };
}

export const DEPLOYMENT_TOOLS: readonly McpTool[] = [
  deployments.call(
    'deploy_list_templates',
    'deploy:templates',
    'read',
    'Deployment templates: Docker host, Nginx, Node API, Next.js, WordPress, Ollama.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  deployments.call(
    'deploy_list',
    'deploy:list',
    'read',
    "This project's deployment history.",
    {},
    (_input, context) => ({ projectId: context.projectId() }),
    { openWorld: false },
  ),
  deployments.call(
    'deploy_count',
    'deploy:count',
    'read',
    'How many deployments this project has.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  deployments.custom(
    'deploy_inspect_host_key',
    ['deploy:inspectHostKey'],
    'read',
    "Read a server's SSH fingerprint, to check before trusting it.",
    { host: z.string().min(1), port: port.default(22) },
    async (input, context) => {
      const result = await context.call('deploy:inspectHostKey', input);
      rememberHostKey(context.session, input.host, input.port, result.fingerprint, context.now());
      return result;
    },
  ),
  deployments.custom(
    'deploy_run',
    ['deploy:run', 'ansible:getTarget'],
    'write',
    'Run a deployment template on a server. Give targetId for a saved target; a host that is not saved also needs sshCredentialId and the fingerprint from deploy_inspect_host_key.',
    {
      templateId: id('Template id, from deploy_list_templates'),
      targetId: targetId.optional(),
      host: z.string().min(1).optional(),
      port: port.default(22),
      username: z.string().min(1).default('ubuntu'),
      sshCredentialId: credentialId.optional(),
      hostKeySha256: z.string().min(1).optional(),
      appImage: z.string().min(1).optional().describe('Container image, for the app templates'),
    },
    async (input, context) => {
      const options = compact({ appImage: input.appImage });
      const common = {
        projectId: context.projectId(),
        templateId: input.templateId,
        streamId: context.streamId,
        ...options,
      };
      if (input.targetId) {
        const { targetId: _saved, ...connection } = await savedTarget(context, input.targetId);
        return context.call('deploy:run', { ...common, ...connection });
      }
      if (!input.host || !input.sshCredentialId || !input.hostKeySha256) {
        throw new McpToolError('Give targetId, or host with sshCredentialId and hostKeySha256.');
      }
      requireInspectedHostKey(
        context,
        input.host,
        input.port,
        input.hostKeySha256,
        'deploy_inspect_host_key',
      );
      return context.call('deploy:run', {
        ...common,
        host: input.host,
        port: input.port,
        username: input.username,
        sshCredentialId: input.sshCredentialId,
        hostKeySha256: input.hostKeySha256,
      });
    },
    { operation: { logChannel: 'deploy:log', cancelChannel: 'deploy:cancel' } },
  ),
  deployments.call(
    'deploy_cancel',
    'deploy:cancel',
    'write',
    'Stop a running deployment; completed steps are not rolled back. Use the operationId of deploy_run.',
    { operationId: id('From deploy_run or operations_list') },
    (input) => ({ streamId: input.operationId }),
    { openWorld: false, destructive: false },
  ),
];

export const ANSIBLE_TOOLS: readonly McpTool[] = [
  ansible.call(
    'targets_list',
    'ansible:targets',
    'read',
    'Saved VPS targets. Most server tools take one of these ids.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  ansible.call(
    'targets_get',
    'ansible:getTarget',
    'read',
    'One saved VPS target, with its last readiness report.',
    { id: targetId },
    (input) => input,
    { openWorld: false },
  ),
  ansible.custom(
    'targets_inspect_host_key',
    ['ansible:inspectHostKey'],
    'read',
    "Read a server's SSH fingerprint before saving it. Show it to the user to check against the provider's console.",
    { host: z.string().min(1), port: port.default(22) },
    async (input, context) => {
      const result = await context.call('ansible:inspectHostKey', input);
      rememberHostKey(context.session, input.host, input.port, result.fingerprint, context.now());
      return result;
    },
  ),
  ansible.custom(
    'targets_create',
    ['ansible:createTarget'],
    'write',
    'Save a server as a VPS target. The fingerprint must come from targets_inspect_host_key on this connection, and from then on only that machine is accepted.',
    {
      name: z.string().min(1),
      host: z.string().min(1),
      port: port.default(22),
      username: z.string().min(1).default('ubuntu'),
      sshCredentialId: credentialId.describe('An ssh or ssh-password credential'),
      hostKeySha256: z.string().min(1).describe('From targets_inspect_host_key'),
    },
    async (input, context) => {
      requireInspectedHostKey(
        context,
        input.host,
        input.port,
        input.hostKeySha256,
        'targets_inspect_host_key',
      );
      return context.call('ansible:createTarget', input);
    },
    { openWorld: false },
  ),
  ansible.custom(
    'targets_update',
    ['ansible:updateTarget', 'ansible:getTarget'],
    'write',
    'Change a saved VPS target. Fields not given keep their value. A new fingerprint must come from targets_inspect_host_key on this connection.',
    {
      id: targetId,
      name: z.string().min(1).optional(),
      host: z.string().min(1).optional(),
      port: port.optional(),
      username: z.string().min(1).optional(),
      sshCredentialId: credentialId.optional(),
      hostKeySha256: z.string().min(1).optional(),
    },
    async (input, context) => {
      const current = await context.call('ansible:getTarget', { id: input.id });
      const next = {
        id: input.id,
        name: input.name ?? current.name,
        host: input.host ?? current.host,
        port: input.port ?? current.port,
        username: input.username ?? current.username,
        sshCredentialId: input.sshCredentialId ?? current.sshCredentialId ?? '',
        hostKeySha256: input.hostKeySha256 ?? current.hostKeySha256,
      };
      if (next.hostKeySha256 !== current.hostKeySha256 || next.host !== current.host) {
        requireInspectedHostKey(
          context,
          next.host,
          next.port,
          next.hostKeySha256,
          'targets_inspect_host_key',
        );
      }
      return context.call('ansible:updateTarget', next);
    },
    { openWorld: false },
  ),
  ansible.call(
    'targets_delete',
    'ansible:deleteTarget',
    'critical',
    'Remove a saved target from CloudForge. The server itself is not touched.',
    { id: targetId },
    (input) => input,
    { openWorld: false },
  ),
  ansible.call(
    'ansible_list_profiles',
    'ansible:profiles',
    'read',
    'What Ansible can install (Docker, Dockhand, Portainer, Jenkins, Nginx, PostgreSQL) and the variables each profile takes.',
    {},
    () => undefined,
    { openWorld: false },
  ),
  ansible.custom(
    'ansible_get_status',
    ['ansible:status', 'ansible:getTarget'],
    'read',
    'Whether Ansible is installed on a server, and which version.',
    { targetId },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:status', request);
    },
  ),
  ansible.custom(
    'ansible_get_profile_states',
    ['ansible:profileStates', 'ansible:getTarget'],
    'read',
    'Live state of every profile on a server: installed, running, version, port, firewall.',
    { targetId },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:profileStates', request);
    },
  ),
  ansible.custom(
    'ansible_preflight',
    ['ansible:preflight', 'ansible:getTarget'],
    'read',
    'Check whether a server is ready for a profile. needs-repair means ansible_repair can fix it; blocked means it cannot.',
    { targetId, profileId: profileId.optional(), variables: variables.optional() },
    async (input, context) => {
      const request = await savedTarget(context, input.targetId);
      return context.call(
        'ansible:preflight',
        compact({
          ...request,
          profileId: input.profileId,
          variables: input.profileId
            ? await withProfileDefaults(context, input.profileId, input.variables ?? {})
            : undefined,
        }),
      );
    },
  ),
  ansible.custom(
    'ansible_repair',
    ['ansible:repair', 'ansible:getTarget'],
    'write',
    'Install the system packages and Ansible a server is missing, as reported by ansible_preflight.',
    { targetId },
    async (input, context) =>
      context.call('ansible:repair', {
        ...(await savedTarget(context, input.targetId)),
        streamId: context.streamId,
      }),
    { operation: ansibleLog, idempotent: true },
  ),
  ansible.custom(
    'ansible_bootstrap',
    ['ansible:bootstrap', 'ansible:getTarget'],
    'write',
    'Install Ansible itself on a server.',
    { targetId },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:bootstrap', { ...request, streamId: context.streamId });
    },
    { operation: ansibleLog, idempotent: true },
  ),
  ansible.custom(
    'ansible_run_profile',
    ['ansible:run', 'ansible:profiles', 'ansible:getTarget'],
    'write',
    'Install or update a profile on a server. Safe to run again. The server must pass ansible_preflight first.',
    { targetId, profileId, variables },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:run', {
        ...request,
        profileId: input.profileId,
        variables: await withProfileDefaults(context, input.profileId, input.variables),
        streamId: context.streamId,
      });
    },
    { operation: ansibleLog, idempotent: true },
  ),
  ansible.custom(
    'ansible_jenkins_verify',
    ['ansible:jenkinsAction', 'ansible:getTarget'],
    'read',
    'Check that the Jenkins installed by Ansible is healthy.',
    { targetId },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:jenkinsAction', {
        ...request,
        action: 'verify',
        streamId: context.streamId,
      });
    },
    { operation: ansibleLog },
  ),
  ansible.custom(
    'ansible_jenkins_restart',
    ['ansible:jenkinsAction', 'ansible:getTarget'],
    'write',
    'Restart Jenkins. It is briefly unavailable; jobs and history are kept.',
    { targetId },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:jenkinsAction', {
        ...request,
        action: 'restart',
        streamId: context.streamId,
      });
    },
    { operation: ansibleLog },
  ),
  ansible.custom(
    'ansible_get_access',
    ['ansible:access', 'ansible:profiles', 'ansible:getTarget'],
    'secret',
    'Login details of an installed service: the Jenkins unlock password, or the PostgreSQL password and connection string.',
    { targetId, profileId: z.enum(['jenkins', 'postgres']), variables },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:access', {
        ...request,
        profileId: input.profileId,
        variables: await withProfileDefaults(context, input.profileId, input.variables),
      });
    },
  ),
  ansible.call(
    'ansible_cancel',
    'ansible:cancel',
    'write',
    'Stop a running Ansible operation; completed tasks are not rolled back.',
    { operationId: id('From the tool that started it, or operations_list') },
    (input) => ({ streamId: input.operationId }),
    { openWorld: false, destructive: false },
  ),
  ansible.custom(
    'ansible_list_networks',
    ['ansible:networks', 'ansible:getTarget'],
    'read',
    'Docker networks on a server.',
    { targetId },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:networks', request);
    },
  ),
  ansible.custom(
    'ansible_create_network',
    ['ansible:createNetwork', 'ansible:getTarget'],
    'write',
    'Create a Docker network on a server.',
    { targetId, name: z.string().min(1) },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:createNetwork', { ...request, name: input.name });
    },
    { idempotent: true },
  ),
  ansible.custom(
    'ansible_list_nginx_sites',
    ['ansible:nginxSites', 'ansible:getTarget'],
    'read',
    'Nginx routes managed through the Ansible page. nginx_list_sites shows every site.',
    { targetId },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:nginxSites', request);
    },
  ),
  ansible.custom(
    'ansible_upsert_nginx_site',
    ['ansible:nginxUpsert', 'ansible:getTarget'],
    'write',
    'Add or change a simple Nginx route to a local port. nginx_save_site offers every option.',
    {
      targetId,
      domain: z.string().min(1),
      upstreamHost: z.string().min(1).default('127.0.0.1'),
      upstreamPort: port.default(3000),
      websocket: z.boolean().default(false),
    },
    async ({ targetId: id, domain, upstreamHost, upstreamPort, websocket }, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, id);
      return context.call('ansible:nginxUpsert', {
        ...request,
        site: {
          domain: domain.trim().toLowerCase(),
          upstreamHost: upstreamHost.trim(),
          upstreamPort,
          websocket,
        },
        streamId: context.streamId,
      });
    },
    { operation: ansibleLog, idempotent: true },
  ),
  ansible.custom(
    'ansible_remove_nginx_site',
    ['ansible:nginxRemove', 'ansible:getTarget'],
    'critical',
    'Remove an Nginx route. The domain stops being served.',
    { targetId, domain: z.string().min(1) },
    async (input, context) => {
      const { targetId: _saved, ...request } = await savedTarget(context, input.targetId);
      return context.call('ansible:nginxRemove', {
        ...request,
        domain: input.domain,
        streamId: context.streamId,
      });
    },
    { operation: ansibleLog },
  ),
];

export const CONTAINER_TOOLS: readonly McpTool[] = [
  containers.call(
    'containers_list',
    'containers:list',
    'read',
    'Containers on a server. runtime_inspect also shows networks, volumes and ownership.',
    { targetId },
    (input) => input,
  ),
  containers.call(
    'runtime_inspect',
    'runtime:inspect',
    'read',
    'What is running on a server: Docker versions, containers with their ports and who owns them, networks and volumes.',
    { targetId },
    (input) => input,
  ),
  containers.call(
    'containers_start',
    'containers:action',
    'write',
    'Start a container.',
    { targetId, containerId },
    (input) => ({ ...input, action: 'start' as const }),
    { idempotent: true },
  ),
  containers.call(
    'containers_restart',
    'containers:action',
    'write',
    'Restart a container. It is briefly unavailable.',
    { targetId, containerId },
    (input) => ({ ...input, action: 'restart' as const }),
  ),
  containers.call(
    'containers_stop',
    'containers:action',
    'critical',
    'Stop a container. Whatever it serves goes offline.',
    { targetId, containerId },
    (input) => ({ ...input, action: 'stop' as const }),
  ),
  containers.call(
    'containers_remove',
    'containers:action',
    'critical',
    'Remove a container.',
    { targetId, containerId },
    (input) => ({ ...input, action: 'remove' as const }),
  ),
  containers.call(
    'containers_logs',
    'containers:logs',
    'read',
    "A container's recent log lines. They may contain secrets the application printed.",
    { targetId, containerId, lines: z.number().int().min(1).max(10000).default(200) },
    (input) => input,
  ),
  containers.call(
    'containers_stats',
    'containers:stats',
    'read',
    "A container's CPU, memory, network and disk use.",
    { targetId, containerId },
    (input) => input,
  ),
  containers.call(
    'containers_deploy_compose',
    'containers:deployCompose',
    'write',
    'Bring up a Compose project with no domain handling. stacks_create also handles domains, DNS and HTTPS.',
    { targetId, projectName: z.string().min(1), composeYaml: z.string().min(1) },
    (input) => input,
    { idempotent: true },
  ),
];

export const RUNTIME_TOOLS: readonly McpTool[] = [
  runtime.call(
    'runtime_get_plan',
    'runtime:getPlan',
    'read',
    "A target's desired runtime topology and any problems with it.",
    { targetId },
    (input) => input,
    { openWorld: false },
  ),
  runtime.call(
    'runtime_save_plan',
    'runtime:savePlan',
    'write',
    "Save a target's desired runtime. Database only: nothing on the server changes until runtime_apply. Read the current plan with runtime_get_plan, change it and send all of it back.",
    {
      targetId,
      plan: z.looseObject({}).describe('The whole plan, in the shape runtime_get_plan returns'),
    },
    (input) => ({ targetId: input.targetId, plan: asRuntimePlan(input.plan) }),
    { openWorld: false },
  ),
  runtime.call(
    'runtime_validate_plan',
    'runtime:validatePlan',
    'read',
    'Check a runtime plan without saving it.',
    { plan: z.looseObject({}).describe('The whole plan') },
    (input) => ({ plan: asRuntimePlan(input.plan) }),
    { openWorld: false },
  ),
  runtime.call(
    'runtime_set_mode',
    'runtime:setMode',
    'write',
    'Choose how much of the target CloudForge manages: legacy changes nothing, hybrid and managed allow runtime_apply.',
    { targetId, mode: z.enum(['legacy', 'hybrid', 'managed']) },
    (input) => input,
    { openWorld: false, idempotent: true },
  ),
  runtime.call(
    'runtime_drift',
    'runtime:drift',
    'read',
    'Compare the runtime plan with what is actually on the server.',
    { targetId },
    (input) => input,
  ),
  runtime.call(
    'runtime_adopt',
    'runtime:adopt',
    'write',
    'Record that CloudForge owns an existing resource. Database only: nothing on the server changes.',
    { targetId, resourceKind, dockerName },
    (input) => input,
    { openWorld: false },
  ),
  runtime.call(
    'runtime_release',
    'runtime:release',
    'write',
    'Stop owning an adopted resource. Database only: it keeps running on the server.',
    { targetId, resourceKind, dockerName },
    (input) => input,
    { openWorld: false },
  ),
  runtime.call(
    'runtime_connectivity',
    'runtime:connectivity',
    'read',
    "Whether the plan's ports can carry traffic through the server and cloud firewalls.",
    { targetId },
    (input) => input,
  ),
  runtime.call(
    'runtime_open_required_ports',
    'runtime:openFirewall',
    'write',
    "Open the ports the plan needs on the server's firewall. Only adds rules, never removes any.",
    { targetId },
    (input) => input,
    { idempotent: true },
  ),
  runtime.call(
    'runtime_preview',
    'runtime:preview',
    'read',
    'Work out what runtime_apply would do, and get the token it needs. Each operation lists its risk; destructive ones need their resource name passed to runtime_apply.',
    {
      targetId,
      remove: z
        .array(z.string())
        .default([])
        .describe('Docker names the user explicitly agreed to delete'),
    },
    (input) => ({ targetId: input.targetId, options: { remove: input.remove } }),
  ),
  runtime.call(
    'runtime_apply',
    'runtime:apply',
    'critical',
    'Change the server to match the runtime plan, exactly as the preview described. The server is checked again first; a changed server refuses the token.',
    {
      targetId,
      previewToken: z.string().min(1).describe('From runtime_preview'),
      confirmations: z
        .array(z.string())
        .default([])
        .describe('The exact resource name of every destructive operation in the preview'),
      remove: z.array(z.string()).default([]).describe('The same list given to runtime_preview'),
    },
    (input, context) => ({
      targetId: input.targetId,
      previewToken: input.previewToken,
      confirmations: input.confirmations,
      options: { remove: input.remove },
      streamId: context.streamId,
    }),
    { operation: { logChannel: 'runtime:log' } },
  ),
];

export const HOST_TOOLS: readonly McpTool[] = [
  host.call(
    'host_firewall_inspect',
    'hostFirewall:inspect',
    'read',
    "The server's own firewall: which backend is in charge and its rules.",
    { targetId },
    (input) => input,
  ),
  host.call(
    'host_firewall_open',
    'hostFirewall:open',
    'write',
    "Open ports on the server's own firewall. Only adds rules. The cloud firewall may still block them.",
    { targetId, ports: portsList },
    (input) => input,
    { idempotent: true },
  ),
  host.call(
    'host_firewall_close',
    'hostFirewall:close',
    'critical',
    "Close ports on the server's own firewall. The SSH port CloudForge uses is always refused.",
    { targetId, ports: portsList },
    (input) => input,
    { idempotent: true },
  ),
  host.call(
    'host_access_inspect',
    'hostAccess:inspect',
    'read',
    'SSH accounts CloudForge created for other people on a server, and anything that could stop them connecting.',
    { targetId },
    (input) => input,
  ),
  host.call(
    'host_access_grant',
    'hostAccess:grant',
    'critical',
    'Give a person SSH access with their own account and public key, optionally with full administrator rights. Only accounts CloudForge created can be changed.',
    {
      targetId,
      username: z.string().min(2).max(32),
      publicKey: z.string().min(1).describe('Their OpenSSH PUBLIC key line, never a private key'),
      sudo: z.boolean().default(false).describe('Full administrator rights on the server'),
    },
    (input) => ({ ...input, username: input.username.trim().toLowerCase() }),
    { destructive: false },
  ),
  host.call(
    'host_access_revoke',
    'hostAccess:revoke',
    'critical',
    "Remove a person's account from a server, with its home folder and sudo rule.",
    { targetId, username: z.string().min(1) },
    (input) => input,
  ),
  host.call(
    'host_access_instructions',
    'hostAccess:instructions',
    'read',
    'The message telling a person how to connect, and the message asking them for their public key.',
    {
      targetId,
      username: z.string().min(1),
      sudo: z.boolean().default(false),
      language: z.enum(['en', 'fr']).default('en'),
    },
    (input) => input,
    { openWorld: false },
  ),
];

export const TERMINAL_TOOLS: readonly McpTool[] = [
  terminal.custom(
    'terminal_open',
    ['terminal:open'],
    'shell',
    'Open an interactive shell on a saved target. Read what it prints with terminal_read.',
    {
      targetId,
      columns: z.number().int().min(20).max(500).default(120),
      rows: z.number().int().min(5).max(300).default(40),
    },
    async (input, context) => {
      const newSession = randomUUID();
      context.terminals.track(newSession);
      try {
        await context.call('terminal:open', { ...input, sessionId: newSession });
      } catch (error) {
        context.terminals.forget(newSession);
        throw error;
      }
      return { sessionId: newSession };
    },
  ),
  terminal.call(
    'terminal_write',
    'terminal:write',
    'shell',
    'Send keystrokes to a terminal. End a command with a newline.',
    { sessionId, data: z.string().min(1).max(65536) },
    (input) => input,
  ),
  terminal.custom(
    'terminal_read',
    [],
    'shell',
    'What a terminal has printed since a cursor. Pass back nextCursor to read only new output.',
    { sessionId, cursor: z.number().int().min(0).default(0) },
    (input, context) => {
      const output = context.terminals.read(input.sessionId, input.cursor);
      if (!output) throw new McpToolError('No terminal with that session id on this connection.');
      return Promise.resolve(output);
    },
    { openWorld: false, needsProject: true },
  ),
  terminal.call(
    'terminal_resize',
    'terminal:resize',
    'shell',
    'Change the size of a terminal.',
    {
      sessionId,
      columns: z.number().int().min(20).max(500),
      rows: z.number().int().min(5).max(300),
    },
    (input) => input,
  ),
  terminal.custom(
    'terminal_close',
    ['terminal:close'],
    'shell',
    'Close a terminal.',
    { sessionId },
    async (input, context) => {
      await context.call('terminal:close', input);
      context.terminals.forget(input.sessionId);
      return { closed: true };
    },
  ),
  terminal.call(
    'terminal_exec',
    'terminal:exec',
    'shell',
    'Run one command on a saved target and return its exit code and output. For anything interactive use terminal_open.',
    {
      targetId,
      command: z.string().min(1).max(65536),
      timeoutSeconds: z.number().int().min(1).max(600).default(60),
    },
    (input) => input,
    { operation: { logChannel: null } },
  ),
];
