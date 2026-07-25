import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { app, dialog } from 'electron';
import type { PortableCredentialSecrets, StackReference } from '@cloudforge/core';
import { ConflictError, UnauthorizedError } from '@cloudforge/shared';
import { getContainer } from '../../container.js';
import { projectStackReference } from '../../infra/stack-reference.js';
import { projectOperations } from '../../project-operation-registry.js';
import { registerHandler } from '../registry.js';
import {
  decryptPortableSecrets,
  encryptPortableSecrets,
  type PortableSecretEnvelope,
} from '../../security/portable-backup.js';

interface ProjectBackupManifest {
  readonly format: 3;
  readonly product: 'CloudForge';
  readonly scope: 'project';
  readonly projectId: string;
  readonly projectName: string;
  readonly stack: StackReference;
  readonly hasPulumiState: boolean;
  readonly createdAt: string;
  readonly version: string;
}

interface LegacyBackupManifest {
  readonly format: 1 | 2;
  readonly product: 'CloudForge';
}

type BackupManifest = ProjectBackupManifest | LegacyBackupManifest;

export function registerBackupHandlers(): void {
  registerHandler('backup:create', async ({ passphrase }) => {
    const current = getContainer();
    const lease = current.projectContext.current();
    if (!lease) throw new UnauthorizedError('Unlock a project to create its backup');
    const project = await current.projectService.get(lease.projectId);
    if (!project.ok) throw project.error;

    const selection = await dialog.showOpenDialog({
      title: `Choose a folder for the ${project.value.name} backup`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { path: null };

    const operation = projectOperations.begin(
      `backup-create:${lease.sessionId}`,
      lease.projectId,
      false,
    );
    let destination: string | null = null;
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      destination = join(selection.filePaths[0], `CloudForge-project-${timestamp}`);
      await mkdir(destination, { recursive: false });
      const secrets = await current.credentialService.exportPortableSecrets();
      if (!secrets.ok) throw secrets.error;
      const envelope = encryptPortableSecrets(JSON.stringify(secrets.value), passphrase);
      await current.snapshotProjectDatabase(join(destination, 'project.db'), lease.projectId);
      const stack = projectStackReference(project.value);
      const hasPulumiState = await copyProjectPulumiState(
        app.getPath('userData'),
        destination,
        stack,
      );
      await copyProjectLog(app.getPath('userData'), destination, lease.projectId);
      await writeFile(join(destination, 'credentials.enc'), JSON.stringify(envelope), 'utf8');
      const manifest: ProjectBackupManifest = {
        format: 3,
        product: 'CloudForge',
        scope: 'project',
        projectId: lease.projectId,
        projectName: project.value.name,
        stack,
        hasPulumiState,
        createdAt: new Date().toISOString(),
        version: app.getVersion(),
      };
      await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      return { path: destination };
    } catch (cause) {
      if (destination) await rm(destination, { recursive: true, force: true });
      throw cause;
    } finally {
      operation.complete();
    }
  });

  registerHandler('backup:restore', async ({ passphrase }) => {
    const current = getContainer();
    const lease = current.projectContext.current();
    if (!lease) throw new UnauthorizedError('Unlock the destination project first');
    const selection = await dialog.showOpenDialog({
      title: 'Select a CloudForge project backup folder',
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { restored: false };
    const source = selection.filePaths[0];
    const manifest = await readManifest(source);
    if (manifest.format !== 3) {
      throw new ConflictError(
        'This is a legacy whole-application backup. It cannot be restored over a multi-project database because that would overwrite unrelated projects.',
      );
    }
    if (manifest.scope !== 'project' || manifest.projectId !== lease.projectId) {
      throw new ConflictError(
        `This backup belongs to "${manifest.projectName}". Open that same project before restoring it.`,
      );
    }
    const activeProject = await current.projectService.get(lease.projectId);
    if (!activeProject.ok) throw activeProject.error;
    const activeStack = projectStackReference(activeProject.value);
    if (
      activeStack.project !== manifest.stack.project ||
      activeStack.stack !== manifest.stack.stack
    ) {
      throw new ConflictError(
        'The project name or environment changed after this backup. Restore is blocked to avoid writing a checkpoint under the wrong Pulumi stack identity.',
      );
    }
    if (!existsSync(join(source, 'project.db'))) throw new Error('Project backup database is missing');
    const portableSecrets = await readPortableSecrets(source, passphrase);

    const operation = projectOperations.begin(
      `backup-restore:${lease.sessionId}`,
      lease.projectId,
      false,
    );
    const safetyBackup = join(app.getPath('userData'), `pre-restore-${Date.now()}`);
    await mkdir(safetyBackup, { recursive: false });
    let restored = false;
    try {
      await current.snapshotProjectDatabase(join(safetyBackup, 'project.db'), lease.projectId);
      await copyProjectPulumiState(app.getPath('userData'), safetyBackup, manifest.stack);
      try {
        await current.restoreProjectDatabase(join(source, 'project.db'), lease.projectId);
        const imported = await current.credentialService.importPortableSecrets(portableSecrets);
        if (!imported.ok) throw imported.error;
        await restoreProjectPulumiState(source, app.getPath('userData'), manifest);
        restored = true;
      } catch (cause) {
        await current.restoreProjectDatabase(join(safetyBackup, 'project.db'), lease.projectId);
        await restoreProjectPulumiState(safetyBackup, app.getPath('userData'), {
          ...manifest,
          hasPulumiState: existsSync(join(safetyBackup, 'pulumi', 'stack.json')),
        });
        throw cause;
      }
    } finally {
      operation.complete();
      if (restored) await rm(safetyBackup, { recursive: true, force: true });
    }

    app.relaunch();
    app.exit(0);
    return { restored: true };
  });
}

async function readManifest(source: string): Promise<BackupManifest> {
  const parsed: unknown = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || (parsed as { product?: unknown }).product !== 'CloudForge')
    throw new Error('The selected folder is not a CloudForge backup');
  const manifest = parsed as BackupManifest;
  if (![1, 2, 3].includes(manifest.format))
    throw new Error('The selected folder uses an unsupported backup format');
  return manifest;
}

async function copyProjectPulumiState(
  userData: string,
  destination: string,
  stack: StackReference,
): Promise<boolean> {
  assertSafeSegment(stack.project);
  assertSafeSegment(stack.stack);
  const source = projectStackPath(userData, stack);
  if (!existsSync(source)) return false;
  await mkdir(join(destination, 'pulumi'), { recursive: true });
  await copyFile(source, join(destination, 'pulumi', 'stack.json'));
  return true;
}

async function restoreProjectPulumiState(
  source: string,
  userData: string,
  manifest: ProjectBackupManifest,
): Promise<void> {
  const target = projectStackPath(userData, manifest.stack);
  assertInside(resolve(userData), resolve(target));
  await rm(target, { force: true });
  if (!manifest.hasPulumiState) return;
  const checkpoint = join(source, 'pulumi', 'stack.json');
  if (!existsSync(checkpoint)) throw new Error('Project Pulumi checkpoint is missing');
  await mkdir(resolve(target, '..'), { recursive: true });
  await copyFile(checkpoint, target);
}

function projectStackPath(userData: string, stack: StackReference): string {
  assertSafeSegment(stack.project);
  assertSafeSegment(stack.stack);
  return join(userData, 'pulumi', 'state', '.pulumi', 'stacks', stack.project, `${stack.stack}.json`);
}

async function copyProjectLog(
  userData: string,
  destination: string,
  projectId: string,
): Promise<void> {
  assertSafeSegment(projectId);
  const source = join(userData, 'logs', 'projects', projectId, 'cloudforge.log');
  if (!existsSync(source)) return;
  await mkdir(join(destination, 'logs'), { recursive: true });
  await copyFile(source, join(destination, 'logs', 'cloudforge.log'));
}

async function readPortableSecrets(
  source: string,
  passphrase: string,
): Promise<PortableCredentialSecrets> {
  const path = join(source, 'credentials.enc');
  if (!existsSync(path)) throw new Error('Portable credential backup is missing');
  const envelope = JSON.parse(await readFile(path, 'utf8')) as PortableSecretEnvelope;
  const parsed: unknown = JSON.parse(decryptPortableSecrets(envelope, passphrase));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Portable credential backup is invalid');
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== 'string'))
    throw new Error('Portable credential backup is invalid');
  return Object.fromEntries(entries) as PortableCredentialSecrets;
}

function assertSafeSegment(value: string): void {
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value))
    throw new Error('Unsafe project backup path');
}

function assertInside(parent: string, child: string): void {
  if (!child.startsWith(`${parent}${sep}`)) throw new Error('Unsafe restore target');
}
