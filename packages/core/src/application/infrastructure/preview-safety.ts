import type { PreviewAnalysis, PreviewResourceChange } from '../ports/infrastructure-engine.js';

type PreviewLike = Pick<PreviewAnalysis, 'hasReplacements' | 'hasDeletes' | 'resources'>;

/**
 * Whether applying a preview can lose data or servers.
 *
 * Not only replacements and deletions: an Oracle "update" that swaps a server's
 * image replaces its boot disk, and the engine marks such a change destructive
 * on the resource itself. Checking only the operation names let exactly that
 * change through as safe.
 */
export function isDestructivePreview(preview: PreviewLike): boolean {
  return (
    preview.hasReplacements || preview.hasDeletes || preview.resources.some((r) => r.destructive)
  );
}

/** Servers that already exist and that the preview would change, replace or delete. */
export function changedServers(
  preview: Pick<PreviewAnalysis, 'resources'>,
): PreviewResourceChange[] {
  return preview.resources.filter((r) => r.type === 'Instance' && r.operation !== 'create');
}
