import type { Brand } from '../branding/brand.js';

/**
 * A UUID v4 branded so that a raw string cannot be passed where an identity is
 * expected. Domain packages refine this further, e.g.
 * `type ProjectId = Brand<Uuid, 'ProjectId'>`.
 */
export type Uuid = Brand<string, 'Uuid'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generate a new random UUID v4 using the platform Web Crypto API. Available in
 * both Node (≥ 19) and the browser renderer, keeping this kernel environment-agnostic.
 */
export function newUuid(): Uuid {
  return globalThis.crypto.randomUUID() as Uuid;
}

/** Whether a string is a syntactically valid UUID. */
export function isUuid(value: string): value is Uuid {
  return UUID_PATTERN.test(value);
}

/**
 * Parse a string into a branded {@link Uuid}, or return `null` if invalid.
 * Callers in the Domain layer should convert `null` into a `ValidationError`.
 */
export function parseUuid(value: string): Uuid | null {
  return isUuid(value) ? value : null;
}
