import { describe, expect, it } from 'vitest';
import type { AnsibleProfile, AnsibleProfileState } from '../ports/ansible-manager.js';
import {
  ansibleFirewallRequirements,
  mergeFirewallRequirements,
  observedAnsibleRequirements,
  resolveProfilePort,
} from './ansible-runtime-requirements.js';

const jenkins: AnsibleProfile = {
  id: 'jenkins',
  name: 'Jenkins',
  description: 'A native service.',
  variables: [],
  runtime: {
    ports: [
      {
        protocol: 'tcp',
        variableKey: 'service_port',
        defaultPort: 8080,
        reason: 'Jenkins web interface',
        reach: 'public',
      },
    ],
  },
};

const docker: AnsibleProfile = {
  id: 'docker',
  name: 'Docker Engine',
  description: 'A socket, not a port.',
  variables: [],
  runtime: { ports: [], providesContainerRuntime: true },
};

const state = (over: Partial<AnsibleProfileState> = {}): AnsibleProfileState => ({
  profileId: 'jenkins',
  status: 'running',
  installed: true,
  running: true,
  version: '2.516.1',
  port: 8080,
  hostFirewallOpen: true,
  detail: '',
  configuration: {},
  checkedAt: '2026-07-16T00:00:00.000Z',
  ...over,
});

describe('resolveProfilePort', () => {
  it('prefers the value the user chose', () => {
    expect(resolveProfilePort(jenkins.runtime!.ports[0]!, { service_port: 9000 })).toBe(9000);
  });

  it('falls back to the default when the variable is absent or blank', () => {
    expect(resolveProfilePort(jenkins.runtime!.ports[0]!, {})).toBe(8080);
    expect(resolveProfilePort(jenkins.runtime!.ports[0]!, { service_port: '' })).toBe(8080);
  });

  it('reads a port that arrived as a string', () => {
    // Variables round-trip through JSON and a form, so a number can show up as text.
    expect(resolveProfilePort(jenkins.runtime!.ports[0]!, { service_port: '9000' })).toBe(9000);
  });

  it('returns null rather than the default for a value it cannot read', () => {
    // Falling back to 8080 here would send the user to open a port Jenkins is not
    // listening on — a wrong answer dressed as a confident one.
    for (const bad of ['nonsense', 0, 70_000, -1, 1.5, {}]) {
      expect(resolveProfilePort(jenkins.runtime!.ports[0]!, { service_port: bad })).toBeNull();
    }
  });

  it('reads a fixed port that has no variable at all', () => {
    expect(
      resolveProfilePort(
        { protocol: 'tcp', defaultPort: 80, reason: 'HTTP', reach: 'public' },
        { service_port: 9999 },
      ),
    ).toBe(80);
  });
});

describe('ansibleFirewallRequirements', () => {
  it('reports the port the profile was configured with', () => {
    expect(ansibleFirewallRequirements(jenkins, { service_port: 9000 })).toEqual([
      { port: 9000, protocol: 'tcp', reason: 'Jenkins web interface', requiredBy: ['Jenkins'] },
    ]);
  });

  it('asks for nothing for a profile that declares no runtime', () => {
    // Every profile behaved this way before the field existed. One that has not
    // declared anything must keep contributing nothing rather than being guessed at.
    const { runtime: _declared, ...undeclared } = jenkins;

    expect(ansibleFirewallRequirements(undeclared, { service_port: 9000 })).toEqual([]);
  });

  it('asks for nothing for a service that listens on a socket', () => {
    expect(ansibleFirewallRequirements(docker)).toEqual([]);
  });

  it('does not ask to open a port only the host uses', () => {
    // No firewall rule can make loopback reachable and none should try.
    const internal: AnsibleProfile = {
      ...jenkins,
      runtime: {
        ports: [{ protocol: 'tcp', defaultPort: 5432, reason: 'Local database', reach: 'host' }],
      },
    };

    expect(ansibleFirewallRequirements(internal)).toEqual([]);
  });

  it('stays quiet about a port it cannot resolve', () => {
    expect(ansibleFirewallRequirements(jenkins, { service_port: 'nonsense' })).toEqual([]);
  });
});

describe('observedAnsibleRequirements', () => {
  it('believes the live port over the declared default', () => {
    // Someone who moved Jenkins to 9000 by hand still deserves a correct answer.
    expect(observedAnsibleRequirements([jenkins], [state({ port: 9000 })])).toEqual([
      { port: 9000, protocol: 'tcp', reason: 'Jenkins web interface', requiredBy: ['Jenkins'] },
    ]);
  });

  it('asks for nothing for software that is not installed', () => {
    // A firewall rule for absent software is how a VPS ends up with open ports
    // nobody can explain.
    expect(
      observedAnsibleRequirements([jenkins], [state({ installed: false, running: false })]),
    ).toEqual([]);
  });

  it('falls back to the default when the probe could not read a port', () => {
    expect(observedAnsibleRequirements([jenkins], [state({ port: null })])[0]?.port).toBe(8080);
  });

  it('ignores a state whose profile is not in the catalog', () => {
    expect(observedAnsibleRequirements([docker], [state()])).toEqual([]);
  });
});

describe('mergeFirewallRequirements', () => {
  it('folds one port needed by two things into a single requirement', () => {
    // Otherwise the UI asks the user to open port 80 twice and then shows it
    // blocked twice.
    const merged = mergeFirewallRequirements(
      [{ port: 80, protocol: 'tcp', reason: 'Routes', requiredBy: ['app.example.com'] }],
      [{ port: 80, protocol: 'tcp', reason: 'HTTP traffic', requiredBy: ['Nginx'] }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.requiredBy).toEqual(['app.example.com', 'Nginx']);
    expect(merged[0]?.reason).toBe('Routes; HTTP traffic');
  });

  it('keeps one reason when both sources give the same one', () => {
    const merged = mergeFirewallRequirements(
      [{ port: 80, protocol: 'tcp', reason: 'HTTP', requiredBy: ['a'] }],
      [{ port: 80, protocol: 'tcp', reason: 'HTTP', requiredBy: ['b'] }],
    );

    expect(merged[0]?.reason).toBe('HTTP');
  });

  it('keeps the same port on different protocols apart', () => {
    const merged = mergeFirewallRequirements(
      [{ port: 53, protocol: 'tcp', reason: 'DNS', requiredBy: ['a'] }],
      [{ port: 53, protocol: 'udp', reason: 'DNS', requiredBy: ['b'] }],
    );

    expect(merged).toHaveLength(2);
  });

  it('does not repeat a requirer that appears in both sources', () => {
    const merged = mergeFirewallRequirements(
      [{ port: 80, protocol: 'tcp', reason: 'HTTP', requiredBy: ['Nginx'] }],
      [{ port: 80, protocol: 'tcp', reason: 'HTTP', requiredBy: ['Nginx'] }],
    );

    expect(merged[0]?.requiredBy).toEqual(['Nginx']);
  });

  it('sorts by port so the report does not reshuffle between reads', () => {
    const merged = mergeFirewallRequirements([
      { port: 443, protocol: 'tcp', reason: 'b', requiredBy: [] },
      { port: 80, protocol: 'tcp', reason: 'a', requiredBy: [] },
    ]);

    expect(merged.map((entry) => entry.port)).toEqual([80, 443]);
  });

  it('merges nothing into nothing', () => {
    expect(mergeFirewallRequirements()).toEqual([]);
    expect(mergeFirewallRequirements([], [])).toEqual([]);
  });
});
