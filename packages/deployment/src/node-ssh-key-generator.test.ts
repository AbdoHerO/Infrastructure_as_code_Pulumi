import { describe, expect, it } from 'vitest';
import { NodeSshKeyGenerator } from './node-ssh-key-generator.js';

describe('NodeSshKeyGenerator', () => {
  const generator = new NodeSshKeyGenerator();

  it.each(['ed25519', 'rsa'] as const)('generates and re-inspects a %s key', (algorithm) => {
    const generated = generator.generate(algorithm);
    expect(generated.ok).toBe(true);
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
    expect(generated.value.privateKey).toContain('ENCRYPTED PRIVATE KEY');
    expect(generator.inspect(generated.value.privateKey).ok).toBe(false);
    expect(generator.inspect(generated.value.privateKey, 'wrong').ok).toBe(false);
    expect(generator.inspect(generated.value.privateKey, 'correct horse').ok).toBe(true);
  });

  it('rejects empty and malformed imports', () => {
    expect(generator.inspect('').ok).toBe(false);
    expect(generator.inspect('not a key').ok).toBe(false);
  });
});
