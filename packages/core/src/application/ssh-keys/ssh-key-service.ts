import {
  err,
  type EncryptionError,
  type NotFoundError,
  ok,
  type PersistenceError,
  type Result,
  ValidationError,
} from '@cloudforge/shared';
import type { CredentialService } from '../credentials/credential-service.js';
import type {
  SshKeyAlgorithm,
  SshKeyGenerator,
  SshKeyMaterial,
} from '../ports/ssh-key-generator.js';

export interface SshKeySummary {
  readonly id: string;
  readonly name: string;
  readonly algorithm: SshKeyAlgorithm;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export type SshKeyServiceError =
  ValidationError | NotFoundError | PersistenceError | EncryptionError;

export class SshKeyService {
  constructor(
    private readonly credentials: CredentialService,
    private readonly generator: SshKeyGenerator,
  ) {}

  async list(): Promise<Result<SshKeySummary[], SshKeyServiceError>> {
    const credentials = await this.credentials.list();
    if (!credentials.ok) return credentials;
    const result: SshKeySummary[] = [];
    for (const summary of credentials.value.filter((credential) => credential.kind === 'ssh')) {
      const revealed = await this.credentials.reveal(summary.id);
      if (!revealed.ok) return revealed;
      const material = this.materialFromData(revealed.value.data);
      // A malformed legacy Secrets record must not hide every valid SSH key.
      if (!material.ok) continue;
      result.push({
        id: summary.id,
        name: summary.name,
        algorithm: material.value.algorithm,
        publicKey: material.value.publicKey,
        fingerprint: material.value.fingerprint,
        createdAt: summary.createdAt,
      });
    }
    return ok(result);
  }

  async generate(
    name: string,
    algorithm: SshKeyAlgorithm,
    passphrase?: string,
  ): Promise<Result<SshKeySummary, SshKeyServiceError>> {
    const cleanName = name.trim();
    if (!cleanName) return err(new ValidationError('SSH key name is required'));
    const material = this.generator.generate(algorithm, passphrase);
    if (!material.ok) return material;
    return this.save(cleanName, material.value, passphrase);
  }

  async import(
    name: string,
    privateKey: string,
    passphrase?: string,
  ): Promise<Result<SshKeySummary, SshKeyServiceError>> {
    const cleanName = name.trim();
    if (!cleanName) return err(new ValidationError('SSH key name is required'));
    const material = this.generator.inspect(privateKey, passphrase);
    if (!material.ok) return material;
    return this.save(cleanName, material.value, passphrase);
  }

  async revealPrivate(id: string): Promise<Result<string, SshKeyServiceError>> {
    const revealed = await this.credentials.reveal(id);
    if (!revealed.ok) return revealed;
    if (revealed.value.kind !== 'ssh')
      return err(new ValidationError('Credential is not an SSH key'));
    return ok(revealed.value.data.privateKey ?? '');
  }

  /** Resolve the encrypted credential that owns an installed public key. */
  async findByPublicKey(
    publicKey: string,
  ): Promise<Result<SshKeySummary | null, SshKeyServiceError>> {
    const keys = await this.list();
    if (!keys.ok) return keys;
    const normalized = normalizePublicKey(publicKey);
    return ok(keys.value.find((key) => normalizePublicKey(key.publicKey) === normalized) ?? null);
  }

  remove(id: string): Promise<Result<void, SshKeyServiceError>> {
    return this.credentials.remove(id);
  }

  private materialFromData(
    data: Readonly<Record<string, string>>,
  ): Result<SshKeyMaterial, ValidationError> {
    const inspected = this.generator.inspect(data.privateKey ?? '', data.passphrase);
    if (!inspected.ok) return inspected;
    if (
      data.publicKey &&
      normalizePublicKey(data.publicKey) !== normalizePublicKey(inspected.value.publicKey)
    ) {
      return err(new ValidationError('Stored SSH public and private keys do not match'));
    }
    return inspected;
  }

  private async save(
    name: string,
    material: SshKeyMaterial,
    passphrase?: string,
  ): Promise<Result<SshKeySummary, SshKeyServiceError>> {
    const created = await this.credentials.create({
      kind: 'ssh',
      name,
      data: {
        privateKey: material.privateKey,
        ...(passphrase ? { passphrase } : {}),
        publicKey: material.publicKey,
        fingerprint: material.fingerprint,
        algorithm: material.algorithm,
      },
    });
    if (!created.ok) return created;
    return ok({
      id: created.value.id,
      name: created.value.name,
      algorithm: material.algorithm,
      publicKey: material.publicKey,
      fingerprint: material.fingerprint,
      createdAt: created.value.createdAt,
    });
  }
}

function normalizePublicKey(value: string): string {
  return value.trim().split(/\s+/).slice(0, 2).join(' ');
}
