import { randomUUID } from 'node:crypto';
import { err, ok, PersistenceError, type Result } from '@cloudforge/shared';
import type { ClonedProjectLinks, ProjectConfigurationCloner } from '@cloudforge/core';
import type { Db } from '../client.js';

/** Transactional configuration-only project clone. */
export class PrismaProjectConfigurationCloner implements ProjectConfigurationCloner {
  constructor(private readonly db: Db) {}

  async clone(
    sourceProjectId: string,
    targetProjectId: string,
  ): Promise<Result<ClonedProjectLinks, PersistenceError>> {
    try {
      const links = await this.db.$transaction(async (tx) => {
        const source = await tx.project.findUniqueOrThrow({ where: { id: sourceProjectId } });
        const [providers, credentials, templates, sshKeys, secrets, settings, plugins] =
          await Promise.all([
            tx.provider.findMany({ where: { projectId: sourceProjectId } }),
            tx.credential.findMany({ where: { projectId: sourceProjectId } }),
            tx.template.findMany({ where: { projectId: sourceProjectId } }),
            tx.sshKey.findMany({ where: { projectId: sourceProjectId } }),
            tx.secret.findMany({ where: { projectId: sourceProjectId } }),
            tx.setting.findMany({ where: { projectId: sourceProjectId } }),
            tx.plugin.findMany({ where: { projectId: sourceProjectId } }),
          ]);

        const providerIds = new Map(providers.map((item) => [item.id, randomUUID()]));
        const credentialIds = new Map(credentials.map((item) => [item.id, randomUUID()]));
        const templateIds = new Map(templates.map((item) => [item.id, randomUUID()]));
        const sshKeyIds = new Map(sshKeys.map((item) => [item.id, randomUUID()]));
        const referenceIds = new Map([...credentialIds, ...templateIds, ...sshKeyIds]);

        for (const item of providers) {
          await tx.provider.create({
            data: {
              ...item,
              id: providerIds.get(item.id)!,
              projectId: targetProjectId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
        for (const item of credentials) {
          await tx.credential.create({
            data: {
              ...item,
              id: credentialIds.get(item.id)!,
              projectId: targetProjectId,
              providerId: item.providerId ? (providerIds.get(item.providerId) ?? null) : null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
        for (const item of templates) {
          await tx.template.create({
            data: {
              ...item,
              id: templateIds.get(item.id)!,
              projectId: targetProjectId,
              definition: remapJson(item.definition, referenceIds),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
        for (const item of sshKeys) {
          await tx.sshKey.create({
            data: {
              ...item,
              id: sshKeyIds.get(item.id)!,
              projectId: targetProjectId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
        for (const item of secrets) {
          await tx.secret.create({
            data: {
              ...item,
              id: randomUUID(),
              projectId: targetProjectId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
        for (const item of settings) {
          if (item.key.startsWith('runtime-plan:')) continue;
          const key = item.key === `plan:${sourceProjectId}` ? `plan:${targetProjectId}` : item.key;
          await tx.setting.create({
            data: {
              projectId: targetProjectId,
              key,
              value: remapJson(item.value, referenceIds),
            },
          });
        }
        for (const item of plugins) {
          await tx.plugin.create({
            data: {
              ...item,
              projectId: targetProjectId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }

        return {
          providerId: source.providerId ? (credentialIds.get(source.providerId) ?? null) : null,
          templateId: source.templateId ? (templateIds.get(source.templateId) ?? null) : null,
        };
      });
      return ok(links);
    } catch (cause) {
      return err(new PersistenceError('Failed to duplicate project configuration', { cause }));
    }
  }
}

function remapJson(value: string, ids: ReadonlyMap<string, string>): string {
  try {
    return JSON.stringify(remapValue(JSON.parse(value) as unknown, ids));
  } catch {
    return ids.get(value) ?? value;
  }
}

function remapValue(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapValue(item, ids));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        remapValue(item, ids),
      ]),
    );
  }
  return value;
}
