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
export * from './domain/plugin/plugin.js';

// Application — ports
export * from './application/ports/project-repository.js';
export * from './application/ports/credential-repository.js';
export * from './application/ports/secret-cipher.js';
export * from './application/ports/settings-repository.js';
export * from './application/ports/provider-factory.js';
export * from './application/ports/infrastructure-engine.js';
export * from './application/ports/plan-store.js';
export * from './application/ports/provider-credential-resolver.js';
export * from './application/ports/template-store.js';
export * from './application/ports/deployer.js';
export * from './application/ports/deployment-repository.js';
export * from './application/ports/activity-repository.js';
export * from './application/ports/plugin-repository.js';
export * from './application/ports/ssh-key-generator.js';
export * from './application/ports/container-manager.js';
export * from './application/ports/host-firewall.js';
export * from './application/ports/runtime-applier.js';
export * from './application/ports/runtime-inspector.js';
export * from './application/ports/runtime-plan-store.js';
export * from './application/ports/ansible-manager.js';
export * from './application/ports/vps-target-repository.js';
export * from './application/ports/remote-target-resolver.js';
export * from './application/ports/nginx-manager.js';
export * from './application/ports/certificate-manager.js';
export * from './application/ports/ssh-terminal-manager.js';
export * from './application/ports/service-provider-factory.js';
export * from './application/ports/jenkins-manager.js';
export * from './application/ports/jenkins-pipeline-repository.js';

// Application — DTOs
export * from './application/dto/project-dto.js';
export * from './application/dto/credential-dto.js';
export * from './application/dto/deployment-dto.js';

// Application — services
export * from './application/projects/project-service.js';
export * from './application/projects/project-configuration-service.js';
export * from './application/credentials/credential-service.js';
export * from './application/settings/settings.js';
export * from './application/settings/settings-service.js';
export * from './application/providers/cloud-provider.js';
export * from './application/providers/provider-connection-service.js';
export * from './application/infrastructure/infrastructure-plan.js';
export * from './application/infrastructure/infrastructure-service.js';
export * from './application/infrastructure/infrastructure-template.js';
export * from './application/infrastructure/ssh-connection.js';
export * from './application/deployment/deployment-template.js';
export * from './application/deployment/deployment-service.js';
export * from './application/activity/activity-service.js';
export * from './application/plugins/plugin-catalog.js';
export * from './application/plugins/plugin-service.js';
export * from './application/ssh-keys/ssh-key-service.js';
export * from './application/vps-targets/vps-target-service.js';
export * from './application/vps-targets/managed-vps-target-sync-service.js';
export * from './application/nginx/nginx-service.js';
export * from './application/ssl/ssl-service.js';
export * from './application/terminal/ssh-terminal-service.js';
export * from './application/containers/container-service.js';
export * from './application/vps-runtime/firewall-requirements.js';
export * from './application/vps-runtime/runtime-drift.js';
export * from './application/vps-runtime/runtime-operations.js';
export * from './application/vps-runtime/runtime-ownership.js';
export * from './application/vps-runtime/runtime-plan-service.js';
export * from './application/vps-runtime/vps-runtime-plan.js';
export * from './application/service-providers/service-provider.js';
export * from './application/service-providers/cloudflare.js';
export * from './application/service-providers/cloudflare-service.js';
export * from './application/service-providers/cloudflare-dns-automation-service.js';
export * from './application/jenkins/jenkins-pipeline-service.js';
