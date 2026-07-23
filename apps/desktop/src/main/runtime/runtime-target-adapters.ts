import { DeploymentError, err, ok, type Result } from '@cloudforge/shared';
import { toProviderFirewallView } from '@cloudforge/core';
import type {
  FirewallView,
  ProjectService,
  ProviderConnectionService,
  RuntimeProviderFirewall,
  RuntimeTargetCatalog,
  VpsTargetDto,
  VpsTargetService,
} from '@cloudforge/core';

/**
 * Resolves runtime resources back to the existing shared VPS target store.
 * This is deliberately an adapter over VpsTargetService, not a second target
 * repository.
 */
export class VpsRuntimeTargetCatalog implements RuntimeTargetCatalog {
  constructor(private readonly targets: VpsTargetService) {}

  async targetIds(): Promise<readonly string[]> {
    const targets = await this.targets.list();
    return targets.ok ? targets.value.map((target) => target.id) : [];
  }

  async findTargetIdByAddress(address: string): Promise<string | null> {
    const targets = await this.targets.list();
    if (!targets.ok) return null;
    const expected = normalizeAddress(address);
    return targets.value.find((target) => normalizeAddress(target.host) === expected)?.id ?? null;
  }
}

/**
 * Reads provider firewall state through the existing provider application
 * service. No OCI/AWS rule leaks into the runtime domain.
 */
export class LiveRuntimeProviderFirewall implements RuntimeProviderFirewall {
  constructor(
    private readonly targets: VpsTargetService,
    private readonly projects: ProjectService,
    private readonly providers: ProviderConnectionService,
  ) {}

  async inspect(targetId: string): Promise<Result<FirewallView | null, DeploymentError>> {
    const target = await this.targets.get(targetId);
    if (!target.ok) return failure('Could not load the VPS target', target.error);
    const binding = await this.binding(target.value);
    if (!binding.ok) return failure('Could not resolve the VPS provider binding', binding.error);
    if (binding.value === null) return ok(null);

    const instances = await this.providers.listInstances(binding.value.credentialId);
    if (!instances.ok) return failure('Could not load provider instances', instances.error);
    const instance = instances.value.find(
      (candidate) =>
        candidate.name === binding.value?.resourceName ||
        candidate.id === binding.value?.resourceName,
    );
    if (!instance) return ok(null);

    const firewall = await this.providers.getInstanceFirewall(
      binding.value.credentialId,
      instance.id,
    );
    if (!firewall.ok) return failure('Could not load the provider firewall', firewall.error);
    return ok(toProviderFirewallView(firewall.value.rules, []));
  }

  private async binding(
    target: VpsTargetDto,
  ): Promise<Result<{ credentialId: string; resourceName: string } | null, DeploymentError>> {
    if (!target.managedProjectId || !target.managedResourceName) return ok(null);
    const project = await this.projects.get(target.managedProjectId);
    if (!project.ok) return failure('Could not load the VPS project', project.error);
    if (!project.value.providerId) return ok(null);
    return ok({
      credentialId: project.value.providerId,
      resourceName: target.managedResourceName,
    });
  }
}

function normalizeAddress(value: string): string {
  return value.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function failure(message: string, cause: Error): Result<never, DeploymentError> {
  return err(new DeploymentError(message, { cause }));
}
