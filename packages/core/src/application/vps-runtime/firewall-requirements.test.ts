import { describe, expect, it } from 'vitest';
import {
  checkConnectivity,
  firewallRequirements,
  portKey,
  type FirewallView,
} from './firewall-requirements.js';
import {
  emptyRuntimePlan,
  type RuntimeRoute,
  type RuntimeService,
  type VpsRuntimePlan,
} from './vps-runtime-plan.js';

const TARGET = 'target-1';

const plan = (overrides: Partial<VpsRuntimePlan> = {}): VpsRuntimePlan => ({
  ...emptyRuntimePlan(TARGET),
  mode: 'managed',
  applications: [
    { name: 'app', displayName: 'App', composeProject: 'app', sourceMode: 'hybrid-override' },
  ],
  ...overrides,
});

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

const route = (overrides: Partial<RuntimeRoute> = {}): RuntimeRoute => ({
  domain: 'example.com',
  path: '/',
  serviceName: 'web',
  servicePort: 80,
  websocket: false,
  tls: true,
  ...overrides,
});

const ports = (plan: VpsRuntimePlan): string[] =>
  firewallRequirements(plan).map((r) => portKey(r.port, r.protocol));

const view = (allowed: string[], overrides: Partial<FirewallView> = {}): FirewallView => ({
  allowed: new Set(allowed),
  indeterminate: false,
  permitsEverything: false,
  ...overrides,
});

describe('firewallRequirements', () => {
  it('needs nothing for a legacy target', () => {
    // Nothing is managed, so nothing is asked of either firewall.
    expect(firewallRequirements(plan({ mode: 'legacy', routes: [route()] }))).toEqual([]);
  });

  it('needs nothing when the target serves nothing', () => {
    // Opening 80 and 443 on a VPS with no routes is a hole for no reason.
    expect(firewallRequirements(plan())).toEqual([]);
  });

  it('needs 80 and 443 for an HTTPS route', () => {
    expect(ports(plan({ services: [service()], routes: [route()] }))).toEqual([
      '80/tcp',
      '443/tcp',
    ]);
  });

  it('still needs 80 when every route is HTTPS, for ACME renewal', () => {
    // Closing 80 is how certificate renewal silently starts failing 60 days later.
    const requirements = firewallRequirements(plan({ services: [service()], routes: [route()] }));

    expect(requirements[0]?.port).toBe(80);
    expect(requirements[0]?.reason).toContain('Let’s Encrypt renewal');
  });

  it('needs only 80 for a plain HTTP route', () => {
    expect(ports(plan({ services: [service()], routes: [route({ tls: false })] }))).toEqual([
      '80/tcp',
    ]);
  });

  it('needs nothing from a proxy it does not run', () => {
    expect(
      ports(plan({ reverseProxy: 'external', services: [service()], routes: [route()] })),
    ).toEqual([]);
  });

  it('names the domains that need each port', () => {
    const requirements = firewallRequirements(
      plan({
        services: [service()],
        routes: [route({ domain: 'a.example.com' }), route({ domain: 'b.example.com' })],
      }),
    );

    expect(requirements[1]?.requiredBy).toEqual(['a.example.com', 'b.example.com']);
  });

  describe('directly published services', () => {
    it('needs the host port a direct service publishes', () => {
      const requirements = firewallRequirements(
        plan({
          services: [
            service({
              name: 'game',
              exposure: 'direct',
              ports: [{ containerPort: 25_565, protocol: 'tcp', hostPort: 25_565 }],
            }),
          ],
        }),
      );

      expect(requirements).toHaveLength(1);
      expect(requirements[0]?.port).toBe(25_565);
      expect(requirements[0]?.requiredBy).toEqual(['game']);
    });

    it('needs a udp port for a udp service', () => {
      expect(
        ports(
          plan({
            services: [
              service({
                exposure: 'direct',
                ports: [{ containerPort: 51_820, protocol: 'udp', hostPort: 51_820 }],
              }),
            ],
          }),
        ),
      ).toEqual(['51820/udp']);
    });

    it('needs nothing for a loopback-bound port', () => {
      // No firewall rule can make 127.0.0.1 reachable and none is needed.
      // Conflating the two is how a hole gets opened for traffic that could
      // never arrive.
      expect(
        ports(
          plan({
            services: [
              service({
                exposure: 'direct',
                ports: [
                  {
                    containerPort: 5432,
                    protocol: 'tcp',
                    hostPort: 5432,
                    bindAddress: '127.0.0.1',
                  },
                ],
              }),
            ],
          }),
        ),
      ).toEqual([]);
    });

    it('needs the port when it is bound to every interface', () => {
      expect(
        ports(
          plan({
            services: [
              service({
                exposure: 'direct',
                ports: [
                  { containerPort: 80, protocol: 'tcp', hostPort: 8080, bindAddress: '0.0.0.0' },
                ],
              }),
            ],
          }),
        ),
      ).toEqual(['8080/tcp']);
    });

    it.each(['internal', 'proxy-only', 'host-loopback'] as const)(
      'needs nothing for a %s service',
      (exposure) => {
        expect(
          ports(
            plan({
              services: [
                service({
                  exposure,
                  ports: [{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }],
                }),
              ],
            }),
          ),
        ).toEqual([]);
      },
    );

    it('merges two services publishing the same port into one requirement', () => {
      const requirements = firewallRequirements(
        plan({
          services: [
            service({
              name: 'a',
              containerName: 'a',
              exposure: 'direct',
              ports: [{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }],
            }),
            service({
              name: 'b',
              containerName: 'b',
              exposure: 'direct',
              ports: [{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }],
            }),
          ],
        }),
      );

      expect(requirements).toHaveLength(1);
      expect(requirements[0]?.requiredBy).toEqual(['a', 'b']);
    });
  });

  it('never asks for SSH', () => {
    // CloudForge is talking to the VPS over SSH to ask the question, so the port
    // is demonstrably open. Listing it invites a reconcile that shuts the door
    // CloudForge is standing in.
    const requirements = firewallRequirements(
      plan({ services: [service()], routes: [route({ tls: false })] }),
    );

    expect(requirements.some((r) => r.port === 22)).toBe(false);
  });

  it('returns requirements in port order', () => {
    const p = plan({
      services: [
        service({
          exposure: 'direct',
          ports: [
            { containerPort: 1, protocol: 'tcp', hostPort: 9000 },
            { containerPort: 2, protocol: 'tcp', hostPort: 25 },
          ],
        }),
      ],
      routes: [route()],
    });

    expect(ports(p)).toEqual(['25/tcp', '80/tcp', '443/tcp', '9000/tcp']);
  });
});

describe('checkConnectivity', () => {
  const requirement = firewallRequirements(
    plan({ services: [service()], routes: [route({ tls: false })] }),
  );

  it('reports reachable only when both firewalls allow it', () => {
    const findings = checkConnectivity(requirement, view(['80/tcp']), view(['80/tcp']));

    expect(findings[0]?.state).toBe('reachable');
  });

  it('names the host firewall when it is the one in the way', () => {
    // "The port is closed" sends someone to the wrong screen half the time.
    const findings = checkConnectivity(requirement, view([]), view(['80/tcp']));

    expect(findings[0]?.state).toBe('blocked-host');
    expect(findings[0]?.message).toContain("VPS's own firewall");
  });

  it('names the provider when it is the one in the way', () => {
    const findings = checkConnectivity(requirement, view(['80/tcp']), view([]));

    expect(findings[0]?.state).toBe('blocked-provider');
    expect(findings[0]?.message).toContain('never reaches the machine');
  });

  it('says so when both are blocking', () => {
    expect(checkConnectivity(requirement, view([]), view([]))[0]?.state).toBe('blocked-both');
  });

  it('treats an unfiltered firewall as allowing everything', () => {
    const findings = checkConnectivity(
      requirement,
      view([], { permitsEverything: true }),
      view(['80/tcp']),
    );

    expect(findings[0]?.state).toBe('reachable');
  });

  it('never calls a port reachable when a firewall could not be read', () => {
    // Reporting "reachable" because we failed to look is worse than reporting
    // nothing: it sends someone hunting for a bug that is a firewall rule.
    const findings = checkConnectivity(
      requirement,
      view([], { indeterminate: true }),
      view(['80/tcp']),
    );

    expect(findings[0]?.state).toBe('unknown');
    expect(findings[0]?.message).toContain('unverified');
  });

  it('does not report unknown when the unreadable firewall is known to allow it', () => {
    // The state was partially readable and the port was in it. That is an answer.
    const findings = checkConnectivity(
      requirement,
      view(['80/tcp'], { indeterminate: true }),
      view(['80/tcp']),
    );

    expect(findings[0]?.state).toBe('reachable');
  });

  it('carries the reason through, so a finding says what needs the port', () => {
    const findings = checkConnectivity(requirement, view([]), view([]));

    expect(findings[0]?.requiredBy).toEqual(['example.com']);
    expect(findings[0]?.reason).toContain('HTTP');
  });

  it('checks nothing when nothing is required', () => {
    expect(checkConnectivity([], view([]), view([]))).toEqual([]);
  });
});
