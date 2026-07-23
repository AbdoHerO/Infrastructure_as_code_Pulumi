import { describe, expect, it } from 'vitest';
import {
  emptyRuntimePlan,
  isApplyable,
  normalizeRuntimePlan,
  type RuntimeNetwork,
  type RuntimeService,
  validateRuntimePlan,
  type VpsRuntimePlan,
} from './vps-runtime-plan.js';

const TARGET_ID = '3f1c2b8e-9a4d-4e5f-8b7a-1c2d3e4f5a6b';

const network = (name: string, overrides: Partial<RuntimeNetwork> = {}): RuntimeNetwork => ({
  name,
  dockerName: name,
  displayName: name,
  driver: 'bridge',
  scope: 'application-private',
  internal: false,
  attachable: false,
  ipv6: false,
  labels: {},
  ...overrides,
});

const service = (name: string, overrides: Partial<RuntimeService> = {}): RuntimeService => ({
  name,
  applicationName: 'shop',
  kind: 'api',
  containerName: name,
  exposure: 'proxy-only',
  ports: [],
  networks: [{ networkName: 'backend', aliases: [] }],
  serviceReferences: [],
  volumes: [],
  restartPolicy: 'unless-stopped',
  ...overrides,
});

const plan = (overrides: Partial<VpsRuntimePlan> = {}): VpsRuntimePlan => ({
  ...emptyRuntimePlan(TARGET_ID),
  mode: 'managed',
  networks: [network('backend')],
  applications: [
    {
      name: 'shop',
      displayName: 'Shop',
      composeProject: 'shop',
      sourceMode: 'hybrid-override',
    },
  ],
  services: [service('api')],
  ...overrides,
});

const ids = (issues: ReturnType<typeof validateRuntimePlan>): string[] =>
  issues.map((issue) => issue.id);

describe('emptyRuntimePlan', () => {
  it('starts a never-managed target in legacy mode with no intent', () => {
    // Upgrading CloudForge must not change a running server.
    const fresh = emptyRuntimePlan(TARGET_ID);

    expect(fresh.mode).toBe('legacy');
    expect(fresh.version).toBe(0);
    expect(fresh.services).toEqual([]);
    expect(validateRuntimePlan(fresh)).toEqual([]);
  });

  it('normalizes a persisted schema-v1 plan without a database migration', () => {
    const legacy = {
      ...emptyRuntimePlan(TARGET_ID),
      schemaVersion: 1,
      certificates: undefined,
      dnsRecords: undefined,
      services: [service('api', { runtimeKind: undefined })],
      routes: [
        {
          domain: 'example.com',
          path: '/',
          serviceName: 'api',
          servicePort: 80,
          websocket: false,
          tls: true,
        },
      ],
    } as unknown as VpsRuntimePlan;

    const normalized = normalizeRuntimePlan(legacy);

    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.certificates).toEqual([]);
    expect(normalized.dnsRecords).toEqual([]);
    expect(normalized.services[0]?.runtimeKind).toBe('container');
    expect(normalized.routes[0]?.applicationName).toBe('shop');
    expect(normalized.routes[0]?.httpRedirect).toBe(false);
  });
});

describe('validateRuntimePlan', () => {
  it('accepts a coherent plan', () => {
    expect(validateRuntimePlan(plan())).toEqual([]);
  });

  it('reports every issue rather than stopping at the first', () => {
    const issues = validateRuntimePlan(
      plan({
        networks: [network('backend'), network('backend')],
        services: [service('api'), service('api')],
      }),
    );

    expect(ids(issues)).toContain('network.duplicate');
    expect(ids(issues)).toContain('service.duplicate');
  });

  describe('references', () => {
    it('rejects a reference to a service on no shared network', () => {
      // The whole point: DB_HOST=db resolves through Docker DNS, which only
      // answers for services that share a network.
      const issues = validateRuntimePlan(
        plan({
          networks: [network('backend'), network('other')],
          services: [
            service('api', {
              serviceReferences: [
                {
                  environmentVariable: 'DB_HOST',
                  targetServiceName: 'db',
                  valueMode: 'network-alias',
                },
              ],
            }),
            service('db', { kind: 'database', networks: [{ networkName: 'other', aliases: [] }] }),
          ],
        }),
      );

      expect(ids(issues)).toContain('reference.unreachable');
    });

    it('accepts a reference between services that share a network', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              serviceReferences: [
                {
                  environmentVariable: 'DB_HOST',
                  targetServiceName: 'db',
                  valueMode: 'network-alias',
                },
              ],
            }),
            service('db', { kind: 'database' }),
          ],
        }),
      );

      expect(issues).toEqual([]);
    });

    it('rejects a reference to a service that does not exist', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              serviceReferences: [
                {
                  environmentVariable: 'DB_HOST',
                  targetServiceName: 'ghost',
                  valueMode: 'network-alias',
                },
              ],
            }),
          ],
        }),
      );

      expect(ids(issues)).toEqual(['reference.target']);
    });

    it('rejects a self-reference and a non-environment-variable name', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              serviceReferences: [
                {
                  environmentVariable: 'API_HOST',
                  targetServiceName: 'api',
                  valueMode: 'network-alias',
                },
                {
                  environmentVariable: 'lower case',
                  targetServiceName: 'api',
                  valueMode: 'network-alias',
                },
              ],
            }),
          ],
        }),
      );

      expect(ids(issues)).toContain('reference.self');
      expect(ids(issues)).toContain('reference.variable');
    });

    it('does not hardcode a framework variable name', () => {
      // DB_HOST, REDIS_HOST or anything else — the model only requires a valid
      // environment variable name.
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              serviceReferences: [
                {
                  environmentVariable: 'SOMETHING_ENTIRELY_CUSTOM',
                  targetServiceName: 'db',
                  valueMode: 'network-alias',
                },
              ],
            }),
            service('db'),
          ],
        }),
      );

      expect(issues).toEqual([]);
    });
  });

  describe('exposure and ports', () => {
    it('rejects a published exposure with no host port', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              exposure: 'direct',
              ports: [{ containerPort: 3000, protocol: 'tcp' }],
            }),
          ],
        }),
      );

      expect(ids(issues)).toContain('service.hostPort.missing');
    });

    it('rejects a host port on an exposure that publishes nothing', () => {
      // Silently ignoring it would tell the user a port is published when it is not.
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              exposure: 'proxy-only',
              ports: [{ containerPort: 3000, protocol: 'tcp', hostPort: 3000 }],
            }),
          ],
        }),
      );

      expect(ids(issues)).toContain('service.hostPort.unexpected');
    });

    it('rejects two services claiming one host port', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              exposure: 'host-loopback',
              ports: [
                { containerPort: 3000, protocol: 'tcp', hostPort: 8000, bindAddress: '127.0.0.1' },
              ],
            }),
            service('web', {
              exposure: 'host-loopback',
              ports: [
                { containerPort: 80, protocol: 'tcp', hostPort: 8000, bindAddress: '127.0.0.1' },
              ],
            }),
          ],
        }),
      );

      expect(ids(issues)).toContain('service.hostPort.conflict');
    });

    it('allows the same host port on different bind addresses', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              exposure: 'host-loopback',
              ports: [
                { containerPort: 3000, protocol: 'tcp', hostPort: 8000, bindAddress: '127.0.0.1' },
              ],
            }),
            service('web', {
              exposure: 'direct',
              ports: [
                { containerPort: 80, protocol: 'tcp', hostPort: 8000, bindAddress: '10.0.0.5' },
              ],
            }),
          ],
        }),
      );

      expect(ids(issues)).not.toContain('service.hostPort.conflict');
    });

    it('warns rather than blocks when a service is published publicly', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', {
              exposure: 'direct',
              ports: [{ containerPort: 3000, protocol: 'tcp', hostPort: 3000 }],
            }),
          ],
        }),
      );

      // Deliberate public exposure is legitimate; it just must be visible.
      expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
      expect(isApplyable(issues)).toBe(true);
    });
  });

  describe('networks', () => {
    it('rejects an internal shared proxy network', () => {
      // An internal network has no route out, so the proxy could never serve traffic.
      const issues = validateRuntimePlan(
        plan({
          networks: [
            network('backend'),
            network('proxy', { scope: 'shared-proxy', internal: true }),
          ],
        }),
      );

      expect(ids(issues)).toContain('network.proxy.internal');
    });

    it('allows an internal application network', () => {
      const issues = validateRuntimePlan(
        plan({ networks: [network('backend', { internal: true })] }),
      );

      expect(issues).toEqual([]);
    });

    it.each([
      'db-password',
      'API_TOKEN',
      'registry.secret',
      'aws.credential',
      'apikey',
      'private-key',
    ])('refuses to put "%s" in a label, where anyone with Docker access can read it', (key) => {
      const issues = validateRuntimePlan(
        plan({ networks: [network('backend', { labels: { [key]: 'value' } })] }),
      );

      expect(ids(issues)).toEqual(['network.labels.secret']);
      expect(isApplyable(issues)).toBe(false);
    });

    it.each(['io.cloudforge.managed', 'com.example.team', 'keycloak-realm'])(
      'allows the ordinary label "%s"',
      (key) => {
        const issues = validateRuntimePlan(
          plan({ networks: [network('backend', { labels: { [key]: 'value' } })] }),
        );

        expect(issues).toEqual([]);
      },
    );

    it('rejects two networks claiming one Docker name', () => {
      const issues = validateRuntimePlan(
        plan({
          networks: [
            network('a', { dockerName: 'shared' }),
            network('b', { dockerName: 'shared' }),
          ],
        }),
      );

      expect(ids(issues)).toContain('network.dockerName.duplicate');
    });

    it('warns about a service attached to nothing', () => {
      const issues = validateRuntimePlan(plan({ services: [service('api', { networks: [] })] }));

      expect(ids(issues)).toContain('service.network.none');
    });

    it('rejects an unknown network reference', () => {
      const issues = validateRuntimePlan(
        plan({ services: [service('api', { networks: [{ networkName: 'ghost', aliases: [] }] })] }),
      );

      expect(ids(issues)).toContain('service.network');
    });
  });

  describe('routes', () => {
    it('rejects a route to an unknown service', () => {
      const issues = validateRuntimePlan(
        plan({
          routes: [
            {
              domain: 'app.example.com',
              path: '/',
              serviceName: 'ghost',
              servicePort: 3000,
              websocket: false,
              tls: true,
            },
          ],
        }),
      );

      expect(ids(issues)).toContain('route.service');
    });

    it('rejects a route when the target has no reverse proxy', () => {
      const issues = validateRuntimePlan(
        plan({
          reverseProxy: 'none',
          routes: [
            {
              domain: 'app.example.com',
              path: '/',
              serviceName: 'api',
              servicePort: 3000,
              websocket: false,
              tls: true,
            },
          ],
        }),
      );

      expect(ids(issues)).toContain('route.noProxy');
    });

    it('rejects duplicate routes but allows different paths on one domain', () => {
      const base = {
        domain: 'app.example.com',
        serviceName: 'api',
        servicePort: 3000,
        websocket: false,
        tls: true,
      };
      // A topology the routes can actually reach, so this test is only about
      // duplication.
      const routable = (routes: VpsRuntimePlan['routes']): VpsRuntimePlan =>
        plan({
          reverseProxy: 'container-nginx',
          networks: [network('backend', { scope: 'shared-proxy' })],
          routes,
        });
      expect(
        ids(
          validateRuntimePlan(
            routable([
              { ...base, path: '/' },
              { ...base, path: '/' },
            ]),
          ),
        ),
      ).toContain('route.duplicate');
      expect(
        validateRuntimePlan(
          routable([
            { ...base, path: '/' },
            { ...base, path: '/app' },
          ]),
        ),
      ).toEqual([]);
    });
  });

  describe('identity', () => {
    it('rejects two services claiming one container name', () => {
      const issues = validateRuntimePlan(
        plan({
          services: [
            service('api', { containerName: 'app' }),
            service('web', { containerName: 'app' }),
          ],
        }),
      );

      expect(ids(issues)).toContain('service.containerName.duplicate');
    });

    it('rejects a service on an unknown application, and an unknown volume', () => {
      const issues = validateRuntimePlan(
        plan({ services: [service('api', { applicationName: 'ghost', volumes: ['nope'] })] }),
      );

      expect(ids(issues)).toContain('service.application');
      expect(ids(issues)).toContain('service.volume');
    });

    it('rejects two applications sharing a Compose project', () => {
      const issues = validateRuntimePlan(
        plan({
          applications: [
            {
              name: 'shop',
              displayName: 'Shop',
              composeProject: 'app',
              sourceMode: 'hybrid-override',
            },
            {
              name: 'blog',
              displayName: 'Blog',
              composeProject: 'app',
              sourceMode: 'hybrid-override',
            },
          ],
        }),
      );

      expect(ids(issues)).toContain('application.composeProject.duplicate');
    });
  });

  it('warns that a legacy-mode plan will not be applied', () => {
    const issues = validateRuntimePlan(plan({ mode: 'legacy' }));

    expect(ids(issues)).toContain('plan.legacy');
    expect(isApplyable(issues)).toBe(true);
  });
});

describe('isApplyable', () => {
  it('blocks on an error and permits warnings', () => {
    expect(isApplyable([{ id: 'x', severity: 'error', resource: 'a', message: 'm' }])).toBe(false);
    expect(isApplyable([{ id: 'x', severity: 'warning', resource: 'a', message: 'm' }])).toBe(true);
    expect(isApplyable([])).toBe(true);
  });
});

describe('generic application shapes', () => {
  it('models several unrelated applications sharing only a proxy network', () => {
    // A landing page and a dashboard as separate applications, separate
    // repositories, separate Compose projects, one shared proxy network.
    const issues = validateRuntimePlan(
      plan({
        reverseProxy: 'container-nginx',
        networks: [network('proxy', { scope: 'shared-proxy' }), network('backend')],
        applications: [
          {
            name: 'landing',
            displayName: 'Landing',
            composeProject: 'landing',
            sourceMode: 'repository-managed',
          },
          {
            name: 'dashboard',
            displayName: 'Dashboard',
            composeProject: 'dashboard',
            sourceMode: 'repository-managed',
          },
        ],
        services: [
          service('landing-web', {
            applicationName: 'landing',
            kind: 'web',
            networks: [{ networkName: 'proxy', aliases: ['landing'] }],
          }),
          service('dashboard-web', {
            applicationName: 'dashboard',
            kind: 'web',
            networks: [{ networkName: 'proxy', aliases: ['dashboard'] }],
          }),
        ],
        routes: [
          {
            domain: 'example.com',
            path: '/',
            serviceName: 'landing-web',
            servicePort: 8080,
            websocket: false,
            tls: true,
          },
          {
            domain: 'app.example.com',
            path: '/',
            serviceName: 'dashboard-web',
            servicePort: 8080,
            websocket: false,
            tls: true,
          },
        ],
      }),
    );

    expect(issues).toEqual([]);
  });

  it('models a multi-service application with private data services and a websocket route', () => {
    const issues = validateRuntimePlan(
      plan({
        reverseProxy: 'container-nginx',
        networks: [
          network('proxy', { scope: 'shared-proxy' }),
          network('backend', { internal: true }),
        ],
        volumes: [{ name: 'db-data', dockerName: 'shop-db-data', applicationName: 'shop' }],
        services: [
          service('web', {
            kind: 'web',
            networks: [
              { networkName: 'proxy', aliases: ['shop'] },
              { networkName: 'backend', aliases: ['web'] },
            ],
            serviceReferences: [
              {
                environmentVariable: 'DB_HOST',
                targetServiceName: 'db',
                valueMode: 'network-alias',
              },
              {
                environmentVariable: 'REDIS_HOST',
                targetServiceName: 'cache',
                valueMode: 'network-alias',
              },
            ],
          }),
          service('reverb', {
            kind: 'websocket',
            networks: [{ networkName: 'proxy', aliases: ['reverb'] }],
          }),
          service('worker', { kind: 'worker', exposure: 'internal' }),
          service('db', { kind: 'database', exposure: 'internal', volumes: ['db-data'] }),
          service('cache', { kind: 'cache', exposure: 'internal' }),
        ],
        routes: [
          {
            domain: 'app.example.com',
            path: '/',
            serviceName: 'web',
            servicePort: 8080,
            websocket: false,
            tls: true,
          },
          {
            domain: 'app.example.com',
            path: '/app',
            serviceName: 'reverb',
            servicePort: 8080,
            websocket: true,
            tls: true,
          },
        ],
      }),
    );

    expect(issues).toEqual([]);
  });

  it('accepts a service kind nobody anticipated', () => {
    expect(
      validateRuntimePlan(plan({ services: [service('api', { kind: 'quantum-flux-capacitor' })] })),
    ).toEqual([]);
  });

  describe('a route the proxy could never reach', () => {
    // The mistake this catches produces a site that is broken the moment it is
    // created: nginx reloads happily and every request 502s.
    const proxyNet = {
      name: 'edge',
      dockerName: 'edge-net',
      displayName: 'Edge',
      driver: 'bridge',
      scope: 'shared-proxy',
      internal: false,
      attachable: true,
      ipv6: false,
      labels: {},
    } as const;

    const web = (overrides: Partial<RuntimeService> = {}): RuntimeService => ({
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

    const routed = (overrides: Partial<VpsRuntimePlan>, service: RuntimeService): VpsRuntimePlan =>
      plan({
        applications: [
          {
            name: 'app',
            displayName: 'App',
            composeProject: 'app',
            sourceMode: 'hybrid-override',
          },
        ],
        services: [service],
        routes: [
          {
            domain: 'example.com',
            path: '/',
            serviceName: 'web',
            servicePort: 80,
            websocket: false,
            tls: true,
          },
        ],
        ...overrides,
      });

    describe('with nginx on the host', () => {
      it('rejects a route to a container the host cannot resolve', () => {
        // The host's resolver cannot answer Docker DNS. A container name means
        // nothing to it.
        const issues = validateRuntimePlan(
          routed({ reverseProxy: 'native-nginx', networks: [proxyNet] }, web()),
        );

        expect(ids(issues)).toContain('route.unreachable');
        expect(isApplyable(issues)).toBe(false);
        expect(issues.find((i) => i.id === 'route.unreachable')?.message).toContain('502');
      });

      it('accepts a route to a service published on loopback', () => {
        const issues = validateRuntimePlan(
          routed(
            { reverseProxy: 'native-nginx' },
            web({
              exposure: 'host-loopback',
              ports: [
                { containerPort: 80, protocol: 'tcp', hostPort: 8080, bindAddress: '127.0.0.1' },
              ],
            }),
          ),
        );

        expect(ids(issues)).not.toContain('route.unreachable');
      });

      it('accepts a route to a directly published service', () => {
        const issues = validateRuntimePlan(
          routed(
            { reverseProxy: 'native-nginx' },
            web({
              exposure: 'direct',
              ports: [{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }],
            }),
          ),
        );

        expect(ids(issues)).not.toContain('route.unreachable');
      });

      it('rejects a route to a port the service does not publish', () => {
        // It publishes something, just not the port the route asks for.
        const issues = validateRuntimePlan(
          routed(
            { reverseProxy: 'native-nginx' },
            web({
              exposure: 'host-loopback',
              ports: [{ containerPort: 9000, protocol: 'tcp', hostPort: 9000 }],
            }),
          ),
        );

        expect(ids(issues)).toContain('route.unreachable');
      });
    });

    describe('with the proxy in a container', () => {
      it('accepts a route to a service on the shared proxy network', () => {
        const issues = validateRuntimePlan(
          routed(
            { reverseProxy: 'container-nginx', networks: [proxyNet] },
            web({ networks: [{ networkName: 'edge', aliases: ['web'] }] }),
          ),
        );

        expect(ids(issues)).not.toContain('route.unreachable');
      });

      it('rejects a route to a service on no shared network', () => {
        const issues = validateRuntimePlan(
          routed({ reverseProxy: 'container-nginx', networks: [proxyNet] }, web({ networks: [] })),
        );

        expect(ids(issues)).toContain('route.unreachable');
      });

      it('rejects a route when no network is scoped for the proxy at all', () => {
        const issues = validateRuntimePlan(
          routed({ reverseProxy: 'container-nginx', networks: [] }, web()),
        );

        expect(ids(issues)).toContain('route.noProxyNetwork');
      });

      it.each(['container-traefik', 'container-caddy'] as const)('applies to %s too', (proxy) => {
        const issues = validateRuntimePlan(
          routed({ reverseProxy: proxy, networks: [proxyNet] }, web({ networks: [] })),
        );

        expect(ids(issues)).toContain('route.unreachable');
      });

      it('does not require a published host port', () => {
        // The whole point of a containerised proxy: the service stays private.
        const issues = validateRuntimePlan(
          routed(
            { reverseProxy: 'container-nginx', networks: [proxyNet] },
            web({ networks: [{ networkName: 'edge', aliases: [] }] }),
          ),
        );

        expect(issues).toEqual([]);
      });
    });

    it('says nothing about reachability for an external proxy', () => {
      // Someone else's proxy. CloudForge cannot know what it can reach.
      const issues = validateRuntimePlan(routed({ reverseProxy: 'external' }, web()));

      expect(ids(issues)).not.toContain('route.unreachable');
    });
  });
});
