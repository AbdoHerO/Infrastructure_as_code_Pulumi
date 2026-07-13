import type { CredentialKind } from '../../domain/credential/credential-kind.js';

/**
 * Non-sensitive summary of a credential, safe to list in the UI. Contains no
 * secret material — only metadata and which field keys are present.
 */
export interface CredentialSummaryDto {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly providerId: string | null;
  readonly fieldKeys: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The decrypted secret data of a credential, returned only on explicit reveal. */
export interface RevealedCredentialDto {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
  readonly data: Readonly<Record<string, string>>;
}
