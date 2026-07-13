import {
  newUuid,
  ok,
  type PersistenceError,
  type Result,
  toIsoDateString,
} from '@cloudforge/shared';
import type { ActivityRecord, ActivityRepository } from '../ports/activity-repository.js';

/** Transport-safe activity entry. */
export interface ActivityDto {
  readonly id: string;
  readonly projectId: string | null;
  readonly type: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** Input for recording an activity. */
export interface RecordActivityInput {
  readonly type: string;
  readonly message: string;
  readonly projectId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

const DEFAULT_LIMIT = 200;

/**
 * Records and reads the application activity feed / audit log. Feature handlers
 * call {@link record} on notable events; the Logs module and dashboard read it.
 */
export class ActivityService {
  constructor(private readonly activities: ActivityRepository) {}

  async record(input: RecordActivityInput): Promise<Result<void, PersistenceError>> {
    return this.activities.create({
      id: newUuid(),
      projectId: input.projectId ?? null,
      type: input.type,
      message: input.message,
      metadata: JSON.stringify(input.metadata ?? {}),
      createdAt: toIsoDateString(new Date()),
    });
  }

  /** Fire-and-forget recording that never throws (best-effort audit). */
  recordSafe(input: RecordActivityInput): void {
    void this.record(input);
  }

  async list(limit: number = DEFAULT_LIMIT): Promise<Result<ActivityDto[], PersistenceError>> {
    const found = await this.activities.list(limit);
    if (!found.ok) return found;
    return ok(found.value.map(toDto));
  }
}

function toDto(record: ActivityRecord): ActivityDto {
  return {
    id: record.id,
    projectId: record.projectId,
    type: record.type,
    message: record.message,
    metadata: parseMetadata(record.metadata),
    createdAt: record.createdAt,
  };
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
