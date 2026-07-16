import { describe, expect, it } from 'vitest';
import {
  checkConnectivity,
  firewallRequirements,
  portKey,
  toProviderFirewallView,
  type FirewallRequirement,
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

describe('toProviderFirewallView', () => {
  const need = (port: number, protocol: 'tcp' | 'udp' = 'tcp'): FirewallRequirement[] => [
    { port, protocol, reason: 'test', requiredBy: [] },
  ];

  const rule = (overrides: Partial<Parameters<typeof toProviderFirewallView>[0][number]> = {}) => ({
    direction: 'ingress',
    protocol: 'tcp',
    cidr: '0.0.0.0/0',
    portFrom: 80,
    portTo: 80,
    ...overrides,
  });

  const open = (rules: Parameters<typeof toProviderFirewallView>[0], port = 80): boolean =>
    toProviderFirewallView(rules, need(port)).allowed.has(portKey(port, 'tcp'));

  it('opens a port an ingress rule allows from anywhere', () => {
    expect(open([rule()])).toBe(true);
  });

  it('ignores an egress rule', () => {
    // An egress rule for 443 says nothing about whether anyone can reach you.
    expect(open([rule({ direction: 'egress' })])).toBe(false);
  });

  it('ignores a rule that only opens the port to a private subnet', () => {
    // The one that produces a confident wrong answer: 5432 from 10.0.0.0/8 does
    // not make the port reachable from the internet, and saying it does sends
    // someone hunting a bug that is a firewall rule.
    expect(open([rule({ cidr: '10.0.0.0/8' })])).toBe(false);
  });

  it.each(['0.0.0.0/0', '::/0'])('treats %s as the whole internet', (cidr) => {
    expect(open([rule({ cidr })])).toBe(true);
  });

  it('tolerates a cidr with surrounding whitespace', () => {
    expect(open([rule({ cidr: ' 0.0.0.0/0 ' })])).toBe(true);
  });

  it('opens a port covered by a range that does not name it', () => {
    expect(open([rule({ portFrom: 8000, portTo: 9000 })], 8080)).toBe(true);
  });

  it('leaves a port outside the range closed', () => {
    expect(open([rule({ portFrom: 8000, portTo: 9000 })], 9001)).toBe(false);
  });

  it('treats a null range as every port, which is what providers mean by it', () => {
    expect(open([rule({ portFrom: null, portTo: null })], 12_345)).toBe(true);
  });

  it('reads a half-stated range narrowly rather than generously', () => {
    // `portFrom: 8000, portTo: null` is ambiguous. Reading it as 8000-65535
    // would claim more ports are open than the rule proves — and a port wrongly
    // called open sends someone hunting a bug that is a firewall rule. Wrongly
    // calling it closed only costs a redundant "open port" click.
    const rules = [rule({ portFrom: 8000, portTo: null })];

    expect(open(rules, 8000)).toBe(true);
    expect(open(rules, 60_000)).toBe(false);
  });

  it('does not let a tcp rule open a udp port', () => {
    const view = toProviderFirewallView([rule({ portFrom: 53, portTo: 53 })], need(53, 'udp'));

    expect(view.allowed.has(portKey(53, 'udp'))).toBe(false);
  });

  it('lets an "all" protocol rule open both tcp and udp', () => {
    const rules = [rule({ protocol: 'all', portFrom: 53, portTo: 53 })];

    expect(toProviderFirewallView(rules, need(53, 'udp')).allowed.has(portKey(53, 'udp'))).toBe(
      true,
    );
    expect(toProviderFirewallView(rules, need(53, 'tcp')).allowed.has(portKey(53, 'tcp'))).toBe(
      true,
    );
  });

  it('does not let an icmp rule open a tcp port', () => {
    expect(open([rule({ protocol: 'icmp', portFrom: null, portTo: null })])).toBe(false);
  });

  it('is never indeterminate: a security list that was read is an answer', () => {
    const view = toProviderFirewallView([], need(80));

    expect(view.indeterminate).toBe(false);
    expect(view.permitsEverything).toBe(false);
    expect(view.allowed.size).toBe(0);
  });

  it('opens a port when any one of several rules allows it', () => {
    expect(open([rule({ cidr: '10.0.0.0/8' }), rule({ direction: 'egress' }), rule()])).toBe(true);
  });
});
