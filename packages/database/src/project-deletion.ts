import type { Prisma } from '@prisma/client';

/** One project id, or every project except one. */
export type ProjectSelector = string | { readonly not: string };

/**
 * Delete whole workspaces inside an open transaction, children first.
 *
 * Legacy databases received projectId through ALTER TABLE: most owned tables
 * have no physical ON DELETE CASCADE, and SshKey/Activity may carry ON DELETE
 * SET NULL, which the ownership triggers reject ("project ownership is
 * required"). Deleting every owned row explicitly works on both legacy and
 * fresh schemas and leaves no orphaned secret or runtime row behind.
 */
export async function deleteProjectWorkspaces(
  tx: Prisma.TransactionClient,
  selector: ProjectSelector,
): Promise<void> {
  const projectId = typeof selector === 'string' ? selector : { not: selector.not };
  const owned = { where: { projectId } };
  await tx.project.updateMany({ where: { id: projectId }, data: { providerId: null } });
  await tx.logEntry.deleteMany(owned);
  await tx.deployment.deleteMany(owned);
  await tx.jenkinsPipeline.deleteMany(owned);
  await tx.vpsTarget.deleteMany(owned);
  await tx.activity.deleteMany(owned);
  await tx.setting.deleteMany(owned);
  await tx.plugin.deleteMany(owned);
  await tx.template.deleteMany(owned);
  await tx.secret.deleteMany(owned);
  await tx.sshKey.deleteMany(owned);
  await tx.provider.deleteMany(owned);
  await tx.credential.deleteMany(owned);
  await tx.project.deleteMany({ where: { id: projectId } });
}
