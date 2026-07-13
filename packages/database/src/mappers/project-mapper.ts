import type { Project as PrismaProject } from '@prisma/client';
import { type IsoDateString, toIsoDateString, type Uuid } from '@cloudforge/shared';
import { type Environment, Project, type ProjectId, type ProjectStatus } from '@cloudforge/core';

/** Convert a Prisma row into a domain {@link Project} aggregate. */
export function toDomainProject(row: PrismaProject): Project {
  return Project.reconstitute({
    id: row.id as Uuid as ProjectId,
    name: row.name,
    description: row.description,
    environment: row.environment as Environment,
    region: row.region,
    providerId: row.providerId,
    templateId: row.templateId,
    status: row.status as ProjectStatus,
    tags: parseJsonArray(row.tags),
    variables: parseJsonRecord(row.variables),
    notes: row.notes,
    createdAt: toIsoDateString(row.createdAt),
    updatedAt: toIsoDateString(row.updatedAt),
  });
}

/** Convert a domain {@link Project} into a Prisma write payload. */
export function toPrismaProject(project: Project): PrismaProject {
  const snapshot = project.toSnapshot();
  return {
    id: snapshot.id,
    name: snapshot.name,
    description: snapshot.description,
    environment: snapshot.environment,
    region: snapshot.region,
    providerId: snapshot.providerId,
    templateId: snapshot.templateId,
    status: snapshot.status,
    tags: JSON.stringify(snapshot.tags),
    variables: JSON.stringify(snapshot.variables),
    notes: snapshot.notes,
    createdAt: fromIsoDateString(snapshot.createdAt),
    updatedAt: fromIsoDateString(snapshot.updatedAt),
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
    return {};
  } catch {
    return {};
  }
}

function fromIsoDateString(value: IsoDateString): Date {
  return new Date(value);
}
