import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { app, dialog } from 'electron';
import type { PortableCredentialSecrets } from '@cloudforge/core';
import { getContainer, initContainer } from '../../container.js';
import { registerHandler } from '../registry.js';
import {
  decryptPortableSecrets,
  encryptPortableSecrets,
  type PortableSecretEnvelope,
} from '../../security/portable-backup.js';

interface BackupManifest {
  readonly format: 1 | 2;
  readonly product: 'CloudForge';
  readonly createdAt: string;
  readonly version: string;
}

export function registerBackupHandlers(): void {
  registerHandler('backup:create', async ({ passphrase }) => {
    const selection = await dialog.showOpenDialog({
      title: 'Choose a folder for the CloudForge backup',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { path: null };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = join(selection.filePaths[0], `CloudForge-backup-${timestamp}`);
    await mkdir(destination, { recursive: false });
    const current = getContainer();
    const secrets = await current.credentialService.exportPortableSecrets();
    if (!secrets.ok) throw secrets.error;
    const envelope = encryptPortableSecrets(JSON.stringify(secrets.value), passphrase);
    await current.snapshotDatabase(join(destination, 'cloudforge.db'));
    await copySupportingData(app.getPath('userData'), destination);
    await writeFile(join(destination, 'credentials.enc'), JSON.stringify(envelope), 'utf8');
    const manifest: BackupManifest = {
      format: 2,
      product: 'CloudForge',
      createdAt: new Date().toISOString(),
      version: app.getVersion(),
    };
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { path: destination };
  });

  registerHandler('backup:restore', async ({ passphrase }) => {
    const selection = await dialog.showOpenDialog({
      title: 'Select a CloudForge backup folder',
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { restored: false };
    const source = selection.filePaths[0];
    const manifest = JSON.parse(
      await readFile(join(source, 'manifest.json'), 'utf8'),
    ) as BackupManifest;
    if (manifest.product !== 'CloudForge' || ![1, 2].includes(manifest.format)) {
      throw new Error('The selected folder is not a supported CloudForge backup');
    }
    if (!existsSync(join(source, 'cloudforge.db'))) throw new Error('Backup database is missing');
    const portableSecrets =
      manifest.format === 2 ? await readPortableSecrets(source, passphrase) : null;

    const userData = resolve(app.getPath('userData'));
    const safetyBackup = join(userData, `pre-restore-${Date.now()}`);
    await mkdir(safetyBackup, { recursive: false });
    const current = getContainer();
    await current.snapshotDatabase(join(safetyBackup, 'cloudforge.db'));
    await copySupportingData(userData, safetyBackup);
    await current.dispose();
    let restored: Awaited<ReturnType<typeof initContainer>> | null = null;
    try {
      await restoreDataFiles(source, userData);
      restored = await initContainer();
      if (portableSecrets) {
        const imported = await restored.credentialService.importPortableSecrets(portableSecrets);
        if (!imported.ok) throw imported.error;
      }
    } catch (cause) {
      await restored?.dispose();
      await restoreDataFiles(safetyBackup, userData);
      await initContainer();
      throw cause;
    }

    app.relaunch();
    app.exit(0);
    return { restored: true };
  });
}

async function copySupportingData(source: string, destination: string): Promise<void> {
  for (const name of ['secret.key'] as const) {
    if (existsSync(join(source, name))) await copyFile(join(source, name), join(destination, name));
  }
  if (existsSync(join(source, 'pulumi'))) {
    await cp(join(source, 'pulumi'), join(destination, 'pulumi'), { recursive: true, force: true });
  }
}

async function restoreDataFiles(source: string, userData: string): Promise<void> {
  await copyFile(join(source, 'cloudforge.db'), join(userData, 'cloudforge.db'));
  await replaceOptional(source, userData, 'secret.key');
  const pulumiTarget = resolve(userData, 'pulumi');
  assertInside(userData, pulumiTarget);
  await rm(pulumiTarget, { recursive: true, force: true });
  if (existsSync(join(source, 'pulumi'))) {
    await cp(join(source, 'pulumi'), pulumiTarget, { recursive: true, force: true });
  }
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

async function replaceOptional(source: string, destination: string, name: string): Promise<void> {
  if (basename(name) !== name) throw new Error('Invalid backup entry');
  const target = join(destination, name);
  await rm(target, { force: true });
  if (existsSync(join(source, name))) await copyFile(join(source, name), target);
}

function assertInside(parent: string, child: string): void {
  if (!child.startsWith(`${parent}${sep}`)) throw new Error('Unsafe restore target');
}
