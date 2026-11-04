import { describe, expect, it } from 'vitest';
import {
  grantAccessScript,
  inspectAccessScript,
  parseAccessState,
  parseKeygenLine,
  revokeAccessScript,
  sudoRulePath,
} from './host-access-script.js';
import { parsesAsShell } from './shell-syntax.test-helper.js';

const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPPiUQHxA6k+sUd6fS8bhCCfdYr3aVWfJkxbm9M/ntbR alex@laptop';

describe('host access scripts', () => {
  it.each([
    ['inspect', inspectAccessScript()],
    ['grant with sudo', grantAccessScript({ username: 'alex', publicKey: KEY, sudo: true })],
    [
      'grant without sudo',
      grantAccessScript({ username: 'client-1', publicKey: KEY, sudo: false }),
    ],
    ['revoke', revokeAccessScript('alex')],
  ])('generates a script that parses: %s', (_name, script) => {
    expect(parsesAsShell(script)).toBe(true);
  });

  it('carries the key base64-encoded, never as shell text', () => {
    const script = grantAccessScript({
      username: 'alex',
      publicKey: "ssh-ed25519 AAAA $(reboot) 'x'",
      sudo: false,
    });
    expect(script).not.toContain('$(reboot)');
    expect(script).toContain(Buffer.from("ssh-ed25519 AAAA $(reboot) 'x'").toString('base64'));
  });

  it('only touches accounts CloudForge created, and never its own login', () => {
    for (const script of [
      grantAccessScript({ username: 'alex', publicKey: KEY, sudo: true }),
      revokeAccessScript('alex'),
    ]) {
      expect(script).toContain("MARK='CloudForge access'");
      expect(script).toContain('was not created by CloudForge');
      expect(script).toContain('"${SUDO_USER:-}" = "$U"');
    }
  });

  it('checks a sudo rule with visudo before it takes effect, and removes it without sudo', () => {
    const withSudo = grantAccessScript({ username: 'alex', publicKey: KEY, sudo: true });
    expect(withSudo).toContain('visudo -cf "$tmp"');
    expect(withSudo).toContain('mv "$tmp" /etc/sudoers.d/cloudforge-access-alex');
    const without = grantAccessScript({ username: 'alex', publicKey: KEY, sudo: false });
    expect(without).toContain('SUDO=0');
  });

  it('adds a key only once and keeps the owner-only permissions sshd requires', () => {
    const script = grantAccessScript({ username: 'alex', publicKey: KEY, sudo: false });
    expect(script).toContain('grep -qxF "$blob"');
    expect(script).toContain('chmod 700 "$home/.ssh"');
    expect(script).toContain('chmod 600 "$f"');
  });

  it('refuses names and keys that could break out of the shell', () => {
    expect(() => revokeAccessScript('a;rm -rf /')).toThrow();
    expect(() => sudoRulePath('../../etc/passwd')).toThrow();
    expect(() =>
      grantAccessScript({ username: 'alex', publicKey: `${KEY}\n${KEY}`, sudo: false }),
    ).toThrow();
  });
});

describe('parseAccessState', () => {
  it('reads accounts, their keys and the warnings', () => {
    const state = parseAccessState(
      [
        'USER\talex\t1',
        'KEY\talex\t256 SHA256:Kq70I+abc alex@laptop (ED25519)',
        'KEY\talex\t3072 SHA256:xyz no comment (RSA)',
        'USER\tclient-1\t0',
        'WARN\tThe SSH server lets in only these accounts (AllowUsers): ubuntu',
        'garbage line',
        '',
      ].join('\n'),
    );
    expect(state).toEqual({
      users: [
        {
          username: 'alex',
          sudo: true,
          keys: [
            {
              bits: 256,
              fingerprint: 'SHA256:Kq70I+abc',
              comment: 'alex@laptop',
              type: 'ED25519',
            },
            { bits: 3072, fingerprint: 'SHA256:xyz', comment: '', type: 'RSA' },
          ],
        },
        { username: 'client-1', sudo: false, keys: [] },
      ],
      warnings: ['The SSH server lets in only these accounts (AllowUsers): ubuntu'],
    });
  });

  it('ignores a key line of an unknown account and a bad keygen line', () => {
    expect(parseAccessState('KEY\tnobody\t256 SHA256:a x (ED25519)').users).toEqual([]);
    expect(parseKeygenLine('not a keygen line')).toBeNull();
  });

  it('keeps a comment with spaces', () => {
    expect(parseKeygenLine('256 SHA256:a my work laptop (ED25519)')?.comment).toBe(
      'my work laptop',
    );
  });
});
