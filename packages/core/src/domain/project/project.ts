import {
  type Brand,
  err,
  type IsoDateString,
  newUuid,
  ok,
  type Result,
  toIsoDateString,
  type Uuid,
  ValidationError,
} from '@cloudforge/shared';
import { Entity } from '../shared/entity.js';
import { type Environment, parseEnvironment } from './environment.js';
import type { ProjectStatus } from './project-status.js';

/** Strongly-typed project identity. */
export type ProjectId = Brand<Uuid, 'ProjectId'>;

/** Full persisted shape of a project, used to reconstitute from storage. */
export interface ProjectProps {
  readonly id: ProjectId;
  readonly name: string;
  readonly description: string;
  readonly environment: Environment;
  readonly region: string;
  readonly providerId: string | null;
  readonly templateId: string | null;
  readonly status: ProjectStatus;
  readonly tags: readonly string[];
  readonly variables: Readonly<Record<string, string>>;
  readonly notes: string;
  readonly createdAt: IsoDateString;
  readonly updatedAt: IsoDateString;
}

/** Attributes a caller supplies to create a new project. */
export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly environment: string;
  readonly region: string;
  readonly providerId?: string | null;
  readonly templateId?: string | null;
  readonly tags?: readonly string[];
  readonly variables?: Readonly<Record<string, string>>;
  readonly notes?: string;
}

/** Mutable attributes of an existing project. */
export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string;
  readonly environment?: string;
  readonly region?: string;
  readonly providerId?: string | null;
  readonly templateId?: string | null;
  readonly status?: ProjectStatus;
  readonly tags?: readonly string[];
  readonly variables?: Readonly<Record<string, string>>;
  readonly notes?: string;
}

const NAME_MAX = 100;

/**
 * A Project is the aggregate root representing a single managed infrastructure:
 * its target provider, environment, region and everything provisioned for it.
 */
export class Project extends Entity<ProjectId> {
  private constructor(private props: ProjectProps) {
    super(props.id);
  }

  /** Create a brand-new project, validating all invariants. */
  static create(
    input: CreateProjectInput,
    now: Date = new Date(),
  ): Result<Project, ValidationError> {
    const name = validateName(input.name);
    if (!name.ok) return name;

    const environment = parseEnvironment(input.environment);
    if (!environment.ok) return environment;

    const region = input.region.trim();
    if (region.length === 0) {
      return err(new ValidationError('Region is required'));
    }

    const timestamp = toIsoDateString(now);
    return ok(
      new Project({
        id: newUuid() as ProjectId,
        name: name.value,
        description: input.description?.trim() ?? '',
        environment: environment.value,
        region,
        providerId: input.providerId ?? null,
        templateId: input.templateId ?? null,
        status: 'draft',
        tags: normalizeTags(input.tags ?? []),
        variables: { ...(input.variables ?? {}) },
        notes: input.notes?.trim() ?? '',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
  }

  /** Rehydrate a project from persisted, already-valid properties. */
  static reconstitute(props: ProjectProps): Project {
    return new Project(props);
  }

  /** Apply a partial update, re-validating any changed invariants. */
  update(input: UpdateProjectInput, now: Date = new Date()): Result<Project, ValidationError> {
    const next: Mutable<ProjectProps> = { ...this.props };

    if (input.name !== undefined) {
      const name = validateName(input.name);
      if (!name.ok) return name;
      next.name = name.value;
    }
    if (input.environment !== undefined) {
      const environment = parseEnvironment(input.environment);
      if (!environment.ok) return environment;
      next.environment = environment.value;
    }
    if (input.region !== undefined) {
      const region = input.region.trim();
      if (region.length === 0) return err(new ValidationError('Region is required'));
      next.region = region;
    }
    if (input.description !== undefined) next.description = input.description.trim();
    if (input.providerId !== undefined) next.providerId = input.providerId;
    if (input.templateId !== undefined) next.templateId = input.templateId;
    if (input.status !== undefined) next.status = input.status;
    if (input.tags !== undefined) next.tags = normalizeTags(input.tags);
    if (input.variables !== undefined) next.variables = { ...input.variables };
    if (input.notes !== undefined) next.notes = input.notes.trim();

    next.updatedAt = toIsoDateString(now);
    this.props = next;
    return ok(this);
  }

  /** An immutable snapshot of the project's properties. */
  toSnapshot(): ProjectProps {
    return { ...this.props, tags: [...this.props.tags], variables: { ...this.props.variables } };
  }

  get name(): string {
    return this.props.name;
  }
  get environment(): Environment {
    return this.props.environment;
  }
  get status(): ProjectStatus {
    return this.props.status;
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function validateName(raw: string): Result<string, ValidationError> {
  const name = raw.trim();
  if (name.length === 0) return err(new ValidationError('Project name is required'));
  if (name.length > NAME_MAX) {
    return err(
      new ValidationError(`Project name must be at most ${NAME_MAX} characters`, {
        context: { length: name.length },
      }),
    );
  }
  return ok(name);
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}
