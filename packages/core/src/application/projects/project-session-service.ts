import {
  AppError,
  err,
  type EncryptionError,
  NotFoundError,
  ok,
  parseUuid,
  PersistenceError,
  type Result,
  UnauthorizedError,
  ValidationError,
} from '@cloudforge/shared';
import type { Project, ProjectId, ProjectPasskey } from '../../domain/project/project.js';
import type { ProjectRepository } from '../ports/project-repository.js';
import type { ProjectPasskeyHasher } from '../ports/project-passkey-hasher.js';
import { toProjectDto, type ProjectDto } from '../dto/project-dto.js';
import type { ProjectContextController, ProjectSessionLease } from './project-context.js';

export interface ProjectSessionDto {
  readonly project: ProjectDto;
  readonly sessionId: string;
  readonly generation: number;
}

export type ProjectSessionError =
  ValidationError | UnauthorizedError | NotFoundError | EncryptionError | PersistenceError;

export interface ProjectSessionLifecycle {
  beforeDeactivate(lease: ProjectSessionLease): Promise<void>;
  afterActivate(lease: ProjectSessionLease): Promise<void>;
}

const NOOP_LIFECYCLE: ProjectSessionLifecycle = {
  beforeDeactivate: () => Promise.resolve(),
  afterActivate: () => Promise.resolve(),
};

/**
 * Opens, locks, and switches the one local workspace session. Teardown is
 * completed before a replacement session is activated.
 */
export class ProjectSessionService {
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly projects: ProjectRepository,
    private readonly hasher: ProjectPasskeyHasher,
    private readonly context: ProjectContextController,
    private readonly lifecycle: ProjectSessionLifecycle = NOOP_LIFECYCLE,
  ) {}

  async current(): Promise<Result<ProjectSessionDto | null, ProjectSessionError>> {
    const lease = this.context.current();
    if (!lease) return ok(null);
    const project = await this.load(lease.projectId);
    return project.ok ? ok({ project: toProjectDto(project.value), ...lease }) : project;
  }

  async unlock(
    projectId: string,
    passkey: string,
  ): Promise<Result<ProjectSessionDto, ProjectSessionError>> {
    return this.exclusive(async () => {
      const project = await this.load(projectId);
      if (!project.ok) return project;
      const snapshot = project.value.toSnapshot();

      if (snapshot.passkeyHash !== null && snapshot.passkeySalt !== null) {
        const verified = await this.hasher.verify(passkey, passkeyFrom(snapshot));
        if (!verified.ok) return verified;
        if (!verified.value) return err(new UnauthorizedError('Incorrect project passkey'));
      }

      const prior = this.context.current();
      if (prior) {
        try {
          await this.lifecycle.beforeDeactivate(prior);
        } catch (cause) {
          return err(new PersistenceError('Failed to close current project workspace', { cause }));
        }
        this.context.clear();
      }

      project.value.markOpened();
      const saved = await this.projects.save(project.value);
      if (!saved.ok) return saved;

      const lease = this.context.activate(projectId);
      try {
        await this.lifecycle.afterActivate(lease);
      } catch (cause) {
        this.context.clear();
        return err(new PersistenceError('Failed to activate project workspace', { cause }));
      }
      return ok({ project: toProjectDto(project.value), ...lease });
    });
  }

  async lock(): Promise<Result<void, PersistenceError>> {
    return this.exclusive(async () => {
      const prior = this.context.current();
      if (!prior) return ok(undefined);
      try {
        await this.lifecycle.beforeDeactivate(prior);
        this.context.clear();
        return ok(undefined);
      } catch (cause) {
        return err(new PersistenceError('Failed to close project workspace', { cause }));
      }
    });
  }

  /**
   * Close the active workspace and perform one deletion/cleanup transaction
   * while all other session transitions remain serialized.
   *
   * The workspace stays locked if the callback fails. This is intentional:
   * reopening is safer than exposing a half-deleted project.
   */
  async deactivateAndRun<TPrepared, TResult>(
    authorization: { readonly passkey: string },
    prepare: (lease: ProjectSessionLease) => Promise<TPrepared>,
    operation: (lease: ProjectSessionLease, prepared: TPrepared) => Promise<TResult>,
  ): Promise<Result<TResult, AppError>> {
    return this.exclusive(async () => {
      const prior = this.context.current();
      if (!prior) return err(new UnauthorizedError('Unlock a project to continue'));
      try {
        const project = await this.load(prior.projectId);
        if (!project.ok) throw project.error;
        const snapshot = project.value.toSnapshot();
        if (snapshot.passkeyHash !== null && snapshot.passkeySalt !== null) {
          const verified = await this.hasher.verify(authorization.passkey, passkeyFrom(snapshot));
          if (!verified.ok) throw verified.error;
          if (!verified.value) throw new UnauthorizedError('Incorrect project passkey');
        }
        // Safety checks that require scoped repositories run while the
        // workspace is still active. A failed check leaves the session open.
        const prepared = await prepare(prior);
        await this.lifecycle.beforeDeactivate(prior);
        this.context.clear();
        return ok(await operation(prior, prepared));
      } catch (cause) {
        if (cause instanceof AppError) return err(cause);
        return err(
          new PersistenceError('Failed to close and clean up project workspace', { cause }),
        );
      }
    });
  }

  async changePasskey(
    currentPasskey: string,
    newPasskey: string,
  ): Promise<Result<void, ProjectSessionError>> {
    return this.exclusive(async () => {
      if (newPasskey.length < 8) {
        return err(new ValidationError('Project passkey must contain at least 8 characters'));
      }
      const lease = this.context.current();
      if (!lease) return err(new UnauthorizedError('Unlock a project to continue'));
      const project = await this.load(lease.projectId);
      if (!project.ok) return project;
      const snapshot = project.value.toSnapshot();
      if (snapshot.passkeyHash && snapshot.passkeySalt) {
        const verified = await this.hasher.verify(currentPasskey, passkeyFrom(snapshot));
        if (!verified.ok) return verified;
        if (!verified.value) return err(new UnauthorizedError('Incorrect project passkey'));
      }
      const digest = await this.hasher.hash(newPasskey);
      if (!digest.ok) return digest;
      project.value.setPasskey(digest.value);
      return this.projects.save(project.value);
    });
  }

  /** Re-authenticate the active project before exporting portable secrets. */
  async authorizeCurrent(passkey: string): Promise<Result<void, ProjectSessionError>> {
    const lease = this.context.current();
    if (!lease) return err(new UnauthorizedError('Unlock a project to continue'));
    const project = await this.load(lease.projectId);
    if (!project.ok) return project;
    const snapshot = project.value.toSnapshot();
    if (!snapshot.passkeyHash || !snapshot.passkeySalt) {
      return err(
        new UnauthorizedError(
          'Set a project passkey in Projects before exporting this migrated workspace',
        ),
      );
    }
    const verified = await this.hasher.verify(passkey, passkeyFrom(snapshot));
    if (!verified.ok) return verified;
    return verified.value ? ok(undefined) : err(new UnauthorizedError('Incorrect project passkey'));
  }

  private async load(projectId: string): Promise<Result<Project, ProjectSessionError>> {
    const uuid = parseUuid(projectId);
    if (!uuid) return err(new ValidationError('Invalid project id'));
    const found = await this.projects.findById(uuid as ProjectId);
    if (!found.ok) return found;
    return found.value ? ok(found.value) : err(new NotFoundError('Project not found'));
  }

  /**
   * Project activation is process-global. Serialize transitions so a late
   * teardown from one IPC call cannot close resources opened by a newer one.
   */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function passkeyFrom(snapshot: {
  readonly passkeyHash: string | null;
  readonly passkeySalt: string | null;
  readonly passkeyVersion: number;
}): ProjectPasskey {
  return {
    hash: snapshot.passkeyHash ?? '',
    salt: snapshot.passkeySalt ?? '',
    version: snapshot.passkeyVersion,
  };
}
