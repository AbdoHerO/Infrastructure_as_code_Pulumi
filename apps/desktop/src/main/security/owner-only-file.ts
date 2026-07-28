import { execFile } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';

interface CommandResult {
  readonly stdout: string;
}

interface OwnerOnlyFileRuntime {
  readonly platform: NodeJS.Platform;
  readonly run: (command: string, args: readonly string[]) => Promise<CommandResult>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
}

interface OwnerOnlyTreeRuntime extends OwnerOnlyFileRuntime {
  readonly removeTree: (path: string) => Promise<void>;
}

function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
        return;
      }
      resolve({ stdout });
    });
  });
}

const systemRuntime: OwnerOnlyTreeRuntime = {
  platform: process.platform,
  run: runCommand,
  chmod,
  removeTree: (path) => rm(path, { recursive: true, force: true }),
};

async function windowsIdentity(runtime: OwnerOnlyFileRuntime): Promise<string> {
  const identity = (await runtime.run('whoami.exe', [])).stdout.trim();
  if (!identity || /[\r\n]/.test(identity)) {
    throw new Error('Could not determine the current Windows identity for SSH key permissions');
  }
  return identity;
}

/**
 * Restrict a local file or directory to the current OS user. Windows OpenSSH
 * validates NTFS ACLs and ignores POSIX-style modes, so icacls is mandatory.
 */
export async function enforceOwnerOnlyPath(
  path: string,
  mode: number,
  runtime: OwnerOnlyFileRuntime = systemRuntime,
  kind: 'file' | 'directory' = 'file',
): Promise<void> {
  if (runtime.platform !== 'win32') {
    await runtime.chmod(path, mode);
    return;
  }

  const identity = await windowsIdentity(runtime);

  // `/grant:r` replaces grants for this identity only. It does not remove an
  // explicit grant left by the process default DACL (for example a sandbox
  // group), so reset first to turn the ACL into inherited entries. Removing
  // inheritance in the second call then leaves only our explicit owner grant.
  await runtime.run('icacls.exe', [path, '/reset']);
  const grant = kind === 'directory' ? `${identity}:(OI)(CI)(F)` : `${identity}:(F)`;
  await runtime.run('icacls.exe', [path, '/inheritance:r', '/grant:r', grant]);
}

function isWindowsPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  return code === 'EPERM' || code === 'EACCES';
}

/**
 * Remove a transient owner-only directory. A previous CloudForge version may
 * have left a Windows ACL that even prevents its owner from deleting the key.
 * Repair that exact tree and retry rather than letting stale key material
 * permanently prevent application startup.
 */
export async function removeOwnerOnlyTree(
  path: string,
  runtime: OwnerOnlyTreeRuntime = systemRuntime,
): Promise<void> {
  try {
    await runtime.removeTree(path);
    return;
  } catch (error) {
    if (runtime.platform !== 'win32' || !isWindowsPermissionError(error)) throw error;
  }

  const identity = await windowsIdentity(runtime);
  await runtime.run('icacls.exe', [path, '/reset', '/T', '/C']);
  await runtime.run('icacls.exe', [path, '/grant:r', `${identity}:(F)`, '/T', '/C']);
  await runtime.removeTree(path);
}
