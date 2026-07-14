import { request as httpsRequest } from 'node:https';
import { err, ok, ProviderError, type Result } from '@cloudforge/shared';
import { signRequest, type SignableRequest } from './oci-signer.js';

const REQUEST_TIMEOUT_MS = 20_000;

/** Perform a signed OCI REST request and parse the JSON response. */
export function ociRequest<T>(options: SignableRequest): Promise<Result<T, ProviderError>> {
  return ociRequestPage<T>(options).then((result) => (result.ok ? ok(result.value.data) : result));
}

export interface OciResponsePage<T> {
  readonly data: T;
  readonly nextPage?: string;
}

/** Perform a signed request and retain OCI pagination metadata. */
export function ociRequestPage<T>(
  options: SignableRequest,
): Promise<Result<OciResponsePage<T>, ProviderError>> {
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
    let settled = false;
    const finish = (result: Result<OciResponsePage<T>, ProviderError>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
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
              const data = text ? (JSON.parse(text) as T) : (undefined as T);
              const rawNext = res.headers['opc-next-page'];
              const nextPage = Array.isArray(rawNext) ? rawNext[0] : rawNext;
              finish(ok({ data, ...(nextPage ? { nextPage } : {}) }));
            } catch (cause) {
              finish(err(new ProviderError('Received malformed JSON from OCI', { cause })));
            }
          } else {
            finish(
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
      finish(err(new ProviderError('OCI request timed out')));
    });
    req.on('error', (cause) => finish(err(new ProviderError('OCI request failed', { cause }))));

    if (options.body) req.write(options.body);
    req.end();
  });
}
