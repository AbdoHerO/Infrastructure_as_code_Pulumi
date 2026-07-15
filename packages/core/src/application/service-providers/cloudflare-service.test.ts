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
  ] as const)('rejects invalid input', (input, message) => {
    const result = validateDnsRecord(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });
});
