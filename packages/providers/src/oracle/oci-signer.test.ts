import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSigningString, signRequest } from './oci-signer.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const keyId = 'ocid1.tenancy../ocid1.user../aa:bb:cc';
const date = new Date('2026-07-13T10:00:00.000Z');

describe('OCI signer', () => {
  it('builds the canonical signing string for a GET', () => {
    const { signingString, headers, host } = buildSigningString(
      {
        method: 'GET',
        url: 'https://identity.eu-frankfurt-1.oci.oraclecloud.com/20160918/users/u1',
        keyId,
        privateKeyPem: privateKey,
      },
      date.toUTCString(),
    );
    expect(host).toBe('identity.eu-frankfurt-1.oci.oraclecloud.com');
    expect(headers).toEqual(['(request-target)', 'host', 'date']);
    expect(signingString).toContain('(request-target): get /20160918/users/u1');
    expect(signingString).toContain('host: identity.eu-frankfurt-1.oci.oraclecloud.com');
  });

  it('produces a signature that verifies against the public key', () => {
    const request = {
      method: 'GET' as const,
      url: 'https://identity.eu-frankfurt-1.oci.oraclecloud.com/20160918/users/u1',
      keyId,
      privateKeyPem: privateKey,
      date,
    };
    const signed = signRequest(request);
    expect(signed.authorization).toContain(`keyId="${keyId}"`);
    expect(signed.authorization).toContain('algorithm="rsa-sha256"');
    expect(signed.date).toBe(date.toUTCString());

    const match = /signature="([^"]+)"/.exec(signed.authorization);
    expect(match).not.toBeNull();
    const signature = Buffer.from(match![1] ?? '', 'base64');
    const { signingString } = buildSigningString(request, date.toUTCString());
    expect(verify('RSA-SHA256', Buffer.from(signingString), publicKey, signature)).toBe(true);
  });

  it('includes body headers for mutating methods', () => {
    const { headers, extra } = buildSigningString(
      {
        method: 'POST',
        url: 'https://iaas.eu-frankfurt-1.oraclecloud.com/20160918/instances',
        keyId,
        privateKeyPem: privateKey,
        body: '{"a":1}',
      },
      date.toUTCString(),
    );
    expect(headers).toContain('x-content-sha256');
    expect(extra['content-length']).toBe('7');
  });
});
