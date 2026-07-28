import type { Db } from './client.js';

export interface ImportedProjectPasskey {
  readonly hash: string;
  readonly salt: string;
  readonly version: number;
}

export interface ImportedProjectCiphertexts {
  readonly credentials: Readonly<Record<string, string>>;
  readonly sshKeys: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * Remove every record that does not belong to one project from a database
 * snapshot. The resulting SQLite file is safe to place in a project backup:
 * it contains no device settings and no data from another workspace.
 */
export async function isolateProjectSnapshot(db: Db, projectId: string): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new Error('The active project is missing from the database snapshot');

  await db.$transaction(async (tx) => {
    await tx.project.deleteMany({ where: { id: { not: projectId } } });
    await tx.systemSetting.deleteMany();
  });
}

/**
 * Replace one project's persisted workspace from an isolated snapshot.
 *
 * The active project's passkey digest is deliberately retained. Restoring
 * project data must never change, remove, or bypass its local unlock boundary.
 */
export async function restoreProjectSnapshot(
  target: Db,
  source: Db,
  projectId: string,
): Promise<void> {
  const [
    sourceProject,
    providers,
    credentials,
    targets,
    pipelines,
    templates,
    deployments,
    logs,
    sshKeys,
    secrets,
    settings,
    plugins,
    activities,
  ] = await Promise.all([
    source.project.findUnique({ where: { id: projectId } }),
    source.provider.findMany({ where: { projectId } }),
    source.credential.findMany({ where: { projectId } }),
    source.vpsTarget.findMany({ where: { projectId } }),
    source.jenkinsPipeline.findMany({ where: { projectId } }),
    source.template.findMany({ where: { projectId } }),
    source.deployment.findMany({ where: { projectId } }),
    source.logEntry.findMany({ where: { projectId } }),
    source.sshKey.findMany({ where: { projectId } }),
    source.secret.findMany({ where: { projectId } }),
    source.setting.findMany({ where: { projectId } }),
    source.plugin.findMany({ where: { projectId } }),
    source.activity.findMany({ where: { projectId } }),
  ]);
  if (!sourceProject) throw new Error('The backup does not contain the selected project');

  await target.$transaction(
    async (tx) => {
      const current = await tx.project.findUnique({ where: { id: projectId } });
      if (!current) throw new Error('The active project no longer exists');

      await tx.project.delete({ where: { id: projectId } });
      await tx.project.create({
        data: {
          ...sourceProject,
          providerId: null,
          templateId: null,
          // A backup cannot alter the current workspace lock.
          passkeyHash: current.passkeyHash,
          passkeySalt: current.passkeySalt,
          passkeyVersion: current.passkeyVersion,
          lastOpenedAt: current.lastOpenedAt,
        },
      });
      if (providers.length > 0) await tx.provider.createMany({ data: providers });
      if (credentials.length > 0) await tx.credential.createMany({ data: credentials });
      if (templates.length > 0) await tx.template.createMany({ data: templates });
      if (targets.length > 0) await tx.vpsTarget.createMany({ data: targets });
      if (pipelines.length > 0) await tx.jenkinsPipeline.createMany({ data: pipelines });
      if (deployments.length > 0) await tx.deployment.createMany({ data: deployments });
      if (logs.length > 0) await tx.logEntry.createMany({ data: logs });
      if (sshKeys.length > 0) await tx.sshKey.createMany({ data: sshKeys });
      if (secrets.length > 0) await tx.secret.createMany({ data: secrets });
      if (settings.length > 0) await tx.setting.createMany({ data: settings });
      if (plugins.length > 0) await tx.plugin.createMany({ data: plugins });
      if (activities.length > 0) await tx.activity.createMany({ data: activities });
      await tx.project.update({
        where: { id: projectId },
        data: {
          providerId: sourceProject.providerId,
          templateId: sourceProject.templateId,
        },
      });
    },
    { timeout: 30_000 },
  );
}

/**
 * Import an isolated project snapshot without changing any existing project.
 *
 * Resource ids are intentionally preserved: Pulumi checkpoints and the many
 * project-internal references use them. A collision is rejected rather than
 * silently merging two security boundaries. Credential ciphertext is replaced
 * with data re-wrapped by the destination machine before it is persisted.
 */
export async function importProjectSnapshot(
  target: Db,
  source: Db,
  projectId: string,
  passkey: ImportedProjectPasskey,
  ciphertexts: ImportedProjectCiphertexts,
): Promise<void> {
  const [
    sourceProject,
    providers,
    credentials,
    targets,
    pipelines,
    templates,
    deployments,
    logs,
    sshKeys,
    secrets,
    settings,
    plugins,
    activities,
  ] = await Promise.all([
    source.project.findUnique({ where: { id: projectId } }),
    source.provider.findMany({ where: { projectId } }),
    source.credential.findMany({ where: { projectId } }),
    source.vpsTarget.findMany({ where: { projectId } }),
    source.jenkinsPipeline.findMany({ where: { projectId } }),
    source.template.findMany({ where: { projectId } }),
    source.deployment.findMany({ where: { projectId } }),
    source.logEntry.findMany({ where: { projectId } }),
    source.sshKey.findMany({ where: { projectId } }),
    source.secret.findMany({ where: { projectId } }),
    source.setting.findMany({ where: { projectId } }),
    source.plugin.findMany({ where: { projectId } }),
    source.activity.findMany({ where: { projectId } }),
  ]);
  if (!sourceProject) throw new Error('The backup does not contain the selected project');
  if (credentials.some((credential) => !ciphertexts.credentials[credential.id])) {
    throw new Error('The portable backup is missing one or more project credentials');
  }
  if (sshKeys.some((key) => key.ciphertext && !ciphertexts.sshKeys[key.id])) {
    throw new Error('The portable backup is missing one or more legacy SSH private keys');
  }
  if (secrets.some((secret) => !ciphertexts.secrets[secret.id])) {
    throw new Error('The portable backup is missing one or more legacy secrets');
  }

  await target.$transaction(
    async (tx) => {
      if (await tx.project.findUnique({ where: { id: projectId }, select: { id: true } })) {
        throw new Error('This project already exists. Open it and use Restore instead.');
      }
      await tx.project.create({
        data: {
          ...sourceProject,
          providerId: null,
          templateId: null,
          passkeyHash: passkey.hash,
          passkeySalt: passkey.salt,
          passkeyVersion: passkey.version,
          lastOpenedAt: null,
        },
      });
      if (providers.length > 0) await tx.provider.createMany({ data: providers });
      if (credentials.length > 0) {
        await tx.credential.createMany({
          data: credentials.map((credential) => ({
            ...credential,
            ciphertext: ciphertexts.credentials[credential.id]!,
          })),
        });
      }
      if (templates.length > 0) await tx.template.createMany({ data: templates });
      if (targets.length > 0) await tx.vpsTarget.createMany({ data: targets });
      if (pipelines.length > 0) await tx.jenkinsPipeline.createMany({ data: pipelines });
      if (deployments.length > 0) await tx.deployment.createMany({ data: deployments });
      if (logs.length > 0) await tx.logEntry.createMany({ data: logs });
      if (sshKeys.length > 0) {
        await tx.sshKey.createMany({
          data: sshKeys.map((key) => ({
            ...key,
            ciphertext: key.ciphertext ? ciphertexts.sshKeys[key.id]! : null,
          })),
        });
      }
      if (secrets.length > 0) {
        await tx.secret.createMany({
          data: secrets.map((secret) => ({
            ...secret,
            ciphertext: ciphertexts.secrets[secret.id]!,
          })),
        });
      }
      if (settings.length > 0) await tx.setting.createMany({ data: settings });
      if (plugins.length > 0) await tx.plugin.createMany({ data: plugins });
      if (activities.length > 0) await tx.activity.createMany({ data: activities });
      await tx.project.update({
        where: { id: projectId },
        data: { providerId: sourceProject.providerId, templateId: sourceProject.templateId },
      });
    },
    { timeout: 30_000 },
  );
}
