import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { utils as sshUtils } from 'ssh2';
import { NodeSshKeyGenerator } from './node-ssh-key-generator.js';

describe('NodeSshKeyGenerator', () => {
  const generator = new NodeSshKeyGenerator();

  it.each(['ed25519', 'rsa'] as const)('generates and re-inspects a %s key', (algorithm) => {
    const generated = generator.generate(algorithm);
    expect(generated.ok, generated.ok ? undefined : String(generated.error.cause)).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.publicKey).toMatch(
      new RegExp(`^ssh-${algorithm === 'rsa' ? 'rsa' : 'ed25519'} `),
    );
    expect(generated.value.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);

    const inspected = generator.inspect(generated.value.privateKey);
    expect(inspected.ok && inspected.value.fingerprint).toBe(generated.value.fingerprint);
  });

  it('encrypts generated private keys and requires the correct passphrase', () => {
    const generated = generator.generate('ed25519', 'correct horse');
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(generator.inspect(generated.value.privateKey).ok).toBe(false);
    expect(generator.inspect(generated.value.privateKey, 'wrong').ok).toBe(false);
    expect(generator.inspect(generated.value.privateKey, 'correct horse').ok).toBe(true);
  });

  it.each(['ed25519', 'rsa'] as const)('inspects an OpenSSH %s private key', (algorithm) => {
    const pair = sshUtils.generateKeyPairSync(
      algorithm,
      algorithm === 'rsa' ? { bits: 2048, comment: 'legacy-key' } : { comment: 'legacy-key' },
    );

    const inspected = generator.inspect(pair.private);

    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.algorithm).toBe(algorithm);
    expect(inspected.value.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(inspected.value.publicKey).toContain(' legacy-key');
    expect(inspected.value.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });

  it('inspects a passphrase-protected OpenSSH private key', () => {
    const pair = sshUtils.generateKeyPairSync('ed25519', {
      comment: 'protected-key',
      passphrase: 'correct horse',
      cipher: 'aes256-ctr',
      rounds: 16,
    });

    expect(generator.inspect(pair.private).ok).toBe(false);
    expect(generator.inspect(pair.private, 'wrong').ok).toBe(false);
    expect(generator.inspect(pair.private, 'correct horse').ok).toBe(true);
  });

  it('normalizes a legacy Ed25519 PKCS8 key into OpenSSH private-key format', () => {
    const legacy = generateKeyPairSync('ed25519').privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    });

    const inspected = generator.inspect(legacy.toString());

    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(sshUtils.parseKey(inspected.value.privateKey)).not.toBeInstanceOf(Error);

    const directory = mkdtempSync(join(tmpdir(), 'cloudforge-key-'));
    const path = join(directory, 'id_ed25519');
    try {
      const knownOpenSsh = sshUtils.generateKeyPairSync('ed25519', { comment: 'control' });
      writeFileSync(path, knownOpenSsh.private, { mode: 0o600 });
      if (process.platform === 'win32' && process.env.USERNAME) {
        spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], {
          encoding: 'utf8',
        });
      }
      const command = spawnSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' });
      if (!command.error || (command.error as NodeJS.ErrnoException).code !== 'ENOENT') {
        expect(command.status, command.stderr).toBe(0);
        expect(command.stdout).toMatch(/^ssh-ed25519 /);
      }
      writeFileSync(path, inspected.value.privateKey, { mode: 0o600 });
      const converted = spawnSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' });
      if (!converted.error || (converted.error as NodeJS.ErrnoException).code !== 'ENOENT') {
        expect(converted.status, converted.stderr).toBe(0);
        expect(converted.stdout).toMatch(/^ssh-ed25519 /);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects empty and malformed imports', () => {
    expect(generator.inspect('').ok).toBe(false);
    expect(generator.inspect('not a key').ok).toBe(false);
  });
});
