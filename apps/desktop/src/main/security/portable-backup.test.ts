import { describe, expect, it } from 'vitest';
import { decryptPortableSecrets, encryptPortableSecrets } from './portable-backup.js';

describe('portable backup encryption', () => {
  it('round-trips secrets without storing plaintext', () => {
    const plaintext = JSON.stringify({ credential: '{"privateKey":"secret"}' });
    const envelope = encryptPortableSecrets(plaintext, 'a-strong-passphrase');
    expect(JSON.stringify(envelope)).not.toContain('privateKey');
    expect(decryptPortableSecrets(envelope, 'a-strong-passphrase')).toBe(plaintext);
  });

  it('rejects short and incorrect passphrases', () => {
    expect(() => encryptPortableSecrets('{}', 'short')).toThrow(/at least 12/);
    const envelope = encryptPortableSecrets('{}', 'correct-passphrase');
    expect(() => decryptPortableSecrets(envelope, 'incorrect-passphrase')).toThrow(/incorrect/);
  });
});
