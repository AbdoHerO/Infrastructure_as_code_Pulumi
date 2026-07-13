import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CredentialSummaryDto,
  DeploymentDto,
  DeploymentTemplateSummary,
} from '@cloudforge/core';
import { invoke, subscribe } from '../../lib/ipc.js';
import { useCredentials } from '../secrets/useCredentials.js';

/** The built-in deployment templates. */
export function useDeploymentTemplates(): UseQueryResult<DeploymentTemplateSummary[]> {
  return useQuery({
    queryKey: ['deploy', 'templates'],
    queryFn: () => invoke('deploy:templates', undefined),
    staleTime: Infinity,
  });
}

/** Deployment history for a project. */
export function useDeployments(projectId: string | null): UseQueryResult<DeploymentDto[]> {
  return useQuery({
    queryKey: ['deploy', 'list', projectId],
    queryFn: () => invoke('deploy:list', { projectId: projectId ?? '' }),
    enabled: projectId !== null,
  });
}

/** SSH credentials available as deployment keys. */
export function useSshCredentials(): CredentialSummaryDto[] {
  const { data } = useCredentials();
  return (data ?? []).filter((c) => c.kind === 'ssh');
}

export interface RunDeploymentArgs {
  projectId: string;
  templateId: string;
  host: string;
  port: number;
  username: string;
  sshCredentialId: string;
  streamId: string;
  appImage?: string;
}

/** Launch a deployment. */
export function useRunDeployment(): UseMutationResult<DeploymentDto, Error, RunDeploymentArgs> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: RunDeploymentArgs) => invoke('deploy:run', args),
    onSuccess: (dto) =>
      queryClient.invalidateQueries({ queryKey: ['deploy', 'list', dto.projectId] }),
  });
}

/** Subscribe to streamed deployment output for a stream id. */
export function useDeployLogs(streamId: string): { lines: string[]; clear: () => void } {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const unsubscribe = subscribe('deploy:log', (payload) => {
      if (payload.streamId !== streamId) return;
      const prefix = payload.event.stream === 'stderr' ? '! ' : '';
      setLines((prev) => [...prev, `${prefix}${payload.event.message.trimEnd()}`]);
    });
    return unsubscribe;
  }, [streamId]);
  return { lines, clear: () => setLines([]) };
}
