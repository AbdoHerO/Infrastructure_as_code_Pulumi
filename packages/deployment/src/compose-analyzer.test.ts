import { describe, expect, it } from 'vitest';
import { analyzeCompose } from './compose-analyzer.js';

/** A real stack: no published port, an external network and an external volume. */
const OBJECT_STORAGE = `services:
  rustfs:
    image:  rustfs/rustfs:1.0.4
    container_name: rustfs.prod
    restart: always
    env_file:
      - .env
    volumes:
      - rustfs.prod:/data
    networks:
      - backend.preprod

volumes:
  rustfs.prod:
    external: true

networks:
  backend.preprod:
    external: true
`;
const ENV = 'RUSTFS_ACCESS_KEY=key\nRUSTFS_SECRET_KEY=secret\n';

function compose(service: string, rest = ''): string {
  return `services:\n  app:\n    image: nginx:stable\n${service}\n${rest}`;
}

describe('analyzeCompose', () => {
  it('understands a stack with external resources and no published port', () => {
    const analysis = analyzeCompose(OBJECT_STORAGE, ENV);
    expect(analysis.errors).toEqual([]);
    expect(analysis.warnings).toEqual([]);
    expect(analysis.services).toEqual([
      {
        name: 'rustfs',
        image: 'rustfs/rustfs:1.0.4',
        containerName: 'rustfs.prod',
        ports: [],
        hostNetwork: false,
      },
    ]);
    expect(analysis.externalNetworks).toEqual(['backend.preprod']);
    expect(analysis.externalVolumes).toEqual(['rustfs.prod']);
  });

  it('never returns a value from the .env', () => {
    const analysis = analyzeCompose(OBJECT_STORAGE, 'RUSTFS_SECRET_KEY=hunter2\nnot a line\n');
    expect(JSON.stringify(analysis)).not.toContain('hunter2');
    expect(analysis.warnings.join(' ')).toContain('line 2');
  });

  it('warns when the file reads a .env that is empty', () => {
    expect(analyzeCompose(OBJECT_STORAGE, '').warnings.join(' ')).toContain('.env file is empty');
  });

  it.each([
    ['empty text', ''],
    ['broken YAML', 'services: [unclosed'],
    ['no services', 'volumes: {}\n'],
    ['a stack built from source', 'services:\n  app:\n    build: .\n'],
    ['a service without an image', 'services:\n  app:\n    restart: always\n'],
    ['an include', 'include:\n  - other.yaml\nservices:\n  app:\n    image: nginx\n'],
    ['another env file', compose('    env_file: secrets.env')],
    ['another file to extend', compose('    extends:\n      file: base.yaml\n      service: x')],
    ['a required variable', compose('    environment:\n      A: ${MISSING:?set it}')],
    [
      'an external name with a variable',
      compose('', 'volumes:\n  v:\n    external: true\n    name: ${V}\n'),
    ],
  ])('refuses %s', (_name, yaml) => {
    expect(analyzeCompose(yaml, '').errors.length).toBeGreaterThan(0);
  });

  it('keeps YAML errors short, because the parser quotes the file', () => {
    const analysis = analyzeCompose('services:\n  app: [\n  password: hunter2', '');
    expect(analysis.errors[0]).toContain('not valid YAML');
    expect(analysis.errors[0]).not.toContain('hunter2');
  });

  it('reads every form of ports and expose, and warns about public ones only', () => {
    const analysis = analyzeCompose(
      compose(`    ports:
      - "127.0.0.1:8080:80"
      - "9000:9001/tcp"
      - "\${WEB_PORT:-3000}:3000"
      - target: 7000
        published: 7001
        host_ip: 127.0.0.1
    expose:
      - "5000"
      - 6000/tcp`),
      '',
    );
    expect(analysis.services[0]?.ports).toEqual([80, 3000, 5000, 6000, 7000, 9001]);
    const publicPorts = analysis.warnings.filter((text) => text.includes('all interfaces'));
    expect(publicPorts).toHaveLength(2);
    expect(publicPorts.join(' ')).toContain('port 9000');
  });

  it('warns about what can take over the server, or start empty', () => {
    const warnings = analyzeCompose(
      compose(`    privileged: true
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./config:/config
      - named:/data`),
      '',
    ).warnings.join(' ');
    expect(warnings).toContain('privileged');
    expect(warnings).toContain('host network');
    expect(warnings).toContain('Docker socket');
    expect(warnings).toContain('./config');
    expect(warnings).not.toContain('named');
  });

  it('marks a host-network service, which no domain can be mapped to', () => {
    const analysis = analyzeCompose(compose('    network_mode: host'), '');
    expect(analysis.services[0]?.hostNetwork).toBe(true);
  });

  it('finds variables that .env does not set, but not ones with a default', () => {
    const warnings = analyzeCompose(
      compose(`    environment:
      A: \${SET}
      B: \${UNSET}
      C: \${DEFAULTED:-x}
      D: $$ESCAPED
      # E: \${IN_A_COMMENT}`),
      'SET=1\n',
    ).warnings.join(' ');
    expect(warnings).toContain('UNSET');
    expect(warnings).not.toContain('DEFAULTED');
    expect(warnings).not.toContain('ESCAPED');
    expect(warnings).not.toContain('IN_A_COMMENT');
    expect(warnings).not.toMatch(/\bSET\b/);
  });

  it('reads the older external form, a custom name, and non-external resources', () => {
    const analysis = analyzeCompose(
      compose(
        '',
        `networks:
  old:
    external:
      name: legacy-net
  named:
    external: true
    name: real-net
  mine: {}
volumes:
  data:
`,
      ),
      '',
    );
    expect(analysis.externalNetworks).toEqual(['legacy-net', 'real-net']);
    expect(analysis.externalVolumes).toEqual([]);
  });

  it('expands YAML merges, as Compose does', () => {
    const analysis = analyzeCompose(
      `x-base: &base
  image: nginx:stable
services:
  app:
    <<: *base
`,
      '',
    );
    expect(analysis.errors).toEqual([]);
    expect(analysis.services[0]?.image).toBe('nginx:stable');
  });

  it('offers the top-level name, and ignores a container_name with a variable', () => {
    const analysis = analyzeCompose(`name: shop\n${compose('    container_name: app-$ENV')}`, '');
    expect(analysis.name).toBe('shop');
    expect(analysis.services[0]?.containerName).toBeNull();
  });
});
