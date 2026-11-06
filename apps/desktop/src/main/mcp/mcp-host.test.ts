/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   These tests read JSON off the wire, and spelling out every answer's shape would
   only restate what each assertion already says. */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcChannel, IpcEventChannel } from '../../shared/ipc/contract.js';
import { DEFAULT_MCP_SETTINGS, type McpSettings } from '../../shared/mcp/types.js';
import { McpApprovals } from './approvals.js';
import { McpHost } from './host.js';

const TOKEN = 'test-token';
const TARGET = {
  id: 'target-1',
  name: 'web',
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  sshCredentialId: 'cred-1',
  hostKeySha256: 'SAVED-FINGERPRINT',
};

type Handler = (payload: never) => unknown;

interface Harness {
  readonly host: McpHost;
  readonly calls: { channel: string; payload: unknown }[];
  readonly emitted: { channel: string; payload: unknown }[];
  readonly audited: { tool: string; outcome: string }[];
  readonly handlers: Partial<Record<IpcChannel, Handler>>;
  readonly approvals: McpApprovals;
  readonly events: EventEmitter;
  activeProject: string | null;
  settings: McpSettings;
}

function createHarness(): Harness {
  const events = new EventEmitter();
  const harness: Harness = {
    calls: [],
    emitted: [],
    audited: [],
    handlers: {},
    events,
    activeProject: 'project-a',
    settings: { ...DEFAULT_MCP_SETTINGS, enabled: true },
    approvals: new McpApprovals({
      timeoutSeconds: () => 5,
      onChanged: () => undefined,
    }),
    host: undefined as unknown as McpHost,
  };
  (harness as { host: McpHost }).host = new McpHost({
    call: (async (channel: IpcChannel, payload: unknown) => {
      harness.calls.push({ channel, payload });
      try {
        const handler = harness.handlers[channel];
        return { ok: true, value: handler ? await handler(payload as never) : undefined };
      } catch (error) {
        return {
          ok: false,
          error: { code: 'TEST_FAILURE', message: (error as Error).message, name: 'Error' },
        };
      }
    }) as never,
    activeProjectId: () => harness.activeProject,
    settings: () => harness.settings,
    verifyToken: (candidate) => candidate === TOKEN,
    approvals: harness.approvals,
    subscribe: ((channel: IpcEventChannel, listener: (payload: unknown) => void) => {
      events.on(channel, listener);
      return () => events.off(channel, listener);
    }) as never,
    emit: (channel, payload) => {
      harness.emitted.push({ channel, payload });
    },
    audit: (entry) => harness.audited.push(entry),
    documentation: () => [
      {
        id: 'welcome',
        file: 'README.md',
        title: 'Documentation home',
        summary: 'Start here',
        category: 'Start here',
        content: '# Hello from the docs',
      },
    ],
    onClientsChanged: () => undefined,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  harness.handlers['ansible:getTarget'] = () => TARGET;
  return harness;
}

async function connect(harness: Harness, name = 'test-client'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(harness.host.url!), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport as unknown as Transport);
  return client;
}

function parsed(result: unknown): Record<string, any> {
  const { content } = result as { content: { text: string }[] };
  return JSON.parse(content[0]!.text) as Record<string, any>;
}

function callsTo(harness: Harness, channel: IpcChannel): unknown[] {
  return harness.calls.filter((call) => call.channel === channel).map((call) => call.payload);
}

describe('MCP host', () => {
  let harness: Harness;
  let client: Client;

  beforeEach(async () => {
    harness = createHarness();
    await harness.host.start(0);
    client = await connect(harness);
  });

  afterEach(async () => {
    await client.close();
    await harness.host.stop();
  });

  describe('who may connect', () => {
    const post = (headers: Record<string, string>, path = ''): Promise<Response> =>
      fetch(`${harness.host.url!}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

    it('refuses a request with no token or the wrong one', async () => {
      expect((await post({})).status).toBe(401);
      expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401);
    });

    it('refuses a web page, even one with the token', async () => {
      const response = await post({
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'https://evil.example.com',
      });
      expect(response.status).toBe(403);
    });

    it('serves nothing but the MCP path', async () => {
      const response = await post({ Authorization: `Bearer ${TOKEN}` }, '/../other');
      expect(response.status).toBe(404);
    });

    it('needs an initialize request to start a session', async () => {
      const response = await post({ Authorization: `Bearer ${TOKEN}` });
      expect(response.status).toBe(400);
    });

    it('refuses a session that does not exist', async () => {
      const response = await post({
        Authorization: `Bearer ${TOKEN}`,
        'Mcp-Session-Id': 'nothing-here',
      });
      expect(response.status).toBe(404);
    });
  });

  describe('which tools a client sees', () => {
    const names = async (): Promise<string[]> =>
      (await client.listTools()).tools.map((tool) => tool.name);

    it('hides secrets, shell and project switching by default', async () => {
      const tools = await names();
      expect(tools).toContain('projects_list');
      expect(tools).toContain('infra_apply');
      expect(tools).not.toContain('credentials_reveal');
      expect(tools).not.toContain('terminal_exec');
      expect(tools).not.toContain('projects_unlock');
    });

    it('offers them once the user allows them', async () => {
      harness.settings = {
        ...harness.settings,
        allowProjectSwitch: true,
        tiers: { ...harness.settings.tiers, secret: true, shell: true },
      };
      const tools = await names();
      expect(tools).toContain('credentials_reveal');
      expect(tools).toContain('terminal_exec');
      expect(tools).toContain('projects_unlock');
    });

    it('drops a toolset the user switched off but never the core one', async () => {
      harness.settings = {
        ...harness.settings,
        disabledToolsets: ['cloudflare', 'core'],
      };
      const tools = await names();
      expect(tools.some((name) => name.startsWith('cloudflare_'))).toBe(false);
      expect(tools).toContain('operations_wait');
    });

    it('describes each tool with annotations a client can act on', async () => {
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === 'infra_destroy')?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(tools.find((tool) => tool.name === 'projects_list')?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    });

    it('takes away file access when the user switches it off', async () => {
      harness.settings = {
        ...harness.settings,
        tiers: { ...harness.settings.tiers, local: false },
      };
      const tools = await names();
      expect(tools).not.toContain('backup_create_project');
      expect(tools).not.toContain('stacks_read_folder');
      // These still work, as long as a call leaves its path option out.
      expect(tools).toContain('stacks_create');
      harness.handlers['stacks:create'] = () => ({ id: 's1' });

      const withPath = await client.callTool({
        name: 'stacks_create',
        arguments: { targetId: 't', name: 'app', folderPath: '/home/alex/app' },
      });
      expect(parsed(withPath).error.code).toBe('TOOL_DISABLED');
      expect(callsTo(harness, 'stacks:chooseFolder')).toEqual([]);

      const withoutPath = await client.callTool({
        name: 'stacks_create',
        arguments: { targetId: 't', name: 'app', composeYaml: 'services: {}' },
      });
      expect(withoutPath.isError).toBeUndefined();
    });

    it('explains why a hidden tool cannot be called', async () => {
      const result = await client.callTool({
        name: 'credentials_reveal',
        arguments: { id: 'x' },
      });
      expect(result.isError).toBe(true);
      expect(parsed(result).error.code).toBe('TOOL_DISABLED');
      expect(callsTo(harness, 'credentials:reveal')).toEqual([]);
    });
  });

  describe('running a tool', () => {
    it('goes through the same channel the window uses', async () => {
      harness.handlers['projects:picker'] = () => [{ id: 'project-a', name: 'Alpha' }];
      const result = await client.callTool({ name: 'projects_list', arguments: {} });
      expect(parsed(result)).toEqual([{ id: 'project-a', name: 'Alpha' }]);
      expect(callsTo(harness, 'projects:picker')).toHaveLength(1);
    });

    it('rejects bad input before doing anything', async () => {
      const result = await client.callTool({
        name: 'host_firewall_open',
        arguments: { targetId: 't', ports: [{ port: 99999, protocol: 'tcp' }] },
      });
      expect(result.isError).toBe(true);
      expect(parsed(result).error.code).toBe('INVALID_INPUT');
      expect(callsTo(harness, 'hostFirewall:open')).toEqual([]);
    });

    it('returns an application failure as a readable tool error', async () => {
      harness.handlers['nginx:inspect'] = () => {
        throw new Error('The server is offline');
      };
      const result = await client.callTool({ name: 'nginx_inspect', arguments: { targetId: 't' } });
      expect(result.isError).toBe(true);
      expect(parsed(result).error).toMatchObject({
        code: 'TEST_FAILURE',
        message: 'The server is offline',
      });
    });

    it('audits and refreshes the window after a change, not after a read', async () => {
      await client.callTool({ name: 'targets_list', arguments: {} });
      expect(harness.audited).toEqual([]);
      expect(harness.emitted).toEqual([]);

      await client.callTool({
        name: 'host_firewall_open',
        arguments: { targetId: 't', ports: [{ port: 443, protocol: 'tcp' }] },
      });
      expect(harness.audited).toEqual([
        { client: 'test-client', tool: 'host_firewall_open', outcome: 'succeeded' },
      ]);
      expect(harness.emitted).toEqual([
        {
          channel: 'app:dataChanged',
          payload: { channels: ['hostFirewall:open'], origin: 'mcp' },
        },
      ]);
    });
  });

  describe('the open project', () => {
    it('answers clearly when no project is open', async () => {
      harness.activeProject = null;
      const result = await client.callTool({ name: 'targets_list', arguments: {} });
      expect(parsed(result).error.code).toBe('NO_PROJECT');
    });

    it('still serves what needs no project', async () => {
      harness.activeProject = null;
      const result = await client.callTool({ name: 'projects_count', arguments: {} });
      expect(result.isError).toBeUndefined();
    });

    it('refuses to carry on in another project until the change is acknowledged', async () => {
      await client.callTool({ name: 'targets_list', arguments: {} });
      harness.activeProject = 'project-b';

      const refused = await client.callTool({ name: 'targets_list', arguments: {} });
      expect(parsed(refused).error.code).toBe('PROJECT_CHANGED');

      harness.handlers['projects:session'] = () => ({ project: { id: 'project-b' } });
      await client.callTool({ name: 'projects_get_session', arguments: {} });

      const resumed = await client.callTool({ name: 'targets_list', arguments: {} });
      expect(resumed.isError).toBeUndefined();
    });

    it('fills in the open project itself', async () => {
      await client.callTool({ name: 'infra_get_plan', arguments: {} });
      expect(callsTo(harness, 'infra:getPlan')).toEqual([{ projectId: 'project-a' }]);
    });
  });

  describe('critical actions', () => {
    const decideNext = (approved: boolean): void => {
      const timer = setInterval(() => {
        const [pending] = harness.approvals.pending();
        if (!pending) return;
        clearInterval(timer);
        harness.approvals.resolve(pending.id, approved);
      }, 5);
    };

    it('do not run when the person refuses', async () => {
      decideNext(false);
      const result = await client.callTool({
        name: 'credentials_delete',
        arguments: { id: 'cred-1' },
      });
      expect(parsed(result).error.code).toBe('NOT_APPROVED');
      expect(callsTo(harness, 'credentials:delete')).toEqual([]);
    });

    it('run once the person approves, showing them what is asked and hiding secrets', async () => {
      const seen: { summary: string; client: string }[] = [];
      const timer = setInterval(() => {
        const [pending] = harness.approvals.pending();
        if (!pending) return;
        clearInterval(timer);
        seen.push({ summary: pending.summary, client: pending.client });
        harness.approvals.resolve(pending.id, true);
      }, 5);
      const result = await client.callTool({
        name: 'projects_remove_passkey',
        arguments: { currentPasskey: 'top-secret-value', confirmationName: 'Alpha' },
      });
      expect(result.isError).toBeUndefined();
      expect(callsTo(harness, 'projects:removePasskey')).toHaveLength(1);
      expect(seen[0]!.client).toBe('test-client');
      expect(seen[0]!.summary).toContain('Alpha');
      expect(seen[0]!.summary).not.toContain('top-secret-value');
    });

    it('run without asking only when the user chose that', async () => {
      harness.settings = {
        ...harness.settings,
        tiers: { ...harness.settings.tiers, critical: 'allow' },
      };
      const result = await client.callTool({
        name: 'credentials_delete',
        arguments: { id: 'cred-1' },
      });
      expect(result.isError).toBeUndefined();
      expect(harness.approvals.pending()).toEqual([]);
    });

    it('turn a normal tool critical when the call itself is dangerous', async () => {
      decideNext(false);
      const refused = await client.callTool({
        name: 'jenkins_trigger_build',
        arguments: { id: 'p1', parameters: { CONFIRM_WIPE: 'WIPE' } },
      });
      expect(parsed(refused).error.code).toBe('NOT_APPROVED');
      expect(callsTo(harness, 'jenkins:trigger')).toEqual([]);

      const normal = await client.callTool({
        name: 'jenkins_trigger_build',
        arguments: { id: 'p1', parameters: { BRANCH: 'main' } },
      });
      expect(normal.isError).toBeUndefined();
      expect(callsTo(harness, 'jenkins:trigger')).toHaveLength(1);
    });
  });

  describe('long-running operations', () => {
    it('return the result and the log when they finish in time', async () => {
      harness.handlers['nginx:reload'] = (payload: { streamId: string }) => {
        harness.events.emit('nginx:log', {
          streamId: payload.streamId,
          event: { stream: 'step', message: 'Testing the config' },
        });
        return { summary: 'Reloaded' };
      };
      const answer = parsed(
        await client.callTool({ name: 'nginx_reload', arguments: { targetId: 't' } }),
      );
      expect(answer.status).toBe('succeeded');
      expect(answer.result).toEqual({ summary: 'Reloaded' });
      expect(answer.logTail).toEqual(['▶ Testing the config']);
    });

    it('hand back an id when they outlast the wait, and keep going', async () => {
      let finish: (value: unknown) => void = () => undefined;
      harness.handlers['nginx:reload'] = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const first = parsed(
        await client.callTool({
          name: 'nginx_reload',
          arguments: { targetId: 't', waitSeconds: 0 },
        }),
      );
      expect(first.status).toBe('running');

      finish({ summary: 'Reloaded' });
      const done = parsed(
        await client.callTool({
          name: 'operations_wait',
          arguments: { operationId: first.operationId, waitSeconds: 5 },
        }),
      );
      expect(done.status).toBe('succeeded');
      expect(done.result).toEqual({ summary: 'Reloaded' });
    });

    it('report a failure as an error', async () => {
      harness.handlers['nginx:reload'] = () => {
        throw new Error('Config is invalid');
      };
      const result = await client.callTool({ name: 'nginx_reload', arguments: { targetId: 't' } });
      expect(result.isError).toBe(true);
      expect(parsed(result).error.message).toBe('Config is invalid');
      expect(harness.audited).toEqual([
        { client: 'test-client', tool: 'nginx_reload', outcome: 'failed' },
      ]);
    });

    it('say honestly when one cannot be stopped', async () => {
      harness.handlers['nginx:reload'] = () => new Promise(() => undefined);
      const started = parsed(
        await client.callTool({
          name: 'nginx_reload',
          arguments: { targetId: 't', waitSeconds: 0 },
        }),
      );
      const answer = parsed(
        await client.callTool({
          name: 'operations_cancel',
          arguments: { operationId: started.operationId },
        }),
      );
      expect(answer.cancelled).toBe(false);
    });

    it('stop one that can be stopped, through its own channel', async () => {
      harness.handlers['ansible:repair'] = () => new Promise(() => undefined);
      const started = parsed(
        await client.callTool({
          name: 'ansible_repair',
          arguments: { targetId: 'target-1', waitSeconds: 0 },
        }),
      );
      const answer = parsed(
        await client.callTool({
          name: 'operations_cancel',
          arguments: { operationId: started.operationId },
        }),
      );
      expect(answer.cancelled).toBe(true);
      expect(callsTo(harness, 'ansible:cancel')).toEqual([{ streamId: started.operationId }]);
    });
  });

  describe('safety built into the tools', () => {
    it('takes SSH details from the saved target, whatever the caller sends', async () => {
      harness.handlers['ansible:profiles'] = () => [];
      await client.callTool({
        name: 'ansible_run_profile',
        arguments: {
          targetId: 'target-1',
          profileId: 'docker',
          host: '198.51.100.99',
          hostKeySha256: 'ATTACKER-FINGERPRINT',
        },
      });
      expect(callsTo(harness, 'ansible:run')[0]).toMatchObject({
        host: TARGET.host,
        hostKeySha256: TARGET.hostKeySha256,
        sshCredentialId: TARGET.sshCredentialId,
      });
    });

    it('fills in the defaults a person would see in the form', async () => {
      harness.handlers['ansible:profiles'] = () => [
        {
          id: 'jenkins',
          variables: [
            { key: 'service_port', defaultValue: 8080 },
            { key: 'manage_host_firewall', defaultValue: true },
          ],
        },
      ];
      await client.callTool({
        name: 'ansible_run_profile',
        arguments: {
          targetId: 'target-1',
          profileId: 'jenkins',
          variables: { service_port: 9090 },
        },
      });
      expect(callsTo(harness, 'ansible:run')[0]).toMatchObject({
        variables: { service_port: 9090, manage_host_firewall: true },
      });
    });

    it('will not pin a fingerprint this connection did not read itself', async () => {
      const target = {
        name: 'web',
        host: '203.0.113.20',
        username: 'ubuntu',
        sshCredentialId: 'cred-1',
        hostKeySha256: 'SOMETHING',
      };
      const uninspected = await client.callTool({ name: 'targets_create', arguments: target });
      expect(uninspected.isError).toBe(true);
      expect(callsTo(harness, 'ansible:createTarget')).toEqual([]);

      harness.handlers['ansible:inspectHostKey'] = () => ({ fingerprint: 'REAL' });
      await client.callTool({
        name: 'targets_inspect_host_key',
        arguments: { host: '203.0.113.20' },
      });
      const wrong = await client.callTool({ name: 'targets_create', arguments: target });
      expect(wrong.isError).toBe(true);

      const right = await client.callTool({
        name: 'targets_create',
        arguments: { ...target, hostKeySha256: 'REAL' },
      });
      expect(right.isError).toBeUndefined();
      expect(callsTo(harness, 'ansible:createTarget')).toHaveLength(1);
    });

    it('keeps the WordPress admin password out of the answer unless secrets are allowed', async () => {
      harness.handlers['wordpress:create'] = () => ({
        site: { domain: 'blog.example.com' },
        adminPassword: 'generated-secret',
      });
      const site = {
        targetId: 't',
        domain: 'blog.example.com',
        siteTitle: 'Blog',
        adminUser: 'alex',
        adminEmail: 'alex@example.com',
      };
      const hidden = parsed(await client.callTool({ name: 'wordpress_create', arguments: site }));
      expect(JSON.stringify(hidden)).not.toContain('generated-secret');

      harness.settings = {
        ...harness.settings,
        tiers: { ...harness.settings.tiers, secret: true },
      };
      const shown = parsed(await client.callTool({ name: 'wordpress_create', arguments: site }));
      expect(shown.result.adminPassword).toBe('generated-secret');
    });

    it('refuses to overwrite a saved plan without being told to', async () => {
      harness.handlers['infra:getPlan'] = () => ({ providerKind: 'oracle', resources: [] });
      const refused = await client.callTool({
        name: 'infra_apply_template',
        arguments: { templateId: 'web-server' },
      });
      expect(refused.isError).toBe(true);
      expect(callsTo(harness, 'infra:applyTemplate')).toEqual([]);

      const allowed = await client.callTool({
        name: 'infra_apply_template',
        arguments: { templateId: 'web-server', replaceExistingPlan: true, shape: 'custom' },
      });
      expect(allowed.isError).toBeUndefined();
      expect(callsTo(harness, 'infra:applyTemplate')[0]).toMatchObject({ shape: 'custom' });
    });

    it('updates a credential without showing its stored values', async () => {
      harness.handlers['credentials:reveal'] = () => ({
        id: 'c1',
        kind: 'cloudflare',
        name: 'Old',
        data: { apiToken: 'stored-token', accountId: 'acc' },
      });
      harness.handlers['credentials:update'] = (payload: { name: string }) => ({
        id: 'c1',
        name: payload.name,
      });
      const result = await client.callTool({
        name: 'credentials_update',
        arguments: { id: 'c1', name: 'New', data: { accountId: 'other' } },
      });
      expect(callsTo(harness, 'credentials:update')[0]).toMatchObject({
        name: 'New',
        data: { apiToken: 'stored-token', accountId: 'other' },
      });
      expect(JSON.stringify(result)).not.toContain('stored-token');
    });

    it('reads a stack folder without showing the values in its .env', async () => {
      harness.handlers['stacks:chooseFolder'] = () => ({
        folderName: 'app',
        composeFileName: 'compose.yaml',
        composeYaml: 'services: {}',
        environment: 'API_KEY=super-secret\nexport DEBUG=1\n# comment\n',
        hasEnvironment: true,
      });
      harness.handlers['stacks:analyze'] = () => ({ services: [] });
      const result = await client.callTool({
        name: 'stacks_read_folder',
        arguments: { path: '/home/alex/app' },
      });
      expect(parsed(result).environmentVariables).toEqual(['API_KEY', 'DEBUG']);
      expect(JSON.stringify(result)).not.toContain('super-secret');
    });

    it('will not issue a certificate until DNS points at the server', async () => {
      harness.handlers['ssl:verifyDns'] = () => ({
        matches: false,
        status: 'error',
        message: 'It points elsewhere',
      });
      const result = await client.callTool({
        name: 'ssl_issue_certificate',
        arguments: { targetId: 't', domain: 'app.example.com', email: 'alex@example.com' },
      });
      expect(result.isError).toBe(true);
      expect(callsTo(harness, 'ssl:issue')).toEqual([]);
    });
  });

  describe('resources and prompts', () => {
    it('lists and reads resources through the same channels', async () => {
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toContain('cloudforge://targets');
      harness.handlers['ansible:targets'] = () => [TARGET];
      const read = await client.readResource({ uri: 'cloudforge://targets' });
      expect(JSON.parse((read.contents[0] as { text: string }).text)).toEqual([TARGET]);
    });

    it('serves the documentation', async () => {
      const read = await client.readResource({ uri: 'cloudforge://docs/welcome' });
      expect((read.contents[0] as { text: string }).text).toContain('Hello from the docs');
    });

    it('offers guided workflows that use what the user provides', async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toContain('deploy-wordpress');
      const prompt = await client.getPrompt({
        name: 'deploy-wordpress',
        arguments: { domain: 'blog.example.com' },
      });
      expect((prompt.messages[0]!.content as { text: string }).text).toContain('blog.example.com');
    });

    it('tells a subscriber when what it follows changes', async () => {
      await client.subscribeResource({ uri: 'cloudforge://targets' });
      const updated = new Promise<string>((resolve) => {
        client.fallbackNotificationHandler = async (notification): Promise<void> => {
          const params = notification.params as { uri?: string } | undefined;
          if (notification.method === 'notifications/resources/updated') resolve(params?.uri ?? '');
          await Promise.resolve();
        };
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      harness.events.emit('vpsTargets:changed', { reason: 'created' });
      await expect(updated).resolves.toBe('cloudforge://targets');
    });
  });

  it('reports who is connected', () => {
    expect(harness.host.clients().map((item) => item.name)).toEqual(['test-client']);
  });
});

describe('stdio bridge', () => {
  it('carries messages between a stdio client and the server', async () => {
    const harness = createHarness();
    await harness.host.start(0);
    const bridge = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../../resources/mcp/cloudforge-mcp.cjs', import.meta.url))],
      {
        env: { ...process.env, CLOUDFORGE_MCP_URL: harness.host.url!, CLOUDFORGE_MCP_TOKEN: TOKEN },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    try {
      const messages = new Map<number, Record<string, any>>();
      let buffered = '';
      bridge.stdout.setEncoding('utf8');
      bridge.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        let end: number;
        while ((end = buffered.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffered.slice(0, end)) as Record<string, any>;
          buffered = buffered.slice(end + 1);
          if (typeof message.id === 'number') messages.set(message.id, message);
        }
      });
      const answer = async (id: number): Promise<Record<string, any>> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const message = messages.get(id);
          if (message) return message;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`No answer to message ${String(id)}`);
      };
      const send = (message: unknown): void => {
        bridge.stdin.write(`${JSON.stringify(message)}\n`);
      };

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bridge-client', version: '1.0.0' },
        },
      });
      expect((await answer(1)).result.serverInfo.name).toBe('cloudforge');

      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect((await answer(2)).result.tools.length).toBeGreaterThan(100);

      harness.handlers['projects:count'] = () => 3;
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'projects_count', arguments: {} },
      });
      expect((await answer(3)).result.content[0].text).toBe('3');
    } finally {
      bridge.stdin.end();
      bridge.kill();
      await harness.host.stop();
    }
  });

  it('explains itself when CloudForge is not there', async () => {
    const bridge = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../../resources/mcp/cloudforge-mcp.cjs', import.meta.url))],
      {
        env: {
          ...process.env,
          CLOUDFORGE_MCP_URL: 'http://127.0.0.1:9/mcp',
          CLOUDFORGE_MCP_TOKEN: TOKEN,
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    try {
      const line = await new Promise<string>((resolve) => {
        bridge.stdout.setEncoding('utf8');
        bridge.stdout.once('data', (chunk: string) => resolve(chunk));
        bridge.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
        );
      });
      expect((JSON.parse(line) as { error: { message: string } }).error.message).toMatch(
        /CloudForge/,
      );
    } finally {
      bridge.kill();
    }
  });
});
