import { beforeEach, describe, expect, it } from 'vitest';
import { type EncryptionError, ok, type PersistenceError, type Result } from '@cloudforge/shared';
import type { CredentialId } from '../../domain/credential/credential.js';
import type { CredentialRecord, CredentialRepository } from '../ports/credential-repository.js';
import type { SecretCipher } from '../ports/secret-cipher.js';
import { CredentialService } from './credential-service.js';

class InMemoryCredentialRepository implements CredentialRepository {
  private readonly store = new Map<string, CredentialRecord>();

  findAll(): Promise<Result<CredentialRecord[], PersistenceError>> {
    return Promise.resolve(ok([...this.store.values()]));
  }
  findById(id: CredentialId): Promise<Result<CredentialRecord | null, PersistenceError>> {
    return Promise.resolve(ok(this.store.get(id) ?? null));
  }
  save(record: CredentialRecord): Promise<Result<void, PersistenceError>> {
    this.store.set(record.id, record);
    return Promise.resolve(ok(undefined));
  }
  delete(id: CredentialId): Promise<Result<void, PersistenceError>> {
    this.store.delete(id);
    return Promise.resolve(ok(undefined));
  }
}

/** Reversible, test-only cipher (base64) — never used in production. */
const fakeCipher: SecretCipher = {
  backedByOsKeychain: false,
  encrypt: (plaintext): Result<string, EncryptionError> =>
    ok(Buffer.from(plaintext, 'utf8').toString('base64')),
  decrypt: (ciphertext): Result<string, EncryptionError> =>
    ok(Buffer.from(ciphertext, 'base64').toString('utf8')),
};

describe('CredentialService', () => {
  let repo: InMemoryCredentialRepository;
  let service: CredentialService;

  beforeEach(() => {
    repo = new InMemoryCredentialRepository();
    service = new CredentialService(repo, fakeCipher);
  });

  it('encrypts secret data at rest and never stores plaintext', async () => {
    const created = await service.create({
      kind: 'anthropic',
      name: 'My key',
      data: { apiKey: 'sk-ant-secret' },
    });
    expect(created.ok).toBe(true);

    const stored = await repo.findAll();
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value[0]?.ciphertext).not.toContain('sk-ant-secret');
  });

  it('lists summaries without exposing secrets', async () => {
    await service.create({ kind: 'github', name: 'CI', data: { personalAccessToken: 'ghp_x' } });
    const listed = await service.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]?.name).toBe('CI');
    expect(JSON.stringify(listed.value)).not.toContain('ghp_x');
  });

  it('reveals decrypted data on request', async () => {
    const created = await service.create({
      kind: 'openai',
      name: 'GPT',
      data: { apiKey: 'sk-123' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const revealed = await service.reveal(created.value.id);
    expect(revealed.ok).toBe(true);
    if (revealed.ok) expect(revealed.value.data.apiKey).toBe('sk-123');
  });

  it('rejects missing required fields', async () => {
    const result = await service.create({ kind: 'aws', name: 'prod', data: { accessKeyId: 'AK' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('deletes a credential', async () => {
    const created = await service.create({
      kind: 'cloudflare',
      name: 'dns',
      data: { apiToken: 't' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await service.remove(created.value.id)).ok).toBe(true);
    const listed = await service.list();
    expect(listed.ok && listed.value).toHaveLength(0);
  });
});
