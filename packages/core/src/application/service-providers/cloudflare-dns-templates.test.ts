import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_DNS_TEMPLATES,
  type CloudflareDnsTemplate,
  cloudflareAddressRecordType,
  cloudflareAnalyticsDates,
  cloudflareDnsTemplateRecord,
} from './cloudflare-dns-templates.js';

const template = (id: string): CloudflareDnsTemplate =>
  CLOUDFLARE_DNS_TEMPLATES.find((item) => item.id === id)!;

describe('cloudflareDnsTemplateRecord', () => {
  it('points an address template at the given address', () => {
    expect(
      cloudflareDnsTemplateRecord(template('api'), 'example.com', '203.0.113.7'),
    ).toMatchObject({
      type: 'A',
      name: 'api.example.com',
      content: '203.0.113.7',
      proxied: true,
      ttl: 1,
    });
  });

  it('uses the zone itself when the template has no prefix', () => {
    expect(
      cloudflareDnsTemplateRecord(template('wordpress'), 'example.com', '203.0.113.7').name,
    ).toBe('example.com');
  });

  it('builds a mail record that is never proxied', () => {
    expect(cloudflareDnsTemplateRecord(template('mail'), 'example.com', '')).toMatchObject({
      type: 'MX',
      content: 'mail.example.com',
      priority: 10,
      proxied: false,
    });
  });

  it('points a CNAME template at the zone', () => {
    expect(cloudflareDnsTemplateRecord(template('nextjs'), 'example.com', '').content).toBe(
      'example.com',
    );
  });
});

describe('cloudflareAnalyticsDates', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0);

  it('covers from midnight to now for today', () => {
    expect(cloudflareAnalyticsDates('today', now)).toEqual({
      since: new Date(2026, 5, 15).toISOString(),
      until: now.toISOString(),
    });
  });

  it('covers the whole previous day for yesterday', () => {
    expect(cloudflareAnalyticsDates('yesterday', now)).toEqual({
      since: new Date(2026, 5, 14).toISOString(),
      until: new Date(2026, 5, 15).toISOString(),
    });
  });

  it('counts back whole days for a rolling range', () => {
    const { since } = cloudflareAnalyticsDates('30d', now);
    expect(now.getTime() - new Date(since).getTime()).toBe(30 * 86400000);
  });
});

describe('cloudflareAddressRecordType', () => {
  it('tells IPv6 from IPv4', () => {
    expect(cloudflareAddressRecordType('203.0.113.7')).toBe('A');
    expect(cloudflareAddressRecordType('2001:db8::1')).toBe('AAAA');
  });
});
