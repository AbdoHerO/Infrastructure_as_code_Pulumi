import { createHash, createSign } from 'node:crypto';

/** A request to be signed with the OCI API Signature (version 1) scheme. */
export interface SignableRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Full HTTPS URL, e.g. `https://identity.eu-frankfurt-1.oci.oraclecloud.com/20160918/users/{id}`. */
  readonly url: string;
  /** `keyId` = `{tenancyOcid}/{userOcid}/{fingerprint}`. */
  readonly keyId: string;
  /** PEM-encoded RSA API private key. */
  readonly privateKeyPem: string;
  /** Request body for mutating methods (signed via `x-content-sha256`). */
  readonly body?: string;
  /** Overridable clock, for deterministic testing. */
  readonly date?: Date;
}

/** Intermediate map of extra signed headers (body methods). */
export type SignedHeaders = Record<string, string>;

/** The concrete set of headers attached to a signed outgoing request. */
export interface SignedRequestHeaders {
  authorization: string;
  date: string;
  host: string;
  [header: string]: string;
}

const BODY_METHODS = new Set(['POST', 'PUT']);

/**
 * Build the exact signing string per the OCI HTTP Signature scheme. Exposed for
 * testing; production code calls {@link signRequest}.
 */
export function buildSigningString(
  request: SignableRequest,
  date: string,
): {
  signingString: string;
  headers: string[];
  host: string;
  extra: SignedHeaders;
} {
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const target = `${request.method.toLowerCase()} ${path}`;

  const lines = [`(request-target): ${target}`, `host: ${url.host}`, `date: ${date}`];
  const headers = ['(request-target)', 'host', 'date'];
  const extra: SignedHeaders = {};

  if (BODY_METHODS.has(request.method)) {
    const body = request.body ?? '';
    const sha = createHash('sha256').update(body, 'utf8').digest('base64');
    const length = String(Buffer.byteLength(body, 'utf8'));
    lines.push(
      `x-content-sha256: ${sha}`,
      `content-type: application/json`,
      `content-length: ${length}`,
    );
    headers.push('x-content-sha256', 'content-type', 'content-length');
    extra['x-content-sha256'] = sha;
    extra['content-type'] = 'application/json';
    extra['content-length'] = length;
  }

  return { signingString: lines.join('\n'), headers, host: url.host, extra };
}

/**
 * Produce the signed headers for an OCI API request. The returned map includes
 * `authorization`, `date`, `host` (and body headers for mutating methods).
 */
export function signRequest(request: SignableRequest): SignedRequestHeaders {
  const date = (request.date ?? new Date()).toUTCString();
  const { signingString, headers, host, extra } = buildSigningString(request, date);

  const signer = createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(request.privateKeyPem, 'base64');

  const authorization =
    `Signature version="1",keyId="${request.keyId}",algorithm="rsa-sha256",` +
    `headers="${headers.join(' ')}",signature="${signature}"`;

  return { authorization, date, host, ...extra };
}
