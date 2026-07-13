import { Client, type ConnectConfig } from 'ssh2';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import type {
  DeployEventSink,
  Deployer,
  DeploymentOutcome,
  DeploymentStep,
  DeploymentTarget,
} from '@cloudforge/core';

const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Runs deployment steps sequentially over an SSH connection, streaming stdout /
 * stderr per step and stopping on the first non-zero exit. Implements the
 * {@link Deployer} port from `@cloudforge/core`.
 */
export class SshDeployer implements Deployer {
  async deploy(
    target: DeploymentTarget,
    steps: readonly DeploymentStep[],
    onEvent?: DeployEventSink,
  ): Promise<Result<DeploymentOutcome, DeploymentError>> {
    const connection = new Client();

    const connected = await connect(connection, target);
    if (!connected.ok) {
      connection.end();
      return connected;
    }

    let completed = 0;
    try {
      for (const step of steps) {
        onEvent?.({ stream: 'step', message: `▶ ${step.name}` });
        const code = await exec(connection, step.command, onEvent);
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
): Promise<Result<void, DeploymentError>> {
  return new Promise((resolve) => {
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    };
    connection.once('ready', () => resolve(ok(undefined)));
    connection.once('error', (cause) =>
      resolve(err(new DeploymentError('SSH connection failed', { cause }))),
    );
    connection.connect(config);
  });
}

function exec(connection: Client, command: string, onEvent?: DeployEventSink): Promise<number> {
  return new Promise((resolve, reject) => {
    connection.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      stream
        .on('close', (code: number | null) => resolve(code ?? 0))
        .on('data', (data: Buffer) =>
          onEvent?.({ stream: 'stdout', message: data.toString('utf8') }),
        );
      stream.stderr.on('data', (data: Buffer) =>
        onEvent?.({ stream: 'stderr', message: data.toString('utf8') }),
      );
    });
  });
}
