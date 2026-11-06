import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffKind } from '@pulumi/pulumi/automation';
import {
  capturePreviewChange,
  PulumiEngine,
  removeTemporaryWorkspace,
  toProgressEvent,
} from './pulumi-engine.js';
import type { PreviewResourceChange } from '@cloudforge/core';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('PulumiEngine structured progress', () => {
  const metadata = {
    op: 'create' as const,
    urn: 'urn:pulumi:development::app::oci:Core/instance:Instance::server',
    type: 'oci:Core/instance:Instance',
    provider: 'provider',
  };

  it('maps resource start and completion to in-progress and ready stages', () => {
    const started = toProgressEvent({
      sequence: 1,
      timestamp: 1,
      resourcePreEvent: { metadata },
    });
    const completed = toProgressEvent({
      sequence: 2,
      timestamp: 2,
      resOutputsEvent: { metadata },
    });

    expect(started?.progress).toEqual({
      scope: 'resource',
      status: 'in-progress',
      label: 'Creating Instance “server”',
      operation: 'create',
      resource: { name: 'server', type: 'Instance' },
    });
    expect(completed?.progress?.status).toBe('ready');
    expect(completed?.progress?.label).toBe('Instance “server” ready');
  });

  it('does not report a failed operation summary as ready', () => {
    const successfulDestroy = toProgressEvent(
      {
        sequence: 3,
        timestamp: 3,
        summaryEvent: {
          maybeCorrupt: false,
          durationSeconds: 75,
          resourceChanges: {},
          policyPacks: {},
        },
      },
      false,
      'destroy',
    );
    const summary = toProgressEvent(
      {
        sequence: 4,
        timestamp: 4,
        summaryEvent: {
          maybeCorrupt: false,
          durationSeconds: 75,
          resourceChanges: {},
          policyPacks: {},
        },
      },
      true,
    );

    expect(summary?.progress).toMatchObject({
      scope: 'operation',
      status: 'failed',
    });
    expect(successfulDestroy?.progress?.label).toBe('Infrastructure destroyed in 1m 15s');
  });

  it('does not let a late cancellation event overwrite a successful destroy summary', () => {
    const event = toProgressEvent(
      { sequence: 5, timestamp: 5, cancelEvent: {} },
      false,
      'destroy',
      true,
    );

    expect(event).toBeNull();
  });

  it('captures replacement properties from the real preview event', () => {
    const changes = new Map<string, PreviewResourceChange>();
    capturePreviewChange(
      {
        sequence: 5,
        timestamp: 5,
        resourcePreEvent: {
          planning: true,
          metadata: {
            ...metadata,
            op: 'replace',
            keys: ['availabilityDomain'],
            diffs: ['shapeConfig.ocpus'],
            detailedDiff: {
              availabilityDomain: { diffKind: DiffKind.updateReplace, inputDiff: true },
            },
          },
        },
      },
      changes,
    );

    expect(changes.get(metadata.urn)).toMatchObject({
      operation: 'replace',
      destructive: true,
      replacementProperties: ['availabilityDomain'],
    });
  });
});

describe('PulumiEngine managed stack discovery', () => {
  it('lists real resources without exposing checkpoint inputs or outputs', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'cloudforge-state-'));
    created.push(stateDir);
    const stackDir = join(stateDir, '.pulumi', 'stacks', 'old-project-12345678');
    await mkdir(stackDir, { recursive: true });
    await writeFile(
      join(stackDir, 'development.json'),
      JSON.stringify({
        version: 3,
        checkpoint: {
          latest: {
            manifest: { time: '2026-07-13T18:27:26.000Z' },
            resources: [
              { type: 'pulumi:pulumi:Stack', urn: 'urn::stack' },
              {
                type: 'pulumi:providers:oci',
                urn: 'urn:pulumi:development::old::pulumi:providers:oci::oci',
                id: 'provider-id',
                inputs: { privateKey: 'must-not-leak' },
              },
              {
                type: 'oci:Core/vcn:Vcn',
                urn: 'urn:pulumi:development::old::oci:Core/vcn:Vcn::network',
                id: 'ocid1.vcn.example',
                outputs: { secret: 'must-not-leak' },
              },
            ],
          },
        },
      }),
    );

    const engine = new PulumiEngine({
      home: join(stateDir, 'home'),
      stateDir,
      backendUrl: `file://${stateDir}`,
      passphrase: 'test-only',
    });

    const result = await engine.listManagedStacks();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        ref: { project: 'old-project-12345678', stack: 'development' },
        updatedAt: '2026-07-13T18:27:26.000Z',
        resources: [
          { name: 'oci', type: 'Provider', provider: 'oci' },
          { name: 'network', type: 'Vcn', provider: 'oci' },
        ],
      },
    ]);
    expect(JSON.stringify(result.value)).not.toContain('must-not-leak');
  });
});

describe('PulumiEngine attempt cleanup', () => {
  const ref = { project: 'demo-12345678', stack: 'production' };
  const since = new Date('2030-01-02T00:00:00.000Z');

  async function setup(): Promise<{ root: string; home: string; engine: PulumiEngine }> {
    const root = await mkdtemp(join(tmpdir(), 'cloudforge-prune-'));
    created.push(root);
    const home = join(root, 'home');
    return {
      root,
      home,
      engine: new PulumiEngine({
        home,
        stateDir: root,
        backendUrl: `file://${root}`,
        passphrase: 'test-only',
      }),
    };
  }

  async function touch(directory: string, name: string, at: Date): Promise<void> {
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    await writeFile(path, 'x');
    await utimes(path, at, at);
  }

  function minutesAfter(minutes: number): Date {
    return new Date(since.getTime() + minutes * 60_000);
  }

  it('keeps the newest files of the run and removes the rest', async () => {
    const { root, engine } = await setup();
    const history = join(root, '.pulumi', 'history', ref.project, ref.stack);
    for (let index = 0; index < 50; index += 1)
      await touch(history, `production-${String(index)}.history.json`, minutesAfter(index));

    const result = await engine.pruneAttemptHistory(ref, since);

    expect(result.ok).toBe(true);
    const left = await readdir(history);
    expect(left).toHaveLength(40);
    expect(left).toContain('production-49.history.json');
    expect(left).toContain('production-10.history.json');
    expect(left).not.toContain('production-9.history.json');
  });

  it('never touches files from before the run, however many there are', async () => {
    const { root, engine } = await setup();
    const backups = join(root, '.pulumi', 'backups', ref.project, ref.stack);
    for (let index = 0; index < 60; index += 1)
      await touch(backups, `production.${String(index)}.json`, new Date('2029-06-01T00:00:00Z'));
    for (let index = 0; index < 60; index += 1)
      await touch(backups, `production.new-${String(index)}.json`, minutesAfter(index));

    await engine.pruneAttemptHistory(ref, since);

    const left = await readdir(backups);
    expect(left.filter((name) => name.startsWith('production.new-'))).toHaveLength(40);
    expect(left.filter((name) => !name.startsWith('production.new-'))).toHaveLength(60);
  });

  it('never touches the state of the stack', async () => {
    const { root, engine } = await setup();
    const stacks = join(root, '.pulumi', 'stacks', ref.project);
    await touch(stacks, 'production.json', minutesAfter(1));
    await touch(stacks, 'production.json.bak', minutesAfter(1));
    const history = join(root, '.pulumi', 'history', ref.project, ref.stack);
    for (let index = 0; index < 50; index += 1)
      await touch(history, `production-${String(index)}.history.json`, minutesAfter(index));

    await engine.pruneAttemptHistory(ref, since);

    expect((await readdir(stacks)).sort()).toEqual(['production.json', 'production.json.bak']);
  });

  it('never touches the logs and workspaces of another project', async () => {
    const { home, engine } = await setup();
    const logs = join(home, 'logs');
    const workspaces = join(home, 'workspaces');
    const hash = 'a'.repeat(40);
    for (let index = 0; index < 50; index += 1) {
      const stamp = String(index).padStart(2, '0');
      await touch(logs, `organization+demo-12345678+production-${stamp}.log`, minutesAfter(index));
      await touch(
        logs,
        `organization+demo-12345678-other+production-${stamp}.log`,
        minutesAfter(index),
      );
      await touch(
        workspaces,
        `demo-12345678-${hash.slice(0, 38)}${stamp}-workspace.json`,
        minutesAfter(index),
      );
      await touch(
        workspaces,
        `demo-12345678-other-${hash}${stamp}-workspace.json`,
        minutesAfter(index),
      );
    }

    await engine.pruneAttemptHistory(ref, since);

    const leftLogs = await readdir(logs);
    expect(leftLogs.filter((name) => name.includes('12345678+production'))).toHaveLength(40);
    expect(leftLogs.filter((name) => name.includes('-other+'))).toHaveLength(50);
    const leftWorkspaces = await readdir(workspaces);
    expect(leftWorkspaces.filter((name) => !name.includes('-other-'))).toHaveLength(40);
    expect(leftWorkspaces.filter((name) => name.includes('-other-'))).toHaveLength(50);
  });

  it('does nothing when the folders do not exist yet', async () => {
    const { engine } = await setup();
    expect((await engine.pruneAttemptHistory(ref, since)).ok).toBe(true);
  });

  it('refuses a stack name that could leave its folder', async () => {
    const { root, engine } = await setup();
    const outside = join(root, 'outside');
    for (let index = 0; index < 50; index += 1)
      await touch(outside, `file-${String(index)}`, minutesAfter(index));

    const escape = { project: '..', stack: '../../outside' };
    expect((await engine.pruneAttemptHistory(escape, since)).ok).toBe(true);
    expect(await readdir(outside)).toHaveLength(50);
  });
});

describe('removeTemporaryWorkspace', () => {
  it('removes the folder the SDK made for an operation', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'automation-'));
    created.push(folder);
    await writeFile(join(folder, 'Pulumi.yaml'), 'name: demo');

    // The SDK builds this path with forward slashes on Windows.
    await removeTemporaryWorkspace(folder.replace(/\\/g, '/'));

    await expect(readdir(folder)).rejects.toThrow();
  });

  it('leaves any other folder alone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cloudforge-keep-'));
    created.push(parent);
    const lookalike = join(parent, 'automation-mine');
    await mkdir(lookalike);
    const other = await mkdtemp(join(tmpdir(), 'cloudforge-keep-'));
    created.push(other);

    await removeTemporaryWorkspace(lookalike);
    await removeTemporaryWorkspace(other);

    await expect(readdir(lookalike)).resolves.toEqual([]);
    await expect(readdir(other)).resolves.toEqual([]);
  });
});
