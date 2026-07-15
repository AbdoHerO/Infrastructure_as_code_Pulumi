import { describe, expect, it } from 'vitest';
import { validateDnsRecord } from './cloudflare-service.js';

describe('validateDnsRecord', () => {
  it('normalizes valid proxied A records', () => {
    const result = validateDnsRecord({
      type: 'A',
      name: ' App.Example.com ',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
      tags: [' production ', ''],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('app.example.com');
      expect(result.value.tags).toEqual(['production']);
    }
  });

  it.each([
    ['@', 'example.com'],
    ['www', 'www.example.com'],
    ['api.dev', 'api.dev.example.com'],
    ['*.preview', '*.preview.example.com'],
    ['already.example.com.', 'already.example.com'],
  ])('normalizes the zone-relative name %s', (name, expected) => {
    const result = validateDnsRecord(
      { type: 'A', name, content: '203.0.113.10', ttl: 1, proxied: true },
      'example.com',
    );
    expect(result.ok && result.value.name).toBe(expected);
  });

  it('normalizes local CNAME targets before checking for self references', () => {
    const valid = validateDnsRecord(
      { type: 'CNAME', name: 'www', content: '@', ttl: 1, proxied: true },
      'example.com',
    );
    expect(valid.ok && valid.value.content).toBe('example.com');

    const invalid = validateDnsRecord(
      { type: 'CNAME', name: 'www', content: 'www', ttl: 1, proxied: true },
      'example.com',
    );
    expect(invalid.ok).toBe(false);
  });

  it.each([
    [{ type: 'A', name: 'example.com', content: '999.0.0.1', ttl: 1, proxied: true }, 'valid A'],
    [
      { type: 'CNAME', name: 'app.example.com', content: 'app.example.com', ttl: 1, proxied: true },
      'CNAME',
    ],
    [
      { type: 'TXT', name: 'example.com', content: 'value', ttl: 1, proxied: true },
      'cannot be proxied',
    ],
    [{ type: 'A', name: 'example.com', content: '203.0.113.10', ttl: 10, proxied: false }, 'TTL'],
    [
      { type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 300, proxied: false },
      'priority',
    ],
  ] as const)('rejects invalid input', (input, message) => {
    const result = validateDnsRecord(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });
});
