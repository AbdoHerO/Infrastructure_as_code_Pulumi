import { describe, expect, it } from 'vitest';
import { isProviderKind, isProvisioningProviderKind } from './provider-kind.js';

describe('provider capabilities', () => {
  it('recognizes AWS as a provider without enabling infrastructure mutation', () => {
    expect(isProviderKind('aws')).toBe(true);
    expect(isProvisioningProviderKind('aws')).toBe(false);
  });

  it('keeps Oracle infrastructure provisioning enabled', () => {
    expect(isProviderKind('oracle')).toBe(true);
    expect(isProvisioningProviderKind('oracle')).toBe(true);
  });
});
