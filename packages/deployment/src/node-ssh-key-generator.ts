import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  type JsonWebKey,
} from 'node:crypto';
import { utils as sshUtils } from 'ssh2';
import { err, ok, type Result, ValidationError } from '@cloudforge/shared';
import type { SshKeyAlgorithm, SshKeyGenerator, SshKeyMaterial } from '@cloudforge/core';

export class NodeSshKeyGenerator implements SshKeyGenerator {
  generate(
    algorithm: SshKeyAlgorithm,
    passphrase?: string,
  ): Result<SshKeyMaterial, ValidationError> {
    try {
      const encryption = passphrase
        ? { passphrase, cipher: 'aes256-ctr' as const, rounds: 16 }
        : {};
      const pair = sshUtils.generateKeyPairSync(
        algorithm,
        algorithm === 'rsa'
          ? { bits: 3072, comment: 'cloudforge', ...encryption }
          : { comment: 'cloudforge', ...encryption },
      );
      return this.inspect(pair.private, passphrase);
    } catch (cause) {
      return err(new ValidationError('Failed to generate SSH key pair', { cause }));
    }
  }

  inspect(privateKey: string, passphrase?: string): Result<SshKeyMaterial, ValidationError> {
    try {
      if (!privateKey.trim()) return err(new ValidationError('SSH private key is required'));
      const parsed = sshUtils.parseKey(privateKey.trim(), passphrase);
      let algorithm: SshKeyAlgorithm;
      let publicKey: string;
      if (parsed instanceof Error) {
        const privateObject = createPrivateKey({ key: privateKey, format: 'pem', passphrase });
        const publicObject = createPublicKey(privateObject);
        const jwk = publicObject.export({ format: 'jwk' });
        algorithm = algorithmFromJwk(jwk);
        publicKey = openSshPublicKey(jwk, algorithm);
        if (passphrase) {
          throw new Error(
            'Encrypted PEM/PKCS8 keys cannot be converted safely; import an OpenSSH private key',
          );
        }
        privateKey = openSshPrivateKey(privateObject.export({ format: 'jwk' }), algorithm);
      } else {
        if (!parsed.isPrivateKey()) throw new Error('SSH key does not contain private material');
        algorithm = algorithmFromSshType(parsed.type);
        publicKey = `${parsed.type} ${parsed.getPublicSSH().toString('base64')} ${parsed.comment || 'cloudforge'}`;
      }
      return ok({
        algorithm,
        // Windows OpenSSH rejects otherwise valid private keys when the PEM/
        // OpenSSH footer is not newline-terminated.
        privateKey: `${privateKey.trim()}\n`,
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

function algorithmFromSshType(type: string): SshKeyAlgorithm {
  if (type === 'ssh-ed25519') return 'ed25519';
  if (type === 'ssh-rsa') return 'rsa';
  throw new Error(`Unsupported SSH key type: ${type}`);
}

function algorithmFromJwk(jwk: JsonWebKey): SshKeyAlgorithm {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'ed25519';
  if (jwk.kty === 'RSA') return 'rsa';
  throw new Error(`Unsupported SSH key type: ${jwk.kty ?? 'unknown'}`);
}

/** Convert an unencrypted PKCS8 key into the format accepted by OpenSSH clients. */
function openSshPrivateKey(jwk: JsonWebKey, algorithm: SshKeyAlgorithm): string {
  const type = Buffer.from(algorithm === 'ed25519' ? 'ssh-ed25519' : 'ssh-rsa');
  const publicBlob =
    algorithm === 'ed25519'
      ? Buffer.concat([sshField(type), sshField(requiredJwk(jwk.x, 'x'))])
      : Buffer.concat([
          sshField(type),
          sshField(mpint(requiredJwk(jwk.e, 'e'))),
          sshField(mpint(requiredJwk(jwk.n, 'n'))),
        ]);
  const check = randomBytes(4);
  const privateFields =
    algorithm === 'ed25519'
      ? Buffer.concat([
          sshField(type),
          sshField(requiredJwk(jwk.x, 'x')),
          sshField(Buffer.concat([requiredJwk(jwk.d, 'd'), requiredJwk(jwk.x, 'x')])),
          sshField(Buffer.from('cloudforge')),
        ])
      : Buffer.concat([
          sshField(type),
          sshField(mpint(requiredJwk(jwk.n, 'n'))),
          sshField(mpint(requiredJwk(jwk.e, 'e'))),
          sshField(mpint(requiredJwk(jwk.d, 'd'))),
          sshField(mpint(requiredJwk(jwk.qi, 'qi'))),
          sshField(mpint(requiredJwk(jwk.p, 'p'))),
          sshField(mpint(requiredJwk(jwk.q, 'q'))),
          sshField(Buffer.from('cloudforge')),
        ]);
  const unpadded = Buffer.concat([check, check, privateFields]);
  const paddingLength = (8 - (unpadded.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: paddingLength }, (_, index) => index + 1));
  const encoded = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshField(Buffer.from('none')),
    sshField(Buffer.from('none')),
    sshField(Buffer.alloc(0)),
    uint32(1),
    sshField(publicBlob),
    sshField(Buffer.concat([unpadded, padding])),
  ]).toString('base64');
  const lines = encoded.match(/.{1,64}/g)?.join('\n') ?? encoded;
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function requiredJwk(value: string | undefined, field: string): Buffer {
  if (!value) throw new Error(`Private key is missing JWK field ${field}`);
  return Buffer.from(value, 'base64url');
}

function uint32(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
  return output;
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
