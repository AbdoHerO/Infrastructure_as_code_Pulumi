/**
 * What the services installed *outside* the container runtime need from a
 * firewall.
 *
 * Deliberately one method wide. The runtime layer has no business knowing that
 * Ansible exists, and Ansible has no business knowing what a runtime plan is —
 * but a Jenkins on 8080 and a Compose service on 8080 are the same kind of fact
 * to a firewall, and the connectivity report is wrong if it can only see one of
 * them. This is the seam that lets it see both without either side importing the
 * other.
 */
import type { DeploymentError, Result } from '@cloudforge/shared';
import type { FirewallRequirement } from '../vps-runtime/firewall-requirements.js';
import type { DeploymentTarget } from './deployer.js';

export interface NativeServiceRequirements {
  /**
   * The ports the natively-installed services on this target need open.
   *
   * Read-only: this reports what is required, never what to do about it.
   * Implementations report only services that are actually installed — a rule for
   * absent software is how a VPS ends up with open ports nobody can explain.
   */
  requirements(
    target: DeploymentTarget,
  ): Promise<Result<readonly FirewallRequirement[], DeploymentError>>;
}
