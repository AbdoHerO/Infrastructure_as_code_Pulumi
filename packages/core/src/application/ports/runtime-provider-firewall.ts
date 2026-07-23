import type { DeploymentError, Result } from '@cloudforge/shared';
import type { FirewallView } from '../vps-runtime/firewall-requirements.js';

/** Reads current provider firewall rules for a saved VPS target. */
export interface RuntimeProviderFirewall {
  inspect(targetId: string): Promise<Result<FirewallView | null, DeploymentError>>;
}
