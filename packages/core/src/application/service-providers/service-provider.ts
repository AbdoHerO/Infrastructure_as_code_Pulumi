import type { Result, ServiceProviderError } from '@cloudforge/shared';

export type ServiceProviderKind =
  'cloudflare' | 'github' | 'gitlab' | 'dockerhub' | 'openai' | 'anthropic';

export interface ServiceConnection {
  readonly connected: boolean;
  readonly provider: ServiceProviderKind;
  readonly message: string;
  readonly account?: { readonly id: string; readonly name: string };
  readonly zones?: readonly {
    readonly id: string;
    readonly name: string;
    readonly plan: string;
    readonly status: string;
  }[];
}

export interface ServiceProvider {
  readonly kind: ServiceProviderKind;
  testConnection(): Promise<Result<ServiceConnection, ServiceProviderError>>;
}
