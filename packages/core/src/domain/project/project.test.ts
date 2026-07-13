import { describe, expect, it } from 'vitest';
import { isUuid } from '@cloudforge/shared';
import { Project } from './project.js';

describe('Project.create', () => {
  const valid = { name: 'API', environment: 'production', region: 'eu-frankfurt-1' };

  it('creates a valid draft project', () => {
    const result = Project.create(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshot = result.value.toSnapshot();
    expect(isUuid(snapshot.id)).toBe(true);
    expect(snapshot.name).toBe('API');
    expect(snapshot.status).toBe('draft');
    expect(snapshot.environment).toBe('production');
  });

  it('trims the name and rejects empty names', () => {
    expect(Project.create({ ...valid, name: '   ' }).ok).toBe(false);
    const padded = Project.create({ ...valid, name: '  API  ' });
    expect(padded.ok && padded.value.name).toBe('API');
  });

  it('rejects an invalid environment', () => {
    const result = Project.create({ ...valid, environment: 'prod' });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty region', () => {
    expect(Project.create({ ...valid, region: ' ' }).ok).toBe(false);
  });

  it('normalises tags (lowercase, de-duplicated)', () => {
    const result = Project.create({ ...valid, tags: ['Web', 'web', ' API '] });
    expect(result.ok && result.value.toSnapshot().tags).toEqual(['web', 'api']);
  });
});

describe('Project.update', () => {
  it('applies partial updates and bumps updatedAt', () => {
    const created = Project.create(
      { name: 'API', environment: 'staging', region: 'eu-frankfurt-1' },
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = created.value.update(
      { status: 'active' },
      new Date('2026-01-02T00:00:00.000Z'),
    );
    expect(updated.ok).toBe(true);
    const snapshot = created.value.toSnapshot();
    expect(snapshot.status).toBe('active');
    expect(snapshot.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(snapshot.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects an invalid update without mutating state', () => {
    const created = Project.create({ name: 'API', environment: 'staging', region: 'r' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = created.value.update({ name: '' });
    expect(result.ok).toBe(false);
    expect(created.value.name).toBe('API');
  });
});
