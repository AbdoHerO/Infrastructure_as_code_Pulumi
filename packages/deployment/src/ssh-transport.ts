/**
 * Shared SSH transport primitives for every adapter that operates on a trusted
 * VPS target.
 *
 * Each adapter previously hand-rolled its own connect/exec/fingerprint pair, so
 * the same host-key verification and privilege-escalation logic existed five
 * times over and had already drifted. This module owns those primitives once;
 * adapters supply only their own operation label and timeout.
 *
 * Nothing here is provider- or feature-specific.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import type { DeploymentTarget } from '@cloudforge/core';

export const SSH_CONNECT_TIMEOUT_MS = 20_000;

/**
 * The structural shape every port's event type shares (`NginxEvent`,
 * `AnsibleEvent`, `DeployEvent`, `CertificateEvent`). Keeping one shape here
 * lets adapters pass their own sink through unchanged.
 */
export interface SshEvent {
  readonly stream: 'stdout' | 'stderr' | 'step' | 'error';
  readonly message: string;
}

export type SshEventSink = (event: SshEvent) => void;

export interface SshOperationOptions {
  /** Operation name used in error text, e.g. `Nginx` → "Remote Nginx command timed out". */
  readonly label: string;
  readonly signal?: AbortSignal | undefined;
  readonly connectTimeoutMs?: number | undefined;
}

export interface SshExecOptions {
  readonly label: string;
  readonly timeoutMs: number;
  readonly onEvent?: SshEventSink | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SshCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Wrap a value as a single POSIX shell word.
 *
 * The only correct way to embed arbitrary text in a `sh -c` string: close the
 * quote, emit an escaped literal quote, reopen. Prefer this over allow-list
 * regexes whenever the value can contain anything a user typed.
 */
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** OpenSSH-style SHA-256 host-key fingerprint (`SHA256:<base64>`, unpadded). */
export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** Normalise a fingerprint for comparison: no `SHA256:` prefix, no base64 padding. */
export function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}

/**
 * Build an ssh2 config that verifies the pinned host key.
 *
 * `hostVerifier` returning false aborts the handshake before authentication, so
 * a changed server identity can never receive credentials.
 */
export function sshConnectionConfig(
  target: DeploymentTarget,
  connectTimeoutMs: number = SSH_CONNECT_TIMEOUT_MS,
): ConnectConfig {
  if (!target.privateKey && !target.password)
    throw new DeploymentError('An SSH private key or password is required');
  return {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: connectTimeoutMs,
    hostVerifier: (key: Buffer) =>
      normalizeFingerprint(fingerprintHostKey(key)) === normalizeFingerprint(target.hostKeySha256),
    ...(target.privateKey ? { privateKey: target.privateKey } : {}),
    ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    ...(target.password ? { password: target.password } : {}),
  };
}

/**
 * Open one verified connection, run `action`, and always disconnect.
 *
 * `action` receives the live client, so a caller needing several commands pays
 * for a single handshake instead of one per command.
 */
export function withSshConnection<T>(
  target: DeploymentTarget,
  options: SshOperationOptions,
  action: (client: Client) => Promise<T>,
): Promise<Result<T, DeploymentError>> {
  const { label, signal, connectTimeoutMs } = options;
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (result: Result<T, DeploymentError>): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      client.end();
      resolve(result);
    };
    const abort = (): void => finish(err(new DeploymentError(`${label} operation cancelled`)));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    client.once('error', (cause) =>
      finish(
        err(
          new DeploymentError(`${label} SSH connection or host-key verification failed`, { cause }),
        ),
      ),
    );
    client.once('ready', () => {
      void action(client)
        .then((value) => finish(ok(value)))
        .catch((cause) =>
          finish(
            err(
              cause instanceof DeploymentError
                ? cause
                : new DeploymentError(`Remote ${label} operation failed`, { cause }),
            ),
          ),
        );
    });
    try {
      client.connect(sshConnectionConfig(target, connectTimeoutMs));
    } catch (cause) {
      // `sshConnectionConfig` throws for a target with no key and no password.
      // Surface it as a Result rather than an unhandled rejection.
      finish(
        err(
          cause instanceof DeploymentError
            ? cause
            : new DeploymentError('Invalid SSH target', { cause }),
        ),
      );
    }
  });
}

/**
 * Run one command, streaming output as it arrives. Rejects on a non-zero exit
 * so callers cannot mistake a failed command for an empty result.
 */
export function execCommand(
  client: Client,
  command: string,
  options: SshExecOptions,
): Promise<SshCommandOutput> {
  const { label, timeoutMs, onEvent, signal } = options;
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (cause?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (cause) reject(cause);
        else
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
      };
      const abort = (): void => {
        stream.close();
        finish(new DeploymentError(`${label} operation cancelled`));
      };
      const timer = setTimeout(() => {
        stream.close();
        finish(new DeploymentError(`Remote ${label} command timed out`));
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      stream.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        onEvent?.({ stream: 'stdout', message: chunk.toString('utf8') });
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        onEvent?.({ stream: 'stderr', message: chunk.toString('utf8') });
      });
      stream.on('close', (code: number | null) => {
        if (code === 0) finish();
        else
          finish(
            new DeploymentError(
              Buffer.concat(stderr).toString('utf8').trim() ||
                `Remote command failed with exit ${code ?? 'unknown'}`,
            ),
          );
      });
    });
  });
}

/** Write a file over SFTP with owner-only permissions by default. */
export function uploadFile(
  client: Client,
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  return new Promise((resolve, reject) =>
    client.sftp((error, sftp: SFTPWrapper) => {
      if (error) return reject(error);
      sftp.writeFile(path, Buffer.from(content, 'utf8'), { mode }, (writeError) =>
        writeError ? reject(writeError) : resolve(),
      );
    }),
  );
}

/**
 * Wrap a multi-line script so it runs with privilege and leaves nothing behind.
 *
 * The script is base64-encoded rather than interpolated, so its content can
 * never be reinterpreted by the invoking shell. It is written mode 700, run as
 * root directly or via `sudo -n`, then removed — and the original exit code is
 * preserved so callers still see failures.
 */
export function privilegedScript(script: string, prefix = 'cloudforge'): string {
  const path = `/tmp/${prefix}-${randomUUID()}.sh`;
  return `printf '%s' '${base64(script)}' | base64 -d > ${path} && chmod 700 ${path} && if [ "$(id -u)" -eq 0 ]; then ${path}; else sudo -n ${path}; fi; code=$?; rm -f ${path}; exit $code`;
}

/** Open a connection and run one privileged script on it. */
export function runPrivilegedScript(
  target: DeploymentTarget,
  script: string,
  options: SshExecOptions & { readonly scriptPrefix?: string | undefined },
): Promise<Result<SshCommandOutput, DeploymentError>> {
  const connectionOptions: SshOperationOptions = {
    label: options.label,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return withSshConnection(target, connectionOptions, (client) =>
    execCommand(client, privilegedScript(script, options.scriptPrefix), options),
  );
}

/**
 * Read a server's host-key fingerprint without authenticating.
 *
 * `hostVerifier` captures the key then returns false, so the handshake stops
 * before any credential is offered. Used for trust-on-first-use pinning.
 */
export function inspectHostKeyFingerprint(
  host: string,
  port: number,
  connectTimeoutMs: number = SSH_CONNECT_TIMEOUT_MS,
): Promise<Result<string, DeploymentError>> {
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (result: Result<string, DeploymentError>): void => {
      if (settled) return;
      settled = true;
      client.end();
      resolve(result);
    };
    client.once('error', (cause) =>
      finish(err(new DeploymentError('Failed to inspect SSH host key', { cause }))),
    );
    client.connect({
      host,
      port,
      username: 'cloudforge-host-key-inspection',
      readyTimeout: connectTimeoutMs,
      hostVerifier: (key: Buffer) => {
        finish(ok(fingerprintHostKey(key)));
        return false;
      },
    });
  });
}
