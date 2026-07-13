import { useEffect, useState } from 'react';
import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ApplyResult, InfrastructurePlan, PreviewResult } from '@cloudforge/core';
import { invoke, subscribe } from '../../lib/ipc.js';

/** Load the persisted infrastructure plan for a project (null if none). */
export function usePlan(projectId: string | null): UseQueryResult<InfrastructurePlan | null> {
  return useQuery({
    queryKey: ['infra', 'plan', projectId],
    queryFn: () => invoke('infra:getPlan', { projectId: projectId ?? '' }),
    enabled: projectId !== null,
  });
}

/** Persist a plan for a project. */
export function useSavePlan(): ReturnType<
  typeof useMutation<void, Error, { projectId: string; plan: InfrastructurePlan }>
> {
  return useMutation({
    mutationFn: ({ projectId, plan }: { projectId: string; plan: InfrastructurePlan }) =>
      invoke('infra:savePlan', { projectId, plan }),
  });
}

/** Run a Pulumi preview for a project. */
export function usePreview(): ReturnType<
  typeof useMutation<PreviewResult, Error, { projectId: string; streamId: string }>
> {
  return useMutation({
    mutationFn: ({ projectId, streamId }: { projectId: string; streamId: string }) =>
      invoke('infra:preview', { projectId, streamId }),
  });
}

/** Apply (provision) a project's infrastructure. */
export function useApply(): ReturnType<
  typeof useMutation<ApplyResult, Error, { projectId: string; streamId: string }>
> {
  return useMutation({
    mutationFn: ({ projectId, streamId }: { projectId: string; streamId: string }) =>
      invoke('infra:apply', { projectId, streamId }),
  });
}

/** Destroy a project's infrastructure. */
export function useDestroy(): ReturnType<
  typeof useMutation<void, Error, { projectId: string; streamId: string }>
> {
  return useMutation({
    mutationFn: ({ projectId, streamId }: { projectId: string; streamId: string }) =>
      invoke('infra:destroy', { projectId, streamId }),
  });
}

/** Subscribe to streamed engine output for a given stream id. */
export function useEngineLogs(streamId: string): {
  lines: string[];
  clear: () => void;
} {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const unsubscribe = subscribe('engine:log', (payload) => {
      if (payload.streamId !== streamId) return;
      setLines((prev) => [...prev, payload.event.message]);
    });
    return unsubscribe;
  }, [streamId]);

  return { lines, clear: () => setLines([]) };
}
