import { err, map, ok, ProviderError, type Result } from '@cloudforge/shared';
import type {
  AvailabilityDomain,
  CloudInstance,
  CloudResource,
  CloudProvider,
  ConnectionTestResult,
  AccountInfo,
  ProviderCredentials,
  Region,
  Shape,
  InstanceAction,
} from '@cloudforge/core';
import { ociRequest, ociRequestPage } from './oci-client.js';

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
interface OciNetworkResource {
  id: string;
  displayName: string;
  lifecycleState: string;
  cidrBlock?: string;
}
interface OciVolumeResource {
  id: string;
  displayName: string;
  lifecycleState: string;
  sizeInGBs?: number;
}

const TERMINATION_POLL_MS = 3_000;
const TERMINATION_TIMEOUT_MS = 10 * 60_000;

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

  private post(url: string, body = ''): Promise<Result<void, ProviderError>> {
    return ociRequest<void>({
      method: 'POST',
      url,
      keyId: this.keyId,
      privateKeyPem: this.config.privateKey,
      body,
    });
  }

  private async getAll<T>(url: string): Promise<Result<T[], ProviderError>> {
    const items: T[] = [];
    let page: string | undefined;
    do {
      const current = new URL(url);
      if (page) current.searchParams.set('page', page);
      const response = await ociRequestPage<T[]>({
        method: 'GET',
        url: current.toString(),
        keyId: this.keyId,
        privateKeyPem: this.config.privateKey,
      });
      if (!response.ok) return response;
      items.push(...response.value.data);
      page = response.value.nextPage;
    } while (page);
    return ok(items);
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
    const subscriptions = await this.getAll<OciRegionSubscription>(
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
    const domains = await this.getAll<OciAvailabilityDomain>(
      this.identity(`/20160918/availabilityDomains?${params.toString()}`),
    );
    return map(domains, (list) => list.map((d) => ({ id: d.id, name: d.name })));
  }

  async listShapes(): Promise<Result<Shape[], ProviderError>> {
    const params = new URLSearchParams({ compartmentId: this.config.compartmentOcid });
    const shapes = await this.getAll<OciShape>(this.iaas(`/20160918/shapes?${params.toString()}`));
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
    const instances = await this.getAll<OciInstance>(
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

  async terminateInstance(instanceId: string): Promise<Result<void, ProviderError>> {
    const params = new URLSearchParams({ preserveBootVolume: 'false' });
    const requested = await this.delete(
      this.iaas(`/20160918/instances/${encodeURIComponent(instanceId)}?${params.toString()}`),
    );
    if (!requested.ok) return requested;

    const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const instances = await this.listInstances();
      if (!instances.ok) return instances;
      const instance = instances.value.find((candidate) => candidate.id === instanceId);
      if (!instance || instance.state === 'TERMINATED') return ok(undefined);
      await delay(TERMINATION_POLL_MS);
    }
    return err(
      new ProviderError('OCI accepted termination, but the instance did not terminate in time', {
        context: { instanceId, timeoutMs: TERMINATION_TIMEOUT_MS },
      }),
    );
  }

  async instanceAction(
    instanceId: string,
    action: InstanceAction,
  ): Promise<Result<CloudInstance, ProviderError>> {
    const apiAction = action === 'start' ? 'START' : action === 'stop' ? 'SOFTSTOP' : 'SOFTRESET';
    const requested = await this.post(
      this.iaas(`/20160918/instances/${encodeURIComponent(instanceId)}?action=${apiAction}`),
    );
    if (!requested.ok) return requested;
    const targetState = action === 'stop' ? 'STOPPED' : 'RUNNING';
    const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const instance = await this.get<OciInstance>(
        this.iaas(`/20160918/instances/${encodeURIComponent(instanceId)}`),
      );
      if (!instance.ok) return instance;
      if (instance.value.lifecycleState === targetState)
        return ok(this.mapInstance(instance.value));
      if (instance.value.lifecycleState === 'TERMINATED') {
        return err(new ProviderError('Instance terminated while waiting for lifecycle action'));
      }
      await delay(TERMINATION_POLL_MS);
    }
    return err(new ProviderError(`Instance did not reach ${targetState} before timeout`));
  }

  async listResources(): Promise<Result<CloudResource[], ProviderError>> {
    const query = new URLSearchParams({ compartmentId: this.config.compartmentOcid }).toString();
    const [vcns, subnets, gateways, volumes] = await Promise.all([
      this.getAll<OciNetworkResource>(this.iaas(`/20160918/vcns?${query}`)),
      this.getAll<OciNetworkResource>(this.iaas(`/20160918/subnets?${query}`)),
      this.getAll<OciNetworkResource>(this.iaas(`/20160918/internetGateways?${query}`)),
      this.getAll<OciVolumeResource>(this.iaas(`/20160918/volumes?${query}`)),
    ]);
    if (!vcns.ok) return vcns;
    if (!subnets.ok) return subnets;
    if (!gateways.ok) return gateways;
    if (!volumes.ok) return volumes;
    return ok([
      ...vcns.value.map((item) => this.mapResource(item, 'vcn', item.cidrBlock)),
      ...subnets.value.map((item) => this.mapResource(item, 'subnet', item.cidrBlock)),
      ...gateways.value.map((item) => this.mapResource(item, 'internet-gateway')),
      ...volumes.value.map((item) =>
        this.mapResource(item, 'volume', item.sizeInGBs ? `${item.sizeInGBs} GB` : undefined),
      ),
    ]);
  }

  private mapInstance(instance: OciInstance): CloudInstance {
    return {
      id: instance.id,
      name: instance.displayName,
      state: instance.lifecycleState,
      shape: instance.shape,
      availabilityDomain: instance.availabilityDomain,
      region: this.config.region,
      ...(instance.timeCreated ? { createdAt: instance.timeCreated } : {}),
    };
  }

  private mapResource(
    item: OciNetworkResource | OciVolumeResource,
    type: CloudResource['type'],
    details?: string,
  ): CloudResource {
    return {
      id: item.id,
      name: item.displayName,
      type,
      state: item.lifecycleState,
      region: this.config.region,
      ...(details ? { details } : {}),
    };
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
