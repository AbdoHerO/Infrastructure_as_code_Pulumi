/**
 * Reads the natively-installed services on a VPS and reports what they need from
 * its firewall.
 *
 * Thin by design: the probe already knows what is installed and on which port,
 * and the catalog already declares what each profile needs. This only joins the
 * two, so the runtime layer can see a native Jenkins without knowing that Ansible
 * exists.
 */
import type {
  AnsibleManager,
  DeploymentTarget,
  FirewallRequirement,
  NativeServiceRequirements,
} from '@cloudforge/core';
import { observedAnsibleRequirements } from '@cloudforge/core';
import { ok, type DeploymentError, type Result } from '@cloudforge/shared';
import { ANSIBLE_PROFILES } from './ansible-playbooks.js';

export class AnsibleNativeServiceRequirements implements NativeServiceRequirements {
  constructor(private readonly ansible: AnsibleManager) {}

  async requirements(
    target: DeploymentTarget,
  ): Promise<Result<readonly FirewallRequirement[], DeploymentError>> {
    const states = await this.ansible.profileStates(target);
    if (!states.ok) return states;
    return ok(observedAnsibleRequirements(ANSIBLE_PROFILES, states.value));
  }
}
