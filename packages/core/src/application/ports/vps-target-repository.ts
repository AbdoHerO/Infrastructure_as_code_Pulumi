import type { PersistenceError, Result } from '@cloudforge/shared';

export interface VpsTargetRecord {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly sshCredentialId: string | null;
  readonly hostKeySha256: string;
  readonly lastPreflight: string;
  readonly lastPreflightAt: string | null;
  readonly managedProjectId: string | null;
  readonly managedResourceName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VpsTargetUpdate {
  readonly name?: string;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly sshCredentialId?: string | null;
  readonly hostKeySha256?: string;
  readonly lastPreflight?: string;
  readonly lastPreflightAt?: string | null;
  readonly managedProjectId?: string | null;
  readonly managedResourceName?: string | null;
}

export interface VpsTargetRepository {
  list(): Promise<Result<VpsTargetRecord[], PersistenceError>>;
  get(id: string): Promise<Result<VpsTargetRecord | null, PersistenceError>>;
  findManaged(
    projectId: string,
    resourceName: string,
  ): Promise<Result<VpsTargetRecord | null, PersistenceError>>;
  create(record: VpsTargetRecord): Promise<Result<void, PersistenceError>>;
  update(id: string, patch: VpsTargetUpdate): Promise<Result<void, PersistenceError>>;
  remove(id: string): Promise<Result<void, PersistenceError>>;
  removeManaged(projectId: string, resourceName: string): Promise<Result<void, PersistenceError>>;
  removeManagedByProject(projectId: string): Promise<Result<void, PersistenceError>>;
}
