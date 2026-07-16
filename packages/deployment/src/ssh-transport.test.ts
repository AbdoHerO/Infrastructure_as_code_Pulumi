import { describe, expect, it } from 'vitest';
import {
  base64,
  fingerprintHostKey,
  normalizeFingerprint,
  privilegedScript,
  quote,
  sshConnectionConfig,
} from './ssh-transport.js';

const target = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'PRIVATE',
  hostKeySha256: 'SHA256:2Sqk9dPO8UUnBTbLGpJ3nHwmYYAOJcVLLcYRGDrNvS4',
};

describe('quote', () => {
  it('wraps a plain value as one shell word', () => {
    expect(quote('app.example.com')).toBe(`'app.example.com'`);
  });

  it('neutralises shell metacharacters', () => {
    for (const attack of [
      'a; reboot',
      'a && rm -rf /',
      'a | tee /etc/passwd',
      'a $(id)',
      'a `id`',
      'a\nreboot',
      'a > /etc/nginx/nginx.conf',
      '../../etc/shadow',
      '*',
    ]) {
      const quoted = quote(attack);
      expect(quoted.startsWith(`'`)).toBe(true);
      expect(quoted.endsWith(`'`)).toBe(true);
      // Everything between the outer quotes is literal: the only way out of a
      // POSIX single-quoted string is a quote character, and there is none.
      expect(quoted.slice(1, -1)).not.toContain(`'`);
    }
  });

  it('escapes an embedded single quote by closing, escaping and reopening', () => {
    expect(quote(`O'Brien`)).toBe(`'O'"'"'Brien'`);
  });

  it('does not let an embedded quote terminate the word and inject a command', () => {
    // The classic break-out attempt: value ends the quote then appends a command.
    expect(quote(`'; reboot; '`)).toBe(`''"'"'; reboot; '"'"''`);
  });

  it('round-trips through a POSIX shell word parser', () => {
    // Model how `sh` reads a single word: outside quotes, `'` opens a literal
    // run and `"` opens a double-quoted run; the `'"'"'` idiom depends on both.
    // Whatever the shell reconstructs must equal the original input exactly.
    const parse = (word: string): string => {
      let result = '';
      let index = 0;
      while (index < word.length) {
        const character = word[index];
        if (character === `'` || character === '"') {
          const end = word.indexOf(character, index + 1);
          expect(end, `unterminated ${character} in ${word}`).toBeGreaterThan(-1);
          result += word.slice(index + 1, end);
          index = end + 1;
        } else {
          result += character;
          index += 1;
        }
      }
      return result;
    };

    for (const value of [
      `plain`,
      `O'Brien`,
      `'; reboot; '`,
      `a'b'c`,
      `$(id)`,
      `''`,
      `'`,
      `a b`,
      `app.example.com`,
    ]) {
      expect(parse(quote(value)), value).toBe(value);
    }
  });
});

describe('privilegedScript', () => {
  it('base64-encodes the script instead of interpolating it', () => {
    const script = `echo 'hello'; reboot`;
    const command = privilegedScript(script);

    expect(command).toContain(base64(script));
    // The script body must never appear as shell text in the outer command.
    expect(command).not.toContain('reboot');
  });

  it('runs as root directly or via non-interactive sudo, then cleans up', () => {
    const command = privilegedScript('echo hi');

    expect(command).toContain('chmod 700');
    expect(command).toContain('if [ "$(id -u)" -eq 0 ]');
    expect(command).toContain('sudo -n');
    expect(command).toContain('rm -f');
  });

  it('preserves the script exit code after cleanup', () => {
    // `rm` must not mask a failing script, or callers treat failure as success.
    expect(privilegedScript('false')).toContain('code=$?');
    expect(privilegedScript('false')).toContain('exit $code');
  });

  it('uses a unique temporary path per invocation', () => {
    expect(privilegedScript('echo hi')).not.toBe(privilegedScript('echo hi'));
  });

  it('applies a caller-supplied prefix', () => {
    expect(privilegedScript('echo hi', 'cloudforge-nginx')).toContain('/tmp/cloudforge-nginx-');
  });
});

describe('fingerprintHostKey', () => {
  it('formats an OpenSSH SHA-256 fingerprint without base64 padding', () => {
    const fingerprint = fingerprintHostKey(Buffer.from('host-key-material'));

    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fingerprint).not.toContain('=');
  });

  it('is stable for the same key and differs for another', () => {
    expect(fingerprintHostKey(Buffer.from('a'))).toBe(fingerprintHostKey(Buffer.from('a')));
    expect(fingerprintHostKey(Buffer.from('a'))).not.toBe(fingerprintHostKey(Buffer.from('b')));
  });
});

describe('normalizeFingerprint', () => {
  it('treats prefixed, padded and whitespaced forms as one value', () => {
    const expected = normalizeFingerprint('2Sqk9dPO8UUnBTbLGpJ3nHwmYYAOJcVLLcYRGDrNvS4');

    expect(normalizeFingerprint('SHA256:2Sqk9dPO8UUnBTbLGpJ3nHwmYYAOJcVLLcYRGDrNvS4')).toBe(
      expected,
    );
    expect(normalizeFingerprint('  sha256:2Sqk9dPO8UUnBTbLGpJ3nHwmYYAOJcVLLcYRGDrNvS4=  ')).toBe(
      expected,
    );
  });

  it('keeps distinct keys distinct', () => {
    expect(normalizeFingerprint('SHA256:aaa')).not.toBe(normalizeFingerprint('SHA256:bbb'));
  });
});

describe('sshConnectionConfig', () => {
  it('pins the host key so a changed server never receives credentials', () => {
    const config = sshConnectionConfig(target);
    const verifier = config.hostVerifier as (key: Buffer) => boolean;

    // A key whose fingerprint matches the pin is accepted; anything else is not.
    const matching = Buffer.from('host-key-material');
    const pinned = sshConnectionConfig({ ...target, hostKeySha256: fingerprintHostKey(matching) });

    expect((pinned.hostVerifier as (key: Buffer) => boolean)(matching)).toBe(true);
    expect(verifier(Buffer.from('a different key'))).toBe(false);
  });

  it('accepts a pin recorded without the SHA256 prefix', () => {
    const key = Buffer.from('host-key-material');
    const bare = fingerprintHostKey(key).replace('SHA256:', '');
    const config = sshConnectionConfig({ ...target, hostKeySha256: bare });

    expect((config.hostVerifier as (k: Buffer) => boolean)(key)).toBe(true);
  });

  it('passes key, passphrase and password only when present', () => {
    expect(sshConnectionConfig(target)).toMatchObject({ privateKey: 'PRIVATE' });
    expect(sshConnectionConfig(target)).not.toHaveProperty('password');
    expect(
      sshConnectionConfig({ ...target, privateKey: undefined, password: 'secret' }),
    ).toMatchObject({ password: 'secret' });
  });

  it('rejects a target with no authentication material', () => {
    expect(() => sshConnectionConfig({ ...target, privateKey: undefined })).toThrow(
      /private key or password/i,
    );
  });
});
