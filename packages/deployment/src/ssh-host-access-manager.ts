/**
 * Gives and removes other people's SSH access over verified SSH.
 *
 * Thin by design: which account and which key are decided above, and every line
 * of shell lives in `host-access-script`. Each change is followed by reading the
 * accounts back, so what the page shows is what the server has.
 */
import type {
  DeploymentTarget,
  HostAccessGrant,
  HostAccessManager,
  HostAccessState,
} from '@cloudforge/core';
import { ok, type DeploymentError, type Result } from '@cloudforge/shared';
import {
  grantAccessScript,
  inspectAccessScript,
  parseAccessState,
  revokeAccessScript,
} from './host-access-script.js';
import { runPrivilegedScript } from './ssh-transport.js';

const LABEL = 'SSH access';
const TIMEOUT_MS = 60_000;

export class SshHostAccessManager implements HostAccessManager {
  async inspect(target: DeploymentTarget): Promise<Result<HostAccessState, DeploymentError>> {
    const result = await runPrivilegedScript(target, inspectAccessScript(), {
      label: LABEL,
      timeoutMs: TIMEOUT_MS,
    });
    if (!result.ok) return result;
    return ok(parseAccessState(result.value.stdout));
  }

  async grant(
    target: DeploymentTarget,
    grant: HostAccessGrant,
  ): Promise<Result<HostAccessState, DeploymentError>> {
    return this.change(target, grantAccessScript(grant));
  }

  async revoke(
    target: DeploymentTarget,
    username: string,
  ): Promise<Result<HostAccessState, DeploymentError>> {
    return this.change(target, revokeAccessScript(username));
  }

  private async change(
    target: DeploymentTarget,
    script: string,
  ): Promise<Result<HostAccessState, DeploymentError>> {
    const applied = await runPrivilegedScript(target, script, {
      label: LABEL,
      timeoutMs: TIMEOUT_MS,
    });
    if (!applied.ok) return applied;
    return this.inspect(target);
  }
}
