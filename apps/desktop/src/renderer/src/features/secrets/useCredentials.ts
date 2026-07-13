import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { CreateCredentialInput, CredentialSummaryDto } from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

const CREDENTIALS_KEY = ['credentials'] as const;

/** List stored credentials (metadata only — never secrets). */
export function useCredentials(): UseQueryResult<CredentialSummaryDto[]> {
  return useQuery({
    queryKey: CREDENTIALS_KEY,
    queryFn: () => invoke('credentials:list', undefined),
  });
}

/** Whether secret storage is backed by the OS keychain. */
export function useSecurityStatus(): UseQueryResult<{ backedByOsKeychain: boolean }> {
  return useQuery({
    queryKey: ['security', 'status'],
    queryFn: () => invoke('security:status', undefined),
    staleTime: Infinity,
  });
}

/** Create (and encrypt) a credential. */
export function useCreateCredential(): UseMutationResult<
  CredentialSummaryDto,
  Error,
  CreateCredentialInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCredentialInput) => invoke('credentials:create', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  });
}

/** Delete a credential. */
export function useDeleteCredential(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke('credentials:delete', { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
  });
}

/** Reveal (decrypt) a credential's secret data on demand. */
export function revealCredential(id: string): Promise<Record<string, string>> {
  return invoke('credentials:reveal', { id }).then((r) => ({ ...r.data }));
}
