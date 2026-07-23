import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ContainerAction, ContainerStats } from '@cloudforge/core';
import type { ContainerTargetRequest, IpcResponse } from '@shared/ipc/contract.js';
import { invoke } from '../../lib/ipc.js';

const runtimeKey = (targetId: string): readonly unknown[] => ['runtime', targetId];

/**
 * The live runtime of a saved VPS target.
 *
 * A query rather than a mutation: it is a read, so it caches, refetches and can
 * be invalidated by anything that changes the target.
 */
export function useRuntime(targetId: string): UseQueryResult<IpcResponse<'runtime:inspect'>> {
  return useQuery({
    queryKey: [...runtimeKey(targetId), 'inspect'],
    queryFn: () => invoke('runtime:inspect', { targetId }),
    enabled: Boolean(targetId),
    refetchInterval: 15_000,
  });
}

/** Refetch a target's runtime after something changed it. */
export function useRefreshRuntime(targetId: string): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: runtimeKey(targetId) });
  };
}

export function useContainerAction(): UseMutationResult<
  void,
  Error,
  ContainerTargetRequest & { containerId: string; action: ContainerAction }
> {
  return useMutation({ mutationFn: (request) => invoke('containers:action', request) });
}

export function useContainerLogs(): UseMutationResult<
  { text: string },
  Error,
  ContainerTargetRequest & { containerId: string; lines?: number }
> {
  return useMutation({ mutationFn: (request) => invoke('containers:logs', request) });
}

export function useContainerStats(): UseMutationResult<
  ContainerStats,
  Error,
  ContainerTargetRequest & { containerId: string }
> {
  return useMutation({ mutationFn: (request) => invoke('containers:stats', request) });
}

export function useDeployCompose(): UseMutationResult<
  void,
  Error,
  ContainerTargetRequest & { projectName: string; composeYaml: string }
> {
  return useMutation({ mutationFn: (request) => invoke('containers:deployCompose', request) });
}
