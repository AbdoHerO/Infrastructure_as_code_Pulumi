import type { Client } from 'ssh2';
import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import type {
  ContainerAction,
  ContainerManager,
  ContainerStats,
  DeploymentTarget,
  RemoteContainer,
} from '@cloudforge/core';
import { base64, execCommand, withSshConnection } from './ssh-transport.js';

const TIMEOUT_MS = 30_000;
const ID_PATTERN = /^(?:[a-f0-9]{12,64}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LABEL = 'Docker';

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
    const encoded = base64(composeYaml);
    const directory = `/opt/cloudforge/compose/${projectName}`;
    const command =
      `sudo mkdir -p ${directory} && ` +
      `printf '%s' '${encoded}' | base64 -d | sudo tee ${directory}/compose.yaml >/dev/null && ` +
      `cd ${directory} && sudo docker compose --project-name ${projectName} up -d --remove-orphans`;
    const output = await run(target, command, 10 * 60_000);
    return output.ok ? ok(undefined) : output;
  }
}

/** Run one command on its own connection. */
function run(
  target: DeploymentTarget,
  command: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Result<string, DeploymentError>> {
  return runAll(target, [command], timeoutMs).then((result) =>
    result.ok ? ok(result.value[0] ?? '') : result,
  );
}

/**
 * Run several commands over a single verified connection.
 *
 * Inventorying a runtime takes a handful of `docker` reads; one command per
 * connection would pay a full SSH handshake for each. Commands run in order and
 * stop at the first failure.
 */
export function runAll(
  target: DeploymentTarget,
  commands: readonly string[],
  timeoutMs = TIMEOUT_MS,
): Promise<Result<string[], DeploymentError>> {
  return withSshConnection(target, { label: LABEL }, async (client: Client) => {
    const output: string[] = [];
    for (const command of commands) {
      const result = await execCommand(client, command, { label: LABEL, timeoutMs });
      output.push(result.stdout.trim());
    }
    return output;
  });
}
