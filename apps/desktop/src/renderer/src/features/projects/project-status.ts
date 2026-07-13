import type { BadgeProps } from '@cloudforge/ui';
import type { ProjectDto } from '@cloudforge/core';

/** Map a project status to a Badge variant for consistent status colours. */
export function statusVariant(status: ProjectDto['status']): BadgeProps['variant'] {
  switch (status) {
    case 'active':
      return 'success';
    case 'provisioning':
    case 'destroying':
      return 'warning';
    case 'error':
      return 'destructive';
    case 'destroyed':
      return 'outline';
    case 'draft':
    default:
      return 'secondary';
  }
}
