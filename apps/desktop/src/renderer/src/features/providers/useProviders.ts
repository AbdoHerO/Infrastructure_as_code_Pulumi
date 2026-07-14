import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import {
  type AvailabilityDomain,
  type ConnectionTestResult,
  type CloudInstance,
  type CloudResource,
  type CredentialSummaryDto,
  isProviderKind,
  type Region,
  type Shape,
  type InstanceAction,
  type MachineImage,
} from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';
import { useCredentials } from '../secrets/useCredentials.js';

/** Credentials that correspond to a cloud provider (excludes GitHub, OpenAI, …). */
export function useProviderCredentials(): {
  data: CredentialSummaryDto[] | undefined;
  isLoading: boolean;
} {
  const { data, isLoading } = useCredentials();
  return { data: data?.filter((c) => isProviderKind(c.kind)), isLoading };
}

/** Test a provider connection for a given credential. */
export function useTestConnection(): UseMutationResult<ConnectionTestResult, Error, string> {
  return useMutation({
    mutationFn: (credentialId: string) => invoke('providers:test', { credentialId }),
  });
}

/** Load the regions available to a provider credential. */
export function useLoadRegions(): UseMutationResult<Region[], Error, string> {
  return useMutation({
    mutationFn: (credentialId: string) => invoke('providers:listRegions', { credentialId }),
  });
}

/** Load the compute shapes available to a provider credential. */
export function useLoadShapes(): UseMutationResult<Shape[], Error, string> {
  return useMutation({
    mutationFn: (credentialId: string) => invoke('providers:listShapes', { credentialId }),
  });
}

/** Load provider-curated machine images for launching compute instances. */
export function useLoadImages(): UseMutationResult<MachineImage[], Error, string> {
  return useMutation({
    mutationFn: (credentialId: string) => invoke('providers:listImages', { credentialId }),
  });
}

/** Load the availability domains for a provider credential. */
export function useLoadAvailabilityDomains(): UseMutationResult<
  AvailabilityDomain[],
  Error,
  string
> {
  return useMutation({
    mutationFn: (credentialId: string) =>
      invoke('providers:listAvailabilityDomains', { credentialId }),
  });
}

/** Discover instances created inside or outside CloudForge. */
export function useLoadInstances(): UseMutationResult<CloudInstance[], Error, string> {
  return useMutation({
    mutationFn: (credentialId: string) => invoke('providers:listInstances', { credentialId }),
  });
}

export function useLoadResources(): UseMutationResult<CloudResource[], Error, string> {
  return useMutation({
    mutationFn: (credentialId: string) => invoke('providers:listResources', { credentialId }),
  });
}

export function useInstanceAction(): UseMutationResult<
  CloudInstance,
  Error,
  { credentialId: string; instanceId: string; action: InstanceAction }
> {
  return useMutation({ mutationFn: (request) => invoke('providers:instanceAction', request) });
}

/** Permanently terminate a provider instance and its boot volume. */
export function useTerminateInstance(): UseMutationResult<
  void,
  Error,
  { credentialId: string; instanceId: string }
> {
  return useMutation({
    mutationFn: (request) => invoke('providers:terminateInstance', request),
  });
}
