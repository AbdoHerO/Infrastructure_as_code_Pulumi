import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { ContainerAction, ContainerStats, RemoteContainer } from '@cloudforge/core';
import type { ContainerTargetRequest } from '@shared/ipc/contract.js';
import { invoke } from '../../lib/ipc.js';

export function useListContainers(): UseMutationResult<
  RemoteContainer[],
  Error,
  ContainerTargetRequest
> {
  return useMutation({ mutationFn: (target) => invoke('containers:list', target) });
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
