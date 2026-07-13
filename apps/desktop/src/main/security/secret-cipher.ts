import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import { EncryptionError, err, fromThrowable, ok, type Result } from '@cloudforge/shared';
import type { SecretCipher } from '@cloudforge/core';

/**
 * Preferred cipher: delegates to the OS keychain via Electron `safeStorage`
 * (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 */
class SafeStorageCipher implements SecretCipher {
  readonly backedByOsKeychain = true;

  encrypt(plaintext: string): Result<string, EncryptionError> {
    return fromThrowable(
      () => safeStorage.encryptString(plaintext).toString('base64'),
      (cause) => new EncryptionError('Failed to encrypt secret', { cause }),
    );
  }

  decrypt(ciphertext: string): Result<string, EncryptionError> {
    return fromThrowable(
      () => safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
      (cause) => new EncryptionError('Failed to decrypt secret', { cause }),
    );
  }
}

/**
 * Fallback cipher for systems without an available OS keychain. Uses
 * AES-256-GCM with a locally-persisted key (0600). Weaker than the OS keychain
 * (the key sits on disk) but never stores plaintext.
 */
class AesGcmCipher implements SecretCipher {
  readonly backedByOsKeychain = false;

  constructor(private readonly key: Buffer) {}

  encrypt(plaintext: string): Result<string, EncryptionError> {
    return fromThrowable(
      () => {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, encrypted]).toString('base64');
      },
      (cause) => new EncryptionError('Failed to encrypt secret', { cause }),
    );
  }

  decrypt(ciphertext: string): Result<string, EncryptionError> {
    return fromThrowable(
      () => {
        const buffer = Buffer.from(ciphertext, 'base64');
        const iv = buffer.subarray(0, 12);
        const tag = buffer.subarray(12, 28);
        const data = buffer.subarray(28);
        const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      },
      (cause) => new EncryptionError('Failed to decrypt secret', { cause }),
    );
  }
}

function loadOrCreateKey(): Result<Buffer, EncryptionError> {
  return fromThrowable(
    () => {
      const keyPath = join(app.getPath('userData'), 'secret.key');
      if (existsSync(keyPath)) return readFileSync(keyPath);
      const key = randomBytes(32);
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, key, { mode: 0o600 });
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        // Best-effort on platforms without POSIX permissions (e.g. Windows).
      }
      return key;
    },
    (cause) => new EncryptionError('Failed to initialise fallback encryption key', { cause }),
  );
}

/**
 * Create the best available {@link SecretCipher}: the OS keychain when possible,
 * otherwise the AES-GCM fallback. Must be called after the app is ready.
 */
export function createSecretCipher(): Result<SecretCipher, EncryptionError> {
  if (safeStorage.isEncryptionAvailable()) return ok(new SafeStorageCipher());
  const key = loadOrCreateKey();
  if (!key.ok) return err(key.error);
  return ok(new AesGcmCipher(key.value));
}
