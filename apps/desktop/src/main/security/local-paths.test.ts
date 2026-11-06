import { describe, expect, it } from 'vitest';
import { requireLocalPath } from './local-paths.js';

describe('requireLocalPath', () => {
  it('accepts a complete path on this computer', () => {
    const path = process.platform === 'win32' ? 'C:\\Users\\alex\\.env' : '/home/alex/.env';
    expect(requireLocalPath(path)).toBe(path);
  });

  it.each(['', '   ', 'a\0b'])('refuses an unusable path %#', (path) => {
    expect(() => requireLocalPath(path)).toThrow('A file path is required');
  });

  it('refuses a relative path', () => {
    expect(() => requireLocalPath('secrets/.env')).toThrow('relative');
  });

  it.each(['\\\\server\\share\\.env', '//server/share/.env'])(
    'refuses the network share %s',
    (path) => {
      expect(() => requireLocalPath(path)).toThrow('Network paths');
    },
  );
});
