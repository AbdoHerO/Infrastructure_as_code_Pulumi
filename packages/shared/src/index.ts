/**
 * `@cloudforge/shared` — the shared kernel.
 *
 * Framework-agnostic primitives consumed by every layer: functional error
 * handling ({@link Result}), the domain error hierarchy, branded identities and
 * cross-cutting types. This package must remain free of provider-, framework-
 * and environment-specific dependencies.
 */
export * from './result/result.js';
export * from './errors/app-error.js';
export * from './branding/brand.js';
export * from './identity/id.js';
export * from './types/common.js';
export * from './constants/app.js';
