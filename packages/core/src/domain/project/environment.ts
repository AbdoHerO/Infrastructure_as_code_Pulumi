import { err, ok, type Result, ValidationError } from '@cloudforge/shared';

/** The deployment environment a project targets. */
export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

/** Validate an arbitrary string as an {@link Environment}. */
export function parseEnvironment(value: string): Result<Environment, ValidationError> {
  return (ENVIRONMENTS as readonly string[]).includes(value)
    ? ok(value as Environment)
    : err(
        new ValidationError(`Invalid environment: "${value}"`, {
          context: { allowed: ENVIRONMENTS },
        }),
      );
}
