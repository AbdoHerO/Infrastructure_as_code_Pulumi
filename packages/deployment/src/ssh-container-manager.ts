import { createHash } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import type {
  ContainerAction,
  ContainerManager,
  ContainerStats,
  DeploymentTarget,
  RemoteContainer,
} from '@cloudforge/core';

const TIMEOUT_MS = 30_000;
const ID_PATTERN = /^(?:[a-f0-9]{12,64}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class SshContainerManager implements ContainerManager {
  async list(target: DeploymentTarget): Promise<Result<RemoteContainer[], DeploymentError>> {
    const output = await run(target, `sudo docker ps -a --no-trunc --format '{{json .}}'`);
    if (!output.ok) return output;
    try {
      return ok(
        output.value
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const item = JSON.parse(line) as Record<string, string>;
            return {
              id: item.ID ?? '',
              name: item.Names ?? '',
              image: item.Image ?? '',
              state: item.State ?? '',
              status: item.Status ?? '',
              ports: item.Ports ?? '',
            };
          }),
      );
    } catch (cause) {
      return err(new DeploymentError('Docker returned malformed container data', { cause }));
    }
  }

  async action(
    target: DeploymentTarget,
    containerId: string,
    action: ContainerAction,
  ): Promise<Result<void, DeploymentError>> {
    if (!ID_PATTERN.test(containerId)) return err(new DeploymentError('Invalid container id'));
    const command =
      action === 'remove'
        ? `sudo docker rm -f -- ${containerId}`
        : `sudo docker ${action} -- ${containerId}`;
    const output = await run(target, command);
    return output.ok ? ok(undefined) : output;
  }

  logs(
    target: DeploymentTarget,
    containerId: string,
    lines: number,
  ): Promise<Result<string, DeploymentError>> {
    if (!ID_PATTERN.test(containerId))
      return Promise.resolve(err(new DeploymentError('Invalid container id')));
    const safeLines = Math.min(5000, Math.max(1, Math.trunc(lines)));
    return run(target, `sudo docker logs --tail ${safeLines} --timestamps -- ${containerId}`);
  }

  async stats(
    target: DeploymentTarget,
    containerId: string,
  ): Promise<Result<ContainerStats, DeploymentError>> {
    if (!ID_PATTERN.test(containerId)) return err(new DeploymentError('Invalid container id'));
    const output = await run(
      target,
      `sudo docker stats --no-stream --format '{{json .}}' -- ${containerId}`,
    );
    if (!output.ok) return output;
    try {
      const value = JSON.parse(output.value.trim()) as Record<string, string>;
      return ok({
        name: value.Name ?? containerId,
        cpu: value.CPUPerc ?? '—',
        memory: value.MemUsage ?? '—',
        networkIo: value.NetIO ?? '—',
        blockIo: value.BlockIO ?? '—',
      });
    } catch (cause) {
      return err(new DeploymentError('Docker returned malformed statistics', { cause }));
    }
  }

  async deployCompose(
    target: DeploymentTarget,
    projectName: string,
    composeYaml: string,
  ): Promise<Result<void, DeploymentError>> {
    if (!PROJECT_PATTERN.test(projectName))
      return err(new DeploymentError('Invalid Compose project name'));
    if (!composeYaml.trim() || composeYaml.length > 512_000)
      return err(new DeploymentError('Compose YAML must be 1–512000 characters'));
    const encoded = Buffer.from(composeYaml, 'utf8').toString('base64');
    const directory = `/opt/cloudforge/compose/${projectName}`;
    const command =
      `sudo mkdir -p ${directory} && ` +
      `printf '%s' '${encoded}' | base64 -d | sudo tee ${directory}/compose.yaml >/dev/null && ` +
      `cd ${directory} && sudo docker compose --project-name ${projectName} up -d --remove-orphans`;
    const output = await run(target, command, 10 * 60_000);
    return output.ok ? ok(undefined) : output;
  }
}

function run(
  target: DeploymentTarget,
  command: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<string, DeploymentError>> {
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (result: Result<string, DeploymentError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish(err(new DeploymentError('Remote Docker command timed out'))),
      timeoutMs,
    );
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: TIMEOUT_MS,
      hostVerifier: (key: Buffer) =>
        normalizeFingerprint(fingerprintHostKey(key)) ===
        normalizeFingerprint(target.hostKeySha256),
      ...(target.privateKey ? { privateKey: target.privateKey } : {}),
      ...(target.passphrase ? { passphrase: target.passphrase } : {}),
      ...(target.password ? { password: target.password } : {}),
    };
    client.once('error', (cause) =>
      finish(err(new DeploymentError('Remote Docker SSH connection failed', { cause }))),
    );
    client.once('ready', () => {
      client.exec(command, (error, stream) => {
        if (error)
          return finish(
            err(new DeploymentError('Failed to execute remote Docker command', { cause: error })),
          );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => stdout.push(chunk));
        stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        stream.on('close', (code: number | null) => {
          const errorText = Buffer.concat(stderr).toString('utf8').trim();
          if (code !== 0) {
            finish(
              err(
                new DeploymentError(
                  errorText || `Remote Docker command failed with exit ${code ?? 'unknown'}`,
                ),
              ),
            );
          } else {
            finish(ok(Buffer.concat(stdout).toString('utf8').trim()));
          }
        });
      });
    });
    client.connect(config);
  });
}

function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
}
