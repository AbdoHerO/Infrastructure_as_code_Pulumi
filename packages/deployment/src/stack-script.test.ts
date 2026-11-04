import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderStackOverride } from '@cloudforge/core';
import { parsesAsShell } from './shell-syntax.test-helper.js';
import {
  deployStackScript,
  parseStackStatus,
  parseUsedPorts,
  removeStackScript,
  stackDirectory,
  stackStatusScript,
  usedPortsScript,
} from './stack-script.js';

const UPLOAD = '0f8fad5b-d9cb-469f-a165-70867728950e';

function deploy(overrides: Partial<Parameters<typeof deployStackScript>[0]> = {}): string {
  return deployStackScript({
    project: 'rustfs',
    overrideYaml: 'services: {}\n',
    externalNetworks: ['backend.preprod'],
    externalVolumes: ['rustfs.prod'],
    containerNames: ['rustfs.prod'],
    hostPorts: [8400, 8401],
    composeFile: `/tmp/cloudforge-stack-${UPLOAD}.yaml`,
    environmentFile: `/tmp/cloudforge-stack-${UPLOAD}.env`,
    ...overrides,
  });
}

describe('stack scripts', () => {
  it.each([
    ['deploy', deploy()],
    [
      'deploy with nothing external and no route',
      deploy({ externalNetworks: [], externalVolumes: [], containerNames: [], hostPorts: [] }),
    ],
    ['status', stackStatusScript('rustfs', [8400])],
    ['status without a route', stackStatusScript('rustfs', [])],
    ['remove and keep data', removeStackScript('rustfs', false)],
    ['remove with data', removeStackScript('rustfs', true)],
    ['used ports', usedPortsScript()],
  ])('generates a script that parses: %s', (_name, script) => {
    expect(parsesAsShell(script)).toBe(true);
  });

  it('never carries the Compose file or .env: they arrive as uploaded files', () => {
    const script = deploy();
    expect(script).toContain('install -m 600 "$COMPOSE_UPLOAD" "$STAGING/compose.yaml"');
    expect(script).toContain('install -m 600 "$ENV_UPLOAD" "$STAGING/.env"');
    expect(script).toContain('trap \'rm -f "$COMPOSE_UPLOAD" "$ENV_UPLOAD"');
  });

  it('validates a new file in staging before touching the running stack', () => {
    const script = deploy();
    const validated = script.indexOf('(cd "$STAGING" && compose config -q)');
    const moved = script.indexOf('mv -f "$STAGING/compose.yaml"');
    const started = script.indexOf('compose up -d --remove-orphans');
    expect(validated).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(validated);
    expect(started).toBeGreaterThan(moved);
  });

  it('stops before any change when something else owns the name, a container or a port', () => {
    const script = deploy();
    const firstChange = script.indexOf('install -d -m 700');
    for (const guard of [
      'already runs on this server, not deployed by CloudForge',
      'Port 8400 is already used',
      'Port 8401 is already used',
      'A container named rustfs.prod already exists',
    ]) {
      expect(script).toContain(guard);
      expect(script.indexOf(guard)).toBeLessThan(firstChange);
    }
    expect(script).toContain('was not created by CloudForge');
  });

  it('creates external networks and volumes only when they are missing', () => {
    const script = deploy();
    expect(script).toContain("if ! docker network inspect 'backend.preprod'");
    expect(script).toContain("docker network create 'backend.preprod'");
    expect(script).toContain("if ! docker volume inspect 'rustfs.prod'");
    expect(script).toContain("docker volume create 'rustfs.prod'");
  });

  it('does not fail on an image built on the server, which has no registry', () => {
    expect(deploy()).toContain('compose pull --quiet --ignore-pull-failures');
  });

  it('deletes data only when asked, and never an external resource by name', () => {
    expect(removeStackScript('rustfs', false)).not.toContain('--volumes');
    expect(removeStackScript('rustfs', false)).not.toContain('rm -rf');
    const deleted = removeStackScript('rustfs', true);
    expect(deleted).toContain('compose down --remove-orphans --volumes');
    expect(deleted).toContain('rm -rf "$DIR"');
    expect(deleted).not.toContain('docker volume rm');
    expect(deleted).not.toContain('docker network rm');
  });

  it('refuses names, ports and upload paths that could escape the stack folder', () => {
    expect(() => stackDirectory('../etc')).toThrow();
    expect(() => stackDirectory('a;rm')).toThrow();
    expect(() => stackDirectory('Upper')).toThrow();
    expect(() => deploy({ hostPorts: [80] })).toThrow();
    expect(() => deploy({ composeFile: '/etc/shadow' })).toThrow();
    expect(() => deploy({ environmentFile: '/tmp/../etc/passwd' })).toThrow();
  });

  it('quotes names, so one cannot run a command', () => {
    expect(deploy({ externalNetworks: ["x'; reboot; '"] })).toContain(
      `docker network inspect 'x'"'"'; reboot; '"'"''`,
    );
  });
});

describe('renderStackOverride', () => {
  it('publishes each route on loopback only and labels every service', () => {
    const document = parse(
      renderStackOverride({
        name: 'rustfs',
        services: ['rustfs', 'worker'],
        routes: [
          { domain: 'files.example.com', service: 'rustfs', containerPort: 9001, hostPort: 8400 },
          { domain: 's3.example.com', service: 'rustfs', containerPort: 9000, hostPort: 8401 },
        ],
      }),
    ) as { services: Record<string, { ports?: string[]; labels: Record<string, string> }> };
    expect(document.services.rustfs?.ports).toEqual(['127.0.0.1:8400:9001', '127.0.0.1:8401:9000']);
    expect(document.services.worker?.ports).toBeUndefined();
    expect(document.services.worker?.labels).toMatchObject({
      'com.cloudforge.managed': 'true',
      'com.cloudforge.stack': 'rustfs',
    });
  });

  it('accepts service names with dots', () => {
    const document = parse(
      renderStackOverride({ name: 'a', services: ['web.prod'], routes: [] }),
    ) as { services: Record<string, unknown> };
    expect(Object.keys(document.services)).toEqual(['web.prod']);
  });
});

describe('parsers', () => {
  it('reads containers and port states, and ignores the log around them', () => {
    expect(
      parseStackStatus(
        [
          '==> Starting the stack',
          ' Container rustfs.prod  Started',
          '@@CONTAINER|rustfs|rustfs.prod|running|healthy|rustfs/rustfs:1.0.4',
          '@@PORT|8400|open',
          '@@PORT|8401|closed',
          '@@PORT|8402|nonsense',
        ].join('\n'),
      ),
    ).toEqual({
      containers: [
        {
          service: 'rustfs',
          name: 'rustfs.prod',
          state: 'running',
          health: 'healthy',
          image: 'rustfs/rustfs:1.0.4',
        },
      ],
      ports: [
        { port: 8400, state: 'open' },
        { port: 8401, state: 'closed' },
      ],
    });
  });

  it('collects ports from ss and from what Docker publishes, including ranges', () => {
    expect(
      parseUsedPorts(
        [
          '@@LISTEN|22',
          '@@LISTEN|80',
          '@@LISTEN|LISTEN',
          '@@DOCKER|127.0.0.1:8091->80/tcp',
          '@@DOCKER|0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp',
          '@@DOCKER|6333-6334/tcp',
          '@@DOCKER|0.0.0.0:7000-7002->7000-7002/tcp',
          '@@DOCKER|',
        ].join('\n'),
      ),
    ).toEqual([22, 80, 3000, 7000, 7001, 7002, 8091]);
  });
});
