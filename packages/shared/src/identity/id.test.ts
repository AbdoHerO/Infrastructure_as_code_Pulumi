import { describe, expect, it } from 'vitest';
import { isUuid, newUuid, parseUuid } from './id.js';

describe('Uuid', () => {
  it('generates valid, unique UUIDs', () => {
    const a = newUuid();
    const b = newUuid();
    expect(isUuid(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('validates well-formed and rejects malformed strings', () => {
    expect(isUuid(newUuid())).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });

  it('parses valid UUIDs and returns null otherwise', () => {
    const valid = newUuid();
    expect(parseUuid(valid)).toBe(valid);
    expect(parseUuid('nope')).toBeNull();
  });
});
