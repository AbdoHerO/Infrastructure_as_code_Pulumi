import type { Brand } from '../branding/brand.js';

/** An ISO-8601 timestamp string, e.g. `2026-07-13T10:00:00.000Z`. */
export type IsoDateString = Brand<string, 'IsoDateString'>;

/** Convert a `Date` to a branded ISO-8601 string. */
export function toIsoDateString(date: Date): IsoDateString {
  return date.toISOString() as IsoDateString;
}

/** Creation/update audit timestamps shared by persisted entities. */
export interface Timestamps {
  readonly createdAt: IsoDateString;
  readonly updatedAt: IsoDateString;
}

/** A page of results with cursor metadata. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}

/** Standard pagination request parameters. */
export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
}

/** Recursively mark every property of `T` readonly. */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Make the listed keys optional while keeping the rest required. */
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** A value that may still be loading, resolved, or failed — for UI state. */
export type Loadable<T, E = Error> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly error: E };
