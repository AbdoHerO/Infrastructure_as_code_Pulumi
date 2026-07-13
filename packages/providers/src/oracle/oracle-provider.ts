import { map, ok, ProviderError, type Result } from '@cloudforge/shared';
import type {
  AvailabilityDomain,
  CloudInstance,
  CloudProvider,
  ConnectionTestResult,
  AccountInfo,
  ProviderCredentials,
  Region,
  Shape,
} from '@cloudforge/core';
import { ociRequest } from './oci-client.js';

/** Required Oracle credential fields. */
interface OracleConfig {
  tenancyOcid: string;
  userOcid: string;
  compartmentOcid: string;
  fingerprint: string;
  privateKey: string;
  region: string;
}

interface OciUser {
  id: string;
  name: string;
  email?: string;
}
interface OciRegionSubscription {
  regionName: string;
  regionKey: string;
  isHomeRegion?: boolean;
}
interface OciAvailabilityDomain {
  id: string;
  name: string;
}
interface OciShape {
  shape: string;
  ocpus?: number;
  memoryInGBs?: number;
}
interface OciInstance {
  id: string;
  displayName: string;
  lifecycleState: string;
  shape: string;
  availabilityDomain: string;
  timeCreated?: string;
}

/**
 * Oracle Cloud Infrastructure provider. Talks to the OCI REST APIs directly
 * using the request-signing scheme (no heavyweight SDK), keeping the provider
 * self-contained and its signing logic unit-testable.
 */
export class OracleProvider implements CloudProvider {
  readonly kind = 'oracle' as const;

  private constructor(private readonly config: OracleConfig) {}

  /** Validate and construct from decrypted credential fields. */
  static fromCredentials(credentials: ProviderCredentials): Result<OracleProvider, ProviderError> {
    const required = [
      'tenancyOcid',
      'userOcid',
      'compartmentOcid',
      'fingerprint',
      'privateKey',
      'region',
    ] as const;
    for (const key of required) {
      if (!credentials[key]?.trim()) {
        return {
          ok: false,
          error: new ProviderError(`Missing Oracle credential field: ${key}`),
        };
      }
    }
    return ok(
      new OracleProvider({
        tenancyOcid: credentials.tenancyOcid ?? '',
        userOcid: credentials.userOcid ?? '',
        compartmentOcid: credentials.compartmentOcid ?? '',
        fingerprint: credentials.fingerprint ?? '',
        privateKey: credentials.privateKey ?? '',
        region: credentials.region ?? '',
      }),
    );
  }

  private get keyId(): string {
    return `${this.config.tenancyOcid}/${this.config.userOcid}/${this.config.fingerprint}`;
  }

  private identity(path: string): string {
    return `https://identity.${this.config.region}.oci.oraclecloud.com${path}`;
  }

  private iaas(path: string): string {
    return `https://iaas.${this.config.region}.oraclecloud.com${path}`;
  }

  private get<T>(url: string): Promise<Result<T, ProviderError>> {
    return ociRequest<T>({
      method: 'GET',
      url,
      keyId: this.keyId,
      privateKeyPem: this.config.privateKey,
    });
  }

  private delete(url: string): Promise<Result<void, ProviderError>> {
    return ociRequest<void>({
      method: 'DELETE',
      url,
      keyId: this.keyId,
      privateKeyPem: this.config.privateKey,
    });
  }

  async getAccountInfo(): Promise<Result<AccountInfo, ProviderError>> {
    const user = await this.get<OciUser>(
      this.identity(`/20160918/users/${encodeURIComponent(this.config.userOcid)}`),
    );
    return map(user, (u) => ({
      accountId: this.config.tenancyOcid,
      name: u.name,
      ...(u.email ? { email: u.email } : {}),
      homeRegion: this.config.region,
    }));
  }

  async testConnection(): Promise<Result<ConnectionTestResult, ProviderError>> {
    const account = await this.getAccountInfo();
    if (!account.ok) {
      return ok({ connected: false, message: account.error.message });
    }
    return ok({
      connected: true,
      message: `Connected to Oracle Cloud as ${account.value.name}`,
      account: account.value,
    });
  }

  async listRegions(): Promise<Result<Region[], ProviderError>> {
    const subscriptions = await this.get<OciRegionSubscription[]>(
      this.identity(
        `/20160918/tenancies/${encodeURIComponent(this.config.tenancyOcid)}/regionSubscriptions`,
      ),
    );
    return map(subscriptions, (list) =>
      list.map((r) => ({
        id: r.regionKey,
        name: r.regionName,
        ...(r.isHomeRegion ? { isHome: true } : {}),
      })),
    );
  }

  async listAvailabilityDomains(): Promise<Result<AvailabilityDomain[], ProviderError>> {
    const params = new URLSearchParams({ compartmentId: this.config.compartmentOcid });
    const domains = await this.get<OciAvailabilityDomain[]>(
      this.identity(`/20160918/availabilityDomains?${params.toString()}`),
    );
    return map(domains, (list) => list.map((d) => ({ id: d.id, name: d.name })));
  }

  async listShapes(): Promise<Result<Shape[], ProviderError>> {
    const params = new URLSearchParams({ compartmentId: this.config.compartmentOcid });
    const shapes = await this.get<OciShape[]>(this.iaas(`/20160918/shapes?${params.toString()}`));
    return map(shapes, (list) =>
      dedupeBy(list, (s) => s.shape).map((s) => ({
        id: s.shape,
        name: s.shape,
        ...(s.ocpus !== undefined ? { ocpus: s.ocpus } : {}),
        ...(s.memoryInGBs !== undefined ? { memoryGb: s.memoryInGBs } : {}),
      })),
    );
  }

  async listInstances(): Promise<Result<CloudInstance[], ProviderError>> {
    const params = new URLSearchParams({ compartmentId: this.config.compartmentOcid });
    const instances = await this.get<OciInstance[]>(
      this.iaas(`/20160918/instances?${params.toString()}`),
    );
    return map(instances, (list) =>
      list
        .filter((instance) => instance.lifecycleState !== 'TERMINATED')
        .map((instance) => ({
          id: instance.id,
          name: instance.displayName,
          state: instance.lifecycleState,
          shape: instance.shape,
          availabilityDomain: instance.availabilityDomain,
          region: this.config.region,
          ...(instance.timeCreated ? { createdAt: instance.timeCreated } : {}),
        })),
    );
  }

  terminateInstance(instanceId: string): Promise<Result<void, ProviderError>> {
    const params = new URLSearchParams({ preserveBootVolume: 'false' });
    return this.delete(
      this.iaas(`/20160918/instances/${encodeURIComponent(instanceId)}?${params.toString()}`),
    );
  }
}

function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }
  return result;
}
