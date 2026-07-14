import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { AnsibleOutcome, AnsibleProfile, AnsibleStatus, NginxSite } from '@cloudforge/core';
import type { SshTargetRequest } from '@shared/ipc/contract.js';
import { invoke, subscribe } from '../../lib/ipc.js';

type RunRequest = SshTargetRequest & {
  profileId: AnsibleProfile['id'];
  variables: Record<string, unknown>;
};
type UpsertRequest = SshTargetRequest & { site: NginxSite };
type RemoveRequest = SshTargetRequest & { domain: string };

interface AnsibleActions {
  inspect: UseMutationResult<{ fingerprint: string }, Error, { host: string; port: number }>;
  status: UseMutationResult<AnsibleStatus, Error, SshTargetRequest>;
  bootstrap: UseMutationResult<AnsibleStatus, Error, SshTargetRequest>;
  run: UseMutationResult<AnsibleOutcome, Error, RunRequest>;
  sites: UseMutationResult<NginxSite[], Error, SshTargetRequest>;
  upsert: UseMutationResult<AnsibleOutcome, Error, UpsertRequest>;
  remove: UseMutationResult<AnsibleOutcome, Error, RemoveRequest>;
  cancel: UseMutationResult<void, Error, void>;
}

export function useAnsibleProfiles(): UseQueryResult<AnsibleProfile[]> {
  return useQuery<AnsibleProfile[]>({
    queryKey: ['ansible', 'profiles'],
    queryFn: () => invoke('ansible:profiles', undefined),
    staleTime: Infinity,
  });
}

export function useAnsibleActions(streamId: string): AnsibleActions {
  const inspect = useMutation({
    mutationFn: (target: { host: string; port: number }) =>
      invoke('ansible:inspectHostKey', target),
  });
  const status = useMutation({
    mutationFn: (target: SshTargetRequest) => invoke('ansible:status', target),
  });
  const bootstrap = useMutation({
    mutationFn: (target: SshTargetRequest) => invoke('ansible:bootstrap', { ...target, streamId }),
  });
  const run = useMutation({
    mutationFn: (
      request: SshTargetRequest & {
        profileId: AnsibleProfile['id'];
        variables: Record<string, unknown>;
      },
    ) => invoke('ansible:run', { ...request, streamId }),
  });
  const sites = useMutation({
    mutationFn: (target: SshTargetRequest) => invoke('ansible:nginxSites', target),
  });
  const upsert = useMutation({
    mutationFn: (request: SshTargetRequest & { site: NginxSite }) =>
      invoke('ansible:nginxUpsert', { ...request, streamId }),
  });
  const remove = useMutation({
    mutationFn: (request: SshTargetRequest & { domain: string }) =>
      invoke('ansible:nginxRemove', { ...request, streamId }),
  });
  const cancel = useMutation({ mutationFn: () => invoke('ansible:cancel', { streamId }) });
  return { inspect, status, bootstrap, run, sites, upsert, remove, cancel };
}

export function useAnsibleLogs(streamId: string): { lines: string[]; clear: () => void } {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(
    () =>
      subscribe('ansible:log', (payload) => {
        if (payload.streamId !== streamId) return;
        const prefix =
          payload.event.stream === 'stderr' ? '! ' : payload.event.stream === 'step' ? '▶ ' : '';
        setLines((current) => [...current, `${prefix}${payload.event.message.trimEnd()}`]);
      }),
    [streamId],
  );
  return { lines, clear: () => setLines([]) };
}
