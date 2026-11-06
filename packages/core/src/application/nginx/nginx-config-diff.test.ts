import { describe, expect, it } from 'vitest';
import { changedLineCount, nginxConfigChanges } from './nginx-config-diff.js';

describe('nginxConfigChanges', () => {
  it('finds nothing in identical configs', () => {
    expect(nginxConfigChanges('a\nb', 'a\nb')).toEqual([]);
  });

  it('reports each differing position with both versions', () => {
    expect(nginxConfigChanges('a\nb\nc', 'a\nx\nc')).toEqual([
      { line: 2, before: 'b', after: 'x' },
    ]);
  });

  it('reports added and removed lines as null on the missing side', () => {
    expect(nginxConfigChanges('a', 'a\nb')).toEqual([{ line: 2, before: null, after: 'b' }]);
    expect(nginxConfigChanges('a\nb', 'a')).toEqual([{ line: 2, before: 'b', after: null }]);
  });

  it('counts the same positions', () => {
    expect(changedLineCount('a\nb\nc', 'x\nb\ny')).toBe(2);
  });
});
