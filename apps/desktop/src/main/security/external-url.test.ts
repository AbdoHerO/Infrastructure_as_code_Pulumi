import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from './external-url.js';

describe('isSafeExternalUrl', () => {
  it('allows HTTPS and rejects executable or local protocols', () => {
    expect(isSafeExternalUrl('https://github.com/CloudForge')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/secrets.txt')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});
