/**
 * Reads a VPS's live Docker runtime over verified SSH.
 *
 * Read-only by construction: every command here is an inspect or a list. The
 * inventory has to be safe to run against a production server, since it is what
 * everything else in the runtime layer decides from.
 *
 * All six reads share one connection. At one handshake per command a refresh
 * would pay six.
 */
import type { DeploymentTarget, RuntimeInspector, RuntimeObservation } from '@cloudforge/core';
import { type DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import { parseContainers, parseNetworks, parseVolumes } from './docker-inspect.js';
import { execCommand, withSshConnection } from './ssh-transport.js';

const LABEL = 'Docker';
const TIMEOUT_MS = 60_000;

/**
 * `docker inspect` fails when given no arguments, and a VPS with no containers
 * is normal — so each read guards on an empty id list and prints nothing.
 */
const COMMANDS = {
  version: `sudo docker version --format '{{.Server.Version}}' 2>/dev/null || true`,
  compose: `sudo docker compose version --short 2>/dev/null || true`,
  containers: `ids=$(sudo docker ps -aq --no-trunc); if [ -n "$ids" ]; then sudo docker container inspect $ids --format '{{json .}}'; fi`,
  networks: `ids=$(sudo docker network ls -q); if [ -n "$ids" ]; then sudo docker network inspect $ids --format '{{json .}}'; fi`,
  volumes: `names=$(sudo docker volume ls -q); if [ -n "$names" ]; then sudo docker volume inspect $names --format '{{json .}}'; fi`,
} as const;

export class SshRuntimeInspector implements RuntimeInspector {
  async inspect(
    target: DeploymentTarget,
    targetId: string,
  ): Promise<Result<RuntimeObservation, DeploymentError>> {
    const observedAt = new Date().toISOString();
    const result = await withSshConnection(target, { label: LABEL }, async (client) => {
      const read = async (command: string): Promise<string> => {
        const output = await execCommand(client, command, { label: LABEL, timeoutMs: TIMEOUT_MS });
        return output.stdout.trim();
      };
      // Probe the engine first: without Docker the remaining reads would each
      // fail with a shell error that says nothing useful.
      const version = await read(COMMANDS.version);
      if (!version) return null;
      return {
        version,
        compose: await read(COMMANDS.compose),
        containers: await read(COMMANDS.containers),
        networks: await read(COMMANDS.networks),
        volumes: await read(COMMANDS.volumes),
      };
    });
    if (!result.ok) return err(result.error);

    if (result.value === null) {
      return ok({
        targetId,
        observedAt,
        docker: { available: false, version: null, composeVersion: null },
        containers: [],
        networks: [],
        volumes: [],
      });
    }

    const containers = parseContainers(result.value.containers);
    return ok({
      targetId,
      observedAt,
      docker: {
        available: true,
        version: result.value.version,
        composeVersion: result.value.compose || null,
      },
      containers,
      networks: parseNetworks(result.value.networks),
      // Volume users are recovered from container mounts; `docker volume
      // inspect` does not report them.
      volumes: parseVolumes(result.value.volumes, containers),
    });
  }
}
