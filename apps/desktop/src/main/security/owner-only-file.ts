import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';

interface CommandResult {
  readonly stdout: string;
}

interface OwnerOnlyFileRuntime {
  readonly platform: NodeJS.Platform;
  readonly run: (command: string, args: readonly string[]) => Promise<CommandResult>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
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

const systemRuntime: OwnerOnlyFileRuntime = {
  platform: process.platform,
  run: runCommand,
  chmod,
};

/**
 * Restrict a local file or directory to the current OS user. Windows OpenSSH
 * validates NTFS ACLs and ignores POSIX-style modes, so icacls is mandatory.
 */
export async function enforceOwnerOnlyPath(
  path: string,
  mode: number,
  runtime: OwnerOnlyFileRuntime = systemRuntime,
): Promise<void> {
  if (runtime.platform !== 'win32') {
    await runtime.chmod(path, mode);
    return;
  }

  const identity = (await runtime.run('whoami.exe', [])).stdout.trim();
  if (!identity || /[\r\n]/.test(identity)) {
    throw new Error('Could not determine the current Windows identity for SSH key permissions');
  }

  // One invocation avoids leaving the key inaccessible between removing
  // inherited access and granting the current user full control.
  await runtime.run('icacls.exe', [path, '/inheritance:r', '/grant:r', `${identity}:(F)`]);
}
