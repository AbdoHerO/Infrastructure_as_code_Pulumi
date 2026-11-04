import { describe, expect, it } from 'vitest';
import { withToolDirectories } from './tool-path.js';

describe('withToolDirectories', () => {
  it('adds the Homebrew and Pulumi directories on macOS after the existing PATH', () => {
    expect(withToolDirectories('/usr/bin:/bin', 'darwin', '/Users/alex')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/alex/.pulumi/bin',
    );
  });

  it('does not repeat a directory that is already present', () => {
    expect(withToolDirectories('/usr/local/bin:/usr/bin', 'darwin', '/Users/alex')).toBe(
      '/usr/local/bin:/usr/bin:/opt/homebrew/bin:/Users/alex/.pulumi/bin',
    );
  });

  it('works when PATH is empty', () => {
    expect(withToolDirectories(undefined, 'darwin', '/Users/alex')).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/Users/alex/.pulumi/bin',
    );
  });

  it('leaves other platforms unchanged', () => {
    expect(withToolDirectories('C:\\Windows', 'win32', 'C:\\Users\\x')).toBe('C:\\Windows');
    expect(withToolDirectories(undefined, 'linux', '/home/x')).toBeUndefined();
  });
});
