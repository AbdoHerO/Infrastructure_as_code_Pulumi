import { request as httpsRequest } from 'node:https';
import { err, ok, ProviderError, type Result } from '@cloudforge/shared';
import { signRequest, type SignableRequest } from './oci-signer.js';

const REQUEST_TIMEOUT_MS = 20_000;

/** Perform a signed OCI REST request and parse the JSON response. */
export function ociRequest<T>(options: SignableRequest): Promise<Result<T, ProviderError>> {
  let headers;
  try {
    headers = signRequest(options);
  } catch (cause) {
    return Promise.resolve(
      err(new ProviderError('Failed to sign OCI request (check the private key)', { cause })),
    );
  }

  const url = new URL(options.url);
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        method: options.method,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, accept: 'application/json', 'user-agent': 'CloudForge' },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(ok(text ? (JSON.parse(text) as T) : (undefined as T)));
            } catch (cause) {
              resolve(err(new ProviderError('Received malformed JSON from OCI', { cause })));
            }
          } else {
            resolve(
              err(
                new ProviderError(`OCI request failed with status ${status}`, {
                  context: { status, body: text.slice(0, 400) },
                }),
              ),
            );
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(err(new ProviderError('OCI request timed out')));
    });
    req.on('error', (cause) => resolve(err(new ProviderError('OCI request failed', { cause }))));

    if (options.body) req.write(options.body);
    req.end();
  });
}
