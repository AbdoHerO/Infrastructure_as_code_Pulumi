import {
  err,
  isUuid,
  type DeploymentError,
  type Result,
  ValidationError,
} from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type {
  ContainerAction,
  ContainerManager,
  ContainerStats,
  RemoteContainer,
} from '../ports/container-manager.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { RemoteTargetResolver } from '../ports/remote-target-resolver.js';
import type { RuntimeInspector, RuntimeObservation } from '../ports/runtime-inspector.js';

export type ContainerServiceError = ValidationError | DeploymentError;

const CONTAINER_ID = /^(?:[a-f0-9]{12,64}|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/;
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_COMPOSE_BYTES = 512_000;

/**
 * Container use-cases against saved, fingerprint-verified VPS targets.
 *
 * Containers was the one feature that skipped the Application layer: its IPC
 * handlers called the adapter directly, so it recorded no Activity and — unlike
 * every other SSH feature — accepted the host address and host-key fingerprint
 * straight from the renderer. Everything else passes only a target id and lets
 * the main process load the pinned identity from the database. A renderer that
 * can name its own fingerprint can defeat the pinning, so this service takes a
 * target id and nothing else.
 */
export class ContainerService {
  constructor(
    private readonly targets: RemoteTargetResolver,
    private readonly containers: ContainerManager,
    private readonly inspector: RuntimeInspector,
    private readonly activities: ActivityService,
  ) {}

  /**
   * Read a target's full runtime: containers, networks, volumes and ownership.
   *
   * Read-only, so it is safe against a production VPS.
   */
  async inspect(targetId: string): Promise<Result<RuntimeObservation, ContainerServiceError>> {
    if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));
    const target = await this.targets.resolve(targetId);
    if (!target.ok) return target;
    return this.inspector.inspect(target.value, targetId);
  }

  async list(targetId: string): Promise<Result<RemoteContainer[], ContainerServiceError>> {
    const target = await this.withTarget(targetId);
    if (!target.ok) return target;
    return this.containers.list(target.value);
  }

  async action(
    targetId: string,
    containerId: string,
    action: ContainerAction,
  ): Promise<Result<void, ContainerServiceError>> {
    const target = await this.withTarget(targetId);
    if (!target.ok) return target;
    if (!CONTAINER_ID.test(containerId)) return err(new ValidationError('Invalid container id'));
    const result = await this.containers.action(target.value, containerId, action);
    if (result.ok) {
      this.activities.recordSafe({
        type: `container.${action}`,
        message: `Ran ${action} on container ${containerId}`,
        metadata: { targetId, containerId, action },
      });
    }
    return result;
  }

  async logs(
    targetId: string,
    containerId: string,
    lines = 200,
  ): Promise<Result<string, ContainerServiceError>> {
    const target = await this.withTarget(targetId);
    if (!target.ok) return target;
    if (!CONTAINER_ID.test(containerId)) return err(new ValidationError('Invalid container id'));
    return this.containers.logs(target.value, containerId, clampLines(lines));
  }

  async stats(
    targetId: string,
    containerId: string,
  ): Promise<Result<ContainerStats, ContainerServiceError>> {
    const target = await this.withTarget(targetId);
    if (!target.ok) return target;
    if (!CONTAINER_ID.test(containerId)) return err(new ValidationError('Invalid container id'));
    return this.containers.stats(target.value, containerId);
  }

  async deployCompose(
    targetId: string,
    projectName: string,
    composeYaml: string,
  ): Promise<Result<void, ContainerServiceError>> {
    const target = await this.withTarget(targetId);
    if (!target.ok) return target;
    if (!COMPOSE_PROJECT.test(projectName))
      return err(
        new ValidationError(
          'Compose project names must be lowercase letters, numbers, dashes or underscores',
        ),
      );
    if (!composeYaml.trim() || composeYaml.length > MAX_COMPOSE_BYTES)
      return err(new ValidationError(`Compose YAML must be 1–${MAX_COMPOSE_BYTES} characters`));
    const result = await this.containers.deployCompose(target.value, projectName, composeYaml);
    if (result.ok) {
      this.activities.recordSafe({
        type: 'container.compose.deployed',
        message: `Deployed Compose project ${projectName}`,
        metadata: { targetId, projectName },
      });
    }
    return result;
  }

  private async withTarget(
    targetId: string,
  ): Promise<Result<DeploymentTarget, ContainerServiceError>> {
    if (!isUuid(targetId)) return err(new ValidationError('Select a valid saved VPS target'));
    return this.targets.resolve(targetId);
  }
}

function clampLines(lines: number): number {
  return Math.min(5000, Math.max(1, Math.trunc(lines) || 200));
}
