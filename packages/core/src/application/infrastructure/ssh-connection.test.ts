import { describe, expect, it } from 'vitest';
import { extractSshConnectionHints, formatSshCommand } from './ssh-connection.js';

describe('SSH connection hints', () => {
  it('extracts public instances and formats commands', () => {
    const connections = extractSshConnectionHints({
      'api-serverPublicIp': '51.170.135.49',
      'api-serverPrivateIp': '10.0.1.47',
      'api-serverSshUser': 'ubuntu',
      providerKind: 'oracle',
    });

    expect(connections).toEqual([
      { resourceName: 'api-server', host: '51.170.135.49', user: 'ubuntu' },
    ]);
    expect(formatSshCommand(connections[0]!)).toBe('ssh ubuntu@51.170.135.49');
    expect(formatSshCommand(connections[0]!, 'C:\\Users\\test\\.ssh\\cloudforge-server')).toBe(
      'ssh -i "C:\\Users\\test\\.ssh\\cloudforge-server" ubuntu@51.170.135.49',
    );
  });

  it('supports IPv6 and rejects unsafe or incomplete output values', () => {
    const connections = extractSshConnectionHints({
      ipv6PublicIp: '2001:db8::10',
      ipv6SshUser: 'opc',
      missingUserPublicIp: '192.0.2.1',
      unsafePublicIp: 'host; shutdown',
      unsafeSshUser: 'root',
    });

    expect(connections).toEqual([{ resourceName: 'ipv6', host: '2001:db8::10', user: 'opc' }]);
    expect(formatSshCommand(connections[0]!)).toBe('ssh opc@2001:db8::10');
  });
});
