import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

/** Resolves a saved VPS target into short-lived connection material. */
export interface RemoteTargetResolver {
  resolve(targetId: string): Promise<Result<DeploymentTarget, DeploymentError>>;
}
