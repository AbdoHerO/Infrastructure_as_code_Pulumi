import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IpcEventChannel } from '../../shared/ipc/contract.js';
import { DEFAULT_MCP_SETTINGS } from '../../shared/mcp/types.js';
import { McpApprovals } from './approvals.js';
import { environmentVariableNames } from './catalog/common.js';
import { type EventSubscriber, OperationManager } from './operations.js';
import { describeCall, maskArguments } from './redaction.js';
import {
  applyMcpSettingsPatch,
  createMcpToken,
  mcpTokenMatches,
  normalizeMcpSettings,
} from './settings.js';
import { TerminalBuffers } from './terminal-buffers.js';

function bus(): { events: EventEmitter; subscribe: EventSubscriber } {
  const events = new EventEmitter();
  return {
    events,
    subscribe: ((channel: IpcEventChannel, listener: (payload: unknown) => void) => {
      events.on(channel, listener);
      return () => events.off(channel, listener);
    }) as unknown as EventSubscriber,
  };
}

describe('MCP settings', () => {
  it('starts switched off, with secrets and shell off and critical actions asking', () => {
    expect(DEFAULT_MCP_SETTINGS).toMatchObject({
      enabled: false,
      allowProjectSwitch: false,
      tiers: { secret: false, shell: false, critical: 'ask' },
    });
  });

  it.each([null, 'nonsense', 42, { tiers: 'nope', port: 'x', enabled: 'yes' }])(
    'falls back to the cautious defaults for unreadable data %#',
    (raw) => {
      expect(normalizeMcpSettings(raw)).toEqual(DEFAULT_MCP_SETTINGS);
    },
  );

  it('refuses an out-of-range port and an unknown critical mode', () => {
    expect(normalizeMcpSettings({ port: 80 }).port).toBe(DEFAULT_MCP_SETTINGS.port);
    expect(normalizeMcpSettings({ tiers: { critical: 'always' } }).tiers.critical).toBe('ask');
  });

  it('changes only what a patch names', () => {
    const next = applyMcpSettingsPatch(DEFAULT_MCP_SETTINGS, { tiers: { secret: true } });
    expect(next.tiers.secret).toBe(true);
    expect(next.tiers.critical).toBe('ask');
    expect(next.port).toBe(DEFAULT_MCP_SETTINGS.port);
  });
});

describe('MCP token', () => {
  it('is long and different each time', () => {
    const token = createMcpToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(createMcpToken()).not.toBe(token);
  });

  it('matches only itself, whatever the length of the attempt', () => {
    expect(mcpTokenMatches('abc', 'abc')).toBe(true);
    expect(mcpTokenMatches('abc', 'abd')).toBe(false);
    expect(mcpTokenMatches('abc', '')).toBe(false);
    expect(mcpTokenMatches('abc', 'abcdefgh')).toBe(false);
  });
});

describe('approvals', () => {
  const approvals = (timeoutSeconds = 60): McpApprovals =>
    new McpApprovals({ timeoutSeconds: () => timeoutSeconds, onChanged: () => undefined });
  const request = { client: 'c', tool: 't', title: 'T', summary: 's' };

  it('waits for a decision and carries it back', async () => {
    const queue = approvals();
    const decision = queue.request(request);
    expect(queue.pending()).toHaveLength(1);
    queue.resolve(queue.pending()[0]!.id, true);
    await expect(decision).resolves.toBe(true);
    expect(queue.pending()).toEqual([]);
  });

  it('treats silence as a refusal', async () => {
    vi.useFakeTimers();
    try {
      const decision = approvals(30).request(request);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(decision).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses everything still waiting when the server stops', async () => {
    const queue = approvals();
    const decisions = [queue.request(request), queue.request(request)];
    queue.refuseAll();
    await expect(Promise.all(decisions)).resolves.toEqual([false, false]);
  });

  it('ignores a decision about a request that is gone', () => {
    expect(() => approvals().resolve('nothing', true)).not.toThrow();
  });

  it('tells the window every time the list changes', async () => {
    const onChanged = vi.fn();
    const queue = new McpApprovals({ timeoutSeconds: () => 60, onChanged });
    const decision = queue.request(request);
    expect(onChanged).toHaveBeenCalledTimes(1);
    queue.resolve(queue.pending()[0]!.id, false);
    await decision;
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenLastCalledWith([]);
  });
});

describe('masking arguments', () => {
  it('hides anything that looks secret, however deep', () => {
    const masked = JSON.stringify(
      maskArguments({
        domain: 'example.com',
        passkey: 'one',
        adminPassword: 'two',
        apiToken: 'three',
        privateKey: 'four',
        environment: 'five',
        composeYaml: 'six',
        nested: { data: { clientSecret: 'seven' } },
      }),
    );
    expect(masked).toContain('example.com');
    for (const secret of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
      expect(masked).not.toContain(`"${secret}"`);
    }
  });

  it('shortens long values', () => {
    expect((maskArguments({ note: 'x'.repeat(500) }) as { note: string }).note.length).toBe(201);
  });

  it('says what a call does, with its details when there are any', () => {
    expect(describeCall('Do a thing.', {})).toBe('Do a thing.');
    expect(describeCall('Do a thing.', { name: 'alpha' })).toContain('alpha');
  });
});

describe('environment variable names', () => {
  it('finds the names and never the values', () => {
    expect(environmentVariableNames('A=1\r\nexport B = two\n# C=3\n\nnot a line\nD_4=')).toEqual([
      'A',
      'B',
      'D_4',
    ]);
  });
});

describe('operation manager', () => {
  const start = (
    manager: OperationManager,
    run: () => Promise<unknown>,
    extra: Partial<Parameters<OperationManager['start']>[0]> = {},
  ): ReturnType<OperationManager['start']> =>
    manager.start({
      id: 'op-1',
      tool: 'nginx_reload',
      client: 'test',
      logChannel: 'nginx:log',
      cancel: null,
      run,
      ...extra,
    });

  it('collects only the lines of its own stream, marked by kind', async () => {
    const { events, subscribe } = bus();
    const manager = new OperationManager(subscribe);
    let finish = (): void => undefined;
    start(manager, () => new Promise<void>((resolve) => (finish = resolve)));
    const line = (streamId: string, stream: string, message: string): boolean =>
      events.emit('nginx:log', { streamId, event: { stream, message } });
    line('op-1', 'step', 'Testing');
    line('other', 'stdout', 'Not mine');
    line('op-1', 'stdout', 'ok  ');
    line('op-1', 'stderr', 'warning');
    line('op-1', 'stdout', '   ');
    finish();
    await manager.wait('op-1', 1000);
    expect(manager.tail('op-1', 10)).toEqual(['▶ Testing', 'ok', '! warning']);
  });

  it('stops following the stream once finished', async () => {
    const { events, subscribe } = bus();
    const manager = new OperationManager(subscribe);
    start(manager, () => Promise.resolve('done'));
    await manager.wait('op-1', 1000);
    expect(events.listenerCount('nginx:log')).toBe(0);
    expect(manager.get('op-1')).toMatchObject({ status: 'succeeded', result: 'done' });
  });

  it('records a failure with its code', async () => {
    const { subscribe } = bus();
    const manager = new OperationManager(subscribe);
    start(manager, () => Promise.reject(Object.assign(new Error('Nope'), { code: 'BAD' })));
    await expect(manager.wait('op-1', 1000)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'BAD', message: 'Nope' },
    });
  });

  it('returns where it stands when the wait runs out', async () => {
    const { subscribe } = bus();
    const manager = new OperationManager(subscribe);
    start(manager, () => new Promise(() => undefined));
    await expect(manager.wait('op-1', 1)).resolves.toMatchObject({ status: 'running' });
  });

  it('keeps cursors valid when old lines scroll out', () => {
    const { events, subscribe } = bus();
    const manager = new OperationManager(subscribe);
    start(manager, () => new Promise(() => undefined));
    for (let index = 0; index < 2100; index += 1) {
      events.emit('nginx:log', {
        streamId: 'op-1',
        event: { stream: 'stdout', message: `${index}` },
      });
    }
    const first = manager.logs('op-1', 0, 10)!;
    expect(first.missedLines).toBe(100);
    expect(first.lines[0]).toBe('100');
    expect(first.nextCursor).toBe(110);
    expect(manager.logs('op-1', first.nextCursor, 1)!.lines).toEqual(['110']);
  });

  it('forgets finished operations after an hour, not running ones', async () => {
    const { subscribe } = bus();
    let now = 1_000_000;
    const manager = new OperationManager(subscribe, () => now);
    start(manager, () => Promise.resolve());
    await manager.wait('op-1', 1000);
    start(manager, () => new Promise(() => undefined), { id: 'op-2' });
    now += 61 * 60_000;
    expect(manager.list().map((item) => item.operationId)).toEqual(['op-2']);
  });

  it('only claims to cancel what it can', async () => {
    const { subscribe } = bus();
    const manager = new OperationManager(subscribe);
    start(manager, () => new Promise(() => undefined));
    await expect(manager.cancel('op-1')).resolves.toMatchObject({ cancelled: false });
    await expect(manager.cancel('missing')).resolves.toMatchObject({ cancelled: false });

    const cancel = vi.fn(() => Promise.resolve());
    start(manager, () => new Promise(() => undefined), { id: 'op-2', cancel });
    await expect(manager.cancel('op-2')).resolves.toMatchObject({ cancelled: true });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('terminal buffers', () => {
  it('keeps output per session and reads from a cursor', () => {
    const { events, subscribe } = bus();
    const buffers = new TerminalBuffers(subscribe);
    buffers.track('s1');
    events.emit('terminal:data', { sessionId: 's1', data: 'hello ' });
    events.emit('terminal:data', { sessionId: 's2', data: 'other' });
    const first = buffers.read('s1')!;
    expect(first.output).toBe('hello ');
    events.emit('terminal:data', { sessionId: 's1', data: 'world' });
    expect(buffers.read('s1', first.nextCursor)!.output).toBe('world');
  });

  it('reports when the session closes, with the reason', () => {
    const { events, subscribe } = bus();
    const buffers = new TerminalBuffers(subscribe);
    buffers.track('s1');
    events.emit('terminal:closed', { sessionId: 's1', reason: 'SSH connection lost' });
    expect(buffers.read('s1')).toMatchObject({ closed: true, closedReason: 'SSH connection lost' });
  });

  it('stops following a forgotten session', () => {
    const { events, subscribe } = bus();
    const buffers = new TerminalBuffers(subscribe);
    buffers.track('s1');
    buffers.forget('s1');
    expect(buffers.read('s1')).toBeNull();
    expect(events.listenerCount('terminal:data')).toBe(0);
  });
});
