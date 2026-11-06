import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/ipc/contract.js';
import { knowsModule, queryRootsForChannels } from './mcp-sync.js';

describe('queryRootsForChannels', () => {
  it('knows every module in the contract', () => {
    const modules = new Set(IPC_CHANNELS.map((channel) => channel.split(':')[0]!));
    expect([...modules].filter((module) => !knowsModule(module))).toEqual([]);
  });

  it('always reloads the activity feed, which records the change', () => {
    expect([...queryRootsForChannels(['backup:create'])]).toEqual(['activity']);
  });

  it('reloads what a change can reach', () => {
    const roots = queryRootsForChannels(['stacks:create', 'credentials:create']);
    expect(roots).toContain('stacks');
    expect(roots).toContain('nginx');
    expect(roots).toContain('credentials');
    expect(roots).not.toContain('jenkins');
  });

  it('reloads the VPS target list', () => {
    expect(queryRootsForChannels(['ansible:createTarget'])).toContain('ansible');
  });
});
