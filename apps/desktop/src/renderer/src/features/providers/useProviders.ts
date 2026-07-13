import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import {
  type AvailabilityDomain,
  type ConnectionTestResult,
  type CredentialSummaryDto,
  isProviderKind,
  type Region,
  type Shape,
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
