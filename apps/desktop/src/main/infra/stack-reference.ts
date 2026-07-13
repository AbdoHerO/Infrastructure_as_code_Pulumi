import type { ProjectDto, StackReference } from '@cloudforge/core';

/** Derive the stable Pulumi stack reference used for a CloudForge project. */
export function projectStackReference(project: ProjectDto): StackReference {
  const slug = project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return { project: `${slug || 'project'}-${project.id.slice(0, 8)}`, stack: project.environment };
}
