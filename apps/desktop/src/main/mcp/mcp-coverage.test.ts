import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../../shared/ipc/contract.js';
import { MCP_TOOLS, mcpToolsets } from './catalog/index.js';
import { localFileToolNames } from './catalog/local-files.js';
import { MCP_COVERAGE, MCP_EVENT_COVERAGE } from './coverage.js';
import { toolInputSchema } from './host.js';
import { MCP_PROMPTS } from './prompts.js';

const toolNames = new Set(MCP_TOOLS.map((tool) => tool.name));

describe('MCP coverage of the IPC contract', () => {
  it('decides what happens to every channel', () => {
    const decided = new Set(Object.keys(MCP_COVERAGE));
    expect(IPC_CHANNELS.filter((channel) => !decided.has(channel))).toEqual([]);
  });

  it('names only tools that exist and that really use the channel', () => {
    const wrong = Object.entries(MCP_COVERAGE).flatMap(([channel, decision]) =>
      'excluded' in decision
        ? []
        : decision
            .filter((name) => {
              const tool = MCP_TOOLS.find((item) => item.name === name);
              return !tool || !(tool.channels as readonly string[]).includes(channel);
            })
            .map((name) => `${channel} → ${name}`),
    );
    expect(wrong).toEqual([]);
  });

  it('lists every channel each tool uses', () => {
    const unlisted = MCP_TOOLS.flatMap((tool) =>
      tool.channels
        .filter((channel) => {
          const decision = MCP_COVERAGE[channel];
          return 'excluded' in decision || !decision.includes(tool.name);
        })
        .map((channel) => `${tool.name} → ${channel}`),
    );
    expect(unlisted).toEqual([]);
  });

  it('excludes only what has a reason, and very little', () => {
    const excluded = Object.entries(MCP_COVERAGE).filter(([, decision]) => 'excluded' in decision);
    expect(excluded.map(([channel]) => channel).filter((name) => !name.startsWith('mcp:'))).toEqual(
      ['logs:report'],
    );
  });

  it('never lets a tool reach the channels that manage permissions', () => {
    const reaching = MCP_TOOLS.filter((tool) =>
      tool.channels.some((channel) => channel.startsWith('mcp:')),
    );
    expect(reaching).toEqual([]);
  });

  it('covers every push event', () => {
    const decided = new Set(Object.keys(MCP_EVENT_COVERAGE));
    expect(IPC_EVENT_CHANNELS.filter((channel) => !decided.has(channel))).toEqual([]);
  });
});

describe('MCP tool catalogue', () => {
  it('has unique names every client accepts', () => {
    expect(toolNames.size).toBe(MCP_TOOLS.length);
    const invalid = MCP_TOOLS.filter((tool) => !/^[a-z][a-z0-9_]{1,63}$/.test(tool.name));
    expect(invalid.map((tool) => tool.name)).toEqual([]);
  });

  it('describes every tool', () => {
    expect(MCP_TOOLS.filter((tool) => tool.description.length < 10).map((t) => t.name)).toEqual([]);
  });

  it('produces an input schema for every tool', () => {
    for (const tool of MCP_TOOLS) {
      expect(toolInputSchema(tool).type, tool.name).toBe('object');
    }
  });

  it('never asks a client for ids the server generates itself', () => {
    const asking = MCP_TOOLS.filter(
      (tool) => 'streamId' in tool.input.shape || 'projectId' in tool.input.shape,
    );
    expect(asking.map((tool) => tool.name)).toEqual([]);
  });

  it('takes a saved target, never a fingerprint, for every SSH operation', () => {
    const allowed = new Set(['targets_create', 'targets_update', 'deploy_run']);
    const asking = MCP_TOOLS.filter(
      (tool) => 'hostKeySha256' in tool.input.shape && !allowed.has(tool.name),
    );
    expect(asking.map((tool) => tool.name)).toEqual([]);
  });

  it('marks every tool that hands a secret to the client', () => {
    const secret = MCP_TOOLS.filter((tool) => tool.tier === 'secret').map((tool) => tool.name);
    expect(secret.sort()).toEqual(
      [
        'ansible_get_access',
        'credentials_reveal',
        'ssh_keys_export_private',
        'ssh_keys_materialize_private',
        'ssh_keys_reveal_private',
        'ssl_export_private_key',
        'stacks_reveal',
      ].sort(),
    );
  });

  it('asks a person before anything that deletes, destroys or grants access', () => {
    const mustAsk = [
      'projects_delete',
      'projects_remove_passkey',
      'projects_change_passkey',
      'credentials_delete',
      'ssh_keys_delete',
      'providers_terminate_instance',
      'providers_stop_instance',
      'providers_reboot_instance',
      'cloud_firewall_update',
      'infra_apply',
      'infra_keep_trying',
      'infra_destroy',
      'infra_destroy_stack',
      'infra_delete_custom_template',
      'targets_delete',
      'ansible_remove_nginx_site',
      'containers_stop',
      'containers_remove',
      'runtime_apply',
      'host_firewall_close',
      'host_access_grant',
      'host_access_revoke',
      'nginx_remove_site',
      'nginx_save_config',
      'nginx_restore_backup',
      'cloudflare_delete_zone',
      'cloudflare_delete_dns_record',
      'cloudflare_batch_repoint',
      'cloudflare_batch_delete',
      'cloudflare_withdraw_dns',
      'cloudflare_purge_cache',
      'cloudflare_delete_page_rule',
      'cloudflare_delete_redirect_rule',
      'wordpress_remove',
      'stacks_remove',
      'jenkins_delete_pipeline',
      'backup_restore_project',
      'updates_install',
    ];
    const notCritical = mustAsk.filter(
      (name) => MCP_TOOLS.find((tool) => tool.name === name)?.tier !== 'critical',
    );
    expect(notCritical).toEqual([]);
  });

  it('accounts for every tool that takes a path on this computer', () => {
    // Paths inside a repository or on a server are not paths on this computer.
    const elsewhere = new Set(['jenkinsfilePath', 'certificatePath']);
    const takesPath = MCP_TOOLS.filter((tool) =>
      Object.keys(tool.input.shape).some((key) => /path$|dir$/i.test(key) && !elsewhere.has(key)),
    ).map((tool) => tool.name);
    expect(localFileToolNames().sort()).toEqual(takesPath.sort());
  });

  it('keeps shell access in its own tier', () => {
    const terminal = MCP_TOOLS.filter((tool) => tool.toolset === 'terminal');
    expect(terminal.length).toBeGreaterThan(0);
    expect(terminal.every((tool) => tool.tier === 'shell')).toBe(true);
  });

  it('puts every tool in a toolset the user can see, except the always-on one', () => {
    const known = new Set(mcpToolsets().map((toolset) => toolset.id));
    const orphans = MCP_TOOLS.filter((tool) => tool.toolset !== 'core' && !known.has(tool.toolset));
    expect(orphans.map((tool) => tool.name)).toEqual([]);
    expect(mcpToolsets().every((toolset) => toolset.tools > 0)).toBe(true);
  });

  it('marks an operation only where its log channel can be followed', () => {
    const noOwnStream = MCP_TOOLS.filter(
      (tool) =>
        tool.operation?.logChannel &&
        !tool.channels.some((channel) =>
          [
            'infra:',
            'deploy:',
            'ansible:',
            'nginx:',
            'runtime:',
            'ssl:',
            'wordpress:',
            'stacks:',
          ].some((prefix) => channel.startsWith(prefix)),
        ),
    );
    expect(noOwnStream.map((tool) => tool.name)).toEqual([]);
  });
});

describe('MCP prompts', () => {
  it('only recommends tools that exist', () => {
    const unknown = MCP_PROMPTS.flatMap((prompt) => {
      const text = prompt.text({});
      return [...text.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)]
        .map((match) => match[0])
        .filter(
          (word) =>
            !toolNames.has(word) &&
            !['database_password', 'service_port', 'needs_repair'].includes(word),
        )
        .map((word) => `${prompt.name}: ${word}`);
    });
    expect(unknown).toEqual([]);
  });
});
