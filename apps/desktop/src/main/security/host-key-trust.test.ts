import { describe, expect, it } from 'vitest';
import { HostKeyTrust } from './host-key-trust.js';

describe('HostKeyTrust', () => {
  it('accepts what was just read from that host', () => {
    const trust = new HostKeyTrust();
    trust.remember('203.0.113.5', 22, 'REAL');
    expect(trust.wasInspected('203.0.113.5', 22, 'REAL')).toBe(true);
  });

  it('refuses a fingerprint nobody read', () => {
    expect(new HostKeyTrust().wasInspected('203.0.113.5', 22, 'MADE-UP')).toBe(false);
  });

  it('refuses a different fingerprint, another host and another port', () => {
    const trust = new HostKeyTrust();
    trust.remember('203.0.113.5', 22, 'REAL');
    expect(trust.wasInspected('203.0.113.5', 22, 'OTHER')).toBe(false);
    expect(trust.wasInspected('203.0.113.6', 22, 'REAL')).toBe(false);
    expect(trust.wasInspected('203.0.113.5', 2222, 'REAL')).toBe(false);
  });

  it('ignores case and spaces in the host name', () => {
    const trust = new HostKeyTrust();
    trust.remember(' Server.Example.COM ', 22, 'REAL');
    expect(trust.wasInspected('server.example.com', 22, 'REAL')).toBe(true);
  });

  it('forgets after half an hour', () => {
    let now = 1_000_000;
    const trust = new HostKeyTrust(() => now);
    trust.remember('203.0.113.5', 22, 'REAL');
    now += 29 * 60_000;
    expect(trust.wasInspected('203.0.113.5', 22, 'REAL')).toBe(true);
    now += 2 * 60_000;
    expect(trust.wasInspected('203.0.113.5', 22, 'REAL')).toBe(false);
  });
});
