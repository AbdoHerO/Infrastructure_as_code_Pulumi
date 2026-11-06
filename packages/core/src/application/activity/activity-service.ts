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

/** Narrows what {@link ActivityService.list} returns; every field is optional. */
export interface ActivityFilter {
  /** Matches the start of the event type, e.g. `firewall.` or `infrastructure.applied`. */
  readonly typePrefix?: string;
  /** Case-insensitive text found in the message or the type. */
  readonly search?: string;
  /** ISO date: only events at or after it. */
  readonly since?: string;
}

const DEFAULT_LIMIT = 200;
/** How far back a filtered read looks, so a filter can find older events. */
const FILTER_SCAN_LIMIT = 1000;

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

  async list(
    limit: number = DEFAULT_LIMIT,
    filter: ActivityFilter = {},
  ): Promise<Result<ActivityDto[], PersistenceError>> {
    const filtering = [filter.typePrefix, filter.search, filter.since].some(Boolean);
    const found = await this.activities.list(
      filtering ? Math.max(limit, FILTER_SCAN_LIMIT) : limit,
    );
    if (!found.ok) return found;
    const items = found.value.map(toDto);
    return ok(filtering ? items.filter(matches(filter)).slice(0, limit) : items);
  }
}

function matches(filter: ActivityFilter): (item: ActivityDto) => boolean {
  const search = filter.search?.trim().toLowerCase();
  const since = filter.since ? Date.parse(filter.since) : null;
  return (item) =>
    (!filter.typePrefix || item.type.startsWith(filter.typePrefix)) &&
    (!search || `${item.message} ${item.type}`.toLowerCase().includes(search)) &&
    (since === null || Number.isNaN(since) || Date.parse(item.createdAt) >= since);
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
