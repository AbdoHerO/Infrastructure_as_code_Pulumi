import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { err, ok, type Result, ValidationError } from '@cloudforge/shared';
import type { SshKeyAlgorithm, SshKeyGenerator, SshKeyMaterial } from '@cloudforge/core';

export class NodeSshKeyGenerator implements SshKeyGenerator {
  generate(
    algorithm: SshKeyAlgorithm,
    passphrase?: string,
  ): Result<SshKeyMaterial, ValidationError> {
    try {
      const pair =
        algorithm === 'ed25519'
          ? generateKeyPairSync('ed25519')
          : generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
      return ok(toMaterial(pair.privateKey, pair.publicKey, algorithm, passphrase));
    } catch (cause) {
      return err(new ValidationError('Failed to generate SSH key pair', { cause }));
    }
  }

  inspect(privateKey: string, passphrase?: string): Result<SshKeyMaterial, ValidationError> {
    try {
      if (!privateKey.trim()) return err(new ValidationError('SSH private key is required'));
      const privateObject = createPrivateKey({ key: privateKey, format: 'pem', passphrase });
      const publicObject = createPublicKey(privateObject);
      const jwk = publicObject.export({ format: 'jwk' });
      const algorithm = algorithmFromJwk(jwk);
      const publicKey = openSshPublicKey(jwk, algorithm);
      return ok({
        algorithm,
        privateKey: privateKey.trim(),
        publicKey,
        fingerprint: fingerprint(publicKey),
      });
    } catch (cause) {
      return err(
        new ValidationError('Private key or passphrase is invalid or unsupported', { cause }),
      );
    }
  }
}

function toMaterial(
  privateKey: KeyObject,
  publicKey: KeyObject,
  algorithm: SshKeyAlgorithm,
  passphrase?: string,
): SshKeyMaterial {
  const privatePem = privateKey.export(
    passphrase
      ? { format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase }
      : { format: 'pem', type: 'pkcs8' },
  );
  const publicValue = openSshPublicKey(publicKey.export({ format: 'jwk' }), algorithm);
  return {
    algorithm,
    privateKey: privatePem.toString(),
    publicKey: publicValue,
    fingerprint: fingerprint(publicValue),
  };
}

function algorithmFromJwk(jwk: JsonWebKey): SshKeyAlgorithm {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'ed25519';
  if (jwk.kty === 'RSA') return 'rsa';
  throw new Error(`Unsupported SSH key type: ${jwk.kty ?? 'unknown'}`);
}

function openSshPublicKey(jwk: JsonWebKey, algorithm: SshKeyAlgorithm): string {
  if (algorithm === 'ed25519') {
    if (!jwk.x) throw new Error('Ed25519 public key is incomplete');
    const type = Buffer.from('ssh-ed25519');
    const raw = Buffer.from(jwk.x, 'base64url');
    const blob = Buffer.concat([sshField(type), sshField(raw)]);
    return `ssh-ed25519 ${blob.toString('base64')} cloudforge`;
  }

  if (!jwk.e || !jwk.n) throw new Error('RSA public key is incomplete');
  const type = Buffer.from('ssh-rsa');
  const exponent = mpint(Buffer.from(jwk.e, 'base64url'));
  const modulus = mpint(Buffer.from(jwk.n, 'base64url'));
  const blob = Buffer.concat([sshField(type), sshField(exponent), sshField(modulus)]);
  return `ssh-rsa ${blob.toString('base64')} cloudforge`;
}

function sshField(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function mpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  return trimmed[0] !== undefined && (trimmed[0] & 0x80) !== 0
    ? Buffer.concat([Buffer.from([0]), trimmed])
    : trimmed;
}

function fingerprint(publicKey: string): string {
  const encoded = publicKey.split(/\s+/)[1];
  if (!encoded) throw new Error('OpenSSH public key is malformed');
  const digest = createHash('sha256')
    .update(Buffer.from(encoded, 'base64'))
    .digest('base64')
    .replace(/=+$/, '');
  return `SHA256:${digest}`;
}
