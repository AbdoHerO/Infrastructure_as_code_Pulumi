import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '@cloudforge/shared';
import { InMemoryProjectContext } from './project-context.js';

describe('InMemoryProjectContext', () => {
  it('invalidates leases when a project is switched or locked', () => {
    const context = new InMemoryProjectContext();
    expect(() => context.requireActive()).toThrow(UnauthorizedError);

    const first = context.activate('project-a');
    expect(context.isCurrent(first)).toBe(true);

    const second = context.activate('project-b');
    expect(context.isCurrent(first)).toBe(false);
    expect(context.isCurrent(second)).toBe(true);
    expect(second.generation).toBeGreaterThan(first.generation);

    context.clear();
    expect(context.isCurrent(second)).toBe(false);
    expect(context.current()).toBeNull();
  });
});
