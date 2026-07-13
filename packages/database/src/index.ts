/**
 * `@cloudforge/database` — the persistence Infrastructure layer.
 *
 * Provides the Prisma client factory, runtime schema bootstrap and concrete
 * repository implementations of the Application-layer ports. Consumed only by
 * the Electron main process; never by the renderer.
 */
export { createPrismaClient, PrismaClient, type Db } from './client.js';
export { ensureSchema, migrateSchema, type MigrateSchemaHooks } from './schema-bootstrap.js';
export { PrismaProjectRepository } from './repositories/prisma-project-repository.js';
export { PrismaCredentialRepository } from './repositories/prisma-credential-repository.js';
export { PrismaSettingsRepository } from './repositories/prisma-settings-repository.js';
export { PrismaPlanStore } from './repositories/prisma-plan-store.js';
export { PrismaTemplateStore } from './repositories/prisma-template-store.js';
export { PrismaDeploymentRepository } from './repositories/prisma-deployment-repository.js';
export { PrismaActivityRepository } from './repositories/prisma-activity-repository.js';
export { PrismaPluginRepository } from './repositories/prisma-plugin-repository.js';
export { toDomainProject, toPrismaProject } from './mappers/project-mapper.js';
