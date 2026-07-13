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

// Application
export * from './application/dto/project-dto.js';
export * from './application/ports/project-repository.js';
export * from './application/projects/project-service.js';
