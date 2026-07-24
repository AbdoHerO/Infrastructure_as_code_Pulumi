import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ProjectPasskey, ProjectPasskeyHasher } from '@cloudforge/core';
import { EncryptionError, err, ok, type Result } from '@cloudforge/shared';

const derive = promisify(scrypt);
const KEY_BYTES = 32;
const CURRENT_VERSION = 1;

/** Node adapter for memory-hard, per-project local passkey hashing. */
export class NodeProjectPasskeyHasher implements ProjectPasskeyHasher {
  async hash(passkey: string): Promise<Result<ProjectPasskey, EncryptionError>> {
    try {
      const salt = randomBytes(16);
      const hash = (await derive(passkey, salt, KEY_BYTES)) as Buffer;
      return ok({
        hash: hash.toString('base64'),
        salt: salt.toString('base64'),
        version: CURRENT_VERSION,
      });
    } catch (cause) {
      return err(new EncryptionError('Failed to hash project passkey', { cause }));
    }
  }

  async verify(passkey: string, stored: ProjectPasskey): Promise<Result<boolean, EncryptionError>> {
    try {
      if (stored.version !== CURRENT_VERSION) {
        return err(new EncryptionError(`Unsupported project passkey version ${stored.version}`));
      }
      const expected = Buffer.from(stored.hash, 'base64');
      const salt = Buffer.from(stored.salt, 'base64');
      if (expected.length !== KEY_BYTES || salt.length < 16) return ok(false);
      const actual = (await derive(passkey, salt, expected.length)) as Buffer;
      return ok(timingSafeEqual(actual, expected));
    } catch (cause) {
      return err(new EncryptionError('Failed to verify project passkey', { cause }));
    }
  }
}
