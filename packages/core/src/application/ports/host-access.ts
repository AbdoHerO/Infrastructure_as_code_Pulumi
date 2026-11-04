import type { DeploymentError, Result } from '@cloudforge/shared';
import type { DeploymentTarget } from './deployer.js';

/**
 * SSH access for other people — a client, a colleague — to a server CloudForge
 * manages.
 *
 * Each person gets their own Linux account with their own public key. Nobody is
 * ever given CloudForge's private key: that key is CloudForge's access, it opens
 * every server it is installed on, and sharing it would make one person's access
 * impossible to withdraw without breaking CloudForge's.
 *
 * Only accounts CloudForge created are ever changed or removed. They carry
 * {@link HOST_ACCESS_MARKER} as their GECOS comment; an existing account without
 * it — `ubuntu`, `root`, anything a person or another tool made — is refused.
 */

/** The GECOS comment of every account CloudForge creates for SSH access. */
export const HOST_ACCESS_MARKER = 'CloudForge access';

export interface HostAccessKey {
  /** OpenSSH fingerprint, `SHA256:…`. */
  readonly fingerprint: string;
  /** Key type as `ssh-keygen -l` names it: `ED25519`, `RSA`, `ECDSA`… */
  readonly type: string;
  readonly bits: number;
  readonly comment: string;
}

export interface HostAccessUser {
  readonly username: string;
  /** True when the account may run `sudo` (full administrator). */
  readonly sudo: boolean;
  readonly keys: readonly HostAccessKey[];
}

export interface HostAccessState {
  /** Accounts CloudForge created for SSH access, nothing else. */
  readonly users: readonly HostAccessUser[];
  /**
   * What on the server could still stop these people from connecting, read
   * from the SSH daemon's effective configuration (CloudForge never edits it):
   * an `AllowUsers` list that does not name them, public-key login switched off.
   */
  readonly warnings: readonly string[];
}

export interface HostAccessGrant {
  readonly username: string;
  /** One validated OpenSSH public key line: `type base64 [comment]`. */
  readonly publicKey: string;
  readonly sudo: boolean;
}

/**
 * Reads and changes the SSH access accounts on a host.
 *
 * `grant` creates the account when it does not exist and adds the key when it
 * is not there yet; giving or taking `sudo` follows the grant. `revoke` removes
 * the account, its home folder and its sudo rule. Both refuse an account
 * CloudForge did not create.
 */
export interface HostAccessManager {
  inspect(target: DeploymentTarget): Promise<Result<HostAccessState, DeploymentError>>;
  grant(
    target: DeploymentTarget,
    grant: HostAccessGrant,
  ): Promise<Result<HostAccessState, DeploymentError>>;
  revoke(
    target: DeploymentTarget,
    username: string,
  ): Promise<Result<HostAccessState, DeploymentError>>;
}
