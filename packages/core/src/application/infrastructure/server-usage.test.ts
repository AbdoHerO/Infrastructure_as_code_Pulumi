import { describe, expect, it } from 'vitest';
import {
  describeServerUsage,
  mayBeInUse,
  targetsForServers,
  type ServerTargetLink,
  type ServerUsage,
} from './server-usage.js';

function target(partial: Partial<ServerTargetLink> & { id: string }): ServerTargetLink {
  return {
    name: partial.id,
    host: '192.0.2.10',
    managedProjectId: null,
    managedResourceName: null,
    ...partial,
  };
}

function usage(partial: Partial<ServerUsage> = {}): ServerUsage {
  return {
    targetName: 'web',
    host: '192.0.2.10',
    containers: [],
    sites: [],
    pipelines: [],
    stacks: [],
    wordpress: [],
    unchecked: [],
    ...partial,
  };
}

describe('targetsForServers', () => {
  const targets = [
    target({ id: 'linked', managedProjectId: 'p1', managedResourceName: 'web' }),
    target({
      id: 'other-server',
      managedProjectId: 'p1',
      managedResourceName: 'db',
      host: '192.0.2.11',
    }),
    target({ id: 'by-hand', host: '192.0.2.10' }),
    target({
      id: 'other-project',
      managedProjectId: 'p2',
      managedResourceName: 'web',
      host: '192.0.2.99',
    }),
  ];

  it('finds the linked target and one added by hand with the same address', () => {
    const found = targetsForServers(targets, {
      project: 'p1',
      servers: ['web'],
      addresses: { web: '192.0.2.10', db: '192.0.2.11' },
    });
    expect(found.map((t) => t.id)).toEqual(['linked', 'by-hand']);
  });

  it('takes every server of the project for a destroy', () => {
    const found = targetsForServers(targets, { project: 'p1', servers: 'all', addresses: {} });
    expect(found.map((t) => t.id)).toEqual(['linked', 'other-server']);
  });

  it('finds the servers of a stack whose project record is gone', () => {
    const found = targetsForServers(targets, {
      project: (id) => id === 'p2',
      servers: 'all',
      addresses: {},
    });
    expect(found.map((t) => t.id)).toEqual(['other-project']);
  });

  it('never picks another project’s server', () => {
    const found = targetsForServers(targets, {
      project: 'p1',
      servers: 'all',
      addresses: { web: '192.0.2.10' },
    });
    expect(found.map((t) => t.id)).not.toContain('other-project');
  });
});

describe('server usage', () => {
  it('counts a failed check as possibly in use', () => {
    expect(mayBeInUse(usage())).toBe(false);
    expect(mayBeInUse(usage({ containers: ['nginx'] }))).toBe(true);
    expect(mayBeInUse(usage({ unchecked: ['containers: timed out'] }))).toBe(true);
  });

  it('lists what runs on each server', () => {
    const text = describeServerUsage([
      usage({
        containers: ['app', 'db'],
        sites: ['example.com'],
        unchecked: ['pipelines: offline'],
      }),
    ]);
    expect(text).toContain('web (192.0.2.10)');
    expect(text).toContain('Containers (2): app, db');
    expect(text).toContain('Nginx sites (1): example.com');
    expect(text).toContain('Could not check: pipelines: offline');
  });

  it('says so when no target is saved for the servers', () => {
    expect(describeServerUsage([])).toContain('cannot tell what runs on them');
  });
});
