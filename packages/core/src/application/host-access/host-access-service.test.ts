import { describe, expect, it, vi } from 'vitest';
import { DeploymentError, err, ok } from '@cloudforge/shared';
import type { ActivityService } from '../activity/activity-service.js';
import type { DeploymentTarget } from '../ports/deployer.js';
import type { HostAccessState } from '../ports/host-access.js';
import {
  HostAccessService,
  hostAccessInstructions,
  parseSshPublicKey,
  validateAccessUsername,
} from './host-access-service.js';

// Throwaway keys generated for these tests (their private halves were deleted).
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPPiUQHxA6k+sUd6fS8bhCCfdYr3aVWfJkxbm9M/ntbR alex@laptop';
const RSA_3072 =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDHr1/544P5IfhrzStBoClNA7MeOlfV/5Z+UIoAZjcpCK8If/2Y6eD2JPRNLm5GU+5eQ7VE23EdsmgZZNeteDUVBv4vHcUTmOA/qYNXs8yxC61L+LB/qkey52+qXkSEyjUaIa1oprDKAxPdsQoifaAFnrgys94pAkr/R18Hxqj8IerNET2T+dEjwUQSiXPDEMwLQvvZL+Ga+aySv4/4ZkQaCfRol6qdlmOfRMHc8P0sd7pywbLK6KQcYCcGB1qMCTtC3Ge1i744kK9YJXL5ro8UJEFUy6vP+ForcwQ9WEyRU+HTYZ9hDLbyH68vd6EbTZuRShuHIlRHUmqqVML+8v4q1Mr6swmUCpqS9+J0ouJ+QhgLe2LMVAnHRoxxoyFX4PF7LYVKSWnUCQfwAbzA7L4DE9ygr46HS79fuYyRqQnFlsvo06CTBspsWnpR4DMxqPKbVlWYDJ6cpGLJELPooGDudI3WLyJo/yQRORedlGrdvWBv93MsS3WT3RDnYuI8wf0= rsa3072';
const RSA_1024 =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQClcGJuGu0k+m/R7DVF1SQ81+jJ+fa9FC7Q5ONfNq2odLtmNI4DQATb10j9Cavvn1UO6mYliX6js7kZj7fkBxR1PKGq6Vl1AcqkQOvzEEAJlquprBun64lea0Zz18WStIZn5Jv08jXb3gs4U/F0V6AH4oVjwTw9pvoBlqbM+LiedQ== weak';

const target: DeploymentTarget = {
  host: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  privateKey: 'key',
  hostKeySha256: 'SHA256:test',
};

const state: HostAccessState = {
  users: [
    {
      username: 'alex',
      sudo: true,
      keys: [{ fingerprint: 'SHA256:abc', type: 'ED25519', bits: 256, comment: 'alex@laptop' }],
    },
  ],
  warnings: [],
};

function setup() {
  const inspect = vi.fn().mockResolvedValue(ok(state));
  const grant = vi.fn().mockResolvedValue(ok(state));
  const revoke = vi.fn().mockResolvedValue(ok({ users: [], warnings: [] }));
  const recordSafe = vi.fn();
  const resolve = vi.fn().mockResolvedValue(ok(target));
  const service = new HostAccessService({ resolve }, { inspect, grant, revoke }, {
    recordSafe,
  } as unknown as ActivityService);
  return { service, inspect, grant, revoke, recordSafe, resolve };
}

describe('HostAccessService', () => {
  it('gives a person their own account with their normalized key, and records it without the key', async () => {
    const { service, grant, recordSafe, resolve } = setup();
    const result = await service.grant('target-1', {
      username: ' alex ',
      publicKey: `  ${ED25519}  `,
      sudo: true,
    });

    expect(result.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith('target-1');
    expect(grant).toHaveBeenCalledWith(target, {
      username: 'alex',
      publicKey: ED25519,
      sudo: true,
    });
    const entry = recordSafe.mock.calls[0]?.[0] as { type: string; metadata: object };
    expect(entry.type).toBe('host.access.granted');
    expect(entry.metadata).toEqual({
      targetId: 'target-1',
      username: 'alex',
      sudo: true,
      keyType: 'ssh-ed25519',
    });
    expect(JSON.stringify(entry)).not.toContain(ED25519.split(' ')[1]);
  });

  it('refuses a bad name or key before connecting to anything', async () => {
    const { service, grant, resolve } = setup();
    for (const request of [
      { username: 'Alex', publicKey: ED25519, sudo: false },
      { username: 'root', publicKey: ED25519, sudo: false },
      { username: 'alex', publicKey: 'not a key', sudo: false },
    ]) {
      expect((await service.grant('target-1', request)).ok).toBe(false);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  it('never hands out or deletes the account CloudForge connects with', async () => {
    const { service, grant, revoke } = setup();
    const given = await service.grant('target-1', {
      username: 'ubuntu',
      publicKey: ED25519,
      sudo: true,
    });
    const removed = await service.revoke('target-1', 'ubuntu');

    expect(given.ok).toBe(false);
    expect(removed.ok).toBe(false);
    if (!given.ok) expect(given.error.message).toContain('account CloudForge connects with');
    expect(grant).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('removes an account and records it', async () => {
    const { service, revoke, recordSafe } = setup();
    const result = await service.revoke('target-1', 'alex');

    expect(result.ok).toBe(true);
    expect(revoke).toHaveBeenCalledWith(target, 'alex');
    expect(recordSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'host.access.revoked',
        metadata: { targetId: 'target-1', username: 'alex' },
      }),
    );
  });

  it('records nothing when the server refuses', async () => {
    const { service, grant, recordSafe } = setup();
    grant.mockResolvedValueOnce(
      err(new DeploymentError('alex exists and was not created by CloudForge')),
    );
    const result = await service.grant('target-1', {
      username: 'alex',
      publicKey: ED25519,
      sudo: false,
    });

    expect(result.ok).toBe(false);
    expect(recordSafe).not.toHaveBeenCalled();
  });

  it('requires a target', async () => {
    const { service } = setup();
    expect((await service.inspect('  ')).ok).toBe(false);
  });
});

describe('validateAccessUsername', () => {
  it.each(['alex', 'client-1', 'a_smith', 'ab'])('accepts %s', (name) => {
    expect(validateAccessUsername(name)).toEqual(ok(name));
  });

  it.each([
    '',
    'a',
    'Alex',
    '1abc',
    'ab cd',
    'a;rm -rf /',
    'x'.repeat(33),
    'root',
    'www-data',
    'systemd-network',
  ])('refuses %j', (name) => {
    expect(validateAccessUsername(name).ok).toBe(false);
  });
});

describe('parseSshPublicKey', () => {
  it('accepts an ed25519 key and keeps its comment', () => {
    expect(parseSshPublicKey(ED25519)).toEqual(
      ok({ type: 'ssh-ed25519', comment: 'alex@laptop', line: ED25519 }),
    );
  });

  it('accepts a 3072-bit RSA key and refuses a 1024-bit one', () => {
    expect(parseSshPublicKey(RSA_3072).ok).toBe(true);
    const weak = parseSshPublicKey(RSA_1024);
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.error.message).toContain('1024 bits');
  });

  it('accepts a key without a comment', () => {
    const bare = ED25519.split(' ').slice(0, 2).join(' ');
    expect(parseSshPublicKey(bare)).toEqual(ok({ type: 'ssh-ed25519', comment: '', line: bare }));
  });

  it('warns loudly about a private key', () => {
    const result = parseSshPublicKey(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('PRIVATE key');
  });

  it.each([
    ['two keys', `${ED25519}\n${RSA_3072}`],
    ['options before the key', `command="/bin/sh" ${ED25519}`],
    ['a truncated key', ED25519.slice(0, 40)],
    ['a key whose type does not match its content', ED25519.replace('ssh-ed25519', 'ssh-rsa')],
    ['not base64', 'ssh-ed25519 !!!notbase64!!! x'],
  ])('refuses %s', (_name, value) => {
    expect(parseSshPublicKey(value).ok).toBe(false);
  });

  it('keeps only printable characters of the comment', () => {
    const parsed = parseSshPublicKey(`${ED25519.split(' ').slice(0, 2).join(' ')} al\u0007ex`);
    expect(parsed.ok && parsed.value.comment).toBe('alex');
  });
});

describe('hostAccessInstructions', () => {
  it('gives the command, the fingerprint and a message', () => {
    const out = hostAccessInstructions(
      { host: '203.0.113.10', port: 22, hostKeySha256: 'SHA256:Kq7' },
      'alex',
      { sudo: true, language: 'en' },
    );
    expect(out.command).toBe('ssh alex@203.0.113.10');
    expect(out.fingerprint).toBe('SHA256:Kq7');
    expect(out.message).toContain('ssh alex@203.0.113.10');
    expect(out.message).toContain('SHA256:Kq7');
    expect(out.message).toContain('sudo');
  });

  it('names a port other than 22, adds the SHA256 prefix, and writes French', () => {
    const out = hostAccessInstructions(
      { host: 'example.org', port: 2222, hostKeySha256: 'abc' },
      'client',
      { sudo: false, language: 'fr' },
    );
    expect(out.command).toBe('ssh -p 2222 client@example.org');
    expect(out.fingerprint).toBe('SHA256:abc');
    expect(out.message).toContain('Votre accès SSH');
    expect(out.message).not.toContain('sudo');
  });
});
