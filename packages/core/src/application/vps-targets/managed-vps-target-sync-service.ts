import type { Result } from '@cloudforge/shared';
import type { InfrastructurePlan } from '../infrastructure/infrastructure-plan.js';
import { extractSshConnectionHints } from '../infrastructure/ssh-connection.js';
import type { EngineEventSink } from '../ports/infrastructure-engine.js';
import type { SshKeySummary } from '../ssh-keys/ssh-key-service.js';
import type { VpsTargetDto } from './vps-target-service.js';

interface KeyLookup {
  findByPublicKey(publicKey: string): Promise<Result<SshKeySummary | null, { message: string }>>;
}

interface HostKeyInspector {
  inspectHostKey(host: string, port: number): Promise<Result<string, { message: string }>>;
}

interface ManagedTargetStore {
  upsertManaged(input: {
    name: string;
    host: string;
    port: number;
    username: string;
    sshCredentialId: string;
    hostKeySha256: string;
    managedProjectId: string;
    managedResourceName: string;
  }): Promise<Result<VpsTargetDto, { message: string }>>;
  removeManagedProject(projectId: string): Promise<Result<void, { message: string }>>;
  removeManagedResource(
    projectId: string,
    resourceName: string,
  ): Promise<Result<void, { message: string }>>;
}

export interface ManagedTargetSyncResult {
  readonly targets: readonly VpsTargetDto[];
  readonly warnings: readonly string[];
}

/**
 * Synchronizes provider outputs into the shared VPS-target catalog. Every SSH
 * feature consumes that catalog, so Infrastructure, Ansible, Nginx, SSL,
 * Containers and Deployments observe one connection identity.
 */
export class ManagedVpsTargetSyncService {
  constructor(
    private readonly targets: ManagedTargetStore,
    private readonly keys: KeyLookup,
    private readonly hostKeys: HostKeyInspector,
    private readonly retry: { attempts: number; delayMs: number } = {
      attempts: 20,
      delayMs: 3_000,
    },
  ) {}

  async sync(
    projectId: string,
    plan: InfrastructurePlan,
    outputs: Readonly<Record<string, unknown>>,
    onEvent?: EngineEventSink,
  ): Promise<ManagedTargetSyncResult> {
    const hints = new Map(
      extractSshConnectionHints(outputs).map((connection) => [connection.resourceName, connection]),
    );
    const targets: VpsTargetDto[] = [];
    const warnings: string[] = [];

    for (const resource of plan.resources) {
      if (resource.kind !== 'compute' || !resource.assignPublicIp) continue;
      const connection = hints.get(resource.name);
      if (!connection) {
        warnings.push(`${resource.name}: no public SSH output was returned`);
        continue;
      }
      // Resolve from validated key material instead of trusting a persisted ID.
      // This prevents malformed legacy SSH credentials from being propagated
      // into every SSH-based module.
      const key = await this.lookupKey(resource.sshPublicKey, warnings, resource.name);
      if (!key) {
        const removed = await this.targets.removeManagedResource(projectId, resource.name);
        if (!removed.ok) warnings.push(`${resource.name}: ${removed.error.message}`);
        continue;
      }
      if (resource.sshCredentialId && resource.sshCredentialId !== key.id) {
        warnings.push(
          `${resource.name}: the stored SSH credential did not match its public key; the matching validated key was used`,
        );
      }

      onEvent?.({
        stream: 'stdout',
        message: `Synchronizing ${resource.name} with VPS Targets…`,
        progress: {
          scope: 'resource',
          status: 'in-progress',
          label: 'Verifying SSH host identity',
          operation: 'synchronize',
          resource: { name: resource.name, type: 'VpsTarget' },
        },
      });
      const fingerprint = await this.inspectWithRetry(connection.host, 22);
      if (!fingerprint) {
        warnings.push(`${resource.name}: SSH did not become ready; target was not synchronized`);
        continue;
      }
      const saved = await this.targets.upsertManaged({
        name: resource.name,
        host: connection.host,
        port: 22,
        username: connection.user,
        sshCredentialId: key.id,
        hostKeySha256: fingerprint,
        managedProjectId: projectId,
        managedResourceName: resource.name,
      });
      if (!saved.ok) {
        warnings.push(`${resource.name}: ${saved.error.message}`);
        continue;
      }
      targets.push(saved.value);
      onEvent?.({
        stream: 'stdout',
        message: `VPS target ${resource.name} is ready for Ansible and other SSH features.`,
        progress: {
          scope: 'resource',
          status: 'ready',
          label: 'VPS target synchronized',
          operation: 'synchronize',
          resource: { name: resource.name, type: 'VpsTarget' },
        },
      });
    }
    return { targets, warnings };
  }

  async removeProject(projectId: string): Promise<readonly string[]> {
    const removed = await this.targets.removeManagedProject(projectId);
    return removed.ok ? [] : [removed.error.message];
  }

  private async lookupKey(
    publicKey: string,
    warnings: string[],
    resourceName: string,
  ): Promise<{ id: string } | null> {
    const found = await this.keys.findByPublicKey(publicKey);
    if (!found.ok) {
      warnings.push(`${resourceName}: ${found.error.message}`);
      return null;
    }
    if (!found.value) {
      warnings.push(`${resourceName}: its SSH public key is not managed by CloudForge`);
      return null;
    }
    return { id: found.value.id };
  }

  private async inspectWithRetry(host: string, port: number): Promise<string | null> {
    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      const inspected = await this.hostKeys.inspectHostKey(host, port);
      if (inspected.ok) return inspected.value;
      if (attempt < this.retry.attempts) await delay(this.retry.delayMs);
    }
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
