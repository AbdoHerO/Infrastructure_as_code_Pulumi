import type { PersistenceError, Result } from '@cloudforge/shared';

/** A persisted activity/audit entry. */
export interface ActivityRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly type: string;
  readonly message: string;
  readonly metadata: string;
  readonly createdAt: string;
}

/** Persistence port for the activity feed / audit log. */
export interface ActivityRepository {
  create(record: ActivityRecord): Promise<Result<void, PersistenceError>>;
  list(limit: number): Promise<Result<ActivityRecord[], PersistenceError>>;
}
