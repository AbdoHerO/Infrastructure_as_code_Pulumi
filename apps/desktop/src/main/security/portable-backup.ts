import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export interface PortableSecretEnvelope {
  readonly format: 1;
  readonly algorithm: 'aes-256-gcm+scrypt';
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

const MIN_PASSPHRASE_LENGTH = 12;

export function encryptPortableSecrets(
  plaintext: string,
  passphrase: string,
): PortableSecretEnvelope {
  validatePassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    format: 1,
    algorithm: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptPortableSecrets(
  envelope: PortableSecretEnvelope,
  passphrase: string,
): string {
  validatePassphrase(passphrase);
  if (envelope.format !== 1 || envelope.algorithm !== 'aes-256-gcm+scrypt')
    throw new Error('Unsupported portable-secret backup format');
  try {
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const key = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('The backup passphrase is incorrect or the backup is damaged');
  }
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH)
    throw new Error(`Backup passphrase must contain at least ${MIN_PASSPHRASE_LENGTH} characters`);
}
