declare const __brand: unique symbol;

/**
 * Nominal typing helper. `Brand<string, 'ProjectId'>` produces a type that is
 * structurally a string but not assignable to/from other branded strings —
 * preventing accidental mixing of IDs and other opaque primitives.
 */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Extract the underlying primitive from a branded type. */
export type Unbrand<T> = T extends Brand<infer U, string> ? U : T;
