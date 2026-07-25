import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

const materialized = new Map<string, Set<string>>();

/**
 * Write a temporary OpenSSH key for the active workspace. These files are
 * removed when that workspace is locked or switched.
 */
export async function materializeProjectSshKey(input: {
  readonly projectId: string;
  readonly credentialId: string;
  readonly suggestedName: string;
  readonly privateKey: string;
}): Promise<string> {
  const directory = join(app.getPath('home'), '.ssh');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const safeName =
    input.suggestedName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'key';
  const path = join(
    directory,
    `cloudforge-${input.projectId.slice(0, 8)}-${safeName}-${input.credentialId.slice(0, 8)}`,
  );
  await writeFile(path, input.privateKey, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  const paths = materialized.get(input.projectId) ?? new Set<string>();
  paths.add(path);
  materialized.set(input.projectId, paths);
  return path;
}

export async function removeMaterializedProjectKeys(projectId: string): Promise<void> {
  const paths = materialized.get(projectId);
  materialized.delete(projectId);
  if (!paths) return;
  await Promise.all([...paths].map((path) => rm(path, { force: true })));
}

export async function removeMaterializedCredential(
  projectId: string,
  credentialId: string,
): Promise<void> {
  const paths = materialized.get(projectId);
  if (!paths) return;
  const suffix = `-${credentialId.slice(0, 8)}`;
  const matching = [...paths].filter((path) => path.endsWith(suffix));
  await Promise.all(matching.map((path) => rm(path, { force: true })));
  for (const path of matching) paths.delete(path);
  if (paths.size === 0) materialized.delete(projectId);
}
