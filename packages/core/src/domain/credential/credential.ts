import {
  type Brand,
  err,
  type IsoDateString,
  newUuid,
  ok,
  type Result,
  toIsoDateString,
  type Uuid,
  ValidationError,
} from '@cloudforge/shared';
import { Entity } from '../shared/entity.js';
import { CREDENTIAL_SCHEMAS, type CredentialKind, isCredentialKind } from './credential-kind.js';

/** Strongly-typed credential identity. */
export type CredentialId = Brand<Uuid, 'CredentialId'>;

/** Secret field values for a credential, keyed by field key. */
export type CredentialData = Readonly<Record<string, string>>;

/** Full persisted shape of a credential (secret data included). */
export interface CredentialProps {
  readonly id: CredentialId;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly providerId: string | null;
  readonly data: CredentialData;
  readonly createdAt: IsoDateString;
  readonly updatedAt: IsoDateString;
}

/** Attributes supplied to create a credential. */
export interface CreateCredentialInput {
  readonly kind: string;
  readonly name: string;
  readonly providerId?: string | null;
  readonly data: Record<string, string>;
}

/** Attributes supplied when replacing an existing encrypted credential. */
export interface UpdateCredentialInput extends CreateCredentialInput {
  readonly id: string;
}

/**
 * A Credential holds the (to-be-encrypted) secret material for one external
 * service. The entity validates its fields against the kind's schema; encryption
 * happens in the Application layer via the `SecretCipher` port.
 */
export class Credential extends Entity<CredentialId> {
  private constructor(private readonly props: CredentialProps) {
    super(props.id);
  }

  static create(
    input: CreateCredentialInput,
    now: Date = new Date(),
  ): Result<Credential, ValidationError> {
    if (!isCredentialKind(input.kind)) {
      return err(new ValidationError(`Unknown credential kind: "${input.kind}"`));
    }
    const name = input.name.trim();
    if (name.length === 0) return err(new ValidationError('Credential name is required'));

    const data = validateData(input.kind, input.data);
    if (!data.ok) return data;

    const timestamp = toIsoDateString(now);
    return ok(
      new Credential({
        id: newUuid() as CredentialId,
        kind: input.kind,
        name,
        providerId: input.providerId ?? null,
        data: data.value,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
  }

  static reconstitute(props: CredentialProps): Credential {
    return new Credential(props);
  }

  get kind(): CredentialKind {
    return this.props.kind;
  }
  get name(): string {
    return this.props.name;
  }
  get providerId(): string | null {
    return this.props.providerId;
  }
  get data(): CredentialData {
    return this.props.data;
  }
  get createdAt(): IsoDateString {
    return this.props.createdAt;
  }
  get updatedAt(): IsoDateString {
    return this.props.updatedAt;
  }
}

function validateData(
  kind: CredentialKind,
  raw: Record<string, string>,
): Result<CredentialData, ValidationError> {
  const spec = CREDENTIAL_SCHEMAS[kind];
  const data: Record<string, string> = {};
  for (const fieldSpec of spec.fields) {
    const value = (raw[fieldSpec.key] ?? '').trim();
    if (fieldSpec.required && value.length === 0) {
      return err(
        new ValidationError(`"${fieldSpec.label}" is required`, {
          context: { kind, field: fieldSpec.key },
        }),
      );
    }
    if (value.length > 0) data[fieldSpec.key] = value;
  }
  return ok(data);
}
