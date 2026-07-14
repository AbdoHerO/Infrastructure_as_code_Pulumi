import {
  err,
  newUuid,
  NotFoundError,
  ok,
  type PersistenceError,
  type Result,
  toIsoDateString,
  ValidationError,
} from '@cloudforge/shared';
import type {
  VpsTargetRecord,
  VpsTargetRepository,
  VpsTargetUpdate,
} from '../ports/vps-target-repository.js';

export interface VpsTargetDto {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly sshCredentialId: string | null;
  readonly hostKeySha256: string;
  readonly lastPreflight: unknown;
  readonly lastPreflightAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveVpsTargetInput {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly sshCredentialId: string;
  readonly hostKeySha256: string;
}

export type VpsTargetServiceError = ValidationError | NotFoundError | PersistenceError;

const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/;
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/i;
const FINGERPRINT_PATTERN = /^(?:SHA256:)?[A-Za-z0-9+/]{43}=?$/;

export class VpsTargetService {
  constructor(private readonly targets: VpsTargetRepository) {}

  async list(): Promise<Result<VpsTargetDto[], PersistenceError>> {
    const result = await this.targets.list();
    return result.ok ? ok(result.value.map(toDto)) : result;
  }

  async get(id: string): Promise<Result<VpsTargetDto, VpsTargetServiceError>> {
    const found = await this.targets.get(id);
    if (!found.ok) return found;
    if (!found.value) return err(new NotFoundError(`VPS target "${id}" was not found`));
    return ok(toDto(found.value));
  }

  async create(input: SaveVpsTargetInput): Promise<Result<VpsTargetDto, VpsTargetServiceError>> {
    const validated = validate(input);
    if (!validated.ok) return validated;
    const now = toIsoDateString(new Date());
    const record: VpsTargetRecord = {
      id: newUuid(),
      ...validated.value,
      lastPreflight: '',
      lastPreflightAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.targets.create(record);
    return created.ok ? ok(toDto(record)) : created;
  }

  async update(
    id: string,
    input: SaveVpsTargetInput,
  ): Promise<Result<VpsTargetDto, VpsTargetServiceError>> {
    const validated = validate(input);
    if (!validated.ok) return validated;
    const existing = await this.targets.get(id);
    if (!existing.ok) return existing;
    if (!existing.value) return err(new NotFoundError(`VPS target "${id}" was not found`));
    const connectionChanged =
      existing.value.host !== validated.value.host ||
      existing.value.port !== validated.value.port ||
      existing.value.username !== validated.value.username ||
      existing.value.sshCredentialId !== validated.value.sshCredentialId ||
      existing.value.hostKeySha256 !== validated.value.hostKeySha256;
    const patch: VpsTargetUpdate = {
      ...validated.value,
      ...(connectionChanged ? { lastPreflight: '', lastPreflightAt: null } : {}),
    };
    const updated = await this.targets.update(id, patch);
    if (!updated.ok) return updated;
    return ok(
      toDto({
        ...existing.value,
        ...patch,
        updatedAt: toIsoDateString(new Date()),
      }),
    );
  }

  async recordPreflight(id: string, report: unknown): Promise<Result<void, VpsTargetServiceError>> {
    const existing = await this.targets.get(id);
    if (!existing.ok) return existing;
    if (!existing.value) return err(new NotFoundError(`VPS target "${id}" was not found`));
    return this.targets.update(id, {
      lastPreflight: JSON.stringify(report),
      lastPreflightAt: toIsoDateString(new Date()),
    });
  }

  remove(id: string): Promise<Result<void, PersistenceError>> {
    return this.targets.remove(id);
  }
}

function validate(
  input: SaveVpsTargetInput,
): Result<
  Omit<VpsTargetRecord, 'id' | 'lastPreflight' | 'lastPreflightAt' | 'createdAt' | 'updatedAt'>,
  ValidationError
> {
  const name = input.name.trim();
  const host = input.host.trim();
  const username = input.username.trim();
  const fingerprint = input.hostKeySha256.trim();
  if (!name || name.length > 80)
    return err(new ValidationError('Target name must be 1–80 characters'));
  if (!HOST_PATTERN.test(host))
    return err(new ValidationError('Enter a valid hostname or IP address'));
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
    return err(new ValidationError('SSH port must be 1–65535'));
  if (!USER_PATTERN.test(username))
    return err(new ValidationError('SSH username contains unsupported characters'));
  if (!input.sshCredentialId.trim()) return err(new ValidationError('Select an SSH credential'));
  if (!FINGERPRINT_PATTERN.test(fingerprint))
    return err(new ValidationError('Inspect and trust a valid SHA-256 SSH host fingerprint'));
  return ok({
    name,
    host,
    port: input.port,
    username,
    sshCredentialId: input.sshCredentialId,
    hostKeySha256: fingerprint.startsWith('SHA256:') ? fingerprint : `SHA256:${fingerprint}`,
  });
}

function toDto(record: VpsTargetRecord): VpsTargetDto {
  return {
    ...record,
    lastPreflight: parseReport(record.lastPreflight),
  };
}

function parseReport(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
