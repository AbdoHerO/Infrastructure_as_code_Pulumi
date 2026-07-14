import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import type { SshKeyAlgorithm, SshKeySummary } from '@cloudforge/core';
import { invoke } from '../../lib/ipc.js';

const SSH_KEYS = ['sshKeys'] as const;

export function useSshKeys(): ReturnType<typeof useQuery<SshKeySummary[]>> {
  return useQuery({ queryKey: SSH_KEYS, queryFn: () => invoke('sshKeys:list', undefined) });
}

export function useGenerateSshKey(): UseMutationResult<
  SshKeySummary,
  Error,
  { name: string; algorithm: SshKeyAlgorithm; passphrase?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request) => invoke('sshKeys:generate', request),
    onSuccess: () => client.invalidateQueries({ queryKey: SSH_KEYS }),
  });
}

export function useImportSshKey(): UseMutationResult<
  SshKeySummary,
  Error,
  { name: string; privateKey: string; passphrase?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request) => invoke('sshKeys:import', request),
    onSuccess: () => client.invalidateQueries({ queryKey: SSH_KEYS }),
  });
}

export function useDeleteSshKey(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id) => invoke('sshKeys:delete', { id }),
    onSuccess: () => client.invalidateQueries({ queryKey: SSH_KEYS }),
  });
}

export function revealSshPrivateKey(id: string): Promise<string> {
  return invoke('sshKeys:revealPrivate', { id }).then((result) => result.privateKey);
}
