import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PulumiEngine } from './pulumi-engine.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
