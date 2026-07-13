/**
 * Lifecycle status of a project's infrastructure. Transitions are driven by the
 * provisioning and deployment pipelines in later phases.
 */
export const PROJECT_STATUSES = [
  'draft',
  'provisioning',
  'active',
  'error',
  'destroying',
  'destroyed',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
