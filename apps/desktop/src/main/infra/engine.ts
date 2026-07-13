import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { PulumiEngine } from '@cloudforge/pulumi';

/**
 * Build the Pulumi engine bound to the app's `userData` directory: a private
 * Pulumi home, a local file backend for state, and a locally-persisted
 * passphrase for encrypting stack secrets.
 */
export function createInfrastructureEngine(): PulumiEngine {
  const base = join(app.getPath('userData'), 'pulumi');
  const home = join(base, 'home');
  const state = join(base, 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });

  const passphraseFile = join(base, 'passphrase');
  let passphrase: string;
  if (existsSync(passphraseFile)) {
    passphrase = readFileSync(passphraseFile, 'utf8');
  } else {
    passphrase = randomBytes(24).toString('base64');
    writeFileSync(passphraseFile, passphrase, { mode: 0o600 });
  }

  return new PulumiEngine({
    home,
    stateDir: state,
    // Pulumi's DIY/file backend strips the `file://` prefix and runs
    // `filepath.Abs()` on the remainder, so the URL must be `file://` + a plain
    // absolute path with forward slashes and NO leading slash before the drive.
    // On Windows this is `file://C:/Users/...` (two slashes); a canonical
    // three-slash `file:///C:/...` URL becomes `/C:/...` → Abs → `C:\C:\...`.
    backendUrl: `file://${state.replace(/\\/g, '/')}`,
    passphrase,
  });
}
