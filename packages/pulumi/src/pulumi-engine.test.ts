import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffKind } from '@pulumi/pulumi/automation';
import { capturePreviewChange, PulumiEngine, toProgressEvent } from './pulumi-engine.js';
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
