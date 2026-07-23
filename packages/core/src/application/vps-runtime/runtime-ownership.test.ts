import { describe, expect, it } from 'vitest';
import {
  classifyObservedExposure,
  classifyOwnership,
  isLoopbackAddress,
  isOwned,
  isPubliclyReachable,
  isWildcardAddress,
  RUNTIME_LABELS,
} from './runtime-ownership.js';

describe('classifyOwnership', () => {
  it('recognises a resource CloudForge created', () => {
    expect(classifyOwnership({ labels: { [RUNTIME_LABELS.managed]: 'true' } })).toBe(
      'cloudforge-managed',
    );
  });

  it('distinguishes a resource handed over by a user from one CloudForge made', () => {
    expect(
      classifyOwnership({
        labels: { [RUNTIME_LABELS.managed]: 'true', [RUNTIME_LABELS.adopted]: 'true' },
      }),
    ).toBe('adopted');
  });

  it('defaults to unmanaged when there is no evidence', () => {
    // Claiming something CloudForge did not create is the one mistake here that
    // destroys a user's work, so absence of evidence is never evidence.
    expect(classifyOwnership({ labels: {} })).toBe('unmanaged');
    expect(classifyOwnership({ labels: { app: 'someone-elses' } })).toBe('unmanaged');
  });

  it('does not accept a label value other than true as ownership', () => {
    expect(classifyOwnership({ labels: { [RUNTIME_LABELS.managed]: 'false' } })).toBe('unmanaged');
    expect(classifyOwnership({ labels: { [RUNTIME_LABELS.managed]: '1' } })).toBe('unmanaged');
  });

  it.each([
    '/opt/cloudforge/compose/shop',
    '/opt/cloudforge/apps/dockhand',
    '/opt/cloudforge/apps/portainer',
  ])('recognises a Compose project built by an earlier release at %s', (workingDir) => {
    expect(
      classifyOwnership({ labels: { 'com.docker.compose.project.working_dir': workingDir } }),
    ).toBe('legacy-managed');
  });

  it('does not treat a lookalike path as CloudForge-created', () => {
    expect(
      classifyOwnership({
        labels: { 'com.docker.compose.project.working_dir': '/home/user/cloudforge-clone' },
      }),
    ).toBe('unmanaged');
    expect(
      classifyOwnership({
        labels: { 'com.docker.compose.project.working_dir': '/opt/cloudforge-other/x' },
      }),
    ).toBe('unmanaged');
  });

  it('prefers an explicit label over a legacy path', () => {
    expect(
      classifyOwnership({
        labels: {
          [RUNTIME_LABELS.managed]: 'true',
          'com.docker.compose.project.working_dir': '/opt/cloudforge/compose/shop',
        },
      }),
    ).toBe('cloudforge-managed');
  });
});

describe('isOwned', () => {
  it('permits changes only to what CloudForge created or was given', () => {
    expect(isOwned('cloudforge-managed')).toBe(true);
    expect(isOwned('adopted')).toBe(true);
  });

  it('withholds authority over legacy and foreign resources', () => {
    // legacy-managed is recognised, not owned: it needs explicit adoption.
    expect(isOwned('legacy-managed')).toBe(false);
    expect(isOwned('unmanaged')).toBe(false);
  });
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.0.1.1', '::1', '[::1]', 'localhost', ' 127.0.0.1 '])(
    'treats %s as reachable only from the VPS itself',
    (address) => {
      expect(isLoopbackAddress(address)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '10.0.0.5', '203.0.113.10'])('treats %s as routable', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe('isWildcardAddress', () => {
  it.each(['0.0.0.0', '::', '[::]', '*', ''])('recognises %s as every interface', (address) => {
    expect(isWildcardAddress(address)).toBe(true);
  });

  it('does not treat a specific address as a wildcard', () => {
    expect(isWildcardAddress('127.0.0.1')).toBe(false);
    expect(isWildcardAddress('10.0.0.5')).toBe(false);
  });
});

describe('classifyObservedExposure', () => {
  it('calls an unpublished port internal', () => {
    expect(classifyObservedExposure(null, null)).toBe('internal');
  });

  it('separates a loopback publish from a routable one', () => {
    expect(classifyObservedExposure(3000, '127.0.0.1')).toBe('host-loopback');
    expect(classifyObservedExposure(3000, '0.0.0.0')).toBe('direct');
    expect(classifyObservedExposure(3000, '203.0.113.10')).toBe('direct');
  });

  it('assumes the worst when Docker reports no bind address', () => {
    // An unqualified publish binds every interface.
    expect(classifyObservedExposure(3000, null)).toBe('direct');
  });
});

describe('isPubliclyReachable', () => {
  it('is true only for a port published on a routable interface', () => {
    expect(isPubliclyReachable('direct', '0.0.0.0')).toBe(true);
    expect(isPubliclyReachable('direct', null)).toBe(true);
  });

  it('is false for internal, proxy-only and loopback services', () => {
    expect(isPubliclyReachable('internal', null)).toBe(false);
    expect(isPubliclyReachable('proxy-only', null)).toBe(false);
    expect(isPubliclyReachable('host-loopback', '127.0.0.1')).toBe(false);
    expect(isPubliclyReachable('direct', '127.0.0.1')).toBe(false);
  });
});
