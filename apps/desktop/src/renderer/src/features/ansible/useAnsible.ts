import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AnsibleOutcome,
  AnsibleProfile,
  AnsibleStatus,
  NginxSite,
  VpsPreflightReport,
  VpsTargetDto,
} from '@cloudforge/core';
import type { SaveVpsTargetRequest, SshTargetRequest } from '@shared/ipc/contract.js';
import { invoke, subscribe } from '../../lib/ipc.js';

type RunRequest = SshTargetRequest & {
  profileId: AnsibleProfile['id'];
  variables: Record<string, unknown>;
};
type UpsertRequest = SshTargetRequest & { site: NginxSite };
type RemoveRequest = SshTargetRequest & { domain: string };
type PreflightRequest = SshTargetRequest & {
  targetId?: string;
  profileId?: AnsibleProfile['id'];
  variables?: Record<string, unknown>;
};

interface AnsibleActions {
  inspect: UseMutationResult<{ fingerprint: string }, Error, { host: string; port: number }>;
  status: UseMutationResult<AnsibleStatus, Error, SshTargetRequest>;
  bootstrap: UseMutationResult<AnsibleStatus, Error, SshTargetRequest>;
  preflight: UseMutationResult<VpsPreflightReport, Error, PreflightRequest>;
  repair: UseMutationResult<VpsPreflightReport, Error, SshTargetRequest & { targetId?: string }>;
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

export function useVpsTargets(): UseQueryResult<VpsTargetDto[]> {
  const client = useQueryClient();
  useEffect(
    () =>
      subscribe('vpsTargets:changed', () => {
        void client.invalidateQueries({ queryKey: ['ansible', 'targets'] });
      }),
    [client],
  );
  return useQuery<VpsTargetDto[]>({
    queryKey: ['ansible', 'targets'],
    queryFn: () => invoke('ansible:targets', undefined),
  });
}

export function useVpsTargetActions(): {
  create: UseMutationResult<VpsTargetDto, Error, SaveVpsTargetRequest>;
  update: UseMutationResult<VpsTargetDto, Error, SaveVpsTargetRequest & { id: string }>;
  remove: UseMutationResult<void, Error, string>;
} {
  const client = useQueryClient();
  const refresh = async (): Promise<void> =>
    client.invalidateQueries({ queryKey: ['ansible', 'targets'] });
  const create = useMutation({
    mutationFn: (target: SaveVpsTargetRequest) => invoke('ansible:createTarget', target),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: (target: SaveVpsTargetRequest & { id: string }) =>
      invoke('ansible:updateTarget', target),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => invoke('ansible:deleteTarget', { id }),
    onSuccess: refresh,
  });
  return { create, update, remove };
}

export function useAnsibleActions(streamId: string): AnsibleActions {
  const client = useQueryClient();
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
  const preflight = useMutation({
    mutationFn: (target: PreflightRequest) => invoke('ansible:preflight', target),
    onSuccess: async () => client.invalidateQueries({ queryKey: ['ansible', 'targets'] }),
  });
  const repair = useMutation({
    mutationFn: (target: SshTargetRequest & { targetId?: string }) =>
      invoke('ansible:repair', { ...target, streamId }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ['ansible', 'targets'] }),
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
  return { inspect, status, bootstrap, preflight, repair, run, sites, upsert, remove, cancel };
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
