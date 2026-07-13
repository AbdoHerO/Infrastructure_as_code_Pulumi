/**
 * `@cloudforge/core` — the Domain and Application layers.
 *
 * Contains entities, value objects, repository ports and use-case services.
 * Depends only on `@cloudforge/shared`; it has no knowledge of persistence,
 * providers, IPC or the UI. Infrastructure packages implement its ports.
 */

// Domain
export * from './domain/shared/entity.js';
export * from './domain/project/environment.js';
export * from './domain/project/project-status.js';
export * from './domain/project/project.js';
export * from './domain/credential/credential-kind.js';
export * from './domain/credential/credential.js';
export * from './domain/provider/provider-kind.js';

// Application — ports
export * from './application/ports/project-repository.js';
export * from './application/ports/credential-repository.js';
export * from './application/ports/secret-cipher.js';
export * from './application/ports/settings-repository.js';
export * from './application/ports/provider-factory.js';
export * from './application/ports/infrastructure-engine.js';

// Application — DTOs
export * from './application/dto/project-dto.js';
export * from './application/dto/credential-dto.js';

// Application — services
export * from './application/projects/project-service.js';
export * from './application/credentials/credential-service.js';
export * from './application/settings/settings.js';
export * from './application/settings/settings-service.js';
export * from './application/providers/cloud-provider.js';
export * from './application/providers/provider-connection-service.js';
export * from './application/infrastructure/infrastructure-plan.js';
