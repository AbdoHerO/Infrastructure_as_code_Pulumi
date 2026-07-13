import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  ApplyResult,
  AvailabilityDomain,
  CustomTemplateSummary,
  EngineProgress,
  InfrastructurePlan,
  ManagedStackSummary,
  PreviewResult,
  Shape,
  StackReference,
} from '@cloudforge/core';
import { invoke, subscribe } from '../../lib/ipc.js';

const CUSTOM_TEMPLATES_KEY = ['infra', 'customTemplates'] as const;
const MANAGED_STACKS_KEY = ['infra', 'managedStacks'] as const;

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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, streamId }: { projectId: string; streamId: string }) =>
      invoke('infra:apply', { projectId, streamId }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: MANAGED_STACKS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['infra', 'outputs', variables.projectId] });
    },
  });
}

/** Destroy a project's infrastructure. */
export function useDestroy(): ReturnType<
  typeof useMutation<void, Error, { projectId: string; streamId: string }>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, streamId }: { projectId: string; streamId: string }) =>
      invoke('infra:destroy', { projectId, streamId }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: MANAGED_STACKS_KEY });
      void queryClient.removeQueries({ queryKey: ['infra', 'outputs', variables.projectId] });
    },
  });
}

/** Read the current stack outputs, including instance public/private IPs. */
export function useOutputs(
  projectId: string | null,
  enabled: boolean,
): UseQueryResult<Record<string, unknown>> {
  return useQuery({
    queryKey: ['infra', 'outputs', projectId],
    queryFn: () => invoke('infra:outputs', { projectId: projectId ?? '' }),
    enabled: projectId !== null && enabled,
    retry: false,
  });
}

/** Discover every stack in CloudForge's local backend, including orphaned stacks. */
export function useManagedStacks(): UseQueryResult<ManagedStackSummary[]> {
  return useQuery({
    queryKey: MANAGED_STACKS_KEY,
    queryFn: () => invoke('infra:managedStacks', undefined),
  });
}

/** Safely destroy a stack that was returned by {@link useManagedStacks}. */
export function useDestroyManagedStack(): UseMutationResult<
  void,
  Error,
  { ref: StackReference; streamId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args) => invoke('infra:destroyStack', args),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MANAGED_STACKS_KEY }),
  });
}

/**
 * Live compute shapes available in the linked provider account. Disabled until a
 * credential is known; failures are swallowed so the editor falls back to a
 * built-in list rather than blocking plan editing.
 */
export function useShapes(credentialId: string | null): UseQueryResult<Shape[]> {
  return useQuery({
    queryKey: ['providers', 'shapes', credentialId],
    queryFn: () => invoke('providers:listShapes', { credentialId: credentialId ?? '' }),
    enabled: credentialId !== null && credentialId !== '',
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** Live availability domains in the linked provider account (see {@link useShapes}). */
export function useAvailabilityDomains(
  credentialId: string | null,
): UseQueryResult<AvailabilityDomain[]> {
  return useQuery({
    queryKey: ['providers', 'availabilityDomains', credentialId],
    queryFn: () =>
      invoke('providers:listAvailabilityDomains', { credentialId: credentialId ?? '' }),
    enabled: credentialId !== null && credentialId !== '',
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** List the user's saved (custom) infrastructure templates. */
export function useCustomTemplates(): UseQueryResult<CustomTemplateSummary[]> {
  return useQuery({
    queryKey: CUSTOM_TEMPLATES_KEY,
    queryFn: () => invoke('infra:customTemplates', undefined),
  });
}

/** Save the current plan as a reusable custom template. */
export function useSaveTemplate(): UseMutationResult<
  CustomTemplateSummary,
  Error,
  { name: string; description?: string; plan: InfrastructurePlan }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => invoke('infra:saveTemplate', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CUSTOM_TEMPLATES_KEY }),
  });
}

/** Delete a custom template. */
export function useDeleteTemplate(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => invoke('infra:deleteTemplate', { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CUSTOM_TEMPLATES_KEY }),
  });
}

/** Apply a custom template's stored plan to a project. */
export function useApplyCustomTemplate(): UseMutationResult<
  InfrastructurePlan,
  Error,
  { projectId: string; templateId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args) => invoke('infra:applyCustomTemplate', args),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({ queryKey: ['infra', 'plan', variables.projectId] }),
  });
}

/** Subscribe to streamed engine output for a given stream id. */
export function useEngineLogs(streamId: string): {
  lines: string[];
  progress: InfrastructureProgressState | null;
  resources: InfrastructureResourceProgress[];
  clear: () => void;
} {
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState<InfrastructureProgressState | null>(null);
  const [resources, setResources] = useState<Record<string, InfrastructureResourceProgress>>({});

  useEffect(() => {
    const unsubscribe = subscribe('engine:log', (payload) => {
      if (payload.streamId !== streamId) return;
      const eventProgress = payload.event.progress;
      if (!eventProgress) {
        setLines((prev) => [...prev, payload.event.message]);
        return;
      }

      if (eventProgress.scope === 'operation') {
        setProgress({ status: eventProgress.status, label: eventProgress.label });
        return;
      }

      const resource = eventProgress.resource;
      if (!resource) return;
      const key = `${resource.type}:${resource.name}`;
      setResources((previous) => ({
        ...previous,
        [key]: {
          ...resource,
          status: eventProgress.status,
          label: eventProgress.label,
          operation: eventProgress.operation ?? 'process',
        },
      }));
      setProgress((previous) => ({
        status:
          eventProgress.status === 'failed'
            ? 'failed'
            : previous?.status === 'ready'
              ? 'ready'
              : 'in-progress',
        label: eventProgress.label,
      }));
    });
    return unsubscribe;
  }, [streamId]);

  return {
    lines,
    progress,
    resources: Object.values(resources),
    clear: () => {
      setLines([]);
      setProgress(null);
      setResources({});
    },
  };
}

export interface InfrastructureProgressState {
  readonly status: EngineProgress['status'];
  readonly label: string;
}

export interface InfrastructureResourceProgress {
  readonly name: string;
  readonly type: string;
  readonly status: EngineProgress['status'];
  readonly operation: string;
  readonly label: string;
}
