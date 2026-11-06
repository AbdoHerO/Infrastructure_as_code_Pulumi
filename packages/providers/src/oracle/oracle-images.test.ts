import { describe, expect, it } from 'vitest';
import { mapOciImage } from './oracle-provider.js';

const image = {
  id: 'ocid1.image.oc1..aaa',
  displayName: 'Canonical-Ubuntu-24.04-2026.09.01-0',
  operatingSystem: 'Canonical Ubuntu',
  operatingSystemVersion: '24.04',
  timeCreated: '2026-09-01T00:00:00.000Z',
};

describe('OCI machine images', () => {
  it('maps an image to the provider-neutral shape', () => {
    expect(mapOciImage(image)).toEqual({
      id: 'ocid1.image.oc1..aaa',
      name: 'Canonical-Ubuntu-24.04-2026.09.01-0',
      operatingSystem: 'Canonical Ubuntu 24.04',
      architecture: 'x86_64',
      owner: 'Oracle',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('recognises an ARM image from its name', () => {
    const arm = { ...image, displayName: 'Canonical-Ubuntu-24.04-aarch64-2026.09.01-0' };
    expect(mapOciImage(arm).architecture).toBe('arm64');
  });

  it('tells a custom image from an Oracle one', () => {
    expect(mapOciImage({ ...image, compartmentId: 'ocid1.compartment' }).owner).toBe(
      'ocid1.compartment',
    );
  });

  it('copes with missing optional fields', () => {
    const bare = { id: 'x', displayName: 'custom' };
    expect(mapOciImage(bare)).toEqual({
      id: 'x',
      name: 'custom',
      operatingSystem: 'Unknown',
      architecture: 'x86_64',
      owner: 'Oracle',
    });
  });
});
