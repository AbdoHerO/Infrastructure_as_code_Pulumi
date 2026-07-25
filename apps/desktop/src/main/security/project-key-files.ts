import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

const materialized = new Map<string, Set<string>>();

function keyRoot(): string {
  return join(app.getPath('userData'), 'runtime-keys');
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function projectDirectory(projectId: string): string {
  return join(keyRoot(), safeSegment(projectId));
}

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
  const directory = projectDirectory(input.projectId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const safeName = safeSegment(input.suggestedName);
  const path = join(directory, `${safeName}-${safeSegment(input.credentialId)}`);
  await writeFile(path, input.privateKey, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  const paths = materialized.get(input.projectId) ?? new Set<string>();
  paths.add(path);
  materialized.set(input.projectId, paths);
  return path;
}

export async function removeMaterializedProjectKeys(projectId: string): Promise<void> {
  materialized.delete(projectId);
  // Remove the whole project directory so files left by an interrupted write
  // cannot survive a normal lock/switch.
  await rm(projectDirectory(projectId), { recursive: true, force: true });
}

export async function removeMaterializedCredential(
  projectId: string,
  credentialId: string,
): Promise<void> {
  const paths = materialized.get(projectId);
  if (!paths) return;
  const suffix = `-${safeSegment(credentialId)}`;
  const matching = [...paths].filter((path) => path.endsWith(suffix));
  await Promise.all(matching.map((path) => rm(path, { force: true })));
  for (const path of matching) paths.delete(path);
  if (paths.size === 0) materialized.delete(projectId);
}

/** Remove transient key material left behind by an unclean application exit. */
export async function clearMaterializedProjectKeyRoot(): Promise<void> {
  materialized.clear();
  await rm(keyRoot(), { recursive: true, force: true });
}
