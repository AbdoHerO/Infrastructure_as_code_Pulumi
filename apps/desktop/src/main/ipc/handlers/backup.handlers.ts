import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { app, dialog } from 'electron';
import { getContainer } from '../../container.js';
import { registerHandler } from '../registry.js';

interface BackupManifest {
  readonly format: 1;
  readonly product: 'CloudForge';
  readonly createdAt: string;
  readonly version: string;
}

export function registerBackupHandlers(): void {
  registerHandler('backup:create', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Choose a folder for the CloudForge backup',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { path: null };
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = join(selection.filePaths[0], `CloudForge-backup-${timestamp}`);
    await mkdir(destination, { recursive: false });
    await copyCriticalData(app.getPath('userData'), destination);
    const manifest: BackupManifest = {
      format: 1,
      product: 'CloudForge',
      createdAt: new Date().toISOString(),
      version: app.getVersion(),
    };
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { path: destination };
  });

  registerHandler('backup:restore', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Select a CloudForge backup folder',
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { restored: false };
    const source = selection.filePaths[0];
    const manifest = JSON.parse(
      await readFile(join(source, 'manifest.json'), 'utf8'),
    ) as BackupManifest;
    if (manifest.product !== 'CloudForge' || manifest.format !== 1) {
      throw new Error('The selected folder is not a supported CloudForge backup');
    }
    if (!existsSync(join(source, 'cloudforge.db'))) throw new Error('Backup database is missing');

    const userData = resolve(app.getPath('userData'));
    const safetyBackup = join(userData, `pre-restore-${Date.now()}`);
    await mkdir(safetyBackup, { recursive: false });
    await copyCriticalData(userData, safetyBackup);
    await getContainer().dispose();

    await copyFile(join(source, 'cloudforge.db'), join(userData, 'cloudforge.db'));
    await restoreOptional(source, userData, 'secret.key');
    const pulumiTarget = resolve(userData, 'pulumi');
    assertInside(userData, pulumiTarget);
    await rm(pulumiTarget, { recursive: true, force: true });
    if (existsSync(join(source, 'pulumi'))) {
      await cp(join(source, 'pulumi'), pulumiTarget, { recursive: true, force: true });
    }

    app.relaunch();
    app.exit(0);
    return { restored: true };
  });
}

async function copyCriticalData(source: string, destination: string): Promise<void> {
  for (const name of ['cloudforge.db', 'secret.key'] as const) {
    if (existsSync(join(source, name))) await copyFile(join(source, name), join(destination, name));
  }
  if (existsSync(join(source, 'pulumi'))) {
    await cp(join(source, 'pulumi'), join(destination, 'pulumi'), { recursive: true, force: true });
  }
}

async function restoreOptional(source: string, destination: string, name: string): Promise<void> {
  if (basename(name) !== name) throw new Error('Invalid backup entry');
  if (existsSync(join(source, name))) await copyFile(join(source, name), join(destination, name));
}

function assertInside(parent: string, child: string): void {
  if (!child.startsWith(`${parent}${sep}`)) throw new Error('Unsafe restore target');
}
