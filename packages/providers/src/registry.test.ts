import { describe, expect, it } from 'vitest';
import { DefaultProviderFactory } from './registry.js';

describe('DefaultProviderFactory', () => {
  it('registers AWS without changing Oracle registration', () => {
    const factory = new DefaultProviderFactory();
    expect(factory.supports('oracle')).toBe(true);
    expect(factory.supports('aws')).toBe(true);
    expect(factory.supports('azure')).toBe(false);
  });

  it('continues constructing the Oracle adapter from Oracle credentials', () => {
    const result = new DefaultProviderFactory().create('oracle', {
      tenancyOcid: 'ocid1.tenancy.oc1..example',
      userOcid: 'ocid1.user.oc1..example',
      compartmentOcid: 'ocid1.compartment.oc1..example',
      fingerprint: 'aa:bb',
      privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      region: 'eu-frankfurt-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('oracle');
  });
});
