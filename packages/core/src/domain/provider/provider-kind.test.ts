import { describe, expect, it } from 'vitest';
import { isProviderKind, isProvisioningProviderKind } from './provider-kind.js';

describe('provider capabilities', () => {
  it('enables AWS infrastructure provisioning', () => {
    expect(isProviderKind('aws')).toBe(true);
    expect(isProvisioningProviderKind('aws')).toBe(true);
  });

  it('keeps Oracle infrastructure provisioning enabled', () => {
    expect(isProviderKind('oracle')).toBe(true);
    expect(isProvisioningProviderKind('oracle')).toBe(true);
  });
});
