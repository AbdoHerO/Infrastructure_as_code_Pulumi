import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { app, dialog } from 'electron';
import type { StackReference } from '@cloudforge/core';
import { ConflictError, UnauthorizedError } from '@cloudforge/shared';
import { getContainer, type PortableProjectSecrets } from '../../container.js';
import { projectStackReference } from '../../infra/stack-reference.js';
import { projectOperations } from '../../project-operation-registry.js';
import { registerHandler } from '../registry.js';
import {
  decryptPortableSecrets,
  encryptPortableSecrets,
  type PortableSecretEnvelope,
} from '../../security/portable-backup.js';

interface ProjectBackupManifest {
  readonly format: 3 | 4;
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
  registerHandler('backup:create', async ({ passphrase, projectPasskey }) => {
    const current = getContainer();
    const lease = current.projectContext.current();
    if (!lease) throw new UnauthorizedError('Unlock a project to create its backup');
    const authorized = await current.projectSessionService.authorizeCurrent(projectPasskey);
    if (!authorized.ok) throw authorized.error;
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
      const secrets = await current.exportProjectSecrets(lease.projectId);
      const envelope = encryptPortableSecrets(JSON.stringify(secrets), passphrase);
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
        format: 4,
        product: 'CloudForge',
        scope: 'project',
        projectId: lease.projectId,
        projectName: project.value.name,
        stack,
        hasPulumiState,
        createdAt: new Date().toISOString(),
        version: app.getVersion(),
      };
      await writeFile(
        join(destination, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );
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
    if (manifest.format !== 3 && manifest.format !== 4) {
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
    if (!existsSync(join(source, 'project.db')))
      throw new Error('Project backup database is missing');
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
        await current.rewrapProjectSecrets(lease.projectId, portableSecrets);
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

  registerHandler('backup:importProject', async ({ passphrase, projectPasskey }) => {
    const current = getContainer();
    if (current.projectContext.current()) {
      throw new ConflictError('Lock the current project before importing another workspace');
    }
    if (projectPasskey.length < 8) {
      throw new UnauthorizedError('The new project passkey must contain at least 8 characters');
    }
    const selection = await dialog.showOpenDialog({
      title: 'Select a CloudForge project backup folder to import',
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { imported: false };
    const source = selection.filePaths[0];
    const manifest = await readManifest(source);
    if ((manifest.format !== 3 && manifest.format !== 4) || manifest.scope !== 'project') {
      throw new ConflictError('Only a portable multi-project backup can be imported');
    }
    if (!existsSync(join(source, 'project.db')))
      throw new Error('Project backup database is missing');
    const projects = await current.projectService.listForPicker();
    if (!projects.ok) throw projects.error;
    if (projects.value.some((project) => project.id === manifest.projectId)) {
      throw new ConflictError('This project already exists. Open it and use Restore instead.');
    }
    const checkpointTarget = projectStackPath(app.getPath('userData'), manifest.stack);
    if (existsSync(checkpointTarget)) {
      throw new ConflictError(
        'A Pulumi stack with this project identity already exists on this computer. Import was stopped to avoid overwriting it.',
      );
    }
    const portableSecrets = await readPortableSecrets(source, passphrase);
    await current.importProjectDatabase(
      join(source, 'project.db'),
      manifest.projectId,
      projectPasskey,
      portableSecrets,
    );
    try {
      await restoreProjectPulumiState(source, app.getPath('userData'), manifest);
      await restoreProjectLog(source, app.getPath('userData'), manifest.projectId);
    } catch (cause) {
      const removed = await current.projectService.remove(manifest.projectId);
      if (!removed.ok) throw removed.error;
      await rm(checkpointTarget, { force: true });
      throw cause;
    }
    app.relaunch();
    app.exit(0);
    return { imported: true };
  });
}

async function readManifest(source: string): Promise<BackupManifest> {
  const parsed: unknown = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { product?: unknown }).product !== 'CloudForge'
  )
    throw new Error('The selected folder is not a CloudForge backup');
  const manifest = parsed as BackupManifest;
  if (![1, 2, 3, 4].includes(manifest.format))
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
  return join(
    userData,
    'pulumi',
    'state',
    '.pulumi',
    'stacks',
    stack.project,
    `${stack.stack}.json`,
  );
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

async function restoreProjectLog(
  source: string,
  userData: string,
  projectId: string,
): Promise<void> {
  assertSafeSegment(projectId);
  const backupLog = join(source, 'logs', 'cloudforge.log');
  if (!existsSync(backupLog)) return;
  const destination = join(userData, 'logs', 'projects', projectId, 'cloudforge.log');
  await mkdir(resolve(destination, '..'), { recursive: true });
  await copyFile(backupLog, destination);
}

async function readPortableSecrets(
  source: string,
  passphrase: string,
): Promise<PortableProjectSecrets> {
  const path = join(source, 'credentials.enc');
  if (!existsSync(path)) throw new Error('Portable credential backup is missing');
  const envelope = JSON.parse(await readFile(path, 'utf8')) as PortableSecretEnvelope;
  const parsed: unknown = JSON.parse(decryptPortableSecrets(envelope, passphrase));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Portable credential backup is invalid');
  const record = parsed as Record<string, unknown>;
  // Format 3 stored only the current Credential table as a flat id/value map.
  // It remains importable because all current secret kinds use that table.
  if (record.format !== 1) {
    const entries = Object.entries(record);
    if (entries.some(([, value]) => typeof value !== 'string'))
      throw new Error('Portable credential backup is invalid');
    return {
      format: 1,
      credentials: Object.fromEntries(entries) as Readonly<Record<string, string>>,
      sshKeys: {},
      secrets: {},
    };
  }
  const groups = ['credentials', 'sshKeys', 'secrets'] as const;
  for (const group of groups) {
    const value = record[group];
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Portable project secret backup is invalid');
    if (Object.values(value as Record<string, unknown>).some((entry) => typeof entry !== 'string'))
      throw new Error('Portable project secret backup is invalid');
  }
  return {
    format: 1,
    credentials: record.credentials as Readonly<Record<string, string>>,
    sshKeys: record.sshKeys as Readonly<Record<string, string>>,
    secrets: record.secrets as Readonly<Record<string, string>>,
  };
}

function assertSafeSegment(value: string): void {
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value))
    throw new Error('Unsafe project backup path');
}

function assertInside(parent: string, child: string): void {
  if (!child.startsWith(`${parent}${sep}`)) throw new Error('Unsafe restore target');
}
