import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const WINDOWS_GIT_SHELLS = [
  'C:\\Program Files\\Git\\bin\\sh.exe',
  'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
];

function shellExecutable(): string {
  if (process.platform !== 'win32') return 'sh';
  return WINDOWS_GIT_SHELLS.find(existsSync) ?? 'sh';
}

/**
 * Ask a real POSIX shell whether a generated script parses.
 *
 * Git for Windows supplies the shell used by the release toolchain, but it is
 * not necessarily present on PATH in PowerShell or CI child processes.
 */
export function parsesAsShell(script: string): boolean {
  try {
    execFileSync(shellExecutable(), ['-n'], {
      input: script,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
