import { describe, expect, it } from 'vitest';
import { NodeProjectPasskeyHasher } from './project-passkey-hasher.js';

describe('NodeProjectPasskeyHasher', () => {
  it('uses a fresh salt and verifies without retaining plaintext', async () => {
    const hasher = new NodeProjectPasskeyHasher();
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.hash).not.toBe(second.value.hash);
    expect(first.value.salt).not.toBe(second.value.salt);
    await expect(hasher.verify('correct horse battery staple', first.value)).resolves.toEqual({
      ok: true,
      value: true,
    });
    await expect(hasher.verify('incorrect', first.value)).resolves.toEqual({
      ok: true,
      value: false,
    });
  });
});
