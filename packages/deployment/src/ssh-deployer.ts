import { createHash } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import type {
  DeployEventSink,
  Deployer,
  DeploymentOutcome,
  DeploymentStep,
  DeploymentTarget,
  DeploymentOptions,
} from '@cloudforge/core';

const CONNECT_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 15 * 60_000;

/**
 * Runs deployment steps sequentially over an SSH connection, streaming stdout /
 * stderr per step and stopping on the first non-zero exit. Implements the
 * {@link Deployer} port from `@cloudforge/core`.
 */
export class SshDeployer implements Deployer {
  inspectHostKey(host: string, port: number): Promise<Result<string, DeploymentError>> {
    return inspectHostKey(host, port);
  }

  async deploy(
    target: DeploymentTarget,
    steps: readonly DeploymentStep[],
    onEvent?: DeployEventSink,
    options: DeploymentOptions = {},
  ): Promise<Result<DeploymentOutcome, DeploymentError>> {
    const connection = new Client();

    const connected = await connect(connection, target, options.signal);
    if (!connected.ok) {
      connection.end();
      return connected;
    }

    let completed = 0;
    try {
      for (const step of steps) {
        if (options.signal?.aborted) throw new DeploymentError('Deployment cancelled');
        onEvent?.({ stream: 'step', message: `▶ ${step.name}` });
        const code = await exec(
          connection,
          step.command,
          onEvent,
          options.signal,
          options.stepTimeoutMs ?? STEP_TIMEOUT_MS,
        );
        if (code !== 0) {
          onEvent?.({ stream: 'error', message: `Step "${step.name}" failed (exit ${code})` });
          return ok({ success: false, completedSteps: completed, totalSteps: steps.length });
        }
        completed += 1;
      }
      onEvent?.({ stream: 'step', message: '✓ Deployment complete' });
      return ok({ success: true, completedSteps: completed, totalSteps: steps.length });
    } catch (cause) {
      return err(new DeploymentError('Deployment step failed', { cause }));
    } finally {
      connection.end();
    }
  }
}

function connect(
  connection: Client,
  target: DeploymentTarget,
  signal?: AbortSignal,
): Promise<Result<void, DeploymentError>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Result<void, DeploymentError>): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      connection.end();
      finish(err(new DeploymentError('Deployment cancelled')));
    };
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => fingerprintHostKey(key) === target.hostKeySha256,
      ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    connection.once('ready', () => finish(ok(undefined)));
    connection.once('error', (cause) =>
      finish(err(new DeploymentError('SSH connection or host-key verification failed', { cause }))),
    );
    connection.connect(config);
  });
}

function exec(
  connection: Client,
  command: string,
  onEvent: DeployEventSink | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    connection.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(code);
      };
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        stream.close();
        reject(cause instanceof Error ? cause : new DeploymentError(String(cause)));
      };
      const onAbort = (): void => fail(new DeploymentError('Deployment cancelled'));
      const timer = setTimeout(
        () => fail(new DeploymentError(`Deployment step timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      stream
        .on('close', (code: number | null, signalName: string | null) => {
          if (code === null) {
            fail(
              new DeploymentError(
                `Remote command closed without an exit code${signalName ? ` (${signalName})` : ''}`,
              ),
            );
          } else {
            finish(code);
          }
        })
        .on('data', (data: Buffer) =>
          onEvent?.({ stream: 'stdout', message: data.toString('utf8') }),
        );
      stream.stderr.on('data', (data: Buffer) =>
        onEvent?.({ stream: 'stderr', message: data.toString('utf8') }),
      );
    });
  });
}

function inspectHostKey(host: string, port: number): Promise<Result<string, DeploymentError>> {
  return new Promise((resolve) => {
    const connection = new Client();
    let settled = false;
    const finish = (result: Result<string, DeploymentError>): void => {
      if (settled) return;
      settled = true;
      connection.end();
      resolve(result);
    };
    connection.once('error', (cause) => {
      if (!settled) finish(err(new DeploymentError('Failed to inspect SSH host key', { cause })));
    });
    connection.connect({
      host,
      port,
      username: 'cloudforge-host-key-inspection',
      readyTimeout: CONNECT_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        finish(ok(fingerprintHostKey(key)));
        return false;
      },
    });
  });
}

function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}
