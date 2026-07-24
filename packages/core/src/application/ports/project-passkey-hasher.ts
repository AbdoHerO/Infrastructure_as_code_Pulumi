import type { EncryptionError, Result } from '@cloudforge/shared';
import type { ProjectPasskey } from '../../domain/project/project.js';

/** Hashes and verifies local project passkeys without exposing an implementation to the domain. */
export interface ProjectPasskeyHasher {
  hash(passkey: string): Promise<Result<ProjectPasskey, EncryptionError>>;
  verify(passkey: string, stored: ProjectPasskey): Promise<Result<boolean, EncryptionError>>;
}
