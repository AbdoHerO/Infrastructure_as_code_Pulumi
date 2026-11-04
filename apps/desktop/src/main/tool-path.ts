import { posix } from 'node:path';

/**
 * Directories where macOS users install command-line tools. An app opened from
 * Finder or the Dock inherits launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:
 * /sbin), so a Pulumi CLI installed with Homebrew or Pulumi's own installer
 * would be invisible to CloudForge even though `pulumi version` works in a
 * terminal.
 */
export function macToolDirectories(home: string): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.pulumi', 'bin')];
}

/**
 * Return PATH with the macOS tool directories appended when missing. Existing
 * entries keep their order and precedence; other platforms are unchanged.
 */
export function withToolDirectories(
  path: string | undefined,
  platform: NodeJS.Platform,
  home: string,
): string | undefined {
  if (platform !== 'darwin') return path;
  const entries = (path ?? '').split(posix.delimiter).filter((entry) => entry !== '');
  for (const directory of macToolDirectories(home)) {
    if (!entries.includes(directory)) entries.push(directory);
  }
  return entries.join(posix.delimiter);
}
