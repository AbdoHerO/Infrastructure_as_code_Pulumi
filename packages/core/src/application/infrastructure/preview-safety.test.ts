import { describe, expect, it } from 'vitest';
import type { PreviewResourceChange } from '../ports/infrastructure-engine.js';
import { changedServers, isDestructivePreview } from './preview-safety.js';

function change(partial: Partial<PreviewResourceChange>): PreviewResourceChange {
  return {
    urn: `urn:${partial.name ?? 'x'}`,
    name: 'x',
    type: 'Vcn',
    operation: 'update',
    destructive: false,
    changedProperties: [],
    replacementProperties: [],
    ...partial,
  };
}

describe('isDestructivePreview', () => {
  it('catches an update that replaces a server boot disk, which no operation name reveals', () => {
    const preview = {
      hasReplacements: false,
      hasDeletes: false,
      resources: [
        change({
          name: 'always-free-arm',
          type: 'Instance',
          operation: 'update',
          destructive: true,
          changedProperties: ['sourceDetails', 'sourceDetails.sourceId'],
        }),
      ],
    };
    expect(isDestructivePreview(preview)).toBe(true);
  });

  it('still counts replacements and deletions', () => {
    expect(isDestructivePreview({ hasReplacements: true, hasDeletes: false, resources: [] })).toBe(
      true,
    );
    expect(isDestructivePreview({ hasReplacements: false, hasDeletes: true, resources: [] })).toBe(
      true,
    );
  });

  it('lets a harmless update through', () => {
    const preview = {
      hasReplacements: false,
      hasDeletes: false,
      resources: [change({ name: 'firewall' })],
    };
    expect(isDestructivePreview(preview)).toBe(false);
  });
});

describe('changedServers', () => {
  it('lists existing servers that would change, and never new ones', () => {
    const preview = {
      resources: [
        change({ name: 'old', type: 'Instance', operation: 'update' }),
        change({ name: 'gone', type: 'Instance', operation: 'delete' }),
        change({ name: 'new', type: 'Instance', operation: 'create' }),
        change({ name: 'firewall', type: 'SecurityList', operation: 'update' }),
      ],
    };
    expect(changedServers(preview).map((r) => r.name)).toEqual(['old', 'gone']);
  });
});
