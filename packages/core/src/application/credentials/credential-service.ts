import {
  type Brand,
  type EncryptionError,
  err,
  type IsoDateString,
  NotFoundError,
  ok,
  parseUuid,
  type PersistenceError,
  type Result,
  type Uuid,
  ValidationError,
} from '@cloudforge/shared';
import {
  type CreateCredentialInput,
  Credential,
  type CredentialData,
  type CredentialId,
} from '../../domain/credential/credential.js';
import { CREDENTIAL_SCHEMAS } from '../../domain/credential/credential-kind.js';
import type { CredentialRecord, CredentialRepository } from '../ports/credential-repository.js';
import type { SecretCipher } from '../ports/secret-cipher.js';
import type { CredentialSummaryDto, RevealedCredentialDto } from '../dto/credential-dto.js';

/** Union of every failure the credential use-cases can surface. */
export type CredentialServiceError =
  ValidationError | NotFoundError | PersistenceError | EncryptionError;

/**
 * Application service for the encrypted Credential Manager. Secret material is
 * encrypted through the {@link SecretCipher} before it ever reaches the
 * repository, and decrypted only on explicit reveal or internal provider use.
 */
export class CredentialService {
  constructor(
    private readonly credentials: CredentialRepository,
    private readonly cipher: SecretCipher,
  ) {}

  async create(
    input: CreateCredentialInput,
  ): Promise<Result<CredentialSummaryDto, CredentialServiceError>> {
    const created = Credential.create(input);
    if (!created.ok) return created;

    const ciphertext = this.cipher.encrypt(JSON.stringify(created.value.data));
    if (!ciphertext.ok) return ciphertext;

    const record: CredentialRecord = {
      id: created.value.id,
      kind: created.value.kind,
      name: created.value.name,
      providerId: created.value.providerId,
      ciphertext: ciphertext.value,
      createdAt: created.value.createdAt,
      updatedAt: created.value.updatedAt,
    };
    const saved = await this.credentials.save(record);
    if (!saved.ok) return saved;

    return ok(toSummary(record));
  }

  async list(): Promise<Result<CredentialSummaryDto[], PersistenceError>> {
    const found = await this.credentials.findAll();
    if (!found.ok) return found;
    return ok(found.value.map(toSummary));
  }

  async reveal(id: string): Promise<Result<RevealedCredentialDto, CredentialServiceError>> {
    const loaded = await this.loadDecrypted(id);
    if (!loaded.ok) return loaded;
    const { record, data } = loaded.value;
    return ok({ id: record.id, kind: record.kind, name: record.name, data });
  }

  /** Load and decrypt a credential as a domain entity, for internal provider use. */
  async getDecrypted(id: string): Promise<Result<Credential, CredentialServiceError>> {
    const loaded = await this.loadDecrypted(id);
    if (!loaded.ok) return loaded;
    const { record, data } = loaded.value;
    return ok(
      Credential.reconstitute({
        id: record.id as Uuid as CredentialId,
        kind: record.kind,
        name: record.name,
        providerId: record.providerId,
        data,
        createdAt: record.createdAt as IsoDateString,
        updatedAt: record.updatedAt as IsoDateString,
      }),
    );
  }

  async remove(id: string): Promise<Result<void, CredentialServiceError>> {
    const credentialId = parseCredentialId(id);
    if (!credentialId.ok) return credentialId;
    return this.credentials.delete(credentialId.value);
  }

  private async loadDecrypted(
    id: string,
  ): Promise<Result<{ record: CredentialRecord; data: CredentialData }, CredentialServiceError>> {
    const credentialId = parseCredentialId(id);
    if (!credentialId.ok) return credentialId;

    const found = await this.credentials.findById(credentialId.value);
    if (!found.ok) return found;
    if (found.value === null) {
      return err(new NotFoundError('Credential not found', { context: { id } }));
    }

    const plaintext = this.cipher.decrypt(found.value.ciphertext);
    if (!plaintext.ok) return plaintext;

    const data = parseData(plaintext.value);
    return ok({ record: found.value, data });
  }
}

function toSummary(record: CredentialRecord): CredentialSummaryDto {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    providerId: record.providerId,
    fieldKeys: CREDENTIAL_SCHEMAS[record.kind].fields.map((f) => f.key),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseData(plaintext: string): CredentialData {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
    return {};
  } catch {
    return {};
  }
}

function parseCredentialId(id: string): Result<CredentialId, ValidationError> {
  const uuid = parseUuid(id);
  if (uuid === null) return err(new ValidationError('Invalid credential id', { context: { id } }));
  return ok(uuid as Brand<Uuid, 'CredentialId'>);
}
