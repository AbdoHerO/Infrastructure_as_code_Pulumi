import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type {
  JenkinsParameter,
  JenkinsPipelineRecord,
  JenkinsPipelineRepository,
  ProjectContext,
} from '@cloudforge/core';
import type { Db } from '../client.js';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly description: string;
  readonly targetId: string;
  readonly jenkinsCredentialId: string;
  readonly githubCredentialId: string | null;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly jenkinsfilePath: string;
  readonly pipelineScript: string;
  readonly definitionMode: string;
  readonly parameters: string;
  readonly environment: string;
  readonly environmentCredentialId: string | null;
  readonly domain: string;
  readonly applicationPort: number | null;
  readonly cloudflareCredentialId: string | null;
  readonly cloudflareZoneId: string | null;
  readonly configureDomain: number | boolean;
  readonly applicationRoutes: string;
  readonly lastStatus: string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export class PrismaJenkinsPipelineRepository implements JenkinsPipelineRepository {
  constructor(
    private readonly db: Db,
    private readonly context: ProjectContext,
  ) {}

  async list(): Promise<Result<JenkinsPipelineRecord[], PersistenceError>> {
    return guard('list Jenkins pipelines', async () => {
      const rows = await this.db.$queryRawUnsafe<Row[]>(
        'SELECT * FROM "JenkinsPipeline" WHERE "projectId" = ? ORDER BY "updatedAt" DESC',
        this.projectId(),
      );
      return rows.map(toRecord);
    });
  }

  async get(id: string): Promise<Result<JenkinsPipelineRecord | null, PersistenceError>> {
    return guard('load Jenkins pipeline', async () => {
      const rows = await this.db.$queryRawUnsafe<Row[]>(
        'SELECT * FROM "JenkinsPipeline" WHERE "id" = ? AND "projectId" = ? LIMIT 1',
        id,
        this.projectId(),
      );
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  async getByFolderAndName(
    folder: string,
    name: string,
  ): Promise<Result<JenkinsPipelineRecord | null, PersistenceError>> {
    return guard('load Jenkins pipeline by remote identity', async () => {
      const rows = await this.db.$queryRawUnsafe<Row[]>(
        'SELECT * FROM "JenkinsPipeline" WHERE "folder" = ? AND "name" = ? AND "projectId" = ? LIMIT 1',
        folder,
        name,
        this.projectId(),
      );
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  async save(record: JenkinsPipelineRecord): Promise<Result<void, PersistenceError>> {
    return guard('save Jenkins pipeline', async () => {
      const projectId = this.projectId();
      const values = [
        record.name,
        record.folder,
        record.description,
        record.targetId,
        record.jenkinsCredentialId,
        record.githubCredentialId,
        record.repositoryUrl,
        record.branch,
        record.jenkinsfilePath,
        record.pipelineScript,
        record.definitionMode,
        JSON.stringify(record.parameters),
        JSON.stringify(record.environment),
        record.environmentCredentialId,
        record.domain,
        record.applicationPort,
        record.cloudflareCredentialId,
        record.cloudflareZoneId,
        record.configureDomain ? 1 : 0,
        record.lastStatus,
        JSON.stringify(record.applicationRoutes),
        record.updatedAt,
      ] as const;
      const updated = await this.db.$executeRawUnsafe(
        `UPDATE "JenkinsPipeline" SET
          "name"=?, "folder"=?, "description"=?, "targetId"=?,
          "jenkinsCredentialId"=?, "githubCredentialId"=?, "repositoryUrl"=?,
          "branch"=?, "jenkinsfilePath"=?, "pipelineScript"=?,
          "definitionMode"=?, "parameters"=?, "environment"=?,
          "environmentCredentialId"=?, "domain"=?, "applicationPort"=?,
          "cloudflareCredentialId"=?, "cloudflareZoneId"=?, "configureDomain"=?,
          "lastStatus"=?, "applicationRoutes"=?, "updatedAt"=?
        WHERE "id"=? AND "projectId"=?`,
        ...values,
        record.id,
        projectId,
      );
      if (updated > 0) return;
      await this.db.$executeRawUnsafe(
        `INSERT INTO "JenkinsPipeline" (
          "id","projectId","name","folder","description","targetId","jenkinsCredentialId",
          "githubCredentialId","repositoryUrl","branch","jenkinsfilePath","pipelineScript",
          "definitionMode","parameters","environment","environmentCredentialId","domain","applicationPort",
          "cloudflareCredentialId","cloudflareZoneId","configureDomain","lastStatus",
          "applicationRoutes","createdAt","updatedAt"
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        record.id,
        projectId,
        ...values.slice(0, 21),
        record.createdAt,
        record.updatedAt,
      );
    });
  }

  async remove(id: string): Promise<Result<void, PersistenceError>> {
    return guard('delete Jenkins pipeline', async () => {
      await this.db.$executeRawUnsafe(
        'DELETE FROM "JenkinsPipeline" WHERE "id" = ? AND "projectId" = ?',
        id,
        this.projectId(),
      );
    });
  }

  private projectId(): string {
    return this.context.requireActive().projectId;
  }
}

function toRecord(row: Row): JenkinsPipelineRecord {
  return {
    ...row,
    definitionMode: row.definitionMode === 'inline' ? 'inline' : 'scm',
    parameters: parse<JenkinsParameter[]>(row.parameters, []),
    environment: parse<Record<string, string>>(row.environment, {}),
    environmentCredentialId: row.environmentCredentialId ?? null,
    applicationRoutes: parse(row.applicationRoutes ?? '[]', []),
    configureDomain: Boolean(row.configureDomain),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function parse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function guard<T>(
  action: string,
  operation: () => Promise<T>,
): Promise<Result<T, PersistenceError>> {
  try {
    return ok(await operation());
  } catch (cause) {
    return err(new PersistenceError(`Failed to ${action}`, { cause }));
  }
}
