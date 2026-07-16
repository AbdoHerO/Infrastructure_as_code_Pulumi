import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  closePortsScript,
  detectBackendScript,
  FIREWALL_MARKER,
  inspectScript,
  isValidPort,
  openPortsFragment,
  openPortsScript,
  parseFirewallState,
} from './host-firewall-script.js';

const HTTP = [{ port: 80, protocol: 'tcp' as const }];
const BOTH = [
  { port: 80, protocol: 'tcp' as const },
  { port: 443, protocol: 'tcp' as const },
];

/**
 * Ask a real shell whether the generated script parses.
 *
 * `sh -n` reads and parses without executing anything, so this is safe and
 * offline. It catches the failure mode that matters most here: a quoting mistake
 * in a template literal produces a script that is syntactically broken, and
 * without this the first place anyone finds out is a production VPS.
 */
function parsesAsShell(script: string): boolean {
  try {
    execFileSync('sh', ['-n'], { input: script, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

describe('shell syntax', () => {
  // Guard the guard: if `sh` is unavailable these tests would silently pass by
  // never being able to fail.
  it('has a working shell to check against', () => {
    expect(parsesAsShell('echo hello')).toBe(true);
    expect(parsesAsShell('if [ 1 ]; then')).toBe(false);
  });

  it.each([
    ['detect', detectBackendScript()],
    ['inspect', inspectScript()],
    ['open one port', openPortsScript(HTTP)],
    ['open several ports', openPortsScript(BOTH)],
    ['open fragment', openPortsFragment(BOTH)],
    ['close', closePortsScript(BOTH)],
    ['close one', closePortsScript(HTTP)],
  ])('generates a script that parses: %s', (_name, script) => {
    expect(parsesAsShell(script)).toBe(true);
  });

  it('generates a fragment that parses inside a larger set -e script', () => {
    const embedded = `set -e\necho before\n${openPortsFragment(BOTH)}\necho after`;

    expect(parsesAsShell(embedded)).toBe(true);
  });
});

describe('isValidPort', () => {
  it.each([1, 80, 443, 65_535])('accepts %i', (port) => {
    expect(isValidPort(port)).toBe(true);
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p', (port) => {
    expect(isValidPort(port)).toBe(false);
  });
});

describe('openPortsScript', () => {
  it('handles every backend, nftables included', () => {
    // Only the preflight probe knew nftables existed before. On a modern distro
    // `iptables` is a shim over nftables, so a host with a real nft ruleset was
    // being driven through the shim.
    const script = openPortsScript(HTTP);

    for (const backend of ['ufw', 'firewalld', 'nftables', 'iptables']) {
      expect(script).toContain(`${backend})`);
    }
  });

  it('prefers nftables over the iptables compatibility shim', () => {
    const script = detectBackendScript();

    expect(script.indexOf('nft list ruleset')).toBeLessThan(script.indexOf('iptables -S'));
  });

  it('only treats ufw and firewalld as in charge when they are running', () => {
    // Debian ships ufw installed and inactive. Treating that as "the firewall"
    // reports a port as blocked when nothing is blocking it.
    const script = detectBackendScript();

    expect(script).toContain("ufw status 2>/dev/null | grep -q '^Status: active'");
    expect(script).toContain('systemctl is-active --quiet firewalld');
  });

  it('checks before it changes, so running twice changes nothing', () => {
    const script = openPortsScript(HTTP);

    expect(script).toContain('grep -Eq');
    expect(script).toContain('--query-port');
    expect(script).toContain('iptables -C INPUT');
  });

  it('opens each port it is given', () => {
    const script = openPortsScript(BOTH);

    expect(script).toContain('cloudforge_open 80 tcp');
    expect(script).toContain('cloudforge_open 443 tcp');
  });

  it('reports whether it actually changed anything', () => {
    // So Activity does not claim a change that did not happen.
    expect(openPortsScript(HTTP)).toContain('printf changed');
    expect(openPortsScript(HTTP)).toContain('printf unchanged');
  });

  it('persists iptables rules, which do not survive a reboot on their own', () => {
    // A rule that vanishes on reboot is worse than one never added: it works
    // until the machine restarts at 3am.
    const script = openPortsScript(HTTP);

    expect(script).toContain('netfilter-persistent save');
    expect(script).toContain('iptables-save');
  });

  it('marks its own iptables and nftables rules', () => {
    const script = openPortsScript(HTTP);

    expect(script).toContain(`--comment '${FIREWALL_MARKER}'`);
    expect(script).toContain(`comment '"${FIREWALL_MARKER}"'`);
  });

  it('adds an nftables chain that accepts, so it can never be what blocks traffic', () => {
    expect(openPortsScript(HTTP)).toContain('policy accept');
  });

  it.each([0, 70_000, -1, 1.5])('refuses to generate a script for port %p', (port) => {
    expect(() => openPortsScript([{ port, protocol: 'tcp' }])).toThrow();
  });

  it('refuses an unknown protocol', () => {
    expect(() => openPortsScript([{ port: 80, protocol: 'sctp' as unknown as 'tcp' }])).toThrow();
  });
});

describe('openPortsFragment', () => {
  it('isolates its variables from the script it is pasted into', () => {
    expect(openPortsFragment(HTTP).startsWith('( ')).toBe(true);
  });

  it('stays quiet and cannot abort its host script', () => {
    // These callers run under `set -e`. A firewall hiccup must not abort a
    // certificate issuance that would otherwise have worked.
    const fragment = openPortsFragment(HTTP);

    expect(fragment).toContain('>/dev/null 2>&1');
    expect(fragment.endsWith('|| true')).toBe(true);
  });
});

describe('closePortsScript', () => {
  it('closes only the ports it is given', () => {
    const script = closePortsScript(HTTP);

    expect(script).toContain('cloudforge_close 80 tcp');
    expect(script).not.toContain('443');
  });

  it('has no reconcile mode that could close a port nobody asked about', () => {
    // A VPS firewall carries rules put there by people and other tools. A port
    // CloudForge did not open is not CloudForge's to close.
    const script = closePortsScript(HTTP);

    expect(script).not.toMatch(/ufw\s+reset|iptables\s+-F|flush ruleset|--remove-all/);
  });

  it('removes only its own marked rule on iptables and nftables', () => {
    const script = closePortsScript(HTTP);

    expect(script).toContain(`--comment '${FIREWALL_MARKER}'`);
    expect(script).toContain("grep -o 'handle [0-9]*'");
  });

  it('removes every duplicate of its own iptables rule', () => {
    // `iptables -D` deletes one match. Opening twice across releases leaves two.
    expect(closePortsScript(HTTP)).toContain('while iptables -C INPUT');
  });

  it('does nothing when the port is not open', () => {
    const script = closePortsScript(HTTP);

    expect(script).toContain('printf unchanged');
  });

  it.each([0, 70_000])('refuses to generate a script for port %p', (port) => {
    expect(() => closePortsScript([{ port, protocol: 'tcp' }])).toThrow();
  });
});

describe('parseFirewallState', () => {
  it('reads a ufw inspection', () => {
    const state = parseFirewallState(
      [
        'CF_FW|backend|ufw',
        'CF_FW|active|1',
        'CF_FW|rule|80|tcp|0|80/tcp ALLOW Anywhere',
        'CF_FW|rule|443|tcp|0|443/tcp ALLOW Anywhere',
      ].join('\n'),
    );

    expect(state.backend).toBe('ufw');
    expect(state.active).toBe(true);
    expect(state.rules.map((r) => r.port)).toEqual([80, 443]);
    expect(state.rules[0]?.raw).toBe('80/tcp ALLOW Anywhere');
  });

  it('reads which rules CloudForge added', () => {
    const state = parseFirewallState(
      [
        'CF_FW|backend|iptables',
        'CF_FW|active|1',
        `CF_FW|rule|8080|tcp|1|-A INPUT -p tcp --dport 8080 -m comment --comment "${FIREWALL_MARKER}" -j ACCEPT`,
        'CF_FW|rule|9090|tcp|0|-A INPUT -p tcp --dport 9090 -j ACCEPT',
      ].join('\n'),
    );

    expect(state.rules.map((r) => r.managed)).toEqual([true, false]);
  });

  it('reads a host with no firewall', () => {
    const state = parseFirewallState('CF_FW|backend|none\nCF_FW|active|0');

    expect(state).toEqual({ backend: 'none', active: false, rules: [] });
  });

  it('defaults to unknown rather than assuming there is no firewall', () => {
    // Assuming "no firewall" because the probe said nothing is how CloudForge
    // would report a port as reachable when it is not.
    expect(parseFirewallState('').backend).toBe('unknown');
  });

  it('ignores output that is not ours', () => {
    // Distributions print warnings and MOTDs into these streams.
    const state = parseFirewallState(
      [
        'WARN: something unrelated',
        'CF_FW|backend|ufw',
        'sudo: unable to resolve host',
        'CF_FW|active|1',
        'CF_FW|rule|80|tcp|0|80/tcp ALLOW',
      ].join('\n'),
    );

    expect(state.backend).toBe('ufw');
    expect(state.rules).toHaveLength(1);
  });

  it('drops a rule line it cannot read rather than failing the whole inspection', () => {
    // One surprising line should not blind CloudForge to the rest of the firewall.
    const state = parseFirewallState(
      [
        'CF_FW|backend|ufw',
        'CF_FW|active|1',
        'CF_FW|rule|not-a-port|tcp|0|junk',
        'CF_FW|rule|80|sctp|0|junk',
        'CF_FW|rule|99999|tcp|0|junk',
        'CF_FW|rule|443|tcp|0|443/tcp ALLOW',
      ].join('\n'),
    );

    expect(state.rules.map((r) => r.port)).toEqual([443]);
  });

  it('keeps a raw rule that contains a pipe', () => {
    const state = parseFirewallState(
      'CF_FW|backend|ufw\nCF_FW|active|1\nCF_FW|rule|80|tcp|0|a|b|c',
    );

    expect(state.rules[0]?.raw).toBe('a|b|c');
  });

  it('tolerates trailing whitespace and blank lines', () => {
    const state = parseFirewallState('  CF_FW|backend|ufw  \n\n  CF_FW|active|1\n\n');

    expect(state.backend).toBe('ufw');
    expect(state.active).toBe(true);
  });
});
